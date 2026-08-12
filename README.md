# SerialPilot

SerialPilot 是一个跨平台桌面端 AI 串口助手。它使用 Tauri 2、React、TypeScript 和 Rust 构建，串口核心、UI 和 MCP 共享同一套结构化命令与事件路径。

> 当前发布版使用明确标注的 Mock 串口适配器进行演示和开发，尚未接入真实物理串口驱动。

## 功能

- 桌面端串口工作区：端口、波特率、数据位、校验位、停止位和流控配置。
- 文本、HEX、Base64 发送，以及文件发送进度和取消。
- TX/RX 实时日志，支持暂停、清空、显示格式切换和接收数据保存。
- 后台接收任务、游标读取、固定容量 RX 缓冲和丢弃帧提示。
- 有界的 `wait_for`、`exchange`、批量发送和批量事务操作。
- 多通道波形：自定义通道名称和颜色，悬浮查看采样值，拖拽/滚轮平移，`Ctrl + 滚轮` 缩放横轴，一键跟随最新数据。
- MCP 工具：串口控制和波形通道控制均经过 Rust 串口核心，不绕过核心访问硬件。
- MCP stdio 和 Streamable HTTP 两种独立服务；桌面程序内置 HTTP 服务开关。
- 深色和浅色桌面主题。

## 架构边界

```text
React UI ─┐
MCP      ─┼─> 统一 Command/Event ─> Rust SerialCore ─> SerialAdapter
审计记录 ─┘
```

- 前端不直接访问物理串口。
- MCP 不绕过串口核心。
- 只有 Rust 串口适配器可以访问串口设备。
- 串口打开后，后台读取任务持续运行；`read_since`、`wait_for` 和 `exchange` 都从接收缓冲区读取。
- 原始字节、文本显示和波形解析结果分开保存，解析不会覆盖原始数据。
- stdio MCP 的日志只写入 stderr，不污染 stdout 协议流。

## 快速开始

### 开发环境

需要 Node.js 20+、Rust stable、Cargo 和 Tauri 2 在 Windows 上所需的 WebView2/构建依赖。

```bash
npm install
npm run tauri dev
```

前端单独运行：

```bash
npm run dev
```

### 验证

```bash
npm run build
npm test -- --run
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo test --manifest-path src-tauri/Cargo.toml
```

## MCP

桌面窗口右上角的 MCP 状态按钮用于启动和停止内置 HTTP 服务。独立服务可使用：

```bash
cargo run --manifest-path src-tauri/Cargo.toml --bin serialpilot-mcp
cargo run --manifest-path src-tauri/Cargo.toml --bin serialpilot-mcp-http
```

HTTP 服务默认监听 `http://127.0.0.1:3030/mcp`，可通过 `SERIALPILOT_MCP_ADDR=127.0.0.1:PORT` 修改地址。当前 HTTP 实现使用 Streamable HTTP，不使用 SSE；SSE/实时界面更新由桌面端本地事件流承担。

核心工具包括：

- `serial.list_ports`、`serial.open`、`serial.status`、`serial.send`
- `serial.read_since`、`serial.wait_for`、`serial.exchange`
- `serial.send_batch`、`serial.exchange_batch`、`serial.wait_for_any`
- `serial.monitor_ports`、`serial.reconnect`
- `waveform.list_channels`、`waveform.add_channel`、`waveform.update_channel`
- `waveform.remove_channel`、`waveform.clear_samples`

## Windows 发布版

普通用户只需要桌面程序：

```text
src-tauri/target/release/serialpilot.exe
```

`serialpilot-mcp.exe` 是 MCP stdio 服务，`serialpilot-mcp-http.exe` 是独立 MCP HTTP 服务；它们不是桌面 UI，只有需要独立 MCP 进程时才使用。

当前发布版本：`0.1.0`

## Mock 数据

Mock 适配器会持续生成带名称的数值帧，例如：

```text
X1=100,X2=200,X3=24\r\n
```

因此可以在没有硬件的情况下测试发送、接收、游标、MCP 和波形功能。替换为真实跨平台串口适配器时，不需要改变 UI 或 MCP 命令路径。

## 已知限制

- 当前没有真实物理串口适配器。
- 本地会话审计暂存于内存，尚未接入 SQLite 持久化。
- 安装包生成依赖 Windows WiX/NSIS 工具链；没有安装工具时可直接运行 Release EXE。

## 许可证

项目许可证尚未确定。
