use crate::ops::RpcCallError;

/// Decodes a Git C-style quoted path (`"..."`) using strict 3-digit octal `[0-3][0-7]{2}` & fatal UTF-8.
pub fn parse_git_quoted_path(raw: &str, start: usize) -> Result<(String, usize), RpcCallError> {
    let bytes_raw = raw.as_bytes();
    if bytes_raw.get(start) != Some(&b'"') {
        return Err(RpcCallError::invalid("quoted patch path must start with '\"'"));
    }
    let mut out = Vec::new();
    let mut i = start + 1;
    while i < bytes_raw.len() {
        match bytes_raw[i] {
            b'"' => {
                let text = String::from_utf8(out)
                    .map_err(|_| RpcCallError::invalid("quoted patch path contains invalid UTF-8 bytes"))?;
                if text.contains('\0') {
                    return Err(RpcCallError::invalid("patch path contains NUL byte"));
                }
                return Ok((text, i + 1));
            }
            b'\\' => {
                i += 1;
                if i >= bytes_raw.len() {
                    return Err(RpcCallError::invalid("unterminated escape in quoted patch path"));
                }
                let esc = bytes_raw[i];
                if (b'0'..=b'7').contains(&esc) {
                    if i + 3 > bytes_raw.len() {
                        return Err(RpcCallError::invalid("truncated octal escape in quoted patch path"));
                    }
                    let (d0, d1, d2) = (bytes_raw[i], bytes_raw[i + 1], bytes_raw[i + 2]);
                    if !(b'0'..=b'3').contains(&d0) || !(b'0'..=b'7').contains(&d1) || !(b'0'..=b'7').contains(&d2) {
                        return Err(RpcCallError::invalid("invalid 3-digit octal escape in quoted patch path"));
                    }
                    let val = ((d0 - b'0') << 6) | ((d1 - b'0') << 3) | (d2 - b'0');
                    if val == 0 {
                        return Err(RpcCallError::invalid("NUL octal escape \\000 is forbidden in patch path"));
                    }
                    out.push(val);
                    i += 3;
                } else {
                    let mapped = match esc {
                        b'\\' => b'\\', b'"' => b'"', b'a' => 0x07, b'b' => 0x08,
                        b'f' => 0x0c, b'n' => 0x0a, b'r' => 0x0d, b't' => 0x09, b'v' => 0x0b,
                        _ => return Err(RpcCallError::invalid(format!("unsupported escape in quoted patch path: \\{}", esc as char))),
                    };
                    out.push(mapped);
                    i += 1;
                }
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    Err(RpcCallError::invalid("unterminated quoted patch path"))
}

pub fn strip_diff_ab(value: &str, strip_ab: bool) -> Option<String> {
    if value.is_empty() || value == "/dev/null" { return None; }
    if strip_ab {
        if let Some(rest) = value.strip_prefix("a/").or_else(|| value.strip_prefix("b/")) {
            return Some(rest.to_string());
        }
    }
    Some(value.to_string())
}

pub fn parse_single_patch_path(raw: &str, strip_ab: bool, allow_timestamp_tab: bool) -> Result<Option<String>, RpcCallError> {
    if !allow_timestamp_tab && raw.contains('\t') {
        return Err(RpcCallError::invalid("patch path must not contain tab characters"));
    }
    let trimmed = raw.trim_start();
    if trimmed.is_empty() { return Ok(None); }
    if trimmed.starts_with('"') {
        let (value, next_idx) = parse_git_quoted_path(trimmed, 0)?;
        let tail = &trimmed[next_idx..];
        let tail_ok = if allow_timestamp_tab {
            tail.is_empty() || tail.starts_with('\t') || tail.chars().all(char::is_whitespace)
        } else {
            tail.is_empty() || tail.chars().all(char::is_whitespace)
        };
        if !tail_ok {
            return Err(RpcCallError::invalid("unexpected trailing characters after quoted patch path"));
        }
        if !allow_timestamp_tab && value.contains('\t') {
            return Err(RpcCallError::invalid("patch path must not contain tab characters"));
        }
        return Ok(strip_diff_ab(&value, strip_ab));
    }
    let value = if allow_timestamp_tab {
        trimmed.split('\t').next().unwrap_or("").trim()
    } else {
        trimmed.trim()
    };
    Ok(strip_diff_ab(value, strip_ab))
}

/// Fail-closed parser for `diff --git <lhs> <rhs>`, aligned with `backend/src/client-host/patch-paths.ts`.
pub fn parse_git_diff_header(line: &str) -> Result<(String, String, Vec<String>), RpcCallError> {
    let rest = line.strip_prefix("diff --git").unwrap_or("").trim_start_matches([' ', '\t']);
    if rest.is_empty() {
        return Err(RpcCallError::invalid("diff --git header is missing file paths"));
    }
    let extract_pair = |left: &str, right: &str| -> Result<(String, String), RpcCallError> {
        let l = strip_diff_ab(left, true).ok_or_else(|| RpcCallError::invalid("diff --git has empty source path"))?;
        let r = strip_diff_ab(right, true).ok_or_else(|| RpcCallError::invalid("diff --git has empty target path"))?;
        Ok((l, r))
    };
    if rest.starts_with('"') {
        let (l_val, next_idx) = parse_git_quoted_path(rest, 0)?;
        if rest.as_bytes().get(next_idx) != Some(&b' ') {
            return Err(RpcCallError::invalid("invalid separator in diff --git header"));
        }
        let right_raw = &rest[next_idx + 1..];
        if right_raw.is_empty() { return Err(RpcCallError::invalid("diff --git header missing target path")); }
        let r_val = if right_raw.starts_with('"') {
            let (rv, end_idx) = parse_git_quoted_path(right_raw, 0)?;
            if end_idx != right_raw.len() {
                return Err(RpcCallError::invalid("unexpected trailing content in diff --git header"));
            }
            rv
        } else {
            right_raw.to_string()
        };
        let (l, r) = extract_pair(&l_val, &r_val)?;
        let all = if l == r { vec![l.clone()] } else { vec![l.clone(), r.clone()] };
        return Ok((l, r, all));
    }
    if rest.ends_with('"') {
        let mut pairs = Vec::new();
        for (idx, _) in rest.match_indices(" \"") {
            if idx == 0 { continue; }
            if let Ok((r_val, end_idx)) = parse_git_quoted_path(rest, idx + 1) {
                if end_idx == rest.len() {
                    if let Ok(pair) = extract_pair(&rest[..idx], &r_val) {
                        pairs.push(pair);
                    }
                }
            }
        }
        if pairs.is_empty() {
            return Err(RpcCallError::invalid("unable to parse diff --git header paths"));
        }
        let mut all = Vec::new();
        for (l, r) in &pairs {
            if !all.contains(l) { all.push(l.clone()); }
            if !all.contains(r) { all.push(r.clone()); }
        }
        return Ok((pairs[0].0.clone(), pairs[0].1.clone(), all));
    }
    let mut ab_candidates = Vec::new();
    for (idx, b) in rest.bytes().enumerate() {
        if idx == 0 || idx + 1 >= rest.len() || b != b' ' { continue; }
        let (lhs, rhs) = (&rest[..idx], &rest[idx + 1..]);
        if lhs.starts_with("a/") && rhs.starts_with("b/") {
            ab_candidates.push((lhs, rhs));
        }
    }
    if !ab_candidates.is_empty() {
        let exact: Vec<_> = ab_candidates.iter().copied().filter(|(l, r)| l[2..] == r[2..]).collect();
        let chosen = if exact.len() == 1 { exact } else { ab_candidates };
        let mut all = Vec::new();
        let first = extract_pair(chosen[0].0, chosen[0].1)?;
        for (l, r) in chosen {
            let (pl, pr) = extract_pair(l, r)?;
            if !all.contains(&pl) { all.push(pl); }
            if !all.contains(&pr) { all.push(pr); }
        }
        return Ok((first.0, first.1, all));
    }
    if rest.len() >= 3 && rest.len() % 2 == 1 {
        let mid = (rest.len() - 1) / 2;
        if rest.as_bytes()[mid] == b' ' {
            let (lhs, rhs) = (&rest[..mid], &rest[mid + 1..]);
            if !lhs.is_empty() && lhs == rhs {
                return Ok((lhs.to_string(), rhs.to_string(), vec![lhs.to_string()]));
            }
        }
    }
    Err(RpcCallError::invalid("unable to parse diff --git header paths"))
}
