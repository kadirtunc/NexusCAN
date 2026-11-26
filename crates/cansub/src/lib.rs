//! # cansub — Rust SDK for CSS Electronics CANsub.2 / CANsub.4
//!
//! Layers (contract `planning/contracts/cansub-v1.md`):
//!
//! | Module | Feature | `no_std` | Content |
//! |---|---|---|---|
//! | [`proto`] | — | yes, no alloc | HDLC + CRC32 stream decoder / encoder, `proto::CanFrame`, DLC tables |
//! | [`timing`] | — | yes | bitrate → `brp/seg1/seg2/sjw` for the 80 MHz CAN clock |
//! | [`certs`] | — | yes | pinned CSS Electronics root CA |
//! | `client` | `blocking` | no | TLS 1.2 + REST + WSS device / channel client |
//! | `discovery` | `discovery` | no | mDNS `_cansub._tcp` browser |
//! | `sim` | `sim` | no | device emulator (`cansub-sim`) |
//!
//! Wire format reference: CSS Electronics CANsub API docs (API 05.x) and the MIT-licensed
//! `CSS-Electronics/c-cpp-sdk-cansub` reference implementation.
#![cfg_attr(not(feature = "std"), no_std)]
#![forbid(unsafe_code)]
#![warn(missing_docs)]

pub mod certs;
pub mod proto;
pub mod timing;

#[cfg(feature = "blocking")]
pub mod client;
#[cfg(feature = "blocking")]
pub use client::{Channel, ChannelStatus, ConnectOptions, Device, DeviceInfo, Error, PhyConfig};

#[cfg(feature = "discovery")]
pub mod discovery;

#[cfg(feature = "sim")]
pub mod sim;
