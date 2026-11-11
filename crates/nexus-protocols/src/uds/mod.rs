//! ISO 14229 (UDS) helpers.
//!
//! * `security` — SecurityAccess seed/key providers (contract: planning/contracts/seedkey-v1.md)
//! * `port`     — HAL ↔ UDS client frame port (contract: planning/contracts/uds-client-d003-v1.md)
//! * `dto`      — `cmd_diag_*` IPC DTOs (same contract)
//! * `discovery` — functional-addressing ECU discovery (pure logic, `cmd_diag_discover_ecus`)
pub mod client;
pub mod discovery;
pub mod dto;
pub mod port;
pub mod security;
