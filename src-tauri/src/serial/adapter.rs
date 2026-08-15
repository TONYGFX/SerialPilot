use async_trait::async_trait;
use std::sync::{atomic::AtomicBool, Arc};
use tokio::sync::mpsc;

use crate::command::{CoreError, FileTransferProtocol, PortInfo, SerialConfig};

/// This boundary is the sole route to a physical serial implementation.
pub struct AdapterConnection {
    pub incoming: mpsc::Receiver<Vec<u8>>,
    pub outgoing: mpsc::Sender<Vec<u8>>,
    /// Development adapters can receive this notification to emulate a device
    /// handshake. Physical adapters leave it unset and never see this hook.
    pub file_transfer_control: Option<mpsc::Sender<FileTransferProtocol>>,
    pub shutdown: Option<Arc<AtomicBool>>,
    pub workers: Vec<std::thread::JoinHandle<()>>,
}

#[async_trait]
pub trait SerialAdapter: Send + Sync {
    async fn list_ports(&self) -> Result<Vec<PortInfo>, CoreError>;
    async fn open(&self, config: &SerialConfig) -> Result<AdapterConnection, CoreError>;
}
