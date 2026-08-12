//! Streamable HTTP transport for MCP. The endpoint is separate from Tauri UI traffic.

use std::{net::SocketAddr, sync::Arc};

use axum::{
    extract::State,
    http::StatusCode,
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use serde_json::{json, Value};
use serialpilot_lib::{command::SerialCore, mcp::handle_request, serial::MockSerialAdapter};

#[derive(Clone)]
struct McpState(Arc<SerialCore>);

#[tokio::main]
async fn main() {
    let state = McpState(Arc::new(SerialCore::new(Arc::new(MockSerialAdapter))));
    let app = Router::new()
        .route("/mcp", post(mcp))
        .route("/health", get(health))
        .with_state(state);
    let address: SocketAddr = std::env::var("SERIALPILOT_MCP_ADDR")
        .unwrap_or_else(|_| "127.0.0.1:3030".into())
        .parse()
        .unwrap_or_else(|error| {
            eprintln!("invalid SERIALPILOT_MCP_ADDR: {error}");
            std::process::exit(2);
        });
    eprintln!("SerialPilot MCP Streamable HTTP (Mock adapter) listening on http://{address}/mcp");
    let listener = match tokio::net::TcpListener::bind(address).await {
        Ok(listener) => listener,
        Err(error) => {
            eprintln!("failed to bind MCP HTTP address: {error}");
            return;
        }
    };
    if let Err(error) = axum::serve(listener, app).await {
        eprintln!("MCP HTTP server failed: {error}");
    }
}

async fn health() -> impl IntoResponse {
    (StatusCode::OK, Json(json!({ "status": "ok" })))
}

async fn mcp(State(state): State<McpState>, Json(request): Json<Value>) -> impl IntoResponse {
    match handle_request(&state.0, request).await {
        Some(response) => (StatusCode::OK, Json(response)),
        None => (StatusCode::NO_CONTENT, Json(Value::Null)),
    }
}
