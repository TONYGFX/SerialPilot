/**
 * Renders the configured waveform workspace and its channel editor.
 * The component only displays samples derived from RX events; channel rules
 * are passed back to the serial-session hook for deterministic capture.
 */

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  type SetStateAction,
  type WheelEvent as ReactWheelEvent,
} from "react";
import { Icon } from "./Icon";
import { buildWaveChart, formatWaveValue, limitSamplesPerChannel } from "../lib/waveform";
import type { WaveChannel, WaveSample, WaveformSettings } from "../types/waveform";

type WaveformPanelProps = {
  samples: WaveSample[];
  channels: WaveChannel[];
  connected: boolean;
  paused: boolean;
  onPause: () => void;
  onClear: () => void;
  onChannelsChange: (channels: WaveChannel[]) => void;
};

type OpenMenu = "channels" | "settings" | undefined;

const DEFAULT_SETTINGS: WaveformSettings = {
  samplesPerChannel: 240,
  showLatestMarker: true,
};

const CHANNEL_COLORS = ["#61d792", "#5fc7dd", "#e8ba61", "#df7aa4", "#a8a6ee", "#d9935d"];
const WAVE_AXIS_WIDTH = 58;
const WAVE_TOOLBAR_HEIGHT = 54;

/**
 * Draws configured channels using an aspect-correct SVG viewport.
 *
 * @param props Channel configuration, serial-derived samples and user actions.
 * @returns The waveform workspace panel.
 */
export function WaveformPanel({ samples, channels, connected, paused, onPause, onClear, onChannelsChange }: WaveformPanelProps) {
  const plot = useRef<HTMLDivElement>(null);
  const toolbar = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<HoverPoint>();
  const [settings, setSettings] = useState<WaveformSettings>(DEFAULT_SETTINGS);
  const [openMenu, setOpenMenu] = useState<OpenMenu>();
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ startX: number; startY: number; originX: number; originY: number }>();
  const visibleSamples = useVisibleSamples(samples, channels, settings.samplesPerChannel);
  const viewport = useMeasuredViewport(plot, settings.samplesPerChannel, channels.length);
  const chart = useMemo(() => buildWaveChart(visibleSamples, channels, { width: viewport.contentWidth, height: viewport.contentHeight }), [visibleSamples, channels, viewport.contentWidth, viewport.contentHeight]);
  const panBounds = useMemo(() => ({
    x: Math.max(0, chart.viewportWidth - viewport.width),
    y: Math.max(0, chart.viewportHeight - viewport.height),
  }), [chart.viewportHeight, chart.viewportWidth, viewport.height, viewport.width]);
  const latestValues = useMemo(() => getLatestValues(samples), [samples]);

  useEffect(() => {
    setPan((current) => clampPan(current, panBounds));
  }, [panBounds]);

  const updatePan = (x: number, y: number) => setPan(clampPan({ x, y }, panBounds));
  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { startX: event.clientX, startY: event.clientY, originX: pan.x, originY: pan.y };
    setDragging(true);
  };
  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const currentDrag = drag.current;
    if (!currentDrag) return;
    updatePan(currentDrag.originX + event.clientX - currentDrag.startX, currentDrag.originY + event.clientY - currentDrag.startY);
  };
  const handlePointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    drag.current = undefined;
    setDragging(false);
  };
  const handleWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    const horizontalDelta = event.shiftKey ? event.deltaY : event.deltaX;
    const verticalDelta = event.shiftKey ? 0 : event.deltaY;
    updatePan(pan.x - horizontalDelta, pan.y - verticalDelta);
  };

  useDismissableMenu(toolbar, openMenu, () => setOpenMenu(undefined));

  return <section className="waveform">
    <div className="wave-plot" ref={plot}>
      <div className="wave-surface">
        <div className="wave-axis" aria-hidden="true">
          <div className="wave-axis-content" style={{ width: WAVE_AXIS_WIDTH, height: chart.viewportHeight }}>
            <WaveYAxis chart={chart} height={viewport.height} />
          </div>
        </div>
        <div className={"wave-viewport " + (dragging ? "dragging" : "")} onWheel={handleWheel} onPointerDown={handlePointerDown} onPointerMove={handlePointerMove} onPointerUp={handlePointerUp} onPointerCancel={handlePointerUp} onMouseLeave={() => setHover(undefined)}>
          <div className="wave-pan-layer" style={{ width: chart.viewportWidth, height: chart.viewportHeight, transform: `translate(${pan.x}px, ${pan.y}px)` }}>
            <WaveSvg chart={chart} plot={plot} showLatestMarker={settings.showLatestMarker} onHover={setHover} onLeave={() => setHover(undefined)} />
          </div>
        </div>
      </div>
      {hover && <WaveHover point={hover} />}
      {chart.series.length === 0 && <p className="wave-empty">{getEmptyMessage(connected, channels)}</p>}
      <div className="wave-overlay" ref={toolbar}>
        <WaveToolbar
          channelCount={channels.length}
          connected={connected}
          openMenu={openMenu}
          paused={paused}
          onClear={onClear}
          onPause={onPause}
          onToggleMenu={setOpenMenu}
        />
        {openMenu === "channels" && <ChannelEditor channels={channels} latestValues={latestValues} onChange={onChannelsChange} />}
        {openMenu === "settings" && <SettingsMenu settings={settings} onChange={setSettings} />}
      </div>
      <WaveMetadata channelCount={chart.series.length} chart={chart} sampleCount={visibleSamples.length} />
      <WaveLegend chart={chart} />
      <div className="wave-footer"><span>数据源：RX 名称=数值帧</span><span>每通道窗口：{settings.samplesPerChannel}</span></div>
    </div>
  </section>;
}

type HoverPoint = { point: ReturnType<typeof buildWaveChart>["series"][number]["points"][number]; channel: WaveChannel; left: number; top: number };

function WaveYAxis({ chart, height }: { chart: ReturnType<typeof buildWaveChart>; height: number }) {
  return <svg className="wave-axis-svg" width={WAVE_AXIS_WIDTH} height={chart.viewportHeight} viewBox={`0 0 ${WAVE_AXIS_WIDTH} ${chart.viewportHeight}`} preserveAspectRatio="none">
    {chart.horizontalGrid.map((line, index) => {
      const visibleY = chart.top + index / Math.max(1, chart.horizontalGrid.length - 1) * Math.max(1, height - chart.top - 64);
      return <text key={"axis-" + index} x={WAVE_AXIS_WIDTH - 8} y={visibleY + 4} className="wave-label" textAnchor="end">{line.label}</text>;
    })}
  </svg>;
}

function WaveSvg({ chart, plot, showLatestMarker, onHover, onLeave }: { chart: ReturnType<typeof buildWaveChart>; plot: RefObject<HTMLDivElement>; showLatestMarker: boolean; onHover: (hover: HoverPoint) => void; onLeave: () => void }) {
  const viewBox = "0 0 " + chart.viewportWidth + " " + chart.viewportHeight;
  const handleMove = (event: ReactMouseEvent<SVGSVGElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    const x = (event.clientX - bounds.left) * chart.viewportWidth / bounds.width;
    const y = (event.clientY - bounds.top) * chart.viewportHeight / bounds.height;
    const nearest = findNearestPoint(chart, x, y);
    if (!nearest) return onLeave();
    const plotBounds = plot.current?.getBoundingClientRect();
    if (!plotBounds) return onLeave();
    onHover({ ...nearest, left: event.clientX - plotBounds.left, top: event.clientY - plotBounds.top });
  };
  return <svg className="wave-svg" viewBox={viewBox} preserveAspectRatio="none" role="img" aria-label="配置通道的串口接收数据波形" onMouseMove={handleMove} onMouseLeave={onLeave}>
    <rect x={chart.left} y={chart.top} width={chart.plotWidth} height={chart.plotHeight} className="wave-frame" />
    {chart.horizontalGrid.map((line, index) => <line key={"h-" + index} x1={chart.left} y1={line.y} x2={chart.right} y2={line.y} className="wave-grid" />)}
    {chart.verticalGrid.map((x, index) => <line key={"v-" + index} x1={x} y1={chart.top} x2={x} y2={chart.bottom} className="wave-grid" />)}
    {chart.series.map((series) => <path key={series.channel.id} d={series.path} className="wave-line" style={{ stroke: series.channel.color }} />)}
    {showLatestMarker && chart.series.map((series) => series.lastPoint && <circle key={"point-" + series.channel.id} cx={series.lastPoint.x} cy={series.lastPoint.y} r="4.5" className="wave-point" style={{ fill: series.channel.color, stroke: series.channel.color }} />)}
    <text x={chart.left} y={chart.labelBaseline} className="wave-label">最早</text><text x={chart.right} y={chart.labelBaseline} className="wave-label" textAnchor="end">最新</text>
  </svg>;
}

function findNearestPoint(chart: ReturnType<typeof buildWaveChart>, x: number, y: number): { point: HoverPoint["point"]; channel: WaveChannel } | undefined {
  let nearest: { point: HoverPoint["point"]; channel: WaveChannel; distance: number } | undefined;
  for (const series of chart.series) {
    for (const point of series.points) {
      const distance = Math.hypot(point.x - x, point.y - y);
      if (distance > 22 || (nearest && distance >= nearest.distance)) continue;
      nearest = { point, channel: series.channel, distance };
    }
  }
  return nearest;
}

function WaveHover({ point }: { point: HoverPoint }) {
  const left = Math.min(Math.max(point.left + 14, 12), 420);
  const top = Math.max(point.top - 74, 74);
  return <div className="wave-hover" style={{ left, top }}>
    <strong style={{ color: point.channel.color }}>{point.channel.name}</strong>
    <span>值 {formatWaveValue(point.point.sample.value)}</span>
    <span>时间 {new Date(point.point.sample.timestampMs).toLocaleTimeString()}</span>
    <span>游标 #{point.point.sample.cursor}</span>
  </div>;
}

function WaveToolbar({ channelCount, connected, openMenu, paused, onClear, onPause, onToggleMenu }: {
  channelCount: number;
  connected: boolean;
  openMenu: OpenMenu;
  paused: boolean;
  onClear: () => void;
  onPause: () => void;
  onToggleMenu: Dispatch<SetStateAction<OpenMenu>>;
}) {
  return <div className="wave-toolbar">
    <div><h2>波形监视器</h2><p>RX 名称=数值 · 手动通道配置</p></div>
    <div className="wave-actions">
      <button type="button" className={"wave-action " + (openMenu === "channels" ? "active" : "")} title="配置波形通道" aria-label="配置波形通道" aria-expanded={openMenu === "channels"} onClick={() => toggleMenu("channels", onToggleMenu)}><Icon name="channels" /><b>{channelCount}</b></button>
      <button type="button" className={"wave-action " + (paused ? "active" : "")} title={paused ? "继续波形显示" : "暂停波形显示"} aria-label={paused ? "继续波形显示" : "暂停波形显示"} aria-pressed={paused} onClick={onPause}><Icon name={paused ? "play" : "pause"} /></button>
      <button type="button" className="wave-action" title="清空波形数据" aria-label="清空波形数据" onClick={onClear}><Icon name="trash" /></button>
      <button type="button" className={"wave-action " + (openMenu === "settings" ? "active" : "")} title="波形显示设置" aria-label="波形显示设置" aria-expanded={openMenu === "settings"} onClick={() => toggleMenu("settings", onToggleMenu)}><Icon name="settings" /></button>
      <span className={"wave-state " + (connected ? "online" : "")}>{paused ? "已暂停" : connected ? "采集中" : "等待连接"}</span>
    </div>
  </div>;
}

function ChannelEditor({ channels, latestValues, onChange }: { channels: WaveChannel[]; latestValues: Map<string, number>; onChange: (channels: WaveChannel[]) => void }) {
  return <div className="wave-popover channel-editor" role="dialog" aria-label="波形通道配置">
    <div className="wave-popover-head"><strong>通道配置</strong><button type="button" onClick={() => onChange([...channels, createChannel(channels)])}>添加通道</button></div>
    {channels.length === 0 ? <p className="wave-menu-empty">添加名称后，匹配的 RX 数值会绘制为波形。</p> : <div className="channel-editor-list">{channels.map((channel) => <ChannelEditorRow key={channel.id} channel={channel} latestValue={latestValues.get(channel.id)} onChange={onChange} channels={channels} />)}</div>}
  </div>;
}

function ChannelEditorRow({ channel, channels, latestValue, onChange }: { channel: WaveChannel; channels: WaveChannel[]; latestValue?: number; onChange: (channels: WaveChannel[]) => void }) {
  const update = (change: Partial<WaveChannel>) => onChange(channels.map((item) => item.id === channel.id ? { ...item, ...change } : item));
  return <div className={"channel-editor-row " + (channel.enabled ? "" : "disabled")}>
    <label className="channel-enabled" title={channel.enabled ? "停止采集此通道" : "开始采集此通道"}><input type="checkbox" checked={channel.enabled} onChange={(event) => update({ enabled: event.target.checked })} aria-label={channel.name + "启用状态"} /></label>
    <input className="channel-color" type="color" value={channel.color} onChange={(event) => update({ color: event.target.value })} aria-label={channel.name + "线条颜色"} />
    <input className="channel-name" type="text" value={channel.name} maxLength={24} onChange={(event) => update({ name: event.target.value })} aria-label="通道名称" placeholder="通道名称" />
    <strong className="channel-latest">{latestValue === undefined ? "--" : formatWaveValue(latestValue)}</strong>
    <button type="button" className="channel-remove" title="删除通道" aria-label="删除通道" onClick={() => onChange(channels.filter((item) => item.id !== channel.id))}><Icon name="trash" size={14} /></button>
  </div>;
}

function SettingsMenu({ settings, onChange }: { settings: WaveformSettings; onChange: Dispatch<SetStateAction<WaveformSettings>> }) {
  return <div className="wave-popover settings-menu" role="dialog" aria-label="波形显示设置">
    <strong>显示设置</strong>
    <span className="wave-menu-label">每通道样本</span>
    <div className="wave-option-group">{[120, 240, 500].map((count) => <button type="button" key={count} className={settings.samplesPerChannel === count ? "selected" : ""} onClick={() => onChange((current) => ({ ...current, samplesPerChannel: count }))}>{count}</button>)}</div>
    <button type="button" className={"wave-toggle-option " + (settings.showLatestMarker ? "selected" : "")} aria-pressed={settings.showLatestMarker} onClick={() => onChange((current) => ({ ...current, showLatestMarker: !current.showLatestMarker }))}>显示最新点</button>
  </div>;
}

function WaveMetadata({ channelCount, chart, sampleCount }: { channelCount: number; chart: ReturnType<typeof buildWaveChart>; sampleCount: number }) {
  return <div className="wave-meta"><span>通道 <strong>{channelCount}</strong></span><span>样本 {sampleCount}</span><span>范围 {chart.minLabel} - {chart.maxLabel}</span></div>;
}

function WaveLegend({ chart }: { chart: ReturnType<typeof buildWaveChart> }) {
  if (chart.series.length === 0) return null;
  return <div className="wave-legend" aria-label="波形通道图例">
    {chart.series.map((series) => <span className="wave-legend-item" key={series.channel.id}><i style={{ backgroundColor: series.channel.color }} />{series.channel.name}</span>)}
  </div>;
}

function useVisibleSamples(samples: WaveSample[], channels: WaveChannel[], samplesPerChannel: number): WaveSample[] {
  return useMemo(() => {
    const enabledIds = new Set(channels.filter((channel) => channel.enabled).map((channel) => channel.id));
    return limitSamplesPerChannel(samples.filter((sample) => enabledIds.has(sample.channelId)), samplesPerChannel);
  }, [channels, samples, samplesPerChannel]);
}

function useMeasuredViewport(plot: RefObject<HTMLDivElement>, samplesPerChannel: number, channelCount: number) {
  const [viewport, setViewport] = useState({ width: 900, height: 500, contentWidth: 1000, contentHeight: 560 });
  useEffect(() => {
    const element = plot.current;
    if (!element) return;
    const update = () => setViewportFromElement(element, setViewport, samplesPerChannel, channelCount);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [plot, samplesPerChannel, channelCount]);
  return viewport;
}

function setViewportFromElement(element: HTMLDivElement, setViewport: Dispatch<SetStateAction<{ width: number; height: number; contentWidth: number; contentHeight: number }>>, samplesPerChannel: number, channelCount: number) {
  const bounds = element.getBoundingClientRect();
  const width = Math.max(1, Math.round(bounds.width) - WAVE_AXIS_WIDTH);
  const height = Math.max(1, Math.round(bounds.height) - WAVE_TOOLBAR_HEIGHT);
  // Samples from separate channels share one arrival timeline; they must not widen it repeatedly.
  const contentWidth = Math.max(width, 900, samplesPerChannel * 4 + 120);
  const contentHeight = Math.max(height, 560, channelCount * 70 + 420);
  const next = { width, height, contentWidth, contentHeight };
  setViewport((current) => current.width === next.width && current.height === next.height && current.contentWidth === next.contentWidth && current.contentHeight === next.contentHeight ? current : next);
}

function clampPan(pan: { x: number; y: number }, bounds: { x: number; y: number }) {
  return { x: Math.min(0, Math.max(-bounds.x, pan.x)), y: Math.min(0, Math.max(-bounds.y, pan.y)) };
}

function useDismissableMenu(root: RefObject<HTMLDivElement>, openMenu: OpenMenu, dismiss: () => void) {
  useEffect(() => {
    if (!openMenu) return;
    const dismissWhenOutside = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) dismiss();
    };
    const dismissOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") dismiss();
    };
    document.addEventListener("mousedown", dismissWhenOutside);
    document.addEventListener("keydown", dismissOnEscape);
    return () => {
      document.removeEventListener("mousedown", dismissWhenOutside);
      document.removeEventListener("keydown", dismissOnEscape);
    };
  }, [dismiss, openMenu, root]);
}

function createChannel(channels: WaveChannel[]): WaveChannel {
  const color = CHANNEL_COLORS[channels.length % CHANNEL_COLORS.length];
  return { id: crypto.randomUUID(), name: "X" + (channels.length + 1), color, enabled: true };
}

function getLatestValues(samples: WaveSample[]): Map<string, number> {
  const latest = new Map<string, number>();
  for (const sample of samples) latest.set(sample.channelId, sample.value);
  return latest;
}

function getEmptyMessage(connected: boolean, channels: WaveChannel[]): string {
  if (!connected) return "打开端口后开始采集";
  if (channels.length === 0) return "请先在通道配置中添加通道";
  if (!channels.some((channel) => channel.enabled)) return "请启用至少一个通道";
  return "等待名称匹配的 RX 数值帧";
}

function toggleMenu(menu: Exclude<OpenMenu, undefined>, setOpenMenu: Dispatch<SetStateAction<OpenMenu>>) {
  setOpenMenu((current) => current === menu ? undefined : menu);
}
