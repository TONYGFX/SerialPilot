/**
 * Shared serial-domain contracts used by the desktop UI and Tauri command bridge.
 * They mirror Rust's serialized command payloads without granting the frontend
 * direct hardware access.
 */

/** Complete port configuration accepted by the serial core. */
export type SerialConfig = {
  port: string;
  baud_rate: number;
  data_bits: number;
  parity: string;
  stop_bits: number;
  flow_control: string;
  exclusive: boolean;
  dtr: boolean;
  rts: boolean;
};

/** An immutable TX or RX frame recorded by the serial core. */
export type SerialFrame = {
  cursor: number;
  timestamp_ms: number;
  direction: "tx" | "rx";
  raw_hex: string;
  raw_base64: string;
  text_utf8?: string | null;
};

/** Structured event emitted by the Rust serial core. */
export type SerialEvent = {
  event_id: string;
  timestamp_ms: number;
  kind: "command_started" | "command_completed" | "command_failed" | "frame" | "file_frame" | "file_progress" | "file_receive_progress";
  action: string;
  action_id?: string | null;
  detail: unknown;
};

/** Progress emitted by the Rust-owned file transmission task. */
export type FileSendProgress = {
  action_id: string;
  file_path: string;
  file_size: number;
  sent_bytes: number;
  chunk_size: number;
  completed: boolean;
  cancelled: boolean;
  failed?: boolean;
  message?: string | null;
};

/** Progress emitted by the Rust-owned X/Ymodem file receiver. */
export type FileReceiveProgress = {
  action_id: string;
  file_path: string;
  file_name: string;
  file_size?: number | null;
  received_bytes: number;
  chunk_size: number;
  waiting: boolean;
  completed: boolean;
  cancelled: boolean;
  failed: boolean;
  message?: string | null;
};

export type FileTransferProtocol = "null" | "xmodem" | "xmodem-1k" | "ymodem";

/** Connection and receive-buffer status returned by serial.status. */
export type SerialStatus = {
  connected: boolean;
  session_id?: string | null;
  config?: SerialConfig | null;
  rx_cursor: number;
  oldest_cursor: number;
  buffered_bytes: number;
  buffer_limit_bytes: number;
  buffered_frames: number;
  dropped_frames: number;
  rx_bytes: number;
  tx_bytes: number;
};

/** A serial port exposed by the current adapter. */
export type SerialPort = {
  id: string;
  display_name: string;
  is_mock: boolean;
};

/** A display-ready frame with an already formatted local timestamp. */
export type DisplayFrame = SerialFrame & { local: string };
