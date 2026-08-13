//! Desktop serial adapter routing for production hardware and Debug-only simulation.
//! The Mock route exists only in Debug builds, while the physical adapter remains
//! the sole implementation included in Release binaries.

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
        #[cfg(debug_assertions)]
        let mut ports = self.physical.list_ports().await?;
        #[cfg(not(debug_assertions))]
        let ports = self.physical.list_ports().await?;
        #[cfg(debug_assertions)]
        ports.extend(self.mock.list_ports().await?);
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
