//! Desktop serial adapter for physical hardware.
//! Debug builds additionally expose the Mock loopback adapter for repeatable
//! development tests; release builds only enumerate and open physical ports.

use async_trait::async_trait;

use crate::{
    command::{CoreError, PortInfo, SerialConfig},
    serial::{AdapterConnection, PhysicalSerialAdapter, SerialAdapter},
};

#[cfg(debug_assertions)]
use crate::serial::mock::{MockSerialAdapter, MOCK_LOOPBACK_PORT_ID};

#[derive(Default)]
pub struct DesktopSerialAdapter {
    physical: PhysicalSerialAdapter,
    #[cfg(debug_assertions)]
    mock: MockSerialAdapter,
}

#[async_trait]
impl SerialAdapter for DesktopSerialAdapter {
    async fn list_ports(&self) -> Result<Vec<PortInfo>, CoreError> {
        let ports = self.physical.list_ports().await?;
        #[cfg(debug_assertions)]
        {
            let mut ports = ports;
            ports.extend(self.mock.list_ports().await?);
            return Ok(ports);
        }
        #[cfg(not(debug_assertions))]
        Ok(ports)
    }

    async fn open(&self, config: &SerialConfig) -> Result<AdapterConnection, CoreError> {
        #[cfg(debug_assertions)]
        if config.port == MOCK_LOOPBACK_PORT_ID {
            return self.mock.open(config).await;
        }
        self.physical.open(config).await
    }
}
