//! Madde 4: 0x34 -> 0x36 döngüsü (BSC FF->00 sarması) -> 0x37 -> CRC32 rutini.
//! Flash helper (`flash`, `image`, `flash_client_config`) lives in src/lib.rs.
use automotive::protocols::uds::UDSClient;
use automotive::transports::isotp::IsoTP;
use automotive_eval::*;

#[tokio::test]
async fn t04_flash_128k_classic() {
    let ecu = EcuSim::start("t04_flash", "default", CLASSIC, false);
    let adapter = adapter();
    let isotp = IsoTP::new(&adapter, isotp_config(CLASSIC, false));
    let uds = UDSClient::with_config(&isotp, flash_client_config());

    let img = image(0x20000);
    let r = flash(&uds, &img, 0x0008_0000).await;
    let bps = img.len() as f64 / r.transfer.as_secs_f64();
    println!(
        "classic: maxNumberOfBlockLength={} blocks={} transfer={:?} total={:?} => {:.1} KiB/s",
        r.max_block_len, r.blocks, r.transfer, r.total, bps / 1024.0
    );
    assert_eq!(r.max_block_len, 130);
    assert_eq!(r.blocks, 0x20000 / 128);
    assert_eq!(r.crc_ecu, crc32(&img), "ECU CRC32 routine == local CRC32");

    // Evidence: ECU saw BSC ... FE FF 00 01 ... (wrap) and download_done crc.
    let bscs: Vec<String> = ecu
        .rx_data()
        .iter()
        .filter(|d| d.starts_with("36"))
        .map(|d| d[2..4].to_string())
        .collect();
    println!("BSC sequence around first wrap: {:?}", &bscs[252..260]);
    assert_eq!(&bscs[253..257], &["FE", "FF", "00", "01"]);
    let done = ecu.events_of("download_done");
    println!("ECU download_done: {done:?}");
    assert_eq!(done.len(), 1);
}

/// Same flash with the crate defaults (server P2 = 50 ms adopted, no margin).
/// Passes on an idle machine; failed 1/3 runs while 4 rustc jobs were running.
/// Ignored by default because it measures the host, not the crate logic.
#[tokio::test]
#[ignore = "timing-sensitive: demonstrates finding F-P2 under CPU load"]
async fn t04_flash_128k_default_timing() {
    let _ecu = EcuSim::start("t04_flash_default", "default", CLASSIC, false);
    let adapter = adapter();
    let isotp = IsoTP::new(&adapter, isotp_config(CLASSIC, false));
    let uds = UDSClient::new(&isotp);
    let img = image(0x20000);
    let r = flash(&uds, &img, 0x0008_0000).await;
    assert_eq!(r.crc_ecu, crc32(&img));
}
