//! Shared MCP protocol handling for SerialPilot's stdio and HTTP transports.
//!
//! The transport binaries only deal with framing. Tool names, schemas, command
//! decoding, and execution all live here so every MCP entry point has identical
//! behavior and remains on the Rust serial-core command path.

use serde_json::{json, Value};

use crate::command::{CommandResult, SerialCommand, SerialCore};

/// Handles one JSON-RPC request. Notifications intentionally produce no response.
pub async fn handle_request(core: &SerialCore, request: Value) -> Option<Value> {
    let id = request.get("id").cloned().unwrap_or(Value::Null);
    let method = match request.get("method").and_then(Value::as_str) {
        Some(method) => method,
        None => return Some(jsonrpc_error(id, -32600, "invalid request")),
    };

    if request.get("id").is_none() {
        if method == "notifications/initialized" {
            return None;
        }
        return None;
    }

    match method {
        "initialize" => Some(initialize_response(id)),
        "ping" => Some(json!({ "jsonrpc": "2.0", "id": id, "result": {} })),
        "tools/list" => Some(json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": { "tools": tools() }
        })),
        "tools/call" => Some(
            call_tool(
                core,
                id,
                request.get("params").cloned().unwrap_or_else(|| json!({})),
            )
            .await,
        ),
        _ => Some(jsonrpc_error(id, -32601, "method not found")),
    }
}

/// Converts an MCP tool invocation into the same command used by the UI.
pub fn tool_command(name: &str, arguments: Value) -> Result<SerialCommand, String> {
    match name {
        "serial.list_ports" => Ok(SerialCommand::ListPorts),
        "serial.open" => serde_json::from_value(json!({ "type": "open", "config": arguments }))
            .map_err(|error| error.to_string()),
        "serial.close" => decode_tagged("close", arguments),
        "serial.configure" => decode_tagged("configure", arguments),
        "serial.status" => Ok(SerialCommand::Status),
        "serial.send" => decode_tagged("send", arguments),
        "serial.send_file" => decode_file_send(arguments),
        "serial.cancel_send_file" => decode_tagged("cancel_send_file", arguments),
        "serial.read_since" => decode_tagged("read_since", arguments),
        "serial.wait_for" => decode_tagged("wait_for", arguments),
        "serial.exchange" => decode_tagged("exchange", arguments),
        "serial.send_batch" => {
            decode_with_defaults("send_batch", arguments, &[("interval_ms", json!(0))])
        }
        "serial.exchange_batch" => decode_tagged("exchange_batch", arguments),
        "serial.wait_for_any" => decode_tagged("wait_for_any", arguments),
        "serial.monitor_ports" => {
            decode_with_defaults("monitor_ports", arguments, &[("interval_ms", json!(1000))])
        }
        "serial.reconnect" => decode_tagged("reconnect", arguments),
        "waveform.list_channels" => Ok(SerialCommand::WaveformListChannels),
        "waveform.add_channel" => decode_with_defaults(
            "waveform_add_channel",
            arguments,
            &[("enabled", json!(true))],
        ),
        "waveform.update_channel" => decode_tagged("waveform_update_channel", arguments),
        "waveform.remove_channel" => decode_tagged("waveform_remove_channel", arguments),
        "waveform.clear_samples" => Ok(SerialCommand::WaveformClearSamples),
        _ => Err(format!("unknown SerialPilot tool: {name}")),
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

    match core.execute(command).await {
        Ok(result) => tool_result(id, result),
        Err(error) => tool_error(id, error.to_string()),
    }
}

fn decode_file_send(arguments: Value) -> Result<SerialCommand, String> {
    let mut object = arguments
        .as_object()
        .cloned()
        .ok_or("tool arguments must be an object")?;
    object.entry("protocol").or_insert_with(|| json!("null"));
    object.entry("chunk_size").or_insert_with(|| json!(256));
    object.entry("interval_ms").or_insert_with(|| json!(10));
    object.insert("type".into(), Value::String("send_file".into()));
    serde_json::from_value(Value::Object(object)).map_err(|error| error.to_string())
}

fn decode_tagged(tag: &str, arguments: Value) -> Result<SerialCommand, String> {
    let mut object = arguments
        .as_object()
        .cloned()
        .ok_or("tool arguments must be an object")?;
    object.insert("type".into(), Value::String(tag.into()));
    serde_json::from_value(Value::Object(object)).map_err(|error| error.to_string())
}

fn decode_with_defaults(
    tag: &str,
    arguments: Value,
    defaults: &[(&str, Value)],
) -> Result<SerialCommand, String> {
    let mut object = arguments
        .as_object()
        .cloned()
        .ok_or("tool arguments must be an object")?;
    for (name, value) in defaults {
        object
            .entry((*name).to_owned())
            .or_insert_with(|| value.clone());
    }
    object.insert("type".into(), Value::String(tag.into()));
    serde_json::from_value(Value::Object(object)).map_err(|error| error.to_string())
}

fn initialize_response(id: Value) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "result": {
            "protocolVersion": "2025-03-26",
            "serverInfo": { "name": "serialpilot-mcp", "version": env!("CARGO_PKG_VERSION") },
            "capabilities": { "tools": {} }
        }
    })
}

fn tool_result(id: Value, result: CommandResult) -> Value {
    let text = serde_json::to_string(&result)
        .unwrap_or_else(|error| format!("serialization error: {error}"));
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "result": {
            "content": [{ "type": "text", "text": text }],
            "structuredContent": result
        }
    })
}

fn tool_error(id: Value, message: String) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "result": {
            "content": [{ "type": "text", "text": message }],
            "isError": true
        }
    })
}

fn jsonrpc_error(id: Value, code: i32, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

/// Returns the public MCP tool catalogue and its validation schemas.
pub fn tools() -> Vec<Value> {
    vec![
        tool(
            "serial.list_ports",
            "List available serial ports.",
            object_schema(vec![], vec![]),
        ),
        tool(
            "serial.open",
            "Open a port with full serial configuration.",
            object_schema(
                vec![
                    ("port", string_schema()),
                    ("baud_rate", integer_schema()),
                    ("data_bits", integer_schema()),
                    ("parity", string_enum(&["none", "odd", "even"])),
                    ("stop_bits", integer_schema()),
                    (
                        "flow_control",
                        string_enum(&["none", "software", "hardware"]),
                    ),
                    ("exclusive", boolean_schema()),
                    ("dtr", boolean_schema()),
                    ("rts", boolean_schema()),
                ],
                vec![
                    "port",
                    "baud_rate",
                    "data_bits",
                    "parity",
                    "stop_bits",
                    "flow_control",
                    "exclusive",
                    "dtr",
                    "rts",
                ],
            ),
        ),
        tool(
            "serial.close",
            "Close the active serial session.",
            object_schema(vec![("session_id", string_schema())], vec!["session_id"]),
        ),
        tool(
            "serial.configure",
            "Update configuration while closed, or reopen explicitly.",
            object_schema(
                vec![
                    ("config", serial_config_schema()),
                    ("reopen", boolean_schema()),
                ],
                vec!["config", "reopen"],
            ),
        ),
        tool(
            "serial.status",
            "Read connection, buffer, rate, and overflow state.",
            object_schema(vec![], vec![]),
        ),
        tool(
            "serial.send",
            "Send text, HEX, or base64 bytes through an active session.",
            object_schema(
                vec![
                    ("session_id", string_schema()),
                    ("encoding", string_enum(&["text", "hex", "base64"])),
                    ("payload", string_schema()),
                    ("action_id", string_schema()),
                    ("timeout_ms", integer_schema()),
                ],
                vec!["session_id", "encoding", "payload"],
            ),
        ),
        tool(
            "serial.send_file",
            "Send a local file using Null, Xmodem, Xmodem-1k, or Ymodem.",
            object_schema(
                vec![
                    ("session_id", string_schema()),
                    ("file_path", string_schema()),
                    (
                        "protocol",
                        string_enum(&["null", "xmodem", "xmodem-1k", "ymodem"]),
                    ),
                    ("chunk_size", integer_schema()),
                    ("interval_ms", integer_schema()),
                    ("timeout_ms", integer_schema()),
                    ("action_id", string_schema()),
                ],
                vec!["session_id", "file_path"],
            ),
        ),
        tool(
            "serial.cancel_send_file",
            "Cancel an active file transfer.",
            object_schema(vec![("action_id", string_schema())], vec!["action_id"]),
        ),
        tool(
            "serial.read_since",
            "Read buffered frames after a cursor without waiting.",
            object_schema(
                vec![
                    ("session_id", string_schema()),
                    ("after_cursor", integer_schema()),
                    ("max_bytes", integer_schema()),
                    ("max_frames", integer_schema()),
                ],
                vec!["session_id", "after_cursor", "max_bytes", "max_frames"],
            ),
        ),
        tool(
            "serial.wait_for",
            "Wait a bounded time for matching RX data.",
            object_schema(
                vec![
                    ("session_id", string_schema()),
                    ("after_cursor", integer_schema()),
                    ("condition", wait_condition_schema()),
                    ("timeout_ms", integer_schema()),
                ],
                vec!["session_id", "after_cursor", "condition", "timeout_ms"],
            ),
        ),
        tool(
            "serial.exchange",
            "Send a request and capture a fast matching response from the background buffer.",
            object_schema(
                vec![
                    ("session_id", string_schema()),
                    ("encoding", string_enum(&["text", "hex", "base64"])),
                    ("payload", string_schema()),
                    ("condition", wait_condition_schema()),
                    ("timeout_ms", integer_schema()),
                    ("action_id", string_schema()),
                ],
                vec![
                    "session_id",
                    "encoding",
                    "payload",
                    "condition",
                    "timeout_ms",
                ],
            ),
        ),
        tool(
            "serial.send_batch",
            "Send a bounded sequence of payloads in order.",
            object_schema(
                vec![
                    ("session_id", string_schema()),
                    (
                        "items",
                        json!({ "type": "array", "minItems": 1, "maxItems": 256 }),
                    ),
                    ("interval_ms", integer_schema()),
                    ("action_id", string_schema()),
                ],
                vec!["session_id", "items"],
            ),
        ),
        tool(
            "serial.exchange_batch",
            "Run bounded request-response transactions in order.",
            object_schema(
                vec![
                    ("session_id", string_schema()),
                    (
                        "items",
                        json!({ "type": "array", "minItems": 1, "maxItems": 128 }),
                    ),
                    ("action_id", string_schema()),
                ],
                vec!["session_id", "items"],
            ),
        ),
        tool(
            "serial.wait_for_any",
            "Wait for the first matching condition from a bounded list.",
            object_schema(
                vec![
                    ("session_id", string_schema()),
                    ("after_cursor", integer_schema()),
                    ("conditions", json!({ "type": "array", "minItems": 1 })),
                    ("timeout_ms", integer_schema()),
                ],
                vec!["session_id", "after_cursor", "conditions", "timeout_ms"],
            ),
        ),
        tool(
            "serial.monitor_ports",
            "Poll available ports for a bounded period.",
            object_schema(
                vec![
                    ("duration_ms", integer_schema()),
                    ("interval_ms", integer_schema()),
                ],
                vec!["duration_ms"],
            ),
        ),
        tool(
            "serial.reconnect",
            "Close and reopen the current session with its existing configuration.",
            object_schema(vec![("session_id", string_schema())], vec!["session_id"]),
        ),
        tool(
            "waveform.list_channels",
            "List user-configured waveform channels.",
            object_schema(vec![], vec![]),
        ),
        tool(
            "waveform.add_channel",
            "Add a named waveform channel with a line color.",
            object_schema(
                vec![
                    ("name", string_schema()),
                    ("color", string_schema()),
                    ("enabled", boolean_schema()),
                ],
                vec!["name", "color"],
            ),
        ),
        tool(
            "waveform.update_channel",
            "Update a waveform channel name, color, or enabled state.",
            object_schema(
                vec![
                    ("channel_id", string_schema()),
                    ("name", string_schema()),
                    ("color", string_schema()),
                    ("enabled", boolean_schema()),
                ],
                vec!["channel_id"],
            ),
        ),
        tool(
            "waveform.remove_channel",
            "Remove a configured waveform channel.",
            object_schema(vec![("channel_id", string_schema())], vec!["channel_id"]),
        ),
        tool(
            "waveform.clear_samples",
            "Clear derived waveform samples without changing raw RX frames.",
            object_schema(vec![], vec![]),
        ),
    ]
}

fn tool(name: &str, description: &str, input_schema: Value) -> Value {
    json!({ "name": name, "description": description, "inputSchema": input_schema })
}

fn object_schema(properties: Vec<(&str, Value)>, required: Vec<&str>) -> Value {
    let properties = properties
        .into_iter()
        .map(|(name, schema)| (name.to_owned(), schema))
        .collect::<serde_json::Map<_, _>>();
    json!({ "type": "object", "properties": properties, "required": required, "additionalProperties": false })
}

fn string_schema() -> Value {
    json!({ "type": "string" })
}
fn integer_schema() -> Value {
    json!({ "type": "integer", "minimum": 0 })
}
fn boolean_schema() -> Value {
    json!({ "type": "boolean" })
}
fn string_enum(values: &[&str]) -> Value {
    json!({ "type": "string", "enum": values })
}

fn serial_config_schema() -> Value {
    object_schema(
        vec![
            ("port", string_schema()),
            ("baud_rate", integer_schema()),
            ("data_bits", integer_schema()),
            ("parity", string_enum(&["none", "odd", "even"])),
            ("stop_bits", integer_schema()),
            (
                "flow_control",
                string_enum(&["none", "software", "hardware"]),
            ),
            ("exclusive", boolean_schema()),
            ("dtr", boolean_schema()),
            ("rts", boolean_schema()),
        ],
        vec![
            "port",
            "baud_rate",
            "data_bits",
            "parity",
            "stop_bits",
            "flow_control",
            "exclusive",
            "dtr",
            "rts",
        ],
    )
}

fn wait_condition_schema() -> Value {
    object_schema(
        vec![
            ("contains_text", string_schema()),
            ("contains_hex", string_schema()),
            ("frame_prefix", string_schema()),
            ("regex", string_schema()),
            ("protocol_field", json!({ "type": "object" })),
        ],
        vec![],
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{command::FileTransferProtocol, serial::MockSerialAdapter};
    use std::sync::Arc;

    #[test]
    fn catalogue_contains_all_serial_tools() {
        let names = tools()
            .into_iter()
            .filter_map(|tool| tool.get("name").and_then(Value::as_str).map(str::to_owned))
            .collect::<Vec<_>>();
        assert!(names.contains(&"serial.close".to_owned()));
        assert!(names.contains(&"serial.configure".to_owned()));
        assert_eq!(names.len(), 21);
    }

    #[test]
    fn decodes_close_and_configure() {
        assert!(matches!(
            tool_command("serial.close", json!({ "session_id": "s" })),
            Ok(SerialCommand::Close { .. })
        ));
        assert!(matches!(
            tool_command(
                "serial.configure",
                json!({ "config": serde_json::to_value(crate::command::SerialConfig::default()).unwrap(), "reopen": false })
            ),
            Ok(SerialCommand::Configure { .. })
        ));
    }

    #[test]
    fn file_defaults_are_bounded() {
        let command = tool_command(
            "serial.send_file",
            json!({ "session_id": "s", "file_path": "a.bin" }),
        )
        .unwrap();
        match command {
            SerialCommand::SendFile {
                protocol,
                chunk_size,
                interval_ms,
                ..
            } => {
                assert_eq!(protocol, FileTransferProtocol::Null);
                assert_eq!(chunk_size, 256);
                assert_eq!(interval_ms, 10);
            }
            _ => panic!("unexpected command"),
        }
    }

    #[test]
    fn decodes_automation_and_waveform_tools() {
        assert!(matches!(
            tool_command(
                "serial.send_batch",
                json!({ "session_id": "s", "items": [] })
            ),
            Ok(SerialCommand::SendBatch { .. })
        ));
        assert!(matches!(
            tool_command(
                "serial.wait_for_any",
                json!({ "session_id": "s", "after_cursor": 0, "conditions": [], "timeout_ms": 1 })
            ),
            Ok(SerialCommand::WaitForAny { .. })
        ));
        assert!(matches!(
            tool_command("waveform.list_channels", json!({})),
            Ok(SerialCommand::WaveformListChannels)
        ));
        assert!(matches!(
            tool_command(
                "waveform.add_channel",
                json!({ "name": "X1", "color": "#61d792", "enabled": true })
            ),
            Ok(SerialCommand::WaveformAddChannel { .. })
        ));
    }

    #[tokio::test]
    async fn tool_call_uses_serial_core() {
        let core = SerialCore::new(Arc::new(MockSerialAdapter));
        let response = handle_request(&core, json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": { "name": "serial.list_ports", "arguments": {} } })).await.unwrap();
        assert_eq!(
            response["result"]["structuredContent"]["ports"][0]["is_mock"],
            true
        );
    }
}
