import { describe, expect, it } from "vitest";
import { terminalFormatters } from "./TerminalPanel";

describe("terminal HEX formatter", () => {
  it("separates raw bytes with one space", () => {
    expect(terminalFormatters.formatHexBytes("AA55FF")).toBe("AA 55 FF");
    expect(terminalFormatters.formatHexBytes("AA  55\nFF")).toBe("AA 55 FF");
  });

  it("filters RX and TX independently", () => {
    const frames = [
      { direction: "rx" },
      { direction: "tx" },
      { direction: "rx" },
    ] as never[];
    expect(terminalFormatters.filterFramesByDirection(frames, { rx: true, tx: true })).toHaveLength(3);
    expect(terminalFormatters.filterFramesByDirection(frames, { rx: true, tx: false })).toHaveLength(2);
    expect(terminalFormatters.filterFramesByDirection(frames, { rx: false, tx: true })).toHaveLength(1);
  });
});
