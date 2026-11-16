//! ISO 15765-2 address formats (normal, normal fixed, extended, mixed): validation and the
//! address byte that precedes the PCI. Pure logic, shared by the UDS client and discovery.

use super::dto::AddressFormatDto;

/// Address byte before the PCI, per direction (`None` = normal / normal fixed addressing).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct AddressBytes {
    /// Prefix of every frame the tester sends (N_TA / N_AE).
    pub tx: Option<u8>,
    /// Required first byte of every frame from the ECU.
    pub rx: Option<u8>,
}

impl AddressBytes {
    /// Bytes before the PCI in tester frames (0 or 1).
    pub fn tx_offset(self) -> usize {
        usize::from(self.tx.is_some())
    }

    /// Bytes before the PCI in ECU frames (0 or 1).
    pub fn rx_offset(self) -> usize {
        usize::from(self.rx.is_some())
    }

    /// ISO-TP part of an ECU frame (`None` when the address byte does not match).
    pub fn rx_pdu(self, payload: &[u8]) -> Option<&[u8]> {
        match self.rx {
            None => Some(payload),
            Some(a) => match payload.split_first() {
                Some((&first, rest)) if first == a => Some(rest),
                _ => None,
            },
        }
    }
}

/// Address bytes for `format`. `extended` needs both bytes; `mixed` needs `target` and
/// defaults the response byte to it. `target` / `response` are ignored for the normal formats.
pub fn resolve_address_bytes(
    format: AddressFormatDto,
    target: Option<u8>,
    response: Option<u8>,
) -> Result<AddressBytes, String> {
    match format {
        AddressFormatDto::Normal | AddressFormatDto::NormalFixed => Ok(AddressBytes::default()),
        AddressFormatDto::Extended => {
            let tx = target.ok_or("addressFormat extended requires targetAddress (N_TA)")?;
            let rx = response
                .ok_or("addressFormat extended requires responseAddress (e.g. tester 0xF1)")?;
            Ok(AddressBytes {
                tx: Some(tx),
                rx: Some(rx),
            })
        }
        AddressFormatDto::Mixed => {
            let tx = target.ok_or("addressFormat mixed requires targetAddress (N_AE)")?;
            Ok(AddressBytes {
                tx: Some(tx),
                rx: Some(response.unwrap_or(tx)),
            })
        }
    }
}

/// 29-bit id with PDU format `pf` (priority bits ignored; DP / EDP must be 0).
pub fn is_pf_form(id: u32, pf: u8) -> bool {
    id <= 0x1FFF_FFFF && (id & 0x03FF_0000) == (u32::from(pf) << 16)
}

/// PF of physical / functional ids for the 29-bit fixed formats (`None` = no id form rule).
fn fixed_pf(format: AddressFormatDto, extended: bool) -> Result<Option<(u8, u8)>, String> {
    match (format, extended) {
        (AddressFormatDto::NormalFixed, true) => Ok(Some((0xDA, 0xDB))),
        (AddressFormatDto::NormalFixed, false) => {
            Err("addressFormat normalFixed requires 29-bit ids (0x18DA_TA_SA)".into())
        }
        (AddressFormatDto::Mixed, true) => Ok(Some((0xCE, 0xCD))),
        _ => Ok(None),
    }
}

/// Id form rules: `normalFixed` → 29-bit `0x18DA` physical / `0x18DB` functional; `mixed` →
/// 11-bit ids, or 29-bit `0x18CE` physical / `0x18CD` functional. `physical` = (name, id).
pub fn check_id_forms(
    format: AddressFormatDto,
    extended: bool,
    physical: &[(&str, u32)],
    functional: Option<u32>,
) -> Result<(), String> {
    let Some((phys_pf, func_pf)) = fixed_pf(format, extended)? else {
        return Ok(());
    };
    for (name, id) in physical {
        if !is_pf_form(*id, phys_pf) {
            return Err(format!(
                "{name} 0x{id:X} must have the 29-bit 0x18{phys_pf:02X}_TA_SA form for addressFormat {format:?}"
            ));
        }
    }
    if let Some(f) = functional {
        if !is_pf_form(f, func_pf) {
            return Err(format!(
                "functionalId 0x{f:X} must have the 29-bit 0x18{func_pf:02X}_TA_SA form for addressFormat {format:?}"
            ));
        }
    }
    Ok(())
}

/// Max UDS payload of one single frame: classic 7 / CAN-FD 62, one less with an address byte
/// (same as `automotive`: classic PCI below 8 - offset bytes, escape `00 len` above).
pub fn max_sf_payload(fd: bool, offset: usize) -> usize {
    if fd {
        62 - offset
    } else {
        7 - offset
    }
}

/// UDS payload bytes per consecutive frame (classic 7 / CAN-FD 63, minus the address byte).
pub fn cf_payload(fd: bool, offset: usize) -> usize {
    if fd {
        63 - offset
    } else {
        7 - offset
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use AddressFormatDto::*;

    #[test]
    fn resolve_rules() {
        assert_eq!(
            resolve_address_bytes(Normal, Some(1), Some(2)),
            Ok(AddressBytes::default())
        );
        assert_eq!(
            resolve_address_bytes(NormalFixed, None, None),
            Ok(AddressBytes::default())
        );
        assert!(resolve_address_bytes(Extended, None, Some(0xF1)).is_err());
        assert!(resolve_address_bytes(Extended, Some(0x10), None).is_err());
        assert_eq!(
            resolve_address_bytes(Extended, Some(0x10), Some(0xF1)),
            Ok(AddressBytes {
                tx: Some(0x10),
                rx: Some(0xF1)
            })
        );
        assert!(resolve_address_bytes(Mixed, None, None).is_err());
        assert_eq!(
            resolve_address_bytes(Mixed, Some(0x55), None),
            Ok(AddressBytes {
                tx: Some(0x55),
                rx: Some(0x55)
            })
        );
        assert_eq!(
            resolve_address_bytes(Mixed, Some(0x55), Some(0x66)).map(|a| a.rx),
            Ok(Some(0x66))
        );
    }

    #[test]
    fn id_form_rules() {
        let ok = |f, ext, req, resp, func| check_id_forms(f, ext, &[("r", req), ("s", resp)], func);
        assert!(ok(
            NormalFixed,
            true,
            0x18DA_10F1,
            0x18DA_F110,
            Some(0x18DB_33F1)
        )
        .is_ok());
        assert!(
            ok(NormalFixed, true, 0x1CDA_10F1, 0x1CDA_F110, None).is_ok(),
            "priority 7"
        );
        assert!(ok(NormalFixed, true, 0x18CE_10F1, 0x18DA_F110, None).is_err());
        assert!(ok(
            NormalFixed,
            true,
            0x18DA_10F1,
            0x18DA_F110,
            Some(0x18DA_33F1)
        )
        .is_err());
        assert!(ok(NormalFixed, false, 0x7E0, 0x7E8, None).is_err());
        assert!(
            ok(Mixed, false, 0x6F1, 0x6F9, Some(0x6FF)).is_ok(),
            "11-bit mixed"
        );
        assert!(ok(Mixed, true, 0x18CE_10F1, 0x18CE_F110, Some(0x18CD_33F1)).is_ok());
        assert!(ok(Mixed, true, 0x18DA_10F1, 0x18CE_F110, None).is_err());
        assert!(ok(Mixed, true, 0x18CE_10F1, 0x18CE_F110, Some(0x18DB_33F1)).is_err());
        assert!(
            ok(Mixed, true, 0x1BCE_10F1, 0x18CE_F110, None).is_err(),
            "DP set"
        );
        assert!(ok(Extended, false, 0x6F1, 0x6F9, None).is_ok());
        assert!(ok(Normal, true, 0x1234_5678, 0x0123_4567, None).is_ok());
    }

    #[test]
    fn payload_sizes_match_automotive() {
        assert_eq!(max_sf_payload(false, 0), 7);
        assert_eq!(max_sf_payload(false, 1), 6);
        assert_eq!(max_sf_payload(true, 0), 62);
        assert_eq!(max_sf_payload(true, 1), 61);
        assert_eq!(cf_payload(false, 1), 6);
        assert_eq!(cf_payload(true, 1), 62);
    }

    #[test]
    fn rx_pdu_strips_matching_byte_only() {
        let a = AddressBytes {
            tx: Some(0x10),
            rx: Some(0xF1),
        };
        assert_eq!(
            a.rx_pdu(&[0xF1, 0x02, 0x7E, 0x00]),
            Some(&[0x02, 0x7E, 0x00][..])
        );
        assert_eq!(a.rx_pdu(&[0xF2, 0x02, 0x7E, 0x00]), None);
        assert_eq!(a.rx_pdu(&[]), None);
        assert_eq!(AddressBytes::default().rx_pdu(&[1, 2]), Some(&[1, 2][..]));
    }
}
