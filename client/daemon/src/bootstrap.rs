use std::collections::BTreeMap;
use std::net::{Ipv4Addr, Ipv6Addr};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use thiserror::Error;
use url::{Host, Url};

use crate::identity::{write_private_file, DeviceIdentity};
use crate::private_io::read_existing_private_string;

#[derive(Debug, Error)]
pub enum BootstrapError {
    #[error("invalid Hub URL: {0}")]
    InvalidHubUrl(String),
    #[error("HTTP request failed: {0}")]
    Http(#[from] reqwest::Error),
    #[error("unexpected HTTP status {status}: {body}")]
    UnexpectedStatus { status: u16, body: String },
    #[error("invalid bootstrap payload: {0}")]
    InvalidPayload(String),
    #[error("trust store I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error("trust store JSON error: {0}")]
    Json(#[from] serde_json::Error),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BootstrapInfo {
    pub hub_key: String,
    pub host_id: String,
    pub host_name: String,
    pub ssh_host: String,
    pub ssh_port: u16,
    pub ws_tunnel_path: String,
    pub host_key_fingerprint: String,
}

#[derive(Debug, Clone)]
pub enum BootstrapOutcome {
    Ready(BootstrapInfo),
    Unregistered,
    Suspended,
    Maintenance { message: String },
    RateLimited { retry_after_secs: u64 },
    Unauthorized { error: String },
    UntrustedFirstConnect {
        hub_key: String,
        actual: String,
        info: BootstrapInfo,
    },
    FingerprintMismatch {
        hub_key: String,
        expected: String,
        actual: String,
        info: BootstrapInfo,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrustedHubRecord {
    pub host_key_fingerprint: String,
    pub updated_at_ms: u64,
}

/// Persists pinned Hub SSH host key fingerprints per normalized Hub origin (`trusted_hubs.json`, mode `0600`).
#[derive(Debug, Clone)]
pub struct TrustStore {
    path: PathBuf,
}

impl TrustStore {
    pub fn new(state_dir: &Path) -> Self { Self { path: state_dir.join("trusted_hubs.json") } }

    pub fn load_all(&self) -> Result<BTreeMap<String, TrustedHubRecord>, BootstrapError> {
        let Some(raw) = read_existing_private_string(&self.path, "trusted_hubs.json")? else {
            return Ok(BTreeMap::new());
        };
        if raw.trim().is_empty() { return Ok(BTreeMap::new()); }
        Ok(serde_json::from_str(&raw)?)
    }

    pub fn get_fingerprint(&self, hub_key: &str) -> Result<Option<String>, BootstrapError> {
        Ok(self.load_all()?.get(hub_key).map(|rec| rec.host_key_fingerprint.clone()))
    }

    pub fn pin_fingerprint(&self, hub_key: &str, fingerprint: &str) -> Result<(), BootstrapError> {
        let mut map = self.load_all()?;
        map.insert(
            hub_key.to_string(),
            TrustedHubRecord { host_key_fingerprint: fingerprint.to_string(), updated_at_ms: now_unix_ms() },
        );
        let serialized = serde_json::to_vec_pretty(&map)?;
        write_private_file(&self.path, &serialized)?;
        Ok(())
    }
}

/// Allows TOFU only for HTTPS/WSS Hubs and exact loopback HTTP (`127.0.0.1`, `::1`, `localhost`).
pub fn allows_tofu(hub_url: &Url) -> bool {
    match hub_url.scheme() {
        "https" => true,
        "http" => match hub_url.host() {
            Some(Host::Ipv4(ip)) => ip == Ipv4Addr::LOCALHOST,
            Some(Host::Ipv6(ip)) => ip == Ipv6Addr::LOCALHOST,
            Some(Host::Domain(name)) => name.eq_ignore_ascii_case("localhost"),
            None => false,
        },
        _ => false,
    }
}

/// Normalizes a Hub base URL and computes its trust-store key (`scheme://host[:port]`).
pub fn normalize_hub_url(raw: &str) -> Result<(Url, String), BootstrapError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(BootstrapError::InvalidHubUrl("Hub URL must not be empty".into()));
    }
    let mut url = Url::parse(trimmed).map_err(|e| BootstrapError::InvalidHubUrl(e.to_string()))?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err(BootstrapError::InvalidHubUrl("Hub URL must use http:// or https://".into()));
    }
    let host = url
        .host_str()
        .ok_or_else(|| BootstrapError::InvalidHubUrl("Hub URL missing host".into()))?
        .to_ascii_lowercase();
    url.set_query(None);
    url.set_fragment(None);
    let hub_key = match url.port() {
        Some(port) => format!("{}://{host}:{port}", url.scheme()),
        None => format!("{}://{host}", url.scheme()),
    };
    Ok((url, hub_key))
}

pub fn build_bootstrap_url(hub_url: &Url) -> Result<Url, BootstrapError> {
    let mut out = hub_url.clone();
    let base_path = out.path().trim_end_matches('/');
    out.set_path(&format!("{base_path}/api/client-devices/bootstrap"));
    Ok(out)
}

pub fn build_ws_tunnel_url(hub_url: &Url, ws_tunnel_path: &str) -> Result<Url, BootstrapError> {
    let mut out = hub_url.clone();
    let ws_scheme = if out.scheme() == "https" { "wss" } else { "ws" };
    out.set_scheme(ws_scheme)
        .map_err(|_| BootstrapError::InvalidHubUrl("failed to derive WebSocket scheme".into()))?;
    let base_path = out.path().trim_end_matches('/');
    let suffix = if ws_tunnel_path.starts_with('/') {
        ws_tunnel_path.to_string()
    } else {
        format!("/{ws_tunnel_path}")
    };
    out.set_path(&format!("{base_path}{suffix}"));
    Ok(out)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BootstrapRequestBody<'a> {
    device_id: &'a str,
    timestamp: u64,
    signature: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BootstrapResponseBody {
    #[serde(default)]
    registered: bool,
    #[serde(default)]
    suspended: bool,
    host_id: Option<String>,
    host_name: Option<String>,
    ssh_host: Option<String>,
    ssh_port: Option<u16>,
    ws_tunnel_path: Option<String>,
    host_key_fingerprint: Option<String>,
    error: Option<String>,
}

pub struct BootstrapClient {
    http: reqwest::Client,
    last_timestamp_ms: AtomicU64,
}

impl BootstrapClient {
    pub fn new() -> Result<Self, BootstrapError> {
        // Keep headers clean: never attach untrusted Origin or Sec-Fetch-Site headers rejected by Hub auth hook.
        let http = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(15))
            .redirect(reqwest::redirect::Policy::none())
            .build()?;
        Ok(Self {
            http,
            last_timestamp_ms: AtomicU64::new(0),
        })
    }

    fn next_timestamp_ms(&self) -> u64 {
        let now = now_unix_ms();
        loop {
            let prev = self.last_timestamp_ms.load(Ordering::Relaxed);
            let candidate = if now > prev { now } else { prev + 1 };
            if self
                .last_timestamp_ms
                .compare_exchange_weak(prev, candidate, Ordering::Relaxed, Ordering::Relaxed)
                .is_ok()
            {
                return candidate;
            }
        }
    }

    pub async fn bootstrap(
        &self,
        hub_url: &Url,
        hub_key: &str,
        identity: &DeviceIdentity,
        trust_store: &TrustStore,
        expected_override: Option<&str>,
    ) -> Result<BootstrapOutcome, BootstrapError> {
        let endpoint = build_bootstrap_url(hub_url)?;
        let timestamp = self.next_timestamp_ms();
        let signature = identity.sign_bootstrap(timestamp);
        let body = BootstrapRequestBody {
            device_id: &identity.device_id,
            timestamp,
            signature,
        };

        let response = self
            .http
            .post(endpoint)
            .header(reqwest::header::ACCEPT, "application/json")
            .json(&body)
            .send()
            .await?;

        let status = response.status();
        let retry_after = response
            .headers()
            .get(reqwest::header::RETRY_AFTER)
            .and_then(|h| h.to_str().ok())
            .and_then(|s| s.parse::<u64>().ok());
        let text = response.text().await?;

        if status.as_u16() == 503 {
            let message = serde_json::from_str::<serde_json::Value>(&text)
                .ok()
                .and_then(|v| v.get("error").and_then(|e| e.as_str()).map(str::to_string))
                .unwrap_or_else(|| "Hub is in maintenance mode".into());
            return Ok(BootstrapOutcome::Maintenance { message });
        }
        if status.as_u16() == 429 {
            return Ok(BootstrapOutcome::RateLimited {
                retry_after_secs: retry_after.unwrap_or(60).clamp(5, 300),
            });
        }
        if status.as_u16() == 401 {
            let error = serde_json::from_str::<BootstrapResponseBody>(&text)
                .ok()
                .and_then(|b| b.error)
                .unwrap_or_else(|| "bootstrap authentication failed".into());
            return Ok(BootstrapOutcome::Unauthorized { error });
        }
        if !status.is_success() {
            return Err(BootstrapError::UnexpectedStatus {
                status: status.as_u16(),
                body: text,
            });
        }

        let parsed: BootstrapResponseBody =
            serde_json::from_str(&text).map_err(|e| BootstrapError::InvalidPayload(e.to_string()))?;
        if parsed.suspended {
            return Ok(BootstrapOutcome::Suspended);
        }
        if !parsed.registered {
            return Ok(BootstrapOutcome::Unregistered);
        }

        let info = BootstrapInfo {
            hub_key: hub_key.to_string(),
            host_id: parsed
                .host_id
                .filter(|s| !s.is_empty())
                .ok_or_else(|| BootstrapError::InvalidPayload("missing hostId".into()))?,
            host_name: parsed.host_name.unwrap_or_default(),
            ssh_host: parsed
                .ssh_host
                .filter(|s| !s.is_empty())
                .ok_or_else(|| BootstrapError::InvalidPayload("missing sshHost".into()))?,
            ssh_port: parsed
                .ssh_port
                .ok_or_else(|| BootstrapError::InvalidPayload("missing sshPort".into()))?,
            ws_tunnel_path: parsed
                .ws_tunnel_path
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| "/api/client-devices/tunnel".into()),
            host_key_fingerprint: parsed
                .host_key_fingerprint
                .filter(|s| !s.is_empty())
                .ok_or_else(|| BootstrapError::InvalidPayload("missing hostKeyFingerprint".into()))?,
        };

        if let Some(expected) = expected_override {
            if expected != info.host_key_fingerprint {
                return Ok(BootstrapOutcome::FingerprintMismatch {
                    hub_key: hub_key.to_string(),
                    expected: expected.to_string(),
                    actual: info.host_key_fingerprint.clone(),
                    info,
                });
            }
            return Ok(BootstrapOutcome::Ready(info));
        }

        match trust_store.get_fingerprint(hub_key)? {
            None if allows_tofu(hub_url) => {
                trust_store.pin_fingerprint(hub_key, &info.host_key_fingerprint)?;
                Ok(BootstrapOutcome::Ready(info))
            }
            None => Ok(BootstrapOutcome::UntrustedFirstConnect {
                hub_key: hub_key.to_string(),
                actual: info.host_key_fingerprint.clone(),
                info,
            }),
            Some(expected) if expected == info.host_key_fingerprint => Ok(BootstrapOutcome::Ready(info)),
            Some(expected) => Ok(BootstrapOutcome::FingerprintMismatch {
                hub_key: hub_key.to_string(),
                expected,
                actual: info.host_key_fingerprint.clone(),
                info,
            }),
        }
    }
}

fn now_unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}
