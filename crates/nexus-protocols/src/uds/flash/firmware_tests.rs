use super::*;

/// Builds one Intel HEX record with a correct checksum.
pub(crate) fn ihex(rtype: u8, offset: u16, data: &[u8]) -> String {
    let mut bytes = vec![data.len() as u8, (offset >> 8) as u8, offset as u8, rtype];
    bytes.extend_from_slice(data);
    let cs = bytes
        .iter()
        .fold(0u8, |a, &b| a.wrapping_add(b))
        .wrapping_neg();
    bytes.push(cs);
    let hex: String = bytes.iter().map(|b| format!("{b:02X}")).collect();
    format!(":{hex}")
}

/// Builds one S-record with a correct checksum.
fn srec(rtype: u8, address: u32, data: &[u8]) -> String {
    let addr_len = match rtype {
        0 | 1 | 5 | 9 => 2,
        2 | 6 | 8 => 3,
        _ => 4,
    };
    let mut bytes = vec![(addr_len + data.len() + 1) as u8];
    bytes.extend_from_slice(&address.to_be_bytes()[4 - addr_len..]);
    bytes.extend_from_slice(data);
    let cs = !bytes.iter().fold(0u8, |a, &b| a.wrapping_add(b));
    bytes.push(cs);
    let hex: String = bytes.iter().map(|b| format!("{b:02X}")).collect();
    format!("S{rtype}{hex}")
}

fn seg(address: u32, data: &[u8]) -> FirmwareSegment {
    FirmwareSegment {
        address,
        data: data.to_vec(),
    }
}

// ─── Intel HEX ──────────────────────────────────────────────────────────────

#[test]
fn ihex_reference_record_and_eof() {
    // Classic reference record (16 bytes at 0x0100) + EOF, hand-written checksums.
    let text = ":10010000214601360121470136007EFE09D2190140\n:00000001FF\n";
    let img = parse_intel_hex(text).unwrap();
    assert_eq!(img.segments.len(), 1);
    assert_eq!(img.segments[0].address, 0x0100);
    assert_eq!(
        img.segments[0].data,
        [
            0x21, 0x46, 0x01, 0x36, 0x01, 0x21, 0x47, 0x01, 0x36, 0x00, 0x7E, 0xFE, 0x09, 0xD2,
            0x19, 0x01
        ]
    );
}

#[test]
fn ihex_merges_adjacent_and_keeps_gaps() {
    let text = [
        ihex(0, 0x0010, &[1, 2, 3, 4]),
        ihex(0, 0x0000, &[0xA; 16]), // out of order, adjacent to the first
        ihex(0, 0x0100, &[9, 9]),
        ihex(1, 0, &[]),
    ]
    .join("\r\n");
    let img = parse_intel_hex(&text).unwrap();
    assert_eq!(img.segments.len(), 2);
    assert_eq!(img.segments[0].address, 0);
    assert_eq!(img.segments[0].data.len(), 20);
    assert_eq!(&img.segments[0].data[16..], &[1, 2, 3, 4]);
    assert_eq!(img.segments[1], seg(0x100, &[9, 9]));
    assert_eq!(img.total_bytes(), 22);
}

#[test]
fn ihex_checksum_error_reports_line() {
    let mut bad = ihex(0, 0x0010, &[1, 2, 3]);
    bad.replace_range(bad.len() - 2.., "00");
    let text = format!("{}\n\n{bad}\n{}", ihex(0, 0, &[0]), ihex(1, 0, &[]));
    match parse_intel_hex(&text).unwrap_err() {
        FirmwareError::Checksum { line, stored, .. } => {
            assert_eq!(line, 3, "blank lines still count");
            assert_eq!(stored, 0);
        }
        e => panic!("unexpected {e:?}"),
    }
}

#[test]
fn ihex_extended_linear_address_04() {
    let text = [
        ihex(4, 0, &[0x08, 0x00]),
        ihex(0, 0x1000, &[0xDE, 0xAD]),
        ihex(4, 0, &[0x08, 0x01]),
        ihex(0, 0x0000, &[0xBE, 0xEF]),
        ihex(5, 0, &[0x08, 0x00, 0x10, 0x00]),
        ihex(1, 0, &[]),
    ]
    .join("\n");
    let img = parse_intel_hex(&text).unwrap();
    assert_eq!(
        img.segments,
        vec![
            seg(0x0800_1000, &[0xDE, 0xAD]),
            seg(0x0801_0000, &[0xBE, 0xEF])
        ]
    );
}

#[test]
fn ihex_linear_record_crossing_64k_continues_linearly() {
    let text = [
        ihex(4, 0, &[0x00, 0x01]),
        ihex(0, 0xFFFE, &[1, 2, 3, 4]),
        ihex(1, 0, &[]),
    ]
    .join("\n");
    let img = parse_intel_hex(&text).unwrap();
    assert_eq!(img.segments, vec![seg(0x0001_FFFE, &[1, 2, 3, 4])]);
}

#[test]
fn ihex_extended_segment_address_02_and_wrap() {
    let text = [
        ihex(2, 0, &[0x12, 0x00]), // SBA = 0x12000
        ihex(0, 0x0004, &[1, 2]),
        ihex(0, 0xFFFE, &[3, 4, 5, 6]), // wraps inside the segment → 0x21FFE.. and 0x12000..
        ihex(3, 0, &[0, 0, 0, 0]),
        ihex(1, 0, &[]),
    ]
    .join("\n");
    let img = parse_intel_hex(&text).unwrap();
    assert_eq!(
        img.segments,
        vec![
            seg(0x12000, &[5, 6]),
            seg(0x12004, &[1, 2]),
            seg(0x21FFE, &[3, 4])
        ]
    );
}

#[test]
fn ihex_overlap_reports_both_addresses_and_lines() {
    let text = [
        ihex(0, 0x0100, &[0; 16]),
        ihex(0, 0x0200, &[0; 4]),
        ihex(0, 0x0108, &[0; 4]),
        ihex(1, 0, &[]),
    ]
    .join("\n");
    match parse_intel_hex(&text).unwrap_err() {
        FirmwareError::Overlap {
            first_address,
            first_line,
            second_address,
            second_line,
            overlap_start,
        } => {
            assert_eq!((first_address, first_line), (0x100, Some(1)));
            assert_eq!((second_address, second_line), (0x108, Some(3)));
            assert_eq!(overlap_start, 0x108);
        }
        e => panic!("unexpected {e:?}"),
    }
    // Identical duplicate writes are still overlaps.
    let dup = [ihex(0, 0, &[1]), ihex(0, 0, &[1]), ihex(1, 0, &[])].join("\n");
    assert!(matches!(
        parse_intel_hex(&dup),
        Err(FirmwareError::Overlap { .. })
    ));
}

#[test]
fn ihex_structural_errors() {
    let eof = ihex(1, 0, &[]);
    // Missing EOF.
    assert_eq!(
        parse_intel_hex(&ihex(0, 0, &[1])).unwrap_err(),
        FirmwareError::MissingTerminator
    );
    // Data after EOF.
    let t = format!("{}\n{eof}\n{}", ihex(0, 0, &[1]), ihex(0, 1, &[2]));
    assert_eq!(
        parse_intel_hex(&t).unwrap_err(),
        FirmwareError::DataAfterTerminator { line: 3 }
    );
    // No data at all.
    assert_eq!(parse_intel_hex(&eof).unwrap_err(), FirmwareError::NoData);
    // Missing colon / bad digit / length mismatch / unknown type / bad 04 length.
    for (text, line) in [
        (format!("10010000\n{eof}"), 1),
        (format!(":0G\n{eof}"), 1),
        (format!("{}\n:0300000001FC\n{eof}", ihex(0, 0, &[1])), 2),
        (format!("{}\n{eof}", ihex(6, 0, &[])), 1),
        (format!("{}\n{eof}", ihex(4, 0, &[1])), 1),
        (format!(":00\n{eof}"), 1),
    ] {
        match parse_intel_hex(&text) {
            Err(FirmwareError::Syntax { line: l, .. }) => assert_eq!(l, line, "{text}"),
            r => panic!("{text}: {r:?}"),
        }
    }
}

#[test]
fn ihex_address_overflow_is_error() {
    let text = [
        ihex(4, 0, &[0xFF, 0xFF]),
        ihex(0, 0xFFFE, &[1, 2, 3]),
        ihex(1, 0, &[]),
    ]
    .join("\n");
    assert!(matches!(
        parse_intel_hex(&text),
        Err(FirmwareError::AddressOverflow { line: 2, .. })
    ));
}

// ─── S-record ───────────────────────────────────────────────────────────────

#[test]
fn srec_reference_records() {
    // Hand-written reference header / count / terminator records.
    let text = format!(
        "S00F000068656C6C6F202020202000003C\n{}\n{}\n{}\nS5030003F9\nS9030000FC\n",
        srec(1, 0x0000, &[1, 2, 3]),
        srec(1, 0x0003, &[4]),
        srec(1, 0x0010, &[5])
    );
    let img = parse_srec(&text).unwrap();
    assert_eq!(img.segments, vec![seg(0, &[1, 2, 3, 4]), seg(0x10, &[5])]);
}

#[test]
fn srec_s1_s2_s3_and_s7_s8() {
    let text = [
        srec(0, 0, b"hdr"),
        srec(3, 0x0800_0000, &[0xAA, 0xBB]),
        srec(2, 0x12_3456, &[0xCC]),
        srec(1, 0x1234, &[0xDD]),
        srec(7, 0x0800_0000, &[]),
    ]
    .join("\n");
    let img = parse_srec(&text).unwrap();
    assert_eq!(
        img.segments,
        vec![
            seg(0x1234, &[0xDD]),
            seg(0x12_3456, &[0xCC]),
            seg(0x0800_0000, &[0xAA, 0xBB])
        ]
    );
    let s8 = [srec(2, 0x10_0000, &[1]), srec(8, 0, &[])].join("\n");
    assert_eq!(
        parse_srec(&s8).unwrap().segments,
        vec![seg(0x10_0000, &[1])]
    );
}

#[test]
fn srec_count_record_verified() {
    let ok = [
        srec(1, 0, &[1]),
        srec(1, 1, &[2]),
        srec(5, 2, &[]),
        srec(9, 0, &[]),
    ]
    .join("\n");
    assert!(parse_srec(&ok).is_ok());
    let s6 = [srec(1, 0, &[1]), srec(6, 1, &[]), srec(9, 0, &[])].join("\n");
    assert!(parse_srec(&s6).is_ok());

    let bad = [
        srec(1, 0, &[1]),
        srec(1, 1, &[2]),
        srec(5, 3, &[]),
        srec(9, 0, &[]),
    ]
    .join("\n");
    assert_eq!(
        parse_srec(&bad).unwrap_err(),
        FirmwareError::RecordCount {
            line: 3,
            stored: 3,
            actual: 2
        }
    );
}

#[test]
fn srec_checksum_error_reports_line() {
    let mut bad = srec(1, 0x10, &[1, 2]);
    bad.replace_range(bad.len() - 2.., "00");
    let text = [srec(0, 0, &[]), srec(1, 0, &[1]), bad, srec(9, 0, &[])].join("\n");
    assert!(matches!(
        parse_srec(&text),
        Err(FirmwareError::Checksum {
            line: 3,
            stored: 0,
            ..
        })
    ));
}

#[test]
fn srec_structural_errors() {
    let s9 = srec(9, 0, &[]);
    assert_eq!(
        parse_srec(&srec(1, 0, &[1])).unwrap_err(),
        FirmwareError::MissingTerminator
    );
    assert_eq!(
        parse_srec(&format!("{s9}\n{}", srec(1, 0, &[1]))).unwrap_err(),
        FirmwareError::DataAfterTerminator { line: 2 }
    );
    assert_eq!(
        parse_srec(&format!("{}\n{s9}", srec(0, 0, &[]))).unwrap_err(),
        FirmwareError::NoData
    );
    for text in [
        format!("X1030000FC\n{s9}"),
        format!("S4030000FC\n{s9}"),
        format!("S1\n{s9}"),
        format!("S105000001\n{s9}"), // count says 5, carries 4
        format!("S10200FD\n{s9}"),   // count too small for S1
        format!("Sx030000FC\n{s9}"),
    ] {
        assert!(
            matches!(
                parse_srec(&text),
                Err(FirmwareError::Syntax { line: 1, .. })
            ),
            "{text}: {:?}",
            parse_srec(&text)
        );
    }
}

#[test]
fn srec_overlap_detected() {
    let text = [
        srec(3, 0x1000, &[0; 8]),
        srec(3, 0x1004, &[0; 8]),
        srec(7, 0, &[]),
    ]
    .join("\n");
    assert!(matches!(
        parse_srec(&text),
        Err(FirmwareError::Overlap {
            first_address: 0x1000,
            second_address: 0x1004,
            ..
        })
    ));
}

// ─── Binary / helpers / summary ─────────────────────────────────────────────

#[test]
fn binary_and_detection() {
    let img = from_binary(&[1, 2, 3], 0x0800_0000).unwrap();
    assert_eq!(img.segments, vec![seg(0x0800_0000, &[1, 2, 3])]);
    assert_eq!(from_binary(&[], 0).unwrap_err(), FirmwareError::NoData);
    assert!(matches!(
        from_binary(&[0; 4], 0xFFFF_FFFE),
        Err(FirmwareError::AddressOverflow { .. })
    ));
    assert!(from_binary(&[0; 2], 0xFFFF_FFFE).is_ok());

    assert_eq!(detect_format(b"\n:00000001FF"), FirmwareFormat::IntelHex);
    assert_eq!(detect_format(b"S9030000FC"), FirmwareFormat::Srec);
    assert_eq!(detect_format(&[0x00, 0xFF, 0x80]), FirmwareFormat::Binary);
    assert_eq!(detect_format(b"Solid"), FirmwareFormat::Binary);

    let hex = format!("\u{FEFF}{}\n:00000001FF", ihex(0, 0, &[7]));
    let img = FirmwareImage::load(hex.as_bytes(), FirmwareFormat::IntelHex, 0).unwrap();
    assert_eq!(img.segments, vec![seg(0, &[7])]);
    assert!(matches!(
        FirmwareImage::load(&[0xFF, 0xFE], FirmwareFormat::Srec, 0),
        Err(FirmwareError::InvalidArgument(_))
    ));
}

#[test]
fn from_segments_normalises() {
    let img =
        FirmwareImage::from_segments(vec![seg(10, &[2]), seg(8, &[0, 1]), seg(20, &[3])]).unwrap();
    assert_eq!(img.segments, vec![seg(8, &[0, 1, 2]), seg(20, &[3])]);
    assert!(matches!(
        FirmwareImage::from_segments(vec![seg(0, &[0; 4]), seg(3, &[0])]),
        Err(FirmwareError::Overlap {
            first_line: None,
            ..
        })
    ));
}

#[test]
fn fill_gaps_and_split() {
    let mut img =
        FirmwareImage::from_segments(vec![seg(0, &[1, 2]), seg(4, &[3]), seg(100, &[4])]).unwrap();
    img.fill_gaps(2, 0xFF);
    assert_eq!(
        img.segments,
        vec![seg(0, &[1, 2, 0xFF, 0xFF, 3]), seg(100, &[4])]
    );
    img.fill_gaps(1000, 0x00);
    assert_eq!(img.segments.len(), 1);
    assert_eq!(img.segments[0].data.len(), 101);
    assert_eq!(img.total_bytes(), 101);

    img.split_max(40).unwrap();
    let lens: Vec<_> = img
        .segments
        .iter()
        .map(|s| (s.address, s.data.len()))
        .collect();
    assert_eq!(lens, vec![(0, 40), (40, 40), (80, 21)]);
    assert!(img.split_max(0).is_err());
}

#[test]
fn summary_shape_and_crc() {
    let img =
        FirmwareImage::from_segments(vec![seg(0x100, b"12345"), seg(0x200, b"6789")]).unwrap();
    let s = img.summary();
    assert_eq!(s.total_bytes, 9);
    assert_eq!(
        s.crc32, 0xCBF4_3926,
        "whole-image CRC over concatenated data"
    );
    assert_eq!(s.segments[1].crc32, crc32_ieee(b"6789"));
    let json = serde_json::to_value(&s).unwrap();
    assert_eq!(
        json,
        serde_json::json!({
            "segments": [
                {"address": 256, "length": 5, "crc32": crc32_ieee(b"12345")},
                {"address": 512, "length": 4, "crc32": crc32_ieee(b"6789")}
            ],
            "totalBytes": 9,
            "crc32": 0xCBF4_3926u32
        })
    );
}

#[test]
fn garbage_input_never_panics() {
    let mut x: u32 = 0x1234_5678;
    let alphabet = b":S0123456789ABCDEFabcdefxyz \n\r";
    for _ in 0..2000 {
        let mut s = String::new();
        for _ in 0..(x % 80) {
            x = x.wrapping_mul(1_103_515_245).wrapping_add(12345);
            s.push(alphabet[(x >> 16) as usize % alphabet.len()] as char);
        }
        let _ = parse_intel_hex(&s);
        let _ = parse_srec(&s);
        let _ = parse_intel_hex(&format!(":{s}"));
        let _ = parse_srec(&format!("S1{s}"));
    }
}
