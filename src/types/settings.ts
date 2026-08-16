/**
 * Defines persisted application preferences rather than serial-session state.
 * These settings are local to the desktop application and do not modify a
 * connected device until the relevant runtime service is enabled.
 */

export type Theme = "dark" | "light" | "system";

/** Text charset used when the terminal is in text rather than HEX mode. */
export type TextCharset = "utf-8" | "gbk" | "ascii" | "utf-16le";

/** Configurable keyboard gesture used to submit terminal text and HEX payloads. */
export type SendShortcut = "ctrl-enter" | "enter";

export type KeyboardPreferences = {
  sendShortcut: SendShortcut;
};

export type McpHttpPreferences = {
  enabled: boolean;
  port: number;
};

export type McpHttpStatus = {
  enabled: boolean;
  endpoint?: string;
};

export type UpdatePreferences = {
  lastCheckedAt?: string;
};

export type ApplicationPreferences = {
  theme: Theme;
  textCharset: TextCharset;
  keyboard: KeyboardPreferences;
  receiveDirectory: string;
  mcpHttp: McpHttpPreferences;
  updates: UpdatePreferences;
};

export const DEFAULT_APPLICATION_PREFERENCES: ApplicationPreferences = {
  theme: "system",
  textCharset: "utf-8",
  keyboard: { sendShortcut: "ctrl-enter" },
  receiveDirectory: "",
  mcpHttp: { enabled: false, port: 3030 },
  updates: {},
};
