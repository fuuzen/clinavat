use std::path::{Component, Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;

use serde::Deserialize;
use serde_json::{json, Value};
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::Command;

use crate::ops::fs_common::{atomic_replace_file, create_temp_in_dir, ensure_dirs_contained, open_read_nofollow, unix_mode};
use crate::ops::proc::{ProcessTree, RunningProcessGuard};
use crate::ops::sync::MAX_SYNC_FILE_BYTES;
use crate::ops::{OpContext, RpcCallError, RpcErrorCode};
use crate::path_guard::{
    assert_client_path, clean_native_path, format_client_path, is_symlink_or_reparse,
    resolve_contained_details, ClientPlatform,
};

const MAX_GIT_STATUS_BYTES: usize = 512 * 1024;
const MAX_GIT_DIFF_BYTES: usize = 2 * 1024 * 1024;
const MAX_GIT_STATUS_JSON_BYTES: usize = 3584 * 1024;
const MAX_GIT_STDERR_BYTES: usize = 64 * 1024;
const DIFF_TRUNCATED_MARKER: &str = "\n... [diff truncated to fit RPC frame limit]\n";

#[cfg(windows)] const NULL_HOOKS_CFG: &str = "core.hooksPath=NUL";
#[cfg(not(windows))] const NULL_HOOKS_CFG: &str = "core.hooksPath=/dev/null";

struct GitOutput { code: i32, stdout: String, stderr: String }

async fn run_git(cwd: &Path, args: &[&str], extra_env: &[(&str, &str)], max_out: usize, platform: ClientPlatform) -> Result<GitOutput, RpcCallError> {
    let mut cmd = Command::new("git");
    ProcessTree::configure_command(&mut cmd);
    cmd.current_dir(clean_native_path(platform, cwd)).args(args)
        .env("GIT_TERMINAL_PROMPT", "0").env("GIT_OPTIONAL_LOCKS", "0")
        .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    for (k, v) in extra_env { cmd.env(k, v); }
    let mut child = cmd.spawn().map_err(|e| RpcCallError::new(RpcErrorCode::InternalError, format!("failed to spawn git: {e}")))?;
    let (stdout, stderr) = (child.stdout.take(), child.stderr.take());
    let tree = ProcessTree::from_child(child);
    let mut guard = RunningProcessGuard::new(Arc::clone(&tree));
    let (mut out_b, mut err_b, status) = tokio::join!(read_bounded(stdout, max_out), read_bounded(stderr, MAX_GIT_STDERR_BYTES), tree.wait());
    guard.disarm();
    Ok(GitOutput { code: status?.code().unwrap_or(1), stdout: decode_utf8_bounded(&mut out_b), stderr: decode_utf8_bounded(&mut err_b) })
}

fn decode_utf8_bounded(bytes: &mut Vec<u8>) -> String {
    for i in (bytes.len().saturating_sub(3)..bytes.len()).rev() {
        if let Err(e) = std::str::from_utf8(&bytes[i..]) { if e.valid_up_to() == 0 && e.error_len().is_none() { bytes.truncate(i); break; } } else { break; }
    }
    String::from_utf8_lossy(bytes).into_owned()
}

async fn read_bounded<R: AsyncRead + Unpin>(stream: Option<R>, cap: usize) -> Vec<u8> {
    let Some(mut reader) = stream else { return Vec::new() };
    let (mut out, mut buf) = (Vec::new(), [0u8; 8192]);
    while let Ok(n) = reader.read(&mut buf).await {
        if n == 0 { break; }
        if out.len() < cap { out.extend_from_slice(&buf[..(cap - out.len()).min(n)]); }
    }
    out
}

fn require_existing_dir(platform: ClientPlatform, raw: &str) -> Result<PathBuf, RpcCallError> {
    let path = PathBuf::from(assert_client_path(platform, raw.trim())?);
    let meta = std::fs::symlink_metadata(&path)?;
    if is_symlink_or_reparse(&path, &meta) { return Err(RpcCallError::new(RpcErrorCode::Eacces, "directory path must not be a symlink")); }
    if !meta.is_dir() { return Err(RpcCallError::new(RpcErrorCode::Enotdir, "target path is not a directory")); }
    Ok(clean_native_path(platform, &std::fs::canonicalize(&path)?))
}

fn validate_git_ref<'a>(value: &'a str, label: &str) -> Result<&'a str, RpcCallError> {
    let t = value.trim();
    if t.is_empty() || t.len() > 256 || t.starts_with('-') || t.contains("..") || t.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return Err(RpcCallError::invalid(format!("invalid git {label}: {value}")));
    }
    Ok(t)
}

fn validate_safe_segment<'a>(value: &'a str, label: &str) -> Result<&'a str, RpcCallError> {
    let t = value.trim();
    if t.is_empty() || t == "." || t == ".." || t.len() > 160 || t.contains(['/', '\\', ':', '\0', '\r', '\n']) {
        return Err(RpcCallError::invalid(format!("invalid {label}: {value}")));
    }
    Ok(t)
}

fn is_strict_worktree_descendant(path: &Path) -> bool {
    let (mut in_wt, mut has_child) = (false, false);
    for comp in path.components() {
        match comp {
            Component::ParentDir => return false,
            Component::Normal(_) if in_wt => has_child = true,
            Component::Normal(s) if s.to_string_lossy().eq_ignore_ascii_case("worktrees") => in_wt = true,
            _ => {}
        }
    }
    in_wt && has_child
}

fn validate_worktree_cleanup_path(path: &Path, repo_dir: &Path, root_dir: Option<&Path>) -> Result<(), RpcCallError> {
    if path.parent().is_none() { return Err(RpcCallError::invalid("worktree path must not be a filesystem root")); }
    let cmp = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    if !is_strict_worktree_descendant(path) || !is_strict_worktree_descendant(&cmp) {
        return Err(RpcCallError::invalid("worktree path must be a strict subdirectory inside a worktrees directory"));
    }
    if cmp == repo_dir || repo_dir.starts_with(&cmp) { return Err(RpcCallError::invalid("worktree path cannot overlap repository root")); }
    if root_dir.is_some_and(|root| cmp == root || root.starts_with(&cmp)) { return Err(RpcCallError::invalid("worktree path cannot overlap project root")); }
    if let Ok(meta) = std::fs::symlink_metadata(path) {
        if is_symlink_or_reparse(path, &meta) { return Err(RpcCallError::new(RpcErrorCode::Eacces, "worktree path must not be a symlink")); }
        if !meta.is_dir() { return Err(RpcCallError::new(RpcErrorCode::Conflict, "worktree path is not a directory")); }
    }
    Ok(())
}

async fn fallback_identity_env(dir: &Path, platform: ClientPlatform) -> Vec<(&'static str, &'static str)> {
    if run_git(dir, &["config", "user.email"], &[], 1024, platform).await.map(|o| o.code == 0 && !o.stdout.trim().is_empty()).unwrap_or(false) {
        Vec::new()
    } else {
        vec![("GIT_AUTHOR_NAME", "Clinavat"), ("GIT_AUTHOR_EMAIL", "clinavat@localhost"), ("GIT_COMMITTER_NAME", "Clinavat"), ("GIT_COMMITTER_EMAIL", "clinavat@localhost")]
    }
}

#[derive(Debug, Deserialize)]
struct GitStatusParams { root: String }

pub async fn handle_git_status(params: Option<Value>, ctx: &OpContext) -> Result<Value, RpcCallError> {
    let input: GitStatusParams = serde_json::from_value(params.unwrap_or(Value::Null)).map_err(|e| RpcCallError::invalid(e.to_string()))?;
    let dir = require_existing_dir(ctx.platform, &input.root)?;
    let inside = run_git(&dir, &["rev-parse", "--is-inside-work-tree"], &[], 128, ctx.platform).await?;
    if inside.code != 0 || inside.stdout.trim() != "true" { return Err(RpcCallError::invalid(first_non_empty(&inside.stderr, "not a git repository"))); }
    let has_head = run_git(&dir, &["rev-parse", "--verify", "-q", "HEAD"], &[], 256, ctx.platform).await?.code == 0;
    let branch_args: &[&str] = if has_head { &["rev-parse", "--abbrev-ref", "HEAD"] } else { &["symbolic-ref", "--short", "HEAD"] };
    let diff_args: &[&str] = if has_head { &["-c", "core.quotepath=false", "diff", "--no-ext-diff", "--no-color", "HEAD", "--", "."] }
        else { &["-c", "core.quotepath=false", "diff", "--no-ext-diff", "--no-color", "--", "."] };
    let branch = run_git(&dir, branch_args, &[], 512, ctx.platform).await?;
    let status = run_git(&dir, &["-c", "core.quotepath=false", "status", "--short"], &[], MAX_GIT_STATUS_BYTES, ctx.platform).await?;
    let diff = run_git(&dir, diff_args, &[], MAX_GIT_DIFF_BYTES, ctx.platform).await?;
    Ok(fit_git_status_payload(branch.stdout.trim(), status.stdout, diff.stdout))
}

fn floor_char_boundary(s: &str, mut idx: usize) -> usize {
    idx = idx.min(s.len());
    while idx > 0 && !s.is_char_boundary(idx) { idx -= 1; }
    idx
}

fn fit_utf8_prefix_len(text: &str, fits: impl Fn(&str) -> bool) -> usize {
    let (mut lo, mut hi) = (0usize, text.len());
    while lo < hi {
        let mut mid = floor_char_boundary(text, lo + (hi - lo).div_ceil(2));
        if mid == lo { mid = text[lo..].chars().next().map_or(hi, |c| lo + c.len_utf8()).min(hi); }
        if fits(&text[..mid]) { lo = mid; } else { hi = floor_char_boundary(text, mid.saturating_sub(1)); }
    }
    lo
}

/// Ensures serialized `git.status` JSON stays within 3.5 MiB by UTF-8-safe diff truncation (`T4-M3`).
fn fit_git_status_payload(branch: &str, mut status: String, mut diff: String) -> Value {
    let mk = |st: &str, df: &str, trunc: bool| if trunc { json!({ "branch": branch, "status": st, "diff": df, "diffTruncated": true }) } else { json!({ "branch": branch, "status": st, "diff": df }) };
    let ok = |v: &Value| serde_json::to_vec(v).map(|b| b.len()).unwrap_or(usize::MAX) <= MAX_GIT_STATUS_JSON_BYTES;
    let initial = mk(&status, &diff, false);
    if ok(&initial) { return initial; }
    diff.truncate(fit_utf8_prefix_len(&diff, |p| ok(&mk(&status, &format!("{p}{DIFF_TRUNCATED_MARKER}"), true))));
    diff.push_str(DIFF_TRUNCATED_MARKER);
    let out = mk(&status, &diff, true);
    if ok(&out) { return out; }
    status.truncate(fit_utf8_prefix_len(&status, |p| ok(&mk(p, DIFF_TRUNCATED_MARKER, true))));
    mk(&status, DIFF_TRUNCATED_MARKER, true)
}

#[derive(Debug, Deserialize)]
#[serde(tag = "op", rename_all = "lowercase")]
enum WorktreeRequest {
    Inspect { root: String, directory: Option<String> },
    Create {
        repo: String, root: String, head: String, branch: String, target: Option<String>, directory: Option<String>,
        destination: Option<String>, #[serde(rename = "worktreeName")] worktree_name: Option<String>,
        #[serde(rename = "mainProjectId")] main_project_id: Option<String>,
    },
    Commit { #[serde(rename = "worktreePath")] worktree_path: String, base: String, message: String },
    Merge { repo: String, branch: String, mode: String, #[serde(rename = "onConflict")] on_conflict: String, message: String },
    Remove { repo: String, #[serde(rename = "worktreePath")] worktree_path: String, branch: String },
}

pub async fn handle_git_worktree(params: Option<Value>, ctx: &OpContext) -> Result<Value, RpcCallError> {
    let req: WorktreeRequest = serde_json::from_value(params.unwrap_or(Value::Null)).map_err(|e| RpcCallError::invalid(e.to_string()))?;
    match req {
        WorktreeRequest::Inspect { root, directory } => worktree_inspect(ctx, &root, directory.as_deref()).await,
        WorktreeRequest::Create { repo, root, head, branch, target, directory, destination, worktree_name, main_project_id } =>
            worktree_create(ctx, &repo, &root, &head, &branch, target.as_deref(), directory.as_deref(), destination.as_deref(), worktree_name.as_deref(), main_project_id.as_deref()).await,
        WorktreeRequest::Commit { worktree_path, base, message } => worktree_commit(ctx, &worktree_path, &base, &message).await,
        WorktreeRequest::Merge { repo, branch, mode, on_conflict, message } => worktree_merge(ctx, &repo, &branch, &mode, &on_conflict, &message).await,
        WorktreeRequest::Remove { repo, worktree_path, branch } => worktree_remove(ctx, &repo, &worktree_path, &branch).await,
    }
}

async fn worktree_inspect(ctx: &OpContext, root: &str, directory: Option<&str>) -> Result<Value, RpcCallError> {
    let contained = resolve_contained_details(root, directory, ctx.platform, true, false)?;
    if !std::fs::symlink_metadata(&contained.full_path)?.is_dir() { return Err(RpcCallError::new(RpcErrorCode::Enotdir, "inspect target is not a directory")); }
    let target = clean_native_path(ctx.platform, &std::fs::canonicalize(&contained.full_path)?);
    let top_out = run_git(&target, &["rev-parse", "--show-toplevel"], &[], 4096, ctx.platform).await?;
    if top_out.code != 0 || top_out.stdout.trim().is_empty() { return Ok(json!({ "isRepo": false })); }
    let head_out = run_git(&target, &["rev-parse", "--verify", "-q", "HEAD"], &[], 256, ctx.platform).await?;
    if head_out.code != 0 || head_out.stdout.trim().is_empty() { return Ok(json!({ "isRepo": false })); }
    let prefix = run_git(&target, &["rev-parse", "--show-prefix"], &[], 4096, ctx.platform).await?.stdout;
    if !prefix.trim().is_empty() && run_git(&target, &["cat-file", "-e", &format!("HEAD:{}", prefix.trim())], &[], 256, ctx.platform).await?.code != 0 {
        return Ok(json!({ "isRepo": false }));
    }
    let top = clean_native_path(ctx.platform, &std::fs::canonicalize(top_out.stdout.trim()).unwrap_or_else(|_| PathBuf::from(top_out.stdout.trim())));
    let dirty = run_git(&top, &["status", "--porcelain", "--untracked-files=no"], &[], 4096, ctx.platform).await?;
    Ok(json!({ "isRepo": true, "root": format_client_path(ctx.platform, &contained.canonical_root), "target": format_client_path(ctx.platform, &target), "repo": format_client_path(ctx.platform, &top), "head": head_out.stdout.trim(), "dirty": !dirty.stdout.trim().is_empty() }))
}

#[allow(clippy::too_many_arguments)]
async fn worktree_create(
    ctx: &OpContext, repo: &str, root: &str, head: &str, branch: &str, target: Option<&str>,
    directory: Option<&str>, destination: Option<&str>, worktree_name: Option<&str>, main_project_id: Option<&str>,
) -> Result<Value, RpcCallError> {
    let (repo_dir, root_dir) = (require_existing_dir(ctx.platform, repo)?, require_existing_dir(ctx.platform, root)?);
    let (head, branch) = (validate_git_ref(head, "head")?, validate_git_ref(branch, "branch")?);
    let target_dir = if let Some(raw_t) = target.map(str::trim).filter(|s| !s.is_empty()) {
        require_existing_dir(ctx.platform, raw_t)?
    } else if let Some(raw_d) = directory.map(str::trim).filter(|s| !s.is_empty()) {
        clean_native_path(ctx.platform, &std::fs::canonicalize(&resolve_contained_details(root, Some(raw_d), ctx.platform, true, false)?.full_path)?)
    } else { root_dir.clone() };
    let dest = if let Some(raw_dest) = destination.map(str::trim).filter(|s| !s.is_empty()) {
        clean_native_path(ctx.platform, Path::new(&assert_client_path(ctx.platform, raw_dest)?))
    } else {
        let wt_name = validate_safe_segment(worktree_name.unwrap_or("worktree"), "worktreeName")?;
        let base = if !ctx.homedir.trim().is_empty() {
            let mut p = PathBuf::from(assert_client_path(ctx.platform, &ctx.homedir)?).join(".clinavat").join("worktrees");
            if let Some(pid) = main_project_id.map(str::trim).filter(|s| !s.is_empty()) { p.push(validate_safe_segment(pid, "mainProjectId")?); }
            p
        } else { root_dir.join(".clinavat").join("worktrees") };
        base.join(wt_name)
    };
    validate_worktree_cleanup_path(&dest, &repo_dir, Some(&root_dir))?;
    if let Some(parent) = dest.parent() { std::fs::create_dir_all(parent)?; }
    let dest_str = format_client_path(ctx.platform, &dest);
    if dest.exists() {
        let _ = run_git(&repo_dir, &["worktree", "remove", "--force", &dest_str], &[], 4096, ctx.platform).await;
        if dest.exists() { let _ = std::fs::remove_dir_all(&dest); }
    }
    let _ = run_git(&repo_dir, &["worktree", "prune"], &[], 4096, ctx.platform).await;
    let add = run_git(&repo_dir, &["-c", NULL_HOOKS_CFG, "worktree", "add", "-q", "-b", branch, &dest_str, head], &[], MAX_GIT_STDERR_BYTES, ctx.platform).await?;
    if add.code != 0 { return Err(RpcCallError::new(RpcErrorCode::Conflict, format!("git worktree add failed: {}", first_non_empty(&add.stderr, &add.stdout)))); }
    let wt_canon = clean_native_path(ctx.platform, &std::fs::canonicalize(&dest)?);
    copy_worktree_includes(&repo_dir, &wt_canon, ctx.platform).await;
    let (project_root, child_dir) = match root_dir.strip_prefix(&repo_dir) {
        Ok(rel) => (if rel.as_os_str().is_empty() { wt_canon.clone() } else { wt_canon.join(rel) }, rel_posix_opt(&root_dir, &target_dir)),
        Err(_) => (wt_canon.clone(), rel_posix_opt(&repo_dir, &target_dir)),
    };
    Ok(json!({ "worktreePath": format_client_path(ctx.platform, &wt_canon), "projectRoot": format_client_path(ctx.platform, &project_root), "childDirectory": child_dir }))
}

async fn copy_worktree_includes(repo_dir: &Path, wt_dir: &Path, platform: ClientPlatform) {
    if !repo_dir.join(".worktreeinclude").is_file() { return; }
    let Ok(listed) = run_git(repo_dir, &["ls-files", "-z", "--others", "--ignored", "--exclude-from=.worktreeinclude"], &[], MAX_GIT_STATUS_BYTES, platform).await else { return };
    if listed.code != 0 { return; }
    let (repo_str, wt_str) = (format_client_path(platform, repo_dir), format_client_path(platform, wt_dir));
    for rel in listed.stdout.split('\0').filter(|s| !s.is_empty()) {
        let Ok(src) = resolve_contained_details(&repo_str, Some(rel), platform, false, true) else { continue };
        let Ok((mut f, _)) = open_read_nofollow(&src.full_path) else { continue };
        let Ok(meta) = f.metadata() else { continue };
        if !meta.file_type().is_file() || meta.len() > MAX_SYNC_FILE_BYTES { continue; }
        let Ok(dst) = resolve_contained_details(&wt_str, Some(&src.rel_path), platform, false, true) else { continue };
        let segs: Vec<&str> = dst.rel_path.split('/').collect();
        let parent = if segs.len() > 1 {
            let Ok(p) = ensure_dirs_contained(&dst.canonical_root, &segs[..segs.len() - 1], platform) else { continue };
            p
        } else { dst.canonical_root.clone() };
        if std::fs::symlink_metadata(&dst.full_path).is_ok_and(|dm| is_symlink_or_reparse(&dst.full_path, &dm) || dm.is_dir()) { continue; }
        let Ok((tmp_path, mut tmp_file)) = create_temp_in_dir(&parent, "wtinc") else { continue };
        let ok = std::io::copy(&mut f, &mut tmp_file).is_ok() && tmp_file.sync_all().is_ok();
        drop(tmp_file);
        if ok { let _ = atomic_replace_file(&dst.canonical_root, &dst.full_path, &tmp_path, platform, Some(unix_mode(&meta))); }
        else { let _ = std::fs::remove_file(&tmp_path); }
    }
}

async fn worktree_commit(ctx: &OpContext, wt_path: &str, base: &str, message: &str) -> Result<Value, RpcCallError> {
    let (wt_dir, base) = (require_existing_dir(ctx.platform, wt_path)?, validate_git_ref(base, "base")?);
    let id_env = fallback_identity_env(&wt_dir, ctx.platform).await;
    let status = run_git(&wt_dir, &["status", "--porcelain"], &[], MAX_GIT_STATUS_BYTES, ctx.platform).await?;
    if status.code != 0 { return Err(RpcCallError::new(RpcErrorCode::InternalError, first_non_empty(&status.stderr, &status.stdout))); }
    if !status.stdout.trim().is_empty() {
        let add = run_git(&wt_dir, &["add", "-A"], &id_env, 4096, ctx.platform).await?;
        if add.code != 0 { return Err(RpcCallError::new(RpcErrorCode::InternalError, first_non_empty(&add.stderr, &add.stdout))); }
        let msg = if message.trim().is_empty() { "clinavat: worktree changes" } else { message };
        let commit = run_git(&wt_dir, &["-c", NULL_HOOKS_CFG, "commit", "-q", "--no-verify", "-m", msg], &id_env, 8192, ctx.platform).await?;
        if commit.code != 0 { return Err(RpcCallError::new(RpcErrorCode::Conflict, first_non_empty(&commit.stderr, &commit.stdout))); }
    }
    let range = format!("{base}..HEAD");
    let count: u64 = run_git(&wt_dir, &["rev-list", "--count", &range], &[], 256, ctx.platform).await?.stdout.trim().parse().unwrap_or(0);
    let stat_out = run_git(&wt_dir, &["diff", "--stat", &range], &[], MAX_GIT_STATUS_BYTES, ctx.platform).await?;
    let lines: Vec<&str> = stat_out.stdout.lines().collect();
    let tail = if lines.len() > 40 { &lines[lines.len() - 40..] } else { &lines[..] };
    Ok(json!({ "commitCount": count, "diffStat": tail.join("\n") }))
}

async fn worktree_merge(ctx: &OpContext, repo: &str, branch: &str, mode: &str, on_conflict: &str, message: &str) -> Result<Value, RpcCallError> {
    let (repo_dir, branch) = (require_existing_dir(ctx.platform, repo)?, validate_git_ref(branch, "branch")?);
    if mode != "merge" && mode != "squash" { return Err(RpcCallError::invalid(format!("unsupported merge mode: {mode}"))); }
    if on_conflict != "abort" && on_conflict != "leave" { return Err(RpcCallError::invalid(format!("unsupported onConflict: {on_conflict}"))); }
    let id_env = fallback_identity_env(&repo_dir, ctx.platform).await;
    let msg = if message.trim().is_empty() { "clinavat: merge worktree" } else { message };
    let res = if mode == "squash" {
        let sq = run_git(&repo_dir, &["-c", NULL_HOOKS_CFG, "merge", "--squash", branch], &id_env, 16_384, ctx.platform).await?;
        if sq.code == 0 { run_git(&repo_dir, &["-c", NULL_HOOKS_CFG, "commit", "-q", "--no-verify", "-m", msg], &id_env, 16_384, ctx.platform).await? } else { sq }
    } else { run_git(&repo_dir, &["-c", NULL_HOOKS_CFG, "merge", "--no-ff", "--no-verify", "-m", msg, branch], &id_env, 16_384, ctx.platform).await? };
    if res.code == 0 {
        let head = run_git(&repo_dir, &["rev-parse", "HEAD"], &[], 256, ctx.platform).await?;
        return Ok(json!({ "status": "merged", "commit": head.stdout.trim(), "files": [], "detail": "" }));
    }
    let detail = tail_chars(first_non_empty(&res.stderr, &res.stdout), 2000);
    let conflicted = run_git(&repo_dir, &["diff", "--name-only", "--diff-filter=U"], &[], MAX_GIT_STATUS_BYTES, ctx.platform).await?;
    let files: Vec<String> = conflicted.stdout.lines().map(str::trim).filter(|s| !s.is_empty()).map(str::to_string).collect();
    if files.is_empty() {
        let _ = run_git(&repo_dir, &["merge", "--abort"], &[], 4096, ctx.platform).await;
        return Ok(json!({ "status": "failed", "files": [], "detail": detail }));
    }
    if on_conflict == "abort" && run_git(&repo_dir, &["merge", "--abort"], &[], 4096, ctx.platform).await.map(|r| r.code != 0).unwrap_or(true) {
        let _ = run_git(&repo_dir, &["reset", "--merge"], &[], 4096, ctx.platform).await;
    }
    Ok(json!({ "status": "conflict", "files": files, "detail": detail }))
}

async fn worktree_remove(ctx: &OpContext, repo: &str, wt_path: &str, branch: &str) -> Result<Value, RpcCallError> {
    let repo_dir = require_existing_dir(ctx.platform, repo)?;
    let wt_norm = clean_native_path(ctx.platform, Path::new(&assert_client_path(ctx.platform, wt_path.trim())?));
    let branch = validate_git_ref(branch, "branch")?;
    validate_worktree_cleanup_path(&wt_norm, &repo_dir, None)?;
    let wt_str = format_client_path(ctx.platform, &wt_norm);
    if run_git(&repo_dir, &["worktree", "remove", "--force", &wt_str], &[], 4096, ctx.platform).await.map(|r| r.code != 0).unwrap_or(true) && wt_norm.exists() {
        let _ = std::fs::remove_dir_all(&wt_norm);
    }
    let _ = run_git(&repo_dir, &["worktree", "prune"], &[], 4096, ctx.platform).await;
    let _ = run_git(&repo_dir, &["branch", "-D", branch], &[], 4096, ctx.platform).await;
    Ok(json!({ "ok": true }))
}

fn rel_posix_opt(base: &Path, target: &Path) -> Option<String> {
    let parts: Vec<&str> = target.strip_prefix(base).ok()?.components().filter_map(|c| match c { Component::Normal(s) => s.to_str(), _ => None }).collect();
    if parts.is_empty() { None } else { Some(parts.join("/")) }
}
fn first_non_empty<'a>(a: &'a str, b: &'a str) -> &'a str { let ta = a.trim(); if !ta.is_empty() { ta } else { b.trim() } }
fn tail_chars(text: &str, max_chars: usize) -> String {
    let count = text.chars().count();
    if count <= max_chars { text.to_string() } else { text.chars().skip(count - max_chars).collect() }
}
