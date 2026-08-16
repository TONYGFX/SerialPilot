/**
 * Verifies the UI-level serial ownership guard used by terminal send controls.
 * Persistent receive history must not be treated as an active file operation.
 */

import { describe, expect, it } from "vitest";
import { isFileTransferActive } from "./useSerialSession";
import type { FileReceiveProgress, FileSendProgress } from "../types/serial";

const sendProgress: FileSendProgress = {
  action_id: "send-1",
  file_path: "C:/test.bin",
  file_size: 100,
  sent_bytes: 50,
  chunk_size: 128,
  completed: false,
  cancelled: false,
  failed: false,
};

const receiveProgress: FileReceiveProgress = {
  action_id: "receive-1",
  file_path: "C:/received.bin",
  file_name: "received.bin",
  received_bytes: 100,
  chunk_size: 1024,
  waiting: false,
  completed: true,
  cancelled: false,
  failed: false,
};

describe("file transfer activity", () => {
  it("blocks terminal traffic while a send is starting or active", () => {
    expect(isFileTransferActive(undefined, [], true)).toBe(true);
    expect(isFileTransferActive(sendProgress, [], false)).toBe(true);
  });

  it("releases terminal traffic after terminal transfer states", () => {
    expect(isFileTransferActive({ ...sendProgress, completed: true }, [], false)).toBe(false);
    expect(isFileTransferActive(undefined, [receiveProgress], false)).toBe(false);
  });

  it("blocks terminal traffic while a receive task waits for the sender", () => {
    expect(isFileTransferActive(undefined, [{ ...receiveProgress, completed: false, waiting: true }], false)).toBe(true);
  });
});
