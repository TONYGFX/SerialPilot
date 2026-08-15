/**
 * Captures named waveform values and builds multi-channel chart geometry.
 * Parsing is deliberately independent of React and Tauri, so channel rules
 * remain deterministic and testable without changing raw serial data.
 */

import type { SerialFrame } from "../types/serial";
import type { WaveChannel, WaveSample } from "../types/waveform";

export type ChartViewport = {
  width: number;
  height: number;
  timeRange?: { originMs: number; startMs: number; endMs: number };
};

export type ChartPoint = { x: number; y: number; sample: WaveSample };

export type WaveChartSeries = {
  channel: WaveChannel;
  path: string;
  points: ChartPoint[];
  lastPoint?: ChartPoint;
};

export type WaveChart = {
  viewportWidth: number;
  viewportHeight: number;
  left: number;
  top: number;
  right: number;
  bottom: number;
  plotWidth: number;
  plotHeight: number;
  labelBaseline: number;
  minLabel: string;
  maxLabel: string;
  timeRange: { originMs: number; startMs: number; endMs: number };
  series: WaveChartSeries[];
  horizontalGrid: Array<{ y: number; label: string }>;
  verticalGrid: Array<{ x: number; label: string }>;
};

const NUMERIC_VALUE = /^[+-]?(?:\d+\.?\d*|\.\d+)$/;
const LATEST_POINT_CLEARANCE = 16;
const FOOTER_SAFE_HEIGHT = 64;

/**
 * Captures named values from one decoded RX frame.
 *
 * @param frame Immutable RX frame emitted by the serial core.
 * @param channels User-defined names and display rules.
 * @returns Samples for enabled channels with matching numeric values.
 */
export function parseConfiguredFrame(frame: SerialFrame, channels: WaveChannel[], decodedText = frame.text_utf8): WaveSample[] {
  if (frame.direction !== "rx" || !decodedText || !decodedText.endsWith("\r\n")) return [];
  const values = parseNamedValues(decodedText);
  if (!values) return [];
  return channels.flatMap((channel) => {
    if (!channel.enabled) return [];
    const value = values.get(channel.name);
    if (value === undefined) return [];
    return [{ channelId: channel.id, cursor: frame.cursor, timestampMs: frame.timestamp_ms, value }];
  });
}

/**
 * Retains a bounded tail for every channel so one noisy source cannot evict another.
 *
 * @param samples Samples in arrival order.
 * @param maximumPerChannel Maximum samples retained for each configured channel.
 * @returns Source-ordered sample history within the requested bounds.
 */
export function limitSamplesPerChannel(samples: WaveSample[], maximumPerChannel: number): WaveSample[] {
  const remaining = new Map<string, number>();
  const retained: WaveSample[] = [];
  for (const sample of [...samples].reverse()) {
    const count = remaining.get(sample.channelId) ?? 0;
    if (count >= maximumPerChannel) continue;
    remaining.set(sample.channelId, count + 1);
    retained.push(sample);
  }
  return retained.reverse();
}

/**
 * Builds shared-axis SVG geometry for configured and visible channels.
 *
 * @param samples Visible samples in arrival order.
 * @param channels Enabled channel configurations.
 * @param viewport Measured CSS-pixel dimensions of the plot surface.
 * @returns Axes plus one SVG path for each configured channel with samples.
 */
export function buildWaveChart(samples: WaveSample[], channels: WaveChannel[], viewport: ChartViewport): WaveChart {
  const geometry = createChartGeometry(viewport);
  const range = getValueRange(samples);
  const timeRange = getTimeRange(samples, viewport.timeRange);
  const series = channels
    .filter((channel) => channel.enabled)
    .map((channel) => createChartSeries(samples.filter((sample) => sample.channelId === channel.id), channel, range.min, range.max, timeRange, geometry))
    .filter((series) => series.path);

  return {
    ...geometry,
    minLabel: formatWaveValue(range.min),
    maxLabel: formatWaveValue(range.max),
    timeRange,
    series,
    horizontalGrid: createHorizontalGrid(range.min, range.max, geometry),
    verticalGrid: createVerticalGrid(timeRange, geometry),
  };
}

/** Formats one axis value without adding unnecessary decimal digits. */
export function formatWaveValue(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function parseNamedValues(text: string): Map<string, number> | undefined {
  const values = new Map<string, number>();
  const fields = text.trim().split(",");
  for (const field of fields) {
    if (!field) continue;
    const [name, valueText] = field.split("=", 2);
    if (!name || !valueText || !NUMERIC_VALUE.test(valueText)) continue;
    values.set(name, Number(valueText));
  }
  return values.size > 0 ? values : undefined;
}

function getValueRange(samples: WaveSample[]): { min: number; max: number } {
  const values = samples.map((sample) => sample.value);
  const rawMin = values.length > 0 ? Math.min(...values) : 0;
  const rawMax = values.length > 0 ? Math.max(...values) : 200;
  const span = Math.max(rawMax - rawMin, 10);
  return { min: rawMin - span * 0.16, max: rawMax + span * 0.16 };
}

function getTimeRange(samples: WaveSample[], requested?: ChartViewport["timeRange"]): { originMs: number; startMs: number; endMs: number } {
  if (requested) return requested;
  const first = samples[0]?.timestampMs ?? 0;
  const last = samples.at(-1)?.timestampMs ?? first + 1;
  return { originMs: first, startMs: first, endMs: Math.max(first + 1, last) };
}

function createChartGeometry(viewport: ChartViewport): Omit<WaveChart, "minLabel" | "maxLabel" | "timeRange" | "series" | "horizontalGrid" | "verticalGrid"> {
  const left = Math.max(46, Math.round(viewport.width * 0.045));
  const top = Math.max(12, Math.round(viewport.height * 0.02));
  // Keep the latest-point marker and its stroke inside the SVG viewport.
  const right = viewport.width - Math.max(LATEST_POINT_CLEARANCE, Math.round(viewport.width * 0.012));
  // Reserve a dedicated band for time labels and the overlay footer.
  const bottom = viewport.height - Math.max(FOOTER_SAFE_HEIGHT, Math.round(viewport.height * 0.06));
  return {
    viewportWidth: viewport.width,
    viewportHeight: viewport.height,
    left,
    top,
    right,
    bottom,
    plotWidth: Math.max(1, right - left),
    plotHeight: Math.max(1, bottom - top),
    labelBaseline: bottom + 17,
  };
}

function createChartSeries(samples: WaveSample[], channel: WaveChannel, min: number, max: number, timeRange: { startMs: number; endMs: number }, geometry: Pick<WaveChart, "left" | "top" | "plotWidth" | "plotHeight">): WaveChartSeries {
  const points = samples.filter((sample) => sample.timestampMs >= timeRange.startMs && sample.timestampMs <= timeRange.endMs).map((sample) => sampleToPoint(sample, min, max, timeRange, geometry));
  return {
    channel,
    points,
    path: points.map((point, index) => (index === 0 ? "M" : "L") + point.x.toFixed(2) + "," + point.y.toFixed(2)).join(" "),
    lastPoint: points.at(-1),
  };
}

function sampleToPoint(sample: WaveSample, min: number, max: number, timeRange: { startMs: number; endMs: number }, geometry: Pick<WaveChart, "left" | "top" | "plotWidth" | "plotHeight">): ChartPoint {
  const timeSpan = timeRange.endMs - timeRange.startMs;
  const progress = timeSpan > 0 ? (sample.timestampMs - timeRange.startMs) / timeSpan : 0;
  return {
    sample,
    x: geometry.left + progress * geometry.plotWidth,
    y: geometry.top + (max - sample.value) / (max - min) * geometry.plotHeight,
  };
}

function createHorizontalGrid(min: number, max: number, geometry: Pick<WaveChart, "top" | "plotHeight">): Array<{ y: number; label: string }> {
  return Array.from({ length: 6 }, (_, index) => {
    const ratio = index / 5;
    return { y: geometry.top + ratio * geometry.plotHeight, label: formatWaveValue(max - ratio * (max - min)) };
  });
}

function createVerticalGrid(timeRange: { originMs: number; startMs: number; endMs: number }, geometry: Pick<WaveChart, "left" | "plotWidth">): Array<{ x: number; label: string }> {
  const divisions = 8;
  return Array.from({ length: divisions + 1 }, (_, index) => {
    const ratio = index / divisions;
    const timestampMs = timeRange.startMs + ratio * (timeRange.endMs - timeRange.startMs);
    return { x: geometry.left + ratio * geometry.plotWidth, label: formatElapsedTime(timestampMs - timeRange.originMs) };
  });
}

/** Formats elapsed monitoring time for the X axis and point inspection. */
export function formatElapsedTime(milliseconds: number): string {
  if (milliseconds < 1000) return `${Math.max(0, Math.round(milliseconds))} ms`;
  if (milliseconds < 60_000) return `${(milliseconds / 1000).toFixed(milliseconds < 10_000 ? 1 : 0)} s`;
  return `${Math.floor(milliseconds / 60_000)}:${String(Math.floor(milliseconds / 1000) % 60).padStart(2, "0")}`;
}
