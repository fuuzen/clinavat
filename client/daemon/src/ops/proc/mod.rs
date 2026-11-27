pub mod exec;
pub mod process_tree;
pub mod pty;
pub mod task_store;

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use crate::ops::{RpcCallError, RpcErrorCode};
use crate::path_guard::{
    assert_client_path, clean_native_path, is_symlink_or_reparse, resolve_contained_details,
    verify_canonical_within, ClientPlatform,
};

pub use exec::{handle_exec_command, handle_manage_task};
pub use process_tree::{ProcessTree, RunningProcessGuard};
pub use pty::{handle_pty_close, handle_pty_open, handle_pty_resize, PtyStore};
pub use task_store::BackgroundTaskStore;

const MAX_ENV_ENTRIES: usize = 128;
const MAX_ENV_TOTAL_BYTES: usize = 64 * 1024;

/// Validates `cwd` (and optional `root` containment) and returns a cleaned native path without `\\?\` prefix (`H5`).
pub fn resolve_exec_cwd(platform: ClientPlatform, root: Option<&str>, cwd: &str) -> Result<PathBuf, RpcCallError> {
    let trimmed = cwd.trim();
    let canonical = if let Some(root_str) = root.map(str::trim).filter(|s| !s.is_empty()) {
        let root_norm = assert_client_path(platform, root_str)?;
        let canonical_root = std::fs::canonicalize(&root_norm)?;
        if trimmed.is_empty() || trimmed == "." {
            canonical_root
        } else if is_absolute_for_platform(platform, trimmed) {
            let cwd_norm = assert_client_path(platform, trimmed)?;
            let p = Path::new(&cwd_norm);
            let meta = std::fs::symlink_metadata(p)?;
            if is_symlink_or_reparse(p, &meta) {
                return Err(RpcCallError::new(RpcErrorCode::Eacces, "cwd must not be a symlink"));
            }
            if !meta.is_dir() {
                return Err(RpcCallError::new(RpcErrorCode::Enotdir, "cwd is not a directory"));
            }
            verify_canonical_within(&canonical_root, p, platform)?
        } else {
            let contained = resolve_contained_details(root_str, Some(trimmed), platform, true, false)?;
            if !std::fs::symlink_metadata(&contained.full_path)?.is_dir() {
                return Err(RpcCallError::new(RpcErrorCode::Enotdir, "cwd is not a directory"));
            }
            contained.full_path
        }
    } else {
        let path = PathBuf::from(assert_client_path(platform, trimmed)?);
        let meta = std::fs::symlink_metadata(&path)?;
        if is_symlink_or_reparse(&path, &meta) {
            return Err(RpcCallError::new(RpcErrorCode::Eacces, "cwd must not be a symlink"));
        }
        if !meta.is_dir() {
            return Err(RpcCallError::new(RpcErrorCode::Enotdir, "cwd is not a directory"));
        }
        std::fs::canonicalize(&path)?
    };
    Ok(clean_native_path(platform, &canonical))
}

fn is_absolute_for_platform(platform: ClientPlatform, raw: &str) -> bool {
    if platform == ClientPlatform::Windows {
        let b = raw.as_bytes();
        b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && (b[2] == b'\\' || b[2] == b'/')
    } else {
        raw.starts_with('/')
    }
}

pub fn validate_env(raw: Option<&HashMap<String, String>>) -> Result<Vec<(String, String)>, RpcCallError> {
    let Some(map) = raw else { return Ok(Vec::new()) };
    if map.len() > MAX_ENV_ENTRIES {
        return Err(RpcCallError::invalid("too many environment variables"));
    }
    let mut out = Vec::with_capacity(map.len());
    let mut total = 0usize;
    for (k, v) in map {
        if k.is_empty() || k.len() > 128 || k.contains(['\0', '=']) || v.contains('\0') {
            return Err(RpcCallError::invalid(format!("invalid environment variable: {k}")));
        }
        total = total.saturating_add(k.len() + v.len());
        if total > MAX_ENV_TOTAL_BYTES {
            return Err(RpcCallError::invalid("environment variables exceed 64 KiB limit"));
        }
        out.push((k.clone(), v.clone()));
    }
    Ok(out)
}

pub fn extract_exit_info(status: &std::process::ExitStatus) -> (i32, Option<i32>) {
    #[cfg(unix)]
    let sig = {
        use std::os::unix::process::ExitStatusExt;
        status.signal()
    };
    #[cfg(not(unix))]
    let sig: Option<i32> = None;
    (status.code().unwrap_or_else(|| sig.map_or(1, |s| 128 + s)), sig)
}
