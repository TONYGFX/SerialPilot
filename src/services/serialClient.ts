/**
 * Tauri command bridge for the frontend serial workflow.
 * All UI operations use this module so the Rust core remains the only hardware owner.
 */

import { invoke } from "@tauri-apps/api/core";

/**
 * Executes one structured serial command through the Rust command dispatcher.
 *
 * @param command Command payload matching Rust's SerialCommand enum.
 * @returns The typed command result emitted by the serial core.
 * @throws Rejects when the core rejects the command or the Tauri bridge is unavailable.
 */
export async function executeSerialCommand<Result>(command: unknown): Promise<Result> {
  return invoke<Result>("execute_serial", { command });
}
