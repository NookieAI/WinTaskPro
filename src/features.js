/* ============================================================================
 * WinTaskPro — Feature Pack (1.15.0)
 * ----------------------------------------------------------------------------
 * Eight features, all built on IPC commands already registered in main.rs.
 * NO new Rust commands are introduced — every invoke() target here already
 * exists (verified against generate_handler! per Rule 31):
 *   export_task_xml, import_task_xml, delete_task, run_task, get_task_history,
 *   get_all_tasks, search_event_history, get_folders.
 *
 * Features
 *   1. Recycle Bin / Undo Delete       — deletedTrash:* + Undo toast + Trash page
 *   2. Tamper Watch (definition drift)  — trustBaseline:* snapshot + drift card
 *   3. True Test Run (real principal)   — temp wrapper task + run + history poll
 *   4. "While You Were Away" digest     — search_event_history over last 24h
 *   5. 24-hour schedule timeline        — next_run data on a horizontal track
 *   6. Failure-code explainer           — HRESULT → plain-English lookup
 *   7. Backup / Restore all tasks       — bundle XML export + import wizard
 *   8. Command palette (Ctrl+K)         — fuzzy jump-to-task + action launcher
 *
 * This file depends on functions defined in app.js (escHtml, showToast,
 * openModal, closeModal, invoke, dinfo/dwarn/derror, appendAuditLog,
 * refreshAll, showPage, allTasks, openEditDialog, runTask, healthScore).
 * It is loaded AFTER app.js in index.html, so those are all in scope.
 * ========================================================================== */

'use strict';

/* ──────────────────────────────────────────────────────────────────────────
 * Shared: small storage helpers (localStorage, guarded — Rule 9)
 * ────────────────────────────────────────────────────────────────────────── */
function fpLoad(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (err) {
    dwarn('features', 'load failed; using fallback', { key, err: String(err) });
    return fallback;
  }
}
function fpSave(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (err) {
    // QuotaExceeded is the realistic failure (many large XML blobs).
    derror('features', 'save failed', { key, err: String(err) });
    showToast('Could not save — local storage may be full', 'error');
    return false;
  }
}

// ISO-ish timestamp for filenames and display.
function fpStamp(d = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
function fpFileStamp(d = new Date()) {
  return fpStamp(d).replace(/[: ]/g, '-');
}

// Trigger a browser download of text content (mirrors the CSV-export pattern).
function fpDownload(filename, text, mime = 'application/xml') {
  const blob = new Blob([text], { type: mime + ';charset=utf-8' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = filename; a.style.display = 'none';
  document.body.appendChild(a); a.click();
  document.body.removeChild(a); URL.revokeObjectURL(url);
}

/* ══════════════════════════════════════════════════════════════════════════
 * FEATURE 6 — Failure-code explainer  (defined first; used by digest + cards)
 * ══════════════════════════════════════════════════════════════════════════
 * Pure-JS lookup: HRESULT / scheduler result code → { cause, advice }.
 * Covers the codes that actually show up in Task Scheduler "Last Result".
 * Accepts a numeric code OR the formatted string ("Error (0x80070002)").
 */
const HRESULT_TABLE = {
  0x0:        { name: 'Success',                         cause: 'The task action completed and returned 0.', advice: '' },
  0x41300:    { name: 'Task is ready',                    cause: 'The task is ready to run at its next scheduled time.', advice: '' },
  0x41301:    { name: 'Task is currently running',        cause: 'An instance of the task is executing right now.', advice: '' },
  0x41302:    { name: 'Task is disabled',                 cause: 'The task is disabled and will not run on its triggers.', advice: 'Enable the task if it should run.' },
  0x41303:    { name: 'Task has not yet run',             cause: 'The task has never been triggered since it was created or last reset.', advice: '' },
  0x41304:    { name: 'No more scheduled runs',           cause: 'All of the task\u2019s triggers have expired.', advice: 'Add or extend a trigger if it should keep running.' },
  0x41306:    { name: 'Task was terminated',              cause: 'The task was stopped \u2014 by a user, by the execution time-limit, or on shutdown.', advice: 'Check the execution time limit on the Advanced tab if termination was unexpected.' },
  0x4131B:    { name: 'No triggers / can\u2019t start',    cause: 'The task has no triggers able to start it, or the trigger condition was never met.', advice: 'Add a trigger, or check that the trigger\u2019s day/time mask is not empty.' },
  0x80070002: { name: 'File not found',                   cause: 'The program, script, or working directory the action points to does not exist.', advice: 'Verify the Program path and Working Directory on the Action tab \u2014 a moved or renamed file is the usual cause.' },
  0x80070003: { name: 'Path not found',                   cause: 'Part of the path to the program could not be found.', advice: 'Check that every folder in the Program path exists and is spelled correctly.' },
  0x80070005: { name: 'Access denied',                    cause: 'The account the task runs as lacks permission to run the program or read its files.', advice: 'Check the Run-As account and Run Level (Highest Privileges), and the file/folder permissions on the target.' },
  0x8007000E: { name: 'Out of memory',                    cause: 'The system could not allocate memory to start the action.', advice: 'Free up memory or stagger the task away from other heavy jobs.' },
  0x80070020: { name: 'File in use (sharing violation)',  cause: 'The program or a file it needs is locked by another process.', advice: 'Ensure a previous run has fully exited; consider "Stop existing instance" on the Advanced tab.' },
  0x80070040: { name: 'Network name no longer available', cause: 'A network path the task uses went away mid-run.', advice: 'If the action lives on a share, enable "Run only if network available" and add a startup delay.' },
  0x80070420: { name: 'Service has not been started',     cause: 'A Windows service the action depends on was not running.', advice: 'Add the required service as a dependency, or a startup delay so it has time to start.' },
  0x800704DD: { name: 'Not logged on (no interactive session)', cause: 'The task is set to run only when the user is logged on, but no interactive session was present.', advice: 'Switch the task to "Run whether user is logged on or not" if it must run unattended.' },
  0x800705B4: { name: 'Operation timed out',              cause: 'The action did not finish within its time limit and was stopped.', advice: 'Raise the execution time limit on the Advanced tab, or speed up the script.' },
  0x80070571: { name: 'Corrupt / structure error',       cause: 'The action or one of its files returned a corruption error.', advice: 'Re-check the script or executable; a partial download or disk error is a common cause.' },
  0x800710E0: { name: 'No mapped network drive at logon', cause: 'The action referenced a mapped drive that is not available to the task\u2019s session.', advice: 'Use a full UNC path (\\\\server\\share\\...) instead of a mapped drive letter.' },
  0x8004130F: { name: 'No account information',           cause: 'The stored credentials for the run-as account are missing or were cleared.', advice: 'Re-enter the task\u2019s run-as account, or switch it to SYSTEM / current user.' },
  0xC000013A: { name: 'Terminated by Ctrl+C / shutdown',  cause: 'The action was ended by a console interrupt or by the system shutting down.', advice: 'Usually benign if it coincided with a reboot; otherwise check what is signalling the process.' },
  0xC0000142: { name: 'DLL initialization failed',        cause: 'A library the program loads failed to initialise \u2014 often a missing runtime.', advice: 'Confirm the program\u2019s runtime prerequisites (e.g. .NET, VC++ redistributable) are installed.' },
  0x1:        { name: 'Incorrect function / generic error', cause: 'The program ran but returned exit code 1 (its own "something went wrong").', advice: 'This code comes from your script, not Windows \u2014 use Test Run to see its output.' },
  0x2:        { name: 'Exit code 2',                      cause: 'The program returned exit code 2 \u2014 meaning is defined by the program itself.', advice: 'Check the program\u2019s own documentation; use Test Run to capture stderr.' },
};

// Normalise a code (number or "Error (0x...)"/"Success" string) to a uint32, or null.
function fpNormalizeCode(input) {
  if (typeof input === 'number') return input >>> 0;
  if (typeof input !== 'string') return null;
  const s = input.trim();
  if (/^success$/i.test(s)) return 0;
  const hex = s.match(/0x([0-9a-fA-F]+)/);
  if (hex) return parseInt(hex[1], 16) >>> 0;
  const dec = s.match(/^-?\d+$/);
  if (dec) return (parseInt(s, 10)) >>> 0;
  return null;
}

// Returns { name, cause, advice, hex } or null when the code is unknown/success-noise.
function explainResultCode(input) {
  const code = fpNormalizeCode(input);
  if (code === null) return null;
  // Benign codes carry no actionable explanation, so we return null for them:
  // the "?" help badge should only appear next to results that represent a
  // real problem worth investigating. 0=success, 0x41300=ready,
  // 0x41301=running, 0x41303=not yet run, 0x41304=no more runs.
  const BENIGN = new Set([0x0, 0x41300, 0x41301, 0x41303, 0x41304]);
  if (BENIGN.has(code)) return null;
  const entry = HRESULT_TABLE[code];
  const hex = '0x' + code.toString(16).toUpperCase().padStart(8, '0');
  if (entry) return { ...entry, hex };
  // Unknown non-zero code: still give a useful generic frame.
  return {
    name: 'Application-defined error',
    cause: 'The program returned a non-zero code that Windows does not define \u2014 it is specific to that program.',
    advice: 'Use Test Run to capture the program\u2019s own output, which usually explains the code.',
    hex,
  };
}

// Small inline "?" affordance that opens the explainer popover for a code.
function fpResultHelpBadge(resultStr) {
  const info = explainResultCode(resultStr);
  if (!info) return '';
  const payload = escHtml(JSON.stringify(resultStr));
  return ` <button class="result-help-badge" title="Explain this result code"
      onclick="fpShowResultExplainer(${payload})">?</button>`;
}

function fpShowResultExplainer(resultStr) {
  const info = explainResultCode(resultStr);
  if (!info) { showToast('No explanation available for this result', 'info'); return; }
  openModal(`Result ${info.hex} — ${info.name}`,
    `<div class="fp-explainer">
       <div class="fp-explainer-row">
         <div class="fp-explainer-label">Code</div>
         <div class="fp-explainer-mono">${escHtml(info.hex)}</div>
       </div>
       <div class="fp-explainer-row">
         <div class="fp-explainer-label">Meaning</div>
         <div>${escHtml(info.name)}</div>
       </div>
       <div class="fp-explainer-block">
         <div class="fp-explainer-label">What it means</div>
         <p>${escHtml(info.cause)}</p>
       </div>
       ${info.advice ? `
       <div class="fp-explainer-block fp-explainer-advice">
         <div class="fp-explainer-label" style="color:var(--accent)">What to check</div>
         <p>${escHtml(info.advice)}</p>
       </div>` : ''}
     </div>`,
    `<button class="btn btn-primary" onclick="closeModal()">Got it</button>`);
}

/* ══════════════════════════════════════════════════════════════════════════
 * FEATURE 1 — Recycle Bin / Undo Delete
 * ══════════════════════════════════════════════════════════════════════════
 * Before any delete, capture the task XML and stash it. The delete flow in
 * app.js calls fpCaptureBeforeDelete(path, name) which returns a token that
 * the caller passes to fpOfferUndo() after a successful delete.
 *
 * Storage: localStorage key 'wtp_trash' = [{ id, name, path, folder, xml, ts }]
 * Capped at FP_TRASH_MAX entries (newest kept).
 */
const FP_TRASH_KEY = 'wtp_trash';
const FP_TRASH_MAX = 50;

// Capture XML for a task path. Returns the trash record (not yet persisted) or
// null if export failed (caller decides whether to proceed with delete).
async function fpCaptureTaskXml(path, name) {
  try {
    const xml = await invoke('export_task_xml', { path });
    if (!xml) return null;
    const folder = path.replace(/\\[^\\]*$/, '') || '\\';
    return {
      id: 'tr_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
      name: name || path.split('\\').pop() || path,
      path, folder, xml, ts: fpStamp(),
    };
  } catch (err) {
    dwarn('recycleBin', 'capture failed (task may be a system task we can\u2019t export)', { path, err: String(err) });
    return null;
  }
}

function fpPushToTrash(record) {
  if (!record) return;
  const trash = fpLoad(FP_TRASH_KEY, []);
  trash.unshift(record);
  while (trash.length > FP_TRASH_MAX) trash.pop();
  // Also cap by total serialized size: a few large task XMLs can exceed the
  // ~5MB localStorage quota, after which fpSave fails and newer captures are
  // silently lost. Evict oldest until under budget. (audit 2026-06-19)
  const FP_TRASH_BUDGET = 3500000; // chars (~bytes for ASCII XML), well under quota
  while (trash.length > 1 && JSON.stringify(trash).length > FP_TRASH_BUDGET) trash.pop();
  fpSave(FP_TRASH_KEY, trash);
}

// Restore a single trash record by id. Returns true on success.
async function fpRestoreFromTrash(id, { silent = false } = {}) {
  const trash = fpLoad(FP_TRASH_KEY, []);
  const rec = trash.find(t => t.id === id);
  if (!rec) { if (!silent) showToast('That item is no longer in the recycle bin', 'error'); return false; }
  const taskName = rec.path.split('\\').pop() || rec.name;
  try {
    // SAFETY (audit 2026-06-19): import uses TASK_CREATE_OR_UPDATE and overwrites
    // any LIVE task at this path. Capture the current definition into the recycle
    // bin first so the overwrite is itself undoable.
    if ((allTasks || []).some(x => x.path === rec.path)) {
      const cur = await fpCaptureTaskXml(rec.path, taskName);
      if (cur) fpPushToTrash(cur);   // mutates+saves the trash store
    }
    await invoke('import_task_xml', { folder: rec.folder, name: taskName, xml: rec.xml });
    // Remove the restored record from the CURRENT trash (reload — fpPushToTrash
    // above may have just added the captured-current entry; the stale `trash`
    // snapshot from load time must not clobber it).
    fpSave(FP_TRASH_KEY, fpLoad(FP_TRASH_KEY, []).filter(t => t.id !== id));
    appendAuditLog('restore_task', rec.name, `from recycle bin → ${rec.path}`);
    dinfo('recycleBin', 'restored', { path: rec.path });
    if (!silent) showToast(`Restored "${rec.name}"`, 'success');
    refreshAll(true);
    return true;
  } catch (err) {
    derror('recycleBin', 'restore failed', { path: rec.path, err: String(err) });
    if (!silent) showToast('Restore failed: ' + String(err), 'error');
    return false;
  }
}

// Show the "Undo" toast right after a delete. We can't reuse the plain
// showToast (no button), so this renders a richer transient banner.
let _fpUndoTimer = null;
function fpOfferUndo(record) {
  if (!record) return;
  const existing = document.getElementById('fp-undo-banner');
  if (existing) existing.remove();
  if (_fpUndoTimer) clearTimeout(_fpUndoTimer);

  const banner = document.createElement('div');
  banner.id = 'fp-undo-banner';
  banner.className = 'fp-undo-banner';
  banner.innerHTML = `
    <span class="fp-undo-icon">🗑</span>
    <span class="fp-undo-text">Deleted <strong>${escHtml(record.name)}</strong></span>
    <button class="btn btn-sm fp-undo-btn" id="fp-undo-action">↩ Undo</button>`;
  document.body.appendChild(banner);
  requestAnimationFrame(() => banner.classList.add('show'));

  const dismiss = () => {
    banner.classList.remove('show');
    setTimeout(() => banner.remove(), 220);
    if (_fpUndoTimer) { clearTimeout(_fpUndoTimer); _fpUndoTimer = null; }
  };
  banner.querySelector('#fp-undo-action')?.addEventListener('click', async () => {
    dismiss();
    await fpRestoreFromTrash(record.id);
  });
  _fpUndoTimer = setTimeout(dismiss, 8000);
}

// Convenience used by delete flows: capture → push → return record for undo.
async function fpTrapDelete(path, name) {
  const rec = await fpCaptureTaskXml(path, name);
  if (rec) fpPushToTrash(rec);
  return rec; // may be null (e.g. uneportable system task) — caller still deletes
}

// ── Recycle Bin page ──────────────────────────────────────────────────────
function renderRecycleBin() {
  const content = document.getElementById('recyclebin-content');
  if (!content) return;
  const trash = fpLoad(FP_TRASH_KEY, []);

  const headerActions = trash.length
    ? `<button class="btn btn-danger btn-sm" onclick="fpEmptyTrash()">🗑 Empty Bin</button>`
    : '';

  if (!trash.length) {
    content.innerHTML = `
      <div class="fp-page-head">
        <h2 class="section-heading">🗑 Recycle Bin</h2>
      </div>
      <div class="fp-empty">
        <div style="font-size:42px;margin-bottom:8px">🗑</div>
        <div style="font-size:15px;font-weight:700;color:var(--text);margin-bottom:4px">Recycle bin is empty</div>
        <div style="font-size:12.5px;color:var(--text3)">Deleted tasks are kept here so you can restore them. The last ${FP_TRASH_MAX} deletions are retained.</div>
      </div>`;
    return;
  }

  const rows = trash.map(rec => `
    <tr>
      <td><span class="task-name">${escHtml(rec.name)}</span></td>
      <td class="cell-trunc" title="${escHtml(rec.path)}"><span class="task-path">${escHtml(rec.path)}</span></td>
      <td style="color:var(--text3);white-space:nowrap">${escHtml(rec.ts)}</td>
      <td style="text-align:right;white-space:nowrap">
        <button class="btn btn-sm btn-success" onclick="fpRestoreFromTrash(${escHtml(JSON.stringify(rec.id))})">↩ Restore</button>
        <button class="icon-btn danger" title="Remove permanently" onclick="fpPurgeTrashItem(${escHtml(JSON.stringify(rec.id))})">✕</button>
      </td>
    </tr>`).join('');

  content.innerHTML = `
    <div class="fp-page-head">
      <h2 class="section-heading">🗑 Recycle Bin</h2>
      <div style="display:flex;gap:8px;align-items:center">
        <span style="font-size:11px;color:var(--text3)">${trash.length} item${trash.length === 1 ? '' : 's'}</span>
        ${headerActions}
      </div>
    </div>
    <div class="fp-hint">Deleted tasks are captured as Task Scheduler XML and restored exactly as they were. System tasks that could not be exported are not captured.</div>
    <table class="fp-table">
      <thead><tr><th style="width:28%">Name</th><th style="width:42%">Original Path</th><th style="width:18%">Deleted</th><th style="width:12%"></th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function fpPurgeTrashItem(id) {
  const trash = fpLoad(FP_TRASH_KEY, []).filter(t => t.id !== id);
  fpSave(FP_TRASH_KEY, trash);
  renderRecycleBin();
}

function fpEmptyTrash() {
  openModal('Empty Recycle Bin',
    `<div style="padding:16px 16px 8px">
       <p style="color:var(--text2)">Permanently remove all recycle-bin items? Tasks already deleted from Windows cannot be recovered afterward.</p>
     </div>`,
    `<button class="btn" onclick="closeModal()">Cancel</button>
     <button class="btn btn-danger" id="fp-empty-ok">Empty Bin</button>`);
  setTimeout(() => {
    const btn = document.getElementById('fp-empty-ok');
    if (btn) btn.onclick = () => {
      fpSave(FP_TRASH_KEY, []);
      closeModal();
      renderRecycleBin();
      showToast('Recycle bin emptied', 'success');
    };
  }, 0);
}

/* ══════════════════════════════════════════════════════════════════════════
 * FEATURE 2 — Tamper Watch (definition drift detection)
 * ══════════════════════════════════════════════════════════════════════════
 * Snapshot the security-relevant fields of a task when the user "trusts" it,
 * then flag any later change. Complements the executable-hash integrity check:
 * this catches edits to the ARGUMENTS / TRIGGER / PRINCIPAL, which malware uses
 * for persistence without touching the binary.
 *
 * Storage: 'wtp_trust_baseline' = { [path]: { sig, fields, ts } }
 */
const FP_TRUST_KEY = 'wtp_trust_baseline';
// Bump when fpTaskSignature's shape changes — fpDetectDrift silently re-baselines
// any entry stored under an older version so users aren't spammed with false
// "changed" alerts on upgrade. (audit 2026-06-19: v2 adds actions + hidden.)
const FP_SIG_VERSION = 2;

// Build a stable signature object from a TaskInfo.
function fpTaskSignature(t) {
  return {
    program: t.program_path || '',
    args:    t.program_args || '',
    workdir: t.working_dir || '',
    // ALL actions, not just the first exec — a malware-persistence technique is
    // to append/alter a SECOND action, which the first-action-only signature
    // missed entirely. (audit 2026-06-19)
    actions: (t.actions || []).join(' || '),
    triggers: (t.triggers || []).join(' | '),
    trigger_type: t.trigger_type || '',
    run_as:  t.run_as_user || '',
    run_level: t.run_level || 0,
    hidden:  t.hidden === true,   // catch a task being stealthed
    enabled: t.enabled !== false,
  };
}
// Cheap deterministic hash (FNV-1a) of the signature for quick equality.
function fpHashSig(sig) {
  const s = JSON.stringify(sig);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return ('00000000' + h.toString(16)).slice(-8);
}

function fpTrustTask(path) {
  const t = (allTasks || []).find(x => x.path === path);
  if (!t) { showToast('Task not found', 'error'); return; }
  const sig = fpTaskSignature(t);
  const baseline = fpLoad(FP_TRUST_KEY, {});
  baseline[path] = { sig: fpHashSig(sig), fields: sig, ts: fpStamp(), v: FP_SIG_VERSION };
  fpSave(FP_TRUST_KEY, baseline);
  appendAuditLog('trust_task', t.name, 'definition baseline captured');
  showToast(`Now watching "${t.name}" for definition changes`, 'success');
  // Refresh dashboard drift card if visible.
  if (currentPage === 'dashboard') loadDashboard();
}

function fpUntrustTask(path) {
  const baseline = fpLoad(FP_TRUST_KEY, {});
  if (baseline[path]) { delete baseline[path]; fpSave(FP_TRUST_KEY, baseline); }
  if (currentPage === 'dashboard') loadDashboard();
  showToast('Stopped watching this task', 'info');
}

function fpIsTrusted(path) {
  const baseline = fpLoad(FP_TRUST_KEY, {});
  return !!baseline[path];
}

// Compare current tasks against baselines; return array of drift findings.
function fpDetectDrift(tasks) {
  const baseline = fpLoad(FP_TRUST_KEY, {});
  const findings = [];
  let migrated = false;
  for (const path of Object.keys(baseline)) {
    const t = tasks.find(x => x.path === path);
    const base = baseline[path];
    if (!t) {
      findings.push({ path, name: path.split('\\').pop() || path, kind: 'missing', changes: [], base });
      continue;
    }
    const cur = fpTaskSignature(t);
    // Schema migration: an entry captured under an older signature version is
    // silently re-baselined to the current shape (one-time per task) so the
    // upgrade itself doesn't look like tampering. Trade-off: a task already
    // tampered before upgrade is blessed once — acceptable vs false alerts.
    if (base.v !== FP_SIG_VERSION) {
      baseline[path] = { sig: fpHashSig(cur), fields: cur, ts: base.ts || fpStamp(), v: FP_SIG_VERSION };
      migrated = true;
      continue;
    }
    if (fpHashSig(cur) === base.sig) continue; // unchanged
    // Identify which fields changed for a precise message.
    const labels = {
      program: 'Program', args: 'Arguments', workdir: 'Working dir',
      actions: 'Actions', triggers: 'Triggers', trigger_type: 'Trigger type',
      run_as: 'Run-as account', run_level: 'Run level', hidden: 'Hidden', enabled: 'Enabled',
    };
    const changes = [];
    for (const k of Object.keys(labels)) {
      if (JSON.stringify(cur[k]) !== JSON.stringify(base.fields[k])) {
        changes.push({ label: labels[k], from: base.fields[k], to: cur[k] });
      }
    }
    findings.push({ path, name: t.name, kind: 'changed', changes, base, task: t });
  }
  if (migrated) fpSave(FP_TRUST_KEY, baseline);   // persist silent schema re-baseline
  return findings;
}

// Dashboard card HTML for drift findings (returns '' when nothing to show).
function fpRenderDriftCard(tasks) {
  const findings = fpDetectDrift(tasks);
  if (!findings.length) return '';
  const rows = findings.slice(0, 12).map(f => {
    if (f.kind === 'missing') {
      return `<tr>
        <td><span class="task-name">${escHtml(f.name)}</span></td>
        <td colspan="2" style="color:var(--yellow)">⚠ Watched task no longer exists — deleted or moved.</td>
        <td style="text-align:right"><button class="btn btn-sm" onclick="fpUntrustTask(${escHtml(JSON.stringify(f.path))})">Stop watching</button></td>
      </tr>`;
    }
    const summary = f.changes.map(c => escHtml(c.label)).join(', ');
    const pj = escHtml(JSON.stringify(f.path));
    return `<tr>
      <td><span class="task-name">${escHtml(f.name)}</span></td>
      <td style="color:var(--red);font-weight:600">${summary || 'definition changed'}</td>
      <td class="cell-trunc" title="${escHtml(f.path)}"><span class="task-path">${escHtml(f.path)}</span></td>
      <td style="text-align:right;white-space:nowrap">
        <button class="btn btn-sm" onclick="fpShowDriftDetail(${pj})">Review</button>
      </td>
    </tr>`;
  }).join('');

  return `
    <div class="dash-card fp-drift-card" style="margin-top:16px">
      <div class="dash-card-title" style="color:var(--red)">
        🛡 Tamper Watch — ${findings.length} watched task${findings.length === 1 ? '' : 's'} changed
      </div>
      <div class="fp-hint" style="margin:0 0 8px">These tasks were marked trusted and their definition (program, arguments, trigger, or account) has since changed. Review each change and re-trust if it was intentional.</div>
      <table class="dash-table">
        <thead><tr><th style="width:26%">Name</th><th style="width:28%">Changed</th><th style="width:30%">Path</th><th style="width:16%"></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

function fpShowDriftDetail(path) {
  const tasks = allTasks || [];
  const findings = fpDetectDrift(tasks).filter(f => f.path === path);
  if (!findings.length) { showToast('No changes recorded for this task', 'info'); return; }
  const f = findings[0];
  const rows = f.changes.map(c => `
    <div class="fp-diff-row">
      <div class="fp-diff-field">${escHtml(c.label)}</div>
      <div class="fp-diff-vals">
        <div class="fp-diff-from"><span class="fp-diff-tag">was</span> ${escHtml(String(c.from) || '(empty)')}</div>
        <div class="fp-diff-to"><span class="fp-diff-tag accent">now</span> ${escHtml(String(c.to) || '(empty)')}</div>
      </div>
    </div>`).join('');
  const pj = escHtml(JSON.stringify(path));
  openModal(`🛡 Definition changes — ${escHtml(f.name)}`,
    `<div class="fp-diff-wrap">
       <div class="fp-hint" style="margin-top:0">Baseline captured ${escHtml(f.base.ts)}.</div>
       ${rows}
     </div>`,
    `<button class="btn" onclick="fpUntrustTask(${pj}); closeModal();">Stop watching</button>
     <button class="btn btn-primary" onclick="fpTrustTask(${pj}); closeModal();">✓ Re-trust (accept changes)</button>`);
}

/* ══════════════════════════════════════════════════════════════════════════
 * FEATURE 3 — True Test Run (under the task's real principal)
 * ══════════════════════════════════════════════════════════════════════════
 * run_task_test runs as the current user with no conditions. This runs the
 * REAL registered task via run_task(), then reads its run history to report
 * the actual result code under the actual principal. No temp task, no new IPC:
 * it triggers the genuine task and polls get_task_history / get_all_tasks.
 */
async function fpTrueTestRun(path, name) {
  const taskName = name || path.split('\\').pop() || path;
  openModal('▶ Run Now (real principal)',
    `<div class="fp-run-modal">
       <div class="fp-run-spinner"><span class="spinner"></span></div>
       <div class="fp-run-title">Running <strong>${escHtml(taskName)}</strong></div>
       <div class="fp-run-sub" id="fp-run-status">Starting the task under its configured account…</div>
       <div class="fp-hint" style="margin-top:12px">This triggers the real task exactly as Windows would — using its run-as account, run level, and (where applicable) conditions. The plain "Test Run" button instead runs the program directly as you, with output capture.</div>
     </div>`,
    `<button class="btn" id="fp-run-close" onclick="closeModal()">Close</button>`);

  const setStatus = (html) => { const el = document.getElementById('fp-run-status'); if (el) el.innerHTML = html; };

  try {
    await invoke('run_task', { path });
    dinfo('trueTestRun', 'triggered', { path });
  } catch (err) {
    setStatus(`<span style="color:var(--red)">Could not start: ${escHtml(String(err))}</span>`);
    return;
  }

  // Poll get_all_tasks for this task's status/result to settle.
  const started = Date.now();
  const TIMEOUT_MS = 30000;
  const poll = async () => {
    let task = null;
    try {
      const tasks = await invoke('get_all_tasks');
      task = tasks.find(t => t.path === path) || null;
    } catch (err) {
      setStatus(`<span style="color:var(--yellow)">Started, but could not read status: ${escHtml(String(err))}</span>`);
      return;
    }
    if (!task) { setStatus('Started. (Task list no longer contains this task.)'); return; }

    if (task.status === 'Running') {
      const secs = Math.round((Date.now() - started) / 1000);
      setStatus(`<span style="color:var(--accent)">● Running…</span> <span style="color:var(--text3)">(${secs}s)</span>`);
      if (Date.now() - started < TIMEOUT_MS) { setTimeout(poll, 1000); return; }
      setStatus('Still running after 30s — it will continue in the background. Check the task list for the final result.');
      return;
    }

    // Settled — report the real result code with the explainer.
    const info = explainResultCode(task.last_result_code);
    const ok = task.last_result_code === 0;
    const icon = ok ? '✅' : '⚠';
    const colour = ok ? 'var(--green)' : 'var(--red)';
    let html = `<div style="font-size:14px;color:${colour};font-weight:600;margin-bottom:6px">${icon} ${escHtml(task.last_result || 'completed')}</div>`;
    if (info && info.name) {
      html += `<div style="font-size:12.5px;color:var(--text2)"><strong>${escHtml(info.name)}</strong> (${escHtml(info.hex)})</div>`;
      html += `<div style="font-size:12px;color:var(--text3);margin-top:4px;line-height:1.5">${escHtml(info.cause)}</div>`;
      if (info.advice) html += `<div style="font-size:12px;color:var(--text2);margin-top:6px;line-height:1.5"><span style="color:var(--accent);font-weight:600">Check:</span> ${escHtml(info.advice)}</div>`;
    }
    setStatus(html);
    appendAuditLog('run_now', taskName, task.last_result || '');
  };
  setTimeout(poll, 1200);
}

/* ══════════════════════════════════════════════════════════════════════════
 * FEATURE 4 — "While You Were Away" digest
 * ══════════════════════════════════════════════════════════════════════════
 * Uses search_event_history (already registered) over the last 24h to render
 * a compact starts / completed / failed summary. Shown as a dashboard card AND
 * available as its own modal from the dashboard header.
 */
// The digest reads the Windows Event Log via search_event_history, which on
// the Rust side spawns `powershell.exe Get-WinEvent` — a cold start of one to
// several seconds, and exactly the kind of child process antivirus inspects on
// an unsigned exe. The dashboard auto-refreshes every 30s, so without caching
// this would re-spawn PowerShell every 30 seconds forever. A 24-hour summary
// does not change meaningfully minute to minute, so we cache the raw events for
// FP_DIGEST_TTL_MS and only re-query when the cache is stale or the caller
// passes force:true (the Activity modal does, so a manual open is always live).
const FP_DIGEST_TTL_MS = 5 * 60 * 1000; // 5 minutes
let _fpDigestCache = null; // { hours, events, at }

async function fpFetchDigest(hours = 24, { force = false } = {}) {
  const now = Date.now();
  if (!force && _fpDigestCache &&
      _fpDigestCache.hours === hours &&
      (now - _fpDigestCache.at) < FP_DIGEST_TTL_MS) {
    return _fpDigestCache.events;
  }
  const end = new Date();
  const start = new Date(end.getTime() - hours * 3600 * 1000);
  const iso = d => {
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  };
  // event IDs: 100 started, 102 completed, 200 action start, 201 action done, 103 action failed, 111 terminated
  const events = await invoke('search_event_history', {
    query: '',
    startIso: iso(start),
    endIso: iso(end),
    eventIds: [100, 102, 103, 111, 200, 201],
    maxRecords: 500,
  });
  const result = Array.isArray(events) ? events : [];
  _fpDigestCache = { hours, events: result, at: now };
  return result;
}

function fpSummariseDigest(events) {
  let started = 0, completed = 0, failed = 0;
  const failedTasks = new Map(); // task → count
  for (const e of events) {
    const id = e.id;
    if (id === 100 || id === 200) started++;
    else if (id === 102 || id === 201) completed++;
    else if (id === 103 || id === 111) {
      failed++;
      const key = e.task || '(unknown task)';
      failedTasks.set(key, (failedTasks.get(key) || 0) + 1);
    }
  }
  return { started, completed, failed, failedTasks };
}

async function fpRenderDigestInto(targetId, hours = 24, { force = false } = {}) {
  const el = document.getElementById(targetId);
  if (!el) return;
  el.innerHTML = `<div class="fp-digest-loading"><span class="spinner"></span> Reading the last ${hours}h of activity…</div>`;
  let events;
  try {
    events = await fpFetchDigest(hours, { force });
  } catch (err) {
    // Event log may be disabled; degrade gracefully.
    el.innerHTML = `<div class="fp-hint" style="margin:0">Activity history unavailable (the Task Scheduler operational log may be disabled). ${escHtml(String(err)).slice(0, 120)}</div>`;
    return;
  }
  const s = fpSummariseDigest(events);
  const failRows = [...s.failedTasks.entries()]
    .sort((a, b) => b[1] - a[1]).slice(0, 6)
    .map(([task, n]) => {
      const short = task.split('\\').pop() || task;
      return `<div class="fp-digest-failrow">
        <span class="fp-digest-failname" title="${escHtml(task)}">${escHtml(short)}</span>
        <span class="fp-digest-failcount">${n}×</span>
      </div>`;
    }).join('');

  el.innerHTML = `
    <div class="fp-digest-stats">
      <div class="fp-digest-stat"><div class="fp-digest-num">${s.started}</div><div class="fp-digest-lbl">started</div></div>
      <div class="fp-digest-stat ok"><div class="fp-digest-num">${s.completed}</div><div class="fp-digest-lbl">completed</div></div>
      <div class="fp-digest-stat ${s.failed ? 'bad' : ''}"><div class="fp-digest-num">${s.failed}</div><div class="fp-digest-lbl">failed</div></div>
    </div>
    ${s.failed ? `<div class="fp-digest-fails"><div class="fp-digest-fails-title">Failing tasks</div>${failRows}</div>`
      : `<div class="fp-digest-allgood">✓ No failures in the last ${hours} hours</div>`}`;
}

function fpShowDigestModal() {
  openModal('🌙 Activity — last 24 hours',
    `<div id="fp-digest-modal-body" style="min-height:120px"></div>`,
    `<button class="btn btn-primary" onclick="closeModal()">Close</button>`);
  // Explicit open → force a fresh read (bypasses the dashboard's 5-min cache).
  fpRenderDigestInto('fp-digest-modal-body', 24, { force: true });
}

/* ══════════════════════════════════════════════════════════════════════════
 * FEATURE 5 — 24-hour schedule timeline
 * ══════════════════════════════════════════════════════════════════════════
 * Renders upcoming runs (from each task's next_run) on a horizontal 24h track
 * so clustered firings are visible. Pure client-side over allTasks.
 */
function fpParseNextRun(s) {
  // next_run format: "YYYY-MM-DD HH:MM:SS (UTC±..)" — take the leading datetime.
  if (!s || s === 'Never' || s === 'N/A') return null;
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})/);
  if (!m) return null;
  const [, y, mo, d, h, mi] = m.map(Number);
  return new Date(y, mo - 1, d, h, mi);
}

function fpShowTimeline() {
  const tasks = allTasks || [];
  const now = new Date();
  const horizonMs = 24 * 3600 * 1000;
  const horizonEnd = new Date(now.getTime() + horizonMs);

  const upcoming = tasks
    .map(t => ({ t, when: fpParseNextRun(t.next_run) }))
    .filter(x => x.when && x.when >= now && x.when <= horizonEnd)
    .sort((a, b) => a.when - b.when);

  // Bucket by hour for the density strip.
  const buckets = new Array(24).fill(0);
  upcoming.forEach(x => {
    const hrsFromNow = Math.floor((x.when - now) / 3600000);
    if (hrsFromNow >= 0 && hrsFromNow < 24) buckets[hrsFromNow]++;
  });
  const maxBucket = Math.max(1, ...buckets);

  const hourTicks = buckets.map((count, i) => {
    const tickTime = new Date(now.getTime() + i * 3600000);
    const label = String(tickTime.getHours()).padStart(2, '0');
    const h = Math.round((count / maxBucket) * 100);
    const cls = count === 0 ? 'empty' : (count >= 3 ? 'hot' : 'warm');
    return `<div class="fp-tl-col" title="${count} run${count === 1 ? '' : 's'} around ${label}:00">
      <div class="fp-tl-bar-wrap"><div class="fp-tl-bar ${cls}" style="height:${Math.max(h, count ? 8 : 0)}%"></div></div>
      <div class="fp-tl-tick">${label}</div>
    </div>`;
  }).join('');

  const listRows = upcoming.slice(0, 40).map(x => {
    const time = `${String(x.when.getHours()).padStart(2, '0')}:${String(x.when.getMinutes()).padStart(2, '0')}`;
    const mins = Math.round((x.when - now) / 60000);
    const rel = mins < 60 ? `in ${mins}m` : `in ${Math.round(mins / 60)}h ${mins % 60}m`;
    const trig = escHtml((x.t.triggers || ['—'])[0] || '—');
    const pj = escHtml(JSON.stringify(x.t.path));
    return `<tr onclick="fpJumpToTask(${pj})" style="cursor:pointer">
      <td style="white-space:nowrap;font-family:'Cascadia Code',Consolas,monospace">${time}</td>
      <td style="color:var(--text3);white-space:nowrap">${rel}</td>
      <td><span class="task-name">${escHtml(x.t.name)}</span></td>
      <td class="cell-trunc" title="${trig}">${trig}</td>
    </tr>`;
  }).join('');

  openModal('🕒 Next 24 hours',
    `<div class="fp-timeline-wrap">
       <div class="fp-hint" style="margin-top:0">${upcoming.length} scheduled run${upcoming.length === 1 ? '' : 's'} in the next 24 hours. Tall bars are busy hours where several tasks fire close together.</div>
       <div class="fp-tl-chart">${hourTicks}</div>
       <div class="fp-tl-axis"><span>now</span><span>+24h</span></div>
       ${upcoming.length ? `
       <table class="fp-table" style="margin-top:14px">
         <thead><tr><th style="width:14%">Time</th><th style="width:16%">When</th><th style="width:38%">Task</th><th style="width:32%">Trigger</th></tr></thead>
         <tbody>${listRows}</tbody>
       </table>` : `<div class="fp-empty" style="padding:30px"><div style="font-size:13px;color:var(--text3)">No tasks are scheduled to run in the next 24 hours.</div></div>`}
     </div>`,
    `<button class="btn btn-primary" onclick="closeModal()">Close</button>`);
}

// Jump from timeline/palette to a task: close modal, go to tasks, open its edit.
function fpJumpToTask(path) {
  closeModal();
  showPage('tasks');
  const t = (allTasks || []).find(x => x.path === path);
  if (t && typeof openEditDialog === 'function') {
    setTimeout(() => openEditDialog(t), 60);
  }
}

/* ══════════════════════════════════════════════════════════════════════════
 * FEATURE 7 — Backup / Restore all tasks
 * ══════════════════════════════════════════════════════════════════════════
 * Export: bundle every task's XML into one downloadable file (a simple,
 * dependency-free container format that we can re-parse on import). Import:
 * paste/load that file and recreate tasks via import_task_xml with collision
 * reporting. No JSZip — one text bundle, delimiter-framed.
 */
const FP_BUNDLE_MAGIC = '### WINTASKPRO-BACKUP v1';
const FP_BUNDLE_SEP   = '\n### TASK ';   // followed by  <folder>\t<name>\n<xml>

async function fpExportAllTasks() {
  showToast('Preparing backup…', 'info');
  let tasks;
  try {
    tasks = await invoke('get_all_tasks');
  } catch (err) {
    showToast('Backup failed: could not list tasks (' + String(err) + ')', 'error');
    return;
  }
  // Skip Windows/Microsoft system tasks by default — they belong to the OS and
  // usually cannot be re-registered cleanly. Offer a clear count.
  const userTasks = tasks.filter(t => {
    const p = (t.path || '').toLowerCase();
    return !p.startsWith('\\microsoft\\') && !p.startsWith('\\windows\\');
  });

  let exported = 0, failed = 0;
  const parts = [FP_BUNDLE_MAGIC, `# created ${fpStamp()}  (${userTasks.length} user task(s))`];
  for (const t of userTasks) {
    try {
      const xml = await invoke('export_task_xml', { path: t.path });
      const folder = t.folder || (t.path.replace(/\\[^\\]*$/, '') || '\\');
      const name = t.path.split('\\').pop() || t.name;
      parts.push(`${FP_BUNDLE_SEP.trim()} ${folder}\t${name}`);
      parts.push(xml);
      exported++;
    } catch (err) {
      failed++;
      dwarn('backup', 'export skipped', { path: t.path, err: String(err) });
    }
  }
  const bundle = parts.join('\n');
  fpDownload(`wintaskpro-backup-${fpFileStamp()}.wtpbak`, bundle, 'text/plain');
  appendAuditLog('backup_all', `${exported} tasks`, failed ? `${failed} skipped` : '');
  showToast(`Backed up ${exported} task${exported === 1 ? '' : 's'}${failed ? ` (${failed} skipped)` : ''}`, 'success');
}

// Parse a bundle string into [{ folder, name, xml }].
function fpParseBundle(text) {
  if (!text || text.indexOf(FP_BUNDLE_MAGIC) === -1) {
    throw new Error('Not a WinTaskPro backup file');
  }
  const out = [];
  // Split on the task separator marker at line start.
  const chunks = text.split(/\n### TASK /).slice(1); // first chunk is the header
  for (const chunk of chunks) {
    const nl = chunk.indexOf('\n');
    if (nl === -1) continue;
    const headerLine = chunk.slice(0, nl).trim();
    const xml = chunk.slice(nl + 1).replace(/\s+$/, '');
    const tab = headerLine.indexOf('\t');
    if (tab === -1) continue;
    const folder = headerLine.slice(0, tab).trim() || '\\';
    const name = headerLine.slice(tab + 1).trim();
    if (name && xml) out.push({ folder, name, xml });
  }
  return out;
}

function fpOpenBackupRestore() {
  openModal('💾 Backup &amp; Restore Tasks',
    `<div class="fp-backup-modal">
       <div class="fp-backup-section">
         <div class="fp-backup-h">Backup</div>
         <p class="fp-backup-p">Download every user task as a single backup file. Windows system tasks are excluded.</p>
         <button class="btn btn-primary" onclick="fpExportAllTasks()">⬇ Download backup</button>
       </div>
       <div class="fp-backup-divider"></div>
       <div class="fp-backup-section">
         <div class="fp-backup-h">Restore</div>
         <p class="fp-backup-p">Load a backup file to recreate its tasks. Existing tasks with the same name are overwritten.</p>
         <input type="file" id="fp-restore-file" accept=".wtpbak,.txt" class="fp-file-input" />
         <div id="fp-restore-preview" class="fp-restore-preview"></div>
         <button class="btn" id="fp-restore-go" style="display:none" onclick="fpRunRestore()">↩ Restore tasks</button>
       </div>
     </div>`,
    `<button class="btn btn-primary" onclick="closeModal()">Done</button>`);

  setTimeout(() => {
    const fileInput = document.getElementById('fp-restore-file');
    if (fileInput) fileInput.addEventListener('change', fpHandleRestoreFile);
  }, 0);
}

let _fpPendingRestore = null;
function fpHandleRestoreFile(e) {
  const file = e.target.files && e.target.files[0];
  const preview = document.getElementById('fp-restore-preview');
  const goBtn = document.getElementById('fp-restore-go');
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const items = fpParseBundle(String(reader.result));
      _fpPendingRestore = items;
      if (preview) preview.innerHTML = `<div class="fp-restore-ok">✓ ${items.length} task${items.length === 1 ? '' : 's'} found in backup</div>` +
        items.slice(0, 8).map(i => `<div class="fp-restore-item">${escHtml(i.folder)}\\${escHtml(i.name)}</div>`).join('') +
        (items.length > 8 ? `<div class="fp-restore-item" style="color:var(--text3)">…and ${items.length - 8} more</div>` : '');
      if (goBtn) goBtn.style.display = items.length ? '' : 'none';
    } catch (err) {
      _fpPendingRestore = null;
      if (preview) preview.innerHTML = `<div class="fp-restore-err">✕ ${escHtml(String(err.message || err))}</div>`;
      if (goBtn) goBtn.style.display = 'none';
    }
  };
  reader.onerror = () => { if (preview) preview.innerHTML = `<div class="fp-restore-err">✕ Could not read file</div>`; };
  reader.readAsText(file);
}

async function fpRunRestore() {
  if (!_fpPendingRestore || !_fpPendingRestore.length) return;
  const items = _fpPendingRestore;
  const goBtn = document.getElementById('fp-restore-go');
  const preview = document.getElementById('fp-restore-preview');
  if (goBtn) { goBtn.disabled = true; goBtn.textContent = 'Restoring…'; }
  let ok = 0; const failed = []; let overwritten = 0;
  for (const item of items) {
    const targetPath = item.folder === '\\' ? ('\\' + item.name) : (item.folder + '\\' + item.name);
    try {
      // SAFETY (audit 2026-06-19): import uses TASK_CREATE_OR_UPDATE and overwrites
      // any live task at this path. If one exists, capture its current definition
      // into the recycle bin first so a bad bulk restore is undoable.
      if ((allTasks || []).some(x => x.path === targetPath)) {
        const cur = await fpCaptureTaskXml(targetPath, item.name);
        if (cur) { fpPushToTrash(cur); overwritten++; }
      }
      await invoke('import_task_xml', { folder: item.folder, name: item.name, xml: item.xml });
      ok++;
    } catch (err) {
      failed.push(`${item.folder}\\${item.name}: ${String(err)}`);
    }
  }
  appendAuditLog('restore_all', `${ok} tasks`,
    (failed.length ? `${failed.length} failed` : '') +
    (overwritten ? ` (${overwritten} overwritten — previous versions captured to recycle bin)` : ''));
  if (preview) {
    preview.innerHTML = `<div class="fp-restore-ok">✓ Restored ${ok} of ${items.length} task${items.length === 1 ? '' : 's'}</div>` +
      (overwritten ? `<div class="fp-restore-item" style="color:var(--text2);margin-top:4px">${overwritten} existing task${overwritten === 1 ? '’s previous version was' : 's’ previous versions were'} saved to the Recycle Bin (undo any overwrite from there).</div>` : '') +
      (failed.length ? `<div class="fp-restore-err" style="margin-top:6px">${failed.length} failed:</div>` +
        failed.slice(0, 5).map(f => `<div class="fp-restore-item" style="color:var(--red)">${escHtml(f)}</div>`).join('') : '');
  }
  if (goBtn) { goBtn.disabled = false; goBtn.textContent = '↩ Restore tasks'; }
  showToast(`Restored ${ok}/${items.length} task${items.length === 1 ? '' : 's'}`, failed.length ? 'error' : 'success');
  refreshAll(true);
}

/* ══════════════════════════════════════════════════════════════════════════
 * FEATURE 8 — Command palette (Ctrl+K)
 * ══════════════════════════════════════════════════════════════════════════
 * Fuzzy launcher: jump to any task, navigate pages, or run an action.
 */
const FP_ACTIONS = [
  { id: 'nav-dashboard',  label: 'Go to Dashboard',         icon: '🏠', run: () => showPage('dashboard') },
  { id: 'nav-tasks',      label: 'Go to Task Manager',      icon: '📋', run: () => showPage('tasks') },
  { id: 'nav-live',       label: 'Go to Live Monitor',      icon: '🔴', run: () => showPage('live') },
  { id: 'nav-templates',  label: 'Go to Script Library',    icon: '📚', run: () => showPage('templates') },
  { id: 'nav-audit',      label: 'Go to Audit Log',         icon: '📝', run: () => showPage('auditlog') },
  { id: 'nav-proc',       label: 'Go to Process Manager',   icon: '🖥', run: () => showPage('processes') },
  { id: 'nav-trash',      label: 'Go to Recycle Bin',       icon: '🗑', run: () => showPage('recyclebin') },
  { id: 'nav-settings',   label: 'Go to Settings',          icon: '⚙', run: () => showPage('settings') },
  { id: 'act-new',        label: 'New Task…',               icon: '➕', run: () => { showPage('tasks'); setTimeout(() => openCreateDialog(), 50); } },
  { id: 'act-refresh',    label: 'Refresh all',             icon: '🔄', run: () => refreshAll() },
  { id: 'act-timeline',   label: 'Show next-24h timeline',  icon: '🕒', run: () => fpShowTimeline() },
  { id: 'act-digest',     label: 'Show activity digest',    icon: '🌙', run: () => fpShowDigestModal() },
  { id: 'act-backup',     label: 'Backup / Restore tasks…', icon: '💾', run: () => fpOpenBackupRestore() },
];

// Simple subsequence fuzzy match → score (lower is better); null if no match.
function fpFuzzy(needle, hay) {
  needle = needle.toLowerCase(); hay = hay.toLowerCase();
  if (!needle) return 0;
  let hi = 0, score = 0, lastIdx = -1;
  for (const ch of needle) {
    const idx = hay.indexOf(ch, hi);
    if (idx === -1) return null;
    if (lastIdx !== -1) score += (idx - lastIdx); // prefer contiguous
    lastIdx = idx; hi = idx + 1;
  }
  // Bonus for prefix match.
  if (hay.startsWith(needle)) score -= 50;
  return score;
}

let _fpPaletteOpen = false;
let _fpPaletteIdx = 0;
let _fpPaletteResults = [];

function fpOpenPalette() {
  if (_fpPaletteOpen) return;
  _fpPaletteOpen = true;
  _fpPaletteIdx = 0;

  const overlay = document.createElement('div');
  overlay.id = 'fp-palette-overlay';
  overlay.className = 'fp-palette-overlay';
  overlay.innerHTML = `
    <div class="fp-palette" role="dialog" aria-label="Command palette">
      <input id="fp-palette-input" class="fp-palette-input" type="text"
             placeholder="Jump to a task, page, or action…" autocomplete="off" spellcheck="false" />
      <div id="fp-palette-list" class="fp-palette-list"></div>
      <div class="fp-palette-foot">
        <span><kbd>↑</kbd><kbd>↓</kbd> navigate</span>
        <span><kbd>↵</kbd> select</span>
        <span><kbd>esc</kbd> close</span>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  const input = document.getElementById('fp-palette-input');
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) fpClosePalette(); });
  input.addEventListener('input', () => fpRenderPalette(input.value));
  input.addEventListener('keydown', fpPaletteKeydown);
  fpRenderPalette('');
  requestAnimationFrame(() => input.focus());
}

function fpClosePalette() {
  const o = document.getElementById('fp-palette-overlay');
  if (o) o.remove();
  _fpPaletteOpen = false;
  _fpPaletteResults = [];
}

function fpBuildPaletteItems(query) {
  const items = [];
  // Actions / navigation.
  for (const a of FP_ACTIONS) {
    const score = fpFuzzy(query, a.label);
    if (score !== null) items.push({ kind: 'action', icon: a.icon, label: a.label, score, run: a.run });
  }
  // Tasks (cap to keep it snappy).
  for (const t of (allTasks || [])) {
    const hay = `${t.name} ${t.path}`;
    const score = fpFuzzy(query, hay);
    if (score !== null) {
      items.push({
        kind: 'task', icon: '📋',
        label: t.name,
        sub: t.path,
        score: score + 5, // slight bias so exact action labels rank first
        run: () => fpJumpToTask(t.path),
      });
    }
  }
  items.sort((a, b) => a.score - b.score);
  return items.slice(0, 30);
}

function fpRenderPalette(query) {
  _fpPaletteResults = fpBuildPaletteItems(query);
  if (_fpPaletteIdx >= _fpPaletteResults.length) _fpPaletteIdx = 0;
  const list = document.getElementById('fp-palette-list');
  if (!list) return;
  if (!_fpPaletteResults.length) {
    list.innerHTML = `<div class="fp-palette-empty">No matches</div>`;
    return;
  }
  list.innerHTML = _fpPaletteResults.map((r, i) => `
    <div class="fp-palette-item ${i === _fpPaletteIdx ? 'active' : ''}" data-idx="${i}">
      <span class="fp-palette-icon">${r.icon}</span>
      <span class="fp-palette-label">${escHtml(r.label)}</span>
      ${r.sub ? `<span class="fp-palette-sub">${escHtml(r.sub)}</span>` : `<span class="fp-palette-kind">${r.kind}</span>`}
    </div>`).join('');
  // Click + hover wiring.
  list.querySelectorAll('.fp-palette-item').forEach(el => {
    const idx = parseInt(el.dataset.idx, 10);
    el.addEventListener('mouseenter', () => { _fpPaletteIdx = idx; fpHighlightPalette(); });
    el.addEventListener('click', () => fpRunPaletteItem(idx));
  });
}

function fpHighlightPalette() {
  const list = document.getElementById('fp-palette-list');
  if (!list) return;
  list.querySelectorAll('.fp-palette-item').forEach((el, i) => {
    el.classList.toggle('active', i === _fpPaletteIdx);
    if (i === _fpPaletteIdx) el.scrollIntoView({ block: 'nearest' });
  });
}

function fpPaletteKeydown(e) {
  if (e.key === 'Escape') { e.preventDefault(); fpClosePalette(); return; }
  if (e.key === 'ArrowDown') { e.preventDefault(); _fpPaletteIdx = Math.min(_fpPaletteResults.length - 1, _fpPaletteIdx + 1); fpHighlightPalette(); return; }
  if (e.key === 'ArrowUp')   { e.preventDefault(); _fpPaletteIdx = Math.max(0, _fpPaletteIdx - 1); fpHighlightPalette(); return; }
  if (e.key === 'Enter')     { e.preventDefault(); fpRunPaletteItem(_fpPaletteIdx); return; }
}

function fpRunPaletteItem(idx) {
  const item = _fpPaletteResults[idx];
  if (!item) return;
  fpClosePalette();
  try { item.run(); }
  catch (err) { derror('palette', 'action failed', { label: item.label, err: String(err) }); }
}

/* ══════════════════════════════════════════════════════════════════════════
 * Wiring: page registration, global key handler, dashboard injection
 * ══════════════════════════════════════════════════════════════════════════ */

// Ctrl+K / Cmd+K palette — capture phase so it works from anywhere, including
// inside inputs, without colliding with the app's own handleKeyboard.
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) {
    e.preventDefault();
    if (_fpPaletteOpen) fpClosePalette(); else fpOpenPalette();
  }
}, true);

// Hook showPage() so our custom pages render when navigated to. We wrap the
// original rather than editing its body, keeping the integration in one place.
(function hookShowPage() {
  if (typeof showPage !== 'function') return;
  const original = showPage;
  window.showPage = function (page) {
    original(page);
    if (page === 'recyclebin') renderRecycleBin();
  };
  // showPage is referenced by name in inline handlers (global scope), so the
  // window assignment above replaces it everywhere.
})();

// Expose the feature functions that inline HTML handlers call. (Functions
// declared at top level in a classic script are already global, but we make
// the intent explicit and guard against bundlers.)
Object.assign(window, {
  fpShowResultExplainer, fpResultHelpBadge,
  fpRestoreFromTrash, fpPurgeTrashItem, fpEmptyTrash, renderRecycleBin,
  fpTrustTask, fpUntrustTask, fpShowDriftDetail,
  fpTrueTestRun,
  fpShowDigestModal,
  fpShowTimeline, fpJumpToTask,
  fpExportAllTasks, fpOpenBackupRestore, fpRunRestore,
  fpOpenPalette,
});

dinfo('features', 'feature pack loaded (1.15.0)', {
  trash: fpLoad(FP_TRASH_KEY, []).length,
  watched: Object.keys(fpLoad(FP_TRUST_KEY, {})).length,
});
