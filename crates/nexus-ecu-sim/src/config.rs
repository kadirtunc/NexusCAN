//! CLI value parsers shared by the binaries (kept in the library so they are
//! unit-tested on every platform).

/// Parses `0x…` / `0X…` hexadecimal or plain decimal.
pub fn parse_num(s: &str) -> Result<u64, String> {
    let t = s.trim().replace('_', "");
    let r = if let Some(h) = t.strip_prefix("0x").or_else(|| t.strip_prefix("0X")) {
        u64::from_str_radix(h, 16)
    } else {
        t.parse::<u64>()
    };
    r.map_err(|e| format!("invalid number '{s}': {e}"))
}

pub fn parse_u32(s: &str) -> Result<u32, String> {
    let v = parse_num(s)?;
    u32::try_from(v).map_err(|_| format!("'{s}' does not fit in 32 bits"))
}

pub fn parse_u8(s: &str) -> Result<u8, String> {
    let v = parse_num(s)?;
    u8::try_from(v).map_err(|_| format!("'{s}' does not fit in 8 bits"))
}

/// Parses a byte that is *always* hexadecimal (UDS service IDs and NRCs are
/// conventionally written in hex): `0x36`, `36`, `7f`.
pub fn parse_hex_u8(s: &str) -> Result<u8, String> {
    let t = s.trim();
    let h = t
        .strip_prefix("0x")
        .or_else(|| t.strip_prefix("0X"))
        .unwrap_or(t);
    if h.is_empty() || h.len() > 2 {
        return Err(format!("expected a hex byte, got '{s}'"));
    }
    u8::from_str_radix(h, 16).map_err(|e| format!("invalid hex byte '{s}': {e}"))
}

/// A CAN ID that can be switched off (`--functional off`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OptionalId(pub Option<u32>);

/// Parses a CAN ID, or `off` / `none` / `disabled` for no ID.
pub fn parse_optional_id(s: &str) -> Result<OptionalId, String> {
    match s.trim().to_ascii_lowercase().as_str() {
        "off" | "none" | "disabled" | "no" => Ok(OptionalId(None)),
        _ => {
            let v = parse_u32(s)?;
            if v > 0x1FFF_FFFF {
                return Err(format!("'{s}' is not a valid 29-bit CAN ID"));
            }
            Ok(OptionalId(Some(v)))
        }
    }
}

/// `ADDRESS:LENGTH` memory region (both hex `0x…` or decimal).
pub fn parse_region(s: &str) -> Result<(u32, u32), String> {
    let (a, l) = s
        .split_once(':')
        .ok_or_else(|| format!("region '{s}' must be ADDRESS:LENGTH"))?;
    let addr = parse_u32(a)?;
    let len = parse_u32(l)?;
    if len == 0 {
        return Err(format!("region '{s}' has zero length"));
    }
    if u64::from(addr) + u64::from(len) > 1u64 << 32 {
        return Err(format!("region '{s}' exceeds the 32-bit address space"));
    }
    Ok((addr, len))
}

/// Validates that regions do not overlap.
pub fn check_regions(regions: &[(u32, u32)]) -> Result<(), String> {
    let mut v: Vec<(u64, u64)> = regions
        .iter()
        .map(|&(a, l)| (u64::from(a), u64::from(a) + u64::from(l)))
        .collect();
    v.sort_unstable();
    for w in v.windows(2) {
        if w[1].0 < w[0].1 {
            return Err(format!(
                "memory regions overlap: 0x{:08X}..0x{:08X} and 0x{:08X}..0x{:08X}",
                w[0].0, w[0].1, w[1].0, w[1].1
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numbers() {
        assert_eq!(parse_num("0x7E0").unwrap(), 0x7E0);
        assert_eq!(parse_num("2016").unwrap(), 2016);
        assert_eq!(parse_num("0x0800_0000").unwrap(), 0x0800_0000);
        assert!(parse_u8("0x100").is_err());
        assert_eq!(parse_hex_u8("36").unwrap(), 0x36);
        assert_eq!(parse_hex_u8("0x7f").unwrap(), 0x7F);
        assert!(parse_hex_u8("0x123").is_err());
        assert_eq!(parse_optional_id("0x7DF").unwrap(), OptionalId(Some(0x7DF)));
        assert_eq!(parse_optional_id("off").unwrap(), OptionalId(None));
        assert_eq!(parse_optional_id("NONE").unwrap(), OptionalId(None));
        assert!(parse_optional_id("0x20000000").is_err());
        assert!(parse_optional_id("bogus").is_err());
    }

    #[test]
    fn regions() {
        assert_eq!(
            parse_region("0x08000000:0x80000").unwrap(),
            (0x0800_0000, 0x8_0000)
        );
        assert!(parse_region("0xFFFFFFFF:2").is_err());
        assert!(parse_region("0x1000").is_err());
        assert!(check_regions(&[(0, 0x100), (0x100, 0x100)]).is_ok());
        assert!(check_regions(&[(0, 0x101), (0x100, 0x100)]).is_err());
    }
}
