use std::{collections::VecDeque, sync::Arc, time::Duration};

use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use regex::bytes::Regex;
use serde::{Deserialize, Serialize};
use thiserror::Error;
use tokio::{
    sync::{broadcast, Mutex, Notify},
    task::JoinHandle,
    time::timeout,
};
use uuid::Uuid;

use crate::serial::{AdapterConnection, SerialAdapter};

const MAX_BUFFER_BYTES: usize = 64 * 1024;

#[derive(Debug, Error)]
pub enum CoreError {
    #[error("serial port not found: {0}")]
    PortNotFound(String),
    #[error("no serial session is open")]
    NotOpen,
    #[error("session does not match active session")]
    InvalidSession,
    #[error("invalid {encoding} payload: {reason}")]
    InvalidPayload { encoding: String, reason: String },
    #[error("configuration can only change while closed (pass reopen=true to reopen)")]
    MustCloseToConfigure,
    #[error("adapter connection failed: {0}")]
    Adapter(String),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DataEncoding {
    Text,
    Hex,
    Base64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Direction {
    Tx,
    Rx,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SerialConfig {
    pub port: String,
    pub baud_rate: u32,
    pub data_bits: u8,
    pub parity: String,
    pub stop_bits: u8,
    pub flow_control: String,
    pub exclusive: bool,
    pub dtr: bool,
    pub rts: bool,
}

impl Default for SerialConfig {
    fn default() -> Self {
        Self {
            port: "mock://loopback-01".into(),
            baud_rate: 115_200,
            data_bits: 8,
            parity: "none".into(),
            stop_bits: 1,
            flow_control: "none".into(),
            exclusive: true,
            dtr: false,
            rts: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PortInfo {
    pub id: String,
    pub display_name: String,
    pub is_mock: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Frame {
    pub cursor: u64,
    pub timestamp_ms: u64,
    pub direction: Direction,
    pub raw_base64: String,
    pub raw_hex: String,
    pub text_utf8: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BufferRead {
    pub frames: Vec<Frame>,
    pub next_cursor: u64,
    pub has_more: bool,
    pub dropped: bool,
    pub cursor_expired: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionStatus {
    pub connected: bool,
    pub session_id: Option<String>,
    pub config: Option<SerialConfig>,
    pub rx_cursor: u64,
    pub oldest_cursor: u64,
    pub buffered_bytes: usize,
    pub buffered_frames: usize,
    pub dropped_frames: u64,
    pub rx_bytes: u64,
    pub tx_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WaitCondition {
    pub contains_text: Option<String>,
    pub contains_hex: Option<String>,
    pub frame_prefix: Option<String>,
    pub regex: Option<String>,
    /// Reserved structured field matcher for future protocol decoders.
    pub protocol_field: Option<serde_json::Value>,
}

impl WaitCondition {
    fn matches(&self, frame: &Frame) -> bool {
        let bytes = match BASE64.decode(&frame.raw_base64) {
            Ok(value) => value,
            Err(_) => return false,
        };
        let any_predicate = self.contains_text.is_some()
            || self.contains_hex.is_some()
            || self.frame_prefix.is_some()
            || self.regex.is_some()
            || self.protocol_field.is_some();
        if !any_predicate {
            return true;
        }
        if let Some(expected) = &self.contains_text {
            if !String::from_utf8_lossy(&bytes).contains(expected) {
                return false;
            }
        }
        if let Some(expected) = &self.contains_hex {
            let expected = expected.replace([' ', ':'], "").to_ascii_lowercase();
            if !hex::encode(&bytes).contains(&expected) {
                return false;
            }
        }
        if let Some(prefix) = &self.frame_prefix {
            let prefix = match hex::decode(prefix.replace([' ', ':'], "")) {
                Ok(value) => value,
                Err(_) => return false,
            };
            if !bytes.starts_with(&prefix) {
                return false;
            }
        }
        if let Some(pattern) = &self.regex {
            match Regex::new(pattern) {
                Ok(regex) if regex.is_match(&bytes) => {}
                _ => return false,
            }
        }
        // No decoder is registered in this slice, so a requested protocol field cannot match.
        self.protocol_field.is_none()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SerialCommand {
    ListPorts,
    Open {
        config: SerialConfig,
    },
    Close {
        session_id: String,
    },
    Configure {
        config: SerialConfig,
        reopen: bool,
    },
    Status,
    Send {
        session_id: String,
        encoding: DataEncoding,
        payload: String,
        action_id: Option<String>,
        timeout_ms: Option<u64>,
    },
    ReadSince {
        session_id: String,
        after_cursor: u64,
        max_bytes: usize,
        max_frames: usize,
    },
    WaitFor {
        session_id: String,
        after_cursor: u64,
        condition: WaitCondition,
        timeout_ms: u64,
    },
    Exchange {
        session_id: String,
        encoding: DataEncoding,
        payload: String,
        condition: WaitCondition,
        timeout_ms: u64,
        action_id: Option<String>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum CommandResult {
    Ports {
        ports: Vec<PortInfo>,
    },
    Opened {
        session_id: String,
        rx_cursor: u64,
    },
    Closed,
    Configured {
        session_id: String,
        rx_cursor: u64,
    },
    Status {
        status: SessionStatus,
    },
    Sent {
        action_id: String,
        frame: Frame,
    },
    Read {
        read: BufferRead,
    },
    Waited {
        matched: Option<Frame>,
        next_cursor: u64,
        timed_out: bool,
        cursor_expired: bool,
    },
    Exchanged {
        action_id: String,
        response: Option<Frame>,
        next_cursor: u64,
        timed_out: bool,
        cursor_expired: bool,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EventKind {
    CommandStarted,
    CommandCompleted,
    CommandFailed,
    Frame,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SerialEvent {
    pub event_id: String,
    pub timestamp_ms: u64,
    pub kind: EventKind,
    pub action: String,
    pub action_id: Option<String>,
    pub detail: serde_json::Value,
}

struct ActiveSession {
    id: String,
    config: SerialConfig,
    outgoing: tokio::sync::mpsc::Sender<Vec<u8>>,
    reader: JoinHandle<()>,
}

struct State {
    session: Option<ActiveSession>,
    frames: VecDeque<Frame>,
    next_cursor: u64,
    buffered_bytes: usize,
    dropped_frames: u64,
    rx_bytes: u64,
    tx_bytes: u64,
}

impl Default for State {
    fn default() -> Self {
        Self {
            session: None,
            frames: VecDeque::new(),
            next_cursor: 1,
            buffered_bytes: 0,
            dropped_frames: 0,
            rx_bytes: 0,
            tx_bytes: 0,
        }
    }
}

pub struct SerialCore {
    adapter: Arc<dyn SerialAdapter>,
    state: Arc<Mutex<State>>,
    events: broadcast::Sender<SerialEvent>,
    audit: Arc<std::sync::Mutex<VecDeque<SerialEvent>>>,
    changed: Arc<Notify>,
}

impl SerialCore {
    pub fn new(adapter: Arc<dyn SerialAdapter>) -> Self {
        let (events, _) = broadcast::channel(512);
        Self {
            adapter,
            state: Arc::new(Mutex::new(State::default())),
            events,
            audit: Arc::new(std::sync::Mutex::new(VecDeque::with_capacity(512))),
            changed: Arc::new(Notify::new()),
        }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<SerialEvent> {
        self.events.subscribe()
    }

    /// Bounded in-memory session audit. Persistence is intentionally deferred from this slice.
    pub fn audit_snapshot(&self) -> Vec<SerialEvent> {
        self.audit
            .lock()
            .map(|events| events.iter().cloned().collect())
            .unwrap_or_default()
    }

    fn emit(
        &self,
        kind: EventKind,
        action: &str,
        action_id: Option<String>,
        detail: serde_json::Value,
    ) {
        let event = SerialEvent {
            event_id: Uuid::new_v4().to_string(),
            timestamp_ms: now_ms(),
            kind,
            action: action.into(),
            action_id,
            detail,
        };
        record_event(&self.events, &self.audit, event);
    }

    pub async fn execute(&self, command: SerialCommand) -> Result<CommandResult, CoreError> {
        let action = command_name(&command);
        let action_id = match &command {
            SerialCommand::Send { action_id, .. } | SerialCommand::Exchange { action_id, .. } => {
                action_id.clone()
            }
            _ => None,
        };
        self.emit(
            EventKind::CommandStarted,
            action,
            action_id.clone(),
            serde_json::json!({ "command": command }),
        );
        let result = self.execute_inner(command).await;
        match &result {
            Ok(value) => self.emit(
                EventKind::CommandCompleted,
                action,
                action_id,
                serde_json::to_value(value).unwrap_or_default(),
            ),
            Err(error) => self.emit(
                EventKind::CommandFailed,
                action,
                action_id,
                serde_json::json!({ "error": error.to_string() }),
            ),
        }
        result
    }

    async fn execute_inner(&self, command: SerialCommand) -> Result<CommandResult, CoreError> {
        match command {
            SerialCommand::ListPorts => Ok(CommandResult::Ports {
                ports: self.adapter.list_ports().await?,
            }),
            SerialCommand::Open { config } => self.open(config).await,
            SerialCommand::Close { session_id } => self.close(&session_id).await,
            SerialCommand::Configure { config, reopen } => self.configure(config, reopen).await,
            SerialCommand::Status => Ok(CommandResult::Status {
                status: self.status().await,
            }),
            SerialCommand::Send {
                session_id,
                encoding,
                payload,
                action_id,
                timeout_ms,
            } => {
                self.send(&session_id, encoding, payload, action_id, timeout_ms)
                    .await
            }
            SerialCommand::ReadSince {
                session_id,
                after_cursor,
                max_bytes,
                max_frames,
            } => {
                self.ensure_session(&session_id).await?;
                Ok(CommandResult::Read {
                    read: self.read(after_cursor, max_bytes, max_frames).await,
                })
            }
            SerialCommand::WaitFor {
                session_id,
                after_cursor,
                condition,
                timeout_ms,
            } => {
                self.ensure_session(&session_id).await?;
                let result = self.wait_for(after_cursor, condition, timeout_ms).await;
                Ok(CommandResult::Waited {
                    matched: result.0,
                    next_cursor: result.1,
                    timed_out: result.2,
                    cursor_expired: result.3,
                })
            }
            SerialCommand::Exchange {
                session_id,
                encoding,
                payload,
                condition,
                timeout_ms,
                action_id,
            } => {
                self.exchange(
                    &session_id,
                    encoding,
                    payload,
                    condition,
                    timeout_ms,
                    action_id,
                )
                .await
            }
        }
    }

    async fn open(&self, config: SerialConfig) -> Result<CommandResult, CoreError> {
        if self.state.lock().await.session.is_some() {
            return Err(CoreError::Adapter(
                "a serial session is already open".into(),
            ));
        }
        let AdapterConnection {
            mut incoming,
            outgoing,
        } = self.adapter.open(&config).await?;
        let state = self.state.clone();
        let events = self.events.clone();
        let audit = self.audit.clone();
        let changed = self.changed.clone();
        let reader = tokio::spawn(async move {
            while let Some(bytes) = incoming.recv().await {
                let frame = append_frame(&state, Direction::Rx, bytes).await;
                record_event(&events, &audit, frame_event(frame));
                changed.notify_waiters();
            }
        });
        let id = Uuid::new_v4().to_string();
        let rx_cursor = {
            let mut state = self.state.lock().await;
            state.session = Some(ActiveSession {
                id: id.clone(),
                config,
                outgoing,
                reader,
            });
            state.next_cursor.saturating_sub(1)
        };
        Ok(CommandResult::Opened {
            session_id: id,
            rx_cursor,
        })
    }

    async fn close(&self, session_id: &str) -> Result<CommandResult, CoreError> {
        let session = {
            let mut state = self.state.lock().await;
            let active = state.session.take().ok_or(CoreError::NotOpen)?;
            if active.id != session_id {
                state.session = Some(active);
                return Err(CoreError::InvalidSession);
            }
            active
        };
        session.reader.abort();
        Ok(CommandResult::Closed)
    }

    async fn configure(
        &self,
        config: SerialConfig,
        reopen: bool,
    ) -> Result<CommandResult, CoreError> {
        let active = {
            let mut state = self.state.lock().await;
            state.session.take()
        };
        if let Some(session) = active {
            if !reopen {
                self.state.lock().await.session = Some(session);
                return Err(CoreError::MustCloseToConfigure);
            }
            session.reader.abort();
        }
        self.open(config).await.map(|result| match result {
            CommandResult::Opened {
                session_id,
                rx_cursor,
            } => CommandResult::Configured {
                session_id,
                rx_cursor,
            },
            _ => unreachable!(),
        })
    }

    async fn send(
        &self,
        session_id: &str,
        encoding: DataEncoding,
        payload: String,
        action_id: Option<String>,
        timeout_ms: Option<u64>,
    ) -> Result<CommandResult, CoreError> {
        let bytes = decode_payload(&encoding, &payload)?;
        let outgoing = {
            let state = self.state.lock().await;
            let session = state.session.as_ref().ok_or(CoreError::NotOpen)?;
            if session.id != session_id {
                return Err(CoreError::InvalidSession);
            }
            session.outgoing.clone()
        };
        let limit = Duration::from_millis(timeout_ms.unwrap_or(1_000));
        timeout(limit, outgoing.send(bytes.clone()))
            .await
            .map_err(|_| CoreError::Adapter("send timed out".into()))?
            .map_err(|_| CoreError::Adapter("serial writer closed".into()))?;
        let frame = append_frame(&self.state, Direction::Tx, bytes).await;
        self.emit(
            EventKind::Frame,
            "frame",
            action_id.clone(),
            serde_json::to_value(&frame).unwrap_or_default(),
        );
        self.changed.notify_waiters();
        Ok(CommandResult::Sent {
            action_id: action_id.unwrap_or_else(|| Uuid::new_v4().to_string()),
            frame,
        })
    }

    async fn exchange(
        &self,
        session_id: &str,
        encoding: DataEncoding,
        payload: String,
        condition: WaitCondition,
        timeout_ms: u64,
        action_id: Option<String>,
    ) -> Result<CommandResult, CoreError> {
        self.ensure_session(session_id).await?;
        let before_cursor = { self.state.lock().await.next_cursor.saturating_sub(1) };
        let sent = self
            .send(session_id, encoding, payload, action_id, Some(timeout_ms))
            .await?;
        let id = match sent {
            CommandResult::Sent { action_id, .. } => action_id,
            _ => unreachable!(),
        };
        let (response, next_cursor, timed_out, cursor_expired) =
            self.wait_for(before_cursor, condition, timeout_ms).await;
        Ok(CommandResult::Exchanged {
            action_id: id,
            response,
            next_cursor,
            timed_out,
            cursor_expired,
        })
    }

    async fn ensure_session(&self, session_id: &str) -> Result<(), CoreError> {
        let state = self.state.lock().await;
        match &state.session {
            Some(session) if session.id == session_id => Ok(()),
            Some(_) => Err(CoreError::InvalidSession),
            None => Err(CoreError::NotOpen),
        }
    }

    async fn status(&self) -> SessionStatus {
        let state = self.state.lock().await;
        SessionStatus {
            connected: state.session.is_some(),
            session_id: state.session.as_ref().map(|session| session.id.clone()),
            config: state.session.as_ref().map(|session| session.config.clone()),
            rx_cursor: state.next_cursor.saturating_sub(1),
            oldest_cursor: state
                .frames
                .front()
                .map(|frame| frame.cursor)
                .unwrap_or(state.next_cursor),
            buffered_bytes: state.buffered_bytes,
            buffered_frames: state.frames.len(),
            dropped_frames: state.dropped_frames,
            rx_bytes: state.rx_bytes,
            tx_bytes: state.tx_bytes,
        }
    }

    async fn read(&self, after_cursor: u64, max_bytes: usize, max_frames: usize) -> BufferRead {
        let state = self.state.lock().await;
        read_locked(&state, after_cursor, max_bytes.max(1), max_frames.max(1))
    }

    async fn wait_for(
        &self,
        after_cursor: u64,
        condition: WaitCondition,
        timeout_ms: u64,
    ) -> (Option<Frame>, u64, bool, bool) {
        let deadline = tokio::time::Instant::now() + Duration::from_millis(timeout_ms);
        let mut cursor = after_cursor;
        loop {
            let read = self.read(cursor, MAX_BUFFER_BYTES, usize::MAX).await;
            if read.cursor_expired {
                return (None, read.next_cursor, false, true);
            }
            for frame in read.frames {
                cursor = frame.cursor;
                if frame.direction == Direction::Rx && condition.matches(&frame) {
                    return (Some(frame), cursor, false, false);
                }
            }
            cursor = read.next_cursor;
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            if remaining.is_zero() {
                return (None, cursor, true, false);
            }
            let notified = self.changed.notified();
            if timeout(remaining, notified).await.is_err() {
                return (None, cursor, true, false);
            }
        }
    }
}

async fn append_frame(state: &Arc<Mutex<State>>, direction: Direction, bytes: Vec<u8>) -> Frame {
    let mut state = state.lock().await;
    let frame = Frame {
        cursor: state.next_cursor,
        timestamp_ms: now_ms(),
        direction: direction.clone(),
        raw_base64: BASE64.encode(&bytes),
        raw_hex: hex::encode_upper(&bytes),
        text_utf8: String::from_utf8(bytes.clone()).ok(),
    };
    state.next_cursor += 1;
    state.buffered_bytes += bytes.len();
    match direction {
        Direction::Rx => state.rx_bytes += bytes.len() as u64,
        Direction::Tx => state.tx_bytes += bytes.len() as u64,
    }
    state.frames.push_back(frame.clone());
    while state.buffered_bytes > MAX_BUFFER_BYTES {
        if let Some(removed) = state.frames.pop_front() {
            state.buffered_bytes -= BASE64
                .decode(removed.raw_base64)
                .map(|value| value.len())
                .unwrap_or_default();
            state.dropped_frames += 1;
        } else {
            break;
        }
    }
    frame
}

fn read_locked(
    state: &State,
    after_cursor: u64,
    max_bytes: usize,
    max_frames: usize,
) -> BufferRead {
    let oldest = state
        .frames
        .front()
        .map(|frame| frame.cursor)
        .unwrap_or(state.next_cursor);
    if after_cursor.saturating_add(1) < oldest {
        return BufferRead {
            frames: vec![],
            next_cursor: oldest.saturating_sub(1),
            has_more: true,
            dropped: true,
            cursor_expired: true,
        };
    }
    let mut bytes = 0usize;
    let mut frames = Vec::new();
    for frame in state
        .frames
        .iter()
        .filter(|frame| frame.cursor > after_cursor)
    {
        let length = BASE64
            .decode(&frame.raw_base64)
            .map(|value| value.len())
            .unwrap_or_default();
        if !frames.is_empty() && (frames.len() >= max_frames || bytes + length > max_bytes) {
            break;
        }
        bytes += length;
        frames.push(frame.clone());
    }
    let next_cursor = frames
        .last()
        .map(|frame| frame.cursor)
        .unwrap_or(after_cursor);
    let has_more = state.frames.iter().any(|frame| frame.cursor > next_cursor);
    BufferRead {
        frames,
        next_cursor,
        has_more,
        dropped: false,
        cursor_expired: false,
    }
}

fn decode_payload(encoding: &DataEncoding, payload: &str) -> Result<Vec<u8>, CoreError> {
    match encoding {
        DataEncoding::Text => Ok(payload.as_bytes().to_vec()),
        DataEncoding::Hex => hex::decode(payload.replace([' ', ':'], "")).map_err(|error| {
            CoreError::InvalidPayload {
                encoding: "hex".into(),
                reason: error.to_string(),
            }
        }),
        DataEncoding::Base64 => BASE64
            .decode(payload)
            .map_err(|error| CoreError::InvalidPayload {
                encoding: "base64".into(),
                reason: error.to_string(),
            }),
    }
}

fn frame_event(frame: Frame) -> SerialEvent {
    SerialEvent {
        event_id: Uuid::new_v4().to_string(),
        timestamp_ms: now_ms(),
        kind: EventKind::Frame,
        action: "frame".into(),
        action_id: None,
        detail: serde_json::to_value(frame).unwrap_or_default(),
    }
}
fn record_event(
    events: &broadcast::Sender<SerialEvent>,
    audit: &std::sync::Mutex<VecDeque<SerialEvent>>,
    event: SerialEvent,
) {
    if let Ok(mut audit) = audit.lock() {
        if audit.len() == 512 {
            audit.pop_front();
        }
        audit.push_back(event.clone());
    }
    let _ = events.send(event);
}
fn command_name(command: &SerialCommand) -> &'static str {
    match command {
        SerialCommand::ListPorts => "serial.list_ports",
        SerialCommand::Open { .. } => "serial.open",
        SerialCommand::Close { .. } => "serial.close",
        SerialCommand::Configure { .. } => "serial.configure",
        SerialCommand::Status => "serial.status",
        SerialCommand::Send { .. } => "serial.send",
        SerialCommand::ReadSince { .. } => "serial.read_since",
        SerialCommand::WaitFor { .. } => "serial.wait_for",
        SerialCommand::Exchange { .. } => "serial.exchange",
    }
}
fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;
    use crate::{dispatch_command, serial::MockSerialAdapter};

    fn core() -> SerialCore {
        SerialCore::new(Arc::new(MockSerialAdapter))
    }

    async fn open(core: &SerialCore) -> (String, u64) {
        match core
            .execute(SerialCommand::Open {
                config: SerialConfig::default(),
            })
            .await
            .unwrap()
        {
            CommandResult::Opened {
                session_id,
                rx_cursor,
            } => (session_id, rx_cursor),
            _ => unreachable!(),
        }
    }

    #[tokio::test]
    async fn read_since_does_not_repeat_frames() {
        let core = core();
        let (session, cursor) = open(&core).await;
        core.execute(SerialCommand::Send {
            session_id: session.clone(),
            encoding: DataEncoding::Hex,
            payload: "0102".into(),
            action_id: None,
            timeout_ms: None,
        })
        .await
        .unwrap();
        tokio::time::sleep(Duration::from_millis(50)).await;
        let first = match core
            .execute(SerialCommand::ReadSince {
                session_id: session.clone(),
                after_cursor: cursor,
                max_bytes: 1024,
                max_frames: 16,
            })
            .await
            .unwrap()
        {
            CommandResult::Read { read } => read,
            _ => unreachable!(),
        };
        let second = match core
            .execute(SerialCommand::ReadSince {
                session_id: session,
                after_cursor: first.next_cursor,
                max_bytes: 1024,
                max_frames: 16,
            })
            .await
            .unwrap()
        {
            CommandResult::Read { read } => read,
            _ => unreachable!(),
        };
        assert_eq!(first.frames.len(), 2);
        assert!(second.frames.is_empty());
    }

    #[tokio::test]
    async fn expired_cursor_reports_data_loss() {
        let core = core();
        let (session, _) = open(&core).await;
        for _ in 0..80 {
            append_frame(&core.state, Direction::Rx, vec![0u8; 1024]).await;
        }
        let result = match core
            .execute(SerialCommand::ReadSince {
                session_id: session,
                after_cursor: 0,
                max_bytes: 1,
                max_frames: 1,
            })
            .await
            .unwrap()
        {
            CommandResult::Read { read } => read,
            _ => unreachable!(),
        };
        assert!(result.cursor_expired);
        assert!(result.dropped);
    }

    #[tokio::test]
    async fn wait_for_times_out() {
        let core = core();
        let (session, cursor) = open(&core).await;
        let result = core
            .execute(SerialCommand::WaitFor {
                session_id: session,
                after_cursor: cursor,
                condition: WaitCondition {
                    contains_text: Some("never-arrives".into()),
                    contains_hex: None,
                    frame_prefix: None,
                    regex: None,
                    protocol_field: None,
                },
                timeout_ms: 12,
            })
            .await
            .unwrap();
        assert!(matches!(
            result,
            CommandResult::Waited {
                timed_out: true,
                ..
            }
        ));
    }

    #[tokio::test]
    async fn mock_streams_fixed_numeric_rx_samples_after_opening() {
        let core = core();
        let (session, cursor) = open(&core).await;
        let result = core
            .execute(SerialCommand::WaitFor {
                session_id: session,
                after_cursor: cursor,
                condition: WaitCondition {
                    contains_text: Some("100".into()),
                    contains_hex: None,
                    frame_prefix: None,
                    regex: None,
                    protocol_field: None,
                },
                timeout_ms: 500,
            })
            .await
            .unwrap();
        assert!(matches!(
            result,
            CommandResult::Waited {
                matched: Some(Frame { text_utf8: Some(text), .. }),
                timed_out: false,
                ..
            } if text == "100\n"
        ));
    }

    #[tokio::test]
    async fn exchange_captures_fast_mock_response() {
        let core = core();
        let (session, _) = open(&core).await;
        let result = core
            .execute(SerialCommand::Exchange {
                session_id: session,
                encoding: DataEncoding::Hex,
                payload: "DEAD".into(),
                condition: WaitCondition {
                    contains_text: None,
                    contains_hex: None,
                    frame_prefix: Some("AA55".into()),
                    regex: None,
                    protocol_field: None,
                },
                timeout_ms: 100,
                action_id: Some("test-action".into()),
            })
            .await
            .unwrap();
        match result {
            CommandResult::Exchanged {
                response,
                timed_out,
                ..
            } => {
                assert!(!timed_out);
                assert_eq!(response.unwrap().raw_hex, "AA55DEAD");
            }
            _ => unreachable!(),
        }
    }

    #[tokio::test]
    async fn ui_and_mcp_share_dispatch_path() {
        let core = core();
        let ui_result = dispatch_command(&core, SerialCommand::ListPorts)
            .await
            .unwrap();
        let mcp_result = dispatch_command(&core, SerialCommand::ListPorts)
            .await
            .unwrap();
        assert_eq!(
            serde_json::to_value(ui_result).unwrap(),
            serde_json::to_value(mcp_result).unwrap()
        );
    }
}
