//! Real operating-system serial adapter used by the desktop application.
//! Enumeration and device I/O stay behind the `SerialAdapter` boundary so the
//! command, event, MCP, and UI layers do not depend on a serial-port crate.

use std::{
    io::{Read, Write},
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
            .timeout(Duration::from_millis(50))
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
        let runtime = tokio::runtime::Handle::current();
        std::thread::spawn(move || run_reader(read_port, incoming_tx));
        std::thread::spawn(move || {
            let mut write_port = port;
            while let Some(payload) = runtime.block_on(writes.recv()) {
                if write_port.write_all(&payload).is_err() {
                    break;
                }
                if write_port.flush().is_err() {
                    break;
                }
            }
        });
        Ok(AdapterConnection { incoming, outgoing })
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

fn run_reader(mut port: Box<dyn SerialPort>, incoming_tx: mpsc::Sender<Vec<u8>>) {
    let mut buffer = [0_u8; 4096];
    loop {
        match port.read(&mut buffer) {
            Ok(size) if size > 0 => {
                // The core owns framing and cursor assignment; the adapter only emits raw chunks.
                if incoming_tx.blocking_send(buffer[..size].to_vec()).is_err() {
                    break;
                }
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::TimedOut => {}
            Err(_) => break,
        }
    }
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
}
