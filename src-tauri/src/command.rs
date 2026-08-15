use std::{collections::VecDeque, sync::Arc, time::Duration};

use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use encoding_rs::{Encoding, GBK, UTF_16LE, UTF_8};
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
    #[error("file send failed: {0}")]
    FileSend(String),
    #[error("file send is already active")]
    FileSendBusy,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DataEncoding {
    Text,
    Hex,
    Base64,
}

/// Charset used when a payload is handled as text rather than raw bytes.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum TextCharset {
    #[default]
    Utf8,
    Gbk,
    Ascii,
    Utf16le,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum FileTransferProtocol {
    Null,
    Xmodem,
    #[serde(rename = "xmodem-1k")]
    Xmodem1k,
    Ymodem,
}

impl Default for FileTransferProtocol {
    fn default() -> Self {
        Self::Null
    }
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
            port: String::new(),
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
    pub buffer_limit_bytes: usize,
    pub buffered_frames: usize,
    pub dropped_frames: u64,
    pub rx_bytes: u64,
    pub tx_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WaitCondition {
    pub contains_text: Option<String>,
    #[serde(default)]
    pub text_charset: Option<TextCharset>,
    pub contains_hex: Option<String>,
    pub frame_prefix: Option<String>,
    pub regex: Option<String>,
    /// Reserved structured field matcher for future protocol decoders.
    pub protocol_field: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct WaveChannel {
    pub id: String,
    pub name: String,
    pub color: String,
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BatchSendItem {
    pub encoding: DataEncoding,
    #[serde(default)]
    pub text_charset: Option<TextCharset>,
    pub payload: String,
    pub timeout_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PortMonitorSample {
    pub timestamp_ms: u64,
    pub ports: Vec<PortInfo>,
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
            if !decode_text(&bytes, self.text_charset.unwrap_or_default())
                .is_some_and(|text| text.contains(expected))
            {
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
        #[serde(default)]
        text_charset: Option<TextCharset>,
        payload: String,
        action_id: Option<String>,
        timeout_ms: Option<u64>,
    },
    SendFile {
        session_id: String,
        file_path: String,
        #[serde(default)]
        protocol: FileTransferProtocol,
        chunk_size: usize,
        interval_ms: u64,
        timeout_ms: Option<u64>,
        action_id: Option<String>,
    },
    CancelSendFile {
        action_id: String,
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
        #[serde(default)]
        text_charset: Option<TextCharset>,
        payload: String,
        condition: WaitCondition,
        timeout_ms: u64,
        action_id: Option<String>,
    },
    SendBatch {
        session_id: String,
        items: Vec<BatchSendItem>,
        interval_ms: u64,
        action_id: Option<String>,
    },
    ExchangeBatch {
        session_id: String,
        items: Vec<ExchangeItem>,
        action_id: Option<String>,
    },
    WaitForAny {
        session_id: String,
        after_cursor: u64,
        conditions: Vec<WaitCondition>,
        timeout_ms: u64,
    },
    MonitorPorts {
        duration_ms: u64,
        interval_ms: u64,
    },
    Reconnect {
        session_id: String,
    },
    WaveformListChannels,
    WaveformSetChannels {
        channels: Vec<WaveChannel>,
    },
    WaveformAddChannel {
        name: String,
        color: String,
        enabled: bool,
    },
    WaveformUpdateChannel {
        channel_id: String,
        name: Option<String>,
        color: Option<String>,
        enabled: Option<bool>,
    },
    WaveformRemoveChannel {
        channel_id: String,
    },
    WaveformClearSamples,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExchangeItem {
    pub encoding: DataEncoding,
    #[serde(default)]
    pub text_charset: Option<TextCharset>,
    pub payload: String,
    pub condition: WaitCondition,
    pub timeout_ms: u64,
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
    FileSendStarted {
        action_id: String,
        file_size: u64,
        chunk_size: usize,
    },
    FileSendCancelled {
        action_id: String,
        sent_bytes: u64,
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
    SentBatch {
        results: Vec<CommandResult>,
    },
    ExchangedBatch {
        results: Vec<CommandResult>,
    },
    WaitedAny {
        matched: Option<Frame>,
        matched_condition: Option<usize>,
        next_cursor: u64,
        timed_out: bool,
        cursor_expired: bool,
    },
    PortMonitor {
        samples: Vec<PortMonitorSample>,
    },
    Reconnected {
        session_id: String,
        rx_cursor: u64,
    },
    WaveformChannels {
        channels: Vec<WaveChannel>,
    },
    WaveformChannel {
        channel: WaveChannel,
        channels: Vec<WaveChannel>,
    },
    WaveformSamplesCleared {
        generation: u64,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EventKind {
    CommandStarted,
    CommandCompleted,
    CommandFailed,
    Frame,
    FileProgress,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileProgress {
    pub action_id: String,
    pub file_path: String,
    pub file_size: u64,
    pub sent_bytes: u64,
    pub chunk_size: usize,
    pub completed: bool,
    pub cancelled: bool,
}

struct ActiveSession {
    id: String,
    config: SerialConfig,
    outgoing: tokio::sync::mpsc::Sender<Vec<u8>>,
    reader: JoinHandle<()>,
    shutdown: Option<Arc<std::sync::atomic::AtomicBool>>,
    workers: Vec<std::thread::JoinHandle<()>>,
}

struct State {
    session: Option<ActiveSession>,
    frames: VecDeque<Frame>,
    next_cursor: u64,
    buffered_bytes: usize,
    dropped_frames: u64,
    rx_bytes: u64,
    tx_bytes: u64,
    wave_channels: Vec<WaveChannel>,
    waveform_generation: u64,
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
            wave_channels: Vec::new(),
            waveform_generation: 0,
        }
    }
}

pub struct SerialCore {
    adapter: Arc<dyn SerialAdapter>,
    state: Arc<Mutex<State>>,
    events: broadcast::Sender<SerialEvent>,
    audit: Arc<std::sync::Mutex<VecDeque<SerialEvent>>>,
    changed: Arc<Notify>,
    file_send: Arc<Mutex<Option<String>>>,
    file_cancel: Arc<Mutex<Option<String>>>,
    file_task: Arc<Mutex<Option<tokio::task::JoinHandle<()>>>>,
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
            file_send: Arc::new(Mutex::new(None)),
            file_cancel: Arc::new(Mutex::new(None)),
            file_task: Arc::new(Mutex::new(None)),
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
            SerialCommand::Send { action_id, .. }
            | SerialCommand::Exchange { action_id, .. }
            | SerialCommand::SendFile { action_id, .. }
            | SerialCommand::SendBatch { action_id, .. }
            | SerialCommand::ExchangeBatch { action_id, .. } => action_id.clone(),
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
                text_charset,
                payload,
                action_id,
                timeout_ms,
            } => {
                self.send(
                    &session_id,
                    encoding,
                    text_charset.unwrap_or_default(),
                    payload,
                    action_id,
                    timeout_ms,
                )
                .await
            }
            SerialCommand::SendFile {
                session_id,
                file_path,
                protocol,
                chunk_size,
                interval_ms,
                timeout_ms,
                action_id,
            } => {
                self.send_file(
                    &session_id,
                    file_path,
                    protocol,
                    chunk_size,
                    interval_ms,
                    timeout_ms,
                    action_id,
                )
                .await
            }
            SerialCommand::CancelSendFile { action_id } => self.cancel_send_file(&action_id).await,
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
                text_charset,
                payload,
                condition,
                timeout_ms,
                action_id,
            } => {
                self.exchange(
                    &session_id,
                    encoding,
                    text_charset.unwrap_or_default(),
                    payload,
                    condition,
                    timeout_ms,
                    action_id,
                )
                .await
            }
            SerialCommand::SendBatch {
                session_id,
                items,
                interval_ms,
                action_id,
            } => {
                self.send_batch(&session_id, items, interval_ms, action_id)
                    .await
            }
            SerialCommand::ExchangeBatch {
                session_id,
                items,
                action_id,
            } => self.exchange_batch(&session_id, items, action_id).await,
            SerialCommand::WaitForAny {
                session_id,
                after_cursor,
                conditions,
                timeout_ms,
            } => {
                self.ensure_session(&session_id).await?;
                let (matched, matched_condition, next_cursor, timed_out, cursor_expired) = self
                    .wait_for_any(after_cursor, conditions, timeout_ms)
                    .await;
                Ok(CommandResult::WaitedAny {
                    matched,
                    matched_condition,
                    next_cursor,
                    timed_out,
                    cursor_expired,
                })
            }
            SerialCommand::MonitorPorts {
                duration_ms,
                interval_ms,
            } => self.monitor_ports(duration_ms, interval_ms).await,
            SerialCommand::Reconnect { session_id } => self.reconnect(&session_id).await,
            SerialCommand::WaveformListChannels => Ok(CommandResult::WaveformChannels {
                channels: self.state.lock().await.wave_channels.clone(),
            }),
            SerialCommand::WaveformSetChannels { channels } => {
                let mut state = self.state.lock().await;
                state.wave_channels = channels;
                Ok(CommandResult::WaveformChannels {
                    channels: state.wave_channels.clone(),
                })
            }
            SerialCommand::WaveformAddChannel {
                name,
                color,
                enabled,
            } => {
                let mut state = self.state.lock().await;
                let channel = WaveChannel {
                    id: Uuid::new_v4().to_string(),
                    name,
                    color,
                    enabled,
                };
                state.wave_channels.push(channel.clone());
                Ok(CommandResult::WaveformChannel {
                    channel,
                    channels: state.wave_channels.clone(),
                })
            }
            SerialCommand::WaveformUpdateChannel {
                channel_id,
                name,
                color,
                enabled,
            } => {
                let mut state = self.state.lock().await;
                let channel = state
                    .wave_channels
                    .iter_mut()
                    .find(|channel| channel.id == channel_id)
                    .ok_or_else(|| CoreError::Adapter("waveform channel not found".into()))?;
                if let Some(name) = name {
                    channel.name = name;
                }
                if let Some(color) = color {
                    channel.color = color;
                }
                if let Some(enabled) = enabled {
                    channel.enabled = enabled;
                }
                Ok(CommandResult::WaveformChannel {
                    channel: channel.clone(),
                    channels: state.wave_channels.clone(),
                })
            }
            SerialCommand::WaveformRemoveChannel { channel_id } => {
                let mut state = self.state.lock().await;
                state
                    .wave_channels
                    .retain(|channel| channel.id != channel_id);
                Ok(CommandResult::WaveformChannels {
                    channels: state.wave_channels.clone(),
                })
            }
            SerialCommand::WaveformClearSamples => {
                let mut state = self.state.lock().await;
                state.waveform_generation = state.waveform_generation.saturating_add(1);
                Ok(CommandResult::WaveformSamplesCleared {
                    generation: state.waveform_generation,
                })
            }
        }
    }

    async fn send_batch(
        &self,
        session_id: &str,
        items: Vec<BatchSendItem>,
        interval_ms: u64,
        action_id: Option<String>,
    ) -> Result<CommandResult, CoreError> {
        if items.is_empty() || items.len() > 256 {
            return Err(CoreError::Adapter(
                "send_batch requires 1..=256 items".into(),
            ));
        }
        let item_count = items.len();
        let mut results = Vec::with_capacity(item_count);
        for (index, item) in items.into_iter().enumerate() {
            results.push(
                self.send(
                    session_id,
                    item.encoding,
                    item.text_charset.unwrap_or_default(),
                    item.payload,
                    Some(format!(
                        "{}-{index}",
                        action_id
                            .clone()
                            .unwrap_or_else(|| Uuid::new_v4().to_string())
                    )),
                    item.timeout_ms,
                )
                .await?,
            );
            if interval_ms > 0 && index + 1 < item_count {
                tokio::time::sleep(Duration::from_millis(interval_ms)).await;
            }
        }
        Ok(CommandResult::SentBatch { results })
    }

    async fn exchange_batch(
        &self,
        session_id: &str,
        items: Vec<ExchangeItem>,
        action_id: Option<String>,
    ) -> Result<CommandResult, CoreError> {
        if items.is_empty() || items.len() > 128 {
            return Err(CoreError::Adapter(
                "exchange_batch requires 1..=128 items".into(),
            ));
        }
        let prefix = action_id.unwrap_or_else(|| Uuid::new_v4().to_string());
        let mut results = Vec::with_capacity(items.len());
        for (index, item) in items.into_iter().enumerate() {
            results.push(
                self.exchange(
                    session_id,
                    item.encoding,
                    item.text_charset.unwrap_or_default(),
                    item.payload,
                    item.condition,
                    item.timeout_ms,
                    Some(format!("{prefix}-{index}")),
                )
                .await?,
            );
        }
        Ok(CommandResult::ExchangedBatch { results })
    }

    async fn wait_for_any(
        &self,
        after_cursor: u64,
        conditions: Vec<WaitCondition>,
        timeout_ms: u64,
    ) -> (Option<Frame>, Option<usize>, u64, bool, bool) {
        let deadline = tokio::time::Instant::now() + Duration::from_millis(timeout_ms.min(300_000));
        let mut cursor = after_cursor;
        loop {
            let snapshot = self.state.lock().await;
            let expired = snapshot
                .frames
                .front()
                .map(|frame| cursor + 1 < frame.cursor)
                .unwrap_or(false);
            let frames: Vec<Frame> = snapshot
                .frames
                .iter()
                .filter(|frame| frame.cursor > cursor && frame.direction == Direction::Rx)
                .cloned()
                .collect();
            drop(snapshot);
            for frame in frames {
                cursor = frame.cursor;
                if let Some(index) = conditions
                    .iter()
                    .position(|condition| condition.matches(&frame))
                {
                    return (Some(frame), Some(index), cursor, false, expired);
                }
            }
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            if remaining.is_zero() {
                return (None, None, cursor, true, expired);
            }
            if timeout(remaining, self.changed.notified()).await.is_err() {
                return (None, None, cursor, true, expired);
            }
        }
    }

    async fn monitor_ports(
        &self,
        duration_ms: u64,
        interval_ms: u64,
    ) -> Result<CommandResult, CoreError> {
        let duration_ms = duration_ms.min(300_000);
        let interval_ms = interval_ms.clamp(50, 60_000);
        let deadline = tokio::time::Instant::now() + Duration::from_millis(duration_ms);
        let mut samples = Vec::new();
        loop {
            samples.push(PortMonitorSample {
                timestamp_ms: now_ms(),
                ports: self.adapter.list_ports().await?,
            });
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            if remaining.is_zero() {
                break;
            }
            tokio::time::sleep(remaining.min(Duration::from_millis(interval_ms))).await;
        }
        Ok(CommandResult::PortMonitor { samples })
    }

    async fn reconnect(&self, session_id: &str) -> Result<CommandResult, CoreError> {
        let config = self
            .state
            .lock()
            .await
            .session
            .as_ref()
            .ok_or(CoreError::NotOpen)
            .and_then(|session| {
                if session.id == session_id {
                    Ok(session.config.clone())
                } else {
                    Err(CoreError::InvalidSession)
                }
            })?;
        self.close(session_id).await?;
        match self.open(config).await? {
            CommandResult::Opened {
                session_id,
                rx_cursor,
            } => Ok(CommandResult::Reconnected {
                session_id,
                rx_cursor,
            }),
            _ => unreachable!(),
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
            shutdown,
            workers,
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
                shutdown,
                workers,
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
        stop_active_session(session).await;
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
            stop_active_session(session).await;
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
        text_charset: TextCharset,
        payload: String,
        action_id: Option<String>,
        timeout_ms: Option<u64>,
    ) -> Result<CommandResult, CoreError> {
        if self.file_send.lock().await.is_some() {
            return Err(CoreError::FileSendBusy);
        }
        let bytes = decode_payload(&encoding, text_charset, &payload)?;
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

    async fn send_file(
        &self,
        session_id: &str,
        file_path: String,
        protocol: FileTransferProtocol,
        chunk_size: usize,
        interval_ms: u64,
        timeout_ms: Option<u64>,
        action_id: Option<String>,
    ) -> Result<CommandResult, CoreError> {
        let action_id = action_id.unwrap_or_else(|| Uuid::new_v4().to_string());
        let chunk_size = match protocol {
            FileTransferProtocol::Null => chunk_size.clamp(1, 1024 * 1024),
            FileTransferProtocol::Xmodem => 128,
            FileTransferProtocol::Xmodem1k => 1024,
            FileTransferProtocol::Ymodem => 1024,
        };
        let metadata = tokio::fs::metadata(&file_path)
            .await
            .map_err(|error| CoreError::FileSend(error.to_string()))?;
        if !metadata.is_file() {
            return Err(CoreError::FileSend(
                "selected path is not a regular file".into(),
            ));
        }
        let file_size = metadata.len();
        self.ensure_session(session_id).await?;
        let outgoing = self.session_sender(session_id).await?;
        {
            let mut active = self.file_send.lock().await;
            if active.is_some() {
                return Err(CoreError::FileSendBusy);
            }
            *active = Some(action_id.clone());
        }
        *self.file_cancel.lock().await = None;
        let state = self.state.clone();
        let events = self.events.clone();
        let audit = self.audit.clone();
        let changed = self.changed.clone();
        let file_send = self.file_send.clone();
        let file_cancel = self.file_cancel.clone();
        let file_task = self.file_task.clone();
        let file_path_for_event = file_path.clone();
        let action_for_task = action_id.clone();
        let timeout_ms = timeout_ms.unwrap_or(1_000);
        let task = tokio::spawn(async move {
            let result = stream_file(
                &file_path,
                &action_for_task,
                protocol,
                file_size,
                chunk_size,
                interval_ms,
                timeout_ms,
                outgoing,
                &state,
                &events,
                &audit,
                &changed,
                &file_cancel,
            )
            .await;
            let _ = file_send.lock().await.take();
            if let Err(error) = result {
                let cancelled =
                    error.1 || cancellation_requested(&file_cancel, &action_for_task).await;
                emit_file_progress(
                    &events,
                    &audit,
                    FileProgress {
                        action_id: action_for_task.clone(),
                        file_path: file_path_for_event,
                        file_size,
                        sent_bytes: error.0,
                        chunk_size,
                        completed: false,
                        cancelled,
                    },
                );
            }
        });
        *file_task.lock().await = Some(task);
        Ok(CommandResult::FileSendStarted {
            action_id,
            file_size,
            chunk_size,
        })
    }

    async fn cancel_send_file(&self, action_id: &str) -> Result<CommandResult, CoreError> {
        let active = self.file_send.lock().await.clone();
        if active.as_deref() != Some(action_id) {
            return Err(CoreError::FileSend(
                "no matching file send is active".into(),
            ));
        }
        *self.file_cancel.lock().await = Some(action_id.into());
        if let Some(task) = self.file_task.lock().await.take() {
            task.abort();
        }
        let _ = self.file_send.lock().await.take();
        self.changed.notify_waiters();
        self.emit(
            EventKind::FileProgress,
            "serial.send_file",
            Some(action_id.to_string()),
            serde_json::to_value(FileProgress {
                action_id: action_id.to_string(),
                file_path: String::new(),
                file_size: 0,
                sent_bytes: 0,
                chunk_size: 0,
                completed: false,
                cancelled: true,
            })
            .unwrap_or_default(),
        );
        Ok(CommandResult::FileSendCancelled {
            action_id: action_id.into(),
            sent_bytes: 0,
        })
    }

    async fn session_sender(
        &self,
        session_id: &str,
    ) -> Result<tokio::sync::mpsc::Sender<Vec<u8>>, CoreError> {
        let state = self.state.lock().await;
        let session = state.session.as_ref().ok_or(CoreError::NotOpen)?;
        if session.id != session_id {
            return Err(CoreError::InvalidSession);
        }
        Ok(session.outgoing.clone())
    }

    async fn exchange(
        &self,
        session_id: &str,
        encoding: DataEncoding,
        text_charset: TextCharset,
        payload: String,
        condition: WaitCondition,
        timeout_ms: u64,
        action_id: Option<String>,
    ) -> Result<CommandResult, CoreError> {
        self.ensure_session(session_id).await?;
        let before_cursor = { self.state.lock().await.next_cursor.saturating_sub(1) };
        let sent = self
            .send(
                session_id,
                encoding,
                text_charset,
                payload,
                action_id,
                Some(timeout_ms),
            )
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
            buffer_limit_bytes: MAX_BUFFER_BYTES,
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

async fn stop_active_session(session: ActiveSession) {
    let ActiveSession {
        outgoing,
        reader,
        shutdown,
        workers,
        ..
    } = session;
    if let Some(shutdown) = shutdown {
        shutdown.store(true, std::sync::atomic::Ordering::Release);
    }
    drop(outgoing);
    reader.abort();
    for worker in workers {
        let _ = tokio::task::spawn_blocking(move || worker.join()).await;
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

async fn stream_file(
    file_path: &str,
    action_id: &str,
    protocol: FileTransferProtocol,
    file_size: u64,
    chunk_size: usize,
    interval_ms: u64,
    timeout_ms: u64,
    outgoing: tokio::sync::mpsc::Sender<Vec<u8>>,
    state: &Arc<Mutex<State>>,
    events: &broadcast::Sender<SerialEvent>,
    audit: &Arc<std::sync::Mutex<VecDeque<SerialEvent>>>,
    changed: &Arc<Notify>,
    cancel: &Arc<Mutex<Option<String>>>,
) -> Result<u64, (u64, bool)> {
    let mut file = match tokio::fs::File::open(file_path).await {
        Ok(file) => file,
        Err(_) => return Err((0, false)),
    };
    let mut sent_bytes = 0u64;
    let mut buffer = vec![0u8; chunk_size];
    let cursor = state.lock().await.next_cursor.saturating_sub(1);
    if protocol != FileTransferProtocol::Null {
        if wait_for_control(
            state,
            changed,
            cancel,
            action_id,
            cursor,
            timeout_ms,
            &[0x15, 0x43],
        )
        .await
        .is_none()
        {
            return Err((0, cancellation_requested(cancel, action_id).await));
        }
        if protocol == FileTransferProtocol::Ymodem {
            let mut header = vec![0u8; 128];
            let name = file_path.rsplit(['/', '\\']).next().unwrap_or("file.bin");
            let metadata = format!("{}\0{}\0", name, file_size);
            header[..metadata.len().min(128)]
                .copy_from_slice(&metadata.as_bytes()[..metadata.len().min(128)]);
            let frame = xmodem_frame(0, &header, false);
            let before = state.lock().await.next_cursor.saturating_sub(1);
            send_wire(
                &frame,
                outgoing.clone(),
                state,
                events,
                audit,
                changed,
                timeout_ms,
            )
            .await?;
            if wait_for_control(
                state,
                changed,
                cancel,
                action_id,
                before,
                timeout_ms,
                &[0x06],
            )
            .await
            .is_none()
            {
                return Err((0, cancellation_requested(cancel, action_id).await));
            }
            let after_header = state.lock().await.next_cursor.saturating_sub(1);
            if wait_for_control(
                state,
                changed,
                cancel,
                action_id,
                after_header,
                timeout_ms,
                &[0x43],
            )
            .await
            .is_none()
            {
                return Err((0, cancellation_requested(cancel, action_id).await));
            }
        }
    }
    let mut sequence = 1u8;
    loop {
        if cancel.lock().await.as_deref() == Some(action_id) {
            return Err((sent_bytes, true));
        }
        let read = match tokio::io::AsyncReadExt::read(&mut file, &mut buffer).await {
            Ok(read) => read,
            Err(_) => return Err((sent_bytes, false)),
        };
        if read == 0 {
            break;
        }
        let chunk = buffer[..read].to_vec();
        let wire = match protocol {
            FileTransferProtocol::Null => chunk.clone(),
            FileTransferProtocol::Xmodem => xmodem_frame(sequence, &chunk, false),
            FileTransferProtocol::Xmodem1k | FileTransferProtocol::Ymodem => {
                xmodem_frame(sequence, &chunk, true)
            }
        };
        if cancellation_requested(cancel, action_id).await {
            return Err((sent_bytes, true));
        }
        let before = state.lock().await.next_cursor.saturating_sub(1);
        send_wire(
            &wire,
            outgoing.clone(),
            state,
            events,
            audit,
            changed,
            timeout_ms,
        )
        .await?;
        if protocol != FileTransferProtocol::Null {
            if wait_for_control(
                state,
                changed,
                cancel,
                action_id,
                before,
                timeout_ms,
                &[0x06],
            )
            .await
            .is_none()
            {
                return Err((sent_bytes, cancellation_requested(cancel, action_id).await));
            }
            sequence = sequence.wrapping_add(1);
        }
        sent_bytes += read as u64;
        emit_file_progress(
            events,
            audit,
            FileProgress {
                action_id: action_id.into(),
                file_path: file_path.into(),
                file_size,
                sent_bytes,
                chunk_size,
                completed: false,
                cancelled: false,
            },
        );
        if interval_ms > 0
            && wait_between_chunks(
                cancel,
                changed,
                action_id,
                Duration::from_millis(interval_ms),
            )
            .await
        {
            return Err((sent_bytes, true));
        }
    }
    if protocol != FileTransferProtocol::Null {
        let eot = [0x04];
        let before = state.lock().await.next_cursor.saturating_sub(1);
        send_wire(&eot, outgoing, state, events, audit, changed, timeout_ms).await?;
        if wait_for_control(
            state,
            changed,
            cancel,
            action_id,
            before,
            timeout_ms,
            &[0x06],
        )
        .await
        .is_none()
        {
            return Err((sent_bytes, cancellation_requested(cancel, action_id).await));
        }
    }
    if cancellation_requested(cancel, action_id).await {
        return Err((sent_bytes, true));
    }
    emit_file_progress(
        events,
        audit,
        FileProgress {
            action_id: action_id.into(),
            file_path: file_path.into(),
            file_size,
            sent_bytes,
            chunk_size,
            completed: true,
            cancelled: false,
        },
    );
    Ok(sent_bytes)
}

async fn send_wire(
    bytes: &[u8],
    outgoing: tokio::sync::mpsc::Sender<Vec<u8>>,
    state: &Arc<Mutex<State>>,
    events: &broadcast::Sender<SerialEvent>,
    audit: &Arc<std::sync::Mutex<VecDeque<SerialEvent>>>,
    changed: &Arc<Notify>,
    timeout_ms: u64,
) -> Result<(), (u64, bool)> {
    timeout(
        Duration::from_millis(timeout_ms),
        outgoing.send(bytes.to_vec()),
    )
    .await
    .map_err(|_| (0, false))
    .and_then(|result| result.map_err(|_| (0, false)))?;
    let frame = append_frame(state, Direction::Tx, bytes.to_vec()).await;
    record_event(events, audit, frame_event(frame));
    changed.notify_waiters();
    Ok(())
}

async fn wait_for_control(
    state: &Arc<Mutex<State>>,
    changed: &Arc<Notify>,
    cancel: &Arc<Mutex<Option<String>>>,
    action_id: &str,
    after_cursor: u64,
    timeout_ms: u64,
    accepted: &[u8],
) -> Option<u8> {
    let deadline = tokio::time::Instant::now() + Duration::from_millis(timeout_ms);
    let mut cursor = after_cursor;
    loop {
        if cancellation_requested(cancel, action_id).await {
            return None;
        }
        let snapshot = state.lock().await;
        let frames: Vec<_> = snapshot
            .frames
            .iter()
            .filter(|frame| frame.cursor > cursor && frame.direction == Direction::Rx)
            .cloned()
            .collect();
        drop(snapshot);
        for frame in frames {
            if let Ok(bytes) = BASE64.decode(&frame.raw_base64) {
                if bytes.len() == 1 && accepted.contains(&bytes[0]) {
                    return Some(bytes[0]);
                }
            }
            cursor = frame.cursor;
        }
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            return None;
        }
        if timeout(remaining, changed.notified()).await.is_err() {
            return None;
        }
    }
}

async fn cancellation_requested(cancel: &Arc<Mutex<Option<String>>>, action_id: &str) -> bool {
    cancel.lock().await.as_deref() == Some(action_id)
}

async fn wait_between_chunks(
    cancel: &Arc<Mutex<Option<String>>>,
    changed: &Arc<Notify>,
    action_id: &str,
    duration: Duration,
) -> bool {
    tokio::select! {
        _ = tokio::time::sleep(duration) => cancellation_requested(cancel, action_id).await,
        _ = changed.notified() => cancellation_requested(cancel, action_id).await,
    }
}

fn xmodem_frame(sequence: u8, payload: &[u8], large: bool) -> Vec<u8> {
    let (marker, size) = if large { (0x02, 1024) } else { (0x01, 128) };
    let mut frame = vec![marker, sequence, 255 - sequence];
    frame.extend(
        payload
            .iter()
            .copied()
            .chain(std::iter::repeat(0x1a))
            .take(size),
    );
    let crc = crc16(&frame[3..]);
    frame.extend([(crc >> 8) as u8, crc as u8]);
    frame
}

fn crc16(bytes: &[u8]) -> u16 {
    bytes.iter().fold(0u16, |mut crc, byte| {
        crc ^= (*byte as u16) << 8;
        for _ in 0..8 {
            crc = if crc & 0x8000 != 0 {
                (crc << 1) ^ 0x1021
            } else {
                crc << 1
            };
        }
        crc
    })
}

fn emit_file_progress(
    events: &broadcast::Sender<SerialEvent>,
    audit: &Arc<std::sync::Mutex<VecDeque<SerialEvent>>>,
    progress: FileProgress,
) {
    let event = SerialEvent {
        event_id: Uuid::new_v4().to_string(),
        timestamp_ms: now_ms(),
        kind: EventKind::FileProgress,
        action: "serial.send_file".into(),
        action_id: Some(progress.action_id.clone()),
        detail: serde_json::to_value(progress).unwrap_or_default(),
    };
    record_event(events, audit, event);
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

fn decode_payload(
    encoding: &DataEncoding,
    text_charset: TextCharset,
    payload: &str,
) -> Result<Vec<u8>, CoreError> {
    match encoding {
        DataEncoding::Text => encode_text(payload, text_charset),
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

fn encode_text(payload: &str, charset: TextCharset) -> Result<Vec<u8>, CoreError> {
    if charset == TextCharset::Ascii {
        return payload
            .is_ascii()
            .then(|| payload.as_bytes().to_vec())
            .ok_or_else(|| CoreError::InvalidPayload {
                encoding: "ascii".into(),
                reason: "ASCII text cannot contain non-ASCII characters".into(),
            });
    }
    let (bytes, _, had_replacements) = charset_encoding(charset).encode(payload);
    if had_replacements {
        return Err(CoreError::InvalidPayload {
            encoding: charset_name(charset).into(),
            reason: "text contains characters that cannot be represented by this encoding".into(),
        });
    }
    Ok(bytes.into_owned())
}

fn decode_text(bytes: &[u8], charset: TextCharset) -> Option<String> {
    if charset == TextCharset::Ascii {
        return bytes
            .is_ascii()
            .then(|| String::from_utf8_lossy(bytes).into_owned());
    }
    let (text, _, had_replacements) = charset_encoding(charset).decode(bytes);
    (!had_replacements).then(|| text.into_owned())
}

fn charset_encoding(charset: TextCharset) -> &'static Encoding {
    match charset {
        TextCharset::Utf8 => UTF_8,
        TextCharset::Gbk => GBK,
        TextCharset::Utf16le => UTF_16LE,
        TextCharset::Ascii => unreachable!("ASCII is handled without encoding_rs"),
    }
}

fn charset_name(charset: TextCharset) -> &'static str {
    match charset {
        TextCharset::Utf8 => "utf-8",
        TextCharset::Gbk => "gbk",
        TextCharset::Ascii => "ascii",
        TextCharset::Utf16le => "utf-16le",
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
        SerialCommand::SendFile { .. } => "serial.send_file",
        SerialCommand::CancelSendFile { .. } => "serial.cancel_send_file",
        SerialCommand::ReadSince { .. } => "serial.read_since",
        SerialCommand::WaitFor { .. } => "serial.wait_for",
        SerialCommand::Exchange { .. } => "serial.exchange",
        SerialCommand::SendBatch { .. } => "serial.send_batch",
        SerialCommand::ExchangeBatch { .. } => "serial.exchange_batch",
        SerialCommand::WaitForAny { .. } => "serial.wait_for_any",
        SerialCommand::MonitorPorts { .. } => "serial.monitor_ports",
        SerialCommand::Reconnect { .. } => "serial.reconnect",
        SerialCommand::WaveformListChannels => "waveform.list_channels",
        SerialCommand::WaveformSetChannels { .. } => "waveform.set_channels",
        SerialCommand::WaveformAddChannel { .. } => "waveform.add_channel",
        SerialCommand::WaveformUpdateChannel { .. } => "waveform.update_channel",
        SerialCommand::WaveformRemoveChannel { .. } => "waveform.remove_channel",
        SerialCommand::WaveformClearSamples => "waveform.clear_samples",
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
    use std::{sync::Arc, time::SystemTime};

    use super::*;
    use crate::{dispatch_command, serial::mock::MockSerialAdapter};

    fn core() -> SerialCore {
        SerialCore::new(Arc::new(MockSerialAdapter))
    }

    async fn open(core: &SerialCore) -> (String, u64) {
        match core
            .execute(SerialCommand::Open {
                config: SerialConfig {
                    port: "mock://loopback-01".into(),
                    ..SerialConfig::default()
                },
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
            text_charset: None,
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
                    text_charset: None,
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
    async fn mock_streams_multichannel_rx_samples_after_opening() {
        let core = core();
        let (session, cursor) = open(&core).await;
        let result = core
            .execute(SerialCommand::WaitFor {
                session_id: session,
                after_cursor: cursor,
                condition: WaitCondition {
                    contains_text: Some("X1=100,X2=52,X3=24".into()),
                    text_charset: None,
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
            } if text == "X1=100,X2=52,X3=24\r\n"
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
                text_charset: None,
                payload: "DEAD".into(),
                condition: WaitCondition {
                    contains_text: None,
                    text_charset: None,
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
    async fn sends_gbk_text_as_gbk_bytes() {
        let core = core();
        let (session, _) = open(&core).await;
        let result = core
            .execute(SerialCommand::Send {
                session_id: session,
                encoding: DataEncoding::Text,
                text_charset: Some(TextCharset::Gbk),
                payload: "中文".into(),
                action_id: None,
                timeout_ms: None,
            })
            .await
            .unwrap();
        assert!(matches!(
            result,
            CommandResult::Sent { frame, .. } if frame.raw_hex == "D6D0CEC4"
        ));
    }

    #[test]
    fn matches_gbk_text_with_the_selected_charset() {
        let frame = Frame {
            cursor: 1,
            timestamp_ms: 0,
            direction: Direction::Rx,
            raw_base64: BASE64.encode([0xd6, 0xd0, 0xce, 0xc4]),
            raw_hex: "D6D0CEC4".into(),
            text_utf8: None,
        };
        let condition = WaitCondition {
            contains_text: Some("中文".into()),
            text_charset: Some(TextCharset::Gbk),
            contains_hex: None,
            frame_prefix: None,
            regex: None,
            protocol_field: None,
        };
        assert!(condition.matches(&frame));
    }

    #[tokio::test]
    async fn file_send_streams_chunks_and_reports_completion() {
        let core = core();
        let (session, cursor) = open(&core).await;
        let path = std::env::temp_dir().join(format!(
            "serialpilot-file-{}-{}.bin",
            std::process::id(),
            SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        tokio::fs::write(&path, [1u8, 2, 3, 4, 5]).await.unwrap();
        let action_id = "file-test".to_string();
        let mut events = core.subscribe();
        let result = core
            .execute(SerialCommand::SendFile {
                session_id: session,
                file_path: path.to_string_lossy().into_owned(),
                protocol: FileTransferProtocol::Null,
                chunk_size: 2,
                interval_ms: 0,
                timeout_ms: Some(100),
                action_id: Some(action_id.clone()),
            })
            .await
            .unwrap();
        assert!(matches!(
            result,
            CommandResult::FileSendStarted {
                file_size: 5,
                chunk_size: 2,
                ..
            }
        ));
        let mut progress = None;
        for _ in 0..20 {
            if let Some(event) = events.try_recv().ok() {
                if matches!(event.kind, EventKind::FileProgress) {
                    progress = serde_json::from_value::<FileProgress>(event.detail).ok();
                }
            }
            if progress.as_ref().is_some_and(|item| item.completed) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        let read = match core
            .execute(SerialCommand::ReadSince {
                session_id: core.status().await.session_id.unwrap(),
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
        assert_eq!(
            read.frames
                .iter()
                .filter(|frame| frame.direction == Direction::Tx)
                .count(),
            3
        );
        assert!(progress.is_some_and(|item| item.completed && item.sent_bytes == 5));
        tokio::fs::remove_file(path).await.unwrap();
    }

    #[tokio::test]
    async fn file_send_can_be_cancelled() {
        let core = core();
        let (session, _) = open(&core).await;
        let path =
            std::env::temp_dir().join(format!("serialpilot-cancel-{}.bin", std::process::id()));
        tokio::fs::write(&path, vec![7u8; 256]).await.unwrap();
        let action_id = "cancel-test".to_string();
        core.execute(SerialCommand::SendFile {
            session_id: session,
            file_path: path.to_string_lossy().into_owned(),
            protocol: FileTransferProtocol::Null,
            chunk_size: 1,
            interval_ms: 5,
            timeout_ms: Some(100),
            action_id: Some(action_id.clone()),
        })
        .await
        .unwrap();
        tokio::time::sleep(Duration::from_millis(8)).await;
        assert!(matches!(
            core.execute(SerialCommand::CancelSendFile { action_id })
                .await
                .unwrap(),
            CommandResult::FileSendCancelled { .. }
        ));
        tokio::time::sleep(Duration::from_millis(15)).await;
        assert!(core.file_send.lock().await.is_none());
        tokio::fs::remove_file(path).await.unwrap();
    }

    #[tokio::test]
    async fn xmodem_without_handshake_can_be_cancelled_immediately() {
        let core = core();
        let (session, _) = open(&core).await;
        let path = std::env::temp_dir().join(format!(
            "serialpilot-xmodem-cancel-{}.bin",
            std::process::id()
        ));
        tokio::fs::write(&path, vec![7u8; 256]).await.unwrap();
        let action_id = "xmodem-cancel-test".to_string();
        core.execute(SerialCommand::SendFile {
            session_id: session,
            file_path: path.to_string_lossy().into_owned(),
            protocol: FileTransferProtocol::Xmodem,
            chunk_size: 128,
            interval_ms: 0,
            timeout_ms: Some(10_000),
            action_id: Some(action_id.clone()),
        })
        .await
        .unwrap();
        tokio::time::sleep(Duration::from_millis(5)).await;
        let started = tokio::time::Instant::now();
        core.execute(SerialCommand::CancelSendFile { action_id })
            .await
            .unwrap();
        assert!(started.elapsed() < Duration::from_millis(100));
        assert!(core.file_send.lock().await.is_none());
        assert!(core.file_task.lock().await.is_none());
        tokio::fs::remove_file(path).await.unwrap();
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
