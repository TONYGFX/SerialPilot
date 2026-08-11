import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import "./styles.css";

type Config = { port: string; baud_rate: number; data_bits: number; parity: string; stop_bits: number; flow_control: string; exclusive: boolean; dtr: boolean; rts: boolean };
type Frame = { cursor: number; timestamp_ms: number; direction: "tx" | "rx"; raw_hex: string; raw_base64: string; text_utf8?: string | null };
type SerialEvent = { event_id: string; timestamp_ms: number; kind: "command_started" | "command_completed" | "command_failed" | "frame"; action: string; action_id?: string | null; detail: unknown };
type Status = { connected: boolean; session_id?: string | null; config?: Config | null; rx_cursor: number; oldest_cursor: number; buffered_bytes: number; buffered_frames: number; dropped_frames: number; rx_bytes: number; tx_bytes: number };
type Port = { id: string; display_name: string; is_mock: boolean };
type Sample = { cursor: number; timestampMs: number; value: number };
type View = "terminal" | "waveform";
type Theme = "dark" | "light";
type SelectOption = { value: string; label: string };

const defaultConfig: Config = { port: "mock://loopback-01", baud_rate: 115200, data_bits: 8, parity: "none", stop_bits: 1, flow_control: "none", exclusive: true, dtr: false, rts: false };
const baudRates = [300, 600, 1200, 2400, 4800, 9600, 14400, 19200, 38400, 56000, 57600, 115200, 128000, 230400, 256000, 460800, 512000, 750000, 921600, 1000000, 1500000, 2000000];

async function command<T>(value: unknown): Promise<T> {
  return invoke<T>("execute_serial", { command: value });
}

function App() {
  const [ports, setPorts] = useState<Port[]>([]);
  const [config, setConfig] = useState<Config>(defaultConfig);
  const [status, setStatus] = useState<Status>({ connected: false, rx_cursor: 0, oldest_cursor: 1, buffered_bytes: 0, buffered_frames: 0, dropped_frames: 0, rx_bytes: 0, tx_bytes: 0 });
  const [frames, setFrames] = useState<Frame[]>([]);
  const [samples, setSamples] = useState<Sample[]>([]);
  const [payload, setPayload] = useState("01 03 00 00 00 02");
  const [encoding, setEncoding] = useState<"text" | "hex">("hex");
  const [view, setView] = useState<View>("terminal");
  const [theme, setTheme] = useState<Theme>(() => window.localStorage.getItem("serialpilot-theme") === "light" ? "light" : "dark");
  const [paused, setPaused] = useState(false);
  const [autoReconnect, setAutoReconnect] = useState(false);
  const [timedSend, setTimedSend] = useState(false);
  const [timerSeconds, setTimerSeconds] = useState(1);
  const [error, setError] = useState<string>();
  const pausedRef = useRef(false);
  const manuallyClosedRef = useRef(false);

  useEffect(() => { pausedRef.current = paused; }, [paused]);
  useEffect(() => { window.localStorage.setItem("serialpilot-theme", theme); }, [theme]);

  const refresh = async () => {
    try {
      const result = await command<{ type: "status"; status: Status }>({ type: "status" });
      setStatus(result.status);
      if (result.status.config) setConfig(result.status.config);
    } catch (cause) {
      setError(String(cause));
    }
  };

  const refreshPorts = async () => {
    try {
      const result = await command<{ type: "ports"; ports: Port[] }>({ type: "list_ports" });
      setPorts(result.ports);
    } catch (cause) {
      setError(String(cause));
    }
  };

  const session = status.session_id;

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void (async () => {
      try {
        unlisten = await listen<SerialEvent>("serial-event", ({ payload: event }) => {
          if (event.kind === "frame") {
            const frame = event.detail as Frame;
            if (pausedRef.current) return;
            setFrames((items) => [frame, ...items].slice(0, 300));
            const value = frame.direction === "rx" ? parseSample(frame.text_utf8) : undefined;
            if (value !== undefined) {
              setSamples((items) => [...items, { cursor: frame.cursor, timestampMs: frame.timestamp_ms, value }].slice(-500));
            }
          }
          if ((event.kind === "command_completed" || event.kind === "command_failed") && event.action !== "serial.status") void refresh();
        });
        await refreshPorts();
        await refresh();
      } catch (cause) {
        setError(String(cause));
      }
    })();
    return () => unlisten?.();
  }, []);

  useEffect(() => {
    if (!timedSend || !status.connected || !session || timerSeconds <= 0) return;
    const timer = window.setInterval(() => {
      void command({ type: "send", session_id: session, encoding, payload, timeout_ms: 1000 }).catch((cause) => setError(String(cause)));
    }, timerSeconds * 1000);
    return () => window.clearInterval(timer);
  }, [timedSend, status.connected, session, timerSeconds, encoding, payload]);

  useEffect(() => {
    if (!autoReconnect || status.connected || manuallyClosedRef.current) return;
    const timer = window.setInterval(() => {
      void command({ type: "open", config }).catch(() => undefined);
    }, 3000);
    return () => window.clearInterval(timer);
  }, [autoReconnect, status.connected, config]);

  const canSend = Boolean(status.connected && session && payload.trim());
  const sessionLabel = status.connected ? `已连接 · ${session?.slice(0, 8)}` : "未连接";
  const activity = useMemo(() => frames.map((frame) => ({ ...frame, local: new Date(frame.timestamp_ms).toLocaleTimeString() })), [frames]);

  const open = async () => {
    setError(undefined);
    manuallyClosedRef.current = false;
    try { await command({ type: "open", config }); } catch (cause) { setError(String(cause)); }
  };
  const close = async () => {
    if (!session) return;
    manuallyClosedRef.current = true;
    try { await command({ type: "close", session_id: session }); } catch (cause) { setError(String(cause)); }
  };
  const send = async (event: FormEvent) => {
    event.preventDefault();
    if (!session) return;
    setError(undefined);
    try { await command({ type: "send", session_id: session, encoding, payload, timeout_ms: 1000 }); } catch (cause) { setError(String(cause)); }
  };
  const clearFrames = () => { setFrames([]); setSamples([]); };
  const setReconnect = (enabled: boolean) => {
    manuallyClosedRef.current = !enabled;
    setAutoReconnect(enabled);
  };
  const saveFrames = () => {
    const content = [...frames].reverse().map((frame) => `${new Date(frame.timestamp_ms).toISOString()} ${frame.direction.toUpperCase()} ${frame.raw_hex}${frame.text_utf8 ? ` ${frame.text_utf8.trim()}` : ""}`).join("\n");
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([content], { type: "text/plain;charset=utf-8" }));
    link.download = `serialpilot-${new Date().toISOString().replace(/[:.]/g, "-")}.log`;
    link.click();
    URL.revokeObjectURL(link.href);
  };

  return <main className="app-shell" data-theme={theme}>
    <header>
      <div><p className="eyebrow">AI SERIAL CONSOLE</p><h1>SerialPilot</h1></div>
      <nav className="view-tabs" aria-label="工作区视图">
        <button type="button" className={view === "terminal" ? "selected" : ""} aria-selected={view === "terminal"} onClick={() => setView("terminal")}>终端</button>
        <button type="button" className={view === "waveform" ? "selected" : ""} aria-selected={view === "waveform"} onClick={() => setView("waveform")}>波形</button>
      </nav>
      <div className="header-status"><button type="button" className="theme-toggle" title={theme === "dark" ? "切换到浅色主题" : "切换到深色主题"} aria-label={theme === "dark" ? "切换到浅色主题" : "切换到深色主题"} onClick={() => setTheme((current) => current === "dark" ? "light" : "dark")}>{theme === "dark" ? "☀" : "☾"}</button><div className={`connection ${status.connected ? "online" : "offline"}`}><i />{sessionLabel}</div></div>
    </header>
    {error && <div className="error" role="alert">{error}</div>}
    <div className="workspace">
      <SettingsPanel config={config} ports={ports} connected={status.connected} autoReconnect={autoReconnect} timedSend={timedSend} timerSeconds={timerSeconds} onChange={setConfig} onOpen={open} onClose={close} onRefreshPorts={refreshPorts} onAutoReconnect={setReconnect} onTimedSend={setTimedSend} onTimerSeconds={setTimerSeconds} />
      {view === "terminal" ? <TerminalPanel activity={activity} status={status} paused={paused} encoding={encoding} payload={payload} canSend={canSend} onPause={() => setPaused((value) => !value)} onClear={clearFrames} onSave={saveFrames} onEncoding={setEncoding} onPayload={setPayload} onSend={send} /> : <WaveformPanel samples={samples} connected={status.connected} />}
    </div>
  </main>;
}

function SettingsPanel({ config, ports, connected, autoReconnect, timedSend, timerSeconds, onChange, onOpen, onClose, onRefreshPorts, onAutoReconnect, onTimedSend, onTimerSeconds }: { config: Config; ports: Port[]; connected: boolean; autoReconnect: boolean; timedSend: boolean; timerSeconds: number; onChange: (config: Config) => void; onOpen: () => void; onClose: () => void; onRefreshPorts: () => void; onAutoReconnect: (value: boolean) => void; onTimedSend: (value: boolean) => void; onTimerSeconds: (value: number) => void }) {
  const lineControlSelected = config.dtr || config.rts;
  return <aside className="settings" aria-label="串口配置">
    <div className="settings-title"><h2>串口配置</h2><button type="button" className="tool-button" title="刷新串口列表" onClick={onRefreshPorts}>↻</button></div>
    <label>端口<OptionPicker value={config.port} disabled={connected} options={ports.map((port) => ({ value: port.id, label: port.display_name }))} onChange={(port) => onChange({ ...config, port })} /></label>
    <div className="field-grid"><label>波特率<OptionPicker value={String(config.baud_rate)} disabled={connected} options={baudRates.map((baudRate) => ({ value: String(baudRate), label: String(baudRate) }))} onChange={(baudRate) => onChange({ ...config, baud_rate: Number(baudRate) })} /></label><label>数据位<OptionPicker value={String(config.data_bits)} disabled={connected} options={["5", "6", "7", "8"].map((value) => ({ value, label: value }))} onChange={(dataBits) => onChange({ ...config, data_bits: Number(dataBits) })} /></label><label>校验位<OptionPicker value={config.parity} disabled={connected} options={[{ value: "none", label: "无" }, { value: "even", label: "偶" }, { value: "odd", label: "奇" }]} onChange={(parity) => onChange({ ...config, parity })} /></label><label>停止位<OptionPicker value={String(config.stop_bits)} disabled={connected} options={["1", "2"].map((value) => ({ value, label: value }))} onChange={(stopBits) => onChange({ ...config, stop_bits: Number(stopBits) })} /></label></div>
    <div className="signal-row" aria-label="串口控制与状态线">
      <label className="signal-check" title="切换 DTR 与 RTS"><input type="checkbox" checked={lineControlSelected} disabled={connected} onChange={(event) => onChange({ ...config, dtr: event.target.checked, rts: event.target.checked })} aria-label="切换 DTR 与 RTS" /></label>
      <span className="signal-input" title="RI：当前适配器不提供来电指示状态">RI</span>
      <span className="signal-input" title="DSR：当前适配器不提供设备就绪状态">DSR</span>
      <span className="signal-input" title="CTS：当前适配器不提供允许发送状态">CTS</span>
      <button type="button" className={`signal-toggle ${config.dtr ? "active" : ""}`} title="DTR：打开端口前配置主机就绪线" aria-pressed={config.dtr} disabled={connected} onClick={() => onChange({ ...config, dtr: !config.dtr })}>DTR</button>
      <button type="button" className={`signal-toggle ${config.rts ? "active" : ""}`} title="RTS：打开端口前配置请求发送线" aria-pressed={config.rts} disabled={connected} onClick={() => onChange({ ...config, rts: !config.rts })}>RTS</button>
    </div>
    {connected ? <button className="danger" onClick={onClose}>关闭串口</button> : <button className="primary" onClick={onOpen}>打开串口</button>}
    <div className="settings-divider" />
    <h2>接收控制</h2>
    <div className="control-row"><button type="button" className="secondary" onClick={onRefreshPorts}>刷新串口</button><button type="button" className="secondary" onClick={() => onAutoReconnect(!autoReconnect)}>{autoReconnect ? "停止重连" : "自动重连"}</button></div>
    <div className="settings-divider" />
    <h2>发送控制</h2>
    <label className="check"><input type="checkbox" checked={timedSend} onChange={(e) => onTimedSend(e.target.checked)} />定时发送</label>
    <label>间隔（秒）<NumberStepper value={timerSeconds} min={0.1} max={3600} step={0.1} onChange={onTimerSeconds} /></label>
    <p className="mock-note">Mock 端口每 250ms 输出 `100`，用于验证 RX 与波形显示。</p>
  </aside>;
}

function OptionPicker({ value, options, disabled, onChange }: { value: string; options: SelectOption[]; disabled?: boolean; onChange: (value: string) => void }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const selected = options.find((option) => option.value === value);

  useEffect(() => {
    const close = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  return <div className="select-control" ref={root}>
    <button type="button" className={`select-trigger ${open ? "open" : ""}`} disabled={disabled} aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen((isOpen) => !isOpen)}>
      <span>{selected?.label ?? value}</span><span className="select-chevron" aria-hidden="true">⌄</span>
    </button>
    {open && <div className="select-menu" role="listbox" aria-label="选择选项">
      {options.map((option) => <button type="button" role="option" aria-selected={option.value === value} className={`select-option ${option.value === value ? "selected" : ""}`} key={option.value} onClick={() => { onChange(option.value); setOpen(false); }}>{option.label}</button>)}
    </div>}
  </div>;
}

function NumberStepper({ value, min, max, step, onChange }: { value: number; min: number; max: number; step: number; onChange: (value: number) => void }) {
  const update = (delta: number) => onChange(Math.min(max, Math.max(min, Number((value + delta).toFixed(2)))));
  return <div className="stepper-control">
    <input type="text" inputMode="decimal" value={value} onChange={(event) => {
      const next = Number(event.target.value);
      if (Number.isFinite(next)) onChange(Math.min(max, Math.max(min, next)));
    }} aria-label="间隔秒数" />
    <div className="stepper-buttons">
      <button type="button" className="stepper-button" aria-label="增加间隔" onClick={() => update(step)}>▲</button>
      <button type="button" className="stepper-button" aria-label="减少间隔" onClick={() => update(-step)}>▼</button>
    </div>
  </div>;
}

function TerminalPanel({ activity, status, paused, encoding, payload, canSend, onPause, onClear, onSave, onEncoding, onPayload, onSend }: { activity: Array<Frame & { local: string }>; status: Status; paused: boolean; encoding: "text" | "hex"; payload: string; canSend: boolean; onPause: () => void; onClear: () => void; onSave: () => void; onEncoding: (encoding: "text" | "hex") => void; onPayload: (payload: string) => void; onSend: (event: FormEvent) => void }) {
  return <section className="console">
    <div className="metrics"><Metric label="RX 缓冲" value={`${status.buffered_bytes} B`} /><Metric label="丢弃帧" value={String(status.dropped_frames)} /><Metric label="总 RX" value={`${status.rx_bytes} B`} /><Metric label="总 TX" value={`${status.tx_bytes} B`} /></div>
    <div className="log-head"><h2>实时 TX / RX</h2><div className="log-actions"><span>游标 {status.rx_cursor}</span><button type="button" className="icon-button" title={paused ? "继续接收显示" : "暂停接收显示"} onClick={onPause}>{paused ? "▶" : "Ⅱ"}</button><button type="button" className="icon-button" title="保存接收数据" onClick={onSave}>↓</button><button type="button" className="icon-button" title="清空接收数据" onClick={onClear}>×</button></div></div>
    <div className="log" aria-live="polite">{activity.length === 0 ? <p className="empty">打开端口后，核心事件流中的 TX/RX 帧会显示在这里。</p> : activity.map((frame) => <article className={`frame ${frame.direction}`} key={frame.cursor}><time>{frame.local}</time><b>{frame.direction.toUpperCase()}</b><code>{frame.raw_hex}</code><small className="frame-text">{frame.text_utf8?.trim()}</small></article>)}</div>
    <form className="composer" onSubmit={onSend}><div className="composer-head"><h2>发送</h2><div className="segmented"><button type="button" className={encoding === "text" ? "selected" : ""} onClick={() => onEncoding("text")}>文本</button><button type="button" className={encoding === "hex" ? "selected" : ""} onClick={() => onEncoding("hex")}>HEX</button></div></div><textarea value={payload} onChange={(e) => onPayload(e.target.value)} spellCheck={false} placeholder={encoding === "hex" ? "AA 55 01" : "输入文本"} /><button className="primary send" disabled={!canSend} type="submit">发送</button></form>
  </section>;
}

function WaveformPanel({ samples, connected }: { samples: Sample[]; connected: boolean }) {
  const plot = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ width: 1000, height: 560 });

  useEffect(() => {
    const element = plot.current;
    if (!element) return;
    const update = () => {
      const { width, height } = element.getBoundingClientRect();
      const next = { width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)) };
      setViewport((current) => current.width === next.width && current.height === next.height ? current : next);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const chart = useMemo(() => buildChart(samples.slice(-240), viewport), [samples, viewport]);
  const latest = samples.at(-1);
  return <section className="waveform">
    <div className="wave-plot" ref={plot}>
      <svg className="wave-svg" viewBox={`0 0 ${chart.viewportWidth} ${chart.viewportHeight}`} preserveAspectRatio="none" role="img" aria-label="串口接收数据波形">
        <rect x={chart.left} y={chart.top} width={chart.plotWidth} height={chart.plotHeight} className="wave-frame" />
        {chart.horizontalGrid.map((line, index) => <g key={`h-${index}`}><line x1={chart.left} y1={line.y} x2={chart.right} y2={line.y} className="wave-grid" /><text x={chart.left - 7} y={line.y + 4} className="wave-label" textAnchor="end">{line.label}</text></g>)}
        {chart.verticalGrid.map((x, index) => <line key={`v-${index}`} x1={x} y1={chart.top} x2={x} y2={chart.bottom} className="wave-grid" />)}
        {chart.path && <path d={chart.path} className="wave-line" />}
        {chart.lastPoint && <circle cx={chart.lastPoint.x} cy={chart.lastPoint.y} r="5" className="wave-point" />}
        <text x={chart.left} y={chart.labelBaseline} className="wave-label">最早</text><text x={chart.right} y={chart.labelBaseline} className="wave-label" textAnchor="end">最新</text>
      </svg>
      {!chart.path && <p className="wave-empty">{connected ? "等待数值型 RX 数据" : "打开端口后开始采集"}</p>}
      <div className="wave-toolbar"><div><h2>波形监视器</h2><p>RX 文本数值 · 每行或 CSV 的第一个数值</p></div><div className="signal-key"><i />CH1 <span>{connected ? "采集中" : "等待连接"}</span></div></div>
      <div className="wave-meta"><span>最近值 <strong>{latest ? formatValue(latest.value) : "--"}</strong></span><span>样本 {samples.length}</span><span>范围 {chart.minLabel} - {chart.maxLabel}</span></div>
      <div className="wave-footer"><span>数据源：串口核心 RX 事件</span><span>窗口：最近 240 个样本</span></div>
    </div>
  </section>;
}

function Metric({ label, value }: { label: string; value: string }) { return <div><span>{label}</span><strong>{value}</strong></div>; }

function parseSample(text?: string | null): number | undefined {
  if (!text) return undefined;
  const firstToken = text.trim().split(/[\s,]+/, 1)[0];
  if (!firstToken || !/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(firstToken)) return undefined;
  const value = Number(firstToken);
  return Number.isFinite(value) ? value : undefined;
}

function buildChart(samples: Sample[], viewport: { width: number; height: number }) {
  const values = samples.map((sample) => sample.value);
  const rawMin = values.length ? Math.min(...values) : 0;
  const rawMax = values.length ? Math.max(...values) : 200;
  const span = Math.max(rawMax - rawMin, 10);
  const min = rawMin - span * 0.16;
  const max = rawMax + span * 0.16;
  const viewportWidth = viewport.width;
  const viewportHeight = viewport.height;
  const left = Math.max(46, Math.round(viewportWidth * .045));
  const top = Math.max(12, Math.round(viewportHeight * .02));
  const right = viewportWidth - Math.max(12, Math.round(viewportWidth * .012));
  const bottom = viewportHeight - Math.max(34, Math.round(viewportHeight * .06));
  const plotWidth = Math.max(1, right - left);
  const plotHeight = Math.max(1, bottom - top);
  const point = (sample: Sample, index: number) => ({ x: left + (samples.length > 1 ? index / (samples.length - 1) : .5) * plotWidth, y: top + (max - sample.value) / (max - min) * plotHeight });
  const points = samples.map(point);
  return {
    viewportWidth, viewportHeight, left, top, right, bottom, plotWidth, plotHeight, labelBaseline: viewportHeight - 8,
    minLabel: formatValue(min), maxLabel: formatValue(max),
    path: points.map((value, index) => `${index === 0 ? "M" : "L"}${value.x.toFixed(2)},${value.y.toFixed(2)}`).join(" "),
    lastPoint: points.at(-1),
    horizontalGrid: Array.from({ length: 6 }, (_, index) => { const y = top + index / 5 * plotHeight; return { y, label: formatValue(max - index / 5 * (max - min)) }; }),
    verticalGrid: Array.from({ length: 10 }, (_, index) => left + index / 9 * plotWidth),
  };
}

function formatValue(value: number) { return Number.isInteger(value) ? String(value) : value.toFixed(2); }

createRoot(document.getElementById("root")!).render(<App />);
