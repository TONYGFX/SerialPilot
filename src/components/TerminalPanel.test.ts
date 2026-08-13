import { describe, expect, it } from "vitest";
import { terminalFormatters } from "./TerminalPanel";

describe("terminal HEX formatter", () => {
  it("separates raw bytes with one space", () => {
    expect(terminalFormatters.formatHexBytes("AA55FF")).toBe("AA 55 FF");
    expect(terminalFormatters.formatHexBytes("AA  55\nFF")).toBe("AA 55 FF");
  });
});
