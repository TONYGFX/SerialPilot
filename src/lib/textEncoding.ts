/**
 * Decodes immutable serial bytes for the desktop text view.
 * HEX remains the source of truth; changing a charset only reinterprets the
 * existing bytes and never alters the serial core's audit record.
 */

import type { TextCharset } from "../types/settings";

const DECODER_LABELS: Record<TextCharset, string> = {
  "utf-8": "utf-8",
  gbk: "gbk",
  ascii: "us-ascii",
  "utf-16le": "utf-16le",
};

/**
 * Decodes a base64 serial frame with the selected text charset.
 *
 * @param rawBase64 Original bytes emitted by the Rust serial core.
 * @param charset Charset selected in application settings.
 * @returns Replacement-character tolerant text suitable for terminal display.
 */
export function decodeSerialText(rawBase64: string, charset: TextCharset): string {
  try {
    return new TextDecoder(DECODER_LABELS[charset]).decode(base64ToBytes(rawBase64));
  } catch {
    return "";
  }
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
