//! Standalone Streamable HTTP transport for MCP development and integration.

use std::sync::Arc;

use serialpilot_lib::{
    command::SerialCore, mcp_http::McpHttpServer, serial::PhysicalSerialAdapter,
};

#[tokio::main]
async fn main() {
    let port = match http_port() {
        Ok(port) => port,
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(2);
        }
    };
    let core = Arc::new(SerialCore::new(Arc::new(PhysicalSerialAdapter)));
    let server = match McpHttpServer::start(core, port).await {
        Ok(server) => server,
        Err(error) => {
            eprintln!("failed to start MCP HTTP server: {error}");
            return;
        }
    };
    let endpoint = server.status().endpoint.unwrap_or_default();
    eprintln!("SerialPilot MCP Streamable HTTP (physical serial adapter) listening on {endpoint}");
    std::future::pending::<()>().await;
}

fn http_port() -> Result<u16, String> {
    std::env::var("SERIALPILOT_MCP_ADDR")
        .unwrap_or_else(|_| "127.0.0.1:3030".into())
        .parse::<std::net::SocketAddr>()
        .map(|address| address.port())
        .map_err(|error| format!("SERIALPILOT_MCP_ADDR must be host:port: {error}"))
}
