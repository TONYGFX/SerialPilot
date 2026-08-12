/**
 * Top-level desktop workspace composition.
 * This module selects the active view and theme while serial state remains in
 * useSerialSession and visual controls remain in dedicated components.
 */

import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { Icon } from "./components/Icon";
import { ResizableDivider } from "./components/ResizableDivider";
import { SettingsPanel } from "./components/SettingsPanel";
import { TerminalPanel } from "./components/TerminalPanel";
import { WaveformPanel } from "./components/WaveformPanel";
import { useSerialSession } from "./hooks/useSerialSession";

type WorkspaceView = "terminal" | "waveform";
type Theme = "dark" | "light";

/** Renders SerialPilot's desktop workbench. */
export function App() {
 const [view, setView] = useState<WorkspaceView>("terminal");
  const [settingsWidth, setSettingsWidth] = useState(260);
  const [theme, setTheme] = useState<Theme>(() => window.localStorage.getItem("serialpilot-theme") === "light" ? "light" : "dark");
  const serial = useSerialSession();
  const activity = useMemo(() => serial.frames.map((frame) => ({ ...frame, local: new Date(frame.timestamp_ms).toLocaleTimeString() })), [serial.frames]);
  const sessionLabel = serial.status.connected ? `已连接 · ${serial.status.session_id?.slice(0, 8)}` : "未连接";
  const canSend = Boolean(serial.status.connected && serial.status.session_id && serial.payload.trim());

  useEffect(() => { window.localStorage.setItem("serialpilot-theme", theme); }, [theme]);

  return <main className="app-shell" data-theme={theme}>
    <header>
      <div><p className="eyebrow">AI SERIAL CONSOLE</p><h1>SerialPilot</h1></div>
      <nav className="view-tabs" aria-label="工作区视图"><button type="button" className={view === "terminal" ? "selected" : ""} aria-selected={view === "terminal"} onClick={() => setView("terminal")}>终端</button><button type="button" className={view === "waveform" ? "selected" : ""} aria-selected={view === "waveform"} onClick={() => setView("waveform")}>波形</button></nav>
      <div className="header-status"><button type="button" className="theme-toggle" title={theme === "dark" ? "切换到浅色主题" : "切换到深色主题"} aria-label={theme === "dark" ? "切换到浅色主题" : "切换到深色主题"} onClick={() => setTheme((current) => current === "dark" ? "light" : "dark")}><Icon name={theme === "dark" ? "sun" : "moon"} /></button><div className={`connection ${serial.status.connected ? "online" : "offline"}`}><i />{sessionLabel}</div></div>
    </header>
    {serial.error && <div className="error" role="alert">{serial.error}</div>}
    <div className="workspace" style={{ "--settings-width": `${settingsWidth}px` } as CSSProperties}>
      <SettingsPanel config={serial.config} ports={serial.ports} connected={serial.status.connected} autoReconnect={serial.autoReconnect} timedSend={serial.timedSend} timerSeconds={serial.timerSeconds} fileProgress={serial.fileProgress} onChange={serial.setConfig} onOpen={serial.open} onClose={serial.close} onRefreshPorts={serial.refreshPorts} onAutoReconnect={serial.setAutoReconnect} onTimedSend={serial.setTimedSend} onTimerSeconds={serial.setTimerSeconds} onSendFile={serial.sendFile} onCancelFile={serial.cancelFileSend} />
      <ResizableDivider orientation="vertical" value={settingsWidth} min={220} max={460} onChange={setSettingsWidth} label="调整串口配置栏宽度" />
      <div className="workspace-main">
        {view === "terminal" ? <TerminalPanel activity={activity} status={serial.status} paused={serial.paused} encoding={serial.encoding} payload={serial.payload} canSend={canSend} onPause={serial.togglePaused} onClear={serial.clearFrames} onSave={serial.saveFrames} onEncoding={serial.setEncoding} onPayload={serial.setPayload} onSend={serial.send} /> : <WaveformPanel samples={serial.waveSamples} channels={serial.waveChannels} connected={serial.status.connected} paused={serial.waveformPaused} onPause={serial.toggleWaveformPaused} onClear={serial.clearWaveform} onChannelsChange={serial.setWaveChannels} />}
      </div>
    </div>
  </main>;
}
