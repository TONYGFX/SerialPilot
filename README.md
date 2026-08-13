<p align="center">
  <img src="src-tauri/icons/icon.png" alt="SerialPilot Logo" width="128" />
</p>

<h1 align="center">SerialPilot</h1>

<p align="center">跨平台桌面端 AI 串口助手</p>

<p align="center">
  <a href="https://github.com/TONYGFX/SerialPilot">GitHub</a>
  ·
  <a href="LICENSE">MIT License</a>
</p>

SerialPilot 面向嵌入式开发、硬件调试和串口自动化场景。它将可靠的 Rust 串口核心、专业桌面工作区和 MCP 工具接口组合在一起，让用户和 AI 都通过同一套结构化命令操作串口。

## 产品特点

- 原生桌面工作区：可调整大小的配置栏、终端日志区和波形工作区，窗口变化时自动填充客户区。
- 可靠串口核心：后台持续接收、固定容量 RX 缓冲、游标读取、超时等待和请求-响应事务。
- 完整数据保留：发送和接收均保留原始字节，同时提供文本、HEX 和 Base64 数据处理。
- 多通道波形：自定义通道名称和颜色，支持跟随最新数据、拖拽平移、横轴缩放和悬浮查看采样值。
- 文件发送：支持文件选择、传输协议选择、进度显示、取消传输和 TXT 数据保存。
- AI 原生控制：MCP 通过结构化工具完成端口选择、配置、发送、接收和波形通道管理。
- 深色、浅色和跟随系统主题。

## 截图

项目界面以紧凑的桌面工作区为核心，适合连续接收、对比日志和调试设备状态。

## 架构

```text
React UI ─┐
MCP      ─┼─> 统一 Command / Event ─> Rust SerialCore ─> SerialAdapter ─> 串口设备
审计记录 ─┘
```

- 前端不直接访问物理串口。
- MCP 不绕过串口核心访问硬件。
- 只有 Rust 串口适配器可以访问物理串口。
- 串口打开后，后台读取任务持续运行；`read_since`、`wait_for` 和 `exchange` 从接收缓冲区读取数据。
- 原始字节、文本显示和波形解析结果分开保存，解析不会覆盖原始数据。
- stdio MCP 的协议消息写入 stdout，诊断日志写入 stderr。

## MCP

SerialPilot 支持两种 MCP 连接方式：

- **stdio**：由 MCP 客户端启动 `serialpilot-mcp`，适合本地桌面 AI 客户端。
- **Streamable HTTP**：启动 `serialpilot-mcp-http`，或在桌面程序设置中启用本机 HTTP 服务。

桌面程序内置 HTTP 服务默认使用：

```text
http://127.0.0.1:3030/mcp
```

核心工具包括：

- 串口：`serial.list_ports`、`serial.open`、`serial.configure`、`serial.status`、`serial.send`
- 接收：`serial.read_since`、`serial.wait_for`、`serial.exchange`
- 批量和连接：`serial.send_batch`、`serial.exchange_batch`、`serial.wait_for_any`、`serial.monitor_ports`、`serial.reconnect`
- 波形：`waveform.list_channels`、`waveform.add_channel`、`waveform.update_channel`、`waveform.remove_channel`、`waveform.clear_samples`

当前 HTTP 实现使用 Streamable HTTP，不使用 SSE；SSE/实时事件流仅用于桌面端内部状态同步。

## 下载与运行

Windows 用户下载发布页中的 `serialpilot.exe` 即可运行。`serialpilot-mcp.exe` 和 `serialpilot-mcp-http.exe` 是给需要独立 MCP 服务的用户使用的辅助程序，不是桌面 UI。

当前版本：**v0.1.2**

## 从源码运行

开发环境需要：

- Node.js 20+
- Rust stable 和 Cargo
- Windows WebView2 与 Tauri 2 构建依赖

```bash
npm install
npm run tauri dev
```

常用验证命令：

```bash
npm run build
npm test -- --run
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo test --manifest-path src-tauri/Cargo.toml
```

## 项目结构

```text
src/                 React、TypeScript 界面与前端状态投影
src-tauri/src/       Rust 串口核心、命令、事件和 MCP 服务
src-tauri/src/serial/  串口适配器，包括真实适配器和测试 Mock
docs/                发布说明与架构文档
tests/               自动化测试（按模块放置在 src/ 与 Rust 模块旁）
```

## 已知限制

- 不同操作系统和设备驱动对串口控制线、独占访问等能力的支持可能不同。
- 本地会话审计目前主要保留在内存中，SQLite 持久化将在后续版本完善。
- Mock 适配器仅用于开发和自动化测试，不进入正常发行版运行路径。

## 许可证

本项目采用 [MIT License](LICENSE) 开源。

Copyright (c) 2026 TONYGFX
