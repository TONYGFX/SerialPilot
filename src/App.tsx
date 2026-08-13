/**
 * Top-level desktop workspace composition.
 * This module selects the active view and theme while serial state remains in
 * useSerialSession and visual controls remain in dedicated components.
 */

import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { Icon } from "./components/Icon";
import { McpDialog } from "./components/McpDialog";
import { ResizableDivider } from "./components/ResizableDivider";
import { SettingsPanel } from "./components/SettingsPanel";
import { TerminalPanel } from "./components/TerminalPanel";
import { WaveformPanel } from "./components/WaveformPanel";
import { useSerialSession } from "./hooks/useSerialSession";
import { configureMcpHttp, isDebugModeAvailable } from "./services/serialClient";
import { DEFAULT_APPLICATION_PREFERENCES, type ApplicationPreferences, type McpHttpStatus, type Theme } from "./types/settings";

type WorkspaceView = "terminal" | "waveform";
const PREFERENCES_STORAGE_KEY = "serialpilot-preferences";
const MOCK_PORT_PREFIX = "mock://";

/** Renders SerialPilot's desktop workbench. */
export function App() {
  const [view, setView] = useState<WorkspaceView>("terminal");
  const [settingsWidth, setSettingsWidth] = useState(260);
  const [preferences, setPreferences] = useState<ApplicationPreferences>(readPreferences);
  const [mcpOpen, setMcpOpen] = useState(false);
  const [mcpStatus, setMcpStatus] = useState<McpHttpStatus>({ enabled: false });
  const [debugMode, setDebugMode] = useState(false);
  const [debugAvailable, setDebugAvailable] = useState(false);
  const serial = useSerialSession();
  const visiblePorts = debugMode ? serial.ports : serial.ports.filter((port) => !port.id.startsWith(MOCK_PORT_PREFIX));
  const activity = useMemo(() => serial.frames.map((frame) => ({ ...frame, local: new Date(frame.timestamp_ms).toLocaleTimeString() })), [serial.frames]);
  const sessionLabel = serial.status.connected ? `已连接 · ${serial.status.session_id?.slice(0, 8)}` : "未连接";
  const canSend = Boolean(serial.status.connected && serial.status.session_id && serial.payload.trim());

  useEffect(() => { window.localStorage.setItem(PREFERENCES_STORAGE_KEY, JSON.stringify(preferences)); }, [preferences]);
  useEffect(() => {
    if (!preferences.mcpHttp.enabled) return;
    void configureMcpHttp(preferences.mcpHttp).then(setMcpStatus).catch(() => undefined);
  }, []);
  useEffect(() => {
    void isDebugModeAvailable().then(setDebugAvailable).catch(() => setDebugAvailable(false));
  }, []);
  const applyMcp = async () => {
    const status = await configureMcpHttp(preferences.mcpHttp);
    setMcpStatus(status);
  };

  return <main className="app-shell" data-theme={preferences.theme}>
    <header>
      <div><p className="eyebrow">AI SERIAL CONSOLE</p><h1>SerialPilot</h1></div>
      <nav className="view-tabs" aria-label="工作区视图"><button type="button" className={view === "terminal" ? "selected" : ""} aria-selected={view === "terminal"} onClick={() => setView("terminal")}>终端</button><button type="button" className={view === "waveform" ? "selected" : ""} aria-selected={view === "waveform"} onClick={() => setView("waveform")}>波形</button></nav>
      <div className="header-status"><button type="button" className="theme-toggle" title={preferences.theme === "dark" ? "切换到浅色主题" : "切换到深色主题"} aria-label={preferences.theme === "dark" ? "切换到浅色主题" : "切换到深色主题"} onClick={() => setPreferences((current) => ({ ...current, theme: current.theme === "dark" ? "light" : "dark" }))}><Icon name={preferences.theme === "dark" ? "sun" : "moon"} /></button><button type="button" className={`mcp-status ${mcpStatus.enabled ? "online" : "offline"}`} title="MCP 服务设置" aria-label="MCP 服务设置" aria-pressed={mcpStatus.enabled} onClick={() => setMcpOpen(true)}><i />MCP</button><div className={`connection ${serial.status.connected ? "online" : "offline"}`}><i />{sessionLabel}</div></div>
    </header>
    {serial.error && <div className="error" role="alert">{serial.error}</div>}
    <div className="workspace" style={{ "--settings-width": `${settingsWidth}px` } as CSSProperties}>
      <SettingsPanel config={serial.config} ports={visiblePorts} connected={serial.status.connected} debugAvailable={debugAvailable} debugEnabled={debugMode} autoReconnect={serial.autoReconnect} timedSend={serial.timedSend} timerSeconds={serial.timerSeconds} filePath={serial.filePath} fileProtocol={serial.fileProtocol} onChange={serial.setConfig} onOpen={serial.open} onClose={serial.close} onRefreshPorts={serial.refreshPorts} onDebugEnabled={(enabled) => { setDebugMode(enabled); if (!enabled && serial.config.port.startsWith(MOCK_PORT_PREFIX)) serial.setConfig({ ...serial.config, port: "" }); }} onAutoReconnect={serial.setAutoReconnect} onTimedSend={serial.setTimedSend} onTimerSeconds={serial.setTimerSeconds} onFilePath={(path) => { serial.setFilePath(path); serial.setPayload(path); serial.setEncoding("text"); }} onFileProtocol={serial.setFileProtocol} />
      <ResizableDivider orientation="vertical" value={settingsWidth} min={220} max={460} onChange={setSettingsWidth} label="调整串口配置栏宽度" />
      <div className="workspace-main">
        {view === "terminal" ? <TerminalPanel activity={activity} status={serial.status} paused={serial.paused} encoding={serial.encoding} payload={serial.payload} canSend={canSend} onPause={serial.togglePaused} onClear={serial.clearFrames} onSave={serial.saveFrames} onEncoding={serial.setEncoding} onPayload={(value) => { serial.setPayload(value); if (value !== serial.filePath) serial.setFilePath(""); }} onSend={serial.send} /> : <WaveformPanel samples={serial.waveSamples} channels={serial.waveChannels} connected={serial.status.connected} paused={serial.waveformPaused} onPause={serial.toggleWaveformPaused} onClear={serial.clearWaveform} onChannelsChange={serial.setWaveChannels} />}
      </div>
    </div>
    {mcpOpen && <McpDialog preferences={preferences.mcpHttp} runtimeStatus={mcpStatus} onChange={(mcpHttp) => setPreferences((current) => ({ ...current, mcpHttp }))} onApply={applyMcp} onClose={() => setMcpOpen(false)} />}
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
    const theme: Theme = candidate.theme === "light" ? "light" : "dark";
    const port = candidate.mcpHttp?.port;
    return {
      theme,
      mcpHttp: {
        enabled: candidate.mcpHttp?.enabled === true,
        port: typeof port === "number" && Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : 3030,
      },
    };
  } catch {
    return DEFAULT_APPLICATION_PREFERENCES;
  }
}
