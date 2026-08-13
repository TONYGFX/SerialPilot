/**
 * Live TX/RX terminal view and outbound payload composer.
 * It renders frames emitted by the serial core and delegates all commands to its caller.
 */

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type FormEvent, type UIEvent } from "react";
import { Icon } from "./Icon";
import { ResizableDivider } from "./ResizableDivider";
import type { DisplayFrame, SerialStatus } from "../types/serial";

type TerminalPanelProps = {
  activity: DisplayFrame[];
  status: SerialStatus;
  paused: boolean;
  encoding: "text" | "hex";
  payload: string;
  canSend: boolean;
  onPause: () => void;
  onClear: () => void;
  onSave: () => void;
  onEncoding: (encoding: "text" | "hex") => void;
  onPayload: (payload: string) => void;
  onSend: (event: FormEvent) => void;
};

type ReceiveDisplayMode = "text" | "hex" | "both";

/**
 * Renders received and transmitted frames plus the send composer.
 *
 * @param props Frame history, status metrics and command callbacks.
 * @returns The terminal workspace panel.
 */
export function TerminalPanel({ activity, status, paused, encoding, payload, canSend, onPause, onClear, onSave, onEncoding, onPayload, onSend }: TerminalPanelProps) {
  const [composerHeight, setComposerHeight] = useState(190);
  const [receiveDisplayMode, setReceiveDisplayMode] = useState<ReceiveDisplayMode>("text");
  const consoleStyle = { "--composer-height": composerHeight + "px" } as CSSProperties;
  return <section className="console" style={consoleStyle}>
    <div className="metrics"><Metric label="会话缓冲" value={`${formatBytes(status.buffered_bytes)} / ${formatBytes(status.buffer_limit_bytes)}`} /><Metric label="丢弃帧" value={String(status.dropped_frames)} /><Metric label="总 RX" value={`${status.rx_bytes} B`} /><Metric label="总 TX" value={`${status.tx_bytes} B`} /></div>
    <div className="log-head"><h2>实时 TX / RX</h2><div className="log-actions"><span>游标 {status.rx_cursor}</span><ReceiveDisplayPicker value={receiveDisplayMode} onChange={setReceiveDisplayMode} /><button type="button" className="icon-button" title={paused ? "继续接收显示" : "暂停接收显示"} aria-label={paused ? "继续接收显示" : "暂停接收显示"} onClick={onPause}><Icon name={paused ? "play" : "pause"} /></button><button type="button" className="icon-button" title="保存接收数据" aria-label="保存接收数据" onClick={onSave}><Icon name="download" /></button><button type="button" className="icon-button" title="清空接收数据" aria-label="清空接收数据" onClick={onClear}><Icon name="trash" /></button></div></div>
    <FrameLog activity={activity} displayMode={receiveDisplayMode} />
    <ResizableDivider orientation="horizontal" value={composerHeight} min={150} max={360} onChange={setComposerHeight} label="调整发送区高度" />
    <SendComposer encoding={encoding} payload={payload} canSend={canSend} onEncoding={onEncoding} onPayload={onPayload} onSend={onSend} />
  </section>;
}

function ReceiveDisplayPicker({ value, onChange }: { value: ReceiveDisplayMode; onChange: (value: ReceiveDisplayMode) => void }) {
  return <div className="receive-display-picker" aria-label="接收显示格式"><button type="button" className={value === "text" ? "selected" : ""} aria-pressed={value === "text"} onClick={() => onChange("text")}>文本</button><button type="button" className={value === "hex" ? "selected" : ""} aria-pressed={value === "hex"} onClick={() => onChange("hex")}>HEX</button><button type="button" className={value === "both" ? "selected" : ""} aria-pressed={value === "both"} onClick={() => onChange("both")}>混合</button></div>;
}

function FrameLog({ activity, displayMode }: { activity: DisplayFrame[]; displayMode: ReceiveDisplayMode }) {
  const logRef = useRef<HTMLDivElement>(null);
  const followTailRef = useRef(true);
  const adjustingScrollRef = useRef(false);
  const [followTail, setFollowTail] = useState(true);

  useLayoutEffect(() => {
    if (!followTailRef.current || !logRef.current) return;
    const element = logRef.current;
    adjustingScrollRef.current = true;
    element.scrollTop = element.scrollHeight;
    requestAnimationFrame(() => { adjustingScrollRef.current = false; });
  }, [activity]);

  const handleScroll = (event: UIEvent<HTMLDivElement>) => {
    if (adjustingScrollRef.current) return;
    const element = event.currentTarget;
    const atTail = element.scrollHeight <= element.clientHeight + 1 || element.scrollHeight - element.scrollTop - element.clientHeight < 24;
    followTailRef.current = atTail;
    setFollowTail((current) => current === atTail ? current : atTail);
  };

  if (activity.length === 0) return <div className="log" aria-live="polite"><p className="empty">打开端口后，核心事件流中的 TX/RX 帧会显示在这里。</p></div>;
  return <div className="log" aria-live="polite" ref={logRef} onScroll={handleScroll}>{activity.map((frame) => <FrameRow key={frame.cursor} frame={frame} displayMode={displayMode} />)}{!followTail && <button type="button" className="log-jump-bottom" title="滚动到最新数据" aria-label="滚动到最新数据" onClick={() => { followTailRef.current = true; setFollowTail(true); if (logRef.current) { adjustingScrollRef.current = true; logRef.current.scrollTop = logRef.current.scrollHeight; requestAnimationFrame(() => { adjustingScrollRef.current = false; }); } }}><Icon name="arrowDown" size={14} /></button>}</div>;
}

function FrameRow({ frame, displayMode }: { frame: DisplayFrame; displayMode: ReceiveDisplayMode }) {
  const text = frame.text_utf8?.trimEnd() || "[非 UTF-8 数据]";
  const showText = displayMode === "text" || displayMode === "both";
  const showHex = displayMode === "hex" || displayMode === "both";
  return <article className={`frame ${frame.direction} display-${displayMode}`}><time>{frame.local}</time><b>{frame.direction.toUpperCase()}</b>{showHex && <code>{formatHexBytes(frame.raw_hex)}</code>}{showText && <small className={displayMode === "text" ? "frame-text text-primary" : "frame-text"}>{text}</small>}</article>;
}

function formatHexBytes(rawHex: string): string {
  const normalized = rawHex.replace(/\s+/g, "");
  return normalized.match(/.{1,2}/g)?.join(" ") ?? "";
}

function SendComposer({ encoding, payload, canSend, onEncoding, onPayload, onSend }: Pick<TerminalPanelProps, "encoding" | "payload" | "canSend" | "onEncoding" | "onPayload" | "onSend">) {
  return <form className="composer" onSubmit={onSend}><div className="composer-head"><h2>发送</h2><div className="segmented"><button type="button" className={encoding === "text" ? "selected" : ""} onClick={() => onEncoding("text")}>文本</button><button type="button" className={encoding === "hex" ? "selected" : ""} onClick={() => onEncoding("hex")}>HEX</button></div></div><textarea value={payload} onChange={(event) => onPayload(event.target.value)} spellCheck={false} placeholder={encoding === "hex" ? "AA 55 01" : "输入文本"} /><button className="primary send" disabled={!canSend} type="submit">发送</button></form>;
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div><span>{label}</span><strong>{value}</strong></div>;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

export const terminalFormatters = { formatHexBytes };
