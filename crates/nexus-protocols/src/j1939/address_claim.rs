//! SAE J1939-81 network management: the 64-bit NAME, Address Claimed (PGN 60928) and the
//! Request PGN 59904 builder — pure logic, no I/O.
//!
//! NAME layout (8 data bytes, little-endian `u64`):
//!
//! | bits   | width | field                         |
//! |--------|-------|-------------------------------|
//! | 0..20  | 21    | identity number               |
//! | 21..31 | 11    | manufacturer code             |
//! | 32..34 | 3     | ECU instance                  |
//! | 35..39 | 5     | function instance             |
//! | 40..47 | 8     | function                      |
//! | 48     | 1     | reserved                      |
//! | 49..55 | 7     | vehicle system                |
//! | 56..59 | 4     | vehicle system instance       |
//! | 60..62 | 3     | industry group                |
//! | 63     | 1     | arbitrary address capable     |
//!
//! Arbitration: when two ECUs claim the same source address, the NAME with the LOWER numeric
//! value wins (J1939-81). An Address Claimed message sent from SA 254 (NULL) is "Cannot Claim
//! Address".
//!
//! Request frames built here are TX actions: the HAL must route them through the gated TX path
//! (Listen-Only lock, Arm Active Bus, Panic Stop).

use serde::{Deserialize, Serialize};

use super::id::{pgn_to_le3, J1939Frame, J1939Id, J1939IdError, ADDRESS_NULL};

/// Address Claimed PGN (0xEE00).
pub const PGN_ADDRESS_CLAIMED: u32 = 60928;
/// Request PGN (0xEA00).
pub const PGN_REQUEST: u32 = 59904;
/// Default priority of Request and Address Claimed messages.
pub const DEFAULT_REQUEST_PRIORITY: u8 = 6;
/// Number of claimable source addresses (0..=253; 254 = NULL, 255 = global).
pub const CLAIMABLE_ADDRESSES: usize = 254;

/// Field value out of range when encoding a NAME.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum NameError {
    #[error("NAME field {field} = {value} exceeds its {bits}-bit width")]
    FieldOutOfRange {
        field: &'static str,
        value: u32,
        bits: u8,
    },
    #[error("NAME needs 8 data bytes, got {0}")]
    TooShort(usize),
}

/// Decoded J1939 64-bit NAME. Every field fits in 21 bits, so this DTO is JSON-safe (the raw
/// `u64` is deliberately not serialized: it does not fit a JS number).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct J1939Name {
    pub arbitrary_address_capable: bool,
    /// 3 bits.
    pub industry_group: u8,
    /// 4 bits.
    pub vehicle_system_instance: u8,
    /// 7 bits.
    pub vehicle_system: u8,
    /// Bit 48, reserved (kept so encode(decode(x)) == x).
    pub reserved: bool,
    /// 8 bits.
    pub function: u8,
    /// 5 bits.
    pub function_instance: u8,
    /// 3 bits.
    pub ecu_instance: u8,
    /// 11 bits.
    pub manufacturer_code: u16,
    /// 21 bits.
    pub identity_number: u32,
}

impl J1939Name {
    /// Decodes a raw little-endian NAME value. Never fails: every bit maps to a field.
    pub fn from_raw(raw: u64) -> Self {
        Self {
            identity_number: (raw & 0x1F_FFFF) as u32,
            manufacturer_code: ((raw >> 21) & 0x7FF) as u16,
            ecu_instance: ((raw >> 32) & 0x07) as u8,
            function_instance: ((raw >> 35) & 0x1F) as u8,
            function: ((raw >> 40) & 0xFF) as u8,
            reserved: (raw >> 48) & 1 == 1,
            vehicle_system: ((raw >> 49) & 0x7F) as u8,
            vehicle_system_instance: ((raw >> 56) & 0x0F) as u8,
            industry_group: ((raw >> 60) & 0x07) as u8,
            arbitrary_address_capable: (raw >> 63) & 1 == 1,
        }
    }

    /// Decodes the 8 data bytes of an Address Claimed message (byte 0 = NAME bits 0..7).
    pub fn from_bytes(data: &[u8]) -> Result<Self, NameError> {
        let bytes: [u8; 8] = data
            .get(..8)
            .and_then(|s| s.try_into().ok())
            .ok_or(NameError::TooShort(data.len()))?;
        Ok(Self::from_raw(u64::from_le_bytes(bytes)))
    }

    /// Encodes to the raw NAME value, rejecting any field wider than its bit width.
    pub fn to_raw(&self) -> Result<u64, NameError> {
        fn check(field: &'static str, value: u32, bits: u8) -> Result<u64, NameError> {
            if u64::from(value) >> bits != 0 {
                Err(NameError::FieldOutOfRange { field, value, bits })
            } else {
                Ok(u64::from(value))
            }
        }
        let identity = check("identityNumber", self.identity_number, 21)?;
        let manufacturer = check("manufacturerCode", u32::from(self.manufacturer_code), 11)?;
        let ecu = check("ecuInstance", u32::from(self.ecu_instance), 3)?;
        let fi = check("functionInstance", u32::from(self.function_instance), 5)?;
        let function = u64::from(self.function);
        let vs = check("vehicleSystem", u32::from(self.vehicle_system), 7)?;
        let vsi = check(
            "vehicleSystemInstance",
            u32::from(self.vehicle_system_instance),
            4,
        )?;
        let ig = check("industryGroup", u32::from(self.industry_group), 3)?;
        Ok(identity
            | (manufacturer << 21)
            | (ecu << 32)
            | (fi << 35)
            | (function << 40)
            | (u64::from(self.reserved) << 48)
            | (vs << 49)
            | (vsi << 56)
            | (ig << 60)
            | (u64::from(self.arbitrary_address_capable) << 63))
    }

    /// Encodes to the 8 little-endian data bytes of an Address Claimed message.
    pub fn to_bytes(&self) -> Result<[u8; 8], NameError> {
        Ok(self.to_raw()?.to_le_bytes())
    }

    /// Industry-group-independent function name (codes 0..=127), `None` if not tabulated.
    pub fn function_name(&self) -> Option<&'static str> {
        function_name(self.function)
    }
}

/// Industry group names (J1939 Appendix B). 6 and 7 are reserved → `None`.
pub fn industry_group_name(group: u8) -> Option<&'static str> {
    match group {
        0 => Some("Global"),
        1 => Some("On-Highway Equipment"),
        2 => Some("Agricultural and Forestry Equipment"),
        3 => Some("Construction Equipment"),
        4 => Some("Marine"),
        5 => Some("Industrial-Process Control-Stationary (Gen-Sets)"),
        _ => None,
    }
}

/// NAME functions 0..=127 are independent of industry group and vehicle system.
/// Source: the J1939 NAME function list as published on isobus.net (codes 0..=94).
/// Codes 95..=127 are not tabulated here and 128..=255 depend on the industry group / vehicle
/// system: both return `None` (no guessing).
static FUNCTION_NAMES: [&str; 95] = [
    "Engine",
    "Auxiliary Power Unit (APU)",
    "Electric Propulsion Control",
    "Transmission",
    "Battery Pack Monitor",
    "Shift Control/Console",
    "Power TakeOff - (Main or Rear)",
    "Axle - Steering",
    "Axle - Drive",
    "Brakes - System Controller",
    "Brakes - Steer Axle",
    "Brakes - Drive axle",
    "Retarder - Engine",
    "Retarder - Driveline",
    "Cruise Control",
    "Fuel System",
    "Steering Controller",
    "Suspension - Steer Axle",
    "Suspension - Drive Axle",
    "Instrument Cluster",
    "Trip Recorder",
    "Cab Climate Control",
    "Aerodynamic Control",
    "Vehicle Navigation",
    "Vehicle Security",
    "Network Interconnect ECU",
    "Body Controller",
    "Power TakeOff (Secondary or Front)",
    "Off Vehicle Gateway",
    "Virtual Terminal (in cab)",
    "Management Computer",
    "Propulsion Battery Charger",
    "Headway Controller",
    "System Monitor",
    "Hydraulic Pump Controller",
    "Suspension - System Controller",
    "Pneumatic - System Controller",
    "Cab Controller",
    "Tire Pressure Control",
    "Ignition Control Module",
    "Seat Control",
    "Lighting - Operator Controls",
    "Water Pump Control",
    "Transmission Display",
    "Exhaust Emission Control",
    "Vehicle Dynamic Stability Control",
    "Oil Sensor Unit",
    "Information System Controller",
    "Ramp Control",
    "Clutch/Converter Control",
    "Auxiliary Heater",
    "Forward-Looking Collision Warning System",
    "Chassis Controller",
    "Alternator/Charging System",
    "Communications Unit, Cellular",
    "Communications Unit, Satellite",
    "Communications Unit, Radio",
    "Steering Column Unit",
    "Fan Drive Control",
    "Starter",
    "Cab Display",
    "File Server / Printer",
    "On-Board Diagnostic Unit",
    "Engine Valve Controller",
    "Endurance Braking",
    "Gas Flow Measurement",
    "I/O Controller",
    "Electrical System Controller",
    "Aftertreatment system gas measurement",
    "Engine Emission Aftertreatment System",
    "Auxiliary Regeneration Device",
    "Transfer Case Control",
    "Coolant Valve Controller",
    "Rollover Detection Control",
    "Lubrication System",
    "Supplemental Fan",
    "Temperature Sensor",
    "Fuel Properties Sensor",
    "Fire Suppression System",
    "Power Systems Manager",
    "Electric Powertrain",
    "Hydraulic Powertrain",
    "File Server",
    "Printer",
    "Start Aid Device",
    "Engine Injection Control Module",
    "EV Communication Controller",
    "Driver Impairment Device",
    "Electric Power Converter",
    "Supply Equipment Communication Controller (SECC)",
    "Vehicle Adapter Communication Controller (VACC)",
    "Accessory Electric Motor Controller",
    "Current Sensor",
    "Fuel Cell System",
    "Auxiliary Display",
];

/// Industry-group-independent NAME function name, `None` when not tabulated.
pub fn function_name(function: u8) -> Option<&'static str> {
    FUNCTION_NAMES.get(usize::from(function)).copied()
}

/// Builds a Request (PGN 59904) for `requested_pgn`: 3-byte little-endian payload, DLC 3.
/// `da` = 0xFF asks every node, otherwise only that node.
///
/// TX action: the HAL must gate it (Listen-Only / Arm Active Bus / Panic Stop).
pub fn build_request(
    requested_pgn: u32,
    sa: u8,
    da: u8,
    priority: u8,
) -> Result<J1939Frame, J1939IdError> {
    if requested_pgn > super::id::MAX_PGN {
        return Err(J1939IdError::InvalidPgn(requested_pgn));
    }
    let id = J1939Id::from_pgn(priority, PGN_REQUEST, da, sa)?;
    let pgn = pgn_to_le3(requested_pgn);
    Ok(J1939Frame {
        id: id.encode(),
        data: [pgn[0], pgn[1], pgn[2], 0xFF, 0xFF, 0xFF, 0xFF, 0xFF],
        len: 3,
    })
}

/// Builds a Request for Address Claimed (PGN 60928) at default priority 6.
pub fn build_request_address_claimed(sa: u8, da: u8) -> Result<J1939Frame, J1939IdError> {
    build_request(PGN_ADDRESS_CLAIMED, sa, da, DEFAULT_REQUEST_PRIORITY)
}

/// A parsed Address Claimed / Cannot Claim message.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddressClaimDto {
    /// Claimed address; 254 means "Cannot Claim Address".
    pub sa: u8,
    pub name: J1939Name,
    pub cannot_claim: bool,
}

/// Parses an Address Claimed frame. `Ok(None)` when the frame is not PGN 60928.
pub fn parse_address_claim(
    id: &J1939Id,
    data: &[u8],
) -> Result<Option<AddressClaimDto>, NameError> {
    if id.pgn() != PGN_ADDRESS_CLAIMED {
        return Ok(None);
    }
    let name = J1939Name::from_bytes(data)?;
    Ok(Some(AddressClaimDto {
        sa: id.sa,
        name,
        cannot_claim: id.sa == ADDRESS_NULL,
    }))
}

/// Result of feeding one claim into the [`AddressTable`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ClaimOutcome {
    /// First claim for this address.
    #[serde(rename_all = "camelCase")]
    New { sa: u8, name: J1939Name },
    /// Same NAME re-claimed the same address.
    #[serde(rename_all = "camelCase")]
    Refreshed { sa: u8, name: J1939Name },
    /// A NAME already in the table claimed a different address; the old entry was removed.
    #[serde(rename_all = "camelCase")]
    Moved { from: u8, to: u8, name: J1939Name },
    /// Two NAMEs claimed the same address. Lower NAME wins; the table now holds the winner.
    /// `previous_address_of_winner` is set when the winner moved from another address.
    #[serde(rename_all = "camelCase")]
    Conflict {
        sa: u8,
        winner: J1939Name,
        loser: J1939Name,
        previous_address_of_winner: Option<u8>,
    },
    /// Message from SA 254: the ECU could not claim an address. Its NAME is removed from the
    /// table (`released` = the address it held, if any).
    #[serde(rename_all = "camelCase")]
    CannotClaim {
        name: J1939Name,
        released: Option<u8>,
    },
    /// SA 255 (global) is never a valid claim; ignored.
    #[serde(rename_all = "camelCase")]
    InvalidAddress { sa: u8 },
}

/// One live entry of the [`AddressTable`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddressEntryDto {
    pub sa: u8,
    pub name: J1939Name,
    pub last_claim_us: u64,
}

#[derive(Debug, Clone, Copy)]
struct Entry {
    raw: u64,
    last_claim_us: u64,
}

/// SA → NAME map built from observed claims. Fixed size (254 slots), no growth.
#[derive(Debug, Clone)]
pub struct AddressTable {
    slots: Vec<Option<Entry>>,
}

impl Default for AddressTable {
    fn default() -> Self {
        Self::new()
    }
}

impl AddressTable {
    pub fn new() -> Self {
        Self {
            slots: vec![None; CLAIMABLE_ADDRESSES],
        }
    }

    /// Removes every entry.
    pub fn clear(&mut self) {
        self.slots.iter_mut().for_each(|s| *s = None);
    }

    /// NAME currently holding `sa`.
    pub fn get(&self, sa: u8) -> Option<J1939Name> {
        self.slots
            .get(usize::from(sa))
            .copied()
            .flatten()
            .map(|e| J1939Name::from_raw(e.raw))
    }

    /// Number of claimed addresses.
    pub fn len(&self) -> usize {
        self.slots.iter().filter(|s| s.is_some()).count()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Snapshot ordered by SA.
    pub fn entries(&self) -> Vec<AddressEntryDto> {
        self.slots
            .iter()
            .enumerate()
            .filter_map(|(sa, s)| {
                s.map(|e| AddressEntryDto {
                    sa: sa as u8,
                    name: J1939Name::from_raw(e.raw),
                    last_claim_us: e.last_claim_us,
                })
            })
            .collect()
    }

    fn find_raw(&self, raw: u64) -> Option<u8> {
        self.slots
            .iter()
            .position(|s| s.is_some_and(|e| e.raw == raw))
            .map(|p| p as u8)
    }

    /// Feeds one observed claim (`sa` = frame source address, `name` = raw NAME value).
    pub fn observe_claim(&mut self, sa: u8, raw_name: u64, timestamp_us: u64) -> ClaimOutcome {
        let name = J1939Name::from_raw(raw_name);
        if sa == ADDRESS_NULL {
            let released = self.find_raw(raw_name);
            if let Some(old) = released {
                self.slots[usize::from(old)] = None;
            }
            return ClaimOutcome::CannotClaim { name, released };
        }
        let idx = usize::from(sa);
        if idx >= CLAIMABLE_ADDRESSES {
            return ClaimOutcome::InvalidAddress { sa };
        }
        let fresh = Entry {
            raw: raw_name,
            last_claim_us: timestamp_us,
        };
        let previous_address = self.find_raw(raw_name).filter(|&a| a != sa);
        match self.slots[idx] {
            None => {
                self.slots[idx] = Some(fresh);
                if let Some(from) = previous_address {
                    self.slots[usize::from(from)] = None;
                    ClaimOutcome::Moved { from, to: sa, name }
                } else {
                    ClaimOutcome::New { sa, name }
                }
            }
            Some(incumbent) if incumbent.raw == raw_name => {
                self.slots[idx] = Some(fresh);
                ClaimOutcome::Refreshed { sa, name }
            }
            Some(incumbent) => {
                let incumbent_name = J1939Name::from_raw(incumbent.raw);
                if raw_name < incumbent.raw {
                    // Newcomer wins: it takes the address (and leaves its old one, if any).
                    self.slots[idx] = Some(fresh);
                    if let Some(from) = previous_address {
                        self.slots[usize::from(from)] = None;
                    }
                    ClaimOutcome::Conflict {
                        sa,
                        winner: name,
                        loser: incumbent_name,
                        previous_address_of_winner: previous_address,
                    }
                } else {
                    // Incumbent keeps the address; newcomer's table state is unchanged.
                    ClaimOutcome::Conflict {
                        sa,
                        winner: incumbent_name,
                        loser: name,
                        previous_address_of_winner: None,
                    }
                }
            }
        }
    }

    /// Feeds a raw frame; `None` unless it is a well-formed Address Claimed message.
    pub fn observe_frame(
        &mut self,
        raw_id: u32,
        extended: bool,
        data: &[u8],
        timestamp_us: u64,
    ) -> Option<ClaimOutcome> {
        let id = J1939Id::decode(raw_id, extended).ok()?;
        let claim = parse_address_claim(&id, data).ok()??;
        let raw = claim.name.to_raw().ok()?;
        Some(self.observe_claim(claim.sa, raw, timestamp_us))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_name() -> J1939Name {
        J1939Name {
            arbitrary_address_capable: true,
            industry_group: 1,
            vehicle_system_instance: 0x3,
            vehicle_system: 0x7F,
            reserved: false,
            function: 0,
            function_instance: 0x1F,
            ecu_instance: 0x5,
            manufacturer_code: 0x7FF,
            identity_number: 0x1F_FFFF,
        }
    }

    #[test]
    fn name_field_layout() {
        // Constructed from the bit layout: each field set to a distinct value.
        let raw: u64 = 0x12345
            | (0x2AB << 21)
            | (0x6 << 32)
            | (0x15 << 35)
            | (0x81 << 40)
            | (0x55 << 49)
            | (0xA << 56)
            | (0x2 << 60)
            | (1 << 63);
        let n = J1939Name::from_raw(raw);
        assert_eq!(n.identity_number, 0x12345);
        assert_eq!(n.manufacturer_code, 0x2AB);
        assert_eq!(n.ecu_instance, 6);
        assert_eq!(n.function_instance, 0x15);
        assert_eq!(n.function, 0x81);
        assert!(!n.reserved);
        assert_eq!(n.vehicle_system, 0x55);
        assert_eq!(n.vehicle_system_instance, 0xA);
        assert_eq!(n.industry_group, 2);
        assert!(n.arbitrary_address_capable);
        assert_eq!(n.to_raw().unwrap(), raw);
    }

    #[test]
    fn name_roundtrip_random() {
        let mut x: u64 = 0x9E37_79B9_7F4A_7C15;
        for _ in 0..10_000 {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            let n = J1939Name::from_raw(x);
            assert_eq!(n.to_raw().unwrap(), x);
            assert_eq!(J1939Name::from_bytes(&x.to_le_bytes()).unwrap(), n);
            assert_eq!(n.to_bytes().unwrap(), x.to_le_bytes());
        }
        let n = sample_name();
        assert_eq!(J1939Name::from_raw(n.to_raw().unwrap()), n);
    }

    #[test]
    fn name_rejects_oversized_fields() {
        let mut n = sample_name();
        n.identity_number = 0x20_0000;
        assert!(matches!(
            n.to_raw(),
            Err(NameError::FieldOutOfRange { bits: 21, .. })
        ));
        let mut n = sample_name();
        n.industry_group = 8;
        assert!(n.to_raw().is_err());
        assert_eq!(J1939Name::from_bytes(&[0; 7]), Err(NameError::TooShort(7)));
    }

    #[test]
    fn function_name_table() {
        assert_eq!(function_name(0), Some("Engine"));
        assert_eq!(function_name(3), Some("Transmission"));
        assert_eq!(function_name(9), Some("Brakes - System Controller"));
        assert_eq!(function_name(19), Some("Instrument Cluster"));
        assert_eq!(function_name(26), Some("Body Controller"));
        assert_eq!(function_name(95), None);
        assert_eq!(function_name(130), None);
        assert_eq!(industry_group_name(1), Some("On-Highway Equipment"));
        assert_eq!(industry_group_name(7), None);
    }

    #[test]
    fn request_builder_address_claimed() {
        let f = build_request_address_claimed(0xF9, 0xFF).unwrap();
        // Priority 6, PGN 0xEA00, DA 0xFF, SA 0xF9.
        assert_eq!(f.id, 0x18EA_FFF9);
        assert_eq!(f.payload(), &[0x00, 0xEE, 0x00]);
        let f = build_request(65226, 0xF9, 0x00, 6).unwrap();
        assert_eq!(f.id, 0x18EA_00F9);
        assert_eq!(f.payload(), &[0xCA, 0xFE, 0x00]);
        assert!(build_request(0x4_0000, 0xF9, 0x00, 6).is_err());
    }

    #[test]
    fn parse_claim_and_cannot_claim() {
        let name = sample_name();
        let bytes = name.to_bytes().unwrap();
        let id = J1939Id::decode(0x18EE_FF00, true).unwrap();
        let c = parse_address_claim(&id, &bytes).unwrap().unwrap();
        assert_eq!(c.sa, 0);
        assert!(!c.cannot_claim);
        assert_eq!(c.name, name);
        let id = J1939Id::decode(0x18EE_FFFE, true).unwrap();
        assert!(
            parse_address_claim(&id, &bytes)
                .unwrap()
                .unwrap()
                .cannot_claim
        );
        let other = J1939Id::decode(0x18FE_CA00, true).unwrap();
        assert_eq!(parse_address_claim(&other, &bytes), Ok(None));
        assert!(parse_address_claim(&id, &bytes[..4]).is_err());
    }

    #[test]
    fn address_table_conflict_lower_name_wins() {
        let mut t = AddressTable::new();
        let high = 0x8000_0000_0000_0100u64;
        let low = 0x8000_0000_0000_0001u64;
        assert!(matches!(
            t.observe_claim(0x80, high, 1),
            ClaimOutcome::New { sa: 0x80, .. }
        ));
        assert!(matches!(
            t.observe_claim(0x80, high, 2),
            ClaimOutcome::Refreshed { .. }
        ));
        // Lower NAME challenges: newcomer wins, incumbent is reported as loser.
        match t.observe_claim(0x80, low, 3) {
            ClaimOutcome::Conflict { winner, loser, .. } => {
                assert_eq!(winner, J1939Name::from_raw(low));
                assert_eq!(loser, J1939Name::from_raw(high));
            }
            o => panic!("unexpected {o:?}"),
        }
        assert_eq!(t.get(0x80), Some(J1939Name::from_raw(low)));
        // Higher NAME challenges: incumbent keeps the address.
        match t.observe_claim(0x80, high, 4) {
            ClaimOutcome::Conflict { winner, loser, .. } => {
                assert_eq!(winner, J1939Name::from_raw(low));
                assert_eq!(loser, J1939Name::from_raw(high));
            }
            o => panic!("unexpected {o:?}"),
        }
        assert_eq!(t.get(0x80), Some(J1939Name::from_raw(low)));
        assert_eq!(t.len(), 1);
    }

    #[test]
    fn address_table_move_and_cannot_claim() {
        let mut t = AddressTable::new();
        let n = 0x1234u64;
        t.observe_claim(0x10, n, 1);
        assert_eq!(
            t.observe_claim(0x11, n, 2),
            ClaimOutcome::Moved {
                from: 0x10,
                to: 0x11,
                name: J1939Name::from_raw(n)
            }
        );
        assert_eq!(t.get(0x10), None);
        assert_eq!(
            t.observe_claim(ADDRESS_NULL, n, 3),
            ClaimOutcome::CannotClaim {
                name: J1939Name::from_raw(n),
                released: Some(0x11)
            }
        );
        assert!(t.is_empty());
        assert_eq!(
            t.observe_claim(0xFF, n, 4),
            ClaimOutcome::InvalidAddress { sa: 0xFF }
        );
    }

    #[test]
    fn address_table_observe_frame() {
        let mut t = AddressTable::new();
        let bytes = sample_name().to_bytes().unwrap();
        assert!(t.observe_frame(0x18EE_FF25, true, &bytes, 10).is_some());
        assert_eq!(t.entries().len(), 1);
        assert_eq!(t.entries()[0].sa, 0x25);
        assert!(t.observe_frame(0x18EE_FF25, false, &bytes, 10).is_none());
        assert!(t.observe_frame(0x18FE_CA25, true, &bytes, 10).is_none());
        assert!(t
            .observe_frame(0x18EE_FF25, true, &bytes[..3], 10)
            .is_none());
    }
}
