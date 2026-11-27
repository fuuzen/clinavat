use std::collections::VecDeque;
use std::io;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};
use std::time::Duration;

use base64::engine::general_purpose::STANDARD_NO_PAD as BASE64_NO_PAD;
use base64::Engine;
use bytes::{Bytes, BytesMut};
use futures_util::{Sink, Stream};
use russh::client::{self, Handle};
use russh::keys::{PrivateKeyWithHashAlg, PublicKey};
use russh::ChannelMsg;
use sha2::{Digest, Sha256};
use thiserror::Error;
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::net::TcpStream;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::{Error as WsError, Message};
use tokio_tungstenite::{connect_async, MaybeTlsStream, WebSocketStream};
use tokio_util::sync::CancellationToken;
use url::Url;

use crate::bootstrap::{build_ws_tunnel_url, BootstrapInfo};
use crate::framing::FrameDecoder;
use crate::identity::DeviceIdentity;
use crate::path_guard::ClientPlatform;
use crate::router::{RouterEvent, RpcRouter};

const AGENT_EXEC_COMMAND: &str = "clinavat-agent-v1";
// Hub registers @fastify/websocket with maxPayload=65536; keep each WS binary frame safely below that cap.
const MAX_WS_BINARY_FRAME: usize = 32 * 1024;
const MAX_SSH_DATA_CHUNK: usize = 32 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TransportMode {
    WsThenTcp,
    WsOnly,
    TcpOnly,
}

impl TransportMode {
    pub fn parse(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "auto" | "ws-then-tcp" => Some(Self::WsThenTcp),
            "ws" | "ws-only" => Some(Self::WsOnly),
            "tcp" | "tcp-only" => Some(Self::TcpOnly),
            _ => None,
        }
    }
}

#[derive(Debug, Error)]
pub enum TransportError {
    #[error("Hub tunnel unavailable during maintenance (HTTP 503)")]
    Maintenance,
    #[error("Hub tunnel rate limited (HTTP 429)")]
    RateLimited,
    #[error("SSH host key fingerprint mismatch (expected {expected}, actual {actual})")]
    FingerprintMismatch { expected: String, actual: String },
    #[error("SSH public key authentication rejected by Hub")]
    AuthRejected,
    #[error("WebSocket tunnel error: {0}")]
    WebSocket(String),
    #[error("TCP connection error: {0}")]
    Tcp(String),
    #[error("SSH protocol error: {0}")]
    Ssh(String),
    #[error("Framing error: {0}")]
    Framing(String),
}

/// Adapts a `WebSocketStream` binary message stream into `AsyncRead + AsyncWrite` for `russh`.
pub struct WsStream {
    inner: WebSocketStream<MaybeTlsStream<TcpStream>>,
    read_buf: BytesMut,
    pending_pongs: VecDeque<Bytes>,
}

impl WsStream {
    pub fn new(inner: WebSocketStream<MaybeTlsStream<TcpStream>>) -> Self {
        Self { inner, read_buf: BytesMut::with_capacity(16 * 1024), pending_pongs: VecDeque::new() }
    }

    fn flush_pongs(&mut self, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        while !self.pending_pongs.is_empty() {
            match Pin::new(&mut self.inner).poll_ready(cx) {
                Poll::Pending => return Poll::Pending,
                Poll::Ready(Err(err)) => return Poll::Ready(Err(io::Error::other(err))),
                Poll::Ready(Ok(())) => {
                    if let Some(pong) = self.pending_pongs.pop_front() {
                        Pin::new(&mut self.inner).start_send(Message::Pong(pong)).map_err(io::Error::other)?;
                    }
                }
            }
        }
        Poll::Ready(Ok(()))
    }
}

impl AsyncRead for WsStream {
    fn poll_read(mut self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &mut ReadBuf<'_>) -> Poll<io::Result<()>> {
        if !self.read_buf.is_empty() {
            let take = buf.remaining().min(self.read_buf.len());
            buf.put_slice(&self.read_buf.split_to(take));
            return Poll::Ready(Ok(()));
        }
        loop {
            let _ = self.flush_pongs(cx);
            match Pin::new(&mut self.inner).poll_next(cx) {
                Poll::Pending => return Poll::Pending,
                Poll::Ready(None) | Poll::Ready(Some(Ok(Message::Close(_)))) => return Poll::Ready(Ok(())),
                Poll::Ready(Some(Ok(Message::Binary(data)))) if !data.is_empty() => {
                    let take = buf.remaining().min(data.len());
                    buf.put_slice(&data[..take]);
                    if take < data.len() { self.read_buf.extend_from_slice(&data[take..]); }
                    return Poll::Ready(Ok(()));
                }
                Poll::Ready(Some(Ok(Message::Ping(payload)))) => {
                    self.pending_pongs.push_back(payload);
                    let _ = self.flush_pongs(cx);
                }
                Poll::Ready(Some(Ok(_))) => continue,
                Poll::Ready(Some(Err(err))) => return Poll::Ready(Err(io::Error::other(err))),
            }
        }
    }
}

impl AsyncWrite for WsStream {
    fn poll_write(mut self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &[u8]) -> Poll<io::Result<usize>> {
        if buf.is_empty() { return Poll::Ready(Ok(0)); }
        if self.flush_pongs(cx)?.is_pending() { return Poll::Pending; }
        match Pin::new(&mut self.inner).poll_ready(cx) {
            Poll::Pending => Poll::Pending,
            Poll::Ready(Err(err)) => Poll::Ready(Err(io::Error::other(err))),
            Poll::Ready(Ok(())) => {
                let take = buf.len().min(MAX_WS_BINARY_FRAME);
                Pin::new(&mut self.inner)
                    .start_send(Message::Binary(Bytes::copy_from_slice(&buf[..take])))
                    .map_err(io::Error::other)?;
                Poll::Ready(Ok(take))
            }
        }
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        if self.flush_pongs(cx)?.is_pending() { return Poll::Pending; }
        Pin::new(&mut self.inner).poll_flush(cx).map_err(io::Error::other)
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_close(cx).map_err(io::Error::other)
    }
}

/// Computes `SHA256:<base64-no-pad>` over the OpenSSH public key blob, matching `ssh-server.ts`.
pub fn ssh_public_key_fingerprint(key: &PublicKey) -> Result<String, TransportError> {
    let wire = key.to_bytes().map_err(|e| TransportError::Ssh(format!("failed to encode server public key: {e}")))?;
    Ok(format!("SHA256:{}", BASE64_NO_PAD.encode(Sha256::digest(&wire))))
}

struct AgentSshHandler {
    expected_fingerprint: String,
    mismatch_actual: Arc<Mutex<Option<String>>>,
}

impl client::Handler for AgentSshHandler {
    type Error = russh::Error;

    async fn check_server_key(&mut self, server_public_key: &PublicKey) -> Result<bool, Self::Error> {
        let Ok(actual) = ssh_public_key_fingerprint(server_public_key) else { return Ok(false); };
        if actual == self.expected_fingerprint { return Ok(true); }
        if let Ok(mut guard) = self.mismatch_actual.lock() { *guard = Some(actual); }
        Ok(false)
    }
}

pub struct SessionRunParams<'a> {
    pub hub_url: &'a Url,
    pub info: &'a BootstrapInfo,
    pub identity: &'a DeviceIdentity,
    pub mode: TransportMode,
    pub heartbeat_interval: Duration,
    pub cancel: CancellationToken,
    pub router_events: Option<mpsc::UnboundedSender<RouterEvent>>,
}

/// Connects via WebSocket (or optional TCP fallback), verifies host key & Ed25519 auth,
/// executes `clinavat-agent-v1`, and runs the multiplexed RPC + heartbeat session.
pub async fn run_ssh_session<F>(params: SessionRunParams<'_>, on_connected: F) -> Result<(), TransportError>
where
    F: FnOnce(&str),
{
    let (handle, transport_label) = establish_ssh_handle(params.hub_url, params.info, params.identity, params.mode).await?;
    let mut channel = handle.channel_open_session().await.map_err(|e| TransportError::Ssh(format!("open session channel failed: {e}")))?;
    channel.exec(true, AGENT_EXEC_COMMAND).await.map_err(|e| TransportError::Ssh(format!("exec {AGENT_EXEC_COMMAND} failed: {e}")))?;
    on_connected(transport_label);

    let (outbound_tx, mut outbound_rx) = mpsc::channel::<Bytes>(256);
    let router = Arc::new(RpcRouter::new(
        params.identity.device_id.clone(),
        params.identity.homedir.clone(),
        params.identity.state_dir().to_path_buf(),
        ClientPlatform::parse(&params.identity.platform),
        outbound_tx,
        params.router_events,
    ));

    let hb_router = Arc::clone(&router);
    let hb_cancel = params.cancel.clone();
    let hb_interval = params.heartbeat_interval.max(Duration::from_millis(200));
    let hb_task = tokio::spawn(async move {
        let _ = hb_router.send_heartbeat().await;
        let mut ticker = tokio::time::interval(hb_interval);
        ticker.tick().await;
        loop {
            tokio::select! {
                _ = hb_cancel.cancelled() => break,
                _ = ticker.tick() => { if hb_router.send_heartbeat().await.is_err() { break; } }
            }
        }
    });

    let mut decoder = FrameDecoder::default();
    let mut exit_err: Option<TransportError> = None;
    loop {
        tokio::select! {
            _ = params.cancel.cancelled() => {
                let _ = channel.eof().await;
                let _ = channel.close().await;
                break;
            }
            maybe_out = outbound_rx.recv() => {
                let Some(mut data) = maybe_out else { break; };
                while !data.is_empty() {
                    let chunk = data.split_to(data.len().min(MAX_SSH_DATA_CHUNK));
                    if let Err(err) = channel.data(&chunk[..]).await {
                        exit_err = Some(TransportError::Ssh(format!("channel write failed: {err}")));
                        break;
                    }
                }
                if exit_err.is_some() { break; }
            }
            msg = channel.wait() => {
                match msg {
                    Some(ChannelMsg::Data { data }) => {
                        match decoder.push(&data) {
                            Ok(frames) => {
                                for frame in frames {
                                    if let Err(err) = router.handle_frame(frame) {
                                        exit_err = Some(TransportError::Framing(err.to_string()));
                                        break;
                                    }
                                }
                            }
                            Err(err) => { exit_err = Some(TransportError::Framing(err.to_string())); }
                        }
                        if exit_err.is_some() { break; }
                    }
                    Some(ChannelMsg::Eof | ChannelMsg::Close | ChannelMsg::ExitStatus { .. }) | None => break,
                    _ => {}
                }
            }
        }
    }

    hb_task.abort();
    router.cancel_all();
    let _ = handle.disconnect(russh::Disconnect::ByApplication, "session closed", "en").await;
    exit_err.map_or(Ok(()), Err)
}

async fn establish_ssh_handle(
    hub_url: &Url, info: &BootstrapInfo, identity: &DeviceIdentity, mode: TransportMode,
) -> Result<(Handle<AgentSshHandler>, &'static str), TransportError> {
    if mode != TransportMode::TcpOnly {
        let ws_label = if hub_url.scheme() == "https" { "wss" } else { "ws" };
        match open_ws_ssh(hub_url, info, identity).await {
            Ok(handle) => return Ok((handle, ws_label)),
            Err(err @ (TransportError::Maintenance | TransportError::RateLimited | TransportError::FingerprintMismatch { .. } | TransportError::AuthRejected)) => return Err(err),
            Err(ws_err) if mode == TransportMode::WsOnly || info.ssh_port == 0 => return Err(ws_err),
            Err(_) => {}
        }
    }
    Ok((open_tcp_ssh(info, identity).await?, "tcp"))
}

/// Formats `host:port`, bracketing bare IPv6 literals as `[host]:port` (`T2-M4`).
pub fn format_tcp_addr(host: &str, port: u16) -> String {
    let trimmed = host.trim();
    if trimmed.starts_with('[') && trimmed.ends_with(']') {
        format!("{trimmed}:{port}")
    } else if trimmed.contains(':') {
        format!("[{trimmed}]:{port}")
    } else {
        format!("{trimmed}:{port}")
    }
}

async fn open_ws_ssh(hub_url: &Url, info: &BootstrapInfo, identity: &DeviceIdentity) -> Result<Handle<AgentSshHandler>, TransportError> {
    let ws_url = build_ws_tunnel_url(hub_url, &info.ws_tunnel_path).map_err(|e| TransportError::WebSocket(e.to_string()))?;
    let request = ws_url.as_str().into_client_request().map_err(|e| TransportError::WebSocket(e.to_string()))?;
    let (ws_stream, _) = connect_async(request).await.map_err(|err| match &err {
        WsError::Http(resp) if resp.status().as_u16() == 503 => TransportError::Maintenance,
        WsError::Http(resp) if resp.status().as_u16() == 429 => TransportError::RateLimited,
        _ => TransportError::WebSocket(err.to_string()),
    })?;
    handshake_and_auth(WsStream::new(ws_stream), info, identity).await
}

async fn open_tcp_ssh(info: &BootstrapInfo, identity: &DeviceIdentity) -> Result<Handle<AgentSshHandler>, TransportError> {
    let addr = format_tcp_addr(&info.ssh_host, info.ssh_port);
    let tcp = tokio::time::timeout(Duration::from_secs(10), TcpStream::connect(&addr))
        .await
        .map_err(|_| TransportError::Tcp(format!("TCP connect timed out: {addr}")))?
        .map_err(|e| TransportError::Tcp(format!("TCP connect to {addr} failed: {e}")))?;
    let _ = tcp.set_nodelay(true);
    handshake_and_auth(tcp, info, identity).await
}

async fn handshake_and_auth<S>(stream: S, info: &BootstrapInfo, identity: &DeviceIdentity) -> Result<Handle<AgentSshHandler>, TransportError>
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let config = Arc::new(client::Config {
        keepalive_interval: Some(Duration::from_secs(20)),
        keepalive_max: 3,
        inactivity_timeout: Some(Duration::from_secs(90)),
        ..Default::default()
    });
    let mismatch_actual = Arc::new(Mutex::new(None));
    let handler = AgentSshHandler { expected_fingerprint: info.host_key_fingerprint.clone(), mismatch_actual: Arc::clone(&mismatch_actual) };
    let mut handle = match client::connect_stream(config, stream, handler).await {
        Ok(h) => h,
        Err(err) => {
            if let Some(actual) = mismatch_actual.lock().ok().and_then(|g| g.clone()) {
                return Err(TransportError::FingerprintMismatch { expected: info.host_key_fingerprint.clone(), actual });
            }
            return Err(TransportError::Ssh(err.to_string()));
        }
    };
    let username = format!("device:{}", identity.device_id);
    let key = PrivateKeyWithHashAlg::new(Arc::new(identity.ssh_private_key().clone()), None);
    let auth_res = handle.authenticate_publickey(username, key).await.map_err(|e| TransportError::Ssh(format!("publickey auth error: {e}")))?;
    if !auth_res.success() { return Err(TransportError::AuthRejected); }
    Ok(handle)
}
