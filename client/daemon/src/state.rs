use std::path::PathBuf;
use std::time::Duration;

use serde::Serialize;
use thiserror::Error;

use crate::bootstrap::BootstrapError;
use crate::identity::IdentityError;
use crate::transport::TransportMode;

#[derive(Debug, Error)]
pub enum DaemonError {
    #[error(transparent)]
    Identity(#[from] IdentityError),
    #[error(transparent)]
    Bootstrap(#[from] BootstrapError),
    #[error("invalid host fingerprint confirmation: {0}")]
    FingerprintConfirmation(String),
}

#[derive(Debug, Clone)]
pub struct DaemonConfig {
    pub hub_url: String,
    pub state_dir: Option<PathBuf>,
    pub transport_mode: TransportMode,
    pub heartbeat_interval: Duration,
    pub expected_fingerprint: Option<String>,
    pub stop_on_fingerprint_mismatch: bool,
}

impl DaemonConfig {
    pub fn new(hub_url: impl Into<String>) -> Self {
        Self {
            hub_url: hub_url.into(),
            state_dir: None,
            transport_mode: TransportMode::WsThenTcp,
            heartbeat_interval: Duration::from_secs(25),
            expected_fingerprint: None,
            stop_on_fingerprint_mismatch: false,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FingerprintReason {
    UntrustedHttp,
    Changed,
}

impl FingerprintReason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::UntrustedHttp => "untrusted_http",
            Self::Changed => "changed",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingFingerprint {
    pub hub_key: String,
    pub hub_url: String,
    pub host: String,
    pub host_key_fingerprint: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_fingerprint: Option<String>,
    pub reason: FingerprintReason,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum DaemonState {
    Stopped,
    Bootstrapping,
    Unregistered,
    Suspended,
    Maintenance { message: String },
    #[serde(rename = "awaiting_fingerprint")]
    AwaitingFingerprint(PendingFingerprint),
    Error { reason: String },
    Connecting { host_id: String },
    Connected { host_id: String, host_name: String, transport: String, fingerprint: String },
    Reconnecting { attempt: u32, delay_ms: u64, reason: String },
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "event", rename_all = "camelCase")]
pub enum DaemonEvent {
    StateChanged(DaemonState),
    #[serde(rename = "awaiting_fingerprint")]
    AwaitingFingerprint(PendingFingerprint),
    HeartbeatAck { server_time: String },
    RequestCancelled { id: u32, method: String },
}
