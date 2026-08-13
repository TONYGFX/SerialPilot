pub mod adapter;
pub mod physical;

#[cfg(test)]
pub mod mock;

pub use adapter::{AdapterConnection, SerialAdapter};
pub use physical::PhysicalSerialAdapter;
