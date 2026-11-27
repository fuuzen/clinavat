pub mod ignore;
pub mod pull;
pub mod push;
pub mod scan;

use std::fs::File;
use std::io::{Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, UNIX_EPOCH};

use serde_json::{json, Value};

use crate::ops::fs_common::{
    atomic_replace_file, create_temp_in_dir, ensure_dirs_contained, unix_mode,
};
use crate::ops::{RpcCallError, RpcErrorCode};
use crate::path_guard::{
    assert_client_path, is_symlink_or_reparse, resolve_contained_details,
    resolve_contained_path_for_stat, verify_canonical_within, ClientPlatform,
};

pub use pull::handle_sync_pull_batch;
pub use push::handle_sync_push_batch;
pub use scan::handle_sync_scan;

pub const MAX_SYNC_FILE_BYTES: u64 = 64 * 1024 * 1024;
/// Fail-closed JSON payload cap for `sync.scan` safely beneath Layer-1's 4 MiB frame limit.
pub const MAX_SCAN_RESPONSE_BYTES: usize = 3_670_016;

/// Classifies an I/O error into Hub's `mirror-reconcile.ts::LOCK_ERROR_CODES` / RPC error vocabulary.
pub fn classify_sync_io_error(err: &std::io::Error) -> &'static str {
    match err.raw_os_error() {
        Some(32) => return "SHARING_VIOLATION",
        Some(33) => return "LOCK_VIOLATION",
        Some(16) => return "EBUSY",
        _ => {}
    }
    #[cfg(unix)]
    if err.raw_os_error() == Some(libc::ELOOP) {
        return "EACCES";
    }
    match err.kind() {
        std::io::ErrorKind::NotFound => "ENOENT",
        std::io::ErrorKind::PermissionDenied => "EACCES",
        std::io::ErrorKind::ResourceBusy => "EBUSY",
        std::io::ErrorKind::IsADirectory => "EISDIR",
        std::io::ErrorKind::NotADirectory => "ENOTDIR",
        std::io::ErrorKind::AlreadyExists => "EEXIST",
        std::io::ErrorKind::InvalidInput => "INVALID_ARGUMENT",
        _ => "IO_ERROR",
    }
}

pub fn validate_sync_root(platform: ClientPlatform, raw_root: &str) -> Result<PathBuf, RpcCallError> {
    let path = PathBuf::from(assert_client_path(platform, raw_root.trim())?);
    let meta = std::fs::symlink_metadata(&path)?;
    if is_symlink_or_reparse(&path, &meta) {
        return Err(RpcCallError::new(RpcErrorCode::Eacces, "sync root must not be a symlink"));
    }
    if !meta.is_dir() {
        return Err(RpcCallError::new(RpcErrorCode::Enotdir, "sync root is not a directory"));
    }
    Ok(std::fs::canonicalize(&path)?)
}

/// Safely creates a directory for `sync.push_batch`, returning `Ok(rel_path)` or `Err((path, code, msg))`.
pub fn apply_sync_mkdir(
    root: &str, raw_path: &str, platform: ClientPlatform,
) -> Result<String, (String, &'static str, String)> {
    let contained = resolve_contained_details(root, Some(raw_path), platform, false, true)
        .map_err(|e| { let r = RpcCallError::from(e); (raw_path.to_string(), r.code.as_str(), r.message) })?;
    let segments: Vec<&str> = contained.rel_path.split('/').collect();
    ensure_dirs_contained(&contained.canonical_root, &segments, platform)
        .map_err(|e| (contained.rel_path.clone(), e.code.as_str(), e.message))?;
    Ok(contained.rel_path)
}

/// Safely deletes a file, symlink (without following), or empty directory for `sync.push_batch`.
pub fn apply_sync_delete(
    root: &str, raw_path: &str, platform: ClientPlatform,
) -> Result<Option<String>, (String, &'static str, String)> {
    let contained = resolve_contained_path_for_stat(root, Some(raw_path), platform, false)
        .map_err(|e| { let r = RpcCallError::from(e); (raw_path.to_string(), r.code.as_str(), r.message) })?;
    if contained.full_path == contained.canonical_root {
        return Err((contained.rel_path, "EACCES", "cannot delete workspace root".into()));
    }
    let meta = match std::fs::symlink_metadata(&contained.full_path) {
        Ok(m) => m,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(err) => return Err((contained.rel_path, classify_sync_io_error(&err), err.to_string())),
    };
    if let Some(parent) = contained.full_path.parent() {
        verify_canonical_within(&contained.canonical_root, parent, platform)
            .map_err(|e| { let r = RpcCallError::from(e); (contained.rel_path.clone(), r.code.as_str(), r.message) })?;
    }
    let rm_res = if is_symlink_or_reparse(&contained.full_path, &meta) {
        #[cfg(windows)]
        { std::fs::remove_file(&contained.full_path).or_else(|_| std::fs::remove_dir(&contained.full_path)) }
        #[cfg(not(windows))]
        { std::fs::remove_file(&contained.full_path) }
    } else if meta.is_dir() {
        std::fs::remove_dir(&contained.full_path)
    } else {
        std::fs::remove_file(&contained.full_path)
    };
    match rm_res {
        Ok(()) => Ok(Some(contained.rel_path)),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(err) => Err((contained.rel_path, classify_sync_io_error(&err), err.to_string())),
    }
}

/// Atomically commits a staged `sync.push_batch` file into `target`, preserving/applying mode and mtime.
#[allow(clippy::too_many_arguments)]
pub fn commit_sync_staged_file(
    canonical_root: &Path, rel: &str, target: &Path, staged_file: &mut File,
    mtime_opt: Option<u64>, mode_opt: Option<u32>, sha256_hex: String, platform: ClientPlatform,
) -> Result<Value, (&'static str, String)> {
    let segs: Vec<&str> = rel.split('/').collect();
    let parent = if segs.len() > 1 {
        ensure_dirs_contained(canonical_root, &segs[..segs.len() - 1], platform)
            .map_err(|e| (e.code.as_str(), e.message))?
    } else {
        canonical_root.to_path_buf()
    };
    let existing_mode = match std::fs::symlink_metadata(target) {
        Ok(meta) => {
            if is_symlink_or_reparse(target, &meta) { return Err(("EACCES", "cannot overwrite symlink".into())); }
            if meta.is_dir() { return Err(("EISDIR", "target path is a directory".into())); }
            Some(unix_mode(&meta))
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => None,
        Err(err) => return Err((classify_sync_io_error(&err), err.to_string())),
    };
    let (temp_path, mut temp_file) = create_temp_in_dir(&parent, "sync")
        .map_err(|e| (e.code.as_str(), e.message))?;
    let copy_res = (|| -> std::io::Result<()> {
        staged_file.flush()?;
        staged_file.seek(SeekFrom::Start(0))?;
        std::io::copy(staged_file, &mut temp_file)?;
        temp_file.sync_all()?;
        if let Some(ms) = mtime_opt {
            let _ = temp_file.set_modified(UNIX_EPOCH + Duration::from_millis(ms));
        }
        Ok(())
    })();
    drop(temp_file);
    if let Err(err) = copy_res {
        let _ = std::fs::remove_file(&temp_path);
        return Err((classify_sync_io_error(&err), err.to_string()));
    }
    let final_mode = resolve_push_mode(existing_mode, mode_opt);
    let written = atomic_replace_file(canonical_root, target, &temp_path, platform, final_mode)
        .map_err(|e| (e.code.as_str(), e.message))?;
    Ok(json!({
        "size": written.size,
        "mtimeMs": mtime_opt.unwrap_or(written.mtime_ms),
        "sha256": sha256_hex,
    }))
}

fn resolve_push_mode(existing: Option<u32>, incoming: Option<u32>) -> Option<u32> {
    #[cfg(unix)]
    { incoming.map(|m| crate::ops::fs_common::default_new_file_mode((m & 0o111) != 0)).or(existing) }
    #[cfg(not(unix))]
    { let _ = (existing, incoming); None }
}

pub fn hex_lower(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        use std::fmt::Write;
        let _ = write!(&mut out, "{b:02x}");
    }
    out
}
