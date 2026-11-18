//! Zero-`unsafe` CAN Controller & Transceiver Error Frame Decoder (`<linux/can/error.h>` & `gs_usb`).
//!
//! Translates `CAN_ERR_FLAG` (`0x2000_0000`) error frames from `candleLight` / `gs_usb` and Linux
//! `SocketCAN` into human-readable industrial diagnostics (`CRTL`, `PROT @ACK-Slot`, `NO-ACK`,
//! `BUS-OFF`, `TEC`/`REC`) and controller [`BusState`] updates.

use crate::traits::BusState;
use nexus_core::EXT_CAN_ID_MASK;

/// TX timeout (`CAN_ERR_TX_TIMEOUT = 0x0000_0001`).
pub const CAN_ERR_TX_TIMEOUT: u32 = 0x0000_0001;
/// Lost arbitration (`CAN_ERR_LOSTARB = 0x0000_0002`, bit index in `data[0]`).
pub const CAN_ERR_LOSTARB: u32 = 0x0000_0002;
/// Controller error state change (`CAN_ERR_CRTL = 0x0000_0004`, details in `data[1]`).
pub const CAN_ERR_CRTL: u32 = 0x0000_0004;
/// Protocol violation (`CAN_ERR_PROT = 0x0000_0008`, type in `data[2]`, location in `data[3]`).
pub const CAN_ERR_PROT: u32 = 0x0000_0008;
/// Transceiver fault (`CAN_ERR_TRX = 0x0000_0010`, details in `data[4]`).
pub const CAN_ERR_TRX: u32 = 0x0000_0010;
/// Received no ACK on transmission (`CAN_ERR_ACK = 0x0000_0020`).
pub const CAN_ERR_ACK: u32 = 0x0000_0020;
/// Bus-Off state entered (`CAN_ERR_BUSOFF = 0x0000_0040`).
pub const CAN_ERR_BUSOFF: u32 = 0x0000_0040;
/// General bus error (`CAN_ERR_BUSERROR = 0x0000_0080`).
pub const CAN_ERR_BUSERROR: u32 = 0x0000_0080;
/// Controller restarted from Bus-Off (`CAN_ERR_RESTARTED = 0x0000_0100`).
pub const CAN_ERR_RESTARTED: u32 = 0x0000_0100;
/// TX/RX error counter payload present (`CAN_ERR_CNT = 0x0000_0200`, `TEC = data[6]`, `REC = data[7]`).
pub const CAN_ERR_CNT: u32 = 0x0000_0200;

// `data[1]` controller status flags (`CAN_ERR_CRTL_*`)
const CRTL_RX_OVERFLOW: u8 = 0x01;
const CRTL_TX_OVERFLOW: u8 = 0x02;
const CRTL_RX_WARNING: u8 = 0x04;
const CRTL_TX_WARNING: u8 = 0x08;
const CRTL_RX_PASSIVE: u8 = 0x10;
const CRTL_TX_PASSIVE: u8 = 0x20;
const CRTL_ACTIVE: u8 = 0x40;

// `data[2]` protocol violation flags (`CAN_ERR_PROT_*`)
const PROT_BIT: u8 = 0x01;
const PROT_FORM: u8 = 0x02;
const PROT_STUFF: u8 = 0x04;
const PROT_BIT0: u8 = 0x08;
const PROT_BIT1: u8 = 0x10;
const PROT_OVERLOAD: u8 = 0x20;
const PROT_ACTIVE: u8 = 0x40;
const PROT_TX: u8 = 0x80;

/// Decodes a `SocketCAN` / `gs_usb` CAN error frame (`err_mask = raw_arb_id & 0x1FFF_FFFF` + `data[0..8]`)
/// into a concise, actionable engineering summary string.
pub fn decode_can_error_summary(raw_arb_id: u32, data: &[u8]) -> String {
    let err_mask = raw_arb_id & EXT_CAN_ID_MASK;
    let mut parts: Vec<String> = Vec::with_capacity(6);

    if (err_mask & CAN_ERR_TX_TIMEOUT) != 0 {
        parts.push("TX-Timeout".to_string());
    }

    if (err_mask & CAN_ERR_LOSTARB) != 0 {
        let bit = data.first().copied().unwrap_or(0);
        if bit > 0 {
            parts.push(format!("Lost-Arb(bit {bit})"));
        } else {
            parts.push("Lost-Arb".to_string());
        }
    }

    if (err_mask & CAN_ERR_CRTL) != 0 {
        let crtl = data.get(1).copied().unwrap_or(0);
        let mut sub: Vec<&'static str> = Vec::with_capacity(4);
        if (crtl & CRTL_RX_OVERFLOW) != 0 {
            sub.push("RX-Overflow");
        }
        if (crtl & CRTL_TX_OVERFLOW) != 0 {
            sub.push("TX-Overflow");
        }
        if (crtl & CRTL_RX_WARNING) != 0 {
            sub.push("RX-Warning");
        }
        if (crtl & CRTL_TX_WARNING) != 0 {
            sub.push("TX-Warning");
        }
        if (crtl & CRTL_RX_PASSIVE) != 0 {
            sub.push("RX-Passive");
        }
        if (crtl & CRTL_TX_PASSIVE) != 0 {
            sub.push("TX-Passive");
        }
        if (crtl & CRTL_ACTIVE) != 0 {
            sub.push("Error-Active");
        }
        if sub.is_empty() {
            parts.push("CRTL".to_string());
        } else {
            parts.push(format!("CRTL[{}]", sub.join(",")));
        }
    }

    if (err_mask & CAN_ERR_PROT) != 0 {
        let prot = data.get(2).copied().unwrap_or(0);
        let loc_code = data.get(3).copied().unwrap_or(0);
        let mut p_flags: Vec<&'static str> = Vec::with_capacity(5);
        if (prot & PROT_BIT) != 0 {
            p_flags.push("Bit-Err");
        }
        if (prot & PROT_FORM) != 0 {
            p_flags.push("Form-Err");
        }
        if (prot & PROT_STUFF) != 0 {
            p_flags.push("Stuff-Err");
        }
        if (prot & PROT_BIT0) != 0 {
            p_flags.push("Bit0-Dom");
        }
        if (prot & PROT_BIT1) != 0 {
            p_flags.push("Bit1-Rec");
        }
        if (prot & PROT_OVERLOAD) != 0 {
            p_flags.push("Overload");
        }
        if (prot & PROT_ACTIVE) != 0 {
            p_flags.push("Active-Err");
        }
        if (prot & PROT_TX) != 0 {
            p_flags.push("(TX)");
        }

        let loc_str = decode_prot_location(loc_code);
        match (p_flags.is_empty(), loc_str) {
            (true, None) => parts.push("PROT".to_string()),
            (false, None) => parts.push(format!("PROT[{}]", p_flags.join(","))),
            (true, Some(loc)) => parts.push(format!("PROT[{loc}]")),
            (false, Some(loc)) => parts.push(format!("PROT[{} {loc}]", p_flags.join(","))),
        }
    }

    if (err_mask & CAN_ERR_TRX) != 0 {
        let trx = data.get(4).copied().unwrap_or(0);
        if trx > 0 {
            parts.push(format!("TRX-Fault(0x{trx:02X})"));
        } else {
            parts.push("TRX-Fault".to_string());
        }
    }

    if (err_mask & CAN_ERR_ACK) != 0 {
        parts.push("NO-ACK".to_string());
    }

    if (err_mask & CAN_ERR_BUSOFF) != 0 {
        parts.push("BUS-OFF".to_string());
    }

    if (err_mask & CAN_ERR_BUSERROR) != 0 {
        parts.push("BUS-ERR".to_string());
    }

    if (err_mask & CAN_ERR_RESTARTED) != 0 {
        parts.push("Controller-Restarted".to_string());
    }

    if data.len() >= 8 && ((err_mask & CAN_ERR_CNT) != 0 || data[6] > 0 || data[7] > 0) {
        parts.push(format!("TEC={} REC={}", data[6], data[7]));
    }

    if parts.is_empty() {
        "Bus Error Frame".to_string()
    } else {
        parts.join(" | ")
    }
}

#[inline]
const fn decode_prot_location(code: u8) -> Option<&'static str> {
    match code {
        0x03 => Some("@SOF"),
        0x02 | 0x06 | 0x07 | 0x0E | 0x0F => Some("@ID"),
        0x04 => Some("@SRTR"),
        0x05 => Some("@IDE"),
        0x0C => Some("@RTR"),
        0x0B => Some("@DLC"),
        0x0A => Some("@Data"),
        0x08 => Some("@CRC"),
        0x18 => Some("@CRC-Delim"),
        0x19 => Some("@ACK-Slot"),
        0x1B => Some("@ACK-Delim"),
        0x1A => Some("@EOF"),
        0x12 => Some("@Intermission"),
        _ => None,
    }
}

/// Zero-allocation helper extracting updated [`BusState`] and `(TEC, REC)` error counters from
/// a `SocketCAN` / `gs_usb` CAN error frame (`FLAG_ERROR`).
#[inline]
pub fn extract_bus_health_from_error_frame(
    raw_arb_id: u32,
    data: &[u8],
) -> (Option<BusState>, Option<(u32, u32)>) {
    let err_mask = raw_arb_id & EXT_CAN_ID_MASK;

    let state = if (err_mask & CAN_ERR_BUSOFF) != 0 {
        Some(BusState::BusOff)
    } else if (err_mask & CAN_ERR_RESTARTED) != 0 {
        Some(BusState::Active)
    } else if (err_mask & CAN_ERR_CRTL) != 0 {
        let crtl = data.get(1).copied().unwrap_or(0);
        if (crtl & (CRTL_RX_PASSIVE | CRTL_TX_PASSIVE)) != 0 {
            Some(BusState::Passive)
        } else if (crtl & (CRTL_RX_WARNING | CRTL_TX_WARNING)) != 0 {
            Some(BusState::Warning)
        } else if (crtl & CRTL_ACTIVE) != 0 {
            Some(BusState::Active)
        } else {
            None
        }
    } else {
        None
    };

    let counters =
        if data.len() >= 8 && ((err_mask & CAN_ERR_CNT) != 0 || data[6] > 0 || data[7] > 0) {
            Some((u32::from(data[6]), u32::from(data[7])))
        } else {
            None
        };

    (state, counters)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decode_error_frame_004_008_00c_020_040_and_tec_rec() {
        // 1. 0x004: CAN_ERR_CRTL (TX-Warning + TX-Passive)
        let s_004 = decode_can_error_summary(0x004, &[0, 0x28, 0, 0, 0, 0, 128, 0]);
        assert!(
            s_004.contains("CRTL[TX-Warning,TX-Passive]"),
            "got: {s_004}"
        );
        assert!(s_004.contains("TEC=128 REC=0"), "got: {s_004}");

        // 2. 0x008: CAN_ERR_PROT (Stuff-Err @Data)
        let s_008 = decode_can_error_summary(0x008, &[0, 0, 0x04, 0x0A, 0, 0, 0, 16]);
        assert!(s_008.contains("PROT[Stuff-Err @Data]"), "got: {s_008}");
        assert!(s_008.contains("TEC=0 REC=16"), "got: {s_008}");

        // 3. 0x00C: CAN_ERR_CRTL | CAN_ERR_PROT + ACK-Slot + TEC/REC (classic un-terminated candleLight TX!)
        let s_00c = decode_can_error_summary(0x00C, &[0, 0x20, 0x88, 0x19, 0, 0, 136, 0]);
        assert!(s_00c.contains("CRTL[TX-Passive]"), "got: {s_00c}");
        assert!(
            s_00c.contains("PROT[Bit0-Dom,(TX) @ACK-Slot]"),
            "got: {s_00c}"
        );
        assert!(s_00c.contains("TEC=136 REC=0"), "got: {s_00c}");

        // 4. 0x020: CAN_ERR_ACK (NO-ACK)
        let s_020 = decode_can_error_summary(0x020, &[0; 8]);
        assert_eq!(s_020, "NO-ACK");

        // 5. 0x040: CAN_ERR_BUSOFF
        let s_040 = decode_can_error_summary(0x040 | CAN_ERR_CNT, &[0, 0, 0, 0, 0, 0, 255, 0]);
        assert_eq!(s_040, "BUS-OFF | TEC=255 REC=0");

        let (st, cnt) =
            extract_bus_health_from_error_frame(0x040 | CAN_ERR_CNT, &[0, 0, 0, 0, 0, 0, 255, 3]);
        assert_eq!(st, Some(BusState::BusOff));
        assert_eq!(cnt, Some((255, 3)));

        // 6. Fallback when mask == 0 and data == 0
        assert_eq!(decode_can_error_summary(0, &[0; 8]), "Bus Error Frame");
    }
}
