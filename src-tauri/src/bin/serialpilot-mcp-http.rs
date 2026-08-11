//! Streamable HTTP transport for MCP. The endpoint is intentionally separate from Tauri UI traffic.
use std::{net::SocketAddr, sync::Arc};

use axum::{extract::State, routing::post, Json, Router};
use serde_json::{json, Value};
use serialpilot_lib::{
    command::{SerialCommand, SerialCore},
    dispatch_command,
    serial::MockSerialAdapter,
};

#[derive(Clone)]
struct McpState(Arc<SerialCore>);

#[tokio::main]
async fn main() {
    let state = McpState(Arc::new(SerialCore::new(Arc::new(MockSerialAdapter))));
    let app = Router::new().route("/mcp", post(mcp)).with_state(state);
    let address: SocketAddr = std::env::var("SERIALPILOT_MCP_ADDR")
        .unwrap_or_else(|_| "127.0.0.1:3030".into())
        .parse()
        .expect("SERIALPILOT_MCP_ADDR must be host:port");
    eprintln!("SerialPilot MCP Streamable HTTP (Mock adapter) listening on http://{address}/mcp");
    let listener = tokio::net::TcpListener::bind(address)
        .await
        .expect("failed to bind MCP HTTP address");
    axum::serve(listener, app)
        .await
        .expect("MCP HTTP server failed");
}

async fn mcp(State(state): State<McpState>, Json(request): Json<Value>) -> Json<Value> {
    Json(handle(&state.0, request).await)
}

async fn handle(core: &SerialCore, request: Value) -> Value {
    let id = request.get("id").cloned().unwrap_or(Value::Null);
    match request
        .get("method")
        .and_then(Value::as_str)
        .unwrap_or_default()
    {
        "initialize" => {
            json!({ "jsonrpc": "2.0", "id": id, "result": { "protocolVersion": "2025-03-26", "serverInfo": { "name": "serialpilot-mcp", "version": "0.1.0" }, "capabilities": { "tools": {} } } })
        }
        "tools/list" => json!({ "jsonrpc": "2.0", "id": id, "result": { "tools": tools() } }),
        "tools/call" => {
            let params = request.get("params").cloned().unwrap_or_default();
            let name = params
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or_default();
            match tool_command(
                name,
                params
                    .get("arguments")
                    .cloned()
                    .unwrap_or_else(|| json!({})),
            ) {
                Ok(command) => match dispatch_command(core, command).await {
                    Ok(result) => {
                        json!({ "jsonrpc": "2.0", "id": id, "result": { "content": [{ "type": "text", "text": serde_json::to_string(&result).unwrap() }], "structuredContent": result } })
                    }
                    Err(error) => tool_error(id, error),
                },
                Err(error) => tool_error(id, error),
            }
        }
        _ => {
            json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32601, "message": "method not found" } })
        }
    }
}

fn tool_command(name: &str, arguments: Value) -> Result<SerialCommand, String> {
    match name {
        "serial.list_ports" => Ok(SerialCommand::ListPorts),
        "serial.open" => serde_json::from_value(json!({ "type": "open", "config": arguments }))
            .map_err(|error| error.to_string()),
        "serial.status" => Ok(SerialCommand::Status),
        "serial.send" => decode_tagged("send", arguments),
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
fn tools() -> Vec<Value> {
    ["serial.list_ports", "serial.open", "serial.status", "serial.send", "serial.read_since", "serial.wait_for", "serial.exchange"].into_iter().map(|name| json!({ "name": name, "description": "SerialPilot structured serial command.", "inputSchema": { "type": "object", "additionalProperties": true } })).collect()
}
