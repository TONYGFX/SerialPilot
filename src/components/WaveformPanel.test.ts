import { describe, expect, it } from "vitest";
import { waveformExportFormatters, waveformInteractionHelpers } from "./WaveformPanel";
import { buildWaveChart } from "../lib/waveform";
import type { WaveChannel, WaveSample } from "../types/waveform";

describe("waveform export filename", () => {
  it("formats local date and time without filesystem-invalid characters", () => {
    expect(waveformExportFormatters.formatFileTimestamp(new Date(2026, 7, 13, 22, 15, 30))).toBe("20260813_221530");
  });
});

describe("shared waveform crosshair", () => {
  const channels: WaveChannel[] = [
    { id: "x1", name: "X1", color: "#61d792", enabled: true },
    { id: "x2", name: "X2", color: "#5fc7dd", enabled: true },
  ];
  const samples: WaveSample[] = [
    { channelId: "x1", cursor: 1, timestampMs: 1_000, value: 10 },
    { channelId: "x2", cursor: 1, timestampMs: 1_000, value: 20 },
    { channelId: "x1", cursor: 2, timestampMs: 2_000, value: 12 },
    { channelId: "x2", cursor: 2, timestampMs: 2_000, value: 24 },
  ];

  it("links the nearest timestamp across every visible channel", () => {
    const chart = buildWaveChart(samples, channels, { width: 640, height: 360 });
    const anchor = chart.series[0].points[1];
    const crosshair = waveformInteractionHelpers.findSharedCrosshair(chart, anchor.x, anchor.y);

    expect(crosshair?.timestampMs).toBe(2_000);
    expect(crosshair?.points).toHaveLength(2);
    expect(crosshair?.points.map(({ point }) => point.sample.value)).toEqual([12, 24]);
  });

  it("stays hidden when the pointer is outside the plot area", () => {
    const chart = buildWaveChart(samples, channels, { width: 640, height: 360 });

    expect(waveformInteractionHelpers.findSharedCrosshair(chart, chart.left - 1, chart.top)).toBeUndefined();
  });
});
