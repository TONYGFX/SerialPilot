import { describe, expect, it } from "vitest";
import { terminalFormatters } from "./TerminalPanel";

describe("terminal HEX input formatter", () => {
  it("keeps only hex digits and groups bytes", () => {
    expect(terminalFormatters.formatHexInput("a1-b2 c3z")).toBe("A1 B2 C3");
    expect(terminalFormatters.formatHexInput("f")).toBe("F");
  });

  it("maps a byte caret position into the formatted value", () => {
    expect(terminalFormatters.positionAfterHexCount("AA BB CC", 2)).toBe(2);
  });
});
