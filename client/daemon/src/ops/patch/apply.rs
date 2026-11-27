use std::collections::{HashMap, HashSet};

use crate::ops::patch::parse::{CodexChunk, CodexOp, HunkLine, UnifiedFileOp, UnifiedHunk};
use crate::ops::{RpcCallError, RpcErrorCode};
use crate::path_guard::{resolve_contained_details, ClientPlatform};

fn norm_rel(root: &str, raw: &str, platform: ClientPlatform) -> Result<String, RpcCallError> {
    Ok(resolve_contained_details(root, Some(raw), platform, false, true)?.rel_path)
}

fn resolve_git_target_mode(git_mode: u32) -> u32 {
    #[cfg(unix)]
    {
        crate::ops::fs_common::default_new_file_mode((git_mode & 0o111) != 0)
    }
    #[cfg(not(unix))]
    {
        git_mode & 0o777
    }
}

pub fn apply_unified_op(
    op: &UnifiedFileOp,
    vfs: &mut HashMap<String, Option<String>>,
    vmodes: &mut HashMap<String, Option<u32>>,
    same_file_case_renames: &HashSet<String>,
    root: &str,
    platform: ClientPlatform,
) -> Result<usize, RpcCallError> {
    let old_rel = op.old_path.as_deref().map(|p| norm_rel(root, p, platform)).transpose()?;
    let new_rel = op.new_path.as_deref().map(|p| norm_rel(root, p, platform)).transpose()?;

    if op.is_new_file || old_rel.is_none() {
        let dest = new_rel.ok_or_else(|| RpcCallError::invalid("add file op missing target path"))?;
        if vfs.get(&dest).and_then(|o| o.as_ref()).is_some() {
            return Err(RpcCallError::new(RpcErrorCode::Conflict, format!("file already exists: {dest}")));
        }
        let content = apply_unified_hunks("", &op.hunks, &dest)?;
        vfs.insert(dest.clone(), Some(content));
        let mode = op.new_mode.map(resolve_git_target_mode);
        vmodes.insert(dest, mode);
        return Ok(op.hunks.len().max(1));
    }
    if op.is_deleted_file || new_rel.is_none() {
        let src = old_rel.ok_or_else(|| RpcCallError::invalid("delete file op missing source path"))?;
        let existing = vfs.get(&src).and_then(|o| o.clone())
            .ok_or_else(|| RpcCallError::new(RpcErrorCode::Enoent, format!("file not found for delete: {src}")))?;
        if !op.hunks.is_empty() {
            let remaining = apply_unified_hunks(&existing, &op.hunks, &src)?;
            if !remaining.is_empty() {
                return Err(RpcCallError::new(RpcErrorCode::Conflict, format!("delete patch did not remove full content of {src}")));
            }
        }
        vfs.insert(src.clone(), None);
        vmodes.insert(src, None);
        return Ok(op.hunks.len().max(1));
    }
    let src = old_rel.unwrap();
    let dest = new_rel.unwrap();
    let existing = vfs.get(&src).and_then(|o| o.clone())
        .ok_or_else(|| RpcCallError::new(RpcErrorCode::Enoent, format!("file not found: {src}")))?;
    let is_same_physical_case_rename = src != dest && same_file_case_renames.contains(&dest);
    if src != dest && !is_same_physical_case_rename && vfs.get(&dest).and_then(|o| o.as_ref()).is_some() {
        return Err(RpcCallError::new(RpcErrorCode::Conflict, format!("destination file already exists: {dest}")));
    }
    let src_mode = vmodes.get(&src).copied().flatten();
    let updated = if op.hunks.is_empty() {
        existing
    } else {
        apply_unified_hunks(&existing, &op.hunks, &src)?
    };
    if src != dest && !op.is_copy {
        vfs.insert(src.clone(), None);
        vmodes.insert(src, None);
    }
    let dest_mode = op.new_mode.map(resolve_git_target_mode).or(src_mode);
    vfs.insert(dest.clone(), Some(updated));
    vmodes.insert(dest, dest_mode);
    Ok(op.hunks.len().max(1))
}

fn apply_unified_hunks(original: &str, hunks: &[UnifiedHunk], path: &str) -> Result<String, RpcCallError> {
    if hunks.is_empty() { return Ok(original.to_string()); }
    let uses_crlf = original.contains("\r\n");
    let orig_trailing_nl = original.ends_with('\n');
    let mut lines = split_lines_preserve_empty(original);
    let mut line_delta: isize = 0;
    let mut final_trailing_nl = if original.is_empty() { true } else { orig_trailing_nl };

    for hunk in hunks {
        let old_seq: Vec<&str> = hunk.lines.iter().filter_map(|l| match l {
            HunkLine::Context(s) | HunkLine::Remove(s) => Some(s.as_str()),
            HunkLine::Add(_) => None,
        }).collect();
        let new_seq: Vec<String> = hunk.lines.iter().filter_map(|l| match l {
            HunkLine::Context(s) | HunkLine::Add(s) => Some(s.clone()),
            HunkLine::Remove(_) => None,
        }).collect();

        let expected = if hunk.old_start == 0 {
            0usize
        } else {
            ((hunk.old_start as isize - 1) + line_delta).max(0) as usize
        };
        let pos = find_hunk_position(&lines, &old_seq, expected).ok_or_else(|| {
            RpcCallError::new(RpcErrorCode::Conflict, format!("hunk failed to apply in {path} at line {}", hunk.old_start))
        })?;
        lines.splice(pos..pos + old_seq.len(), new_seq.iter().cloned());
        line_delta += new_seq.len() as isize - old_seq.len() as isize;
        if hunk.new_no_newline {
            final_trailing_nl = false;
        } else if hunk.old_no_newline && !hunk.new_no_newline {
            final_trailing_nl = true;
        }
    }
    Ok(join_lines(&lines, final_trailing_nl, uses_crlf))
}

pub fn apply_codex_op(
    op: &CodexOp,
    vfs: &mut HashMap<String, Option<String>>,
    vmodes: &mut HashMap<String, Option<u32>>,
    same_file_case_renames: &HashSet<String>,
    root: &str,
    platform: ClientPlatform,
) -> Result<usize, RpcCallError> {
    match op {
        CodexOp::Add { path, lines } => {
            let rel = norm_rel(root, path, platform)?;
            if vfs.get(&rel).and_then(|o| o.as_ref()).is_some() {
                return Err(RpcCallError::new(RpcErrorCode::Conflict, format!("file already exists: {rel}")));
            }
            vfs.insert(rel.clone(), Some(join_lines(lines, !lines.is_empty(), false)));
            vmodes.insert(rel, None);
            Ok(1)
        }
        CodexOp::Delete { path } => {
            let rel = norm_rel(root, path, platform)?;
            if vfs.get(&rel).and_then(|o| o.as_ref()).is_none() {
                return Err(RpcCallError::new(RpcErrorCode::Enoent, format!("file not found for delete: {rel}")));
            }
            vfs.insert(rel.clone(), None);
            vmodes.insert(rel, None);
            Ok(1)
        }
        CodexOp::Update { path, move_to, chunks } => {
            let src = norm_rel(root, path, platform)?;
            let dest = match move_to {
                Some(d) => norm_rel(root, d, platform)?,
                None => src.clone(),
            };
            let existing = vfs.get(&src).and_then(|o| o.clone())
                .ok_or_else(|| RpcCallError::new(RpcErrorCode::Enoent, format!("file not found: {src}")))?;
            let is_same_physical_case_rename = src != dest && same_file_case_renames.contains(&dest);
            if src != dest && !is_same_physical_case_rename && vfs.get(&dest).and_then(|o| o.as_ref()).is_some() {
                return Err(RpcCallError::new(RpcErrorCode::Conflict, format!("destination file already exists: {dest}")));
            }
            let src_mode = vmodes.get(&src).copied().flatten();
            let updated = apply_codex_chunks(&existing, chunks, &src)?;
            if src != dest {
                vfs.insert(src.clone(), None);
                vmodes.insert(src, None);
            }
            vfs.insert(dest.clone(), Some(updated));
            vmodes.insert(dest, src_mode);
            Ok(chunks.len().max(1))
        }
    }
}

fn apply_codex_chunks(original: &str, chunks: &[CodexChunk], path: &str) -> Result<String, RpcCallError> {
    if chunks.is_empty() { return Ok(original.to_string()); }
    let uses_crlf = original.contains("\r\n");
    let trailing_nl = original.ends_with('\n') || original.is_empty();
    let mut lines = split_lines_preserve_empty(original);
    let mut cursor = 0usize;

    for chunk in chunks {
        let mut search_from = cursor;
        if let Some(hint) = &chunk.hint {
            if let Some(idx) = lines[search_from..].iter().position(|l| l == hint || l.trim() == hint.trim()) {
                search_from += idx;
            }
        }
        let old_refs: Vec<&str> = chunk.old_lines.iter().map(String::as_str).collect();
        // Strictly monotonic forward search from cursor to avoid matching earlier duplicate blocks (L6).
        let pos = if old_refs.is_empty() {
            if chunk.is_eof { lines.len() } else { search_from }
        } else {
            find_sequence_from(&lines, &old_refs, search_from, chunk.is_eof)
                .ok_or_else(|| RpcCallError::new(RpcErrorCode::Conflict, format!("Codex patch context not found in {path}")))?
        };
        lines.splice(pos..pos + old_refs.len(), chunk.new_lines.iter().cloned());
        cursor = pos + chunk.new_lines.len();
    }
    Ok(join_lines(&lines, trailing_nl, uses_crlf))
}

fn split_lines_preserve_empty(text: &str) -> Vec<String> {
    if text.is_empty() { return Vec::new(); }
    let trimmed = text.strip_suffix('\n').unwrap_or(text);
    trimmed.split('\n').map(|l| l.strip_suffix('\r').unwrap_or(l).to_string()).collect()
}

fn join_lines(lines: &[String], trailing_nl: bool, crlf: bool) -> String {
    if lines.is_empty() { return String::new(); }
    let sep = if crlf { "\r\n" } else { "\n" };
    let mut out = lines.join(sep);
    if trailing_nl { out.push_str(sep); }
    out
}

fn matches_at(lines: &[String], seq: &[&str], pos: usize) -> bool {
    pos + seq.len() <= lines.len() && lines[pos..pos + seq.len()].iter().zip(seq).all(|(a, b)| a == b)
}

fn find_hunk_position(lines: &[String], seq: &[&str], expected: usize) -> Option<usize> {
    if seq.is_empty() { return Some(expected.min(lines.len())); }
    if matches_at(lines, seq, expected) { return Some(expected); }
    let max_offset = lines.len();
    for delta in 1..=max_offset {
        if let Some(back) = expected.checked_sub(delta) {
            if matches_at(lines, seq, back) { return Some(back); }
        }
        let fwd = expected + delta;
        if fwd + seq.len() <= lines.len() && matches_at(lines, seq, fwd) { return Some(fwd); }
    }
    None
}

fn find_sequence_from(lines: &[String], seq: &[&str], start: usize, prefer_eof: bool) -> Option<usize> {
    if seq.len() > lines.len() || start > lines.len() - seq.len() { return None; }
    if prefer_eof {
        let eof_pos = lines.len() - seq.len();
        if eof_pos >= start && matches_at(lines, seq, eof_pos) { return Some(eof_pos); }
    }
    for pos in start..=(lines.len() - seq.len()) {
        if matches_at(lines, seq, pos) { return Some(pos); }
    }
    None
}
