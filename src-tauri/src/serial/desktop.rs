//! Desktop serial adapter routing for physical hardware and the temporary Mock device.
//! Both routes use the same adapter boundary, preserving the shared command and
//! event behavior for UI, MCP, and session logging.

use async_trait::async_trait;

use crate::{
    command::{CoreError, PortInfo, SerialConfig},
    serial::{
        mock::{MockSerialAdapter, MOCK_LOOPBACK_PORT_ID},
        AdapterConnection, PhysicalSerialAdapter, SerialAdapter,
    },
};

#[derive(Default)]
pub struct DesktopSerialAdapter {
    physical: PhysicalSerialAdapter,
    mock: MockSerialAdapter,
}

#[async_trait]
impl SerialAdapter for DesktopSerialAdapter {
    async fn list_ports(&self) -> Result<Vec<PortInfo>, CoreError> {
        let mut ports = self.physical.list_ports().await?;
        ports.extend(self.mock.list_ports().await?);
        Ok(ports)
    }

    async fn open(&self, config: &SerialConfig) -> Result<AdapterConnection, CoreError> {
        if config.port == MOCK_LOOPBACK_PORT_ID {
            return self.mock.open(config).await;
        }
        self.physical.open(config).await
    }
}
