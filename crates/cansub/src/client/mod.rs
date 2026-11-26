//! Blocking TLS 1.2 + REST + WSS client (contract cansub-v1 §3.3), feature `blocking`.
//!
//! * [`Device`] — one CANsub (REST control connection, keep-alive, shared by all threads).
//! * [`Channel`] — one CAN channel WebSocket (`wss://<host>/api/can/{ch}/ws`), streaming RX / TX.
//!
//! TLS (§2.6): TLS 1.2 only, single suite `ECDHE-ECDSA-AES128-GCM-SHA256`, chain pinned to the
//! embedded CSS Electronics root ([`crate::certs::CSS_ROOT_CA_PEM`]); the device identity is checked
//! against the certificate SANs `<device_id>-usb.local` / `<device_id>-eth.local`, so the host may
//! be an IP address when a Device ID is given.
//!
//! REST is a small HTTP/1.1 client on the same rustls stream type (ureq 3 cannot take a custom
//! certificate verifier, contract §3.5 "REST notu").

mod channel;
mod device;
mod rest;
mod tls;
mod ws;

use std::time::Duration;

use serde::Deserialize;

use crate::timing::BitTiming;

pub use channel::Channel;
pub use device::Device;

/// Connection parameters for [`Device::connect`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConnectOptions {
    /// `name[:port]`, `ipv4[:port]` or `[ipv6]:port` (port defaults to 443),
    /// e.g. `"aabbccdd-usb.local"` or `"10.123.45.1"`.
    pub host: String,
    /// Device ID (8 hex digits). When set, the certificate must carry the SAN
    /// `<device_id>-usb.local` or `<device_id>-eth.local` (§2.6 rule 1); the host may be an IP.
    pub device_id: Option<String>,
    /// Without a Device ID: accept any certificate chaining to the CSS root (§2.6 rule 2).
    /// Applications must show this choice with a warning.
    pub accept_any_device: bool,
    /// TCP connect, TLS handshake, WebSocket upgrade and REST request timeout (default 3 s).
    pub timeout: Duration,
}

impl Default for ConnectOptions {
    fn default() -> Self {
        Self {
            host: String::new(),
            device_id: None,
            accept_any_device: false,
            timeout: Duration::from_secs(3),
        }
    }
}

/// Device identity, read once by [`Device::connect`] (`GET /api/version`, `/api/info`, `/api/can`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DeviceInfo {
    /// Device ID, 8 hex digits (`/api/info` `id`).
    pub id: String,
    /// Product variant derived from the channel count: `"CANsub.2"` or `"CANsub.4"`
    /// (`/api/info` has no variant field).
    pub variant: String,
    /// Hardware version `xx.yy` (`hw_ver`).
    pub hw: String,
    /// Firmware version `xx.yy.zz` (`fw_ver`).
    pub fw: String,
    /// REST API version, e.g. `"05.00"` (`/api/version`).
    pub api: String,
    /// Number of CAN channels (2 or 4); channel numbers are `1..=channels`.
    pub channels: u8,
}

/// CAN controller state (`GET /api/can/{ch}` `state`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CanState {
    /// Error-active (normal operation).
    ErrorActive,
    /// Error-warning (an error counter ≥ 96).
    ErrorWarning,
    /// Error-passive (an error counter ≥ 128).
    ErrorPassive,
    /// Bus-off.
    BusOff,
    /// Controller stopped (no WebSocket client on the channel).
    Stopped,
    /// A state value this SDK version does not know.
    #[serde(other)]
    Unknown,
}

/// Channel health (`GET /api/can/{ch}`, OpenAPI `status`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
pub struct ChannelStatus {
    /// Controller state.
    pub state: CanState,
    /// Frame counter.
    pub frame_count: u64,
    /// Frame rate, frames/s.
    pub frame_rate: u64,
    /// Bus load, 0..=100 %.
    pub bus_load: u8,
    /// Receive error counter (REC).
    pub rx_error_count: u32,
    /// Transmit error counter (TEC).
    pub tx_error_count: u32,
    /// Bus error counter.
    pub bus_error_count: u64,
}

/// PHY configuration (`PUT /api/can/{ch}/phy`). All six fields are always sent (the API rejects
/// partial bodies, contract §2.4 C2 note).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PhyConfig {
    /// Listen-only (no ACK, no TX). Default `true` (NexusCAN field-safety rule).
    pub listen_only: bool,
    /// Automatic bus-off recovery. Default `true`.
    pub auto_reset: bool,
    /// Report bus error frames. Default `false`.
    pub error_frames: bool,
    /// Report TX acknowledgements ([`crate::proto::FrameFlags::TX_ACK`]). Default `false`.
    pub tx_ack_frames: bool,
    /// Nominal bit timing. Default 500 kbit/s, 80 % sample point.
    pub timing: BitTiming,
    /// Data-phase bit timing (CAN-FD). Default 2 Mbit/s, 80 % sample point (shared BRP,
    /// [`crate::timing::fd_timing`]).
    pub timing_data: BitTiming,
}

impl Default for PhyConfig {
    fn default() -> Self {
        // == timing::fd_timing(500_000, 2_000_000, 800) (unit-tested below).
        Self {
            listen_only: true,
            auto_reset: true,
            error_frames: false,
            tx_ack_frames: false,
            timing: BitTiming {
                brp: 2,
                seg1: 63,
                seg2: 16,
                sjw: 4,
            },
            timing_data: BitTiming {
                brp: 2,
                seg1: 15,
                seg2: 4,
                sjw: 4,
            },
        }
    }
}

/// Client error.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// TLS setup, handshake or certificate verification failure (§2.6).
    #[error("TLS: {0}")]
    Tls(String),
    /// Non-success HTTP status from the REST API or the WebSocket upgrade.
    #[error("HTTP {status}: {body}")]
    Http {
        /// HTTP status code.
        status: u16,
        /// Response body (lossy UTF-8).
        body: String,
    },
    /// WebSocket protocol error or connection closed.
    #[error("WebSocket: {0}")]
    Ws(String),
    /// Socket I/O error (including timeouts).
    #[error("I/O: {0}")]
    Io(#[from] std::io::Error),
    /// The device speaks an API major version other than `05`.
    #[error("unsupported CANsub API: {0}")]
    UnsupportedApi(String),
    /// The channel WebSocket is already in use by another client (HTTP 409 on upgrade).
    #[error("CAN channel busy: another client holds its WebSocket")]
    Busy,
    /// Malformed response, invalid argument or unrepresentable frame.
    #[error("protocol: {0}")]
    Protocol(String),
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_phy_matches_fd_timing() {
        let (n, d) = crate::timing::fd_timing(500_000, 2_000_000, 800).unwrap();
        let p = PhyConfig::default();
        assert_eq!((p.timing, p.timing_data), (n, d));
        assert!(p.listen_only);
    }

    #[test]
    fn status_parses_openapi_example() {
        let s: ChannelStatus = serde_json::from_str(
            r#"{"state":"stopped","frame_count":0,"frame_rate":0,"bus_load":0,
                "rx_error_count":0,"tx_error_count":0,"bus_error_count":0}"#,
        )
        .unwrap();
        assert_eq!(s.state, CanState::Stopped);
        let s: ChannelStatus = serde_json::from_str(
            r#"{"state":"warp","frame_count":1,"frame_rate":2,"bus_load":3,
                "rx_error_count":4,"tx_error_count":5,"bus_error_count":6}"#,
        )
        .unwrap();
        assert_eq!(s.state, CanState::Unknown);
    }
}
