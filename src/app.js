// ── Tauri invoke (withGlobalTauri: true) ─────────────────────────────────────
const invoke = (window.__TAURI__?.core?.invoke) ?? (() => Promise.reject('Tauri IPC not available'));

// ── Dev logger (mirrors to backend log file via log_event IPC) ───────────────
//
// dlog(target, level, msg, dataObj?) — fires async; never throws.
// Use throughout the codebase to record meaningful actions:
//   dlog('init', 'info', 'app started');
//   dlog('submit_task', 'info', 'update OK', { name, path });
//   dlog('refreshAll', 'warn', 'partial failure', { error });
//
// Level tags: 'trace' | 'debug' | 'info' | 'warn' | 'error'
// Convenience wrappers below: dtrace, ddebug, dinfo, dwarn, derror.
//
// CRITICAL: This function MUST NOT throw. It is called from the global
// window.onerror handler; any throw would recurse infinitely and lock the
// WebView. Every step is wrapped in try/catch and degrades silently.
//
// The log_event IPC writes through to the same %LOCALAPPDATA% file that
// Rust-side log_info!/log_warn! macros write to, so frontend and backend
// events appear interleaved in chronological order.
function dlog(target, level, msg, data) {
  try {
    // Browser-console mirror so DevTools shows the same line (with stack).
    // Skip TRACE/DEBUG in console to keep noise down — they still go to file.
    if (level !== 'trace' && level !== 'debug') {
      const consoleLevel = (level === 'error' || level === 'warn') ? level : 'log';
      try {
        // eslint-disable-next-line no-console
        if (data !== undefined) console[consoleLevel](`[${target}] ${msg}`, data);
        else                     console[consoleLevel](`[${target}] ${msg}`);
      } catch (_) { /* console may be sealed in some contexts */ }
    }

    // Compose one-line message (file logger collapses newlines to ¶).
    let fullMsg = String(msg);
    if (data !== undefined) {
      try { fullMsg += ' | ' + JSON.stringify(data); }
      catch (_) { fullMsg += ' | [unserialisable data]'; }
    }

    // Fire-and-forget. `invoke` is always a function (thanks to the `??`
    // fallback above), so we get a Promise. `.catch` swallows rejections
    // including "IPC not available" pre-init.
    const p = invoke('log_event', { level: String(level || 'info'), target: String(target || ''), message: fullMsg });
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch (_) {
    // Absolute last-resort guard: do NOT let dlog throw under any
    // circumstance. Error handlers below invoke dlog; a throw here creates
    // an infinite recursion that locks the WebView.
  }
}
const dtrace = (t, m, d) => dlog(t, 'trace', m, d);
const ddebug = (t, m, d) => dlog(t, 'debug', m, d);
const dinfo  = (t, m, d) => dlog(t, 'info',  m, d);
const dwarn  = (t, m, d) => dlog(t, 'warn',  m, d);
const derror = (t, m, d) => dlog(t, 'error', m, d);

// Catch unhandled errors and route to the log so we never lose a crash diag.
// BUG FIX (2.1.0): previous version used `e.error?.stack?.toString().slice(0, 800)`
// where `.slice` was NOT optional-chained. If `.toString()` returned undefined
// (e.g. errors without a stack, or fired from outside any frame), the .slice
// call threw a TypeError — which re-fired the error event — infinite recursion.
// The nested try/catch is belt-and-suspenders: dlog() itself is also hardened
// to never throw (see above).
window.addEventListener('error', function (e) {
  try {
    const stack = (e && e.error && typeof e.error.stack === 'string') ? e.error.stack.slice(0, 800) : '';
    derror('window.onerror', (e && e.message) ? String(e.message) : 'unknown', {
      file: e && e.filename, line: e && e.lineno, col: e && e.colno, stack
    });
  } catch (_) { /* never let the error handler itself throw */ }
});
window.addEventListener('unhandledrejection', function (e) {
  try {
    const reason = e && e.reason;
    const stack = (reason && typeof reason.stack === 'string') ? reason.stack.slice(0, 800) : '';
    derror('window.unhandledrejection', String(reason || 'unknown'), { stack });
  } catch (_) { /* never let the error handler itself throw */ }
});

// ── App state ─────────────────────────────────────────────────────────────────
let currentPage    = 'dashboard';
let selectedFolder = null;
let allTasks       = [];
let filteredTasks  = [];
// PERF (1.15.3): one-shot boot cache. get_all_tasks walks every folder via COM
// (~3s for ~260 tasks). On launch BOTH the folder counts and the dashboard need
// the full task list, so init() fetches it once into here and hands the same
// array to refreshFolders() and loadDashboard() instead of enumerating twice.
// loadDashboard consumes it (sets it back to null) so every later refresh —
// manual, auto, or after a task mutation — fetches fresh and never goes stale.
let _bootAllTasks  = null;
let sortCol        = 'name';
let sortDir        = 1;
let selectedTask   = null;
let _createTabIdx  = 0;     // tracks which tab is active in the Create Task modal
let _editTaskPath  = null;  // non-null when editing an existing task
let _editTriggerStartDate = null;  // original StartBoundary date (YYYY-MM-DD) of the task being edited, so a recurring-task edit keeps its schedule phase instead of re-anchoring to today

// Live Monitor
let liveRefreshInterval = null;

// Dashboard auto-refresh timer
let _dashboardRefreshTimer = null;

// Audit log (max MAX_AUDIT_LOG_ENTRIES entries, stored in localStorage)
const MAX_AUDIT_LOG_ENTRIES = 500;
let _auditLog = [];

// Task failure detection for notifications
const TASK_RESULT_RUNNING  = 267009;
const TASK_RESULT_NOT_RUN  = 267011;
let _prevTaskResults = {};

// Bulk operations
let _selectedPaths = new Set();

// Active tag filter (null = no tag filter)
let _activeTagFilter = null;

// Column visibility preferences
let _colPrefs = {
  cb: true, name: true, health: true, status: true,
  triggers: true, action: true, last_run: true,
  next_run: true, last_result: true, controls: true,
};

// Debounce timer for search input
let searchDebounce = null;

// Refresh guard — prevents overlapping concurrent refreshes
let _refreshInProgress = false;
let _liveRefreshInProgress = false;  // Live Monitor in-flight guard (perf 2026-06-11)
let _procRefreshInProgress = false;  // Process Manager in-flight guard (audit 2026-06-19)
// Re-entrancy guard for the create/update submit — the COM call is slow, so a
// double-click would otherwise fire two create_task IPCs and duplicate the task.
let _submittingTask = false;
// Monotonic request token for loadTasksForFolder — a folder click racing an
// in-flight auto-refresh fetch must not let the slower/older response overwrite
// the newer one (last-write-wins on the global allTasks showed wrong-folder data).
let _loadTasksReqId = 0;
// ── New features (audit 2026-06-19): favorites, saved searches ───────────────
// Declared here (not in the module at EOF) so they're initialized before the
// first filterTasks()/renderTable() call; the helper functions are hoisted.
let _favorites = (function () {
  try { return new Set(JSON.parse(localStorage.getItem('wtp_favorites') || '[]')); }
  catch (e) { derror('favorites', 'failed to parse wtp_favorites', { err: String(e) }); return new Set(); }
})();
let _favFilterActive = false;
let _savedSearches = (function () {
  try { return JSON.parse(localStorage.getItem('wtp_saved_searches') || '[]'); }
  catch (e) { derror('savedSearches', 'failed to parse wtp_saved_searches', { err: String(e) }); return []; }
})();
// Window-visibility gate: auto-refresh timers each call invoke(), which on the
// backend run synchronous COM enumeration on the main thread (a temporary UI
// freeze per call until the threading refactor lands). There is no reason to
// pay that cost while the window is minimised or in the background, so every
// timer callback checks _appHidden first and skips the refresh while hidden.
// On return to visibility we trigger one immediate refresh of the current page.
let _appHidden = (typeof document !== 'undefined' && document.hidden) || false;

// Create dialog tab indices
const TAB_GENERAL  = 0;
const TAB_TRIGGER  = 1;
const TAB_ACTION   = 2;
const TAB_ADVANCED = 3;
const TAB_XML      = 4;

// ── Utility: status bar ───────────────────────────────────────────────────────
// LOW-1 FIX: setStatus() was a no-op (status bar removed). Call sites
// now use console.debug() so messages still appear in DevTools if needed.
function setStatus(msg) { console.debug("[status]", msg); }

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
let _modalCloseTimer = null; // track the delayed clear so openModal can cancel it

function openModal(title, bodyHtml, footerHtml = '') {
  // Cancel any pending post-close clear. Without this, the following race
  // occurs: user closes modal A (starts 200ms timer) → cloneTask awaits
  // get_folders (~50ms) → openModal sets new content → 200ms timer fires
  // and WIPES the new content, leaving the modal blank with dead buttons.
  if (_modalCloseTimer) {
    clearTimeout(_modalCloseTimer);
    _modalCloseTimer = null;
  }
  document.getElementById('modal-title').textContent = title;
  document.getElementById('modal-body').innerHTML    = bodyHtml;
  document.getElementById('modal-footer').innerHTML  = footerHtml;
  document.getElementById('modal-overlay').classList.add('show');
  trapFocus(document.getElementById('modal-box'));   // a11y: trap + initial focus
}

function closeModal() {
  releaseFocusTrap();   // a11y: restore focus to the element that opened the modal
  document.getElementById('modal-overlay').classList.remove('show');
  // Delay the clear slightly so the closing CSS animation plays out
  // before the content disappears. The timer is tracked so openModal
  // can cancel it if a new modal opens before the 200ms elapses.
  if (_modalCloseTimer) clearTimeout(_modalCloseTimer);
  _modalCloseTimer = setTimeout(() => {
    _modalCloseTimer = null;
    document.getElementById('modal-body').innerHTML    = '';
    document.getElementById('modal-footer').innerHTML  = '';
  }, 200);
}

// ── Modal focus management + keyboard activation (a11y, audit 2026-06-19) ──────
// Dialogs previously never moved focus in, never trapped Tab (so a keyboard user
// could drive the background controls behind the dimmed backdrop), and never
// restored focus on close. trapFocus/releaseFocusTrap fix all three.
let _modalReturnFocus = null;
let _modalTrapHandler = null;
let _modalTrapContainer = null;
function _focusables(container) {
  if (!container) return [];
  return Array.from(container.querySelectorAll(
    'a[href], button:not([disabled]), input:not([disabled]):not([type=hidden]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
  )).filter(el => el.offsetParent !== null || el === document.activeElement);
}
function trapFocus(container) {
  releaseFocusTrap();
  if (!container) return;
  _modalReturnFocus = document.activeElement;
  const f = _focusables(container);
  // Prefer the first real input over a leading close button.
  const first = f.find(el => el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') || f[0] || container;
  setTimeout(() => { try { first.focus(); } catch (e) { /* element gone */ } }, 0);
  _modalTrapHandler = (e) => {
    if (e.key !== 'Tab') return;
    const items = _focusables(container);
    if (!items.length) return;
    const firstI = items[0], lastI = items[items.length - 1];
    if (e.shiftKey && document.activeElement === firstI) { e.preventDefault(); lastI.focus(); }
    else if (!e.shiftKey && document.activeElement === lastI) { e.preventDefault(); firstI.focus(); }
    else if (!container.contains(document.activeElement)) { e.preventDefault(); firstI.focus(); }
  };
  _modalTrapContainer = container;
  container.addEventListener('keydown', _modalTrapHandler);
}
function releaseFocusTrap() {
  if (_modalTrapContainer && _modalTrapHandler) {
    _modalTrapContainer.removeEventListener('keydown', _modalTrapHandler);
  }
  _modalTrapHandler = null; _modalTrapContainer = null;
  const ret = _modalReturnFocus;
  _modalReturnFocus = null;
  if (ret && ret.focus) { try { ret.focus(); } catch (e) { /* element gone */ } }
}

// Keyboard activation for role="button" elements that are <div>/<th>/<span>
// (nav items, stat pills, folders, sortable headers, statusbar help). Native
// <button>s already handle Enter/Space; we only synthesize a click for the
// non-button interactive elements so keyboard users can operate them.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
  const el = e.target;
  if (!el || !el.getAttribute || el.getAttribute('role') !== 'button') return;
  const tag = el.tagName;
  if (tag === 'BUTTON' || tag === 'A' || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
  e.preventDefault();
  el.click();
});

// ── Page navigation ───────────────────────────────────────────────────────────
function showPage(page) {
  const prevPage = currentPage;
  if (currentPage === 'dashboard' && page !== 'dashboard') {
    clearTimeout(_dashboardRefreshTimer);
    _dashboardRefreshTimer = null;
  }
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

  // Stop process manager interval when leaving processes page
  if (page !== 'processes' && _procRefreshInterval) {
    clearInterval(_procRefreshInterval);
    _procRefreshInterval = null;
  }

  // Log nav change BEFORE loading the new page so the log line lands first
  // in the file even if the loader takes a while or throws.
  if (prevPage !== page) {
    dinfo('nav', 'page change', { from: prevPage, to: page });
  }

  if (page === 'dashboard')  loadDashboard();
  if (page === 'tasks') {
    // PERF (1.16.0): render the in-memory list INSTANTLY for the "All Tasks" view
    // (selectedFolder === null, where allTasks holds the full set) instead of
    // re-walking COM on every click. For a SPECIFIC folder, allTasks holds that
    // folder's subset AND a background refresh may have replaced it with the full
    // set, so ALWAYS reload the folder to guarantee correct scope.
    // (review fix 2026-06-19 — previously rendered the full list under a selected
    // folder, a persistent wrong-folder view.)
    if (selectedFolder === null && allTasks && allTasks.length > 0) filterTasks();
    else loadTasksForFolder(selectedFolder);
  }
  if (page === 'live')       startLiveMonitor();
  if (page === 'templates')  renderTemplates();
  if (page === 'auditlog')   renderAuditLog();
  if (page === 'settings')   renderSettings();
  if (page === 'processes')  startProcessManager();
}

// ── Slow-operation timing wrapper ─────────────────────────────────────────────
// Wraps an async function, measures wall time, and emits a log line if the
// operation exceeded the threshold. Used to surface "why is this slow"
// without flooding the log on every fast call.
//
// Usage:
//   const tasks = await timed('loadTasksForFolder', 1000, () =>
//     invoke('get_tasks', { folder }));
//
// Threshold is in milliseconds. Operations over the threshold log at WARN;
// failures (any throw) log at ERROR with the elapsed time so timeout-vs-error
// can be distinguished. Returns whatever the wrapped function returns.
async function timed(target, thresholdMs, fn) {
  const start = performance.now();
  try {
    const result = await fn();
    const ms = Math.round(performance.now() - start);
    if (ms >= thresholdMs) {
      dwarn(target, 'slow operation', { ms, threshold: thresholdMs });
    } else {
      dtrace(target, 'completed', { ms });
    }
    return result;
  } catch (err) {
    const ms = Math.round(performance.now() - start);
    derror(target, 'failed', { ms, err: String(err) });
    throw err;
  }
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
    allEl.id          = 'folder-item-all';
    allEl.innerHTML   = '<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">📂 All Tasks</span><span class="folder-count-badge" id="fi-count-all"></span>';
    allEl.onclick = () => {
      selectedFolder = null;
      document.querySelectorAll('.folder-item').forEach(f => f.classList.remove('active'));
      allEl.classList.add('active');
      showPage('tasks');
    };
    list.appendChild(allEl);

    folders.forEach(folder => {
      const el = document.createElement('div');
      el.className = 'folder-item' + (selectedFolder === folder ? ' active' : '');
      const safeId = 'fi-count-' + folder.replace(/[^a-zA-Z0-9]/g, '_');
      el.innerHTML = `<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">📁 ${escHtml(folder)}</span><span class="folder-count-badge" id="${safeId}"></span>`;
      el.onclick = () => {
        selectedFolder = folder;
        document.querySelectorAll('.folder-item').forEach(f => f.classList.remove('active'));
        el.classList.add('active');
        showPage('tasks');   // showPage('tasks') loads the selected folder — avoids the double-load
        updateStatusBar();
      };
      // ── Drop target wiring (Phase 2) ──────────────────────────────────────
      // Highlight on dragenter when a task is being dragged. dragover MUST
      // call preventDefault to mark this element as a valid drop zone — by
      // default the browser refuses drops to anything but inputs/textareas.
      el.ondragover = e => {
        if (!_draggingTaskPath) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
      };
      el.ondragenter = e => {
        if (!_draggingTaskPath) return;
        e.preventDefault();
        // Skip self-drops: if the task already lives in this folder, don't
        // highlight (we'll also reject in the drop handler).
        const draggedFolder = (_draggingTaskPath || '').replace(/\\[^\\]*$/, '') || '\\';
        if (draggedFolder === folder) return;
        el.classList.add('drop-target');
      };
      el.ondragleave = () => {
        el.classList.remove('drop-target');
      };
      el.ondrop = e => {
        e.preventDefault();
        el.classList.remove('drop-target');
        const path = e.dataTransfer.getData('text/x-wintaskpro-path') || _draggingTaskPath;
        if (!path) return;
        confirmMoveTask(path, folder);
      };
      // Right-click on a non-root folder offers delete
      el.oncontextmenu = e => {
        if (folder === '\\') return;
        e.preventDefault();
        const ctxMenu = document.getElementById('ctx-menu');
        ctxMenu.innerHTML = `<div class="ctx-item danger" id="folder-ctx-delete">🗑 Delete Folder…</div>`;
        ctxMenu.style.display = 'block';
        ctxMenu.style.left = e.pageX + 'px';
        ctxMenu.style.top  = e.pageY + 'px';
        ctxMenu.querySelector('#folder-ctx-delete')?.addEventListener('click', () => {
          hideCtxMenu();
          openDeleteFolderDialog(folder);
        });
      };
      list.appendChild(el);
    });

    // ── Drop target wiring for "All Tasks" (root) ──────────────────────────
    // The "All Tasks" entry was added before the .forEach above; we tag it
    // as a root-folder drop target ('\\') here.
    if (allEl) {
      allEl.ondragover = e => {
        if (!_draggingTaskPath) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
      };
      allEl.ondragenter = e => {
        if (!_draggingTaskPath) return;
        e.preventDefault();
        const draggedFolder = (_draggingTaskPath || '').replace(/\\[^\\]*$/, '') || '\\';
        if (draggedFolder === '\\') return;
        allEl.classList.add('drop-target');
      };
      allEl.ondragleave = () => allEl.classList.remove('drop-target');
      allEl.ondrop = e => {
        e.preventDefault();
        allEl.classList.remove('drop-target');
        const path = e.dataTransfer.getData('text/x-wintaskpro-path') || _draggingTaskPath;
        if (!path) return;
        confirmMoveTask(path, '\\');
      };
    }

    // Populate task counts asynchronously — one get_all_tasks call, count by folder.
    // Reuses the boot prefetch when present (does NOT clear it — the dashboard
    // render that follows also needs it; loadDashboard is what clears it).
    try {
      const allTasksForCount = _bootAllTasks || await invoke('get_all_tasks', { skipSystem: !settings.showSystemTasks });
      // Count per folder
      const counts = {};
      allTasksForCount.forEach(t => {
        const f = t.folder || '\\';
        counts[f] = (counts[f] || 0) + 1;
      });
      // Update All Tasks badge
      const allBadge = document.getElementById('fi-count-all');
      if (allBadge) allBadge.textContent = allTasksForCount.length || '';
      // Update per-folder badges
      folders.forEach(folder => {
        const safeId = 'fi-count-' + folder.replace(/[^a-zA-Z0-9]/g, '_');
        const badge = document.getElementById(safeId);
        if (badge) badge.textContent = counts[folder] || '';
      });
    } catch (err) {
      // Not fatal — folder badges will appear blank — but log so empty
      // badges are diagnosable.
      dwarn('refreshFolders', 'get_all_tasks for counts failed', { err: String(err) });
    }

  } catch (err) {
    showToast('Failed to load folders: ' + err, 'error');
  }
}

// ── Task list ─────────────────────────────────────────────────────────────────
async function loadTasksForFolder(folder) {
  // Monotonic request token: a folder click can race an in-flight auto-refresh
  // fetch; only the latest-started call may commit to allTasks (see check before
  // the assignment below). (audit 2026-06-19)
  const myReqId = ++_loadTasksReqId;
  // BUG FIX (video audit 2026-04-20): was unconditionally resetting the stat
  // pills to `—` before awaiting IPC, which made the Task Manager page look
  // empty for 2-3 seconds every navigation (IPC takes ~3s for 262 tasks).
  // Fix: only reset pills when we have NO cached data to show. If allTasks
  // already has entries (cached from a prior load), keep them visible so the
  // UI doesn't flash empty — new data will overwrite atomically on return.
  const setVal = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  const hasCache = allTasks.length > 0;
  if (!hasCache) {
    setVal('stat-total-val', '—'); setVal('stat-running-val', '—');
    setVal('stat-ready-val', '—'); setVal('stat-disabled-val', '—');
    setVal('stat-queued-val', '—'); setVal('stat-failed-val', '—');
    // Show a loading indicator in the empty table body
    const tbody = document.getElementById('task-tbody');
    if (tbody) tbody.innerHTML = '<tr><td colspan="10" style="text-align:center;padding:40px;color:var(--text3)">⏳ Loading tasks…</td></tr>';
    // UX (1.15.4): the COM walk below is synchronous on the UI thread; yield so
    // the loading row actually paints instead of the page looking frozen.
    await new Promise(r => setTimeout(r, 50));
  }
  try {
    // Threshold 1500 ms — get_all_tasks walks every folder via COM and is the
    // most common source of perceived slowness. Logging slow runs makes it
    // easy to correlate with COM/AV/RAM pressure on the user's box.
    const tasks = folder === null
      ? await timed('loadTasksForFolder.get_all_tasks', 1500, () => invoke('get_all_tasks', { skipSystem: !settings.showSystemTasks }))
      : await timed('loadTasksForFolder.get_tasks', 1500, () => invoke('get_tasks', { folder }));

    // MED-2: Warn if enumeration returned suspiciously few tasks — this can
    // happen when the app lacks Administrator rights and some folders are
    // inaccessible. The Rust layer silently skips failed folders, so a partial
    // result looks identical to a full one. Surface a clue to the user.
    const isAdmin = await invoke('is_admin').catch(() => false);
    if (!isAdmin && folder === null && tasks.length < 5) {
      showToast('⚠ Limited task visibility — run as Administrator to see all tasks', 'error');
    }

    // Drop this response if a newer load started while we were awaiting (folder
    // click racing auto-refresh) — otherwise the slower/older response would
    // overwrite the newer one and show wrong-folder data. (audit 2026-06-19)
    if (myReqId !== _loadTasksReqId) {
      dlog('loadTasksForFolder', 'dropping stale response', { folder, myReqId, latest: _loadTasksReqId });
      return;
    }
    allTasks = tasks;
    if (folder === null) saveTaskCache(tasks);   // keep the instant-launch cache fresh
    filterTasks();
    renderTagFilterBar();

    // Update stats pills
    const total    = tasks.length;
    const running  = tasks.filter(t => t.status === 'Running').length;
    const ready    = tasks.filter(t => t.status === 'Ready').length;
    const disabled = tasks.filter(t => t.status === 'Disabled').length;
    const queued   = tasks.filter(t => t.status === 'Queued').length;

    setVal('stat-total-val',    total);
    setVal('stat-running-val',  running);
    setVal('stat-ready-val',    ready);
    setVal('stat-disabled-val', disabled);
    const failed = tasks.filter(t => t.last_result_code !== 0 && t.last_result_code !== TASK_RESULT_RUNNING && t.last_result_code !== TASK_RESULT_NOT_RUN).length;
    setVal('stat-queued-val',   queued);
    setVal('stat-failed-val',   failed);

    const badge = document.getElementById('tasks-nav-badge');
    if (badge) badge.textContent = total;

    // Update the bottom status bar — it reads from allTasks.length and
    // filteredTasks.length which were just populated.
    updateStatusBar();
  } catch (err) {
    showToast('Failed to load tasks: ' + err, 'error');
    derror('loadTasksForFolder', 'task load failed', { folder, err: String(err) });
  }
}

// ── Status bar ────────────────────────────────────────────────────────────────
function updateStatusBar() {
  const folderEl   = document.getElementById('sb-folder');
  const countEl    = document.getElementById('sb-count');
  const selectedEl = document.getElementById('sb-selected');

  const folderName = selectedFolder === null ? 'All Tasks'
    : selectedFolder === '\\' ? '\\ (root)'
    : selectedFolder;
  if (folderEl) folderEl.textContent = '📁 ' + folderName;

  const total    = allTasks.length;
  const filtered = filteredTasks.length;
  const hasFilter = filtered < total;
  if (countEl) countEl.textContent = hasFilter
    ? `${filtered} / ${total} ${filtered === 1 ? 'task' : 'tasks'}`
    : `${total} task${total !== 1 ? 's' : ''}`;

  const selCount = _selectedPaths.size;
  if (selectedEl) {
    selectedEl.style.display = selCount > 0 ? '' : 'none';
    selectedEl.textContent = `${selCount} selected`;
  }
}


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
    // System task filter — tasks whose path starts with \Microsoft\ or \Windows\
    // are Windows built-in tasks. If the user has hidden them in Settings, skip them.
    if (!settings.showSystemTasks) {
      const p = (t.path || '').toLowerCase();
      if (p.startsWith('\\microsoft\\') || p.startsWith('\\windows\\')) return false;
    }

    const matchSearch = !search ||
      t.name.toLowerCase().includes(search) ||
      t.path.toLowerCase().includes(search) ||
      (t.description && t.description.toLowerCase().includes(search)) ||
      (t.actions && t.actions.some(a => a.toLowerCase().includes(search)));
    // "Failed" is a virtual status: non-zero result that is not "still running" or "not run yet"
    let matchStatus;
    if (status === 'Failed') {
      matchStatus = t.last_result_code !== 0 &&
                    t.last_result_code !== TASK_RESULT_RUNNING &&
                    t.last_result_code !== TASK_RESULT_NOT_RUN;
    } else {
      matchStatus = !status || t.status === status;
    }
    // Tag filter
    const matchTag = !_activeTagFilter || (getTagsForTask(t.path).includes(_activeTagFilter));
    // Favorites-only filter (★ toggle in the stats bar)
    const matchFav = !_favFilterActive || isFavorite(t.path);
    return matchSearch && matchStatus && matchTag && matchFav;
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
  // Pin favorites to the top, preserving the column-sort order within each group
  // (Array.sort is stable in modern WebView2). No-op when there are no favorites.
  if (_favorites && _favorites.size) {
    result.sort((a, b) => (isFavorite(b.path) ? 1 : 0) - (isFavorite(a.path) ? 1 : 0));
  }

  filteredTasks = result;
  renderTable();

  // Update stats pills to reflect what's actually visible after all filters.
  // allTasks stats are set by loadTasksForFolder; here we update them to match
  // the filtered view so the user can see "Running 2" means 2 in current view.
  const setVal = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  const hasFilter = search || status || _activeTagFilter || _favFilterActive;
  if (hasFilter) {
    setVal('stat-total-val',    result.length);
    setVal('stat-running-val',  result.filter(t => t.status === 'Running').length);
    setVal('stat-ready-val',    result.filter(t => t.status === 'Ready').length);
    setVal('stat-disabled-val', result.filter(t => t.status === 'Disabled').length);
    setVal('stat-queued-val',   result.filter(t => t.status === 'Queued').length);
    setVal('stat-failed-val',   result.filter(t => t.last_result_code !== 0 && t.last_result_code !== TASK_RESULT_RUNNING && t.last_result_code !== TASK_RESULT_NOT_RUN).length);
  } else {
    // No filter active — restore the full counts from allTasks
    setVal('stat-total-val',    allTasks.length);
    setVal('stat-running-val',  allTasks.filter(t => t.status === 'Running').length);
    setVal('stat-ready-val',    allTasks.filter(t => t.status === 'Ready').length);
    setVal('stat-disabled-val', allTasks.filter(t => t.status === 'Disabled').length);
    setVal('stat-queued-val',   allTasks.filter(t => t.status === 'Queued').length);
    setVal('stat-failed-val',   allTasks.filter(t => t.last_result_code !== 0 && t.last_result_code !== TASK_RESULT_RUNNING && t.last_result_code !== TASK_RESULT_NOT_RUN).length);
  }
  updateStatusBar();
}

function onSearchInput() {
  if (searchDebounce) clearTimeout(searchDebounce);
  searchDebounce = setTimeout(filterTasks, 200);
  // Show/hide the search clear button
  const clearBtn = document.getElementById('search-clear-btn');
  const searchEl = document.getElementById('search-input');
  if (clearBtn) clearBtn.style.display = (searchEl && searchEl.value) ? '' : 'none';
}

// Clear both search text and status filter, then re-filter
function clearAllFilters() {
  const searchEl = document.getElementById('search-input');
  const statusEl = document.getElementById('status-filter');
  const clearBtn = document.getElementById('search-clear-btn');
  if (searchEl) searchEl.value = '';
  if (statusEl) statusEl.value = '';
  if (clearBtn) clearBtn.style.display = 'none';
  _activeTagFilter = null;
  renderTagFilterBar();
  filterTasks();
}

// Render the tag filter bar above the task table
function renderTagFilterBar() {
  let bar = document.getElementById('tag-filter-bar');
  const tags = allTagsList();
  if (!tags.length && !_activeTagFilter) {
    if (bar) bar.remove();
    return;
  }
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'tag-filter-bar';
    const statsBar = document.getElementById('stats-bar');
    if (statsBar) statsBar.insertAdjacentElement('afterend', bar);
  }
  bar.innerHTML = `
    <span style="font-size:10px;font-weight:700;color:var(--text3);text-transform:uppercase;letter-spacing:.06em;flex-shrink:0">Tags:</span>
    ${tags.map(tag => {
      const color = TAG_COLORS[Math.abs(tag.split('').reduce((a,c)=>a+c.charCodeAt(0),0)) % TAG_COLORS.length];
      const active = _activeTagFilter === tag;
      return `<button class="tag-filter-chip ${active ? 'active' : ''}" style="--tag-color:${color}" data-tag="${escHtml(tag)}">${escHtml(tag)}</button>`;
    }).join('')}
    ${_activeTagFilter ? `<button class="btn btn-sm" id="tag-clear-btn" style="margin-left:4px">✕ Clear</button>` : ''}`;

  bar.querySelectorAll('.tag-filter-chip').forEach(btn => {
    btn.onclick = () => {
      _activeTagFilter = _activeTagFilter === btn.dataset.tag ? null : btn.dataset.tag;
      renderTagFilterBar();
      filterTasks();
    };
  });
  const clearBtn = bar.querySelector('#tag-clear-btn');
  if (clearBtn) clearBtn.onclick = () => { _activeTagFilter = null; renderTagFilterBar(); filterTasks(); };
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

// CSV cell encoder with formula-injection guard (audit 2026-06-11).
// Excel/LibreOffice execute cells beginning with = + - @ (and tab/CR
// variants) as formulas, so a task or process literally NAMED something
// like "=cmd|' /c ...'!A1" would detonate inside the admin's exported
// spreadsheet — squarely in this app's threat model, since the integrity
// feature exists precisely because scheduled tasks get tampered with.
// A leading single-quote forces text interpretation; purely numeric
// values are left unprefixed so number columns still sort and sum.
// Always quote-wraps and doubles internal quotes (RFC 4180).
function csvCell(v) {
  let s = (v === null || v === undefined) ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = "'" + s;
  return '"' + s.replace(/"/g, '""') + '"';
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
  if (!result || result === '—') return 'result-na';
  const r = result.toLowerCase();
  // Rust fmt_code returns: "Success", "Not Run Yet", "Still Running", "Error (0x...)"
  if (r.startsWith('success'))      return 'result-ok';
  if (r === 'not run yet')          return 'result-na';
  if (r === 'still running')        return 'result-running';
  if (r === 'n/a')                  return 'result-na';
  return 'result-error';
}

function renderTable() {
  const tbody      = document.getElementById('task-tbody');
  const emptyState = document.getElementById('empty-state');

  if (!tbody) return;

  if (filteredTasks.length === 0) {
    tbody.innerHTML = '';
    if (emptyState) {
      const searchEl = document.getElementById('search-input');
      const statusEl = document.getElementById('status-filter');
      const activeSearch = searchEl && searchEl.value.trim();
      const activeStatus = statusEl && statusEl.value;
      const hasFilter = activeSearch || activeStatus;
      if (hasFilter) {
        const filterDesc = [
          activeStatus ? `status = "${activeStatus}"` : '',
          activeSearch ? `search = "${escHtml(activeSearch)}"` : '',
        ].filter(Boolean).join(', ');
        emptyState.innerHTML = `
          <div style="font-size:44px;margin-bottom:8px">🔍</div>
          <div style="font-size:15px;font-weight:700;margin-bottom:4px;color:var(--text)">No tasks match your filter</div>
          <div style="font-size:12px;color:var(--text3);margin-bottom:16px">Active filter: ${filterDesc}</div>
          <button class="btn btn-primary" id="empty-clear-btn">✕ Clear Filters</button>`;
        // Wire up clear button immediately after injecting HTML
        const clearBtn = emptyState.querySelector('#empty-clear-btn');
        if (clearBtn) clearBtn.onclick = clearAllFilters;
      } else {
        emptyState.innerHTML = `
          <div style="font-size:44px;margin-bottom:8px">📋</div>
          <div style="font-size:15px;font-weight:700;margin-bottom:4px;color:var(--text)">No tasks found</div>
          <div style="font-size:12px;color:var(--text3)">Create a new task or select a different folder.</div>`;
      }
      emptyState.style.display = 'flex';
    }
    return;
  }
  if (emptyState) emptyState.style.display = 'none';

  tbody.innerHTML = filteredTasks.map((task, idx) => {
    const firstAction = task.actions && task.actions.length > 0 ? task.actions[0] : null;
    const actionText = firstAction ? firstAction.substring(0, 50) + (firstAction.length > 50 ? '…' : '') : '—';
    const triggers   = (task.triggers && task.triggers.length > 0)
      ? task.triggers.join(', ').substring(0, 40) : '—';
    const health  = healthScore(task);
    // a11y: a coloured dot alone is invisible to screen readers; add sr-only text.
    const healthDot = `<span class="health-dot ${health}" title="Health: ${health}"></span><span class="sr-only">Health: ${health}</span>`;
    const isChecked = _selectedPaths.has(task.path);
    const isFav = isFavorite(task.path);
    // Use data-path (stable task identifier) on rows and action buttons instead of
    // a positional data-idx. This prevents a stale-index bug where an async
    // auto-refresh re-renders the table between the click and the handler running,
    // causing idx to point at a completely different task.
    const epath = escHtml(task.path);

    return `<tr data-path="${epath}" draggable="true" class="${isChecked ? 'row-selected' : ''}${isFav ? ' row-fav' : ''}">
      <td data-col="cb"><input type="checkbox" class="task-cb" data-path="${epath}" ${isChecked ? 'checked' : ''} /></td>
      <td data-col="name">
        <div style="display:flex;align-items:center;gap:7px;min-width:0">
          <button class="fav-star ${isFav ? 'is-fav' : ''}" data-fav="${epath}" title="${isFav ? 'Unpin from favorites' : 'Pin to favorites'}" aria-label="${isFav ? 'Remove from favorites' : 'Add to favorites'}" aria-pressed="${isFav}">${isFav ? '★' : '☆'}</button>
          <div style="min-width:0;flex:1">
            <span class="task-name">${escHtml(task.name)}</span>
            <span class="task-path">${escHtml(task.folder || '')}</span>
          </div>
          ${task.hidden ? '<span class="badge badge-unknown" title="Hidden task" aria-label="Hidden">H</span>' : ''}
        </div>
      </td>
      <td data-col="health">${healthDot}</td>
      <td data-col="status"><span class="badge badge-${badgeClass(task.status)}">${escHtml(task.status || '—')}</span></td>
      <td data-col="triggers" class="cell-trunc" title="${escHtml(triggers)}">${escHtml(triggers)}</td>
      <td data-col="action" class="cell-trunc" title="${escHtml(firstAction || '')}">${escHtml(actionText)}</td>
      <td data-col="last_run">${escHtml(task.last_run || '—')}</td>
      <td data-col="next_run">${escHtml(task.next_run || '—')}</td>
      <td data-col="last_result" class="${resultClass(task.last_result)}">${escHtml(task.last_result || '—')}</td>
      <td data-col="controls" class="controls-cell">
        <button class="icon-btn" title="Run"    data-action="run"    data-path="${epath}">▶</button>
        <button class="icon-btn" title="Stop"   data-action="stop"   data-path="${epath}">⏹</button>
        <button class="icon-btn danger" title="Delete" data-action="delete" data-path="${epath}">🗑</button>
      </td>
    </tr>`;
  }).join('');

  // Apply column visibility
  applyColumnVisibility();

  // Helper: look up a task by its stable path in the current filteredTasks snapshot.
  // Using path instead of index means a concurrent re-render cannot cause the wrong
  // task to be acted on.
  const taskByPath = path => filteredTasks.find(t => t.path === path) ?? null;

  // Event delegation for row clicks and control buttons
  tbody.onclick = e => {
    // Favorite star toggle — must run before the row-click → openDetail below.
    const star = e.target.closest('.fav-star');
    if (star) { e.stopPropagation(); toggleFavorite(star.dataset.fav); return; }
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
      const path = btn.dataset.path;
      const task = taskByPath(path);
      if (!task) return;
      if (btn.dataset.action === 'run')    runTask(task.path);
      if (btn.dataset.action === 'stop')   stopTask(task.path);
      if (btn.dataset.action === 'delete') deleteTask(task.path, task.name);
      return;
    }
    const row = e.target.closest('tr[data-path]');
    if (row) { const t = taskByPath(row.dataset.path); if (t) openDetail(t); }
  };
  tbody.oncontextmenu = e => {
    const row = e.target.closest('tr[data-path]');
    if (row) { const t = taskByPath(row.dataset.path); if (t) showCtxMenu(e, t); }
  };

  // ── Drag-and-drop: tasks → folders (Phase 2 feature) ──────────────────────
  // Each row is `draggable="true"` (set in the row template). We attach a
  // single delegated dragstart/dragend listener on the tbody rather than per
  // row to avoid re-binding listeners on every renderTable() call.
  tbody.ondragstart = e => {
    const row = e.target.closest('tr[data-path]');
    if (!row) return;
    const path = row.dataset.path;
    // dataTransfer is the canonical channel; we also stash on a module-level
    // var because dataTransfer.getData() returns '' during dragenter/dragover
    // events (it's only readable on drop). The folder-side listeners need to
    // know what's being dragged BEFORE drop to decide whether to highlight.
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/x-wintaskpro-path', path);
    _draggingTaskPath = path;
    row.classList.add('dragging');
    dinfo('drag', 'task drag start', { path });
  };
  tbody.ondragend = e => {
    const row = e.target.closest('tr[data-path]');
    if (row) row.classList.remove('dragging');
    _draggingTaskPath = null;
    // Clear any leftover drop-target highlights — defensive in case a
    // dragleave fired without a corresponding dragenter cleanup
    document.querySelectorAll('.folder-item.drop-target').forEach(el =>
        el.classList.remove('drop-target'));
  };

  // Initialise resize handles on first render (guard inside prevents re-init)
  initColumnResize();
}

// Module-scoped dragging state. Set by the tbody.ondragstart handler;
// consumed by the folder-list drop handlers in refreshFolders().
let _draggingTaskPath = null;

// ── Confirm + execute task move (Phase 2) ──────────────────────────────────
// Called when the user drops a task row onto a folder. Shows a small
// confirmation modal (dragdrop is irreversible-ish — the task gets
// re-registered which loses run history — so we don't move silently),
// then calls the move_task IPC. On success, refreshes the folder list and
// the current task view so the moved task appears in the new folder.
async function confirmMoveTask(srcPath, destFolder) {
    // Compute display strings. The task name is the last \-segment.
    const taskName = srcPath.split('\\').pop() || srcPath;
    const srcFolder = srcPath.replace(/\\[^\\]*$/, '') || '\\';

    if (srcFolder === destFolder) {
        showToast('Already in this folder', 'info');
        return;
    }

    openModal('Move Task',
        `<div style="display:flex;flex-direction:column;gap:14px">
           <div style="font-size:14px;color:var(--text2);line-height:1.5">
             Move <strong>${escHtml(taskName)}</strong> from <code>${escHtml(srcFolder)}</code> to <code>${escHtml(destFolder)}</code>?
           </div>
           <div style="font-size:12.5px;color:var(--yellow);background:rgba(245,158,11,.06);border:1px solid rgba(245,158,11,.22);border-radius:6px;padding:10px 12px;line-height:1.5">
             <strong>Note:</strong> Moving re-registers the task in the new location. The task's
             previous run history (Last Run, Last Result) will be reset because Windows tracks
             history by the full path. The task itself — schedule, action, settings — is preserved.
           </div>
         </div>`,
        `<button class="btn" onclick="closeModal()">Cancel</button>
         <button class="btn btn-primary" id="confirm-move-btn">Move Task</button>`
    );

    document.getElementById('confirm-move-btn').onclick = async () => {
        const btn = document.getElementById('confirm-move-btn');
        if (btn) { btn.disabled = true; btn.textContent = 'Moving…'; }
        try {
            const newPath = await invoke('move_task', { srcPath, destFolder });
            dinfo('confirmMoveTask', 'OK', { srcPath, destFolder, newPath });
            appendAuditLog('move_task', taskName, `${srcPath} → ${newPath}`);
            closeModal();
            showToast(`Moved "${taskName}" to ${destFolder}`, 'success');
            // Refresh folder counts + task list. If the user is currently
            // viewing the source folder, the moved task disappears from the
            // list naturally on reload.
            await refreshFolders();
            await loadTasksForFolder(selectedFolder);
        } catch (err) {
            derror('confirmMoveTask', 'failed', { srcPath, destFolder, err: String(err) });
            const errBtn = document.getElementById('confirm-move-btn');
            if (errBtn) { errBtn.disabled = false; errBtn.textContent = 'Retry'; }
            showToast('Move failed: ' + String(err), 'error');
        }
    };
}

// ── Detail panel ──────────────────────────────────────────────────────────────
// ── Detail-panel tab state (Phase 4 feature) ────────────────────────────────
// Persist current tab across openDetail calls so navigating between tasks
// doesn't reset the user's tab focus. Reset to 'general' if the new task
// doesn't have the previously-selected tab (shouldn't happen with the
// current fixed tab list, but defensive).
let _detailTab = 'general';

function setDetailTab(tabId) {
    _detailTab = tabId;
    applyDetailTabState();
}

function applyDetailTabState() {
    document.querySelectorAll('.detail-tab').forEach(btn => {
        if (btn.dataset.tab === _detailTab) {
            btn.style.color = 'var(--text)';
            btn.style.borderBottomColor = 'var(--accent)';
            btn.style.fontWeight = '600';
        } else {
            // UX (Unreleased): inactive tab colour matched to the brightened
            // sidebar (--text2 instead of --text3) so the readability fix
            // survives a tab switch. Active stays on --text + accent border.
            btn.style.color = 'var(--text2)';
            btn.style.borderBottomColor = 'transparent';
            btn.style.fontWeight = '500';
        }
    });
    document.querySelectorAll('.detail-tab-pane').forEach(pane => {
        pane.style.display = (pane.dataset.pane === _detailTab) ? '' : 'none';
    });
}

// Loads full history records via existing IPC, then renders stats into
// the Stats tab pane. Called from the "Load Statistics" button.
async function loadTaskStatsForDetail(taskPath) {
    const container = document.getElementById('task-stats-container');
    if (!container) return;
    container.innerHTML = '<div style="text-align:center;padding:24px;color:var(--text3)">⏳ Loading run records…</div>';
    try {
        const records = await invoke('get_task_history', { path: taskPath, maxRecords: 200 });
        if (!records || records.length === 0) {
            container.innerHTML = `
              <div style="text-align:center;padding:24px;color:var(--text3);font-size:13px">
                <div style="margin-bottom:6px">No run records found for this task.</div>
                <div style="font-size:11px">The Task Scheduler engine returns the next-run schedule for tasks that haven't run yet — but the per-task history only contains <em>past</em> runs from the engine's own bookkeeping. Use 📋 Load Full History (under the History tab) to query the Windows Event Log instead.</div>
              </div>`;
            return;
        }
        container.innerHTML = renderTaskStats(records);
        dinfo('loadTaskStatsForDetail', 'rendered', { task: taskPath, records: records.length });
    } catch (err) {
        derror('loadTaskStatsForDetail', 'failed', { err: String(err) });
        container.innerHTML = `<div style="color:var(--red);padding:14px">Could not load statistics: ${escHtml(String(err))}</div>`;
    }
}

function openDetail(task) {
  selectedTask = task;

  document.getElementById('detail-name').textContent = task.name;

  // ── Build detail body as tabbed panes (Phase 4 feature) ───────────────────
  // Previously: one long scroll with all sections. Now: tabs across the
  // top, one pane visible at a time. Reduces scroll fatigue for tasks
  // with many triggers/actions and gives Stats its own home.
  //
  // Tabs preserved by index across openDetail calls via _detailTab so a
  // user navigating between tasks doesn't lose their tab focus. Reset to
  // 'general' if the previous tab doesn't exist on the new task.
  const healthCls = healthScore(task);
  const existingNote = getNoteForTask(task.path);

  const tabs = [
    { id: 'general',  label: 'General',  icon: '📋' },
    { id: 'triggers', label: 'Triggers', icon: '⏰' },
    { id: 'actions',  label: 'Actions',  icon: '⚡' },
    { id: 'history',  label: 'History',  icon: '📜' },
    { id: 'stats',    label: 'Stats',    icon: '📊' },
    { id: 'tags',     label: 'Tags',     icon: '🏷' },
    { id: 'notes',    label: 'Notes',    icon: '📝' + (existingNote ? '*' : '') },
  ];

  // Persist selected tab across detail-panel reopens; default 'general'
  if (!_detailTab || !tabs.some(t => t.id === _detailTab)) _detailTab = 'general';

  const tabNavHtml = `
    <div id="detail-tab-nav" style="display:flex;gap:2px;border-bottom:1px solid var(--border);margin-bottom:14px;overflow-x:auto;scrollbar-width:thin">
      ${tabs.map(t => `
        <button class="detail-tab" data-tab="${t.id}" style="padding:7px 10px;background:transparent;border:none;border-bottom:2px solid transparent;color:var(--text2);font-size:13px;font-weight:500;cursor:pointer;white-space:nowrap;transition:color 120ms,border-color 120ms">
          ${t.icon} ${t.label}
        </button>`).join('')}
    </div>`;

  const panes = {};

  panes.general = `
    <div class="detail-tab-pane" data-pane="general">
      <table class="detail-table">
        <tr><td>Path</td><td>${escHtml(task.path)} <button class="icon-btn" id="copy-path-btn" title="Copy path">📋</button></td></tr>
        <tr><td>Status</td><td><span class="badge badge-${badgeClass(task.status)}">${escHtml(task.status)}</span> <span class="health-dot ${healthCls}" title="Health: ${healthCls}" style="vertical-align:middle;margin-left:6px"></span></td></tr>
        <tr><td>Description</td><td>${escHtml(task.description || '—')}</td></tr>
        <tr><td>Author</td><td>${escHtml(task.author || '—')}</td></tr>
        <tr><td>Run As</td><td>${escHtml(task.run_as_user || '—')}</td></tr>
        <tr><td>Run Level</td><td>${task.run_level === 1 ? 'Highest' : 'Standard (LUA)'}</td></tr>
        <tr><td>Hidden</td><td>${task.hidden ? 'Yes' : 'No'}</td></tr>
        <tr><td>Enabled</td><td>${task.enabled ? 'Yes' : 'No'}</td></tr>
        <tr><td>Last Run</td><td>${escHtml(task.last_run || '—')}</td></tr>
        <tr><td>Next Run</td><td>${escHtml(task.next_run || '—')}</td></tr>
        <tr><td>Last Result</td><td class="${resultClass(task.last_result)}">${escHtml(task.last_result || '—')}${fpResultHelpBadge(task.last_result)}</td></tr>
      </table>
    </div>`;

  panes.triggers = `
    <div class="detail-tab-pane" data-pane="triggers">
      ${task.triggers && task.triggers.length > 0
        ? task.triggers.map(t => `<div class="detail-item">${escHtml(t)}</div>`).join('')
        : '<div class="detail-item muted">No triggers defined — this task will never run automatically.</div>'}
    </div>`;

  panes.actions = `
    <div class="detail-tab-pane" data-pane="actions">
      ${task.actions && task.actions.length > 0
        ? task.actions.map(a => `<div class="detail-item">${escHtml(a)}</div>`).join('')
        : task.action
          ? `<div class="detail-item">${escHtml(task.action)}</div>`
          : '<div class="detail-item muted">No actions defined — this task does nothing when triggered.</div>'}
      ${task.program_path ? `
        <table class="detail-table" style="margin-top:14px">
          <tr><td>Program</td><td style="word-break:break-all">${escHtml(task.program_path)}</td></tr>
          <tr><td>Args</td><td style="word-break:break-all">${escHtml(task.program_args || '—')}</td></tr>
          <tr><td>Working Dir</td><td style="word-break:break-all">${escHtml(task.working_dir || '—')}</td></tr>
        </table>` : ''}
    </div>`;

  panes.history = `
    <div class="detail-tab-pane" data-pane="history">
      <div style="margin-bottom:10px">
        <button class="btn" id="load-history-btn">📋 Load Full History</button>
      </div>
      <div id="task-history-container"></div>
    </div>`;

  panes.stats = `
    <div class="detail-tab-pane" data-pane="stats">
      <div id="task-stats-container">
        <div style="text-align:center;padding:24px;color:var(--text3);font-size:13px">
          <button class="btn" id="load-stats-btn">📊 Load Statistics</button>
          <div style="margin-top:8px;font-size:11px">Computes success rate, avg duration, and weekly distribution from the Task Scheduler engine's run records.</div>
        </div>
      </div>
    </div>`;

  panes.tags = `
    <div class="detail-tab-pane" data-pane="tags">
      <div id="detail-tags-container" style="display:flex;flex-wrap:wrap;gap:5px;align-items:center;min-height:28px"></div>
      <div style="margin-top:8px;font-size:11px;color:var(--text3)">Tap any tag to remove it. Use the 🏷 button in the toolbar to add new tags.</div>
    </div>`;

  panes.notes = `
    <div class="detail-tab-pane" data-pane="notes">
      <div id="detail-note-container">
        ${existingNote
          ? `<div style="font-size:13px;color:var(--text2);white-space:pre-wrap;line-height:1.5;padding:4px 0">${escHtml(existingNote)}</div>`
          : '<div style="font-size:12px;color:var(--text3);font-style:italic">No note. Click 📝 Note in the toolbar to add one.</div>'}
      </div>
    </div>`;

  document.getElementById('detail-body').innerHTML =
    tabNavHtml + Object.values(panes).join('');

  // Apply tab-active styling and visibility
  applyDetailTabState();

  // Wire tab clicks
  document.querySelectorAll('.detail-tab').forEach(tab => {
    tab.onclick = () => setDetailTab(tab.dataset.tab);
  });

  // Render tags into now-existing container
  renderTagChips(task.path, 'detail-tags-container');

  // Wire up copy-path button safely (avoids inline onclick XSS)
  const copyPathBtn = document.getElementById('copy-path-btn');
  if (copyPathBtn) copyPathBtn.onclick = () => navigator.clipboard.writeText(task.path);

  // Wire up load-history button safely (avoids inline onclick with path string)
  const loadHistoryBtn = document.getElementById('load-history-btn');
  if (loadHistoryBtn) loadHistoryBtn.onclick = () => loadTaskHistory(task.path);

  // Wire up load-stats button — uses the same get_task_history IPC and runs
  // the records through computeTaskStats / renderTaskStats.
  const loadStatsBtn = document.getElementById('load-stats-btn');
  if (loadStatsBtn) loadStatsBtn.onclick = () => loadTaskStatsForDetail(task.path);

  // Wire up buttons (null-checked to avoid crashes if DOM changes)
  const runBtn     = document.getElementById('d-run-btn');
  const runTestBtn = document.getElementById('d-runtest-btn');
  const stopBtn    = document.getElementById('d-stop-btn');
  const toggleBtn  = document.getElementById('d-toggle-btn');
  const xmlBtn     = document.getElementById('d-xml-btn');
  const editBtn    = document.getElementById('d-edit-btn');
  const cloneBtn   = document.getElementById('d-clone-btn');
  const saveTplBtn = document.getElementById('d-savetpl-btn');
  const deleteBtn  = document.getElementById('d-delete-btn');
  const noteBtn    = document.getElementById('d-note-btn');
  const psBtn      = document.getElementById('d-ps-btn');
  const psExportBtn = document.getElementById('d-psexport-btn');
  const runNowBtn  = document.getElementById('d-runnow-btn');
  const watchBtn   = document.getElementById('d-watch-btn');

  if (runBtn)     runBtn.onclick     = () => { appendAuditLog('run_task', task.name, task.path); runTask(task.path); };
  if (runTestBtn) runTestBtn.onclick = () => runTaskAsTest(task);
  if (runNowBtn)  runNowBtn.onclick  = () => fpTrueTestRun(task.path, task.name);
  if (stopBtn)    stopBtn.onclick    = () => { appendAuditLog('stop_task', task.name, task.path); stopTask(task.path); };
  if (toggleBtn) {
    toggleBtn.onclick = () => toggleTask(task);
    toggleBtn.innerHTML = task.enabled
      ? '<svg class="ico" aria-hidden="true"><use href="#i-pause"/></svg> Disable'
      : '<svg class="ico" aria-hidden="true"><use href="#i-play"/></svg> Enable';
  }
  if (xmlBtn)    xmlBtn.onclick    = () => exportXml(task.path);
  if (editBtn)   editBtn.onclick   = () => openEditDialog(task);
  if (cloneBtn)  cloneBtn.onclick  = () => cloneTask(task);
  if (saveTplBtn) saveTplBtn.onclick = () => openSaveAsTemplateDialog(task);
  if (deleteBtn) deleteBtn.onclick = () => deleteTask(task.path, task.name);
  if (noteBtn)   noteBtn.onclick   = () => openNoteDialog(task);
  if (psBtn)     psBtn.onclick     = () => copyAsPowerShell(task);
  if (psExportBtn) psExportBtn.onclick = () => exportTaskAsPowerShell(task);
  // Feature pack 1.15.0 — Tamper Watch toggle. Label and colour reflect state.
  if (watchBtn) {
    const watched = (typeof fpIsTrusted === 'function') && fpIsTrusted(task.path);
    watchBtn.textContent = watched ? '🛡 Watching' : '🛡 Watch';
    watchBtn.style.color = watched ? 'var(--green)' : '';
    watchBtn.onclick = () => {
      if (fpIsTrusted(task.path)) { fpUntrustTask(task.path); }
      else { fpTrustTask(task.path); }
      // Re-open detail to refresh the button state cleanly.
      openDetail(task);
    };
  }
  // Highlight note button if task has a note
  if (noteBtn && existingNote) noteBtn.style.color = 'var(--yellow)';

  document.getElementById('detail-panel').classList.remove('panel-hidden');

  // Highlight the selected row using the stable data-path attribute
  document.querySelectorAll('#task-tbody tr').forEach(r => r.classList.remove('selected'));
  const targetRow = document.querySelector(`#task-tbody tr[data-path="${CSS.escape(task.path)}"]`);
  if (targetRow) targetRow.classList.add('selected');
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
    setTimeout(() => refreshAll(true), 1000);
  } catch (err) {
    showToast('Run failed: ' + err, 'error');
  }
}

// ── Run as Test (Phase 2 feature) ───────────────────────────────────────────
// Spawns the task's action directly with stdout/stderr captured and shown in
// a modal. Crucial UX point: this is NOT the same as the regular Run button.
// We open the modal IMMEDIATELY in a "running" state so the user sees the
// program/args echoed and a spinner — long-running scripts shouldn't make
// the app feel frozen. When the IPC returns, we replace the spinner with
// the actual output blocks.
//
// Caveats surfaced inline (not just in tooltip): "runs as YOU not the
// task's principal"; "doesn't honor scheduler conditions"; "60s hard
// timeout". These matter — silently swallowing them would lead to
// "but the test passed!" / "but the task failed!" confusion.
async function runTaskAsTest(task) {
    if (!task.program_path || !task.program_path.trim()) {
        openModal('🧪 Test Run',
            `<div style="display:flex;flex-direction:column;gap:14px">
               <div style="font-size:14px;color:var(--red)">No executable found in this task's first action.</div>
               <div style="font-size:13px;color:var(--text2);line-height:1.5">
                 Test Run reads the program path from the task's first <em>Execute</em>
                 action. This task either has no actions defined or its action is
                 a different type (email, message, etc.) that can't be replayed
                 with output capture.
               </div>
             </div>`,
            `<button class="btn btn-primary" onclick="closeModal()">Close</button>`
        );
        return;
    }

    const program = task.program_path;
    const args    = task.program_args  || '';
    const cwd     = task.working_dir   || '';

    // Open the modal immediately with the running state so the user has
    // visual feedback before the IPC returns.
    openModal('🧪 Test Run',
        `<div style="display:flex;flex-direction:column;gap:14px">
           <div style="background:rgba(245,158,11,.06);border:1px solid rgba(245,158,11,.22);border-radius:6px;padding:10px 12px;font-size:12px;color:var(--text2);line-height:1.5">
             <strong style="color:var(--yellow)">Important caveats:</strong>
             <ul style="margin:6px 0 0 18px;padding:0">
               <li>Runs as <strong>you</strong> (current user) — NOT as the task's configured principal (<code>${escHtml(task.run_as_user || '—')}</code>)</li>
               <li>Scheduler conditions (idle, AC power, network) are <strong>not</strong> applied</li>
               <li>60-second hard timeout — long-running tasks will be terminated</li>
             </ul>
           </div>
           <div style="display:grid;grid-template-columns:auto 1fr;gap:6px 12px;font-size:12.5px;font-family:'Cascadia Code',Consolas,monospace">
             <div style="color:var(--text3)">Program:</div>
             <div style="color:var(--text2);word-break:break-all">${escHtml(program)}</div>
             <div style="color:var(--text3)">Args:</div>
             <div style="color:var(--text2);word-break:break-all">${escHtml(args || '(none)')}</div>
             <div style="color:var(--text3)">Working dir:</div>
             <div style="color:var(--text2);word-break:break-all">${escHtml(cwd || '(default)')}</div>
           </div>
           <div id="testrun-result" style="min-height:120px;background:var(--bg0);border:1px solid var(--border);border-radius:6px;padding:14px;text-align:center;color:var(--text3)">
             <div style="font-size:14px;margin-bottom:6px">⏳ Running…</div>
             <div style="font-size:12px">Output will appear here when the program completes (max 60s)</div>
           </div>
         </div>`,
        `<button class="btn btn-primary" id="testrun-close-btn" onclick="closeModal()">Close</button>`
    );

    appendAuditLog('test_run', task.name, `${program} ${args}`.trim());
    dinfo('runTaskAsTest', 'starting', { task: task.path, program });

    let result;
    try {
        result = await invoke('run_task_test', {
            program,
            args,
            workingDir: cwd,
        });
    } catch (err) {
        derror('runTaskAsTest', 'IPC failed', { err: String(err) });
        const resultEl = document.getElementById('testrun-result');
        if (resultEl) {
            resultEl.style.textAlign = 'left';
            resultEl.innerHTML = `
                <div style="color:var(--red);font-weight:600;margin-bottom:8px">❌ Test run failed to start</div>
                <pre style="margin:0;color:var(--text2);font-family:'Cascadia Code',Consolas,monospace;font-size:12px;white-space:pre-wrap">${escHtml(String(err))}</pre>`;
        }
        return;
    }

    dinfo('runTaskAsTest', 'completed', {
        exit_code: result.exit_code,
        timed_out: result.timed_out,
        duration_ms: result.duration_ms,
        stdout_bytes: (result.stdout || '').length,
        stderr_bytes: (result.stderr || '').length,
    });

    // Render result blocks
    const exitText = result.timed_out
        ? `<span style="color:var(--red)">⏱ TIMED OUT after 60s (process killed)</span>`
        : result.exit_code === 0
            ? `<span style="color:var(--green)">✅ exit 0</span>`
            : result.exit_code === null
                ? `<span style="color:var(--yellow)">⚠ no exit code (terminated by signal?)</span>`
                : `<span style="color:var(--red)">❌ exit ${result.exit_code}</span>`;

    const outBlock = (label, text, color) => `
        <div style="margin-top:12px">
            <div style="font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--text3);font-weight:700;margin-bottom:5px">${label} ${text ? `(${text.length} chars)` : '(empty)'}</div>
            <pre style="margin:0;background:var(--bg);border:1px solid var(--border);border-radius:5px;padding:10px;font-family:'Cascadia Code',Consolas,monospace;font-size:12px;color:${color};max-height:240px;overflow:auto;white-space:pre-wrap;line-height:1.45">${text ? escHtml(text) : '<span style="color:var(--text3);font-style:italic">(no output on this stream)</span>'}</pre>
        </div>`;

    const resultEl = document.getElementById('testrun-result');
    if (resultEl) {
        resultEl.style.textAlign = 'left';
        resultEl.style.padding = '12px';
        resultEl.innerHTML = `
            <div style="display:flex;justify-content:space-between;align-items:center;font-size:13px;font-weight:600">
                <span>${exitText}</span>
                <span style="color:var(--text3);font-weight:400;font-size:12px">${result.duration_ms}ms</span>
            </div>
            ${outBlock('stdout', result.stdout || '', 'var(--text2)')}
            ${outBlock('stderr', result.stderr || '', 'var(--red)')}`;
    }
}

async function stopTask(path) {
  try {
    await invoke('stop_task', { path });
    showToast('Task stopped', 'success');
    setTimeout(() => refreshAll(true), 1000);
  } catch (err) {
    showToast('Stop failed: ' + err, 'error');
  }
}

async function toggleTask(task) {
  try {
    // Re-resolve the task by path from the live allTasks before deciding the new
    // state: the detail panel captures `task` by closure and is not re-synced
    // after a background refresh, so task.enabled can be stale and a naive
    // !task.enabled would flip to the wrong value. (audit 2026-06-19)
    const cur = allTasks.find(t => t.path === task.path) || task;
    const newEnabled = !cur.enabled;
    await invoke('set_task_enabled', { path: task.path, enabled: newEnabled });
    appendAuditLog(newEnabled ? 'enable_task' : 'disable_task', task.name, task.path);
    showToast(`Task ${newEnabled ? 'enabled' : 'disabled'}`, 'success');
    setTimeout(() => refreshAll(true), 500);
  } catch (err) {
    showToast('Toggle failed: ' + err, 'error');
  }
}

async function deleteTask(path, name) {
  // Detect system tasks (under \Microsoft\ or \Windows\) and show an extra warning
  const isSystemTask = path.startsWith('\\Microsoft\\') || path.startsWith('\\Windows\\');
  const systemWarning = isSystemTask
    ? `<div class="info-box" style="margin-bottom:12px;border-color:var(--yellow);color:var(--yellow)">⚠ This is a Windows system task. Deleting it may break Windows functionality.</div>`
    : '';

  openModal('🗑 Delete Task',
    `<div style="padding:16px 16px 8px">
       ${systemWarning}
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
      // Feature pack 1.15.0 — capture the task XML for the recycle bin BEFORE
      // deletion so the user can undo. Returns null for unexportable system
      // tasks; we still proceed with the delete in that case.
      const trashRec = await fpTrapDelete(path, name);
      try {
        await invoke('delete_task', { path });
        appendAuditLog('delete_task', name, path);
        closeDetail();
        refreshAll();
        if (trashRec) fpOfferUndo(trashRec);
        else showToast('Task deleted', 'success');
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
  // Escape first, then wrap syntax elements in colour spans.
  // Process tag-by-tag to safely highlight attribute names/values only within tags.
  const escaped = escHtml(xml);
  return escaped
    // XML comments (apply first so tag regexes don't match inside comments)
    .replace(/(&lt;!--[\s\S]*?--&gt;)/g, '<span class="xml-comment">$1</span>')
    // Tag names (opening, closing, and self-closing)
    .replace(/(&lt;\/?)([\w:.]+)/g, '$1<span class="xml-tag-name">$2</span>')
    // Attribute names followed by ="..." values (only double-quoted via &quot; entities)
    .replace(/([\w:]+)(=&quot;[^&]*&quot;)/g,
             '<span class="xml-attr-name">$1</span><span class="xml-attr-value">$2</span>');
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
async function refreshAll(silent = false) {
  if (_refreshInProgress) return;   // prevent overlapping concurrent refreshes
  _refreshInProgress = true;
  try {
    await refreshFolders();
    await loadTasksForFolder(selectedFolder);

    // Check for task failures and notify if enabled. Uses Win32 FlashWindowEx
    // via the flash_taskbar IPC (defined in main.rs) instead of the browser
    // Notification API, which WV2 blocks by default. See sendTestNotification
    // below for the flash implementation.
    const notifyEnabled = localStorage.getItem('wtp_notifyOnFailure') === 'true';
    if (notifyEnabled && allTasks.length > 0) {
      const newlyFailed = [];
      allTasks.forEach(task => {
        const prev = _prevTaskResults[task.path];
        const code = task.last_result_code;
        // Non-zero, non-running, non-never-run = failure
        if (prev !== undefined && prev !== code && code !== 0 && code !== TASK_RESULT_RUNNING && code !== TASK_RESULT_NOT_RUN) {
          newlyFailed.push(task);
        }
      });
      if (newlyFailed.length > 0) {
        // One taskbar flash for all failures in this refresh tick — flashing
        // 20 times for 20 simultaneous failures would be obnoxious. Toast
        // gets a count or the single failed name.
        try { await invoke('flash_taskbar'); }
        catch (err) { dwarn('refreshAll', 'flash_taskbar failed', { err: String(err) }); }
        const msg = newlyFailed.length === 1
          ? `Task failed: ${newlyFailed[0].name}`
          : `${newlyFailed.length} tasks failed`;
        showToast(msg, 'error');
      }
    }
    // Update previous results map regardless of notify state.
    // BUG FIX (audit 2026-06-11): this line lived INSIDE the notifyEnabled
    // block above, contradicting its own comment. With notifications off the
    // map froze, so re-enabling them replayed every state change that
    // happened while they were off as a fresh "task failed" alert. Seeding
    // unconditionally keeps `prev` current so only genuinely new transitions
    // notify.
    allTasks.forEach(t => { _prevTaskResults[t.path] = t.last_result_code; });

    // Only show "Refreshed" toast for explicit manual refreshes (not auto-refresh ticks)
    if (!silent) showToast('Refreshed', 'success');
  } catch (err) {
    if (!silent) showToast('Refresh failed: ' + err, 'error');
  } finally {
    _refreshInProgress = false;
  }
}

// ── Create task dialog ────────────────────────────────────────────────────────
async function openCreateDialog(prefill = {}) {
  _editTaskPath = null;   // reset edit mode; openEditDialog will set this after
  _editTriggerStartDate = null;

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
  let folderOptions = `<option value="\\" ${!(prefill.folder) || prefill.folder === '\\' ? 'selected' : ''}>&#92; (Root)</option>`;
  try {
    const folders = await invoke('get_folders');
    folderOptions += folders.map(f =>
      `<option value="${escHtml(f)}" ${(prefill.folder || '').toLowerCase() === f.toLowerCase() ? 'selected' : ''}>${escHtml(f)}</option>`
    ).join('');
  } catch (err) {
    // Not fatal — the dialog can still open with only root available — but we
    // want this in the log so a user reporting "I can't see my custom folders
    // in the new-task dialog" has something concrete for diagnosis.
    dwarn('openCreateDialog', 'get_folders failed', { err: String(err) });
  }

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
        <div class="form-error" id="err-name">Name is required and cannot contain: \ / : * ? " &lt; &gt; |</div>
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
        <div class="form-hint">Leave blank to run as the current user. For service accounts enter: SYSTEM, NT AUTHORITY\\NetworkService, etc. Regular user names are not supported by the Task Scheduler API without a password.</div>
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

      <!-- Schedule preview — Phase 1 feature.
           Pure-JS forecast of the next firings; no IPC. Updates live as the
           user edits the trigger fields via the input listener below. -->
      <div class="form-group" style="margin-top:18px;padding-top:14px;border-top:1px solid var(--border)">
        <label style="display:flex;align-items:center;gap:6px">
          <span>📅 Schedule Preview</span>
          <span style="font-weight:400;font-size:11px;color:var(--text3);text-transform:none;letter-spacing:0">— forecast based on current settings</span>
        </label>
        <div id="cf-schedule-preview" style="margin-top:6px">
          <div style="font-size:12.5px;color:var(--text3);font-style:italic">Adjust trigger settings to see the next firings…</div>
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
          <div style="display:flex;gap:6px;align-items:center">
            <input type="text" id="cf-script-path" class="form-control" placeholder="C:\\Scripts\\myjob.bat" style="flex:1" />
            <button class="btn" type="button" id="browse-script-btn" title="Browse for file">📂</button>
          </div>
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
          <div style="display:flex;gap:6px;align-items:center">
            <input type="text" id="cf-program" class="form-control" value="${escHtml(prefill.program || '')}" placeholder="C:\\Windows\\System32\\notepad.exe" style="flex:1" />
            <button class="btn" type="button" id="browse-program-btn" title="Browse for file">📂</button>
          </div>
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
        <div style="display:flex;gap:6px;align-items:center">
          <input type="text" id="cf-workdir" class="form-control" value="${escHtml(prefill.working_dir || '')}" placeholder="C:\\Scripts" style="flex:1" />
          <button class="btn" type="button" id="browse-workdir-btn" title="Browse for folder">📂</button>
        </div>
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

  // Apply trigger-detail prefill (Weekly days, Monthly months, days-of-month) so
  // TEMPLATES — which call this dialog directly — can pre-select them. Previously
  // only openEditDialog did this, so a Weekly/Monthly template's days/months were
  // silently dropped (e.g. "Weekly Backup — every Sunday" selected no day and then
  // failed the new weekly-day validation). (audit 2026-06-19)
  if (typeof setDaysOfWeek === 'function')   setDaysOfWeek(prefill.days_of_week || 0);
  if (typeof setMonthsOfYear === 'function') setMonthsOfYear(prefill.months_of_year || 0);
  if (prefill.days_of_month_mask) {
    const domEl = document.getElementById('cf-days-of-month');
    if (domEl) {
      const days = [];
      for (let i = 0; i < 31; i++) if (prefill.days_of_month_mask & (1 << i)) days.push(i + 1);
      domEl.value = days.join(', ');
    }
  }

  // Tab click navigation
  document.querySelectorAll('#create-tabs .modal-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      _createTabIdx = parseInt(tab.dataset.tab, 10);
      if (_createTabIdx === TAB_XML) generateXmlPreview(); // auto-refresh XML tab
      if (_createTabIdx === TAB_TRIGGER) renderSchedulePreview(); // refresh on tab focus
      updateCreateTabUI();
    });
  });

  // Live-update the schedule preview as trigger fields change. Single
  // delegated listener on the trigger panel covers all the controls (date,
  // time, day-of-week checkboxes, day-of-month, month, interval, etc.)
  // without having to wire each input individually. Both `change` (commit
  // events on selects/checkboxes) and `input` (live keystroke on text/date/
  // time/number inputs) need handling — different field types fire
  // different events.
  const triggerPanel = document.getElementById('tab-panel-1');
  if (triggerPanel) {
    const handler = () => {
      // Defer one tick so the input's value is committed before we read it
      setTimeout(renderSchedulePreview, 0);
    };
    triggerPanel.addEventListener('change', handler);
    triggerPanel.addEventListener('input',  handler);
  }

  // Wire up browse buttons for path inputs (after modal is in the DOM)
  requestAnimationFrame(() => {
    // Rust's browse_for_file/browse_for_folder return Err("cancelled") on
    // user cancel and a real error string on COM / dialog failures. We
    // swallow the cancel (legitimate, no breadcrumb needed) but log
    // anything else so a future "why didn't the picker open" debug session
    // has something to grep for. Rule 9 — no empty catches on IPC.
    const isCancel = err => String(err).toLowerCase() === 'cancelled';
    const browseScript = document.getElementById('browse-script-btn');
    if (browseScript) browseScript.onclick = async () => {
      try {
        const path = await invoke('browse_for_file', { filter: '' });
        if (path) { const el = document.getElementById('cf-script-path'); if (el) el.value = path; }
      } catch (err) { if (!isCancel(err)) derror('browse_for_file', 'script picker failed', { err: String(err) }); }
    };
    const browseProgram = document.getElementById('browse-program-btn');
    if (browseProgram) browseProgram.onclick = async () => {
      try {
        const path = await invoke('browse_for_file', { filter: '' });
        if (path) { const el = document.getElementById('cf-program'); if (el) el.value = path; }
      } catch (err) { if (!isCancel(err)) derror('browse_for_file', 'program picker failed', { err: String(err) }); }
    };
    const browseWorkdir = document.getElementById('browse-workdir-btn');
    if (browseWorkdir) browseWorkdir.onclick = async () => {
      try {
        const path = await invoke('browse_for_folder');
        if (path) { const el = document.getElementById('cf-workdir'); if (el) el.value = path; }
      } catch (err) { if (!isCancel(err)) derror('browse_for_folder', 'workdir picker failed', { err: String(err) }); }
    };
  });
}

// Show the correct tab panel and update Prev/Next/Submit button visibility
function updateCreateTabUI() {
  // Scope selectors to #modal-body so they only match the currently open
  // create/edit/clone modal and never accidentally touch other elements.
  const body = document.getElementById('modal-body');
  if (!body) return;
  body.querySelectorAll('.modal-tab-panel').forEach((p, i) => p.classList.toggle('active', i === _createTabIdx));
  body.querySelectorAll('#create-tabs .modal-tab').forEach((t, i) => t.classList.toggle('active', i === _createTabIdx));
  const prevBtn   = document.getElementById('tab-prev-btn');
  const nextBtn   = document.getElementById('tab-next-btn');
  const submitBtn = document.getElementById('create-submit-btn');
  if (prevBtn)   prevBtn.style.display   = _createTabIdx > 0       ? '' : 'none';
  if (nextBtn)   nextBtn.style.display   = _createTabIdx < TAB_XML ? '' : 'none';
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

  // Refresh the schedule preview pane whenever the trigger type or its
  // associated controls change. Defined as a function so we can call it from
  // multiple places without re-deriving form state at each call site.
  if (typeof renderSchedulePreview === 'function') renderSchedulePreview();
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

// ── Complex-task edit chooser (audit fix 1.15.1) ──────────────────────────────
// Shown when openEditDialog is asked to edit a task with >1 trigger or >1 action.
// The simple form cannot represent those without loss, so we offer the lossless
// raw-XML editor, or an explicit "continue anyway" that accepts the data loss.
function openComplexTaskEditChoice(task, triggerCount, actionCount) {
  const parts = [];
  if (triggerCount > 1) parts.push(`${triggerCount} triggers`);
  if (actionCount  > 1) parts.push(`${actionCount} actions`);
  const detail = parts.join(' and ');
  const body = `
    <div class="info-box" style="margin-bottom:12px">
      ⚠️ <strong>${escHtml(task.name)}</strong> has ${escHtml(detail)}.
    </div>
    <p style="font-size:13px;color:var(--text2);line-height:1.55;margin:0 0 10px">
      The simple editor only shows one trigger and one action. Saving from it
      would rebuild the task and <strong>discard the extra ${escHtml(detail)}</strong>.
    </p>
    <p style="font-size:13px;color:var(--text2);line-height:1.55;margin:0">
      Use the <strong>raw-XML editor</strong> to change this task without losing
      anything — it edits the exact definition Windows stores.
    </p>`;
  const footer = `
    <button class="btn btn-primary" id="cplx-xml-btn">&#xFF1C;/&#xFF1E; Edit raw XML (keeps everything)</button>
    <button class="btn" id="cplx-simple-btn" title="Will discard the extra triggers/actions">Use simple editor anyway</button>
    <button class="btn" onclick="closeModal()">Cancel</button>`;
  openModal('⚠️ Complex Task', body, footer);
  requestAnimationFrame(() => {
    const xmlBtn    = document.getElementById('cplx-xml-btn');
    const simpleBtn = document.getElementById('cplx-simple-btn');
    if (xmlBtn) xmlBtn.onclick = () => { closeModal(); openXmlEditor(task); };
    if (simpleBtn) simpleBtn.onclick = () => {
      dwarn('openComplexTaskEditChoice', 'user chose lossy simple editor', { path: task.path });
      closeModal();
      openEditDialog(task, { allowLossy: true });
    };
  });
}

// ── Lossless raw-XML editor (audit fix 1.15.1) ────────────────────────────────
// Loads the task's real XML via export_task_xml, lets the user edit it, then
// re-registers it in place via import_task_xml (TASK_CREATE_OR_UPDATE). This is
// the only edit path that preserves multi-trigger / multi-action definitions and
// anything the simple form doesn't model. The folder + name are taken from the
// task IDENTITY (its path), never a form field, so a re-import can never
// duplicate or relocate the task (AGENT_RULES Rule 45).
let _xmlEditorTask = null;
async function openXmlEditor(task) {
  // Accept a path string too, mirroring openEditDialog.
  if (typeof task === 'string') {
    const resolved = allTasks.find(t => t.path === task) || null;
    if (!resolved) {
      derror('openXmlEditor', 'task not found', { path: task });
      showToast('Task not found — refresh and try again', 'error');
      return;
    }
    task = resolved;
  }
  if (!task || !task.path) {
    derror('openXmlEditor', 'invalid task argument', { task: String(task) });
    showToast('Could not open task for editing', 'error');
    return;
  }
  _xmlEditorTask = task;

  let xml = '';
  try {
    xml = await invoke('export_task_xml', { path: task.path });
  } catch (err) {
    derror('openXmlEditor', 'export failed', { path: task.path, err: String(err) });
    showToast('Could not load task XML: ' + String(err), 'error');
    return;
  }

  const body = `
    <div class="info-box" style="margin-bottom:10px">
      Editing the exact XML Windows stores for <strong>${escHtml(task.name)}</strong>.
      Every trigger, action and setting is preserved. Saving re-registers the task
      in place — it is not duplicated or moved.
    </div>
    <div class="form-group">
      <label>Task XML</label>
      <textarea id="xe-xml" class="form-control" rows="22" spellcheck="false"
                style="font-family:monospace;font-size:11px;white-space:pre">${escHtml(xml)}</textarea>
      <div class="form-error" id="xe-err" style="display:none"></div>
    </div>`;
  const footer = `
    <button class="btn btn-primary" id="xe-save-btn">💾 Save Changes</button>
    <button class="btn" onclick="closeModal()">Cancel</button>`;
  openModal('&#xFF1C;/&#xFF1E; Edit Task XML', body, footer);

  requestAnimationFrame(() => {
    const saveBtn = document.getElementById('xe-save-btn');
    if (saveBtn) saveBtn.onclick = submitXmlEditor;
  });
}

async function submitXmlEditor() {
  const task  = _xmlEditorTask;
  const ta    = document.getElementById('xe-xml');
  const errEl = document.getElementById('xe-err');
  const showErr = (msg) => {
    if (errEl) { errEl.textContent = msg; errEl.style.display = 'block'; }
    showToast(msg, 'error');
  };
  if (!task || !task.path) { showErr('No task loaded — reopen the editor.'); return; }
  if (!ta) { showErr('XML field missing — reopen the editor.'); return; }

  const xml = ta.value.trim();
  if (!xml) { showErr('XML cannot be empty.'); return; }
  // Minimal sanity check — the backend RegisterTask is the authoritative
  // validator, but catch the obvious mistakes before we touch the live task.
  if (!/^<\?xml|^<Task[\s>]/.test(xml)) {
    showErr('That does not look like Task Scheduler XML (must start with <?xml or <Task>).');
    return;
  }

  // Folder + name come from the task IDENTITY (its path), never a form field,
  // so import can only ever update THIS task in place. (Rule 45)
  const lastSlash = task.path.lastIndexOf('\\');
  const folder = lastSlash > 0 ? task.path.substring(0, lastSlash) : '\\';
  const name   = lastSlash >= 0 ? task.path.substring(lastSlash + 1) : task.path;
  if (!name) { showErr('Could not determine task name from its path.'); return; }

  dinfo('submitXmlEditor', 'importing', { path: task.path, folder, bytes: xml.length });
  try {
    await invoke('import_task_xml', { folder, name, xml });
    appendAuditLog('edit_task', name, 'Raw XML edit');
    dinfo('submitXmlEditor', 'import OK', { path: task.path });
    showToast('Task XML saved successfully!', 'success');
    _xmlEditorTask = null;
    closeModal();
    refreshAll();
  } catch (err) {
    const errStr = String(err);
    derror('submitXmlEditor', 'import failed', { path: task.path, error: errStr });
    // Leave the modal open so the user can fix the XML and retry — same
    // retry-safety principle as submitCreateTask.
    showErr('Save failed: ' + errStr);
  }
}

// ── Open edit dialog (pre-fill create dialog and switch to edit mode) ─────────
async function openEditDialog(task, opts = {}) {
  // BUG FIX (audit 2026-06-11): several call sites pass a task PATH STRING
  // (compare modal, dashboard recent-failure rows) while the detail panel and
  // keyboard shortcut pass the task OBJECT. With a string, every property read
  // below was undefined — worst of all `task.path`, which left _editTaskPath
  // falsy so the save button silently routed to create_task and produced a
  // DUPLICATE task (the exact bug class documented in HANDOVER.md).
  // Accept both: resolve strings against the current allTasks snapshot.
  if (typeof task === 'string') {
    const resolved = allTasks.find(t => t.path === task) || null;
    if (!resolved) {
      derror('openEditDialog', 'task not found', { path: task });
      showToast('Task not found — refresh and try again', 'error');
      return;
    }
    task = resolved;
  }
  if (!task || !task.path) {
    derror('openEditDialog', 'invalid task argument', { task: String(task) });
    showToast('Could not open task for editing', 'error');
    return;
  }

  // ── SAFETY GUARD (audit fix 1.15.1): multi-trigger / multi-action tasks ────
  // The simple form models exactly ONE trigger and ONE action. update_task
  // rebuilds the entire definition from the form, so saving a task that has
  // more than one of either would SILENTLY DROP the extras — corrupting the
  // task. Many Microsoft system tasks legitimately have multiple triggers or
  // actions. Route those to the lossless raw-XML editor instead, unless the
  // user has explicitly opted into the simple editor (opts.allowLossy).
  const _trigCount = Array.isArray(task.triggers) ? task.triggers.length : 0;
  // Use the backend's total action_count (ALL action types) when available, not
  // task.actions.length (EXEC actions only) — otherwise a task with one exec +
  // one email/show-message action reports 1 and slips past the guard, then
  // update_task rebuilds it with a single exec action, silently dropping the
  // other. (audit 2026-06-19)
  const _actCount  = (typeof task.action_count === 'number' && task.action_count > 0)
    ? task.action_count
    : (Array.isArray(task.actions) ? task.actions.length : 0);
  // Environment-variable tasks are stored as a cmd.exe `/c "SET ..."` wrapper the
  // simple form cannot round-trip (editing would strip or double-wrap the vars).
  // Route them to the lossless XML editor too. (audit 2026-06-19)
  if (!opts.allowLossy) {
    const a0 = (task.actions && task.actions[0]) || '';
    if (/cmd\.exe/i.test(a0) && /\/c\s+"set\s+/i.test(a0)) {
      dwarn('openEditDialog', 'env-var wrapped task — offering XML editor', { path: task.path });
      openComplexTaskEditChoice(task, _trigCount, _actCount);
      return;
    }
  }
  if (!opts.allowLossy && (_trigCount > 1 || _actCount > 1)) {
    dwarn('openEditDialog', 'complex task — offering XML editor',
          { path: task.path, triggers: _trigCount, actions: _actCount });
    openComplexTaskEditChoice(task, _trigCount, _actCount);
    return;
  }
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

  // Derive folder from the task's full path (e.g. "\MyFolder\TaskName" → "\MyFolder")
  // task.folder may already be set, but fall back to parsing task.path for reliability.
  const taskFolder = (() => {
    if (task.folder && task.folder !== '\\') return task.folder;
    const path = task.path || '';
    const lastSlash = path.lastIndexOf('\\');
    if (lastSlash <= 0) return '\\';
    return path.substring(0, lastSlash) || '\\';
  })();

  const prefill = {
    name:         task.name,
    folder:       taskFolder,
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
  // Preserve the original StartBoundary date so editing a recurring task does
  // not re-anchor its schedule to today. (audit 2026-06-19)
  _editTriggerStartDate = (tIdx >= 0 ? startFull.slice(0, tIdx) : null);
  const titleEl   = document.getElementById('modal-title');
  const submitBtn = document.getElementById('create-submit-btn');
  if (titleEl)   titleEl.textContent   = '✏️ Edit Task';
  if (submitBtn) submitBtn.textContent = '💾 Save Changes';

  // BUG FIX (audit 2026-06-11): lock the name field while editing. update_task
  // registers the definition under params.name in the source folder — if the
  // user renamed here, RegisterTaskDefinition created a NEW task under the new
  // name and the original remained: silent duplication. Windows' own Task
  // Scheduler MMC has no rename either (rename = export/import), so read-only
  // matches platform convention. readonly (not disabled) keeps the value
  // selectable/copyable and still readable by submitCreateTask.
  const nameLockEl = document.getElementById('cf-name');
  if (nameLockEl) {
    nameLockEl.readOnly = true;
    nameLockEl.style.opacity = '0.65';
    nameLockEl.style.cursor = 'not-allowed';
    nameLockEl.title = 'Task names cannot be changed while editing — to rename, export the task and import it under the new name.';
  }

  // Lock the Run Level select on edit: update_task preserves the task's existing
  // privilege level and ignores this field, so leaving it editable promised a
  // change it could not deliver. Locked (with a tooltip) it now tells the truth.
  // (audit 2026-06-19)
  const runLevelLockEl = document.getElementById('cf-run-level');
  if (runLevelLockEl) {
    runLevelLockEl.disabled = true;
    runLevelLockEl.style.opacity = '0.65';
    runLevelLockEl.style.cursor = 'not-allowed';
    runLevelLockEl.title = 'Run level cannot be changed while editing — the existing privilege level is preserved. To change it, recreate the task.';
  }

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
    // Keep the single "Day of Month" field on the Trigger tab consistent with the
    // real day instead of always showing 1 (the Advanced days-of-month field
    // carries the full set and wins on submit). (audit 2026-06-19)
    if (normalizedTrigger === 'Monthly') {
      let firstDay = null;
      for (let i = 0; i < 31; i++) { if (prefill.days_of_month_mask & (1 << i)) { firstDay = i + 1; break; } }
      const monthDayEl = document.getElementById('cf-month-day');
      if (monthDayEl && firstDay) monthDayEl.value = String(firstDay);
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
  // Re-entrancy guard: the create/update IPC is a slow synchronous COM call;
  // without this a double-click fires two create_task IPCs → a duplicate task.
  if (_submittingTask) return;
  // ── Gather values ──────────────────────────────────────────────────────────
  const nameEl    = document.getElementById('cf-name');
  const name      = nameEl ? nameEl.value.trim() : '';
  const folder    = document.getElementById('cf-folder')?.value    || '\\';
  const desc      = document.getElementById('cf-desc')?.value.trim() || '';
  const run_level = parseInt(document.getElementById('cf-run-level')?.value || '0', 10);
  const run_as    = document.getElementById('cf-run-as-user')?.value.trim() || '';
  const hidden    = !!document.getElementById('cf-hidden')?.checked;
  const enabled   = document.getElementById('cf-enabled')?.checked ?? true;

  const trigger_type = document.getElementById('cf-trigger-type')?.value || 'Once';
  const action_type  = document.getElementById('cf-action-type')?.value || 'program';

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

  const nameInvalid = !name || /[\/\\:*?"<>|]/.test(name);
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
  // When EDITING a recurring task, keep its original StartBoundary date instead
  // of re-anchoring to today (which shifts the day/week parity of "every N
  // days/weeks" triggers); null for new tasks → today. (audit 2026-06-19)
  const baseDate = (_editTaskPath && _editTriggerStartDate) ? _editTriggerStartDate : today;

  switch (trigger_type) {
    case 'Once': {
      const dt = document.getElementById('cf-datetime')?.value || '';
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
      const t = document.getElementById('cf-daily-time')?.value || '';
      if (!t) {
        markErr('cf-daily-time', true);
        if (_createTabIdx !== TAB_TRIGGER) { _createTabIdx = TAB_TRIGGER; updateCreateTabUI(); }
      } else {
        start_datetime = `${baseDate}T${fmtTime(t)}`;
        markErr('cf-daily-time', false);
      }
      const di = parseInt(document.getElementById('cf-days-interval')?.value || '1', 10) || 1;
      days_interval = Math.max(1, di);
      markErr('cf-days-interval', di < 1);
      break;
    }
    case 'Weekly': {
      const t = document.getElementById('cf-weekly-time')?.value || '08:00';
      start_datetime = `${baseDate}T${fmtTime(t)}`;
      days_interval  = Math.max(1, parseInt(document.getElementById('cf-weeks-interval')?.value || '1', 10) || 1);
      // A weekly trigger with no day-of-week selected is accepted by Windows but
      // never fires. Validate at least one day. (audit 2026-06-19)
      if (daysOfWeekBitmask() === 0) {
        const dowGroup = document.getElementById('cf-dow-mon')?.closest('.form-group');
        if (dowGroup) dowGroup.classList.add('has-error');
        valid = false;
        if (_createTabIdx !== TAB_TRIGGER) { _createTabIdx = TAB_TRIGGER; updateCreateTabUI(); }
        showToast('Select at least one day of the week — a weekly trigger with no days never runs', 'error');
      }
      break;
    }
    case 'Monthly': {
      const t   = document.getElementById('cf-monthly-time')?.value || '08:00';
      const day = parseInt(document.getElementById('cf-month-day')?.value || '1', 10) || 1;
      start_datetime = `${baseDate}T${fmtTime(t)}`;
      days_interval  = Math.max(1, Math.min(31, day));
      markErr('cf-month-day', day < 1 || day > 31);
      break;
    }
    case 'Idle': {
      const mins = parseInt(document.getElementById('cf-idle-min')?.value || '10', 10) || 10;
      days_interval = Math.max(1, mins);
      markErr('cf-idle-min', mins < 1);
      break;
    }
    case 'Interval': {
      // Interval maps to Daily trigger with repetition_interval
      const startTime = document.getElementById('cf-interval-start')?.value || '00:00';
      start_datetime = `${baseDate}T${fmtTime(startTime)}`;
      days_interval  = 1; // Always 1 day interval for the outer trigger
      break;
    }
    default: break; // Boot, Logon, SessionLock, SessionUnlock — no extra params needed
  }

  // ── Build action params ────────────────────────────────────────────────────
  let program_path  = '';
  let arguments_str = '';

  const scriptPath = document.getElementById('cf-script-path')?.value.trim() || '';
  const extraArgs  = document.getElementById('cf-extra-args')?.value.trim() || '';

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
      program_path  = document.getElementById('cf-program')?.value.trim() || '';
      arguments_str = document.getElementById('cf-args')?.value.trim() || '';
      if (!program_path) {
        markErr('cf-program', true);
        if (_createTabIdx !== TAB_ACTION) { _createTabIdx = TAB_ACTION; updateCreateTabUI(); }
      } else {
        markErr('cf-program', false);
      }
      break;
    }
  }

  const working_dir = document.getElementById('cf-workdir')?.value.trim() || '';

  if (!valid) {
    showToast('Please fix the highlighted errors', 'error');
    return;
  }

  // ── Guard: time-based triggers require a valid start_datetime ───────────────
  const timeBased = ['Once', 'Daily', 'Weekly', 'Monthly', 'Interval'].includes(trigger_type);
  if (timeBased && !start_datetime) {
    showToast('Please set a valid start date/time for this trigger type', 'error');
    _createTabIdx = TAB_TRIGGER;
    updateCreateTabUI();
    return;
  }

  // ── Submit ─────────────────────────────────────────────────────────────────
  // Read all advanced params
  const endBoundaryRaw = document.getElementById('cf-end-boundary')?.value || '';
  const endBoundary    = endBoundaryRaw.length === 16 ? endBoundaryRaw + ':00' : endBoundaryRaw;

  // Handle Interval trigger: compute repetition_interval from unit+value
  let intervalRepetitionInterval = parseDurationSelect('cf-rep-interval','cf-rep-interval-custom');
  if (trigger_type === 'Interval') {
    const val  = parseInt(document.getElementById('cf-interval-value')?.value || '1', 10) || 1;
    const unit = document.getElementById('cf-interval-unit')?.value || 'Hours';
    intervalRepetitionInterval = unit === 'Hours' ? `PT${val}H` : `PT${val}M`;
  }

  // Collect env vars from the textarea (newline-separated KEY=VALUE)
  const envVarsEl  = document.getElementById('cf-env-vars');
  const env_vars   = envVarsEl ? envVarsEl.value.trim() : '';

  const advancedParams = {
    execution_time_limit:  parseDurationSelect('cf-exec-limit',  'cf-exec-limit-custom'),
    repetition_interval:   intervalRepetitionInterval,
    repetition_duration:   trigger_type === 'Interval' ? '' : parseDurationSelect('cf-rep-duration','cf-rep-duration-custom'),
    stop_at_duration_end:  trigger_type === 'Interval' ? false : !!document.getElementById('cf-rep-stop-end')?.checked,
    end_boundary:          endBoundary,
    delay:                 parseDurationSelect('cf-boot-delay',  'cf-boot-delay-custom'),
    random_delay:          parseDurationSelect('cf-random-delay','cf-random-delay-custom'),
    weeks_interval:        parseInt(document.getElementById('cf-weeks-interval')?.value || '0', 10) || 0,
    days_of_week:          daysOfWeekBitmask(),
    months_of_year:        monthsOfYearBitmask(),
    days_of_month:         daysOfMonthBitmask(),
    stop_existing:         !!document.getElementById('cf-stop-existing')?.checked,
    delete_expired:        !!document.getElementById('cf-delete-expired')?.checked,
    priority:              parseInt(document.getElementById('cf-priority')?.value || '7', 10),
    wake_to_run:           !!document.getElementById('cf-wake-to-run')?.checked,
    run_only_if_network:   !!document.getElementById('cf-run-on-network')?.checked,
    run_only_if_idle:      !!document.getElementById('cf-run-on-idle')?.checked,
    disallow_on_batteries: !!document.getElementById('cf-no-battery-start')?.checked,
    stop_on_batteries:     !!document.getElementById('cf-stop-on-battery')?.checked,
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

  // Snapshot edit-mode flag BEFORE the async call so the catch arm can label
  // the error correctly even if some other code path mutates _editTaskPath
  // concurrently. Used by both branches of the toast.
  const wasEdit = !!_editTaskPath;
  // BUG FIX (2.1.0 audit round 4): these were calling `dlog(target, level, msg, data)`
  // with the level slot containing human-readable strings ('update', 'create OK',
  // 'FAIL') — which aren't valid levels. The logger silently defaulted to INFO
  // AND the object in the msg slot became "[object Object]" via String(). Net
  // result: every submit_task log line was useless. Now uses the right wrappers
  // with a proper string message and the object as the data param.
  dinfo('submit_task', wasEdit ? 'updating' : 'creating',
        { name, path: _editTaskPath, trigger_type, program_path });
  _submittingTask = true;
  const _submitBtn = document.getElementById('create-submit-btn');
  if (_submitBtn) _submitBtn.disabled = true;
  try {
    if (_editTaskPath) {
      await invoke('update_task', { path: _editTaskPath, params: taskParams });
      appendAuditLog('edit_task', name, 'Trigger: ' + trigger_type);
      dinfo('submit_task', 'update OK', { name, path: _editTaskPath });
      showToast('Task updated successfully!', 'success');
    } else {
      await invoke('create_task', { params: taskParams });
      appendAuditLog('create_task', name, 'Trigger: ' + trigger_type);
      dinfo('submit_task', 'create OK', { name });
      showToast('Task created successfully!', 'success');
    }
    // Only clear edit state on SUCCESS. Clearing on failure is what previously
    // caused the "save fails → user retries with the still-open modal → silently
    // creates a duplicate" bug, because the second click would see _editTaskPath
    // as null and route to create_task instead of update_task.
    _editTaskPath = null;
    closeModal();
    refreshAll();
  } catch (err) {
    const errStr = String(err);
    // _editTaskPath is intentionally NOT reset on failure — the modal stays open
    // so the user can correct the error and retry; the retry must still target
    // update_task with the same path, not create a new task.
    derror('submit_task', (wasEdit ? 'update' : 'create') + ' failed',
           { wasEdit, name, error: errStr });
    showToast((wasEdit ? 'Update' : 'Create') + ' failed: ' + errStr, 'error');
  } finally {
    _submittingTask = false;
    if (_submitBtn) _submitBtn.disabled = false;
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
  } catch (err) {
    dwarn('importXml', 'get_folders failed', { err: String(err) });
  }

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
  const name   = document.getElementById('ix-name')?.value.trim()  || '';
  const folder = document.getElementById('ix-folder')?.value          || '\\';
  const xml    = document.getElementById('ix-xml')?.value.trim()  || '';

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
    <div class="ctx-item" data-ctx-action="run">▶ Run</div>
    <div class="ctx-item" data-ctx-action="stop">⏹ Stop</div>
    <div class="ctx-item" data-ctx-action="toggle">${task.enabled ? '⏸ Disable' : '▶ Enable'}</div>
    <div class="ctx-sep"></div>
    <div class="ctx-item" data-ctx-action="note">📝 ${getNoteForTask(task.path) ? 'Edit Note' : 'Add Note'}</div>
    <div class="ctx-item" data-ctx-action="ps">⚡ Copy as PowerShell</div>
    <div class="ctx-item" data-ctx-action="copy-path">📋 Copy Path</div>
    <div class="ctx-item" data-ctx-action="copy-name">📋 Copy Name</div>
    <div class="ctx-item" data-ctx-action="xml">＜/＞ Export XML</div>
    <div class="ctx-item" data-ctx-action="edit-xml">＜/＞ Edit XML</div>
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
      case 'note':      openNoteDialog(t);                       break;
      case 'ps':        copyAsPowerShell(t);                     break;
      case 'copy-path': navigator.clipboard.writeText(t.path);   break;
      case 'copy-name': navigator.clipboard.writeText(t.name);   break;
      case 'run':       runTask(t.path);                         break;
      case 'stop':      stopTask(t.path);                        break;
      case 'toggle':    toggleTask(t);                           break;
      case 'xml':       exportXml(t.path);                       break;
      case 'edit-xml':  openXmlEditor(t);                        break;
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
      days_of_week:  1,   // Sunday (bitmask Sun=1) — matches the description (audit 2026-06-19)
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
  // ── Maintenance templates (audit 2026-06-19) — real built-in Windows tools,
  //    fully wired (days/months pre-selected where a trigger needs them). ──────
  {
    name: 'Empty Recycle Bin',
    description: 'Empties the Recycle Bin every Sunday at 3 AM',
    icon: '🗑️',
    prefill: {
      name: 'Empty_Recycle_Bin', description: 'Empty the Recycle Bin weekly',
      trigger_type: 'weekly', trigger_value: '03:00', days_of_week: 1,
      action_type: 'powershell', program: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      arguments: '-NonInteractive -Command "Clear-RecycleBin -Force -ErrorAction SilentlyContinue"',
    }
  },
  {
    name: 'Flush DNS Cache',
    description: 'Clears the DNS resolver cache at every logon',
    icon: '🌐',
    prefill: {
      name: 'Flush_DNS_Cache', description: 'Flush the DNS resolver cache',
      trigger_type: 'logon',
      action_type: 'cmd', program: 'C:\\Windows\\System32\\cmd.exe', arguments: '/c ipconfig /flushdns',
    }
  },
  {
    name: 'System File Check',
    description: 'Runs SFC /scannow on the 1st of each month at 4 AM',
    icon: '🛠️',
    prefill: {
      name: 'System_File_Check', description: 'Verify and repair Windows system files',
      trigger_type: 'monthly', trigger_value: '04:00', days_interval: 1, days_of_month_mask: 1, months_of_year: 4095,
      action_type: 'cmd', program: 'C:\\Windows\\System32\\cmd.exe', arguments: '/c sfc /scannow',
    }
  },
  {
    name: 'Disk Cleanup',
    description: 'Runs Windows Disk Cleanup every Saturday at 2 AM',
    icon: '🧼',
    prefill: {
      name: 'Disk_Cleanup', description: 'Free up disk space with cleanmgr',
      trigger_type: 'weekly', trigger_value: '02:00', days_of_week: 64,
      action_type: 'cmd', program: 'C:\\Windows\\System32\\cmd.exe', arguments: '/c cleanmgr /verylowdisk',
    }
  },
  {
    name: 'Defender Quick Scan',
    description: 'Runs a Microsoft Defender quick scan daily at noon',
    icon: '🛡️',
    prefill: {
      name: 'Defender_Quick_Scan', description: 'Microsoft Defender quick scan',
      trigger_type: 'daily', trigger_value: '12:00',
      action_type: 'custom', program: 'C:\\Program Files\\Windows Defender\\MpCmdRun.exe', arguments: '-Scan -ScanType 1',
    }
  },
  {
    name: 'Battery Health Report',
    description: 'Generates a battery report every Monday at 9 AM (laptops)',
    icon: '🔋',
    prefill: {
      name: 'Battery_Health_Report', description: 'Generate a powercfg battery report',
      trigger_type: 'weekly', trigger_value: '09:00', days_of_week: 2,
      action_type: 'cmd', program: 'C:\\Windows\\System32\\cmd.exe',
      arguments: '/c powercfg /batteryreport /output "%USERPROFILE%\\battery-report.html"',
    }
  },
  {
    name: 'Refresh Group Policy',
    description: 'Forces a Group Policy update at every logon (domain PCs)',
    icon: '🔁',
    prefill: {
      name: 'Refresh_Group_Policy', description: 'Force gpupdate at logon',
      trigger_type: 'logon',
      action_type: 'cmd', program: 'C:\\Windows\\System32\\cmd.exe', arguments: '/c gpupdate /target:computer /force',
    }
  },
  {
    name: 'Optimize Drive (Idle)',
    description: 'Optimizes/defragments C: when the PC is idle',
    icon: '💿',
    prefill: {
      name: 'Optimize_Drive_Idle', description: 'Optimize the C: drive when idle',
      trigger_type: 'idle',
      action_type: 'cmd', program: 'C:\\Windows\\System32\\cmd.exe', arguments: '/c defrag C: /O',
    }
  },
  {
    name: 'Log Boot Time',
    description: 'Appends the date and time to a log file at every startup',
    icon: '🚀',
    prefill: {
      name: 'Log_Boot_Time', description: 'Record each system startup time',
      trigger_type: 'boot',
      action_type: 'cmd', program: 'C:\\Windows\\System32\\cmd.exe',
      arguments: '/c echo Booted %DATE% %TIME% >> "%USERPROFILE%\\boot-log.txt"',
    }
  },
  {
    name: 'Create Restore Point',
    description: 'Creates a System Restore point every Sunday at 1 AM',
    icon: '🛟',
    prefill: {
      name: 'Create_Restore_Point', description: 'Weekly System Restore checkpoint',
      trigger_type: 'weekly', trigger_value: '01:00', days_of_week: 1,
      action_type: 'powershell', program: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      arguments: '-NonInteractive -Command "Checkpoint-Computer -Description \'Weekly Restore Point\' -RestorePointType MODIFY_SETTINGS"',
    }
  },
];

// ── PowerShell setup-script export (Phase 3 feature) ────────────────────────
// Generates a self-contained .ps1 that recreates the selected tasks on
// another machine. Use cases: backups, machine migration, deployment to
// a fleet.
//
// Implementation strategy: for each task, embed its XML literally and use
// `Register-ScheduledTask -Xml`. This is the most faithful reproduction
// because Microsoft's exported XML preserves every nuance (delays, random
// jitter, conditions) that a hand-rolled `-Trigger` / `-Action` chain
// would miss.
//
// The generated script has these qualities:
//   - Single file, no external deps beyond PowerShell 5.1 (built into
//     Windows 10+).
//   - Self-documenting header explaining what it does.
//   - Per-task try/catch so a partial failure doesn't abort the rest.
//   - Final summary line so the user knows what got installed.
//   - "Re-run safe" — uses Register-ScheduledTask with -Force which is
//     create-or-update.
//
// Caveats baked into the script header:
//   - Tasks running as specific accounts (not SYSTEM/current user) need
//     credentials at install time — script prompts.
//   - Tasks with relative paths in working directory may behave
//     differently on the target machine.
async function exportTasksAsPowerShellScript(tasksToExport) {
    if (!tasksToExport || tasksToExport.length === 0) {
        showToast('No tasks selected for export', 'error');
        return;
    }

    // Fetch each task's XML — needed to reconstruct on the other side.
    showToast('Building setup script…', 'info');
    const blocks = [];
    let failures = 0;
    for (const task of tasksToExport) {
        try {
            const xml = await invoke('export_task_xml', { path: task.path });
            blocks.push({ task, xml });
        } catch (err) {
            derror('exportTasksAsPowerShellScript', 'export failed', { path: task.path, err: String(err) });
            failures++;
        }
    }

    if (blocks.length === 0) {
        showToast('Could not export any tasks', 'error');
        return;
    }

    // Build the script. Header + per-task block + footer.
    // PowerShell here-strings (@'...'@) preserve the XML literally
    // without us having to escape anything. The single-quoted form
    // (@'...'@ as opposed to @"..."@) means $variables aren't expanded,
    // so XML containing literal $ characters is safe.
    const isoDate = new Date().toISOString().slice(0, 19).replace('T', ' ');
    const scriptParts = [];

    scriptParts.push(`# WinTaskPro task setup script
# Generated: ${isoDate}
# Tasks:     ${blocks.length}
# Source:    ${tasksToExport.map(t => t.path).join(', ')}
#
# Recreates the selected scheduled tasks on the target machine. Run as
# Administrator (required for task registration).
#
# Caveats:
#   - Tasks configured to run as specific user accounts (not SYSTEM,
#     LocalService, NetworkService, or the current user) will prompt for
#     credentials when registered. If you need unattended install, edit
#     each Register-ScheduledTask call to pass -User and -Password.
#   - Tasks referencing absolute paths (e.g. C:\\Scripts\\backup.ps1) need
#     those paths to exist on the target machine.
#   - Re-running this script is safe — Register-ScheduledTask with -Force
#     overwrites existing tasks of the same name in the same folder.
#
# Exit codes:
#   0 = all tasks installed successfully
#   1 = one or more tasks failed (see output)

#Requires -RunAsAdministrator
$ErrorActionPreference = 'Continue'

$installed = 0
$failed    = 0
$failedTasks = @()
`);

    for (const { task, xml } of blocks) {
        // PS comment-safe task name (escape backticks and dollar signs)
        const safeName = task.name.replace(/[\`$]/g, '');
        const folder   = task.folder || '\\';

        // Within an @'...'@ here-string, the only thing that closes it is
        // a line with literally `'@`. XML cannot contain that sequence
        // at the start of a line in valid Task Scheduler output, but
        // defend against it anyway by indenting the XML one space.
        const safeXml = xml.split('\n').map(line =>
            line.startsWith("'@") ? ' ' + line : line
        ).join('\n');

        scriptParts.push(`
# ─── Task: ${safeName} ───────────────────────────────────────────────
Write-Host "Registering ${safeName}…" -NoNewline
$xml = @'
${safeXml}
'@
try {
    Register-ScheduledTask -TaskName '${task.name.replace(/'/g, "''")}' \`
                           -TaskPath '${folder.replace(/'/g, "''")}' \`
                           -Xml $xml \`
                           -Force | Out-Null
    Write-Host " ✓" -ForegroundColor Green
    $installed++
} catch {
    Write-Host " ✗" -ForegroundColor Red
    Write-Host "  Error: $($_.Exception.Message)" -ForegroundColor Red
    $failed++
    $failedTasks += '${task.name.replace(/'/g, "''")}'
}
`);
    }

    scriptParts.push(`
# ─── Summary ─────────────────────────────────────────────────────
Write-Host ''
Write-Host "Installed: $installed" -ForegroundColor Green
if ($failed -gt 0) {
    Write-Host "Failed:    $failed" -ForegroundColor Red
    Write-Host "Failed tasks:" -ForegroundColor Red
    $failedTasks | ForEach-Object { Write-Host "  - $_" -ForegroundColor Red }
    exit 1
}
exit 0
`);

    const finalScript = scriptParts.join('');

    // Show a modal with copy + download options. localStorage isn't
    // suitable for blob downloads; we use a Blob URL.
    const blob = new Blob([finalScript], { type: 'text/plain;charset=utf-8' });
    const blobUrl = URL.createObjectURL(blob);
    const filename = `wintaskpro_setup_${new Date().toISOString().slice(0,10)}.ps1`;

    openModal('⚡ PowerShell Setup Script',
        `<div style="display:flex;flex-direction:column;gap:14px">
           <div style="font-size:13px;color:var(--text2);line-height:1.5">
             Generated a self-contained PowerShell script that recreates ${blocks.length} task${blocks.length === 1 ? '' : 's'}
             on another machine. Run as Administrator on the target.
           </div>
           ${failures > 0 ? `
           <div style="background:rgba(245,158,11,.06);border:1px solid rgba(245,158,11,.22);border-radius:6px;padding:10px 12px;font-size:12px;color:var(--yellow)">
             ⚠ ${failures} task${failures === 1 ? '' : 's'} could not be exported and ${failures === 1 ? 'is' : 'are'} not in the script.
           </div>` : ''}
           <div style="background:var(--bg0);border:1px solid var(--border);border-radius:6px;max-height:280px;overflow:auto">
             <pre style="margin:0;padding:14px;font-family:'Cascadia Code',Consolas,monospace;font-size:11.5px;color:var(--text2);line-height:1.5;white-space:pre">${escHtml(finalScript.length > 4000 ? finalScript.slice(0, 4000) + '\n\n... (truncated for preview, full script in download)' : finalScript)}</pre>
           </div>
           <div style="font-size:12px;color:var(--text3)">Script size: ${(finalScript.length / 1024).toFixed(1)} KB</div>
         </div>`,
        `<a href="${blobUrl}" download="${escHtml(filename)}" class="btn btn-primary" style="text-decoration:none">📥 Download .ps1</a>
         <button class="btn" onclick="copyScriptToClipboard()">📋 Copy</button>
         <button class="btn" onclick="closeModal()">Close</button>`
    );

    // Stash for the copy button
    window._wtpExportedScript = finalScript;
    appendAuditLog('export_ps_script', blocks.length + ' tasks', filename);
    dinfo('exportTasksAsPowerShellScript', 'generated', { tasks: blocks.length, kb: (finalScript.length / 1024).toFixed(1), failures });
}

async function copyScriptToClipboard() {
    if (!window._wtpExportedScript) return;
    try {
        await navigator.clipboard.writeText(window._wtpExportedScript);
        showToast('Script copied to clipboard', 'success');
    } catch (err) {
        showToast('Copy failed: ' + String(err), 'error');
    }
}

// Convenience entry points: one for selected (bulk toolbar) and one for
// single (detail panel).
async function exportSelectedAsPowerShell() {
    const paths = [..._selectedPaths];
    if (paths.length === 0) { showToast('No tasks selected', 'info'); return; }
    const tasks = paths.map(p => allTasks.find(t => t.path === p)).filter(Boolean);
    await exportTasksAsPowerShellScript(tasks);
}
async function exportTaskAsPowerShell(task) {
    if (!task) return;
    await exportTasksAsPowerShellScript([task]);
}


// ── Integrity check (Phase 3 feature) ───────────────────────────────────────
// Detects when a task's referenced executable has changed since the user
// last marked it as "trusted". Threat model: malware replacing the .exe
// at a path used by an existing scheduled task, where the task itself
// looks unchanged in Task Scheduler but executes attacker code on its
// next firing.
//
// Workflow:
//   1. User clicks "🛡 Integrity Check" → modal.
//   2. App computes SHA-256 of every task's program_path in parallel,
//      compares against stored baselines from localStorage.
//   3. Tasks fall into three buckets:
//        a. NEW (no baseline yet) — user can "Trust current" to record.
//        b. UNCHANGED (matches baseline) — green checkmark.
//        c. CHANGED (mismatch) — red flag with old vs new hash, user
//           can re-trust if they made a deliberate update, or
//           investigate.
//   4. "Trust all" / "Re-trust changed" bulk operations with confirmation.
//
// Storage key: 'wtp_integrity_baselines'. Schema:
//   { "<task_path>": { "program_path": "...", "hash": "...", "trusted_at": iso } }
//
// Limitations explicitly disclosed:
//   - Doesn't catch ARGUMENT changes (would need a separate baseline of args)
//   - Doesn't catch replacements of dependent DLLs the program loads
//   - First-run baseline establishment is a leap of faith (you have to
//     trust the .exe at LEAST once)
const INTEGRITY_BASELINE_KEY = 'wtp_integrity_baselines';

function loadIntegrityBaselines() {
    try {
        const raw = localStorage.getItem(INTEGRITY_BASELINE_KEY);
        return raw ? JSON.parse(raw) : {};
    } catch (err) {
        derror('loadIntegrityBaselines', 'parse failed', { err: String(err) });
        return {};
    }
}

function saveIntegrityBaselines(baselines) {
    try {
        localStorage.setItem(INTEGRITY_BASELINE_KEY, JSON.stringify(baselines));
        return true;
    } catch (err) {
        derror('saveIntegrityBaselines', 'write failed', { err: String(err) });
        showToast('Could not save trust list (storage full?)', 'error');
        return false;
    }
}

async function openIntegrityCheck() {
    openModal('🛡 Integrity Check',
        `<div style="display:flex;flex-direction:column;gap:14px">
           <div style="font-size:13px;color:var(--text2);line-height:1.5">
             Hashes the executable at each task's program path and compares against
             a saved "trust" baseline. Detects when a binary has been replaced
             or modified since it was last marked trusted — a useful tripwire for
             malware that hijacks scheduled tasks.
           </div>
           <div style="background:rgba(245,158,11,.06);border:1px solid rgba(245,158,11,.22);border-radius:6px;padding:10px 12px;font-size:12px;color:var(--text2);line-height:1.5">
             <strong style="color:var(--yellow)">Limitations:</strong>
             only checks the program binary itself — not arguments, not DLLs the program loads.
             First-run baseline requires you to trust the executable at least once. Storage is
             local only (no cross-machine sync).
           </div>
           <div id="integ-results" style="min-height:120px;background:var(--bg0);border:1px solid var(--border);border-radius:6px;padding:14px;text-align:center;color:var(--text3)">
             <div style="font-size:14px;margin-bottom:6px">⏳ Scanning…</div>
             <div style="font-size:12px" id="integ-progress">Computing hashes</div>
           </div>
         </div>`,
        `<button class="btn" onclick="closeModal()">Close</button>`
    );

    const tasks  = (allTasks || []).filter(t => t.program_path && t.program_path.trim());
    const baselines = loadIntegrityBaselines();
    const records = [];

    const progressEl = document.getElementById('integ-progress');
    let done = 0;

    // Hash every program path in parallel — Tauri IPCs are independent
    // requests; sequential await would be needlessly slow on large task
    // lists. The Rust side reads files in 64KB chunks so even multi-MB
    // exes hash in milliseconds on modern SSDs.
    const hashPromises = tasks.map(async (t) => {
        try {
            const hash = await invoke('hash_file', { path: t.program_path });
            done++;
            if (progressEl) progressEl.textContent = `Hashed ${done} / ${tasks.length}`;
            return { task: t, hash, error: null };
        } catch (err) {
            done++;
            if (progressEl) progressEl.textContent = `Hashed ${done} / ${tasks.length}`;
            return { task: t, hash: null, error: String(err) };
        }
    });

    const hashResults = await Promise.all(hashPromises);

    // Bucket the results
    const buckets = { changed: [], missing: [], untrusted: [], ok: [] };
    for (const { task, hash, error } of hashResults) {
        const key = task.path;
        const baseline = baselines[key];
        if (error) {
            records.push({ task, status: 'error', hash: null, baseline, error });
            continue;
        }
        if (hash === '') {
            // File doesn't exist
            buckets.missing.push({ task, hash: '', baseline });
            continue;
        }
        if (!baseline) {
            buckets.untrusted.push({ task, hash, baseline: null });
            continue;
        }
        if (baseline.program_path !== task.program_path) {
            // Program path itself changed — treat as untrusted (user
            // changed which file they care about; baseline doesn't apply).
            buckets.untrusted.push({ task, hash, baseline });
            continue;
        }
        if (baseline.hash === hash) {
            buckets.ok.push({ task, hash, baseline });
        } else {
            buckets.changed.push({ task, hash, baseline });
        }
    }

    renderIntegrityResults(buckets);
}

function renderIntegrityResults(buckets) {
    const resultsEl = document.getElementById('integ-results');
    if (!resultsEl) return;

    const totalScanned = buckets.ok.length + buckets.changed.length
                       + buckets.missing.length + buckets.untrusted.length;

    const renderRow = (entry, statusBadge, statusColor, hashCell) => `
        <tr style="border-bottom:1px solid rgba(31,38,64,.45)">
            <td style="padding:7px 10px" title="${escHtml(entry.task.path)}">${escHtml(entry.task.name)}</td>
            <td style="padding:7px 10px;font-size:11.5px;color:var(--text3);font-family:'Cascadia Code',Consolas,monospace" title="${escHtml(entry.task.program_path || '')}">${escHtml((entry.task.program_path || '').slice(0, 50))}${(entry.task.program_path || '').length > 50 ? '…' : ''}</td>
            <td style="padding:7px 10px;color:${statusColor};font-size:12px;white-space:nowrap">${statusBadge}</td>
            <td style="padding:7px 10px;font-family:'Cascadia Code',Consolas,monospace;font-size:11px;color:var(--text2)">${hashCell}</td>
        </tr>`;

    const sections = [];

    // Summary header
    sections.push(`
      <div style="display:flex;gap:12px;padding:10px 14px;background:var(--bg2);border-radius:6px;margin-bottom:12px;font-size:13px;flex-wrap:wrap">
        <span><strong style="color:var(--green)">${buckets.ok.length}</strong> unchanged</span>
        <span><strong style="color:var(--red)">${buckets.changed.length}</strong> changed</span>
        <span><strong style="color:var(--yellow)">${buckets.missing.length}</strong> missing</span>
        <span><strong style="color:var(--text2)">${buckets.untrusted.length}</strong> not yet trusted</span>
        <span style="color:var(--text3);margin-left:auto">${totalScanned} task${totalScanned === 1 ? '' : 's'} scanned</span>
      </div>`);

    if (buckets.changed.length > 0) {
        sections.push(`
          <div style="margin-bottom:8px;font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--red);font-weight:700">⚠ Changed since last trust (${buckets.changed.length})</div>
          <div style="background:rgba(239,68,68,.04);border:1px solid rgba(239,68,68,.22);border-radius:6px;overflow:hidden;margin-bottom:14px">
            <table style="width:100%;border-collapse:collapse;font-size:12.5px">
              ${buckets.changed.map(e => renderRow(e,
                  '⚠ CHANGED', 'var(--red)',
                  `<div style="color:var(--text3)">was ${escHtml(e.baseline.hash.slice(0, 12))}…</div><div style="color:var(--red)">now ${escHtml(e.hash.slice(0, 12))}…</div>`
              )).join('')}
            </table>
            <div style="padding:10px 14px;border-top:1px solid rgba(239,68,68,.22);display:flex;justify-content:flex-end;gap:8px">
              <button class="btn" onclick="reTrustChangedIntegrity()" title="Mark all changed binaries as trusted at their current hash">✅ Re-trust all changed</button>
            </div>
          </div>`);
    }

    if (buckets.missing.length > 0) {
        sections.push(`
          <div style="margin-bottom:8px;font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--yellow);font-weight:700">📁 Missing executables (${buckets.missing.length})</div>
          <div style="background:rgba(245,158,11,.04);border:1px solid rgba(245,158,11,.22);border-radius:6px;overflow:hidden;margin-bottom:14px">
            <table style="width:100%;border-collapse:collapse;font-size:12.5px">
              ${buckets.missing.map(e => renderRow(e, '✗ NOT FOUND', 'var(--yellow)', '<span style="color:var(--text3);font-style:italic">(file missing)</span>')).join('')}
            </table>
          </div>`);
    }

    if (buckets.untrusted.length > 0) {
        sections.push(`
          <div style="margin-bottom:8px;font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--text2);font-weight:700">📝 Not yet trusted (${buckets.untrusted.length})</div>
          <div style="background:var(--bg2);border:1px solid var(--border);border-radius:6px;overflow:hidden;margin-bottom:14px">
            <table style="width:100%;border-collapse:collapse;font-size:12.5px">
              ${buckets.untrusted.map(e => renderRow(e, 'no baseline', 'var(--text3)', escHtml(e.hash.slice(0, 16)) + '…')).join('')}
            </table>
            <div style="padding:10px 14px;border-top:1px solid var(--border);display:flex;justify-content:flex-end;gap:8px">
              <button class="btn btn-primary" onclick="trustAllUntrustedIntegrity()" title="Record current hashes as the trust baseline">📝 Trust all current versions</button>
            </div>
          </div>`);
        // Stash untrusted entries for the bulk button
        window._wtpIntegrityUntrusted = buckets.untrusted;
    }

    if (buckets.ok.length > 0) {
        sections.push(`
          <details style="margin-bottom:8px">
            <summary style="cursor:pointer;font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--green);font-weight:700;padding:6px 0">✅ Unchanged (${buckets.ok.length})</summary>
            <div style="background:var(--bg2);border:1px solid var(--border);border-radius:6px;overflow:hidden;margin-top:6px">
              <table style="width:100%;border-collapse:collapse;font-size:12.5px">
                ${buckets.ok.slice(0, 50).map(e => renderRow(e, '✅ OK', 'var(--green)', escHtml(e.hash.slice(0, 16)) + '…')).join('')}
              </table>
              ${buckets.ok.length > 50 ? `<div style="padding:8px 14px;font-size:11px;color:var(--text3)">… and ${buckets.ok.length - 50} more</div>` : ''}
            </div>
          </details>`);
    }

    // Stash changed entries for the bulk re-trust button
    window._wtpIntegrityChanged = buckets.changed;

    resultsEl.style.padding = '14px';
    resultsEl.style.textAlign = 'left';
    resultsEl.innerHTML = sections.join('');
    dinfo('integrity', 'scan complete', {
        ok: buckets.ok.length, changed: buckets.changed.length,
        missing: buckets.missing.length, untrusted: buckets.untrusted.length,
    });
}

function trustAllUntrustedIntegrity() {
    const items = window._wtpIntegrityUntrusted || [];
    if (items.length === 0) return;
    const baselines = loadIntegrityBaselines();
    for (const { task, hash } of items) {
        baselines[task.path] = {
            program_path: task.program_path,
            hash: hash,
            trusted_at: new Date().toISOString(),
        };
    }
    if (saveIntegrityBaselines(baselines)) {
        showToast(`Trusted ${items.length} executable${items.length === 1 ? '' : 's'}`, 'success');
        appendAuditLog('integrity_trust_all', items.length + ' tasks', '');
        delete window._wtpIntegrityUntrusted;
        // Re-run the scan to update the UI
        openIntegrityCheck();
    }
}

function reTrustChangedIntegrity() {
    const items = window._wtpIntegrityChanged || [];
    if (items.length === 0) return;
    confirmAction(
        `Re-trust ${items.length} changed executable${items.length === 1 ? '' : 's'}?`,
        'This records the CURRENT hash as the new baseline. Only do this if you intentionally updated these binaries — otherwise you may be silencing a real malware tripwire.',
        'Re-trust',
        () => {
            const baselines = loadIntegrityBaselines();
            for (const { task, hash } of items) {
                baselines[task.path] = {
                    program_path: task.program_path,
                    hash: hash,
                    trusted_at: new Date().toISOString(),
                };
            }
            if (saveIntegrityBaselines(baselines)) {
                showToast(`Re-trusted ${items.length} executable${items.length === 1 ? '' : 's'}`, 'success');
                appendAuditLog('integrity_retrust', items.length + ' tasks', '');
                delete window._wtpIntegrityChanged;
                openIntegrityCheck();
            }
        }
    );
}


// Lets the user replace strings across many tasks at once. Common case:
// scripts moved from C:\Old\Path\ to D:\New\Path\, dozens of tasks
// reference the old path. Without this feature: edit each task one by one.
//
// Implementation strategy:
//   1. Show a preview modal that lets the user enter find/replace strings
//      and pick which fields to scan (program path / args / working dir).
//   2. Scan in-memory `allTasks` and show every match with the BEFORE/AFTER
//      so the user can spot mistakes BEFORE committing.
//   3. On confirm: for each task with matches, export its XML, do the
//      string-replace on the XML, and call import_task_xml. The import
//      uses TASK_CREATE_OR_UPDATE so it's an in-place update — no risk
//      of orphan duplicates like there is for move_task.
//
// Why client-side string-replace on the exported XML? Because:
//   - We KNOW the find string only appears in field positions (program
//     path, args, working dir) — Task Scheduler XML uses these in
//     <Command>, <Arguments>, <WorkingDirectory> elements specifically.
//   - String-level replace correctly handles every possible escape
//     scenario; trying to walk the XML tree would mean reimplementing
//     Microsoft's quoting rules.
//   - The XML round-trips exactly because Microsoft's exporter is
//     deterministic.
//
// Safety: confirmation modal is mandatory. Backups aren't taken — the
// user has the full power of "edit every task at once" and is expected
// to use it carefully. The audit log records every change.
function openBulkFindReplace() {
    openModal('🔁 Bulk Find &amp; Replace',
        `<div style="display:flex;flex-direction:column;gap:14px">
           <div style="font-size:13px;color:var(--text2);line-height:1.5">
             Replace text across many tasks at once — useful after moving scripts
             between folders/drives or renaming network shares. Scans the program path,
             arguments, and working directory of every task.
           </div>
           <div class="form-group">
             <label>Find</label>
             <input type="text" id="frp-find" class="form-control" placeholder="e.g. C:\\Old\\Scripts\\" autocomplete="off" />
             <div class="form-error" id="err-frp-find" style="display:none">Find text is required</div>
           </div>
           <div class="form-group">
             <label>Replace with</label>
             <input type="text" id="frp-replace" class="form-control" placeholder="e.g. D:\\NewLocation\\Scripts\\" autocomplete="off" />
           </div>
           <div class="form-group">
             <label>Case sensitivity</label>
             <div style="display:flex;gap:14px;font-size:13px">
               <label style="display:flex;align-items:center;gap:5px;cursor:pointer">
                 <input type="radio" name="frp-case" value="sensitive" checked /> Case-sensitive (recommended)
               </label>
               <label style="display:flex;align-items:center;gap:5px;cursor:pointer">
                 <input type="radio" name="frp-case" value="insensitive" /> Case-insensitive
               </label>
             </div>
           </div>
           <button class="btn btn-primary" onclick="previewBulkFindReplace()" style="align-self:flex-start">🔍 Preview matches</button>
           <div id="frp-preview" style="min-height:60px"></div>
         </div>`,
        `<button class="btn" onclick="closeModal()">Close</button>`
    );
    setTimeout(() => {
        const findEl = document.getElementById('frp-find');
        if (findEl) findEl.focus();
    }, 100);
}

// Compute matches across all tasks. Returns an array of
//   { task, matches: [{field, before, after}] }
// so the preview UI can show every individual change before commit.
function computeFindReplaceMatches(find, replace, caseSensitive) {
    const tasks = allTasks || [];
    const matches = [];

    // Build a regex for case-insensitive search; otherwise simple
    // string indexOf is faster.
    const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = caseSensitive ? null : new RegExp(escapeRegex(find), 'gi');

    const replaceFn = (text) => {
        if (!text) return text;
        if (caseSensitive) {
            return text.split(find).join(replace);
        } else {
            return text.replace(re, replace);
        }
    };
    const containsFn = (text) => {
        if (!text) return false;
        if (caseSensitive) return text.indexOf(find) !== -1;
        return new RegExp(escapeRegex(find), 'i').test(text);
    };

    for (const t of tasks) {
        const taskMatches = [];
        const FIELDS = [
            ['program_path', 'Program', t.program_path],
            ['program_args', 'Arguments', t.program_args],
            ['working_dir',  'Working Dir', t.working_dir],
        ];
        for (const [key, label, val] of FIELDS) {
            if (val && containsFn(val)) {
                taskMatches.push({
                    field: key,
                    label: label,
                    before: val,
                    after: replaceFn(val),
                });
            }
        }
        if (taskMatches.length > 0) matches.push({ task: t, matches: taskMatches });
    }
    return matches;
}

function previewBulkFindReplace() {
    const find    = document.getElementById('frp-find')?.value || '';
    const replace = document.getElementById('frp-replace')?.value || '';
    const caseEl  = document.querySelector('input[name="frp-case"]:checked');
    const caseSensitive = !caseEl || caseEl.value === 'sensitive';

    const errEl = document.getElementById('err-frp-find');
    if (!find) {
        if (errEl) errEl.style.display = '';
        return;
    }
    if (errEl) errEl.style.display = 'none';

    if (find === replace) {
        document.getElementById('frp-preview').innerHTML = `
            <div style="color:var(--text3);padding:14px;font-style:italic">Find and Replace are identical — nothing to change.</div>`;
        return;
    }

    const results = computeFindReplaceMatches(find, replace, caseSensitive);
    const totalMatches = results.reduce((sum, r) => sum + r.matches.length, 0);

    const previewEl = document.getElementById('frp-preview');
    if (results.length === 0) {
        previewEl.innerHTML = `
            <div style="background:var(--bg0);border:1px solid var(--border);border-radius:6px;padding:18px;text-align:center;color:var(--text3)">
                No tasks contain <code>${escHtml(find)}</code> in their program path, arguments, or working directory.
            </div>`;
        return;
    }

    // Stash the prepared changes on a global so the commit handler can
    // grab them without re-computing (and without leaking to console).
    window._wtpFindReplacePending = { find, replace, caseSensitive, results };

    previewEl.innerHTML = `
        <div style="font-size:12.5px;color:var(--text2);margin-bottom:10px">
          Found <strong>${totalMatches} match${totalMatches === 1 ? '' : 'es'}</strong> across <strong>${results.length} task${results.length === 1 ? '' : 's'}</strong>. Review the changes below — nothing is committed yet.
        </div>
        <div style="background:var(--bg0);border:1px solid var(--border);border-radius:6px;max-height:340px;overflow-y:auto">
          ${results.map(({ task, matches }) => `
            <div style="padding:10px 12px;border-bottom:1px solid rgba(31,38,64,.45)">
              <div style="font-weight:600;color:var(--text);font-size:13px;margin-bottom:6px">${escHtml(task.name)}</div>
              <div style="font-size:11px;color:var(--text3);font-family:'Cascadia Code',Consolas,monospace;margin-bottom:8px">${escHtml(task.path)}</div>
              ${matches.map(m => `
                <div style="margin:6px 0;font-family:'Cascadia Code',Consolas,monospace;font-size:11.5px;line-height:1.5">
                  <div style="font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:var(--text3);font-weight:700;margin-bottom:2px">${escHtml(m.label)}</div>
                  <div style="color:var(--red);text-decoration:line-through;opacity:.85" title="${escHtml(m.before)}">- ${escHtml(m.before.length > 100 ? m.before.slice(0, 100) + '…' : m.before)}</div>
                  <div style="color:var(--green)" title="${escHtml(m.after)}">+ ${escHtml(m.after.length > 100 ? m.after.slice(0, 100) + '…' : m.after)}</div>
                </div>`).join('')}
            </div>`).join('')}
        </div>
        <div style="display:flex;justify-content:flex-end;margin-top:14px">
          <button class="btn btn-primary" onclick="commitBulkFindReplace()">✅ Apply changes (${totalMatches})</button>
        </div>`;
}

async function commitBulkFindReplace() {
    const pending = window._wtpFindReplacePending;
    if (!pending || !pending.results || pending.results.length === 0) {
        showToast('Nothing pending to apply', 'info');
        return;
    }
    const { find, replace, caseSensitive, results } = pending;

    // Inner string-replace function — same semantics as the preview path
    const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = caseSensitive ? null : new RegExp(escapeRegex(find), 'g');
    const replaceXml = (xml) => caseSensitive ? xml.split(find).join(replace) : xml.replace(re, replace);

    let ok = 0, fail = 0;
    const failures = [];

    // Disable the apply button during the long-running operation
    const previewEl = document.getElementById('frp-preview');
    if (previewEl) {
        previewEl.innerHTML = `
            <div style="text-align:center;padding:24px;color:var(--text3)">
                <div style="font-size:14px;margin-bottom:6px">⏳ Applying changes…</div>
                <div style="font-size:12px" id="frp-progress">0 / ${results.length}</div>
            </div>`;
    }

    for (let i = 0; i < results.length; i++) {
        const { task } = results[i];
        const progressEl = document.getElementById('frp-progress');
        if (progressEl) progressEl.textContent = `${i} / ${results.length}`;
        try {
            const xml = await invoke('export_task_xml', { path: task.path });
            const newXml = replaceXml(xml);
            if (newXml === xml) {
                // Find string was in our matched fields but not in the
                // serialized XML — possibly an XML-encoding mismatch
                // (e.g. & → &amp;). Skip but flag it.
                derror('commitBulkFindReplace', 'no XML change after replace', { path: task.path });
                fail++;
                failures.push({ name: task.name, error: 'XML round-trip skipped change (encoding mismatch?)' });
                continue;
            }
            await invoke('import_task_xml', {
                folder: task.folder || '\\',
                name:   task.name,
                xml:    newXml,
            });
            appendAuditLog('bulk_find_replace', task.name, `${find} → ${replace}`);
            ok++;
        } catch (err) {
            derror('commitBulkFindReplace', 'failed', { path: task.path, err: String(err) });
            fail++;
            failures.push({ name: task.name, error: String(err) });
        }
    }

    delete window._wtpFindReplacePending;

    if (previewEl) {
        previewEl.innerHTML = `
            <div style="background:var(--bg0);border:1px solid var(--border);border-radius:6px;padding:14px">
                <div style="font-size:14px;font-weight:600;margin-bottom:8px">
                    ${fail === 0
                        ? `<span style="color:var(--green)">✅ All ${ok} task${ok === 1 ? '' : 's'} updated successfully</span>`
                        : `<span style="color:var(--yellow)">⚠ ${ok} succeeded, ${fail} failed</span>`}
                </div>
                ${failures.length > 0 ? `
                  <div style="font-size:12px;color:var(--text2);margin-top:10px">
                    <div style="font-weight:600;margin-bottom:4px">Failures:</div>
                    <ul style="margin:0 0 0 18px;padding:0;font-family:'Cascadia Code',Consolas,monospace;font-size:11.5px">
                      ${failures.map(f => `<li><strong>${escHtml(f.name)}</strong>: ${escHtml(f.error)}</li>`).join('')}
                    </ul>
                  </div>` : ''}
                <div style="margin-top:14px;display:flex;justify-content:flex-end">
                  <button class="btn btn-primary" onclick="closeModal(); refreshAll(true);">Close &amp; refresh</button>
                </div>
            </div>`;
    }

    dinfo('commitBulkFindReplace', 'completed', { ok, fail, find, replace });
    showToast(`Bulk replace: ${ok} ok, ${fail} failed`, fail === 0 ? 'success' : 'warning');
}

// ── User-defined templates (Phase 3 feature) ────────────────────────────────
// Built-in TEMPLATES is a static array shipped with the binary. User
// templates live in localStorage so they survive across launches but stay
// per-machine — there's no cloud sync (out of scope) and templates are
// fundamentally personal preferences.
//
// Storage key: 'wtp_user_templates'. Schema: same as TEMPLATES entries
// (name, description, icon, prefill, plus an `id` for deletion and a
// `created` ISO timestamp for sorting/display).
//
// Why localStorage over the file system: portability. Users move the
// portable .exe between machines and we don't want to lose their
// templates with the move. The intentional consequence is templates are
// browser-storage scoped to this WebView2 install — which in practice is
// per-Windows-user-account, exactly what users expect.
const USER_TEMPLATES_KEY = 'wtp_user_templates';

function loadUserTemplates() {
    try {
        const raw = localStorage.getItem(USER_TEMPLATES_KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch (err) {
        derror('loadUserTemplates', 'parse failed', { err: String(err) });
        return [];
    }
}

function saveUserTemplates(templates) {
    try {
        localStorage.setItem(USER_TEMPLATES_KEY, JSON.stringify(templates));
        return true;
    } catch (err) {
        derror('saveUserTemplates', 'write failed', { err: String(err) });
        showToast('Could not save template (storage full?)', 'error');
        return false;
    }
}

// Open the "Save as Template" modal pre-filled from a TaskInfo. The user
// can edit the name/description/icon before saving — the inferred values
// from the task are starting points.
function openSaveAsTemplateDialog(task) {
    if (!task) return;
    const defaultIcon = '⭐';
    openModal('Save as Template',
        `<div style="display:flex;flex-direction:column;gap:14px">
           <div style="font-size:13px;color:var(--text2);line-height:1.5">
             Save this task's configuration as a reusable template. Future tasks created from
             this template will pre-fill the trigger and action settings.
           </div>
           <div class="form-group">
             <label>Template Name *</label>
             <input type="text" id="tpl-name" class="form-control" maxlength="80" value="${escHtml(task.name)}" />
           </div>
           <div class="form-group">
             <label>Description</label>
             <input type="text" id="tpl-desc" class="form-control" maxlength="200" value="${escHtml(task.description || 'Custom template based on ' + task.name)}" />
           </div>
           <div class="form-group">
             <label>Icon (emoji)</label>
             <input type="text" id="tpl-icon" class="form-control" maxlength="4" style="max-width:80px;text-align:center;font-size:18px" value="${defaultIcon}" />
             <div style="font-size:11px;color:var(--text3);margin-top:4px">Click to change. Suggestions: ⭐ 🔧 ⚙️ 📊 🚀 💼 📁 ⏰</div>
           </div>
           <div style="background:rgba(245,158,11,.06);border:1px solid rgba(245,158,11,.22);border-radius:6px;padding:10px 12px;font-size:12px;color:var(--text2);line-height:1.5">
             <strong style="color:var(--yellow)">Note:</strong> Templates store the program path, arguments, working directory, and trigger settings. They do <em>not</em> store credentials or run-as principals — those must be re-set when creating a task from the template.
           </div>
         </div>`,
        `<button class="btn" onclick="closeModal()">Cancel</button>
         <button class="btn btn-primary" id="tpl-save-btn">Save Template</button>`
    );

    document.getElementById('tpl-save-btn').onclick = () => {
        const name  = document.getElementById('tpl-name')?.value.trim();
        const desc  = document.getElementById('tpl-desc')?.value.trim();
        const icon  = document.getElementById('tpl-icon')?.value.trim() || defaultIcon;
        if (!name) {
            showToast('Template name is required', 'error');
            return;
        }
        // Build a prefill from the task. The shape matches what
        // openCreateDialog accepts (it tolerates missing fields).
        const triggerLower = (task.trigger_type || 'Once').toLowerCase();
        const prefill = {
            name:          name.replace(/\s+/g, '_'),
            description:   desc,
            trigger_type:  triggerLower,
            // Carry over trigger-specific fields. The dialog code reads
            // whichever ones apply to the chosen trigger type.
            trigger_value: task.trigger_start ? task.trigger_start.slice(11, 16) : '',
            trigger_datetime: task.trigger_start || '',
            days_interval: task.trigger_interval || 1,
            days_of_week:  task.trigger_days_of_week || 0,
            // Action fields — best-effort: programs go in a generic "program" slot
            action_type:   'program',
            program:       task.program_path || '',
            arguments:     task.program_args  || '',
            working_dir:   task.working_dir   || '',
            run_level:     task.run_level || 0,
            hidden:        !!task.hidden,
        };
        const tpl = {
            id:          'u_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
            name:        name,
            description: desc || ('Custom template based on ' + task.name),
            icon:        icon,
            prefill:     prefill,
            created:     new Date().toISOString(),
            isUser:      true,
        };
        const templates = loadUserTemplates();
        templates.push(tpl);
        if (saveUserTemplates(templates)) {
            showToast(`Template "${name}" saved`, 'success');
            appendAuditLog('save_template', name, task.path);
            closeModal();
            // If we're on the templates page, refresh it so the new template appears
            if (currentPage === 'templates') renderTemplates();
        }
    };
}

function deleteUserTemplate(id) {
    const templates = loadUserTemplates();
    const tpl = templates.find(t => t.id === id);
    if (!tpl) return;

    confirmAction(
        'Delete template?',
        `Remove "${tpl.name}" from your saved templates? This cannot be undone, but the original task is unaffected.`,
        'Delete',
        () => {
            const filtered = templates.filter(t => t.id !== id);
            if (saveUserTemplates(filtered)) {
                showToast(`Template "${tpl.name}" deleted`, 'success');
                appendAuditLog('delete_template', tpl.name, '');
                renderTemplates();
            }
        }
    );
}

function renderTemplates() {
  const content = document.getElementById('templates-content');
  if (!content) return;

  // Phase 3: merge built-in + user templates. User ones get an "isUser"
  // flag for rendering (delete button, visual distinction).
  const builtIn = TEMPLATES.map((t, i) => ({ ...t, _idx: i, isUser: false }));
  const userTemplates = loadUserTemplates();

  content.innerHTML = `
    <h2 class="section-heading">📚 Script Library</h2>
    <p class="section-sub">Pre-built task templates — click <em>Use Template</em> to create a task with these settings pre-filled. Save your own templates from any task's detail panel via "💾 Save as Template".</p>
    ${userTemplates.length > 0 ? `
      <div style="font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--text3);font-weight:700;margin:18px 0 8px">⭐ Your Templates (${userTemplates.length})</div>
      <div class="template-grid">
        ${userTemplates.map(tpl => `
          <div class="template-card" style="border-color:rgba(${getComputedStyle(document.documentElement).getPropertyValue('--accent-rgb') || '99,102,241'},.32)">
            <div class="template-icon">${escHtml(tpl.icon || '⭐')}</div>
            <div class="template-name">${escHtml(tpl.name)}</div>
            <div class="template-desc">${escHtml(tpl.description)}</div>
            <div style="display:flex;gap:6px;margin-top:auto">
              <button class="btn btn-primary" style="flex:1" onclick="useUserTemplate(${escHtml(JSON.stringify(tpl.id))})">Use</button>
              <button class="btn btn-danger" onclick="deleteUserTemplate(${escHtml(JSON.stringify(tpl.id))})">🗑</button>
            </div>
          </div>`).join('')}
      </div>
      <div style="font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--text3);font-weight:700;margin:24px 0 8px">📦 Built-in Templates</div>
    ` : ''}
    <div class="template-grid">
      ${builtIn.map((tpl) => `
        <div class="template-card">
          <div class="template-icon">${tpl.icon}</div>
          <div class="template-name">${escHtml(tpl.name)}</div>
          <div class="template-desc">${escHtml(tpl.description)}</div>
          <button class="btn btn-primary" onclick="useTemplate(${tpl._idx})">Use Template</button>
        </div>`).join('')}
    </div>`;
}

async function useUserTemplate(id) {
  const templates = loadUserTemplates();
  const tpl = templates.find(t => t.id === id);
  if (!tpl) return;
  await openCreateDialog(tpl.prefill);
  const titleEl = document.getElementById('modal-title');
  if (titleEl) titleEl.textContent = (tpl.icon || '⭐') + ' ' + tpl.name;
}

async function useTemplate(idx) {
  const tpl = TEMPLATES[idx];
  if (!tpl) return;
  await openCreateDialog(tpl.prefill);
  const titleEl = document.getElementById('modal-title');
  if (titleEl) titleEl.textContent = '📚 ' + tpl.name;
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
                   onchange="settings.showSystemTasks = this.checked; localStorage.setItem('wtp_showSystemTasks', this.checked); refreshAll()" />
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
        <div class="settings-section-title">🛠 Developer Logs</div>
        <div class="settings-row">
          <div>
            <div class="settings-label">Log Level</div>
            <div class="settings-sub">Higher verbosity = more detail in the log file. Set to DEBUG or TRACE when reproducing a bug.</div>
          </div>
          <select id="s-log-level" class="form-control" style="width:130px"
                  onchange="onLogLevelChange(this.value)">
            <option value="ERROR">ERROR</option>
            <option value="WARN">WARN</option>
            <option value="INFO" selected>INFO</option>
            <option value="DEBUG">DEBUG</option>
            <option value="TRACE">TRACE</option>
          </select>
        </div>
        <div class="settings-row">
          <div>
            <div class="settings-label">Open Logs Folder</div>
            <div class="settings-sub">Reveal <code style="font-size:10px">%LOCALAPPDATA%\\WinTaskPro\\logs\\</code> in Explorer</div>
          </div>
          <button class="btn" onclick="openLogsFolder()">📁 Open</button>
        </div>
        <div class="settings-row">
          <div>
            <div class="settings-label">Show Recent Log Entries</div>
            <div class="settings-sub">Display the last 200 lines of the log file in a viewer modal</div>
          </div>
          <button class="btn" onclick="showLogTail()">📜 View Logs</button>
        </div>
        <div class="settings-row">
          <div>
            <div class="settings-label">Copy Diagnostic Snapshot</div>
            <div class="settings-sub">Copy a one-line summary of the runtime environment (OS, RAM, WebView2, admin) plus the last 50 log entries — useful for bug reports.</div>
          </div>
          <button class="btn" onclick="copyDiagnosticSnapshot()">🩺 Copy Diagnostics</button>
        </div>
        <div class="settings-row">
          <div>
            <div class="settings-label">Log Self-Test</div>
            <div class="settings-sub">Writes a unique marker line to the log, then reads it back to verify logging is working end-to-end. Use this if you suspect logs aren't being written.</div>
          </div>
          <button class="btn" onclick="runLogSelfTest()">🧪 Test Logging</button>
        </div>
        <div class="settings-row">
          <div>
            <div class="settings-label">View Last Update Helper Trace</div>
            <div class="settings-sub">Shows the heartbeat trace from the most recent auto-update attempt. Helpful when an update click didn't visibly take effect.</div>
          </div>
          <button class="btn" onclick="showUpdateHelperTrace()">📄 View Trace</button>
        </div>
        <div class="settings-row">
          <div>
            <div class="settings-label">Log File Path</div>
            <div class="settings-sub" id="s-log-path" style="font-family:monospace;font-size:10px">Resolving…</div>
          </div>
        </div>
      </div>

      <div class="settings-section">
        <div class="settings-section-title">Export & Backup</div>
        <div class="settings-row">
          <div>
            <div class="settings-label">Backup &amp; Restore All Tasks</div>
            <div class="settings-sub">Download every user task as a single backup file, or restore tasks from a previous backup. Survives reinstalls and moves between machines.</div>
          </div>
          <button class="btn btn-primary" onclick="fpOpenBackupRestore()">💾 Backup / Restore</button>
        </div>
        <div class="settings-row">
          <div>
            <div class="settings-label">Export Task List (CSV)</div>
            <div class="settings-sub">Download all tasks as a spreadsheet-compatible CSV file</div>
          </div>
          <button class="btn" onclick="exportTasksCsv()">📊 Export CSV</button>
        </div>
        <div class="settings-row">
          <div>
            <div class="settings-label">Export Task List (JSON)</div>
            <div class="settings-sub">Download all tasks as a machine-readable JSON file</div>
          </div>
          <button class="btn" onclick="exportTasksJson()">📄 Export JSON</button>
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
            <div class="settings-sub">Version ${document.getElementById('app-version')?.textContent || 'v1.16.0'} &mdash; Windows Task Scheduler Manager</div>
          </div>
        </div>
        <div class="settings-row">
          <div>
            <div class="settings-label">Built with</div>
            <div class="settings-sub">Tauri v2 · Rust · sysinfo · Vanilla JS</div>
          </div>
        </div>
        <div class="settings-row">
          <div>
            <div class="settings-label">Updates</div>
            <div class="settings-sub">WinTaskPro checks GitHub for new releases on each launch and shows a banner when one is available. Click Download in the banner to open the release page in your browser. See <code style="font-size:10px">UPDATER.md</code> for in-place update setup.</div>
          </div>
        </div>
      </div>
    </div>`;

  // Hydrate Developer Logs panel asynchronously (level dropdown + path).
  // Done after innerHTML is set so DOM elements exist for querySelector.
  _initLogPanel();
}

// ── Developer Logs (Settings panel handlers) ────────────────────────────────
//
// All four handlers degrade gracefully when the IPC isn't available (e.g.
// running the served HTML outside Tauri for quick UI iteration).

async function _initLogPanel() {
  // Populate current level + log file path on render.
  // Called after the Settings page renders; the HTML default is INFO so a
  // brief flash of INFO before the real value loads is acceptable.
  try {
    const lvl  = await invoke('get_log_level');
    const sel  = document.getElementById('s-log-level');
    if (sel && lvl) sel.value = lvl;
  } catch (e) { dwarn('settings', 'get_log_level failed', { err: String(e) }); }
  try {
    const path = await invoke('get_log_file_path');
    const el   = document.getElementById('s-log-path');
    if (el) el.textContent = path || '(unavailable)';
  } catch (e) {
    const el = document.getElementById('s-log-path');
    if (el) el.textContent = '(unavailable: ' + String(e) + ')';
  }
}

async function onLogLevelChange(level) {
  try {
    await invoke('set_log_level', { level });
    showToast('Log level set to ' + level, 'success');
    dinfo('settings', 'log level changed', { level });
  } catch (err) {
    showToast('Failed to change log level: ' + err, 'error');
    derror('settings', 'set_log_level failed', { err: String(err) });
  }
}

async function openLogsFolder() {
  try {
    const path = await invoke('open_logs_folder');
    dinfo('settings', 'opened logs folder', { path });
  } catch (err) {
    showToast('Could not open logs folder: ' + err, 'error');
    derror('settings', 'open_logs_folder failed', { err: String(err) });
  }
}

async function showLogTail() {
  let lines = [];
  try {
    lines = await invoke('get_log_tail', { lines: 200 });
  } catch (err) {
    showToast('Failed to read log: ' + err, 'error');
    return;
  }
  if (!lines || lines.length === 0) {
    showToast('Log file is empty', 'info');
    return;
  }
  // Render as a monospace pre — entries come back newest-first from the backend.
  const body = `
    <div style="margin-bottom:8px;display:flex;justify-content:space-between;align-items:center">
      <div style="font-size:12px;color:var(--text2)">Showing ${lines.length} most-recent entries (newest first)</div>
      <div style="display:flex;gap:6px">
        <button class="btn" onclick="copyLogToClipboard()">📋 Copy</button>
        <button class="btn" onclick="openLogsFolder()">📁 Open Folder</button>
      </div>
    </div>
    <pre id="log-viewer-pre" style="background:var(--bg0);color:var(--text);padding:12px;border-radius:6px;
         max-height:60vh;overflow:auto;font-family:ui-monospace,'Cascadia Code','Consolas',monospace;
         font-size:11px;line-height:1.4;white-space:pre;border:1px solid var(--border)">${
      lines.map(l => escHtml(l)).join('\n')
    }</pre>`;
  openModal('🛠 Recent Log Entries', body,
    `<button class="btn" onclick="closeModal()">Close</button>`);
}

async function copyLogToClipboard() {
  const pre = document.getElementById('log-viewer-pre');
  if (!pre) return;
  try {
    await navigator.clipboard.writeText(pre.textContent);
    showToast('Log copied to clipboard', 'success');
  } catch (err) {
    showToast('Copy failed: ' + err, 'error');
  }
}

// ── Copy diagnostic snapshot ──────────────────────────────────────────────
// Bundles the runtime environment summary (OS / RAM / admin / WebView2) plus
// the last 50 log entries into a single block of text on the clipboard.
// The snapshot mirrors what the boot_snapshot log line writes on every launch,
// so a user reporting a bug can paste this and the maintainer immediately
// sees the same env data the app saw at startup.
async function copyDiagnosticSnapshot() {
  let snap = null;
  let lines = [];
  try {
    snap = await invoke('get_diagnostic_snapshot');
  } catch (err) {
    showToast('Could not read diagnostics: ' + err, 'error');
    derror('settings', 'get_diagnostic_snapshot failed', { err: String(err) });
    return;
  }
  try {
    lines = await invoke('get_log_tail', { lines: 50 });
  } catch (err) {
    // Non-fatal — still copy the env block even if log tail fails
    dwarn('settings', 'get_log_tail failed during diagnostic copy', { err: String(err) });
    lines = ['(log tail unavailable: ' + String(err) + ')'];
  }
  const now = new Date().toISOString();
  const envBlock = [
    `WinTaskPro diagnostic snapshot — generated ${now}`,
    `─────────────────────────────────────────────────────────`,
    `App version    : ${snap.app_version}`,
    `Build profile  : ${snap.build_profile}`,
    `OS             : ${snap.os}`,
    `OS version     : ${snap.os_version}`,
    `Kernel version : ${snap.kernel_version}`,
    `Host name      : ${snap.host_name}`,
    `CPU arch       : ${snap.cpu_arch}`,
    `CPU count      : ${snap.cpu_count}`,
    `Total RAM (MB) : ${snap.total_memory_mb}`,
    `Running admin  : ${snap.is_admin ? 'YES' : 'no'}`,
    `WebView2       : ${snap.webview2 || '(not detected)'}`,
    `Log file       : ${snap.log_file || '(unavailable)'}`,
    `Log level      : ${snap.log_level}`,
    `User agent     : ${navigator.userAgent}`,
    `Viewport       : ${window.innerWidth}x${window.innerHeight}`,
    ``,
    `Last ${lines.length} log entries (newest first):`,
    `─────────────────────────────────────────────────────────`,
    ...lines,
  ].join('\n');

  try {
    await navigator.clipboard.writeText(envBlock);
    showToast('Diagnostic snapshot copied (' + envBlock.length + ' chars)', 'success');
    dinfo('settings', 'diagnostic snapshot copied', {
      envChars: envBlock.length, logLines: lines.length,
    });
  } catch (err) {
    showToast('Clipboard copy failed: ' + err, 'error');
    derror('settings', 'clipboard write failed', { err: String(err) });
  }
}

function onAutoRefreshChange() {
  settings.autoRefresh = document.getElementById('s-auto-refresh').checked;
  localStorage.setItem('wtp_autoRefresh', settings.autoRefresh);
  const row = document.getElementById('s-interval-row');
  if (row) row.style.display = settings.autoRefresh ? '' : 'none';

  // Always clear any existing timer (null check inside is fine — clearInterval(null) is a no-op)
  if (autoRefreshTimer) { clearInterval(autoRefreshTimer); autoRefreshTimer = null; }
  if (settings.autoRefresh) {
    autoRefreshTimer = setInterval(() => { if (!_appHidden) refreshAll(true); }, settings.refreshInterval * 1000);
    startRefreshCountdown(settings.refreshInterval);
  } else {
    stopRefreshCountdown();
  }

  updateLiveIndicator(settings.autoRefresh);
}

function updateLiveIndicator(visible) {
  const ind = document.getElementById('live-refresh-indicator');
  if (ind) ind.style.display = visible ? '' : 'none';
}

function onRefreshIntervalChange() {
  // Clamp to 5-300 range per the settings-sub hint. A 1-second interval would
  // hammer Task Scheduler COM and make the app unusable on machines with
  // many tasks (each get_all_tasks takes ~3s for 262 tasks).
  const raw = parseInt(document.getElementById('s-refresh-interval').value, 10);
  const clamped = Math.max(5, Math.min(300, isNaN(raw) ? 30 : raw));
  if (clamped !== raw) {
    const el = document.getElementById('s-refresh-interval');
    if (el) el.value = clamped;
    showToast(`Refresh interval clamped to ${clamped}s (5–300 allowed)`, 'info');
  }
  settings.refreshInterval = clamped;
  localStorage.setItem('wtp_refreshInterval', settings.refreshInterval);
  if (settings.autoRefresh) {
    if (autoRefreshTimer) clearInterval(autoRefreshTimer);
    autoRefreshTimer = setInterval(() => { if (!_appHidden) refreshAll(true); }, settings.refreshInterval * 1000);
    startRefreshCountdown(settings.refreshInterval);
  }
}

// ── App initialisation ────────────────────────────────────────────────────────
// ── Persistent task cache (1.16.0) — render last session's task list instantly ──
// localStorage['wtp_taskCache'] = { ts, tasks: TaskInfo[] }. Lets every launch
// after the first paint the full list with ZERO COM calls; the live data refreshes
// in the background.
function loadTaskCache() {
  try {
    const raw = localStorage.getItem('wtp_taskCache');
    if (!raw) return null;
    const obj = JSON.parse(raw);
    return (obj && Array.isArray(obj.tasks)) ? obj.tasks : null;
  } catch (e) { dwarn('taskCache', 'load failed; ignoring', { err: String(e) }); return null; }
}
function saveTaskCache(tasks) {
  try {
    if (!Array.isArray(tasks) || !tasks.length) return;
    localStorage.setItem('wtp_taskCache', JSON.stringify({ ts: Date.now(), tasks }));
  } catch (e) {
    // QuotaExceeded is the realistic failure (recycle-bin XML + cache). Graceful:
    // next launch just falls back to the async walk instead of the instant cache.
    dwarn('taskCache', 'save failed (storage full?) — cache skipped', { err: String(e) });
  }
}
// Apply a freshly-loaded task list to the live state + visible view, and (when
// final) persist it for the next launch.
async function _applyFreshTasks(tasks, isFinal) {
  _bootAllTasks = tasks;
  if (isFinal) saveTaskCache(tasks);
  // Only replace the live allTasks when viewing the full "All Tasks" set. If a
  // folder is selected, allTasks holds THAT folder's subset and is owned by
  // loadTasksForFolder — overwriting it here showed the full list under the
  // selected folder. (review fix 2026-06-19)
  if (selectedFolder === null) allTasks = tasks;
  // Await refreshFolders BEFORE loadDashboard. refreshFolders reuses _bootAllTasks
  // for its counts and does not clear it; awaiting avoids the interleave where
  // loadDashboard nulls _bootAllTasks mid-await, forcing refreshFolders to re-walk
  // COM redundantly (and a folder-badge vs dashboard count flicker). (review fix)
  await refreshFolders();
  if (currentPage === 'dashboard') loadDashboard();
  else if (currentPage === 'tasks' && selectedFolder === null) filterTasks();
}
// Background task refresh on boot (async → never blocks the UI). With a cache
// already shown, do a single silent full refresh; without one, show the user's
// own tasks first (fast) then the full set.
async function refreshTasksOnBoot(hadCache) {
  try {
    if (settings.showSystemTasks) {
      if (!hadCache) {
        const user = await invoke('get_all_tasks', { skipSystem: true });
        await _applyFreshTasks(user, false);
      }
      const full = await invoke('get_all_tasks', { skipSystem: false });
      await _applyFreshTasks(full, true);
    } else {
      const user = await invoke('get_all_tasks', { skipSystem: true });
      await _applyFreshTasks(user, true);
    }
  } catch (err) {
    derror('init', 'background task refresh failed', { err: String(err) });
  }
}

async function init() {
  // Very first log line — confirms the JS log chain is working and gives every
  // session a clear boundary marker in the log file.
  dinfo('init', 'app booting', {
    tauri:       !!window.__TAURI__,
    userAgent:   navigator.userAgent.slice(0, 200),
    viewport:    window.innerWidth + 'x' + window.innerHeight,
  });

  // Apply stored settings before first render
  if (localStorage.getItem('wtp_autoRefresh') === 'true') {
    settings.autoRefresh = true;
    settings.refreshInterval = parseInt(localStorage.getItem('wtp_refreshInterval') || '30', 10) || 30;
    autoRefreshTimer = setInterval(() => { if (!_appHidden) refreshAll(true); }, settings.refreshInterval * 1000);
    updateLiveIndicator(true);
    startRefreshCountdown(settings.refreshInterval);
  }
  if (localStorage.getItem('wtp_showSystemTasks') === 'false') {
    settings.showSystemTasks = false;
  }

  // Apply saved accent color
  const savedAccent = localStorage.getItem('wtp_accent');
  if (savedAccent) applyAccentColor(savedAccent);

  // Populate the version pill from Tauri.
  // Tauri v2 exposes version via the plugin:app|version invoke OR __TAURI__.app.getVersion.
  // Try both to be forward-compatible.
  try {
    let ver = await window.__TAURI__?.app?.getVersion?.()
           || await window.__TAURI__?.core?.invoke?.('plugin:app|version')
           || null;
    if (ver) {
      const el = document.getElementById('app-version');
      if (el) el.textContent = 'v' + ver;
    }
  } catch (err) {
    // Non-fatal — pill keeps hardcoded v1.16.0. Log for diagnosability.
    dwarn('init', 'version pill read failed', { err: String(err) });
  }

  // Load audit log from localStorage
  try {
    const stored = localStorage.getItem('wtp_auditLog');
    if (stored) _auditLog = JSON.parse(stored);
  } catch (err) {
    _auditLog = [];
    dwarn('init', 'wtp_auditLog parse failed; resetting', { err: String(err) });
    try { localStorage.removeItem('wtp_auditLog'); } catch (_) {}
  }

  // Load column preferences from localStorage
  try {
    const stored = localStorage.getItem('wtp_colPrefs');
    if (stored) Object.assign(_colPrefs, JSON.parse(stored));
  } catch (err) {
    // Corrupted preferences — log for diagnosis, then reset so the app
    // doesn't re-read the bad value every launch.
    dwarn('init', 'wtp_colPrefs parse failed; resetting', { err: String(err) });
    try { localStorage.removeItem('wtp_colPrefs'); } catch (_) {}
  }

  // Load tags
  loadTags();

  // Load notes
  loadNotes();

  // Apply saved theme
  const savedTheme = localStorage.getItem('wtp_theme');
  if (savedTheme === 'light') { _isLightTheme = true; applyTheme(true); }

  // Note: previously we called Notification.requestPermission() here on boot
  // when wtp_notifyOnFailure was enabled. Removed in 1.14.3 — we now use
  // FlashWindowEx via the flash_taskbar IPC instead of the browser
  // Notification API, which doesn't require permission and isn't blocked by
  // WV2's default policy.

  // Nav click handlers
  document.querySelectorAll('.nav-item[data-page]').forEach(el => {
    el.addEventListener('click', () => showPage(el.dataset.page));
  });

  // Stat pill click handlers — each pill filters to its status
  document.querySelectorAll('.stat-pill[data-filter]').forEach(pill => {
    pill.addEventListener('click', () => {
      const filter = pill.dataset.filter;
      const sel = document.getElementById('status-filter');
      if (sel) { sel.value = filter; filterTasks(); }
      showPage('tasks');
    });
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

  // Visibility gate (perf 2026-06-11): pause the per-page auto-refresh timers
  // while the window is hidden/minimised so their synchronous COM calls don't
  // freeze a window nobody is looking at; refresh once when the user returns.
  document.addEventListener('visibilitychange', () => {
    _appHidden = document.hidden;
    if (!_appHidden) {
      // Back in view — refresh whatever page is showing, immediately.
      if (currentPage === 'dashboard') loadDashboard();
      else if (currentPage === 'live') renderLiveMonitor();
      else if (currentPage === 'processes') refreshProcessData();
      else if (settings.autoRefresh) refreshAll(true);
    }
  });

  // CACHE-FIRST boot (1.16.0) — the bulletproof launch. The COM walk of every
  // task takes seconds even on a background thread, so we NEVER make the user wait
  // for it on launch: we render the PREVIOUS session's task list from localStorage
  // INSTANTLY (zero COM, zero wait), then refresh in the background (async — runs
  // off the UI thread, see main.rs) and re-cache. Every launch after the very
  // first is effectively instant.
  const _dashEl = document.getElementById('dash-content');
  let _cachedTasks = loadTaskCache();
  // If the user has system tasks hidden, drop them from the cached set so the
  // boot folder/dashboard counts don't momentarily include hidden tasks (the
  // Tasks list itself is already filtered by filterTasks). (review fix 2026-06-19)
  if (_cachedTasks && !settings.showSystemTasks) {
    _cachedTasks = _cachedTasks.filter(t => {
      const p = (t.path || '').toLowerCase();
      return !(p.startsWith('\\microsoft\\') || p.startsWith('\\windows\\'));
    });
  }
  const _hadCache = !!(_cachedTasks && _cachedTasks.length);
  if (_hadCache) {
    _bootAllTasks = _cachedTasks;
    allTasks = _cachedTasks;
    dinfo('init', 'rendered task list from cache', { count: _cachedTasks.length });
  } else if (_dashEl) {
    // First-ever launch — nothing cached. Show a loading state while the async
    // walk runs (the UI stays responsive; the list populates when it finishes).
    _dashEl.innerHTML = '<div class="loading-msg"><span class="spinner"></span> Loading your scheduled tasks…</div>';
    await new Promise(r => setTimeout(r, 50)); // yield so the spinner paints
  }

  await refreshFolders();   // uses _bootAllTasks (cache) for counts when present
  showPage('dashboard');    // uses _bootAllTasks (cache) when present

  // Background refresh — async get_all_tasks runs OFF the UI thread, so this never
  // blocks. It quietly updates the live data + the cache.
  refreshTasksOnBoot(_hadCache);


  // Check for an update_failed.txt marker from a previous failed auto-update.
  // If present, surface it immediately so the user can see WHY their last
  // update click didn't take effect — instead of having to dig in the
  // filesystem at %LOCALAPPDATA%\WinTaskPro\update_failed.txt manually.
  // The banner appears regardless of whether a NEW update is available.
  try {
    const marker = await invoke('read_update_failed_marker');
    if (marker && marker.contents) {
      dwarn('init::update_marker', 'previous update failed', {
        modified: marker.modified,
        bytes:    marker.contents.length,
        path:     marker.path,
      });
      showUpdateFailureBanner(marker);
    }
  } catch (err) {
    // Non-fatal — diagnostic feature only
    dwarn('init::update_marker', 'read_update_failed_marker failed', { err: String(err) });
  }

  // Check elevation — show result in status bar, compact dismissible banner if not admin
  try {
    const elevated = await invoke('is_admin');
    const devMode  = await invoke('is_dev');
    const sbEl = document.getElementById('sb-elevation');
    if (elevated) {
      if (sbEl) sbEl.textContent = '🔒 Administrator';
    } else {
      if (sbEl) {
        sbEl.textContent = '⚠ Not Admin';
        sbEl.style.color = 'var(--red)';
        sbEl.title = 'Click to restart as Administrator';
        sbEl.classList.add('clickable');
        sbEl.onclick = async () => {
          try { await invoke('restart_as_admin'); }
          catch (err) { showToast('Restart failed: ' + err, 'error'); }
        };
      }
      const banner = document.createElement('div');
      banner.id = 'elevation-banner';
      // Dev mode: add a note about the devserver restart — the button still works
      // (restart_as_admin in debug builds kills + relaunches the devserver elevated)
      const devNote = devMode
        ? ' <span style="opacity:.7;font-size:10px">(Devserver will also restart elevated)</span>'
        : '';
      banner.innerHTML = `
        <span>⚠ <strong>Not running as Administrator</strong> — Task Scheduler operations will fail.${devNote}</span>
        <div style="display:flex;gap:6px;align-items:center;flex-shrink:0">
          <button class="btn btn-danger btn-sm" id="elevation-restart-btn">↑ Restart as Admin</button>
          <button class="icon-btn" id="elevation-dismiss-btn" style="color:var(--red)">✕</button>
        </div>`;
      // BUG FIX (video audit 2026-04-20): was `position:fixed; top:0` which
      // clipped BEHIND the Windows title bar AND behind the v2.1.0 version pill
      // on the left and minimize/close buttons on the right — the ⚠ text got
      // cut mid-line and the Restart button was partially obscured.
      // Solution: inject INLINE into the document flow at the top of <body>,
      // above the layout container, so the entire app shifts down to make room.
      // No `position:fixed` → no clip, no z-index fight with window chrome.
      banner.style.cssText = [
        'background:rgba(247,118,142,.12)',
        'border-bottom:1px solid rgba(247,118,142,.35)',
        'color:var(--red)',
        'padding:7px 14px',
        'display:flex','align-items:center','justify-content:space-between','gap:10px',
        'font-size:11px','flex-shrink:0','line-height:1.4',
      ].join(';');
      // Insert as the FIRST child of <body> so the layout shifts down under it
      document.body.insertBefore(banner, document.body.firstChild);
      const restartBtn = document.getElementById('elevation-restart-btn');
      if (restartBtn) restartBtn.onclick = async () => {
        restartBtn.disabled = true;
        restartBtn.textContent = '⏳ Restarting…';
        try { await invoke('restart_as_admin'); }
        catch (err) {
          restartBtn.disabled = false;
          restartBtn.textContent = '↑ Restart as Admin';
          showToast('Restart failed: ' + err, 'error');
        }
      };
      banner.querySelector('#elevation-dismiss-btn')?.addEventListener('click', () => banner.remove());
    }
  } catch (err) {
    // Non-fatal — elevation UI is a best-effort hint. Log via dwarn so a
    // missing banner can be diagnosed.
    dwarn('init::elevation', 'elevation check failed', { err: String(err) });
  }

  // Check GitHub releases for a newer version — no signing keys required.
  // Fires in the background; never blocks or errors visibly.
  setTimeout(checkForUpdate, 3000); // slight delay so app finishes loading first
}

document.addEventListener('DOMContentLoaded', init);

// ── Auto-update banner ────────────────────────────────────────────────────────
// ── Semver comparison helper ─────────────────────────────────────────────────
function semverGt(a, b) {
  const pa = String(a).replace(/^v/, '').split('.').map(Number);
  const pb = String(b).replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return true;
    if ((pa[i] || 0) < (pb[i] || 0)) return false;
  }
  return false;
}

// ── Update-asset selection ────────────────────────────────────────────────────
// The matcher logic for picking which asset on a GitHub release to download.
// Encoded as ordered preferences rather than a strict equality check so the
// auto-update flow doesn't break if the release naming drifts.
//
// Priority order (highest first):
//   1. exactly 'WinTaskPro.exe'                 — what the workflow produces
//   2. 'WinTaskPro_v{X.Y.Z}_portable.exe'       — local build_portable.ps1 name
//   3. 'WinTaskPro_*portable*.exe'              — loose portable match
//   4. any 'WinTaskPro*.exe' that's not an installer/setup/msi/debug
//
// Returns the browser_download_url of the best match, or null.
function pickUpdateAsset(assets) {
  if (!assets || assets.length === 0) return null;
  // Filter to viable .exe assets first
  const candidates = assets.filter(a => {
    const reason = assetSkipReason(a.name);
    return !reason;
  });
  if (candidates.length === 0) return null;

  // Tier 1: exact canonical name
  const tier1 = candidates.find(a => a.name === 'WinTaskPro.exe');
  if (tier1) return tier1.browser_download_url;

  // Tier 2: versioned portable (matches build_portable.ps1 output)
  const tier2 = candidates.find(a => /^WinTaskPro_v[\d.]+_portable\.exe$/i.test(a.name));
  if (tier2) return tier2.browser_download_url;

  // Tier 3: anything starting with WinTaskPro and containing 'portable'
  const tier3 = candidates.find(a =>
    /^WinTaskPro/i.test(a.name) && /portable/i.test(a.name)
  );
  if (tier3) return tier3.browser_download_url;

  // Tier 4: any WinTaskPro*.exe that survived the skip filter
  const tier4 = candidates.find(a => /^WinTaskPro.*\.exe$/i.test(a.name));
  if (tier4) return tier4.browser_download_url;

  return null;
}

// Returns a string reason if the asset should NOT be considered for
// auto-update, or null if it's a viable candidate. The Rust IPC will do its
// own PE-header verification on whatever we hand it, so this is a "polite
// pre-filter" — better to refuse obvious mismatches up front than to download
// the MSI installer and have the Rust side reject it.
function assetSkipReason(name) {
  if (!name) return 'no name';
  const lower = name.toLowerCase();
  if (!lower.endsWith('.exe'))           return 'not an .exe';
  if (lower.includes('setup'))           return 'installer (setup)';
  if (lower.includes('install'))         return 'installer (install)';
  if (lower.includes('debug'))           return 'debug build';
  if (lower.includes('symbols'))         return 'symbols';
  if (lower.includes('.pdb'))            return 'PDB';
  return null;
}

// ── Update check — fetches latest GitHub release, no keys required ────────────
// See UPDATER.md for the full design + upgrade path to plugin-updater.
// Logs every outcome at INFO so the log file always answers "did the update
// check run, and what did it find?" — a common bug-report question.
async function checkForUpdate() {
  const startedAt = performance.now();
  try {
    const res = await fetch(
      'https://api.github.com/repos/NookieAI/WinTaskPro/releases/latest',
      { headers: { Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(8000) }
    );
    const ms = Math.round(performance.now() - startedAt);
    if (!res.ok) {
      dwarn('checkForUpdate', 'GitHub API non-OK', { status: res.status, ms });
      return;
    }
    const data = await res.json();
    const latestTag = data.tag_name || '';
    if (!latestTag) {
      dwarn('checkForUpdate', 'GitHub response missing tag_name', { ms });
      return;
    }

    const currentRaw = document.getElementById('app-version')?.textContent?.replace(/^v/, '') || '0.0.0';
    const newer = semverGt(latestTag, currentRaw);

    if (newer) {
      // Pick the best portable .exe asset using an ordered preference list.
      // Background: the auto-update flow needs to download a single .exe asset
      // and replace the running one. The CI workflow uploads it as exactly
      // 'WinTaskPro.exe' but historically other naming has been used (e.g.
      // 'WinTaskPro_v1.9.0_portable.exe' from the local build_portable.ps1).
      // Releases hand-uploaded by the maintainer may use any of these names.
      // Be tolerant — accept any reasonable portable .exe and reject the
      // installers/MSI/debug variants we know aren't safe to swap.
      const assetUrl = pickUpdateAsset(data.assets || []);

      // Log every asset considered + the verdict so future "no Update Now
      // button" debugging takes one log line, not a GitHub round-trip.
      const allAssets = (data.assets || []).map(a => ({
        name: a.name,
        size: a.size,
        skipped: assetUrl !== a.browser_download_url
          ? assetSkipReason(a.name) || 'lower priority'
          : null,
      }));
      dinfo('checkForUpdate', 'new release found', {
        current: currentRaw, latest: latestTag, ms,
        hasAsset: !!assetUrl,
        chosen:   assetUrl ? assetUrl.split('/').pop() : null,
        assets:   allAssets,
      });
      showUpdateBanner(
        latestTag.replace(/^v/, ''),
        data.body || '',
        data.html_url || '',
        assetUrl,
      );
    } else {
      dinfo('checkForUpdate', 'up to date', {
        current: currentRaw, latest: latestTag, ms,
      });
    }
  } catch (err) {
    // Not fatal — the app works fine offline — but log so the user can see
    // why the update banner didn't appear. Common causes: no internet,
    // GitHub rate-limit, CSP blocking (release build), fetch timeout.
    dwarn('checkForUpdate', 'fetch failed', {
      err: String(err),
      ms: Math.round(performance.now() - startedAt),
    });
  }
}

// ── Update-failure banner ─────────────────────────────────────────────────────
// Shown when %LOCALAPPDATA%\WinTaskPro\update_failed.txt exists from a
// previous failed in-place update. The banner shows up immediately on boot
// and stays at the bottom-right (same slot as the regular update banner).
// Click "View details" to see the marker contents in a modal — that's the
// primary diagnostic for "I clicked Update Now and nothing happened".
function showUpdateFailureBanner(marker) {
  const existing = document.getElementById('update-failure-banner');
  if (existing) existing.remove();

  const banner = document.createElement('div');
  banner.id = 'update-failure-banner';
  // Same positioning class as the regular update banner so the styles cascade
  banner.style.cssText = [
    'position:fixed','bottom:32px','right:16px',
    'background:rgba(247,118,142,.10)',
    'border:1px solid rgba(247,118,142,.36)',
    'color:var(--text)',
    'padding:10px 14px','border-radius:10px',
    'display:flex','align-items:center','gap:10px',
    'font-size:13px','z-index:900',
    'box-shadow:0 8px 28px rgba(0,0,0,.5)',
    'max-width:520px',
  ].join(';');

  const when = marker.modified || 'previously';
  banner.innerHTML = `
    <div style="display:flex;flex-direction:column;gap:3px;min-width:0">
      <span><span style="color:var(--red)">⚠</span> Last update attempt <strong>failed</strong> ${escHtml(when)}</span>
      <span style="font-size:11px;color:var(--text3)">Click View details to see why — this is usually fixable</span>
    </div>
    <div style="display:flex;gap:6px;align-items:center;flex-shrink:0">
      <button class="btn btn-sm btn-warning" id="update-fail-view-btn">📋 View details</button>
      <button class="icon-btn" id="update-fail-dismiss-btn" title="Dismiss (won't clear marker)">✕</button>
    </div>`;
  document.body.appendChild(banner);

  banner.querySelector('#update-fail-view-btn')?.addEventListener('click', () => {
    showUpdateFailureModal(marker);
  });
  banner.querySelector('#update-fail-dismiss-btn')?.addEventListener('click', () => {
    banner.remove();
  });
}

function showUpdateFailureModal(marker) {
  // Convert the marker contents into a properly-escaped <pre> block. The
  // 1.9.0 marker has [stamp] [section] format; older 1.8.0 markers were just
  // single lines. Either way, we display verbatim — no parsing — so the user
  // sees exactly what the helper recorded.
  const escContents = escHtml(marker.contents).replace(/\n/g, '<br>');

  openModal('Previous update failed',
    `<div style="display:flex;flex-direction:column;gap:14px">
       <div>
         <div style="font-size:12px;color:var(--text3);margin-bottom:5px">Marker file</div>
         <div style="font-family:'Cascadia Code',Consolas,monospace;font-size:12px;color:var(--text2);word-break:break-all;background:var(--bg0);border:1px solid var(--border);border-radius:6px;padding:8px 10px">${escHtml(marker.path)}</div>
       </div>
       <div>
         <div style="font-size:12px;color:var(--text3);margin-bottom:5px">Recorded ${escHtml(marker.modified || '')}</div>
         <div style="font-family:'Cascadia Code',Consolas,monospace;font-size:12.5px;color:var(--text2);background:var(--bg0);border:1px solid var(--border);border-radius:6px;padding:12px 14px;max-height:300px;overflow-y:auto;line-height:1.55;white-space:pre-wrap;word-break:break-all">${escContents}</div>
       </div>
       <div style="font-size:12.5px;color:var(--text2);background:rgba(245,158,11,.06);border:1px solid rgba(245,158,11,.22);border-radius:6px;padding:10px 12px;line-height:1.5">
         <strong style="color:var(--yellow)">Common causes:</strong><br>
         <span style="color:var(--text2)"><strong>[rename] / [swap] failed</strong> — Antivirus held the .exe file lock longer than 5 seconds. 1.9.0 extends this to 30 seconds and adds rollback. Update to 1.9.0 manually once and future updates use the fixed helper.</span><br>
         <span style="color:var(--text2)"><strong>Empty marker, no relaunch</strong> — PowerShell ExecutionPolicy is set to Restricted/AllSigned by Group Policy. 1.9.0 spawns the helper with <code>-ExecutionPolicy Bypass</code> which sidesteps this without changing your machine policy.</span><br>
         <span style="color:var(--text2)"><strong>Disk space</strong> — %TEMP% needs ~30 MB free. 1.9.0 pre-checks this.</span>
       </div>
     </div>`,
    `<button class="btn" onclick="copyMarkerToClipboard()">📋 Copy</button>
     <button class="btn btn-warning" onclick="clearUpdateFailureMarker()">🗑 Clear marker</button>
     <button class="btn btn-primary" onclick="closeModal()">Close</button>`
  );
}

async function copyMarkerToClipboard() {
  try {
    const marker = await invoke('read_update_failed_marker');
    if (!marker) {
      showToast('Marker file no longer exists', 'info');
      return;
    }
    const text = `WinTaskPro update_failed.txt\nPath: ${marker.path}\nModified: ${marker.modified}\n\n${marker.contents}`;
    await navigator.clipboard.writeText(text);
    showToast('Copied marker to clipboard', 'success');
    dinfo('copyMarkerToClipboard', 'copied', { bytes: text.length });
  } catch (err) {
    derror('copyMarkerToClipboard', 'failed', { err: String(err) });
    showToast('Copy failed: ' + String(err), 'error');
  }
}

async function clearUpdateFailureMarker() {
  try {
    const cleared = await invoke('clear_update_failed_marker');
    if (cleared) {
      showToast('Marker file cleared', 'success');
      const banner = document.getElementById('update-failure-banner');
      if (banner) banner.remove();
      closeModal();
      dinfo('clearUpdateFailureMarker', 'cleared');
    } else {
      showToast('No marker file to clear', 'info');
    }
  } catch (err) {
    derror('clearUpdateFailureMarker', 'failed', { err: String(err) });
    showToast('Clear failed: ' + String(err), 'error');
  }
}

// ── Log self-test ────────────────────────────────────────────────────────────
// Settings → Developer Logs → 🧪 Test Logging button. Writes a marker line
// then reads back the tail; modal shows a clear pass/fail and the resolved
// path. This is the answer to "are logs even being written?" — one click
// instead of "go check this folder manually."
async function runLogSelfTest() {
  try {
    const result = await invoke('log_self_test');
    const ok = result.write_ok && result.read_ok && result.found_marker;
    const verdict = ok
      ? '<span style="color:var(--green)">✅ Logging is working</span>'
      : '<span style="color:var(--red)">❌ Logging is broken</span>';
    const lines = (result.recent || '').split('\n').slice(-15).join('\n');
    openModal('Log Self-Test',
      `<div style="display:flex;flex-direction:column;gap:14px">
         <div style="font-size:16px;font-weight:600">${verdict}</div>
         <div style="display:grid;grid-template-columns:auto 1fr;gap:8px 14px;font-size:13px">
           <div style="color:var(--text3)">Log path:</div>
           <div style="font-family:'Cascadia Code',Consolas,monospace;font-size:12px;word-break:break-all">${escHtml(result.log_path || '(unresolved)')}</div>
           <div style="color:var(--text3)">Write marker:</div>
           <div>${result.write_ok ? '✅ ok' : '❌ failed'}</div>
           <div style="color:var(--text3)">Read tail:</div>
           <div>${result.read_ok ? '✅ ok' : '❌ failed (file empty or unreadable)'}</div>
           <div style="color:var(--text3)">Marker found:</div>
           <div>${result.found_marker ? '✅ ok (round-trip works)' : '❌ marker not in tail'}</div>
         </div>
         <div>
           <div style="font-size:12px;color:var(--text3);margin-bottom:5px">Recent log lines (tail 15):</div>
           <pre style="background:var(--bg0);border:1px solid var(--border);border-radius:6px;padding:10px;font-family:'Cascadia Code',Consolas,monospace;font-size:11.5px;color:var(--text2);max-height:280px;overflow:auto;line-height:1.5;white-space:pre-wrap">${escHtml(lines || '(no log lines available)')}</pre>
         </div>
       </div>`,
      `<button class="btn btn-primary" onclick="closeModal()">Close</button>`
    );
    dinfo('runLogSelfTest', 'completed', {
      write_ok: result.write_ok,
      read_ok: result.read_ok,
      found_marker: result.found_marker,
    });
  } catch (err) {
    derror('runLogSelfTest', 'IPC failed', { err: String(err) });
    openModal('Log Self-Test',
      `<div style="display:flex;flex-direction:column;gap:14px">
         <div style="font-size:16px;font-weight:600;color:var(--red)">❌ Log self-test IPC threw an error</div>
         <div style="font-family:'Cascadia Code',Consolas,monospace;font-size:12px;color:var(--text2);background:var(--bg0);border:1px solid var(--border);border-radius:6px;padding:10px">${escHtml(String(err))}</div>
         <div style="font-size:13px;color:var(--text2);line-height:1.5">If you see this dialog, the IPC mechanism itself is fine — the failure is inside the test logic. This points at devlog state initialization failing — most likely a write-permission issue at <code>%LOCALAPPDATA%\\WinTaskPro\\logs\\</code>.</div>
       </div>`,
      `<button class="btn btn-primary" onclick="closeModal()">Close</button>`
    );
  }
}

// ── Update helper trace viewer ───────────────────────────────────────────────
// Reads %LOCALAPPDATA%\WinTaskPro\update_helper.log — the heartbeat trace
// the cmd.exe swap helper writes on every run (overwritten each time, so
// it's always the LATEST attempt). If the file doesn't exist, the helper
// either never ran or got killed before its first echo.
async function showUpdateHelperTrace() {
  try {
    const trace = await invoke('read_update_helper_log');
    if (trace === null) {
      openModal('Update Helper Trace',
        `<div style="display:flex;flex-direction:column;gap:14px">
           <div style="font-size:14px;color:var(--text2)">No update helper trace file found.</div>
           <div style="font-size:13px;color:var(--text2);line-height:1.5">This means either:
             <ul style="margin:8px 0 0 18px;padding:0">
               <li>You haven't attempted an auto-update yet (nothing to log)</li>
               <li>The cmd.exe helper failed to spawn at all (rare; would also fail to write any other file)</li>
               <li>An antivirus product killed the helper before its first echo</li>
             </ul>
           </div>
           <div style="font-size:12px;color:var(--text3)">Expected location:<br><code>%LOCALAPPDATA%\\WinTaskPro\\update_helper.log</code></div>
         </div>`,
        `<button class="btn btn-primary" onclick="closeModal()">Close</button>`
      );
      return;
    }
    openModal('Update Helper Trace',
      `<div style="display:flex;flex-direction:column;gap:14px">
         <div style="font-size:13px;color:var(--text2)">Heartbeat trace from the most recent auto-update attempt. Each line shows what step the cmd.exe helper reached.</div>
         <pre style="background:var(--bg0);border:1px solid var(--border);border-radius:6px;padding:12px;font-family:'Cascadia Code',Consolas,monospace;font-size:12px;color:var(--text2);max-height:400px;overflow:auto;line-height:1.55;white-space:pre-wrap">${escHtml(trace)}</pre>
       </div>`,
      `<button class="btn" onclick="copyHelperTraceToClipboard()">📋 Copy</button>
       <button class="btn btn-primary" onclick="closeModal()">Close</button>`
    );
  } catch (err) {
    derror('showUpdateHelperTrace', 'IPC failed', { err: String(err) });
    showToast('Could not read helper trace: ' + String(err), 'error');
  }
}

async function copyHelperTraceToClipboard() {
  try {
    const trace = await invoke('read_update_helper_log');
    if (!trace) {
      showToast('No trace to copy', 'info');
      return;
    }
    await navigator.clipboard.writeText(trace);
    showToast('Trace copied to clipboard', 'success');
  } catch (err) {
    showToast('Copy failed: ' + String(err), 'error');
  }
}


function showUpdateBanner(version, notes, releaseUrl, assetUrl) {
  const existing = document.getElementById('update-banner');
  if (existing) existing.remove();
  const banner = document.createElement('div');
  banner.id = 'update-banner';
  // Banner UX:
  //   • "🔄 Update Now"   → in-place auto-update via download_and_install_update IPC
  //   • "↗ View on GitHub" → fallback if user prefers to download manually
  //   • "✕"                → dismiss
  // The Update Now button is hidden if there is no WinTaskPro.exe asset on
  // the release (e.g. a maintainer published a release without the portable).
  const hasAsset = !!assetUrl;
  banner.innerHTML = `
    <div style="display:flex;flex-direction:column;gap:4px;min-width:0">
      <span>📦 WinTaskPro <strong>v${escHtml(version)}</strong> has been released</span>
      ${notes ? `<span style="font-size:11px;color:var(--text3);max-width:340px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escHtml(notes)}">${escHtml(notes.split('\n')[0])}</span>` : ''}
    </div>
    <div style="display:flex;gap:8px;align-items:center;flex-shrink:0">
      ${hasAsset ? `<button class="btn btn-primary btn-sm" id="update-install-btn" title="Download and install ${escHtml(version)} in place">🔄 Update Now</button>` : ''}
      <button class="btn btn-sm" id="update-view-btn" title="Open the release page in your browser">↗ View on GitHub</button>
      <button class="icon-btn" id="update-dismiss-btn" title="Dismiss">✕</button>
    </div>`;
  document.body.appendChild(banner);

  if (hasAsset) {
    banner.querySelector('#update-install-btn')?.addEventListener('click', () => {
      dinfo('checkForUpdate', 'install click', { version, assetUrl });
      installUpdate(version, assetUrl);
    });
  }

  banner.querySelector('#update-view-btn')?.addEventListener('click', async () => {
    const url = releaseUrl || `https://github.com/NookieAI/WinTaskPro/releases/latest`;
    dinfo('checkForUpdate', 'view-on-github click', { version, url });
    try {
      await invoke('open_in_browser', { url });
    } catch (err) {
      derror('checkForUpdate', 'open_in_browser failed', { url, err: String(err) });
      showToast('Could not open browser. URL: ' + url, 'error');
    }
  });

  banner.querySelector('#update-dismiss-btn')?.addEventListener('click', () => {
    dinfo('checkForUpdate', 'banner dismissed', { version });
    banner.remove();
  });
}

// ── In-place auto-update flow ─────────────────────────────────────────────────
// Calls the Rust download_and_install_update IPC, which:
//   1. Downloads WinTaskPro.exe from the GitHub release URL to %TEMP%
//   2. Verifies the PE header
//   3. Spawns a detached PowerShell helper that waits for our PID to exit,
//      replaces the current exe, and re-launches.
//   4. Calls process::exit(0) on the Rust side.
//
// This means a successful update never returns from the IPC — the Promise
// just gets dropped when the WebView dies along with the rest of the app.
// We show a non-dismissable progress modal while it runs and rely on the
// fact that "modal still showing after 2 minutes" means something went
// wrong (the swap helper should have re-launched the new exe by then).
async function installUpdate(version, assetUrl) {
  // Replace the banner with a progress modal so the user can't double-click
  // install while the download is in flight.
  const banner = document.getElementById('update-banner');
  if (banner) banner.remove();

  openModal('🔄 Installing update',
    `<div style="padding:24px 24px 8px;text-align:center">
       <div style="font-size:36px;line-height:1;margin-bottom:12px">⏳</div>
       <div style="font-size:15px;font-weight:600;margin-bottom:6px">Updating to v${escHtml(version)}</div>
       <div id="update-status" style="font-size:13px;color:var(--text2);margin-bottom:14px">Downloading WinTaskPro.exe…</div>
       <div style="font-size:11px;color:var(--text3);line-height:1.5">
         The app will close and re-open automatically when the update is installed.<br>
         Don't close this window manually — it will quit on its own.
       </div>
       <div style="font-size:10px;color:var(--text3);margin-top:14px;font-family:monospace;word-break:break-all">${escHtml(assetUrl)}</div>
     </div>`,
    ''  // no footer buttons — user must wait
  );

  const startedAt = performance.now();
  dinfo('installUpdate', 'starting', { version, assetUrl });

  // Watchdog: if the IPC takes longer than 90 s, something is wrong (a healthy
  // download from GitHub for ~10 MB is well under 30 s on any modern link).
  // We can't actually cancel the in-flight Rust download — but we can at least
  // tell the user.
  const watchdog = setTimeout(() => {
    const status = document.getElementById('update-status');
    if (status) {
      status.innerHTML = '⚠ Download is taking longer than expected — still trying…';
    }
    dwarn('installUpdate', 'watchdog elapsed (90s)', { version });
  }, 90_000);

  try {
    await invoke('download_and_install_update', {
      url: assetUrl,
      expectedVersion: version,
    });
    // If we get here, the IPC returned WITHOUT exiting the process.
    // That means an error path on the Rust side that we should surface but
    // shouldn't be reachable on a successful install — successful install
    // calls process::exit(0).
    clearTimeout(watchdog);
    const ms = Math.round(performance.now() - startedAt);
    dwarn('installUpdate', 'IPC returned without exiting (unexpected)', { ms });
    closeModal();
    showToast('Update finished but app did not relaunch — please restart manually', 'error');
  } catch (err) {
    clearTimeout(watchdog);
    const ms = Math.round(performance.now() - startedAt);
    const errStr = String(err);
    derror('installUpdate', 'failed', { err: errStr, ms });
    closeModal();

    // Build a more diagnostic error modal. The previous approach was a one-line
    // toast which the user could miss, and a banner re-showing "View on GitHub"
    // as if nothing had happened. We now open a proper error modal that
    // - shows the error verbatim
    // - explains the most likely causes for THAT specific error pattern
    // - provides a "Manual download" link that works
    // - offers a Retry button
    const lower = errStr.toLowerCase();
    let diagnosis = '';
    if (lower.includes('https://github.com') || lower.includes('url must')) {
      diagnosis = 'The IPC URL allowlist rejected the asset URL. This usually means the release was published to a fork. Use Manual download instead.';
    } else if (lower.includes('disk space') || lower.includes('temp')) {
      diagnosis = 'Free up at least 30 MB in your %TEMP% folder, then click Retry.';
    } else if (lower.includes('not a valid windows binary') || lower.includes('mz') || lower.includes('pe')) {
      diagnosis = 'The file downloaded but doesn\'t look like a Windows executable — likely a partial download or an HTML 404 page. Click Retry; if it persists, check that the WinTaskPro.exe asset on the release isn\'t corrupt.';
    } else if (lower.includes('download failed') || lower.includes('invoke-webrequest') || lower.includes('timeout')) {
      diagnosis = 'Network problem or GitHub rate-limit. Wait a moment and click Retry, or use Manual download.';
    } else if (lower.includes('powershell')) {
      diagnosis = 'PowerShell could not be invoked. This is unusual on Windows — check Windows Defender or AppLocker logs. Manual download is your best path.';
    } else {
      diagnosis = 'See the log file for full IPC trace. Common causes: AV scanning the download, disk space, or PowerShell ExecutionPolicy.';
    }

    // Stash retry context on window so the inline onclicks below stay simple
    // (avoids fighting nested template-literal escaping with embedded onclicks).
    window._wtpUpdateRetry = { version, assetUrl };

    openModal('Update failed',
      `<div style="display:flex;flex-direction:column;gap:12px">
         <div style="display:flex;align-items:center;gap:10px;padding:10px 14px;background:rgba(239,68,68,.10);border:1px solid rgba(239,68,68,.28);border-radius:8px">
           <span style="font-size:24px;line-height:1">⚠</span>
           <div style="flex:1;min-width:0">
             <div style="font-size:14px;font-weight:600;color:var(--text)">Couldn't install v${escHtml(version)}</div>
             <div style="font-size:12px;color:var(--text2);margin-top:2px;font-family:'Cascadia Code',Consolas,monospace;word-break:break-word">${escHtml(errStr)}</div>
           </div>
         </div>
         <div style="font-size:13px;color:var(--text2);line-height:1.5">${escHtml(diagnosis)}</div>
         <div style="font-size:12px;color:var(--text3);line-height:1.5">Asset URL:<br><span style="font-family:'Cascadia Code',Consolas,monospace;word-break:break-all">${escHtml(assetUrl)}</span></div>
       </div>`,
      `<button class="btn" onclick="manualDownloadFromError()">↗ Manual download</button>
       <button class="btn btn-warning" onclick="retryInstallUpdate()">🔄 Retry</button>
       <button class="btn btn-primary" onclick="closeModal()">Close</button>`
    );
    // Also rebuild the banner so View on GitHub is still reachable next time
    showUpdateBanner(version, '', `https://github.com/NookieAI/WinTaskPro/releases/latest`, assetUrl);
  }
}

// ── Helpers for the update-error modal buttons ───────────────────────────────
// These read window._wtpUpdateRetry which installUpdate's catch block stashes
// before opening the modal. Defined as top-level so inline onclick="..."
// resolves them globally (works under the CSP-with-unsafe-inline config).
async function manualDownloadFromError() {
  const ctx = window._wtpUpdateRetry;
  if (!ctx) { closeModal(); return; }
  try { await invoke('open_in_browser', { url: ctx.assetUrl }); }
  catch (err) {
    derror('manualDownloadFromError', 'open_in_browser failed', { err: String(err) });
    showToast('Could not open browser. URL: ' + ctx.assetUrl, 'error');
  }
  closeModal();
}

async function retryInstallUpdate() {
  const ctx = window._wtpUpdateRetry;
  if (!ctx) { closeModal(); return; }
  closeModal();
  // Slight delay so the close animation can play before the new modal opens
  setTimeout(() => installUpdate(ctx.version, ctx.assetUrl), 150);
}

// ── Health scoring ────────────────────────────────────────────────────────────
function healthScore(task) {
  const code = task.last_result_code;
  // Use numeric codes only — they're authoritative and don't depend on string formatting.
  // TASK_RESULT_NOT_RUN (267011) = never ran → warning (grey dot)
  // TASK_RESULT_RUNNING (267009) = currently executing → good (green dot, task is alive)
  // 0 = success → good
  // anything else = error → bad (red dot)
  if (code === TASK_RESULT_NOT_RUN || !task.enabled) return 'warning';
  if (code === 0 || code === TASK_RESULT_RUNNING)    return 'good';
  return 'bad';
}

// ── Invisibly-broken task detection (Phase 1 feature) ───────────────────────
// Identifies tasks that LOOK healthy in the dashboard ("Ready", enabled, no
// failure code) but actually CAN'T fire because their trigger spec is
// unfireable. The Windows MMC happily lets you save these and then the task
// just silently never runs. This detector surfaces them so the user can fix
// the trigger.
//
// Each finding includes a `reason` string suitable for inline display and an
// `advice` string suggesting what to check. The detector is pure JS over
// fields already present in TaskInfo — no extra IPC.
function findInvisiblyBrokenTasks(tasks) {
    const findings = [];
    for (const t of tasks) {
        // Skip tasks that are already obviously broken/disabled — the user
        // already knows about those via the failed-tasks count and the
        // disabled count.
        if (!t.enabled) continue;
        if (t.last_result_code !== 0
            && t.last_result_code !== TASK_RESULT_NOT_RUN
            && t.last_result_code !== TASK_RESULT_RUNNING) continue;

        const tt = t.trigger_type || '';

        // Pathology 1: Weekly with empty day-of-week mask
        if (tt === 'Weekly' && (t.trigger_days_of_week | 0) === 0) {
            findings.push({
                task: t,
                reason: 'Weekly trigger has no days selected',
                advice: 'Edit the task and pick at least one day of the week.',
            });
            continue;
        }
        // Pathology 2: Monthly with empty day-of-month mask
        if (tt === 'Monthly' && (t.trigger_days_of_month | 0) === 0) {
            findings.push({
                task: t,
                reason: 'Monthly trigger has no days of the month selected',
                advice: 'Edit the task and pick at least one day (1-31).',
            });
            continue;
        }
        // Pathology 3: Monthly with empty months mask
        if (tt === 'Monthly' && (t.trigger_months | 0) === 0) {
            findings.push({
                task: t,
                reason: 'Monthly trigger has no months selected',
                advice: 'Edit the task and pick at least one month.',
            });
            continue;
        }
        // Pathology 4: Marked enabled but next_run is empty/"Never" AND it's
        // a time-based trigger that SHOULD have a next run.
        // Time-based triggers: Once, Daily, Weekly, Monthly, Interval.
        // Event triggers (Boot/Logon/Idle/SessionLock/SessionUnlock) have
        // no deterministic next-run, so an empty next_run on those is
        // expected and not a finding.
        const isTimeBased = ['Once','Daily','Weekly','Monthly','Interval'].includes(tt);
        const nrEmpty = !t.next_run || t.next_run === 'Never' || t.next_run === 'N/A' || t.next_run === '';
        if (isTimeBased && nrEmpty) {
            findings.push({
                task: t,
                reason: `${tt} trigger has no upcoming run scheduled`,
                advice: 'Trigger may have an end-boundary in the past, or all conditions disqualify it. Check the trigger and Conditions tab.',
            });
            continue;
        }
        // Pathology 5: Once trigger whose start is in the past AND the
        // task hasn't run (e.g. machine was off when the time came).
        if (tt === 'Once' && t.last_result_code === TASK_RESULT_NOT_RUN
            && t.trigger_start && new Date(t.trigger_start) < new Date()) {
            findings.push({
                task: t,
                reason: 'One-time trigger fired in the past but never ran',
                advice: 'Computer was likely off at the scheduled time. Re-run manually or update the trigger.',
            });
            continue;
        }
    }
    return findings;
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
  // Compare button shows only when exactly 2 tasks are selected. Comparing
  // 3+ would either need pivot UI (which gets cramped) or a matrix view —
  // the 2-task case covers ~95% of "I have a working task and a broken
  // sibling, what's different?" use cases.
  const cmpBtn = document.getElementById('bulk-compare-btn');
  if (cmpBtn) cmpBtn.style.display = (n === 2) ? '' : 'none';
  const allCb   = document.getElementById('select-all-cb');
  const taskCbs = document.querySelectorAll('.task-cb');
  if (allCb && taskCbs.length > 0) {
    allCb.indeterminate = n > 0 && n < taskCbs.length;
    allCb.checked = n === taskCbs.length;
  }
  updateStatusBar();
}

function clearBulkSelection() {
  _selectedPaths.clear();
  document.querySelectorAll('.task-cb').forEach(cb => { cb.checked = false; });
  document.querySelectorAll('#task-tbody tr').forEach(r => r.classList.remove('row-selected'));
  const allCb = document.getElementById('select-all-cb');
  if (allCb) { allCb.checked = false; allCb.indeterminate = false; }
  updateBulkToolbar();
}

// ── Side-by-side task compare (Phase 1 feature) ─────────────────────────────
// Opens a modal that shows two tasks' fields side-by-side with differences
// highlighted. Use case: user has 5 nearly-identical tasks (PS4, PS4 Copy,
// PS5...) and wants to know which one differs from the others. Saves the
// alt-tab dance through detail panels.
//
// Comparison strategy: a hand-curated list of "interesting" fields rather
// than a recursive object diff. Reasoning:
//   - The TaskInfo struct has dozens of fields, most of them noise (folder
//     path, status timestamps, etc.) that always differ between two tasks.
//   - A curated list lets us group fields by category (Identity, Trigger,
//     Action, Conditions) which matches how users mentally organize tasks.
//   - We can render readable "Daily" vs "Weekly" instead of "trigger_type:
//     1 vs 2".
function compareSelectedTasks() {
    const paths = [..._selectedPaths];
    if (paths.length !== 2) {
        showToast('Select exactly 2 tasks to compare', 'info');
        return;
    }
    // Resolve the TaskInfo objects from the in-memory cache. allTasks is
    // populated by loadTasksForFolder / get_all_tasks; if a task isn't there
    // (rare race condition between selection and click) we bail.
    const t1 = allTasks.find(t => t.path === paths[0]);
    const t2 = allTasks.find(t => t.path === paths[1]);
    if (!t1 || !t2) {
        showToast('Task data not loaded — try refreshing first', 'error');
        return;
    }

    // Format helpers — convert raw field values to human-readable strings.
    // Some fields are bitmasks; we expand them to comma-separated names.
    const dowMaskToString = (m) => {
        if (!m) return '(none)';
        const days = [];
        const names = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
        for (let i = 0; i < 7; i++) if (m & (1 << i)) days.push(names[i]);
        return days.join(', ') || '(none)';
    };
    const moyMaskToString = (m) => {
        if (!m) return '(all months)';
        const months = [];
        const names = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
        for (let i = 0; i < 12; i++) if (m & (1 << i)) months.push(names[i]);
        return months.join(', ') || '(none)';
    };
    const domMaskToString = (m) => {
        if (!m) return '(none)';
        const days = [];
        for (let i = 0; i < 31; i++) if (m & (1 << i)) days.push(i + 1);
        return days.join(', ') || '(none)';
    };
    const fmt = (v) => {
        if (v === null || v === undefined || v === '') return '(empty)';
        if (typeof v === 'boolean') return v ? 'yes' : 'no';
        return String(v);
    };

    // Curated comparison schema: each row has a category, label, and a
    // function that extracts the display value from a task. Categories
    // group rows in the rendered table; differences are highlighted by
    // string equality of the formatted output (so "0" vs "" both show
    // as "(empty)" and don't false-positive as a diff).
    const rows = [
        // Identity
        ['Identity', 'Name',         t => fmt(t.name)],
        ['Identity', 'Folder',       t => fmt(t.folder || '\\')],
        ['Identity', 'Description',  t => fmt(t.description)],
        ['Identity', 'Author',       t => fmt(t.author)],
        ['Identity', 'Run as',       t => fmt(t.run_as_user)],
        ['Identity', 'Hidden',       t => fmt(t.hidden)],
        ['Identity', 'Enabled',      t => fmt(t.enabled)],

        // Trigger
        ['Trigger',  'Type',         t => fmt(t.trigger_type)],
        ['Trigger',  'Start',        t => fmt(t.trigger_start)],
        ['Trigger',  'Days interval',t => fmt(t.trigger_interval)],
        ['Trigger',  'Days of week', t => dowMaskToString(t.trigger_days_of_week | 0)],
        ['Trigger',  'Months',       t => moyMaskToString(t.trigger_months | 0)],
        ['Trigger',  'Days of month',t => domMaskToString(t.trigger_days_of_month | 0)],
        ['Trigger',  'End boundary', t => fmt(t.end_boundary)],
        ['Trigger',  'Random delay', t => fmt(t.random_delay)],
        ['Trigger',  'Boot delay',   t => fmt(t.boot_delay)],

        // Repetition
        ['Repetition','Interval',    t => fmt(t.repetition_interval)],
        ['Repetition','Duration',    t => fmt(t.repetition_duration)],
        ['Repetition','Stop at end', t => fmt(t.stop_at_duration_end)],

        // Action
        ['Action',   'Action(s)',    t => fmt((t.actions || []).join(' | '))],
        ['Action',   'Exec time limit', t => fmt(t.exec_time_limit)],
    ];

    // Render comparison table with per-cell highlighting.
    let lastCategory = null;
    const bodyRows = rows.map(([cat, label, getter]) => {
        const v1 = getter(t1);
        const v2 = getter(t2);
        const diff = v1 !== v2;
        const catHeader = (cat !== lastCategory)
            ? `<tr><td colspan="3" style="padding:14px 10px 6px;font-size:11px;text-transform:uppercase;letter-spacing:.08em;font-weight:700;color:var(--text3);background:var(--bg0)">${escHtml(cat)}</td></tr>`
            : '';
        lastCategory = cat;
        const cellStyle = (val) => `padding:7px 10px;font-family:'Cascadia Code',Consolas,monospace;font-size:12.5px;color:${diff ? 'var(--yellow)' : 'var(--text2)'};word-break:break-word;background:${diff ? 'rgba(245,158,11,.06)' : 'transparent'}`;
        return `${catHeader}<tr style="border-bottom:1px solid rgba(31,38,64,.45)">
            <td style="padding:7px 10px;color:${diff ? 'var(--yellow)' : 'var(--text3)'};font-size:12px;font-weight:${diff ? '700' : '600'};white-space:nowrap">
                ${diff ? '<span style="font-size:11px;margin-right:4px">⚠</span>' : ''}${escHtml(label)}
            </td>
            <td style="${cellStyle(v1)}" title="${escHtml(v1)}">${escHtml(v1)}</td>
            <td style="${cellStyle(v2)}" title="${escHtml(v2)}">${escHtml(v2)}</td>
        </tr>`;
    }).join('');

    // Count diffs for the title bar
    const diffCount = rows.filter(([_, __, g]) => g(t1) !== g(t2)).length;

    openModal('🔀 Compare Tasks',
        `<div style="display:flex;flex-direction:column;gap:12px">
          <div style="font-size:12.5px;color:var(--text3);line-height:1.5">
            Showing ${rows.length} fields across ${new Set(rows.map(r => r[0])).size} categories.
            <strong style="color:${diffCount > 0 ? 'var(--yellow)' : 'var(--green)'}">
              ${diffCount === 0 ? '✅ Tasks are identical in compared fields.' : `${diffCount} field${diffCount === 1 ? '' : 's'} differ.`}
            </strong>
          </div>
          <div style="background:var(--bg0);border:1px solid var(--border);border-radius:8px;overflow:hidden;max-height:520px;overflow-y:auto">
            <table style="width:100%;border-collapse:collapse">
              <thead style="position:sticky;top:0;background:var(--bg2);z-index:1">
                <tr>
                  <th style="text-align:left;padding:10px;border-bottom:1px solid var(--border);font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--text3);font-weight:700;width:160px">Field</th>
                  <th style="text-align:left;padding:10px;border-bottom:1px solid var(--border);font-size:12.5px;color:var(--text);font-weight:600" title="${escHtml(t1.path)}">${escHtml(t1.name)}</th>
                  <th style="text-align:left;padding:10px;border-bottom:1px solid var(--border);font-size:12.5px;color:var(--text);font-weight:600" title="${escHtml(t2.path)}">${escHtml(t2.name)}</th>
                </tr>
              </thead>
              <tbody>${bodyRows}</tbody>
            </table>
          </div>
         </div>`,
        `<button class="btn" onclick="openEditDialog(${escHtml(JSON.stringify(t1.path))}); closeModal();">✏ Edit "${escHtml(t1.name)}"</button>
         <button class="btn" onclick="openEditDialog(${escHtml(JSON.stringify(t2.path))}); closeModal();">✏ Edit "${escHtml(t2.name)}"</button>
         <button class="btn btn-primary" onclick="closeModal()">Close</button>`
    );
    dinfo('compareSelectedTasks', 'opened', { task1: t1.path, task2: t2.path, diffCount });
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
  setTimeout(() => refreshAll(true), 1000);
}

async function bulkEnable() {
  const paths = [..._selectedPaths];
  let ok = 0, fail = 0;
  for (const path of paths) {
    try { await invoke('set_task_enabled', { path, enabled: true }); ok++; }
    catch (err) { fail++; derror('bulkEnable', 'failed', { path, err: String(err) }); }
  }
  appendAuditLog('bulk_enable', `${ok} tasks`, paths.join(', '));
  showToast(fail ? `Enabled ${ok}, failed ${fail}` : `Enabled ${ok} tasks`, ok > 0 ? 'success' : 'error');
  clearBulkSelection();
  setTimeout(() => refreshAll(true), 500);
}

async function bulkDisable() {
  const paths = [..._selectedPaths];
  let ok = 0, fail = 0;
  for (const path of paths) {
    try { await invoke('set_task_enabled', { path, enabled: false }); ok++; }
    catch (err) { fail++; derror('bulkDisable', 'failed', { path, err: String(err) }); }
  }
  appendAuditLog('bulk_disable', `${ok} tasks`, paths.join(', '));
  showToast(fail ? `Disabled ${ok}, failed ${fail}` : `Disabled ${ok} tasks`, ok > 0 ? 'success' : 'error');
  clearBulkSelection();
  setTimeout(() => refreshAll(true), 500);
}

async function bulkExportXml() {
  const paths = [..._selectedPaths];
  let ok = 0;
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
      ok++;
    } catch (err) { derror('bulkExportXml', 'failed', { path, err: String(err) }); }
  }
  appendAuditLog('bulk_export_xml', `${ok} tasks`, '');
  showToast(`Exported ${ok} of ${paths.length} task(s) as XML`, ok === paths.length ? 'success' : 'error');
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
      const failed = [];
      // Feature pack 1.15.0 — capture each task's XML for the recycle bin
      // before deletion so bulk deletes are recoverable from the Recycle Bin
      // page (the Undo toast is single-item; bulk recovery lives on that page).
      let captured = 0;
      for (const path of paths) {
        const name = path.split('\\').pop() || path;
        const rec = await fpCaptureTaskXml(path, name);
        if (rec) { fpPushToTrash(rec); captured++; }
        try {
          await invoke('delete_task', { path });
          ok++;
        } catch (err) {
          failed.push({ path, err: String(err) });
        }
      }
      if (failed.length > 0) {
        dwarn('bulk_delete', 'partial failure',
              { ok, fail: failed.length, total: paths.length, failures: failed });
      } else {
        dinfo('bulk_delete', 'all succeeded', { count: ok });
      }
      appendAuditLog('bulk_delete', `${ok} tasks` + (failed.length ? ` (${failed.length} failed)` : ''), paths.join(', '));
      showToast(
        failed.length === 0
          ? `Deleted ${ok} tasks`
          : `Deleted ${ok} of ${paths.length} — ${failed.length} failed (see logs)`,
        failed.length === 0 ? 'success' : 'error'
      );
      clearBulkSelection();
      closeDetail();
      refreshAll();
    };
  }, 0);
}

// ── Task clone ────────────────────────────────────────────────────────────────
async function cloneTask(task) {
  // Use task.trigger_type (the structured field from Rust) when available,
  // falling back to parsing the first human-readable trigger string.
  const rawTrigger = (task.trigger_type || (task.triggers && task.triggers[0]) || 'Once');
  const triggerTypeMap = {
    'once': 'Once', 'daily': 'Daily', 'weekly': 'Weekly', 'monthly': 'Monthly',
    'at boot': 'Boot', 'boot': 'Boot',
    'at logon': 'Logon', 'logon': 'Logon',
    'on idle': 'Idle', 'idle': 'Idle',
    'interval': 'Interval',
    'sessionlock': 'SessionLock', 'session lock': 'SessionLock',
    'sessionunlock': 'SessionUnlock', 'session unlock': 'SessionUnlock',
  };
  const normalizedTrigger = triggerTypeMap[rawTrigger.toLowerCase()] || 'Once';
  const baseName = task.name.replace(/ \(Copy(?: \d+)?\)$/, '');

  // Derive trigger start time same way openEditDialog does
  const startFull = task.trigger_start || '';
  const tIdx      = startFull.indexOf('T');
  const startTime = tIdx >= 0 ? startFull.slice(tIdx + 1, tIdx + 6) : '';

  // Derive folder same way openEditDialog does
  const taskFolder = (() => {
    if (task.folder && task.folder !== '\\') return task.folder;
    const path = task.path || '';
    const lastSlash = path.lastIndexOf('\\');
    if (lastSlash <= 0) return '\\';
    return path.substring(0, lastSlash) || '\\';
  })();

  const prefill = {
    // General
    name:         baseName + ' (Copy)',
    folder:       taskFolder,
    description:  task.description || '',
    run_as_user:  task.run_as_user || '',
    run_level:    task.run_level || 0,
    hidden:       task.hidden || false,
    enabled:      task.enabled !== false,

    // Trigger — full set matching openEditDialog
    trigger_type:      normalizedTrigger,
    trigger_value:     startTime || '08:00',
    trigger_datetime:  startFull.slice(0, 16),
    days_interval:     task.trigger_interval || 1,
    days_of_week:      task.trigger_days_of_week || 0,
    months_of_year:    task.trigger_months || 0,
    days_of_month_mask:task.trigger_days_of_month || 0,

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
    working_dir: task.working_dir  || '',
  };

  await openCreateDialog(prefill);

  // Post-fill advanced duration selects (DOM must exist first)
  setDurationSelect('cf-exec-limit',   'cf-exec-limit-custom',   prefill.exec_time_limit);
  setDurationSelect('cf-random-delay', 'cf-random-delay-custom', prefill.random_delay);
  setDurationSelect('cf-rep-interval', 'cf-rep-interval-custom', prefill.repetition_interval);
  setDurationSelect('cf-rep-duration', 'cf-rep-duration-custom', prefill.repetition_duration);
  setDurationSelect('cf-boot-delay',   'cf-boot-delay-custom',   prefill.boot_delay);
  setDaysOfWeek(prefill.days_of_week);
  setMonthsOfYear(prefill.months_of_year);
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
  const stopEndEl = document.getElementById('cf-rep-stop-end');
  if (stopEndEl) stopEndEl.checked = prefill.stop_at_duration_end;
  const condFields = [
    ['cf-wake-to-run',     prefill.wake_to_run],
    ['cf-run-on-network',  prefill.run_only_if_network],
    ['cf-run-on-idle',     prefill.run_only_if_idle],
    ['cf-no-battery-start',prefill.disallow_on_battery_start],
    ['cf-stop-on-battery', prefill.stop_on_battery],
    ['cf-stop-existing',   prefill.stop_if_running],
    ['cf-delete-expired',  prefill.delete_expired],
  ];
  condFields.forEach(([id, val]) => { const el = document.getElementById(id); if (el) el.checked = !!val; });
  const priorityEl = document.getElementById('cf-priority');
  if (priorityEl) priorityEl.value = String(prefill.priority);

  const titleEl   = document.getElementById('modal-title');
  const submitBtn = document.getElementById('create-submit-btn');
  if (titleEl)   titleEl.textContent   = '📋 Clone Task';
  if (submitBtn) submitBtn.textContent = '📋 Clone Task';
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
    <button class="btn btn-primary" id="create-folder-ok-btn">Create</button>
    <button class="btn" onclick="closeModal()">Cancel</button>`;
  openModal('New Folder', body, footer);
  // Wire up confirm button safely — avoids embedding parentPath into onclick string
  requestAnimationFrame(() => {
    const btn = document.getElementById('create-folder-ok-btn');
    if (btn) btn.onclick = () => submitCreateFolder(parentPath);
  });
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

// ── Live Monitor ──────────────────────────────────────────────────────────────
function startLiveMonitor() {
  renderLiveMonitor();
  if (liveRefreshInterval) clearInterval(liveRefreshInterval);
  liveRefreshInterval = setInterval(() => {
    if (currentPage === 'live' && !_appHidden) renderLiveMonitor();
  }, 3000);
}

async function renderLiveMonitor() {
  const content = document.getElementById('live-content');
  if (!content) return;
  // In-flight guard (perf 2026-06-11): get_running_tasks runs synchronous COM
  // on the main thread. If a refresh is already running, skip this tick rather
  // than queue another blocking call behind it.
  if (_liveRefreshInProgress) return;
  _liveRefreshInProgress = true;
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
              ${tasks.map((t, idx) => `
                <tr>
                  <td>${escHtml(t.name)}</td>
                  <td class="cell-trunc" title="${escHtml(t.path)}">${escHtml(t.path)}</td>
                  <td>${escHtml(t.current_action || '-')}</td>
                  <td><span class="badge badge-running">${escHtml(t.state)}</span></td>
                  <td><button class="btn btn-danger" data-live-stop-idx="${idx}">Stop</button></td>
                </tr>`).join('')}
            </tbody>
          </table>`}`;
    // Wire up stop buttons via event delegation (avoids embedding task path in onclick attr)
    const liveTable = content.querySelector('.detail-table');
    if (liveTable) {
      liveTable.onclick = e => {
        const btn = e.target.closest('[data-live-stop-idx]');
        if (btn) {
          const idx = parseInt(btn.dataset.liveStopIdx, 10);
          if (tasks[idx]) stopTask(tasks[idx].path);
        }
      };
    }
  } catch (err) {
    const c = document.getElementById('live-content');
    if (c) c.innerHTML = `<div style="color:var(--red);padding:16px">Error: ${escHtml(String(err))}</div>`;
  } finally {
    _liveRefreshInProgress = false;
  }
}

// ── Audit log ─────────────────────────────────────────────────────────────────
function appendAuditLog(action, target, detail) {
  _auditLog.unshift({ ts: new Date().toISOString(), action, target, detail: detail || '' });
  if (_auditLog.length > MAX_AUDIT_LOG_ENTRIES) _auditLog.length = MAX_AUDIT_LOG_ENTRIES;
  // LOW-6 NOTE: Audit log is stored in WebView2 localStorage — it is accessible
  // to JS and cleared by DevTools. For tamper-proof logging, export to a file via
  // the Export button. A future version should use write_file() to persist outside
  // the WebView storage boundary.
  try { localStorage.setItem('wtp_auditLog', JSON.stringify(_auditLog)); } catch (_) {
    derror('appendAuditLog', 'failed to persist audit log to localStorage', { err: String(_) });
  }
}

// ── History-wide search (Phase 1 feature) ────────────────────────────────────
// Opens a modal with date range / event-id / substring filters that queries
// the Task Scheduler operational event log across ALL tasks. Results show
// time, task path, event id, and a snippet of the message. Clicking a row
// jumps to that task in the Task Manager view.
//
// The search is server-side (PowerShell Get-WinEvent with FilterHashtable),
// so even on machines with thousands of events it stays fast — the filter
// pushes into the kernel-mode log query instead of streaming all events to
// the app and filtering in JS.
function openHistorySearch() {
  // Default range: last 24 hours
  const now = new Date();
  const yesterday = new Date(now.getTime() - 24 * 3600 * 1000);
  const fmtLocal = (d) => {
    // datetime-local input wants 'YYYY-MM-DDTHH:mm' in local time
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };

  openModal('🔍 Search Run History',
    `<div style="display:flex;flex-direction:column;gap:14px">
      <div style="font-size:12.5px;color:var(--text3);line-height:1.5">
        Searches the Microsoft-Windows-TaskScheduler/Operational event log across <strong>all</strong> tasks.
        Use this to answer "what happened at 2:32pm yesterday?" or "did the backup task ever fail?"
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
        <div class="form-group">
          <label>Start (local time)</label>
          <input type="datetime-local" id="hs-start" class="form-control" value="${fmtLocal(yesterday)}" />
        </div>
        <div class="form-group">
          <label>End (local time)</label>
          <input type="datetime-local" id="hs-end" class="form-control" value="${fmtLocal(now)}" />
        </div>
      </div>
      <div class="form-group">
        <label>Filter by text (task path, error message, etc. — optional)</label>
        <input type="text" id="hs-query" class="form-control" placeholder="e.g. PS4, backup, error" />
      </div>
      <div class="form-group">
        <label>Event types</label>
        <div style="display:flex;gap:14px;flex-wrap:wrap;font-size:13px">
          <label style="display:flex;align-items:center;gap:5px;cursor:pointer">
            <input type="checkbox" id="hs-evt-100" checked /> 100 — task started
          </label>
          <label style="display:flex;align-items:center;gap:5px;cursor:pointer">
            <input type="checkbox" id="hs-evt-102" checked /> 102 — task completed
          </label>
          <label style="display:flex;align-items:center;gap:5px;cursor:pointer">
            <input type="checkbox" id="hs-evt-103" /> 103 — action failed
          </label>
          <label style="display:flex;align-items:center;gap:5px;cursor:pointer">
            <input type="checkbox" id="hs-evt-200" checked /> 200 — action started
          </label>
          <label style="display:flex;align-items:center;gap:5px;cursor:pointer">
            <input type="checkbox" id="hs-evt-201" checked /> 201 — action completed
          </label>
        </div>
      </div>
      <div class="form-group">
        <label>Max results</label>
        <input type="number" id="hs-max" class="form-control" min="10" max="1000" value="200" style="max-width:140px" />
      </div>
      <div id="hs-results" style="min-height:120px"></div>
     </div>`,
    `<button class="btn btn-primary" onclick="runHistorySearch()">🔍 Search</button>
     <button class="btn" onclick="closeModal()">Close</button>`
  );
}

async function runHistorySearch() {
  const startEl  = document.getElementById('hs-start');
  const endEl    = document.getElementById('hs-end');
  const queryEl  = document.getElementById('hs-query');
  const maxEl    = document.getElementById('hs-max');
  const resultsEl = document.getElementById('hs-results');
  if (!startEl || !endEl || !queryEl || !resultsEl) return;

  // Convert datetime-local (local) to ISO. The PS side accepts a literal
  // datetime string and parses it as local time, so we don't strictly need
  // ISO — but feeding YYYY-MM-DDTHH:mm:ss is unambiguous.
  const startIso = startEl.value ? startEl.value + ':00' : '';
  const endIso   = endEl.value   ? endEl.value   + ':00' : '';
  const query    = queryEl.value.trim();
  const max      = Math.max(10, Math.min(1000, parseInt(maxEl.value, 10) || 200));

  // Collect checked event IDs
  const eventIds = [];
  for (const id of [100, 102, 103, 200, 201]) {
    if (document.getElementById('hs-evt-' + id)?.checked) eventIds.push(id);
  }
  if (eventIds.length === 0) {
    resultsEl.innerHTML = `<div style="color:var(--red);padding:14px;text-align:center">Select at least one event type.</div>`;
    return;
  }

  resultsEl.innerHTML = `<div style="text-align:center;padding:24px;color:var(--text3)">Searching event log…</div>`;

  try {
    const t0 = performance.now();
    const rows = await invoke('search_event_history', {
      query,
      startIso,
      endIso,
      eventIds,
      maxRecords: max,
    });
    const ms = Math.round(performance.now() - t0);
    dinfo('runHistorySearch', 'completed', { ms, rows: rows.length, query, eventIds });

    if (!rows || rows.length === 0) {
      resultsEl.innerHTML = `
        <div style="text-align:center;padding:32px;color:var(--text3)">
          <div style="font-size:14px;margin-bottom:6px">No matching events found.</div>
          <div style="font-size:12px">Try widening the date range, removing the text filter, or selecting more event types.</div>
        </div>`;
      return;
    }

    const eventLabel = (id) => ({
      100: 'started', 102: 'completed', 103: '<span style="color:var(--red)">action FAILED</span>',
      200: 'action started', 201: 'action completed',
    })[id] || ('event ' + id);

    resultsEl.innerHTML = `
      <div style="font-size:11px;color:var(--text3);margin-bottom:6px">${rows.length} matching event${rows.length === 1 ? '' : 's'} (search took ${ms}ms)</div>
      <div style="background:var(--bg0);border:1px solid var(--border);border-radius:6px;max-height:400px;overflow-y:auto">
        <table style="width:100%;border-collapse:collapse;font-size:12.5px;font-family:'Cascadia Code',Consolas,monospace">
          <thead style="position:sticky;top:0;background:var(--bg2);z-index:1">
            <tr>
              <th style="text-align:left;padding:8px 10px;border-bottom:1px solid var(--border);font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--text3);font-weight:700">Time</th>
              <th style="text-align:left;padding:8px 10px;border-bottom:1px solid var(--border);font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--text3);font-weight:700">Task</th>
              <th style="text-align:left;padding:8px 10px;border-bottom:1px solid var(--border);font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--text3);font-weight:700">Event</th>
              <th style="text-align:left;padding:8px 10px;border-bottom:1px solid var(--border);font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--text3);font-weight:700">Detail</th>
            </tr>
          </thead>
          <tbody>
            ${rows.map(r => `
              <tr style="border-bottom:1px solid rgba(31,38,64,.45)">
                <td style="padding:7px 10px;color:var(--text2);white-space:nowrap">${escHtml(r.time || '')}</td>
                <td style="padding:7px 10px;color:var(--text)" title="${escHtml(r.task || '')}">${escHtml((r.task || '').slice(0, 40))}</td>
                <td style="padding:7px 10px;color:var(--text3);white-space:nowrap">${eventLabel(r.id)}</td>
                <td style="padding:7px 10px;color:var(--text3);font-size:11.5px" title="${escHtml(r.message || '')}">${escHtml((r.message || '').slice(0, 80))}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>`;
  } catch (err) {
    derror('runHistorySearch', 'IPC failed', { err: String(err) });
    resultsEl.innerHTML = `
      <div style="color:var(--red);padding:16px">
        <div style="font-weight:600;margin-bottom:6px">Search failed</div>
        <div style="font-size:12px;font-family:'Cascadia Code',Consolas,monospace">${escHtml(String(err))}</div>
      </div>`;
  }
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
      <button class="btn" onclick="openHistorySearch()">🔍 Search Run History</button>
      <button class="btn btn-danger" onclick="clearAuditLog()">Clear Log</button>
      <span style="color:var(--text3);font-size:11px">${_auditLog.length} ${_auditLog.length === 1 ? 'entry' : 'entries'}</span>
    </div>
    <div id="al-table-container"></div>`;
  renderAuditLogTable();
}

function renderAuditLogTable() {
  const container = document.getElementById('al-table-container');
  if (!container) return;
  const search = (document.getElementById('al-search')?.value || '').toLowerCase();
  const actionFilter = document.getElementById('al-action-filter')?.value || '';
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
    [e.ts, e.action, e.target, e.detail].map(csvCell).join(',')  // formula-injection-guarded (audit 2026-06-11)
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
      <div style="border-top:1px solid var(--border);margin:8px 0 6px"></div>
      <button class="btn btn-sm" style="width:100%;justify-content:center" onclick="autoFitAllColumns();toggleColPicker()">⟺ Auto Fit All Columns</button>
      <button class="btn btn-sm" style="width:100%;justify-content:center;margin-top:4px" onclick="resetColumnWidths();toggleColPicker()">↺ Reset Widths</button>
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
    // Hide/show every cell (th + td) with this data-col attribute.
    // Because widths live on <th> elements (not <col>), setting display:none
    // on the <th> correctly collapses that column with no leftover space.
    document.querySelectorAll(`[data-col="${col}"]`).forEach(el => {
      el.style.display = visible ? '' : 'none';
    });
  });
}

// ── Column resize ─────────────────────────────────────────────────────────────
// Columns that should not get a resize handle (too small to be useful)
const _NO_RESIZE_COLS = new Set(['cb']);

// Guard: resize handles are added to <th> elements once and persist across
// renderTable() calls since renderTable() only rebuilds <tbody>, not <thead>.
let _colResizeInitialized = false;

function initColumnResize() {
  if (_colResizeInitialized) return;
  const _ths = document.querySelectorAll('#task-table thead th[data-col]');
  if (!_ths.length) return; // thead not ready yet
  _colResizeInitialized = true;

  _ths.forEach(th => {
    const col = th.dataset.col;
    if (_NO_RESIZE_COLS.has(col)) return;

    const handle = document.createElement('div');
    handle.className = 'col-resize-handle';
    handle.title = 'Drag to resize · Double-click to auto-fit';
    th.appendChild(handle);

    let startX = 0, startW = 0;

    handle.addEventListener('mousedown', e => {
      e.preventDefault();
      e.stopPropagation();
      startX = e.clientX;
      startW = th.offsetWidth;
      handle.classList.add('dragging');
      document.body.style.cursor     = 'col-resize';
      document.body.style.userSelect = 'none';

      const onMove = e => {
        const w = Math.max(48, startW + e.clientX - startX);
        th.style.width = w + 'px';
      };
      const onUp = () => {
        handle.classList.remove('dragging');
        document.body.style.cursor     = '';
        document.body.style.userSelect = '';
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup',   onUp);
        saveColumnWidths();
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup',   onUp);
    });

    // Double-click handle → auto-fit this column
    handle.addEventListener('dblclick', e => {
      e.stopPropagation();
      autoFitColumn(th, col);
    });
  });

  // Restore any previously saved widths
  loadColumnWidths();
}

// Measure the widest content in a column and snap the th to that width.
// scrollWidth gives full content width even on overflow:hidden cells.
function autoFitColumn(th, col) {
  let maxW = th.scrollWidth + 20; // header + sort icon + padding
  document.querySelectorAll(`#task-tbody td[data-col="${col}"]`).forEach(td => {
    maxW = Math.max(maxW, td.scrollWidth + 24); // cell content + padding buffer
  });
  th.style.width = Math.max(48, maxW) + 'px';
  saveColumnWidths();
}

function autoFitAllColumns() {
  document.querySelectorAll('#task-table thead th[data-col]').forEach(th => {
    if (!_NO_RESIZE_COLS.has(th.dataset.col)) autoFitColumn(th, th.dataset.col);
  });
}

function resetColumnWidths() {
  document.querySelectorAll('#task-table thead th[data-col]').forEach(th => {
    th.style.width = '';
  });
  try { localStorage.removeItem('wtp_colWidths'); } catch (_) {}
}

function saveColumnWidths() {
  const widths = {};
  document.querySelectorAll('#task-table thead th[data-col]').forEach(th => {
    if (th.style.width) widths[th.dataset.col] = th.style.width;
  });
  try { localStorage.setItem('wtp_colWidths', JSON.stringify(widths)); } catch (_) {}
}

function loadColumnWidths() {
  try {
    const stored = localStorage.getItem('wtp_colWidths');
    if (!stored) return;
    const widths = JSON.parse(stored);
    document.querySelectorAll('#task-table thead th[data-col]').forEach(th => {
      const w = widths[th.dataset.col];
      if (w) th.style.width = w;
    });
  } catch (_) {}
}
function applyAccentColor(color) {
  document.documentElement.style.setProperty('--accent', color);
  try { localStorage.setItem('wtp_accent', color); } catch (_) {}
  document.querySelectorAll('.color-swatch').forEach(s => {
    s.classList.toggle('active', s.style.background === color);
  });
}

// ── Notifications ─────────────────────────────────────────────────────────────
// We don't use the browser Notification API. WebView2 blocks it by default
// and overriding requires either MSIX packaging or a Tauri plugin. Instead
// we use Win32 FlashWindowEx (via Tauri's request_user_attention IPC) which
// flashes the taskbar icon — the standard Windows "look at me" signal —
// plus an in-app toast for in-context confirmation. No permissions, no
// browser-popup nag, works in every WV2 environment.

function onNotifyFailureChange() {
  const enabled = document.getElementById('s-notify-failure').checked;
  localStorage.setItem('wtp_notifyOnFailure', enabled);
  // No browser permission to request — the taskbar flash works without it.
}

async function sendTestNotification() {
  // Flash the taskbar icon and show an in-app toast as a unified "you
  // would have been notified" signal. If the app is in the foreground the
  // user sees the toast immediately; if backgrounded they see the taskbar
  // pulse and can come back to find the toast still on screen.
  let flashed = false;
  try {
    await invoke('flash_taskbar');
    flashed = true;
  } catch (err) {
    dwarn('sendTestNotification', 'flash_taskbar failed', { err: String(err) });
  }
  showToast(
    flashed
      ? '🔔 Test notification sent — taskbar icon flashed'
      : '🔔 Test notification (in-app only — taskbar flash unavailable)',
    'success',
  );
}

// (notifyFailure helper removed in audit 2026-06-11: it was never called.
// The failure-detection path in refreshAll() flashes the taskbar inline,
// deliberately ONCE per refresh tick regardless of how many tasks failed —
// a per-task helper would regress that decision. See refreshAll().)

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
      }).catch(err => {
        // File might not exist yet (user typed a new path). Log and let user
        // see the empty editor — they can save their new content normally.
        dwarn('openScriptEditor', 'read_file failed', { path, err: String(err) });
        updateScriptEditorStats();
      });
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

// ── Schedule preview ──────────────────────────────────────────────────────────
// Given the current state of the create/edit dialog form, compute the next N
// times the task would fire. Helps the user verify "yes, this will run when I
// expect" BEFORE clicking save — closes the gap where someone sets a Weekly
// trigger on a Wednesday but their day-of-week mask is empty (unfireable).
//
// Implementation note: we deliberately reproduce trigger-firing logic in JS
// rather than serializing the form to XML and asking Windows what would
// happen. Reasons:
//   - Avoids an IPC round-trip on every form keystroke.
//   - Gives us a place to tell users "this will NEVER fire" loudly when the
//     mask/options combo is empty.
//   - Keeps the preview accurate even before the form is valid enough to
//     register a real task.
//
// Limitations: this is a forecast based on the LITERAL trigger spec. It
// cannot model "wake the computer to run" delays, idle conditions, network
// availability gates, or AC-power requirements — those affect WHETHER a
// fired trigger actually runs the action, not when it fires. If the user has
// "run only if on AC power" set, the preview still shows the trigger times
// (correctly); a tooltip notes the conditions that gate execution.

function computeNextFirings(formState, count = 5) {
    // Returns an array of Date objects representing the next `count` firing
    // times after `now`. Returns [] if the trigger spec can never fire (e.g.
    // weekly with empty day mask). Returns null if the trigger type is
    // unrecognized or required fields are missing — caller renders a
    // neutral "preview unavailable" state in that case.
    const {
        triggerType, startDateTime, daysInterval,
        daysOfWeek, daysOfMonth, monthsOfYear,
        intervalValue, intervalUnit,
    } = formState;
    // Note: formState also carries intervalStartTime and idleMinutes for the
    // caller's own rendering. The Interval case here reads its start through
    // the startDateTime fallback chain (renderSchedulePreview folds
    // cf-interval-start into startDateTime), so they are not destructured.

    if (!triggerType) return null;
    const now = new Date();
    const results = [];

    // Parse startDateTime — accept HTML datetime-local 'YYYY-MM-DDTHH:mm' or
    // a separate date+time. If empty, default to today at the form's
    // currently-set time, or now+1min as a last resort.
    function parseStart() {
        if (startDateTime && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(startDateTime)) {
            return new Date(startDateTime);
        }
        if (startDateTime && /^\d{2}:\d{2}/.test(startDateTime)) {
            // Time-only string: combine with today
            const d = new Date();
            const [h, m] = startDateTime.split(':').map(Number);
            d.setHours(h, m, 0, 0);
            return d;
        }
        const d = new Date(now); d.setMinutes(d.getMinutes() + 1, 0, 0); return d;
    }

    // (ensureFuture stub removed in audit 2026-06-11: its body was a bare
    // `return d;` that never implemented the roll-forward its comment
    // described, and nothing called it. Each trigger case below already
    // rolls its own cursor past `now`.)

    switch (triggerType) {
        case 'Once': {
            const d = parseStart();
            if (d > now) results.push(d);
            break;
        }
        case 'Daily': {
            const interval = Math.max(1, parseInt(daysInterval || 1, 10));
            let d = parseStart();
            // Roll forward to today/tomorrow
            while (d <= now) d.setDate(d.getDate() + interval);
            for (let i = 0; i < count; i++) {
                results.push(new Date(d));
                d.setDate(d.getDate() + interval);
            }
            break;
        }
        case 'Weekly': {
            // daysOfWeek is a Set/array of 'Sun','Mon','Tue','Wed','Thu','Fri','Sat'
            const dow = new Set((daysOfWeek || []).map(s => s.slice(0, 3)));
            if (dow.size === 0) return [];   // unfireable
            const dayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
            const targetDays = [...dow].map(s => dayMap[s]).filter(n => n !== undefined);
            const interval = Math.max(1, parseInt(daysInterval || 1, 10));
            const start = parseStart();
            // Walk forward day-by-day from max(start, now), emitting hits on
            // matching weekdays. We don't try to model the "every N weeks
            // anchored to a base week" complexity here — it's an approximation
            // that's accurate to within one week for `interval > 1`.
            const cursor = new Date(Math.max(now.getTime(), start.getTime()));
            cursor.setSeconds(0, 0);
            cursor.setHours(start.getHours(), start.getMinutes(), 0, 0);
            for (let i = 0; i < 365 && results.length < count; i++) {
                if (targetDays.includes(cursor.getDay()) && cursor > now) {
                    results.push(new Date(cursor));
                }
                cursor.setDate(cursor.getDate() + 1);
            }
            // Apply the every-N-weeks filter as a coarse post-step
            if (interval > 1 && results.length > 0) {
                const startWeek = Math.floor(results[0].getTime() / (7*24*3600*1000));
                const filtered = results.filter(d => {
                    const w = Math.floor(d.getTime() / (7*24*3600*1000));
                    return ((w - startWeek) % interval) === 0;
                });
                return filtered.slice(0, count);
            }
            break;
        }
        case 'Monthly': {
            // daysOfMonth: array of day-of-month numbers 1..31, OR null/empty
            // monthsOfYear: array of month names ('Jan'..'Dec') — null/empty = all
            const days = (daysOfMonth || []).map(Number).filter(d => d >= 1 && d <= 31);
            if (days.length === 0) return [];
            const monthMap = { Jan:0,Feb:1,Mar:2,Apr:3,May:4,Jun:5,Jul:6,Aug:7,Sep:8,Oct:9,Nov:10,Dec:11 };
            const months = (monthsOfYear && monthsOfYear.length)
                ? [...new Set(monthsOfYear.map(s => monthMap[s.slice(0,3)]).filter(n => n !== undefined))]
                : [0,1,2,3,4,5,6,7,8,9,10,11];
            if (months.length === 0) return [];
            const start = parseStart();
            const cursor = new Date(now.getFullYear(), now.getMonth(), 1,
                                    start.getHours(), start.getMinutes(), 0, 0);
            for (let m = 0; m < 36 && results.length < count; m++) {
                if (months.includes(cursor.getMonth())) {
                    for (const d of [...days].sort((a,b)=>a-b)) {
                        // Skip days that don't exist in this month (e.g. Feb 30)
                        const lastDay = new Date(cursor.getFullYear(), cursor.getMonth()+1, 0).getDate();
                        if (d > lastDay) continue;
                        const candidate = new Date(cursor); candidate.setDate(d);
                        if (candidate > now) {
                            results.push(candidate);
                            if (results.length >= count) break;
                        }
                    }
                }
                cursor.setMonth(cursor.getMonth() + 1);
            }
            break;
        }
        case 'Interval': {
            // Repeats every N hours/minutes starting at intervalStartTime today
            const v = Math.max(1, parseInt(intervalValue || 1, 10));
            const unit = (intervalUnit || 'Hours').toLowerCase();
            const stepMs = unit === 'minutes' ? v * 60_000 : v * 3_600_000;
            const start = parseStart();
            // If the interval-start was a time-only field, combine with today
            const cursor = new Date(start);
            while (cursor <= now) cursor.setTime(cursor.getTime() + stepMs);
            for (let i = 0; i < count; i++) {
                results.push(new Date(cursor));
                cursor.setTime(cursor.getTime() + stepMs);
            }
            break;
        }
        case 'AtLogon':
        case 'AtStartup':
        case 'OnEvent':
        case 'OnIdle':
        case 'Logon':
        case 'Boot':
        case 'Idle':
        case 'SessionLock':
        case 'SessionUnlock':
            // Event-triggered: no deterministic firing schedule.
            // Return null — the renderer shows a "depends on event" message
            // rather than a list of times.
            return null;
        default:
            return null;
    }

    return results.slice(0, count);
}

// ── Render schedule preview into the UI ──────────────────────────────────────
// Called whenever a relevant form field changes. Updates the #cf-schedule-preview
// element with a readable "next 5 firings" list, or an explanatory state
// (event-driven / unfireable / form incomplete).
function renderSchedulePreview() {
    const el = document.getElementById('cf-schedule-preview');
    if (!el) return;

    // Collect form state. Use the same field IDs the rest of the dialog uses.
    const triggerType = document.getElementById('cf-trigger-type')?.value || 'Once';

    // Day-of-week checkboxes: cf-dow-sun, cf-dow-mon, ...
    const dowKeys = ['sun','mon','tue','wed','thu','fri','sat'];
    const dowMap = { sun:'Sun', mon:'Mon', tue:'Tue', wed:'Wed', thu:'Thu', fri:'Fri', sat:'Sat' };
    const daysOfWeek = dowKeys
        .filter(k => document.getElementById('cf-dow-' + k)?.checked)
        .map(k => dowMap[k]);

    // Day-of-month: 31 checkboxes cf-dom-1..cf-dom-31 (if they exist)
    const daysOfMonth = [];
    for (let d = 1; d <= 31; d++) {
        if (document.getElementById('cf-dom-' + d)?.checked) daysOfMonth.push(d);
    }
    // Fallback to single day-of-month input "cf-month-day"
    if (daysOfMonth.length === 0) {
        const md = document.getElementById('cf-month-day')?.value;
        if (md) daysOfMonth.push(parseInt(md, 10));
    }

    // Month checkboxes: cf-moy-jan, cf-moy-feb, ...
    const moyKeys = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
    const moyMap = { jan:'Jan',feb:'Feb',mar:'Mar',apr:'Apr',may:'May',jun:'Jun',
                     jul:'Jul',aug:'Aug',sep:'Sep',oct:'Oct',nov:'Nov',dec:'Dec' };
    const monthsOfYear = moyKeys
        .filter(k => document.getElementById('cf-moy-' + k)?.checked)
        .map(k => moyMap[k]);

    // Pull start date/time from whichever input is visible for this trigger
    const startDateTime =
        document.getElementById('cf-datetime')?.value
        || document.getElementById('cf-daily-time')?.value
        || document.getElementById('cf-interval-start')?.value
        || '';

    const formState = {
        triggerType,
        startDateTime,
        daysInterval:    document.getElementById('cf-days-interval')?.value
                       || document.getElementById('cf-weeks-interval')?.value || 1,
        daysOfWeek,
        daysOfMonth,
        monthsOfYear,
        intervalValue:   document.getElementById('cf-interval-value')?.value || 1,
        intervalUnit:    document.getElementById('cf-interval-unit')?.value || 'Hours',
        intervalStartTime: document.getElementById('cf-interval-start')?.value || '00:00',
        idleMinutes:     document.getElementById('cf-idle-min')?.value || 10,
    };

    const firings = computeNextFirings(formState, 5);

    if (firings === null) {
        // Event-triggered or unrecognized
        const msg = ({
            AtLogon:       'Fires when any user (or this user, if scoped) logs on.',
            Logon:         'Fires when any user (or this user, if scoped) logs on.',
            AtStartup:     'Fires when Windows boots — before any user logon.',
            Boot:          'Fires when Windows boots — before any user logon.',
            OnEvent:       'Fires when a matching Event Log entry is recorded.',
            OnIdle:        `Fires after the system has been idle for ${formState.idleMinutes} minutes.`,
            Idle:          `Fires after the system has been idle for ${formState.idleMinutes} minutes.`,
            SessionLock:   'Fires when the workstation is locked (Win+L).',
            SessionUnlock: 'Fires when the workstation is unlocked.',
        })[triggerType] || 'Schedule preview unavailable for this trigger type.';
        el.innerHTML = `<div style="font-size:12.5px;color:var(--text3);font-style:italic">${escHtml(msg)}</div>`;
        return;
    }

    if (firings.length === 0) {
        // Unfireable — empty mask
        el.innerHTML = `
            <div style="display:flex;align-items:center;gap:8px;padding:8px 10px;background:rgba(239,68,68,.08);border:1px solid rgba(239,68,68,.24);border-radius:6px">
                <span style="font-size:16px">⚠</span>
                <span style="font-size:12.5px;color:var(--red)">This trigger will never fire — no days/months are selected.</span>
            </div>`;
        return;
    }

    // Render the next firings as a tidy list
    const fmt = (d) => {
        const opts = { weekday: 'short', month: 'short', day: 'numeric',
                       hour: '2-digit', minute: '2-digit', hour12: false };
        return d.toLocaleString(undefined, opts);
    };
    const relativeMs = (d) => d.getTime() - Date.now();
    const relTime = (ms) => {
        if (ms < 60_000) return 'in <1m';
        if (ms < 3_600_000) return `in ${Math.round(ms / 60_000)}m`;
        if (ms < 86_400_000) return `in ${Math.round(ms / 3_600_000)}h`;
        return `in ${Math.round(ms / 86_400_000)}d`;
    };

    const items = firings.map((d, i) => `
        <div style="display:flex;justify-content:space-between;padding:5px 8px;${i ? 'border-top:1px solid var(--border)' : ''};font-family:'Cascadia Code',Consolas,monospace;font-size:12.5px">
            <span style="color:var(--text2)">${escHtml(fmt(d))}</span>
            <span style="color:var(--text3);font-size:11px">${escHtml(relTime(relativeMs(d)))}</span>
        </div>`).join('');

    el.innerHTML = `
        <div style="font-size:11px;color:var(--text3);text-transform:uppercase;letter-spacing:.06em;font-weight:700;margin-bottom:6px">Next ${firings.length} firing${firings.length === 1 ? '' : 's'}</div>
        <div style="background:var(--bg0);border:1px solid var(--border);border-radius:6px;overflow:hidden">${items}</div>`;
}

// ── XML tab helpers ───────────────────────────────────────────────────────────
function generateXmlPreview() {
  const ta = document.getElementById('cf-task-xml');
  if (!ta) return;
  const name    = (document.getElementById('cf-name')?.value || 'MyTask').trim();
  const desc    = (document.getElementById('cf-desc')?.value || '').trim();
  const program = (document.getElementById('cf-program')?.value
               || document.getElementById('cf-script-path')?.value || '').trim();
  const args    = (document.getElementById('cf-args')?.value
               || document.getElementById('cf-extra-args')?.value || '').trim();
  const trigger = document.getElementById('cf-trigger-type')?.value || 'Daily';
  const dt      = (document.getElementById('cf-daily-time')?.value
               || document.getElementById('cf-datetime')?.value || '').trim();
  const today   = new Date().toISOString().slice(0, 10);
  const startBoundary = today + 'T' + (dt ? dt.slice(0,5) + ':00' : '08:00:00');

  ta.value = `<?xml version="1.0" encoding="UTF-16"?>\n<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">\n  <RegistrationInfo>\n    <Description>${escHtml(desc)}</Description>\n  </RegistrationInfo>\n  <Triggers>\n    <CalendarTrigger>\n      <StartBoundary>${startBoundary}</StartBoundary>\n      <Enabled>true</Enabled>\n    </CalendarTrigger>\n  </Triggers>\n  <Actions Context="Author">\n    <Exec>\n      <Command>${escHtml(program)}</Command>\n      <Arguments>${escHtml(args)}</Arguments>\n    </Exec>\n  </Actions>\n  <Settings>\n    <Enabled>true</Enabled>\n    <Hidden>false</Hidden>\n  </Settings>\n</Task>`;
}

function applyXmlToForm() {
  const ta = document.getElementById('cf-task-xml');
  if (!ta) return;
  try {
    const doc  = new DOMParser().parseFromString(ta.value.trim(), 'application/xml');
    // DOMParser never throws — parse errors appear as a <parsererror> element
    if (doc.querySelector('parsererror')) {
      showToast('Invalid XML — cannot apply to form', 'error');
      return;
    }
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
      if (!e.ctrlKey && !e.metaKey && currentPage === 'tasks') { e.preventDefault(); openCreateDialog(); }
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
    case '6': showPage('recyclebin');  break;

    // ── Phase 4: vim-style row navigation ──────────────────────────────
    // j/k move selection through visible task rows; Enter opens detail.
    // Only active on the Tasks page.
    case 'j': case 'k':
    case 'ArrowDown': case 'ArrowUp':
      if (currentPage === 'tasks') {
        e.preventDefault();
        const dir = (e.key === 'j' || e.key === 'ArrowDown') ? 1 : -1;
        moveTaskRowSelection(dir);
      }
      break;
    case 'Enter':
      if (currentPage === 'tasks' && selectedTask) {
        e.preventDefault();
        openDetail(selectedTask);
      }
      break;

    // ── Phase 4: detail-panel tab navigation ───────────────────────────
    // [ and ] cycle through detail-panel tabs when the detail panel is
    // open. Useful keyboard parity with the click navigation.
    case '[': case ']':
      if (selectedTask && document.querySelector('.detail-tab')) {
        e.preventDefault();
        cycleDetailTab(e.key === ']' ? 1 : -1);
      }
      break;
  }
}

// Move the keyboard-focused row up or down by `dir` (-1 or +1). Wraps at
// the ends. The "focused" row gets a subtle highlight via .row-focused
// class; this is distinct from .row-selected (the bulk-selection class)
// because keyboard focus is single-row whereas bulk selection is multi.
function moveTaskRowSelection(dir) {
    const tbody = document.getElementById('task-tbody');
    if (!tbody) return;
    const rows = [...tbody.querySelectorAll('tr[data-path]')];
    if (rows.length === 0) return;

    // Find current focused row, default to first
    const current = tbody.querySelector('tr.row-focused');
    let idx = current ? rows.indexOf(current) : -1;
    idx = (idx + dir + rows.length) % rows.length;
    if (current) current.classList.remove('row-focused');
    const next = rows[idx];
    next.classList.add('row-focused');
    next.scrollIntoView({ block: 'nearest', behavior: 'smooth' });

    // Also update selectedTask so Enter / E / Delete keys work on this row
    const path = next.dataset.path;
    const task = (allTasks || []).find(t => t.path === path);
    if (task) selectedTask = task;
}

// Cycle the detail panel's active tab by `dir` (-1 or +1). Used by the
// [ and ] keys when the detail panel is open.
function cycleDetailTab(dir) {
    const tabIds = [...document.querySelectorAll('.detail-tab')].map(b => b.dataset.tab);
    if (tabIds.length === 0) return;
    let idx = tabIds.indexOf(_detailTab);
    if (idx === -1) idx = 0;
    idx = (idx + dir + tabIds.length) % tabIds.length;
    setDetailTab(tabIds[idx]);
}

function showHelpModal() {
  const body = `
    <div style="padding:4px 0">
      <table class="detail-table">
        <thead><tr><th>Key</th><th>Action</th></tr></thead>
        <tbody>
          <tr><td style="font-family:monospace">Ctrl+K</td><td>Command palette — jump to any task, page, or action</td></tr>
          <tr><td style="font-family:monospace">N</td><td>New task</td></tr>
          <tr><td style="font-family:monospace">J / K / ↓ / ↑</td><td>Next / previous task row</td></tr>
          <tr><td style="font-family:monospace">Enter</td><td>Open selected task's detail panel</td></tr>
          <tr><td style="font-family:monospace">[ / ]</td><td>Previous / next detail-panel tab</td></tr>
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
          <tr><td style="font-family:monospace">6</td><td>Go to Recycle Bin</td></tr>
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
async function loadDashboard() {
  clearTimeout(_dashboardRefreshTimer);
  _dashboardRefreshTimer = null;
  const content = document.getElementById('dash-content');
  content.innerHTML = '<div class="loading-msg"><span class="spinner"></span> Loading...</div>';
  setStatus('Loading dashboard...');
  try {
    // Reuse the boot prefetch on first launch, then clear it so every later
    // dashboard render (manual/auto refresh, or after a task change) fetches
    // fresh and never shows stale data. (PERF 1.15.3) When we DO have to fetch,
    // yield first so the spinner paints before the synchronous COM walk (1.15.4).
    let tasks;
    if (_bootAllTasks) {
      tasks = _bootAllTasks;
      _bootAllTasks = null;
    } else {
      await new Promise(r => setTimeout(r, 50));
      tasks = await invoke('get_all_tasks', { skipSystem: !settings.showSystemTasks });
    }
    // BUG FIX (video audit 2026-04-20): populate globals from the dashboard's
    // fetch so the bottom status bar shows the correct count BEFORE the user
    // first visits Task Manager. Previously `allTasks` was only set inside
    // loadTasksForFolder — if user stayed on Dashboard, the status bar read
    // `allTasks.length` as 0 (stale initial value) and showed "0 tasks" even
    // though the dashboard displayed the correct count on its stat cards.
    // Also updates the Task Manager nav-item badge for consistency.
    allTasks = tasks;
    filteredTasks = tasks;
    const tmBadge = document.getElementById('tasks-nav-badge');
    if (tmBadge) tmBadge.textContent = tasks.length;
    updateStatusBar();
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
    const fmtDate = s => (s && s !== 'Never' && s !== 'N/A') ? s.replace(/(\d{4}-\d{2}-\d{2} \d{2}:\d{2}):\d{2}.*/, '$1') : (s || '');

    content.innerHTML = `
      <div class="stat-grid">
        <div class="stat-card"><div class="stat-icon">📋</div><div class="stat-val">${total}</div><div class="stat-lbl">Total</div></div>
        <div class="stat-card running"><div class="stat-icon">▶</div><div class="stat-val">${running}</div><div class="stat-lbl">Running</div></div>
        <div class="stat-card ready"><div class="stat-icon">✅</div><div class="stat-val">${ready}</div><div class="stat-lbl">Ready</div></div>
        <div class="stat-card disabled"><div class="stat-icon">⏸</div><div class="stat-val">${disabled}</div><div class="stat-lbl">Disabled</div></div>
        <div class="stat-card failed-card" onclick="goToFailedTasks()" style="cursor:pointer"><div class="stat-icon">❌</div><div class="stat-val">${failed}</div><div class="stat-lbl">Failed</div></div>
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
            : `<table class="dash-table">
                <thead><tr><th style="width:45%">Name</th><th style="width:30%">Next Run</th><th style="width:25%">Trigger</th></tr></thead>
                <tbody>${upcoming.map(t => {
                  const trig = escHtml((t.triggers||['-'])[0]);
                  return `<tr style="cursor:pointer" onclick="showPage('tasks')">
                    <td title="${escHtml(t.name)}">${escHtml(t.name)}</td>
                    <td title="${escHtml(t.next_run)}">${escHtml(fmtDate(t.next_run))}</td>
                    <td title="${trig}">${trig}</td>
                  </tr>`;
                }).join('')}
                </tbody></table>`}
        </div>
        <div class="dash-card">
          <div class="dash-card-title">Recently Failed</div>
          ${recentlyFailed.length === 0
            ? '<div style="padding:20px;text-align:center;color:var(--text2)">No failed tasks — all good!</div>'
            : `<table class="dash-table">
                <thead><tr><th style="width:40%">Name</th><th style="width:28%">Last Run</th><th style="width:32%">Error</th></tr></thead>
                <tbody>${recentlyFailed.map(t => `
                  <tr>
                    <td title="${escHtml(t.name)}">${escHtml(t.name)}</td>
                    <td title="${escHtml(t.last_run)}">${escHtml(fmtDate(t.last_run))}</td>
                    <td class="result-error" title="${escHtml(t.last_result)}">${escHtml(t.last_result)}</td>
                  </tr>`).join('')}
                </tbody></table>
              <button class="btn" style="margin-top:8px" onclick="showPage('tasks')">View All</button>`}
        </div>
      </div>
      ${(() => {
        // Phase 1: surface invisibly-broken tasks (enabled but unfireable due
        // to empty trigger masks, past-due Once triggers that never ran, etc.)
        const broken = findInvisiblyBrokenTasks(tasks);
        if (broken.length === 0) return '';  // hide the card entirely if nothing to show
        return `
        <div class="dash-card" style="margin-top:16px;border-color:rgba(245,158,11,.34)">
          <div class="dash-card-title" style="color:var(--yellow)">⚠ Tasks That Won't Fire (${broken.length})</div>
          <div style="font-size:12px;color:var(--text3);margin-bottom:10px">These tasks are enabled and have no failures recorded, but their trigger settings mean they can never run as configured.</div>
          <table class="dash-table">
            <thead><tr><th style="width:34%">Name</th><th style="width:32%">Reason</th><th style="width:34%">Advice</th></tr></thead>
            <tbody>
              ${broken.slice(0, 10).map(({ task, reason, advice }) => `
                <tr style="cursor:pointer" onclick="openEditDialog(${escHtml(JSON.stringify(task.path))})" title="Click to edit">
                  <td title="${escHtml(task.name)}">${escHtml(task.name)}</td>
                  <td title="${escHtml(reason)}" style="color:var(--yellow)">${escHtml(reason)}</td>
                  <td title="${escHtml(advice)}" style="color:var(--text3);font-size:12px">${escHtml(advice)}</td>
                </tr>`).join('')}
            </tbody>
          </table>
          ${broken.length > 10 ? `<div style="font-size:11px;color:var(--text3);margin-top:8px">…and ${broken.length - 10} more</div>` : ''}
        </div>`;
      })()}
      ${renderTimelineCard(tasks)}
      ${renderConflictsCard(tasks)}
      ${fpRenderDriftCard(tasks)}
      <div class="dash-card fp-digest-card" style="margin-top:16px">
        <div class="dash-card-title">🌙 While You Were Away <span style="font-weight:400;font-size:11px;color:var(--text3);text-transform:none;letter-spacing:0">— last 24 hours</span></div>
        <div id="fp-dash-digest"></div>
      </div>`;
    // Populate the digest without blocking paint, and defer it briefly so its
    // (cached) Event Log read never competes with the initial get_all_tasks /
    // first render. Subsequent 30s dashboard refreshes hit the 5-min cache, so
    // PowerShell is spawned at most once every 5 minutes, not every 30 seconds.
    if (typeof fpRenderDigestInto === 'function') {
      setTimeout(() => {
        if (currentPage === 'dashboard' && document.getElementById('fp-dash-digest')) {
          fpRenderDigestInto('fp-dash-digest', 24);
        }
      }, 600);
    }
    setStatus('Loaded ' + total + ' total tasks');
    // Honor the user's auto-refresh preference: previously the dashboard
    // re-walked every task via COM on a fixed 30s cadence even when the user
    // turned auto-refresh OFF. Gate on settings.autoRefresh and reuse the same
    // interval the rest of the app uses. (audit 2026-06-19)
    if (settings.autoRefresh) {
      const ms = Math.max(5, (settings.refreshInterval || 30)) * 1000;
      _dashboardRefreshTimer = setTimeout(() => {
        if (currentPage === 'dashboard' && !_appHidden) loadDashboard();
      }, ms);
    }
  } catch (err) {
    const c = document.getElementById('dash-content');
    if (c) c.innerHTML = `<div style="color:var(--red);padding:16px">Failed to load dashboard: ${escHtml(String(err))}</div>`;
    setStatus('Error loading dashboard');
    derror('loadDashboard', 'failed', { err: String(err) });   // ensure it lands in the file log, not just console.debug
    showToast('Dashboard error: ' + err, 'error');
  }
};

function goToFailedTasks() {
  showPage('tasks');
  const sel = document.getElementById('status-filter');
  if (sel) { sel.value = 'Failed'; filterTasks(); }
}

// ── Helpers for timeline + conflict detection (Phase 2) ─────────────────────
// Project the next firings for a TaskInfo over a window of N hours. We adapt
// the TaskInfo's bitmask fields to the formState shape that computeNextFirings
// wants. Returns an array of Date objects within [now, now + windowHours].
function taskFiringsFromInfo(task, windowHours, count = 12) {
    if (!task.enabled) return [];
    const tt = task.trigger_type || '';
    if (!tt) return [];

    // Convert bitmask fields to label arrays (the shape computeNextFirings
    // already accepts via the form path).
    const dowNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    const moyNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const daysOfWeek = [];
    for (let i = 0; i < 7; i++) {
        if ((task.trigger_days_of_week | 0) & (1 << i)) daysOfWeek.push(dowNames[i]);
    }
    const monthsOfYear = [];
    for (let i = 0; i < 12; i++) {
        if ((task.trigger_months | 0) & (1 << i)) monthsOfYear.push(moyNames[i]);
    }
    const daysOfMonth = [];
    for (let i = 0; i < 31; i++) {
        if ((task.trigger_days_of_month | 0) & (1 << i)) daysOfMonth.push(i + 1);
    }

    // Interval triggers store value/unit in the engine differently; we use
    // trigger_interval as a generic "every N units" with unit defaulting to
    // hours (covers the common case).
    const formState = {
        triggerType: tt,
        startDateTime: task.trigger_start || '',
        daysInterval: task.trigger_interval || 1,
        daysOfWeek,
        daysOfMonth,
        monthsOfYear,
        intervalValue: task.trigger_interval || 1,
        intervalUnit: 'Hours',
        intervalStartTime: '',
        idleMinutes: task.trigger_interval || 10,
    };

    const all = computeNextFirings(formState, count);
    if (!all || all.length === 0) return [];

    // Filter to [now, now + windowHours]
    const cutoff = new Date(Date.now() + windowHours * 3_600_000);
    return all.filter(d => d > new Date() && d <= cutoff);
}

// ── Timeline card (Phase 2) ─────────────────────────────────────────────────
// SVG-based 24h timeline showing every projected task firing as a dot on a
// horizontal axis. Each lane is a task with at least one firing in window.
// X-axis: now → +24h with hour ticks. Hover any dot for time + task name.
//
// Why SVG and not HTML/CSS positioning? SVG renders crisply at all scales
// and gives us hover targets per dot for free via <title>. The whole card
// is ~3KB of markup even for 50 firings.
function renderTimelineCard(tasks) {
    const HOURS = 24;
    const WIDTH = 720;
    const LEFT_LABELS = 160;
    const TIMELINE_W = WIDTH - LEFT_LABELS - 20;
    const ROW_H = 22;

    const taskFirings = [];
    for (const t of tasks) {
        const firings = taskFiringsFromInfo(t, HOURS, 30);
        if (firings.length > 0) taskFirings.push({ task: t, firings });
    }

    if (taskFirings.length === 0) {
        return `
            <div class="dash-card" style="margin-top:16px">
              <div class="dash-card-title">📅 Next 24 Hours</div>
              <div style="padding:18px;text-align:center;color:var(--text2);font-size:13px">
                No deterministic firings scheduled in the next 24 hours.
                <div style="font-size:11px;color:var(--text3);margin-top:6px">Event-driven triggers (boot, logon, idle) aren't shown here — only time-based triggers.</div>
              </div>
            </div>`;
    }

    // Sort by first firing time so the lanes read top-to-bottom in
    // chronological order — easier to scan than alphabetical.
    taskFirings.sort((a, b) => a.firings[0].getTime() - b.firings[0].getTime());

    // Limit to top 12 lanes to keep the card compact. If there are more,
    // we show a "and N more lanes" footnote.
    const MAX_LANES = 12;
    const shown = taskFirings.slice(0, MAX_LANES);
    const overflow = taskFirings.length - shown.length;

    const HEIGHT = shown.length * ROW_H + 40;
    const now = Date.now();
    const cutoff = now + HOURS * 3_600_000;
    const tToX = (d) => LEFT_LABELS + ((d.getTime() - now) / (cutoff - now)) * TIMELINE_W;

    // Hour ticks every 4 hours, label every 8 hours
    const ticks = [];
    for (let h = 0; h <= HOURS; h += 4) {
        const x = LEFT_LABELS + (h / HOURS) * TIMELINE_W;
        const showLabel = h % 8 === 0;
        const labelTime = new Date(now + h * 3_600_000);
        const labelText = h === 0
            ? 'now'
            : labelTime.toLocaleTimeString(undefined, {hour: '2-digit', minute: '2-digit', hour12: false});
        ticks.push({ x, h, showLabel, labelText });
    }

    const lanes = shown.map((entry, i) => {
        const y = 28 + i * ROW_H;
        const labelText = entry.task.name.length > 20
            ? entry.task.name.slice(0, 19) + '…'
            : entry.task.name;
        const dots = entry.firings.map(d => {
            const x = tToX(d);
            const timeStr = d.toLocaleString(undefined, {
                month: 'short', day: 'numeric',
                hour: '2-digit', minute: '2-digit', hour12: false,
            });
            return `<circle cx="${x.toFixed(1)}" cy="${y}" r="4" fill="var(--accent)" stroke="var(--bg2)" stroke-width="1.5">
                <title>${escHtml(entry.task.name)} — ${escHtml(timeStr)}</title>
            </circle>`;
        }).join('');
        return `
            <text x="${LEFT_LABELS - 8}" y="${y + 4}" text-anchor="end" font-size="11.5" font-family="-apple-system,Segoe UI,sans-serif" fill="var(--text2)" style="cursor:pointer" data-task-path="${escHtml(entry.task.path)}">
              <title>${escHtml(entry.task.name)}</title>${escHtml(labelText)}
            </text>
            <line x1="${LEFT_LABELS}" y1="${y}" x2="${LEFT_LABELS + TIMELINE_W}" y2="${y}" stroke="var(--border)" stroke-width="0.5" stroke-dasharray="2,3"/>
            ${dots}`;
    }).join('');

    return `
        <div class="dash-card" style="margin-top:16px">
          <div class="dash-card-title">📅 Next 24 Hours <span style="font-weight:400;font-size:11px;color:var(--text3);text-transform:none;letter-spacing:0;margin-left:8px">— ${taskFirings.length} task${taskFirings.length === 1 ? '' : 's'} with scheduled firings</span></div>
          <svg viewBox="0 0 ${WIDTH} ${HEIGHT}" style="width:100%;max-width:${WIDTH}px;height:auto;display:block;margin:8px auto" xmlns="http://www.w3.org/2000/svg">
            ${ticks.map(t => `
              <line x1="${t.x}" y1="22" x2="${t.x}" y2="${HEIGHT - 12}" stroke="${t.h === 0 ? 'var(--accent)' : 'var(--border)'}" stroke-width="${t.h === 0 ? '1' : '0.5'}"/>
              ${t.showLabel ? `<text x="${t.x}" y="14" text-anchor="middle" font-size="10" font-family="-apple-system,Segoe UI,sans-serif" fill="var(--text3)">${escHtml(t.labelText)}</text>` : ''}
            `).join('')}
            ${lanes}
          </svg>
          ${overflow > 0 ? `<div style="font-size:11px;color:var(--text3);text-align:center;margin-top:4px">…and ${overflow} more task${overflow === 1 ? '' : 's'} not shown</div>` : ''}
        </div>`;
}

// ── Conflict detection (Phase 2) ────────────────────────────────────────────
// Find pairs of tasks that fire within CONFLICT_WINDOW seconds of each other.
// Useful for catching "I just scheduled two heavy tasks at 3am and they'll
// fight for CPU/disk" before it becomes a problem.
//
// Algorithm: for each task, compute next 5 firings within 7 days. Build a
// sorted timeline of (timestamp, task) entries. Sliding-window scan: any two
// entries within the window threshold = a conflict pair.
//
// We deliberately don't try to detect "memory contention" or "they touch
// the same files" — that requires deep program understanding we don't
// have. Just temporal proximity, which is what the user can fix by
// adjusting trigger times.
const CONFLICT_WINDOW_SEC = 30;
const CONFLICT_PROJECTION_DAYS = 7;

function findScheduleConflicts(tasks) {
    const entries = [];   // [{ time: Date, task: TaskInfo }]
    for (const t of tasks) {
        if (!t.enabled) continue;
        const firings = taskFiringsFromInfo(t, CONFLICT_PROJECTION_DAYS * 24, 5);
        for (const f of firings) entries.push({ time: f, task: t });
    }
    entries.sort((a, b) => a.time.getTime() - b.time.getTime());

    const conflicts = [];
    for (let i = 0; i < entries.length; i++) {
        for (let j = i + 1; j < entries.length; j++) {
            const dt = entries[j].time.getTime() - entries[i].time.getTime();
            if (dt > CONFLICT_WINDOW_SEC * 1000) break;
            // Skip "task colliding with itself" (different firings of same task)
            if (entries[i].task.path === entries[j].task.path) continue;
            conflicts.push({
                t1: entries[i].task,
                t2: entries[j].task,
                time1: entries[i].time,
                time2: entries[j].time,
                gapSec: dt / 1000,
            });
        }
    }
    return conflicts;
}

function renderConflictsCard(tasks) {
    const conflicts = findScheduleConflicts(tasks);
    if (conflicts.length === 0) return '';

    // De-duplicate by task pair — show each pair only once even if they
    // collide on multiple days. Keep the soonest collision time as representative.
    const seen = new Map();
    for (const c of conflicts) {
        const key = [c.t1.path, c.t2.path].sort().join('|||');
        if (!seen.has(key) || seen.get(key).time1 > c.time1) {
            seen.set(key, c);
        }
    }
    const unique = [...seen.values()].sort((a, b) => a.time1 - b.time1);

    const fmtDt = (d) => d.toLocaleString(undefined, {
        weekday: 'short', month: 'short', day: 'numeric',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    });

    return `
        <div class="dash-card" style="margin-top:16px;border-color:rgba(245,158,11,.34)">
          <div class="dash-card-title" style="color:var(--yellow)">⚡ Schedule Conflicts (${unique.length})</div>
          <div style="font-size:12px;color:var(--text3);margin-bottom:10px">Pairs of tasks scheduled to fire within ${CONFLICT_WINDOW_SEC} seconds of each other in the next ${CONFLICT_PROJECTION_DAYS} days. Concurrent execution can cause CPU/disk/memory contention.</div>
          <table class="dash-table">
            <thead><tr><th style="width:30%">Task A</th><th style="width:30%">Task B</th><th style="width:25%">Collision</th><th style="width:15%">Gap</th></tr></thead>
            <tbody>
              ${unique.slice(0, 10).map(({ t1, t2, time1, gapSec }) => `
                <tr>
                  <td title="${escHtml(t1.path)}" style="cursor:pointer" onclick="openEditDialog(${escHtml(JSON.stringify(t1.path))})">${escHtml(t1.name)}</td>
                  <td title="${escHtml(t2.path)}" style="cursor:pointer" onclick="openEditDialog(${escHtml(JSON.stringify(t2.path))})">${escHtml(t2.name)}</td>
                  <td style="color:var(--text2);font-family:'Cascadia Code',Consolas,monospace;font-size:11.5px">${escHtml(fmtDt(time1))}</td>
                  <td style="color:var(--yellow)">${gapSec.toFixed(1)}s</td>
                </tr>`).join('')}
            </tbody>
          </table>
          ${unique.length > 10 ? `<div style="font-size:11px;color:var(--text3);margin-top:8px">…and ${unique.length - 10} more</div>` : ''}
        </div>`;
}

// ════════════════════════════════════════════════════════════════════════════════
// FEATURE: Light / dark theme toggle
// ════════════════════════════════════════════════════════════════════════════════
let _isLightTheme = false;

function toggleTheme() {
  _isLightTheme = !_isLightTheme;
  applyTheme(_isLightTheme);
  try { localStorage.setItem('wtp_theme', _isLightTheme ? 'light' : 'dark'); } catch (_) {}
}

function applyTheme(light) {
  const root = document.documentElement;
  // Toggle a class so CSS can override the values that are NOT among the 16
  // inline variables below — hover overlays, focus ring, scrollbar, and the
  // badge/info/xml status foregrounds — plus clear the dark boot background.
  // (audit 2026-06-19: light theme was partially broken without this.)
  root.classList.toggle('theme-light', !!light);
  if (light) {
    root.style.setProperty('--bg0',    '#e8eaf2');
    root.style.setProperty('--bg',     '#f0f2f9');
    root.style.setProperty('--bg2',    '#ffffff');
    root.style.setProperty('--bg3',    '#edf0f7');
    root.style.setProperty('--bg4',    '#e2e6f0');
    root.style.setProperty('--border', '#d0d5e8');
    root.style.setProperty('--border2','#bcc5dc');
    root.style.setProperty('--text',   '#1e2340');
    root.style.setProperty('--text2',  '#4a5275');
    root.style.setProperty('--text3',  '#8892b0');
    root.style.setProperty('--accent', '#2563eb');
    root.style.setProperty('--accent-glow', 'rgba(37,99,235,.15)');
    root.style.setProperty('--green',  '#059669');
    root.style.setProperty('--red',    '#dc2626');
    root.style.setProperty('--red-bg', 'rgba(220,38,38,.1)');
    root.style.setProperty('--yellow', '#d97706');
  } else {
    // UX (Unreleased): the dark branch previously SET specific hex values that
    // were subtly different from :root in style.css (e.g. --bg2 was #111422 here
    // vs #0f1220 in :root; --text3 was #535e7a vs #48547a). The drift was below
    // perception threshold but meant a light→dark toggle landed on a different
    // palette than initial load.
    //
    // Fix: clear the inline overrides so the cascade falls back to :root in
    // style.css. :root is now the single source of truth for the dark palette;
    // designers edit one place. The 16 properties below are exactly the ones
    // the light branch overrides — same list, mirrored.
    root.style.removeProperty('--bg0');
    root.style.removeProperty('--bg');
    root.style.removeProperty('--bg2');
    root.style.removeProperty('--bg3');
    root.style.removeProperty('--bg4');
    root.style.removeProperty('--border');
    root.style.removeProperty('--border2');
    root.style.removeProperty('--text');
    root.style.removeProperty('--text2');
    root.style.removeProperty('--text3');
    root.style.removeProperty('--accent');
    root.style.removeProperty('--accent-glow');
    root.style.removeProperty('--green');
    root.style.removeProperty('--red');
    root.style.removeProperty('--red-bg');
    root.style.removeProperty('--yellow');
  }
  const btn = document.getElementById('theme-toggle-btn');
  if (btn) btn.textContent = light ? '🌙' : '☀';
}

// ════════════════════════════════════════════════════════════════════════════════
// FEATURE: CSV / JSON export of task list
// ════════════════════════════════════════════════════════════════════════════════
function exportTasksCsv() {
  if (!allTasks.length) { showToast('No tasks to export', 'error'); return; }
  const tasks = filteredTasks.length ? filteredTasks : allTasks;
  const esc = csvCell;  // formula-injection-guarded (audit 2026-06-11)
  const header = 'Name,Path,Folder,Status,Triggers,Action,Last Run,Next Run,Last Result,Enabled,Hidden\n';
  const rows = tasks.map(t => [
    esc(t.name), esc(t.path), esc(t.folder), esc(t.status),
    esc((t.triggers || []).join('; ')),
    esc((t.actions  || []).join('; ')),
    esc(t.last_run), esc(t.next_run), esc(t.last_result),
    esc(t.enabled ? 'Yes' : 'No'), esc(t.hidden ? 'Yes' : 'No'),
  ].join(',')).join('\n');
  const blob = new Blob([header + rows], { type: 'text/csv;charset=utf-8' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url;
  a.download = 'wintaskpro-tasks-' + new Date().toISOString().slice(0,10) + '.csv';
  document.body.appendChild(a); a.click();
  document.body.removeChild(a); URL.revokeObjectURL(url);
  showToast(`Exported ${tasks.length} tasks as CSV`, 'success');
  appendAuditLog('export_csv', `${tasks.length} tasks`, '');
}

function exportTasksJson() {
  if (!allTasks.length) { showToast('No tasks to export', 'error'); return; }
  const tasks = filteredTasks.length ? filteredTasks : allTasks;
  const blob = new Blob([JSON.stringify(tasks, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url;
  a.download = 'wintaskpro-tasks-' + new Date().toISOString().slice(0,10) + '.json';
  document.body.appendChild(a); a.click();
  document.body.removeChild(a); URL.revokeObjectURL(url);
  showToast(`Exported ${tasks.length} tasks as JSON`, 'success');
  appendAuditLog('export_json', `${tasks.length} tasks`, '');
}

// ════════════════════════════════════════════════════════════════════════════════
// FEATURE: Task tags / labels (stored in localStorage, purely client-side)
// ════════════════════════════════════════════════════════════════════════════════
let _taskTags = {};   // { [taskPath]: ['tag1','tag2'] }
const TAG_COLORS = ['#4f8ef7','#10b981','#f59e0b','#ef4444','#a78bfa','#06b6d4','#f97316','#ec4899'];

function loadTags() {
  try {
    _taskTags = JSON.parse(localStorage.getItem('wtp_tags') || '{}');
  } catch (err) {
    _taskTags = {};
    dwarn('tags', 'wtp_tags parse failed; resetting', { err: String(err) });
    try { localStorage.removeItem('wtp_tags'); } catch (_) {}
  }
}

function saveTags() {
  try {
    localStorage.setItem('wtp_tags', JSON.stringify(_taskTags));
  } catch (err) {
    // Likely localStorage quota exceeded — log so user knows why tags aren't
    // persisting across restarts.
    dwarn('tags', 'saveTags failed', { err: String(err), tagCount: Object.keys(_taskTags).length });
  }
}

function getTagsForTask(path) { return _taskTags[path] || []; }

function addTagToTask(path, tag) {
  if (!tag.trim()) return;
  const tags = getTagsForTask(path);
  if (!tags.includes(tag.trim())) {
    _taskTags[path] = [...tags, tag.trim()];
    saveTags();
  }
}

function removeTagFromTask(path, tag) {
  const tags = getTagsForTask(path);
  _taskTags[path] = tags.filter(t => t !== tag);
  if (!_taskTags[path].length) delete _taskTags[path];
  saveTags();
}

function allTagsList() {
  const set = new Set();
  Object.values(_taskTags).forEach(tags => tags.forEach(t => set.add(t)));
  return [...set].sort();
}

function renderTagChips(path, containerId) {
  const container = document.getElementById(containerId);
  if (!container) return;
  const tags = getTagsForTask(path);
  container.innerHTML = tags.map((tag, i) => {
    const color = TAG_COLORS[Math.abs(tag.split('').reduce((a, c) => a + c.charCodeAt(0), 0)) % TAG_COLORS.length];
    return `<span class="tag-chip" style="--tag-color:${color}">
      ${escHtml(tag)}
      <button class="tag-chip-remove" data-tag="${escHtml(tag)}" title="Remove tag">×</button>
    </span>`;
  }).join('') + `<button class="btn btn-sm" id="add-tag-btn-${containerId}" style="padding:2px 8px;font-size:10px">+ Tag</button>`;

  // Wire remove buttons
  container.querySelectorAll('.tag-chip-remove').forEach(btn => {
    btn.onclick = e => {
      e.stopPropagation();
      removeTagFromTask(path, btn.dataset.tag);
      renderTagChips(path, containerId);
    };
  });
  // Wire add button
  const addBtn = container.querySelector(`#add-tag-btn-${containerId}`);
  if (addBtn) addBtn.onclick = () => openAddTagDialog(path, containerId);
}

function openAddTagDialog(path, containerId) {
  const existing = allTagsList();
  const suggestions = existing.length
    ? `<div style="margin-top:8px;font-size:11px;color:var(--text3)">Existing tags:</div>
       <div style="display:flex;gap:5px;flex-wrap:wrap;margin-top:4px">
         ${existing.map(t => `<button class="tag-chip-suggestion" data-tag="${escHtml(t)}">${escHtml(t)}</button>`).join('')}
       </div>`
    : '';
  openModal('🏷 Add Tag',
    `<div style="padding:8px 0">
       <div class="form-group">
         <label>Tag name</label>
         <input type="text" id="new-tag-input" class="form-control" placeholder="e.g. backup, nightly, critical" />
       </div>
       ${suggestions}
     </div>`,
    `<button class="btn btn-primary" id="add-tag-ok">Add</button>
     <button class="btn" onclick="closeModal()">Cancel</button>`);
  requestAnimationFrame(() => {
    document.getElementById('new-tag-input')?.focus();
    const okBtn = document.getElementById('add-tag-ok');
    if (okBtn) okBtn.onclick = () => {
      const tag = document.getElementById('new-tag-input')?.value.trim();
      if (tag) { addTagToTask(path, tag); closeModal(); renderTagChips(path, containerId); }
    };
    document.querySelectorAll('.tag-chip-suggestion').forEach(btn => {
      btn.onclick = () => {
        const tag = btn.dataset.tag;
        addTagToTask(path, tag); closeModal(); renderTagChips(path, containerId);
      };
    });
  });
}

// ════════════════════════════════════════════════════════════════════════════════
// FEATURE: Quick "Run with args" dialog
// ════════════════════════════════════════════════════════════════════════════════
// ════════════════════════════════════════════════════════════════════════════════
// FEATURE: Delete folder
// ════════════════════════════════════════════════════════════════════════════════
function openDeleteFolderDialog(folderPath) {
  openModal('🗑 Delete Folder',
    `<div style="padding:16px 16px 8px">
       <div style="font-size:15px;font-weight:700;color:var(--red);margin-bottom:6px">${escHtml(folderPath)}</div>
       <p style="font-size:13px;color:var(--text2)">Delete this folder and <strong>all tasks inside it</strong>? This cannot be undone.</p>
       <p style="font-size:11px;color:var(--text3);margin-top:8px">Tasks inside the folder will be deleted first, then the folder.</p>
     </div>`,
    `<button class="btn" id="delfolder-cancel">Cancel</button>
     <button class="btn btn-danger" id="delfolder-ok">🗑 Delete Folder</button>`);
  requestAnimationFrame(() => {
    document.getElementById('delfolder-cancel')?.addEventListener('click', closeModal);
    const okBtn = document.getElementById('delfolder-ok');
    if (okBtn) okBtn.onclick = async () => {
      closeModal();
      try {
        // Delete all tasks in this folder first (Windows requires empty folder)
        let tasks = [];
        try {
          tasks = await invoke('get_tasks', { folder: folderPath });
        } catch (err) {
          dwarn('delete_folder', 'enumerate failed; proceeding to folder delete anyway',
                { folder: folderPath, err: String(err) });
        }
        let taskFails = 0;
        for (const t of tasks) {
          try {
            await invoke('delete_task', { path: t.path });
          } catch (err) {
            taskFails++;
            dwarn('delete_folder', 'child task delete failed',
                  { folder: folderPath, task: t.path, err: String(err) });
          }
        }
        if (taskFails > 0) {
          // The folder delete will likely fail because non-empty — surface to user.
          dwarn('delete_folder', 'aborting due to child task failures',
                { folder: folderPath, taskFails, total: tasks.length });
          showToast(`Could not delete ${taskFails} of ${tasks.length} tasks; folder not removed`, 'error');
          return;
        }
        await invoke('delete_folder', { path: folderPath });
        dinfo('delete_folder', 'success', { folder: folderPath, taskCount: tasks.length });
        appendAuditLog('delete_folder', folderPath, `${tasks.length} tasks deleted`);
        showToast('Folder deleted', 'success');
        if (selectedFolder === folderPath) { selectedFolder = null; }
        await refreshFolders();
        await loadTasksForFolder(selectedFolder);
      } catch (err) {
        derror('delete_folder', 'failed', { folder: folderPath, err: String(err) });
        showToast('Delete folder failed: ' + err, 'error');
      }
    };
  });
}


// ════════════════════════════════════════════════════════════════════════════════
// FEATURE: Real Event Log execution history
// ════════════════════════════════════════════════════════════════════════════════
// ── Task statistics over time (Phase 4 feature) ─────────────────────────────
// Computes derivable metrics from `get_task_history` records:
//   - Run count over the last 30 days
//   - Success rate (% of runs with result_code === 0)
//   - Average duration in seconds (excluding result_code === RUNNING)
//   - Median duration (less skew-prone than mean for fat-tailed distros)
//   - Most-recent failure (timestamp + result text), if any
//   - Day-of-week histogram (which days does this task usually run?)
//
// Pure JS over the records array — no new IPC needed. The records come from
// the existing `get_task_history` call which already counts toward the
// detail panel's history loading.
//
// Tradeoffs:
//   - We're limited to whatever get_task_history returns (currently capped
//     at 20-200 records). Long histories beyond that aren't represented.
//   - duration_secs is from the Run engine's own tracking. Tasks that
//     time out and get killed by the scheduler may have inflated durations.
//   - Day-of-week histogram is biased by the fixed sample size — a task
//     that runs hourly will have ~equal distribution; a task that runs once
//     a week will look concentrated.
function computeTaskStats(records) {
    if (!records || records.length === 0) return null;

    const now = Date.now();
    const dayMs = 86_400_000;
    const last30dCutoff = now - 30 * dayMs;

    // Filter records that have a parseable start_time. The scheduler engine
    // returns ISO-ish strings; Date.parse copes with most variants.
    const withTime = records
        .map(r => ({ ...r, ts: Date.parse(r.start_time) }))
        .filter(r => !isNaN(r.ts));

    const last30d = withTime.filter(r => r.ts >= last30dCutoff);
    const total   = withTime.length;
    const total30 = last30d.length;

    // Success counting. result_code === 0 is the canonical success.
    // result_code === TASK_RESULT_RUNNING is "still running" — neither
    // success nor failure for stats purposes, exclude from the rate.
    const completed = withTime.filter(r => r.result_code !== TASK_RESULT_RUNNING);
    const successes = completed.filter(r => r.result_code === 0);
    const successRate = completed.length > 0
        ? (successes.length / completed.length) * 100
        : null;

    // Duration stats — only include records with a numeric duration > 0
    // and result_code !== RUNNING (running ones don't have a final
    // duration yet).
    const durations = completed
        .map(r => parseFloat(r.duration_secs))
        .filter(d => !isNaN(d) && d > 0)
        .sort((a, b) => a - b);
    const avgDuration = durations.length > 0
        ? durations.reduce((s, d) => s + d, 0) / durations.length
        : null;
    const medianDuration = durations.length > 0
        ? durations[Math.floor(durations.length / 2)]
        : null;

    // Most recent failure
    const recentFail = withTime
        .filter(r => r.result_code !== 0 && r.result_code !== TASK_RESULT_RUNNING && r.result_code !== TASK_RESULT_NOT_RUN)
        .sort((a, b) => b.ts - a.ts)[0] || null;

    // Day-of-week histogram (Sun=0..Sat=6)
    const dowCounts = [0, 0, 0, 0, 0, 0, 0];
    for (const r of withTime) dowCounts[new Date(r.ts).getDay()]++;
    const dowMax = Math.max(...dowCounts);

    return {
        total,
        total30,
        successRate,
        avgDuration,
        medianDuration,
        durationCount: durations.length,
        recentFail,
        dowCounts,
        dowMax,
        oldestRecord: withTime.length > 0
            ? new Date(Math.min(...withTime.map(r => r.ts)))
            : null,
        newestRecord: withTime.length > 0
            ? new Date(Math.max(...withTime.map(r => r.ts)))
            : null,
    };
}

function renderTaskStats(records) {
    const stats = computeTaskStats(records);
    if (!stats) {
        return `<div style="color:var(--text3);font-style:italic;padding:14px;text-align:center;font-size:12.5px">No history records to compute statistics from. The Windows Event Log for the Task Scheduler may be empty or filtered.</div>`;
    }

    const fmtPct = (n) => n === null ? '—' : `${n.toFixed(1)}%`;
    const fmtDur = (n) => {
        if (n === null) return '—';
        if (n < 1)    return `<1s`;
        if (n < 60)   return `${n.toFixed(1)}s`;
        if (n < 3600) return `${(n/60).toFixed(1)}m`;
        return `${(n/3600).toFixed(1)}h`;
    };
    const fmtDate = (d) => d ? d.toLocaleDateString(undefined, {month:'short', day:'numeric', year:'numeric'}) : '—';

    // Determine success-rate color band
    const sRate = stats.successRate;
    const sColor = sRate === null ? 'var(--text3)'
                 : sRate >= 95 ? 'var(--green)'
                 : sRate >= 75 ? 'var(--yellow)'
                 : 'var(--red)';

    // DoW histogram bars
    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const dowBars = stats.dowCounts.map((count, i) => {
        const heightPct = stats.dowMax > 0 ? (count / stats.dowMax) * 100 : 0;
        return `
            <div style="display:flex;flex-direction:column;align-items:center;gap:3px;flex:1">
              <div style="height:50px;width:100%;display:flex;align-items:flex-end;justify-content:center">
                <div style="width:80%;background:var(--accent);border-radius:2px 2px 0 0;height:${heightPct}%;min-height:${count > 0 ? 2 : 0}px" title="${count} run${count === 1 ? '' : 's'} on ${dayNames[i]}"></div>
              </div>
              <div style="font-size:10px;color:var(--text3);font-weight:600">${dayNames[i].slice(0,1)}</div>
              <div style="font-size:9px;color:var(--text3)">${count}</div>
            </div>`;
    }).join('');

    return `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:14px">
        <div style="background:var(--bg0);border:1px solid var(--border);border-radius:6px;padding:12px">
          <div style="font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:var(--text3);font-weight:700;margin-bottom:4px">Success Rate</div>
          <div style="font-size:24px;font-weight:600;color:${sColor}">${fmtPct(sRate)}</div>
          <div style="font-size:11px;color:var(--text3);margin-top:2px">${stats.durationCount} of ${stats.total} runs completed</div>
        </div>
        <div style="background:var(--bg0);border:1px solid var(--border);border-radius:6px;padding:12px">
          <div style="font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:var(--text3);font-weight:700;margin-bottom:4px">Avg Duration</div>
          <div style="font-size:24px;font-weight:600;color:var(--text)">${fmtDur(stats.avgDuration)}</div>
          <div style="font-size:11px;color:var(--text3);margin-top:2px">median ${fmtDur(stats.medianDuration)}</div>
        </div>
        <div style="background:var(--bg0);border:1px solid var(--border);border-radius:6px;padding:12px">
          <div style="font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:var(--text3);font-weight:700;margin-bottom:4px">Last 30 Days</div>
          <div style="font-size:24px;font-weight:600;color:var(--text)">${stats.total30}</div>
          <div style="font-size:11px;color:var(--text3);margin-top:2px">${stats.total} total in window</div>
        </div>
        <div style="background:var(--bg0);border:1px solid var(--border);border-radius:6px;padding:12px">
          <div style="font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:var(--text3);font-weight:700;margin-bottom:4px">Window</div>
          <div style="font-size:13px;font-weight:600;color:var(--text);line-height:1.3">${escHtml(fmtDate(stats.oldestRecord))} —<br>${escHtml(fmtDate(stats.newestRecord))}</div>
        </div>
      </div>
      <div style="background:var(--bg0);border:1px solid var(--border);border-radius:6px;padding:12px;margin-bottom:14px">
        <div style="font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:var(--text3);font-weight:700;margin-bottom:8px">Day of Week</div>
        <div style="display:flex;align-items:flex-end;gap:6px;height:80px">${dowBars}</div>
      </div>
      ${stats.recentFail ? `
        <div style="background:rgba(239,68,68,.04);border:1px solid rgba(239,68,68,.22);border-radius:6px;padding:10px 12px">
          <div style="font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:var(--red);font-weight:700;margin-bottom:4px">Most Recent Failure</div>
          <div style="font-size:12.5px;color:var(--text2)">${escHtml(stats.recentFail.start_time || '')} — <span style="color:var(--red)">${escHtml(stats.recentFail.result_text || '')}</span></div>
        </div>` : ''}`;
}


async function loadTaskHistory(taskPath) {
  const container = document.getElementById('task-history-container');
  const btn       = document.getElementById('load-history-btn');
  if (!container) return;
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Loading…'; }
  container.innerHTML = '<div style="color:var(--text3);font-size:11px;padding:4px 0">Querying Event Log…</div>';

  try {
    // Try real Event Log first
    const records = await invoke('get_event_log_history', { taskPath, maxRecords: 20 });
    if (btn) { btn.disabled = false; btn.textContent = '📋 Reload History'; }

    if (records && records.length > 0) {
      container.innerHTML = `
        <div style="font-size:9px;font-weight:700;color:var(--text3);text-transform:uppercase;letter-spacing:.08em;margin-bottom:4px">
          Last ${records.length} runs (Event Log)
        </div>
        <table class="detail-table" style="font-size:10px">
          <tr><th>Time</th><th>Result</th></tr>
          ${records.map(r => {
            const success = r.success === true || r.result === 0 || r.result === '0';
            const cls = success ? 'result-ok' : 'result-error';
            const icon = success ? '✓' : '✗';
            const resultText = success ? 'Success' : (typeof r.result === 'string' ? r.result : `Error (${r.result})`);
            return `<tr><td>${escHtml(r.time || '')}</td><td class="${cls}">${icon} ${escHtml(resultText)}</td></tr>`;
          }).join('')}
        </table>`;
    } else {
      // Fallback to scheduled run times
      await loadScheduledRunTimes(taskPath, container);
    }
  } catch (err) {
    // Event Log query failed — fall back to scheduled run times
    await loadScheduledRunTimes(taskPath, container);
    if (btn) { btn.disabled = false; btn.textContent = '📋 Reload History'; }
  }
}

async function loadScheduledRunTimes(taskPath, container) {
  try {
    const records = await invoke('get_task_history', { path: taskPath, maxRecords: 20 });
    if (records && records.length > 0) {
      container.innerHTML = `
        <div style="font-size:9px;font-weight:700;color:var(--text3);text-transform:uppercase;letter-spacing:.08em;margin-bottom:4px">
          Scheduled runs (next 90 days) — Event Log unavailable
        </div>
        <table class="detail-table" style="font-size:10px">
          <tr><th>Scheduled Time</th><th>Type</th></tr>
          ${records.map(r => `<tr><td>${escHtml(r.start_time || '')}</td><td style="color:var(--text3)">Scheduled</td></tr>`).join('')}
        </table>`;
    } else {
      container.innerHTML = '<div class="info-box" style="font-size:11px;margin-top:4px">No history available. The Task Scheduler event log may be disabled on this machine.<br><br>To enable: <code>eventvwr.msc</code> → Applications and Services Logs → Microsoft → Windows → TaskScheduler → Operational → Enable Log.</div>';
    }
  } catch (err) {
    derror('loadScheduledRunTimes', 'get_task_history failed', { taskPath, err: String(err) });
    container.innerHTML = '<div style="color:var(--text3);font-size:11px;padding:4px 0">History unavailable.</div>';
  }
}

// ════════════════════════════════════════════════════════════════════════════════
// FEATURE: Copy as PowerShell
// ════════════════════════════════════════════════════════════════════════════════
function copyAsPowerShell(task) {
  const trigger = (() => {
    switch ((task.trigger_type || '').toLowerCase()) {
      case 'daily':   return `New-ScheduledTaskTrigger -Daily -At "${task.trigger_start ? task.trigger_start.slice(11,16) : '08:00'}"`;
      case 'weekly':  return `New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday -At "${task.trigger_start ? task.trigger_start.slice(11,16) : '08:00'}"`;
      case 'once':    return `New-ScheduledTaskTrigger -Once -At "${task.trigger_start || '2026-01-01T08:00:00'}"`;
      case 'boot':    return `New-ScheduledTaskTrigger -AtStartup`;
      case 'logon':   return `New-ScheduledTaskTrigger -AtLogOn`;
      default:        return `New-ScheduledTaskTrigger -Daily -At "08:00"`;
    }
  })();

  const runAs = task.run_as_user || 'SYSTEM';
  const isSystem = runAs.toUpperCase() === 'SYSTEM' || runAs.toUpperCase().startsWith('NT AUTHORITY');
  const principalArgs = isSystem
    ? `-RunLevel Highest`
    : `-UserId "${runAs}" -RunLevel ${task.run_level === 1 ? 'Highest' : 'Limited'}`;

  const ps = `# Generated by WinTaskPro — ${new Date().toISOString().slice(0,10)}
# Task: ${task.path}

$action  = New-ScheduledTaskAction -Execute "${task.program_path || 'C:\\Windows\\System32\\cmd.exe'}"${task.program_args ? ` -Argument "${task.program_args}"` : ''}${task.working_dir ? ` -WorkingDirectory "${task.working_dir}"` : ''}
$trigger = ${trigger}
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Hours 1) -RestartCount 3
$principal = New-ScheduledTaskPrincipal ${principalArgs}

Register-ScheduledTask \\
  -TaskName "${task.name}" \\
  -TaskPath "${task.folder || '\\'}" \\
  -Action $action \\
  -Trigger $trigger \\
  -Settings $settings \\
  -Principal $principal \\
  -Description "${(task.description || '').replace(/"/g, "'")}" \\
  -Force`;

  navigator.clipboard.writeText(ps).then(() => {
    showToast('PowerShell script copied to clipboard', 'success');
  }).catch(() => {
    // Fallback: show in a modal
    openModal('PowerShell Script',
      `<div class="xml-box" style="max-height:360px">${escHtml(ps)}</div>`,
      `<button class="btn btn-primary" onclick="navigator.clipboard.writeText(${JSON.stringify(ps)}).then(()=>showToast('Copied','success'))">📋 Copy</button>
       <button class="btn" onclick="closeModal()">Close</button>`);
  });
}

// ════════════════════════════════════════════════════════════════════════════════
// FEATURE: Global search across all folders
// ════════════════════════════════════════════════════════════════════════════════
let _globalSearchActive = false;

async function toggleGlobalSearch() {
  _globalSearchActive = !_globalSearchActive;
  const btn = document.getElementById('global-search-btn');
  if (!btn) return;

  if (_globalSearchActive) {
    btn.classList.add('active');
    btn.title = 'Searching ALL folders — click to return to folder view';
    // Load all tasks regardless of folder
    try {
      const tasks = await invoke('get_all_tasks', { skipSystem: !settings.showSystemTasks });
      allTasks = tasks;
      filterTasks();
      renderTagFilterBar();
      showToast(`Searching all ${tasks.length} tasks`, 'info');
      updateStatusBar();
    } catch (err) {
      showToast('Global search failed: ' + err, 'error');
      _globalSearchActive = false;
      btn.classList.remove('active');
    }
  } else {
    btn.classList.remove('active');
    btn.title = 'Search across all folders';
    // Return to current folder
    await loadTasksForFolder(selectedFolder);
  }
}

// ════════════════════════════════════════════════════════════════════════════════
// FEATURE: Task notes / annotations (localStorage)
// ════════════════════════════════════════════════════════════════════════════════
let _taskNotes = {};

function loadNotes() {
  try {
    _taskNotes = JSON.parse(localStorage.getItem('wtp_notes') || '{}');
  } catch (err) {
    _taskNotes = {};
    dwarn('notes', 'wtp_notes parse failed; resetting', { err: String(err) });
    try { localStorage.removeItem('wtp_notes'); } catch (_) {}
  }
}

function saveNotes() {
  try {
    localStorage.setItem('wtp_notes', JSON.stringify(_taskNotes));
  } catch (err) {
    dwarn('notes', 'saveNotes failed', { err: String(err), noteCount: Object.keys(_taskNotes).length });
  }
}

function getNoteForTask(path) { return _taskNotes[path] || ''; }

function openNoteDialog(task) {
  const current = getNoteForTask(task.path);
  openModal('📝 Task Note',
    `<div style="padding:0 0 8px">
       <div style="font-size:12px;font-weight:600;margin-bottom:10px;color:var(--text2)">${escHtml(task.name)}</div>
       <div class="form-group">
         <label>Note</label>
         <textarea id="task-note-input" class="form-control" rows="5" placeholder="Add a note about this task… (stored locally, not in Windows Task Scheduler)">${escHtml(current)}</textarea>
       </div>
     </div>`,
    `<button class="btn btn-danger btn-sm" id="note-clear-btn" style="margin-right:auto">🗑 Clear</button>
     <button class="btn btn-primary" id="note-save-btn">💾 Save Note</button>
     <button class="btn" onclick="closeModal()">Cancel</button>`);
  requestAnimationFrame(() => {
    document.getElementById('task-note-input')?.focus();
    const saveBtn  = document.getElementById('note-save-btn');
    const clearBtn = document.getElementById('note-clear-btn');
    if (saveBtn) saveBtn.onclick = () => {
      const text = document.getElementById('task-note-input')?.value.trim() || '';
      if (text) { _taskNotes[task.path] = text; } else { delete _taskNotes[task.path]; }
      saveNotes();
      closeModal();
      // Re-open detail to refresh the notes section
      openDetail(task);
      showToast('Note saved', 'success');
    };
    if (clearBtn) clearBtn.onclick = () => {
      delete _taskNotes[task.path];
      saveNotes();
      closeModal();
      openDetail(task);
      showToast('Note cleared', 'success');
    };
  });
}

// ════════════════════════════════════════════════════════════════════════════════
// FEATURE: Process Manager — Expert Edition (Phase 5)
// ════════════════════════════════════════════════════════════════════════════════
//
// Architecture:
//   - One-time DOM build on first entry (renderProcessManagerShell)
//   - Subsequent refreshes diff process data and update rows in place
//     (refreshProcessData) — no innerHTML on the table body, so scroll
//     position is preserved and there's zero flicker between refreshes.
//   - Right-pane detail panel for the selected process, with tabs.
//   - Per-process CPU history kept in a circular buffer for sparkline.
//   - Tree mode toggleable: groups children under parents via parent_pid
//     edges, indented + collapse/expand chevrons.
//   - Watchlist persists in localStorage; pinned processes float to the top.
//   - Snapshot/diff: capture state into _procSnapshot, do something, then
//     toggle "Diff vs snapshot" to colorize new/dead/changed processes.
//
// Performance constraints:
//   - Refresh interval: 1.5s (was 3s). Faster feedback for "is this CPU
//     spike still happening" without breaking sysinfo's CPU delta math.
//   - Row count: hard cap at 1000 visible. Filter narrows beyond that.
//     Without virtualization, 1000 rows × 8 cells × 30 char each = ~240KB
//     of DOM, which the browser handles fine. Going beyond that we'd want
//     a windowed renderer; not necessary at 1000.
//   - CPU sparkline: 60 samples × 1 SVG path per selected process = trivial.
let _procRefreshInterval = null;
let _procSearch          = '';
let _procSortCol         = 'cpu_usage';
let _procSortDir         = -1;
let _procData            = [];          // last fetched ProcessInfo array
let _procPrevDataMap     = new Map();   // pid → ProcessInfo from previous refresh (for diffing/highlight)
let _procSystemOverview  = null;        // last fetched system-wide aggregate (cpu_pct, mem_used_bytes, etc.)
let _procSelectedPid     = null;        // currently-selected PID for detail pane
let _procDetailTab       = 'overview';
let _procTreeMode        = false;
let _procExpanded        = new Set();   // pids whose children are visible in tree mode
let _procFilterUser      = '';          // empty = all users
let _procFilterElevated  = false;       // show only elevated
let _procFilterSysHide   = false;       // hide system processes
let _procWatchlist       = new Set(loadProcWatchlist());
let _procCpuHistory      = new Map();   // pid → [60 samples]
let _procMemHistory      = new Map();   // pid → [60 samples] (working_set MB)
let _procIoHistory       = new Map();   // pid → [60 samples] (KB/s combined R+W)
let _procHandlesHistory  = new Map();   // pid → [60 samples]
const PROC_CPU_HISTORY_SIZE = 60;
let _procSnapshot        = null;        // snapshot mode {timestamp, byPid: Map}
let _procShellMounted    = false;
let _procDetailDataCache = { modules: null, connections: null, lastModulesPid: null, lastConnsPid: null };
const PROC_REFRESH_MS    = 1500;

// ── Column schema (Phase 5+) ────────────────────────────────────────────────
// Single source of truth for table columns. Adding/removing a column requires
// touching exactly this array — the header, body row, grid-template, and
// column picker all derive from it.
//
// `key`        — ProcessInfo field used for sorting + cell rendering
// `label`      — short header text
// `width`      — CSS grid-template-columns segment (px or fr)
// `align`      — 'left' | 'right' (numeric columns right-align)
// `sortable`   — clickable for sort
// `cell`       — function(p) returning innerHTML for the cell
// `default`    — visibility on first run (user preference overrides)
const PROC_COLUMNS = [
    { key: '_pin',     label: '',         width: '38px',  align: 'left',  sortable: false, default: true,
      cell: (p, ctx) => ctx.pinChevronStarHtml },
    { key: 'pid',      label: 'PID',      width: '74px',  align: 'left',  sortable: true,  default: true,
      cell: (p) => `<div style="color:var(--text3);font-size:11.5px;font-family:monospace">${p.pid}</div>` },
    { key: 'name',     label: 'Name / Command', width: '1fr', align: 'left', sortable: true, default: true,
      cell: (p, ctx) => ctx.nameCellHtml },
    { key: 'cpu_usage',     label: 'CPU %',  width: '68px',  align: 'right', sortable: true, default: true,
      cell: (p) => {
          const c = p.cpu_usage > 50 ? 'var(--red)' : p.cpu_usage > 10 ? 'var(--yellow)' : 'var(--text2)';
          return `<div style="text-align:right;color:${c};font-weight:${p.cpu_usage > 10 ? '600' : '400'};font-family:monospace;font-size:11.5px">${p.cpu_usage > 0 ? p.cpu_usage.toFixed(1) : '—'}</div>`;
      } },
    { key: 'mem_working_kb', label: 'Memory', width: '100px', align: 'right', sortable: true, default: true,
      cell: (p) => {
          const mb = p.mem_working_kb / 1024;
          const c = p.mem_working_kb > 500 * 1024 ? 'var(--yellow)' : 'var(--text2)';
          return `<div style="text-align:right;color:${c};font-family:monospace;font-size:11.5px">${mb.toFixed(0)} MB</div>`;
      } },
    { key: 'mem_private_kb', label: 'Private', width: '92px', align: 'right', sortable: true, default: false,
      cell: (p) => `<div style="text-align:right;color:var(--text3);font-family:monospace;font-size:11.5px">${(p.mem_private_kb / 1024).toFixed(0)} MB</div>` },
    { key: 'user',     label: 'User',     width: '110px', align: 'left',  sortable: true, default: true,
      cell: (p) => `<div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text3);font-size:11.5px" title="${escHtml(p.user || '')}">${escHtml(p.user || '—')}</div>` },
    { key: 'threads',  label: 'Threads',  width: '70px',  align: 'right', sortable: true, default: true,
      cell: (p) => `<div style="text-align:right;color:var(--text3);font-family:monospace;font-size:11.5px">${p.threads || '—'}</div>` },
    { key: 'handles',  label: 'Handles',  width: '78px',  align: 'right', sortable: true, default: true,
      cell: (p) => `<div style="text-align:right;color:var(--text3);font-family:monospace;font-size:11.5px">${p.handles || '—'}</div>` },
    { key: 'parent_pid',   label: 'Parent', width: '70px',  align: 'right', sortable: true, default: false,
      cell: (p) => `<div style="text-align:right;color:var(--text3);font-family:monospace;font-size:11.5px">${p.parent_pid || '—'}</div>` },
    { key: 'run_secs', label: 'Uptime',   width: '70px',  align: 'right', sortable: true, default: true,
      cell: (p) => {
          const s = p.run_secs || 0;
          let txt;
          if (!s) txt = '—';
          else if (s < 60) txt = `${s}s`;
          else if (s < 3600) txt = `${Math.floor(s/60)}m`;
          else if (s < 86400) txt = `${Math.floor(s/3600)}h`;
          else txt = `${Math.floor(s/86400)}d`;
          return `<div style="text-align:right;color:var(--text3);font-family:monospace;font-size:11.5px">${txt}</div>`;
      } },
    { key: 'disk_read_kb_s', label: 'I/O R', width: '70px', align: 'right', sortable: true, default: true,
      cell: (p) => {
          const r = p.disk_read_kb_s;
          const c = r > 1000 ? 'var(--yellow)' : 'var(--text3)';
          return `<div style="text-align:right;color:${c};font-family:monospace;font-size:11.5px">${r ? r : '—'}</div>`;
      } },
    { key: 'disk_write_kb_s', label: 'I/O W', width: '70px', align: 'right', sortable: true, default: true,
      cell: (p) => {
          const w = p.disk_write_kb_s;
          const c = w > 1000 ? 'var(--yellow)' : 'var(--text3)';
          return `<div style="text-align:right;color:${c};font-family:monospace;font-size:11.5px">${w ? w : '—'}</div>`;
      } },
    { key: 'status',   label: 'Status',   width: '78px',  align: 'left',  sortable: true, default: false,
      cell: (p) => `<div style="color:var(--text3);font-size:11.5px">${escHtml(p.status || '—')}</div>` },
];

// User-overridable visibility (persisted)
let _procColumnVis = loadProcColumnVis();

function loadProcColumnVis() {
    try {
        const raw = localStorage.getItem('wtp_proc_column_vis');
        if (raw) {
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === 'object') return parsed;
        }
    } catch (_) {}
    // First-run defaults from schema
    const out = {};
    for (const c of PROC_COLUMNS) out[c.key] = c.default;
    return out;
}

function saveProcColumnVis() {
    try { localStorage.setItem('wtp_proc_column_vis', JSON.stringify(_procColumnVis)); } catch (_) {}
}

function visibleProcColumns() {
    return PROC_COLUMNS.filter(c => _procColumnVis[c.key] !== false);
}

function procGridTemplate() {
    return visibleProcColumns().map(c => c.width).join(' ');
}

// ── Persistent process-manager state (Phase 5+) ─────────────────────────────
// Save and restore: sort column/direction, tree mode, filters. Reset-on-launch
// behavior was disorienting — users would set up a view and lose it on the
// next visit. localStorage now keeps these between sessions.
//
// Storage key: 'wtp_proc_state'. Schema:
//   { sortCol, sortDir, treeMode, filterUser, filterElevated, filterSysHide,
//     groupBy, highlightRules }
// Anything not in the saved object falls back to the in-code default.
const PROC_STATE_KEY = 'wtp_proc_state';

function loadProcStateFromStorage() {
    try {
        const raw = localStorage.getItem(PROC_STATE_KEY);
        if (!raw) return;
        const s = JSON.parse(raw);
        if (typeof s !== 'object' || !s) return;
        if (typeof s.sortCol === 'string')        _procSortCol = s.sortCol;
        if (typeof s.sortDir === 'number')        _procSortDir = s.sortDir;
        if (typeof s.treeMode === 'boolean')      _procTreeMode = s.treeMode;
        if (typeof s.filterUser === 'string')     _procFilterUser = s.filterUser;
        if (typeof s.filterElevated === 'boolean')_procFilterElevated = s.filterElevated;
        if (typeof s.filterSysHide === 'boolean') _procFilterSysHide = s.filterSysHide;
        if (typeof s.groupBy === 'string')        _procGroupBy = s.groupBy;
    } catch (_) {}
}

function saveProcStateToStorage() {
    try {
        localStorage.setItem(PROC_STATE_KEY, JSON.stringify({
            sortCol: _procSortCol,
            sortDir: _procSortDir,
            treeMode: _procTreeMode,
            filterUser: _procFilterUser,
            filterElevated: _procFilterElevated,
            filterSysHide: _procFilterSysHide,
            groupBy: _procGroupBy,
        }));
    } catch (_) {}
}

// ── Group-by mode (Phase 5+) ────────────────────────────────────────────────
// Beyond flat-list and tree, users sometimes want to ask "which user has
// the most processes?" or "show me everything elevated together". Group-by
// inserts collapsible group headers between rows, sorted by group size.
// Mutually exclusive with tree mode (we toggle treeMode off when group-by
// is set, and vice versa).
//
// 'none'      — no grouping
// 'user'      — group by the username field
// 'name'      — group by image name (e.g. all chrome.exe under one header)
// 'elevated'  — two groups: "Elevated" and "Standard"
let _procGroupBy = 'none';
let _procGroupCollapsed = new Set(); // group keys whose rows are hidden

// ── Highlight rules (Phase 5+) ──────────────────────────────────────────────
// User-customizable rule list. Each rule is matched against every process;
// the first matching rule wins. The rule's color is applied to the row
// background as a subtle tint.
//
// Built-in rules represent the previously-hardcoded thresholds (CPU>50% red).
// Users can add custom rules via the highlight-editor modal.
//
// Schema: { id, label, type: 'cpu'|'memory'|'name'|'user', op: '>'|'<'|'contains', value, color, enabled }
const PROC_HIGHLIGHT_KEY = 'wtp_proc_highlights';

function loadProcHighlights() {
    try {
        const raw = localStorage.getItem(PROC_HIGHLIGHT_KEY);
        if (raw) {
            const arr = JSON.parse(raw);
            if (Array.isArray(arr)) return arr;
        }
    } catch (_) {}
    // Built-in defaults
    return [
        { id: 'b1', label: 'High CPU',     type: 'cpu',    op: '>', value: 50,  color: '#ef4444', enabled: true },
        { id: 'b2', label: 'High memory',  type: 'memory', op: '>', value: 1024, color: '#f59e0b', enabled: true },
    ];
}
function saveProcHighlights() {
    try { localStorage.setItem(PROC_HIGHLIGHT_KEY, JSON.stringify(_procHighlights)); } catch (_) {}
}
let _procHighlights = loadProcHighlights();

// Returns a CSS color (rgba string, partially transparent) for the row
// background, or null if no rule matches.
function highlightForProc(p) {
    for (const r of _procHighlights) {
        if (!r.enabled) continue;
        let val;
        switch (r.type) {
            case 'cpu':    val = p.cpu_usage; break;
            case 'memory': val = p.mem_working_kb / 1024; break; // MB
            case 'name':   val = p.name || ''; break;
            case 'user':   val = p.user || ''; break;
            default: continue;
        }
        let match = false;
        if (r.op === '>')        match = parseFloat(val) > parseFloat(r.value);
        else if (r.op === '<')   match = parseFloat(val) < parseFloat(r.value);
        else if (r.op === 'contains') match = String(val).toLowerCase().includes(String(r.value).toLowerCase());
        if (match) {
            // Convert hex color to rgba with low alpha for tinted background
            const hex = (r.color || '#3b82f6').replace('#', '');
            const num = parseInt(hex.length === 3 ? hex.split('').map(c => c + c).join('') : hex, 16);
            const rd = (num >> 16) & 255, gn = (num >> 8) & 255, bl = num & 255;
            return `rgba(${rd},${gn},${bl},0.10)`;
        }
    }
    return null;
}

function loadProcWatchlist() {
    try {
        const raw = localStorage.getItem('wtp_proc_watchlist');
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch (_) { return []; }
}
function saveProcWatchlist() {
    try {
        localStorage.setItem('wtp_proc_watchlist', JSON.stringify([..._procWatchlist]));
    } catch (_) {}
}

function startProcessManager() {
    loadProcStateFromStorage();   // restore persisted sort/filters/tree mode
    _procShellMounted = false;  // force shell rebuild when entering page
    renderProcessManagerShell();
    refreshProcessData();
    if (_procRefreshInterval) clearInterval(_procRefreshInterval);
    _procRefreshInterval = setInterval(() => {
        if (currentPage === 'processes' && !_appHidden) refreshProcessData();
    }, PROC_REFRESH_MS);
}

// (renderProcessManager removed in audit 2026-06-11: zero call sites. Its
// comment claimed confirmKillProcess used it, but every refresh path —
// including confirmKillProcess and confirmKillProcessTree — calls
// refreshProcessData() directly. startProcessManager() owns shell mounting.)

// Builds the static UI scaffolding ONCE per page entry. Re-renders only on
// shell-changing actions (column visibility toggle, tree mode toggle, etc.).
function renderProcessManagerShell() {
    const content = document.getElementById('processes-content');
    if (!content) return;

    const cols = visibleProcColumns();
    const headerCells = cols.map(c => {
        const arrow = (_procSortCol === c.key) ? (_procSortDir < 0 ? ' ↓' : ' ↑') : '';
        const align = c.align === 'right' ? 'text-align:right;' : '';
        const cur   = (_procSortCol === c.key) ? 'color:var(--accent);' : '';
        const cursor = c.sortable ? 'cursor:pointer;' : '';
        const dataAttr = c.sortable ? `data-sort="${c.key}"` : '';
        return `<div ${dataAttr} style="${align}${cursor}${cur}">${escHtml(c.label)}${arrow}</div>`;
    }).join('');

    content.innerHTML = `
      <div id="proc-system-overview" style="display:flex;gap:10px;margin-bottom:12px"></div>
      <div id="proc-toolbar" style="display:flex;align-items:center;gap:8px;margin-bottom:10px;flex-wrap:wrap">
        <h2 class="section-heading" style="margin:0">Process Manager</h2>
        <span class="live-dot" title="Live"></span>
        <span id="proc-refresh-info" style="color:var(--text3);font-size:11px"></span>
        <div style="margin-left:auto;display:flex;gap:6px;align-items:center;flex-wrap:wrap">
          <input id="proc-search-input" type="text" class="form-control" style="width:220px"
                 placeholder="🔍 Name, PID, command, user…" value="${escHtml(_procSearch)}"
                 oninput="procSearchChange(this.value)" />
          <select id="proc-groupby" class="form-control" style="width:130px;font-size:12px;padding:4px 8px" onchange="procSetGroupBy(this.value)" title="Group rows by a field">
            <option value="none"     ${_procGroupBy === 'none' ? 'selected' : ''}>No grouping</option>
            <option value="user"     ${_procGroupBy === 'user' ? 'selected' : ''}>By user</option>
            <option value="name"     ${_procGroupBy === 'name' ? 'selected' : ''}>By image</option>
            <option value="elevated" ${_procGroupBy === 'elevated' ? 'selected' : ''}>By elevation</option>
          </select>
          <button class="btn ${_procTreeMode ? 'btn-primary' : ''}" id="proc-tree-btn" title="Toggle tree view (group by parent process)" onclick="procToggleTree()">🌲 Tree</button>
          <button class="btn" id="proc-port-btn" title="Find process listening on a port" onclick="procFindByPort()">🔌 Port</button>
          <button class="btn" id="proc-snapshot-btn" title="Capture a state snapshot to diff against" onclick="procToggleSnapshot()">📸 Snapshot</button>
          <button class="btn" id="proc-export-btn" title="Export visible processes as CSV" onclick="procExportCsv()">📊 Export</button>
          <button class="btn" id="proc-highlight-btn" title="Edit highlight rules" onclick="procEditHighlights()">🎨 Rules</button>
          <button class="btn" id="proc-cols-btn" title="Show/hide columns" onclick="procToggleColumnPicker()">⚙ Columns</button>
        </div>
      </div>
      <div id="proc-filter-bar" style="display:flex;gap:8px;align-items:center;margin-bottom:10px;font-size:12px;flex-wrap:wrap">
        <span style="color:var(--text3)">Filter:</span>
        <select id="proc-filter-user" class="form-control" style="width:160px;font-size:12px;padding:4px 8px" onchange="procFilterUserChange(this.value)">
          <option value="">All users</option>
        </select>
        <label style="display:flex;align-items:center;gap:4px;cursor:pointer">
          <input type="checkbox" id="proc-filter-elevated" ${_procFilterElevated ? 'checked' : ''} onchange="procFilterElevatedChange(this.checked)">
          <span>Elevated only</span>
        </label>
        <label style="display:flex;align-items:center;gap:4px;cursor:pointer">
          <input type="checkbox" id="proc-filter-syshide" ${_procFilterSysHide ? 'checked' : ''} onchange="procFilterSysHideChange(this.checked)">
          <span>Hide SYSTEM &amp; service processes</span>
        </label>
        <span id="proc-snapshot-info" style="margin-left:auto;color:var(--text3);font-size:11px"></span>
      </div>
      <div id="proc-split-pane" style="display:flex;gap:12px;flex:1;min-height:0;overflow:hidden">
        <div id="proc-list-pane" style="flex:1;min-width:0;display:flex;flex-direction:column;overflow:hidden;background:var(--bg2);border:1px solid var(--border);border-radius:8px">
          <div id="proc-list-header" style="display:grid;grid-template-columns:${procGridTemplate()};gap:8px;padding:10px 12px;font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--text3);font-weight:700;background:var(--bg0);border-bottom:1px solid var(--border);position:sticky;top:0;z-index:1">
            ${headerCells}
          </div>
          <div id="proc-list-body" style="flex:1;overflow-y:auto;font-size:12.5px;font-family:'Cascadia Code',Consolas,monospace"></div>
          <div id="proc-list-footer" style="padding:6px 12px;font-size:11px;color:var(--text3);border-top:1px solid var(--border);background:var(--bg0)"></div>
        </div>
        <div id="proc-detail-pane" style="width:440px;flex-shrink:0;display:flex;flex-direction:column;overflow:hidden;background:var(--bg2);border:1px solid var(--border);border-radius:8px">
          <div id="proc-detail-header" style="padding:12px;border-bottom:1px solid var(--border);background:var(--bg0)">
            <div style="font-size:11px;color:var(--text3);text-transform:uppercase;letter-spacing:.06em;font-weight:700">Selection</div>
            <div id="proc-detail-name" style="font-size:14px;font-weight:600;color:var(--text);margin-top:2px">— No process selected —</div>
            <div id="proc-detail-actions" style="margin-top:8px;display:flex;gap:5px;flex-wrap:wrap"></div>
          </div>
          <div id="proc-detail-tabs" style="display:flex;gap:1px;background:var(--bg0);padding:4px;border-bottom:1px solid var(--border);flex-shrink:0"></div>
          <div id="proc-detail-body" style="flex:1;overflow-y:auto;padding:12px"></div>
        </div>
      </div>
    `;

    // Wire header sort clicks
    content.querySelectorAll('#proc-list-header [data-sort]').forEach(th => {
        th.onclick = () => procSort(th.dataset.sort);
    });

    _procShellMounted = true;
    renderProcDetailPane();
}

// Pulls fresh data and updates the rendered table in place, computing diff
// against the previous data set for animations / highlight.
async function refreshProcessData() {
    // In-flight guard (mirrors _liveRefreshInProgress / _refreshInProgress) so an
    // interval tick coinciding with a visibility-return or post-kill refresh does
    // not run two overlapping get_processes that mutate shared _proc* maps.
    if (_procRefreshInProgress) return;
    _procRefreshInProgress = true;
    try {
        const t0 = performance.now();
        // Two IPCs in parallel — get_processes is the per-row data, and
        // get_system_overview is the system-wide aggregate (true CPU%, real
        // RAM in use, etc.). Running them in parallel keeps refresh cheap.
        const [procs, overview] = await Promise.all([
            invoke('get_processes'),
            invoke('get_system_overview').catch(() => null),  // best-effort
        ]);
        _procSystemOverview = overview;
        const ms = Math.round(performance.now() - t0);

        // Build a PID map for fast lookup; carry-forward prev data.
        _procPrevDataMap = new Map(_procData.map(p => [p.pid, p]));
        _procData = procs;

        // Update history for each live PID. Four series so the Performance
        // tab can show CPU, memory, I/O, and handles trends.
        for (const p of procs) {
            const cpuH = _procCpuHistory.get(p.pid) || new Array(PROC_CPU_HISTORY_SIZE).fill(0);
            cpuH.shift(); cpuH.push(p.cpu_usage);
            _procCpuHistory.set(p.pid, cpuH);

            const memH = _procMemHistory.get(p.pid) || new Array(PROC_CPU_HISTORY_SIZE).fill(0);
            memH.shift(); memH.push(p.mem_working_kb / 1024);   // store as MB for chart sanity
            _procMemHistory.set(p.pid, memH);

            const ioH = _procIoHistory.get(p.pid) || new Array(PROC_CPU_HISTORY_SIZE).fill(0);
            ioH.shift(); ioH.push((p.disk_read_kb_s || 0) + (p.disk_write_kb_s || 0));
            _procIoHistory.set(p.pid, ioH);

            const hH = _procHandlesHistory.get(p.pid) || new Array(PROC_CPU_HISTORY_SIZE).fill(0);
            hH.shift(); hH.push(p.handles || 0);
            _procHandlesHistory.set(p.pid, hH);
        }
        // GC dead-process histories so the map doesn't grow unbounded
        const livePids = new Set(procs.map(p => p.pid));
        for (const m of [_procCpuHistory, _procMemHistory, _procIoHistory, _procHandlesHistory]) {
            for (const pid of [...m.keys()]) {
                if (!livePids.has(pid)) m.delete(pid);
            }
        }

        renderProcList();
        renderProcSystemOverview();

        // Refresh detail pane data if currently viewing a process
        if (_procSelectedPid !== null) {
            const stillAlive = procs.find(p => p.pid === _procSelectedPid);
            if (!stillAlive) {
                // Selected process died — clear selection, show ghost message
                _procSelectedPid = null;
                renderProcDetailPane();
            } else {
                // Update overview tab in place if currently showing
                if (_procDetailTab === 'overview' || _procDetailTab === 'performance') {
                    renderProcDetailPane();
                }
            }
        }

        // Footer
        const fEl = document.getElementById('proc-list-footer');
        if (fEl) {
            const visibleEls = document.querySelectorAll('#proc-list-body .proc-row');
            fEl.textContent = `${visibleEls.length} visible · ${procs.length} total processes · refresh ${ms}ms`;
        }
        const rEl = document.getElementById('proc-refresh-info');
        if (rEl) rEl.textContent = `Auto-refresh ${PROC_REFRESH_MS / 1000}s · ${new Date().toLocaleTimeString()}`;

        // Populate user filter dropdown (one-time-ish — only if list changed)
        populateProcUserFilter();
    } catch (err) {
        derror('refreshProcessData', 'failed', { err: String(err) });
        const body = document.getElementById('proc-list-body');
        if (body) body.innerHTML = `<div style="padding:24px;text-align:center;color:var(--red)">Failed to load processes: ${escHtml(String(err))}</div>`;
    } finally {
        _procRefreshInProgress = false;
    }
}

function populateProcUserFilter() {
    const sel = document.getElementById('proc-filter-user');
    if (!sel) return;
    const users = [...new Set(_procData.map(p => p.user).filter(Boolean))].sort();
    // Only rebuild if user set changed (keeps focus stable while filter dropdown is open)
    const existing = [...sel.querySelectorAll('option')].map(o => o.value).slice(1);
    const same = existing.length === users.length && existing.every((v, i) => v === users[i]);
    if (same) return;
    const current = sel.value;
    sel.innerHTML = '<option value="">All users</option>' +
        users.map(u => `<option value="${escHtml(u)}" ${u === current ? 'selected' : ''}>${escHtml(u)}</option>`).join('');
}

function applyProcFilters(procs) {
    const search = _procSearch.toLowerCase();
    return procs.filter(p => {
        if (search) {
            const hay = `${p.name} ${p.pid} ${p.command_line} ${p.user}`.toLowerCase();
            if (!hay.includes(search)) return false;
        }
        if (_procFilterUser && p.user !== _procFilterUser) return false;
        if (_procFilterElevated && !p.elevated) return false;
        if (_procFilterSysHide) {
            const u = (p.user || '').toLowerCase();
            if (u.includes('system') || u.includes('local service') || u.includes('network service')) return false;
        }
        return true;
    });
}

// Sort and render the process list. In tree mode, builds parent-child
// hierarchy and renders with indentation + collapse chevrons.
function renderProcList() {
    const body = document.getElementById('proc-list-body');
    if (!body) return;

    let filtered = applyProcFilters(_procData);

    // Sort
    filtered.sort((a, b) => {
        const av = a[_procSortCol];
        const bv = b[_procSortCol];
        if (typeof av === 'string') return (av || '').localeCompare(bv || '') * _procSortDir;
        if (typeof av === 'boolean') return ((av ? 1 : 0) - (bv ? 1 : 0)) * _procSortDir;
        return ((av || 0) - (bv || 0)) * _procSortDir;
    });

    // Pin watchlist to top (after sort, before tree-ifying / group-ifying)
    if (_procWatchlist.size > 0) {
        const watched = filtered.filter(p => _procWatchlist.has(p.pid));
        const rest = filtered.filter(p => !_procWatchlist.has(p.pid));
        filtered = [...watched, ...rest];
    }

    // Three rendering modes: tree (parent-child), group-by (collapsible
    // sections), or flat. Tree and group-by are mutually exclusive — see
    // procSetGroupBy / procToggleTree.
    if (_procTreeMode) {
        const listToRender = buildProcTree(filtered);
        body.innerHTML = listToRender.map(({ proc, depth, hasChildren }) => renderProcRow(proc, depth, hasChildren)).join('');
    } else if (_procGroupBy !== 'none') {
        body.innerHTML = renderProcGroups(filtered);
    } else {
        const listToRender = filtered.slice(0, 1000).map(p => ({ proc: p, depth: 0, hasChildren: false }));
        body.innerHTML = listToRender.map(({ proc, depth, hasChildren }) => renderProcRow(proc, depth, hasChildren)).join('');
    }

    // Wire row clicks (event delegation on body)
    body.onclick = (e) => {
        const groupHeader = e.target.closest('.proc-group-header');
        if (groupHeader) {
            const key = groupHeader.dataset.groupKey;
            if (_procGroupCollapsed.has(key)) _procGroupCollapsed.delete(key);
            else _procGroupCollapsed.add(key);
            renderProcList();
            return;
        }
        const row = e.target.closest('.proc-row');
        if (!row) return;
        const pid = parseInt(row.dataset.pid, 10);
        // Chevron click expands/collapses tree node
        if (e.target.classList.contains('proc-chevron')) {
            if (_procExpanded.has(pid)) _procExpanded.delete(pid);
            else _procExpanded.add(pid);
            renderProcList();
            return;
        }
        // Star toggles watchlist
        if (e.target.classList.contains('proc-star')) {
            if (_procWatchlist.has(pid)) _procWatchlist.delete(pid);
            else _procWatchlist.add(pid);
            saveProcWatchlist();
            renderProcList();
            return;
        }
        _procSelectedPid = pid;
        // Reset cached detail data when selection changes
        _procDetailDataCache = { modules: null, connections: null, lastModulesPid: null, lastConnsPid: null };
        renderProcList();        // updates row highlight
        renderProcDetailPane();
    };
    // Right-click menu
    body.oncontextmenu = (e) => {
        const row = e.target.closest('.proc-row');
        if (!row) return;
        e.preventDefault();
        const pid = parseInt(row.dataset.pid, 10);
        showProcContextMenu(e, pid);
    };
}

// Build a tree-like flat list with depth metadata. Filtered procs first;
// then for each, walk up parent_pid to find ancestors and inject them.
// Children are inlined under their parents only if the parent is _procExpanded.
// ── Group-by rendering (Phase 5+) ───────────────────────────────────────────
// Splits the filtered list into named groups based on _procGroupBy, sorts
// groups by size descending so the busiest group is first, and emits
// collapsible group headers as separator rows. Each header click toggles
// the corresponding key in _procGroupCollapsed.
function renderProcGroups(filteredProcs) {
    const groupKey = (p) => {
        switch (_procGroupBy) {
            case 'user':     return p.user || '(unknown user)';
            case 'name':     return p.name || '(unknown)';
            case 'elevated': return p.elevated ? 'Elevated' : 'Standard';
            default:         return '(all)';
        }
    };

    const groups = new Map();
    for (const p of filteredProcs) {
        const k = groupKey(p);
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(p);
    }

    // Order: by group size descending, then alphabetically as a tiebreaker.
    // Caps at 1000 rows total across all visible groups.
    const ordered = [...groups.entries()]
        .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));

    const cols = visibleProcColumns();
    const colCount = cols.length;
    let totalRows = 0;
    const out = [];
    for (const [key, members] of ordered) {
        const collapsed = _procGroupCollapsed.has(key);
        // Group header row
        const totalCpu = members.reduce((s, p) => s + p.cpu_usage, 0);
        const totalMemMb = members.reduce((s, p) => s + p.mem_working_kb, 0) / 1024;
        out.push(`
          <div class="proc-group-header" data-group-key="${escHtml(key)}"
               style="grid-column:1 / span ${colCount};display:flex;align-items:center;gap:10px;padding:7px 12px;background:var(--bg0);border-bottom:1px solid var(--border);cursor:pointer;font-size:11.5px;color:var(--text2);font-weight:600">
            <span style="display:inline-block;width:14px;color:var(--text3);font-size:10px">${collapsed ? '▶' : '▼'}</span>
            <span style="color:var(--text);font-weight:600">${escHtml(key)}</span>
            <span style="color:var(--text3);font-weight:400">${members.length} process${members.length === 1 ? '' : 'es'}</span>
            <span style="margin-left:auto;color:var(--text3);font-weight:400;font-family:monospace;font-size:11px">CPU ${totalCpu.toFixed(1)}% · MEM ${(totalMemMb / 1024).toFixed(1)} GB</span>
          </div>`);
        if (collapsed) continue;
        for (const p of members) {
            if (totalRows >= 1000) break;
            out.push(renderProcRow(p, 0, false));
            totalRows++;
        }
        if (totalRows >= 1000) break;
    }
    return out.join('');
}

function buildProcTree(filteredProcs) {
    // Index ALL processes by PID so we can resolve ancestors regardless of filter.
    const allByPid = new Map(_procData.map(p => [p.pid, p]));

    // First, for every filtered proc, walk up its ancestor chain so the tree
    // hierarchy is complete even when ancestors don't match the filter.
    const includedPids = new Set();
    for (const p of filteredProcs) {
        let cur = p;
        while (cur) {
            if (includedPids.has(cur.pid)) break;
            includedPids.add(cur.pid);
            if (!cur.parent_pid || cur.parent_pid === 0) break;
            cur = allByPid.get(cur.parent_pid);
        }
    }

    // Build adjacency: parent_pid → [child]
    const childrenOf = new Map();
    for (const pid of includedPids) {
        const p = allByPid.get(pid);
        if (!p) continue;
        const parent = p.parent_pid;
        if (!childrenOf.has(parent)) childrenOf.set(parent, []);
        childrenOf.get(parent).push(p);
    }

    // Roots: processes whose parent isn't in our set, or whose parent is 0.
    const roots = [];
    for (const pid of includedPids) {
        const p = allByPid.get(pid);
        if (!p) continue;
        if (!p.parent_pid || !includedPids.has(p.parent_pid)) roots.push(p);
    }
    // Sort roots by current sort
    roots.sort((a, b) => {
        const av = a[_procSortCol]; const bv = b[_procSortCol];
        if (typeof av === 'string') return (av || '').localeCompare(bv || '') * _procSortDir;
        return ((av || 0) - (bv || 0)) * _procSortDir;
    });

    // Walk
    const result = [];
    function walk(p, depth) {
        const kids = childrenOf.get(p.pid) || [];
        result.push({ proc: p, depth, hasChildren: kids.length > 0 });
        if (_procExpanded.has(p.pid) || depth === 0 && kids.length > 0 && depth < 1) {
            // Default-expand top level; user can collapse explicitly
        }
        if (_procExpanded.has(p.pid)) {
            kids.sort((a, b) => {
                const av = a[_procSortCol]; const bv = b[_procSortCol];
                if (typeof av === 'string') return (av || '').localeCompare(bv || '') * _procSortDir;
                return ((av || 0) - (bv || 0)) * _procSortDir;
            });
            for (const k of kids) walk(k, depth + 1);
        }
    }
    for (const r of roots) walk(r, 0);

    return result.slice(0, 1000);
}

// Render a single process row. Depth controls indentation; hasChildren
// controls chevron visibility.
function renderProcRow(p, depth, hasChildren) {
    const isSelected = (_procSelectedPid === p.pid);
    const isWatched  = _procWatchlist.has(p.pid);
    const isNew      = _procSnapshot && !_procSnapshot.byPid.has(p.pid);
    const isElev     = !!p.elevated;

    const indent = depth * 14;
    const chevron = hasChildren
        ? `<span class="proc-chevron" style="cursor:pointer;display:inline-block;width:14px;color:var(--text3);font-size:10px">${_procExpanded.has(p.pid) ? '▼' : '▶'}</span>`
        : `<span style="display:inline-block;width:14px"></span>`;
    const star = `<span class="proc-star" style="cursor:pointer;color:${isWatched ? 'var(--yellow)' : 'var(--text3)'};opacity:${isWatched ? '1' : '0.4'};font-size:13px;user-select:none">★</span>`;
    const pinChevronStarHtml = `<div style="display:flex;align-items:center;gap:4px;padding-left:${indent}px">${chevron}${star}</div>`;

    const elevBadge = isElev ? `<span title="Elevated" style="color:var(--yellow);font-size:11px;font-weight:700;margin-left:4px">⬆</span>` : '';
    const newBadge = isNew ? `<span title="New since snapshot" style="background:var(--green);color:#000;font-size:9px;padding:1px 4px;border-radius:3px;margin-left:4px;font-weight:700">NEW</span>` : '';

    const cmdShort = p.command_line && p.command_line.length > 80
        ? p.command_line.slice(0, 80) + '…'
        : p.command_line;
    const nameCellHtml = `<div style="overflow:hidden">
        <div style="color:var(--text);font-weight:500;font-size:12.5px;display:flex;align-items:center" title="${escHtml(p.exe_path || p.name)}">
          <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(p.name)}</span>${elevBadge}${newBadge}
        </div>
        ${cmdShort ? `<div style="color:var(--text3);font-size:10.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escHtml(p.command_line)}">${escHtml(cmdShort)}</div>` : ''}
      </div>`;

    const ctx = { pinChevronStarHtml, nameCellHtml };
    const cellHtmls = visibleProcColumns().map(c => c.cell(p, ctx)).join('');

    // Highlight rule background — overrides plain background but stays
    // beneath the selection outline so selection is still visible.
    const tint = isSelected ? '' : (highlightForProc(p) || '');
    const bgStyle = isSelected
        ? 'background:var(--accent-glow2);outline:1px solid var(--accent);outline-offset:-1px;'
        : (tint ? `background:${tint};` : '');

    return `
        <div class="proc-row" data-pid="${p.pid}"
             style="display:grid;grid-template-columns:${procGridTemplate()};gap:8px;padding:6px 12px;border-bottom:1px solid rgba(31,38,64,.3);cursor:pointer;${bgStyle}align-items:center">
          ${cellHtmls}
        </div>`;
}

// Render the right-side detail pane based on _procSelectedPid + _procDetailTab.
function renderProcDetailPane() {
    const nameEl = document.getElementById('proc-detail-name');
    const actsEl = document.getElementById('proc-detail-actions');
    const tabsEl = document.getElementById('proc-detail-tabs');
    const bodyEl = document.getElementById('proc-detail-body');
    if (!nameEl || !bodyEl) return;

    if (_procSelectedPid === null) {
        nameEl.textContent = '— No process selected —';
        if (actsEl) actsEl.innerHTML = '';
        if (tabsEl) tabsEl.innerHTML = '';
        bodyEl.innerHTML = `<div style="text-align:center;padding:32px;color:var(--text3);font-size:13px;line-height:1.6">
          Select a process from the list to see its details.<br>
          <span style="font-size:11.5px">⭐ Star to pin · 🔌 Find process by port · 📸 Snapshot to diff state</span>
        </div>`;
        return;
    }

    const p = _procData.find(pp => pp.pid === _procSelectedPid);
    if (!p) {
        bodyEl.innerHTML = `<div style="color:var(--text3);padding:14px;text-align:center;font-style:italic">Process ${_procSelectedPid} no longer exists. Select another.</div>`;
        return;
    }

    nameEl.innerHTML = `${escHtml(p.name)} <span style="color:var(--text3);font-size:11.5px;font-weight:400">(PID ${p.pid})</span>${p.elevated ? ' <span style="color:var(--yellow);font-size:11px;font-weight:700;margin-left:4px">⬆ ELEVATED</span>' : ''}`;

    actsEl.innerHTML = `
      <button class="btn" style="font-size:11px;padding:4px 8px" onclick="procActionSuspend(${p.pid})" title="Pause execution (NtSuspendProcess)">⏸ Suspend</button>
      <button class="btn" style="font-size:11px;padding:4px 8px" onclick="procActionResume(${p.pid})" title="Resume after suspension">▶ Resume</button>
      <button class="btn" style="font-size:11px;padding:4px 8px" onclick="procActionPriority(${p.pid})" title="Change CPU priority class">⚙ Priority</button>
      <button class="btn" style="font-size:11px;padding:4px 8px" onclick="procActionAffinity(${p.pid})" title="Pin process to specific CPU cores">🎚 Affinity</button>
      <button class="btn" style="font-size:11px;padding:4px 8px" onclick="procActionOpenLocation(${escHtml(JSON.stringify(p.exe_path || ''))})" title="Open exe folder in Explorer" ${!p.exe_path ? 'disabled' : ''}>📁 Location</button>
      <button class="btn" style="font-size:11px;padding:4px 8px" onclick="procActionCopyCmd(${p.pid})" title="Copy command line to clipboard">📋 Copy CMD</button>
      <button class="btn btn-danger" style="font-size:11px;padding:4px 8px" onclick="confirmKillProcess(${p.pid}, ${escHtml(JSON.stringify(p.name))})">⏹ Kill</button>
      <button class="btn btn-danger" style="font-size:11px;padding:4px 8px" onclick="confirmKillProcessTree(${p.pid}, ${escHtml(JSON.stringify(p.name))})" title="Kill this process AND all descendants">💀 Tree</button>
    `;

    const tabs = [
        { id: 'overview',    label: 'Overview' },
        { id: 'performance', label: 'Performance' },
        { id: 'modules',     label: 'Modules' },
        { id: 'network',     label: 'Network' },
    ];
    tabsEl.innerHTML = tabs.map(t => `
      <button class="proc-detail-tab" data-tab="${t.id}"
              style="flex:1;padding:6px 4px;background:${_procDetailTab === t.id ? 'var(--bg2)' : 'transparent'};color:${_procDetailTab === t.id ? 'var(--accent)' : 'var(--text3)'};border:none;border-bottom:2px solid ${_procDetailTab === t.id ? 'var(--accent)' : 'transparent'};font-size:11.5px;font-weight:${_procDetailTab === t.id ? '600' : '500'};cursor:pointer">
        ${t.label}
      </button>`).join('');
    tabsEl.querySelectorAll('.proc-detail-tab').forEach(btn => {
        btn.onclick = () => { _procDetailTab = btn.dataset.tab; renderProcDetailPane(); };
    });

    if (_procDetailTab === 'overview')    renderProcDetailOverview(p, bodyEl);
    if (_procDetailTab === 'performance') renderProcDetailPerf(p, bodyEl);
    if (_procDetailTab === 'modules')     renderProcDetailModules(p, bodyEl);
    if (_procDetailTab === 'network')     renderProcDetailNetwork(p, bodyEl);
}

function renderProcDetailOverview(p, bodyEl) {
    const startDate = p.start_time ? new Date(p.start_time * 1000).toLocaleString() : '—';
    const fmtUptime = (s) => {
        if (!s) return '—';
        const d = Math.floor(s / 86400);
        const h = Math.floor((s % 86400) / 3600);
        const m = Math.floor((s % 3600) / 60);
        const sec = s % 60;
        if (d > 0) return `${d}d ${h}h ${m}m`;
        if (h > 0) return `${h}h ${m}m ${sec}s`;
        if (m > 0) return `${m}m ${sec}s`;
        return `${sec}s`;
    };
    const fmtBytes = (kb) => {
        if (kb > 1024 * 1024) return `${(kb / 1024 / 1024).toFixed(2)} GB`;
        if (kb > 1024) return `${(kb / 1024).toFixed(2)} MB`;
        return `${kb} KB`;
    };

    bodyEl.innerHTML = `
      <div style="display:grid;grid-template-columns:auto 1fr;gap:8px 12px;font-size:12.5px;line-height:1.5">
        <div style="color:var(--text3)">PID</div>
        <div style="color:var(--text);font-family:monospace">${p.pid}</div>
        <div style="color:var(--text3)">Parent</div>
        <div style="color:var(--text);font-family:monospace">${p.parent_pid || '—'} ${p.parent_pid ? `<button style="font-size:10px;padding:1px 6px;margin-left:4px;background:var(--bg0);border:1px solid var(--border);border-radius:3px;cursor:pointer;color:var(--text2)" onclick="procSelectPid(${p.parent_pid})">↑ jump</button>` : ''}</div>
        <div style="color:var(--text3)">Status</div>
        <div style="color:var(--text)">${escHtml(p.status)}</div>
        <div style="color:var(--text3)">User</div>
        <div style="color:var(--text);word-break:break-all">${escHtml(p.user || '—')}</div>
        <div style="color:var(--text3)">Elevated</div>
        <div style="color:${p.elevated ? 'var(--yellow)' : 'var(--text)'};font-weight:${p.elevated ? '600' : '400'}">${p.elevated ? '⬆ Yes' : 'No'}</div>
        <div style="color:var(--text3)">Threads</div>
        <div style="color:var(--text);font-family:monospace">${p.threads || '—'}</div>
        <div style="color:var(--text3)">Handles</div>
        <div style="color:var(--text);font-family:monospace">${p.handles || '—'}</div>
        <div style="color:var(--text3)">CPU</div>
        <div style="color:var(--text)">${p.cpu_usage.toFixed(2)}%</div>
        <div style="color:var(--text3)">Memory (working)</div>
        <div style="color:var(--text);font-family:monospace">${fmtBytes(p.mem_working_kb)}</div>
        <div style="color:var(--text3)">Memory (private)</div>
        <div style="color:var(--text);font-family:monospace">${fmtBytes(p.mem_private_kb)}</div>
        <div style="color:var(--text3)">I/O read rate</div>
        <div style="color:var(--text);font-family:monospace">${p.disk_read_kb_s} KB/s</div>
        <div style="color:var(--text3)">I/O write rate</div>
        <div style="color:var(--text);font-family:monospace">${p.disk_write_kb_s} KB/s</div>
        <div style="color:var(--text3)">Started</div>
        <div style="color:var(--text);font-family:monospace;font-size:11.5px">${escHtml(startDate)}</div>
        <div style="color:var(--text3)">Uptime</div>
        <div style="color:var(--text)">${fmtUptime(p.run_secs)}</div>
      </div>
      <div style="margin-top:14px;padding-top:12px;border-top:1px solid var(--border)">
        <div style="font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--text3);font-weight:700;margin-bottom:5px">Executable</div>
        <div style="font-family:'Cascadia Code',Consolas,monospace;font-size:11.5px;color:var(--text2);word-break:break-all;background:var(--bg0);border:1px solid var(--border);border-radius:4px;padding:8px;max-height:80px;overflow:auto">${escHtml(p.exe_path || '(unknown)')}</div>
      </div>
      <div style="margin-top:12px">
        <div style="font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--text3);font-weight:700;margin-bottom:5px">Command Line</div>
        <div style="font-family:'Cascadia Code',Consolas,monospace;font-size:11.5px;color:var(--text2);word-break:break-all;background:var(--bg0);border:1px solid var(--border);border-radius:4px;padding:8px;max-height:120px;overflow:auto">${escHtml(p.command_line || '(none)')}</div>
      </div>
    `;
}

// Performance tab — four 60s sparkline trends (CPU, memory, I/O, handles)
// + a current-state stat strip. Each sparkline is built from a per-PID
// circular buffer in the corresponding _proc*History map, populated
// every refresh in refreshProcessData(). Lines aren't shared across
// processes — switching the selected PID swaps to a different buffer.
function renderProcDetailPerf(p, bodyEl) {
    const cpuHist     = _procCpuHistory.get(p.pid)     || [];
    const memHist     = _procMemHistory.get(p.pid)     || [];
    const ioHist      = _procIoHistory.get(p.pid)      || [];
    const handleHist  = _procHandlesHistory.get(p.pid) || [];

    // Sparkline factory. unitSuffix appears next to the y-axis labels.
    // floorMax keeps flatlines from collapsing to a single horizontal line —
    // we always plot against at least this max value.
    const sparkline = (hist, color, unitSuffix, floorMax) => {
        const W = 392, H = 70;
        const max = Math.max(...hist, floorMax);
        if (max === 0) return `<div style="height:${H}px;background:var(--bg0);border:1px solid var(--border);border-radius:4px;display:flex;align-items:center;justify-content:center;color:var(--text3);font-size:11px;font-style:italic">no data</div>`;
        const pts = hist.map((v, i) => {
            const x = (i / (PROC_CPU_HISTORY_SIZE - 1)) * W;
            const y = H - (v / max) * H;
            return `${x.toFixed(1)},${y.toFixed(1)}`;
        }).join(' ');
        const fillPts = `0,${H} ${pts} ${W},${H}`;
        const fmt = (v) => {
            if (v >= 1000) return Math.round(v).toLocaleString();
            if (v >= 100)  return v.toFixed(0);
            return v.toFixed(1);
        };
        return `
          <svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" preserveAspectRatio="none" style="background:var(--bg0);border:1px solid var(--border);border-radius:4px;display:block">
            <polygon points="${fillPts}" fill="${color}" fill-opacity="0.10"/>
            <polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linejoin="round"/>
            <line x1="0" y1="${H-1}" x2="${W}" y2="${H-1}" stroke="var(--border)" stroke-width="0.5"/>
            <text x="4" y="11" font-size="9" fill="var(--text3)" font-family="monospace">${fmt(max)}${unitSuffix}</text>
            <text x="4" y="${H-3}" font-size="9" fill="var(--text3)" font-family="monospace">0${unitSuffix}</text>
          </svg>`;
    };

    const avg = (h) => h.length === 0 ? 0 : h.reduce((s, v) => s + v, 0) / h.length;
    const peak = (h) => h.length === 0 ? 0 : Math.max(...h);

    bodyEl.innerHTML = `
      <div style="display:flex;flex-direction:column;gap:14px">
        <div>
          <div style="display:flex;justify-content:space-between;font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--text3);font-weight:700;margin-bottom:5px">
            <span>CPU</span>
            <span style="color:var(--text2);font-weight:500;font-family:monospace;text-transform:none;letter-spacing:0">${p.cpu_usage.toFixed(2)}% · peak ${peak(cpuHist).toFixed(1)}% · avg ${avg(cpuHist).toFixed(2)}%</span>
          </div>
          ${sparkline(cpuHist, '#3b82f6', '%', 5)}
        </div>
        <div>
          <div style="display:flex;justify-content:space-between;font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--text3);font-weight:700;margin-bottom:5px">
            <span>Memory (working set)</span>
            <span style="color:var(--text2);font-weight:500;font-family:monospace;text-transform:none;letter-spacing:0">${(p.mem_working_kb/1024).toFixed(0)} MB · peak ${peak(memHist).toFixed(0)} MB</span>
          </div>
          ${sparkline(memHist, '#10b981', ' MB', 50)}
        </div>
        <div>
          <div style="display:flex;justify-content:space-between;font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--text3);font-weight:700;margin-bottom:5px">
            <span>Disk I/O (R+W combined)</span>
            <span style="color:var(--text2);font-weight:500;font-family:monospace;text-transform:none;letter-spacing:0">R ${p.disk_read_kb_s} · W ${p.disk_write_kb_s} KB/s · peak ${peak(ioHist).toLocaleString()}</span>
          </div>
          ${sparkline(ioHist, '#f59e0b', ' KB/s', 100)}
        </div>
        <div>
          <div style="display:flex;justify-content:space-between;font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--text3);font-weight:700;margin-bottom:5px">
            <span>Handles</span>
            <span style="color:var(--text2);font-weight:500;font-family:monospace;text-transform:none;letter-spacing:0">${p.handles || 0} · peak ${peak(handleHist)}${peak(handleHist) > avg(handleHist) * 1.5 ? ' ⚠' : ''}</span>
          </div>
          ${sparkline(handleHist, '#a78bfa', '', 100)}
        </div>
        <div style="font-size:11px;color:var(--text3);text-align:center;font-style:italic">${PROC_CPU_HISTORY_SIZE * PROC_REFRESH_MS / 1000}-second window · ${PROC_REFRESH_MS / 1000}s sample interval</div>
      </div>
    `;
}

// Modules tab — loaded DLLs. Loaded on demand because the IPC is expensive
// (~10-50ms per process for a snapshot).
async function renderProcDetailModules(p, bodyEl) {
    if (_procDetailDataCache.lastModulesPid !== p.pid) {
        _procDetailDataCache.modules = null;
        _procDetailDataCache.lastModulesPid = p.pid;
    }
    if (!_procDetailDataCache.modules) {
        bodyEl.innerHTML = `<div style="text-align:center;padding:24px;color:var(--text3)">⏳ Loading modules…</div>`;
        try {
            _procDetailDataCache.modules = await invoke('get_process_modules', { pid: p.pid });
        } catch (err) {
            bodyEl.innerHTML = `<div style="color:var(--red);padding:14px">Could not load modules: ${escHtml(String(err))}</div>`;
            return;
        }
    }
    const mods = _procDetailDataCache.modules || [];
    if (mods.length === 0) {
        bodyEl.innerHTML = `<div style="color:var(--text3);padding:14px;text-align:center;font-style:italic">No modules listed (may be a protected process).</div>`;
        return;
    }

    const fmtKb = (b) => b > 1024 * 1024 ? `${(b/1024/1024).toFixed(1)} MB` : `${(b/1024).toFixed(0)} KB`;
    bodyEl.innerHTML = `
      <div style="font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--text3);font-weight:700;margin-bottom:6px">${mods.length} loaded module${mods.length === 1 ? '' : 's'}</div>
      <div style="background:var(--bg0);border:1px solid var(--border);border-radius:4px;overflow:hidden">
        <table style="width:100%;border-collapse:collapse;font-size:11.5px;font-family:'Cascadia Code',Consolas,monospace">
          <thead>
            <tr style="background:var(--bg2);position:sticky;top:0">
              <th style="text-align:left;padding:6px 10px;border-bottom:1px solid var(--border);font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:var(--text3);font-weight:700">Module</th>
              <th style="text-align:left;padding:6px 10px;border-bottom:1px solid var(--border);font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:var(--text3);font-weight:700">Base</th>
              <th style="text-align:right;padding:6px 10px;border-bottom:1px solid var(--border);font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:var(--text3);font-weight:700">Size</th>
            </tr>
          </thead>
          <tbody>
            ${mods.map(m => `
              <tr style="border-bottom:1px solid rgba(31,38,64,.3)">
                <td style="padding:5px 10px" title="${escHtml(m.path)}"><strong style="color:var(--text2)">${escHtml(m.name)}</strong></td>
                <td style="padding:5px 10px;color:var(--text3);font-size:10.5px">${escHtml(m.base_addr)}</td>
                <td style="padding:5px 10px;text-align:right;color:var(--text3)">${fmtKb(m.size)}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
    `;
}

async function renderProcDetailNetwork(p, bodyEl) {
    if (_procDetailDataCache.lastConnsPid !== p.pid) {
        _procDetailDataCache.connections = null;
        _procDetailDataCache.lastConnsPid = p.pid;
    }
    if (!_procDetailDataCache.connections) {
        bodyEl.innerHTML = `<div style="text-align:center;padding:24px;color:var(--text3)">⏳ Loading network connections…</div>`;
        try {
            _procDetailDataCache.connections = await invoke('get_process_connections', { pid: p.pid });
        } catch (err) {
            bodyEl.innerHTML = `<div style="color:var(--red);padding:14px">Could not load connections: ${escHtml(String(err))}</div>`;
            return;
        }
    }
    const conns = _procDetailDataCache.connections || [];
    if (conns.length === 0) {
        bodyEl.innerHTML = `<div style="color:var(--text3);padding:14px;text-align:center;font-style:italic">This process has no open IPv4 sockets.</div>`;
        return;
    }
    bodyEl.innerHTML = `
      <div style="font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--text3);font-weight:700;margin-bottom:6px">${conns.length} active connection${conns.length === 1 ? '' : 's'}</div>
      <div style="background:var(--bg0);border:1px solid var(--border);border-radius:4px;overflow:hidden">
        <table style="width:100%;border-collapse:collapse;font-size:11.5px;font-family:'Cascadia Code',Consolas,monospace">
          <thead>
            <tr style="background:var(--bg2)">
              <th style="text-align:left;padding:6px 10px;border-bottom:1px solid var(--border);font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:var(--text3);font-weight:700">Proto</th>
              <th style="text-align:left;padding:6px 10px;border-bottom:1px solid var(--border);font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:var(--text3);font-weight:700">Local</th>
              <th style="text-align:left;padding:6px 10px;border-bottom:1px solid var(--border);font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:var(--text3);font-weight:700">Remote</th>
              <th style="text-align:left;padding:6px 10px;border-bottom:1px solid var(--border);font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:var(--text3);font-weight:700">State</th>
            </tr>
          </thead>
          <tbody>
            ${conns.map(c => `
              <tr style="border-bottom:1px solid rgba(31,38,64,.3)">
                <td style="padding:5px 10px;color:var(--accent);font-weight:600">${c.protocol}</td>
                <td style="padding:5px 10px;color:var(--text2)">${escHtml(c.local_addr)}:${c.local_port}</td>
                <td style="padding:5px 10px;color:var(--text2)">${c.remote_addr ? `${escHtml(c.remote_addr)}:${c.remote_port}` : '<span style="color:var(--text3)">—</span>'}</td>
                <td style="padding:5px 10px;color:${c.state === 'ESTABLISHED' ? 'var(--green)' : c.state === 'LISTENING' ? 'var(--accent)' : 'var(--text3)'};font-size:11px">${escHtml(c.state || '—')}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
    `;
}

// ── Process action handlers (called from inline onclicks in detail pane) ───
async function procActionSuspend(pid) {
    try {
        await invoke('suspend_process', { pid });
        showToast(`Process ${pid} suspended`, 'success');
        appendAuditLog('suspend_process', `PID ${pid}`, '');
        refreshProcessData();
    } catch (err) {
        showToast('Suspend failed: ' + String(err), 'error');
    }
}
async function procActionResume(pid) {
    try {
        await invoke('resume_process', { pid });
        showToast(`Process ${pid} resumed`, 'success');
        appendAuditLog('resume_process', `PID ${pid}`, '');
        refreshProcessData();
    } catch (err) {
        showToast('Resume failed: ' + String(err), 'error');
    }
}
function procActionPriority(pid) {
    const proc = _procData.find(p => p.pid === pid);
    const name = proc ? proc.name : `PID ${pid}`;
    openModal('Set Priority',
        `<div style="display:flex;flex-direction:column;gap:14px">
           <div style="font-size:13px;color:var(--text2)">Choose a CPU priority class for <strong>${escHtml(name)}</strong>.</div>
           <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px">
             <button class="btn" onclick="procDoSetPriority(${pid}, 0)">Idle</button>
             <button class="btn" onclick="procDoSetPriority(${pid}, 1)">Below Normal</button>
             <button class="btn btn-primary" onclick="procDoSetPriority(${pid}, 2)">Normal (default)</button>
             <button class="btn" onclick="procDoSetPriority(${pid}, 3)">Above Normal</button>
             <button class="btn btn-warning" onclick="procDoSetPriority(${pid}, 4)">High</button>
             <button class="btn btn-danger" onclick="procDoSetPriority(${pid}, 5)" title="Realtime priority can starve system processes including input and audio">Realtime ⚠</button>
           </div>
           <div style="font-size:11.5px;color:var(--text3);line-height:1.5">
             Higher priority means more CPU time when contention exists. <strong style="color:var(--yellow)">Realtime</strong> can starve system processes including keyboard, mouse, and audio — use only for short-running benchmarks.
           </div>
         </div>`,
        `<button class="btn" onclick="closeModal()">Cancel</button>`
    );
}
async function procDoSetPriority(pid, level) {
    try {
        const label = await invoke('set_process_priority', { pid, priority: level });
        showToast(`Priority set to ${label}`, 'success');
        appendAuditLog('set_priority', `PID ${pid}`, label);
        closeModal();
    } catch (err) {
        showToast('Set priority failed: ' + String(err), 'error');
    }
}
async function procActionOpenLocation(path) {
    if (!path) { showToast('No path available', 'info'); return; }
    try {
        await invoke('open_file_location', { path });
    } catch (err) {
        showToast('Open location failed: ' + String(err), 'error');
    }
}
async function procActionCopyCmd(pid) {
    const proc = _procData.find(p => p.pid === pid);
    if (!proc || !proc.command_line) { showToast('No command line', 'info'); return; }
    try {
        await navigator.clipboard.writeText(proc.command_line);
        showToast('Command line copied', 'success');
    } catch (err) {
        showToast('Copy failed: ' + String(err), 'error');
    }
}

// Copy a process's full state as JSON to the clipboard. Useful for bug
// reports, forensic snapshots, or sharing on chat.
async function procActionCopyJson(pid) {
    const proc = _procData.find(p => p.pid === pid);
    if (!proc) { showToast('Process not found', 'error'); return; }
    const snap = {
        captured_at: new Date().toISOString(),
        ...proc,
    };
    try {
        await navigator.clipboard.writeText(JSON.stringify(snap, null, 2));
        showToast('Process state copied as JSON', 'success');
    } catch (err) {
        showToast('Copy failed: ' + String(err), 'error');
    }
}

// CPU affinity setter — open a modal with one checkbox per logical CPU.
// Mask of 0 (no cores selected) is rejected on commit.
async function procActionAffinity(pid) {
    const proc = _procData.find(p => p.pid === pid);
    if (!proc) return;
    let cpuCount = 8;
    try {
        cpuCount = await invoke('get_cpu_count');
    } catch (err) {
        dwarn('procActionAffinity', 'get_cpu_count failed, falling back to 8-core default', { err: String(err) });
    }
    // Cap at 64 — we use a u64 mask in the IPC. Server systems above this
    // need processor groups which are out of scope.
    if (cpuCount > 64) cpuCount = 64;

    const checkboxes = [];
    for (let i = 0; i < cpuCount; i++) {
        checkboxes.push(`
          <label style="display:flex;align-items:center;gap:5px;padding:4px 8px;border:1px solid var(--border);border-radius:4px;background:var(--bg0);cursor:pointer;font-size:11.5px;font-family:monospace">
            <input type="checkbox" data-cpu="${i}" checked />
            CPU ${i}
          </label>`);
    }

    openModal('🎚 Set CPU Affinity',
        `<div style="display:flex;flex-direction:column;gap:14px">
           <div style="font-size:13px;color:var(--text2);line-height:1.5">
             Restrict <strong>${escHtml(proc.name)} (PID ${pid})</strong> to specific CPU cores. Useful for confining a hot process to a subset of cores so the rest of the system stays responsive.
           </div>
           <div style="display:flex;gap:6px">
             <button class="btn" onclick="procAffinitySetAll(true)">All cores</button>
             <button class="btn" onclick="procAffinitySetAll(false)">None</button>
             <button class="btn" onclick="procAffinityEvens()">Even cores</button>
             <button class="btn" onclick="procAffinityOdds()">Odd cores</button>
           </div>
           <div id="proc-affinity-grid" style="display:grid;grid-template-columns:repeat(auto-fill, minmax(80px, 1fr));gap:5px;max-height:280px;overflow-y:auto">
             ${checkboxes.join('')}
           </div>
           <div style="background:rgba(245,158,11,.06);border:1px solid rgba(245,158,11,.22);border-radius:5px;padding:8px 10px;font-size:11.5px;color:var(--text2);line-height:1.4">
             ⚠ Affinity changes are <strong>not</strong> persisted by Windows — they reset when the process restarts. The process must currently be running.
           </div>
         </div>`,
        `<button class="btn" onclick="closeModal()">Cancel</button>
         <button class="btn btn-primary" onclick="procAffinityCommit(${pid})">Apply</button>`
    );
}
function procAffinitySetAll(checked) {
    document.querySelectorAll('#proc-affinity-grid input[data-cpu]').forEach(cb => cb.checked = checked);
}
function procAffinityEvens() {
    document.querySelectorAll('#proc-affinity-grid input[data-cpu]').forEach(cb => {
        cb.checked = parseInt(cb.dataset.cpu, 10) % 2 === 0;
    });
}
function procAffinityOdds() {
    document.querySelectorAll('#proc-affinity-grid input[data-cpu]').forEach(cb => {
        cb.checked = parseInt(cb.dataset.cpu, 10) % 2 === 1;
    });
}
async function procAffinityCommit(pid) {
    const cpus = [...document.querySelectorAll('#proc-affinity-grid input[data-cpu]:checked')]
        .map(cb => parseInt(cb.dataset.cpu, 10));
    if (cpus.length === 0) {
        showToast('Select at least one core', 'error');
        return;
    }
    // Build mask. Use BigInt to avoid 32-bit truncation; convert to Number
    // for IPC since Tauri's u64 boundary tolerates JS numbers safely up to
    // 2^53 — and we only allow up to 64 cores so worst-case mask is 2^64-1
    // which doesn't fit. Truncate to u53 here, which covers 0-52 cores in
    // practice (typical client systems have 4-32 cores).
    let mask = 0n;
    for (const c of cpus) mask |= (1n << BigInt(c));
    // For >53 cores we'd need a different IPC encoding (string?), but
    // practically: Windows won't have >64 anyway and we cap at 64 above.
    const maskNum = Number(mask);
    if (!Number.isSafeInteger(maskNum)) {
        showToast('Mask too large (>53 bits) — try fewer high-numbered cores', 'error');
        return;
    }
    try {
        await invoke('set_process_affinity', { pid, mask: maskNum });
        showToast(`Affinity set to ${cpus.length} core${cpus.length === 1 ? '' : 's'}`, 'success');
        appendAuditLog('set_affinity', `PID ${pid}`, cpus.join(','));
        closeModal();
    } catch (err) {
        showToast('Set affinity failed: ' + String(err), 'error');
    }
}

// Kill a process and all its descendants. Big-hammer action — requires a
// preview confirmation showing the full tree of PIDs that would die.
async function confirmKillProcessTree(pid, name) {
    // Build the descendant list ourselves first (using local _procData) so
    // we can show a preview. The Rust side rebuilds it with a fresh refresh
    // when actually killing — short race window between preview and kill is
    // acceptable; user is reading the dialog for at least a second.
    const childrenOf = new Map();
    for (const p of _procData) {
        if (!p.parent_pid) continue;
        if (!childrenOf.has(p.parent_pid)) childrenOf.set(p.parent_pid, []);
        childrenOf.get(p.parent_pid).push(p);
    }
    const tree = [];
    const visited = new Set();
    const queue = [{ pid, depth: 0 }];
    visited.add(pid);
    while (queue.length > 0) {
        const { pid: cur, depth } = queue.shift();
        const proc = _procData.find(p => p.pid === cur);
        if (!proc) continue;
        tree.push({ proc, depth });
        for (const child of childrenOf.get(cur) || []) {
            if (!visited.has(child.pid)) {
                visited.add(child.pid);
                queue.push({ pid: child.pid, depth: depth + 1 });
            }
        }
    }

    const treeHtml = tree.length === 0
        ? '<div style="color:var(--text3);font-style:italic">Process not in current snapshot — only the root PID will be terminated.</div>'
        : tree.map(({ proc, depth }) => `
            <div style="padding:3px 8px;font-family:monospace;font-size:12px">
              ${'&nbsp;'.repeat(depth * 4)}${depth > 0 ? '└─ ' : ''}<strong style="color:var(--text2)">${escHtml(proc.name)}</strong>
              <span style="color:var(--text3)">(PID ${proc.pid})</span>
            </div>`).join('');

    openModal('💀 Kill Process Tree',
        `<div style="display:flex;flex-direction:column;gap:14px">
           <div style="font-size:14px;color:var(--text2);line-height:1.5">
             Forcefully terminate <strong>${escHtml(name)}</strong> (PID ${pid}) <strong>and all its descendants</strong>. This will kill <span style="color:var(--red);font-weight:700">${tree.length} process${tree.length === 1 ? '' : 'es'}</span>.
           </div>
           <div style="background:var(--bg0);border:1px solid var(--border);border-radius:5px;padding:8px;max-height:240px;overflow-y:auto">
             ${treeHtml}
           </div>
           <div style="background:rgba(239,68,68,.06);border:1px solid rgba(239,68,68,.22);border-radius:5px;padding:8px 10px;font-size:12px;color:var(--text2);line-height:1.5">
             ⚠ Children die <strong>before</strong> parents. Unsaved data in any of these processes will be lost. Killing the wrong tree (e.g. the shell or window manager) can crash your session.
           </div>
         </div>`,
        `<button class="btn" onclick="closeModal()">Cancel</button>
         <button class="btn btn-danger" onclick="procDoKillTree(${pid}, ${escHtml(JSON.stringify(name))})">💀 Kill ${tree.length} processes</button>`
    );
}

async function procDoKillTree(pid, name) {
    closeModal();
    try {
        const report = await invoke('kill_process_tree', { pid });
        appendAuditLog('kill_process_tree', name, `PID ${pid}, killed=${report.killed}, failed=${report.failed.length}`);
        if (report.failed.length === 0) {
            showToast(`Killed ${report.killed} process${report.killed === 1 ? '' : 'es'}`, 'success');
        } else {
            showToast(`Killed ${report.killed}, ${report.failed.length} failed (likely access denied on protected processes)`, 'warning');
            dwarn('procDoKillTree', 'partial', { failed: report.failed });
        }
        setTimeout(() => refreshProcessData(), 500);
    } catch (err) {
        showToast('Kill tree failed: ' + String(err), 'error');
    }
}

function procSelectPid(pid) {
    _procSelectedPid = pid;
    _procDetailDataCache = { modules: null, connections: null, lastModulesPid: null, lastConnsPid: null };
    renderProcList();
    renderProcDetailPane();
    // Scroll to selected row
    const row = document.querySelector(`#proc-list-body .proc-row[data-pid="${pid}"]`);
    if (row) row.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

// ── Toolbar actions ────────────────────────────────────────────────────────

function procToggleTree() {
    _procTreeMode = !_procTreeMode;
    if (_procTreeMode) {
        // When entering tree mode, also turn off group-by (mutually exclusive).
        if (_procGroupBy !== 'none') _procGroupBy = 'none';
        // Auto-expand all top-level processes (parent_pid == 0 or unknown)
        // so the user sees something useful immediately rather than just roots.
        _procExpanded.clear();
        for (const p of _procData) {
            if (!p.parent_pid || p.parent_pid === 0) _procExpanded.add(p.pid);
        }
        // Reflect groupBy reset in the dropdown
        const gb = document.getElementById('proc-groupby');
        if (gb) gb.value = 'none';
    }
    const btn = document.getElementById('proc-tree-btn');
    if (btn) btn.classList.toggle('btn-primary', _procTreeMode);
    saveProcStateToStorage();
    renderProcList();
}

// ── Group-by handler (Phase 5+) ─────────────────────────────────────────────
// Switches the list rendering mode to insert collapsible group headers.
// Mutually exclusive with tree mode — turning on group-by turns off tree.
function procSetGroupBy(val) {
    _procGroupBy = val;
    _procGroupCollapsed.clear();   // reset collapsed state when changing group key
    if (_procGroupBy !== 'none' && _procTreeMode) {
        _procTreeMode = false;
        const btn = document.getElementById('proc-tree-btn');
        if (btn) btn.classList.remove('btn-primary');
    }
    saveProcStateToStorage();
    renderProcList();
}

function procFindByPort() {
    openModal('Find Process by Port',
        `<div style="display:flex;flex-direction:column;gap:14px">
           <div style="font-size:13px;color:var(--text2)">Enter a TCP/UDP port number to find processes listening on or connected to it.</div>
           <input type="number" id="proc-port-input" class="form-control" placeholder="e.g. 80, 3000, 8080" min="1" max="65535" autocomplete="off" autofocus />
           <div id="proc-port-result" style="min-height:60px"></div>
         </div>`,
        `<button class="btn btn-primary" onclick="procDoFindByPort()">🔍 Search</button>
         <button class="btn" onclick="closeModal()">Close</button>`
    );
    setTimeout(() => {
        const inp = document.getElementById('proc-port-input');
        if (inp) {
            inp.focus();
            inp.onkeydown = (e) => { if (e.key === 'Enter') procDoFindByPort(); };
        }
    }, 100);
}

async function procDoFindByPort() {
    const portStr = document.getElementById('proc-port-input')?.value;
    const port = parseInt(portStr, 10);
    const resultEl = document.getElementById('proc-port-result');
    if (!port || port < 1 || port > 65535 || !resultEl) {
        if (resultEl) resultEl.innerHTML = `<div style="color:var(--red);padding:8px">Enter a valid port (1-65535)</div>`;
        return;
    }
    resultEl.innerHTML = `<div style="color:var(--text3);padding:8px">Searching…</div>`;
    try {
        const pids = await invoke('find_process_by_port', { port });
        if (pids.length === 0) {
            resultEl.innerHTML = `<div style="color:var(--text3);padding:14px;text-align:center">No process is using port <strong>${port}</strong>.</div>`;
            return;
        }
        const procs = pids.map(pid => _procData.find(p => p.pid === pid) || { pid, name: '(unknown)' });
        resultEl.innerHTML = `
          <div style="font-size:11px;color:var(--text3);text-transform:uppercase;letter-spacing:.06em;font-weight:700;margin-bottom:6px">${pids.length} process${pids.length === 1 ? '' : 'es'} using port ${port}</div>
          ${procs.map(p => `
            <div style="display:flex;align-items:center;gap:10px;padding:8px 10px;border:1px solid var(--border);border-radius:5px;margin-bottom:6px;background:var(--bg0)">
              <div style="font-family:monospace;color:var(--text3)">${p.pid}</div>
              <div style="flex:1;color:var(--text);font-weight:600">${escHtml(p.name)}</div>
              <button class="btn" style="font-size:11px;padding:3px 8px" onclick="procSelectPid(${p.pid}); closeModal();">Open</button>
            </div>`).join('')}
        `;
    } catch (err) {
        resultEl.innerHTML = `<div style="color:var(--red);padding:8px">Error: ${escHtml(String(err))}</div>`;
    }
}

function procToggleSnapshot() {
    if (_procSnapshot) {
        _procSnapshot = null;
        const info = document.getElementById('proc-snapshot-info');
        if (info) info.textContent = '';
        showToast('Snapshot cleared', 'info');
    } else {
        _procSnapshot = {
            timestamp: new Date(),
            byPid: new Map(_procData.map(p => [p.pid, { ...p }])),
        };
        const info = document.getElementById('proc-snapshot-info');
        if (info) info.innerHTML = `📸 Snapshot at ${_procSnapshot.timestamp.toLocaleTimeString()} — <span style="color:var(--green)">NEW</span> badges show processes that started after.`;
        showToast(`Snapshot taken (${_procData.length} processes)`, 'success');
    }
    renderProcList();
}

// ── Column picker (Phase 5+) ────────────────────────────────────────────────
// Lets users hide/show columns. Persisted via _procColumnVis. The Pin column
// (key '_pin') and Name column are kept visible at all times because hiding
// them would leave no way to interact with rows.
function procToggleColumnPicker() {
    const items = PROC_COLUMNS.map(c => {
        const isLocked = c.key === '_pin' || c.key === 'name';
        const checked = _procColumnVis[c.key] !== false;
        return `
          <label style="display:flex;align-items:center;gap:8px;padding:7px 10px;border:1px solid var(--border);border-radius:5px;background:var(--bg0);cursor:${isLocked ? 'not-allowed' : 'pointer'};${isLocked ? 'opacity:0.6' : ''}">
            <input type="checkbox" data-col-key="${escHtml(c.key)}" ${checked ? 'checked' : ''} ${isLocked ? 'disabled' : ''} />
            <span style="flex:1;color:var(--text2);font-size:13px">${escHtml(c.label || c.key)}</span>
            ${isLocked ? '<span style="font-size:10px;color:var(--text3)">required</span>' : ''}
          </label>`;
    }).join('');
    openModal('Show / Hide Columns',
        `<div style="display:flex;flex-direction:column;gap:14px">
           <div style="font-size:12.5px;color:var(--text2)">Choose which columns appear in the process list. Your selection is saved between sessions.</div>
           <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px" id="proc-col-picker-grid">${items}</div>
         </div>`,
        `<button class="btn" onclick="procResetColumns()">Reset to defaults</button>
         <button class="btn btn-primary" onclick="closeModal()">Done</button>`
    );
    // Wire change handlers — apply immediately so the user sees the effect.
    document.querySelectorAll('#proc-col-picker-grid input[data-col-key]').forEach(cb => {
        cb.onchange = () => {
            _procColumnVis[cb.dataset.colKey] = cb.checked;
            saveProcColumnVis();
            // Re-render shell to apply new grid template; refresh data into it.
            renderProcessManagerShell();
            renderProcList();
        };
    });
}

function procResetColumns() {
    _procColumnVis = {};
    for (const c of PROC_COLUMNS) _procColumnVis[c.key] = c.default;
    saveProcColumnVis();
    closeModal();
    renderProcessManagerShell();
    renderProcList();
}

// ── Highlight rules editor (Phase 5+) ───────────────────────────────────────
// Modal for managing the row-highlight rule list. Rules are saved on every
// change so closing the modal preserves edits.
function procEditHighlights() {
    const listHtml = _procHighlights.length === 0
        ? `<div style="color:var(--text3);padding:18px;text-align:center;font-style:italic">No rules. Click "Add rule" below to create one.</div>`
        : _procHighlights.map((r, i) => `
            <div style="display:grid;grid-template-columns:24px 110px 90px 60px 1fr 50px 40px;gap:6px;align-items:center;padding:6px;background:var(--bg0);border:1px solid var(--border);border-radius:5px;margin-bottom:6px">
              <input type="checkbox" ${r.enabled ? 'checked' : ''} data-hl-i="${i}" data-hl-field="enabled" />
              <input type="text" class="form-control" style="font-size:12px;padding:3px 6px" value="${escHtml(r.label || '')}" data-hl-i="${i}" data-hl-field="label" placeholder="Label" />
              <select class="form-control" style="font-size:12px;padding:3px 6px" data-hl-i="${i}" data-hl-field="type">
                <option value="cpu"    ${r.type === 'cpu'    ? 'selected' : ''}>CPU %</option>
                <option value="memory" ${r.type === 'memory' ? 'selected' : ''}>Memory MB</option>
                <option value="name"   ${r.type === 'name'   ? 'selected' : ''}>Name</option>
                <option value="user"   ${r.type === 'user'   ? 'selected' : ''}>User</option>
              </select>
              <select class="form-control" style="font-size:12px;padding:3px 6px" data-hl-i="${i}" data-hl-field="op">
                <option value=">" ${r.op === '>' ? 'selected' : ''}>&gt;</option>
                <option value="<" ${r.op === '<' ? 'selected' : ''}>&lt;</option>
                <option value="contains" ${r.op === 'contains' ? 'selected' : ''}>contains</option>
              </select>
              <input type="text" class="form-control" style="font-size:12px;padding:3px 6px" value="${escHtml(String(r.value))}" data-hl-i="${i}" data-hl-field="value" placeholder="Value" />
              <input type="color" value="${escHtml(r.color || '#3b82f6')}" data-hl-i="${i}" data-hl-field="color" style="width:42px;height:26px;padding:0;border:1px solid var(--border);border-radius:4px;background:none;cursor:pointer" />
              <button class="btn btn-danger" style="font-size:11px;padding:3px 6px" data-hl-del="${i}" title="Remove rule">✕</button>
            </div>`).join('');

    openModal('🎨 Row Highlight Rules',
        `<div style="display:flex;flex-direction:column;gap:12px">
           <div style="font-size:12.5px;color:var(--text2);line-height:1.5">
             Each row is matched against rules in order; the first match wins. Rule background tint is applied at low alpha so text remains readable. <strong>Threshold rules</strong> (CPU/Memory) compare against numeric values; <strong>Name/User</strong> use case-insensitive substring matching.
           </div>
           <div id="proc-hl-list">${listHtml}</div>
           <div style="display:flex;gap:6px">
             <button class="btn" onclick="procAddHighlightRule()">+ Add rule</button>
             <button class="btn" onclick="procResetHighlights()" title="Restore the built-in rules">Reset to defaults</button>
           </div>
         </div>`,
        `<button class="btn btn-primary" onclick="closeModal(); renderProcList();">Done</button>`
    );
    procWireHighlightInputs();
}

function procWireHighlightInputs() {
    document.querySelectorAll('#proc-hl-list [data-hl-i]').forEach(el => {
        const i = parseInt(el.dataset.hlI, 10);
        const f = el.dataset.hlField;
        const handler = () => {
            if (!_procHighlights[i]) return;
            if (f === 'enabled') _procHighlights[i].enabled = el.checked;
            else _procHighlights[i][f] = el.value;
            saveProcHighlights();
            // Don't re-render the modal on every keystroke — that destroys focus.
            // List re-render happens on modal close.
        };
        if (el.tagName === 'INPUT' && el.type === 'checkbox') el.onchange = handler;
        else if (el.tagName === 'INPUT') el.oninput = handler;
        else if (el.tagName === 'SELECT') el.onchange = handler;
    });
    document.querySelectorAll('#proc-hl-list [data-hl-del]').forEach(btn => {
        btn.onclick = () => {
            const i = parseInt(btn.dataset.hlDel, 10);
            _procHighlights.splice(i, 1);
            saveProcHighlights();
            procEditHighlights();   // re-render modal to update indexes
        };
    });
}

function procAddHighlightRule() {
    _procHighlights.push({
        id: 'r' + Date.now(),
        label: 'New rule',
        type: 'cpu',
        op: '>',
        value: 25,
        color: '#3b82f6',
        enabled: true,
    });
    saveProcHighlights();
    procEditHighlights();
}

function procResetHighlights() {
    confirmAction(
        'Reset highlight rules?',
        'This removes all your custom rules and restores only the built-in defaults (High CPU, High memory). Cannot be undone.',
        'Reset',
        () => {
            try { localStorage.removeItem(PROC_HIGHLIGHT_KEY); } catch (_) {}
            _procHighlights = loadProcHighlights();
            procEditHighlights();
        }
    );
}

// ── CSV export (Phase 5+) ───────────────────────────────────────────────────
// Exports the currently-visible processes (after filters/sort) using the
// currently-visible column set. Convenient for sharing state in bug reports
// or analyzing patterns in a spreadsheet.
function procExportCsv() {
    const filtered = applyProcFilters(_procData);
    if (filtered.length === 0) {
        showToast('No processes to export (filters too restrictive?)', 'info');
        return;
    }
    const cols = visibleProcColumns().filter(c => c.key !== '_pin');
    // CSV-escape: wrap in quotes, double internal quotes
    // formula-injection-guarded + uniform RFC4180 quoting (audit 2026-06-11);
    // csvCell leaves purely numeric cells unprefixed so PID/CPU/MB columns
    // still sort and sum in Excel.
    const esc = csvCell;

    const header = cols.map(c => esc(c.label || c.key)).join(',') + '\n';
    const rows = filtered.map(p => cols.map(c => {
        const raw = p[c.key];
        // For the "name" column, also include command_line for usefulness in CSV
        if (c.key === 'name' && p.command_line) {
            return esc(`${p.name} ${p.command_line}`);
        }
        return esc(raw);
    }).join(',')).join('\n');

    const csv = header + rows + '\n';
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url  = URL.createObjectURL(blob);
    const ts   = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const a = document.createElement('a');
    a.href = url;
    a.download = `wintaskpro_processes_${ts}.csv`;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    showToast(`Exported ${filtered.length} processes`, 'success');
}

// ── System overview header (Phase 5+) ───────────────────────────────────────
// 4 cards showing aggregate state at the top of the page. Computed entirely
// from the local _procData snapshot — no extra IPC. Updates on every refresh.
function renderProcSystemOverview() {
    const overviewEl = document.getElementById('proc-system-overview');
    if (!overviewEl || _procData.length === 0) return;

    // System-wide values from get_system_overview IPC. Fall back to safer
    // defaults if the IPC failed (network disconnect, sysinfo not yet warm).
    // Clamp cpuPct here too as a final defence — a bug in the IPC or in
    // sysinfo on some Windows configurations was reported producing values
    // like 299% in the field.
    const ov = _procSystemOverview || {};
    let cpuPct = typeof ov.cpu_pct === 'number' ? ov.cpu_pct : 0;
    if (cpuPct < 0) cpuPct = 0;
    if (cpuPct > 100) cpuPct = 100;
    const memUsedGb   = (ov.mem_used_bytes  || 0) / (1024 * 1024 * 1024);
    const memTotalGb  = (ov.mem_total_bytes || 0) / (1024 * 1024 * 1024);
    const memPct      = memTotalGb > 0 ? (memUsedGb / memTotalGb) * 100 : 0;

    // Per-process aggregates that are still informative. Threads is now
    // populated via Win32 toolhelp (the get_all_thread_counts helper); on
    // 1.14.1 and earlier this column was always 0 because sysinfo's
    // Process::tasks() returns None on Windows in our build configuration.
    const totalThreads = _procData.reduce((s, p) => s + (p.threads || 0), 0);
    const totalHandles = _procData.reduce((s, p) => s + (p.handles || 0), 0);
    const totalIo = _procData.reduce((s, p) => s + (p.disk_read_kb_s || 0) + (p.disk_write_kb_s || 0), 0);

    // Top 5 by CPU — small inline list. We keep showing per-process CPU
    // here because that IS the per-process value (% of one core). The card
    // value above is the system-wide aggregate; these are the contributors.
    const topCpu = [..._procData]
        .sort((a, b) => b.cpu_usage - a.cpu_usage)
        .slice(0, 5)
        .filter(p => p.cpu_usage > 0.1);

    const cpuColor = cpuPct > 80 ? 'var(--red)' : cpuPct > 50 ? 'var(--yellow)' : null;
    const memColor = memPct > 90 ? 'var(--red)' : memPct > 75 ? 'var(--yellow)' : null;
    const ioColor  = totalIo > 100000 ? 'var(--yellow)' : null;

    const card = (label, value, sub, color) => `
      <div style="flex:1;background:var(--bg2);border:1px solid var(--border);border-radius:6px;padding:10px 12px;min-width:0">
        <div style="font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:var(--text3);font-weight:700">${label}</div>
        <div style="font-size:18px;font-weight:600;color:${color || 'var(--text)'};margin-top:2px">${value}</div>
        ${sub ? `<div style="font-size:11px;color:var(--text3);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${sub}</div>` : ''}
      </div>`;

    overviewEl.innerHTML =
      card('CPU',
           `${cpuPct.toFixed(1)}<span style="font-size:12px;color:var(--text3);font-weight:400">%</span>`,
           `${_procData.length} processes${ov.cpu_count ? ` · ${ov.cpu_count} cores` : ''}`, cpuColor) +
      card('Memory',
           memTotalGb > 0
             ? `${memUsedGb.toFixed(1)}<span style="font-size:12px;color:var(--text3);font-weight:400"> / ${memTotalGb.toFixed(0)} GB</span>`
             : `—`,
           memTotalGb > 0 ? `${memPct.toFixed(0)}% in use` : '', memColor) +
      card('Threads / Handles',
           `${totalThreads.toLocaleString()} <span style="font-size:12px;color:var(--text3);font-weight:400">/</span> ${totalHandles.toLocaleString()}`,
           '', null) +
      card('Disk I/O',
           `${totalIo.toLocaleString()}<span style="font-size:12px;color:var(--text3);font-weight:400"> KB/s</span>`,
           'all processes combined', ioColor) +
      `<div style="flex:2;background:var(--bg2);border:1px solid var(--border);border-radius:6px;padding:10px 12px;min-width:0">
         <div style="font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:var(--text3);font-weight:700">Top CPU (per-process)</div>
         <div style="margin-top:4px;display:flex;flex-direction:column;gap:2px;font-family:monospace;font-size:11px">
           ${topCpu.length === 0
             ? '<div style="color:var(--text3);font-style:italic">All idle</div>'
             : topCpu.map(p => `
               <div style="display:flex;gap:8px;align-items:center;cursor:pointer;color:var(--text2)" onclick="procSelectPid(${p.pid})">
                 <div style="color:${p.cpu_usage > 50 ? 'var(--red)' : p.cpu_usage > 10 ? 'var(--yellow)' : 'var(--text)'};font-weight:600;min-width:42px;text-align:right">${p.cpu_usage.toFixed(1)}%</div>
                 <div style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(p.name)}</div>
               </div>`).join('')}
         </div>
       </div>`;
}

function procFilterUserChange(val)     { _procFilterUser = val;     saveProcStateToStorage(); renderProcList(); }
function procFilterElevatedChange(val) { _procFilterElevated = val; saveProcStateToStorage(); renderProcList(); }
function procFilterSysHideChange(val)  { _procFilterSysHide = val;  saveProcStateToStorage(); renderProcList(); }

function showProcContextMenu(e, pid) {
    const proc = _procData.find(p => p.pid === pid);
    if (!proc) return;
    const ctxMenu = document.getElementById('ctx-menu');
    if (!ctxMenu) return;
    const isWatched = _procWatchlist.has(pid);
    const safeName = escHtml(JSON.stringify(proc.name));
    ctxMenu.innerHTML = `
      <div class="ctx-item" onclick="procSelectPid(${pid}); hideCtxMenu();">📋 Show details</div>
      <div class="ctx-item" onclick="procToggleWatch(${pid}); hideCtxMenu();">${isWatched ? '★ Unwatch' : '☆ Add to watchlist'}</div>
      <div class="ctx-item" onclick="procActionCopyCmd(${pid}); hideCtxMenu();">📄 Copy command line</div>
      <div class="ctx-item" onclick="procActionCopyJson(${pid}); hideCtxMenu();">📋 Copy as JSON</div>
      <div class="ctx-item" onclick="procActionOpenLocation(${escHtml(JSON.stringify(proc.exe_path || ''))}); hideCtxMenu();">📁 Open file location</div>
      <div class="ctx-item" onclick="procActionPriority(${pid}); hideCtxMenu();">⚙ Set priority…</div>
      <div class="ctx-item" onclick="procActionAffinity(${pid}); hideCtxMenu();">🎚 Set CPU affinity…</div>
      <div class="ctx-item" onclick="procActionSuspend(${pid}); hideCtxMenu();">⏸ Suspend</div>
      <div class="ctx-item" onclick="procActionResume(${pid}); hideCtxMenu();">▶ Resume</div>
      <div class="ctx-item danger" onclick="confirmKillProcess(${pid}, ${safeName}); hideCtxMenu();">⏹ Kill process</div>
      <div class="ctx-item danger" onclick="confirmKillProcessTree(${pid}, ${safeName}); hideCtxMenu();">💀 Kill process tree…</div>
    `;
    ctxMenu.style.display = 'block';
    ctxMenu.style.left = e.pageX + 'px';
    ctxMenu.style.top  = e.pageY + 'px';
}

function procToggleWatch(pid) {
    if (_procWatchlist.has(pid)) _procWatchlist.delete(pid);
    else _procWatchlist.add(pid);
    saveProcWatchlist();
    renderProcList();
}

function procSort(col) {
    if (_procSortCol === col) { _procSortDir = -_procSortDir; }
    else { _procSortCol = col; _procSortDir = -1; }
    saveProcStateToStorage();
    // Update header arrows. We replace text content carefully because column
    // labels may contain " %" or other chars that look arrow-like; key off
    // the column schema instead of regex on textContent.
    const cols = visibleProcColumns();
    document.querySelectorAll('#proc-list-header [data-sort]').forEach(th => {
        const colDef = cols.find(c => c.key === th.dataset.sort);
        if (!colDef) return;
        const isCur = th.dataset.sort === _procSortCol;
        const arrow = isCur ? (_procSortDir < 0 ? ' ↓' : ' ↑') : '';
        th.style.color = isCur ? 'var(--accent)' : '';
        th.textContent = colDef.label + arrow;
    });
    renderProcList();
}

function procSearchChange(val) {
    _procSearch = val;
    renderProcList();
}

function confirmKillProcess(pid, name) {
    openModal('⏹ Kill Process',
        `<div style="padding:4px">
           <div style="font-size:15px;font-weight:700;color:var(--red);margin-bottom:6px">${escHtml(name)} (PID ${pid})</div>
           <p style="font-size:13px;color:var(--text2);line-height:1.5">Forcefully terminate this process? Unsaved data in the process will be lost. Killing system processes can crash the OS.</p>
         </div>`,
        `<button class="btn" onclick="closeModal()">Cancel</button>
         <button class="btn btn-danger" id="kill-ok-btn">⏹ Kill Process</button>`);
    requestAnimationFrame(() => {
        const okBtn = document.getElementById('kill-ok-btn');
        if (okBtn) okBtn.onclick = async () => {
            closeModal();
            try {
                await invoke('kill_process', { pid });
                showToast(`Process ${name} (PID ${pid}) terminated`, 'success');
                appendAuditLog('kill_process', name, `PID ${pid}`);
                setTimeout(() => refreshProcessData(), 500);
            } catch (err) {
                showToast('Kill failed: ' + err, 'error');
            }
        };
    });
}

// ════════════════════════════════════════════════════════════════════════════════
// FEATURE: Auto-refresh countdown in topbar
// ════════════════════════════════════════════════════════════════════════════════
let _countdownInterval = null;
let _countdownNext     = 0;

function startRefreshCountdown(intervalSecs) {
  stopRefreshCountdown();
  _countdownNext = Date.now() + intervalSecs * 1000;
  const el = document.getElementById('refresh-countdown');
  if (!el) return;
  el.style.display = '';
  _countdownInterval = setInterval(() => {
    const rem = Math.max(0, Math.ceil((_countdownNext - Date.now()) / 1000));
    if (el) el.textContent = `↺ ${rem}s`;
    if (rem === 0) _countdownNext = Date.now() + intervalSecs * 1000;
  }, 500);
}

function stopRefreshCountdown() {
  if (_countdownInterval) { clearInterval(_countdownInterval); _countdownInterval = null; }
  const el = document.getElementById('refresh-countdown');
  if (el) el.style.display = 'none';
}

// ════════════════════════════════════════════════════════════════════════════════
// FEATURE (audit 2026-06-19): Favorites / pinning · Saved searches · Health panel
// All pure-frontend over the already-loaded allTasks + localStorage. Functions are
// global (classic script) so inline onclick handlers can reach them. State (_favorites,
// _favFilterActive, _savedSearches) is declared near the top of this file so it is
// initialized before the first filterTasks()/renderTable() call.
// ════════════════════════════════════════════════════════════════════════════════

// ── Favorites ────────────────────────────────────────────────────────────────
function saveFavorites() {
  try { localStorage.setItem('wtp_favorites', JSON.stringify([..._favorites])); }
  catch (e) { derror('favorites', 'save failed', { err: String(e) }); showToast('Could not save favorites — storage may be full', 'error'); }
}
function isFavorite(path) { return _favorites.has(path); }
function toggleFavorite(path) {
  if (!path) return;
  if (_favorites.has(path)) _favorites.delete(path); else _favorites.add(path);
  const nowFav = _favorites.has(path);
  saveFavorites();
  appendAuditLog(nowFav ? 'favorite_add' : 'favorite_remove', path, '');
  dinfo('favorites', nowFav ? 'pinned' : 'unpinned', { path });
  updateFavCount();
  filterTasks();   // re-render so the star, row highlight and pin-to-top update
}
function updateFavCount() {
  const el = document.getElementById('fav-count');
  if (el) el.textContent = _favorites.size;
  const pill = document.getElementById('fav-filter-pill');
  if (pill) { pill.classList.toggle('active', _favFilterActive); pill.setAttribute('aria-pressed', String(_favFilterActive)); }
}
function toggleFavoritesFilter() {
  _favFilterActive = !_favFilterActive;
  updateFavCount();
  filterTasks();
}

// ── Saved searches ───────────────────────────────────────────────────────────
function saveCurrentSearch() {
  const search = document.getElementById('search-input')?.value || '';
  const status = document.getElementById('status-filter')?.value || '';
  const tag    = _activeTagFilter || '';
  if (!search && !status && !tag && !_favFilterActive) {
    showToast('Nothing to save — set a search, status, tag or favorites filter first', 'info');
    return;
  }
  const label = (search || status || tag || 'Favorites').slice(0, 28);
  _savedSearches.push({ id: 's_' + Date.now().toString(36), label, search, status, tag, fav: _favFilterActive });
  try { localStorage.setItem('wtp_saved_searches', JSON.stringify(_savedSearches)); }
  catch (e) { derror('savedSearches', 'save failed', { err: String(e) }); showToast('Could not save search — storage may be full', 'error'); return; }
  appendAuditLog('saved_search_add', label, '');
  renderSavedSearchBar();
  showToast('Search saved', 'success');
}
function applySavedSearch(id) {
  const s = _savedSearches.find(x => x.id === id);
  if (!s) return;
  const se = document.getElementById('search-input'); if (se) se.value = s.search || '';
  const st = document.getElementById('status-filter'); if (st) st.value = s.status || '';
  _activeTagFilter = s.tag || null;
  _favFilterActive = !!s.fav;
  const clearBtn = document.getElementById('search-clear-btn');
  if (clearBtn) clearBtn.style.display = (s.search ? '' : 'none');
  updateFavCount();
  if (typeof renderTagFilterBar === 'function') renderTagFilterBar();
  filterTasks();
}
function deleteSavedSearch(id, ev) {
  if (ev) ev.stopPropagation();
  _savedSearches = _savedSearches.filter(x => x.id !== id);
  try { localStorage.setItem('wtp_saved_searches', JSON.stringify(_savedSearches)); }
  catch (e) { derror('savedSearches', 'delete-save failed', { err: String(e) }); }
  renderSavedSearchBar();
}
function renderSavedSearchBar() {
  const bar = document.getElementById('saved-search-bar');
  if (!bar) return;
  if (!_savedSearches.length) { bar.style.display = 'none'; bar.innerHTML = ''; return; }
  bar.style.display = '';
  bar.innerHTML = '<span class="ss-label">Saved</span>' + _savedSearches.map(s =>
    `<span class="saved-search-chip" role="button" tabindex="0" onclick="applySavedSearch(${escHtml(JSON.stringify(s.id))})" title="Apply saved search">` +
    `${escHtml(s.label)}` +
    `<span class="ss-del" title="Delete saved search" onclick="deleteSavedSearch(${escHtml(JSON.stringify(s.id))}, event)">✕</span>` +
    `</span>`).join('');
}

// ── Task health scoring ──────────────────────────────────────────────────────
// Composite 0-100 score from signals already present in TaskInfo, with reasons.
function scoreTaskHealth(task) {
  let score = 100; const reasons = [];
  const code = task.last_result_code;
  if (!task.enabled) { score -= 10; reasons.push('disabled'); }
  if (code !== 0 && code !== TASK_RESULT_RUNNING && code !== TASK_RESULT_NOT_RUN) {
    score -= 45; reasons.push('last run failed (' + (task.last_result || code) + ')');
  }
  const noLast = (task.last_run === 'Never' || !task.last_run);
  const noNext = (task.next_run === 'Never' || !task.next_run);
  if (noLast && noNext) { score -= 25; reasons.push('never run and not scheduled'); }
  else if (noNext) { score -= 12; reasons.push('no next run scheduled'); }
  if (task.actions && task.actions.length === 0) { score -= 20; reasons.push('no action defined'); }
  if (score < 0) score = 0;
  let grade = 'good'; if (score < 50) grade = 'bad'; else if (score < 80) grade = 'warn';
  return { score, grade, reasons };
}
function jumpToTask(path) {
  closeModal();
  const t = allTasks.find(z => z.path === path);
  if (!t) return;
  if (currentPage !== 'tasks') showPage('tasks');
  openDetail(t);
}
function openHealthPanel() {
  if (!allTasks.length) { showToast('No tasks loaded yet', 'info'); return; }
  const scored = allTasks.map(t => ({ t, h: scoreTaskHealth(t) })).sort((a, b) => a.h.score - b.h.score);
  const unhealthy = scored.filter(x => x.h.grade !== 'good');
  const list = unhealthy.length ? unhealthy : scored.slice(0, 10);
  const body =
    `<div style="margin-bottom:12px;color:var(--text2);font-size:13px">` +
    (unhealthy.length
      ? `<strong style="color:var(--text)">${unhealthy.length}</strong> task(s) need attention — lowest health first. Click a row to inspect it.`
      : `All tasks look healthy — showing the 10 lowest scores.`) +
    `</div>` +
    list.map(x =>
      `<div class="health-score-row" role="button" tabindex="0" onclick="jumpToTask(${escHtml(JSON.stringify(x.t.path))})">` +
      `<div class="health-grade ${x.h.grade}">${x.h.score}</div>` +
      `<div class="health-score-meta">` +
      `<div class="health-score-name">${escHtml(x.t.name)}</div>` +
      `<div class="health-score-reasons">${x.h.reasons.length ? escHtml(x.h.reasons.join(' · ')) : 'healthy'}</div>` +
      `</div></div>`).join('');
  openModal('🩺 Task Health', body, '<button class="btn" onclick="closeModal()">Close</button>');
}

// ── One-time UI injection (DOM already parsed: app.js loads at end of <body>) ──
function initNewFeaturesUI() {
  const statsBar = document.getElementById('stats-bar');
  if (statsBar && !document.getElementById('fav-filter-pill')) {
    const pill = document.createElement('div');
    pill.className = 'stat-pill'; pill.id = 'fav-filter-pill';
    pill.setAttribute('role', 'button'); pill.setAttribute('tabindex', '0');
    pill.setAttribute('aria-pressed', 'false'); pill.title = 'Show only favorites';
    pill.innerHTML = '★ Favorites <strong id="fav-count">0</strong>';
    pill.onclick = toggleFavoritesFilter;
    statsBar.appendChild(pill);
    // Saved-search chip bar, as a sibling right after the stats bar
    if (!document.getElementById('saved-search-bar')) {
      const bar = document.createElement('div');
      bar.id = 'saved-search-bar'; bar.style.display = 'none';
      statsBar.insertAdjacentElement('afterend', bar);
    }
  }
  const tl = document.getElementById('topbar-left');
  if (tl && !document.getElementById('health-btn')) {
    const hb = document.createElement('button');
    hb.className = 'btn'; hb.id = 'health-btn'; hb.title = 'Task health overview';
    hb.innerHTML = '<svg class="ico" aria-hidden="true"><use href="#i-health"/></svg> Health'; hb.onclick = openHealthPanel;
    tl.appendChild(hb);
  }
  const tr = document.getElementById('topbar-right');
  if (tr && !document.getElementById('save-search-btn')) {
    const sb = document.createElement('button');
    sb.className = 'btn'; sb.id = 'save-search-btn'; sb.title = 'Save the current search/filter as a chip';
    sb.innerHTML = '<svg class="ico" aria-hidden="true"><use href="#i-save"/></svg> Save Search'; sb.onclick = saveCurrentSearch;
    tr.appendChild(sb);
  }
  updateFavCount();
  renderSavedSearchBar();
}
initNewFeaturesUI();

