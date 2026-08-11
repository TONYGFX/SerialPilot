use std::time::Duration;

use async_trait::async_trait;
use tokio::sync::mpsc;

use crate::{
    command::{CoreError, PortInfo, SerialConfig},
    serial::{AdapterConnection, SerialAdapter},
};

/// Development-only adapter. It has no access to a physical serial device.
#[derive(Default)]
pub struct MockSerialAdapter;

#[async_trait]
impl SerialAdapter for MockSerialAdapter {
    async fn list_ports(&self) -> Result<Vec<PortInfo>, CoreError> {
        Ok(vec![PortInfo {
            id: "mock://loopback-01".into(),
            display_name: "Mock Loopback (development only)".into(),
            is_mock: true,
        }])
    }

    async fn open(&self, config: &SerialConfig) -> Result<AdapterConnection, CoreError> {
        if config.port != "mock://loopback-01" {
            return Err(CoreError::PortNotFound(config.port.clone()));
        }

        let (outgoing, mut writes) = mpsc::channel::<Vec<u8>>(64);
        let (incoming_tx, incoming) = mpsc::channel::<Vec<u8>>(64);
        let sample_tx = incoming_tx.clone();
        tokio::spawn(async move {
            while let Some(payload) = writes.recv().await {
                tokio::time::sleep(Duration::from_millis(8)).await;
                let mut response = vec![0xaa, 0x55];
                response.extend(payload);
                if incoming_tx.send(response).await.is_err() {
                    break;
                }
            }
        });
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_millis(250)).await;
                if sample_tx.send(b"100\n".to_vec()).await.is_err() {
                    break;
                }
            }
        });

        Ok(AdapterConnection { incoming, outgoing })
    }
}
