pub mod adapter;
pub mod desktop;
pub mod physical;

pub mod mock;

pub use adapter::{AdapterConnection, SerialAdapter};
pub use desktop::DesktopSerialAdapter;
pub use physical::PhysicalSerialAdapter;
