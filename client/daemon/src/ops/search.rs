use std::io::Read;
use std::path::Path;

use globset::{GlobBuilder, GlobMatcher};
use ignore::WalkBuilder;
use regex::RegexBuilder;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::ops::fs_common::open_read_nofollow;
use crate::ops::{OpContext, RpcCallError, RpcErrorCode, SAFE_RPC_RESPONSE_BYTES};
use crate::path_guard::{
    is_protected_internal_segment, resolve_contained_details, ClientPlatform,
};

const DEFAULT_GLOB_MAX_RESULTS: usize = 200;
const MAX_GLOB_RESULTS: usize = 2000;
const DEFAULT_GREP_MAX_RESULTS: usize = 100;
const MAX_GREP_RESULTS: usize = 2000;
const MAX_GREP_FILE_BYTES: u64 = 4 * 1024 * 1024;
const MAX_GREP_CONTEXT_LINES: usize = 20;
const MAX_GREP_LINE_BYTES: usize = 2048;
const REGEX_SIZE_LIMIT: usize = 4 * 1024 * 1024;
const BINARY_SNIFF_BYTES: usize = 8 * 1024;

#[derive(Debug, Deserialize)]
struct GlobParams {
    root: String,
    pattern: String,
    cwd: Option<String>,
    path: Option<String>,
    #[serde(rename = "maxResults")]
    max_results: Option<usize>,
}

pub async fn handle_glob(params: Option<Value>, ctx: &OpContext) -> Result<Value, RpcCallError> {
    let input: GlobParams = serde_json::from_value(params.unwrap_or(Value::Null))
        .map_err(|e| RpcCallError::invalid(e.to_string()))?;
    assert_safe_glob_pattern(&input.pattern, ctx.platform)?;
    let max_results = input.max_results.unwrap_or(DEFAULT_GLOB_MAX_RESULTS).clamp(1, MAX_GLOB_RESULTS);
    let matcher = compile_glob(&input.pattern)?;
    let match_basename_only = !input.pattern.contains('/') && !input.pattern.contains('\\');
    let platform = ctx.platform;
    let cancel = ctx.cancel.clone();

    tokio::task::spawn_blocking(move || -> Result<Value, RpcCallError> {
        let rel_base = input.cwd.as_deref().or(input.path.as_deref());
        let contained = resolve_contained_details(&input.root, rel_base, platform, true, false)?;
        let meta = std::fs::symlink_metadata(&contained.full_path)?;
        if !meta.is_dir() {
            return Err(RpcCallError::new(RpcErrorCode::Enotdir, "glob search directory is not a directory"));
        }
        let mut matches = Vec::new();
        let mut est_bytes = 64usize;
        let mut truncated = false;
        let walker = build_safe_walker(&contained.full_path);

        for entry_res in walker.build() {
            if cancel.is_cancelled() {
                return Err(RpcCallError::new(RpcErrorCode::InternalError, "cancelled"));
            }
            let Ok(entry) = entry_res else { continue };
            if entry.depth() == 0 || entry.path_is_symlink() { continue; }
            let Some(ft) = entry.file_type() else { continue };
            if !ft.is_file() { continue; }
            let Ok(rel_from_search) = entry.path().strip_prefix(&contained.full_path) else { continue };
            let rel_search_posix = to_posix_rel(rel_from_search);
            let is_match = matcher.is_match(&rel_search_posix)
                || (match_basename_only && entry.file_name().to_str().is_some_and(|n| matcher.is_match(n)));
            if !is_match { continue; }
            let rel_from_root = entry
                .path()
                .strip_prefix(&contained.canonical_root)
                .map(to_posix_rel)
                .unwrap_or(rel_search_posix);
            if has_protected_segment(&rel_from_root) { continue; }
            let cost = rel_from_root.len().saturating_mul(2).saturating_add(8);
            if matches.len() >= max_results || est_bytes.saturating_add(cost) > SAFE_RPC_RESPONSE_BYTES {
                truncated = true;
                break;
            }
            est_bytes += cost;
            matches.push(rel_from_root);
        }
        matches.sort();
        Ok(json!({ "matches": matches, "truncated": truncated }))
    })
    .await
    .map_err(|e| RpcCallError::new(RpcErrorCode::InternalError, format!("glob task failed: {e}")))?
}

#[derive(Debug, Deserialize)]
struct GrepParams {
    root: String,
    pattern: String,
    path: Option<String>,
    glob: Option<String>,
    #[serde(rename = "caseInsensitive")]
    case_insensitive: Option<bool>,
    #[serde(rename = "caseSensitive")]
    case_sensitive: Option<bool>,
    #[serde(rename = "contextLines")]
    context_lines: Option<usize>,
    #[serde(rename = "maxResults")]
    max_results: Option<usize>,
}

pub async fn handle_grep(params: Option<Value>, ctx: &OpContext) -> Result<Value, RpcCallError> {
    let input: GrepParams = serde_json::from_value(params.unwrap_or(Value::Null))
        .map_err(|e| RpcCallError::invalid(e.to_string()))?;
    if input.pattern.is_empty() || input.pattern.len() > 2048 {
        return Err(RpcCallError::invalid("grep pattern is empty or too long"));
    }
    let glob_filter = match input.glob.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(g) => {
            assert_safe_glob_pattern(g, ctx.platform)?;
            let basename_mode = !g.contains('/') && !g.contains('\\');
            Some((compile_glob(g)?, basename_mode))
        }
        None => None,
    };
    let case_insensitive = input
        .case_insensitive
        .unwrap_or_else(|| input.case_sensitive.map(|cs| !cs).unwrap_or(false));
    let regex = RegexBuilder::new(&input.pattern)
        .case_insensitive(case_insensitive)
        .size_limit(REGEX_SIZE_LIMIT)
        .build()
        .map_err(|e| RpcCallError::invalid(format!("invalid grep regex: {e}")))?;
    let context_lines = input.context_lines.unwrap_or(0).min(MAX_GREP_CONTEXT_LINES);
    let max_results = input.max_results.unwrap_or(DEFAULT_GREP_MAX_RESULTS).clamp(1, MAX_GREP_RESULTS);
    let platform = ctx.platform;
    let cancel = ctx.cancel.clone();

    tokio::task::spawn_blocking(move || -> Result<Value, RpcCallError> {
        let contained = resolve_contained_details(&input.root, input.path.as_deref(), platform, true, false)?;
        let target_meta = std::fs::symlink_metadata(&contained.full_path)?;
        let mut matches = Vec::new();
        let mut est_bytes = 64usize;
        let mut truncated = false;

        if target_meta.file_type().is_file() {
            grep_one_file(
                &contained.full_path, &contained.rel_path, &regex, context_lines, max_results,
                &cancel, &mut matches, &mut est_bytes, &mut truncated,
            )?;
            return Ok(json!({ "matches": matches, "truncated": truncated }));
        }
        if !target_meta.is_dir() {
            return Err(RpcCallError::new(RpcErrorCode::Eacces, "grep target is neither regular file nor directory"));
        }

        let walker = build_safe_walker(&contained.full_path);
        for entry_res in walker.build() {
            if cancel.is_cancelled() {
                return Err(RpcCallError::new(RpcErrorCode::InternalError, "cancelled"));
            }
            let Ok(entry) = entry_res else { continue };
            if entry.depth() == 0 || entry.path_is_symlink() { continue; }
            let Some(ft) = entry.file_type() else { continue };
            if !ft.is_file() { continue; }
            let Ok(rel_from_root) = entry.path().strip_prefix(&contained.canonical_root) else { continue };
            let rel_posix = to_posix_rel(rel_from_root);
            if has_protected_segment(&rel_posix) { continue; }
            if let Some((ref matcher, basename_mode)) = glob_filter {
                let rel_search = entry.path().strip_prefix(&contained.full_path).map(to_posix_rel).unwrap_or_else(|_| rel_posix.clone());
                let matched = matcher.is_match(&rel_search)
                    || (basename_mode && entry.file_name().to_str().is_some_and(|n| matcher.is_match(n)));
                if !matched { continue; }
            }
            grep_one_file(
                entry.path(), &rel_posix, &regex, context_lines, max_results,
                &cancel, &mut matches, &mut est_bytes, &mut truncated,
            )?;
            if truncated { break; }
        }
        Ok(json!({ "matches": matches, "truncated": truncated }))
    })
    .await
    .map_err(|e| RpcCallError::new(RpcErrorCode::InternalError, format!("grep task failed: {e}")))?
}

#[allow(clippy::too_many_arguments)]
fn grep_one_file(
    path: &Path,
    rel_posix: &str,
    regex: &regex::Regex,
    context_lines: usize,
    max_results: usize,
    cancel: &tokio_util::sync::CancellationToken,
    matches: &mut Vec<Value>,
    est_bytes: &mut usize,
    truncated: &mut bool,
) -> Result<(), RpcCallError> {
    let Ok((mut file, meta)) = open_read_nofollow(path) else { return Ok(()) };
    if meta.len() == 0 || meta.len() > MAX_GREP_FILE_BYTES { return Ok(()); }
    let mut head = vec![0u8; (meta.len() as usize).min(BINARY_SNIFF_BYTES)];
    let Ok(n) = file.read(&mut head) else { return Ok(()) };
    head.truncate(n);
    if head.contains(&0) { return Ok(()); }

    let mut content_bytes = head;
    if (content_bytes.len() as u64) < meta.len() && file.read_to_end(&mut content_bytes).is_err() {
        return Ok(());
    }
    if content_bytes.contains(&0) { return Ok(()); }

    let text = String::from_utf8_lossy(&content_bytes);
    let lines: Vec<&str> = text.split('\n').map(|l| l.strip_suffix('\r').unwrap_or(l)).collect();
    for (idx, line) in lines.iter().enumerate() {
        if idx % 256 == 0 && cancel.is_cancelled() {
            return Err(RpcCallError::new(RpcErrorCode::InternalError, "cancelled"));
        }
        if !regex.is_match(line) { continue; }
        let clipped_text = truncate_utf8_line(line, MAX_GREP_LINE_BYTES);
        let mut obj = json!({ "path": rel_posix, "line": idx + 1, "text": clipped_text });
        let mut ctx_cost = 0usize;
        if context_lines > 0 {
            let before_start = idx.saturating_sub(context_lines);
            let after_end = (idx + 1 + context_lines).min(lines.len());
            let before: Vec<String> = lines[before_start..idx].iter().map(|l| truncate_utf8_line(l, MAX_GREP_LINE_BYTES)).collect();
            let after: Vec<String> = lines[idx + 1..after_end].iter().map(|l| truncate_utf8_line(l, MAX_GREP_LINE_BYTES)).collect();
            ctx_cost = before.iter().chain(after.iter()).map(|s| s.len().saturating_mul(2) + 4).sum();
            obj["before"] = json!(before);
            obj["after"] = json!(after);
        }
        let item_cost = rel_posix.len().saturating_mul(2) + clipped_text.len().saturating_mul(2) + ctx_cost + 64;
        if matches.len() >= max_results || est_bytes.saturating_add(item_cost) > SAFE_RPC_RESPONSE_BYTES {
            *truncated = true;
            return Ok(());
        }
        *est_bytes += item_cost;
        matches.push(obj);
    }
    Ok(())
}

fn truncate_utf8_line(line: &str, max_bytes: usize) -> String {
    if line.len() <= max_bytes {
        return line.to_string();
    }
    let mut end = max_bytes;
    while end > 0 && !line.is_char_boundary(end) {
        end -= 1;
    }
    let mut out = String::with_capacity(end + 3);
    out.push_str(&line[..end]);
    out.push_str("...");
    out
}

fn build_safe_walker(root: &Path) -> WalkBuilder {
    let mut builder = WalkBuilder::new(root);
    builder
        .follow_links(false)
        .hidden(false)
        .git_ignore(true)
        .git_global(false)
        .git_exclude(true)
        .ignore(true)
        .require_git(false)
        .filter_entry(|entry| {
            if entry.depth() == 0 { return true; }
            if entry.path_is_symlink() { return false; }
            match entry.file_name().to_str() {
                Some(name) => !is_protected_internal_segment(name),
                None => false,
            }
        });
    builder
}

fn compile_glob(pattern: &str) -> Result<GlobMatcher, RpcCallError> {
    let normalized = pattern.replace('\\', "/");
    GlobBuilder::new(&normalized)
        .literal_separator(true)
        .build()
        .map(|g| g.compile_matcher())
        .map_err(|e| RpcCallError::invalid(format!("invalid glob pattern: {e}")))
}

fn assert_safe_glob_pattern(pattern: &str, platform: ClientPlatform) -> Result<(), RpcCallError> {
    if pattern.is_empty() || pattern.len() > 512 || pattern.bytes().any(|b| b == 0 || b == b'\r' || b == b'\n') {
        return Err(RpcCallError::invalid("search pattern is invalid"));
    }
    if pattern.starts_with("\\\\") || pattern.starts_with("//") {
        return Err(RpcCallError::invalid("search pattern must not use UNC paths"));
    }
    let trimmed = pattern.trim_start_matches('!');
    let bytes = trimmed.as_bytes();
    if trimmed.starts_with('/') || (bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':') {
        return Err(RpcCallError::invalid("search pattern must be relative to workspace"));
    }
    for seg in trimmed.replace('\\', "/").split('/') {
        if seg.is_empty() { continue; }
        if seg == ".." {
            return Err(RpcCallError::invalid("search pattern must not contain parent traversal (..)"));
        }
        if platform == ClientPlatform::Windows && seg.contains(':') {
            return Err(RpcCallError::invalid(format!("Windows search pattern cannot contain colon: {seg}")));
        }
        if is_protected_internal_segment(seg) {
            return Err(RpcCallError::new(RpcErrorCode::Eacces, format!("cannot search protected segment: {seg}")));
        }
    }
    Ok(())
}

fn to_posix_rel(path: &Path) -> String {
    path.components().filter_map(|c| c.as_os_str().to_str()).collect::<Vec<_>>().join("/")
}

fn has_protected_segment(rel_posix: &str) -> bool {
    rel_posix.split('/').any(|s| !s.is_empty() && is_protected_internal_segment(s))
}
