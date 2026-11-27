use std::collections::HashMap;
use std::path::Path;
use std::process::{Command as StdCommand, Stdio};

use globset::{GlobBuilder, GlobMatcher};

use crate::path_guard::{clean_native_path, is_protected_internal_segment, ClientPlatform};

const MAX_GIT_IGNORED_ENTRIES: usize = 8192;

struct IgnoreRule {
    index: usize,
    matcher: GlobMatcher,
    negated: bool,
    dir_only: bool,
    leaf: bool,
}

/// Faithful port of `backend/src/runtime/sync-scan.ts::IgnoreMatcher` (last matching rule wins).
pub struct SyncIgnoreMatcher {
    literals: HashMap<String, usize>,
    rules: Vec<IgnoreRule>,
    dir_cache: HashMap<String, bool>,
}

impl SyncIgnoreMatcher {
    pub fn new(patterns: &[String]) -> Self {
        let mut literals = HashMap::new();
        let mut rules = Vec::new();
        for (index, raw) in patterns.iter().enumerate() {
            let mut pat = raw.as_str();
            let negated = pat.starts_with('!');
            if negated { pat = &pat[1..]; }
            let anchored = pat.starts_with('/');
            if anchored { pat = &pat[1..]; }
            let dir_only = pat.ends_with('/');
            if dir_only { pat = &pat[..pat.len() - 1]; }
            if pat.is_empty() { continue; }
            if anchored && !negated && !dir_only && !pat.contains(['*', '?', '[', '{']) {
                literals.insert(pat.replace('\\', ""), index);
                continue;
            }
            if let Ok(glob) = GlobBuilder::new(pat).literal_separator(true).build() {
                rules.push(IgnoreRule {
                    index,
                    matcher: glob.compile_matcher(),
                    negated,
                    dir_only,
                    leaf: !anchored && !pat.contains('/'),
                });
            }
        }
        Self { literals, rules, dir_cache: HashMap::new() }
    }

    fn matches_own(&self, rel: &str, is_dir: bool) -> bool {
        let best = self.literals.get(rel).copied().map(|i| i as isize).unwrap_or(-1);
        let leaf_name = rel.rsplit('/').next().unwrap_or(rel);
        for rule in self.rules.iter().rev() {
            if (rule.index as isize) < best { break; }
            if rule.dir_only && !is_dir { continue; }
            if rule.matcher.is_match(rel) || (rule.leaf && rule.matcher.is_match(leaf_name)) {
                return !rule.negated;
            }
        }
        best >= 0
    }

    fn dir_ignored(&mut self, rel: &str) -> bool {
        if let Some(&cached) = self.dir_cache.get(rel) { return cached; }
        let parent_ign = rel.rfind('/').map(|i| self.dir_ignored(&rel[..i])).unwrap_or(false);
        let ignored = parent_ign || self.matches_own(rel, true);
        self.dir_cache.insert(rel.to_string(), ignored);
        ignored
    }

    pub fn is_ignored(&mut self, rel: &str, is_dir: bool) -> bool {
        if rel.split('/').any(is_protected_internal_segment) { return true; }
        if let Some(i) = rel.rfind('/') {
            if self.dir_ignored(&rel[..i]) { return true; }
        }
        if is_dir { self.dir_ignored(rel) } else { self.matches_own(rel, false) }
    }
}

pub fn collect_git_ignored(root_dir: &Path, platform: ClientPlatform) -> Vec<String> {
    let cwd = clean_native_path(platform, root_dir);
    let mut cmd = StdCommand::new("git");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let Ok(out) = cmd
        .current_dir(&cwd)
        .args([
            "--no-optional-locks",
            "-c",
            "status.renames=false",
            "-c",
            "core.quotepath=false",
            "status",
            "--porcelain=v1",
            "--ignored=matching",
            "--untracked-files=normal",
            "-z",
        ])
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
    else {
        return Vec::new();
    };
    if !out.status.success() { return Vec::new(); }
    String::from_utf8_lossy(&out.stdout)
        .split('\0')
        .filter_map(|e| e.strip_prefix("!! "))
        .filter(|p| !p.is_empty())
        .take(MAX_GIT_IGNORED_ENTRIES)
        .map(str::to_string)
        .collect()
}
