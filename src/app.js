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
  confirmAction(`Delete task "${name}"?\nThis cannot be undone.`, async () => {
    try {
      await invoke('delete_task', { path });
      showToast('Task deleted', 'success');
      closeDetail();
      refreshAll();
    } catch (err) {
      showToast('Delete failed: ' + err, 'error');
    }
  });
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
let _lastExportedXml = '';

async function exportXml(path) {
  try {
    const xml = await invoke('export_task_xml', { path });
    _lastExportedXml = xml;
    openModal('Exported XML', `<pre class="xml-pre">${escHtml(xml)}</pre>`,
      `<button class="btn btn-primary" id="copy-xml-btn">📋 Copy</button>
       <button class="btn" onclick="closeModal()">Close</button>`);
    // Wire up copy button safely after modal renders
    requestAnimationFrame(() => {
      const copyBtn = document.getElementById('copy-xml-btn');
      if (copyBtn) copyBtn.onclick = () => copyXml(_lastExportedXml);
    });
  } catch (err) {
    showToast('Export failed: ' + err, 'error');
  }
}

function copyXml(text) {
  navigator.clipboard.writeText(text).then(() => showToast('Copied to clipboard', 'success'));
}

// ── Refresh all ───────────────────────────────────────────────────────────────
async function refreshAll() {
  await refreshFolders();
  await loadTasksForFolder(selectedFolder);
  showToast('Refreshed', 'success');
}

// ── Create task dialog ────────────────────────────────────────────────────────
async function openCreateDialog(prefill = {}) {
  // Build folder options
  let folderOptions = '<option value="">Select folder…</option>';
  try {
    const folders = await invoke('get_folders');
    folderOptions += folders.map(f =>
      `<option value="${escHtml(f)}" ${prefill.folder === f ? 'selected' : ''}>${escHtml(f)}</option>`
    ).join('');
  } catch (_) {}

  const bodyHtml = `
    <div class="form-tabs">
      <div class="form-group">
        <label>Task Name *</label>
        <input type="text" id="cf-name" value="${escHtml(prefill.name || '')}" placeholder="MyTask" />
      </div>
      <div class="form-group">
        <label>Folder</label>
        <select id="cf-folder">${folderOptions}</select>
      </div>
      <div class="form-group">
        <label>Description</label>
        <textarea id="cf-desc" rows="2">${escHtml(prefill.description || '')}</textarea>
      </div>
      <hr/>
      <strong>Trigger</strong>
      <div class="form-group">
        <label>Trigger Type</label>
        <select id="cf-trigger-type" onchange="updateTriggerValueLabel()">
          <option value="once"    ${prefill.trigger_type==='once'    ?'selected':''}>Once</option>
          <option value="daily"   ${prefill.trigger_type==='daily'   ?'selected':''}>Daily</option>
          <option value="weekly"  ${prefill.trigger_type==='weekly'  ?'selected':''}>Weekly</option>
          <option value="boot"    ${prefill.trigger_type==='boot'    ?'selected':''}>At Boot</option>
          <option value="logon"   ${prefill.trigger_type==='logon'   ?'selected':''}>At Logon</option>
        </select>
      </div>
      <div class="form-group" id="cf-trigger-value-group">
        <label id="cf-trigger-value-label">Date/Time</label>
        <input type="datetime-local" id="cf-trigger-value" value="${escHtml(prefill.trigger_value || '')}" />
      </div>
      <hr/>
      <strong>Action</strong>
      <div class="form-group">
        <label>Action Type</label>
        <select id="cf-action-type">
          <option value="program"    ${prefill.action_type==='program'    ?'selected':''}>Program/Script</option>
          <option value="powershell" ${prefill.action_type==='powershell' ?'selected':''}>PowerShell</option>
          <option value="cmd"        ${prefill.action_type==='cmd'        ?'selected':''}>CMD</option>
        </select>
      </div>
      <div class="form-group">
        <label>Program / Script *</label>
        <input type="text" id="cf-program" value="${escHtml(prefill.program || '')}" placeholder="C:\\Windows\\System32\\cmd.exe" />
      </div>
      <div class="form-group">
        <label>Arguments</label>
        <input type="text" id="cf-args" value="${escHtml(prefill.arguments || '')}" placeholder="/c echo hello" />
      </div>
      <div class="form-group">
        <label>Working Directory</label>
        <input type="text" id="cf-workdir" value="${escHtml(prefill.working_dir || '')}" placeholder="C:\\Temp" />
      </div>
      <div class="form-group">
        <label><input type="checkbox" id="cf-enabled" ${prefill.enabled !== false ? 'checked' : ''} /> Enabled</label>
      </div>
    </div>`;

  const footerHtml = `
    <button class="btn btn-primary" onclick="submitCreateTask()">✅ Create Task</button>
    <button class="btn" onclick="closeModal()">Cancel</button>`;

  openModal('Create New Task', bodyHtml, footerHtml);
  updateTriggerValueLabel();
}

function updateTriggerValueLabel() {
  const type  = document.getElementById('cf-trigger-type');
  const group = document.getElementById('cf-trigger-value-group');
  const label = document.getElementById('cf-trigger-value-label');
  const input = document.getElementById('cf-trigger-value');
  if (!type || !group || !label || !input) return;

  const val = type.value;
  if (val === 'boot' || val === 'logon') {
    group.style.display = 'none';
  } else {
    group.style.display = '';
    if (val === 'daily' || val === 'weekly') {
      label.textContent = 'Start Time (HH:MM or datetime)';
      input.type        = 'time';
    } else {
      label.textContent = 'Date/Time';
      input.type        = 'datetime-local';
    }
  }
}

async function submitCreateTask() {
  const name            = document.getElementById('cf-name').value.trim();
  const folder          = document.getElementById('cf-folder').value;
  const description     = document.getElementById('cf-desc').value.trim();
  const trigger_type_raw= document.getElementById('cf-trigger-type').value;
  const trigger_value   = document.getElementById('cf-trigger-value').value;
  const program         = document.getElementById('cf-program').value.trim();
  const args            = document.getElementById('cf-args').value.trim();
  const working_dir     = document.getElementById('cf-workdir').value.trim();
  const enabled         = document.getElementById('cf-enabled').checked;

  if (!name)    { showToast('Task name is required', 'error'); return; }
  if (!program) { showToast('Program/script is required', 'error'); return; }

  // Capitalize trigger type to match Rust enum values
  const triggerTypeMap = {
    'once': 'Once', 'daily': 'Daily', 'weekly': 'Weekly',
    'boot': 'Boot', 'logon': 'Logon',
  };
  const trigger_type = triggerTypeMap[trigger_type_raw] || 'Once';

  // Build ISO 8601 datetime from form input
  let start_datetime = '';
  if (trigger_value) {
    if (trigger_value.includes('T')) {
      // datetime-local input "YYYY-MM-DDTHH:MM" — ensure it has seconds
      const parts = trigger_value.split('T');
      const timePart = parts[1] || '00:00';
      const timeWithSecs = timePart.length === 5 ? timePart + ':00' : timePart.slice(0, 8);
      start_datetime = `${parts[0]}T${timeWithSecs}`;
    } else {
      // time input "HH:MM" or "HH:MM:SS" — use today's date
      const today = new Date().toISOString().slice(0, 10);
      const timePart = trigger_value.length === 5 ? trigger_value + ':00' : trigger_value.slice(0, 8);
      start_datetime = `${today}T${timePart}`;
    }
  }

  try {
    await invoke('create_task', {
      params: {
        name,
        folder_path: folder || '\\',
        description,
        author: '',
        program_path: program,
        arguments: args,
        working_dir,
        trigger_type,
        start_datetime,
        days_interval: 1,
        run_as_user: '',
        run_level: 0,
        hidden: false,
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
  let folderOptions = '<option value="">Select folder…</option>';
  try {
    const folders = await invoke('get_folders');
    folderOptions += folders.map(f =>
      `<option value="${escHtml(f)}">${escHtml(f)}</option>`
    ).join('');
  } catch (_) {}

  const bodyHtml = `
    <div class="form-group">
      <label>Task Name *</label>
      <input type="text" id="ix-name" placeholder="MyImportedTask" />
    </div>
    <div class="form-group">
      <label>Folder</label>
      <select id="ix-folder">${folderOptions}</select>
    </div>
    <div class="form-group">
      <label>Paste XML *</label>
      <textarea id="ix-xml" rows="10" placeholder="Paste task XML here…" style="font-family:monospace;font-size:12px"></textarea>
    </div>`;

  const footerHtml = `
    <button class="btn btn-primary" onclick="submitImportXml()">📥 Import</button>
    <button class="btn" onclick="closeModal()">Cancel</button>`;

  openModal('Import Task XML', bodyHtml, footerHtml);
}

async function submitImportXml() {
  const name   = document.getElementById('ix-name').value.trim();
  const folder = document.getElementById('ix-folder').value;
  const xml    = document.getElementById('ix-xml').value.trim();

  if (!name)   { showToast('Task name is required', 'error'); return; }
  if (!xml)    { showToast('XML is required', 'error'); return; }

  // Validate XML client-side before sending to backend
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  if (doc.querySelector('parsererror')) {
    showToast('Invalid XML — please check the pasted content', 'error');
    return;
  }

  try {
    await invoke('import_task_xml', { folder, name, xml });
    showToast('Task imported successfully!', 'success');
    closeModal();
    refreshAll();
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