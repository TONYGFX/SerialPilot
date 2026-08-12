pub mod command;
pub mod serial;

use std::sync::Arc;

use command::{CommandResult, SerialCommand, SerialCore};
use serial::MockSerialAdapter;
use tauri::{AppHandle, Emitter, Manager, State};

pub struct AppCore(pub SerialCore);

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
    dispatch_command(&core.0, command).await
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let core = SerialCore::new(Arc::new(MockSerialAdapter));
            let mut events = core.subscribe();
            let handle: AppHandle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                while let Ok(event) = events.recv().await {
                    let _ = handle.emit("serial-event", event);
                }
            });
            app.manage(AppCore(core));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![execute_serial])
        .run(tauri::generate_context!())
        .expect("failed to run SerialPilot");
}
