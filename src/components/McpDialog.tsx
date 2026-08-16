/**
 * Renders the MCP service configuration dialog.
 * The title-bar MCP status control opens this dialog, while the dialog applies
 * actual runtime changes through the Rust-owned local HTTP service.
 */

import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { McpHttpPreferences, McpHttpStatus, SendShortcut, TextCharset, Theme } from "../types/settings";
import { NumberStepper, OptionPicker, type SelectOption } from "./FormControls";
import { Icon } from "./Icon";

const APP_VERSION = "0.1.2";
type SettingsPage = "general" | "mcp" | "about";

type McpDialogProps = {
  initialPage: SettingsPage;
  theme: Theme;
  textCharset: TextCharset;
  sendShortcut: SendShortcut;
  receiveDirectory: string;
  onThemeChange: (theme: Theme) => void;
  onTextCharsetChange: (charset: TextCharset) => void;
  onSendShortcutChange: (shortcut: SendShortcut) => void;
  onReceiveDirectoryChange: (directory: string) => void;
  preferences: McpHttpPreferences;
  runtimeStatus: McpHttpStatus;
  onChange: (preferences: McpHttpPreferences) => void;
  onApply: () => Promise<void>;
  onClose: () => void;
};

const TEXT_CHARSETS: SelectOption[] = [
  { value: "utf-8", label: "UTF-8（默认）" },
  { value: "gbk", label: "GBK" },
  { value: "ascii", label: "ASCII" },
  { value: "utf-16le", label: "UTF-16LE" },
];

const SEND_SHORTCUTS: SelectOption[] = [
  { value: "ctrl-enter", label: "Ctrl + Enter（默认）" },
  { value: "enter", label: "Enter" },
];

/** Renders application settings, including MCP transport controls. */
export function McpDialog({ initialPage, theme, textCharset, sendShortcut, receiveDirectory, onThemeChange, onTextCharsetChange, onSendShortcutChange, onReceiveDirectoryChange, preferences, runtimeStatus, onChange, onApply, onClose }: McpDialogProps) {
  const [activePage, setActivePage] = useState<SettingsPage>(initialPage);
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

  useEffect(() => {
    setActivePage(initialPage);
  }, [initialPage]);

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
  const chooseReceiveDirectory = async () => {
    setError(undefined);
    try {
      const selected = await open({ directory: true, multiple: false, title: "选择接收文件目录" });
      if (typeof selected === "string") onReceiveDirectoryChange(selected);
    } catch (cause) {
      setError(`选择接收目录失败：${String(cause)}`);
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
          <button type="button" className={activePage === "mcp" ? "selected" : ""} aria-current={activePage === "mcp" ? "page" : undefined} onClick={() => setActivePage("mcp")}><Icon name="mcp" size={14} />MCP</button>
          <button type="button" className={activePage === "about" ? "selected" : ""} aria-current={activePage === "about" ? "page" : undefined} onClick={() => setActivePage("about")}><Icon name="info" size={14} />关于</button>
        </nav>
        <div className="settings-page">
          {activePage === "general" && <section className="settings-group"><div className="settings-section-title"><h2>外观</h2><p>选择工作区的显示主题；跟随系统会在操作系统切换外观时自动更新。</p></div><div className="settings-theme-options" role="group" aria-label="界面主题"><button type="button" className={theme === "system" ? "selected" : ""} aria-pressed={theme === "system"} onClick={() => onThemeChange("system")}>跟随系统</button><button type="button" className={theme === "dark" ? "selected" : ""} aria-pressed={theme === "dark"} onClick={() => onThemeChange("dark")}>深色</button><button type="button" className={theme === "light" ? "selected" : ""} aria-pressed={theme === "light"} onClick={() => onThemeChange("light")}>浅色</button></div><div className="settings-section-title text-charset-title"><h2>文本编码</h2><p>用于终端文本收发、文本匹配和波形解析；HEX 始终显示原始字节。</p></div><label className="text-charset-picker">编码<OptionPicker value={textCharset} options={TEXT_CHARSETS} onChange={(value) => onTextCharsetChange(value as TextCharset)} /></label><div className="settings-section-title keyboard-settings-title"><h2>快捷键</h2><p>发送快捷键仅在终端输入框中生效；选择 Enter 后，Shift + Enter 可继续输入换行。</p></div><label className="text-charset-picker">发送<OptionPicker value={sendShortcut} options={SEND_SHORTCUTS} onChange={(value) => onSendShortcutChange(value as SendShortcut)} /></label><dl className="shortcut-list"><div><dt>Ctrl + S</dt><dd>保存终端日志</dd></div><div><dt>Ctrl + L</dt><dd>清空终端日志</dd></div></dl><div className="settings-section-title receive-directory-title"><h2>文件接收</h2><p>接收的文件默认保存到系统下载目录，可在此修改。</p></div><div className="receive-directory"><code title={receiveDirectory}>{receiveDirectory || "正在读取系统下载目录"}</code><button type="button" className="secondary" onClick={() => void chooseReceiveDirectory()}><Icon name="file" size={14} />选择目录</button></div></section>}
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
          {activePage === "about" && <section className="about-page"><div className="settings-section-title"><h2>SerialPilot</h2><p>跨平台桌面端 AI 串口助手。</p></div><dl className="about-details"><div><dt>版本</dt><dd>{APP_VERSION}</dd></div><div><dt>开发者</dt><dd>TONYGFX</dd></div><div><dt>许可证</dt><dd>MIT License</dd></div><div><dt>版权</dt><dd>Copyright (c) 2026 TONYGFX</dd></div><div><dt>GitHub</dt><dd><button type="button" className="about-link" onClick={() => void openUrl("https://github.com/TONYGFX/SerialPilot")}>github.com/TONYGFX/SerialPilot</button></dd></div></dl></section>}
        </div>
      </div>
    </section>
  </div>;
}
