//! Madde 8: CAN-FD ECU örneğine karşı 64 baytlık çerçevelerle VIN, 200 B DID ve büyük 0x36.
use automotive::protocols::uds::UDSClient;
use automotive::transports::isotp::IsoTP;
use automotive_eval::*;

#[tokio::test]
async fn t08_fd_vin_and_long_did() {
    let ecu = EcuSim::start("t08_fd_read", "default", FD, true);
    let dump = Candump::start("t08_fd_read", &[FD.req, FD.resp]);
    let adapter = adapter();
    let isotp = IsoTP::new(&adapter, isotp_config(FD, true));
    let uds = UDSClient::new(&isotp);
    let vin = uds.read_data_by_identifier(0xF190u16).await.unwrap();
    let long = uds.read_data_by_identifier(0xF1F1u16).await.unwrap();
    let f = dump.stop();
    print_capture(&f, 12);
    assert_eq!(vin, b"WNX0ECUSIM0000017");
    assert_eq!(long.len(), 200);
    assert!(f.iter().all(|l| l.fd), "all frames CAN-FD");
    // VIN answer (20 B) fits one FD SingleFrame with escape length byte: 00 14 ...
    let sf = f.iter().find(|l| l.id == FD.resp).unwrap();
    assert_eq!(&sf.data[..2], &[0x00, 0x14]);
    // 203 B answer = FF (62 B) + 3 CF (63 B each, last padded) instead of 29 classic CFs.
    let n_resp = f.iter().filter(|l| l.id == FD.resp).count();
    println!("frames from ECU: {n_resp} (VIN SF + FF + 3 CF); max DLC = {}",
        f.iter().map(|l| l.data.len()).max().unwrap());
    assert_eq!(n_resp, 1 + 1 + 3);
    assert_eq!(ecu.rx_data(), vec!["22F190", "22F1F1"]);
}

#[tokio::test]
async fn t08_fd_flash_4095_byte_blocks() {
    let ecu = EcuSim::start("t08_fd_flash", "fd_bigblock.json", FD, true);
    let adapter = adapter();
    let isotp = IsoTP::new(&adapter, isotp_config(FD, true));
    let uds = UDSClient::with_config(&isotp, flash_client_config());

    let dump = Candump::start("t08_fd_flash", &[FD.req, FD.resp]);
    let img = image(0x20000);
    let r = flash(&uds, &img, 0x0008_0000).await;
    let f = dump.stop();
    let bps = img.len() as f64 / r.transfer.as_secs_f64();
    println!(
        "FD: maxNumberOfBlockLength={} blocks={} transfer={:?} total={:?} => {:.1} KiB/s",
        r.max_block_len, r.blocks, r.transfer, r.total, bps / 1024.0
    );
    assert_eq!(r.max_block_len, 4095);
    assert_eq!(r.blocks, 0x20000_usize.div_ceil(4093));
    assert_eq!(r.crc_ecu, crc32(&img));
    // 0x36 of 4095 bytes -> 12-bit FF length 0xFFF: 1F FF 36 ..
    let ff = f.iter().find(|l| l.id == FD.req && l.data[0] == 0x1F).expect("FF");
    println!("first FF: {} (DLC {})", hex::encode_upper(&ff.data[..8]), ff.data.len());
    assert_eq!(&ff.data[..3], &[0x1F, 0xFF, 0x36]);
    assert_eq!(ff.data.len(), 64);
    assert_eq!(ecu.events_of("download_done").len(), 1);
}

/// PDU > 4095 B needs the FirstFrame 32-bit length escape (CAN-FD). ecusim cannot
/// receive it (UDS_TP_MTU 4095), so the oracle is a Linux kernel ISO-TP socket.
#[tokio::test]
async fn t08_fd_ff_escape_8192_bytes_to_kernel_isotp() {
    use automotive::protocols::uds::UDSConfig;
    use std::io::BufRead;
    let mut child = std::process::Command::new("python3")
        .arg("-I")
        .arg(spike_dir().join("tools/isotp_fd_sink.py"))
        .args(["vcan0", "0x6C0", "0x6C8"])
        .stdout(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    let mut out = std::io::BufReader::new(child.stdout.take().unwrap());
    let mut line = String::new();
    out.read_line(&mut line).unwrap();
    assert_eq!(line.trim(), "ready");

    let dump = Candump::start("t08_fd_escape", &[0x6C0, 0x6C8]);
    let adapter = adapter();
    let cfg = automotive::transports::isotp::IsoTPConfig::builder(id(0x6C0))
        .rx_id(id(0x6C8))
        .fd(true)
        .build()
        .unwrap();
    let isotp = IsoTP::new(&adapter, cfg);
    let uds = UDSClient::with_config(
        &isotp,
        UDSConfig::builder().p2_timeout(std::time::Duration::from_millis(500)).build(),
    );
    let data: Vec<u8> = (0..8190u32).map(|i| ((i + 2) & 0xFF) as u8).collect();
    let r = uds.transfer_data(0x01, Some(&data)).await;
    let f = dump.stop();
    line.clear();
    out.read_line(&mut line).unwrap();
    let _ = child.kill();
    let _ = child.wait();
    println!("kernel sink: {}", line.trim());
    let ff = f.iter().find(|l| l.id == 0x6C0 && l.data[0] == 0x10).expect("FF");
    println!("FF: {}", hex::encode_upper(&ff.data[..10]));
    assert_eq!(&ff.data[..6], &[0x10, 0x00, 0x00, 0x00, 0x20, 0x00]);
    assert_eq!(line.trim(), "rx len=8192 sid=36 pattern_ok=True");
    assert_eq!(r.unwrap(), None);
}
