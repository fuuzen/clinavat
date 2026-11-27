pub mod apply;
pub mod codex;
pub mod parse;
pub mod paths;

use std::collections::{HashMap, HashSet};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use serde::Deserialize;
use serde_json::{json, Value};

use crate::ops::fs_common::{
    atomic_replace_file, create_temp_in_dir, ensure_dirs_contained_tracked, open_read_nofollow,
    same_physical_file, unix_mode,
};
use crate::ops::fs_staging::build_unified_diff;
use crate::ops::patch::apply::{apply_codex_op, apply_unified_op};
use crate::ops::patch::parse::{parse_patch, CodexOp, PatchFileOp};
use crate::ops::{OpContext, RpcCallError, RpcErrorCode};
use crate::path_guard::{is_symlink_or_reparse, resolve_contained_details, ClientPlatform, ContainedPath};

const MAX_PATCH_BYTES: usize = 4 * 1024 * 1024;
const MAX_PATCH_TARGET_FILE_BYTES: u64 = 16 * 1024 * 1024;

#[derive(Debug, Deserialize)]
struct ApplyPatchParams {
    root: String,
    patch: String,
    #[serde(rename = "dryRun")]
    dry_run: Option<bool>,
}

type OriginalsMap = HashMap<String, Option<(Vec<u8>, Option<u32>)>>;
type VirtualFs = HashMap<String, Option<String>>;
type VirtualModes = HashMap<String, Option<u32>>;

struct FileBackup {
    full_path: PathBuf,
    original: Option<(Vec<u8>, Option<u32>)>,
}

pub async fn handle_apply_patch(params: Option<Value>, ctx: &OpContext) -> Result<Value, RpcCallError> {
    let input: ApplyPatchParams = serde_json::from_value(params.unwrap_or(Value::Null))
        .map_err(|e| RpcCallError::invalid(e.to_string()))?;
    if input.patch.trim().is_empty() || input.patch.len() > MAX_PATCH_BYTES {
        return Err(RpcCallError::invalid("patch payload is empty or exceeds size limit"));
    }
    let dry_run = input.dry_run.unwrap_or(false);
    let platform = ctx.platform;
    let cancel = ctx.cancel.clone();

    tokio::task::spawn_blocking(move || -> Result<Value, RpcCallError> {
        if cancel.is_cancelled() {
            return Err(RpcCallError::new(RpcErrorCode::InternalError, "cancelled"));
        }
        let ops = parse_patch(&input.patch)?;

        // Step 1: validate EVERY declared source & target path through path_guard and collect order-preserving `files`.
        let mut resolved_map: HashMap<String, ContainedPath> = HashMap::new();
        let mut affected_files: Vec<String> = Vec::new();
        let mut seen_files: HashSet<String> = HashSet::new();
        let mut candidate_case_renames: Vec<(String, String)> = Vec::new();
        let mut canonical_root: Option<PathBuf> = None;

        let mut validate_path = |raw: &str, record_in_files: bool| -> Result<String, RpcCallError> {
            let contained = resolve_contained_details(&input.root, Some(raw), platform, false, true)?;
            if canonical_root.is_none() {
                canonical_root = Some(contained.canonical_root.clone());
            }
            let rel = contained.rel_path.clone();
            resolved_map.entry(rel.clone()).or_insert(contained);
            if record_in_files && seen_files.insert(rel.clone()) {
                affected_files.push(rel.clone());
            }
            Ok(rel)
        };

        for op in &ops {
            match op {
                PatchFileOp::Unified(u) => {
                    for hp in &u.header_paths { let _ = validate_path(hp, false)?; }
                    let old_rel = u.old_path.as_deref().map(|p| validate_path(p, true)).transpose()?;
                    let new_rel = u.new_path.as_deref().map(|p| validate_path(p, true)).transpose()?;
                    if !u.is_copy {
                        if let (Some(o), Some(n)) = (old_rel, new_rel) {
                            if o != n && o.eq_ignore_ascii_case(&n) { candidate_case_renames.push((o, n)); }
                        }
                    }
                }
                PatchFileOp::Codex(c) => match c {
                    CodexOp::Add { path, .. } | CodexOp::Delete { path } => { let _ = validate_path(path, true)?; }
                    CodexOp::Update { path, move_to, .. } => {
                        let o = validate_path(path, true)?;
                        if let Some(dest) = move_to {
                            let n = validate_path(dest, true)?;
                            if o != n && o.eq_ignore_ascii_case(&n) { candidate_case_renames.push((o, n)); }
                        }
                    }
                },
            }
        }
        drop(validate_path);
        let mut same_file_case_renames: HashSet<String> = HashSet::new();
        for (o, n) in candidate_case_renames {
            // Only treat as an in-place case rename when both paths resolve to the SAME physical file (H-new).
            if same_physical_file(&resolved_map[&o].full_path, &resolved_map[&n].full_path) {
                same_file_case_renames.insert(n);
            }
        }
        let canonical_root = canonical_root.ok_or_else(|| RpcCallError::invalid("patch declares no files"))?;

        // Step 2: snapshot existing files in memory without following symlinks or blocking on FIFOs.
        let (originals, mut virtual_fs, mut virtual_modes) = snapshot_files(&resolved_map, &same_file_case_renames)?;

        // Step 3: apply all operations purely in memory (zero disk side effects on any mismatch).
        let mut total_hunks = 0usize;
        for op in &ops {
            if cancel.is_cancelled() {
                return Err(RpcCallError::new(RpcErrorCode::InternalError, "cancelled"));
            }
            match op {
                PatchFileOp::Unified(u) => {
                    total_hunks += apply_unified_op(u, &mut virtual_fs, &mut virtual_modes, &same_file_case_renames, &input.root, platform)?;
                }
                PatchFileOp::Codex(c) => {
                    total_hunks += apply_codex_op(c, &mut virtual_fs, &mut virtual_modes, &same_file_case_renames, &input.root, platform)?;
                }
            }
        }

        // Step 4: build unified diff preview covering every affected file.
        let mut diff_parts = Vec::new();
        for rel in &affected_files {
            let before_str = originals.get(rel).and_then(|opt| opt.as_ref())
                .and_then(|(bytes, _)| std::str::from_utf8(bytes).ok());
            let after_str = virtual_fs.get(rel).and_then(|opt| opt.as_deref());
            if before_str != after_str {
                diff_parts.push(build_unified_diff(rel, before_str, after_str));
            }
        }
        let preview_diff = diff_parts.join("\n");

        if dry_run {
            return Ok(json!({ "ok": true, "files": affected_files, "diff": preview_diff, "hunks": total_hunks }));
        }

        // Step 5: 2-phase transactional commit with full temp/dir cleanup and rollback on any failure.
        commit_patch_transaction(
            &canonical_root, &affected_files, &resolved_map, &originals, &virtual_fs, &virtual_modes, platform,
        )?;
        Ok(json!({ "ok": true, "files": affected_files, "diff": preview_diff, "hunks": total_hunks }))
    })
    .await
    .map_err(|e| RpcCallError::new(RpcErrorCode::InternalError, format!("apply_patch task failed: {e}")))?
}

fn snapshot_files(
    resolved_map: &HashMap<String, ContainedPath>,
    case_rename_targets: &HashSet<String>,
) -> Result<(OriginalsMap, VirtualFs, VirtualModes), RpcCallError> {
    let mut originals: OriginalsMap = HashMap::new();
    let mut virtual_fs: VirtualFs = HashMap::new();
    let mut virtual_modes: VirtualModes = HashMap::new();
    for (rel, contained) in resolved_map {
        if case_rename_targets.contains(rel) {
            originals.insert(rel.clone(), None);
            virtual_fs.insert(rel.clone(), None);
            virtual_modes.insert(rel.clone(), None);
            continue;
        }
        match std::fs::symlink_metadata(&contained.full_path) {
            Ok(meta) => {
                if is_symlink_or_reparse(&contained.full_path, &meta) {
                    return Err(RpcCallError::new(RpcErrorCode::Eacces, format!("cannot patch symlink: {rel}")));
                }
                if meta.is_dir() {
                    return Err(RpcCallError::new(RpcErrorCode::Eisdir, format!("cannot patch directory: {rel}")));
                }
                if !meta.file_type().is_file() {
                    return Err(RpcCallError::new(RpcErrorCode::Eacces, format!("cannot patch non-regular file: {rel}")));
                }
                if meta.len() > MAX_PATCH_TARGET_FILE_BYTES {
                    return Err(RpcCallError::invalid(format!("target file exceeds 16 MiB patch limit: {rel}")));
                }
                let (mut file, opened_meta) = open_read_nofollow(&contained.full_path)?;
                let mut buf = Vec::with_capacity(opened_meta.len() as usize);
                file.read_to_end(&mut buf)?;
                if buf.contains(&0) {
                    return Err(RpcCallError::invalid(format!("cannot patch binary file: {rel}")));
                }
                let text = String::from_utf8(buf.clone())
                    .map_err(|_| RpcCallError::invalid(format!("target file is not valid UTF-8: {rel}")))?;
                let mode = Some(unix_mode(&opened_meta));
                originals.insert(rel.clone(), Some((buf, mode)));
                virtual_fs.insert(rel.clone(), Some(text));
                virtual_modes.insert(rel.clone(), mode);
            }
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                originals.insert(rel.clone(), None);
                virtual_fs.insert(rel.clone(), None);
                virtual_modes.insert(rel.clone(), None);
            }
            Err(err) => return Err(RpcCallError::from(err)),
        }
    }
    Ok((originals, virtual_fs, virtual_modes))
}

fn cleanup_temps_and_dirs(staged_temps: HashMap<String, (PathBuf, Option<u32>)>, created_dirs: Vec<PathBuf>) {
    for (_, (tp, _)) in staged_temps {
        let _ = std::fs::remove_file(tp);
    }
    for dir in created_dirs.into_iter().rev() {
        let _ = std::fs::remove_dir(dir);
    }
}

fn commit_patch_transaction(
    canonical_root: &Path,
    affected_files: &[String],
    resolved_map: &HashMap<String, ContainedPath>,
    originals: &OriginalsMap,
    virtual_fs: &VirtualFs,
    virtual_modes: &VirtualModes,
    platform: ClientPlatform,
) -> Result<(), RpcCallError> {
    // Phase A: create needed parent dirs (tracked for cleanup) and stage all writes into same-dir temp files.
    let mut staged_temps: HashMap<String, (PathBuf, Option<u32>)> = HashMap::new();
    let mut created_dirs: Vec<PathBuf> = Vec::new();
    for rel in affected_files {
        let Some(Some(new_text)) = virtual_fs.get(rel) else { continue };
        let segments: Vec<&str> = rel.split('/').collect();
        let parent = if segments.len() > 1 {
            match ensure_dirs_contained_tracked(canonical_root, &segments[..segments.len() - 1], platform) {
                Ok((dir, newly_created)) => {
                    created_dirs.extend(newly_created);
                    dir
                }
                Err(err) => {
                    cleanup_temps_and_dirs(staged_temps, created_dirs);
                    return Err(err);
                }
            }
        } else {
            canonical_root.to_path_buf()
        };
        let (temp_path, mut file) = match create_temp_in_dir(&parent, "patch") {
            Ok(pair) => pair,
            Err(err) => {
                cleanup_temps_and_dirs(staged_temps, created_dirs);
                return Err(err);
            }
        };
        if let Err(err) = file.write_all(new_text.as_bytes()).and_then(|_| file.sync_all()) {
            drop(file);
            let _ = std::fs::remove_file(&temp_path);
            cleanup_temps_and_dirs(staged_temps, created_dirs);
            return Err(RpcCallError::from(err));
        }
        let target_mode = virtual_modes
            .get(rel)
            .copied()
            .flatten()
            .or_else(|| originals.get(rel).and_then(|o| o.as_ref()).and_then(|(_, m)| *m));
        staged_temps.insert(rel.clone(), (temp_path, target_mode));
    }

    // Phase B: delete removed/renamed sources before replacing targets (supports case-only renames on APFS/NTFS).
    let mut ordered: Vec<&String> = affected_files
        .iter()
        .filter(|rel| virtual_fs.get(*rel).is_some_and(Option::is_none))
        .collect();
    ordered.extend(affected_files.iter().filter(|rel| virtual_fs.get(*rel).is_some_and(Option::is_some)));

    let mut applied: Vec<FileBackup> = Vec::new();
    let mut commit_err: Option<RpcCallError> = None;

    for rel in ordered {
        let contained = &resolved_map[rel];
        let backup = FileBackup {
            full_path: contained.full_path.clone(),
            original: originals.get(rel).cloned().flatten(),
        };
        let step_res: Result<(), RpcCallError> = if let Some((temp_path, mode)) = staged_temps.remove(rel) {
            atomic_replace_file(canonical_root, &contained.full_path, &temp_path, platform, mode).map(|_| ())
        } else if virtual_fs.get(rel).is_some_and(Option::is_none) && backup.original.is_some() {
            std::fs::remove_file(&contained.full_path).map_err(RpcCallError::from)
        } else {
            Ok(())
        };
        match step_res {
            Ok(()) => applied.push(backup),
            Err(err) => {
                commit_err = Some(err);
                break;
            }
        }
    }

    if let Some(err) = commit_err {
        for (_, (tp, _)) in staged_temps { let _ = std::fs::remove_file(tp); }
        for backup in applied.into_iter().rev() {
            match backup.original {
                Some((orig_bytes, orig_mode)) => {
                    if let Some(parent) = backup.full_path.parent() {
                        if let Ok((tp, mut f)) = create_temp_in_dir(parent, "rollback") {
                            if f.write_all(&orig_bytes).and_then(|_| f.sync_all()).is_ok() {
                                drop(f);
                                let _ = atomic_replace_file(canonical_root, &backup.full_path, &tp, platform, orig_mode);
                            } else {
                                let _ = std::fs::remove_file(tp);
                            }
                        }
                    }
                }
                None => { let _ = std::fs::remove_file(&backup.full_path); }
            }
        }
        for dir in created_dirs.into_iter().rev() {
            let _ = std::fs::remove_dir(dir);
        }
        return Err(err);
    }
    Ok(())
}
