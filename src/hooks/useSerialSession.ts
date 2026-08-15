/**
 * Owns the frontend projection of one Rust-backed serial session.
 * The hook subscribes to core events and issues structured commands; it never
 * accesses a physical serial device or duplicates receive-buffer behavior.
 */

import { listen } from "@tauri-apps/api/event";
import { save } from "@tauri-apps/plugin-dialog";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type FormEvent,
  type MutableRefObject,
  type SetStateAction,
} from "react";
import { parseConfiguredFrame } from "../lib/waveform";
import { decodeSerialText } from "../lib/textEncoding";
import { executeSerialCommand, saveTextFile } from "../services/serialClient";
import type { FileSendProgress, FileTransferProtocol, SerialConfig, SerialEvent, SerialFrame, SerialPort, SerialStatus } from "../types/serial";
import type { TextCharset } from "../types/settings";
import type { WaveChannel, WaveSample } from "../types/waveform";

const DEFAULT_CONFIG: SerialConfig = { port: "", baud_rate: 115200, data_bits: 8, parity: "none", stop_bits: 1, flow_control: "none", exclusive: true, dtr: false, rts: false };
const EMPTY_STATUS: SerialStatus = { connected: false, rx_cursor: 0, oldest_cursor: 1, buffered_bytes: 0, buffer_limit_bytes: 0, buffered_frames: 0, dropped_frames: 0, rx_bytes: 0, tx_bytes: 0 };

type StateSetter<Value> = Dispatch<SetStateAction<Value>>;

type SerialEventHandlers = {
  pausedRef: MutableRefObject<boolean>;
  waveformPausedRef: MutableRefObject<boolean>;
  textCharsetRef: MutableRefObject<TextCharset>;
  channelsRef: MutableRefObject<WaveChannel[]>;
  setFrames: StateSetter<SerialFrame[]>;
  setWaveSamples: StateSetter<WaveSample[]>;
  setWaveChannels: StateSetter<WaveChannel[]>;
  setFileProgress: StateSetter<FileSendProgress | undefined>;
  cancelledFileActionRef: MutableRefObject<string | undefined>;
  refreshPorts: () => Promise<void>;
  refreshStatus: () => Promise<void>;
  setError: StateSetter<string | undefined>;
};

export type SerialSession = {
  ports: SerialPort[];
  config: SerialConfig;
  status: SerialStatus;
  frames: SerialFrame[];
  waveSamples: WaveSample[];
  waveChannels: WaveChannel[];
  fileProgress?: FileSendProgress;
  filePath: string;
  fileProtocol: FileTransferProtocol;
  waveformPaused: boolean;
  payload: string;
  encoding: "text" | "hex";
  paused: boolean;
  autoReconnect: boolean;
  timedSend: boolean;
  timerSeconds: number;
  error?: string;
  setConfig: (config: SerialConfig) => void;
  setPayload: (payload: string) => void;
  setEncoding: (encoding: "text" | "hex") => void;
  setFilePath: (filePath: string) => void;
  setFileProtocol: (protocol: FileTransferProtocol) => void;
  setTimedSend: (enabled: boolean) => void;
  setTimerSeconds: (seconds: number) => void;
  setWaveChannels: (channels: WaveChannel[]) => void;
  refreshPorts: () => Promise<void>;
  open: () => Promise<void>;
  close: () => Promise<void>;
  send: (event: FormEvent) => Promise<void>;
  clearFrames: () => void;
  clearWaveform: () => void;
  saveFrames: () => void;
  togglePaused: () => void;
  toggleWaveformPaused: () => void;
  setAutoReconnect: (enabled: boolean) => void;
  sendFile: (filePath: string, chunkSize: number, intervalMs: number) => Promise<void>;
  cancelFileSend: () => Promise<void>;
  dismissFileSend: () => void;
};

/**
 * Connects the desktop UI to the serial core event and command stream.
 *
 * @returns Current serial-session state plus UI-safe command actions.
 */
export function useSerialSession(textCharset: TextCharset): SerialSession {
  const [ports, setPorts] = useState<SerialPort[]>([]);
  const [config, setConfig] = useState<SerialConfig>(DEFAULT_CONFIG);
  const [status, setStatus] = useState<SerialStatus>(EMPTY_STATUS);
  const [frames, setFrames] = useState<SerialFrame[]>([]);
  const [waveSamples, setWaveSamples] = useState<WaveSample[]>([]);
  const [waveChannels, setWaveChannelsState] = useState<WaveChannel[]>([]);
  const [fileProgress, setFileProgress] = useState<FileSendProgress>();
  const [filePath, setFilePath] = useState("");
  const [fileProtocol, setFileProtocol] = useState<FileTransferProtocol>("null");
  const [payload, setPayload] = useState("01 03 00 00 00 02");
  const [encoding, setEncoding] = useState<"text" | "hex">("hex");
  const [paused, setPaused] = useState(false);
  const [waveformPaused, setWaveformPaused] = useState(true);
  const [autoReconnect, setAutoReconnectState] = useState(false);
  const [timedSend, setTimedSend] = useState(false);
  const [timerSeconds, setTimerSeconds] = useState(1);
  const [error, setError] = useState<string>();
  const pausedRef = useRef(false);
  const waveformPausedRef = useRef(true);
  const textCharsetRef = useRef<TextCharset>(textCharset);
  const channelsRef = useRef<WaveChannel[]>([]);
  const cancelledFileActionRef = useRef<string>();
  const manuallyClosedRef = useRef(false);
  const hasConnectedRef = useRef(false);
  const sessionId = status.session_id;

  useEffect(() => { pausedRef.current = paused; }, [paused]);
  useEffect(() => { waveformPausedRef.current = waveformPaused; }, [waveformPaused]);
  useEffect(() => { textCharsetRef.current = textCharset; }, [textCharset]);
  useEffect(() => { channelsRef.current = waveChannels; }, [waveChannels]);
  useEffect(() => { if (status.connected) hasConnectedRef.current = true; }, [status.connected]);
  useEffect(() => {
    if (!fileProgress?.completed) return;
    const actionId = fileProgress.action_id;
    const dismissTimer = window.setTimeout(() => {
      setFileProgress((current) => current?.action_id === actionId ? undefined : current);
    }, 5_000);
    return () => window.clearTimeout(dismissTimer);
  }, [fileProgress]);

  const refreshStatus = useCallback(async () => {
    try {
      const result = await executeSerialCommand<{ type: "status"; status: SerialStatus }>({ type: "status" });
      setStatus(result.status);
      if (result.status.config) setConfig(result.status.config);
    } catch (cause) {
      setError(String(cause));
    }
  }, []);

  const refreshPorts = useCallback(async () => {
    try {
      const result = await executeSerialCommand<{ type: "ports"; ports: SerialPort[] }>({ type: "list_ports" });
      setPorts(result.ports);
    } catch (cause) {
      setError(String(cause));
    }
  }, []);

  useSerialEvents({ pausedRef, waveformPausedRef, textCharsetRef, channelsRef, cancelledFileActionRef, setFrames, setWaveSamples, setWaveChannels: setWaveChannelsState, setFileProgress, refreshPorts, refreshStatus, setError });
  useEffect(() => {
    void executeSerialCommand<{ type: "waveform_channels"; channels: WaveChannel[] }>({ type: "waveform_list_channels" })
      .then((result) => setWaveChannelsState(result.channels))
      .catch((cause) => setError(String(cause)));
  }, []);
  useTimedSend(timedSend, status.connected, sessionId, timerSeconds, encoding, textCharset, payload, setError);
  useAutoReconnect(autoReconnect, status.connected, manuallyClosedRef, hasConnectedRef, config);

  const open = async () => {
    setError(undefined);
    manuallyClosedRef.current = false;
    try { await executeSerialCommand({ type: "open", config }); } catch (cause) { setError(String(cause)); }
  };
  const close = async () => {
    if (!sessionId) return;
    manuallyClosedRef.current = true;
    try { await executeSerialCommand({ type: "close", session_id: sessionId }); } catch (cause) { setError(String(cause)); }
  };
  const send = async (event: FormEvent) => {
    event.preventDefault();
    if (!sessionId) return;
    setError(undefined);
    if (filePath) {
      await sendFile(filePath, 256, 10);
      return;
    }
    try {
      const result = await executeSerialCommand<{ type: "sent"; action_id: string; frame: SerialFrame }>({ type: "send", session_id: sessionId, encoding, text_charset: textCharset, payload, timeout_ms: 1000 });
      // The command result is authoritative for the local TX row. The event is still
      // consumed for other subscribers, but cursor de-duplication prevents two rows.
      appendEventFrame(result.frame, pausedRef.current, setFrames);
    } catch (cause) { setError(String(cause)); }
  };
  const clearFrames = () => { setFrames([]); setWaveSamples([]); };
  const clearWaveform = () => {
    setWaveSamples([]);
    void executeSerialCommand({ type: "waveform_clear_samples" }).catch((cause) => setError(String(cause)));
  };
  const saveFrames = () => { void saveFrameLog(frames, textCharset).catch((cause) => setError(String(cause))); };
  const togglePaused = () => setPaused((current) => !current);
  const toggleWaveformPaused = () => {
    if (waveformPausedRef.current) {
      setWaveSamples([]);
      void executeSerialCommand({ type: "waveform_clear_samples" }).catch((cause) => setError(String(cause)));
    }
    setWaveformPaused((current) => !current);
  };
  const setWaveChannels = (channels: WaveChannel[]) => {
    setWaveChannelsState(channels);
    void executeSerialCommand({ type: "waveform_set_channels", channels }).catch((cause) => setError(String(cause)));
  };
  const setAutoReconnect = (enabled: boolean) => {
    setAutoReconnectState(enabled);
  };
  const sendFile = async (filePath: string, chunkSize: number, intervalMs: number) => {
    if (!sessionId) return;
    const actionId = crypto.randomUUID();
    cancelledFileActionRef.current = undefined;
    setError(undefined);
    try {
      const result = await executeSerialCommand<{ type: "file_send_started"; action_id: string; file_size: number; chunk_size: number }>({ type: "send_file", session_id: sessionId, file_path: filePath, protocol: fileProtocol, chunk_size: chunkSize, interval_ms: intervalMs, timeout_ms: 1000, action_id: actionId });
      setFileProgress((current) => current?.action_id === result.action_id ? current : { action_id: result.action_id, file_path: filePath, file_size: result.file_size, sent_bytes: 0, chunk_size: result.chunk_size, completed: false, cancelled: false });
    } catch (cause) {
      setError(String(cause));
    }
  };
  const cancelFileSend = async () => {
    if (!fileProgress || fileProgress.completed || fileProgress.cancelled) return;
    const actionId = fileProgress.action_id;
    cancelledFileActionRef.current = actionId;
    // Close the transient UI before awaiting the backend. The backend may be
    // finishing concurrently, so a "no matching task" response is harmless.
    setFileProgress(undefined);
    try {
      await executeSerialCommand({ type: "cancel_send_file", action_id: actionId });
    } catch (cause) {
      if (!String(cause).includes("no matching file send is active")) {
        setError(String(cause));
      }
    }
  };
  const dismissFileSend = () => setFileProgress(undefined);

  return { ports, config, status, frames, waveSamples, waveChannels, fileProgress, filePath, fileProtocol, waveformPaused, payload, encoding, paused, autoReconnect, timedSend, timerSeconds, error, setConfig, setPayload, setEncoding, setFilePath, setFileProtocol, setTimedSend, setTimerSeconds, setWaveChannels, refreshPorts, open, close, send, sendFile, cancelFileSend, dismissFileSend, clearFrames, clearWaveform, saveFrames, togglePaused, toggleWaveformPaused, setAutoReconnect };
}

function useSerialEvents(handlers: SerialEventHandlers) {
  const { pausedRef, waveformPausedRef, textCharsetRef, channelsRef, cancelledFileActionRef, setFrames, setWaveSamples, setWaveChannels, setFileProgress, refreshPorts, refreshStatus, setError } = handlers;
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let isDisposed = false;
    void subscribeToSerialEvents({ pausedRef, waveformPausedRef, textCharsetRef, channelsRef, cancelledFileActionRef, setFrames, setWaveSamples, setWaveChannels, setFileProgress, refreshPorts, refreshStatus, setError }).then((listener) => {
      if (isDisposed) listener();
      else unlisten = listener;
    });
    return () => { isDisposed = true; unlisten?.(); };
  }, [cancelledFileActionRef, channelsRef, pausedRef, refreshPorts, refreshStatus, setError, setFileProgress, setFrames, setWaveChannels, setWaveSamples, textCharsetRef, waveformPausedRef]);
}

async function subscribeToSerialEvents(handlers: SerialEventHandlers): Promise<() => void> {
  const { pausedRef, waveformPausedRef, textCharsetRef, channelsRef, cancelledFileActionRef, setFrames, setWaveSamples, setWaveChannels, setFileProgress, refreshPorts, refreshStatus, setError } = handlers;
  try {
    const unlisten = await listen<SerialEvent>("serial-event", ({ payload: event }) => handleSerialEvent(event, pausedRef, waveformPausedRef, textCharsetRef, channelsRef, cancelledFileActionRef, setFrames, setWaveSamples, setWaveChannels, setFileProgress, refreshStatus));
    await refreshPorts();
    await refreshStatus();
    return unlisten;
  } catch (cause) {
    setError(String(cause));
    return () => undefined;
  }
}

function handleSerialEvent(event: SerialEvent, pausedRef: MutableRefObject<boolean>, waveformPausedRef: MutableRefObject<boolean>, textCharsetRef: MutableRefObject<TextCharset>, channelsRef: MutableRefObject<WaveChannel[]>, cancelledFileActionRef: MutableRefObject<string | undefined>, setFrames: StateSetter<SerialFrame[]>, setWaveSamples: StateSetter<WaveSample[]>, setWaveChannels: StateSetter<WaveChannel[]>, setFileProgress: StateSetter<FileSendProgress | undefined>, refreshStatus: () => Promise<void>) {
  if (event.kind === "frame") {
    const frame = event.detail as SerialFrame;
    appendEventFrame(frame, pausedRef.current, setFrames);
    appendWaveFrame(frame, waveformPausedRef.current, textCharsetRef.current, channelsRef.current, setWaveSamples);
  }
  if (event.kind === "file_progress") {
    const progress = event.detail as FileSendProgress;
    if (cancelledFileActionRef.current === progress.action_id) {
      if (progress.cancelled) setFileProgress(undefined);
      return;
    }
    setFileProgress(progress.cancelled ? undefined : progress);
  }
  if (event.kind === "command_completed" && event.action.startsWith("waveform.")) {
    const detail = event.detail as { channels?: WaveChannel[] };
    if (detail.channels) {
      channelsRef.current = detail.channels;
      setWaveChannels(detail.channels);
    }
    if (event.action === "waveform.clear_samples") setWaveSamples([]);
  }
  if ((event.kind === "command_completed" || event.kind === "command_failed") && event.action !== "serial.status") void refreshStatus();
}

function appendEventFrame(frame: SerialFrame, isPaused: boolean, setFrames: StateSetter<SerialFrame[]>) {
  if (isPaused) return;
  setFrames((items) => items.some((item) => item.cursor === frame.cursor) ? items : [...items, frame].slice(-300));
}

function appendWaveFrame(frame: SerialFrame, isPaused: boolean, textCharset: TextCharset, channels: WaveChannel[], setWaveSamples: StateSetter<WaveSample[]>) {
  if (isPaused || frame.direction !== "rx") return;
  const samples = parseConfiguredFrame(frame, channels, decodeSerialText(frame.raw_base64, textCharset));
  if (samples.length === 0) return;
  setWaveSamples((items) => [...items, ...samples].slice(-1800));
}

function useTimedSend(enabled: boolean, connected: boolean, sessionId: string | null | undefined, seconds: number, encoding: "text" | "hex", textCharset: TextCharset, payload: string, setError: StateSetter<string | undefined>) {
  useEffect(() => {
    if (!enabled || !connected || !sessionId || seconds <= 0) return;
    const timer = window.setInterval(() => { void executeSerialCommand({ type: "send", session_id: sessionId, encoding, text_charset: textCharset, payload, timeout_ms: 1000 }).catch((cause) => setError(String(cause))); }, seconds * 1000);
    return () => window.clearInterval(timer);
  }, [enabled, connected, sessionId, seconds, encoding, textCharset, payload, setError]);
}

function useAutoReconnect(enabled: boolean, connected: boolean, manuallyClosedRef: MutableRefObject<boolean>, hasConnectedRef: MutableRefObject<boolean>, config: SerialConfig) {
  useEffect(() => {
    if (!enabled || connected || manuallyClosedRef.current || !hasConnectedRef.current) return;
    const timer = window.setInterval(() => { void executeSerialCommand({ type: "open", config }).catch((cause) => console.warn("SerialPilot automatic reconnect failed:", cause)); }, 3000);
    return () => window.clearInterval(timer);
  }, [enabled, connected, manuallyClosedRef, hasConnectedRef, config]);
}

async function saveFrameLog(frames: SerialFrame[], textCharset: TextCharset) {
  const content = [...frames].reverse().map((frame) => `${new Date(frame.timestamp_ms).toISOString()} ${frame.direction.toUpperCase()} ${frame.raw_hex} ${decodeSerialText(frame.raw_base64, textCharset).trim()}`.trimEnd()).join("\n");
  const path = await save({ defaultPath: `serialpilot-${formatSaveTimestamp(new Date())}.txt`, filters: [{ name: "文本文件", extensions: ["txt"] }] });
  if (path) await saveTextFile(path, content);
}

function formatSaveTimestamp(date: Date): string {
  return date.toISOString().replace(/[:.]/g, "-");
}
