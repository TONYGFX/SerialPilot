/**
 * Tauri command bridge for the frontend serial workflow.
 * All UI operations use this module so the Rust core remains the only hardware owner.
 */

import { invoke } from "@tauri-apps/api/core";
import type { McpHttpPreferences, McpHttpStatus } from "../types/settings";

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

/**
 * Starts, restarts, or stops the loopback-only MCP HTTP service in the desktop process.
 *
 * @param config Persisted local MCP transport preferences.
 * @returns The live endpoint after the runtime operation finishes.
 * @throws Rejects when the configured port cannot be bound.
 */
export async function configureMcpHttp(config: McpHttpPreferences): Promise<McpHttpStatus> {
  return invoke<McpHttpStatus>("configure_mcp_http", { config });
}

/** Writes content to a path selected by the user through the native save dialog. */
export async function saveTextFile(path: string, content: string): Promise<void> {
  await invoke("save_text_file", { path, content });
}
