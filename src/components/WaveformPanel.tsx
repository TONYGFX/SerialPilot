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
import { save } from "@tauri-apps/plugin-dialog";
import { Icon } from "./Icon";
import { saveTextFile } from "../services/serialClient";
import { buildWaveChart, formatElapsedTime, formatWaveValue, getWavePlotDimensions, type ChartPoint, type WaveChart } from "../lib/waveform";
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

const DEFAULT_SETTINGS: WaveformSettings = { showLatestMarker: true };

const CHANNEL_COLORS = ["#61d792", "#5fc7dd", "#e8ba61", "#df7aa4", "#a8a6ee", "#d9935d"];
const WAVE_AXIS_WIDTH = 58;
const WAVE_TOOLBAR_HEIGHT = 54;
const DEFAULT_TIME_SCALE_MS_PER_PIXEL = 12;
const MIN_TIME_SCALE_MS_PER_PIXEL = 0.5;
const MAX_TIME_SCALE_MS_PER_PIXEL = 864_000;
const DEFAULT_VALUE_CENTER = 0;
const DEFAULT_VALUE_UNITS_PER_PIXEL = 0.5;

/**
 * Draws configured channels using stable data-units-per-pixel viewports.
 *
 * @param props Channel configuration, serial-derived samples and user actions.
 * @returns The waveform workspace panel.
 */
export function WaveformPanel({ samples, channels, connected, paused, onPause, onClear, onChannelsChange }: WaveformPanelProps) {
  const plot = useRef<HTMLDivElement>(null);
  const toolbar = useRef<HTMLDivElement>(null);
  const [crosshair, setCrosshair] = useState<SharedCrosshair>();
  const [saveError, setSaveError] = useState<string>();
  const [settings, setSettings] = useState<WaveformSettings>(DEFAULT_SETTINGS);
  const [openMenu, setOpenMenu] = useState<OpenMenu>();
  const [dragging, setDragging] = useState(false);
  const [timeScaleMsPerPixel, setTimeScaleMsPerPixel] = useState(DEFAULT_TIME_SCALE_MS_PER_PIXEL);
  const [timeStartMs, setTimeStartMs] = useState<number>();
  const [followingLatest, setFollowingLatest] = useState(true);
  const [valueViewport, setValueViewport] = useState<WaveValueViewport>({ center: DEFAULT_VALUE_CENTER, unitsPerPixel: DEFAULT_VALUE_UNITS_PER_PIXEL, initialized: false });
  const drag = useRef<{ startX: number; startY: number; originX: number; originY: number }>();
  const firstTimestamp = samples[0]?.timestampMs;
  const latestTimestamp = samples.at(-1)?.timestampMs ?? firstTimestamp;
  const viewport = useMeasuredViewport(plot);
  const chartHeight = Math.max(1, viewport.height - WAVE_TOOLBAR_HEIGHT);
  const plotDimensions = useMemo(() => getWavePlotDimensions({ width: viewport.width, height: chartHeight }), [viewport.width, chartHeight]);
  const timeWindowMs = timeScaleMsPerPixel * plotDimensions.width;
  const valueRange = getVisibleValueRange(valueViewport, plotDimensions.height);
  // In follow mode, derive the window from the newest sample on every render;
  // this keeps incoming RX samples visible without waiting for another effect.
  const effectiveStart = followingLatest
    ? Math.max(firstTimestamp ?? 0, (latestTimestamp ?? 0) - timeWindowMs)
    : timeStartMs ?? Math.max(firstTimestamp ?? 0, (latestTimestamp ?? 0) - timeWindowMs);
  const chart = useMemo(() => buildWaveChart(samples, channels, { width: viewport.width, height: chartHeight, timeRange: { originMs: firstTimestamp ?? 0, startMs: effectiveStart, endMs: effectiveStart + timeWindowMs }, valueRange }), [samples, channels, viewport.width, chartHeight, firstTimestamp, effectiveStart, timeWindowMs, valueRange]);
  const latestValues = useMemo(() => getLatestValues(samples), [samples]);
  const latestTimestampForView = samples.at(-1)?.timestampMs;
  useFollowedValueRange(samples, followingLatest, plotDimensions.height, setValueViewport);
  const updateTimeStart = (next: number, windowMs = timeWindowMs) => {
    const minimumStart = firstTimestamp ?? next;
    const maximumStart = Math.max(minimumStart, (latestTimestampForView ?? next) - windowMs);
    setTimeStartMs(Math.min(maximumStart, Math.max(minimumStart, next)));
  };
  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    setFollowingLatest(false);
    setCrosshair(undefined);
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { startX: event.clientX, startY: event.clientY, originX: effectiveStart, originY: valueViewport.center };
    setDragging(true);
  };
  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const currentDrag = drag.current;
    if (!currentDrag) return;
    const elapsedDelta = -(event.clientX - currentDrag.startX) / chart.plotWidth * timeWindowMs;
    updateTimeStart(currentDrag.originX + elapsedDelta);
    const valueDelta = (event.clientY - currentDrag.startY) * valueViewport.unitsPerPixel;
    setValueViewport((current) => ({ ...current, center: currentDrag.originY + valueDelta }));
  };
  const handlePointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    drag.current = undefined;
    setDragging(false);
  };
  const handleWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    if (event.ctrlKey) {
      const zoomStep = event.deltaY < 0 ? 1.2 : 1 / 1.2;
      const nextScale = clampTimeScale(timeScaleMsPerPixel / zoomStep);
      const nextWindow = nextScale * chart.plotWidth;
      const bounds = event.currentTarget.getBoundingClientRect();
      const anchorRatio = clamp((event.clientX - bounds.left - chart.left) / chart.plotWidth, 0, 1);
      const anchorTime = effectiveStart + anchorRatio * timeWindowMs;
      setFollowingLatest(false);
      setTimeScaleMsPerPixel(nextScale);
      updateTimeStart(anchorTime - anchorRatio * nextWindow, nextWindow);
      return;
    }
    setFollowingLatest(false);
    const horizontalDelta = event.shiftKey ? event.deltaY : event.deltaX || event.deltaY;
    updateTimeStart(effectiveStart + horizontalDelta / chart.plotWidth * timeWindowMs);
  };
  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!event.ctrlKey || event.key !== "0") return;
    event.preventDefault();
    setTimeScaleMsPerPixel(DEFAULT_TIME_SCALE_MS_PER_PIXEL);
    setTimeStartMs(undefined);
    setFollowingLatest(false);
  };
  const jumpToLatest = () => {
    setFollowingLatest(true);
    setTimeStartMs(Math.max(firstTimestamp ?? 0, (latestTimestampForView ?? 0) - timeWindowMs));
  };
  const saveWaveform = () => { setSaveError(undefined); void saveWaveformData(samples, channels).catch((cause) => setSaveError(String(cause))); };

  useDismissableMenu(toolbar, openMenu, () => setOpenMenu(undefined));

  return <section className="waveform">
    <div className="wave-plot" ref={plot}>
      <div className="wave-surface">
        <div className="wave-axis" aria-hidden="true">
          <div className="wave-axis-content" style={{ width: WAVE_AXIS_WIDTH, height: chart.viewportHeight }}>
            <WaveYAxis chart={chart} />
          </div>
        </div>
        <div className={"wave-viewport " + (dragging ? "dragging" : "")} tabIndex={0} aria-label="波形绘图区，Ctrl 加滚轮缩放横轴，拖拽平移曲线" onKeyDown={handleKeyDown} onWheel={handleWheel} onPointerDown={handlePointerDown} onPointerMove={handlePointerMove} onPointerUp={handlePointerUp} onPointerCancel={handlePointerUp} onMouseLeave={() => setCrosshair(undefined)}>
          <div className="wave-pan-layer" style={{ width: chart.viewportWidth, height: chart.viewportHeight }}>
            <WaveSvg chart={chart} crosshair={crosshair} dragging={dragging} plot={plot} showLatestMarker={settings.showLatestMarker} onCrosshair={setCrosshair} onLeave={() => setCrosshair(undefined)} />
          </div>
        </div>
      </div>
      {crosshair && <WaveCrosshairTooltip crosshair={crosshair} />}
      {chart.series.length === 0 && <p className="wave-empty">{getEmptyMessage(connected, channels, paused)}</p>}
      <div className="wave-overlay" ref={toolbar}>
        <WaveToolbar
          channelCount={channels.length}
          connected={connected}
          openMenu={openMenu}
          paused={paused}
          onClear={onClear}
          onSave={saveWaveform}
          onJumpToLatest={jumpToLatest}
          onPause={onPause}
          onToggleMenu={setOpenMenu}
          followingLatest={followingLatest}
        />
        {openMenu === "channels" && <ChannelEditor channels={channels} latestValues={latestValues} onChange={onChannelsChange} />}
        {openMenu === "settings" && <SettingsMenu settings={settings} onChange={setSettings} />}
      </div>
      <WaveMetadata channelCount={chart.series.length} chart={chart} sampleCount={samples.length} />
      <WaveLegend chart={chart} />
      {saveError && <p className="wave-save-error" role="alert">保存失败：{saveError}</p>}
      <div className="wave-footer"><span>数据源：RX 名称=数值帧</span><span>时间比例 {formatElapsedTime(timeScaleMsPerPixel * 100)} / 100 px · 可视范围 {formatElapsedTime(timeWindowMs)}</span></div>
    </div>
  </section>;
}

type SharedCrosshair = {
  x: number;
  y: number;
  timestampMs: number;
  originMs: number;
  left: number;
  top: number;
  plotWidth: number;
  plotHeight: number;
  points: Array<{ point: ChartPoint; channel: WaveChannel }>;
};

type SharedCrosshairCandidate = Omit<SharedCrosshair, "originMs" | "left" | "top" | "plotWidth" | "plotHeight">;

function WaveYAxis({ chart }: { chart: ReturnType<typeof buildWaveChart> }) {
  return <svg className="wave-axis-svg" width={WAVE_AXIS_WIDTH} height={chart.viewportHeight} viewBox={`0 0 ${WAVE_AXIS_WIDTH} ${chart.viewportHeight}`} preserveAspectRatio="none">
    {chart.horizontalGrid.map((line, index) => <text key={"axis-" + index} x={WAVE_AXIS_WIDTH - 8} y={line.y + 4} className="wave-label" textAnchor="end">{line.label}</text>)}
  </svg>;
}

function WaveSvg({ chart, crosshair, dragging, plot, showLatestMarker, onCrosshair, onLeave }: { chart: WaveChart; crosshair?: SharedCrosshair; dragging: boolean; plot: RefObject<HTMLDivElement>; showLatestMarker: boolean; onCrosshair: (crosshair: SharedCrosshair) => void; onLeave: () => void }) {
  const viewBox = "0 0 " + chart.viewportWidth + " " + chart.viewportHeight;
  const handleMove = (event: ReactMouseEvent<SVGSVGElement>) => {
    if (dragging) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const x = (event.clientX - bounds.left) * chart.viewportWidth / bounds.width;
    const y = (event.clientY - bounds.top) * chart.viewportHeight / bounds.height;
    const candidate = findSharedCrosshair(chart, x, y);
    if (!candidate) return onLeave();
    const plotBounds = plot.current?.getBoundingClientRect();
    if (!plotBounds) return onLeave();
    onCrosshair({
      ...candidate,
      originMs: chart.timeRange.originMs,
      left: event.clientX - plotBounds.left,
      top: event.clientY - plotBounds.top,
      plotWidth: plotBounds.width,
      plotHeight: plotBounds.height,
    });
  };
  return <svg className="wave-svg" viewBox={viewBox} preserveAspectRatio="none" role="img" aria-label="配置通道的串口接收数据波形" onMouseMove={handleMove} onMouseLeave={onLeave}>
    <rect x={chart.left} y={chart.top} width={chart.plotWidth} height={chart.plotHeight} className="wave-frame" />
    {chart.horizontalGrid.map((line, index) => <line key={"h-" + index} x1={chart.left} y1={line.y} x2={chart.right} y2={line.y} className="wave-grid" />)}
    {chart.verticalGrid.map((grid, index) => <g key={"v-" + index}><line x1={grid.x} y1={chart.top} x2={grid.x} y2={chart.bottom} className="wave-grid" /><text x={grid.x} y={chart.labelBaseline} className="wave-label" textAnchor={index === 0 ? "start" : index === chart.verticalGrid.length - 1 ? "end" : "middle"}>{grid.label}</text></g>)}
    {chart.series.map((series) => <path key={series.channel.id} d={series.path} className="wave-line" style={{ stroke: series.channel.color }} />)}
    {showLatestMarker && chart.series.map((series) => series.lastPoint && <circle key={"point-" + series.channel.id} cx={series.lastPoint.x} cy={series.lastPoint.y} r="4.5" className="wave-point" style={{ fill: series.channel.color, stroke: series.channel.color }} />)}
    {crosshair && <SharedCrosshairOverlay crosshair={crosshair} chart={chart} />}
  </svg>;
}

function SharedCrosshairOverlay({ chart, crosshair }: { chart: WaveChart; crosshair: SharedCrosshair }) {
  return <g className="wave-crosshair" aria-hidden="true">
    <line className="wave-crosshair-line wave-crosshair-vertical" x1={crosshair.x} y1={chart.top} x2={crosshair.x} y2={chart.bottom} />
    <line className="wave-crosshair-line wave-crosshair-horizontal" x1={chart.left} y1={crosshair.y} x2={chart.right} y2={crosshair.y} />
    {crosshair.points.map(({ channel, point }) => <circle key={channel.id} className="wave-crosshair-marker" cx={point.x} cy={point.y} r="4.5" style={{ stroke: channel.color }} />)}
  </g>;
}

/** Finds the nearest common timestamp and its closest real sample per visible channel. */
export function findSharedCrosshair(chart: WaveChart, x: number, y: number): SharedCrosshairCandidate | undefined {
  if (x < chart.left || x > chart.right || y < chart.top || y > chart.bottom) return undefined;
  const anchors = chart.series.flatMap((series) => series.points.map((point) => ({ point, channel: series.channel })));
  if (anchors.length === 0) return undefined;
  const anchor = anchors.reduce((nearest, candidate) => Math.abs(candidate.point.x - x) < Math.abs(nearest.point.x - x) ? candidate : nearest);
  const points = chart.series.flatMap((series) => {
    const nearest = series.points.reduce<ChartPoint | undefined>((closest, point) => {
      if (!closest || Math.abs(point.sample.timestampMs - anchor.point.sample.timestampMs) < Math.abs(closest.sample.timestampMs - anchor.point.sample.timestampMs)) return point;
      return closest;
    }, undefined);
    return nearest ? [{ point: nearest, channel: series.channel }] : [];
  });
  return { x: anchor.point.x, y, timestampMs: anchor.point.sample.timestampMs, points };
}

function WaveCrosshairTooltip({ crosshair }: { crosshair: SharedCrosshair }) {
  const left = clampTooltipPosition(crosshair.left + 14, 12, crosshair.plotWidth - 190);
  const top = clampTooltipPosition(crosshair.top + 14, WAVE_TOOLBAR_HEIGHT + 8, crosshair.plotHeight - 120);
  return <div className="wave-hover wave-crosshair-tooltip" style={{ left, top }}>
    <strong>{formatElapsedTime(crosshair.timestampMs - crosshair.originMs)}</strong>
    {crosshair.points.map(({ channel, point }) => <span className="wave-hover-value" key={channel.id}><i style={{ backgroundColor: channel.color }} />{channel.name}<b>{formatWaveValue(point.sample.value)}</b></span>)}
  </div>;
}

function clampTooltipPosition(value: number, minimum: number, maximum: number) {
  return Math.max(minimum, Math.min(value, Math.max(minimum, maximum)));
}

export const waveformInteractionHelpers = { findSharedCrosshair };

function WaveToolbar({ channelCount, connected, followingLatest, openMenu, paused, onClear, onSave, onJumpToLatest, onPause, onToggleMenu }: {
  channelCount: number;
  connected: boolean;
  followingLatest: boolean;
  openMenu: OpenMenu;
  paused: boolean;
  onClear: () => void;
  onSave: () => void;
  onJumpToLatest: () => void;
  onPause: () => void;
  onToggleMenu: Dispatch<SetStateAction<OpenMenu>>;
}) {
  return <div className="wave-toolbar">
    <div><h2>波形监视器</h2><p>RX 名称=数值 · 手动通道配置</p></div>
    <div className="wave-actions">
      <button type="button" className={"wave-action " + (followingLatest ? "active" : "")} title="跳到最新数据并持续跟随" aria-label="跳到最新数据并持续跟随" aria-pressed={followingLatest} onClick={onJumpToLatest}><Icon name="arrowRight" /></button>
      <button type="button" className={"wave-action " + (openMenu === "channels" ? "active" : "")} title="配置波形通道" aria-label="配置波形通道" aria-expanded={openMenu === "channels"} onClick={() => toggleMenu("channels", onToggleMenu)}><Icon name="channels" /><b>{channelCount}</b></button>
      <button type="button" className={"wave-action " + (!paused ? "active" : "")} title={paused ? "开始波形监视" : "停止波形监视"} aria-label={paused ? "开始波形监视" : "停止波形监视"} aria-pressed={!paused} onClick={onPause}><Icon name={paused ? "play" : "pause"} /></button>
      <button type="button" className="wave-action" title="保存波形数据为 TXT" aria-label="保存波形数据为 TXT" onClick={onSave}><Icon name="download" /></button>
      <button type="button" className="wave-action" title="清空波形数据" aria-label="清空波形数据" onClick={onClear}><Icon name="trash" /></button>
      <button type="button" className={"wave-action " + (openMenu === "settings" ? "active" : "")} title="波形显示设置" aria-label="波形显示设置" aria-expanded={openMenu === "settings"} onClick={() => toggleMenu("settings", onToggleMenu)}><Icon name="settings" /></button>
      <span className={"wave-state " + (!paused && connected ? "online" : "")}>{paused ? "监视已停止" : connected ? "采集中" : "等待连接"}</span>
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

function useMeasuredViewport(plot: RefObject<HTMLDivElement>) {
  const [viewport, setViewport] = useState({ width: 900, height: 500 });
  useEffect(() => {
    const element = plot.current;
    if (!element) return;
    const update = () => setViewportFromElement(element, setViewport);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [plot]);
  return viewport;
}

function setViewportFromElement(element: HTMLDivElement, setViewport: Dispatch<SetStateAction<{ width: number; height: number }>>) {
  const bounds = element.getBoundingClientRect();
  const width = Math.max(1, Math.round(bounds.width) - WAVE_AXIS_WIDTH);
  const height = Math.max(1, Math.round(bounds.height));
  const next = { width, height };
  setViewport((current) => current.width === next.width && current.height === next.height ? current : next);
}

type WaveValueViewport = {
  center: number;
  unitsPerPixel: number;
  initialized: boolean;
};

function useFollowedValueRange(samples: WaveSample[], followingLatest: boolean, plotHeight: number, setValueViewport: Dispatch<SetStateAction<WaveValueViewport>>) {
  const lastSampleKey = useRef<string>();
  useEffect(() => {
    const latest = samples.at(-1);
    if (!latest) {
      lastSampleKey.current = undefined;
      return;
    }
    const sampleKey = `${latest.cursor}:${latest.timestampMs}`;
    if (!followingLatest || lastSampleKey.current === sampleKey) return;
    lastSampleKey.current = sampleKey;
    setValueViewport((current) => extendValueViewport(current, samples, plotHeight));
  }, [followingLatest, plotHeight, samples, setValueViewport]);
}

function getVisibleValueRange(viewport: WaveValueViewport, plotHeight: number) {
  const halfSpan = viewport.unitsPerPixel * Math.max(1, plotHeight) / 2;
  return { min: viewport.center - halfSpan, max: viewport.center + halfSpan };
}

function extendValueViewport(current: WaveValueViewport, samples: WaveSample[], plotHeight: number): WaveValueViewport {
  const sampleRange = getSampleValueRange(samples);
  if (!current.initialized) return createValueViewport(sampleRange, plotHeight);
  const visibleRange = getVisibleValueRange(current, plotHeight);
  if (sampleRange.min >= visibleRange.min && sampleRange.max <= visibleRange.max) return current;
  return createValueViewport({ min: Math.min(visibleRange.min, sampleRange.min), max: Math.max(visibleRange.max, sampleRange.max) }, plotHeight, current.unitsPerPixel);
}

function getSampleValueRange(samples: WaveSample[]) {
  const values = samples.map((sample) => sample.value);
  const min = values.length > 0 ? Math.min(...values) : DEFAULT_VALUE_CENTER - 100;
  const max = values.length > 0 ? Math.max(...values) : DEFAULT_VALUE_CENTER + 100;
  const span = Math.max(max - min, 10);
  return { min: min - span * 0.16, max: max + span * 0.16 };
}

function createValueViewport(range: { min: number; max: number }, plotHeight: number, minimumUnitsPerPixel = 0) {
  const span = Math.max(10, range.max - range.min);
  return {
    center: (range.min + range.max) / 2,
    unitsPerPixel: Math.max(minimumUnitsPerPixel, span / Math.max(1, plotHeight)),
    initialized: true,
  };
}

function clampTimeScale(millisecondsPerPixel: number) {
  return clamp(millisecondsPerPixel, MIN_TIME_SCALE_MS_PER_PIXEL, MAX_TIME_SCALE_MS_PER_PIXEL);
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.max(minimum, Math.min(value, maximum));
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

async function saveWaveformData(samples: WaveSample[], channels: WaveChannel[]) {
  const channelNames = new Map(channels.map((channel) => [channel.id, channel.name]));
  const originMs = samples[0]?.timestampMs ?? Date.now();
  const header = "relative_time_ms\tabsolute_time\tchannel\tvalue";
  const rows = samples.map((sample) => [sample.timestampMs - originMs, new Date(sample.timestampMs).toISOString(), channelNames.get(sample.channelId) ?? sample.channelId, formatWaveValue(sample.value)].join("\t"));
  const content = [header, ...rows].join("\n");
  const path = await save({ defaultPath: `SerialPilot_Waveform_${formatFileTimestamp(new Date())}.txt`, filters: [{ name: "文本文件", extensions: ["txt"] }] });
  if (path) await saveTextFile(path, content);
}

function formatFileTimestamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

export const waveformExportFormatters = { formatFileTimestamp };

function getEmptyMessage(connected: boolean, channels: WaveChannel[], paused: boolean): string {
  if (paused) return "点击开始按钮启动波形监视";
  if (!connected) return "打开端口后开始采集";
  if (channels.length === 0) return "请先在通道配置中添加通道";
  if (!channels.some((channel) => channel.enabled)) return "请启用至少一个通道";
  return "等待名称匹配的 RX 数值帧";
}

function toggleMenu(menu: Exclude<OpenMenu, undefined>, setOpenMenu: Dispatch<SetStateAction<OpenMenu>>) {
  setOpenMenu((current) => current === menu ? undefined : menu);
}
