//! Real operating-system serial adapter used by the desktop application.
//! Enumeration and device I/O stay behind the `SerialAdapter` boundary so the
//! command, event, MCP, and UI layers do not depend on a serial-port crate.

use std::{
    io::{Read, Write},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};

use async_trait::async_trait;
use serialport::{
    DataBits, FlowControl, Parity, SerialPort, SerialPortInfo, SerialPortType, StopBits,
};
use tokio::sync::mpsc;

use crate::{
    command::{CoreError, PortInfo, SerialConfig},
    serial::{AdapterConnection, SerialAdapter},
};

const RX_IDLE_FRAME_TIMEOUT: Duration = Duration::from_millis(15);
const MAX_RX_FRAME_BYTES: usize = 4096;

#[derive(Default)]
pub struct PhysicalSerialAdapter;

#[async_trait]
impl SerialAdapter for PhysicalSerialAdapter {
    async fn list_ports(&self) -> Result<Vec<PortInfo>, CoreError> {
        serialport::available_ports()
            .map(|ports| {
                ports
                    .into_iter()
                    .map(|port| PortInfo {
                        id: port.port_name.clone(),
                        display_name: format_port_display_name(&port),
                        is_mock: false,
                    })
                    .collect()
            })
            .map_err(|error| {
                CoreError::Adapter(format!("unable to enumerate serial ports: {error}"))
            })
    }

    async fn open(&self, config: &SerialConfig) -> Result<AdapterConnection, CoreError> {
        if config.port.starts_with("mock://") || config.port.trim().is_empty() {
            return Err(CoreError::PortNotFound(config.port.clone()));
        }
        let mut port = serialport::new(&config.port, config.baud_rate)
            .data_bits(parse_data_bits(config.data_bits)?)
            .parity(parse_parity(&config.parity)?)
            .stop_bits(parse_stop_bits(config.stop_bits)?)
            .flow_control(parse_flow_control(&config.flow_control)?)
            .timeout(RX_IDLE_FRAME_TIMEOUT)
            .open()
            .map_err(|error| {
                CoreError::Adapter(format!("unable to open {}: {error}", config.port))
            })?;
        if config.dtr {
            port.write_data_terminal_ready(true)
                .map_err(adapter_error)?;
        }
        if config.rts {
            port.write_request_to_send(true).map_err(adapter_error)?;
        }

        let read_port = port.try_clone().map_err(adapter_error)?;
        let (outgoing, mut writes) = mpsc::channel::<Vec<u8>>(64);
        let (incoming_tx, incoming) = mpsc::channel::<Vec<u8>>(64);
        let shutdown = Arc::new(AtomicBool::new(false));
        let runtime = tokio::runtime::Handle::current();
        let reader_shutdown = shutdown.clone();
        let reader_worker =
            std::thread::spawn(move || run_reader(read_port, incoming_tx, reader_shutdown));
        let writer_shutdown = shutdown.clone();
        let writer_worker = std::thread::spawn(move || {
            let mut write_port = port;
            while let Some(payload) = runtime.block_on(writes.recv()) {
                if writer_shutdown.load(Ordering::Acquire) {
                    break;
                }
                if write_port.write_all(&payload).is_err() {
                    break;
                }
                if write_port.flush().is_err() {
                    break;
                }
            }
        });
        Ok(AdapterConnection {
            incoming,
            outgoing,
            shutdown: Some(shutdown),
            workers: vec![reader_worker, writer_worker],
        })
    }
}

fn format_port_display_name(port: &SerialPortInfo) -> String {
    let description = match &port.port_type {
        SerialPortType::UsbPort(info) => info.product.as_deref().or(info.manufacturer.as_deref()),
        _ => None,
    }
    .map(|value| trim_port_suffix(value, &port.port_name))
    .filter(|value| !value.is_empty());

    description
        .map(|value| format!("{} · {}", port.port_name, value))
        .unwrap_or_else(|| port.port_name.clone())
}

fn trim_port_suffix(description: &str, port_name: &str) -> String {
    let trimmed = description.trim();
    let Some(opening) = trimmed.rfind('(') else {
        return trimmed.to_string();
    };
    let Some(closing) = trimmed[opening..].find(')') else {
        return trimmed.to_string();
    };
    let closing = opening + closing;
    if trimmed[opening + 1..closing]
        .trim()
        .eq_ignore_ascii_case(port_name)
        && trimmed[closing + 1..].trim().is_empty()
    {
        return trimmed[..opening].trim().to_string();
    }
    trimmed.to_string()
}

fn run_reader(
    mut port: Box<dyn SerialPort>,
    incoming_tx: mpsc::Sender<Vec<u8>>,
    shutdown: Arc<AtomicBool>,
) {
    let mut read_buffer = [0_u8; MAX_RX_FRAME_BYTES];
    let mut pending = Vec::with_capacity(MAX_RX_FRAME_BYTES);
    loop {
        if shutdown.load(Ordering::Acquire) {
            break;
        }
        match port.read(&mut read_buffer) {
            Ok(size) if size > 0 => {
                pending.extend_from_slice(&read_buffer[..size]);
                if pending.len() >= MAX_RX_FRAME_BYTES && !flush_pending(&mut pending, &incoming_tx)
                {
                    break;
                }
            }
            Ok(_) => {}
            // A serial read chunk is not a message boundary. A short idle interval joins
            // immediately adjacent chunks without waiting indefinitely for a delimiter.
            Err(error) if error.kind() == std::io::ErrorKind::TimedOut => {
                if !flush_pending(&mut pending, &incoming_tx) {
                    break;
                }
            }
            Err(_) => {
                flush_pending(&mut pending, &incoming_tx);
                break;
            }
        }
    }
}

fn flush_pending(pending: &mut Vec<u8>, incoming_tx: &mpsc::Sender<Vec<u8>>) -> bool {
    if pending.is_empty() {
        return true;
    }
    incoming_tx.blocking_send(std::mem::take(pending)).is_ok()
}

fn parse_data_bits(value: u8) -> Result<DataBits, CoreError> {
    match value {
        5 => Ok(DataBits::Five),
        6 => Ok(DataBits::Six),
        7 => Ok(DataBits::Seven),
        8 => Ok(DataBits::Eight),
        _ => Err(CoreError::Adapter(format!(
            "unsupported data bits: {value}"
        ))),
    }
}

fn parse_parity(value: &str) -> Result<Parity, CoreError> {
    match value {
        "none" => Ok(Parity::None),
        "even" => Ok(Parity::Even),
        "odd" => Ok(Parity::Odd),
        _ => Err(CoreError::Adapter(format!("unsupported parity: {value}"))),
    }
}

fn parse_stop_bits(value: u8) -> Result<StopBits, CoreError> {
    match value {
        1 => Ok(StopBits::One),
        2 => Ok(StopBits::Two),
        _ => Err(CoreError::Adapter(format!(
            "unsupported stop bits: {value}"
        ))),
    }
}

fn parse_flow_control(value: &str) -> Result<FlowControl, CoreError> {
    match value {
        "none" => Ok(FlowControl::None),
        "software" => Ok(FlowControl::Software),
        "hardware" => Ok(FlowControl::Hardware),
        _ => Err(CoreError::Adapter(format!(
            "unsupported flow control: {value}"
        ))),
    }
}

fn adapter_error(error: serialport::Error) -> CoreError {
    CoreError::Adapter(error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trims_repeated_port_suffix_from_windows_description() {
        assert_eq!(
            trim_port_suffix("USB-SERIAL CH340 (COM3)", "COM3"),
            "USB-SERIAL CH340"
        );
        assert_eq!(
            trim_port_suffix("USB-SERIAL CH340", "COM3"),
            "USB-SERIAL CH340"
        );
    }

    #[test]
    fn batches_adjacent_read_chunks_before_the_idle_boundary() {
        let mut pending = Vec::new();
        pending.extend_from_slice(b"1231231");
        pending.extend_from_slice(b"2");
        assert_eq!(pending, b"12312312");
    }
}
