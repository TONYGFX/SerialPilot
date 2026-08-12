use std::time::Duration;

use async_trait::async_trait;
use tokio::sync::mpsc;

use crate::{
    command::{CoreError, PortInfo, SerialConfig},
    serial::{AdapterConnection, SerialAdapter},
};

const MULTI_CHANNEL_SAMPLES: &[&[u8]] = &[
    b"X1=100,X2=52,X3=24\r\n",
    b"X1=102,X2=54,X3=24.4\r\n",
    b"X1=106,X2=58,X3=25.1\r\n",
    b"X1=110,X2=61,X3=26\r\n",
    b"X1=108,X2=60,X3=25.6\r\n",
    b"X1=104,X2=56,X3=25\r\n",
    b"X1=98,X2=50,X3=23.8\r\n",
    b"X1=95,X2=47,X3=23.2\r\n",
    b"X1=97,X2=49,X3=23.5\r\n",
    b"X1=101,X2=53,X3=24.2\r\n",
    b"X1=105,X2=57,X3=25\r\n",
    b"X1=109,X2=60,X3=25.8\r\n",
];

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
        let handshake_tx = incoming_tx.clone();
        tokio::spawn(async move {
            // Keep the protocol handshake outside the normal send/read test window.
            tokio::time::sleep(Duration::from_millis(80)).await;
            let _ = handshake_tx.send(vec![0x43]).await;
        });
        let sample_tx = incoming_tx.clone();
        tokio::spawn(async move {
            let mut ymodem_header_seen = false;
            while let Some(payload) = writes.recv().await {
                tokio::time::sleep(Duration::from_millis(8)).await;
                let is_packet = matches!(payload.first(), Some(0x01 | 0x02));
                let is_ymodem_header = is_packet && payload.get(1) == Some(&0);
                let mut response = if is_packet || payload == [0x04] {
                    vec![0x06]
                } else {
                    vec![0xaa, 0x55]
                };
                if response[0] == 0xaa {
                    response.extend(payload);
                }
                if incoming_tx.send(response).await.is_err() {
                    break;
                }
                if is_ymodem_header && !ymodem_header_seen {
                    ymodem_header_seen = true;
                    tokio::time::sleep(Duration::from_millis(2)).await;
                    if incoming_tx.send(vec![0x43]).await.is_err() {
                        break;
                    }
                }
            }
        });
        tokio::spawn(async move {
            let mut sample_index = 0usize;
            loop {
                tokio::time::sleep(Duration::from_millis(250)).await;
                let sample = MULTI_CHANNEL_SAMPLES[sample_index % MULTI_CHANNEL_SAMPLES.len()];
                sample_index += 1;
                if sample_tx.send(sample.to_vec()).await.is_err() {
                    break;
                }
            }
        });

        Ok(AdapterConnection { incoming, outgoing })
    }
}
