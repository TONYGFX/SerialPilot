/**
 * Covers named-value capture and chart geometry for configured channels.
 * These cases ensure SerialPilot never invents channel names or captures data
 * outside user-defined named-value rules.
 */

import { describe, expect, it } from "vitest";
import { buildWaveChart, formatElapsedTime, limitSamplesPerChannel, parseConfiguredFrame } from "./waveform";
import type { WaveChannel } from "../types/waveform";

const CHANNELS: WaveChannel[] = [
  { id: "x1", name: "X1", color: "#61d792", enabled: true },
  { id: "x2", name: "X2", color: "#5fc7dd", enabled: true },
  { id: "x3", name: "X3", color: "#e8ba61", enabled: false },
];

describe("parseConfiguredFrame", () => {
  it("captures only enabled case-sensitive named pairs", () => {
    expect(parseConfiguredFrame(createFrame("X1=12.4,X2=0.82,X3=26.5\r\n"), CHANNELS)).toEqual([
      { channelId: "x1", cursor: 9, timestampMs: 1000, value: 12.4 },
      { channelId: "x2", cursor: 9, timestampMs: 1000, value: 0.82 },
    ]);
  });

  it("ignores unknown names, wrong-case names and non-numeric values", () => {
    expect(parseConfiguredFrame(createFrame("x1=12,X2=bad,Unused=26.5"), CHANNELS)).toEqual([]);
    expect(parseConfiguredFrame(createFrame("X1=12,X2=bad,Unused=26.5\r\n"), CHANNELS)).toEqual([
      { channelId: "x1", cursor: 9, timestampMs: 1000, value: 12 },
    ]);
  });
});

describe("configured waveform retention and geometry", () => {
  it("formats elapsed time for the horizontal axis", () => {
    expect(formatElapsedTime(0)).toBe("0 ms");
    expect(formatElapsedTime(1250)).toBe("1.3 s");
    expect(formatElapsedTime(65_000)).toBe("1:05");
  });

  it("keeps the requested tail for every configured channel", () => {
    const samples = [
      { channelId: "x1", cursor: 1, timestampMs: 1, value: 10 },
      { channelId: "x2", cursor: 1, timestampMs: 1, value: 1 },
      { channelId: "x1", cursor: 2, timestampMs: 2, value: 11 },
      { channelId: "x1", cursor: 3, timestampMs: 3, value: 12 },
    ];

    expect(limitSamplesPerChannel(samples, 2)).toEqual([
      { channelId: "x2", cursor: 1, timestampMs: 1, value: 1 },
      { channelId: "x1", cursor: 2, timestampMs: 2, value: 11 },
      { channelId: "x1", cursor: 3, timestampMs: 3, value: 12 },
    ]);
  });

  it("creates chart paths only for enabled configured channels with samples", () => {
    const samples = parseConfiguredFrame(createFrame("X1=10,X2=20,X3=30\r\n"), CHANNELS).concat(parseConfiguredFrame({ ...createFrame("X1=12,X2=22,X3=32\r\n"), cursor: 10, timestamp_ms: 1010 }, CHANNELS));
    const chart = buildWaveChart(samples, CHANNELS, { width: 640, height: 360 });

    expect(chart.viewportWidth).toBe(640);
    expect(chart.series).toHaveLength(2);
    expect(chart.series[0].channel.name).toBe("X1");
    expect(chart.series[0].lastPoint?.x).toBe(chart.right);
    expect(chart.right).toBeLessThan(chart.viewportWidth - 5);
    expect(chart.labelBaseline).toBeGreaterThan(chart.bottom);
    expect(chart.labelBaseline).toBeLessThan(chart.viewportHeight - 28);
  });

  it("keeps existing samples usable when display channel settings change", () => {
    const samples = parseConfiguredFrame(createFrame("X1=10,X2=20\r\n"), CHANNELS);
    const renamedChannels = CHANNELS.map((channel) => channel.id === "x1" ? { ...channel, name: "Voltage" } : channel);
    const chart = buildWaveChart(samples, renamedChannels, { width: 640, height: 360 });

    expect(chart.series).toHaveLength(2);
    expect(chart.series[0].channel.name).toBe("Voltage");
    expect(chart.series[0].path).toContain("M");
  });
});

function createFrame(text: string) {
  return {
    cursor: 9,
    timestamp_ms: 1000,
    direction: "rx" as const,
    raw_hex: "",
    raw_base64: "",
    text_utf8: text,
  };
}
