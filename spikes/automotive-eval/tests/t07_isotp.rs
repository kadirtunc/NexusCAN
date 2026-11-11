//! Madde 7: ISO-TP ayarları: padding, STmin, blok boyutu, extended adresleme,
//! fonksiyonel adresleme, N_As/N_Bs/N_Cr zaman aşımları.
use automotive::protocols::uds::{RequestOutcome, UDSClient, UDSConfig};
use automotive::transports::isotp::IsoTP;
use automotive_eval::*;
use std::io::BufRead;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

#[tokio::test]
async fn t07_padding_value_and_no_padding() {
    let _ecu = EcuSim::start("t07_pad", "default", CLASSIC, false);
    let adapter = adapter();

    let dump = Candump::start("t07_pad55", &[CLASSIC.req, CLASSIC.resp]);
    let isotp = IsoTP::new(&adapter, isotp_builder(CLASSIC, false).padding(0x55).build().unwrap());
    UDSClient::new(&isotp).read_data_by_identifier(0xF190u16).await.unwrap();
    let f = dump.stop();
    print_capture(&f, 10);
    let ours: Vec<_> = f.iter().filter(|l| l.id == CLASSIC.req).collect();
    assert_eq!(hex::encode_upper(&ours[0].data), "0322F19055555555");
    assert_eq!(hex::encode_upper(&ours[1].data), "3000005555555555", "FC padded too");

    let dump = Candump::start("t07_nopad", &[CLASSIC.req, CLASSIC.resp]);
    let isotp = IsoTP::new(&adapter, isotp_builder(CLASSIC, false).without_padding().build().unwrap());
    UDSClient::new(&isotp).read_data_by_identifier(0xF190u16).await.unwrap();
    let f = dump.stop();
    print_capture(&f, 10);
    let ours: Vec<_> = f.iter().filter(|l| l.id == CLASSIC.req).collect();
    assert_eq!(hex::encode_upper(&ours[0].data), "0322F190", "DLC 4");
    assert_eq!(hex::encode_upper(&ours[1].data), "300000", "FC DLC 3");
}

#[tokio::test]
async fn t07_receive_stmin_and_block_size_and_p6_effect() {
    let _ecu = EcuSim::start("t07_rxfc", "default", CLASSIC, false);
    let adapter = adapter();
    let cfg = isotp_builder(CLASSIC, false)
        .receive_separation_time_min(Duration::from_millis(5))
        .block_size(4)
        .build()
        .unwrap();
    let isotp = IsoTP::new(&adapter, cfg);

    // Default P2 (50 ms) covers the WHOLE multi-frame reception (P6 semantics):
    // 28 CFs x 5 ms STmin > 50 ms -> Timeout although the ECU answered at once.
    let err = UDSClient::new(&isotp).read_data_by_identifier(0xF1F1u16).await.unwrap_err();
    println!("F1F1 (200 B) with STmin 5 ms and default P2 -> {err:?}");
    assert!(matches!(err, automotive::Error::Timeout));
    // The client dropped its receive stream at P2 => no further FC. The ECU's
    // kernel ISO-TP sender now waits N_Bs (1 s) and a request sent meanwhile
    // gets a broken answer (seen: ecusim isotp_error errno 70). Wait it out.
    tokio::time::sleep(Duration::from_millis(1500)).await;

    let dump = Candump::start("t07_rxfc", &[CLASSIC.req, CLASSIC.resp]);
    let uds = UDSClient::with_config(
        &isotp,
        UDSConfig::builder().p2_timeout(Duration::from_millis(1000)).build(),
    );
    let t = Instant::now();
    let v = uds.read_data_by_identifier(0xF1F1u16).await.unwrap();
    let took = t.elapsed();
    let f = dump.stop();
    print_capture(&f, 12);
    let fcs: Vec<_> = f.iter().filter(|l| l.id == CLASSIC.req && l.data[0] == 0x30).collect();
    let gap = min_cf_gap_in_block_ms(&f, CLASSIC.resp, CLASSIC.req).unwrap();
    println!("200 B in {took:?}; our FCs = {} (each {}), min ECU CF gap = {gap:.3} ms",
        fcs.len(), hex::encode_upper(&fcs[0].data[..3]));
    assert_eq!(v.len(), 200);
    // 203-byte PDU = FF(6) + 29 CF -> FC after FF and after CF 4, 8, ..., 28.
    assert_eq!(fcs.len(), 8);
    assert_eq!(&fcs[0].data[..3], &[0x30, 0x04, 0x05]);
    assert!(gap >= 4.9);
}

#[tokio::test]
async fn t07_sender_respects_ecu_bs_stmin_and_tx_override() {
    let _ecu = EcuSim::start("t07_txfc", "isotp_bs2_st10.json", CLASSIC, false);
    let adapter = adapter();
    // 22 + 20 x F186 = 41 bytes -> FF + 5 CF
    let mut req = Vec::new();
    for _ in 0..20 {
        req.extend([0xF1, 0x86]);
    }
    let cfg = UDSConfig::builder().p2_timeout(Duration::from_millis(500)).build();

    let dump = Candump::start("t07_txfc", &[CLASSIC.req, CLASSIC.resp]);
    let isotp = IsoTP::new(&adapter, isotp_config(CLASSIC, false));
    let out = UDSClient::with_config(&isotp, cfg).request(0x22u8, None, Some(&req)).await.unwrap();
    let f = dump.stop();
    print_capture(&f, 16);
    let ecu_fcs: Vec<_> = f.iter().filter(|l| l.id == CLASSIC.resp && l.data[0] == 0x30).collect();
    let our_gap = min_cf_gap_in_block_ms(&f, CLASSIC.req, CLASSIC.resp).unwrap();
    println!("ECU FCs = {} ({}), min gap between our CFs = {our_gap:.3} ms",
        ecu_fcs.len(), hex::encode_upper(&ecu_fcs[0].data[..3]));
    assert!(matches!(out, RequestOutcome::PositiveResponse(ref d) if d.len() == 60));
    assert_eq!(ecu_fcs.len(), 3, "BS=2 with 5 CFs -> 3 FCs");
    assert!(our_gap >= 9.9, "ECU STmin 10 ms honoured");

    // Override transmit STmin: 20 ms regardless of the ECU's 10 ms.
    let dump = Candump::start("t07_txoverride", &[CLASSIC.req]);
    let isotp = IsoTP::new(
        &adapter,
        isotp_builder(CLASSIC, false).separation_time_min(Duration::from_millis(20)).build().unwrap(),
    );
    UDSClient::with_config(&isotp, cfg).request(0x22u8, None, Some(&req)).await.unwrap();
    let f = dump.stop();
    let our_gap = min_gap_ms(&f, CLASSIC.req, 0x2).unwrap();
    println!("override 20 ms -> min gap {our_gap:.3} ms");
    assert!(our_gap >= 19.9);
}

#[tokio::test]
async fn t07_extended_addressing_against_kernel_isotp() {
    const TX: u32 = 0x6F0;
    const RX: u32 = 0x6F8;
    let script = spike_dir().join("tools/isotp_ext_echo.py");
    let mut child = Command::new("python3")
        .arg("-I")
        .arg(script)
        .args(["vcan0", "0x6F0", "0x6F8", "0xF1", "0x10"])
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut out = std::io::BufReader::new(child.stdout.take().unwrap());
    let mut line = String::new();
    out.read_line(&mut line).unwrap();
    assert_eq!(line.trim(), "ready");

    let dump = Candump::start("t07_extaddr", &[TX, RX]);
    let adapter = adapter();
    let cfg = automotive::transports::isotp::IsoTPConfig::builder(id(TX))
        .rx_id(id(RX))
        .ext_address(0x10)
        .rx_ext_address(0xF1)
        .build()
        .unwrap();
    let isotp = IsoTP::new(&adapter, cfg);
    let uds = UDSClient::new(&isotp);
    let vin = uds.read_data_by_identifier(0xF190u16).await;
    // multi-frame request with extended addressing (server answers 7F 22 11)
    let big = uds.request(0x22u8, None, Some(&[0xF1, 0x86].repeat(10))).await;
    let f = dump.stop();
    let _ = child.kill();
    let _ = child.wait();
    print_capture(&f, 16);
    println!("ext-addr VIN -> {vin:?}; multi-frame request -> {big:?}");
    assert_eq!(vin.unwrap(), b"EXTADDR0VIN000017");
    assert_eq!(nrc_of(&big.unwrap_err()), Some(0x11));
    assert!(f.iter().filter(|l| l.id == TX).all(|l| l.data[0] == 0x10));
    assert!(f.iter().filter(|l| l.id == RX).all(|l| l.data[0] == 0xF1));
}

#[tokio::test]
async fn t07_functional_obd_and_tester_present() {
    let ecu = EcuSim::start("t07_func", "default", CLASSIC, false);
    let adapter = adapter();
    let func = IsoTP::new(
        &adapter,
        automotive::transports::isotp::IsoTPConfig::builder(id(CLASSIC.func))
            .rx_id(id(CLASSIC.resp))
            .build()
            .unwrap(),
    );
    let uds = UDSClient::new(&func);
    // OBD-II mode 01 PID 0C (engine speed) over the functional ID.
    let r = uds.request(0x01u8, None, Some(&[0x0C])).await.unwrap();
    println!("functional 01 0C -> {r:02X?}");
    assert_eq!(r, RequestOutcome::PositiveResponse(vec![0x0C, 0x1A, 0xF8]));
    uds.tester_present().await.unwrap();
    uds.suppress_positive_responses().tester_present().await.unwrap();
    let rx: Vec<_> = ecu.events_of("rx").iter().map(|e| format!("{}:{}", e["ta"], e["data"])).collect();
    println!("ECU rx: {rx:?}");
    assert!(rx.iter().all(|r| r.starts_with("\"func\"")));
}

#[tokio::test]
async fn t07_functional_multiframe_response_flow_control() {
    let _ecu = EcuSim::start("t07_funcmf", "default", CLASSIC, false);
    let adapter = adapter();
    let func_cfg = automotive::transports::isotp::IsoTPConfig::builder(id(CLASSIC.func))
        .rx_id(id(CLASSIC.resp))
        .build()
        .unwrap();

    // Plain functional IsoTP: FC for the multi-frame answer goes to the FUNCTIONAL id.
    let dump = Candump::start("t07_funcmf_plain", &[CLASSIC.func, CLASSIC.req, CLASSIC.resp]);
    let func = IsoTP::new(&adapter, func_cfg);
    let cfg = UDSConfig::builder().p2_timeout(Duration::from_millis(1500)).build();
    let plain = UDSClient::with_config(&func, cfg).read_data_by_identifier(0xF190u16).await;
    let f = dump.stop();
    print_capture(&f, 10);
    println!("plain functional 22 F190 -> {plain:?}");
    let fc_on_func = f.iter().any(|l| l.id == CLASSIC.func && l.data[0] == 0x30);
    assert!(fc_on_func, "crate sends FC on the functional id");
    assert!(plain.is_err(), "ECU waits for FC on its physical id -> transfer fails");
    tokio::time::sleep(Duration::from_millis(1200)).await;

    // Work-around: send functional, receive + FC on physical.
    let dump = Candump::start("t07_funcmf_split", &[CLASSIC.func, CLASSIC.req, CLASSIC.resp]);
    let split = SplitTransport {
        func: IsoTP::new(&adapter, func_cfg),
        phys: IsoTP::new(&adapter, isotp_config(CLASSIC, false)),
    };
    let vin = UDSClient::new(&split).read_data_by_identifier(0xF190u16).await;
    let f = dump.stop();
    print_capture(&f, 10);
    assert_eq!(vin.unwrap(), b"WNX0ECUSIM0000017");
    assert!(f.iter().any(|l| l.id == CLASSIC.req && l.data[0] == 0x30));
}

#[tokio::test]
async fn t07_n_bs_timeout_when_no_flow_control() {
    let adapter = adapter();
    let cfg = automotive::transports::isotp::IsoTPConfig::builder(id(0x6D0))
        .rx_id(id(0x6D8))
        .timeout(Duration::from_millis(300))
        .build()
        .unwrap();
    let isotp = IsoTP::new(&adapter, cfg);
    let t = Instant::now();
    let err = isotp.send(&[0x2E; 20]).await.unwrap_err();
    println!("multi-frame send, nobody answers FC -> {err:?} after {:?}", t.elapsed());
    assert!(matches!(err, automotive::Error::Timeout));
    assert!(t.elapsed() >= Duration::from_millis(300) && t.elapsed() < Duration::from_millis(450));
}

#[tokio::test]
async fn t07_n_cr_timeout_and_indistinguishable_error() {
    let adapter = adapter();
    let ecu_side = automotive_eval::adapter();
    let cfg = automotive::transports::isotp::IsoTPConfig::builder(id(0x6E0))
        .rx_id(id(0x6E8))
        .timeout(Duration::from_millis(300))
        .build()
        .unwrap();
    let isotp = IsoTP::new(&adapter, cfg);
    let uds = UDSClient::with_config(
        &isotp,
        UDSConfig::builder().p2_timeout(Duration::from_secs(2)).build(),
    );
    // FF announcing 20 bytes, one CF, then silence.
    let script = vec![
        (1, vec![0x10, 0x14, 0x62, 0xF1, 0x90, 0x41, 0x41, 0x41]),
        (1, vec![0x21, 0x42, 0x42, 0x42, 0x42, 0x42, 0x42, 0x42]),
    ];
    let t = Instant::now();
    let (res, seen) = tokio::join!(
        async {
            let r = uds.read_data_by_identifier(0xF190u16).await;
            (r, t.elapsed())
        },
        fake_ecu(&ecu_side, 0x6E0, 0x6E8, script, Duration::from_millis(600))
    );
    let (res, took) = res;
    println!("missing CF -> {res:?} after {took:?}; fake ECU saw {:02X?}", seen);
    // Same variant as a P2 timeout: the caller cannot tell N_Cr from P2/P2*.
    assert!(matches!(res, Err(automotive::Error::Timeout)));
    assert!(took >= Duration::from_millis(300) && took < Duration::from_millis(450));
}

#[tokio::test]
async fn t07_29bit_normal_fixed_addressing() {
    let ids = Ids { req: 0x18DA_10F1, resp: 0x18DA_F110, func: 0x18DB_33F1 };
    let ecu = EcuSim::start("t07_29bit", "default", ids, false);
    let adapter = adapter();
    // rx id derived automatically by swapping the address bytes (TA/SA).
    let cfg = automotive::transports::isotp::IsoTPConfig::builder(
        automotive::can::Identifier::extended(ids.req).unwrap(),
    )
    .build()
    .unwrap();
    println!("tx {:?} -> derived rx {:?}", cfg.tx_id, cfg.rx_id);
    assert_eq!(u32::from(cfg.rx_id), ids.resp);
    let isotp = IsoTP::new(&adapter, cfg);
    let vin = UDSClient::new(&isotp).read_data_by_identifier(0xF190u16).await.unwrap();
    assert_eq!(vin, b"WNX0ECUSIM0000017");
    println!("ECU ready event: {:?}", ecu.events_of("ready"));
    assert_eq!(ecu.rx_data(), vec!["22F190"]);
}
