//! Pinned CSS Electronics CANsub root CA (contract §2.6).
//!
//! Source: `CSS-Electronics/c-cpp-sdk-cansub` `src/src/cansub_root_cert.crt` (MIT, see
//! `certs/LICENSE-CSS-MIT`). `CN=CANsub root`, ECDSA P-256, valid 2026-04-21 .. 2046-04-16.
//! Production code accepts **only** this root; test roots exist only under `cfg(any(test, feature = "sim"))`.

/// PEM encoding of the CSS Electronics CANsub root certificate.
pub const CSS_ROOT_CA_PEM: &str = include_str!("../certs/cansub_root_cert.crt");

/// SHA-256 fingerprint of the DER encoding of [`CSS_ROOT_CA_PEM`]
/// (`D064C85905195400216A11BB50D754865ED2B5F997D36A9EA2EA97883B15D0F1`).
pub const CSS_ROOT_CA_SHA256: [u8; 32] = [
    0xD0, 0x64, 0xC8, 0x59, 0x05, 0x19, 0x54, 0x00, 0x21, 0x6A, 0x11, 0xBB, 0x50, 0xD7, 0x54, 0x86,
    0x5E, 0xD2, 0xB5, 0xF9, 0x97, 0xD3, 0x6A, 0x9E, 0xA2, 0xEA, 0x97, 0x88, 0x3B, 0x15, 0xD0, 0xF1,
];
