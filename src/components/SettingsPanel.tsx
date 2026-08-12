/**
 * Serial connection and transmission settings sidebar.
 * The component is presentational: callers own command execution and configuration state.
 */

import { useState } from "react";
import { NumberStepper, OptionPicker, type SelectOption } from "./FormControls";
import { open } from "@tauri-apps/plugin-dialog";
import { Icon } from "./Icon";
import type { FileSendProgress, SerialConfig, SerialPort } from "../types/serial";

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
  fileProgress?: FileSendProgress;
  onSendFile: (filePath: string, chunkSize: number, intervalMs: number) => Promise<void>;
  onCancelFile: () => Promise<void>;
};

type FileTransferProtocol = "null" | "xmodem" | "xmodem-1k" | "ymodem";

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
export function SettingsPanel({ config, ports, connected, autoReconnect, timedSend, timerSeconds, fileProgress, onChange, onOpen, onClose, onRefreshPorts, onAutoReconnect, onTimedSend, onTimerSeconds, onSendFile, onCancelFile }: SettingsPanelProps) {
  return <aside className="settings" aria-label="串口配置">
    <div className="settings-title"><h2>串口配置</h2><button type="button" className="tool-button" title="刷新串口列表" aria-label="刷新串口列表" onClick={onRefreshPorts}><Icon name="refresh" /></button></div>
    <label>端口<OptionPicker value={config.port} disabled={connected} options={ports.map((port) => ({ value: port.id, label: port.display_name }))} onChange={(port) => onChange({ ...config, port })} /></label>
    <div className="field-grid"><label>波特率<OptionPicker value={String(config.baud_rate)} disabled={connected} options={BAUD_RATES.map((baudRate) => ({ value: String(baudRate), label: String(baudRate) }))} onChange={(baudRate) => onChange({ ...config, baud_rate: Number(baudRate) })} /></label><label>数据位<OptionPicker value={String(config.data_bits)} disabled={connected} options={DATA_BITS.map((value) => ({ value, label: value }))} onChange={(dataBits) => onChange({ ...config, data_bits: Number(dataBits) })} /></label><label>校验位<OptionPicker value={config.parity} disabled={connected} options={PARITY_OPTIONS} onChange={(parity) => onChange({ ...config, parity })} /></label><label>停止位<OptionPicker value={String(config.stop_bits)} disabled={connected} options={STOP_BITS.map((value) => ({ value, label: value }))} onChange={(stopBits) => onChange({ ...config, stop_bits: Number(stopBits) })} /></label></div>
    <label className="check reconnect-check"><input type="checkbox" checked={autoReconnect} onChange={(event) => onAutoReconnect(event.target.checked)} />断线后自动重连</label>
    <div className="signal-row" aria-label="串口信号线"><span className="signal-indicator unavailable" title="RI：当前适配器未提供状态读取">RI</span><span className="signal-indicator unavailable" title="DSR：当前适配器未提供状态读取">DSR</span><span className="signal-indicator unavailable" title="CTS：当前适配器未提供状态读取">CTS</span><button type="button" className={`signal-toggle ${config.dtr ? "active" : ""}`} title="DTR：打开端口前配置主机就绪线" aria-pressed={config.dtr} disabled={connected} onClick={() => onChange({ ...config, dtr: !config.dtr })}>DTR</button><button type="button" className={`signal-toggle ${config.rts ? "active" : ""}`} title="RTS：打开端口前配置请求发送线" aria-pressed={config.rts} disabled={connected} onClick={() => onChange({ ...config, rts: !config.rts })}>RTS</button></div>
    {connected ? <button className="danger" onClick={onClose}>关闭串口</button> : <button className="primary" onClick={onOpen}>打开串口</button>}
    <div className="settings-divider" />
    <h2>发送控制</h2><div className="timed-send-control"><label className="check"><input type="checkbox" checked={timedSend} onChange={(event) => onTimedSend(event.target.checked)} />定时发送</label><label className="timed-send-interval">间隔（秒）<NumberStepper value={timerSeconds} min={0.1} max={3600} step={0.1} ariaLabel="定时发送间隔秒数" onChange={onTimerSeconds} /></label></div>
    <div className="settings-divider" />
    <FileTransferSettings connected={connected} fileProgress={fileProgress} onSendFile={onSendFile} onCancelFile={onCancelFile} />
    <p className="mock-note">Mock 端口每 250ms 循环输出 X1=100,X2=200 形式的变化数据，用于验证多通道波形。</p>
  </aside>;
}

function FileTransferSettings({ connected, fileProgress, onSendFile, onCancelFile }: Pick<SettingsPanelProps, "connected" | "fileProgress" | "onSendFile" | "onCancelFile">) {
  const [filePath, setFilePath] = useState("");
  const [error, setError] = useState("");
  const [protocol, setProtocol] = useState<FileTransferProtocol>("null");
  const isSending = Boolean(fileProgress && !fileProgress.completed && !fileProgress.cancelled);
  const chooseFile = async () => {
    setError("");
    try {
      const selected = await open({ multiple: false, directory: false, title: "选择要发送的文件" });
      if (typeof selected === "string") setFilePath(selected);
    } catch (cause) {
      setError(String(cause));
    }
  };
  const sendFile = async () => {
    if (!connected || !filePath || isSending) return;
    if (protocol !== "null") {
      setError(`${protocolLabel(protocol)} 需要接收端握手支持，当前版本尚未实现。`);
      return;
    }
    setError("");
    await onSendFile(filePath, 256, 10);
  };
  return <section className="file-settings"><h2>文件发送</h2><div className="file-settings-picker"><button type="button" className="secondary file-picker" onClick={() => void chooseFile()}><Icon name="file" size={14} />选择文件</button><input className="file-path-input" readOnly value={filePath} placeholder="选择后显示文件路径" title={filePath} /></div><label className="file-protocol">协议<OptionPicker value={protocol} options={[{ value: "null", label: "Null（裸数据）" }, { value: "xmodem", label: "Xmodem（未实现）" }, { value: "xmodem-1k", label: "Xmodem-1k（未实现）" }, { value: "ymodem", label: "Ymodem（未实现）" }]} onChange={(value) => setProtocol(value as FileTransferProtocol)} /></label><button type="button" className="secondary file-send" disabled={!connected || !filePath || isSending} onClick={() => void sendFile()}>发送文件</button>{fileProgress && <FileProgressView progress={fileProgress} onCancel={onCancelFile} />}{error && <small className="file-picker-error" role="alert">{error}</small>}</section>;
}

function protocolLabel(protocol: FileTransferProtocol): string {
  return protocol === "xmodem-1k" ? "Xmodem-1k" : protocol[0].toUpperCase() + protocol.slice(1);
}

function FileProgressView({ progress, onCancel }: { progress: FileSendProgress; onCancel: () => Promise<void> }) {
  const percent = progress.file_size === 0 ? 100 : Math.min(100, Math.round(progress.sent_bytes / progress.file_size * 100));
  const label = progress.cancelled ? "已取消" : progress.completed ? "已完成" : `${percent}%`;
  return <div className="file-progress" title={`${progress.sent_bytes} / ${progress.file_size} B`}><div className="file-progress-line"><div className="file-progress-bar"><span style={{ width: `${percent}%` }} /></div><strong>{label}</strong>{!progress.completed && !progress.cancelled && <button type="button" className="file-cancel" onClick={() => void onCancel()}>取消</button>}</div></div>;
}
