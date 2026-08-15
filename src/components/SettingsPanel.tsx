/**
 * Serial connection and transmission settings sidebar.
 * The component is presentational: callers own command execution and configuration state.
 */

import { useState } from "react";
import { NumberStepper, OptionPicker, type SelectOption } from "./FormControls";
import { open } from "@tauri-apps/plugin-dialog";
import { Icon } from "./Icon";
import type { FileSendProgress, FileTransferProtocol, SerialConfig, SerialPort } from "../types/serial";

type SettingsPanelProps = {
  config: SerialConfig;
  ports: SerialPort[];
  connected: boolean;
  autoReconnect: boolean;
  timedSend: boolean;
  timerSeconds: number;
  onChange: (config: SerialConfig) => void;
  onOpen: () => void;
  onClose: () => void;
  onRefreshPorts: () => void;
  onAutoReconnect: (value: boolean) => void;
  onTimedSend: (value: boolean) => void;
  onTimerSeconds: (value: number) => void;
  filePath: string;
  fileProtocol: FileTransferProtocol;
  fileProgress?: FileSendProgress;
  onFilePath: (filePath: string) => void;
  onFileProtocol: (protocol: FileTransferProtocol) => void;
  onCancelFileSend: () => Promise<void>;
  onDismissFileSend: () => void;
};

const BAUD_RATES = [300, 600, 1200, 2400, 4800, 9600, 14400, 19200, 38400, 56000, 57600, 115200, 128000, 230400, 256000, 460800, 512000, 750000, 921600, 1000000, 1500000, 2000000];
const DATA_BITS = ["5", "6", "7", "8"];
const STOP_BITS = ["1", "2"];
const PARITY_OPTIONS: SelectOption[] = [{ value: "none", label: "无" }, { value: "even", label: "偶" }, { value: "odd", label: "奇" }];

/**
 * Renders the desktop sidebar for serial configuration and transport controls.
 *
 * @param props Connection state and callbacks supplied by the serial-session hook.
 * @returns The serial settings sidebar.
 */
export function SettingsPanel({ config, ports, connected, autoReconnect, timedSend, timerSeconds, fileProtocol, fileProgress, onChange, onOpen, onClose, onRefreshPorts, onAutoReconnect, onTimedSend, onTimerSeconds, onFilePath, onFileProtocol, onCancelFileSend, onDismissFileSend }: SettingsPanelProps) {
  return <aside className="settings" aria-label="串口配置">
    <div className="settings-title"><h2>串口配置</h2><button type="button" className="tool-button" title="刷新串口列表" aria-label="刷新串口列表" onClick={onRefreshPorts}><Icon name="refresh" /></button></div>
    <label>端口<OptionPicker value={config.port} disabled={connected} options={ports.map((port) => ({ value: port.id, label: port.display_name }))} onChange={(port) => onChange({ ...config, port })} /></label>
    <div className="field-grid"><label>波特率<OptionPicker value={String(config.baud_rate)} disabled={connected} options={BAUD_RATES.map((baudRate) => ({ value: String(baudRate), label: String(baudRate) }))} onChange={(baudRate) => onChange({ ...config, baud_rate: Number(baudRate) })} /></label><label>数据位<OptionPicker value={String(config.data_bits)} disabled={connected} options={DATA_BITS.map((value) => ({ value, label: value }))} onChange={(dataBits) => onChange({ ...config, data_bits: Number(dataBits) })} /></label><label>校验位<OptionPicker value={config.parity} disabled={connected} options={PARITY_OPTIONS} onChange={(parity) => onChange({ ...config, parity })} /></label><label>停止位<OptionPicker value={String(config.stop_bits)} disabled={connected} options={STOP_BITS.map((value) => ({ value, label: value }))} onChange={(stopBits) => onChange({ ...config, stop_bits: Number(stopBits) })} /></label></div>
    <label className="check reconnect-check"><input type="checkbox" checked={autoReconnect} onChange={(event) => onAutoReconnect(event.target.checked)} />断线后自动重连</label>
    <div className="signal-row" aria-label="串口信号线"><span className="signal-indicator unavailable" title="RI：当前适配器未提供状态读取">RI</span><span className="signal-indicator unavailable" title="DSR：当前适配器未提供状态读取">DSR</span><span className="signal-indicator unavailable" title="CTS：当前适配器未提供状态读取">CTS</span><button type="button" className={`signal-toggle ${config.dtr ? "active" : ""}`} title="DTR：打开端口前配置主机就绪线" aria-pressed={config.dtr} disabled={connected} onClick={() => onChange({ ...config, dtr: !config.dtr })}>DTR</button><button type="button" className={`signal-toggle ${config.rts ? "active" : ""}`} title="RTS：打开端口前配置请求发送线" aria-pressed={config.rts} disabled={connected} onClick={() => onChange({ ...config, rts: !config.rts })}>RTS</button></div>
    {connected ? <button className="danger" onClick={onClose}>关闭串口</button> : <button className="primary" onClick={onOpen}>打开串口</button>}
    <div className="settings-divider" />
    <h2>发送控制</h2><div className="timed-send-control"><label className="check"><input type="checkbox" checked={timedSend} onChange={(event) => onTimedSend(event.target.checked)} />定时发送</label><div className="timed-send-interval"><div className="unit-stepper"><NumberStepper value={timerSeconds} min={0.1} max={3600} step={0.1} ariaLabel="定时发送间隔秒数" onChange={onTimerSeconds} /><span>秒</span></div></div></div>
    <div className="settings-divider" />
    <FileTransferSettings fileProtocol={fileProtocol} fileProgress={fileProgress} onFilePath={onFilePath} onFileProtocol={onFileProtocol} onCancelFileSend={onCancelFileSend} onDismissFileSend={onDismissFileSend} />
  </aside>;
}

function FileTransferSettings({ fileProtocol, fileProgress, onFilePath, onFileProtocol, onCancelFileSend, onDismissFileSend }: Pick<SettingsPanelProps, "fileProtocol" | "fileProgress" | "onFilePath" | "onFileProtocol" | "onCancelFileSend" | "onDismissFileSend">) {
  const [error, setError] = useState("");
  const chooseFile = async () => {
    setError("");
    try {
      const selected = await open({ multiple: false, directory: false, title: "选择要发送的文件" });
      if (typeof selected === "string") onFilePath(selected);
    } catch (cause) {
      setError(String(cause));
    }
  };
  return <section className="file-settings"><h2>文件发送</h2><label className="file-protocol">协议<OptionPicker value={fileProtocol} options={[{ value: "null", label: "Null" }, { value: "xmodem", label: "Xmodem" }, { value: "xmodem-1k", label: "Xmodem-1k" }, { value: "ymodem", label: "Ymodem" }]} onChange={(value) => onFileProtocol(value as FileTransferProtocol)} /></label><button type="button" className="secondary file-picker" onClick={() => void chooseFile()}><Icon name="file" size={14} />选择文件</button>{fileProgress && <FileTransferProgress progress={fileProgress} onCancel={onCancelFileSend} onDismiss={onDismissFileSend} />}{error && <small className="file-picker-error" role="alert">{error}</small>}</section>;
}

function FileTransferProgress({ progress, onCancel, onDismiss }: { progress: FileSendProgress; onCancel: () => Promise<void>; onDismiss: () => void }) {
  const percent = progress.file_size === 0 ? 100 : Math.min(100, Math.round((progress.sent_bytes / progress.file_size) * 100));
  const state = progress.cancelled ? "已取消" : progress.completed ? "传输完成" : "正在发送";
  const finished = progress.completed || progress.cancelled;
  return <div className="file-progress" aria-live="polite"><div className="file-progress-head"><span>{state}</span><strong>{percent}%</strong></div><div className="file-progress-bar" role="progressbar" aria-label="文件发送进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}><span style={{ width: `${percent}%` }} /></div><div className="file-progress-line"><small>{formatTransferBytes(progress.sent_bytes)} / {formatTransferBytes(progress.file_size)}</small>{finished ? <button type="button" className="file-dismiss" onClick={onDismiss} title="关闭文件发送状态"><Icon name="close" size={12} />关闭</button> : <button type="button" className="file-cancel" onClick={() => void onCancel()}>取消</button>}</div>{progress.completed && <small className="file-dismiss-hint">3 秒后自动关闭</small>}</div>;
}

function formatTransferBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export const fileTransferFormatters = { formatTransferBytes };
