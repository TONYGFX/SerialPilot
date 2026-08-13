/**
 * Renders the MCP service configuration dialog.
 * The title-bar MCP status control opens this dialog, while the dialog applies
 * actual runtime changes through the Rust-owned local HTTP service.
 */

import { useEffect, useState } from "react";
import type { McpHttpPreferences, McpHttpStatus, Theme } from "../types/settings";
import { NumberStepper } from "./FormControls";
import { Icon } from "./Icon";

const APP_VERSION = "0.1.2";

type McpDialogProps = {
  theme: Theme;
  onThemeChange: (theme: Theme) => void;
  preferences: McpHttpPreferences;
  runtimeStatus: McpHttpStatus;
  onChange: (preferences: McpHttpPreferences) => void;
  onApply: () => Promise<void>;
  onClose: () => void;
};

/** Renders MCP transport settings and provides explicit runtime controls. */
export function McpDialog({ theme, onThemeChange, preferences, runtimeStatus, onChange, onApply, onClose }: McpDialogProps) {
  const [activePage, setActivePage] = useState<"general" | "mcp" | "about">("general");
  const [error, setError] = useState<string>();
  const [isApplying, setIsApplying] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  const update = (change: Partial<McpHttpPreferences>) => onChange({ ...preferences, ...change });
  const apply = async () => {
    setError(undefined);
    setIsApplying(true);
    try {
      await onApply();
    } catch (cause) {
      setError(String(cause));
    } finally {
      setIsApplying(false);
    }
  };
  const copyEndpoint = async () => {
    if (!runtimeStatus.endpoint) return;
    setError(undefined);
    try {
      await navigator.clipboard.writeText(runtimeStatus.endpoint);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch (cause) {
      setError(`复制地址失败：${String(cause)}`);
    }
  };

  return <div className="settings-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="mcp-dialog" role="dialog" aria-modal="true" aria-labelledby="mcp-dialog-title">
      <header className="app-settings-header">
        <div><p className="eyebrow">APPLICATION</p><h2 id="mcp-dialog-title">设置</h2></div>
        <button type="button" className="icon-button" title="关闭设置" aria-label="关闭设置" onClick={onClose}><Icon name="close" /></button>
      </header>
      <div className="settings-layout">
        <nav className="settings-nav" aria-label="设置分类">
          <button type="button" className={activePage === "general" ? "selected" : ""} aria-current={activePage === "general" ? "page" : undefined} onClick={() => setActivePage("general")}><Icon name="settings" size={14} />通用</button>
          <button type="button" className={activePage === "mcp" ? "selected" : ""} aria-current={activePage === "mcp" ? "page" : undefined} onClick={() => setActivePage("mcp")}><span className="settings-nav-dot" />MCP</button>
          <button type="button" className={activePage === "about" ? "selected" : ""} aria-current={activePage === "about" ? "page" : undefined} onClick={() => setActivePage("about")}><span className="settings-nav-mark">i</span>关于</button>
        </nav>
        <div className="settings-page">
          {activePage === "general" && <section className="settings-group"><div className="settings-section-title"><h2>外观</h2><p>选择工作区的显示主题；跟随系统会在操作系统切换外观时自动更新。</p></div><div className="settings-theme-options" role="group" aria-label="界面主题"><button type="button" className={theme === "system" ? "selected" : ""} aria-pressed={theme === "system"} onClick={() => onThemeChange("system")}>跟随系统</button><button type="button" className={theme === "dark" ? "selected" : ""} aria-pressed={theme === "dark"} onClick={() => onThemeChange("dark")}>深色</button><button type="button" className={theme === "light" ? "selected" : ""} aria-pressed={theme === "light"} onClick={() => onThemeChange("light")}>浅色</button></div></section>}
          {activePage === "mcp" && <section className="settings-group"><div className="settings-section-title"><h2>HTTP 服务</h2><p>与桌面工作区共用同一个串口核心、会话和接收缓冲区。</p></div>
            <label className="check"><input type="checkbox" checked={preferences.enabled} onChange={(event) => update({ enabled: event.target.checked })} />启用本机 HTTP MCP</label>
            <label>监听地址<input value="127.0.0.1" readOnly aria-label="HTTP MCP 监听地址" /></label>
            <label>端口<NumberStepper value={preferences.port} min={1024} max={65535} step={1} ariaLabel="HTTP MCP 端口" onChange={(port) => update({ port })} /></label>
            <p className="settings-note">仅允许本机访问；局域网监听需要令牌认证，当前未启用。</p>
            <button type="button" className="primary settings-apply" disabled={isApplying} onClick={() => void apply()}>{isApplying ? "应用中" : "应用 HTTP 设置"}</button>
            {runtimeStatus.enabled && runtimeStatus.endpoint && <div className="mcp-endpoint"><span>{copied ? "已复制" : "运行中"}</span><code title={runtimeStatus.endpoint}>{runtimeStatus.endpoint}</code><button type="button" className="mcp-copy" title={copied ? "已复制" : "复制 HTTP 地址"} aria-label={copied ? "HTTP 地址已复制" : "复制 HTTP 地址"} onClick={() => void copyEndpoint()}><Icon name="copy" size={14} /></button></div>}
            {error && <p className="settings-error" role="alert">{error}</p>}
            <section className="mcp-stdio-note"><h3>stdio</h3><p>由外部 MCP 客户端启动 `serialpilot-mcp`。协议消息使用 stdout，诊断日志只写入 stderr。</p></section>
          </section>}
          {activePage === "about" && <section className="about-page"><div className="settings-section-title"><h2>SerialPilot</h2><p>跨平台桌面端 AI 串口助手。</p></div><dl className="about-details"><div><dt>版本</dt><dd>{APP_VERSION}</dd></div><div><dt>开发者</dt><dd>TONYGFX</dd></div></dl></section>}
        </div>
      </div>
    </section>
  </div>;
}
