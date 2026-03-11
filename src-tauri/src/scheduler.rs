#![cfg(windows)]
#![allow(non_snake_case)]
use serde::{Deserialize, Serialize};
use windows::{
    core::*,
    Win32::Foundation::{SYSTEMTIME, VARIANT_FALSE, VARIANT_TRUE},
    Win32::System::Com::*,
    Win32::System::SystemInformation::GetSystemTime,
    Win32::System::TaskScheduler::*,
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
        0      => "Success (0)".into(),
        267009 => "Still Running".into(),
        267011 => "Not Run Yet".into(),
        _      => format!("Error (0x{:08X})", code as u32),
    }
}

fn ole_date(d: f64) -> String {
    if d < 1.0 { return "Never".into(); }
    let secs = ((d - 25569.0) * 86400.0).round() as i64;
    if secs < 0 { return "Never".into(); }
    let s   = (secs % 60) as u32;
    let m   = ((secs / 60) % 60) as u32;
    let h   = ((secs / 3600) % 24) as u32;
    let (y, mo, day) = days_to_ymd(secs / 86400);
    format!("{:04}-{:02}-{:02} {:02}:{:02}:{:02}", y, mo, day, h, m, s)
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

            let service: ITaskService =
                CoCreateInstance(&TaskScheduler, None, CLSCTX_INPROC_SERVER)?;

            let v = VARIANT::default();
            service.Connect(&v, &v, &v, &v)?;

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
        let tasks  = unsafe { folder.GetTasks(0)? };
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
        if p.name.chars().any(|c| matches!(c, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|'))
            || p.name.trim().is_empty()
        {
            return Err(windows::core::Error::new(
                windows::core::HRESULT(0x80070057u32 as i32),
                "Task name contains invalid characters (cannot use \\ / : * ? \" < > |)",
            ));
        }

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
        let is_system_account = u_upper == "SYSTEM"
            || u_upper.starts_with("NT AUTHORITY\\")
            || u_upper.starts_with("NT SERVICE\\");

        let logon = if is_system_account {
            // Well-known service accounts (SYSTEM, NT AUTHORITY\*, NT SERVICE\*)
            TASK_LOGON_SERVICE_ACCOUNT
        } else if run_as.is_empty() {
            // No user specified → run as the current interactive user
            TASK_LOGON_INTERACTIVE_TOKEN
        } else {
            // A specific named user was provided → use S4U
            // (does NOT require SeTcbPrivilege unlike INTERACTIVE_TOKEN with a UserId)
            TASK_LOGON_S4U
        };

        let principal = unsafe { defn.Principal()? };
        let run_level = if p.run_level == 1 { TASK_RUNLEVEL_HIGHEST } else { TASK_RUNLEVEL_LUA };
        unsafe {
            principal.SetRunLevel(run_level)?;
            principal.SetLogonType(logon)?;
            if !run_as.is_empty() {
                principal.SetUserId(&BSTR::from(run_as))?;
            }
        }

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
        unsafe { trigger.SetEnabled(VARIANT_TRUE)? };

        let time_based = matches!(
            ttype,
            TASK_TRIGGER_TIME | TASK_TRIGGER_DAILY | TASK_TRIGGER_WEEKLY | TASK_TRIGGER_MONTHLY
        );
        if time_based && !p.start_datetime.is_empty() {
            unsafe { trigger.SetStartBoundary(&BSTR::from(p.start_datetime.as_str()))? };
        }

        // End boundary (optional — applies to all trigger types)
        if !p.end_boundary.is_empty() {
            unsafe { let _ = trigger.SetEndBoundary(&BSTR::from(p.end_boundary.as_str())); }
        }

        // Repetition pattern (applies to all trigger types when interval is set)
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

        // Daily trigger
        if ttype == TASK_TRIGGER_DAILY {
            if let Ok(dt) = trigger.cast::<IDailyTrigger>() {
                unsafe { dt.SetDaysInterval(p.days_interval.max(1) as i16)? };
                if !p.random_delay.is_empty() {
                    unsafe { let _ = dt.SetRandomDelay(&BSTR::from(p.random_delay.as_str())); }
                }
            }
        }

        // Once (time) trigger random delay
        if ttype == TASK_TRIGGER_TIME && !p.random_delay.is_empty() {
            if let Ok(tt) = trigger.cast::<ITimeTrigger>() {
                unsafe { let _ = tt.SetRandomDelay(&BSTR::from(p.random_delay.as_str())); }
            }
        }

        // Weekly trigger
        if ttype == TASK_TRIGGER_WEEKLY {
            if let Ok(wt) = trigger.cast::<IWeeklyTrigger>() {
                let wi = if p.weeks_interval > 0 { p.weeks_interval } else { p.days_interval.max(1) };
                unsafe { wt.SetWeeksInterval(wi as i16)? };
                if p.days_of_week > 0 {
                    unsafe { let _ = wt.SetDaysOfWeek(p.days_of_week as i16); }
                }
                if !p.random_delay.is_empty() {
                    unsafe { let _ = wt.SetRandomDelay(&BSTR::from(p.random_delay.as_str())); }
                }
            }
        }

        // Monthly trigger
        if ttype == TASK_TRIGGER_MONTHLY {
            if let Ok(mt) = trigger.cast::<IMonthlyTrigger>() {
                if p.days_of_month > 0 {
                    unsafe { let _ = mt.SetDaysOfMonth(p.days_of_month as i32); }
                } else {
                    // Convert 1-based day number to bitmask (bit 0 = day 1)
                    let day_bit = 1i32 << ((p.days_interval.max(1).min(31) - 1) as i32);
                    unsafe { let _ = mt.SetDaysOfMonth(day_bit); }
                }
                if p.months_of_year > 0 {
                    unsafe { let _ = mt.SetMonthsOfYear(p.months_of_year as i16); }
                }
                if !p.random_delay.is_empty() {
                    unsafe { let _ = mt.SetRandomDelay(&BSTR::from(p.random_delay.as_str())); }
                }
            }
        }

        // Boot trigger delay
        if ttype == TASK_TRIGGER_BOOT && !p.delay.is_empty() {
            if let Ok(bt) = trigger.cast::<IBootTrigger>() {
                unsafe { let _ = bt.SetDelay(&BSTR::from(p.delay.as_str())); }
            }
        }

        // Logon trigger delay
        if ttype == TASK_TRIGGER_LOGON && !p.delay.is_empty() {
            if let Ok(lt) = trigger.cast::<ILogonTrigger>() {
                unsafe { let _ = lt.SetDelay(&BSTR::from(p.delay.as_str())); }
            }
        }

        // Session state change trigger
        if ttype == TASK_TRIGGER_SESSION_STATE_CHANGE {
            if let Ok(sst) = trigger.cast::<ISessionStateChangeTrigger>() {
                let ct = if p.trigger_type == "SessionUnlock" { TASK_SESSION_UNLOCK } else { TASK_SESSION_LOCK };
                unsafe { sst.SetStateChange(ct)? };
                if !p.delay.is_empty() {
                    unsafe { let _ = sst.SetDelay(&BSTR::from(p.delay.as_str())); }
                }
            }
        }

        let act_col = unsafe { defn.Actions()? };
        let action  = unsafe { act_col.Create(TASK_ACTION_EXEC)? };
        let exec: IExecAction = action.cast()?;

        // If env_vars are set, wrap the command in cmd.exe with SET statements.
        // Each KEY=VALUE pair is escaped so that cmd.exe special characters in
        // the value portion (& | < > ^ ( ) ") cannot break out of the SET command.
        if !p.env_vars.is_empty() {
            fn escape_cmd_value(s: &str) -> String {
                s.chars().map(|c| match c {
                    '&' | '|' | '<' | '>' | '^' | '(' | ')' | '"' => format!("^{c}"),
                    _ => c.to_string(),
                }).collect()
            }

            let env_sets: String = p.env_vars.lines()
                .filter_map(|l| {
                    let l = l.trim();
                    // Only accept lines of the form KEY=VALUE where KEY is alphanumeric/underscore
                    let eq = l.find('=')?;
                    let key = &l[..eq];
                    let val = &l[eq + 1..];
                    if key.chars().all(|c| c.is_alphanumeric() || c == '_') {
                        Some(format!("SET {}={} && ", key, escape_cmd_value(val)))
                    } else {
                        None // skip keys with invalid characters
                    }
                })
                .collect();

            let wrapped_args = format!("/c \"{}{}{}\"",
                env_sets,
                p.program_path,
                if p.arguments.is_empty() { String::new() } else { format!(" {}", p.arguments) }
            );
            unsafe {
                exec.SetPath(&BSTR::from("C:\\Windows\\System32\\cmd.exe"))?;
                exec.SetArguments(&BSTR::from(wrapped_args.as_str()))?;
                exec.SetWorkingDirectory(&BSTR::from(p.working_dir.as_str()))?;
            }
        } else {
            unsafe {
                exec.SetPath(&BSTR::from(p.program_path.as_str()))?;
                exec.SetArguments(&BSTR::from(p.arguments.as_str()))?;
                exec.SetWorkingDirectory(&BSTR::from(p.working_dir.as_str()))?;
            }
        }

        // Normalise folder_path: treat empty or root as "\\"
        let folder_path = {
            let fp = p.folder_path.trim();
            if fp.is_empty() { "\\".to_string() } else { fp.to_string() }
        };
        let folder = unsafe { self.service.GetFolder(&BSTR::from(folder_path.as_str()))? };
        let empty_v = VARIANT::default();

        // For service accounts, pass the account name in the userId VARIANT so
        // Windows Task Scheduler knows which service account to use.
        // Note: is_system_account is only true when run_as is non-empty (SYSTEM/NT AUTHORITY/NT SERVICE).
        let user_v = if is_system_account {
            windows::core::VARIANT::from(BSTR::from(run_as))
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

    // ── Update (delete + recreate) ────────────────────────────────────────────
    pub fn update_task(&self, task_path: &str, p: &CreateTaskParams) -> Result<()> {
        // Best-effort delete of the old task. Ignore errors (task may have been renamed
        // or already removed). create_task uses TASK_CREATE_OR_UPDATE so it will overwrite
        // any existing task with the same name.
        let _ = self.delete_task(task_path);
        self.create_task(p)
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

        // Build a 90-day window: start = 90 days ago (simplified via month math),
        // end = very far future so we capture all recent scheduled runs.
        let end_st = unsafe { GetSystemTime() };

        let mut start_st = end_st;
        // Subtract ~3 months (approximation of 90 days)
        if start_st.wMonth <= 3 {
            start_st.wYear  = start_st.wYear.saturating_sub(1);
            start_st.wMonth = start_st.wMonth + 9; // wrap around
        } else {
            start_st.wMonth -= 3;
        }

        let limit = max_records.min(100);
        let mut count: u32 = limit;
        let mut times: *mut SYSTEMTIME = std::ptr::null_mut();

        let ok = unsafe { task.GetRunTimes(&start_st, &end_st, &mut count, &mut times) };
        if ok.is_err() || times.is_null() || count == 0 {
            return Ok(vec![]); // graceful fallback (history may be disabled)
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