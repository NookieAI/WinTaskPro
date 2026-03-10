#![allow(non_snake_case)]
use serde::{Deserialize, Serialize};
use windows::{
    core::*,
    Win32::Foundation::{VARIANT_FALSE, VARIANT_TRUE},
    Win32::System::Com::*,
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
    let unix     = (d - 25569.0) * 86400.0;
    let unix_i   = unix as i64;
    let s  = ((unix_i % 60) + 60) % 60;
    let m  = ((unix_i / 60) % 60 + 60) % 60;
    let h  = ((unix_i / 3600) % 24 + 24) % 24;
    let (y, mo, day) = days_to_ymd(unix_i / 86400);
    format!("{:04}-{:02}-{:02}  {:02}:{:02}:{:02}", y, mo, day, h, m, s)
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
}

// ── Engine ────────────────────────────────────────────────────────────────────
pub struct SchedulerEngine {
    service: ITaskService,
}

// SAFETY: we only ever call this from behind a Mutex
unsafe impl Send for SchedulerEngine {}
unsafe impl Sync for SchedulerEngine {}

impl SchedulerEngine {
    pub fn new() -> Result<Self> {
        unsafe {
            // Use APARTMENTTHREADED to match Tauri/tao's COM mode
            // Ignore RPC_E_CHANGED_MODE — means COM already initialized, which is fine
            let hr = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
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

            Ok(SchedulerEngine { service })
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

        // Triggers
        let trig_col = unsafe { defn.Triggers()? };
        let tcnt     = unsafe { read_i32(|p| trig_col.Count(p)) };
        let mut triggers = Vec::new();
        for j in 1..=tcnt {
            if let Ok(t) = unsafe { trig_col.get_Item(j) } {
                let mut ttype = TASK_TRIGGER_TYPE2::default();
                unsafe { let _ = t.Type(&mut ttype); }
                triggers.push(trigger_str(ttype));
            }
        }

        // Actions
        let act_col = unsafe { defn.Actions()? };
        let acnt    = unsafe { read_i32(|p| act_col.Count(p)) };
        let mut actions = Vec::new();
        for j in 1..=acnt {
            if let Ok(act) = unsafe { act_col.get_Item(j) } {
                if let Ok(exec) = act.cast::<IExecAction>() {
                    let p = unsafe { read_bstr(|b| exec.Path(b)) };
                    let a = unsafe { read_bstr(|b| exec.Arguments(b)) };
                    actions.push(if a.is_empty() { p } else { format!("{} {}", p, a) });
                }
            }
        }

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
        let defn: ITaskDefinition = unsafe { self.service.NewTask(0)? };

        let reg = unsafe { defn.RegistrationInfo()? };
        unsafe {
            reg.SetDescription(&BSTR::from(p.description.as_str()))?;
            reg.SetAuthor(&BSTR::from(p.author.as_str()))?;
        }

        let settings = unsafe { defn.Settings()? };
        unsafe {
            settings.SetEnabled(vb(p.enabled))?;
            settings.SetHidden(vb(p.hidden))?;
            settings.SetStartWhenAvailable(VARIANT_TRUE)?;
            settings.SetMultipleInstances(TASK_INSTANCES_STOP_EXISTING)?;
            settings.SetExecutionTimeLimit(&BSTR::from("PT0S"))?;
        }

        let principal = unsafe { defn.Principal()? };
        let run_level = if p.run_level == 1 { TASK_RUNLEVEL_HIGHEST } else { TASK_RUNLEVEL_LUA };
        unsafe {
            principal.SetRunLevel(run_level)?;
            if !p.run_as_user.is_empty() {
                principal.SetUserId(&BSTR::from(p.run_as_user.as_str()))?;
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
        if ttype == TASK_TRIGGER_DAILY {
            if let Ok(dt) = trigger.cast::<IDailyTrigger>() {
                unsafe { dt.SetDaysInterval(p.days_interval.max(1) as i16)? };
            }
        }
        if ttype == TASK_TRIGGER_SESSION_STATE_CHANGE {
            if let Ok(sst) = trigger.cast::<ISessionStateChangeTrigger>() {
                let ct = if p.trigger_type == "SessionUnlock" { TASK_SESSION_UNLOCK } else { TASK_SESSION_LOCK };
                unsafe { sst.SetStateChange(ct)? };
            }
        }

        let act_col = unsafe { defn.Actions()? };
        let action  = unsafe { act_col.Create(TASK_ACTION_EXEC)? };
        let exec: IExecAction = action.cast()?;
        unsafe {
            exec.SetPath(&BSTR::from(p.program_path.as_str()))?;
            exec.SetArguments(&BSTR::from(p.arguments.as_str()))?;
            exec.SetWorkingDirectory(&BSTR::from(p.working_dir.as_str()))?;
        }

        let folder = unsafe { self.service.GetFolder(&BSTR::from(p.folder_path.as_str()))? };
        let logon  = if p.run_as_user.is_empty() { TASK_LOGON_INTERACTIVE_TOKEN } else { TASK_LOGON_S4U };
        let v = VARIANT::default();
        unsafe {
            folder.RegisterTaskDefinition(
                &BSTR::from(p.name.as_str()),
                &defn,
                TASK_CREATE_OR_UPDATE.0,
                &v, &v,
                logon,
                &v,
            )?;
        }
        Ok(())
    }
}

// ── Utility ─────────────────────���─────────────────────────────────────────────
fn split_path(path: &str) -> (&str, &str) {
    match path.rfind('\\') {
        Some(i) if i > 0 => (&path[..i], &path[i + 1..]),
        _                 => ("\\", path.trim_start_matches('\\')),
    }
}