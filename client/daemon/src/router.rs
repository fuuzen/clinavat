use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};

use bytes::Bytes;
use serde_json::Value;
use tokio::sync::{mpsc, oneshot, watch};
use tokio_util::sync::CancellationToken;

use crate::framing::{
    encode_heartbeat_request, encode_rpc_err, encode_rpc_ok, encode_stream_cancel,
    ClientIdAllocator, Frame, FrameType, FramingError, RpcRequestPayload, RpcResponsePayload,
};
use crate::ops::{dispatch_method, ActiveStream, OpContext, RpcErrorCode, SessionOpsState, StreamInbound};
use crate::path_guard::ClientPlatform;

const MAX_RECENT_CANCELLED: usize = 256;

#[derive(Debug, Clone)]
pub enum RouterEvent {
    HeartbeatAck { server_time: String },
    RequestCancelled { id: u32, method: String },
}

struct ActiveRequest {
    method: String,
    cancel: CancellationToken,
}

/// Routes Layer-1 multiplexed frames between the SSH session transport and RPC/stream handlers.
pub struct RpcRouter {
    device_id: String,
    homedir: String,
    platform: ClientPlatform,
    outbound_tx: mpsc::Sender<Bytes>,
    event_tx: Option<mpsc::UnboundedSender<RouterEvent>>,
    id_alloc: ClientIdAllocator,
    active_requests: Arc<Mutex<HashMap<u32, ActiveRequest>>>,
    active_streams: Arc<Mutex<HashMap<u32, ActiveStream>>>,
    recent_cancelled_streams: Arc<Mutex<VecDeque<u32>>>,
    pending_client_rpcs: Arc<Mutex<HashMap<u32, oneshot::Sender<Result<Value, String>>>>>,
    ops_state: Arc<SessionOpsState>,
}

impl RpcRouter {
    pub fn new(
        device_id: String,
        homedir: String,
        state_dir: PathBuf,
        platform: ClientPlatform,
        outbound_tx: mpsc::Sender<Bytes>,
        event_tx: Option<mpsc::UnboundedSender<RouterEvent>>,
    ) -> Self {
        Self {
            device_id,
            homedir,
            platform,
            outbound_tx,
            event_tx,
            id_alloc: ClientIdAllocator::new(),
            active_requests: Arc::new(Mutex::new(HashMap::new())),
            active_streams: Arc::new(Mutex::new(HashMap::new())),
            recent_cancelled_streams: Arc::new(Mutex::new(VecDeque::new())),
            pending_client_rpcs: Arc::new(Mutex::new(HashMap::new())),
            ops_state: Arc::new(SessionOpsState::new(Some(state_dir))),
        }
    }

    /// Dispatches one decoded Layer-1 frame from the Hub.
    pub fn handle_frame(&self, frame: Frame) -> Result<(), FramingError> {
        match frame.frame_type {
            FrameType::RpcRequest => self.handle_rpc_request(frame.stream_id, &frame.payload),
            FrameType::RpcResponse => self.handle_rpc_response(&frame.payload),
            FrameType::StreamData => {
                self.handle_stream_data(frame.stream_id, frame.payload);
                Ok(())
            }
            FrameType::StreamEof => {
                self.handle_stream_eof(frame.stream_id, frame.payload);
                Ok(())
            }
            FrameType::StreamCancel => {
                self.handle_cancel(frame.stream_id);
                Ok(())
            }
        }
    }

    fn handle_stream_data(&self, stream_id: u32, payload: Bytes) {
        let mut cancel_reason: Option<(&'static str, Option<CancellationToken>)> = None;
        if let Ok(mut guard) = self.active_streams.lock() {
            if let Some(entry) = guard.get(&stream_id) {
                if let Some(tx) = &entry.inbound_tx {
                    let next = entry.pending_bytes.fetch_add(payload.len(), Ordering::Relaxed) + payload.len();
                    if entry.max_pending_bytes > 0 && next > entry.max_pending_bytes {
                        let tok = guard.remove(&stream_id).map(|e| e.cancel);
                        cancel_reason = Some(("inbound stream buffer exceeded limit", tok));
                    } else if tx.send(StreamInbound::Data(payload)).is_err() {
                        let tok = guard.remove(&stream_id).map(|e| e.cancel);
                        cancel_reason = Some(("stream consumer closed", tok));
                    }
                }
            } else if self.mark_recent_cancelled(stream_id) {
                cancel_reason = Some(("stream not found or already closed", None));
            }
        }
        if let Some((reason, tok)) = cancel_reason {
            self.mark_recent_cancelled(stream_id);
            if let Some(t) = tok { t.cancel(); }
            self.send_stream_cancel_nonblocking(stream_id, reason);
        }
    }

    fn mark_recent_cancelled(&self, stream_id: u32) -> bool {
        let Ok(mut guard) = self.recent_cancelled_streams.lock() else { return false };
        if guard.contains(&stream_id) {
            return false;
        }
        if guard.len() >= MAX_RECENT_CANCELLED {
            guard.pop_front();
        }
        guard.push_back(stream_id);
        true
    }

    fn send_stream_cancel_nonblocking(&self, stream_id: u32, reason: &str) {
        if let Ok(frame) = encode_stream_cancel(stream_id, Some(reason)) {
            if self.outbound_tx.try_send(frame.clone()).is_err() {
                let tx = self.outbound_tx.clone();
                if let Ok(handle) = tokio::runtime::Handle::try_current() {
                    handle.spawn(async move { let _ = tx.send(frame).await; });
                }
            }
        }
    }

    fn handle_stream_eof(&self, stream_id: u32, payload: Bytes) {
        if let Ok(mut guard) = self.active_streams.lock() {
            if let Some(entry) = guard.get(&stream_id) {
                if let Some(tx) = &entry.inbound_tx {
                    let _ = tx.send(StreamInbound::Eof(payload));
                    return;
                }
            }
            guard.remove(&stream_id);
        }
    }

    pub fn unregister_stream(&self, stream_id: u32) {
        if let Ok(mut guard) = self.active_streams.lock() {
            guard.remove(&stream_id);
        }
    }

    /// Sends a Client -> Hub `heartbeat` RPC using a high-bit client request ID and awaits the response.
    pub async fn send_heartbeat(&self) -> Result<String, String> {
        let id = self.id_alloc.allocate();
        let frame_bytes = encode_heartbeat_request(id).map_err(|e| e.to_string())?;
        let (tx, rx) = oneshot::channel();
        if let Ok(mut guard) = self.pending_client_rpcs.lock() {
            guard.insert(id, tx);
        }
        if let Err(err) = self.outbound_tx.send(frame_bytes).await {
            if let Ok(mut guard) = self.pending_client_rpcs.lock() {
                guard.remove(&id);
            }
            return Err(format!("heartbeat send failed: {err}"));
        }
        let response = rx.await.map_err(|_| "heartbeat response channel closed".to_string())??;
        let server_time = response
            .get("serverTime")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        if let Some(events) = &self.event_tx {
            let _ = events.send(RouterEvent::HeartbeatAck {
                server_time: server_time.clone(),
            });
        }
        Ok(server_time)
    }

    /// Cancels all in-flight RPCs, streams, staged writes, and pending client RPCs when the transport closes.
    pub fn cancel_all(&self) {
        if let Ok(mut guard) = self.active_requests.lock() {
            for (_, req) in guard.drain() {
                req.cancel.cancel();
            }
        }
        if let Ok(mut guard) = self.active_streams.lock() {
            for (_, entry) in guard.drain() {
                entry.cancel.cancel();
            }
        }
        if let Ok(mut guard) = self.pending_client_rpcs.lock() {
            for (_, tx) in guard.drain() {
                let _ = tx.send(Err("transport closed".into()));
            }
        }
        self.ops_state.cleanup_all();
    }

    fn handle_rpc_request(&self, stream_id: u32, payload: &[u8]) -> Result<(), FramingError> {
        let req: RpcRequestPayload = serde_json::from_slice(payload)?;
        let token = CancellationToken::new();
        if let Ok(mut guard) = self.active_requests.lock() {
            guard.insert(
                req.id,
                ActiveRequest {
                    method: req.method.clone(),
                    cancel: token.clone(),
                },
            );
        }

        let (response_tx, response_rx) = watch::channel(false);
        let ctx = OpContext {
            id: req.id,
            stream_id,
            device_id: self.device_id.clone(),
            homedir: self.homedir.clone(),
            platform: self.platform,
            cancel: token.clone(),
            outbound_tx: self.outbound_tx.clone(),
            active_streams: Arc::clone(&self.active_streams),
            response_sent: response_rx,
            state: Arc::clone(&self.ops_state),
        };
        let active_requests = Arc::clone(&self.active_requests);
        let outbound_tx = self.outbound_tx.clone();
        let method = req.method;
        let params = req.params;
        let id = req.id;

        tokio::spawn(async move {
            let result = tokio::select! {
                _ = token.cancelled() => None,
                outcome = dispatch_method(&method, params, ctx) => Some(outcome),
            };
            if let Ok(mut guard) = active_requests.lock() {
                guard.remove(&id);
            }
            if token.is_cancelled() {
                return;
            }
            let Some(outcome) = result else {
                return;
            };
            let encoded = match outcome {
                Ok(value) => encode_rpc_ok(id, value),
                Err(err) => encode_rpc_err(id, err.code.as_str(), err.message, err.data),
            };
            match encoded {
                Ok(bytes) => {
                    if outbound_tx.send(bytes).await.is_ok() {
                        let _ = response_tx.send(true);
                    }
                }
                Err(err) => {
                    if let Ok(fallback) = encode_rpc_err(
                        id,
                        RpcErrorCode::InternalError.as_str(),
                        format!("failed to encode RPC response: {err}"),
                        None,
                    ) {
                        let _ = outbound_tx.send(fallback).await;
                    }
                }
            }
        });
        Ok(())
    }

    fn handle_rpc_response(&self, payload: &[u8]) -> Result<(), FramingError> {
        let res: RpcResponsePayload = serde_json::from_slice(payload)?;
        let waiter = self
            .pending_client_rpcs
            .lock()
            .ok()
            .and_then(|mut guard| guard.remove(&res.id));
        if let Some(tx) = waiter {
            if let Some(err) = res.error {
                let _ = tx.send(Err(format!("{}: {}", err.code, err.message)));
            } else {
                let _ = tx.send(Ok(res.result.unwrap_or(Value::Null)));
            }
        }
        Ok(())
    }

    fn handle_cancel(&self, id: u32) {
        if let Ok(mut guard) = self.active_requests.lock() {
            if let Some(req) = guard.remove(&id) {
                req.cancel.cancel();
                if let Some(events) = &self.event_tx {
                    let _ = events.send(RouterEvent::RequestCancelled {
                        id,
                        method: req.method,
                    });
                }
            }
        }
        if let Ok(mut guard) = self.active_streams.lock() {
            if let Some(entry) = guard.remove(&id) {
                entry.cancel.cancel();
            }
        }
        if let Ok(mut guard) = self.pending_client_rpcs.lock() {
            if let Some(tx) = guard.remove(&id) {
                let _ = tx.send(Err("cancelled by peer".into()));
            }
        }
    }
}
