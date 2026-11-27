use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use ed25519_dalek::{Signer, SigningKey};
use rand::rngs::OsRng;
use rand::RngCore;
use russh::keys::ssh_key::private::{Ed25519Keypair, Ed25519PrivateKey, KeypairData};
use russh::keys::ssh_key::LineEnding;
use russh::keys::PrivateKey;
use serde::Serialize;
use thiserror::Error;

pub use crate::private_io::write_private_file;
use crate::private_io::{ensure_private_dir, read_existing_private_string, write_private_file_create_new};

#[derive(Debug, Error)]
pub enum IdentityError {
    #[error("unable to determine daemon state directory")]
    NoStateDir,
    #[error("invalid persisted deviceId: {0}")]
    InvalidDeviceId(String),
    #[error("invalid persisted Ed25519 key: {0}")]
    InvalidKey(String),
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceIdentity {
    pub device_id: String,
    pub public_key: String,
    pub name: String,
    pub platform: String,
    pub arch: String,
    pub os_version: String,
    pub default_shell: String,
    pub homedir: String,
    #[serde(skip)]
    signing_key: SigningKey,
    #[serde(skip)]
    ssh_private_key: PrivateKey,
    #[serde(skip)]
    state_dir: PathBuf,
}

impl DeviceIdentity {
    /// Loads existing persisted device identity from `state_dir`, or generates and persists a new Ed25519 identity.
    pub fn load_or_create(state_dir: Option<PathBuf>) -> Result<Self, IdentityError> {
        let dir = match state_dir {
            Some(custom) => custom,
            None => default_state_dir()?,
        };
        ensure_private_dir(&dir)?;
        let device_id = load_or_create_device_id(&dir.join("device_id"))?;
        let (signing_key, ssh_private_key) = load_or_create_keypair(&dir.join("id_ed25519"))?;
        let public_key = format_openssh_ed25519_pubkey(signing_key.verifying_key().as_bytes());
        Ok(Self {
            device_id,
            public_key,
            name: detect_hostname(),
            platform: detect_platform().to_string(),
            arch: detect_arch().to_string(),
            os_version: detect_os_version(),
            default_shell: detect_default_shell(),
            homedir: detect_homedir(),
            signing_key,
            ssh_private_key,
            state_dir: dir,
        })
    }

    pub fn state_dir(&self) -> &Path { &self.state_dir }
    pub fn ssh_private_key(&self) -> &PrivateKey { &self.ssh_private_key }

    /// Signs the canonical `clinavat-bootstrap:<deviceId>:<timestamp>` string and encodes the 64-byte signature in base64.
    pub fn sign_bootstrap(&self, timestamp: u64) -> String {
        let canonical = format!("clinavat-bootstrap:{}:{timestamp}", self.device_id);
        let signature = self.signing_key.sign(canonical.as_bytes());
        BASE64_STANDARD.encode(signature.to_bytes())
    }
}

pub fn default_state_dir() -> Result<PathBuf, IdentityError> {
    let base = dirs::config_dir()
        .or_else(|| dirs::home_dir().map(|h| h.join(".config")))
        .ok_or(IdentityError::NoStateDir)?;
    Ok(base.join("clinavat").join("daemon"))
}

pub fn is_valid_device_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

/// Formats a 32-byte Ed25519 public key into OpenSSH wire format (`ssh-ed25519 <base64>`).
pub fn format_openssh_ed25519_pubkey(verifying_bytes: &[u8; 32]) -> String {
    let mut wire = Vec::with_capacity(4 + 11 + 4 + 32);
    wire.extend_from_slice(&11u32.to_be_bytes());
    wire.extend_from_slice(b"ssh-ed25519");
    wire.extend_from_slice(&32u32.to_be_bytes());
    wire.extend_from_slice(verifying_bytes);
    format!("ssh-ed25519 {}", BASE64_STANDARD.encode(&wire))
}

fn load_or_create_device_id(path: &Path) -> Result<String, IdentityError> {
    if let Some(raw) = read_existing_private_string(path, "device_id")? {
        let trimmed = raw.trim().to_string();
        if !is_valid_device_id(&trimmed) {
            return Err(IdentityError::InvalidDeviceId(trimmed));
        }
        return Ok(trimmed);
    }
    let mut bytes = [0u8; 16];
    OsRng.fill_bytes(&mut bytes);
    let mut hex = String::with_capacity(36);
    hex.push_str("dev-");
    for byte in bytes {
        use std::fmt::Write as _;
        let _ = write!(&mut hex, "{byte:02x}");
    }
    if !write_private_file_create_new(path, format!("{hex}\n").as_bytes())? {
        let raw = read_existing_private_string(path, "device_id")?
            .ok_or_else(|| IdentityError::InvalidDeviceId("missing after concurrent create".into()))?;
        let trimmed = raw.trim().to_string();
        if !is_valid_device_id(&trimmed) {
            return Err(IdentityError::InvalidDeviceId(trimmed));
        }
        return Ok(trimmed);
    }
    Ok(hex)
}

fn parse_ed25519_pem(pem: &str) -> Result<(SigningKey, PrivateKey), IdentityError> {
    let private_key = PrivateKey::from_openssh(pem).map_err(|e| IdentityError::InvalidKey(e.to_string()))?;
    let KeypairData::Ed25519(kp) = private_key.key_data() else {
        return Err(IdentityError::InvalidKey("expected ssh-ed25519 private key".into()));
    };
    let seed: [u8; 32] = kp.private.to_bytes();
    Ok((SigningKey::from_bytes(&seed), private_key))
}

fn load_or_create_keypair(path: &Path) -> Result<(SigningKey, PrivateKey), IdentityError> {
    if let Some(pem) = read_existing_private_string(path, "id_ed25519")? {
        return parse_ed25519_pem(&pem);
    }
    let mut seed = [0u8; 32];
    OsRng.fill_bytes(&mut seed);
    let signing_key = SigningKey::from_bytes(&seed);
    let ed_kp = Ed25519Keypair::from(Ed25519PrivateKey::from_bytes(&seed));
    let private_key = PrivateKey::new(KeypairData::Ed25519(ed_kp), "")
        .map_err(|e| IdentityError::InvalidKey(e.to_string()))?;
    let pem = private_key
        .to_openssh(LineEnding::LF)
        .map_err(|e| IdentityError::InvalidKey(e.to_string()))?;
    if !write_private_file_create_new(path, pem.as_bytes())? {
        let existing = read_existing_private_string(path, "id_ed25519")?
            .ok_or_else(|| IdentityError::InvalidKey("private key missing after concurrent create".into()))?;
        return parse_ed25519_pem(&existing);
    }
    Ok((signing_key, private_key))
}

fn detect_platform() -> &'static str {
    if cfg!(target_os = "macos") { "darwin" } else if cfg!(target_os = "windows") { "win32" } else { "linux" }
}

fn detect_arch() -> &'static str {
    match std::env::consts::ARCH { "x86_64" => "x64", "aarch64" => "arm64", "x86" => "ia32", other => other }
}

fn new_background_command(program: &str) -> Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let mut cmd = Command::new(program);
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        cmd
    }
    #[cfg(not(windows))]
    {
        Command::new(program)
    }
}

fn detect_hostname() -> String {
    if let Ok(raw) = fs::read_to_string("/proc/sys/kernel/hostname") {
        if !raw.trim().is_empty() { return truncate_chars(raw.trim(), 100); }
    }
    for var in ["COMPUTERNAME", "HOSTNAME"] {
        if let Ok(val) = std::env::var(var) {
            if !val.trim().is_empty() { return truncate_chars(val.trim(), 100); }
        }
    }
    if let Ok(out) = new_background_command("hostname").output() {
        if out.status.success() {
            let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if !text.is_empty() { return truncate_chars(&text, 100); }
        }
    }
    format!("clinavat-{}", detect_platform())
}

fn detect_os_version() -> String {
    #[cfg(target_os = "linux")]
    if let Ok(raw) = fs::read_to_string("/proc/sys/kernel/osrelease") {
        if !raw.trim().is_empty() { return truncate_chars(&format!("Linux {}", raw.trim()), 128); }
    }
    #[cfg(target_os = "macos")]
    if let Ok(out) = new_background_command("sw_vers").arg("-productVersion").output() {
        if out.status.success() {
            let ver = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if !ver.is_empty() { return truncate_chars(&format!("macOS {ver}"), 128); }
        }
    }
    #[cfg(target_os = "windows")]
    if let Ok(out) = new_background_command("cmd").args(["/C", "ver"]).output() {
        if out.status.success() {
            let ver = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if !ver.is_empty() { return truncate_chars(&ver, 128); }
        }
    }
    std::env::consts::OS.to_string()
}

fn detect_default_shell() -> String {
    #[cfg(target_os = "windows")]
    { std::env::var("COMSPEC").ok().filter(|s| !s.trim().is_empty()).unwrap_or_else(|| "powershell.exe".into()) }
    #[cfg(not(target_os = "windows"))]
    {
        std::env::var("SHELL").ok().filter(|s| !s.trim().is_empty()).unwrap_or_else(|| {
            if cfg!(target_os = "macos") { "/bin/zsh".into() } else { "/bin/bash".into() }
        })
    }
}

fn detect_homedir() -> String {
    dirs::home_dir().map(|p| p.to_string_lossy().to_string()).unwrap_or_default()
}

fn truncate_chars(value: &str, max_chars: usize) -> String { value.chars().take(max_chars).collect() }
