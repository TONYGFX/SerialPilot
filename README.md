# SerialPilot

SerialPilot is a cross-platform desktop AI serial assistant. The first slice runs entirely against a clearly labelled **Mock serial adapter**, so it can be developed and tested without a physical device.

## Architecture

- `src-tauri/src/serial`: the only layer that owns serial adapters and the continuous receive loop.
- `src-tauri/src/command.rs`: the single command/event contract. Tauri UI commands and MCP tool calls both call `SerialCore::execute`.
- `src-tauri/src/bin/serialpilot-mcp.rs`: a JSON-RPC MCP-compatible stdio server. Diagnostic output uses stderr only.
- `src`: React UI. It receives `serial-event` notifications from the Rust core; it does not access serial devices.

The receive loop starts as part of `serial.open`, appends immutable raw-byte frames to a bounded buffer, and continues independently of reads. `read_since`, `wait_for`, and `exchange` read that buffer by cursor. `exchange` captures the cursor before sending, so a fast response cannot arrive before its wait begins.

Each command and frame creates one structured `SerialEvent`. The event is emitted to Tauri for UI subscription and retained in a bounded in-memory session audit in this first slice. Durable SQLite session storage is the next persistence increment; it is deliberately not pretended to exist yet.

## Run

After installing the prerequisites (Node 20+ and Rust stable with Tauri 2 system dependencies):

```bash
npm install
npm run tauri dev
```

Core verification:

```bash
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo test --manifest-path src-tauri/Cargo.toml
```

For a standalone MCP process using the Mock adapter:

```bash
cargo run --manifest-path src-tauri/Cargo.toml --bin serialpilot-mcp
```

Send newline-delimited JSON-RPC requests on stdin. Protocol responses are written to stdout; logs are written only to stderr.

For MCP Streamable HTTP, which is the recommended remote transport for this project:

```bash
cargo run --manifest-path src-tauri/Cargo.toml --bin serialpilot-mcp-http
```

It listens on `http://127.0.0.1:3030/mcp` by default. Set `SERIALPILOT_MCP_ADDR=127.0.0.1:PORT` to change the bind address. The endpoint accepts JSON-RPC `initialize`, `tools/list`, and `tools/call` POST requests. SSE is deliberately not used in this slice: tool calls return synchronous structured results, while live UI updates remain a local Tauri event stream.

## First-slice limitation

The included adapter is intentionally Mock-only. It echoes each outbound payload after a short delay, prefixed by `aa55`. A future `SerialAdapter` implementation can use a cross-platform physical serial crate without changing UI or MCP command paths.
