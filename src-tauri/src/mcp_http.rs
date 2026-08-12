//! Reusable local HTTP transport for the SerialPilot MCP server.
//!
//! The desktop process uses this module to expose the already-running serial
//! core. The standalone MCP HTTP binary uses the same module with its own core.

use std::{net::SocketAddr, sync::Arc};

use axum::{
    extract::State,
    http::StatusCode,
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::{
    sync::oneshot,
    task::JoinHandle,
    time::{timeout, Duration},
};

use crate::{command::SerialCore, mcp::handle_request};

/// User-configurable local HTTP MCP service options.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct McpHttpConfig {
    pub enabled: bool,
    pub port: u16,
}

impl Default for McpHttpConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            port: 3030,
        }
    }
}

/// Observable HTTP MCP runtime state returned to the desktop UI.
#[derive(Debug, Clone, Serialize)]
pub struct McpHttpStatus {
    pub enabled: bool,
    pub endpoint: Option<String>,
}

impl McpHttpStatus {
    fn stopped() -> Self {
        Self {
            enabled: false,
            endpoint: None,
        }
    }
}

#[derive(Clone)]
struct McpState(Arc<SerialCore>);

/// A running loopback-only MCP HTTP server with a graceful shutdown signal.
pub struct McpHttpServer {
    address: SocketAddr,
    shutdown: Option<oneshot::Sender<()>>,
    task: JoinHandle<()>,
}

impl McpHttpServer {
    /// Starts a loopback-only MCP server over the supplied serial core.
    ///
    /// @param core Shared serial command core used by both the UI and MCP.
    /// @param port TCP port in the user-safe range 1024 through 65535.
    /// @return A server handle or an address/bind error.
    pub async fn start(core: Arc<SerialCore>, port: u16) -> Result<Self, String> {
        validate_port(port)?;
        let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port))
            .await
            .map_err(|error| format!("unable to bind MCP HTTP port {port}: {error}"))?;
        let address = listener
            .local_addr()
            .map_err(|error| format!("unable to read MCP HTTP address: {error}"))?;
        let app = Router::new()
            .route("/mcp", post(mcp))
            .route("/health", get(health))
            .with_state(McpState(core));
        let (shutdown, shutdown_received) = oneshot::channel();
        let task = tokio::spawn(async move {
            let result = axum::serve(listener, app)
                .with_graceful_shutdown(async {
                    let _ = shutdown_received.await;
                })
                .await;
            if let Err(error) = result {
                eprintln!("MCP HTTP server failed: {error}");
            }
        });

        Ok(Self {
            address,
            shutdown: Some(shutdown),
            task,
        })
    }

    /// Returns the endpoint advertised to local MCP clients.
    pub fn status(&self) -> McpHttpStatus {
        McpHttpStatus {
            enabled: true,
            endpoint: Some(format!("http://{}/mcp", self.address)),
        }
    }

    /// Stops the server, aborting only if graceful shutdown does not finish promptly.
    pub async fn stop(mut self) {
        if let Some(shutdown) = self.shutdown.take() {
            let _ = shutdown.send(());
        }
        if timeout(Duration::from_secs(1), &mut self.task)
            .await
            .is_err()
        {
            self.task.abort();
        }
    }
}

/// Applies local HTTP MCP settings to a server runtime without touching serial state.
pub async fn configure_server(
    server: &tokio::sync::Mutex<Option<McpHttpServer>>,
    core: Arc<SerialCore>,
    config: McpHttpConfig,
) -> Result<McpHttpStatus, String> {
    let previous = server.lock().await.take();
    if let Some(previous) = previous {
        previous.stop().await;
    }
    if !config.enabled {
        return Ok(McpHttpStatus::stopped());
    }

    let server_handle = McpHttpServer::start(core, config.port).await?;
    let status = server_handle.status();
    *server.lock().await = Some(server_handle);
    Ok(status)
}

fn validate_port(port: u16) -> Result<(), String> {
    if (1024..=65535).contains(&port) {
        Ok(())
    } else {
        Err("MCP HTTP port must be between 1024 and 65535".into())
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_allows_non_privileged_ports() {
        assert!(validate_port(3030).is_ok());
        assert!(validate_port(1023).is_err());
    }
}
