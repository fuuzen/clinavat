use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use rand::rngs::OsRng;
use rand::RngCore;

pub(crate) fn ensure_private_dir(dir: &Path) -> Result<(), std::io::Error> {
    fs::create_dir_all(dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(dir, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

/// Reads an existing private state file after verifying it is not a symlink and tightening Unix ownership/mode (`T2-M1`).
pub fn read_existing_private_string(path: &Path, label: &str) -> Result<Option<String>, std::io::Error> {
    let meta = match fs::symlink_metadata(path) {
        Ok(m) => m,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(err) => return Err(err),
    };
    if meta.file_type().is_symlink() || !meta.file_type().is_file() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("{label} must be a regular non-symlink file"),
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        let euid = unsafe { libc::geteuid() };
        if meta.uid() != euid {
            return Err(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                format!("{label} is not owned by current user"),
            ));
        }
        if (meta.mode() & 0o077) != 0 {
            fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
        }
    }
    let mut opts = OpenOptions::new();
    opts.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.custom_flags(libc::O_NOFOLLOW);
    }
    let mut file = opts.open(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let fmeta = file.metadata()?;
        if !fmeta.file_type().is_file() || fmeta.uid() != unsafe { libc::geteuid() } {
            return Err(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                format!("{label} failed post-open ownership verification"),
            ));
        }
    }
    let mut text = String::new();
    file.read_to_string(&mut text)?;
    Ok(Some(text))
}

struct TempFileGuard {
    path: Option<PathBuf>,
}

impl TempFileGuard {
    fn new(path: PathBuf) -> Self { Self { path: Some(path) } }
    fn disarm(&mut self) { self.path = None; }
}

impl Drop for TempFileGuard {
    fn drop(&mut self) {
        if let Some(path) = self.path.take() {
            let _ = fs::remove_file(path);
        }
    }
}

/// Stages bytes into a unique `0600` temp file; its `TempFileGuard` removes it on any subsequent failure (`T2-L1`).
fn write_staged_temp(path: &Path, data: &[u8]) -> Result<(PathBuf, TempFileGuard), std::io::Error> {
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    ensure_private_dir(parent)?;
    let mut suffix = [0u8; 6];
    OsRng.fill_bytes(&mut suffix);
    let tmp_name = format!(
        ".{}.tmp-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        path.file_name().and_then(|n| n.to_str()).unwrap_or("file"),
        suffix[0], suffix[1], suffix[2], suffix[3], suffix[4], suffix[5],
    );
    let tmp_path = parent.join(tmp_name);
    let mut opts = OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    let mut file = opts.open(&tmp_path)?;
    let guard = TempFileGuard::new(tmp_path.clone());
    file.write_all(data)?;
    file.sync_all()?;
    drop(file);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&tmp_path, fs::Permissions::from_mode(0o600))?;
    }
    Ok((tmp_path, guard))
}

#[cfg(windows)]
fn windows_move_file_ex(src: &Path, dst: &Path, replace_existing: bool) -> Result<(), std::io::Error> {
    use std::os::windows::ffi::OsStrExt;
    const MOVEFILE_REPLACE_EXISTING: u32 = 0x1;
    const MOVEFILE_WRITE_THROUGH: u32 = 0x8;
    #[link(name = "kernel32")]
    extern "system" {
        fn MoveFileExW(existing: *const u16, new: *const u16, flags: u32) -> i32;
    }
    let mut src_w: Vec<u16> = src.as_os_str().encode_wide().collect();
    src_w.push(0);
    let mut dst_w: Vec<u16> = dst.as_os_str().encode_wide().collect();
    dst_w.push(0);
    let flags = if replace_existing {
        MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH
    } else {
        MOVEFILE_WRITE_THROUGH
    };
    if unsafe { MoveFileExW(src_w.as_ptr(), dst_w.as_ptr(), flags) } == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

/// Atomically writes a private `0600` file, replacing any existing target (`T2-M3`, `T2-L1`).
pub fn write_private_file(path: &Path, data: &[u8]) -> Result<(), std::io::Error> {
    let (tmp_path, mut guard) = write_staged_temp(path, data)?;
    #[cfg(windows)]
    windows_move_file_ex(&tmp_path, path, true)?;
    #[cfg(not(windows))]
    fs::rename(&tmp_path, path)?;
    guard.disarm();
    Ok(())
}

/// Atomically publishes a new private `0600` file without overwriting an existing one (`T2-M2`); returns `Ok(false)` on race.
pub(crate) fn write_private_file_create_new(path: &Path, data: &[u8]) -> Result<bool, std::io::Error> {
    let (tmp_path, mut guard) = write_staged_temp(path, data)?;
    #[cfg(windows)]
    match windows_move_file_ex(&tmp_path, path, false) {
        Ok(()) => {
            guard.disarm();
            Ok(true)
        }
        Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => Ok(false),
        Err(err) => Err(err),
    }
    #[cfg(not(windows))]
    match fs::hard_link(&tmp_path, path) {
        // Keep guard armed so the temporary link is unlinked while `path` persists.
        Ok(()) => {
            let _ = &mut guard;
            Ok(true)
        }
        Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => Ok(false),
        Err(err) if err.kind() == std::io::ErrorKind::Unsupported => {
            drop(guard);
            let mut opts = OpenOptions::new();
            opts.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                opts.mode(0o600).custom_flags(libc::O_NOFOLLOW);
            }
            match opts.open(path) {
                Ok(mut f) => { f.write_all(data)?; f.sync_all()?; Ok(true) }
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Ok(false),
                Err(e) => Err(e),
            }
        }
        Err(err) => Err(err),
    }
}
