//! Desktop serial adapter for physical hardware.
//! The adapter boundary remains shared by the UI, MCP, and session logging paths.

use async_trait::async_trait;

use crate::{
    command::{CoreError, PortInfo, SerialConfig},
    serial::{AdapterConnection, PhysicalSerialAdapter, SerialAdapter},
};

#[derive(Default)]
pub struct DesktopSerialAdapter {
    physical: PhysicalSerialAdapter,
}

#[async_trait]
impl SerialAdapter for DesktopSerialAdapter {
    async fn list_ports(&self) -> Result<Vec<PortInfo>, CoreError> {
        self.physical.list_ports().await
    }

    async fn open(&self, config: &SerialConfig) -> Result<AdapterConnection, CoreError> {
        self.physical.open(config).await
    }
}
