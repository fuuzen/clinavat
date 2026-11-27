use std::fs::{File, Metadata, OpenOptions};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use rand::Rng;
use serde::Deserialize;

use crate::ops::{RpcCallError, RpcErrorCode};
use crate::path_guard::{is_symlink_or_reparse, verify_canonical_within, ClientPlatform};

#[derive(Debug, Clone, Default, Deserialize)]
pub struct WriteCondition {
    #[serde(rename = "createOnly", default)]
    pub create_only: bool,
    #[serde(rename = "expectedTag", default)]
    pub expected_tag: Option<String>,
}

impl WriteCondition {
    pub fn merge(&mut self, other: &WriteCondition) {
        if other.create_only { self.create_only = true; }
        if other.expected_tag.is_some() { self.expected_tag = other.expected_tag.clone(); }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct CommittedFileInfo {
    pub size: u64,
    pub mtime_ms: u64,
}

pub fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

pub fn mtime_ms(meta: &Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or_else(now_ms)
}

pub fn unix_mode(meta: &Metadata) -> u32 {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        meta.permissions().mode() & 0o7777
    }
    #[cfg(not(unix))]
    {
        if meta.permissions().readonly() { 0o444 } else { 0o644 }
    }
}

#[cfg(unix)]
static PROCESS_UMASK: std::sync::OnceLock<u32> = std::sync::OnceLock::new();

#[cfg(target_os = "linux")]
fn read_proc_umask() -> Option<u32> {
    let status = std::fs::read_to_string("/proc/self/status").ok()?;
    for line in status.lines() {
        if let Some(rest) = line.strip_prefix("Umask:") {
            return u32::from_str_radix(rest.trim(), 8).ok().map(|m| m & 0o777);
        }
    }
    None
}

#[cfg(unix)]
fn cached_umask() -> u32 {
    *PROCESS_UMASK.get_or_init(|| {
        #[cfg(target_os = "linux")]
        if let Some(mask) = read_proc_umask() {
            return mask;
        }
        unsafe {
            let cur = libc::umask(0o022);
            libc::umask(cur);
            (cur as u32) & 0o777
        }
    })
}

/// Captures and caches the process `umask` once (call before starting worker threads).
pub fn init_process_umask() {
    #[cfg(unix)]
    {
        let _ = cached_umask();
    }
}

/// Computes the default POSIX permission mode for newly created files respecting process `umask`.
#[cfg(unix)]
pub fn default_new_file_mode(executable: bool) -> u32 {
    let base = if executable { 0o777 } else { 0o666 };
    base & !cached_umask()
}

/// Returns true iff `a` and `b` both exist on disk and refer to the exact same underlying physical file (`H-new`).
pub fn same_physical_file(a: &Path, b: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let (Ok(ma), Ok(mb)) = (std::fs::symlink_metadata(a), std::fs::symlink_metadata(b)) else {
            return false;
        };
        ma.dev() == mb.dev() && ma.ino() == mb.ino()
    }
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        #[repr(C)]
        struct ByHandleFileInfo {
            attrs: u32, c: [u32; 2], a: [u32; 2], w: [u32; 2],
            vol_serial: u32, sz_hi: u32, sz_lo: u32, links: u32, idx_hi: u32, idx_lo: u32,
        }
        #[link(name = "kernel32")]
        extern "system" {
            fn CreateFileW(n: *const u16, a: u32, s: u32, sec: *const u8, d: u32, f: u32, t: isize) -> isize;
            fn GetFileInformationByHandle(h: isize, info: *mut ByHandleFileInfo) -> i32;
            fn CloseHandle(h: isize) -> i32;
        }
        let file_id = |p: &Path| -> Option<(u32, u32, u32)> {
            let mut wide: Vec<u16> = p.as_os_str().encode_wide().collect();
            wide.push(0);
            let h = unsafe { CreateFileW(wide.as_ptr(), 0x80, 7, std::ptr::null(), 3, 0x0220_0000, 0) };
            if h == -1 { return None; }
            let mut info: ByHandleFileInfo = unsafe { std::mem::zeroed() };
            let ok = unsafe { GetFileInformationByHandle(h, &mut info) };
            unsafe { CloseHandle(h); }
            (ok != 0).then_some((info.vol_serial, info.idx_hi, info.idx_lo))
        };
        match (file_id(a), file_id(b)) {
            (Some(ia), Some(ib)) => ia == ib,
            _ => false,
        }
    }
}

pub fn to_base36(mut value: u64) -> String {
    const DIGITS: &[u8; 36] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    if value == 0 { return "0".to_string(); }
    let mut buf = Vec::with_capacity(13);
    while value > 0 {
        buf.push(DIGITS[(value % 36) as usize]);
        value /= 36;
    }
    buf.reverse();
    String::from_utf8(buf).unwrap_or_else(|_| "0".to_string())
}

/// Computes optimistic-concurrency tag matching `backend/src/runtime/file-transfers.ts::fileTag`.
pub fn file_tag(size: u64, mtime: u64) -> String {
    format!("\"{}-{}\"", to_base36(size), to_base36(mtime))
}

/// Opens an existing regular file without following symlinks and without blocking on FIFOs/devices (`T2-M5`/`M4`).
pub fn open_read_nofollow(path: &Path) -> Result<(File, Metadata), RpcCallError> {
    #[cfg(unix)]
    let (file, meta) = {
        use std::os::fd::AsRawFd;
        use std::os::unix::fs::OpenOptionsExt;
        let file = OpenOptions::new().read(true).custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK).open(path)?;
        let meta = file.metadata()?;
        if meta.is_dir() { return Err(RpcCallError::new(RpcErrorCode::Eisdir, "target path is a directory")); }
        if !meta.file_type().is_file() { return Err(RpcCallError::new(RpcErrorCode::Eacces, "target is not a regular file")); }
        let fd = file.as_raw_fd();
        let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
        if flags < 0 { return Err(RpcCallError::from(std::io::Error::last_os_error())); }
        if (flags & libc::O_NONBLOCK) != 0 && unsafe { libc::fcntl(fd, libc::F_SETFL, flags & !libc::O_NONBLOCK) } < 0 {
            return Err(RpcCallError::from(std::io::Error::last_os_error()));
        }
        (file, meta)
    };
    #[cfg(not(unix))]
    let (file, meta) = {
        let pre = std::fs::symlink_metadata(path)?;
        if is_symlink_or_reparse(path, &pre) { return Err(RpcCallError::new(RpcErrorCode::Eacces, "symlink traversal is forbidden")); }
        if pre.is_dir() { return Err(RpcCallError::new(RpcErrorCode::Eisdir, "target path is a directory")); }
        if !pre.file_type().is_file() { return Err(RpcCallError::new(RpcErrorCode::Eacces, "target is not a regular file")); }
        let opened = OpenOptions::new().read(true).open(path)?;
        let meta = opened.metadata()?;
        if meta.is_dir() { return Err(RpcCallError::new(RpcErrorCode::Eisdir, "target path is a directory")); }
        if !meta.file_type().is_file() { return Err(RpcCallError::new(RpcErrorCode::Eacces, "target is not a regular file")); }
        let post = std::fs::symlink_metadata(path)?;
        if is_symlink_or_reparse(path, &post) { return Err(RpcCallError::new(RpcErrorCode::Eacces, "symlink traversal is forbidden")); }
        (opened, meta)
    };
    Ok((file, meta))
}

/// Checks `createOnly` / `expectedTag` and rejects existing symlinks, directories, or special files before writing.
pub fn check_write_condition(target: &Path, cond: &WriteCondition) -> Result<Option<Metadata>, RpcCallError> {
    match std::fs::symlink_metadata(target) {
        Ok(meta) => {
            if is_symlink_or_reparse(target, &meta) { return Err(RpcCallError::new(RpcErrorCode::Eacces, "cannot write through a symlink")); }
            if meta.is_dir() { return Err(RpcCallError::new(RpcErrorCode::Eisdir, "target path is a directory")); }
            if !meta.file_type().is_file() { return Err(RpcCallError::new(RpcErrorCode::Conflict, "target is not a regular file")); }
            if cond.create_only { return Err(RpcCallError::new(RpcErrorCode::PreconditionFailed, "file already exists")); }
            if let Some(expected) = &cond.expected_tag {
                let actual = file_tag(meta.len(), mtime_ms(&meta));
                if actual != *expected {
                    return Err(RpcCallError::new(RpcErrorCode::Conflict, format!("expectedTag mismatch (expected {expected}, actual {actual})")));
                }
            }
            Ok(Some(meta))
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            if cond.expected_tag.is_some() {
                return Err(RpcCallError::new(RpcErrorCode::Conflict, "file does not exist for expectedTag"));
            }
            Ok(None)
        }
        Err(err) => Err(RpcCallError::from(err)),
    }
}

/// Creates a uniquely named temporary file in `dir` without following symlinks.
pub fn create_temp_in_dir(dir: &Path, prefix: &str) -> Result<(PathBuf, File), RpcCallError> {
    for _ in 0..16 {
        let nonce: u64 = rand::thread_rng().gen();
        let candidate = dir.join(format!(".{prefix}.{nonce:016x}.tmp"));
        let mut opts = OpenOptions::new();
        opts.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600).custom_flags(libc::O_NOFOLLOW);
        }
        match opts.open(&candidate) {
            Ok(file) => return Ok((candidate, file)),
            Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(err) => return Err(RpcCallError::from(err)),
        }
    }
    Err(RpcCallError::new(RpcErrorCode::InternalError, "failed to allocate temporary file"))
}

/// Creates directory components along `rel_segments` under `canonical_root`, returning `(final_dir, newly_created_dirs)`.
pub fn ensure_dirs_contained_tracked(
    canonical_root: &Path, rel_segments: &[&str], platform: ClientPlatform,
) -> Result<(PathBuf, Vec<PathBuf>), RpcCallError> {
    let mut cursor = canonical_root.to_path_buf();
    let mut created = Vec::new();
    for seg in rel_segments {
        cursor.push(seg);
        match std::fs::symlink_metadata(&cursor) {
            Ok(meta) => {
                if is_symlink_or_reparse(&cursor, &meta) { return Err(RpcCallError::new(RpcErrorCode::Eacces, "symlink traversal is forbidden")); }
                if !meta.is_dir() { return Err(RpcCallError::new(RpcErrorCode::Enotdir, "ancestor path is not a directory")); }
            }
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                if let Some(parent) = cursor.parent() { verify_canonical_within(canonical_root, parent, platform)?; }
                std::fs::create_dir(&cursor)?;
                created.push(cursor.clone());
            }
            Err(err) => return Err(RpcCallError::from(err)),
        }
    }
    verify_canonical_within(canonical_root, &cursor, platform)?;
    Ok((cursor, created))
}

pub fn ensure_dirs_contained(canonical_root: &Path, rel_segments: &[&str], platform: ClientPlatform) -> Result<PathBuf, RpcCallError> {
    Ok(ensure_dirs_contained_tracked(canonical_root, rel_segments, platform)?.0)
}

/// Re-verifies parent containment & target safety (`T2-M5`), applies mode (`M1`), and atomically replaces `target`.
pub fn atomic_replace_file(
    canonical_root: &Path, target: &Path, temp: &Path, platform: ClientPlatform, preserve_mode: Option<u32>,
) -> Result<CommittedFileInfo, RpcCallError> {
    let cleanup_err = |err: RpcCallError| -> RpcCallError { let _ = std::fs::remove_file(temp); err };
    let parent = target.parent().ok_or_else(|| cleanup_err(RpcCallError::invalid("target has no parent directory")))?;
    let parent_meta = std::fs::symlink_metadata(parent).map_err(|e| cleanup_err(RpcCallError::from(e)))?;
    if is_symlink_or_reparse(parent, &parent_meta) {
        return Err(cleanup_err(RpcCallError::new(RpcErrorCode::Eacces, "parent directory is a symlink")));
    }
    verify_canonical_within(canonical_root, parent, platform).map_err(|e| cleanup_err(e.into()))?;
    match std::fs::symlink_metadata(target) {
        Ok(meta) => {
            if is_symlink_or_reparse(target, &meta) { return Err(cleanup_err(RpcCallError::new(RpcErrorCode::Eacces, "cannot replace a symlink"))); }
            if meta.is_dir() { return Err(cleanup_err(RpcCallError::new(RpcErrorCode::Eisdir, "target path is a directory"))); }
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
        Err(err) => return Err(cleanup_err(RpcCallError::from(err))),
    }
    let fallback_size = std::fs::symlink_metadata(temp).map(|m| m.len()).unwrap_or(0);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let final_mode = preserve_mode.map_or_else(|| default_new_file_mode(false), |m| m & 0o777);
        let _ = std::fs::set_permissions(temp, std::fs::Permissions::from_mode(final_mode));
    }
    #[cfg(not(unix))]
    let _ = preserve_mode;

    if let Err(first_err) = std::fs::rename(temp, target) {
        #[cfg(windows)]
        if let Ok(meta) = std::fs::symlink_metadata(target) {
            if !is_symlink_or_reparse(target, &meta) && meta.is_file() && meta.permissions().readonly() {
                let mut perms = meta.permissions();
                perms.set_readonly(false);
                let _ = std::fs::set_permissions(target, perms);
                if std::fs::rename(temp, target).is_ok() { return Ok(post_rename_info(target, fallback_size)); }
            }
        }
        return Err(cleanup_err(RpcCallError::from(first_err)));
    }
    Ok(post_rename_info(target, fallback_size))
}

fn post_rename_info(target: &Path, fallback_size: u64) -> CommittedFileInfo {
    match std::fs::symlink_metadata(target) {
        Ok(meta) => CommittedFileInfo { size: meta.len(), mtime_ms: mtime_ms(&meta) },
        Err(_) => CommittedFileInfo { size: fallback_size, mtime_ms: now_ms() },
    }
}
