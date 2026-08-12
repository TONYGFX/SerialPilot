/**
 * Renders the MCP service configuration dialog.
 * The title-bar MCP status control opens this dialog, while the dialog applies
 * actual runtime changes through the Rust-owned local HTTP service.
 */

import { useEffect, useState } from "react";
import type { McpHttpPreferences, McpHttpStatus } from "../types/settings";
import { NumberStepper } from "./FormControls";
import { Icon } from "./Icon";

type McpDialogProps = {
  preferences: McpHttpPreferences;
  runtimeStatus: McpHttpStatus;
  onChange: (preferences: McpHttpPreferences) => void;
  onApply: () => Promise<void>;
  onClose: () => void;
};

/** Renders MCP transport settings and provides explicit runtime controls. */
export function McpDialog({ preferences, runtimeStatus, onChange, onApply, onClose }: McpDialogProps) {
  const [error, setError] = useState<string>();
  const [isApplying, setIsApplying] = useState(false);

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

  return <div className="settings-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="mcp-dialog" role="dialog" aria-modal="true" aria-labelledby="mcp-dialog-title">
      <header className="app-settings-header">
        <div><p className="eyebrow">LOCAL SERVICE</p><h2 id="mcp-dialog-title">MCP</h2></div>
        <button type="button" className="icon-button" title="关闭 MCP 设置" aria-label="关闭 MCP 设置" onClick={onClose}><Icon name="close" /></button>
      </header>
      <div className="mcp-dialog-content">
        <div className="settings-section-title"><h2>HTTP 服务</h2><p>与桌面工作区共用同一个串口核心、会话和接收缓冲区。</p></div>
        <label className="check"><input type="checkbox" checked={preferences.enabled} onChange={(event) => update({ enabled: event.target.checked })} />启用本机 HTTP MCP</label>
        <label>监听地址<input value="127.0.0.1" readOnly aria-label="HTTP MCP 监听地址" /></label>
        <label>端口<NumberStepper value={preferences.port} min={1024} max={65535} step={1} ariaLabel="HTTP MCP 端口" onChange={(port) => update({ port })} /></label>
        <p className="settings-note">仅允许本机访问；局域网监听需要令牌认证，当前未启用。</p>
        <button type="button" className="primary settings-apply" disabled={isApplying} onClick={() => void apply()}>{isApplying ? "应用中" : preferences.enabled ? "启动 / 重启服务" : "停止服务"}</button>
        {runtimeStatus.enabled && runtimeStatus.endpoint && <p className="mcp-endpoint">运行中：{runtimeStatus.endpoint}</p>}
        {error && <p className="settings-error" role="alert">{error}</p>}
        <section className="mcp-stdio-note"><h3>stdio</h3><p>由外部 MCP 客户端启动 `serialpilot-mcp`。协议消息使用 stdout，诊断日志只写入 stderr。</p></section>
      </div>
    </section>
  </div>;
}
