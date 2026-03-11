// ── Tauri invoke (withGlobalTauri: true) ─────────────────────────────────────
const invoke = (window.__TAURI__?.core?.invoke) ?? (() => Promise.reject('Tauri IPC not available'));

// ── App state ─────────────────────────────────────────────────────────────────
let currentPage    = 'dashboard';
let selectedFolder = null;
let allTasks       = [];
let filteredTasks  = [];
let sortCol        = 'name';
let sortDir        = 1;
let selectedTask   = null;
let _createTabIdx  = 0;     // tracks which tab is active in the Create Task modal
let _editTaskPath  = null;  // non-null when editing an existing task

// Live Monitor
let liveRefreshInterval = null;

// Audit log (max MAX_AUDIT_LOG_ENTRIES entries, stored in localStorage)
const MAX_AUDIT_LOG_ENTRIES = 500;
let _auditLog = [];

// Task failure detection for notifications
const TASK_RESULT_RUNNING  = 267009;
const TASK_RESULT_NOT_RUN  = 267011;
let _prevTaskResults = {};

// Bulk operations
let _selectedPaths = new Set();

// Column visibility preferences
let _colPrefs = {
  cb: true, name: true, health: true, status: true,
  triggers: true, action: true, last_run: true,
  next_run: true, last_result: true, controls: true,
};

// Debounce timer for search input
let searchDebounce = null;

// Create dialog tab indices
const TAB_GENERAL  = 0;
const TAB_TRIGGER  = 1;
const TAB_ACTION   = 2;
const TAB_ADVANCED = 3;
const TAB_XML      = 4;

// ── Utility: status bar ───────────────────────────────────────────────────────
function setStatus(msg) {
  const el = document.getElementById('status-text');
  if (el) el.textContent = msg;
}

// ── Toast notifications ───────────────────────────────────────────────────────
let toastTimer = null;
function showToast(msg, type = 'info') {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.className   = 'show ' + type;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = ''; }, 2500);
}

// ── Modal helpers ─────────────────────────────────────────────────────────────
function openModal(title, bodyHtml, footerHtml = '') {
  document.getElementById('modal-title').textContent = title;
  document.getElementById('modal-body').innerHTML    = bodyHtml;
  document.getElementById('modal-footer').innerHTML  = footerHtml;
  document.getElementById('modal-overlay').classList.add('show');
}

function closeModal() {
  document.getElementById('modal-overlay').classList.remove('show');
  // Clear form state after closing animation so re-opening shows fresh content
  setTimeout(() => {
    document.getElementById('modal-body').innerHTML = '';
    document.getElementById('modal-footer').innerHTML = '';
  }, 200);
}

// ── Page navigation ───────────────────────────────────────────────────────────
function showPage(page) {
  currentPage = page;
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));

  const pageEl = document.getElementById('page-' + page);
  const navEl  = document.querySelector(`.nav-item[data-page="${page}"]`);
  if (pageEl) pageEl.classList.add('active');
  if (navEl)  navEl.classList.add('active');

  // Only show topbar on tasks page
  const topbar = document.getElementById('topbar');
  if (topbar) topbar.style.display = page === 'tasks' ? 'flex' : 'none';

  // Stop live monitor interval when leaving live page
  if (page !== 'live' && liveRefreshInterval) {
    clearInterval(liveRefreshInterval);
    liveRefreshInterval = null;
  }

  if (page === 'dashboard') loadDashboard();
  if (page === 'tasks')     loadTasksForFolder(selectedFolder);
  if (page === 'live')      startLiveMonitor();
  if (page === 'templates') renderTemplates();
  if (page === 'auditlog')  renderAuditLog();
  if (page === 'settings')  renderSettings();
}

// ── Folder list ───────────────────────────────────────────────────────────────
async function refreshFolders() {
  try {
    const folders = await invoke('get_folders');
    const list    = document.getElementById('folder-list');
    list.innerHTML = '';

    // "All Tasks" entry
    const allEl = document.createElement('div');
    allEl.className   = 'folder-item' + (selectedFolder === null ? ' active' : '');
    allEl.textContent = '📂 All Tasks';
    allEl.onclick = () => {
      selectedFolder = null;
      document.querySelectorAll('.folder-item').forEach(f => f.classList.remove('active'));
      allEl.classList.add('active');
      showPage('tasks');
    };
    list.appendChild(allEl);

    folders.forEach(folder => {
      const el        = document.createElement('div');
      el.className    = 'folder-item' + (selectedFolder === folder ? ' active' : '');
      el.textContent  = '📁 ' + folder;
      el.onclick = () => {
        selectedFolder = folder;
        document.querySelectorAll('.folder-item').forEach(f => f.classList.remove('active'));
        el.classList.add('active');
        loadTasksForFolder(folder);
        showPage('tasks');
      };
      list.appendChild(el);
    });
  } catch (err) {
    showToast('Failed to load folders: ' + err, 'error');
  }
}

// ── Dashboard ─────────────────────────────────────────────────────────────────
async function loadDashboard() {
  const content = document.getElementById('dash-content');
  content.innerHTML = '<div class="loading-msg"><span class="spinner"></span> Loading…</div>';
  setStatus('Loading dashboard…');

  try {
    const tasks = await invoke('get_all_tasks');

    const total    = tasks.length;
    const running  = tasks.filter(t => t.status === 'Running').length;
    const ready    = tasks.filter(t => t.status === 'Ready').length;
    const disabled = tasks.filter(t => t.status === 'Disabled').length;
    const healthPct = total > 0 ? Math.round((ready / total) * 100) : 0;

    // Recent tasks: last 5 sorted by last_run descending
    const recent = [...tasks]
      .filter(t => t.last_run && t.last_run !== 'Never' && t.last_run !== 'N/A')
      .sort((a, b) => b.last_run.localeCompare(a.last_run))
      .slice(0, 5);

    // Running tasks
    const runningTasks = tasks.filter(t => t.status === 'Running');

    content.innerHTML = `
      <div class="stat-grid">
        <div class="stat-card">
          <div class="stat-icon">📋</div>
          <div class="stat-val">${total}</div>
          <div class="stat-lbl">Total Tasks</div>
        </div>
        <div class="stat-card running">
          <div class="stat-icon">▶</div>
          <div class="stat-val">${running}</div>
          <div class="stat-lbl">Running</div>
        </div>
        <div class="stat-card ready">
          <div class="stat-icon">✅</div>
          <div class="stat-val">${ready}</div>
          <div class="stat-lbl">Ready</div>
        </div>
        <div class="stat-card disabled">
          <div class="stat-icon">⏸</div>
          <div class="stat-val">${disabled}</div>
          <div class="stat-lbl">Disabled</div>
        </div>
      </div>

      <div style="font-size:11px;color:var(--text3);margin-bottom:4px">System Health — ${healthPct}% Ready</div>
      <div class="health-bar-wrap">
        <div class="health-bar" style="width:${healthPct}%"></div>
      </div>

      <div class="dash-cols">
        <div class="dash-card">
          <div class="dash-card-title">⏱ Recent Tasks</div>
          ${recent.length === 0
            ? '<div class="dash-empty">No recent task runs</div>'
            : recent.map(t => `
              <div class="dash-row">
                <span class="dash-task-name">${escHtml(t.name)}</span>
                <span class="badge badge-${badgeClass(t.status)}">${escHtml(t.status)}</span>
                <span class="dash-row-right">${escHtml(t.last_run)}</span>
              </div>`).join('')}
        </div>
        <div class="dash-card">
          <div class="dash-card-title">▶ Running Tasks</div>
          ${runningTasks.length === 0
            ? '<div class="dash-empty">No tasks currently running</div>'
            : runningTasks.map(t => `
              <div class="dash-row">
                <span class="dash-task-name">${escHtml(t.name)}</span>
                <span class="dash-row-right">${escHtml(t.path)}</span>
              </div>`).join('')}
        </div>
      </div>`;

    setStatus(`Loaded ${total} total tasks`);
  } catch (err) {
    content.innerHTML = `<div class="error-msg">⚠ Failed to load dashboard: ${escHtml(String(err))}</div>`;
    setStatus('Error loading dashboard');
    showToast('Dashboard error: ' + err, 'error');
  }
}

// ── Task list ─────────────────────────────────────────────────────────────────
async function loadTasksForFolder(folder) {
  setStatus('Loading tasks…');
  // Reset pills to placeholder while loading
  const setVal = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  setVal('stat-total-val', '—'); setVal('stat-running-val', '—');
  setVal('stat-ready-val', '—'); setVal('stat-disabled-val', '—');
  try {
    const tasks = folder === null
      ? await invoke('get_all_tasks')
      : await invoke('get_tasks', { folder });

    allTasks = tasks;
    filterTasks();

    // Update stats pills
    const total    = tasks.length;
    const running  = tasks.filter(t => t.status === 'Running').length;
    const ready    = tasks.filter(t => t.status === 'Ready').length;
    const disabled = tasks.filter(t => t.status === 'Disabled').length;

    setVal('stat-total-val',    total);
    setVal('stat-running-val',  running);
    setVal('stat-ready-val',    ready);
    setVal('stat-disabled-val', disabled);

    const label = folder === null ? '/ (All)' : folder;
    setStatus(`Loaded ${total} tasks from ${label}`);
  } catch (err) {
    showToast('Failed to load tasks: ' + err, 'error');
    setStatus('Error loading tasks');
  }
}

// ── Filter / sort ─────────────────────────────────────────────────────────────
function dateSortVal(str) {
  if (!str || str === 'Never' || str === 'N/A') return '';
  return str;
}

function filterTasks() {
  const searchEl  = document.getElementById('search-input');
  const statusEl  = document.getElementById('status-filter');
  const search    = searchEl  ? searchEl.value.toLowerCase()  : '';
  const status    = statusEl  ? statusEl.value                : '';

  let result = allTasks.filter(t => {
    const matchSearch = !search ||
      t.name.toLowerCase().includes(search) ||
      t.path.toLowerCase().includes(search) ||
      (t.actions && t.actions.some(a => a.toLowerCase().includes(search)));
    const matchStatus = !status || t.status === status;
    return matchSearch && matchStatus;
  });

  // Sort
  result.sort((a, b) => {
    const isDateCol = sortCol === 'last_run' || sortCol === 'next_run';
    let av = isDateCol ? dateSortVal(a[sortCol]) : (a[sortCol] || '');
    let bv = isDateCol ? dateSortVal(b[sortCol]) : (b[sortCol] || '');
    if (typeof av === 'string') av = av.toLowerCase();
    if (typeof bv === 'string') bv = bv.toLowerCase();
    if (av < bv) return -1 * sortDir;
    if (av > bv) return  1 * sortDir;
    return 0;
  });

  filteredTasks = result;
  renderTable();
}

function onSearchInput() {
  if (searchDebounce) clearTimeout(searchDebounce);
  searchDebounce = setTimeout(filterTasks, 200);
}

function sortBy(col) {
  if (sortCol === col) {
    sortDir = -sortDir;
  } else {
    sortCol = col;
    sortDir = 1;
  }
  filterTasks();
}

// ── Render table ──────────────────────────────────────────────────────────────
function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function badgeClass(status) {
  switch ((status || '').toLowerCase()) {
    case 'running':  return 'running';
    case 'ready':    return 'ready';
    case 'disabled': return 'disabled';
    case 'queued':   return 'queued';
    default:         return 'unknown';
  }
}

function resultClass(result) {
  if (!result || result === 'Not Run Yet' || result === 'N/A') return 'result-na';
  if (result === 'Success' || result === '(0x0)') return 'result-ok';
  return 'result-error';
}

function renderTable() {
  const tbody      = document.getElementById('task-tbody');
  const emptyState = document.getElementById('empty-state');

  if (!tbody) return;

  if (filteredTasks.length === 0) {
    tbody.innerHTML = '';
    if (emptyState) emptyState.style.display = 'flex';
    return;
  }
  if (emptyState) emptyState.style.display = 'none';

  tbody.innerHTML = filteredTasks.map((task, idx) => {
    const firstAction = task.actions && task.actions.length > 0 ? task.actions[0] : null;
    const actionText = firstAction ? firstAction.substring(0, 50) + (firstAction.length > 50 ? '…' : '') : '—';
    const triggers   = (task.triggers && task.triggers.length > 0)
      ? task.triggers.join(', ').substring(0, 40) : '—';
    const health  = healthScore(task);
    const healthDot = `<span class="health-dot ${health}" title="Health: ${health}"></span>`;
    const isChecked = _selectedPaths.has(task.path);

    return `<tr data-idx="${idx}" class="${isChecked ? 'row-selected' : ''}">
      <td data-col="cb"><input type="checkbox" class="task-cb" data-path="${escHtml(task.path)}" ${isChecked ? 'checked' : ''} /></td>
      <td data-col="name">
        <span class="task-name">${escHtml(task.name)}</span>
        ${task.hidden ? '<span class="badge badge-unknown" title="Hidden">H</span>' : ''}
      </td>
      <td data-col="health">${healthDot}</td>
      <td data-col="status"><span class="badge badge-${badgeClass(task.status)}">${escHtml(task.status || '—')}</span></td>
      <td data-col="triggers" class="cell-trunc" title="${escHtml(triggers)}">${escHtml(triggers)}</td>
      <td data-col="action" class="cell-trunc" title="${escHtml(firstAction || '')}">${escHtml(actionText)}</td>
      <td data-col="last_run">${escHtml(task.last_run || '—')}</td>
      <td data-col="next_run">${escHtml(task.next_run || '—')}</td>
      <td data-col="last_result" class="${resultClass(task.last_result)}">${escHtml(task.last_result || '—')}</td>
      <td data-col="controls" class="controls-cell">
        <button class="icon-btn" title="Run"    data-action="run"    data-idx="${idx}">▶</button>
        <button class="icon-btn" title="Stop"   data-action="stop"   data-idx="${idx}">⏹</button>
        <button class="icon-btn danger" title="Delete" data-action="delete" data-idx="${idx}">🗑</button>
      </td>
    </tr>`;
  }).join('');

  // Apply column visibility
  applyColumnVisibility();

  // Event delegation for row clicks and control buttons
  tbody.onclick = e => {
    // Handle checkbox
    const cb = e.target.closest('.task-cb');
    if (cb) {
      e.stopPropagation();
      const path = cb.dataset.path;
      if (cb.checked) { _selectedPaths.add(path); } else { _selectedPaths.delete(path); }
      cb.closest('tr').classList.toggle('row-selected', cb.checked);
      updateBulkToolbar();
      return;
    }
    const btn = e.target.closest('[data-action]');
    if (btn) {
      e.stopPropagation();
      const task = filteredTasks[parseInt(btn.dataset.idx, 10)];
      if (!task) return;
      if (btn.dataset.action === 'run')    runTask(task.path);
      if (btn.dataset.action === 'stop')   stopTask(task.path);
      if (btn.dataset.action === 'delete') deleteTask(task.path, task.name);
      return;
    }
    const row = e.target.closest('tr[data-idx]');
    if (row) openDetail(filteredTasks[parseInt(row.dataset.idx, 10)]);
  };
  tbody.oncontextmenu = e => {
    const row = e.target.closest('tr[data-idx]');
    if (row) showCtxMenu(e, filteredTasks[parseInt(row.dataset.idx, 10)]);
  };
}

// ── Detail panel ──────────────────────────────────────────────────────────────
function openDetail(task) {
  selectedTask = task;

  document.getElementById('detail-name').textContent = task.name;

  // Build detail body
  const sections = [];
  const health = healthScore(task);

  sections.push(`
    <div class="detail-section">
      <div class="detail-section-title">General
        <span class="health-dot ${health}" title="Health: ${health}" style="float:right;margin-top:2px"></span>
      </div>
      <table class="detail-table">
        <tr><td>Path</td><td>${escHtml(task.path)}</td></tr>
        <tr><td>Status</td><td><span class="badge badge-${badgeClass(task.status)}">${escHtml(task.status)}</span></td></tr>
        <tr><td>Description</td><td>${escHtml(task.description || '—')}</td></tr>
        <tr><td>Author</td><td>${escHtml(task.author || '—')}</td></tr>
        <tr><td>Run As</td><td>${escHtml(task.run_as_user || '—')}</td></tr>
        <tr><td>Hidden</td><td>${task.hidden ? 'Yes' : 'No'}</td></tr>
        <tr><td>Enabled</td><td>${task.enabled ? 'Yes' : 'No'}</td></tr>
      </table>
    </div>`);

  sections.push(`
    <div class="detail-section">
      <div class="detail-section-title">Triggers</div>
      ${task.triggers && task.triggers.length > 0
        ? task.triggers.map(t => `<div class="detail-item">${escHtml(t)}</div>`).join('')
        : '<div class="detail-item muted">No triggers defined</div>'}
    </div>`);

  sections.push(`
    <div class="detail-section">
      <div class="detail-section-title">Actions</div>
      ${task.actions && task.actions.length > 0
        ? task.actions.map(a => `<div class="detail-item">${escHtml(a)}</div>`).join('')
        : task.action
          ? `<div class="detail-item">${escHtml(task.action)}</div>`
          : '<div class="detail-item muted">No actions defined</div>'}
    </div>`);

  sections.push(`
    <div class="detail-section">
      <div class="detail-section-title">History</div>
      <table class="detail-table">
        <tr><td>Last Run</td><td>${escHtml(task.last_run || '—')}</td></tr>
        <tr><td>Next Run</td><td>${escHtml(task.next_run || '—')}</td></tr>
        <tr><td>Last Result</td><td class="${resultClass(task.last_result)}">${escHtml(task.last_result || '—')}</td></tr>
      </table>
      <div style="margin-top:8px">
        <button class="btn" onclick="loadTaskHistory('${escHtml(task.path)}')">📋 Load Full History</button>
      </div>
      <div id="task-history-container" style="margin-top:8px"></div>
    </div>`);

  document.getElementById('detail-body').innerHTML = sections.join('');

  // Wire up buttons
  const runBtn    = document.getElementById('d-run-btn');
  const stopBtn   = document.getElementById('d-stop-btn');
  const toggleBtn = document.getElementById('d-toggle-btn');
  const xmlBtn    = document.getElementById('d-xml-btn');
  const editBtn   = document.getElementById('d-edit-btn');
  const cloneBtn  = document.getElementById('d-clone-btn');
  const deleteBtn = document.getElementById('d-delete-btn');

  runBtn.onclick    = () => { appendAuditLog('run_task', task.name, task.path); runTask(task.path); };
  stopBtn.onclick   = () => { appendAuditLog('stop_task', task.name, task.path); stopTask(task.path); };
  toggleBtn.onclick = () => toggleTask(task);
  toggleBtn.textContent = task.enabled ? '⏸ Disable' : '▶ Enable';
  xmlBtn.onclick    = () => exportXml(task.path);
  if (editBtn)   editBtn.onclick  = () => openEditDialog(task);
  if (cloneBtn)  cloneBtn.onclick = () => cloneTask(task);
  deleteBtn.onclick = () => deleteTask(task.path, task.name);

  document.getElementById('detail-panel').classList.remove('panel-hidden');

  // Highlight selected row
  document.querySelectorAll('#task-tbody tr').forEach(r => r.classList.remove('selected'));
  const rows = document.querySelectorAll('#task-tbody tr');
  rows.forEach(r => {
    if (r.querySelector('.task-name') &&
        r.querySelector('.task-name').textContent === task.name) {
      r.classList.add('selected');
    }
  });
}

function closeDetail() {
  document.getElementById('detail-panel').classList.add('panel-hidden');
  selectedTask = null;
  document.querySelectorAll('#task-tbody tr').forEach(r => r.classList.remove('selected'));
}

// ── Task operations ───────────────────────────────────────────────────────────
async function runTask(path) {
  try {
    await invoke('run_task', { path });
    showToast('Task started', 'success');
    setStatus('Running: ' + path);
    setTimeout(refreshAll, 1000);
  } catch (err) {
    showToast('Run failed: ' + err, 'error');
  }
}

async function stopTask(path) {
  try {
    await invoke('stop_task', { path });
    showToast('Task stopped', 'success');
    setTimeout(refreshAll, 1000);
  } catch (err) {
    showToast('Stop failed: ' + err, 'error');
  }
}

async function toggleTask(task) {
  try {
    const newEnabled = !task.enabled;
    await invoke('set_task_enabled', { path: task.path, enabled: newEnabled });
    appendAuditLog(newEnabled ? 'enable_task' : 'disable_task', task.name, task.path);
    showToast(`Task ${newEnabled ? 'enabled' : 'disabled'}`, 'success');
    setTimeout(refreshAll, 500);
  } catch (err) {
    showToast('Toggle failed: ' + err, 'error');
  }
}

async function deleteTask(path, name) {
  openModal('🗑 Delete Task',
    `<div style="padding:16px 16px 8px">
       <div style="font-size:16px;font-weight:700;color:var(--red);margin-bottom:6px">${escHtml(name)}</div>
       <div style="font-size:11px;color:var(--text3);font-family:monospace;word-break:break-all;margin-bottom:14px">${escHtml(path)}</div>
       <p style="color:var(--text2);font-size:13px">This action <strong>cannot be undone</strong>. The task will be permanently removed from Windows Task Scheduler.</p>
     </div>`,
    `<button class="btn" id="del-cancel-btn" onclick="closeModal()">Cancel</button>
     <button class="btn btn-danger" id="del-confirm-btn">🗑 Delete</button>`);
  setTimeout(() => {
    const confirmBtn = document.getElementById('del-confirm-btn');
    const cancelBtn  = document.getElementById('del-cancel-btn');
    if (confirmBtn) confirmBtn.onclick = async () => {
      closeModal();
      try {
        await invoke('delete_task', { path });
        appendAuditLog('delete_task', name, path);
        showToast('Task deleted', 'success');
        closeDetail();
        refreshAll();
      } catch (err) {
        showToast('Delete failed: ' + err, 'error');
      }
    };
    if (cancelBtn) cancelBtn.focus();
  }, 0);
}

// ── Confirm action modal ──────────────────────────────────────────────────────
function confirmAction(message, onConfirm) {
  openModal('⚠ Confirm', `<p style="padding:16px;color:var(--text)">${escHtml(message)}</p>`,
    `<button class="btn" onclick="closeModal()">Cancel</button>
     <button class="btn btn-danger" id="confirm-ok-btn">Confirm</button>`);
  setTimeout(() => {
    const btn = document.getElementById('confirm-ok-btn');
    if (btn) btn.onclick = () => { closeModal(); onConfirm(); };
  }, 0);
}

// Module-level variable to hold the last exported XML for clipboard copy
let _lastExportedXml    = '';
let _copyFeedbackTimer  = null;

function syntaxHighlightXml(xml) {
  // Escape first, then wrap tag names in colour spans
  return escHtml(xml)
    .replace(/(&lt;\/?)([\w:.]+)/g, '$1<span class="xml-tag-name">$2</span>')
    .replace(/(&lt;!--[\s\S]*?--&gt;)/g, '<span class="xml-comment">$1</span>');
}

async function exportXml(path) {
  try {
    const xml = await invoke('export_task_xml', { path });
    _lastExportedXml = xml;
    openModal('＜/＞ Export XML',
      `<div class="xml-box" id="xml-display">${syntaxHighlightXml(xml)}</div>`,
      `<button class="btn btn-primary" id="copy-xml-btn">📋 Copy</button>
       <span id="copy-feedback" style="font-size:11px;color:var(--green);display:none">✅ Copied!</span>
       <button class="btn" id="save-xml-btn">💾 Save as file</button>
       <button class="btn" onclick="closeModal()">Close</button>`);
    requestAnimationFrame(() => {
      const copyBtn = document.getElementById('copy-xml-btn');
      const savBtn  = document.getElementById('save-xml-btn');
      const fb      = document.getElementById('copy-feedback');
      if (copyBtn) copyBtn.onclick = () => {
        navigator.clipboard.writeText(_lastExportedXml).then(() => {
          if (fb) {
            fb.style.display = 'inline';
            if (_copyFeedbackTimer) clearTimeout(_copyFeedbackTimer);
            _copyFeedbackTimer = setTimeout(() => {
              fb.style.display = 'none';
              _copyFeedbackTimer = null;
            }, 2000);
          }
        });
      };
      if (savBtn) savBtn.onclick = () => {
        const blob = new Blob([_lastExportedXml], { type: 'application/xml;charset=utf-8' });
        const url  = URL.createObjectURL(blob);
        const a    = document.createElement('a');
        a.href     = url;
        a.download = (path.split('\\').pop() || 'task') + '.xml';
        a.click();
        URL.revokeObjectURL(url);
      };
    });
  } catch (err) {
    showToast('Export failed: ' + err, 'error');
  }
}

// ── Refresh all ───────────────────────────────────────────────────────────────
async function refreshAll() {
  await refreshFolders();
  await loadTasksForFolder(selectedFolder);

  // Check for task failures and notify if enabled
  const notifyEnabled = localStorage.getItem('wtp_notifyOnFailure') === 'true';
  if (notifyEnabled && allTasks.length > 0) {
    allTasks.forEach(task => {
      const prev = _prevTaskResults[task.path];
      const code = task.last_result_code;
      // Non-zero, non-running, non-never-run = failure
      if (prev !== undefined && prev !== code && code !== 0 && code !== TASK_RESULT_RUNNING && code !== TASK_RESULT_NOT_RUN) {
        if (Notification.permission === 'granted') {
          new Notification('WinTaskPro — Task Failed', {
            body: task.name + ' failed with ' + task.last_result,
            icon: 'icon.png',
          });
        }
      }
    });
    // Update previous results map
    allTasks.forEach(t => { _prevTaskResults[t.path] = t.last_result_code; });
  }

  showToast('Refreshed', 'success');
}

// ── Create task dialog ────────────────────────────────────────────────────────
async function openCreateDialog(prefill = {}) {
  _editTaskPath = null;   // reset edit mode; openEditDialog will set this after

  // Normalize trigger type to match Rust enum casing
  const triggerNorm = {
    'once':'Once','daily':'Daily','weekly':'Weekly','monthly':'Monthly',
    'interval':'Interval',
    'boot':'Boot','logon':'Logon','idle':'Idle',
    'sessionlock':'SessionLock','sessionunlock':'SessionUnlock',
  };
  const prefillTrigger = triggerNorm[(prefill.trigger_type || '').toLowerCase()] || prefill.trigger_type || 'Once';

  // Normalize action type — 'cmd' maps to 'custom'; 'powershell'/'cmd' with an
  // explicit program path also map to 'custom' so the free-form fields are shown.
  const actionNormMap = {
    'program':'program','batch':'batch','cmd':'custom',
    'python':'python','vbscript':'vbscript','custom':'custom',
    'powershell': prefill.program ? 'custom' : 'powershell',
  };
  const prefillAction = actionNormMap[(prefill.action_type || '').toLowerCase()] || 'program';

  // Build folder options — root is always available
  let folderOptions = '<option value="\\">&#92; (Root)</option>';
  try {
    const folders = await invoke('get_folders');
    folderOptions += folders.map(f =>
      `<option value="${escHtml(f)}" ${prefill.folder === f ? 'selected' : ''}>${escHtml(f)}</option>`
    ).join('');
  } catch (_) {}

  const prefillPriority = prefill.priority !== undefined ? prefill.priority : 7;

  const bodyHtml = `
    <div class="modal-tabs" id="create-tabs">
      <div class="modal-tab active" data-tab="0">General</div>
      <div class="modal-tab" data-tab="1">Trigger</div>
      <div class="modal-tab" data-tab="2">Action</div>
      <div class="modal-tab" data-tab="3">Advanced</div>
      <div class="modal-tab" data-tab="4">XML</div>
    </div>

    <!-- ── Tab 0: General ── -->
    <div class="modal-tab-panel active" id="tab-panel-0">
      <div class="form-group">
        <label>Task Name *</label>
        <input type="text" id="cf-name" class="form-control" value="${escHtml(prefill.name || '')}" placeholder="MyBackupTask" />
        <div class="form-error" id="err-name">Name is required and cannot contain slashes</div>
      </div>
      <div class="form-group">
        <label>Folder</label>
        <select id="cf-folder" class="form-control">${folderOptions}</select>
      </div>
      <div class="form-group">
        <label>Description</label>
        <textarea id="cf-desc" rows="3" class="form-control">${escHtml(prefill.description || '')}</textarea>
      </div>
      <div class="form-group">
        <label>Run Level</label>
        <select id="cf-run-level" class="form-control">
          <option value="0" ${(prefill.run_level || 0) === 0 ? 'selected' : ''}>Standard User</option>
          <option value="1" ${prefill.run_level === 1 ? 'selected' : ''}>Highest Privileges (Admin)</option>
        </select>
      </div>
      <div class="form-group">
        <label>Run As User</label>
        <input type="text" id="cf-run-as-user" class="form-control" value="${escHtml(prefill.run_as_user || '')}" placeholder="SYSTEM or leave blank for current user" />
      </div>
      <div class="form-group">
        <div class="checkbox-group">
          <input type="checkbox" id="cf-hidden" ${prefill.hidden ? 'checked' : ''} />
          <label for="cf-hidden">Hidden task</label>
        </div>
      </div>
      <div class="form-group">
        <div class="checkbox-group">
          <input type="checkbox" id="cf-enabled" ${prefill.enabled !== false ? 'checked' : ''} />
          <label for="cf-enabled">Enabled</label>
        </div>
      </div>
    </div>

    <!-- ── Tab 1: Trigger ── -->
    <div class="modal-tab-panel" id="tab-panel-1">
      <div class="form-group">
        <label>Trigger Type</label>
        <select id="cf-trigger-type" class="form-control" onchange="updateTriggerFields()">
          <option value="Once"          ${prefillTrigger==='Once'          ?'selected':''}>Once — Run one time at a specific date/time</option>
          <option value="Daily"         ${prefillTrigger==='Daily'         ?'selected':''}>Daily — Run every N days</option>
          <option value="Weekly"        ${prefillTrigger==='Weekly'        ?'selected':''}>Weekly — Run every N weeks</option>
          <option value="Monthly"       ${prefillTrigger==='Monthly'       ?'selected':''}>Monthly — Run on a specific day of the month</option>
          <option value="Interval"      ${prefillTrigger==='Interval'      ?'selected':''}>Interval — Repeat every N hours/minutes</option>
          <option value="Boot"          ${prefillTrigger==='Boot'          ?'selected':''}>Boot — Run at Windows startup</option>
          <option value="Logon"         ${prefillTrigger==='Logon'         ?'selected':''}>Logon — Run when a user logs on</option>
          <option value="Idle"          ${prefillTrigger==='Idle'          ?'selected':''}>Idle — Run when the system is idle</option>
          <option value="SessionLock"   ${prefillTrigger==='SessionLock'   ?'selected':''}>Session Lock — Run when the session is locked</option>
          <option value="SessionUnlock" ${prefillTrigger==='SessionUnlock' ?'selected':''}>Session Unlock — Run when the session is unlocked</option>
        </select>
      </div>

      <!-- Once -->
      <div id="tf-once">
        <div class="form-group">
          <label>Date / Time *</label>
          <input type="datetime-local" id="cf-datetime" class="form-control" value="${escHtml(prefill.trigger_datetime || prefill.trigger_value || '')}" />
          <div class="form-error" id="err-datetime">A start date/time is required</div>
        </div>
      </div>

      <!-- Daily -->
      <div id="tf-daily" style="display:none">
        <div class="form-group">
          <label>Start Time *</label>
          <input type="time" id="cf-daily-time" class="form-control" value="${prefillTrigger==='Daily' ? escHtml(prefill.trigger_value||'08:00') : '08:00'}" />
          <div class="form-error" id="err-daily-time">Start time is required</div>
        </div>
        <div class="form-group">
          <label>Every N Days</label>
          <input type="number" id="cf-days-interval" class="form-control" min="1" max="365" value="${prefill.days_interval || 1}" />
          <div class="form-hint">Task runs every <em>N</em> days starting at the chosen time</div>
          <div class="form-error" id="err-days-interval">Days interval must be at least 1</div>
        </div>
      </div>

      <!-- Weekly -->
      <div id="tf-weekly" style="display:none">
        <div class="form-group">
          <label>Start Time *</label>
          <input type="time" id="cf-weekly-time" class="form-control" value="${prefillTrigger==='Weekly' ? escHtml(prefill.trigger_value||'08:00') : '08:00'}" />
        </div>
        <div class="form-group">
          <label>Repeat every N weeks</label>
          <input type="number" id="cf-weeks-interval" class="form-control" min="1" max="52" value="${prefill.days_interval || 1}" />
          <div class="form-hint">Task will run weekly starting at the chosen time</div>
        </div>
      </div>

      <!-- Monthly -->
      <div id="tf-monthly" style="display:none">
        <div class="form-group">
          <label>Start Time *</label>
          <input type="time" id="cf-monthly-time" class="form-control" value="${prefillTrigger==='Monthly' ? escHtml(prefill.trigger_value||'08:00') : '08:00'}" />
        </div>
        <div class="form-group">
          <label>Day of Month (1–31)</label>
          <input type="number" id="cf-month-day" class="form-control" min="1" max="31" value="${prefill.days_interval || 1}" />
          <div class="form-error" id="err-month-day">Day must be between 1 and 31</div>
        </div>
      </div>

      <!-- Boot -->
      <div id="tf-boot" style="display:none">
        <div class="info-box info">This task will run once each time Windows starts, before any user logs in.</div>
      </div>

      <!-- Logon -->
      <div id="tf-logon" style="display:none">
        <div class="info-box info">This task will run each time any user logs on to the computer.</div>
      </div>

      <!-- Idle -->
      <div id="tf-idle" style="display:none">
        <div class="form-group">
          <label>Wait for idle (minutes)</label>
          <input type="number" id="cf-idle-min" class="form-control" min="1" max="999" value="${prefill.days_interval || 10}" />
          <div class="form-hint">The task runs when the system has been idle for this many minutes</div>
          <div class="form-error" id="err-idle">Idle time must be at least 1 minute</div>
        </div>
      </div>

      <!-- SessionLock -->
      <div id="tf-sessionlock" style="display:none">
        <div class="info-box info">This task will run when the Windows session is locked (Win+L or screen lock).</div>
      </div>

      <!-- SessionUnlock -->
      <div id="tf-sessionunlock" style="display:none">
        <div class="info-box info">This task will run when the Windows session is unlocked (entering PIN or password).</div>
      </div>

      <!-- Interval -->
      <div id="tf-interval" style="display:none">
        <div class="form-group">
          <label>Repeat every</label>
          <div style="display:flex;gap:8px;align-items:center">
            <input type="number" id="cf-interval-value" class="form-control" min="1" value="${prefill.interval_value || 1}" style="width:80px" />
            <select id="cf-interval-unit" class="form-control" style="width:120px">
              <option value="Hours"   ${(prefill.interval_unit||'Hours')==='Hours'   ?'selected':''}>Hours</option>
              <option value="Minutes" ${(prefill.interval_unit||'')==='Minutes' ?'selected':''}>Minutes</option>
            </select>
          </div>
        </div>
        <div class="form-group">
          <label>Start time <span style="font-weight:400;color:var(--text3)">(optional)</span></label>
          <input type="time" id="cf-interval-start" class="form-control" value="${prefill.interval_start || '00:00'}" style="width:140px" />
        </div>
        <div class="info-box info">Task will run indefinitely, repeating every N hours/minutes starting at the chosen time.</div>
        <div style="margin-top:10px">
          <div style="font-size:11px;color:var(--text3);margin-bottom:6px">Quick pick:</div>
          <div style="display:flex;gap:6px;flex-wrap:wrap">
            ${[['15m','15','Minutes'],['30m','30','Minutes'],['1h','1','Hours'],['2h','2','Hours'],['4h','4','Hours'],['6h','6','Hours'],['8h','8','Hours'],['12h','12','Hours']]
              .map(([label,v,u])=>`<button class="btn" type="button" onclick="setIntervalQuick(${v},'${u}')">Every ${label}</button>`).join('')}
          </div>
        </div>
      </div>
    </div>

    <!-- ── Tab 2: Action ── -->
    <div class="modal-tab-panel" id="tab-panel-2">
      <div class="form-group">
        <label>Action Type</label>
        <select id="cf-action-type" class="form-control" onchange="updateActionFields()">
          <option value="program"    ${prefillAction==='program'    ?'selected':''}>Program / Script — plain executable</option>
          <option value="batch"      ${prefillAction==='batch'      ?'selected':''}>Batch File (.bat / .cmd)</option>
          <option value="powershell" ${prefillAction==='powershell' ?'selected':''}>PowerShell Script (.ps1)</option>
          <option value="python"     ${prefillAction==='python'     ?'selected':''}>Python Script (.py)</option>
          <option value="vbscript"   ${prefillAction==='vbscript'   ?'selected':''}>VBScript (.vbs)</option>
          <option value="custom"     ${prefillAction==='custom'     ?'selected':''}>Custom Command — free-form program + args</option>
        </select>
      </div>

      <!-- Script path row (batch / powershell / python / vbscript) -->
      <div id="af-script-group" style="display:none">
        <div class="form-group">
          <label>Script Path *</label>
          <input type="text" id="cf-script-path" class="form-control" placeholder="C:\\Scripts\\myjob.bat" />
          <div class="form-hint" id="af-path-hint">Tip: Use the full absolute path to your script. Network paths (\\\\server\\share\\script.bat) are also supported.</div>
          <div class="form-error" id="err-script-path">Script path is required</div>
        </div>
        <div class="form-group">
          <label>Additional Arguments <span style="font-weight:400;text-transform:none;color:var(--text3)">(optional)</span></label>
          <input type="text" id="cf-extra-args" class="form-control" placeholder="" />
        </div>
        <div class="form-group">
          <button class="btn" type="button" onclick="openScriptEditor()">✏️ Edit Script Inline</button>
        </div>
      </div>

      <!-- Program / Custom path row -->
      <div id="af-program-group">
        <div class="form-group">
          <label>Program Path *</label>
          <input type="text" id="cf-program" class="form-control" value="${escHtml(prefill.program || '')}" placeholder="C:\\Windows\\System32\\notepad.exe" />
          <div class="form-error" id="err-program">Program path is required</div>
        </div>
        <div class="form-group">
          <label>Arguments <span style="font-weight:400;text-transform:none;color:var(--text3)">(optional)</span></label>
          <input type="text" id="cf-args" class="form-control" value="${escHtml(prefill.arguments || '')}" placeholder="/c echo hello" />
        </div>
      </div>

      <!-- Working directory (always shown) -->
      <div class="form-group">
        <label>Working Directory <span style="font-weight:400;text-transform:none;color:var(--text3)">(optional)</span></label>
        <input type="text" id="cf-workdir" class="form-control" value="${escHtml(prefill.working_dir || '')}" placeholder="C:\\Scripts" />
      </div>

      <!-- Environment variables section -->
      <details class="form-group">
        <summary style="font-size:12px;font-weight:600;cursor:pointer;color:var(--text2);padding:4px 0">
          🌐 Environment Variables <span style="font-weight:400;color:var(--text3)">(optional)</span>
        </summary>
        <div style="margin-top:8px">
          <div id="env-vars-list"></div>
          <button class="btn" type="button" onclick="addEnvVar()" style="margin-top:6px">+ Add Variable</button>
          <div class="form-hint">Each variable will be injected before running the script (via cmd.exe SET)</div>
          <textarea id="cf-env-vars" class="form-control" rows="3" style="display:none;font-family:monospace;font-size:11px;margin-top:6px"
                    placeholder="KEY=VALUE&#10;ANOTHER_KEY=ANOTHER_VALUE"></textarea>
        </div>
      </details>
    </div>

    <!-- ── Tab 3: Advanced ── -->
    <div class="modal-tab-panel" id="tab-panel-3">

      <div style="font-weight:600;font-size:11px;color:var(--text3);text-transform:uppercase;letter-spacing:.5px;margin:0 0 6px">Timing / Limits</div>

      <div class="form-group">
        <label>Execution Time Limit</label>
        <select id="cf-exec-limit" class="form-control" onchange="toggleCustomInput('cf-exec-limit','cf-exec-limit-custom')">
          <option value="PT0S">Unlimited</option>
          <option value="PT1H">1 hour</option>
          <option value="PT2H">2 hours</option>
          <option value="PT4H">4 hours</option>
          <option value="PT8H">8 hours</option>
          <option value="PT12H">12 hours</option>
          <option value="PT24H">24 hours</option>
          <option value="custom">Custom…</option>
        </select>
        <input type="text" id="cf-exec-limit-custom" class="form-control" placeholder="ISO 8601, e.g. PT1H30M" style="display:none;margin-top:4px" />
      </div>

      <div class="form-group">
        <label>Random Delay</label>
        <select id="cf-random-delay" class="form-control" onchange="toggleCustomInput('cf-random-delay','cf-random-delay-custom')">
          <option value="">None</option>
          <option value="PT1M">1 minute</option>
          <option value="PT5M">5 minutes</option>
          <option value="PT10M">10 minutes</option>
          <option value="PT30M">30 minutes</option>
          <option value="PT1H">1 hour</option>
          <option value="custom">Custom…</option>
        </select>
        <input type="text" id="cf-random-delay-custom" class="form-control" placeholder="ISO 8601, e.g. PT10M" style="display:none;margin-top:4px" />
      </div>

      <div class="form-group">
        <label>Trigger Expiry (End Boundary)</label>
        <input type="datetime-local" id="cf-end-boundary" class="form-control" />
        <div class="form-hint">Leave blank for no expiry</div>
      </div>

      <div style="font-weight:600;font-size:11px;color:var(--text3);text-transform:uppercase;letter-spacing:.5px;margin:8px 0 6px">Repetition</div>

      <div class="form-group">
        <label>Repeat Every</label>
        <select id="cf-rep-interval" class="form-control" onchange="toggleCustomInput('cf-rep-interval','cf-rep-interval-custom')">
          <option value="">None (no repetition)</option>
          <option value="PT5M">5 minutes</option>
          <option value="PT10M">10 minutes</option>
          <option value="PT15M">15 minutes</option>
          <option value="PT30M">30 minutes</option>
          <option value="PT1H">1 hour</option>
          <option value="PT2H">2 hours</option>
          <option value="PT4H">4 hours</option>
          <option value="custom">Custom…</option>
        </select>
        <input type="text" id="cf-rep-interval-custom" class="form-control" placeholder="ISO 8601, e.g. PT30M" style="display:none;margin-top:4px" />
      </div>

      <div class="form-group">
        <label>Repetition Duration</label>
        <select id="cf-rep-duration" class="form-control" onchange="toggleCustomInput('cf-rep-duration','cf-rep-duration-custom')">
          <option value="">Indefinitely</option>
          <option value="PT1H">1 hour</option>
          <option value="PT4H">4 hours</option>
          <option value="PT8H">8 hours</option>
          <option value="PT12H">12 hours</option>
          <option value="PT24H">24 hours</option>
          <option value="custom">Custom…</option>
        </select>
        <input type="text" id="cf-rep-duration-custom" class="form-control" placeholder="ISO 8601, e.g. PT8H" style="display:none;margin-top:4px" />
      </div>

      <div class="form-group">
        <div class="checkbox-group">
          <input type="checkbox" id="cf-rep-stop-end" />
          <label for="cf-rep-stop-end">Stop task at end of repetition duration</label>
        </div>
      </div>

      <!-- Weekly days-of-week row (shown only when trigger = Weekly) -->
      <div id="adv-weekly-row" class="form-group" style="display:none">
        <label>Days of Week</label>
        <div style="display:flex;gap:12px;flex-wrap:wrap;margin-top:4px">
          <label style="display:flex;align-items:center;gap:4px;font-weight:400"><input type="checkbox" id="cf-dow-sun" /> Sun</label>
          <label style="display:flex;align-items:center;gap:4px;font-weight:400"><input type="checkbox" id="cf-dow-mon" /> Mon</label>
          <label style="display:flex;align-items:center;gap:4px;font-weight:400"><input type="checkbox" id="cf-dow-tue" /> Tue</label>
          <label style="display:flex;align-items:center;gap:4px;font-weight:400"><input type="checkbox" id="cf-dow-wed" /> Wed</label>
          <label style="display:flex;align-items:center;gap:4px;font-weight:400"><input type="checkbox" id="cf-dow-thu" /> Thu</label>
          <label style="display:flex;align-items:center;gap:4px;font-weight:400"><input type="checkbox" id="cf-dow-fri" /> Fri</label>
          <label style="display:flex;align-items:center;gap:4px;font-weight:400"><input type="checkbox" id="cf-dow-sat" /> Sat</label>
        </div>
      </div>

      <!-- Monthly months-of-year row (shown only when trigger = Monthly) -->
      <div id="adv-monthly-row" class="form-group" style="display:none">
        <label>Months of Year</label>
        <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:4px">
          <label style="display:flex;align-items:center;gap:4px;font-weight:400"><input type="checkbox" id="cf-moy-jan" /> Jan</label>
          <label style="display:flex;align-items:center;gap:4px;font-weight:400"><input type="checkbox" id="cf-moy-feb" /> Feb</label>
          <label style="display:flex;align-items:center;gap:4px;font-weight:400"><input type="checkbox" id="cf-moy-mar" /> Mar</label>
          <label style="display:flex;align-items:center;gap:4px;font-weight:400"><input type="checkbox" id="cf-moy-apr" /> Apr</label>
          <label style="display:flex;align-items:center;gap:4px;font-weight:400"><input type="checkbox" id="cf-moy-may" /> May</label>
          <label style="display:flex;align-items:center;gap:4px;font-weight:400"><input type="checkbox" id="cf-moy-jun" /> Jun</label>
          <label style="display:flex;align-items:center;gap:4px;font-weight:400"><input type="checkbox" id="cf-moy-jul" /> Jul</label>
          <label style="display:flex;align-items:center;gap:4px;font-weight:400"><input type="checkbox" id="cf-moy-aug" /> Aug</label>
          <label style="display:flex;align-items:center;gap:4px;font-weight:400"><input type="checkbox" id="cf-moy-sep" /> Sep</label>
          <label style="display:flex;align-items:center;gap:4px;font-weight:400"><input type="checkbox" id="cf-moy-oct" /> Oct</label>
          <label style="display:flex;align-items:center;gap:4px;font-weight:400"><input type="checkbox" id="cf-moy-nov" /> Nov</label>
          <label style="display:flex;align-items:center;gap:4px;font-weight:400"><input type="checkbox" id="cf-moy-dec" /> Dec</label>
        </div>
      </div>

      <div id="adv-monthly-days-row" class="form-group" style="display:none">
        <label>Days of Month</label>
        <input type="text" id="cf-days-of-month" class="form-control" placeholder="e.g. 1, 15, 28  (comma-separated, 1–31)" />
        <div class="form-hint">Overrides the "Day of Month" field in the Trigger tab when set</div>
      </div>

      <!-- Boot / Logon / Session delay row (shown when trigger requires delay) -->
      <div id="adv-boot-delay-row" class="form-group" style="display:none">
        <label>Startup Delay</label>
        <select id="cf-boot-delay" class="form-control" onchange="toggleCustomInput('cf-boot-delay','cf-boot-delay-custom')">
          <option value="">No delay</option>
          <option value="PT30S">30 seconds</option>
          <option value="PT1M">1 minute</option>
          <option value="PT5M">5 minutes</option>
          <option value="PT10M">10 minutes</option>
          <option value="PT30M">30 minutes</option>
          <option value="custom">Custom…</option>
        </select>
        <input type="text" id="cf-boot-delay-custom" class="form-control" placeholder="ISO 8601, e.g. PT5M" style="display:none;margin-top:4px" />
      </div>

      <div style="font-weight:600;font-size:11px;color:var(--text3);text-transform:uppercase;letter-spacing:.5px;margin:8px 0 6px">Conditions</div>

      <div class="form-group">
        <div class="checkbox-group">
          <input type="checkbox" id="cf-wake-to-run" />
          <label for="cf-wake-to-run">Wake computer to run this task</label>
        </div>
      </div>
      <div class="form-group">
        <div class="checkbox-group">
          <input type="checkbox" id="cf-run-on-network" />
          <label for="cf-run-on-network">Only run if network is available</label>
        </div>
      </div>
      <div class="form-group">
        <div class="checkbox-group">
          <input type="checkbox" id="cf-run-on-idle" />
          <label for="cf-run-on-idle">Only run if computer is idle</label>
        </div>
      </div>
      <div class="form-group">
        <div class="checkbox-group">
          <input type="checkbox" id="cf-no-battery-start" />
          <label for="cf-no-battery-start">Don't start on battery power</label>
        </div>
      </div>
      <div class="form-group">
        <div class="checkbox-group">
          <input type="checkbox" id="cf-stop-on-battery" />
          <label for="cf-stop-on-battery">Stop if switching to battery power</label>
        </div>
      </div>

      <div style="font-weight:600;font-size:11px;color:var(--text3);text-transform:uppercase;letter-spacing:.5px;margin:8px 0 6px">Settings</div>

      <div class="form-group">
        <label>Thread Priority</label>
        <select id="cf-priority" class="form-control">
          <option value="0"  ${prefillPriority === 0  ? 'selected' : ''}>0 — Critical (highest CPU priority)</option>
          <option value="1"  ${prefillPriority === 1  ? 'selected' : ''}>1</option>
          <option value="2"  ${prefillPriority === 2  ? 'selected' : ''}>2</option>
          <option value="3"  ${prefillPriority === 3  ? 'selected' : ''}>3</option>
          <option value="4"  ${prefillPriority === 4  ? 'selected' : ''}>4</option>
          <option value="5"  ${prefillPriority === 5  ? 'selected' : ''}>5</option>
          <option value="6"  ${prefillPriority === 6  ? 'selected' : ''}>6</option>
          <option value="7"  ${prefillPriority === 7  ? 'selected' : ''}>7 — Normal (default)</option>
          <option value="8"  ${prefillPriority === 8  ? 'selected' : ''}>8</option>
          <option value="9"  ${prefillPriority === 9  ? 'selected' : ''}>9</option>
          <option value="10" ${prefillPriority === 10 ? 'selected' : ''}>10 — Lowest</option>
        </select>
      </div>
      <div class="form-group">
        <div class="checkbox-group">
          <input type="checkbox" id="cf-stop-existing" />
          <label for="cf-stop-existing">Stop existing instance if task is already running</label>
        </div>
      </div>
      <div class="form-group">
        <div class="checkbox-group">
          <input type="checkbox" id="cf-delete-expired" />
          <label for="cf-delete-expired">Delete task if not scheduled to run again</label>
        </div>
      </div>
    </div>

    <!-- ── Tab 4: XML ── -->
    <div class="modal-tab-panel" id="tab-panel-4">
      <div class="info-box" style="margin-bottom:10px">
        ⚠️ Editing XML directly overrides all form settings. Use "↺ Apply XML" to back-fill the form from the XML (best-effort).
      </div>
      <div class="form-group">
        <label>Task XML
          <button class="btn" type="button" onclick="generateXmlPreview()" style="margin-left:8px;font-size:11px">🔄 Refresh from Form</button>
          <button class="btn" type="button" onclick="applyXmlToForm()" style="margin-left:4px;font-size:11px">↺ Apply XML</button>
        </label>
        <textarea id="cf-task-xml" class="form-control" rows="20"
                  style="font-family:monospace;font-size:11px"
                  placeholder="XML will be generated when you click 'Refresh from Form'…"></textarea>
      </div>
    </div>`;

  const footerHtml = `
    <button class="btn" id="tab-prev-btn" onclick="createTabNav(-1)" style="display:none">◀ Previous</button>
    <button class="btn btn-primary" id="tab-next-btn" onclick="createTabNav(1)">Next ▶</button>
    <button class="btn btn-primary" id="create-submit-btn" onclick="submitCreateTask()" style="display:none">✅ Create Task</button>
    <button class="btn" onclick="closeModal()">Cancel</button>`;

  openModal('➕ New Task', bodyHtml, footerHtml);

  // Initialize tab and field state
  _createTabIdx = 0;
  updateCreateTabUI();
  updateTriggerFields();
  updateActionFields();

  // Tab click navigation
  document.querySelectorAll('#create-tabs .modal-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      _createTabIdx = parseInt(tab.dataset.tab, 10);
      if (_createTabIdx === TAB_XML) generateXmlPreview(); // auto-refresh XML tab
      updateCreateTabUI();
    });
  });
}

// Show the correct tab panel and update Prev/Next/Submit button visibility
function updateCreateTabUI() {
  document.querySelectorAll('.modal-tab-panel').forEach((p, i) => p.classList.toggle('active', i === _createTabIdx));
  document.querySelectorAll('#create-tabs .modal-tab').forEach((t, i) => t.classList.toggle('active', i === _createTabIdx));
  const prevBtn   = document.getElementById('tab-prev-btn');
  const nextBtn   = document.getElementById('tab-next-btn');
  const submitBtn = document.getElementById('create-submit-btn');
  if (prevBtn)   prevBtn.style.display   = _createTabIdx > 0          ? '' : 'none';
  if (nextBtn)   nextBtn.style.display   = _createTabIdx < TAB_XML    ? '' : 'none';
  if (submitBtn) submitBtn.style.display = (_createTabIdx === TAB_ADVANCED || _createTabIdx === TAB_XML) ? '' : 'none';
}

// Move to next (+1) or previous (-1) tab
function createTabNav(delta) {
  _createTabIdx = Math.max(0, Math.min(TAB_XML, _createTabIdx + delta));
  if (_createTabIdx === TAB_XML) generateXmlPreview();
  updateCreateTabUI();
}

// Show/hide trigger-specific sub-sections based on selected trigger type
function updateTriggerFields() {
  const typeEl = document.getElementById('cf-trigger-type');
  if (!typeEl) return;
  const val = typeEl.value.toLowerCase();
  ['once','daily','weekly','monthly','interval','boot','logon','idle','sessionlock','sessionunlock'].forEach(g => {
    const el = document.getElementById('tf-' + g);
    if (el) el.style.display = 'none';
  });
  const active = document.getElementById('tf-' + val);
  if (active) active.style.display = '';

  // Show/hide Advanced tab sections based on trigger type
  const isBootLogon = ['boot','logon','sessionlock','sessionunlock'].includes(val);
  const isWeekly    = val === 'weekly';
  const isMonthly   = val === 'monthly';

  const bootDelayRow   = document.getElementById('adv-boot-delay-row');
  const weeklyRow      = document.getElementById('adv-weekly-row');
  const monthlyRow     = document.getElementById('adv-monthly-row');
  const monthlyDaysRow = document.getElementById('adv-monthly-days-row');

  if (bootDelayRow)   bootDelayRow.style.display   = isBootLogon ? '' : 'none';
  if (weeklyRow)      weeklyRow.style.display       = isWeekly   ? '' : 'none';
  if (monthlyRow)     monthlyRow.style.display      = isMonthly  ? '' : 'none';
  if (monthlyDaysRow) monthlyDaysRow.style.display  = isMonthly  ? '' : 'none';
}

// Show/hide action-specific fields based on selected action type
function updateActionFields() {
  const typeEl = document.getElementById('cf-action-type');
  if (!typeEl) return;
  const val = typeEl.value;
  const isScript = val === 'batch' || val === 'powershell' || val === 'python' || val === 'vbscript';
  const scriptGrp  = document.getElementById('af-script-group');
  const programGrp = document.getElementById('af-program-group');
  if (scriptGrp)  scriptGrp.style.display  = isScript ? '' : 'none';
  if (programGrp) programGrp.style.display = isScript ? 'none' : '';

  // Update placeholder and hint based on script type
  const scriptInput = document.getElementById('cf-script-path');
  const hintEl      = document.getElementById('af-path-hint');
  if (scriptInput && hintEl) {
    const hints = {
      batch:      { ph: 'C:\\Scripts\\myjob.bat', tip: 'Runs via cmd.exe /c. Use full absolute path.' },
      powershell: { ph: 'C:\\Scripts\\myjob.ps1', tip: 'Runs with -ExecutionPolicy Bypass. Use full absolute path.' },
      python:     { ph: 'C:\\Scripts\\myjob.py',  tip: 'python.exe must be in PATH or specify the full path to python.exe separately.' },
      vbscript:   { ph: 'C:\\Scripts\\myjob.vbs', tip: 'Runs via wscript.exe. Use full absolute path.' },
    };
    const h = hints[val] || { ph: '', tip: 'Use the full absolute path to your script. Network paths (\\\\server\\share\\script) are supported.' };
    scriptInput.placeholder = h.ph;
    hintEl.textContent = h.tip ? 'Tip: ' + h.tip : '';
  }
}

// ── Advanced field helpers ────────────────────────────────────────────────────

// Toggle a custom text input visible/hidden based on a select's value being 'custom'
function toggleCustomInput(selectId, customId) {
  const sel = document.getElementById(selectId);
  const inp = document.getElementById(customId);
  if (sel && inp) inp.style.display = sel.value === 'custom' ? '' : 'none';
}

// Return the ISO 8601 duration from a select+custom-input combo
function parseDurationSelect(selectId, customId) {
  const sel = document.getElementById(selectId);
  if (!sel) return '';
  if (sel.value === 'custom') {
    const custom = document.getElementById(customId);
    return custom ? custom.value.trim() : '';
  }
  return sel.value;
}

// Build days-of-week bitmask: Sun=1, Mon=2, Tue=4, Wed=8, Thu=16, Fri=32, Sat=64
function daysOfWeekBitmask() {
  const days = ['sun','mon','tue','wed','thu','fri','sat'];
  const bits = [1, 2, 4, 8, 16, 32, 64];
  let mask = 0;
  days.forEach((d, i) => {
    const cb = document.getElementById('cf-dow-' + d);
    if (cb && cb.checked) mask |= bits[i];
  });
  return mask;
}

// Build months-of-year bitmask: Jan=1, Feb=2, Mar=4, …, Dec=2048
function monthsOfYearBitmask() {
  const months = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
  let mask = 0;
  months.forEach((m, i) => {
    const cb = document.getElementById('cf-moy-' + m);
    if (cb && cb.checked) mask |= (1 << i);
  });
  return mask;
}

// Build days-of-month bitmask from comma-separated day numbers: bit0=day1, bit30=day31
function daysOfMonthBitmask() {
  const el = document.getElementById('cf-days-of-month');
  if (!el) return 0;
  const val = el.value.trim();
  if (!val) return 0;
  let mask = 0;
  val.split(',').forEach(part => {
    const day = parseInt(part.trim(), 10);
    if (day >= 1 && day <= 31) mask |= (1 << (day - 1));
  });
  return mask;
}

// ── Open edit dialog (pre-fill create dialog and switch to edit mode) ─────────
async function openEditDialog(task) {
  // Map trigger_type string to the enum key used by openCreateDialog
  const triggerTypeMap = {
    'once': 'Once', 'daily': 'Daily', 'weekly': 'Weekly', 'monthly': 'Monthly',
    'at boot': 'Boot', 'boot': 'Boot',
    'at logon': 'Logon', 'logon': 'Logon',
    'on idle': 'Idle', 'idle': 'Idle',
    'interval': 'Interval',
    'sessionlock': 'SessionLock', 'session lock': 'SessionLock',
    'sessionunlock': 'SessionUnlock', 'session unlock': 'SessionUnlock',
  };

  // Use task.trigger_type (new field) if available, else fall back to triggers[0]
  const rawTrigger = (task.trigger_type || (task.triggers && task.triggers[0]) || 'Once').toLowerCase();
  const normalizedTrigger = triggerTypeMap[rawTrigger] || 'Once';

  // Normalize trigger start: extract time-only (HH:MM) for time-based triggers,
  // and full datetime for Once. Backend returns ISO 8601 like "2024-01-15T08:00:00".
  const startFull = task.trigger_start || '';
  const tIdx      = startFull.indexOf('T');
  const startTime = tIdx >= 0 ? startFull.slice(tIdx + 1, tIdx + 6) : '';

  const prefill = {
    name:         task.name,
    folder:       task.folder,
    description:  task.description || '',
    run_as_user:  task.run_as_user || '',
    run_level:    task.run_level || 0,
    hidden:       task.hidden || false,
    enabled:      task.enabled !== false,

    // Trigger
    trigger_type:      normalizedTrigger,
    trigger_value:     startTime || '08:00',
    trigger_datetime:  startFull.slice(0, 16),
    days_interval:     task.trigger_interval || 1,

    // Advanced
    exec_time_limit:      task.exec_time_limit || 'PT0S',
    repetition_interval:  task.repetition_interval || '',
    repetition_duration:  task.repetition_duration || '',
    stop_at_duration_end: task.stop_at_duration_end || false,
    random_delay:         task.random_delay || '',
    end_boundary:         task.end_boundary || '',
    boot_delay:           task.boot_delay || '',

    // Conditions
    wake_to_run:               task.wake_to_run || false,
    run_only_if_network:       task.run_only_if_network || false,
    run_only_if_idle:          task.run_only_if_idle || false,
    disallow_on_battery_start: task.disallow_on_battery_start || false,
    stop_on_battery:           task.stop_on_battery || false,

    // Settings
    priority:        task.priority !== undefined ? task.priority : 7,
    stop_if_running: task.stop_if_running || false,
    delete_expired:  task.delete_expired || false,

    // Action
    program:     task.program_path || '',
    arguments:   task.program_args || '',
    working_dir: task.working_dir || '',

    // Weekly days of week
    days_of_week: task.trigger_days_of_week || 0,
    // Monthly months
    months_of_year: task.trigger_months || 0,
    // Monthly days
    days_of_month_mask: task.trigger_days_of_month || 0,
  };

  await openCreateDialog(prefill);

  // Switch dialog to edit mode after it's open
  _editTaskPath = task.path;
  const titleEl   = document.getElementById('modal-title');
  const submitBtn = document.getElementById('create-submit-btn');
  if (titleEl)   titleEl.textContent   = '✏️ Edit Task';
  if (submitBtn) submitBtn.textContent = '💾 Save Changes';

  // Pre-fill advanced duration selects (these need the DOM to exist)
  setDurationSelect('cf-exec-limit',   'cf-exec-limit-custom',   prefill.exec_time_limit);
  setDurationSelect('cf-random-delay', 'cf-random-delay-custom', prefill.random_delay);
  setDurationSelect('cf-rep-interval', 'cf-rep-interval-custom', prefill.repetition_interval);
  setDurationSelect('cf-rep-duration', 'cf-rep-duration-custom', prefill.repetition_duration);
  setDurationSelect('cf-boot-delay',   'cf-boot-delay-custom',   prefill.boot_delay);

  // For Interval trigger: parse the repetition_interval ISO 8601 duration into
  // the value/unit quick-pick fields (e.g. "PT30M" → 30 Minutes, "PT2H" → 2 Hours)
  if (normalizedTrigger === 'Interval' && prefill.repetition_interval) {
    const durStr = prefill.repetition_interval; // e.g. "PT30M", "PT2H", "PT1H30M"
    // Parse ISO 8601 duration: extract hours and minutes components
    const hMatch = durStr.match(/(\d+)H/);
    const mMatch = durStr.match(/(\d+)M/);
    const totalMinutes = (hMatch ? parseInt(hMatch[1], 10) * 60 : 0) + (mMatch ? parseInt(mMatch[1], 10) : 0);
    const valEl  = document.getElementById('cf-interval-value');
    const unitEl = document.getElementById('cf-interval-unit');
    if (valEl && unitEl && totalMinutes > 0) {
      if (totalMinutes % 60 === 0) {
        valEl.value  = String(totalMinutes / 60);
        unitEl.value = 'Hours';
      } else {
        valEl.value  = String(totalMinutes);
        unitEl.value = 'Minutes';
      }
    }
    // Pre-fill interval start time
    const intervalStartEl = document.getElementById('cf-interval-start');
    if (intervalStartEl && startTime) intervalStartEl.value = startTime;
  }

  // Pre-fill end boundary
  const endBoundaryEl = document.getElementById('cf-end-boundary');
  if (endBoundaryEl && prefill.end_boundary) {
    endBoundaryEl.value = prefill.end_boundary.slice(0, 16); // datetime-local format
  }

  // Pre-fill stop-at-duration-end
  const stopEndEl = document.getElementById('cf-rep-stop-end');
  if (stopEndEl) stopEndEl.checked = prefill.stop_at_duration_end;

  // Pre-fill days of week (Weekly trigger)
  setDaysOfWeek(prefill.days_of_week);

  // Pre-fill months of year (Monthly trigger)
  setMonthsOfYear(prefill.months_of_year);

  // Pre-fill days of month (Monthly trigger)
  if (prefill.days_of_month_mask) {
    const daysEl = document.getElementById('cf-days-of-month');
    if (daysEl) {
      const days = [];
      for (let i = 0; i < 31; i++) {
        if (prefill.days_of_month_mask & (1 << i)) days.push(i + 1);
      }
      daysEl.value = days.join(', ');
    }
  }

  // Pre-fill conditions and settings checkboxes
  const condFields = [
    ['cf-wake-to-run',     prefill.wake_to_run],
    ['cf-run-on-network',  prefill.run_only_if_network],
    ['cf-run-on-idle',     prefill.run_only_if_idle],
    ['cf-no-battery-start',prefill.disallow_on_battery_start],
    ['cf-stop-on-battery', prefill.stop_on_battery],
    ['cf-stop-existing',   prefill.stop_if_running],
    ['cf-delete-expired',  prefill.delete_expired],
  ];
  condFields.forEach(([id, val]) => {
    const el = document.getElementById(id);
    if (el) el.checked = !!val;
  });

  // Pre-fill priority select
  const priorityEl = document.getElementById('cf-priority');
  if (priorityEl) priorityEl.value = String(prefill.priority);
}

// Pre-fill a duration <select> and its sibling custom <input>.
// If the value matches a predefined option it selects it; otherwise selects
// "custom" and shows the custom input field with the raw ISO duration value.
function setDurationSelect(selectId, customId, value) {
  if (!value) return;
  const sel = document.getElementById(selectId);
  if (!sel) return;
  const options = Array.from(sel.options).map(o => o.value);
  if (options.includes(value)) {
    sel.value = value;
  } else {
    sel.value = 'custom';
    const customEl = document.getElementById(customId);
    if (customEl) {
      customEl.value = value;
      customEl.style.display = '';
    }
  }
}

// Pre-fill days-of-week checkboxes from a bitmask (Sun=1,Mon=2,Tue=4,…,Sat=64)
function setDaysOfWeek(mask) {
  if (!mask) return;
  const days = ['sun','mon','tue','wed','thu','fri','sat'];
  const bits = [1, 2, 4, 8, 16, 32, 64];
  days.forEach((d, i) => {
    const el = document.getElementById('cf-dow-' + d);
    if (el) el.checked = !!(mask & bits[i]);
  });
}

// Pre-fill months-of-year checkboxes from a bitmask (Jan=1,Feb=2,…,Dec=2048)
function setMonthsOfYear(mask) {
  if (!mask) return;
  const months = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
  months.forEach((m, i) => {
    const el = document.getElementById('cf-moy-' + m);
    if (el) el.checked = !!(mask & (1 << i));
  });
}

async function submitCreateTask() {
  // ── Gather values ──────────────────────────────────────────────────────────
  const nameEl    = document.getElementById('cf-name');
  const name      = nameEl ? nameEl.value.trim() : '';
  const folder    = (document.getElementById('cf-folder')      || {}).value    || '\\';
  const desc      = (document.getElementById('cf-desc')        || {}).value.trim() || '';
  const run_level = parseInt((document.getElementById('cf-run-level') || {}).value || '0', 10);
  const run_as    = (document.getElementById('cf-run-as-user') || {}).value.trim() || '';
  const hidden    = !!(document.getElementById('cf-hidden')    || {}).checked;
  const enabled   = (document.getElementById('cf-enabled')     || { checked: true }).checked !== false;

  const trigger_type = (document.getElementById('cf-trigger-type') || {}).value || 'Once';
  const action_type  = (document.getElementById('cf-action-type')  || {}).value || 'program';

  // ── Validation ─────────────────────────────────────────────────────────────
  let valid = true;

  // Helper: mark a form-group with an error
  function markErr(inputId, condition) {
    const el = document.getElementById(inputId);
    if (!el) return;
    const grp = el.closest('.form-group');
    if (grp) grp.classList.toggle('has-error', condition);
    if (condition) valid = false;
  }

  const nameInvalid = !name || name.includes('/') || name.includes('\\');
  if (nameInvalid) {
    if (nameEl) { const g = nameEl.closest('.form-group'); if (g) g.classList.add('has-error'); }
    valid = false;
    if (_createTabIdx !== TAB_GENERAL) { _createTabIdx = TAB_GENERAL; updateCreateTabUI(); }
  } else {
    if (nameEl) { const g = nameEl.closest('.form-group'); if (g) g.classList.remove('has-error'); }
  }

  // ── Build trigger params ───────────────────────────────────────────────────
  let start_datetime = '';
  let days_interval  = 1;
  const today  = new Date().toISOString().slice(0, 10);
  const fmtTime = t => t ? (t.length === 5 ? t + ':00' : t.slice(0, 8)) : '00:00:00';

  switch (trigger_type) {
    case 'Once': {
      const dt = (document.getElementById('cf-datetime') || {}).value || '';
      if (!dt) {
        markErr('cf-datetime', true);
        if (_createTabIdx !== TAB_TRIGGER) { _createTabIdx = TAB_TRIGGER; updateCreateTabUI(); }
      } else {
        start_datetime = dt.includes('T') ? (dt.length === 16 ? dt + ':00' : dt) : `${today}T${fmtTime(dt)}`;
        markErr('cf-datetime', false);
      }
      break;
    }
    case 'Daily': {
      const t = (document.getElementById('cf-daily-time') || {}).value || '';
      if (!t) {
        markErr('cf-daily-time', true);
        if (_createTabIdx !== TAB_TRIGGER) { _createTabIdx = TAB_TRIGGER; updateCreateTabUI(); }
      } else {
        start_datetime = `${today}T${fmtTime(t)}`;
        markErr('cf-daily-time', false);
      }
      const di = parseInt((document.getElementById('cf-days-interval') || {}).value || '1', 10) || 1;
      days_interval = Math.max(1, di);
      markErr('cf-days-interval', di < 1);
      break;
    }
    case 'Weekly': {
      const t = (document.getElementById('cf-weekly-time') || {}).value || '08:00';
      start_datetime = `${today}T${fmtTime(t)}`;
      days_interval  = Math.max(1, parseInt((document.getElementById('cf-weeks-interval') || {}).value || '1', 10) || 1);
      break;
    }
    case 'Monthly': {
      const t   = (document.getElementById('cf-monthly-time') || {}).value || '08:00';
      const day = parseInt((document.getElementById('cf-month-day') || {}).value || '1', 10) || 1;
      start_datetime = `${today}T${fmtTime(t)}`;
      days_interval  = Math.max(1, Math.min(31, day));
      markErr('cf-month-day', day < 1 || day > 31);
      break;
    }
    case 'Idle': {
      const mins = parseInt((document.getElementById('cf-idle-min') || {}).value || '10', 10) || 10;
      days_interval = Math.max(1, mins);
      markErr('cf-idle-min', mins < 1);
      break;
    }
    case 'Interval': {
      // Interval maps to Daily trigger with repetition_interval
      const startTime = (document.getElementById('cf-interval-start') || {}).value || '00:00';
      start_datetime = `${today}T${fmtTime(startTime)}`;
      days_interval  = 1; // Always 1 day interval for the outer trigger
      break;
    }
    default: break; // Boot, Logon, SessionLock, SessionUnlock — no extra params needed
  }

  // ── Build action params ────────────────────────────────────────────────────
  let program_path  = '';
  let arguments_str = '';

  const scriptPath = (document.getElementById('cf-script-path') || {}).value.trim() || '';
  const extraArgs  = (document.getElementById('cf-extra-args')  || {}).value.trim() || '';

  switch (action_type) {
    case 'batch': {
      if (!scriptPath) {
        markErr('cf-script-path', true);
        if (_createTabIdx !== TAB_ACTION) { _createTabIdx = TAB_ACTION; updateCreateTabUI(); }
      } else {
        program_path  = 'C:\\Windows\\System32\\cmd.exe';
        arguments_str = '/c "' + scriptPath + '"' + (extraArgs ? ' ' + extraArgs : '');
        markErr('cf-script-path', false);
      }
      break;
    }
    case 'powershell': {
      if (!scriptPath) {
        markErr('cf-script-path', true);
        if (_createTabIdx !== TAB_ACTION) { _createTabIdx = TAB_ACTION; updateCreateTabUI(); }
      } else {
        program_path  = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
        arguments_str = '-NonInteractive -ExecutionPolicy Bypass -File "' + scriptPath + '"' + (extraArgs ? ' ' + extraArgs : '');
        markErr('cf-script-path', false);
      }
      break;
    }
    case 'python': {
      if (!scriptPath) {
        markErr('cf-script-path', true);
        if (_createTabIdx !== TAB_ACTION) { _createTabIdx = TAB_ACTION; updateCreateTabUI(); }
      } else {
        program_path  = 'python.exe';
        arguments_str = '"' + scriptPath + '"' + (extraArgs ? ' ' + extraArgs : '');
        markErr('cf-script-path', false);
      }
      break;
    }
    case 'vbscript': {
      if (!scriptPath) {
        markErr('cf-script-path', true);
        if (_createTabIdx !== TAB_ACTION) { _createTabIdx = TAB_ACTION; updateCreateTabUI(); }
      } else {
        program_path  = 'C:\\Windows\\System32\\wscript.exe';
        arguments_str = '"' + scriptPath + '"' + (extraArgs ? ' ' + extraArgs : '');
        markErr('cf-script-path', false);
      }
      break;
    }
    case 'program':
    case 'custom':
    default: {
      program_path  = (document.getElementById('cf-program') || {}).value.trim() || '';
      arguments_str = (document.getElementById('cf-args')    || {}).value.trim() || '';
      if (!program_path) {
        markErr('cf-program', true);
        if (_createTabIdx !== TAB_ACTION) { _createTabIdx = TAB_ACTION; updateCreateTabUI(); }
      } else {
        markErr('cf-program', false);
      }
      break;
    }
  }

  const working_dir = (document.getElementById('cf-workdir') || {}).value.trim() || '';

  if (!valid) {
    showToast('Please fix the highlighted errors', 'error');
    return;
  }

  // ── Submit ─────────────────────────────────────────────────────────────────
  // Read all advanced params
  const endBoundaryRaw = (document.getElementById('cf-end-boundary') || {}).value || '';
  const endBoundary    = endBoundaryRaw.length === 16 ? endBoundaryRaw + ':00' : endBoundaryRaw;

  // Handle Interval trigger: compute repetition_interval from unit+value
  let intervalRepetitionInterval = parseDurationSelect('cf-rep-interval','cf-rep-interval-custom');
  if (trigger_type === 'Interval') {
    const val  = parseInt((document.getElementById('cf-interval-value') || {}).value || '1', 10) || 1;
    const unit = (document.getElementById('cf-interval-unit') || {}).value || 'Hours';
    intervalRepetitionInterval = unit === 'Hours' ? `PT${val}H` : `PT${val}M`;
  }

  // Collect env vars from the textarea (newline-separated KEY=VALUE)
  const envVarsEl  = document.getElementById('cf-env-vars');
  const env_vars   = envVarsEl ? envVarsEl.value.trim() : '';

  const advancedParams = {
    execution_time_limit:  parseDurationSelect('cf-exec-limit',  'cf-exec-limit-custom'),
    repetition_interval:   intervalRepetitionInterval,
    repetition_duration:   trigger_type === 'Interval' ? '' : parseDurationSelect('cf-rep-duration','cf-rep-duration-custom'),
    stop_at_duration_end:  trigger_type === 'Interval' ? false : !!(document.getElementById('cf-rep-stop-end')    || {}).checked,
    end_boundary:          endBoundary,
    delay:                 parseDurationSelect('cf-boot-delay',  'cf-boot-delay-custom'),
    random_delay:          parseDurationSelect('cf-random-delay','cf-random-delay-custom'),
    weeks_interval:        parseInt((document.getElementById('cf-weeks-interval') || {}).value || '0', 10) || 0,
    days_of_week:          daysOfWeekBitmask(),
    months_of_year:        monthsOfYearBitmask(),
    days_of_month:         daysOfMonthBitmask(),
    stop_existing:         !!(document.getElementById('cf-stop-existing')   || {}).checked,
    delete_expired:        !!(document.getElementById('cf-delete-expired')  || {}).checked,
    priority:              parseInt((document.getElementById('cf-priority')  || {}).value || '7', 10),
    wake_to_run:           !!(document.getElementById('cf-wake-to-run')     || {}).checked,
    run_only_if_network:   !!(document.getElementById('cf-run-on-network')  || {}).checked,
    run_only_if_idle:      !!(document.getElementById('cf-run-on-idle')     || {}).checked,
    disallow_on_batteries: !!(document.getElementById('cf-no-battery-start')|| {}).checked,
    stop_on_batteries:     !!(document.getElementById('cf-stop-on-battery') || {}).checked,
    env_vars,
  };

  // For Interval, the trigger_type sent to backend is 'Daily' (backend maps Interval -> Daily)
  const backendTriggerType = trigger_type === 'Interval' ? 'Daily' : trigger_type;

  const taskParams = {
    name,
    folder_path:   folder || '\\',
    description:   desc,
    author:        '',
    program_path,
    arguments:     arguments_str,
    working_dir,
    trigger_type:  backendTriggerType,
    start_datetime,
    days_interval,
    run_as_user:   run_as,
    run_level,
    hidden,
    enabled,
    ...advancedParams,
  };

  try {
    if (_editTaskPath) {
      await invoke('update_task', { path: _editTaskPath, params: taskParams });
      appendAuditLog('edit_task', name, 'Trigger: ' + trigger_type);
      showToast('Task updated successfully!', 'success');
    } else {
      await invoke('create_task', { params: taskParams });
      appendAuditLog('create_task', name, 'Trigger: ' + trigger_type);
      showToast('Task created successfully!', 'success');
    }
    _editTaskPath = null;
    closeModal();
    refreshAll();
  } catch (err) {
    showToast((_editTaskPath ? 'Update' : 'Create') + ' failed: ' + err, 'error');
  }
}

// ── Import XML dialog ─────────────────────────────────────────────────────────
async function importXml() {
  let folderOptions = '<option value="\\">&#92; (Root — default)</option>';
  try {
    const folders = await invoke('get_folders');
    folderOptions += folders.map(f =>
      `<option value="${escHtml(f)}">${escHtml(f)}</option>`
    ).join('');
  } catch (_) {}

  const bodyHtml = `
    <div class="form-group">
      <label>Task Name *</label>
      <input type="text" id="ix-name" class="form-control" placeholder="MyImportedTask" />
      <div class="form-error" id="err-ix-name">Task name is required</div>
    </div>
    <div class="form-group">
      <label>Folder</label>
      <select id="ix-folder" class="form-control">${folderOptions}</select>
    </div>
    <details class="form-group" style="cursor:pointer">
      <summary style="font-size:11px;color:var(--text3);user-select:none;padding:2px 0">❓ What is Task XML?</summary>
      <div class="info-box" style="margin-top:8px">
        Task XML is the format used by Windows Task Scheduler to describe a task — its triggers, actions, settings, and security context.
        You can get it by exporting an existing task (right-click a task in this app → ＜/＞ XML → Save as file, or use the Export XML button in the detail panel).
      </div>
    </details>
    <div class="form-group">
      <label>Paste XML *
        <span id="ix-char-count" style="font-weight:400;text-transform:none;color:var(--text3);float:right">0 chars</span>
      </label>
      <textarea id="ix-xml" rows="10" class="form-control"
                placeholder="Paste Windows Task Scheduler XML here…"
                style="font-family:monospace;font-size:11px"
                oninput="document.getElementById('ix-char-count').textContent=this.value.length+' chars'"></textarea>
      <div class="form-error" id="err-ix-xml">XML content is required</div>
      <div id="ix-validate-result" style="font-size:11px;margin-top:4px;display:none"></div>
    </div>`;

  const footerHtml = `
    <button class="btn" onclick="validateImportXml()">🔍 Validate XML</button>
    <button class="btn btn-primary" onclick="submitImportXml()">📥 Import</button>
    <button class="btn" onclick="closeModal()">Cancel</button>`;

  openModal('📥 Import Task XML', bodyHtml, footerHtml);
}

function validateImportXml() {
  const xmlEl    = document.getElementById('ix-xml');
  const resultEl = document.getElementById('ix-validate-result');
  if (!xmlEl || !resultEl) return;
  const xml = xmlEl.value.trim();

  function showResult(ok, msg) {
    resultEl.style.display = '';
    resultEl.innerHTML     = (ok ? '✅ ' : '❌ ') + escHtml(msg);
    resultEl.style.color   = ok ? 'var(--green)' : 'var(--red)';
  }

  if (!xml) { showResult(false, 'No XML to validate'); return; }

  const doc    = new DOMParser().parseFromString(xml, 'application/xml');
  const errEl  = doc.querySelector('parsererror div') || doc.querySelector('parsererror');
  if (errEl) {
    showResult(false, 'Invalid XML — ' + (errEl.textContent.split('\n')[0] || 'parse error'));
  } else {
    showResult(true, 'XML is valid');
  }
}

async function submitImportXml() {
  const name   = (document.getElementById('ix-name')   || {}).value.trim()  || '';
  const folder = (document.getElementById('ix-folder') || {}).value          || '\\';
  const xml    = (document.getElementById('ix-xml')    || {}).value.trim()  || '';

  let valid = true;
  const nameEl = document.getElementById('ix-name');
  if (nameEl) nameEl.closest('.form-group').classList.toggle('has-error', !name);
  if (!name) valid = false;

  const xmlEl = document.getElementById('ix-xml');
  if (xmlEl)  xmlEl.closest('.form-group').classList.toggle('has-error', !xml);
  if (!xml)   valid = false;

  if (!valid) { showToast('Please fill in all required fields', 'error'); return; }

  // Client-side XML validation before sending to backend
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  if (doc.querySelector('parsererror')) {
    showToast('Invalid XML — please check the pasted content', 'error');
    const resultEl = document.getElementById('ix-validate-result');
    if (resultEl) {
      resultEl.style.display = '';
      resultEl.innerHTML     = '❌ Invalid XML — use the Validate button to see details';
      resultEl.style.color   = 'var(--red)';
    }
    return;
  }

  try {
    await invoke('import_task_xml', { folder: folder || '\\', name, xml });
    showToast('Task imported successfully!', 'success');
    closeModal();
    await refreshFolders();
    await loadTasksForFolder(selectedFolder);
  } catch (err) {
    showToast('Import failed: ' + err, 'error');
  }
}

// ── Context menu ──────────────────────────────────────────────────────────────
let ctxTask = null;

function showCtxMenu(event, task) {
  event.preventDefault();
  ctxTask = task;

  const menu = document.getElementById('ctx-menu');
  menu.innerHTML = `
    <div class="ctx-item" data-ctx-action="edit">✏️ Edit</div>
    <div class="ctx-item" data-ctx-action="clone">📋 Clone</div>
    <div class="ctx-sep"></div>
    <div class="ctx-item" data-ctx-action="copy-path">📋 Copy Path</div>
    <div class="ctx-item" data-ctx-action="copy-name">📋 Copy Name</div>
    <div class="ctx-sep"></div>
    <div class="ctx-item" data-ctx-action="run">▶ Run</div>
    <div class="ctx-item" data-ctx-action="stop">⏹ Stop</div>
    <div class="ctx-item" data-ctx-action="toggle">${task.enabled ? '⏸ Disable' : '▶ Enable'}</div>
    <div class="ctx-sep"></div>
    <div class="ctx-item" data-ctx-action="xml">＜/＞ Export XML</div>
    <div class="ctx-sep"></div>
    <div class="ctx-item danger" data-ctx-action="delete">🗑 Delete</div>`;

  // Wire up each item via event delegation on ctxTask (safe — no string embedding)
  menu.onclick = e => {
    const item = e.target.closest('[data-ctx-action]');
    if (!item || !ctxTask) return;
    const t = ctxTask;
    hideCtxMenu();
    switch (item.dataset.ctxAction) {
      case 'edit':      openEditDialog(t);                       break;
      case 'clone':     cloneTask(t);                            break;
      case 'copy-path': navigator.clipboard.writeText(t.path);   break;
      case 'copy-name': navigator.clipboard.writeText(t.name);   break;
      case 'run':       runTask(t.path);                         break;
      case 'stop':      stopTask(t.path);                        break;
      case 'toggle':    toggleTask(t);                           break;
      case 'xml':       exportXml(t.path);                       break;
      case 'delete':    deleteTask(t.path, t.name);              break;
    }
  };

  menu.style.display = 'block';
  // Clamp to viewport so menu doesn't overflow edges
  let x = event.pageX;
  let y = event.pageY;
  requestAnimationFrame(() => {
    const mw = menu.offsetWidth;
    const mh = menu.offsetHeight;
    if (x + mw > window.innerWidth)  x = window.innerWidth  - mw - 4;
    if (y + mh > window.innerHeight) y = window.innerHeight - mh - 4;
    menu.style.left = Math.max(0, x) + 'px';
    menu.style.top  = Math.max(0, y) + 'px';
  });
  menu.style.left = x + 'px';
  menu.style.top  = y + 'px';
}

function hideCtxMenu() {
  const menu = document.getElementById('ctx-menu');
  if (menu) menu.style.display = 'none';
  ctxTask = null;
}

// ── Templates ─────────────────────────────────────────────────────────────────
const TEMPLATES = [
  {
    name: 'Daily Cleanup',
    description: 'Removes temporary files from %TEMP% every day at midnight',
    icon: '🧹',
    prefill: {
      name:          'Daily_Cleanup',
      description:   'Remove temporary files daily',
      trigger_type:  'daily',
      trigger_value: '00:00',
      action_type:   'cmd',
      program:       'C:\\Windows\\System32\\cmd.exe',
      arguments:     '/c del /q /f /s "%TEMP%\\*"',
    }
  },
  {
    name: 'Weekly Backup',
    description: 'Runs a backup script every Sunday at 2 AM',
    icon: '💾',
    prefill: {
      name:          'Weekly_Backup',
      description:   'Weekly backup of important files',
      trigger_type:  'weekly',
      trigger_value: '02:00',
      action_type:   'powershell',
      program:       'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      arguments:     '-NonInteractive -File C:\\Scripts\\backup.ps1',
    }
  },
  {
    name: 'System Health Check',
    description: 'Logs system health metrics to a file daily',
    icon: '💊',
    prefill: {
      name:          'System_Health_Check',
      description:   'Log CPU, memory, and disk usage',
      trigger_type:  'daily',
      trigger_value: '08:00',
      action_type:   'powershell',
      program:       'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      arguments:     '-NonInteractive -Command "Get-ComputerInfo | Out-File C:\\Logs\\health.txt"',
    }
  },
  {
    name: 'Log Rotation',
    description: 'Archives and compresses log files older than 7 days',
    icon: '🗂',
    prefill: {
      name:          'Log_Rotation',
      description:   'Rotate and compress old log files',
      trigger_type:  'daily',
      trigger_value: '01:00',
      action_type:   'powershell',
      program:       'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      arguments:     '-NonInteractive -File C:\\Scripts\\rotate_logs.ps1',
    }
  },
  {
    name: 'Auto Update Check',
    description: 'Checks for application updates every day at startup',
    icon: '🔄',
    prefill: {
      name:          'Auto_Update_Check',
      description:   'Check for available updates daily',
      trigger_type:  'logon',
      action_type:   'powershell',
      program:       'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      arguments:     '-NonInteractive -File C:\\Scripts\\check_updates.ps1',
    }
  },
  {
    name: 'Disk Space Monitor',
    description: 'Sends an alert if disk space falls below 10%',
    icon: '💿',
    prefill: {
      name:          'Disk_Space_Monitor',
      description:   'Monitor disk space and alert if low',
      trigger_type:  'daily',
      trigger_value: '09:00',
      action_type:   'powershell',
      program:       'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      arguments:     '-NonInteractive -File C:\\Scripts\\disk_monitor.ps1',
    }
  },
  {
    name: 'Hourly',
    description: 'Run a script every hour, indefinitely',
    icon: '🕐',
    prefill: { name: 'Hourly_Task', trigger_type: 'Interval', interval_value: 1, interval_unit: 'Hours', interval_start: '00:00' }
  },
  {
    name: 'Every 4 Hours',
    description: 'Run a script every 4 hours, indefinitely',
    icon: '⏱️',
    prefill: { name: 'Every_4_Hours', trigger_type: 'Interval', interval_value: 4, interval_unit: 'Hours', interval_start: '00:00' }
  },
  {
    name: 'Every 6 Hours',
    description: 'Run a script every 6 hours, indefinitely',
    icon: '⏱️',
    prefill: { name: 'Every_6_Hours', trigger_type: 'Interval', interval_value: 6, interval_unit: 'Hours', interval_start: '00:00' }
  },
  {
    name: 'Every 30 Minutes',
    description: 'Run a script every 30 minutes, indefinitely',
    icon: '⏱️',
    prefill: { name: 'Every_30_Min', trigger_type: 'Interval', interval_value: 30, interval_unit: 'Minutes', interval_start: '00:00' }
  },
];

function renderTemplates() {
  const content = document.getElementById('templates-content');
  if (!content) return;

  content.innerHTML = `
    <h2 class="section-heading">📚 Script Library</h2>
    <p class="section-sub">Pre-built task templates — click <em>Use Template</em> to create a task with these settings pre-filled.</p>
    <div class="template-grid">
      ${TEMPLATES.map((tpl, i) => `
        <div class="template-card">
          <div class="template-icon">${tpl.icon}</div>
          <div class="template-name">${escHtml(tpl.name)}</div>
          <div class="template-desc">${escHtml(tpl.description)}</div>
          <button class="btn btn-primary" onclick="useTemplate(${i})">Use Template</button>
        </div>`).join('')}
    </div>`;
}

function useTemplate(idx) {
  const tpl = TEMPLATES[idx];
  if (!tpl) return;
  openCreateDialog(tpl.prefill);
}

// ── Settings ──────────────────────────────────────────────────────────────────
const settings = {
  autoRefresh:      false,
  refreshInterval:  30,
  showSystemTasks:  true,
};
let autoRefreshTimer = null;

function renderSettings() {
  const content = document.getElementById('settings-content');
  if (!content) return;

  const accentColors = ['#3b82f6','#6366f1','#10b981','#f59e0b','#ef4444','#ec4899','#8b5cf6','#06b6d4'];
  const curAccent = localStorage.getItem('wtp_accent') || '#3b82f6';
  const notifyEnabled = localStorage.getItem('wtp_notifyOnFailure') === 'true';
  const minimizeToTray = localStorage.getItem('wtp_minimizeToTray') !== 'false';

  content.innerHTML = `
    <div class="settings-page">
      <h2 class="section-heading">⚙ Settings</h2>

      <div class="settings-section">
        <div class="settings-section-title">General</div>
        <div class="settings-row">
          <div>
            <div class="settings-label">Auto Refresh</div>
            <div class="settings-sub">Automatically reload task list at a set interval</div>
          </div>
          <label class="toggle">
            <input type="checkbox" id="s-auto-refresh" ${settings.autoRefresh ? 'checked' : ''}
                   onchange="onAutoRefreshChange()" />
            <span class="toggle-slider"></span>
          </label>
        </div>
        <div class="settings-row" id="s-interval-row" style="display:${settings.autoRefresh ? '' : 'none'}">
          <div>
            <div class="settings-label">Refresh Interval</div>
            <div class="settings-sub">Seconds between automatic refreshes (5–300)</div>
          </div>
          <input type="number" id="s-refresh-interval" value="${settings.refreshInterval}"
                 min="5" max="300" style="width:80px"
                 onchange="onRefreshIntervalChange()" />
        </div>
        <div class="settings-row">
          <div>
            <div class="settings-label">Minimize to Tray</div>
            <div class="settings-sub">Hide to system tray when closing the window</div>
          </div>
          <label class="toggle">
            <input type="checkbox" id="s-minimize-tray" ${minimizeToTray ? 'checked' : ''}
                   onchange="localStorage.setItem('wtp_minimizeToTray', this.checked)" />
            <span class="toggle-slider"></span>
          </label>
        </div>
      </div>

      <div class="settings-section">
        <div class="settings-section-title">Notifications</div>
        <div class="settings-row">
          <div>
            <div class="settings-label">🔔 Desktop Notifications on Task Failure</div>
            <div class="settings-sub">Show a system notification when a task's result changes to an error</div>
          </div>
          <label class="toggle">
            <input type="checkbox" id="s-notify-failure" ${notifyEnabled ? 'checked' : ''}
                   onchange="onNotifyFailureChange()" />
            <span class="toggle-slider"></span>
          </label>
        </div>
        <div class="settings-row">
          <div>
            <div class="settings-label">Test Notification</div>
            <div class="settings-sub">Send a test desktop notification now</div>
          </div>
          <button class="btn" onclick="sendTestNotification()">🔔 Test</button>
        </div>
      </div>

      <div class="settings-section">
        <div class="settings-section-title">Appearance</div>
        <div class="settings-row">
          <div>
            <div class="settings-label">Show System Tasks</div>
            <div class="settings-sub">Include hidden Windows system tasks in the task list</div>
          </div>
          <label class="toggle">
            <input type="checkbox" id="s-show-system" ${settings.showSystemTasks ? 'checked' : ''}
                   onchange="settings.showSystemTasks = this.checked; localStorage.setItem('showSystemTasks', this.checked); refreshAll()" />
            <span class="toggle-slider"></span>
          </label>
        </div>
        <div class="settings-row" style="flex-direction:column;align-items:flex-start;gap:10px">
          <div>
            <div class="settings-label">Accent Color</div>
            <div class="settings-sub">Choose the UI accent color</div>
          </div>
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
            ${accentColors.map(c => `
              <button class="color-swatch ${c===curAccent?'active':''}" style="background:${c}"
                      onclick="applyAccentColor('${c}')" title="${c}"></button>`).join('')}
            <input type="color" id="s-accent-custom" value="${curAccent}"
                   oninput="applyAccentColor(this.value)" style="width:36px;height:36px;padding:2px;border-radius:6px;border:1px solid var(--border);cursor:pointer;background:transparent" />
          </div>
        </div>
      </div>

      <div class="settings-section">
        <div class="settings-section-title">⌨️ Keyboard Shortcuts</div>
        <div class="settings-row">
          <div class="settings-sub" style="width:100%">
            <button class="btn" onclick="showHelpModal()">Show All Shortcuts</button>
          </div>
        </div>
        <div style="display:grid;grid-template-columns:120px 1fr;gap:4px 12px;font-size:12px;padding:8px 0">
          <span style="color:var(--text3)">N</span><span>New task</span>
          <span style="color:var(--text3)">F5 / R</span><span>Refresh</span>
          <span style="color:var(--text3)">E</span><span>Edit selected task</span>
          <span style="color:var(--text3)">Del</span><span>Delete selected task</span>
          <span style="color:var(--text3)">/ or Ctrl+F</span><span>Focus search</span>
          <span style="color:var(--text3)">Esc</span><span>Close modal/panel</span>
          <span style="color:var(--text3)">1–5</span><span>Navigate pages</span>
          <span style="color:var(--text3)">?</span><span>Show this help</span>
        </div>
      </div>

      <div class="settings-section">
        <div class="settings-section-title">About</div>
        <div class="settings-row">
          <div>
            <div class="settings-label">WinTaskPro</div>
            <div class="settings-sub">Version 1.0.0 &mdash; Windows Task Scheduler Manager</div>
          </div>
        </div>
        <div class="settings-row">
          <div>
            <div class="settings-label">Built with</div>
            <div class="settings-sub">Tauri v2 · Rust · Vanilla JS</div>
          </div>
        </div>
      </div>
    </div>`;
}

function onAutoRefreshChange() {
  settings.autoRefresh = document.getElementById('s-auto-refresh').checked;
  localStorage.setItem('autoRefresh', settings.autoRefresh);
  const row = document.getElementById('s-interval-row');
  if (row) row.style.display = settings.autoRefresh ? '' : 'none';

  if (autoRefreshTimer) { clearInterval(autoRefreshTimer); autoRefreshTimer = null; }
  if (settings.autoRefresh) {
    autoRefreshTimer = setInterval(refreshAll, settings.refreshInterval * 1000);
  }

  updateLiveIndicator(settings.autoRefresh);
}

function updateLiveIndicator(visible) {
  const ind = document.getElementById('live-refresh-indicator');
  if (ind) ind.style.display = visible ? '' : 'none';
}

function onRefreshIntervalChange() {
  settings.refreshInterval = parseInt(document.getElementById('s-refresh-interval').value, 10) || 30;
  localStorage.setItem('refreshInterval', settings.refreshInterval);
  if (settings.autoRefresh) {
    if (autoRefreshTimer) clearInterval(autoRefreshTimer);
    autoRefreshTimer = setInterval(refreshAll, settings.refreshInterval * 1000);
  }
}

// ── App initialisation ────────────────────────────────────────────────────────
async function init() {
  // Apply stored settings before first render
  if (localStorage.getItem('autoRefresh') === 'true') {
    settings.autoRefresh = true;
    settings.refreshInterval = parseInt(localStorage.getItem('refreshInterval') || '30', 10) || 30;
    autoRefreshTimer = setInterval(refreshAll, settings.refreshInterval * 1000);
    updateLiveIndicator(true);
  }
  if (localStorage.getItem('showSystemTasks') === 'false') {
    settings.showSystemTasks = false;
  }

  // Apply saved accent color
  const savedAccent = localStorage.getItem('wtp_accent');
  if (savedAccent) applyAccentColor(savedAccent);

  // Load audit log from localStorage
  try {
    const stored = localStorage.getItem('wtp_auditLog');
    if (stored) _auditLog = JSON.parse(stored);
  } catch (_) { _auditLog = []; }

  // Load column preferences from localStorage
  try {
    const stored = localStorage.getItem('wtp_colPrefs');
    if (stored) Object.assign(_colPrefs, JSON.parse(stored));
  } catch (_) {}

  // Request notification permission if enabled
  if (localStorage.getItem('wtp_notifyOnFailure') === 'true') {
    if (Notification.permission === 'default') {
      Notification.requestPermission();
    }
  }

  // Check admin status
  try {
    const isAdmin = await invoke('is_admin');
    if (!isAdmin) {
      const banner = document.getElementById('admin-banner');
      if (banner) banner.classList.add('show');
      document.body.classList.add('has-banner');
    }
  } catch (_) {}

  // Nav click handlers
  document.querySelectorAll('.nav-item[data-page]').forEach(el => {
    el.addEventListener('click', () => showPage(el.dataset.page));
  });

  // Hide context menu on any click
  document.addEventListener('click', e => {
    const menu = document.getElementById('ctx-menu');
    if (menu && !menu.contains(e.target)) hideCtxMenu();
    // Hide column picker if clicking outside
    const picker = document.getElementById('col-picker');
    const btn = document.getElementById('col-picker-btn');
    if (picker && picker.style.display !== 'none' && !picker.contains(e.target) && e.target !== btn) {
      picker.style.display = 'none';
    }
  });

  // Close modal on overlay click
  document.getElementById('modal-overlay').addEventListener('click', e => {
    if (e.target === document.getElementById('modal-overlay')) closeModal();
  });

  // Global keyboard shortcuts
  document.addEventListener('keydown', handleKeyboard);

  await refreshFolders();
  showPage('dashboard');
}

document.addEventListener('DOMContentLoaded', init);

// ── Health scoring ────────────────────────────────────────────────────────────
function healthScore(task) {
  const code = task.last_result_code;
  if (code !== 0 && code !== TASK_RESULT_RUNNING && code !== TASK_RESULT_NOT_RUN) return 'bad';
  if (task.last_result === 'Not Run Yet' || !task.enabled) return 'warning';
  return 'good';
}

// ── Bulk operations ───────────────────────────────────────────────────────────
function toggleSelectAll(checked) {
  _selectedPaths.clear();
  document.querySelectorAll('.task-cb').forEach(cb => {
    cb.checked = checked;
    const tr = cb.closest('tr');
    if (tr) tr.classList.toggle('row-selected', checked);
    if (checked) _selectedPaths.add(cb.dataset.path);
  });
  updateBulkToolbar();
}

function updateBulkToolbar() {
  const toolbar = document.getElementById('bulk-toolbar');
  const label   = document.getElementById('bulk-count-label');
  if (!toolbar) return;
  const n = _selectedPaths.size;
  toolbar.style.display = n > 0 ? 'flex' : 'none';
  if (label) label.textContent = n + ' selected';
  const allCb   = document.getElementById('select-all-cb');
  const taskCbs = document.querySelectorAll('.task-cb');
  if (allCb && taskCbs.length > 0) {
    allCb.indeterminate = n > 0 && n < taskCbs.length;
    allCb.checked = n === taskCbs.length;
  }
}

function clearBulkSelection() {
  _selectedPaths.clear();
  document.querySelectorAll('.task-cb').forEach(cb => { cb.checked = false; });
  document.querySelectorAll('#task-tbody tr').forEach(r => r.classList.remove('row-selected'));
  const allCb = document.getElementById('select-all-cb');
  if (allCb) { allCb.checked = false; allCb.indeterminate = false; }
  updateBulkToolbar();
}

async function bulkRun() {
  const paths = [..._selectedPaths];
  let ok = 0, fail = 0;
  for (const path of paths) {
    try { await invoke('run_task', { path }); ok++; } catch { fail++; }
  }
  showToast(`Run: ${ok} ok, ${fail} failed`, ok > 0 ? 'success' : 'error');
  appendAuditLog('bulk_run', `${paths.length} tasks`, paths.join(', '));
  clearBulkSelection();
  setTimeout(refreshAll, 1000);
}

async function bulkEnable() {
  const paths = [..._selectedPaths];
  for (const path of paths) {
    try { await invoke('set_task_enabled', { path, enabled: true }); } catch (_) {}
  }
  appendAuditLog('bulk_enable', `${paths.length} tasks`, paths.join(', '));
  showToast(`Enabled ${paths.length} tasks`, 'success');
  clearBulkSelection();
  setTimeout(refreshAll, 500);
}

async function bulkDisable() {
  const paths = [..._selectedPaths];
  for (const path of paths) {
    try { await invoke('set_task_enabled', { path, enabled: false }); } catch (_) {}
  }
  appendAuditLog('bulk_disable', `${paths.length} tasks`, paths.join(', '));
  showToast(`Disabled ${paths.length} tasks`, 'success');
  clearBulkSelection();
  setTimeout(refreshAll, 500);
}

async function bulkExportXml() {
  const paths = [..._selectedPaths];
  for (const path of paths) {
    try {
      const xml  = await invoke('export_task_xml', { path });
      const name = path.split('\\').pop();
      const blob = new Blob([xml], { type: 'application/xml' });
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href = url; a.download = name + '.xml';
      document.body.appendChild(a); a.click();
      document.body.removeChild(a); URL.revokeObjectURL(url);
    } catch (_) {}
  }
  appendAuditLog('bulk_export_xml', `${paths.length} tasks`, '');
  showToast(`Exported ${paths.length} task(s) as XML`, 'success');
}

async function bulkDelete() {
  const paths     = [..._selectedPaths];
  const taskNames = paths.map(p => p.split('\\').pop()).join(', ');
  openModal('Delete ' + paths.length + ' Tasks',
    `<div style="padding:16px 16px 8px">
       <p style="color:var(--text2)">Delete <strong>${paths.length}</strong> tasks? This cannot be undone.</p>
       <div style="font-size:11px;color:var(--text3);margin-top:8px;max-height:100px;overflow-y:auto">${escHtml(taskNames)}</div>
     </div>`,
    `<button class="btn" onclick="closeModal()">Cancel</button>
     <button class="btn btn-danger" id="bulk-del-ok">Delete All</button>`);
  setTimeout(() => {
    const btn = document.getElementById('bulk-del-ok');
    if (btn) btn.onclick = async () => {
      closeModal();
      let ok = 0;
      for (const path of paths) {
        try { await invoke('delete_task', { path }); ok++; } catch (_) {}
      }
      appendAuditLog('bulk_delete', `${ok} tasks`, paths.join(', '));
      showToast(`Deleted ${ok} tasks`, 'success');
      clearBulkSelection();
      closeDetail();
      refreshAll();
    };
  }, 0);
}

// ── Task clone ────────────────────────────────────────────────────────────────
function cloneTask(task) {
  const rawTrigger = task.triggers && task.triggers.length > 0 ? task.triggers[0] : 'Once';
  const triggerDisplayMap = {
    'once':'Once','daily':'Daily','weekly':'Weekly','monthly':'Monthly',
    'at boot':'Boot','boot':'Boot','at logon':'Logon','logon':'Logon',
    'on idle':'Idle','idle':'Idle',
  };
  const normalizedTrigger = triggerDisplayMap[rawTrigger.toLowerCase()] || 'Once';
  const prefill = {
    name:         task.name + '_Copy',
    folder:       task.folder,
    description:  task.description || '',
    run_as_user:  task.run_as_user || '',
    hidden:       task.hidden || false,
    enabled:      task.enabled !== false,
    trigger_type: normalizedTrigger,
  };
  openCreateDialog(prefill);
  setTimeout(() => {
    const titleEl = document.getElementById('modal-title');
    if (titleEl) titleEl.textContent = 'Clone Task';
  }, 50);
}

// ── Folder management ─────────────────────────────────────────────────────────
function openCreateFolderDialog(parentPath) {
  const body = `
    <div class="form-group">
      <label>Folder Name *</label>
      <input type="text" id="new-folder-name" class="form-control" placeholder="MyFolder" />
      <div class="form-hint">Will be created under: ${escHtml(parentPath)}</div>
    </div>`;
  const footer = `
    <button class="btn btn-primary" onclick="submitCreateFolder('${escHtml(parentPath)}')">Create</button>
    <button class="btn" onclick="closeModal()">Cancel</button>`;
  openModal('New Folder', body, footer);
}

async function submitCreateFolder(parentPath) {
  const nameEl = document.getElementById('new-folder-name');
  const name   = nameEl ? nameEl.value.trim() : '';
  if (!name) { showToast('Folder name is required', 'error'); return; }
  const fullPath = parentPath === '\\' ? '\\' + name : parentPath + '\\' + name;
  try {
    await invoke('create_folder', { path: fullPath });
    appendAuditLog('create_folder', fullPath, '');
    showToast('Folder created: ' + fullPath, 'success');
    closeModal();
    await refreshFolders();
  } catch (err) {
    showToast('Create folder failed: ' + err, 'error');
  }
}

// ── Task history ──────────────────────────────────────────────────────────────
async function loadTaskHistory(path) {
  const container = document.getElementById('task-history-container');
  if (!container) return;
  container.innerHTML = '<span class="spinner"></span> Loading...';
  try {
    const records = await invoke('get_task_history', { path, maxRecords: 100 });
    if (!records || records.length === 0) {
      container.innerHTML = `
        <div class="info-box" style="margin-top:6px">
          No history available — ensure Task History is enabled in Windows Event Viewer.
        </div>`;
      return;
    }
    container.innerHTML = `
      <table class="detail-table" style="margin-top:6px">
        <thead><tr>
          <th style="font-size:11px">Start Time</th>
          <th style="font-size:11px">Result</th>
          <th style="font-size:11px">Duration</th>
        </tr></thead>
        <tbody>
          ${records.map(r => `
            <tr class="${r.result_code === 0 ? '' : 'result-error'}">
              <td>${escHtml(r.start_time)}</td>
              <td>${escHtml(r.result_code === 0 ? 'Success' : r.result_text)}</td>
              <td>${r.duration_secs > 0 ? r.duration_secs.toFixed(1) + 's' : '-'}</td>
            </tr>`).join('')}
        </tbody>
      </table>`;
  } catch (err) {
    container.innerHTML = `<div class="info-box">Could not load history: ${escHtml(String(err))}</div>`;
  }
}

// ── Live Monitor ──────────────────────────────────────────────────────────────
function startLiveMonitor() {
  renderLiveMonitor();
  if (liveRefreshInterval) clearInterval(liveRefreshInterval);
  liveRefreshInterval = setInterval(() => {
    if (currentPage === 'live') renderLiveMonitor();
  }, 3000);
}

async function renderLiveMonitor() {
  const content = document.getElementById('live-content');
  if (!content) return;
  try {
    const tasks = await invoke('get_running_tasks');
    const now   = new Date().toLocaleTimeString();
    content.innerHTML = `
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px">
        <h2 class="section-heading" style="margin:0">Live Monitor</h2>
        <span class="live-dot"></span>
        <span style="color:var(--text3);font-size:12px">Auto-refreshes every 3 seconds — last updated: ${now}</span>
      </div>
      ${tasks.length === 0
        ? '<div style="padding:40px;text-align:center;color:var(--text2)">No tasks currently running</div>'
        : `<table class="detail-table" style="width:100%">
            <thead><tr>
              <th>Task Name</th><th>Path</th><th>Current Action</th><th>State</th><th>Action</th>
            </tr></thead>
            <tbody>
              ${tasks.map(t => `
                <tr>
                  <td>${escHtml(t.name)}</td>
                  <td class="cell-trunc" title="${escHtml(t.path)}">${escHtml(t.path)}</td>
                  <td>${escHtml(t.current_action || '-')}</td>
                  <td><span class="badge badge-running">${escHtml(t.state)}</span></td>
                  <td><button class="btn btn-danger" onclick="stopTask('${escHtml(t.path)}')">Stop</button></td>
                </tr>`).join('')}
            </tbody>
          </table>`}`;
  } catch (err) {
    const c = document.getElementById('live-content');
    if (c) c.innerHTML = `<div style="color:var(--red);padding:16px">Error: ${escHtml(String(err))}</div>`;
  }
}

// ── Audit log ─────────────────────────────────────────────────────────────────
function appendAuditLog(action, target, detail) {
  _auditLog.unshift({ ts: new Date().toISOString(), action, target, detail: detail || '' });
  if (_auditLog.length > MAX_AUDIT_LOG_ENTRIES) _auditLog.length = MAX_AUDIT_LOG_ENTRIES;
  try { localStorage.setItem('wtp_auditLog', JSON.stringify(_auditLog)); } catch (_) {}
}

function renderAuditLog() {
  const content = document.getElementById('auditlog-content');
  if (!content) return;
  content.innerHTML = `
    <h2 class="section-heading">Audit Log</h2>
    <div style="display:flex;gap:8px;margin-bottom:12px;align-items:center;flex-wrap:wrap">
      <input type="text" id="al-search" class="form-control" placeholder="Filter..." style="max-width:220px"
             oninput="renderAuditLogTable()" />
      <select id="al-action-filter" class="form-control" style="max-width:160px" onchange="renderAuditLogTable()">
        <option value="">All Actions</option>
        <option value="create_task">Create Task</option>
        <option value="edit_task">Edit Task</option>
        <option value="delete_task">Delete Task</option>
        <option value="run_task">Run Task</option>
        <option value="stop_task">Stop Task</option>
        <option value="enable_task">Enable Task</option>
        <option value="disable_task">Disable Task</option>
        <option value="bulk_run">Bulk Run</option>
        <option value="bulk_delete">Bulk Delete</option>
        <option value="create_folder">Create Folder</option>
      </select>
      <button class="btn" onclick="exportAuditLogCsv()">Export CSV</button>
      <button class="btn btn-danger" onclick="clearAuditLog()">Clear Log</button>
      <span style="color:var(--text3);font-size:11px">${_auditLog.length} entries</span>
    </div>
    <div id="al-table-container"></div>`;
  renderAuditLogTable();
}

function renderAuditLogTable() {
  const container = document.getElementById('al-table-container');
  if (!container) return;
  const search = ((document.getElementById('al-search') || {}).value || '').toLowerCase();
  const actionFilter = (document.getElementById('al-action-filter') || {}).value || '';
  const filtered = _auditLog.filter(e => {
    const matchSearch = !search || [e.action, e.target, e.detail, e.ts].some(v => String(v).toLowerCase().includes(search));
    const matchAction = !actionFilter || e.action === actionFilter;
    return matchSearch && matchAction;
  });
  if (filtered.length === 0) {
    container.innerHTML = '<div style="padding:40px;text-align:center;color:var(--text2)">No log entries found</div>';
    return;
  }
  container.innerHTML = `
    <table class="detail-table" style="width:100%">
      <thead><tr>
        <th>Timestamp</th><th>Action</th><th>Target</th><th>Detail</th>
      </tr></thead>
      <tbody>
        ${filtered.slice(0, 200).map(e => `
          <tr>
            <td style="white-space:nowrap;font-family:monospace;font-size:11px">${escHtml(e.ts.replace('T',' ').replace(/\.\d+Z$/, ''))}</td>
            <td><span class="badge badge-unknown">${escHtml(e.action)}</span></td>
            <td>${escHtml(e.target || '-')}</td>
            <td class="cell-trunc" title="${escHtml(e.detail || '')}">${escHtml(e.detail || '-')}</td>
          </tr>`).join('')}
      </tbody>
    </table>`;
}

function exportAuditLogCsv() {
  const header = 'Timestamp,Action,Target,Detail\n';
  const rows   = _auditLog.map(e =>
    [e.ts, e.action, e.target, e.detail].map(v => '"' + String(v || '').replace(/"/g, '""') + '"').join(',')
  ).join('\n');
  const blob = new Blob([header + rows], { type: 'text/csv' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = 'wintaskpro-audit-' + new Date().toISOString().slice(0,10) + '.csv';
  document.body.appendChild(a); a.click();
  document.body.removeChild(a); URL.revokeObjectURL(url);
}

function clearAuditLog() {
  openModal('Clear Audit Log',
    '<p style="padding:16px">Clear all audit log entries? This cannot be undone.</p>',
    `<button class="btn" onclick="closeModal()">Cancel</button>
     <button class="btn btn-danger" id="al-clear-ok">Clear</button>`);
  setTimeout(() => {
    const btn = document.getElementById('al-clear-ok');
    if (btn) btn.onclick = () => {
      _auditLog = [];
      try { localStorage.removeItem('wtp_auditLog'); } catch (_) {}
      closeModal();
      showToast('Audit log cleared', 'success');
      renderAuditLog();
    };
  }, 0);
}

// ── Column picker ─────────────────────────────────────────────────────────────
const COL_LABELS = {
  cb:'Checkbox', name:'Name', health:'Health', status:'Status',
  triggers:'Triggers', action:'Action', last_run:'Last Run',
  next_run:'Next Run', last_result:'Last Result', controls:'Controls'
};

function toggleColPicker() {
  const picker = document.getElementById('col-picker');
  if (!picker) return;
  if (picker.style.display === 'none' || !picker.style.display) {
    picker.style.display = 'block';
    picker.innerHTML = `<div class="col-picker-inner">
      <div style="font-size:11px;font-weight:600;color:var(--text3);margin-bottom:6px">Visible Columns</div>
      ${Object.keys(_colPrefs).map(col => `
        <label style="display:flex;align-items:center;gap:6px;padding:3px 0;cursor:pointer">
          <input type="checkbox" ${_colPrefs[col]?'checked':''} onchange="toggleColumn('${col}',this.checked)" />
          ${escHtml(COL_LABELS[col] || col)}
        </label>`).join('')}
    </div>`;
  } else {
    picker.style.display = 'none';
  }
}

function toggleColumn(col, visible) {
  _colPrefs[col] = visible;
  try { localStorage.setItem('wtp_colPrefs', JSON.stringify(_colPrefs)); } catch (_) {}
  applyColumnVisibility();
}

function applyColumnVisibility() {
  Object.entries(_colPrefs).forEach(([col, visible]) => {
    document.querySelectorAll(`[data-col="${col}"]`).forEach(el => {
      el.style.display = visible ? '' : 'none';
    });
  });
}

// ── Accent color ──────────────────────────────────────────────────────────────
function applyAccentColor(color) {
  document.documentElement.style.setProperty('--accent', color);
  try { localStorage.setItem('wtp_accent', color); } catch (_) {}
  document.querySelectorAll('.color-swatch').forEach(s => {
    s.classList.toggle('active', s.style.background === color);
  });
}

// ── Notifications ─────────────────────────────────────────────────────────────
function onNotifyFailureChange() {
  const enabled = document.getElementById('s-notify-failure').checked;
  localStorage.setItem('wtp_notifyOnFailure', enabled);
  if (enabled && Notification.permission === 'default') {
    Notification.requestPermission();
  }
}

function sendTestNotification() {
  if (Notification.permission === 'granted') {
    new Notification('WinTaskPro Test', { body: 'Notifications are working!' });
  } else if (Notification.permission === 'denied') {
    showToast('Notifications are blocked by the browser', 'error');
  } else {
    Notification.requestPermission().then(p => {
      if (p === 'granted') new Notification('WinTaskPro Test', { body: 'Notifications are working!' });
    });
  }
}

// ── Script editor ─────────────────────────────────────────────────────────────
let _scriptEditorPath = '';
let _scriptEditorType = '';

function openScriptEditor() {
  const pathEl = document.getElementById('cf-script-path');
  const typeEl = document.getElementById('cf-action-type');
  const path   = pathEl ? pathEl.value.trim() : '';
  const type   = typeEl ? typeEl.value : 'batch';
  _scriptEditorPath = path;
  _scriptEditorType = type;

  const overlay = document.getElementById('script-editor-overlay');
  const titleEl = document.getElementById('script-editor-title');
  const langEl  = document.getElementById('script-editor-lang');
  const langNames = { batch:'Batch', powershell:'PowerShell', python:'Python', vbscript:'VBScript' };
  if (titleEl) titleEl.textContent = 'Edit Script' + (path ? ': ' + path.split('\\').pop() : '');
  if (langEl)  langEl.textContent  = langNames[type] || type;
  if (overlay) overlay.style.display = 'flex';

  const contentEl = document.getElementById('script-editor-content');
  if (contentEl) {
    contentEl.value = '';
    if (path) {
      invoke('read_file', { path }).then(text => {
        if (contentEl) contentEl.value = text;
        updateScriptEditorStats();
      }).catch(() => { updateScriptEditorStats(); });
    }
  }
}

function closeScriptEditor() {
  const overlay = document.getElementById('script-editor-overlay');
  if (overlay) overlay.style.display = 'none';
}

function updateScriptEditorStats() {
  const el    = document.getElementById('script-editor-content');
  const lines = document.getElementById('script-editor-lines');
  if (!el || !lines) return;
  lines.textContent = (el.value ? el.value.split('\n').length : 0) + ' lines';
}

async function saveScriptFile() {
  const contentEl = document.getElementById('script-editor-content');
  if (!contentEl || !_scriptEditorPath) {
    showToast('No file path set', 'error'); return;
  }
  try {
    await invoke('write_file', { path: _scriptEditorPath, content: contentEl.value });
    showToast('Script saved to ' + _scriptEditorPath, 'success');
    closeScriptEditor();
  } catch (err) {
    showToast('Save failed: ' + err, 'error');
  }
}

// ── Environment variables helpers ─────────────────────────────────────────────
function addEnvVar() {
  const ta = document.getElementById('cf-env-vars');
  if (ta) ta.style.display = '';
}

// ── XML tab helpers ───────────────────────────────────────────────────────────
function generateXmlPreview() {
  const ta = document.getElementById('cf-task-xml');
  if (!ta) return;
  const name    = ((document.getElementById('cf-name')         || {}).value || 'MyTask').trim();
  const desc    = ((document.getElementById('cf-desc')         || {}).value || '').trim();
  const program = ((document.getElementById('cf-program')      || {}).value
               || (document.getElementById('cf-script-path')   || {}).value || '').trim();
  const args    = ((document.getElementById('cf-args')         || {}).value
               || (document.getElementById('cf-extra-args')    || {}).value || '').trim();
  const trigger = (document.getElementById('cf-trigger-type')  || {}).value || 'Daily';
  const dt      = ((document.getElementById('cf-daily-time')   || {}).value
               || (document.getElementById('cf-datetime')      || {}).value || '').trim();
  const today   = new Date().toISOString().slice(0, 10);
  const startBoundary = today + 'T' + (dt ? dt.slice(0,5) + ':00' : '08:00:00');

  ta.value = `<?xml version="1.0" encoding="UTF-16"?>\n<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">\n  <RegistrationInfo>\n    <Description>${escHtml(desc)}</Description>\n  </RegistrationInfo>\n  <Triggers>\n    <CalendarTrigger>\n      <StartBoundary>${startBoundary}</StartBoundary>\n      <Enabled>true</Enabled>\n    </CalendarTrigger>\n  </Triggers>\n  <Actions Context="Author">\n    <Exec>\n      <Command>${escHtml(program)}</Command>\n      <Arguments>${escHtml(args)}</Arguments>\n    </Exec>\n  </Actions>\n  <Settings>\n    <Enabled>true</Enabled>\n    <Hidden>false</Hidden>\n  </Settings>\n</Task>`;
}

function applyXmlToForm() {
  const ta = document.getElementById('cf-task-xml');
  if (!ta) return;
  try {
    const doc  = new DOMParser().parseFromString(ta.value.trim(), 'application/xml');
    const txt  = sel => { const el = doc.querySelector(sel); return el ? el.textContent.trim() : ''; };
    const desc = txt('Description');
    const cmd  = txt('Command');
    const args = txt('Arguments');
    if (desc) { const el = document.getElementById('cf-desc');    if (el) el.value = desc; }
    if (cmd)  { const el = document.getElementById('cf-program'); if (el) el.value = cmd; }
    if (args) { const el = document.getElementById('cf-args');    if (el) el.value = args; }
    showToast('XML applied to form (best-effort)', 'success');
  } catch (err) {
    showToast('Failed to parse XML: ' + err, 'error');
  }
}

// ── Interval quick-pick ───────────────────────────────────────────────────────
function setIntervalQuick(value, unit) {
  const valEl  = document.getElementById('cf-interval-value');
  const unitEl = document.getElementById('cf-interval-unit');
  if (valEl)  valEl.value  = value;
  if (unitEl) unitEl.value = unit;
}

// ── Keyboard shortcuts ────────────────────────────────────────────────────────
function handleKeyboard(e) {
  const tag = document.activeElement && document.activeElement.tagName;
  const inInput = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
  if (e.key === 'Escape') {
    closeModal(); closeScriptEditor(); closeHelpModal(); hideCtxMenu(); return;
  }
  if (inInput) return;
  switch (e.key) {
    case 'n': case 'N':
      if (!e.ctrlKey && !e.metaKey) { e.preventDefault(); openCreateDialog(); }
      break;
    case 'F5': case 'r': case 'R': e.preventDefault(); refreshAll(); break;
    case 'e': case 'E': if (selectedTask) openEditDialog(selectedTask); break;
    case 'Delete': if (selectedTask) deleteTask(selectedTask.path, selectedTask.name); break;
    case '/': e.preventDefault(); { const s = document.getElementById('search-input'); if (s) s.focus(); } break;
    case 'f': if (e.ctrlKey) { e.preventDefault(); const s = document.getElementById('search-input'); if (s) s.focus(); } break;
    case '?': showHelpModal(); break;
    case '1': showPage('dashboard');  break;
    case '2': showPage('tasks');      break;
    case '3': showPage('live');       break;
    case '4': showPage('templates');  break;
    case '5': showPage('settings');   break;
  }
}

function showHelpModal() {
  const body = `
    <div style="padding:4px 0">
      <table class="detail-table">
        <thead><tr><th>Key</th><th>Action</th></tr></thead>
        <tbody>
          <tr><td style="font-family:monospace">N</td><td>New task</td></tr>
          <tr><td style="font-family:monospace">F5 / R</td><td>Refresh all tasks</td></tr>
          <tr><td style="font-family:monospace">E</td><td>Edit selected task</td></tr>
          <tr><td style="font-family:monospace">Del</td><td>Delete selected task</td></tr>
          <tr><td style="font-family:monospace">/</td><td>Focus search box</td></tr>
          <tr><td style="font-family:monospace">Escape</td><td>Close modal / panel</td></tr>
          <tr><td style="font-family:monospace">?</td><td>Show keyboard shortcuts</td></tr>
          <tr><td style="font-family:monospace">1</td><td>Go to Dashboard</td></tr>
          <tr><td style="font-family:monospace">2</td><td>Go to Task Manager</td></tr>
          <tr><td style="font-family:monospace">3</td><td>Go to Live Monitor</td></tr>
          <tr><td style="font-family:monospace">4</td><td>Go to Script Library</td></tr>
          <tr><td style="font-family:monospace">5</td><td>Go to Settings</td></tr>
        </tbody>
      </table>
    </div>`;
  const overlay = document.getElementById('help-modal-overlay');
  const bodyEl  = document.getElementById('help-modal-body');
  if (overlay) overlay.style.display = 'flex';
  if (bodyEl)  bodyEl.innerHTML = body;
}

function closeHelpModal() {
  const overlay = document.getElementById('help-modal-overlay');
  if (overlay) overlay.style.display = 'none';
}

// ── Enhanced dashboard ────────────────────────────────────────────────────────
loadDashboard = async function() {
  const content = document.getElementById('dash-content');
  content.innerHTML = '<div class="loading-msg"><span class="spinner"></span> Loading...</div>';
  setStatus('Loading dashboard...');
  try {
    const tasks    = await invoke('get_all_tasks');
    const total    = tasks.length;
    const running  = tasks.filter(t => t.status === 'Running').length;
    const ready    = tasks.filter(t => t.status === 'Ready').length;
    const disabled = tasks.filter(t => t.status === 'Disabled').length;
    const failed   = tasks.filter(t => t.last_result_code !== 0 && t.last_result_code !== TASK_RESULT_RUNNING && t.last_result_code !== TASK_RESULT_NOT_RUN).length;
    const healthy  = tasks.filter(t => healthScore(t) === 'good').length;
    const warning  = tasks.filter(t => healthScore(t) === 'warning').length;
    const bad      = tasks.filter(t => healthScore(t) === 'bad').length;
    const upcoming = [...tasks]
      .filter(t => t.next_run && t.next_run !== 'Never' && t.next_run !== 'N/A')
      .sort((a, b) => a.next_run.localeCompare(b.next_run)).slice(0, 10);
    const recentlyFailed = tasks
      .filter(t => t.last_result_code !== 0 && t.last_result_code !== TASK_RESULT_NOT_RUN && t.last_result_code !== TASK_RESULT_RUNNING)
      .sort((a, b) => b.last_run.localeCompare(a.last_run)).slice(0, 5);
    const healthPct = total > 0 ? Math.round((ready / total) * 100) : 0;

    content.innerHTML = `
      <div class="stat-grid">
        <div class="stat-card"><div class="stat-icon">All</div><div class="stat-val">${total}</div><div class="stat-lbl">Total Tasks</div></div>
        <div class="stat-card running"><div class="stat-icon">Running</div><div class="stat-val">${running}</div><div class="stat-lbl">Running</div></div>
        <div class="stat-card ready"><div class="stat-icon">Ready</div><div class="stat-val">${ready}</div><div class="stat-lbl">Ready</div></div>
        <div class="stat-card disabled"><div class="stat-icon">Off</div><div class="stat-val">${disabled}</div><div class="stat-lbl">Disabled</div></div>
        <div class="stat-card"><div class="stat-icon">Err</div><div class="stat-val" style="color:var(--red)">${failed}</div><div class="stat-lbl">Failed</div></div>
      </div>
      <div style="margin:10px 0 4px;font-size:11px;color:var(--text3)">System Health: ${healthPct}% Ready</div>
      <div class="health-bar-wrap"><div class="health-bar" style="width:${healthPct}%"></div></div>
      <div style="display:flex;gap:16px;margin:8px 0 16px;font-size:12px">
        <span><span class="health-dot good"></span> ${healthy} Healthy</span>
        <span><span class="health-dot warning"></span> ${warning} Warning</span>
        <span><span class="health-dot bad"></span> ${bad} Failing</span>
      </div>
      <div class="dash-cols">
        <div class="dash-card">
          <div class="dash-card-title">Upcoming Tasks (Next 10)</div>
          ${upcoming.length === 0
            ? '<div style="padding:20px;text-align:center;color:var(--text2)">No upcoming scheduled tasks</div>'
            : `<table class="detail-table" style="width:100%">
                <thead><tr><th>Name</th><th>Next Run</th><th>Trigger</th></tr></thead>
                <tbody>${upcoming.map(t => `
                  <tr style="cursor:pointer" onclick="showPage('tasks')">
                    <td>${escHtml(t.name)}</td>
                    <td>${escHtml(t.next_run)}</td>
                    <td>${escHtml((t.triggers||['-'])[0])}</td>
                  </tr>`).join('')}
                </tbody></table>`}
        </div>
        <div class="dash-card">
          <div class="dash-card-title">Recently Failed</div>
          ${recentlyFailed.length === 0
            ? '<div style="padding:20px;text-align:center;color:var(--text2)">No failed tasks - all good!</div>'
            : `<table class="detail-table" style="width:100%">
                <thead><tr><th>Name</th><th>Last Run</th><th>Error</th></tr></thead>
                <tbody>${recentlyFailed.map(t => `
                  <tr>
                    <td>${escHtml(t.name)}</td>
                    <td>${escHtml(t.last_run)}</td>
                    <td class="result-error">${escHtml(t.last_result)}</td>
                  </tr>`).join('')}
                </tbody></table>
              <button class="btn" style="margin-top:8px" onclick="showPage('tasks')">View All</button>`}
        </div>
      </div>`;
    setStatus('Loaded ' + total + ' total tasks');
  } catch (err) {
    const c = document.getElementById('dash-content');
    if (c) c.innerHTML = `<div style="color:var(--red);padding:16px">Failed to load dashboard: ${escHtml(String(err))}</div>`;
    setStatus('Error loading dashboard');
    showToast('Dashboard error: ' + err, 'error');
  }
};
