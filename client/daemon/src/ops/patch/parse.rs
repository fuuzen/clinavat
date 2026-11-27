use crate::ops::patch::codex::parse_codex_patch;
use crate::ops::patch::paths::{parse_git_diff_header, parse_single_patch_path};
use crate::ops::{RpcCallError, RpcErrorCode};

#[derive(Debug, Clone)]
pub enum PatchFileOp {
    Unified(UnifiedFileOp),
    Codex(CodexOp),
}

#[derive(Debug, Clone)]
pub enum CodexOp {
    Add { path: String, lines: Vec<String> },
    Delete { path: String },
    Update { path: String, move_to: Option<String>, chunks: Vec<CodexChunk> },
}

#[derive(Debug, Clone)]
pub struct CodexChunk {
    pub hint: Option<String>,
    pub old_lines: Vec<String>,
    pub new_lines: Vec<String>,
    pub is_eof: bool,
}

#[derive(Debug, Clone)]
pub struct UnifiedFileOp {
    pub header_paths: Vec<String>,
    pub old_path: Option<String>,
    pub new_path: Option<String>,
    pub is_rename: bool,
    pub is_copy: bool,
    pub is_new_file: bool,
    pub is_deleted_file: bool,
    pub new_mode: Option<u32>,
    pub hunks: Vec<UnifiedHunk>,
}

#[derive(Debug, Clone)]
pub struct UnifiedHunk {
    pub old_start: usize,
    pub old_count: usize,
    pub new_start: usize,
    pub new_count: usize,
    pub lines: Vec<HunkLine>,
    pub old_no_newline: bool,
    pub new_no_newline: bool,
}

#[derive(Debug, Clone)]
pub enum HunkLine {
    Context(String),
    Remove(String),
    Add(String),
}

/// Parses either a Unified Diff or a Codex `*** Begin Patch` payload, rejecting mixed or binary patches.
pub fn parse_patch(patch: &str) -> Result<Vec<PatchFileOp>, RpcCallError> {
    let lines: Vec<&str> = patch.split('\n').map(|l| l.strip_suffix('\r').unwrap_or(l)).collect();
    // Only treat the payload as Codex format when its first non-empty line is `*** Begin Patch` (M6).
    let first_non_empty = lines.iter().map(|l| l.trim()).find(|l| !l.is_empty());
    if first_non_empty == Some("*** Begin Patch") {
        return parse_codex_patch(&lines);
    }
    parse_unified_patch(&lines)
}

/// Strict single-space unified hunk header `@@ -l[,s] +l[,s] @@`, aligned with `patch-paths.ts`.
pub fn parse_strict_unified_hunk(line: &str) -> Option<(usize, usize, usize, usize)> {
    let rest = line.strip_prefix("@@ -")?;
    let (old_spec, after_old) = rest.split_once(" +")?;
    let (new_spec, _) = after_old.split_once(" @@")?;
    let (old_start, old_count) = parse_hunk_range(old_spec)?;
    let (new_start, new_count) = parse_hunk_range(new_spec)?;
    Some((old_start, old_count, new_start, new_count))
}

pub fn is_strict_unified_hunk(line: &str) -> bool {
    parse_strict_unified_hunk(line).is_some()
}

fn parse_hunk_range(spec: &str) -> Option<(usize, usize)> {
    if spec.is_empty() { return None; }
    if let Some((start_s, count_s)) = spec.split_once(',') {
        if start_s.is_empty() || count_s.is_empty()
            || !start_s.bytes().all(|b| b.is_ascii_digit())
            || !count_s.bytes().all(|b| b.is_ascii_digit())
        {
            return None;
        }
        Some((start_s.parse().ok()?, count_s.parse().ok()?))
    } else {
        if !spec.bytes().all(|b| b.is_ascii_digit()) { return None; }
        Some((spec.parse().ok()?, 1))
    }
}

fn parse_git_mode(raw: &str) -> Result<Option<u32>, RpcCallError> {
    let token = raw.trim();
    if token.is_empty() { return Ok(None); }
    let parsed = u32::from_str_radix(token, 8)
        .map_err(|_| RpcCallError::invalid(format!("invalid git file mode: {token}")))?;
    let file_type = parsed & 0o170000;
    if file_type == 0o120000 {
        return Err(RpcCallError::new(RpcErrorCode::Eacces, "symlink mode (120000) is forbidden in patch"));
    }
    if file_type == 0o160000 {
        return Err(RpcCallError::new(RpcErrorCode::Eacces, "gitlink submodule mode (160000) is forbidden in patch"));
    }
    if file_type == 0o100000 {
        return Ok(Some(parsed & 0o777));
    }
    Err(RpcCallError::invalid(format!("unsupported git file mode: {token}")))
}

fn is_codex_outer_directive(line: &str) -> bool {
    let trimmed = line.trim();
    trimmed == "*** Begin Patch"
        || trimmed == "*** End Patch"
        || trimmed.starts_with("*** Add File:")
        || trimmed.starts_with("*** Update File:")
        || trimmed.starts_with("*** Delete File:")
        || trimmed.starts_with("*** Move to:")
}

fn new_empty_op() -> UnifiedFileOp {
    UnifiedFileOp {
        header_paths: Vec::new(), old_path: None, new_path: None,
        is_rename: false, is_copy: false, is_new_file: false, is_deleted_file: false,
        new_mode: None, hunks: Vec::new(),
    }
}

fn parse_unified_patch(lines: &[&str]) -> Result<Vec<PatchFileOp>, RpcCallError> {
    let mut ops: Vec<UnifiedFileOp> = Vec::new();
    let mut current: Option<UnifiedFileOp> = None;
    let mut idx = 0usize;

    let push_unique = |vec: &mut Vec<String>, item: String| {
        if !vec.contains(&item) { vec.push(item); }
    };

    while idx < lines.len() {
        let line = lines[idx];
        if is_codex_outer_directive(line) {
            return Err(RpcCallError::invalid("patch cannot mix unified diff and Codex apply_patch formats"));
        }
        if line == "GIT binary patch" || (line.starts_with("Binary files ") && line.ends_with(" differ")) {
            return Err(RpcCallError::invalid("binary patches are not supported"));
        }
        if line.starts_with("diff --") && !(line == "diff --git" || line.starts_with("diff --git ") || line.starts_with("diff --git\t")) {
            return Err(RpcCallError::invalid(format!("unsupported diff header: {line}")));
        }
        if line.starts_with("diff --git ") || line.starts_with("diff --git\t") || line == "diff --git" {
            if let Some(op) = current.take() { ops.push(op); }
            let (lhs, rhs, all) = parse_git_diff_header(line)?;
            let mut op = new_empty_op();
            op.header_paths = all;
            op.old_path = Some(lhs);
            op.new_path = Some(rhs);
            current = Some(op);
            idx += 1;
            continue;
        }
        if let Some(raw) = line.strip_prefix("--- ") {
            if current.as_ref().is_some_and(|op| !op.hunks.is_empty()) {
                ops.push(current.take().unwrap());
            }
            let parsed = parse_single_patch_path(raw, true, true)?;
            let op = current.get_or_insert_with(new_empty_op);
            op.old_path = parsed.clone();
            if parsed.is_none() { op.is_new_file = true; }
            if let Some(p) = parsed { push_unique(&mut op.header_paths, p); }
            idx += 1;
            continue;
        }
        if let Some(raw) = line.strip_prefix("+++ ") {
            let parsed = parse_single_patch_path(raw, true, true)?;
            let op = current.as_mut().ok_or_else(|| RpcCallError::invalid("unexpected '+++' without preceding file header"))?;
            op.new_path = parsed.clone();
            if parsed.is_none() { op.is_deleted_file = true; }
            if let Some(p) = parsed { push_unique(&mut op.header_paths, p); }
            idx += 1;
            continue;
        }
        if line.starts_with("rename ") || line.starts_with("copy ") {
            let op = current.as_mut().ok_or_else(|| RpcCallError::invalid("unexpected rename/copy header"))?;
            if let Some(raw) = line.strip_prefix("rename from ") {
                let p = parse_single_patch_path(raw, false, false)?.ok_or_else(|| RpcCallError::invalid("missing rename from path"))?;
                op.is_rename = true; op.old_path = Some(p.clone()); push_unique(&mut op.header_paths, p);
            } else if let Some(raw) = line.strip_prefix("rename to ") {
                let p = parse_single_patch_path(raw, false, false)?.ok_or_else(|| RpcCallError::invalid("missing rename to path"))?;
                op.is_rename = true; op.new_path = Some(p.clone()); push_unique(&mut op.header_paths, p);
            } else if let Some(raw) = line.strip_prefix("copy from ") {
                let p = parse_single_patch_path(raw, false, false)?.ok_or_else(|| RpcCallError::invalid("missing copy from path"))?;
                op.is_copy = true; op.old_path = Some(p.clone()); push_unique(&mut op.header_paths, p);
            } else if let Some(raw) = line.strip_prefix("copy to ") {
                let p = parse_single_patch_path(raw, false, false)?.ok_or_else(|| RpcCallError::invalid("missing copy to path"))?;
                op.is_copy = true; op.new_path = Some(p.clone()); push_unique(&mut op.header_paths, p);
            } else {
                return Err(RpcCallError::invalid(format!("unsupported rename/copy header: {line}")));
            }
            idx += 1;
            continue;
        }
        if let Some(raw_mode) = line.strip_prefix("new file mode ") {
            let parsed_mode = parse_git_mode(raw_mode)?;
            if let Some(op) = current.as_mut() {
                op.is_new_file = true;
                op.old_path = None;
                op.new_mode = parsed_mode;
            }
            idx += 1;
            continue;
        }
        if let Some(raw_mode) = line.strip_prefix("new mode ") {
            let parsed_mode = parse_git_mode(raw_mode)?;
            if let Some(op) = current.as_mut() {
                op.new_mode = parsed_mode;
            }
            idx += 1;
            continue;
        }
        if let Some(raw_mode) = line.strip_prefix("old mode ") {
            let _ = parse_git_mode(raw_mode)?;
            idx += 1;
            continue;
        }
        if let Some(raw_mode) = line.strip_prefix("deleted file mode ") {
            let _ = parse_git_mode(raw_mode)?;
            if let Some(op) = current.as_mut() { op.is_deleted_file = true; op.new_path = None; }
            idx += 1;
            continue;
        }
        if line.starts_with("@@") {
            let (old_start, old_count, new_start, new_count) = parse_strict_unified_hunk(line)
                .ok_or_else(|| RpcCallError::invalid(format!("malformed unified hunk header: {line}")))?;
            let op = current.as_mut().ok_or_else(|| RpcCallError::invalid("hunk encountered before file header"))?;
            idx += 1;
            let (mut old_rem, mut new_rem) = (old_count, new_count);
            let mut hunk_lines = Vec::new();
            let (mut old_no_nl, mut new_no_nl) = (false, false);
            let mut last_kind: Option<u8> = None;
            while old_rem > 0 || new_rem > 0 {
                if idx >= lines.len() { return Err(RpcCallError::invalid("unified hunk is truncated")); }
                let body = lines[idx];
                if body.starts_with('\\') {
                    mark_no_newline(last_kind, &mut old_no_nl, &mut new_no_nl);
                    idx += 1;
                    continue;
                }
                if let Some(rest) = body.strip_prefix(' ') {
                    if old_rem == 0 || new_rem == 0 { return Err(RpcCallError::invalid("hunk context exceeds declared count")); }
                    old_rem -= 1; new_rem -= 1; last_kind = Some(b' ');
                    hunk_lines.push(HunkLine::Context(rest.to_string()));
                } else if body.is_empty() {
                    if old_rem == 0 || new_rem == 0 { return Err(RpcCallError::invalid("hunk empty context exceeds declared count")); }
                    old_rem -= 1; new_rem -= 1; last_kind = Some(b' ');
                    hunk_lines.push(HunkLine::Context(String::new()));
                } else if let Some(rest) = body.strip_prefix('-') {
                    if old_rem == 0 { return Err(RpcCallError::invalid("hunk deletion exceeds declared count")); }
                    old_rem -= 1; last_kind = Some(b'-');
                    hunk_lines.push(HunkLine::Remove(rest.to_string()));
                } else if let Some(rest) = body.strip_prefix('+') {
                    if new_rem == 0 { return Err(RpcCallError::invalid("hunk addition exceeds declared count")); }
                    new_rem -= 1; last_kind = Some(b'+');
                    hunk_lines.push(HunkLine::Add(rest.to_string()));
                } else {
                    return Err(RpcCallError::invalid(format!("unexpected hunk body line: {body}")));
                }
                idx += 1;
            }
            while idx < lines.len() && lines[idx].starts_with('\\') {
                mark_no_newline(last_kind, &mut old_no_nl, &mut new_no_nl);
                idx += 1;
            }
            op.hunks.push(UnifiedHunk {
                old_start, old_count, new_start, new_count,
                lines: hunk_lines, old_no_newline: old_no_nl, new_no_newline: new_no_nl,
            });
            continue;
        }
        idx += 1;
    }

    if let Some(op) = current.take() { ops.push(op); }
    if ops.is_empty() {
        return Err(RpcCallError::invalid("patch declares no file operations"));
    }
    Ok(ops.into_iter().map(PatchFileOp::Unified).collect())
}

fn mark_no_newline(last_kind: Option<u8>, old_no_nl: &mut bool, new_no_nl: &mut bool) {
    match last_kind {
        Some(b'-') => *old_no_nl = true,
        Some(b'+') => *new_no_nl = true,
        Some(b' ') => { *old_no_nl = true; *new_no_nl = true; }
        _ => {}
    }
}
