# SerialPilot

SerialPilot is a cross-platform desktop AI serial assistant. The first slice runs entirely against a clearly labelled **Mock serial adapter**, so it can be developed and tested without a physical device.

## Architecture

- `src-tauri/src/serial`: the only layer that owns serial adapters and the continuous receive loop.
- `src-tauri/src/command.rs`: the single command/event contract. Tauri UI commands and MCP tool calls both call `SerialCore::execute`.
- `src-tauri/src/mcp.rs`: the shared MCP tool catalogue, JSON-RPC handling, argument validation, and command decoding used by both transports.
- `src-tauri/src/bin/serialpilot-mcp.rs`: a JSON-RPC MCP-compatible stdio server. Diagnostic output uses stderr only.
- `src`: React UI. It receives `serial-event` notifications from the Rust core; it does not access serial devices.

The receive loop starts as part of `serial.open`, appends immutable raw-byte frames to a bounded buffer, and continues independently of reads. `read_since`, `wait_for`, and `exchange` read that buffer by cursor. `exchange` captures the cursor before sending, so a fast response cannot arrive before its wait begins.

The first slice keeps a maximum 64 KiB unified session buffer for TX/RX frames. When the limit is exceeded, the oldest frames are evicted automatically and counted in `dropped_frames`; readers whose cursor falls behind receive an explicit `cursor_expired`/`dropped` result instead of silently losing data. The UI shows current buffer usage against its limit.

File sending uses the same command path as text and HEX sending. The desktop UI opens a native file picker, then sends the selected file as bounded raw-byte chunks with configurable chunk size and inter-chunk delay. Each chunk is recorded as a TX frame and a `file_progress` event updates the progress bar; an active transfer can be cancelled with `serial.cancel_send_file`. The file is streamed by Rust and is never loaded in full by React.

Each command and frame creates one structured `SerialEvent`. The event is emitted to Tauri for UI subscription and retained in a bounded in-memory session audit in this first slice. Durable SQLite session storage is the next persistence increment; it is deliberately not pretended to exist yet.

## Waveform Workspace

The waveform tab derives display-only numeric samples from RX text frames while leaving the core's raw bytes unchanged. It does not auto-detect or invent channels: users add each channel explicitly with a name, line color, and enabled state. RX frames use case-sensitive named pairs, such as `X1=100,X2=200\r\n`; the parser maps a value only when its name exactly matches a configured channel.

The toolbar can pause only waveform display, clear only waveform history, configure channel mappings, choose the per-channel display window, and turn latest-point markers on or off. A changed channel configuration clears derived samples so data captured under two different mappings never mixes. Mock emits a deterministic 12-frame `X1=100,X2=200,X3=24\r\n`-style sequence every 250 ms so the configured channels visibly move while testing.

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

Use the `MCP` status button in the desktop title bar to open MCP settings. Its gray/green status dot shows whether the loopback-only HTTP service is stopped or running. The service lives inside the desktop process; its tool calls use the same serial core, current session, RX buffer, and event stream as the UI.

For a standalone MCP process using the Mock adapter:

```bash
cargo run --manifest-path src-tauri/Cargo.toml --bin serialpilot-mcp
```

Send newline-delimited JSON-RPC requests on stdin. Protocol responses are written to stdout; logs are written only to stderr.

The MCP tool catalogue includes the core serial tools plus bounded automation tools: `serial.send_batch`, `serial.exchange_batch`, `serial.wait_for_any`, `serial.monitor_ports`, and `serial.reconnect`. Waveform tools are `waveform.list_channels`, `waveform.add_channel`, `waveform.update_channel`, `waveform.remove_channel`, and `waveform.clear_samples`. File transfer accepts `null`, `xmodem`, `xmodem-1k`, and `ymodem`; batch sizes, monitor duration, and wait timeouts are bounded by the Rust core.

Waveform channel tools update the same channel state used by the desktop waveform view. Channel names such as `X1`, `X2`, and `X3` are matched against named RX values; clearing waveform samples only clears the derived display projection and never deletes raw RX frames.

For MCP Streamable HTTP, which is the recommended remote transport for this project:

```bash
cargo run --manifest-path src-tauri/Cargo.toml --bin serialpilot-mcp-http
```

It listens on `http://127.0.0.1:3030/mcp` by default. Set `SERIALPILOT_MCP_ADDR=127.0.0.1:PORT` to change the bind address. The endpoint accepts JSON-RPC `initialize`, `ping`, `tools/list`, and `tools/call` POST requests; `/health` provides a simple local liveness check. SSE is deliberately not used in this slice: tool calls return synchronous structured results, while live UI updates remain a local Tauri event stream.

## First-slice limitation

The included adapter is intentionally Mock-only. It echoes each outbound payload after a short delay, prefixed by `aa55`. A future `SerialAdapter` implementation can use a cross-platform physical serial crate without changing UI or MCP command paths.
