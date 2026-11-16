//! SAE J1939 diagnostics — pure logic, no I/O, no clocks, no threads.
//!
//! * [`id`] — 29-bit identifier codec (J1939-21): priority, EDP, DP, PF, PS, SA, PDU1/PDU2 PGN.
//! * [`tp`] — Transport Protocol reassembly (J1939-21 TP.CM 60416 / TP.DT 60160): BAM and
//!   passively-followed CMDT (RTS / CTS / EndOfMsgAck / Abort), caller-driven timeouts
//!   (T1 750 ms, T2 1250 ms, T3 1250 ms, T4 1050 ms; Tr 200 ms and Th 500 ms exposed as
//!   constants for a future active responder), bounded sessions; pure CTS / EndOfMsgAck /
//!   Abort frame builders.
//! * [`address_claim`] — 64-bit NAME codec, Address Claimed (60928), Request (59904) builder,
//!   Cannot Claim (SA 254) detection, an SA → NAME [`AddressTable`] with lowest-NAME-wins
//!   conflict resolution, and a NAME function name table (codes 0..=94).
//! * [`dm`] — J1939-73 DM1 / DM2 parsing (lamps, DTCs with SPN conversion Versions 1–4) and
//!   DM1 / DM2 / DM3 / DM11 request builders, FMI name table.
//!
//! # Standards
//! SAE J1939-21 (data link / transport), SAE J1939-73 (application diagnostics, §5.7.1 DM1 /
//! §5.7.1.11 SPN conversion method), SAE J1939-81 (network management / NAME), SAE J1939
//! Appendix B / J1939DA (NAME function and industry group codes).
//!
//! # TX safety
//! Nothing here transmits. Every builder returns a [`J1939Frame`] value; the HAL must send it
//! only through the gated TX path (Listen-Only lock by default, explicit Arm Active Bus, Panic
//! Stop). DM3 / DM11 requests clear ECU diagnostic memory and need operator confirmation.
//!
//! # Honest limits (decoded vs. left raw)
//! * Decoded: identifier fields and PGN; TP BAM/CMDT payload reassembly; NAME fields; DM1/DM2
//!   lamps, SPN, FMI, CM, OC.
//! * Left raw / not done: SPN names and SPN data values (needs a DBC / J1939DA lookup); NAME
//!   function codes 95..=255 (95..=127 untabulated, 128..=255 depend on industry group /
//!   vehicle system); manufacturer code names; DM3/DM11 acknowledgement (PGN 59392) parsing;
//!   other DMs (DM4, DM5, ...); Extended TP (J1939-21 ETP, > 1785 bytes) and J1939-22 (CAN-FD)
//!   multi-PG / FD-TP; an active CTS-sending responder; address-claim arbitration as a
//!   claiming node (only observation is implemented).
//! * CM = 1 DTCs: the bit does not identify Version 1, 2 or 3; the method is a caller option
//!   (default Version 3, bit-identical to Version 4) and each DTC keeps its raw bytes.

pub mod address_claim;
pub mod dm;
pub mod id;
pub mod tp;

pub use address_claim::{
    build_request, build_request_address_claimed, function_name, industry_group_name,
    parse_address_claim, AddressClaimDto, AddressEntryDto, AddressTable, ClaimOutcome, J1939Name,
    NameError, PGN_ADDRESS_CLAIMED, PGN_REQUEST,
};
pub use dm::{
    build_request_dm1, build_request_dm11_clear_active, build_request_dm2,
    build_request_dm3_clear_previously_active, decode_spn, fmi_name, parse_dm, parse_dm_by_pgn,
    DmError, DmKind, DmMessageDto, DmParseOptions, DtcDto, LampDto, LampFlash, LampState,
    LampStatusDto, LegacySpnConversion, SpnConversion, PGN_DM1, PGN_DM11, PGN_DM2, PGN_DM3,
};
pub use id::{J1939Frame, J1939Id, J1939IdError, ADDRESS_GLOBAL, ADDRESS_NULL};
pub use tp::{
    build_tp_abort, build_tp_cts, build_tp_end_of_msg_ack, AbortOrigin, Reassembler,
    ReassemblerConfig, TpAbort, TpAbortDetail, TpAbortReason, TpBuildError, TpEvent, TpMessage,
    TpMode, TpStatsDto, TpTimer, PGN_TP_CM, PGN_TP_DT,
};
