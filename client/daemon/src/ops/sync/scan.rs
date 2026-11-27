use std::collections::HashSet;
use std::io::Read;
use std::path::{Path, PathBuf};

use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::ops::fs_common::{mtime_ms, open_read_nofollow, unix_mode};
use crate::ops::sync::ignore::{collect_git_ignored, SyncIgnoreMatcher};
use crate::ops::sync::{
    hex_lower, validate_sync_root, MAX_SCAN_RESPONSE_BYTES, MAX_SYNC_FILE_BYTES,
};
use crate::ops::{OpContext, RpcCallError, RpcErrorCode};
use crate::path_guard::{is_protected_internal_segment, is_symlink_or_reparse};

const INLINE_HASH_MAX_BYTES: u64 = 1024 * 1024;

#[derive(Debug, Deserialize)]
struct SyncScanParams {
    root: String,
    ignores: Option<Vec<String>>,
    #[serde(rename = "excludeVcs")]
    exclude_vcs: Option<bool>,
}

fn check_scan_budget(est_bytes: usize, extra: usize) -> Result<usize, RpcCallError> {
    let next = est_bytes.saturating_add(extra);
    if next > MAX_SCAN_RESPONSE_BYTES {
        return Err(RpcCallError::new(
            RpcErrorCode::PayloadTooLarge,
            format!(
                "sync.scan result exceeds {MAX_SCAN_RESPONSE_BYTES} byte limit; add ignore rules for large generated trees"
            ),
        ));
    }
    Ok(next)
}

pub async fn handle_sync_scan(params: Option<Value>, ctx: &OpContext) -> Result<Value, RpcCallError> {
    let input: SyncScanParams = serde_json::from_value(params.unwrap_or(Value::Null))
        .map_err(|e| RpcCallError::invalid(e.to_string()))?;
    let (platform, cancel) = (ctx.platform, ctx.cancel.clone());
    let (exclude_vcs, ignores) = (input.exclude_vcs.unwrap_or(true), input.ignores.unwrap_or_default());

    tokio::task::spawn_blocking(move || -> Result<Value, RpcCallError> {
        let root_dir = validate_sync_root(platform, &input.root)?;
        let git_ignored = if exclude_vcs { collect_git_ignored(&root_dir, platform) } else { Vec::new() };

        let mut all_patterns = Vec::with_capacity(ignores.len() + git_ignored.len() + 2);
        all_patterns.extend(ignores);
        all_patterns.extend(git_ignored.iter().map(|i| format!("/{}", i.trim_end_matches('/'))));
        all_patterns.push("/.bin".into());
        all_patterns.push(".git".into());
        let mut matcher = SyncIgnoreMatcher::new(&all_patterns);

        let mut entries = Vec::new();
        let mut skipped_links = Vec::new();
        let mut skipped_large = Vec::new();
        let mut seen_large = HashSet::new();
        let mut est_bytes = check_scan_budget(
            256,
            git_ignored.iter().map(|s| s.len() + 4).sum(),
        )?;
        let mut stack: Vec<(PathBuf, String)> = vec![(root_dir, String::new())];

        while let Some((dir_path, rel_prefix)) = stack.pop() {
            if cancel.is_cancelled() {
                return Err(RpcCallError::new(RpcErrorCode::InternalError, "cancelled"));
            }
            let Ok(rd) = std::fs::read_dir(&dir_path) else { continue };
            let mut children: Vec<(String, PathBuf)> = rd
                .flatten()
                .filter_map(|e| e.file_name().to_str().map(|n| (n.to_string(), e.path())))
                .collect();
            children.sort_by(|a, b| a.0.cmp(&b.0));

            for (name, full_path) in children {
                if cancel.is_cancelled() {
                    return Err(RpcCallError::new(RpcErrorCode::InternalError, "cancelled"));
                }
                if is_protected_internal_segment(&name) { continue; }
                let rel = if rel_prefix.is_empty() { name } else { format!("{rel_prefix}/{name}") };
                let Ok(meta) = std::fs::symlink_metadata(&full_path) else { continue };

                if is_symlink_or_reparse(&full_path, &meta) {
                    if !matcher.is_ignored(&rel, false) {
                        let target = std::fs::read_link(&full_path)
                            .map(|p| p.to_string_lossy().to_string())
                            .unwrap_or_else(|_| "未知".into());
                        let reason = format!("不可移植软链接（目标：{target}）");
                        est_bytes = check_scan_budget(est_bytes, rel.len() + reason.len() + 40)?;
                        skipped_links.push(json!({ "path": rel, "reason": reason }));
                    }
                    continue;
                }

                if meta.is_dir() {
                    if matcher.is_ignored(&rel, true) { continue; }
                    est_bytes = check_scan_budget(est_bytes, rel.len() + 68)?;
                    entries.push(json!({
                        "path": rel, "kind": "directory", "size": 0, "mtimeMs": mtime_ms(&meta),
                    }));
                    stack.push((full_path, rel));
                } else if meta.file_type().is_file() {
                    if matcher.is_ignored(&rel, false) { continue; }
                    if meta.len() > MAX_SYNC_FILE_BYTES {
                        if seen_large.insert(rel.clone()) {
                            est_bytes = check_scan_budget(est_bytes, rel.len() + 6)?;
                            skipped_large.push(rel);
                        }
                        continue;
                    }
                    let sha = if meta.len() <= INLINE_HASH_MAX_BYTES {
                        compute_small_sha256(&full_path)
                    } else {
                        None
                    };
                    let item_cost = rel.len() + 104 + sha.as_ref().map_or(0, |s| s.len() + 14);
                    est_bytes = check_scan_budget(est_bytes, item_cost)?;
                    let mut item = json!({
                        "path": rel,
                        "kind": "file",
                        "size": meta.len(),
                        "mtimeMs": mtime_ms(&meta),
                        "mode": unix_mode(&meta),
                    });
                    if let Some(digest) = sha { item["sha256"] = json!(digest); }
                    entries.push(item);
                }
            }
        }

        let response = json!({
            "entries": entries,
            "skippedLinks": skipped_links,
            "skippedLarge": skipped_large,
            "gitIgnored": git_ignored,
        });
        // Fail-closed verification against actual serialized size so we never truncate or blow Layer-1 framing.
        let actual_len = serde_json::to_vec(&response)
            .map(|v| v.len())
            .unwrap_or(MAX_SCAN_RESPONSE_BYTES + 1);
        if actual_len > MAX_SCAN_RESPONSE_BYTES {
            return Err(RpcCallError::new(
                RpcErrorCode::PayloadTooLarge,
                format!("sync.scan serialized payload ({actual_len} bytes) exceeds {MAX_SCAN_RESPONSE_BYTES} byte limit"),
            ));
        }
        Ok(response)
    })
    .await
    .map_err(|e| RpcCallError::new(RpcErrorCode::InternalError, format!("sync.scan task failed: {e}")))?
}

fn compute_small_sha256(path: &Path) -> Option<String> {
    let (mut file, meta) = open_read_nofollow(path).ok()?;
    if !meta.file_type().is_file() || meta.len() > INLINE_HASH_MAX_BYTES { return None; }
    let (mut hasher, mut buf) = (Sha256::new(), [0u8; 16 * 1024]);
    loop {
        let n = file.read(&mut buf).ok()?;
        if n == 0 { break; }
        hasher.update(&buf[..n]);
    }
    Some(hex_lower(&hasher.finalize()))
}
