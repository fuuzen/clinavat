use crate::ops::patch::parse::{is_strict_unified_hunk, CodexChunk, CodexOp, PatchFileOp};
use crate::ops::patch::paths::parse_single_patch_path;
use crate::ops::{RpcCallError, RpcErrorCode};

const BEGIN_PATCH: &str = "*** Begin Patch";
const END_PATCH: &str = "*** End Patch";

/// Parses a Codex `*** Begin Patch` ... `*** End Patch` payload with strict fail-closed validation.
pub fn parse_codex_patch(lines: &[&str]) -> Result<Vec<PatchFileOp>, RpcCallError> {
    let mut idx = 0usize;
    while idx < lines.len() && lines[idx].trim().is_empty() {
        idx += 1;
    }
    if idx >= lines.len() || lines[idx].trim() != BEGIN_PATCH {
        return Err(RpcCallError::invalid("Codex patch must start with '*** Begin Patch'"));
    }
    idx += 1;

    let mut ops = Vec::new();
    let mut saw_end = false;

    while idx < lines.len() {
        let line = lines[idx];
        let trimmed = line.trim();
        if trimmed == END_PATCH {
            saw_end = true;
            idx += 1;
            break;
        }
        if trimmed.is_empty() {
            idx += 1;
            continue;
        }
        if line.starts_with("diff --") || line.starts_with("--- ") || line.starts_with("+++ ") {
            return Err(RpcCallError::invalid("patch cannot mix unified diff and Codex apply_patch formats"));
        }
        if let Some(raw_path) = strip_codex_header(line, "Add File:") {
            let path = parse_codex_path(raw_path)?;
            idx += 1;
            let mut added = Vec::new();
            while idx < lines.len() {
                let cur = lines[idx];
                if is_codex_directive(cur) { break; }
                if let Some(rest) = cur.strip_prefix('+') {
                    added.push(rest.to_string());
                    idx += 1;
                } else {
                    return Err(RpcCallError::invalid(format!("Add File line must start with '+': {cur}")));
                }
            }
            ops.push(PatchFileOp::Codex(CodexOp::Add { path, lines: added }));
            continue;
        }
        if let Some(raw_path) = strip_codex_header(line, "Delete File:") {
            let path = parse_codex_path(raw_path)?;
            idx += 1;
            ops.push(PatchFileOp::Codex(CodexOp::Delete { path }));
            continue;
        }
        if let Some(raw_path) = strip_codex_header(line, "Update File:") {
            let path = parse_codex_path(raw_path)?;
            idx += 1;
            let mut move_to: Option<String> = None;
            if idx < lines.len() {
                if let Some(raw_dest) = strip_codex_header(lines[idx], "Move to:") {
                    move_to = Some(parse_codex_path(raw_dest)?);
                    idx += 1;
                }
            }
            let mut chunks = Vec::new();
            while idx < lines.len() {
                let cur = lines[idx];
                if is_codex_directive(cur) { break; }
                if is_strict_unified_hunk(cur) {
                    return Err(RpcCallError::invalid("patch cannot mix unified diff hunks into Codex apply_patch"));
                }
                if cur == "@@" || cur.starts_with("@@ ") {
                    let hint = cur.strip_prefix("@@ ").map(str::to_string).filter(|s| !s.is_empty());
                    idx += 1;
                    let mut old_lines = Vec::new();
                    let mut new_lines = Vec::new();
                    let mut is_eof = false;
                    while idx < lines.len() {
                        let body = lines[idx];
                        if body.trim() == "*** End of File" {
                            is_eof = true;
                            idx += 1;
                            break;
                        }
                        if is_codex_directive(body) || body == "@@" || body.starts_with("@@ ") {
                            break;
                        }
                        if let Some(rest) = body.strip_prefix(' ') {
                            old_lines.push(rest.to_string());
                            new_lines.push(rest.to_string());
                        } else if body.is_empty() {
                            old_lines.push(String::new());
                            new_lines.push(String::new());
                        } else if let Some(rest) = body.strip_prefix('-') {
                            old_lines.push(rest.to_string());
                        } else if let Some(rest) = body.strip_prefix('+') {
                            new_lines.push(rest.to_string());
                        } else {
                            return Err(RpcCallError::invalid(format!("unexpected Codex patch body line: {body}")));
                        }
                        idx += 1;
                    }
                    chunks.push(CodexChunk { hint, old_lines, new_lines, is_eof });
                } else {
                    return Err(RpcCallError::invalid(format!("expected '@@' chunk header in Update File: {cur}")));
                }
            }
            if chunks.is_empty() && move_to.is_none() {
                return Err(RpcCallError::invalid(format!("Update File '{path}' has no chunks or Move to")));
            }
            ops.push(PatchFileOp::Codex(CodexOp::Update { path, move_to, chunks }));
            continue;
        }
        return Err(RpcCallError::invalid(format!("unsupported Codex patch line: {line}")));
    }

    if !saw_end {
        return Err(RpcCallError::invalid("Codex patch is missing '*** End Patch'"));
    }
    while idx < lines.len() {
        if !lines[idx].trim().is_empty() {
            return Err(RpcCallError::invalid("unexpected trailing content after '*** End Patch'"));
        }
        idx += 1;
    }
    if ops.is_empty() {
        return Err(RpcCallError::new(RpcErrorCode::InvalidArgument, "patch declares no file operations"));
    }
    Ok(ops)
}

fn strip_codex_header<'a>(line: &'a str, label: &str) -> Option<&'a str> {
    let trimmed = line.trim_start();
    let after_stars = trimmed.strip_prefix("***")?.trim_start();
    after_stars.strip_prefix(label)
}

fn is_codex_directive(line: &str) -> bool {
    let trimmed = line.trim();
    trimmed == END_PATCH
        || trimmed == BEGIN_PATCH
        || strip_codex_header(line, "Add File:").is_some()
        || strip_codex_header(line, "Update File:").is_some()
        || strip_codex_header(line, "Delete File:").is_some()
        || strip_codex_header(line, "Move to:").is_some()
}

fn parse_codex_path(raw: &str) -> Result<String, RpcCallError> {
    let parsed = parse_single_patch_path(raw, false, false)?;
    parsed.ok_or_else(|| RpcCallError::invalid("Codex patch directive is missing a file path"))
}
