import { describe, expect, it } from "vitest";
import { waveformExportFormatters } from "./WaveformPanel";

describe("waveform export filename", () => {
  it("formats local date and time without filesystem-invalid characters", () => {
    expect(waveformExportFormatters.formatFileTimestamp(new Date(2026, 7, 13, 22, 15, 30))).toBe("20260813_221530");
  });
});
