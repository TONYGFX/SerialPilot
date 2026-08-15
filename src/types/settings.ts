/**
 * Defines persisted application preferences rather than serial-session state.
 * These settings are local to the desktop application and do not modify a
 * connected device until the relevant runtime service is enabled.
 */

export type Theme = "dark" | "light" | "system";

/** Text charset used when the terminal is in text rather than HEX mode. */
export type TextCharset = "utf-8" | "gbk" | "ascii" | "utf-16le";

export type McpHttpPreferences = {
  enabled: boolean;
  port: number;
};

export type McpHttpStatus = {
  enabled: boolean;
  endpoint?: string;
};

export type ApplicationPreferences = {
  theme: Theme;
  textCharset: TextCharset;
  mcpHttp: McpHttpPreferences;
};

export const DEFAULT_APPLICATION_PREFERENCES: ApplicationPreferences = {
  theme: "system",
  textCharset: "utf-8",
  mcpHttp: { enabled: false, port: 3030 },
};
