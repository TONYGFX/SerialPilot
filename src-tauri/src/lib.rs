pub mod command;
pub mod mcp;
pub mod mcp_http;
pub mod serial;

use std::{
    collections::HashMap,
    path::PathBuf,
    sync::Arc,
    time::{Duration, Instant},
};

use command::{CommandResult, EventKind, SerialCommand, SerialCore, SerialEvent};
use mcp_http::{configure_server, McpHttpConfig, McpHttpServer, McpHttpStatus};
use serial::DesktopSerialAdapter;
use tauri::{AppHandle, Emitter, Manager, State};

pub struct AppCore(pub Arc<SerialCore>);
pub struct McpRuntime(pub tokio::sync::Mutex<Option<McpHttpServer>>);

/// Shared by the Tauri command layer and the MCP stdio server.
pub async fn dispatch_command(
    core: &SerialCore,
    command: SerialCommand,
) -> Result<CommandResult, String> {
    core.execute(command)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn execute_serial(
    core: State<'_, AppCore>,
    command: SerialCommand,
) -> Result<CommandResult, String> {
    dispatch_command(core.0.as_ref(), command).await
}

#[tauri::command]
async fn configure_mcp_http(
    core: State<'_, AppCore>,
    runtime: State<'_, McpRuntime>,
    config: McpHttpConfig,
) -> Result<McpHttpStatus, String> {
    configure_server(&runtime.0, core.0.clone(), config).await
}

#[tauri::command]
fn save_text_file(path: String, content: String) -> Result<(), String> {
    let file_path = PathBuf::from(path.trim());
    if file_path.as_os_str().is_empty() {
        return Err("保存路径为空".to_string());
    }
    std::fs::write(&file_path, content.as_bytes())
        .map_err(|error| format!("写入文件失败：{}", error))
}

#[tauri::command]
fn reveal_file(path: String) -> Result<(), String> {
    let file_path = PathBuf::from(path.trim());
    if !file_path.is_file() {
        return Err("接收文件不存在或已被移动".to_string());
    }

    #[cfg(target_os = "windows")]
    let mut command = {
        let mut command = std::process::Command::new("explorer.exe");
        command.arg(format!("/select,{}", file_path.display()));
        command
    };
    #[cfg(target_os = "macos")]
    let mut command = {
        let mut command = std::process::Command::new("open");
        command.args(["-R", &file_path.to_string_lossy()]);
        command
    };
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut command = {
        let mut command = std::process::Command::new("xdg-open");
        command.arg(file_path.parent().unwrap_or(file_path.as_path()));
        command
    };

    command
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("无法打开文件所在目录：{error}"))
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let core = Arc::new(SerialCore::new(Arc::new(DesktopSerialAdapter::default())));
            let mut events = core.subscribe();
            let handle: AppHandle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let mut progress_updates = HashMap::new();
                loop {
                    let event = match events.recv().await {
                        Ok(event) => event,
                        // File data remains audited by the core. If its high-frequency
                        // events briefly outrun the desktop bridge, resume from the
                        // newest event instead of permanently losing desktop updates.
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                        Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                    };
                    if !should_forward_event_to_desktop(&event, &mut progress_updates) {
                        continue;
                    }
                    let _ = handle.emit("serial-event", event);
                }
            });
            app.manage(AppCore(core));
            app.manage(McpRuntime(tokio::sync::Mutex::new(None)));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            execute_serial,
            configure_mcp_http,
            save_text_file,
            reveal_file
        ])
        .run(tauri::generate_context!())
        .expect("failed to run SerialPilot");
}

/// Keeps bulk transfer bytes in the core audit while protecting the WebView
/// from decoding and laying out every binary packet during a file transfer.
fn should_forward_event_to_desktop(
    event: &SerialEvent,
    progress_updates: &mut HashMap<String, Instant>,
) -> bool {
    if matches!(event.kind, EventKind::FileFrame) {
        return false;
    }
    if !matches!(
        event.kind,
        EventKind::FileProgress | EventKind::FileReceiveProgress
    ) {
        return true;
    }
    let key = event
        .action_id
        .clone()
        .unwrap_or_else(|| event.action.clone());
    if is_terminal_file_progress(event) {
        progress_updates.remove(&key);
        return true;
    }
    let now = Instant::now();
    let should_forward = progress_updates
        .get(&key)
        .is_none_or(|last| now.duration_since(*last) >= Duration::from_millis(100));
    if should_forward {
        progress_updates.insert(key, now);
    }
    should_forward
}

fn is_terminal_file_progress(event: &SerialEvent) -> bool {
    ["completed", "cancelled", "failed"]
        .iter()
        .any(|field| event.detail.get(*field).and_then(|value| value.as_bool()) == Some(true))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn event(kind: EventKind, detail: serde_json::Value) -> SerialEvent {
        SerialEvent {
            event_id: "event".into(),
            timestamp_ms: 0,
            kind,
            action: "serial.send_file".into(),
            action_id: Some("transfer".into()),
            detail,
        }
    }

    #[test]
    fn file_frames_stay_out_of_the_desktop_event_stream() {
        let mut progress_updates = HashMap::new();
        assert!(!should_forward_event_to_desktop(
            &event(EventKind::FileFrame, serde_json::json!({})),
            &mut progress_updates,
        ));
    }

    #[test]
    fn file_progress_is_throttled_but_terminal_state_is_immediate() {
        let mut progress_updates = HashMap::new();
        let ongoing = event(
            EventKind::FileProgress,
            serde_json::json!({ "completed": false }),
        );
        let completed = event(
            EventKind::FileProgress,
            serde_json::json!({ "completed": true }),
        );

        assert!(should_forward_event_to_desktop(
            &ongoing,
            &mut progress_updates
        ));
        assert!(!should_forward_event_to_desktop(
            &ongoing,
            &mut progress_updates
        ));
        assert!(should_forward_event_to_desktop(
            &completed,
            &mut progress_updates
        ));
    }
}
