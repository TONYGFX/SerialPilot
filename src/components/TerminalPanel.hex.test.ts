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

  it("shows bytes when decoded text contains no visible characters", () => {
    expect(terminalFormatters.formatFrameText("\u0001\u0003\u0000", "01 03 00")).toBe("01 03 00");
    expect(terminalFormatters.formatFrameText(undefined, "DE AD")).toBe("DE AD");
  });

  it("keeps printable serial text in text mode", () => {
    expect(terminalFormatters.formatFrameText("OK\n", "4F 4B 0A")).toBe("OK");
  });

  it("uses the configured shortcut without consuming text newlines", () => {
    const key = (keyName: string, options: Partial<KeyboardEvent> = {}) => ({ key: keyName, altKey: false, shiftKey: false, ctrlKey: false, metaKey: false, ...options }) as never;
    expect(terminalFormatters.shouldSubmitFromShortcut(key("Enter", { ctrlKey: true }), "ctrl-enter")).toBe(true);
    expect(terminalFormatters.shouldSubmitFromShortcut(key("Enter"), "ctrl-enter")).toBe(false);
    expect(terminalFormatters.shouldSubmitFromShortcut(key("Enter"), "enter")).toBe(true);
    expect(terminalFormatters.shouldSubmitFromShortcut(key("Enter", { shiftKey: true }), "enter")).toBe(false);
  });
});
