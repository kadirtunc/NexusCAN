//! ISO 14229 (UDS) helpers.
//!
//! * `security` — SecurityAccess seed/key providers (contract: planning/contracts/seedkey-v1.md)
//! * `port`     — HAL ↔ UDS client frame port (contract: planning/contracts/uds-client-d003-v1.md)
//! * `dto`      — `cmd_diag_*` IPC DTOs (same contract)
//! * `discovery` — functional-addressing ECU discovery (pure logic, `cmd_diag_discover_ecus`)
//! * `addressing` — ISO 15765-2 address formats (address byte, id form rules)
//! * `flash`     — firmware images + 0x34/0x36/0x37 download engine
pub mod addressing;
pub mod client;
pub mod discovery;
pub mod dto;
pub mod flash;
pub mod port;
pub mod security;
