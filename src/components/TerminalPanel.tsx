/**
 * Live TX/RX terminal view and outbound payload composer.
 * It renders frames emitted by the serial core and delegates all commands to its caller.
 */

import { useEffect, useLayoutEffect, useRef, useState, type ChangeEvent, type CSSProperties, type FormEvent, type UIEvent } from "react";
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

type DirectionFilter = { rx: boolean; tx: boolean };

/**
 * Renders received and transmitted frames plus the send composer.
 *
 * @param props Frame history, status metrics and command callbacks.
 * @returns The terminal workspace panel.
 */
export function TerminalPanel({ activity, status, paused, encoding, payload, canSend, onPause, onClear, onSave, onEncoding, onPayload, onSend }: TerminalPanelProps) {
  const [composerHeight, setComposerHeight] = useState(190);
  const [directionFilter, setDirectionFilter] = useState<DirectionFilter>({ rx: true, tx: true });
  const consoleStyle = { "--composer-height": composerHeight + "px" } as CSSProperties;
  return <section className="console" style={consoleStyle}>
    <div className="metrics"><Metric label="会话缓冲" value={`${formatBytes(status.buffered_bytes)} / ${formatBytes(status.buffer_limit_bytes)}`} /><Metric label="丢弃帧" value={String(status.dropped_frames)} /><Metric label="总 RX" value={`${status.rx_bytes} B`} /><Metric label="总 TX" value={`${status.tx_bytes} B`} /></div>
    <div className="log-head"><h2>实时 TX / RX</h2><div className="log-actions"><span>游标 {status.rx_cursor}</span><DirectionFilterPicker value={directionFilter} onChange={setDirectionFilter} /><button type="button" className="icon-button" title={paused ? "继续接收显示" : "暂停接收显示"} aria-label={paused ? "继续接收显示" : "暂停接收显示"} onClick={onPause}><Icon name={paused ? "play" : "pause"} /></button><button type="button" className="icon-button" title="保存接收数据" aria-label="保存接收数据" onClick={onSave}><Icon name="download" /></button><button type="button" className="icon-button" title="清空接收数据" aria-label="清空接收数据" onClick={onClear}><Icon name="trash" /></button></div></div>
    <FrameLog activity={activity} directionFilter={directionFilter} />
    <ResizableDivider orientation="horizontal" value={composerHeight} min={150} max={360} onChange={setComposerHeight} label="调整发送区高度" />
    <SendComposer encoding={encoding} payload={payload} canSend={canSend} onEncoding={onEncoding} onPayload={onPayload} onSend={onSend} />
  </section>;
}

function DirectionFilterPicker({ value, onChange }: { value: DirectionFilter; onChange: (value: DirectionFilter) => void }) {
  const toggle = (direction: keyof DirectionFilter) => {
    if (value[direction] && !value[direction === "rx" ? "tx" : "rx"]) return;
    onChange({ ...value, [direction]: !value[direction] });
  };
  return <div className="receive-display-picker" aria-label="日志方向过滤"><button type="button" className={value.rx ? "selected" : ""} aria-pressed={value.rx} onClick={() => toggle("rx")}>RX</button><button type="button" className={value.tx ? "selected" : ""} aria-pressed={value.tx} onClick={() => toggle("tx")}>TX</button></div>;
}

function FrameLog({ activity, directionFilter }: { activity: DisplayFrame[]; directionFilter: DirectionFilter }) {
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

  const visibleActivity = filterFramesByDirection(activity, directionFilter);
  if (visibleActivity.length === 0) return <div className="log" aria-live="polite"><p className="empty">没有符合当前 RX / TX 筛选条件的数据。</p></div>;
  return <div className="log" aria-live="polite" ref={logRef} onScroll={handleScroll}>{visibleActivity.map((frame) => <FrameRow key={frame.cursor} frame={frame} />)}{!followTail && <button type="button" className="log-jump-bottom" title="滚动到最新数据" aria-label="滚动到最新数据" onClick={() => { followTailRef.current = true; setFollowTail(true); if (logRef.current) { adjustingScrollRef.current = true; logRef.current.scrollTop = logRef.current.scrollHeight; requestAnimationFrame(() => { adjustingScrollRef.current = false; }); } }}><Icon name="arrowDown" size={14} /></button>}</div>;
}

function FrameRow({ frame }: { frame: DisplayFrame }) {
  const text = formatFrameText(frame.text_utf8, frame.raw_hex);
  return <article className={`frame ${frame.direction} display-text`}><time>{frame.local}</time><b>{frame.direction.toUpperCase()}</b><small className="frame-text text-primary">{text}</small></article>;
}

function filterFramesByDirection(activity: DisplayFrame[], filter: DirectionFilter): DisplayFrame[] {
  return activity.filter((frame) => filter[frame.direction]);
}

function formatFrameText(rawText: string | null | undefined, rawHex: string): string {
  const text = rawText?.trimEnd() ?? "";
  // Binary frames often decode to control characters that occupy no visible glyph.
  // Keep the text view useful by showing the original bytes in that case.
  const hasVisibleCharacter = [...text].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint === 0x09 || codePoint >= 0x20;
  });
  return hasVisibleCharacter ? text : formatHexBytes(rawHex);
}

function formatHexBytes(rawHex: string): string {
  const normalized = rawHex.replace(/\s+/g, "");
  return normalized.match(/.{1,2}/g)?.join(" ") ?? "";
}

function SendComposer({ encoding, payload, canSend, onEncoding, onPayload, onSend }: Pick<TerminalPanelProps, "encoding" | "payload" | "canSend" | "onEncoding" | "onPayload" | "onSend">) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const changeEncoding = (next: "text" | "hex") => {
    onEncoding(next);
    if (next === "hex") onPayload(formatHexInput(payload));
  };
  const changePayload = (event: ChangeEvent<HTMLTextAreaElement>) => {
    if (encoding !== "hex") {
      onPayload(event.target.value);
      return;
    }
    const raw = event.target.value;
    const caret = event.target.selectionStart ?? raw.length;
    const normalized = formatHexInput(raw);
    const hexBeforeCaret = raw.slice(0, caret).replace(/[^0-9a-f]/gi, "").length;
    onPayload(normalized);
    requestAnimationFrame(() => {
      const element = textareaRef.current;
      if (!element) return;
      element.selectionStart = positionAfterHexCount(normalized, hexBeforeCaret);
      element.selectionEnd = element.selectionStart;
    });
  };

  return <form className="composer" onSubmit={onSend}><div className="composer-head"><h2>发送</h2><div className="segmented"><button type="button" className={encoding === "text" ? "selected" : ""} onClick={() => changeEncoding("text")}>文本</button><button type="button" className={encoding === "hex" ? "selected" : ""} onClick={() => changeEncoding("hex")}>HEX</button></div></div><textarea ref={textareaRef} value={payload} onChange={changePayload} spellCheck={false} placeholder={encoding === "hex" ? "AA 55 01" : "输入文本"} /><button className="primary send" disabled={!canSend} type="submit">发送</button></form>;
}

function formatHexInput(value: string): string {
  const normalized = value.replace(/[^0-9a-f]/gi, "").toUpperCase();
  return normalized.match(/.{1,2}/g)?.join(" ") ?? "";
}

function positionAfterHexCount(formatted: string, hexCount: number): number {
  if (hexCount <= 0) return 0;
  let seen = 0;
  for (let index = 0; index < formatted.length; index += 1) {
    if (/[0-9A-F]/.test(formatted[index])) {
      seen += 1;
      if (seen === hexCount) return index + 1;
    }
  }
  return formatted.length;
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div><span>{label}</span><strong>{value}</strong></div>;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

export const terminalFormatters = { formatHexBytes, formatHexInput, formatFrameText, positionAfterHexCount, filterFramesByDirection };
