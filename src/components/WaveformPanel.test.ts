import { describe, expect, it } from "vitest";
import { waveformExportFormatters, waveformInteractionHelpers } from "./WaveformPanel";
import { buildWaveChart, getWavePlotDimensions } from "../lib/waveform";
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

describe("stable waveform scale", () => {
  const channels: WaveChannel[] = [{ id: "x1", name: "X1", color: "#61d792", enabled: true }];
  const samples: WaveSample[] = [
    { channelId: "x1", cursor: 1, timestampMs: 0, value: 0 },
    { channelId: "x1", cursor: 2, timestampMs: 1_200, value: 10 },
  ];

  it("keeps elapsed-time pixels stable when the available width changes", () => {
    const narrow = createScaledChart(640, 360);
    const wide = createScaledChart(960, 360);

    expect(narrow.series[0].points[1].x - narrow.series[0].points[0].x).toBeCloseTo(100, 5);
    expect(wide.series[0].points[1].x - wide.series[0].points[0].x).toBeCloseTo(100, 5);
  });

  it("keeps value pixels stable when the available height changes", () => {
    const short = createScaledChart(640, 360);
    const tall = createScaledChart(640, 720);

    expect(Math.abs(short.series[0].points[1].y - short.series[0].points[0].y)).toBeCloseTo(20, 5);
    expect(Math.abs(tall.series[0].points[1].y - tall.series[0].points[0].y)).toBeCloseTo(20, 5);
  });

  function createScaledChart(width: number, height: number) {
    const dimensions = getWavePlotDimensions({ width, height });
    return buildWaveChart(samples, channels, {
      width,
      height,
      timeRange: { originMs: 0, startMs: 0, endMs: dimensions.width * 12 },
      valueRange: { min: -dimensions.height * 0.25, max: dimensions.height * 0.25 },
    });
  }
});
