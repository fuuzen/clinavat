pub mod bootstrap;
pub mod framing;
pub mod identity;
pub mod ops;
pub mod path_guard;
pub mod private_io;
pub mod router;
pub mod state;
pub mod transport;

use std::sync::{Arc, Mutex, Once};
use std::time::Duration;

use rand::Rng;
use tokio::sync::{broadcast, mpsc, watch, Notify};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use crate::bootstrap::{normalize_hub_url, BootstrapClient, BootstrapOutcome, TrustStore};
use crate::identity::DeviceIdentity;
pub use crate::ops::fs_common::init_process_umask;
use crate::router::RouterEvent;
pub use crate::state::{
    DaemonConfig, DaemonError, DaemonEvent, DaemonState, FingerprintReason, PendingFingerprint,
};
use crate::transport::{run_ssh_session, SessionRunParams, TransportError};

static CRYPTO_INIT: Once = Once::new();

/// Installs the pure-Rust `rustls` crypto provider once per process.
pub fn ensure_crypto_provider() {
    CRYPTO_INIT.call_once(|| {
        let _ = rustls::crypto::CryptoProvider::install_default(rustls_rustcrypto::provider());
    });
}

/// Embeddable supervisor for both the standalone `clinavat-agent` CLI and the desktop Tauri shell.
pub struct DaemonSupervisor {
    config: DaemonConfig,
    hub_url: url::Url,
    hub_key: String,
    identity: Arc<DeviceIdentity>,
    trust_store: TrustStore,
    pending_fingerprint: Arc<Mutex<Option<PendingFingerprint>>>,
    state_tx: watch::Sender<DaemonState>,
    events_tx: broadcast::Sender<DaemonEvent>,
    cancel: CancellationToken,
    wake: Arc<Notify>,
}

impl DaemonSupervisor {
    pub fn new(config: DaemonConfig) -> Result<Self, DaemonError> {
        init_process_umask();
        ensure_crypto_provider();
        let identity = Arc::new(DeviceIdentity::load_or_create(config.state_dir.clone())?);
        Self::with_identity(config, identity)
    }

    /// Constructs a supervisor reusing a pre-loaded `DeviceIdentity` without disk/process probing.
    pub fn with_identity(config: DaemonConfig, identity: Arc<DeviceIdentity>) -> Result<Self, DaemonError> {
        init_process_umask();
        ensure_crypto_provider();
        let (hub_url, hub_key) = normalize_hub_url(&config.hub_url)?;
        let trust_store = TrustStore::new(identity.state_dir());
        let (state_tx, _) = watch::channel(DaemonState::Stopped);
        let (events_tx, _) = broadcast::channel(64);
        Ok(Self {
            config,
            hub_url,
            hub_key,
            identity,
            trust_store,
            pending_fingerprint: Arc::new(Mutex::new(None)),
            state_tx,
            events_tx,
            cancel: CancellationToken::new(),
            wake: Arc::new(Notify::new()),
        })
    }

    pub fn identity(&self) -> &DeviceIdentity { &self.identity }
    pub fn hub_url(&self) -> &url::Url { &self.hub_url }
    pub fn hub_key(&self) -> &str { &self.hub_key }
    pub fn trust_store(&self) -> &TrustStore { &self.trust_store }
    pub fn current_state(&self) -> DaemonState { self.state_tx.borrow().clone() }
    pub fn pending_fingerprint(&self) -> Option<PendingFingerprint> {
        self.pending_fingerprint.lock().ok().and_then(|g| g.clone())
    }
    pub fn subscribe_state(&self) -> watch::Receiver<DaemonState> { self.state_tx.subscribe() }
    pub fn subscribe_events(&self) -> broadcast::Receiver<DaemonEvent> { self.events_tx.subscribe() }

    /// Confirms the pending SSH host key fingerprint, pins it in `TrustStore`, and resumes connecting.
    pub fn confirm_host_fingerprint(&self, fingerprint: &str) -> Result<(), DaemonError> {
        let trimmed = fingerprint.trim();
        let mut guard = self.pending_fingerprint.lock().map_err(|_| {
            DaemonError::FingerprintConfirmation("pending fingerprint lock poisoned".into())
        })?;
        let Some(pending) = guard.as_ref() else {
            return Err(DaemonError::FingerprintConfirmation("no host fingerprint awaiting confirmation".into()));
        };
        if pending.host_key_fingerprint != trimmed {
            return Err(DaemonError::FingerprintConfirmation(format!(
                "fingerprint mismatch (pending {}, confirmed {trimmed})",
                pending.host_key_fingerprint
            )));
        }
        self.trust_store.pin_fingerprint(&pending.hub_key, trimmed)?;
        *guard = None;
        drop(guard);
        self.wake.notify_one();
        Ok(())
    }

    /// Rejects the pending host key fingerprint and stops the supervisor immediately without pinning.
    pub fn reject_host_fingerprint(&self) {
        if let Ok(mut guard) = self.pending_fingerprint.lock() { *guard = None; }
        self.stop();
    }

    pub fn trigger_reconnect(&self) { self.wake.notify_one(); }
    pub fn stop(&self) { self.cancel.cancel(); self.wake.notify_waiters(); }

    pub fn start(&self) -> JoinHandle<()> {
        tokio::spawn(run_supervisor(SupervisorCtx {
            config: self.config.clone(),
            hub_url: self.hub_url.clone(),
            hub_key: self.hub_key.clone(),
            identity: Arc::clone(&self.identity),
            trust_store: self.trust_store.clone(),
            pending_fingerprint: Arc::clone(&self.pending_fingerprint),
            state_tx: self.state_tx.clone(),
            events_tx: self.events_tx.clone(),
            cancel: self.cancel.clone(),
            wake: Arc::clone(&self.wake),
        }))
    }
}

struct SupervisorCtx {
    config: DaemonConfig,
    hub_url: url::Url,
    hub_key: String,
    identity: Arc<DeviceIdentity>,
    trust_store: TrustStore,
    pending_fingerprint: Arc<Mutex<Option<PendingFingerprint>>>,
    state_tx: watch::Sender<DaemonState>,
    events_tx: broadcast::Sender<DaemonEvent>,
    cancel: CancellationToken,
    wake: Arc<Notify>,
}

impl SupervisorCtx {
    fn set_state(&self, state: DaemonState) {
        let _ = self.state_tx.send(state.clone());
        let _ = self.events_tx.send(DaemonEvent::StateChanged(state));
    }

    async fn wait_state(&self, state: DaemonState, delay: Duration) {
        self.set_state(state);
        tokio::select! {
            _ = self.cancel.cancelled() => {}
            _ = self.wake.notified() => {}
            _ = tokio::time::sleep(delay) => {}
        }
    }

    async fn wait_reconnect(&self, attempt: u32, delay: Duration, reason: impl Into<String>) {
        let delay_ms = delay.as_millis() as u64;
        self.wait_state(DaemonState::Reconnecting { attempt, delay_ms, reason: reason.into() }, delay).await;
    }

    async fn await_fingerprint(
        &self, hub_key: String, host_key_fingerprint: String, expected_fingerprint: Option<String>, reason: FingerprintReason,
    ) -> bool {
        let pending = PendingFingerprint {
            hub_key,
            hub_url: self.hub_url.to_string(),
            host: self.hub_url.host_str().unwrap_or_default().to_string(),
            host_key_fingerprint,
            expected_fingerprint,
            reason,
        };
        if let Ok(mut guard) = self.pending_fingerprint.lock() { *guard = Some(pending.clone()); }
        let _ = self.events_tx.send(DaemonEvent::AwaitingFingerprint(pending.clone()));
        self.set_state(DaemonState::AwaitingFingerprint(pending));
        if self.config.stop_on_fingerprint_mismatch { return true; }
        tokio::select! { _ = self.cancel.cancelled() => {} _ = self.wake.notified() => {} }
        false
    }
}

async fn run_supervisor(ctx: SupervisorCtx) {
    let Ok(client) = BootstrapClient::new() else { ctx.set_state(DaemonState::Stopped); return; };
    let mut attempt: u32 = 0;

    while !ctx.cancel.is_cancelled() {
        ctx.set_state(DaemonState::Bootstrapping);
        let outcome = client
            .bootstrap(&ctx.hub_url, &ctx.hub_key, &ctx.identity, &ctx.trust_store, ctx.config.expected_fingerprint.as_deref())
            .await;

        match outcome {
            Ok(BootstrapOutcome::Unregistered) => { attempt = 0; ctx.wait_state(DaemonState::Unregistered, Duration::from_secs(30)).await; }
            Ok(BootstrapOutcome::Suspended) => { attempt = 0; ctx.wait_state(DaemonState::Suspended, Duration::from_secs(60)).await; }
            Ok(BootstrapOutcome::Maintenance { message }) => { attempt = 0; ctx.wait_state(DaemonState::Maintenance { message }, Duration::from_secs(30)).await; }
            Ok(BootstrapOutcome::RateLimited { retry_after_secs }) => {
                attempt = attempt.saturating_add(1);
                ctx.wait_reconnect(attempt, Duration::from_secs(retry_after_secs), "rate_limited").await;
            }
            Ok(BootstrapOutcome::Unauthorized { error }) => {
                attempt = attempt.saturating_add(1);
                ctx.wait_reconnect(attempt, Duration::from_secs(30), error).await;
            }
            Ok(BootstrapOutcome::UntrustedFirstConnect { hub_key, actual, .. }) => {
                if ctx.await_fingerprint(hub_key, actual, None, FingerprintReason::UntrustedHttp).await { break; }
            }
            Ok(BootstrapOutcome::FingerprintMismatch { hub_key, expected, actual, .. }) => {
                if ctx.await_fingerprint(hub_key, actual, Some(expected), FingerprintReason::Changed).await { break; }
            }
            Err(err) => {
                attempt = attempt.saturating_add(1);
                ctx.wait_reconnect(attempt, backoff_delay(attempt), err.to_string()).await;
            }
            Ok(BootstrapOutcome::Ready(info)) => {
                ctx.set_state(DaemonState::Connecting { host_id: info.host_id.clone() });
                let (router_tx, mut router_rx) = mpsc::unbounded_channel();
                let fwd = ctx.events_tx.clone();
                let forwarder = tokio::spawn(async move {
                    while let Some(ev) = router_rx.recv().await {
                        match ev {
                            RouterEvent::HeartbeatAck { server_time } => { let _ = fwd.send(DaemonEvent::HeartbeatAck { server_time }); }
                            RouterEvent::RequestCancelled { id, method } => { let _ = fwd.send(DaemonEvent::RequestCancelled { id, method }); }
                        }
                    }
                });

                let mut was_connected = false;
                let run_res = run_ssh_session(
                    SessionRunParams {
                        hub_url: &ctx.hub_url, info: &info, identity: &ctx.identity, mode: ctx.config.transport_mode,
                        heartbeat_interval: ctx.config.heartbeat_interval, cancel: ctx.cancel.child_token(),
                        router_events: Some(router_tx),
                    },
                    |transport_name| {
                        was_connected = true;
                        attempt = 0;
                        ctx.set_state(DaemonState::Connected {
                            host_id: info.host_id.clone(), host_name: info.host_name.clone(),
                            transport: transport_name.to_string(), fingerprint: info.host_key_fingerprint.clone(),
                        });
                    },
                ).await;
                forwarder.abort();
                if ctx.cancel.is_cancelled() { break; }

                match run_res {
                    Err(TransportError::FingerprintMismatch { expected, actual }) => {
                        // Transport handshake disagreed with the bootstrap declaration; pinning would loop and never pass.
                        attempt = attempt.saturating_add(1);
                        let reason = format!(
                            "SSH 握手实际主机指纹（{actual}）与 Hub 引导声明指纹（{expected}）不一致，可能存在中间人攻击或端口错配"
                        );
                        if ctx.config.stop_on_fingerprint_mismatch {
                            ctx.set_state(DaemonState::Error { reason });
                            break;
                        }
                        ctx.wait_state(DaemonState::Error { reason }, backoff_delay(attempt)).await;
                    }
                    Err(TransportError::Maintenance) => {
                        ctx.wait_state(DaemonState::Maintenance { message: "Hub tunnel closed for maintenance".into() }, Duration::from_secs(30)).await;
                    }
                    Err(TransportError::RateLimited) => {
                        attempt = attempt.saturating_add(1);
                        ctx.wait_reconnect(attempt, Duration::from_secs(60), "tunnel_rate_limited").await;
                    }
                    Err(err) => {
                        attempt = if was_connected { 1 } else { attempt.saturating_add(1) };
                        ctx.wait_reconnect(attempt, backoff_delay(attempt), err.to_string()).await;
                    }
                    Ok(()) => {
                        attempt = 1;
                        ctx.wait_reconnect(attempt, backoff_delay(attempt), "session_closed").await;
                    }
                }
            }
        }
    }
    if let Ok(mut guard) = ctx.pending_fingerprint.lock() { *guard = None; }
    ctx.set_state(DaemonState::Stopped);
}

fn backoff_delay(attempt: u32) -> Duration {
    let base_secs = (2u64 << attempt.saturating_sub(1).min(5)).min(60);
    Duration::from_secs(base_secs) + Duration::from_millis(rand::thread_rng().gen_range(0..500u64))
}
