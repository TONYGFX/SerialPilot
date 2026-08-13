pub mod adapter;
pub mod desktop;
pub mod physical;

#[cfg(any(test, debug_assertions))]
pub mod mock;

pub use adapter::{AdapterConnection, SerialAdapter};
pub use desktop::DesktopSerialAdapter;
pub use physical::PhysicalSerialAdapter;
