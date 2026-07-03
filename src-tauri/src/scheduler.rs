#![cfg(windows)]
#![allow(non_snake_case)]
use serde::{Deserialize, Serialize};
use windows::{
    core::*,
    Win32::Foundation::{SYSTEMTIME, VARIANT_FALSE, VARIANT_TRUE},
    Win32::System::Com::*,
    Win32::System::SystemInformation::GetSystemTime,
    Win32::System::TaskScheduler::*,
    Win32::System::Time::{GetTimeZoneInformation, TIME_ZONE_INFORMATION},
    // windows-rs 0.61 moved VARIANT out of `windows::core` to here.
    // Under 0.58 it was re-exported from core::*, but that re-export was
    // removed during the 0.59 reorganisation. The Win32_System_Variant
    // feature is enabled in Cargo.toml so this import resolves.
    Win32::System::Variant::VARIANT,
};

// ── VARIANT_BOOL helper ───────────────────────────────────────────────────────
fn vb(b: bool) -> windows::Win32::Foundation::VARIANT_BOOL {
    if b { VARIANT_TRUE } else { VARIANT_FALSE }
}

// ── Out-param helpers ─────────────────────────────────────────────────────────
unsafe fn read_bstr<F: Fn(*mut BSTR) -> Result<()>>(f: F) -> String {
    let mut b = BSTR::default();
    let _ = f(&mut b);
    b.to_string()
}
unsafe fn read_i32<F: Fn(*mut i32) -> Result<()>>(f: F) -> i32 {
    let mut v: i32 = 0;
    let _ = f(&mut v);
    v
}

fn vi(n: i32) -> VARIANT { VARIANT::from(n) }

// ── Helpers ───────────────────────────────────────────────────────────────────
fn task_state_str(state: TASK_STATE) -> (String, u32) {
    match state {
        TASK_STATE_DISABLED => ("Disabled".into(), 1),
        TASK_STATE_QUEUED   => ("Queued".into(),   2),
        TASK_STATE_READY    => ("Ready".into(),    3),
        TASK_STATE_RUNNING  => ("Running".into(),  4),
        _                   => ("Unknown".into(),  0),
    }
}

fn trigger_str(t: TASK_TRIGGER_TYPE2) -> String {
    match t {
        TASK_TRIGGER_TIME    => "Once".into(),
        TASK_TRIGGER_DAILY   => "Daily".into(),
        TASK_TRIGGER_WEEKLY  => "Weekly".into(),
        TASK_TRIGGER_MONTHLY => "Monthly".into(),
        TASK_TRIGGER_BOOT    => "At Boot".into(),
        TASK_TRIGGER_LOGON   => "At Logon".into(),
        TASK_TRIGGER_IDLE    => "On Idle".into(),
        _                    => "Custom".into(),
    }
}

fn fmt_code(code: i32) -> String {
    match code {
        0      => "Success".into(),
        267009 => "Still Running".into(),
        267011 => "Not Run Yet".into(),
        _      => format!("Error (0x{:08X})", code as u32),
    }
}

fn ole_date(d: f64) -> String {
    if d < 1.0 { return "Never".into(); }
    // OLE Automation date epoch is 1899-12-30 UTC.
    // Convert to Unix timestamp then to local time using the system timezone offset.
    let secs_utc = ((d - 25569.0) * 86400.0).round() as i64;
    if secs_utc < 0 { return "Never".into(); }

    // Get the local timezone offset in seconds from the Windows API
    let tz_offset_secs: i64 = unsafe {
        let mut tzi = TIME_ZONE_INFORMATION::default();
        let result = GetTimeZoneInformation(&mut tzi);
        // GetTimeZoneInformation returns a plain u32 in windows-rs 0.58.
        // 2 = TIME_ZONE_ID_DAYLIGHT — add DaylightBias; otherwise use Bias only.
        let bias_mins = if result == 2 {
            tzi.Bias + tzi.DaylightBias
        } else {
            tzi.Bias
        };
        -(bias_mins as i64) * 60
    };

    let secs_local = secs_utc + tz_offset_secs;
    if secs_local < 0 { return "Never".into(); }

    let s   = (secs_local % 60) as u32;
    let m   = ((secs_local / 60) % 60) as u32;
    let h   = ((secs_local / 3600) % 24) as u32;
    let (y, mo, day) = days_to_ymd(secs_local / 86400);

    // Show offset so user knows what timezone the time is in
    let off_h = tz_offset_secs.abs() / 3600;
    let off_m = (tz_offset_secs.abs() % 3600) / 60;
    let sign  = if tz_offset_secs >= 0 { '+' } else { '-' };
    format!("{:04}-{:02}-{:02} {:02}:{:02}:{:02} (UTC{}{}:{:02})",
        y, mo, day, h, m, s, sign, off_h, off_m)
}

fn days_to_ymd(days: i64) -> (i64, i64, i64) {
    let z   = days + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe/1460 + doe/36524 - doe/146096) / 365;
    let y   = yoe + era * 400;
    let doy = doe - (365*yoe + yoe/4 - yoe/100);
    let mp  = (5*doy + 2) / 153;
    let d   = doy - (153*mp + 2)/5 + 1;
    let mo  = if mp < 10 { mp + 3 } else { mp - 9 };
    let y   = if mo <= 2 { y + 1 } else { y };
    (y, mo, d)
}

fn systemtime_to_str(st: &SYSTEMTIME) -> String {
    format!("{:04}-{:02}-{:02} {:02}:{:02}:{:02}",
        st.wYear, st.wMonth, st.wDay, st.wHour, st.wMinute, st.wSecond)
}

// ── Public models ─────────────────────────────────────────────────────────────
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskInfo {
    pub name:             String,
    pub path:             String,
    pub folder:           String,
    pub status:           String,
    pub status_code:      u32,
    pub last_run:         String,
    pub next_run:         String,
    pub last_result:      String,
    pub last_result_code: i32,
    pub triggers:         Vec<String>,
    pub actions:          Vec<String>,
    // Total number of actions of ANY type (exec, email, show-message, COM
    // handler). `actions` above only contains EXEC actions, so the frontend's
    // "more than one action → route to the lossless XML editor" guard would
    // miss a task with one exec + one non-exec action. This is the honest count.
    #[serde(default)]
    pub action_count:     u32,
    pub description:      String,
    pub author:           String,
    pub run_as_user:      String,
    pub hidden:           bool,
    pub enabled:          bool,

    // ── Trigger details ───────────────────────────────────────────────────────
    #[serde(default)]
    pub trigger_type:         String,   // "Once","Daily","Weekly","Monthly","Boot","Logon","Idle","SessionLock","SessionUnlock","Interval","Custom"
    #[serde(default)]
    pub trigger_start:        String,   // ISO datetime string
    #[serde(default)]
    pub trigger_interval:     u32,      // days_interval / weeks_interval / idle_minutes
    #[serde(default)]
    pub trigger_days_of_week: u32,      // bitmask Sun=1,Mon=2,Tue=4,Wed=8,Thu=16,Fri=32,Sat=64
    #[serde(default)]
    pub trigger_months:       u32,      // bitmask Jan=1,Feb=2,…,Dec=2048
    #[serde(default)]
    pub trigger_days_of_month:u32,      // bitmask bit0=day1…bit30=day31

    // ── Advanced / repetition ─────────────────────────────────────────────────
    #[serde(default)]
    pub exec_time_limit:      String,   // ISO 8601 duration, e.g. "PT1H" or "PT0S" = unlimited
    #[serde(default)]
    pub repetition_interval:  String,   // ISO 8601 duration between repetitions
    #[serde(default)]
    pub repetition_duration:  String,   // ISO 8601 total repetition window; "" = indefinite
    #[serde(default)]
    pub stop_at_duration_end: bool,
    #[serde(default)]
    pub random_delay:         String,   // ISO 8601 duration
    #[serde(default)]
    pub end_boundary:         String,   // ISO datetime or ""
    #[serde(default)]
    pub boot_delay:           String,   // ISO 8601 duration for Boot/Logon/Session triggers

    // ── Conditions ────────────────────────────────────────────────────────────
    #[serde(default)]
    pub wake_to_run:               bool,
    #[serde(default)]
    pub run_only_if_network:       bool,
    #[serde(default)]
    pub run_only_if_idle:          bool,
    #[serde(default)]
    pub disallow_on_battery_start: bool,
    #[serde(default)]
    pub stop_on_battery:           bool,

    // ── Settings ──────────────────────────────────────────────────────────────
    #[serde(default = "default_priority")]
    pub priority:       u32,            // 0–10, default 7
    #[serde(default)]
    pub stop_if_running:bool,           // TASK_INSTANCES_STOP_EXISTING
    #[serde(default)]
    pub delete_expired: bool,

    // ── Action details (first exec action) ────────────────────────────────────
    #[serde(default)]
    pub program_path:   String,
    #[serde(default)]
    pub program_args:   String,
    #[serde(default)]
    pub working_dir:    String,
    #[serde(default)]
    pub run_level:      u32,            // 0 = LUA (standard), 1 = Highest
}

#[derive(Debug, Clone, Serialize)]
pub struct RunningTaskInfo {
    pub name:           String,
    pub path:           String,
    pub current_action: String,
    pub state:          String,
}

#[derive(Debug, Clone, Serialize)]
pub struct TaskRunRecord {
    pub start_time:    String,
    pub end_time:      String,
    pub result_code:   i32,
    pub result_text:   String,
    pub duration_secs: f64,
}

fn default_priority() -> u32 { 7 }

// ── Shared action helpers ─────────────────────────────────────────────────────

/// Escape a value for use inside a cmd.exe double-quoted argument.
/// Handles cmd special characters: & | < > ^ ( ) "
fn escape_cmd_value(s: &str) -> String {
    s.chars().map(|c| match c {
        '&' | '|' | '<' | '>' | '^' | '(' | ')' | '"' => format!("^{c}"),
        _ => c.to_string(),
    }).collect()
}

/// Configure an IExecAction from CreateTaskParams.
/// If env_vars are set, wraps the command in cmd.exe with a `SET` preamble.
/// Called from both create_task and update_task to ensure consistency.
///
/// # Safety
/// Caller must be inside an `unsafe` block; all inner COM calls are unsafe.
unsafe fn build_exec_action(exec: &IExecAction, p: &CreateTaskParams) -> Result<()> {
    if !p.env_vars.is_empty() {
        // SECURITY (command-injection fix): the env-var feature runs the user's
        // program under `cmd.exe /c "..."` with a `SET` preamble. cmd quoting is
        // NOT nestable — when special characters (our `&&` separators) appear
        // inside `/c "..."`, cmd strips the outer quote pair and re-parses the
        // remainder UNQUOTED, so a stray `"` in any interpolated value breaks
        // out and a following `& <cmd>` runs as an arbitrary command at the
        // task's privilege. No escape sequence neutralises a `"` in this
        // context (the previous `^"` escaping was a no-op after the strip), so
        // embedded double quotes are rejected outright on this path.
        // GOTCHA: do NOT "fix" this by re-adding `^"` escaping — it is provably
        //         ineffective inside the post-strip unquoted region.
        let has_dquote = |s: &str| s.contains('"');
        if has_dquote(&p.program_path)
            || has_dquote(&p.arguments)
            || p.env_vars.lines().any(has_dquote)
        {
            return Err(windows::core::Error::new(
                windows::core::HRESULT(0x80070057u32 as i32),
                "Double-quote characters are not supported in the program path, arguments, or environment-variable values when environment variables are set. Remove the \" characters (or clear the Environment Variables field) and try again.",
            ));
        }

        // Each pair is emitted as `SET "KEY=VALUE"` so cmd treats VALUE as a
        // literal (no `& | < >` interpretation); KEY is constrained to
        // [A-Za-z0-9_]. No carets are added — a caret would be taken literally
        // inside the SET quotes.
        let env_sets: String = p.env_vars.lines()
            .filter_map(|l| {
                let l = l.trim();
                let eq = l.find('=')?;
                let key = &l[..eq];
                let val = &l[eq + 1..];
                if !key.is_empty() && key.chars().all(|c| c.is_alphanumeric() || c == '_') {
                    Some(format!("SET \"{}={}\"&& ", key, val))
                } else {
                    None
                }
            })
            .collect();

        // The program is wrapped in its own quotes so a path containing spaces
        // runs correctly (embedded `"` was rejected above). Arguments follow the
        // quoted program with `& | < > ( ) ^` caret-escaped so they are passed
        // literally rather than acting as cmd operators — matching the non-env
        // branch, which passes args verbatim to SetArguments.
        let args_part = if p.arguments.is_empty() {
            String::new()
        } else {
            format!(" {}", escape_cmd_value(&p.arguments))
        };
        // After cmd strips the outer quote pair this parses as:
        //   SET "K=V" && "C:\program.exe" <args>
        // No \0 needed — BSTR::from handles null termination internally.
        let wrapped = format!("/c \"{}\"{}\"{}\"", env_sets, p.program_path, args_part);
        // Explicit unsafe{} required for COM method calls even inside an unsafe fn
        // (unsafe_op_in_unsafe_fn lint, Rust 2021+).
        unsafe {
            exec.SetPath(&BSTR::from("C:\\Windows\\System32\\cmd.exe"))?;
            exec.SetArguments(&BSTR::from(wrapped.as_str()))?;
            exec.SetWorkingDirectory(&BSTR::from(p.working_dir.as_str()))?;
        }
    } else {
        unsafe {
            exec.SetPath(&BSTR::from(p.program_path.as_str()))?;
            exec.SetArguments(&BSTR::from(p.arguments.as_str()))?;
            exec.SetWorkingDirectory(&BSTR::from(p.working_dir.as_str()))?;
        }
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateTaskParams {
    pub name:           String,
    pub folder_path:    String,
    pub description:    String,
    pub author:         String,
    pub program_path:   String,
    pub arguments:      String,
    pub working_dir:    String,
    pub trigger_type:   String,
    pub start_datetime: String,
    pub days_interval:  u32,
    pub run_as_user:    String,
    pub run_level:      u32,
    pub hidden:         bool,
    pub enabled:        bool,

    // ── Advanced / new fields (all #[serde(default)] for backwards compat) ──
    #[serde(default)]
    pub execution_time_limit: String,   // ISO 8601 duration; "PT0S" = unlimited
    #[serde(default)]
    pub repetition_interval:  String,   // ISO 8601 duration between repetitions
    #[serde(default)]
    pub repetition_duration:  String,   // ISO 8601 total repetition window; "" = indefinite
    #[serde(default)]
    pub stop_at_duration_end: bool,     // stop repeated task when duration window ends
    #[serde(default)]
    pub end_boundary:         String,   // ISO datetime when trigger expires
    #[serde(default)]
    pub delay:                String,   // boot/logon startup delay, ISO 8601
    #[serde(default)]
    pub random_delay:         String,   // random delay added before firing, ISO 8601
    #[serde(default)]
    pub weeks_interval:       u32,      // Weekly trigger: repeat every N weeks
    #[serde(default)]
    pub days_of_week:         u32,      // Weekly trigger bitmask: Sun=1,Mon=2,Tue=4,Wed=8,Thu=16,Fri=32,Sat=64
    #[serde(default)]
    pub months_of_year:       u32,      // Monthly trigger bitmask: Jan=1,Feb=2,…,Dec=2048
    #[serde(default)]
    pub days_of_month:        u32,      // Monthly trigger bitmask: bit0=day1,…,bit30=day31
    #[serde(default)]
    pub stop_existing:        bool,     // TASK_INSTANCES_STOP_EXISTING vs IGNORE_NEW
    #[serde(default)]
    pub delete_expired:       bool,     // delete task after it expires (DeleteExpiredTaskAfter)
    #[serde(default = "default_priority")]
    pub priority:             u32,      // thread priority 0–10 (default 7 = Normal)
    #[serde(default)]
    pub wake_to_run:          bool,     // WakeToRun setting
    #[serde(default)]
    pub run_only_if_network:  bool,     // RunOnlyIfNetworkAvailable
    #[serde(default)]
    pub run_only_if_idle:     bool,     // RunOnlyIfIdle
    #[serde(default)]
    pub disallow_on_batteries: bool,    // DisallowStartIfOnBatteries
    #[serde(default)]
    pub stop_on_batteries:    bool,     // StopIfGoingOnBatteries
    #[serde(default)]
    pub env_vars:             String,   // newline-separated KEY=VALUE pairs
}

// ── Shared validation ───────────────────────────────────────────────────────

/// Validate a task name against Windows Task Scheduler restrictions.
/// Forbidden characters: \ / : * ? " < > |
/// Returns E_INVALIDARG (0x80070057) so errors surface correctly via IPC.
fn validate_task_name(name: &str) -> Result<()> {
    if name.chars().any(|c| matches!(c, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|'))
        || name.trim().is_empty()
    {
        return Err(windows::core::Error::new(
            windows::core::HRESULT(0x80070057u32 as i32),
            "Task name contains invalid characters (cannot use \\ / : * ? \" < > |)",
        ));
    }
    Ok(())
}

// ── Shared trigger-builder ───────────────────────────────────────────────────
//
// Called from BOTH `create_task` and `update_task` so trigger logic stays in
// lockstep. Previously this was ~120 lines copy-pasted between the two methods;
// any fix to one branch silently failed to apply to the other (the historical
// root cause of "edit task does X correctly but create doesn't" or vice-versa).
//
// SAFETY: every COM call inside is wrapped in its own `unsafe {}` because the
// `unsafe_op_in_unsafe_fn` lint requires explicit unsafe blocks even inside an
// `unsafe fn` body in Rust 2021.
//
// GOTCHA: This MUST be called AFTER `defn.Triggers()` is callable, which is
//         immediately after `service.NewTask(0)` succeeds. Both call sites
//         already satisfy this.
unsafe fn apply_triggers_to_definition(defn: &ITaskDefinition, p: &CreateTaskParams) -> Result<()> {
    let trig_col = unsafe { defn.Triggers()? };
    let ttype = match p.trigger_type.as_str() {
        "Once"          => TASK_TRIGGER_TIME,
        "Weekly"        => TASK_TRIGGER_WEEKLY,
        "Monthly"       => TASK_TRIGGER_MONTHLY,
        "Boot"          => TASK_TRIGGER_BOOT,
        "Logon"         => TASK_TRIGGER_LOGON,
        "Idle"          => TASK_TRIGGER_IDLE,
        "SessionLock"   => TASK_TRIGGER_SESSION_STATE_CHANGE,
        "SessionUnlock" => TASK_TRIGGER_SESSION_STATE_CHANGE,
        "Interval"      => TASK_TRIGGER_DAILY,  // maps to Daily + repetition
        _               => TASK_TRIGGER_DAILY,
    };
    let trigger = unsafe { trig_col.Create(ttype)? };
    unsafe { trigger.SetEnabled(VARIANT_TRUE)?; }

    let time_based = matches!(
        ttype,
        TASK_TRIGGER_TIME | TASK_TRIGGER_DAILY | TASK_TRIGGER_WEEKLY | TASK_TRIGGER_MONTHLY
    );
    if time_based && !p.start_datetime.is_empty() {
        unsafe { trigger.SetStartBoundary(&BSTR::from(p.start_datetime.as_str()))?; }
    }
    if !p.end_boundary.is_empty() {
        unsafe { let _ = trigger.SetEndBoundary(&BSTR::from(p.end_boundary.as_str())); }
    }
    if !p.repetition_interval.is_empty() {
        unsafe {
            if let Ok(rep) = trigger.Repetition() {
                let _ = rep.SetInterval(&BSTR::from(p.repetition_interval.as_str()));
                if !p.repetition_duration.is_empty() {
                    let _ = rep.SetDuration(&BSTR::from(p.repetition_duration.as_str()));
                }
                let _ = rep.SetStopAtDurationEnd(vb(p.stop_at_duration_end));
            }
        }
    }
    if ttype == TASK_TRIGGER_DAILY {
        if let Ok(dt) = trigger.cast::<IDailyTrigger>() {
            // Clamp to [1, 365] before casting to i16 — a u32 > 32767 wraps negative.
            let days = p.days_interval.max(1).min(365) as i16;
            unsafe { dt.SetDaysInterval(days)?; }
            if !p.random_delay.is_empty() {
                unsafe { let _ = dt.SetRandomDelay(&BSTR::from(p.random_delay.as_str())); }
            }
        }
    }
    if ttype == TASK_TRIGGER_TIME && !p.random_delay.is_empty() {
        if let Ok(tt) = trigger.cast::<ITimeTrigger>() {
            unsafe { let _ = tt.SetRandomDelay(&BSTR::from(p.random_delay.as_str())); }
        }
    }
    if ttype == TASK_TRIGGER_WEEKLY {
        if let Ok(wt) = trigger.cast::<IWeeklyTrigger>() {
            let wi = if p.weeks_interval > 0 { p.weeks_interval } else { p.days_interval.max(1) };
            unsafe { wt.SetWeeksInterval(wi.max(1).min(52) as i16)?; }
            if p.days_of_week > 0 {
                // Mask to the valid 7-bit day set (Sun=1…Sat=64) before the
                // narrowing i16 cast — an out-of-range IPC value with bit 15+
                // set would otherwise sign-flip into a bogus day selection.
                unsafe { let _ = wt.SetDaysOfWeek((p.days_of_week & 0x7F) as i16); }
            }
            if !p.random_delay.is_empty() {
                unsafe { let _ = wt.SetRandomDelay(&BSTR::from(p.random_delay.as_str())); }
            }
        }
    }
    if ttype == TASK_TRIGGER_MONTHLY {
        if let Ok(mt) = trigger.cast::<IMonthlyTrigger>() {
            if p.days_of_month > 0 {
                // Mask to the valid 31-day bitfield before the cast.
                unsafe { let _ = mt.SetDaysOfMonth((p.days_of_month & 0x7FFF_FFFF) as i32); }
            } else {
                let day_bit = 1i32 << ((p.days_interval.max(1).min(31) - 1) as i32);
                unsafe { let _ = mt.SetDaysOfMonth(day_bit); }
            }
            if p.months_of_year > 0 {
                // Mask to the valid 12-month bitfield (Jan=1…Dec=2048) before
                // the narrowing i16 cast — any bit ≥ 15 would flip the sign.
                unsafe { let _ = mt.SetMonthsOfYear((p.months_of_year & 0x0FFF) as i16); }
            }
            if !p.random_delay.is_empty() {
                unsafe { let _ = mt.SetRandomDelay(&BSTR::from(p.random_delay.as_str())); }
            }
        }
    }
    if ttype == TASK_TRIGGER_BOOT && !p.delay.is_empty() {
        if let Ok(bt) = trigger.cast::<IBootTrigger>() {
            unsafe { let _ = bt.SetDelay(&BSTR::from(p.delay.as_str())); }
        }
    }
    if ttype == TASK_TRIGGER_LOGON && !p.delay.is_empty() {
        if let Ok(lt) = trigger.cast::<ILogonTrigger>() {
            unsafe { let _ = lt.SetDelay(&BSTR::from(p.delay.as_str())); }
        }
    }
    if ttype == TASK_TRIGGER_SESSION_STATE_CHANGE {
        if let Ok(sst) = trigger.cast::<ISessionStateChangeTrigger>() {
            let ct = if p.trigger_type == "SessionUnlock" { TASK_SESSION_UNLOCK } else { TASK_SESSION_LOCK };
            unsafe { sst.SetStateChange(ct)?; }
            if !p.delay.is_empty() {
                unsafe { let _ = sst.SetDelay(&BSTR::from(p.delay.as_str())); }
            }
        }
    }
    Ok(())
}

// ── Engine ────────────────────────────────────────────────────────────────────
pub struct SchedulerEngine {
    service: ITaskService,
    /// Whether this instance successfully called CoInitializeEx (S_OK).
    /// If true, CoUninitialize must be called in Drop to balance the init.
    com_initialized: bool,
}

// SAFETY: we only ever call this from behind a Mutex
unsafe impl Send for SchedulerEngine {}
unsafe impl Sync for SchedulerEngine {}

impl Drop for SchedulerEngine {
    fn drop(&mut self) {
        if self.com_initialized {
            // Balance the CoInitializeEx(S_OK) call we made in new()
            unsafe { CoUninitialize(); }
        }
    }
}

impl SchedulerEngine {
    pub fn new() -> Result<Self> {
        unsafe {
            // Use APARTMENTTHREADED to match Tauri/tao's COM mode
            // Ignore RPC_E_CHANGED_MODE — means COM already initialized, which is fine
            let hr = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
            // Track whether WE initialized COM so Drop can call CoUninitialize.
            // S_OK (0) = we initialized (must uninitialize); S_FALSE (1) = COM was
            // already initialized in the same apartment (must NOT uninitialize);
            // RPC_E_CHANGED_MODE = different apartment already, must NOT uninitialize.
            let com_initialized = hr.0 == 0; // true only for S_OK — we own this init
            if hr.is_err() {
                let code = hr.0;
                // 0x80010106 = RPC_E_CHANGED_MODE — already initialized, safe to continue
                if code != 0x80010106u32 as i32 {
                    hr.ok()?;
                }
            }

            // RAII: if WE own the COM init and any step below returns early via `?`,
            // CoUninitialize to balance it. Without this, a failed CoCreateInstance
            // /Connect leaks the init — harmless once, but get_all_tasks/get_tasks
            // now build a fresh engine per call on reused blocking-pool threads, so
            // a repeatedly-failing new() would leak many inits on the same thread.
            // GOTCHA (Rule 52): inner items resolve in MODULE scope — full path.
            struct InitGuard(bool);
            impl Drop for InitGuard {
                fn drop(&mut self) {
                    if self.0 { unsafe { windows::Win32::System::Com::CoUninitialize(); } }
                }
            }
            let mut com_guard = InitGuard(com_initialized);

            let service: ITaskService =
                CoCreateInstance(&TaskScheduler, None, CLSCTX_INPROC_SERVER)?;

            let v = VARIANT::default();
            service.Connect(&v, &v, &v, &v)?;

            // Success — ownership of the COM init transfers to the returned struct
            // (its Drop calls CoUninitialize). Disarm the guard so it doesn't too.
            com_guard.0 = false;
            Ok(SchedulerEngine { service, com_initialized })
        }
    }

    // ── Folders ───────────────────────────────────────────────────────────────
    pub fn get_folders(&self) -> Result<Vec<String>> {
        let root = unsafe { self.service.GetFolder(&BSTR::from("\\"))? };
        let mut out = vec!["\\".to_string()];
        self.collect_folders(&root, "\\", &mut out)?;
        Ok(out)
    }

    fn collect_folders(&self, folder: &ITaskFolder, path: &str, out: &mut Vec<String>) -> Result<()> {
        let subs  = unsafe { folder.GetFolders(0)? };
        let count = unsafe { subs.Count()? };
        for i in 1..=count {
            let v   = vi(i);
            let sub = match unsafe { subs.get_Item(&v) } {
                Ok(s)  => s,
                Err(_) => continue,
            };
            let name     = unsafe { sub.Name()?.to_string() };
            let sub_path = if path == "\\" { format!("\\{}", name) } else { format!("{}\\{}", path, name) };
            out.push(sub_path.clone());
            self.collect_folders(&sub, &sub_path, out)?;
        }
        Ok(())
    }

    // ── Tasks ─────────────────────────────────────────────────────────────────
    pub fn get_tasks(&self, folder_path: &str) -> Result<Vec<TaskInfo>> {
        let folder = unsafe { self.service.GetFolder(&BSTR::from(folder_path))? };
        // Pass TASK_ENUM_HIDDEN (0x1) so hidden/system tasks are included.
        // Without this flag, many Microsoft system tasks are invisible.
        let tasks  = unsafe { folder.GetTasks(1)? };
        let count  = unsafe { tasks.Count()? };
        let mut out = Vec::new();
        for i in 1..=count {
            let v    = vi(i);
            let task = match unsafe { tasks.get_Item(&v) } {
                Ok(t)  => t,
                Err(_) => continue,
            };
            if let Ok(info) = self.extract_task(&task, folder_path) {
                out.push(info);
            }
        }
        Ok(out)
    }

    fn extract_task(&self, task: &IRegisteredTask, folder: &str) -> Result<TaskInfo> {
        let name       = unsafe { task.Name()?.to_string() };
        let path       = unsafe { task.Path()?.to_string() };
        let last_run_d = unsafe { task.LastRunTime()? };
        let next_run_d = unsafe { task.NextRunTime()? };
        let state      = unsafe { task.State()? };
        let enabled    = unsafe { task.Enabled()?.as_bool() };
        let last_code  = unsafe { task.LastTaskResult()? };

        let (status, status_code) = if !enabled {
            ("Disabled".to_string(), 1u32)
        } else {
            task_state_str(state)
        };

        let defn      = unsafe { task.Definition()? };
        let reg_info  = unsafe { defn.RegistrationInfo()? };
        let principal = unsafe { defn.Principal()? };
        let settings  = unsafe { defn.Settings()? };

        let description = unsafe { read_bstr(|b| reg_info.Description(b)) };
        let author      = unsafe { read_bstr(|b| reg_info.Author(b)) };
        let run_as_user = unsafe { read_bstr(|b| principal.UserId(b)) };

        let hidden = unsafe {
            let mut h = VARIANT_FALSE;
            let _ = settings.Hidden(&mut h);
            h.as_bool()
        };

        // ── Triggers ─────────────────────────────────────────────────────────
        let trig_col = unsafe { defn.Triggers()? };
        let tcnt     = unsafe { read_i32(|p| trig_col.Count(p)) };
        let mut triggers              = Vec::new();
        let mut trigger_type          = String::new();
        let mut trigger_start         = String::new();
        let mut trigger_interval      = 0u32;
        let mut trigger_days_of_week  = 0u32;
        let mut trigger_months        = 0u32;
        let mut trigger_days_of_month = 0u32;
        let mut exec_time_limit       = String::new();
        let mut repetition_interval   = String::new();
        let mut repetition_duration   = String::new();
        let mut stop_at_duration_end  = false;
        let mut random_delay          = String::new();
        let mut end_boundary          = String::new();
        let mut boot_delay            = String::new();

        for j in 1..=tcnt {
            if let Ok(t) = unsafe { trig_col.get_Item(j) } {
                let mut ttype = TASK_TRIGGER_TYPE2::default();
                unsafe { let _ = t.Type(&mut ttype); }
                triggers.push(trigger_str(ttype));

                // Read detailed properties only from the first trigger
                if j == 1 {
                    trigger_start   = unsafe { read_bstr(|b| t.StartBoundary(b)) };
                    end_boundary    = unsafe { read_bstr(|b| t.EndBoundary(b)) };
                    exec_time_limit = unsafe { read_bstr(|b| t.ExecutionTimeLimit(b)) };

                    // Repetition pattern
                    if let Ok(rep) = unsafe { t.Repetition() } {
                        repetition_interval  = unsafe { read_bstr(|b| rep.Interval(b)) };
                        repetition_duration  = unsafe { read_bstr(|b| rep.Duration(b)) };
                        stop_at_duration_end = unsafe {
                            let mut v = VARIANT_FALSE;
                            let _ = rep.StopAtDurationEnd(&mut v);
                            v.as_bool()
                        };
                    }

                    match ttype {
                        TASK_TRIGGER_DAILY => {
                            let mut days: i16 = 1;
                            if let Ok(dt) = t.cast::<IDailyTrigger>() {
                                unsafe { let _ = dt.DaysInterval(&mut days); }
                                random_delay = unsafe { read_bstr(|b| dt.RandomDelay(b)) };
                            }
                            trigger_interval = days.max(1) as u32;
                            // Daily with interval=1 and a repetition_interval → report as Interval
                            trigger_type = if days <= 1 && !repetition_interval.is_empty() {
                                "Interval".into()
                            } else {
                                "Daily".into()
                            };
                        }
                        TASK_TRIGGER_WEEKLY => {
                            trigger_type = "Weekly".into();
                            if let Ok(wt) = t.cast::<IWeeklyTrigger>() {
                                let mut wi: i16 = 1;
                                let mut dow: i16 = 0;
                                unsafe {
                                    let _ = wt.WeeksInterval(&mut wi);
                                    let _ = wt.DaysOfWeek(&mut dow);
                                }
                                random_delay         = unsafe { read_bstr(|b| wt.RandomDelay(b)) };
                                trigger_interval     = wi.max(1) as u32;
                                trigger_days_of_week = dow as u32;
                            }
                        }
                        TASK_TRIGGER_MONTHLY => {
                            trigger_type = "Monthly".into();
                            if let Ok(mt) = t.cast::<IMonthlyTrigger>() {
                                let mut dom: i32 = 0;
                                let mut moy: i16 = 0;
                                unsafe {
                                    let _ = mt.DaysOfMonth(&mut dom);
                                    let _ = mt.MonthsOfYear(&mut moy);
                                }
                                random_delay          = unsafe { read_bstr(|b| mt.RandomDelay(b)) };
                                trigger_days_of_month = dom as u32;
                                trigger_months        = moy as u32;
                            }
                        }
                        TASK_TRIGGER_TIME => {
                            trigger_type = "Once".into();
                            if let Ok(tt) = t.cast::<ITimeTrigger>() {
                                random_delay = unsafe { read_bstr(|b| tt.RandomDelay(b)) };
                            }
                        }
                        TASK_TRIGGER_BOOT => {
                            trigger_type = "Boot".into();
                            if let Ok(bt) = t.cast::<IBootTrigger>() {
                                boot_delay = unsafe { read_bstr(|b| bt.Delay(b)) };
                            }
                        }
                        TASK_TRIGGER_LOGON => {
                            trigger_type = "Logon".into();
                            if let Ok(lt) = t.cast::<ILogonTrigger>() {
                                boot_delay = unsafe { read_bstr(|b| lt.Delay(b)) };
                            }
                        }
                        TASK_TRIGGER_IDLE => {
                            trigger_type = "Idle".into();
                        }
                        TASK_TRIGGER_SESSION_STATE_CHANGE => {
                            if let Ok(sst) = t.cast::<ISessionStateChangeTrigger>() {
                                let mut sc = TASK_SESSION_STATE_CHANGE_TYPE::default();
                                unsafe { let _ = sst.StateChange(&mut sc); }
                                trigger_type = if sc == TASK_SESSION_UNLOCK {
                                    "SessionUnlock".into()
                                } else {
                                    "SessionLock".into()
                                };
                                boot_delay = unsafe { read_bstr(|b| sst.Delay(b)) };
                            } else {
                                trigger_type = "Custom".into();
                            }
                        }
                        _ => { trigger_type = "Custom".into(); }
                    }
                }
            }
        }

        // ── Settings ─────────────────────────────────────────────────────────
        let wake_to_run = unsafe {
            let mut v = VARIANT_FALSE; let _ = settings.WakeToRun(&mut v); v.as_bool()
        };
        let run_only_if_network = unsafe {
            let mut v = VARIANT_FALSE; let _ = settings.RunOnlyIfNetworkAvailable(&mut v); v.as_bool()
        };
        let run_only_if_idle = unsafe {
            let mut v = VARIANT_FALSE; let _ = settings.RunOnlyIfIdle(&mut v); v.as_bool()
        };
        let disallow_on_battery_start = unsafe {
            let mut v = VARIANT_FALSE; let _ = settings.DisallowStartIfOnBatteries(&mut v); v.as_bool()
        };
        let stop_on_battery = unsafe {
            let mut v = VARIANT_FALSE; let _ = settings.StopIfGoingOnBatteries(&mut v); v.as_bool()
        };
        let mut priority_val: i32 = 7;
        unsafe { let _ = settings.Priority(&mut priority_val); }
        let priority = priority_val.clamp(0, 10) as u32;

        let mut multi_inst = TASK_INSTANCES_IGNORE_NEW;
        unsafe { let _ = settings.MultipleInstances(&mut multi_inst); }
        let stop_if_running = multi_inst == TASK_INSTANCES_STOP_EXISTING;

        let delete_after = unsafe { read_bstr(|b| settings.DeleteExpiredTaskAfter(b)) };
        let delete_expired = !delete_after.is_empty();

        // Use settings ExecutionTimeLimit as fallback if trigger didn't set one
        if exec_time_limit.is_empty() {
            exec_time_limit = unsafe { read_bstr(|b| settings.ExecutionTimeLimit(b)) };
        }

        // ── Actions ───────────────────────────────────────────────────────────
        let act_col = unsafe { defn.Actions()? };
        let acnt    = unsafe { read_i32(|p| act_col.Count(p)) };
        let mut actions      = Vec::new();
        let mut program_path = String::new();
        let mut program_args = String::new();
        let mut working_dir  = String::new();

        for j in 1..=acnt {
            if let Ok(act) = unsafe { act_col.get_Item(j) } {
                if let Ok(exec) = act.cast::<IExecAction>() {
                    let p = unsafe { read_bstr(|b| exec.Path(b)) };
                    let a = unsafe { read_bstr(|b| exec.Arguments(b)) };
                    // Capture first action's details for the new fields
                    if j == 1 {
                        program_path = p.clone();
                        program_args = a.clone();
                        working_dir  = unsafe { read_bstr(|b| exec.WorkingDirectory(b)) };
                    }
                    actions.push(if a.is_empty() { p } else { format!("{} {}", p, a) });
                }
            }
        }

        // ── Principal ─────────────────────────────────────────────────────────
        let mut rl = TASK_RUNLEVEL_LUA;
        unsafe { let _ = principal.RunLevel(&mut rl); }
        let run_level = if rl == TASK_RUNLEVEL_HIGHEST { 1u32 } else { 0u32 };

        Ok(TaskInfo {
            name, path,
            folder:           folder.to_string(),
            status,           status_code,
            last_run:         ole_date(last_run_d),
            next_run:         ole_date(next_run_d),
            last_result:      fmt_code(last_code),
            last_result_code: last_code,
            triggers,         actions,
            action_count:     acnt.max(0) as u32,
            description,      author,
            run_as_user,      hidden,
            enabled,
            // Trigger details
            trigger_type, trigger_start, trigger_interval,
            trigger_days_of_week, trigger_months, trigger_days_of_month,
            // Advanced
            exec_time_limit, repetition_interval, repetition_duration,
            stop_at_duration_end, random_delay, end_boundary, boot_delay,
            // Conditions
            wake_to_run, run_only_if_network, run_only_if_idle,
            disallow_on_battery_start, stop_on_battery,
            // Settings
            priority, stop_if_running, delete_expired,
            // Action details
            program_path, program_args, working_dir, run_level,
        })
    }

    // ── Control ───────────────────────────────────────────────────────────────
    pub fn run_task(&self, task_path: &str) -> Result<()> {
        let (fp, tn) = split_path(task_path);
        let folder   = unsafe { self.service.GetFolder(&BSTR::from(fp))? };
        let task     = unsafe { folder.GetTask(&BSTR::from(tn))? };
        let v        = VARIANT::default();
        unsafe { task.Run(&v)? };
        Ok(())
    }

    pub fn stop_task(&self, task_path: &str) -> Result<()> {
        let (fp, tn) = split_path(task_path);
        let folder   = unsafe { self.service.GetFolder(&BSTR::from(fp))? };
        let task     = unsafe { folder.GetTask(&BSTR::from(tn))? };
        unsafe { task.Stop(0)? };
        Ok(())
    }

    pub fn set_enabled(&self, task_path: &str, enable: bool) -> Result<()> {
        let (fp, tn) = split_path(task_path);
        let folder   = unsafe { self.service.GetFolder(&BSTR::from(fp))? };
        let task     = unsafe { folder.GetTask(&BSTR::from(tn))? };
        unsafe { task.SetEnabled(vb(enable))? };
        Ok(())
    }

    pub fn delete_task(&self, task_path: &str) -> Result<()> {
        let (fp, tn) = split_path(task_path);
        let folder   = unsafe { self.service.GetFolder(&BSTR::from(fp))? };
        unsafe { folder.DeleteTask(&BSTR::from(tn), 0)? };
        Ok(())
    }

    // ── XML ───────────────────────────────────────────────────────────────────
    pub fn export_xml(&self, task_path: &str) -> Result<String> {
        let (fp, tn) = split_path(task_path);
        let folder   = unsafe { self.service.GetFolder(&BSTR::from(fp))? };
        let task     = unsafe { folder.GetTask(&BSTR::from(tn))? };
        Ok(unsafe { task.Xml()?.to_string() })
    }

    pub fn import_xml(&self, folder_path: &str, task_name: &str, xml: &str) -> Result<()> {
        // Validate the name on the import path too, so it enforces the same
        // consistency guarantees as create_task / update_task (which both call
        // validate_task_name). Without this, import is the one registration path
        // that accepts names the other two reject. RegisterTask below uses
        // TASK_CREATE_OR_UPDATE, so a name collision overwrites in place — the
        // caller (restore / backup-restore) is responsible for collision UX.
        validate_task_name(task_name)?;
        let folder = unsafe { self.service.GetFolder(&BSTR::from(folder_path))? };
        let v      = VARIANT::default();
        unsafe {
            folder.RegisterTask(
                &BSTR::from(task_name),
                &BSTR::from(xml),
                TASK_CREATE_OR_UPDATE.0,
                &v, &v,
                TASK_LOGON_NONE,
                &v,
            )?;
        }
        Ok(())
    }

    // ── Create ────────────────────────────────────────────────────────────────
    pub fn create_task(&self, p: &CreateTaskParams) -> Result<()> {
        // Validate task name: Windows Task Scheduler forbids these characters.
        validate_task_name(&p.name)?;

        let defn: ITaskDefinition = unsafe { self.service.NewTask(0)? };

        let reg = unsafe { defn.RegistrationInfo()? };
        unsafe {
            reg.SetDescription(&BSTR::from(p.description.as_str()))?;
            reg.SetAuthor(&BSTR::from(p.author.as_str()))?;
        }

        let settings = unsafe { defn.Settings()? };
        let exec_limit = if p.execution_time_limit.is_empty() { "PT0S" } else { p.execution_time_limit.as_str() };
        unsafe {
            settings.SetEnabled(vb(p.enabled))?;
            settings.SetHidden(vb(p.hidden))?;
            settings.SetStartWhenAvailable(VARIANT_TRUE)?;
            settings.SetMultipleInstances(
                if p.stop_existing { TASK_INSTANCES_STOP_EXISTING } else { TASK_INSTANCES_IGNORE_NEW }
            )?;
            settings.SetExecutionTimeLimit(&BSTR::from(exec_limit))?;
            settings.SetPriority(p.priority.clamp(0, 10) as i32)?;
            settings.SetWakeToRun(vb(p.wake_to_run))?;
            settings.SetRunOnlyIfNetworkAvailable(vb(p.run_only_if_network))?;
            settings.SetDisallowStartIfOnBatteries(vb(p.disallow_on_batteries))?;
            settings.SetStopIfGoingOnBatteries(vb(p.stop_on_batteries))?;
            settings.SetRunOnlyIfIdle(vb(p.run_only_if_idle))?;
            if p.delete_expired {
                let _ = settings.SetDeleteExpiredTaskAfter(&BSTR::from("PT0S"));
            }
        }

        // Compute run_as and logon type BEFORE configuring the principal so both
        // share the same values and SetLogonType is called consistently.
        let run_as = p.run_as_user.trim();
        let u_upper = run_as.to_ascii_uppercase();
        let is_service_account = !run_as.is_empty()
            && (u_upper == "SYSTEM"
                || u_upper.starts_with("NT AUTHORITY\\")
                || u_upper.starts_with("NT SERVICE\\"));

        let logon = if is_service_account {
            // Well-known service accounts (SYSTEM, NT AUTHORITY\*, NT SERVICE\*)
            TASK_LOGON_SERVICE_ACCOUNT
        } else {
            // INTERACTIVE_TOKEN works for both "no user specified" and "named regular user"
            // without requiring SeTcbPrivilege. Windows runs the task as the current
            // interactive session user.
            TASK_LOGON_INTERACTIVE_TOKEN
        };

        let principal = unsafe { defn.Principal()? };
        let run_level = if p.run_level == 1 { TASK_RUNLEVEL_HIGHEST } else { TASK_RUNLEVEL_LUA };
        unsafe {
            principal.SetRunLevel(run_level)?;
            principal.SetLogonType(logon)?;
            // Only set UserId for service accounts; INTERACTIVE_TOKEN must NOT have UserId set.
            if is_service_account {
                principal.SetUserId(&BSTR::from(run_as))?;
            }
        }

        // Triggers — shared with create_task/update_task via apply_triggers_to_definition()
        unsafe { apply_triggers_to_definition(&defn, p)?; }

        let act_col = unsafe { defn.Actions()? };
        let action  = unsafe { act_col.Create(TASK_ACTION_EXEC)? };
        let exec: IExecAction = action.cast()?;

        // If env_vars are set, wrap the command in cmd.exe with SET statements.
        // Each KEY=VALUE pair is escaped so that cmd.exe special characters in
        // the value portion (& | < > ^ ( ) ") cannot break out of the SET command.
        // MED-3 / HIGH-1: use shared build_exec_action() — eliminates the
        // duplicated env_vars block and ensures program_path is always escaped.
        unsafe { build_exec_action(&exec, p)?; }

        // Normalise folder_path: treat empty or root as "\\"
        let folder_path = {
            let fp = p.folder_path.trim();
            if fp.is_empty() { "\\".to_string() } else { fp.to_string() }
        };
        let folder = unsafe { self.service.GetFolder(&BSTR::from(folder_path.as_str()))? };
        let empty_v = VARIANT::default();

        // For service accounts, pass the account name in the userId VARIANT so
        // Windows Task Scheduler knows which service account to use.
        // Note: is_service_account is only true when run_as is non-empty (SYSTEM/NT AUTHORITY/NT SERVICE).
        let user_v = if is_service_account {
            VARIANT::from(BSTR::from(run_as))
        } else {
            VARIANT::default()
        };

        unsafe {
            folder.RegisterTaskDefinition(
                &BSTR::from(p.name.as_str()),
                &defn,
                TASK_CREATE_OR_UPDATE.0,
                &user_v,   // userId: service account name or empty for interactive
                &empty_v,  // password: empty
                logon,
                &empty_v,  // sddl: empty
            )?;
        }
        Ok(())
    }

    // ── Update — preserve the existing task's security principal ─────────────
    // The old delete+recreate approach broke system tasks (SYSTEM, NT AUTHORITY\*)
    // because recreating them with TASK_LOGON_INTERACTIVE_TOKEN is rejected.
    // Instead we:
    //   1. Read the existing task's logon type and UserId.
    //   2. Build a fresh ITaskDefinition from `p` (triggers, actions, settings).
    //   3. Apply the preserved principal onto the new definition.
    //   4. Register with TASK_CREATE_OR_UPDATE — no delete needed.
    pub fn update_task(&self, task_path: &str, p: &CreateTaskParams) -> Result<()> {
        let (fp, tn) = split_path(task_path);
        let folder   = unsafe { self.service.GetFolder(&BSTR::from(fp))? };

        // ── Read existing principal + author (best-effort) ────────────────────
        // Author is preserved here because the simple-form editor exposes no
        // Author field, so `p.author` is always empty on an edit. Without this,
        // every edit would blank the task's Author metadata (e.g. wipe
        // "Microsoft Corporation" off a system task) — silent definition
        // corruption. Mirrors the principal-preservation pattern below.
        // (audit fix 1.15.1)
        let mut preserved_logon:  Option<TASK_LOGON_TYPE>    = None;
        let mut preserved_user:   Option<String>             = None;
        let mut preserved_level:  Option<TASK_RUNLEVEL_TYPE> = None;
        let mut preserved_author: Option<String>             = None;

        if let Ok(existing) = unsafe { folder.GetTask(&BSTR::from(tn)) } {
            if let Ok(defn) = unsafe { existing.Definition() } {
                if let Ok(pr) = unsafe { defn.Principal() } {
                    let mut lt = TASK_LOGON_NONE;
                    unsafe { let _ = pr.LogonType(&mut lt); }
                    preserved_logon = Some(lt);

                    let user = unsafe { read_bstr(|b| pr.UserId(b)) };
                    if !user.is_empty() { preserved_user = Some(user); }

                    let mut rl = TASK_RUNLEVEL_LUA;
                    unsafe { let _ = pr.RunLevel(&mut rl); }
                    preserved_level = Some(rl);
                }
                if let Ok(ri) = unsafe { defn.RegistrationInfo() } {
                    let a = unsafe { read_bstr(|b| ri.Author(b)) };
                    if !a.is_empty() { preserved_author = Some(a); }
                }
            }
        }

        // ── Build the new definition (same path as create_task) ───────────────
        // We re-use create_task's full logic by temporarily calling it inside a
        // try — but we can't pass the preserved principal through CreateTaskParams
        // easily, so instead we rebuild the definition inline and apply the
        // preserved principal at the end.

        // Validate name
        validate_task_name(&p.name)?;

        // Build definition and registration info
        let defn: ITaskDefinition = unsafe { self.service.NewTask(0)? };
        let reg = unsafe { defn.RegistrationInfo()? };
        // Author: the simple-form editor has no author field (p.author is ""),
        // so preserve the existing author rather than blanking it. If a caller
        // ever supplies a non-empty author explicitly, that wins. (audit fix 1.15.1)
        let final_author = if !p.author.trim().is_empty() {
            p.author.clone()
        } else {
            preserved_author.clone().unwrap_or_default()
        };
        unsafe {
            reg.SetDescription(&BSTR::from(p.description.as_str()))?;
            reg.SetAuthor(&BSTR::from(final_author.as_str()))?;
        }

        // Settings
        let settings = unsafe { defn.Settings()? };
        let exec_limit = if p.execution_time_limit.is_empty() { "PT0S" } else { p.execution_time_limit.as_str() };
        unsafe {
            settings.SetEnabled(vb(p.enabled))?;
            settings.SetHidden(vb(p.hidden))?;
            settings.SetStartWhenAvailable(VARIANT_TRUE)?;
            settings.SetMultipleInstances(
                if p.stop_existing { TASK_INSTANCES_STOP_EXISTING } else { TASK_INSTANCES_IGNORE_NEW }
            )?;
            settings.SetExecutionTimeLimit(&BSTR::from(exec_limit))?;
            settings.SetPriority(p.priority.clamp(0, 10) as i32)?;
            settings.SetWakeToRun(vb(p.wake_to_run))?;
            settings.SetRunOnlyIfNetworkAvailable(vb(p.run_only_if_network))?;
            settings.SetDisallowStartIfOnBatteries(vb(p.disallow_on_batteries))?;
            settings.SetStopIfGoingOnBatteries(vb(p.stop_on_batteries))?;
            settings.SetRunOnlyIfIdle(vb(p.run_only_if_idle))?;
            if p.delete_expired {
                let _ = settings.SetDeleteExpiredTaskAfter(&BSTR::from("PT0S"));
            }
        }

        // Principal — use preserved values when available, fall back to params
        let run_as  = p.run_as_user.trim();
        let u_upper = run_as.to_ascii_uppercase();
        let is_service_account = !run_as.is_empty()
            && (u_upper == "SYSTEM"
                || u_upper.starts_with("NT AUTHORITY\\")
                || u_upper.starts_with("NT SERVICE\\"));

        // Determine the final logon type: prefer the preserved one so we never
        // accidentally downgrade a service-account task to INTERACTIVE_TOKEN.
        let final_logon = preserved_logon.unwrap_or_else(|| {
            if is_service_account { TASK_LOGON_SERVICE_ACCOUNT } else { TASK_LOGON_INTERACTIVE_TOKEN }
        });
        let final_level = preserved_level.unwrap_or(
            if p.run_level == 1 { TASK_RUNLEVEL_HIGHEST } else { TASK_RUNLEVEL_LUA }
        );
        // Determine final user: preserved user wins unless the caller explicitly
        // provided a different service account.
        let final_user: String = if is_service_account {
            run_as.to_string()
        } else {
            preserved_user.clone().unwrap_or_default()
        };

        let principal = unsafe { defn.Principal()? };
        unsafe {
            principal.SetRunLevel(final_level)?;
            principal.SetLogonType(final_logon)?;
            if !final_user.is_empty() {
                let _ = principal.SetUserId(&BSTR::from(final_user.as_str()));
            }
        }

        // Triggers (copied verbatim from create_task)
        // Triggers — shared with create_task/update_task via apply_triggers_to_definition()
        unsafe { apply_triggers_to_definition(&defn, p)?; }
        // Action
        let act_col = unsafe { defn.Actions()? };
        let action  = unsafe { act_col.Create(TASK_ACTION_EXEC)? };
        let exec: IExecAction = action.cast()?;
        // MED-3 / HIGH-1: use shared build_exec_action() — eliminates the
        // duplicated env_vars block and ensures program_path is always escaped.
        unsafe { build_exec_action(&exec, p)?; }

        // Register — no delete needed; TASK_CREATE_OR_UPDATE updates in place.
        // BUG FIX (2.1.0): use the SOURCE folder `fp` (extracted from `task_path`)
        // — NOT `p.folder_path` from the form.
        // If `p.folder_path` differed from where the task currently lives,
        // RegisterTaskDefinition would create a NEW copy in the form folder while
        // leaving the original in place — silent task duplication. The detail
        // panel populates the folder field from the displayed task, but tasks
        // loaded via `get_all_tasks` aggregate across folders, and the form's
        // folder field has been observed to drift on edit.
        // Moving a task between folders should be an explicit operation.
        let folder_path = if fp.is_empty() { "\\".to_string() } else { fp.to_string() };
        let reg_folder = unsafe { self.service.GetFolder(&BSTR::from(folder_path.as_str()))? };
        let empty_v    = VARIANT::default();
        let user_v: VARIANT = if !final_user.is_empty() {
            VARIANT::from(BSTR::from(final_user.as_str()))
        } else {
            VARIANT::default()
        };

        unsafe {
            reg_folder.RegisterTaskDefinition(
                &BSTR::from(p.name.as_str()),
                &defn,
                TASK_CREATE_OR_UPDATE.0,
                &user_v,
                &empty_v,
                final_logon,
                &empty_v,
            )?;
        }
        Ok(())
    }

    // ── Running tasks ─────────────────────────────────────────────────────────
    pub fn get_running_tasks(&self) -> Result<Vec<RunningTaskInfo>> {
        let col = unsafe { self.service.GetRunningTasks(0)? };
        let count = unsafe { col.Count().unwrap_or(0) };
        let mut out = Vec::new();
        for i in 1..=count {
            let v = vi(i);
            let rt = match unsafe { col.get_Item(&v) } {
                Ok(t)  => t,
                Err(_) => continue,
            };
            let name           = unsafe { rt.Name().map(|s| s.to_string()).unwrap_or_default() };
            let path           = unsafe { rt.Path().map(|s| s.to_string()).unwrap_or_default() };
            let current_action = unsafe { rt.CurrentAction().map(|s| s.to_string()).unwrap_or_default() };
            let state_val      = unsafe { rt.State().unwrap_or_default() };
            let (state, _) = task_state_str(state_val);
            out.push(RunningTaskInfo { name, path, current_action, state });
        }
        Ok(out)
    }

    // ── Task run history (scheduled run times in a 90-day window) ─────────────
    pub fn get_task_history(&self, task_path: &str, max_records: u32) -> Result<Vec<TaskRunRecord>> {
        let (fp, tn) = split_path(task_path);
        let folder = match unsafe { self.service.GetFolder(&BSTR::from(fp)) } {
            Ok(f)  => f,
            Err(_) => return Ok(vec![]),
        };
        let task = match unsafe { folder.GetTask(&BSTR::from(tn)) } {
            Ok(t)  => t,
            Err(_) => return Ok(vec![]),
        };

        // Build a 90-day FORWARD window: start = now, end = now + 3 months.
        // GetRunTimes returns future scheduled run times — matching the JS
        // label "Scheduled runs (next 90 days)".
        // GOTCHA: Using (now-90days, now) would return past scheduled times,
        //         not future ones — the wrong direction for a "next runs" view.
        let start_st = unsafe { GetSystemTime() };

        let mut end_st = start_st;
        // Add 3 months (~90 days). wMonth is u16, values 1-12.
        if end_st.wMonth > 9 {
            end_st.wMonth -= 9;   // 10→1, 11→2, 12→3
            end_st.wYear  += 1;
        } else {
            end_st.wMonth += 3;   // 1→4, 2→5, ..., 9→12
        }
        // MED-1 FIX: clamp wDay to the last valid day of the target month so we
        // never produce an invalid SYSTEMTIME (e.g. April 31, February 30).
        // GetRunTimes rejects invalid dates and silently returns 0 results.
        {
            let max_day: u16 = match end_st.wMonth {
                4 | 6 | 9 | 11 => 30,
                2 => {
                    let y = end_st.wYear;
                    if y % 4 == 0 && (y % 100 != 0 || y % 400 == 0) { 29 } else { 28 }
                }
                _ => 31,
            };
            if end_st.wDay > max_day { end_st.wDay = max_day; }
        }

        let limit = max_records.min(100);
        let mut count: u32 = limit;
        let mut times: *mut SYSTEMTIME = std::ptr::null_mut();

        let ok = unsafe { task.GetRunTimes(&start_st, &end_st, &mut count, &mut times) };
        // Free the buffer the COM server may have allocated, regardless of error or count.
        // CoTaskMemFree is a no-op on null, but we guard anyway for clarity.
        if ok.is_err() {
            if !times.is_null() {
                unsafe { CoTaskMemFree(Some(times as *mut _)); }
            }
            return Ok(vec![]); // graceful fallback (history may be disabled)
        }

        if times.is_null() || count == 0 {
            if !times.is_null() {
                unsafe { CoTaskMemFree(Some(times as *mut _)); }
            }
            return Ok(vec![]);
        }

        let mut records = Vec::new();
        for i in 0..(count as usize) {
            let st = unsafe { &*times.add(i) };
            records.push(TaskRunRecord {
                start_time:    systemtime_to_str(st),
                end_time:      String::new(),
                result_code:   0,
                result_text:   "Scheduled run".to_string(),
                duration_secs: 0.0,
            });
        }

        // SAFETY: `times` was allocated by the Task Scheduler COM server via
        // CoTaskMemAlloc (as documented for GetRunTimes), so CoTaskMemFree is
        // the correct way to release it.
        unsafe { CoTaskMemFree(Some(times as *mut _)); }

        Ok(records)
    }

    // ── Folder management ─────────────────────────────────────────────────────
    pub fn create_folder(&self, path: &str) -> Result<()> {
        // path should be absolute like \Folder or \Parent\Sub
        let (parent_path, folder_name) = split_path(path);
        let parent = unsafe { self.service.GetFolder(&BSTR::from(parent_path))? };
        let v = VARIANT::default();
        unsafe { parent.CreateFolder(&BSTR::from(folder_name), &v)? };
        Ok(())
    }

    pub fn delete_folder(&self, path: &str) -> Result<()> {
        let (parent_path, folder_name) = split_path(path);
        let parent = unsafe { self.service.GetFolder(&BSTR::from(parent_path))? };
        unsafe { parent.DeleteFolder(&BSTR::from(folder_name), 0)? };
        Ok(())
    }
}

// ── Utility ───────────────────────────────────────────────────────────────────
fn split_path(path: &str) -> (&str, &str) {
    match path.rfind('\\') {
        Some(i) if i > 0 => (&path[..i], &path[i + 1..]),
        _                 => ("\\", path.trim_start_matches('\\')),
    }
}

#[cfg(test)]
mod tests {
    use super::split_path;

    #[test]
    fn test_split_path_nested() {
        assert_eq!(split_path("\\Folder\\Task"), ("\\Folder", "Task"));
    }

    #[test]
    fn test_split_path_root_task() {
        // Root-level task: \TaskName → ("\\", "TaskName")
        assert_eq!(split_path("\\TaskName"), ("\\", "TaskName"));
    }

    #[test]
    fn test_split_path_deeply_nested() {
        assert_eq!(split_path("\\A\\B\\Task"), ("\\A\\B", "Task"));
    }

    #[test]
    fn test_split_path_no_prefix() {
        // Task name without leading backslash — treated as root-level
        assert_eq!(split_path("TaskName"), ("\\", "TaskName"));
    }
}