use std::path::{Component, Path, PathBuf};

use thiserror::Error;

pub const MAX_PATH_LENGTH: usize = 4096;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClientPlatform {
    Windows,
    MacOs,
    Linux,
}

impl ClientPlatform {
    pub fn current() -> Self {
        #[cfg(target_os = "windows")]
        { Self::Windows }
        #[cfg(target_os = "macos")]
        { Self::MacOs }
        #[cfg(not(any(target_os = "windows", target_os = "macos")))]
        { Self::Linux }
    }

    pub fn parse(raw: &str) -> Self {
        let lower = raw.trim().to_ascii_lowercase();
        if lower == "win32" || lower == "windows" || lower.starts_with("win") {
            Self::Windows
        } else if lower == "darwin" || lower == "macos" || lower == "osx" || lower.starts_with("mac") {
            Self::MacOs
        } else {
            Self::Linux
        }
    }
}

#[derive(Debug, Error)]
pub enum PathGuardError {
    #[error("invalid path: {0}")]
    InvalidArgument(String),
    #[error("access denied: {0}")]
    AccessDenied(String),
    #[error("path not found: {0}")]
    NotFound(String),
    #[error("filesystem error: {0}")]
    Io(#[from] std::io::Error),
}

pub fn is_invisible_segment_char(c: char) -> bool {
    matches!(c, '\u{200B}'..='\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2060}' | '\u{206A}'..='\u{206F}' | '\u{FEFF}')
}

fn is_protected_short_name(base: &str) -> bool {
    let rest = base.strip_prefix('.').unwrap_or(base);
    let Some((prefix, tail)) = rest.split_once('~') else { return false };
    if !prefix.eq_ignore_ascii_case("git") && !prefix.eq_ignore_ascii_case("bin") { return false; }
    let digits = tail.split('.').next().unwrap_or("");
    !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit())
}

/// Matches `.git`/`.bin` across case, NTFS ADS (`:stream`), invisible chars, trailing dots/spaces, and 8.3 short names.
pub fn is_protected_internal_segment(segment: &str) -> bool {
    let cleaned: String = segment.chars().filter(|c| !is_invisible_segment_char(*c)).collect();
    let base = cleaned.split(':').next().unwrap_or(&cleaned);
    let lower = base.to_ascii_lowercase();
    if lower == ".git" || lower == ".bin" { return true; }
    let stripped = lower.trim_end_matches(|c| c == '.' || c == ' ');
    stripped == ".git" || stripped == ".bin" || is_protected_short_name(base)
}

fn is_windows_illegal_char(c: char) -> bool {
    (c as u32) < 0x20 || matches!(c, '<' | '>' | ':' | '"' | '\\' | '|' | '?' | '*')
}

fn is_windows_reserved_name(segment: &str) -> bool {
    let upper = segment.split('.').next().unwrap_or("").to_ascii_uppercase();
    if matches!(upper.as_str(), "CON" | "PRN" | "AUX" | "NUL") { return true; }
    upper.len() == 4
        && (upper.starts_with("COM") || upper.starts_with("LPT"))
        && (b'1'..=b'9').contains(&upper.as_bytes()[3])
}

/// Validates and normalizes an absolute path on a client host, matching `path-utils.ts::assertClientPath`.
pub fn assert_client_path(platform: ClientPlatform, raw: &str) -> Result<String, PathGuardError> {
    if raw.is_empty() || raw.len() > MAX_PATH_LENGTH || raw.bytes().any(|b| b == 0 || b == b'\r' || b == b'\n') {
        return Err(PathGuardError::InvalidArgument("client path is empty, too long, or contains control characters".into()));
    }
    if platform == ClientPlatform::Windows {
        if raw.starts_with("\\\\") || raw.starts_with("//") {
            return Err(PathGuardError::InvalidArgument("Windows UNC and device paths are not allowed".into()));
        }
        let bytes = raw.as_bytes();
        if bytes.len() < 3 || !bytes[0].is_ascii_alphabetic() || bytes[1] != b':' || (bytes[2] != b'\\' && bytes[2] != b'/') {
            return Err(PathGuardError::InvalidArgument("Windows path must start with a drive root like C:\\".into()));
        }
        let drive = (bytes[0] as char).to_ascii_uppercase();
        let mut segments = Vec::new();
        for seg in raw[3..].split(|c| c == '\\' || c == '/') {
            if seg.is_empty() || seg == "." { continue; }
            if seg == ".." { return Err(PathGuardError::InvalidArgument("path must not contain parent traversal (..)".into())); }
            if seg.chars().any(|c| (c as u32) < 0x20) || seg.contains(':') {
                return Err(PathGuardError::InvalidArgument(format!("Windows path segment contains illegal character: {seg}")));
            }
            segments.push(seg);
        }
        return Ok(if segments.is_empty() { format!("{drive}:\\") } else { format!("{drive}:\\{}", segments.join("\\")) });
    }
    if !raw.starts_with('/') {
        return Err(PathGuardError::InvalidArgument("POSIX path must be absolute".into()));
    }
    let mut segments = Vec::new();
    for seg in raw.split('/') {
        if seg.is_empty() || seg == "." { continue; }
        if seg == ".." { return Err(PathGuardError::InvalidArgument("path must not contain parent traversal (..)".into())); }
        if seg.chars().any(|c| (c as u32) < 0x20 || c == '\x7f') {
            return Err(PathGuardError::InvalidArgument("path contains control characters".into()));
        }
        segments.push(seg);
    }
    Ok(if segments.is_empty() { "/".into() } else { format!("/{}", segments.join("/")) })
}

/// Normalizes and validates a project-relative POSIX path, matching `path-utils.ts::normalizeRelativePath`.
pub fn normalize_relative_path(
    raw: Option<&str>, allow_empty: bool, allow_internal: bool, platform: ClientPlatform,
) -> Result<String, PathGuardError> {
    let value = raw.unwrap_or("").trim();
    if value.is_empty() || value == "." {
        return if allow_empty { Ok(String::new()) } else { Err(PathGuardError::InvalidArgument("relative path must not be empty".into())) };
    }
    if value.starts_with('/') || value.contains('\\') || value.len() > MAX_PATH_LENGTH
        || value.chars().any(|c| (c as u32) <= 0x1F || c == '\x7f')
    {
        return Err(PathGuardError::InvalidArgument("relative path format is invalid".into()));
    }
    let mut segments = Vec::new();
    for seg in value.split('/').filter(|s| !s.is_empty()) {
        if seg == "." || seg == ".." {
            return Err(PathGuardError::InvalidArgument("relative path must not contain . or ..".into()));
        }
        if platform == ClientPlatform::Windows && seg.contains(':') {
            return Err(PathGuardError::InvalidArgument(format!("Windows relative segment cannot contain colon: {seg}")));
        }
        if !allow_internal && is_protected_internal_segment(seg) {
            return Err(PathGuardError::AccessDenied(format!("protected internal segment rejected: {seg}")));
        }
        segments.push(seg);
    }
    if segments.is_empty() {
        return if allow_empty { Ok(String::new()) } else { Err(PathGuardError::InvalidArgument("relative path must not be empty".into())) };
    }
    Ok(segments.join("/"))
}

/// Validates filename portability for the target client OS, matching `path-utils.ts::assertPortableFilename`.
pub fn assert_portable_filename(platform: ClientPlatform, rel_path: &str) -> Result<(), PathGuardError> {
    if rel_path.is_empty() || rel_path.starts_with('/') || rel_path.ends_with('/') || rel_path.contains('\0') {
        return Err(PathGuardError::InvalidArgument(format!("invalid filename path: {rel_path}")));
    }
    for seg in rel_path.split('/') {
        if seg.is_empty() || seg == "." || seg == ".." {
            return Err(PathGuardError::InvalidArgument(format!("invalid path segment in: {rel_path}")));
        }
        if is_protected_internal_segment(seg) {
            return Err(PathGuardError::AccessDenied(format!("cannot write protected segment: {rel_path}")));
        }
        if platform == ClientPlatform::Windows {
            if seg.chars().any(is_windows_illegal_char) {
                return Err(PathGuardError::InvalidArgument(format!("Windows illegal filename character in: {rel_path}")));
            }
            if seg.ends_with(' ') || seg.ends_with('.') {
                return Err(PathGuardError::InvalidArgument(format!("Windows filename cannot end with space or dot: {rel_path}")));
            }
            if is_windows_reserved_name(seg) {
                return Err(PathGuardError::InvalidArgument(format!("Windows reserved device name in: {rel_path}")));
            }
        }
    }
    Ok(())
}

fn canonical_is_within(candidate: &Path, root: &Path, platform: ClientPlatform) -> bool {
    let strip = |p: &Path| -> Vec<String> {
        p.components().filter_map(|c| match c {
            Component::Prefix(pre) => {
                let s = pre.as_os_str().to_string_lossy();
                let t = s.strip_prefix("\\\\?\\").unwrap_or(&s);
                Some(if platform == ClientPlatform::Windows { t.to_ascii_lowercase() } else { t.to_string() })
            }
            Component::RootDir => Some("/".to_string()),
            Component::Normal(part) => {
                let s = part.to_string_lossy();
                Some(if platform == ClientPlatform::Windows { s.to_ascii_lowercase() } else { s.to_string() })
            }
            _ => None,
        }).collect()
    };
    let root_parts = strip(root);
    let cand_parts = strip(candidate);
    cand_parts.len() >= root_parts.len() && cand_parts[..root_parts.len()] == root_parts[..]
}

/// Returns true if `meta` is a symlink or (on Windows) a name-surrogate reparse point (symlink / mount point / junction).
/// Non-surrogate reparse points such as OneDrive cloud placeholders (`IO_REPARSE_TAG_CLOUD*`) are allowed.
pub fn is_symlink_or_reparse(path: &Path, meta: &std::fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if (meta.file_attributes() & 0x0400) == 0 { return false; }
        if meta.file_type().is_symlink() { return true; }
        windows_is_name_surrogate_reparse(path)
    }
    #[cfg(not(windows))]
    {
        let _ = path;
        meta.file_type().is_symlink()
    }
}

#[cfg(windows)]
fn windows_is_name_surrogate_reparse(path: &Path) -> bool {
    use std::os::windows::ffi::OsStrExt;
    #[repr(C)]
    struct TagInfo { file_attributes: u32, reparse_tag: u32 }
    #[link(name = "kernel32")]
    extern "system" {
        fn CreateFileW(n: *const u16, a: u32, s: u32, sec: *const u8, d: u32, f: u32, t: isize) -> isize;
        fn GetFileInformationByHandleEx(h: isize, c: i32, buf: *mut u8, sz: u32) -> i32;
        fn CloseHandle(h: isize) -> i32;
    }
    let mut wide: Vec<u16> = path.as_os_str().encode_wide().collect();
    wide.push(0);
    // FILE_READ_ATTRIBUTES (0x80), FILE_SHARE_READ|WRITE|DELETE (7), OPEN_EXISTING (3), BACKUP_SEMANTICS|OPEN_REPARSE_POINT.
    let h = unsafe { CreateFileW(wide.as_ptr(), 0x80, 7, std::ptr::null(), 3, 0x0220_0000, 0) };
    if h == -1 { return true; }
    let mut info = TagInfo { file_attributes: 0, reparse_tag: 0 };
    let ok = unsafe { GetFileInformationByHandleEx(h, 9, (&mut info as *mut TagInfo).cast(), 8) };
    unsafe { CloseHandle(h); }
    ok == 0 || (info.reparse_tag & 0x2000_0000) != 0
}

/// Verified workspace-contained path along with its canonical root and normalized POSIX relative path.
#[derive(Debug, Clone)]
pub struct ContainedPath {
    pub canonical_root: PathBuf,
    pub rel_path: String,
    pub full_path: PathBuf,
}

/// Re-verifies that `candidate` (e.g. a parent directory before atomic commit) canonicalizes inside `canonical_root`.
pub fn verify_canonical_within(canonical_root: &Path, candidate: &Path, platform: ClientPlatform) -> Result<PathBuf, PathGuardError> {
    let canonical = std::fs::canonicalize(candidate)?;
    if !canonical_is_within(&canonical, canonical_root, platform) {
        return Err(PathGuardError::AccessDenied("resolved path escapes workspace root".into()));
    }
    Ok(canonical)
}

fn resolve_contained_inner(
    root: &str, rel_path: Option<&str>, platform: ClientPlatform,
    allow_empty: bool, for_write: bool, allow_leaf_symlink: bool,
) -> Result<ContainedPath, PathGuardError> {
    let normalized_root = assert_client_path(platform, root)?;
    let canonical_root = std::fs::canonicalize(&normalized_root).map_err(|err| {
        if err.kind() == std::io::ErrorKind::NotFound { PathGuardError::NotFound(normalized_root.clone()) } else { PathGuardError::Io(err) }
    })?;
    let clean_rel = normalize_relative_path(rel_path, allow_empty, false, platform)?;
    if clean_rel.is_empty() {
        return Ok(ContainedPath { full_path: canonical_root.clone(), canonical_root, rel_path: clean_rel });
    }
    if for_write { assert_portable_filename(platform, &clean_rel)?; }

    let segments: Vec<&str> = clean_rel.split('/').collect();
    let mut cursor = canonical_root.clone();
    let mut deepest_existing = canonical_root.clone();
    let mut still_exists = true;
    for (idx, seg) in segments.iter().enumerate() {
        let is_leaf = idx + 1 == segments.len();
        cursor.push(seg);
        if still_exists {
            match std::fs::symlink_metadata(&cursor) {
                Ok(meta) => {
                    if is_symlink_or_reparse(&cursor, &meta) {
                        if allow_leaf_symlink && is_leaf { continue; }
                        return Err(PathGuardError::AccessDenied(format!("symlink traversal is forbidden: {clean_rel}")));
                    }
                    deepest_existing = cursor.clone();
                }
                Err(err) if err.kind() == std::io::ErrorKind::NotFound => still_exists = false,
                Err(err) => return Err(PathGuardError::Io(err)),
            }
        }
    }
    verify_canonical_within(&canonical_root, &deepest_existing, platform)?;
    Ok(ContainedPath { canonical_root, rel_path: clean_rel, full_path: cursor })
}

/// Resolves `rel_path` strictly inside `root`, rejecting `..`, protected internal segments, and symlink escapes.
pub fn resolve_contained_details(
    root: &str, rel_path: Option<&str>, platform: ClientPlatform, allow_empty: bool, for_write: bool,
) -> Result<ContainedPath, PathGuardError> {
    resolve_contained_inner(root, rel_path, platform, allow_empty, for_write, false)
}

/// Resolves `rel_path` inside `root` for metadata queries (`fs.stat` / `fs.list`): ancestors must be real
/// directories inside `root`, while the leaf entry itself may be a symlink inspected via `symlink_metadata`.
pub fn resolve_contained_path_for_stat(
    root: &str, rel_path: Option<&str>, platform: ClientPlatform, allow_empty: bool,
) -> Result<ContainedPath, PathGuardError> {
    resolve_contained_inner(root, rel_path, platform, allow_empty, false, true)
}

/// Convenience wrapper returning only the resolved filesystem path (strictly rejecting symlinks).
pub fn resolve_contained_path(
    root: &str, rel_path: Option<&str>, platform: ClientPlatform, allow_empty: bool, for_write: bool,
) -> Result<PathBuf, PathGuardError> {
    Ok(resolve_contained_details(root, rel_path, platform, allow_empty, for_write)?.full_path)
}

/// Strips Windows extended-length `\\?\` / `\\?\UNC\` prefixes so `cmd.exe`, PTY, and `git` accept the path (`H5`).
pub fn clean_native_path(platform: ClientPlatform, path: &Path) -> PathBuf {
    if platform != ClientPlatform::Windows {
        return path.to_path_buf();
    }
    let raw = path.to_string_lossy();
    if let Some(unc) = raw.strip_prefix("\\\\?\\UNC\\") {
        PathBuf::from(format!("\\\\{unc}"))
    } else if let Some(stripped) = raw.strip_prefix("\\\\?\\") {
        PathBuf::from(stripped)
    } else {
        path.to_path_buf()
    }
}

/// Formats a canonical filesystem path into a Hub-accepted client path (stripping Windows `\\?\` prefix).
pub fn format_client_path(platform: ClientPlatform, path: &Path) -> String {
    let cleaned = clean_native_path(platform, path);
    let raw = cleaned.to_string_lossy();
    assert_client_path(platform, &raw).unwrap_or_else(|_| raw.into_owned())
}
