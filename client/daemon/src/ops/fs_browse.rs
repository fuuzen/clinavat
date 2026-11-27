use std::collections::VecDeque;

use serde::Deserialize;
use serde_json::{json, Value};

use crate::ops::fs_common::{file_tag, mtime_ms, unix_mode};
use crate::ops::{OpContext, RpcCallError, RpcErrorCode, SAFE_RPC_RESPONSE_BYTES};
use crate::path_guard::{
    assert_client_path, is_protected_internal_segment, is_symlink_or_reparse,
    resolve_contained_path_for_stat, ClientPlatform,
};

const DEFAULT_LIST_MAX_ENTRIES: usize = 10_000;
const MAX_LIST_DEPTH: usize = 16;

#[cfg(windows)]
#[link(name = "kernel32")]
extern "system" {
    fn GetLogicalDrives() -> u32;
}

#[derive(Debug, Default, Deserialize)]
struct ListDirectoriesParams {
    path: Option<String>,
}

pub async fn handle_list_directories(params: Option<Value>, ctx: &OpContext) -> Result<Value, RpcCallError> {
    let input: ListDirectoriesParams = match params {
        Some(v) if !v.is_null() => serde_json::from_value(v).map_err(|e| RpcCallError::invalid(e.to_string()))?,
        _ => ListDirectoriesParams::default(),
    };
    let target_raw = input
        .path
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| {
            if ctx.homedir.is_empty() {
                if ctx.platform == ClientPlatform::Windows { "C:\\" } else { "/" }
            } else {
                ctx.homedir.as_str()
            }
        });
    let normalized = assert_client_path(ctx.platform, target_raw)?;
    let mut rd = tokio::fs::read_dir(&normalized).await?;
    let mut entries = Vec::new();
    let mut count = 0usize;
    while let Some(entry) = rd.next_entry().await? {
        if ctx.cancel.is_cancelled() {
            return Err(RpcCallError::new(RpcErrorCode::InternalError, "cancelled"));
        }
        count += 1;
        if count % 64 == 0 {
            tokio::task::yield_now().await;
        }
        let entry_fs_path = entry.path();
        let Ok(meta) = tokio::fs::symlink_metadata(&entry_fs_path).await else { continue };
        if is_symlink_or_reparse(&entry_fs_path, &meta) || !meta.is_dir() {
            continue;
        }
        let Some(name) = entry.file_name().to_str().map(str::to_string) else { continue };
        if name == "." || name == ".." || name.contains(['/', '\\', '\0', '\r', '\n']) {
            continue;
        }
        let entry_path = join_display_path(ctx.platform, &normalized, &name);
        entries.push(json!({ "name": name, "path": entry_path, "type": "directory" }));
    }
    entries.sort_by(|a, b| a["name"].as_str().cmp(&b["name"].as_str()));
    let roots = list_os_roots(ctx.platform);
    Ok(json!({ "path": normalized, "roots": roots, "entries": entries }))
}

#[derive(Debug, Deserialize)]
struct ListFilesParams {
    root: String,
    path: Option<String>,
    #[serde(rename = "maxDepth")]
    max_depth: Option<usize>,
    #[serde(rename = "maxEntries")]
    max_entries: Option<usize>,
}

pub async fn handle_list_files(params: Option<Value>, ctx: &OpContext) -> Result<Value, RpcCallError> {
    let input: ListFilesParams = serde_json::from_value(params.unwrap_or(Value::Null))
        .map_err(|e| RpcCallError::invalid(e.to_string()))?;
    let contained = resolve_contained_path_for_stat(&input.root, input.path.as_deref(), ctx.platform, true)?;
    let target_meta = tokio::fs::symlink_metadata(&contained.full_path).await?;
    if is_symlink_or_reparse(&contained.full_path, &target_meta) {
        return Err(RpcCallError::new(RpcErrorCode::Eacces, "cannot list a symlink target"));
    }
    if !target_meta.is_dir() {
        return Err(RpcCallError::new(RpcErrorCode::Enotdir, "target path is not a directory"));
    }

    let max_depth = input.max_depth.unwrap_or(1).clamp(1, MAX_LIST_DEPTH);
    let max_entries = input.max_entries.unwrap_or(DEFAULT_LIST_MAX_ENTRIES).clamp(1, 50_000);
    let mut entries = Vec::new();
    let mut est_bytes = 128usize;
    let mut truncated = false;
    let mut queue = VecDeque::from([(contained.full_path.clone(), String::new(), 1usize)]);

    while let Some((dir_path, prefix, depth)) = queue.pop_front() {
        let mut rd = match tokio::fs::read_dir(&dir_path).await {
            Ok(rd) => rd,
            Err(_) if depth > 1 => continue,
            Err(err) => return Err(RpcCallError::from(err)),
        };
        while let Some(entry) = rd.next_entry().await? {
            if ctx.cancel.is_cancelled() {
                return Err(RpcCallError::new(RpcErrorCode::InternalError, "cancelled"));
            }
            let Some(name) = entry.file_name().to_str().map(str::to_string) else { continue };
            if is_protected_internal_segment(&name) {
                continue;
            }
            let entry_fs_path = entry.path();
            let Ok(meta) = tokio::fs::symlink_metadata(&entry_fs_path).await else { continue };
            let is_sym = is_symlink_or_reparse(&entry_fs_path, &meta);
            let kind = if is_sym { "symlink" } else if meta.is_dir() { "directory" } else { "file" };
            let rel_name = if prefix.is_empty() { name.clone() } else { format!("{prefix}/{name}") };
            let entry_cost = rel_name.len().saturating_mul(2).saturating_add(96);
            if entries.len() >= max_entries || est_bytes.saturating_add(entry_cost) > SAFE_RPC_RESPONSE_BYTES {
                truncated = true;
                break;
            }
            est_bytes += entry_cost;
            entries.push(json!({
                "name": rel_name,
                "kind": kind,
                "isSymlink": is_sym,
                "size": if !is_sym && meta.is_file() { Some(meta.len()) } else { None },
                "mtimeMs": mtime_ms(&meta),
            }));
            if !is_sym && meta.is_dir() && depth < max_depth {
                queue.push_back((entry.path(), rel_name, depth + 1));
            }
        }
        if truncated { break; }
    }
    let mut resp = json!({ "path": contained.rel_path, "entries": entries });
    if truncated {
        resp["truncated"] = json!(true);
    }
    Ok(resp)
}

#[derive(Debug, Deserialize)]
struct StatParams {
    root: String,
    path: Option<String>,
}

pub async fn handle_stat(params: Option<Value>, ctx: &OpContext) -> Result<Value, RpcCallError> {
    let input: StatParams = serde_json::from_value(params.unwrap_or(Value::Null))
        .map_err(|e| RpcCallError::invalid(e.to_string()))?;
    let contained = resolve_contained_path_for_stat(&input.root, input.path.as_deref(), ctx.platform, true)?;
    match tokio::fs::symlink_metadata(&contained.full_path).await {
        Ok(meta) => {
            let is_sym = is_symlink_or_reparse(&contained.full_path, &meta);
            let kind = if is_sym { "symlink" } else if meta.is_dir() { "directory" } else { "file" };
            let size = meta.len();
            let modified = mtime_ms(&meta);
            Ok(json!({
                "exists": true,
                "kind": kind,
                "size": size,
                "mtimeMs": modified,
                "mode": unix_mode(&meta),
                "tag": file_tag(size, modified),
                "isSymlink": is_sym,
            }))
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(json!({ "exists": false })),
        Err(err) => Err(RpcCallError::from(err)),
    }
}

fn join_display_path(platform: ClientPlatform, base: &str, name: &str) -> String {
    if platform == ClientPlatform::Windows {
        if base.ends_with('\\') { format!("{base}{name}") } else { format!("{base}\\{name}") }
    } else if base == "/" {
        format!("/{name}")
    } else {
        format!("{base}/{name}")
    }
}

fn list_os_roots(platform: ClientPlatform) -> Vec<String> {
    if platform == ClientPlatform::Windows {
        #[cfg(windows)]
        {
            let mask = unsafe { GetLogicalDrives() };
            let mut roots = Vec::new();
            for bit in 0..26u32 {
                if (mask & (1u32 << bit)) != 0 {
                    let drive = (b'A' + bit as u8) as char;
                    roots.push(format!("{drive}:\\"));
                }
            }
            return roots;
        }
        #[cfg(not(windows))]
        {
            return vec!["C:\\".to_string()];
        }
    }
    vec!["/".to_string()]
}
