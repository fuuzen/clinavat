use std::collections::HashMap;
use std::fs::{File, OpenOptions};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use rand::rngs::OsRng;
use rand::RngCore;

use crate::ops::fs_common::WriteCondition;
use crate::ops::{RpcCallError, RpcErrorCode};
use crate::path_guard::is_symlink_or_reparse;

/// Aligned with Hub `CLINAVAT_UPLOAD_LIMIT_MB = 1024`.
pub const MAX_STAGED_FILE_BYTES: u64 = 1024 * 1024 * 1024;
pub const MAX_TOTAL_STAGED_BYTES: u64 = 2 * 1024 * 1024 * 1024;
pub const MAX_STAGED_ENTRIES: usize = 64;
const DEFAULT_STAGED_IDLE_TTL_SECS: u64 = 15 * 60;
const MAX_DIFF_PREVIEW_BYTES: usize = 64 * 1024;
const STAGE_PREFIX: &str = "clinavat-stage-";

/// Tracks one active multi-chunk upload using its already-open FD (`H1`), never reopening by path.
#[derive(Debug)]
pub struct StagedWrite {
    pub temp_path: PathBuf,
    pub file: File,
    pub received: u64,
    pub total_size: Option<u64>,
    pub condition: WriteCondition,
    pub create_dirs: bool,
    pub last_updated: Instant,
}

/// Per-connection private staging store keyed by `(canonical_root, rel_path)` with TTL & disconnect cleanup.
pub struct WriteStagingStore {
    base_dir: Option<PathBuf>,
    active_dir: Mutex<Option<PathBuf>>,
    entries: Mutex<HashMap<(PathBuf, String), StagedWrite>>,
    idle_ttl: Duration,
}

impl WriteStagingStore {
    pub fn new(state_dir: Option<PathBuf>) -> Self {
        let ttl_secs = std::env::var("CLINAVAT_STAGE_TTL_SECS")
            .ok()
            .and_then(|v| v.parse::<u64>().ok())
            .filter(|&n| n > 0)
            .unwrap_or(DEFAULT_STAGED_IDLE_TTL_SECS);
        let base_dir = state_dir.map(|d| d.join("staging"));
        // Sweep orphaned staging directories left behind by previously crashed PIDs on startup (L-c).
        if let Some(ref dir) = base_dir {
            sweep_dead_staging_dirs(dir);
        }
        Self {
            base_dir,
            active_dir: Mutex::new(None),
            entries: Mutex::new(HashMap::new()),
            idle_ttl: Duration::from_secs(ttl_secs),
        }
    }

    fn resolve_parent_dir(&self) -> Result<PathBuf, RpcCallError> {
        if let Some(dir) = &self.base_dir {
            ensure_private_parent(dir)?;
            return Ok(dir.clone());
        }
        if let Some(dir) = dirs::data_local_dir()
            .or_else(dirs::config_dir)
            .map(|d| d.join("clinavat").join("daemon").join("staging"))
        {
            ensure_private_parent(&dir)?;
            return Ok(dir);
        }
        Ok(std::env::temp_dir())
    }

    /// Returns a verified private per-session staging directory (`0700`, owned by current UID, non-symlink).
    pub fn staging_dir(&self) -> Result<PathBuf, RpcCallError> {
        let mut guard = self.active_dir.lock()
            .map_err(|_| RpcCallError::new(RpcErrorCode::InternalError, "staging dir lock poisoned"))?;
        if let Some(existing) = guard.as_ref() {
            if verify_private_dir(existing).is_ok() {
                return Ok(existing.clone());
            }
            *guard = None;
        }
        let parent = self.resolve_parent_dir()?;
        sweep_dead_staging_dirs(&parent);
        for _ in 0..8 {
            let name = format!("{STAGE_PREFIX}{}-{}", std::process::id(), random_128bit_hex());
            let candidate = parent.join(name);
            match create_private_dir_non_recursive(&candidate) {
                Ok(()) => {
                    // Explicitly apply 0700 before verification so restrictive umasks (e.g. 0277) never break staging (L-d).
                    #[cfg(unix)]
                    {
                        use std::os::unix::fs::PermissionsExt;
                        let meta = std::fs::symlink_metadata(&candidate)?;
                        if is_symlink_or_reparse(&candidate, &meta) || !meta.is_dir() {
                            return Err(RpcCallError::new(RpcErrorCode::Eacces, "staging directory is invalid"));
                        }
                        std::fs::set_permissions(&candidate, std::fs::Permissions::from_mode(0o700))?;
                    }
                    verify_private_dir(&candidate)?;
                    *guard = Some(candidate.clone());
                    return Ok(candidate);
                }
                Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(err) => return Err(RpcCallError::from(err)),
            }
        }
        Err(RpcCallError::new(RpcErrorCode::InternalError, "failed to allocate private staging directory"))
    }

    /// Creates a new staging file inside the verified private directory and returns `(path, open_rw_file)`.
    pub fn create_staged_file(&self) -> Result<(PathBuf, File), RpcCallError> {
        let dir = self.staging_dir()?;
        for _ in 0..16 {
            let candidate = dir.join(format!(".stage.{}.tmp", random_128bit_hex()));
            let mut opts = OpenOptions::new();
            opts.read(true).write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                opts.mode(0o600).custom_flags(libc::O_NOFOLLOW);
            }
            match opts.open(&candidate) {
                Ok(file) => {
                    #[cfg(unix)]
                    {
                        use std::os::unix::fs::PermissionsExt;
                        let _ = file.set_permissions(std::fs::Permissions::from_mode(0o600));
                    }
                    return Ok((candidate, file));
                }
                Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(err) => return Err(RpcCallError::from(err)),
            }
        }
        Err(RpcCallError::new(RpcErrorCode::InternalError, "failed to allocate staging file"))
    }

    pub fn insert(&self, key: (PathBuf, String), mut entry: StagedWrite) -> Result<(), RpcCallError> {
        let mut guard = self.entries.lock()
            .map_err(|_| RpcCallError::new(RpcErrorCode::InternalError, "staging lock poisoned"))?;
        sweep_expired_locked(&mut guard, self.idle_ttl);
        if let Some(old) = guard.remove(&key) { discard_staged(old); }
        let total: u64 = guard.values().map(|e| e.received).sum::<u64>().saturating_add(entry.received);
        if guard.len() >= MAX_STAGED_ENTRIES || total > MAX_TOTAL_STAGED_BYTES {
            discard_staged(entry);
            return Err(RpcCallError::invalid("staged write quota exceeded"));
        }
        entry.last_updated = Instant::now();
        guard.insert(key, entry);
        Ok(())
    }

    pub fn take(&self, key: &(PathBuf, String)) -> Result<Option<StagedWrite>, RpcCallError> {
        let mut guard = self.entries.lock()
            .map_err(|_| RpcCallError::new(RpcErrorCode::InternalError, "staging lock poisoned"))?;
        sweep_expired_locked(&mut guard, self.idle_ttl);
        Ok(guard.remove(key))
    }

    pub fn cleanup_all(&self) {
        if let Ok(mut guard) = self.entries.lock() {
            for (_, entry) in guard.drain() { discard_staged(entry); }
        }
        if let Ok(mut dir_guard) = self.active_dir.lock() {
            if let Some(dir) = dir_guard.take() { let _ = std::fs::remove_dir(&dir); }
        }
    }
}

impl Drop for WriteStagingStore {
    fn drop(&mut self) { self.cleanup_all(); }
}

pub fn discard_staged(entry: StagedWrite) {
    let path = entry.temp_path;
    drop(entry.file);
    let _ = std::fs::remove_file(&path);
}

fn sweep_expired_locked(map: &mut HashMap<(PathBuf, String), StagedWrite>, ttl: Duration) {
    let now = Instant::now();
    let expired_keys: Vec<(PathBuf, String)> = map
        .iter()
        .filter(|(_, entry)| now.duration_since(entry.last_updated) >= ttl)
        .map(|(k, _)| k.clone())
        .collect();
    for key in expired_keys {
        if let Some(entry) = map.remove(&key) { discard_staged(entry); }
    }
}

/// Removes residual `clinavat-stage-<pid>-*` directories owned by the current user whose PID no longer exists (`L-c`).
fn sweep_dead_staging_dirs(parent: &Path) {
    let Ok(rd) = std::fs::read_dir(parent) else { return };
    let self_pid = std::process::id();
    for entry in rd.flatten() {
        let Some(name) = entry.file_name().to_str().map(str::to_string) else { continue };
        let Some(rest) = name.strip_prefix(STAGE_PREFIX) else { continue };
        let Some((pid_str, _)) = rest.split_once('-') else { continue };
        let Ok(pid) = pid_str.parse::<u32>() else { continue };
        if pid == 0 || pid == self_pid { continue; }
        let path = entry.path();
        let Ok(meta) = std::fs::symlink_metadata(&path) else { continue };
        if is_symlink_or_reparse(&path, &meta) || !meta.is_dir() { continue; }
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            if meta.uid() != unsafe { libc::geteuid() } { continue; }
        }
        if is_pid_dead(pid) {
            let _ = std::fs::remove_dir_all(&path);
        }
    }
}

fn is_pid_dead(pid: u32) -> bool {
    #[cfg(unix)]
    {
        let rc = unsafe { libc::kill(pid as libc::pid_t, 0) };
        rc == -1 && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
    }
    #[cfg(windows)]
    {
        #[link(name = "kernel32")]
        extern "system" {
            fn OpenProcess(access: u32, inherit: i32, pid: u32) -> isize;
            fn CloseHandle(h: isize) -> i32;
            fn GetLastError() -> u32;
        }
        let h = unsafe { OpenProcess(0x1000, 0, pid) };
        if h != 0 {
            unsafe { CloseHandle(h); }
            return false;
        }
        unsafe { GetLastError() == 87 } // ERROR_INVALID_PARAMETER: process does not exist.
    }
}

fn random_128bit_hex() -> String {
    let mut bytes = [0u8; 16];
    OsRng.fill_bytes(&mut bytes);
    let mut out = String::with_capacity(32);
    for b in bytes {
        use std::fmt::Write;
        let _ = write!(&mut out, "{b:02x}");
    }
    out
}

fn ensure_private_parent(dir: &Path) -> Result<(), RpcCallError> {
    if !dir.exists() {
        if let Some(parent) = dir.parent() {
            if !parent.as_os_str().is_empty() && !parent.exists() {
                ensure_private_parent(parent)?;
            }
        }
        let _ = std::fs::create_dir(dir);
    }
    let meta = std::fs::symlink_metadata(dir)?;
    if is_symlink_or_reparse(dir, &meta) || !meta.is_dir() {
        return Err(RpcCallError::new(RpcErrorCode::Eacces, "staging parent directory is invalid"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

fn create_private_dir_non_recursive(dir: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        std::fs::DirBuilder::new().mode(0o700).create(dir)
    }
    #[cfg(not(unix))]
    {
        std::fs::DirBuilder::new().create(dir)
    }
}

fn verify_private_dir(dir: &Path) -> Result<(), RpcCallError> {
    let meta = std::fs::symlink_metadata(dir)?;
    if is_symlink_or_reparse(dir, &meta) || !meta.is_dir() {
        return Err(RpcCallError::new(RpcErrorCode::Eacces, "staging directory is not a real directory"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let euid = unsafe { libc::geteuid() };
        if meta.uid() != euid {
            return Err(RpcCallError::new(RpcErrorCode::Eacces, "staging directory owner mismatch"));
        }
        if (meta.mode() & 0o777) != 0o700 {
            return Err(RpcCallError::new(RpcErrorCode::Eacces, "staging directory permissions are not 0700"));
        }
    }
    Ok(())
}

/// Builds a compact unified-diff preview for one file (create, modify, or delete).
pub fn build_unified_diff(rel_path: &str, before: Option<&str>, after: Option<&str>) -> String {
    let old_lines: Vec<&str> = before.map(|s| s.lines().collect()).unwrap_or_default();
    let new_lines: Vec<&str> = after.map(|s| s.lines().collect()).unwrap_or_default();
    let mut prefix = 0usize;
    while prefix < old_lines.len() && prefix < new_lines.len() && old_lines[prefix] == new_lines[prefix] { prefix += 1; }
    let mut suffix = 0usize;
    while suffix < old_lines.len() - prefix && suffix < new_lines.len() - prefix
        && old_lines[old_lines.len() - 1 - suffix] == new_lines[new_lines.len() - 1 - suffix]
    {
        suffix += 1;
    }
    let ctx_start = prefix.saturating_sub(3);
    let old_end = (old_lines.len() - suffix + 3).min(old_lines.len());
    let new_end = (new_lines.len() - suffix + 3).min(new_lines.len());
    let old_count = old_end.saturating_sub(ctx_start);
    let new_count = new_end.saturating_sub(ctx_start);
    let old_start = if old_count == 0 { 0 } else { ctx_start + 1 };
    let new_start = if new_count == 0 { 0 } else { ctx_start + 1 };

    let mut out = Vec::with_capacity(old_count + new_count + 4);
    out.push(format!("--- {}", before.map_or_else(|| "/dev/null".to_string(), |_| format!("a/{rel_path}"))));
    out.push(format!("+++ {}", after.map_or_else(|| "/dev/null".to_string(), |_| format!("b/{rel_path}"))));
    out.push(format!("@@ -{old_start},{old_count} +{new_start},{new_count} @@"));
    for line in &old_lines[ctx_start..prefix] { out.push(format!(" {line}")); }
    for line in &old_lines[prefix..old_lines.len() - suffix] { out.push(format!("-{line}")); }
    for line in &new_lines[prefix..new_lines.len() - suffix] { out.push(format!("+{line}")); }
    for line in &new_lines[new_lines.len() - suffix..new_end] { out.push(format!(" {line}")); }
    let mut joined = out.join("\n");
    if joined.len() > MAX_DIFF_PREVIEW_BYTES {
        let mut end = MAX_DIFF_PREVIEW_BYTES;
        while !joined.is_char_boundary(end) { end -= 1; }
        joined.truncate(end);
        joined.push_str("\n... [diff preview truncated]");
    }
    joined
}
