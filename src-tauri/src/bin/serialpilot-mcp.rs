//! MCP-compatible JSON-RPC over stdio. stdout is reserved for protocol messages.

use std::{
    io::{self, BufRead, Write},
    sync::Arc,
};

use serde_json::{json, Value};
use serialpilot_lib::{command::SerialCore, mcp::handle_request, serial::MockSerialAdapter};

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
                    json!({ "jsonrpc": "2.0", "id": null, "error": { "code": -32700, "message": error.to_string() } }),
                );
                continue;
            }
        };
        if let Some(response) = handle_request(&core, request).await {
            write_message(&mut stdout, response);
        }
    }
}

fn write_message(out: &mut impl Write, message: Value) {
    if let Err(error) = writeln!(out, "{message}") {
        eprintln!("stdout write error: {error}");
        return;
    }
    if let Err(error) = out.flush() {
        eprintln!("stdout flush error: {error}");
    }
}
