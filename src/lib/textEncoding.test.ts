import { describe, expect, it } from "vitest";
import { decodeSerialText } from "./textEncoding";

function base64(bytes: number[]): string {
  return btoa(String.fromCharCode(...bytes));
}

describe("serial text decoding", () => {
  it("decodes GBK Chinese without changing the source bytes", () => {
    expect(decodeSerialText(base64([0xd6, 0xd0, 0xce, 0xc4]), "gbk")).toBe("中文");
  });

  it("decodes UTF-16LE Chinese", () => {
    expect(decodeSerialText(base64([0x4b, 0x6d, 0xd5, 0x8b]), "utf-16le")).toBe("测试");
  });

  it("keeps ASCII payloads readable", () => {
    expect(decodeSerialText(base64([0x4f, 0x4b]), "ascii")).toBe("OK");
  });
});
