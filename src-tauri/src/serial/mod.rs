pub mod adapter;
pub mod mock;

pub use adapter::{AdapterConnection, SerialAdapter};
pub use mock::MockSerialAdapter;
