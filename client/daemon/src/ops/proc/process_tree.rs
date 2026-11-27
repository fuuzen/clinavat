use std::process::ExitStatus;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::process::{Child, Command};
use tokio::sync::Notify;

#[cfg(windows)]
#[repr(C)]
struct JobBasicLimitInfo {
    _time: [i64; 2],
    limit_flags: u32,
    _working_set: [usize; 2],
    _active_limit: u32,
    _affinity: usize,
    _priority: u32,
    _scheduling: u32,
}

#[cfg(windows)]
#[repr(C)]
struct JobExtendedLimitInfo {
    basic: JobBasicLimitInfo,
    _io_counters: [u64; 6],
    _memory_limits: [usize; 4],
}

#[cfg(windows)]
#[link(name = "kernel32")]
extern "system" {
    fn CreateJobObjectW(attrs: *const u8, name: *const u16) -> isize;
    fn SetInformationJobObject(job: isize, class: u32, info: *const u8, len: u32) -> i32;
    fn AssignProcessToJobObject(job: isize, process: isize) -> i32;
    fn TerminateJobObject(job: isize, exit_code: u32) -> i32;
    fn CloseHandle(handle: isize) -> i32;
}

#[cfg(windows)]
struct WinJobHandle(isize);

#[cfg(windows)]
impl Drop for WinJobHandle {
    fn drop(&mut self) {
        if self.0 != 0 {
            unsafe { CloseHandle(self.0); }
            self.0 = 0;
        }
    }
}

enum LifecycleState {
    Running {
        child: Child,
        #[cfg(unix)]
        pgid: i32,
        #[cfg(windows)]
        job: Option<WinJobHandle>,
        terminating: bool,
    },
    Reaped(Option<ExitStatus>),
}

/// Synchronizes child reaping (`try_wait`) and process-tree termination (`killpg` / Job Object)
/// under one mutex so `killpg` can NEVER fire on a recycled PGID after the leader is reaped (`H3`).
pub struct ProcessTree {
    pid: u32,
    state: Mutex<LifecycleState>,
    reaped_notify: Notify,
}

impl ProcessTree {
    pub fn configure_command(cmd: &mut Command) {
        #[cfg(unix)]
        { cmd.process_group(0); }
        #[cfg(windows)]
        { cmd.creation_flags(0x0800_0000); } // CREATE_NO_WINDOW
    }

    pub fn from_child(child: Child) -> Arc<Self> {
        let pid = child.id().unwrap_or(0);
        #[cfg(unix)]
        let state = LifecycleState::Running { child, pgid: pid as i32, terminating: false };
        #[cfg(windows)]
        let state = {
            let job = child.raw_handle().and_then(|raw| create_and_assign_job(raw as isize));
            LifecycleState::Running { child, job, terminating: false }
        };
        Arc::new(Self { pid, state: Mutex::new(state), reaped_notify: Notify::new() })
    }

    pub fn pid(&self) -> u32 {
        self.pid
    }

    /// Checks whether the child has exited under the lifecycle lock, transitioning to `Reaped` atomically.
    pub fn poll_reap(&self) -> std::io::Result<Option<ExitStatus>> {
        let mut guard = self.state.lock().unwrap_or_else(|e| e.into_inner());
        match &mut *guard {
            LifecycleState::Reaped(status) => Ok(*status),
            LifecycleState::Running { child, .. } => match child.try_wait()? {
                Some(status) => {
                    *guard = LifecycleState::Reaped(Some(status));
                    self.reaped_notify.notify_waiters();
                    Ok(Some(status))
                }
                None => Ok(None),
            },
        }
    }

    /// Awaits child exit while keeping `try_wait` synchronized with `terminate` (`H3`).
    pub async fn wait(&self) -> std::io::Result<ExitStatus> {
        #[cfg(unix)]
        let mut sigchld = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::child()).ok();
        loop {
            if let Some(status) = self.poll_reap()? {
                return Ok(status);
            }
            let notified = self.reaped_notify.notified();
            #[cfg(unix)]
            {
                tokio::select! {
                    _ = notified => {}
                    _ = async {
                        if let Some(ref mut s) = sigchld { let _ = s.recv().await; }
                        else { std::future::pending::<()>().await; }
                    } => {}
                    _ = tokio::time::sleep(Duration::from_millis(25)) => {}
                }
            }
            #[cfg(not(unix))]
            {
                tokio::select! {
                    _ = notified => {}
                    _ = tokio::time::sleep(Duration::from_millis(20)) => {}
                }
            }
        }
    }

    /// Terminates the process tree only while the leader is still un-reaped; strict no-op once `Reaped` (`H3`).
    pub fn terminate(self: &Arc<Self>) {
        let should_escalate = {
            let mut guard = self.state.lock().unwrap_or_else(|e| e.into_inner());
            match &mut *guard {
                LifecycleState::Reaped(_) => return,
                LifecycleState::Running {
                    child,
                    #[cfg(unix)]
                    pgid,
                    #[cfg(windows)]
                    job,
                    terminating,
                } => {
                    // Re-check exit before signaling so a dead leader never receives killpg.
                    if let Ok(Some(status)) = child.try_wait() {
                        *guard = LifecycleState::Reaped(Some(status));
                        self.reaped_notify.notify_waiters();
                        return;
                    }
                    if *terminating { return; }
                    *terminating = true;
                    #[cfg(unix)]
                    {
                        if *pgid > 0 {
                            unsafe { libc::killpg(*pgid, libc::SIGTERM); }
                        }
                        true
                    }
                    #[cfg(windows)]
                    {
                        if let Some(handle) = job.take() {
                            if handle.0 != 0 {
                                unsafe { TerminateJobObject(handle.0, 1); }
                            }
                            drop(handle); // Close job handle once.
                        }
                        let _ = child.start_kill();
                        true
                    }
                }
            }
        };

        if should_escalate {
            let tree = Arc::clone(self);
            if let Ok(handle) = tokio::runtime::Handle::try_current() {
                handle.spawn(async move { tree.escalate_and_reap().await; });
            } else {
                std::thread::spawn(move || { tree.escalate_and_reap_blocking(); });
            }
        }
    }

    async fn escalate_and_reap(&self) {
        for _ in 0..10 {
            if self.poll_reap().ok().flatten().is_some() { return; }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        self.force_kill_if_running();
        for _ in 0..20 {
            if self.poll_reap().ok().flatten().is_some() { return; }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    }

    fn escalate_and_reap_blocking(&self) {
        for _ in 0..10 {
            if self.poll_reap().ok().flatten().is_some() { return; }
            std::thread::sleep(Duration::from_millis(25));
        }
        self.force_kill_if_running();
        for _ in 0..20 {
            if self.poll_reap().ok().flatten().is_some() { return; }
            std::thread::sleep(Duration::from_millis(25));
        }
    }

    fn force_kill_if_running(&self) {
        let mut guard = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if let LifecycleState::Running {
            child,
            #[cfg(unix)]
            pgid,
            ..
        } = &mut *guard
        {
            if let Ok(Some(status)) = child.try_wait() {
                *guard = LifecycleState::Reaped(Some(status));
                self.reaped_notify.notify_waiters();
                return;
            }
            #[cfg(unix)]
            if *pgid > 0 {
                unsafe { libc::killpg(*pgid, libc::SIGKILL); }
            }
            let _ = child.start_kill();
        }
    }
}

#[cfg(windows)]
fn create_and_assign_job(process_handle: isize) -> Option<WinJobHandle> {
    const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION: u32 = 9;
    const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: u32 = 0x0000_2000;

    let job = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
    if job == 0 { return None; }
    let handle = WinJobHandle(job);
    let mut info: JobExtendedLimitInfo = unsafe { std::mem::zeroed() };
    info.basic.limit_flags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    let ok = unsafe {
        SetInformationJobObject(
            handle.0, JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
            (&info as *const JobExtendedLimitInfo).cast(),
            std::mem::size_of::<JobExtendedLimitInfo>() as u32,
        )
    };
    if ok == 0 || unsafe { AssignProcessToJobObject(handle.0, process_handle) } == 0 {
        return None;
    }
    Some(handle)
}

/// Ensures a foreground command's process tree is terminated if its RPC future is cancelled/dropped.
pub struct RunningProcessGuard {
    tree: Option<Arc<ProcessTree>>,
}

impl RunningProcessGuard {
    pub fn new(tree: Arc<ProcessTree>) -> Self {
        Self { tree: Some(tree) }
    }

    pub fn disarm(&mut self) {
        self.tree = None;
    }
}

impl Drop for RunningProcessGuard {
    fn drop(&mut self) {
        if let Some(tree) = self.tree.take() {
            tree.terminate();
        }
    }
}
