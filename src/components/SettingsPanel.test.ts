import { describe, expect, it } from "vitest";
import { fileTransferFormatters } from "./SettingsPanel";

describe("file transfer formatter", () => {
  it("formats bytes for the transfer progress display", () => {
    expect(fileTransferFormatters.formatTransferBytes(768)).toBe("768 B");
    expect(fileTransferFormatters.formatTransferBytes(1536)).toBe("1.5 KB");
    expect(fileTransferFormatters.formatTransferBytes(2 * 1024 * 1024)).toBe("2.0 MB");
  });
});
