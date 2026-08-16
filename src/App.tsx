/**
 * Top-level desktop workspace composition.
 * This module selects the active view and theme while serial state remains in
 * useSerialSession and visual controls remain in dedicated components.
 */

import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import { downloadDir } from "@tauri-apps/api/path";
import { APP_VERSION } from "./appInfo";
import { Icon } from "./components/Icon";
import { McpDialog, type SettingsPage } from "./components/McpDialog";
import { ResizableDivider } from "./components/ResizableDivider";
import { SettingsPanel } from "./components/SettingsPanel";
import { TerminalPanel } from "./components/TerminalPanel";
import { WaveformPanel } from "./components/WaveformPanel";
import { useSerialSession } from "./hooks/useSerialSession";
import { configureMcpHttp } from "./services/serialClient";
import { checkForUpdate, type UpdateCheckStatus } from "./services/updateChecker";
import { DEFAULT_APPLICATION_PREFERENCES, type ApplicationPreferences, type McpHttpStatus, type SendShortcut, type TextCharset, type Theme } from "./types/settings";

type WorkspaceView = "terminal" | "waveform";
const PREFERENCES_STORAGE_KEY = "serialpilot-preferences";
const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Renders SerialPilot's desktop workbench. */
export function App() {
  const [view, setView] = useState<WorkspaceView>("terminal");
  const [settingsWidth, setSettingsWidth] = useState(260);
  const [preferences, setPreferences] = useState<ApplicationPreferences>(readPreferences);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsPage, setSettingsPage] = useState<SettingsPage>("general");
  const [mcpStatus, setMcpStatus] = useState<McpHttpStatus>({ enabled: false });
  const [updateStatus, setUpdateStatus] = useState<UpdateCheckStatus>({ state: "idle" });
  const resolvedTheme = useResolvedTheme(preferences.theme);
  const serial = useSerialSession(preferences.textCharset);
  const activity = useMemo(() => serial.frames.map((frame) => ({ ...frame, local: new Date(frame.timestamp_ms).toLocaleTimeString() })), [serial.frames]);
  const sessionLabel = serial.status.connected ? `已连接 · ${serial.status.session_id?.slice(0, 8)}` : "未连接";
  const canSend = Boolean(serial.status.connected && serial.status.session_id && serial.payload.trim() && !serial.fileTransferActive);

  useEffect(() => { window.localStorage.setItem(PREFERENCES_STORAGE_KEY, JSON.stringify(preferences)); }, [preferences]);
  useEffect(() => {
    if (preferences.receiveDirectory) return;
    void downloadDir().then((directory) => {
      setPreferences((current) => current.receiveDirectory ? current : { ...current, receiveDirectory: directory });
    }).catch(() => undefined);
  }, [preferences.receiveDirectory]);
  const checkAppUpdate = useCallback(async () => {
    setUpdateStatus({ state: "checking" });
    try {
      const result = await checkForUpdate(APP_VERSION);
      setUpdateStatus(result.available ? { state: "available", release: result.release } : { state: "up-to-date", release: result.release });
      const checkedAt = new Date().toISOString();
      setPreferences((current) => ({ ...current, updates: { ...current.updates, lastCheckedAt: checkedAt } }));
    } catch {
      setUpdateStatus({ state: "failed" });
    }
  }, []);
  useEffect(() => {
    if (!preferences.updates.autoCheck || !shouldCheckForUpdate(preferences.updates.lastCheckedAt)) return;
    const timer = window.setTimeout(() => void checkAppUpdate(), 1800);
    return () => window.clearTimeout(timer);
  }, [checkAppUpdate, preferences.updates.autoCheck, preferences.updates.lastCheckedAt]);
  useEffect(() => {
    if (!preferences.mcpHttp.enabled) return;
    void configureMcpHttp(preferences.mcpHttp).then(setMcpStatus).catch(() => undefined);
  }, []);
  const applyMcp = async () => {
    const status = await configureMcpHttp(preferences.mcpHttp);
    setMcpStatus(status);
  };

  return <main className="app-shell" data-theme={resolvedTheme}>
    <header>
      <div><p className="eyebrow">AI SERIAL CONSOLE</p><h1>SerialPilot</h1></div>
      <nav className="view-tabs" aria-label="工作区视图"><button type="button" className={view === "terminal" ? "selected" : ""} aria-selected={view === "terminal"} onClick={() => setView("terminal")}>终端</button><button type="button" className={view === "waveform" ? "selected" : ""} aria-selected={view === "waveform"} onClick={() => setView("waveform")}>波形</button></nav>
      <div className="header-status"><button type="button" className={`mcp-status ${mcpStatus.enabled ? "online" : "offline"}`} title={mcpStatus.enabled ? "MCP 服务运行中，打开 MCP 设置" : "MCP 服务未运行，打开 MCP 设置"} aria-label="打开 MCP 设置" onClick={() => { setSettingsPage("mcp"); setSettingsOpen(true); }}><i />MCP</button><div className={`connection ${serial.status.connected ? "online" : "offline"}`}><i />{sessionLabel}</div><button type="button" className={`settings-button ${updateStatus.state === "available" ? "update-available" : ""}`} title={updateStatus.state === "available" ? `发现 v${updateStatus.release.version}，打开更新设置` : "打开应用设置"} aria-label="打开应用设置" onClick={() => { setSettingsPage(updateStatus.state === "available" ? "about" : "general"); setSettingsOpen(true); }}><Icon name="settings" /></button></div>
    </header>
    {serial.error && <div className="error" role="alert">{serial.error}</div>}
    <div className="workspace" style={{ "--settings-width": `${settingsWidth}px` } as CSSProperties}>
      <SettingsPanel config={serial.config} ports={serial.ports} connected={serial.status.connected} autoReconnect={serial.autoReconnect} timedSend={serial.timedSend} timerSeconds={serial.timerSeconds} transferActive={serial.fileTransferActive} filePath={serial.filePath} fileProtocol={serial.fileProtocol} fileProgress={serial.fileProgress} fileReceiveProgress={serial.fileReceiveProgress} receiveDirectory={preferences.receiveDirectory} onChange={serial.setConfig} onOpen={serial.open} onClose={serial.close} onRefreshPorts={serial.refreshPorts} onAutoReconnect={serial.setAutoReconnect} onTimedSend={serial.setTimedSend} onTimerSeconds={serial.setTimerSeconds} onFilePath={(path) => { serial.setFilePath(path); serial.setPayload(path); serial.setEncoding("text"); }} onFileProtocol={serial.setFileProtocol} onCancelFileSend={serial.cancelFileSend} onDismissFileSend={serial.dismissFileSend} onReceiveFile={serial.receiveFile} onCancelFileReceive={serial.cancelFileReceive} onDismissFileReceive={serial.dismissFileReceive} onOpenReceivedFile={serial.openReceivedFile} />
      <ResizableDivider orientation="vertical" value={settingsWidth} min={220} max={460} onChange={setSettingsWidth} label="调整串口配置栏宽度" />
      <div className="workspace-main">
        {view === "terminal" ? <TerminalPanel activity={activity} status={serial.status} paused={serial.paused} textCharset={preferences.textCharset} sendShortcut={preferences.keyboard.sendShortcut} encoding={serial.encoding} payload={serial.payload} canSend={canSend} fileTransferActive={serial.fileTransferActive} onPause={serial.togglePaused} onClear={serial.clearFrames} onSave={serial.saveFrames} onEncoding={serial.setEncoding} onPayload={(value) => { serial.setPayload(value); if (value !== serial.filePath) serial.setFilePath(""); }} onSend={serial.send} /> : <WaveformPanel samples={serial.waveSamples} channels={serial.waveChannels} connected={serial.status.connected} paused={serial.waveformPaused} onPause={serial.toggleWaveformPaused} onClear={serial.clearWaveform} onChannelsChange={serial.setWaveChannels} />}
      </div>
    </div>
    {settingsOpen && <McpDialog initialPage={settingsPage} theme={preferences.theme} textCharset={preferences.textCharset} sendShortcut={preferences.keyboard.sendShortcut} receiveDirectory={preferences.receiveDirectory} autoUpdateCheck={preferences.updates.autoCheck} updateStatus={updateStatus} onThemeChange={(theme) => setPreferences((current) => ({ ...current, theme }))} onTextCharsetChange={(textCharset) => setPreferences((current) => ({ ...current, textCharset }))} onSendShortcutChange={(sendShortcut) => setPreferences((current) => ({ ...current, keyboard: { ...current.keyboard, sendShortcut } }))} onReceiveDirectoryChange={(receiveDirectory) => setPreferences((current) => ({ ...current, receiveDirectory }))} onAutoUpdateCheckChange={(autoCheck) => setPreferences((current) => ({ ...current, updates: { ...current.updates, autoCheck } }))} onCheckForUpdate={() => void checkAppUpdate()} preferences={preferences.mcpHttp} runtimeStatus={mcpStatus} onChange={(mcpHttp) => setPreferences((current) => ({ ...current, mcpHttp }))} onApply={applyMcp} onClose={() => setSettingsOpen(false)} />}
  </main>;
}

function readPreferences(): ApplicationPreferences {
  try {
    const saved = window.localStorage.getItem(PREFERENCES_STORAGE_KEY);
    if (!saved) {
      return {
        ...DEFAULT_APPLICATION_PREFERENCES,
        theme: window.localStorage.getItem("serialpilot-theme") === "light" ? "light" : "dark",
      };
    }
    const candidate = JSON.parse(saved) as Partial<ApplicationPreferences>;
    const theme: Theme = candidate.theme === "light" || candidate.theme === "dark" || candidate.theme === "system" ? candidate.theme : "system";
    const port = candidate.mcpHttp?.port;
    const textCharset: TextCharset = candidate.textCharset === "gbk" || candidate.textCharset === "ascii" || candidate.textCharset === "utf-16le" || candidate.textCharset === "utf-8" ? candidate.textCharset : "utf-8";
    const sendShortcut: SendShortcut = candidate.keyboard?.sendShortcut === "enter" || candidate.keyboard?.sendShortcut === "ctrl-enter" ? candidate.keyboard.sendShortcut : "ctrl-enter";
    const receiveDirectory = typeof candidate.receiveDirectory === "string" ? candidate.receiveDirectory : "";
    return {
      theme,
      textCharset,
      keyboard: { sendShortcut },
      receiveDirectory,
      mcpHttp: {
        enabled: candidate.mcpHttp?.enabled === true,
        port: typeof port === "number" && Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : 3030,
      },
      updates: {
        autoCheck: candidate.updates?.autoCheck !== false,
        lastCheckedAt: isValidTimestamp(candidate.updates?.lastCheckedAt) ? candidate.updates?.lastCheckedAt : undefined,
      },
    };
  } catch {
    return DEFAULT_APPLICATION_PREFERENCES;
  }
}

function shouldCheckForUpdate(lastCheckedAt?: string): boolean {
  if (!lastCheckedAt) return true;
  const lastCheckedTime = Date.parse(lastCheckedAt);
  return Number.isNaN(lastCheckedTime) || Date.now() - lastCheckedTime >= UPDATE_CHECK_INTERVAL_MS;
}

function isValidTimestamp(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function useResolvedTheme(theme: Theme): "dark" | "light" {
  const [systemTheme, setSystemTheme] = useState<"dark" | "light">(() => window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");

  useEffect(() => {
    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const updateTheme = (event: MediaQueryListEvent) => setSystemTheme(event.matches ? "dark" : "light");
    mediaQuery.addEventListener("change", updateTheme);
    return () => mediaQuery.removeEventListener("change", updateTheme);
  }, []);

  return theme === "system" ? systemTheme : theme;
}
