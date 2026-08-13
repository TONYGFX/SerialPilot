pub mod command;
pub mod mcp;
pub mod mcp_http;
pub mod serial;

use std::sync::Arc;
use std::path::PathBuf;

use command::{CommandResult, SerialCommand, SerialCore};
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

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let core = Arc::new(SerialCore::new(Arc::new(DesktopSerialAdapter::default())));
            let mut events = core.subscribe();
            let handle: AppHandle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                while let Ok(event) = events.recv().await {
                    let _ = handle.emit("serial-event", event);
                }
            });
            app.manage(AppCore(core));
            app.manage(McpRuntime(tokio::sync::Mutex::new(None)));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![execute_serial, configure_mcp_http, save_text_file])
        .run(tauri::generate_context!())
        .expect("failed to run SerialPilot");
}
