//! MCP-compatible JSON-RPC over stdio. stdout is reserved for protocol messages.
use std::{
    io::{self, BufRead, Write},
    sync::Arc,
};

use serde_json::{json, Value};
use serialpilot_lib::{
    command::{SerialCommand, SerialCore},
    dispatch_command,
    serial::MockSerialAdapter,
};

#[tokio::main]
async fn main() {
    eprintln!("SerialPilot MCP started with Mock serial adapter");
    let core = SerialCore::new(Arc::new(MockSerialAdapter));
    let stdin = io::stdin();
    let mut stdout = io::stdout().lock();

    for line in stdin.lock().lines() {
        let line = match line {
            Ok(line) => line,
            Err(error) => {
                eprintln!("stdin read error: {error}");
                break;
            }
        };
        if line.trim().is_empty() {
            continue;
        }
        let request: Value = match serde_json::from_str(&line) {
            Ok(request) => request,
            Err(error) => {
                write_message(
                    &mut stdout,
                    json!({ "jsonrpc": "2.0", "error": { "code": -32700, "message": error.to_string() }, "id": null }),
                );
                continue;
            }
        };
        let id = request.get("id").cloned().unwrap_or(Value::Null);
        let method = request
            .get("method")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let response = match method {
            "initialize" => {
                json!({ "jsonrpc": "2.0", "id": id, "result": { "protocolVersion": "2025-03-26", "serverInfo": { "name": "serialpilot-mcp", "version": "0.1.0" }, "capabilities": { "tools": {} } } })
            }
            "tools/list" => json!({ "jsonrpc": "2.0", "id": id, "result": { "tools": tools() } }),
            "tools/call" => {
                call_tool(
                    &core,
                    id,
                    request.get("params").cloned().unwrap_or_default(),
                )
                .await
            }
            _ => {
                json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32601, "message": "method not found" } })
            }
        };
        write_message(&mut stdout, response);
    }
}

async fn call_tool(core: &SerialCore, id: Value, params: Value) -> Value {
    let name = params
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let arguments = params
        .get("arguments")
        .cloned()
        .unwrap_or_else(|| json!({}));
    let command = match tool_command(name, arguments) {
        Ok(command) => command,
        Err(error) => return tool_error(id, error),
    };
    match dispatch_command(core, command).await {
        Ok(result) => {
            json!({ "jsonrpc": "2.0", "id": id, "result": { "content": [{ "type": "text", "text": serde_json::to_string(&result).unwrap() }], "structuredContent": result } })
        }
        Err(error) => tool_error(id, error),
    }
}

fn tool_command(name: &str, arguments: Value) -> Result<SerialCommand, String> {
    match name {
        "serial.list_ports" => Ok(SerialCommand::ListPorts),
        "serial.open" => serde_json::from_value(json!({ "type": "open", "config": arguments }))
            .map_err(|error| error.to_string()),
        "serial.status" => Ok(SerialCommand::Status),
        "serial.send" => decode_tagged("send", arguments),
        "serial.send_file" => decode_tagged("send_file", arguments),
        "serial.cancel_send_file" => decode_tagged("cancel_send_file", arguments),
        "serial.read_since" => decode_tagged("read_since", arguments),
        "serial.wait_for" => decode_tagged("wait_for", arguments),
        "serial.exchange" => decode_tagged("exchange", arguments),
        _ => Err(format!("unknown SerialPilot tool: {name}")),
    }
}

fn decode_tagged(tag: &str, arguments: Value) -> Result<SerialCommand, String> {
    let mut object = arguments
        .as_object()
        .cloned()
        .ok_or("tool arguments must be an object")?;
    object.insert("type".into(), Value::String(tag.into()));
    serde_json::from_value(Value::Object(object)).map_err(|error| error.to_string())
}

fn tool_error(id: Value, message: String) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": { "content": [{ "type": "text", "text": message }], "isError": true } })
}
fn write_message(out: &mut impl Write, message: Value) {
    let _ = writeln!(out, "{}", message);
    let _ = out.flush();
}

fn tools() -> Vec<Value> {
    [
        ("serial.list_ports", "List available serial ports, including the Mock development port."),
        ("serial.open", "Open a port with full serial configuration; returns session_id and initial rx_cursor."),
        ("serial.status", "Read connection, configuration, buffer, rate, and overflow state."),
        ("serial.send", "Send text, hex, or base64 bytes through an active session."),
        ("serial.send_file", "Send a local file through an active session in bounded chunks."),
        ("serial.cancel_send_file", "Cancel an active file send by action_id."),
        ("serial.read_since", "Read buffered TX/RX frames after a cursor without waiting."),
        ("serial.wait_for", "Wait up to timeout_ms for a buffered RX frame matching a condition."),
        ("serial.exchange", "Atomically capture cursor, send, and wait for a bounded response."),
    ].into_iter().map(|(name, description)| json!({ "name": name, "description": description, "inputSchema": { "type": "object", "additionalProperties": true } })).collect()
}
