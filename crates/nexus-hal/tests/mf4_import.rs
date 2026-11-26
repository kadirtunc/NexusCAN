use nexus_hal::pipeline::replay::{parse_trace_bytes, parse_trace_entries_from_bytes};

// Synthetic MDF 4.10 recording generated with asammdf 8.8.33 using zlib compression.
const MF4: &[u8] = include_bytes!("fixtures/mf4_can.mf4");

#[test]
fn imports_interleaved_can_and_can_fd_groups_as_trace() {
    let trace = parse_trace_bytes("capture.MF4", MF4).expect("read MF4");
    assert_eq!(trace.summary.format, "mf4");
    assert_eq!(trace.summary.frame_count, 3);
    assert_eq!(trace.summary.duration_us, 500);

    let entries = parse_trace_entries_from_bytes("capture", MF4).expect("detect MDF header");
    let first = entries[0].frame;
    assert_eq!(
        (entries[0].rel_us, first.bus_id, first.arb_id),
        (0, 1, 0x321)
    );
    assert_eq!(first.flags, 0);
    assert_eq!(&first.data[..usize::from(first.dlc)], &[0xde, 0xad]);

    let fd = entries[1].frame;
    assert_eq!((entries[1].rel_us, fd.bus_id, fd.arb_id), (250, 2, 0x123));
    assert_eq!(
        fd.flags,
        nexus_core::FLAG_EXTENDED
            | nexus_core::FLAG_FD
            | nexus_core::FLAG_BRS
            | nexus_core::FLAG_ESI
            | nexus_core::FLAG_TX
    );
    assert_eq!(
        &fd.data[..usize::from(fd.dlc)],
        &[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]
    );

    let short_fd = entries[2].frame;
    assert_eq!((entries[2].rel_us, short_fd.bus_id), (500, 2));
    assert_eq!(short_fd.flags, nexus_core::FLAG_FD);
    assert_eq!(&short_fd.data[..usize::from(short_fd.dlc)], &[0x5a]);
}

#[test]
fn rejects_invalid_mf4_instead_of_parsing_as_text() {
    for bytes in [b"plain text".as_slice(), b"MDF     4.10".as_slice()] {
        let error = parse_trace_entries_from_bytes("capture.mf4", bytes).unwrap_err();
        assert!(error.to_string().contains("MF4"));
    }
}
