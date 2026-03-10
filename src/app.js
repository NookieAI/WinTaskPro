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

// Debounce timer for search input
let searchDebounce = null;

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

  if (page === 'dashboard') loadDashboard();
  if (page === 'tasks')     loadTasksForFolder(selectedFolder);
  if (page === 'templates') renderTemplates();
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

    return `<tr data-idx="${idx}">
      <td>
        <span class="task-name">${escHtml(task.name)}</span>
        ${task.hidden ? '<span class="badge badge-unknown" title="Hidden">H</span>' : ''}
      </td>
      <td><span class="badge badge-${badgeClass(task.status)}">${escHtml(task.status || '—')}</span></td>
      <td class="cell-trunc" title="${escHtml(triggers)}">${escHtml(triggers)}</td>
      <td class="cell-trunc" title="${escHtml(firstAction || '')}">${escHtml(actionText)}</td>
      <td>${escHtml(task.last_run || '—')}</td>
      <td>${escHtml(task.next_run || '—')}</td>
      <td class="${resultClass(task.last_result)}">${escHtml(task.last_result || '—')}</td>
      <td class="controls-cell">
        <button class="icon-btn" title="Run"    data-action="run"    data-idx="${idx}">▶</button>
        <button class="icon-btn" title="Stop"   data-action="stop"   data-idx="${idx}">⏹</button>
        <button class="icon-btn danger" title="Delete" data-action="delete" data-idx="${idx}">🗑</button>
      </td>
    </tr>`;
  }).join('');

  // Event delegation for row clicks and control buttons
  tbody.onclick = e => {
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

  sections.push(`
    <div class="detail-section">
      <div class="detail-section-title">General</div>
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
    </div>`);

  document.getElementById('detail-body').innerHTML = sections.join('');

  // Wire up buttons
  const runBtn    = document.getElementById('d-run-btn');
  const stopBtn   = document.getElementById('d-stop-btn');
  const toggleBtn = document.getElementById('d-toggle-btn');
  const xmlBtn    = document.getElementById('d-xml-btn');
  const deleteBtn = document.getElementById('d-delete-btn');

  runBtn.onclick    = () => runTask(task.path);
  stopBtn.onclick   = () => stopTask(task.path);
  toggleBtn.onclick = () => toggleTask(task);
  toggleBtn.textContent = task.enabled ? '⏸ Disable' : '▶ Enable';
  xmlBtn.onclick    = () => exportXml(task.path);
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
  showToast('Refreshed', 'success');
}

// ── Create task dialog ────────────────────────────────────────────────────────
async function openCreateDialog(prefill = {}) {
  // Normalize trigger type to match Rust enum casing
  const triggerNorm = {
    'once':'Once','daily':'Daily','weekly':'Weekly','monthly':'Monthly',
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

  const bodyHtml = `
    <div class="modal-tabs" id="create-tabs">
      <div class="modal-tab active" data-tab="0">General</div>
      <div class="modal-tab" data-tab="1">Trigger</div>
      <div class="modal-tab" data-tab="2">Action</div>
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
          <input type="datetime-local" id="cf-datetime" class="form-control" value="${escHtml(prefill.trigger_value || '')}" />
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
  if (prevBtn)   prevBtn.style.display   = _createTabIdx > 0       ? '' : 'none';
  if (nextBtn)   nextBtn.style.display   = _createTabIdx < 2       ? '' : 'none';
  if (submitBtn) submitBtn.style.display = _createTabIdx === 2     ? '' : 'none';
}

// Move to next (+1) or previous (-1) tab
function createTabNav(delta) {
  _createTabIdx = Math.max(0, Math.min(2, _createTabIdx + delta));
  updateCreateTabUI();
}

// Show/hide trigger-specific sub-sections based on selected trigger type
function updateTriggerFields() {
  const typeEl = document.getElementById('cf-trigger-type');
  if (!typeEl) return;
  const val = typeEl.value.toLowerCase();
  ['once','daily','weekly','monthly','boot','logon','idle','sessionlock','sessionunlock'].forEach(g => {
    const el = document.getElementById('tf-' + g);
    if (el) el.style.display = 'none';
  });
  const active = document.getElementById('tf-' + val);
  if (active) active.style.display = '';
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
    if (_createTabIdx !== 0) { _createTabIdx = 0; updateCreateTabUI(); }
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
        if (_createTabIdx !== 1) { _createTabIdx = 1; updateCreateTabUI(); }
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
        if (_createTabIdx !== 1) { _createTabIdx = 1; updateCreateTabUI(); }
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
        if (_createTabIdx !== 2) { _createTabIdx = 2; updateCreateTabUI(); }
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
        if (_createTabIdx !== 2) { _createTabIdx = 2; updateCreateTabUI(); }
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
        if (_createTabIdx !== 2) { _createTabIdx = 2; updateCreateTabUI(); }
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
        if (_createTabIdx !== 2) { _createTabIdx = 2; updateCreateTabUI(); }
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
        if (_createTabIdx !== 2) { _createTabIdx = 2; updateCreateTabUI(); }
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
  try {
    await invoke('create_task', {
      params: {
        name,
        folder_path:   folder || '\\',
        description:   desc,
        author:        '',
        program_path,
        arguments:     arguments_str,
        working_dir,
        trigger_type,
        start_datetime,
        days_interval,
        run_as_user:   run_as,
        run_level,
        hidden,
        enabled,
      }
    });
    showToast('Task created successfully!', 'success');
    closeModal();
    refreshAll();
  } catch (err) {
    showToast('Create failed: ' + err, 'error');
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
    <div class="ctx-item" data-ctx-action="run">▶ Run</div>
    <div class="ctx-item" data-ctx-action="stop">⏹ Stop</div>
    <div class="ctx-item" data-ctx-action="toggle">${task.enabled ? '⏸ Disable' : '▶ Enable'}</div>
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
      case 'run':    runTask(t.path);              break;
      case 'stop':   stopTask(t.path);             break;
      case 'toggle': toggleTask(t);                break;
      case 'xml':    exportXml(t.path);            break;
      case 'delete': deleteTask(t.path, t.name);   break;
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
            <div class="settings-sub">Seconds between automatic refreshes</div>
          </div>
          <input type="number" id="s-refresh-interval" value="${settings.refreshInterval}"
                 min="5" max="300" style="width:80px"
                 onchange="onRefreshIntervalChange()" />
        </div>
      </div>

      <div class="settings-section">
        <div class="settings-section-title">Display</div>
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
  }
  if (localStorage.getItem('showSystemTasks') === 'false') {
    settings.showSystemTasks = false;
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
  });

  // Close modal on overlay click
  document.getElementById('modal-overlay').addEventListener('click', e => {
    if (e.target === document.getElementById('modal-overlay')) closeModal();
  });

  // Escape key: close modal and context menu
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      closeModal();
      hideCtxMenu();
    }
  });

  await refreshFolders();
  showPage('dashboard');
}

document.addEventListener('DOMContentLoaded', init);