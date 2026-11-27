use serde::Serialize;

/// Read-only device metadata injected into `window.__CLINAVAT_CLIENT__` on desktop platforms.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[derive(Debug, Clone)]
pub struct ClientDeviceMeta {
  pub device_id: String,
  pub public_key: String,
  pub device_name: String,
  pub arch: String,
  pub os_version: String,
  pub default_shell: String,
  pub homedir: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingFingerprintInfo {
  pub hub_key: String,
  pub hub_url: String,
  pub host: String,
  pub host_key_fingerprint: String,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub expected_fingerprint: Option<String>,
  pub reason: String,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HubDaemonStatus {
  pub hub_url: String,
  pub hub_key: String,
  pub enabled: bool,
  pub status: String,
  #[serde(skip_serializing_if = "Option::is_none")] pub host_id: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")] pub host_name: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")] pub transport: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")] pub fingerprint: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")] pub last_error: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")] pub reconnect_attempt: Option<u32>,
  #[serde(skip_serializing_if = "Option::is_none")] pub reconnect_delay_ms: Option<u64>,
  #[serde(skip_serializing_if = "Option::is_none")] pub pending_fingerprint: Option<PendingFingerprintInfo>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DaemonBridgeSnapshot {
  pub supported: bool,
  #[serde(skip_serializing_if = "Option::is_none")] pub device_id: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")] pub device_name: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")] pub public_key: Option<String>,
  pub platform: String,
  #[serde(skip_serializing_if = "Option::is_none")] pub arch: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")] pub default_shell: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")] pub init_error: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")] pub config_error: Option<String>,
  pub hubs: Vec<HubDaemonStatus>,
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub mod desktop {
  use std::collections::BTreeMap;
  use std::path::Path;

  use clinavat_daemon::bootstrap::normalize_hub_url;
  use clinavat_daemon::identity::write_private_file;
  use clinavat_daemon::private_io::read_existing_private_string;
  use clinavat_daemon::{DaemonState, DaemonSupervisor, PendingFingerprint};
  use serde::{Deserialize, Serialize};

  use super::{HubDaemonStatus, PendingFingerprintInfo};
  use crate::hub::parse_hub_url;

  #[derive(Debug, Clone, Serialize, Deserialize)]
  #[serde(rename_all = "camelCase")]
  pub struct PersistedHubDaemon {
    pub hub_url: String,
    pub enabled: bool,
  }

  pub struct LoadedHubConfig {
    pub entries: BTreeMap<String, PersistedHubDaemon>,
    pub load_error: Option<String>,
    pub corrupted: bool,
  }

  pub fn validate_and_normalize(raw_url: &str) -> Result<(String, String), String> {
    let parsed = parse_hub_url(raw_url)?;
    let (normalized, hub_key) = normalize_hub_url(parsed.as_str()).map_err(|e| e.to_string())?;
    Ok((normalized.to_string(), hub_key))
  }

  /// Loads `daemon_hubs.json` via non-symlink/owner-verified private I/O and validates every Hub URL (`L4`, `L8`).
  pub fn load_persisted(path: &Path) -> LoadedHubConfig {
    let raw = match read_existing_private_string(path, "daemon_hubs.json") {
      Ok(Some(text)) => text,
      Ok(None) => return LoadedHubConfig { entries: BTreeMap::new(), load_error: None, corrupted: false },
      Err(err) => {
        return LoadedHubConfig {
          entries: BTreeMap::new(),
          load_error: Some(format!("读取守护进程配置失败（未覆盖原文件）: {err}")),
          corrupted: true,
        };
      }
    };
    if raw.trim().is_empty() {
      return LoadedHubConfig { entries: BTreeMap::new(), load_error: None, corrupted: false };
    }
    let parsed: BTreeMap<String, PersistedHubDaemon> = match serde_json::from_str(&raw) {
      Ok(map) => map,
      Err(err) => {
        return LoadedHubConfig {
          entries: BTreeMap::new(),
          load_error: Some(format!("守护进程配置文件 JSON 损坏（未覆盖原文件）: {err}")),
          corrupted: true,
        };
      }
    };

    let mut entries = BTreeMap::new();
    let mut skipped = 0usize;
    for (_key, rec) in parsed {
      match validate_and_normalize(&rec.hub_url) {
        Ok((hub_url, hub_key)) => {
          entries.insert(hub_key, PersistedHubDaemon { hub_url, enabled: rec.enabled });
        }
        Err(_) => skipped += 1,
      }
    }
    let load_error = if skipped > 0 {
      Some(format!("守护进程配置中有 {skipped} 条无效 Hub 地址已被忽略"))
    } else {
      None
    };
    LoadedHubConfig { entries, load_error, corrupted: false }
  }

  pub fn persist_map(path: Option<&Path>, map: &BTreeMap<String, PersistedHubDaemon>) -> Result<(), String> {
    let Some(path) = path else { return Ok(()) };
    let bytes = serde_json::to_vec_pretty(map).map_err(|e| e.to_string())?;
    write_private_file(path, &bytes).map_err(|e| format!("保存守护进程配置失败: {e}"))
  }

  pub fn build_hub_status(
    hub_key: &str,
    hub_url: &str,
    enabled: bool,
    last_error: Option<&str>,
    supervisor: Option<&DaemonSupervisor>,
  ) -> HubDaemonStatus {
    let mut out = HubDaemonStatus {
      hub_url: hub_url.to_string(),
      hub_key: hub_key.to_string(),
      enabled,
      status: "stopped".into(),
      last_error: last_error.map(str::to_string),
      ..Default::default()
    };
    let Some(sup) = supervisor else { return out };
    match sup.current_state() {
      DaemonState::Stopped => out.status = "stopped".into(),
      DaemonState::Bootstrapping => out.status = "bootstrapping".into(),
      DaemonState::Unregistered => out.status = "unregistered".into(),
      DaemonState::Suspended => { out.status = "suspended".into(); out.last_error = Some("当前账号已被停用".into()); }
      DaemonState::Maintenance { message } => { out.status = "maintenance".into(); out.last_error = Some(message); }
      DaemonState::AwaitingFingerprint(p) => {
        out.status = "awaiting_fingerprint".into();
        out.pending_fingerprint = Some(map_pending(p));
      }
      DaemonState::Error { reason } => { out.status = "error".into(); out.last_error = Some(reason); }
      DaemonState::Connecting { host_id } => { out.status = "connecting".into(); out.host_id = Some(host_id); }
      DaemonState::Connected { host_id, host_name, transport, fingerprint } => {
        out.status = "connected".into();
        out.host_id = Some(host_id);
        out.host_name = Some(host_name);
        out.transport = Some(transport);
        out.fingerprint = Some(fingerprint);
        out.last_error = None;
      }
      DaemonState::Reconnecting { attempt, delay_ms, reason } => {
        out.status = "reconnecting".into();
        out.reconnect_attempt = Some(attempt);
        out.reconnect_delay_ms = Some(delay_ms);
        out.last_error = Some(reason);
      }
    }
    out
  }

  fn map_pending(p: PendingFingerprint) -> PendingFingerprintInfo {
    PendingFingerprintInfo {
      hub_key: p.hub_key,
      hub_url: p.hub_url,
      host: p.host,
      host_key_fingerprint: p.host_key_fingerprint,
      expected_fingerprint: p.expected_fingerprint,
      reason: p.reason.as_str().to_string(),
    }
  }
}
