//! # nexus-ecu-sim
//!
//! A deliberately **independent** UDS (ISO 14229-1) bootloader ECU simulator.
//! It is the HIL test target for the NexusCAN flasher and must never share
//! code with `nexus-protocols`: the two implementations cross-check each other.
//! The transport is the Linux kernel `CAN_ISOTP` socket, i.e. a third,
//! independent ISO 15765-2 implementation.
//!
//! Module layout:
//! * Pure, platform-independent logic: [`server`] (UDS state machine),
//!   [`memory`], [`faults`], [`seed`], [`crc`], [`image`], [`firmware`]
//!   (Intel HEX / S-record / binary parser), [`functional`] (Single-Frame
//!   decoder for functional requests) and [`config`] (CLI value parsers).
//! * Linux-only transport + runtime: [`isotp`], [`rawcan`], [`runtime`], [`log`].

pub mod config;
pub mod crc;
pub mod faults;
pub mod firmware;
pub mod functional;
pub mod image;
pub mod memory;
pub mod seed;
pub mod server;

#[cfg(target_os = "linux")]
pub mod isotp;
#[cfg(target_os = "linux")]
pub mod log;
#[cfg(target_os = "linux")]
pub mod rawcan;
#[cfg(target_os = "linux")]
pub mod runtime;
