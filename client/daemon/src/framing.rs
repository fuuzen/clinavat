use std::sync::atomic::{AtomicU32, Ordering};

use bytes::{Buf, BufMut, Bytes, BytesMut};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use thiserror::Error;

pub const FRAME_HEADER_SIZE: usize = 9;
pub const MAX_FRAME_PAYLOAD_BYTES: usize = 4 * 1024 * 1024;
pub const CLIENT_ID_HIGH_BIT: u32 = 0x8000_0000;
pub const MAX_BATCH_HEADER_BYTES: usize = 64 * 1024;
pub const MAX_BATCH_BODY_BYTES: usize = 4 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum FrameType {
    RpcRequest = 0x01,
    RpcResponse = 0x02,
    StreamData = 0x03,
    StreamEof = 0x04,
    StreamCancel = 0x05,
}

impl FrameType {
    pub fn from_u8(raw: u8) -> Result<Self, FramingError> {
        match raw {
            0x01 => Ok(Self::RpcRequest),
            0x02 => Ok(Self::RpcResponse),
            0x03 => Ok(Self::StreamData),
            0x04 => Ok(Self::StreamEof),
            0x05 => Ok(Self::StreamCancel),
            other => Err(FramingError::UnknownFrameType(other)),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Frame {
    pub frame_type: FrameType,
    pub stream_id: u32,
    pub payload: Bytes,
}

#[derive(Debug, Error)]
pub enum FramingError {
    #[error("frame payload exceeds limit ({actual} > {limit})")]
    PayloadTooLarge { actual: usize, limit: usize },
    #[error("unknown frame type: 0x{0:02x}")]
    UnknownFrameType(u8),
    #[error("batch header length invalid ({actual}, limit {limit})")]
    BatchHeaderInvalid { actual: usize, limit: usize },
    #[error("batch body length exceeds limit ({actual} > {limit})")]
    BatchBodyTooLarge { actual: usize, limit: usize },
    #[error("invalid JSON payload: {0}")]
    InvalidJson(#[from] serde_json::Error),
    #[error("batch header must be a JSON object")]
    BatchHeaderNotObject,
}

/// Allocates client-initiated IDs in `0x8000_0001..=0xffff_ffff` so they never collide with Hub IDs (`1..=0x7fff_ffff`).
pub struct ClientIdAllocator {
    next: AtomicU32,
}

impl Default for ClientIdAllocator {
    fn default() -> Self {
        Self::new()
    }
}

impl ClientIdAllocator {
    pub fn new() -> Self {
        Self { next: AtomicU32::new(1) }
    }

    pub fn allocate(&self) -> u32 {
        loop {
            let cur = self.next.load(Ordering::Relaxed);
            let next = if cur >= 0x7fff_ffff { 1 } else { cur + 1 };
            if self.next.compare_exchange_weak(cur, next, Ordering::Relaxed, Ordering::Relaxed).is_ok() {
                return CLIENT_ID_HIGH_BIT | cur;
            }
        }
    }
}

/// Encodes one Layer-1 frame: `[u32BE payloadLen][u8 frameType][u32BE streamId][payload]`.
pub fn encode_frame(frame: &Frame) -> Result<Bytes, FramingError> {
    if frame.payload.len() > MAX_FRAME_PAYLOAD_BYTES {
        return Err(FramingError::PayloadTooLarge { actual: frame.payload.len(), limit: MAX_FRAME_PAYLOAD_BYTES });
    }
    let mut out = BytesMut::with_capacity(FRAME_HEADER_SIZE + frame.payload.len());
    out.put_u32(frame.payload.len() as u32);
    out.put_u8(frame.frame_type as u8);
    out.put_u32(frame.stream_id);
    out.put_slice(&frame.payload);
    Ok(out.freeze())
}

/// Incremental Layer-1 decoder aligned byte-for-byte with `backend/src/client-host/framing.ts`.
pub struct FrameDecoder {
    buf: BytesMut,
    max_payload_bytes: usize,
}

impl Default for FrameDecoder {
    fn default() -> Self {
        Self::new(MAX_FRAME_PAYLOAD_BYTES)
    }
}

impl FrameDecoder {
    pub fn new(max_payload_bytes: usize) -> Self {
        Self { buf: BytesMut::with_capacity(16 * 1024), max_payload_bytes }
    }

    pub fn push(&mut self, chunk: &[u8]) -> Result<Vec<Frame>, FramingError> {
        if !chunk.is_empty() {
            self.buf.extend_from_slice(chunk);
        }
        let mut frames = Vec::new();
        while self.buf.len() >= FRAME_HEADER_SIZE {
            let payload_len = u32::from_be_bytes([self.buf[0], self.buf[1], self.buf[2], self.buf[3]]) as usize;
            let frame_type = FrameType::from_u8(self.buf[4])?;
            let stream_id = u32::from_be_bytes([self.buf[5], self.buf[6], self.buf[7], self.buf[8]]);
            if payload_len > self.max_payload_bytes {
                self.buf.clear();
                return Err(FramingError::PayloadTooLarge { actual: payload_len, limit: self.max_payload_bytes });
            }
            if self.buf.len() < FRAME_HEADER_SIZE + payload_len {
                break;
            }
            self.buf.advance(FRAME_HEADER_SIZE);
            let payload = if payload_len > 0 { self.buf.split_to(payload_len).freeze() } else { Bytes::new() };
            frames.push(Frame { frame_type, stream_id, payload });
        }
        Ok(frames)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RpcRequestPayload {
    pub id: u32,
    pub method: String,
    #[serde(default)]
    pub params: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RpcErrorPayload {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RpcResponsePayload {
    pub id: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<RpcErrorPayload>,
}

pub fn encode_rpc_request(id: u32, method: &str, params: Option<Value>) -> Result<Bytes, FramingError> {
    let body = serde_json::to_vec(&RpcRequestPayload { id, method: method.to_string(), params })?;
    encode_frame(&Frame { frame_type: FrameType::RpcRequest, stream_id: id, payload: Bytes::from(body) })
}

pub fn encode_rpc_ok(id: u32, result: Value) -> Result<Bytes, FramingError> {
    let body = serde_json::to_vec(&RpcResponsePayload { id, result: Some(result), error: None })?;
    encode_frame(&Frame { frame_type: FrameType::RpcResponse, stream_id: id, payload: Bytes::from(body) })
}

pub fn encode_rpc_err(id: u32, code: &str, message: impl Into<String>, data: Option<Value>) -> Result<Bytes, FramingError> {
    let body = serde_json::to_vec(&RpcResponsePayload {
        id,
        result: None,
        error: Some(RpcErrorPayload { code: code.to_string(), message: message.into(), data }),
    })?;
    encode_frame(&Frame { frame_type: FrameType::RpcResponse, stream_id: id, payload: Bytes::from(body) })
}

pub fn encode_stream_data(stream_id: u32, chunk: Bytes) -> Result<Bytes, FramingError> {
    encode_frame(&Frame { frame_type: FrameType::StreamData, stream_id, payload: chunk })
}

pub fn encode_stream_eof(stream_id: u32, meta: Option<&Value>) -> Result<Bytes, FramingError> {
    let payload = match meta {
        Some(value) => Bytes::from(serde_json::to_vec(value)?),
        None => Bytes::new(),
    };
    encode_frame(&Frame { frame_type: FrameType::StreamEof, stream_id, payload })
}

pub fn encode_stream_cancel(stream_id: u32, reason: Option<&str>) -> Result<Bytes, FramingError> {
    let payload = match reason {
        Some(text) if !text.is_empty() => Bytes::from(serde_json::to_vec(&serde_json::json!({ "reason": text }))?),
        _ => Bytes::new(),
    };
    encode_frame(&Frame { frame_type: FrameType::StreamCancel, stream_id, payload })
}

pub fn encode_heartbeat_request(id: u32) -> Result<Bytes, FramingError> {
    encode_rpc_request(id, "heartbeat", Some(serde_json::json!({})))
}

/// One Layer-2 sync batch record: `[u32BE headerLen][UTF-8 JSON header][u32BE bodyLen][body]`.
#[derive(Debug, Clone, PartialEq)]
pub struct BatchRecord {
    pub header: Map<String, Value>,
    pub body: Bytes,
}

pub fn encode_batch_record(record: &BatchRecord) -> Result<Bytes, FramingError> {
    let header_bytes = serde_json::to_vec(&Value::Object(record.header.clone()))?;
    if header_bytes.is_empty() || header_bytes.len() > MAX_BATCH_HEADER_BYTES {
        return Err(FramingError::BatchHeaderInvalid { actual: header_bytes.len(), limit: MAX_BATCH_HEADER_BYTES });
    }
    if record.body.len() > MAX_BATCH_BODY_BYTES {
        return Err(FramingError::BatchBodyTooLarge { actual: record.body.len(), limit: MAX_BATCH_BODY_BYTES });
    }
    let mut out = BytesMut::with_capacity(8 + header_bytes.len() + record.body.len());
    out.put_u32(header_bytes.len() as u32);
    out.put_slice(&header_bytes);
    out.put_u32(record.body.len() as u32);
    out.put_slice(&record.body);
    Ok(out.freeze())
}

/// Incremental Layer-2 sync batch decoder aligned with `mirror-reconcile.ts::BatchRecordDecoder`.
pub struct BatchRecordDecoder {
    buf: BytesMut,
    max_header_bytes: usize,
    max_body_bytes: usize,
}

impl Default for BatchRecordDecoder {
    fn default() -> Self {
        Self::new(MAX_BATCH_HEADER_BYTES, MAX_BATCH_BODY_BYTES)
    }
}

impl BatchRecordDecoder {
    pub fn new(max_header_bytes: usize, max_body_bytes: usize) -> Self {
        Self { buf: BytesMut::with_capacity(16 * 1024), max_header_bytes, max_body_bytes }
    }

    pub fn push(&mut self, chunk: &[u8]) -> Result<Vec<BatchRecord>, FramingError> {
        if !chunk.is_empty() {
            self.buf.extend_from_slice(chunk);
        }
        let mut records = Vec::new();
        while self.buf.len() >= 4 {
            let header_len = u32::from_be_bytes([self.buf[0], self.buf[1], self.buf[2], self.buf[3]]) as usize;
            if header_len == 0 || header_len > self.max_header_bytes {
                self.buf.clear();
                return Err(FramingError::BatchHeaderInvalid { actual: header_len, limit: self.max_header_bytes });
            }
            if self.buf.len() < 4 + header_len + 4 {
                break;
            }
            let off = 4 + header_len;
            let body_len = u32::from_be_bytes([self.buf[off], self.buf[off + 1], self.buf[off + 2], self.buf[off + 3]]) as usize;
            if body_len > self.max_body_bytes {
                self.buf.clear();
                return Err(FramingError::BatchBodyTooLarge { actual: body_len, limit: self.max_body_bytes });
            }
            let total = 8 + header_len + body_len;
            if self.buf.len() < total {
                break;
            }
            let header = match serde_json::from_slice::<Value>(&self.buf[4..4 + header_len])? {
                Value::Object(map) => map,
                _ => {
                    self.buf.clear();
                    return Err(FramingError::BatchHeaderNotObject);
                }
            };
            self.buf.advance(8 + header_len);
            let body = if body_len > 0 { self.buf.split_to(body_len).freeze() } else { Bytes::new() };
            records.push(BatchRecord { header, body });
        }
        Ok(records)
    }
}
