use async_trait::async_trait;
use tokio::sync::mpsc;

use crate::command::{CoreError, PortInfo, SerialConfig};

/// This boundary is the sole route to a physical serial implementation.
pub struct AdapterConnection {
    pub incoming: mpsc::Receiver<Vec<u8>>,
    pub outgoing: mpsc::Sender<Vec<u8>>,
}

#[async_trait]
pub trait SerialAdapter: Send + Sync {
    async fn list_ports(&self) -> Result<Vec<PortInfo>, CoreError>;
    async fn open(&self, config: &SerialConfig) -> Result<AdapterConnection, CoreError>;
}
