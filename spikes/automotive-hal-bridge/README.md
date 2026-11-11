# Spike: `automotive` 0.6.0 ISO-TP + UDS üzerinde NexusCAN HAL köprüsü

**Durum:** değerlendirme denemesi (spike), ürün kodu değil. Root workspace'e üye değil (kendi
`[workspace]` tablosu var). `crates/`, `src-tauri/`, `src/`, `tests/` altında hiçbir dosya değiştirilmedi.
`nexus-core` ve `nexus-hal` yalnızca path bağımlılığı olarak kullanılıyor.

Soru: [`automotive`](https://github.com/I-CAN-hack/automotive) (MIT) crate'inin **yalnızca ISO-TP + UDS**
katmanını kullanıp CAN erişimini kendi HAL'imizden (`nexus-hal`) verebilir miyiz? Maliyeti ne?

**Kısa cevap:** Evet, **ürün HAL'inde küçük değişikliklerle uygulanabilir** (aşağıdaki "Ürün değişiklikleri"
bölümüne bakın). Bu spike'ta klasik CAN ve CAN-FD (BRS) üzerinden VIN okuma, çok çerçeveli RX/TX, 0x78, NRC,
Panic Stop ile aktarımı yarıda kesme ve owner thread'de sıfır heap tahsisi kanıtlandı.

## Yapı

| Dosya | İçerik |
|---|---|
| `src/owner.rs` | `BusOwner`: kanalı tek başına sahiplenen thread (`run_bus_io_loop` ile aynı model) + **tap** fan-out + kaynağa (origin) göre TX onayı + **yetkili güvenlik kapısı** (Listen-Only / Arm / Panic latch, `send_frame`'den hemen önce) |
| `src/adapter.rs` | `HalCanAdapter`: `automotive::can::CanAdapter`'ı bir tap üzerine uygular. `ConversationLog` (HAL zaman damgalı CAN seviyesi günlük). `PassiveCanAdapter` (pasif dinleme denemesi) |
| `src/convert.rs` | `RawCanFrame` (80 B) ↔ `automotive::can::Frame` dönüşümü + birim testleri |
| `src/lib.rs` | `open_bus` (ürünün `DriverRegistry`'si ile), gerçek `nexus_hal::StateTable`'ı besleyen aggregator thread'i, `open_diag_session` |
| `src/main.rs` | Senaryolar: `uds`, `panic`, `gate`, `passive`, `mock`, `alloc`, `cpu` |

## Çalıştırma

```bash
# Sanal ECU'lar (bu spike 0x7E4/0x7EC ve FD için 0x7E5/0x7ED kullanır)
make -C tests/hil/ecusim            # build/ecusim yoksa
tests/hil/ecusim/build/ecusim -i vcan0 -c tests/hil/ecusim/config/default.json \
    --req 0x7E4 --resp 0x7EC --func 0x7DD -l /tmp/ecu_7e4.jsonl &
tests/hil/ecusim/build/ecusim -i vcan0 -c tests/hil/ecusim/config/default.json \
    --req 0x7E5 --resp 0x7ED --func 0x7DC --fd -l /tmp/ecu_7e5.jsonl &

cd spikes/automotive-hal-bridge
cargo test                                         # dönüşüm birim testleri (6)
cargo run -- uds socketcan:vcan0 7E4 7EC           # klasik CAN
cargo run -- uds socketcan:vcan0 7E5 7ED --fd      # CAN-FD + BRS
cargo run -- gate                                  # Listen-Only / Disarmed / yalnızca owner kapısı
cargo run -- panic                                 # 4000 B ISO-TP gönderimi sırasında Panic Stop
cargo run -- passive                               # Listen-Only'de 3. taraf tester oturumunu birleştirme
cargo run -- mock                                  # mock:mock0 üzerinde köprü (arkada ECU yok)
cargo run --release -- alloc                       # 25 kfps'de owner thread heap tahsisi sayımı
cargo run --release -- cpu                         # açık oturumun boştaki CPU maliyeti
```

Her senaryo `[PASS]/[FAIL]` satırları ve `RESULT:` ile biter; çıkış kodu 0 = hepsi geçti.

## Arayüzler (kaynaktan çıkarıldı)

### `automotive` 0.6.0
- `can::CanAdapter` (**bloklayan trait**, tek takılma noktası): `send(&mut VecDeque<Frame>)`,
  `recv() -> Vec<Frame>`, isteğe bağlı `default_brs()`, `buffer_size()`, `cancel_pending_tx()`, `tx_timeout()`.
- `can::AsyncCanAdapter` bir **trait değil, somut struct**. `new(adapter)` kendi `std::thread`'ini açar,
  adaptörü o thread sahiplenir. Döngü: `recv()` → yayın (`tokio::broadcast`, 8192) → TX kuyruğu → `send()` →
  `sleep(1µs)`. `IsoTP` yalnızca `&AsyncCanAdapter` / `Arc<AsyncCanAdapter>` kabul eder.
- `can::Frame`: `bus: u8`, `loopback: bool`, `FrameContent::{Classic, Fd{brs, esi}, Remote, Error}`,
  `ArrayVec<u8, 64>`. **Zaman damgası alanı yok.**
- **Gönderim onayı zorunlu:** `AsyncCanAdapter::send` ancak `recv()` aynı `(bus, id)` ve aynı payload'lı bir
  `loopback = true` çerçeve döndürdüğünde tamamlanır. ISO-TP her çerçeve için bunu `config.timeout` (N_As,
  varsayılan 1 s) süresince bekler. İlk onaydan sonra eşleşmeyen bir loopback gelirse `assert!` ile **panic**
  olur (`async_can.rs`). Bu yüzden köprü onayı **yalnızca çerçeveyi gönderen tap'e** verir.
- Adaptör hatası (`send`/`recv` `Err`) worker'ı sonlandırır. Bekleyen ve sonraki tüm gönderimler **aynı hata
  varyantını** alır (`Error::IoError(..)` korunur). O `AsyncCanAdapter` bundan sonra kullanılamaz.
- `transports::Transport` trait'i public: ileride kendi ISO-TP'mizi yazıp yalnızca `UDSClient`'ı kullanmak için
  ikinci bir takılma noktası.
- `UDSClient`: P2 (50 ms) / P2* (5 s), sunucu zamanlamasını benimseme, 0x78 zinciri, strict doğrulama.
  **Konuşma günlüğü veya kanca yok** (yalnızca `tracing`).

### `nexus-hal`
- `AdapterDriver` (keşif + `open_channel`) / `CanChannel` (`recv_batch(&mut [RawCanFrame], timeout_ms)`,
  `send_frame`, `set_filters`, `health`).
- `PipelineEngine` her bus için **tek** bir `nexus-bus-io-{id}` thread'i açar (`run_bus_io_loop`). Bu thread
  kanalı sahiplenir. TX `bounded(4096)` `TxDispatchRequest` kuyruğundan gelir. RX `bounded(65536)` ile
  aggregator → `StateTable`'a gider. Kapı: bus başına `listen_only`, `tx_armed: AtomicBool`, global
  `tx_panic_latched`. Hem komut seviyesinde hem io döngüsünde kontrol edilir. TX echo'su `send_frame` başarılı
  olunca **sentezlenir** (mock hariç, mock kendi loopback'ini üretir).
- `buses` private ve **tap/abonelik mekanizması yok**. D-003 bu yüzden ürün değişikliği olmadan kanala
  bağlanamaz. Spike, `BusOwner` ile önerilen değişikliği gösteriyor.

## Kritik sorular (kanıtlı)

| # | Soru | Sonuç | Kanıt |
|---|---|---|---|
| 1 | Köprü mümkün mü (VIN, 10 03, 3E 00) | ✓ | `uds` klasik: `10 03` → `SessionParameterRecord{p2 50ms, p2* 2s}`, `3E 00` OK, `22 F1 90` → `"WNX0ECUSIM0000017"` (FF + **bizim FC** + 2 CF), 200 B DID (29 CF), 47 B istek (FF, **ECU FC'si**, 6 CF → ECU `rx len 46`, NRC 0x13), 0x78 ×2 → pozitif yanıt (657 ms), sessiz DID → `Timeout` (53 ms ≈ P2), NRC 0x22 |
| 2 | Tek sahiplik / fan-out, hot-path tahsisi | ✓ (ürün değişikliğiyle) | Tek owner thread, tap başına bounded crossbeam kuyruğu, `RawCanFrame` Copy. `alloc --release`: 25 005 fps × 3 s, tüm çerçeveleri alan bir tap + bir ID tap'i: **owner thread'de 0 tahsis**, 0 drop. Her senaryoda `StateTable ingested = owner rx + tx echo` |
| 3a | Listen-Only / Arm kapısı | ✓ | `gate`: Listen-Only bus'ta oturum açılışta reddedildi. Fabrika atlansa da TX `IoError(PermissionDenied "ListenOnly")`, sürücüye 0 çerçeve. Disarmed: aynısı. Erken kontrol kapatıldığında **yalnızca owner kapısı**: `owner tx_rej=1, tx_sent=0`, ret `recv()` üzerinden UDS hatası olarak geldi |
| 3b | Panic Stop aktarım ortasında | ✓ | `panic`: 4000 B istek, STmin 5 ms. 150 ms'de latch → `isotp.send` **0.9 ms (release) / 3.0 ms (debug)** içinde `IoError(PermissionDenied "PanicLatched")` döndü. Latch'ten sonra bus'a **0** çerçeve çıktı (candump: son CF `22 7A..80`, reddedilen `23 81..` hatta yok). ECU tarafı `isotp_error errno 110` (N_Cr). Aynı oturum aynı terminal hatayı verir. Latch varken yeni oturum reddedilir. Arm'dan sonra yeni oturum `3E 00` OK |
| 4 | Gönderim onayı | ⚠ | Crate onay **istiyor**. Ürün SocketCAN sürücüsü `CAN_RAW_RECV_OWN_MSGS` kullanmıyor. Onay = `write()` kabul edildi (crate'in IFF_ECHO kapalıyken yaptığı emülasyonla aynı). vcan0 `flags=0x81` (IFF_ECHO yok). mock0 kendi loopback'ini üretiyor. Spike, `send_frame` OK olunca owner'da onay üretiyor. Gerçek kabloda onay için sürücüye `RECV_OWN_MSGS` eklenmeli |
| 5 | Zaman damgası → ISO-TP/UDS | ⚠ | `automotive::Frame`'de zaman damgası yok, crate içine **taşınamaz**. Tap'teki `ConversationLog` her çerçeveyi `RawCanFrame::timestamp_us` ile kaydediyor. P2 HAL zamanından ölçüldü (`1.36–1.62 ms`). Not: ürün SocketCAN sürücüsü `resolve_frame_timestamp_us(None)` kullanıyor. Donanım/çekirdek zaman damgası **henüz yok** (`supports_hw_timestamps: true` ilan ediliyor ama uygulanmıyor) |
| 6 | Async uyumu | ✓ / ⚠ | HAL thread + crossbeam ↔ `automotive` worker thread ↔ tokio görevleri sorunsuz (spike `tokio` multi-thread, 2 worker). Maliyet: oturum başına 1 OS thread + yoklama. `cpu --release`: taban 6.7 %, `idle_wait=0` (crate'in kendi tarzı) **+17 %**, `500µs` +10 %, `2ms` +4 % (bir çekirdeğin yüzdesi, oturum açıkken). FC gecikmesi (FF RX → FC TX) ≈ 1.36 ms. STmin 5 ms istenip **7.8 ms** gözlendi (onay gidiş-dönüşü + owner'ın 1 ms `recv_batch` yoklaması + tokio timer) |
| 7 | CAN-FD (64 B, BRS) | ✓ | `uds --fd` (0x7E5/0x7ED): tüm çerçeveler `FD+BRS`. VIN tek FD SF (24 B, kaçış uzunluğu). 200 B DID = FF 64 B + 3 CF (son 16 B). 123 B istek = FF 64 B + **ECU FC'si (FD, 8 B)** + CF 64 B → NRC 0x13. candump `-x`: `TX B - 7E5 [64] 10 7B 2E F1 A0 ...` (B = BRS hatta) |
| 8 | Pasif dinleme (Listen-Only'de 3. taraf tester) | ⚠ teknik olarak / ✗ ürün için | `passive`: Listen-Only bus, yön başına bir `automotive` ISO-TP ile `3E 00`, `22 F1 90` + 20 B yanıt, 33 B çok çerçeveli istek birleştirildi, sniffer hatta 0 çerçeve koydu. **Ama** bu, crate'in göndermeye çalıştığı FC'leri (2 adet) yutup **sahte onay** veren bir adaptörle mümkün. Ayrıca: ID çifti/yön başına bir instance, `fd` önceden bilinmeli (`accepts` FD eşleşmesi istiyor), çerçeve zaman damgası yok, gerçek FC'ler (BS/STmin/WAIT/OVFLW) yok sayılıyor, hatalı CF'ler sessizce düşüyor (`Ok(false)`). uds-interpretation-v1 §2 "Context" katmanı (STmin ihlali, eksik CF, FC wait/overflow, kanıt) bunlarla karşılanamaz. **Kendi pasif birleştiricimizi yazmalıyız** |
| 9 | mock0 | ✓ | `mock`: TX köprüden onaylandı, ECU olmadığı için beklendiği gibi `Timeout`. FD istek FD çerçeve olarak çıktı. StateTable mock'un kendi TX echo'larını aldı |
| 10 | Kapanış | ✓ | `BusOwner::shutdown` 0.3–1.6 ms (< 25 ms) |

### candump parçaları (`candump -td -x vcan0,7E4:7FE` / `7EC:7FE`)

```
# klasik VIN (22 F1 90): istek, FF, bizim FC, 2 CF
vcan0  TX - -  7E4   [8]  03 22 F1 90 CC CC CC CC
vcan0  TX - -  7EC   [8]  10 14 62 F1 90 57 4E 58
vcan0  TX - -  7E4   [8]  30 00 00 CC CC CC CC CC
vcan0  TX - -  7EC   [8]  21 30 45 43 55 53 49 4D
vcan0  TX - -  7EC   [8]  22 30 30 30 30 30 31 37

# CAN-FD + BRS (B): 123 B istek FF, ECU FC'si; 200 B yanıt FF/CF
vcan0  TX B -  7E5  [64]  10 7B 2E F1 A0 00 07 0E 15 1C 23 2A ...
vcan0  TX B -  7ED  [08]  30 00 00 AA AA AA AA AA
vcan0  TX B -  7ED  [64]  10 CB 62 F1 F1 54 68 65 20 71 75 69 ...
vcan0  TX B -  7ED  [64]  21 65 20 71 75 69 63 6B 20 62 72 6F ...

# Panic Stop: 4000 B (FF 1F A0), STmin ~7.8 ms, latch'ten sonra çerçeve yok; 1.5 s sonra yeniden kurulmuş oturum
vcan0  TX - -  7E4   [8]  1F A0 2E F1 A0 00 01 02
...
(000.007719)  vcan0  TX - -  7E4   [8]  22 7A 7B 7C 7D 7E 7F 80
(001.517468)  vcan0  TX - -  7E4   [8]  02 3E 00 CC CC CC CC CC
```

## Bağımlılık maliyeti

- Sabitleme: `automotive = { version = "=0.6.0", default-features = false }` (panda/socketcan/peak/vector/j2534
  kapalı; `rusb`, `libloading`, `bindgen` gelmiyor).
- Doğrudan bağımlılıklar: `arrayvec`, `async-stream`, `bstr`, `hex`, `socket2 0.6`, `strum/strum_macros 0.26`,
  `thiserror 1`, `tokio`, `tokio-stream`, `tracing`. `nexus-hal`'e göre yeni crate'ler: `arrayvec`, `async-stream(-impl)`,
  `bstr`, `regex-automata`, `strum(_macros)`, `heck`, `syn 2`, `thiserror 1` (+impl), `tokio-stream`, `tracing-attributes`.
  Yeni kopya (duplicate): `thiserror 1`/`2`, `syn 1/2/3`. `socket2 0.5/0.6` zaten üründe de kopya.
- **tokio `features = ["full"]` koşulsuz** → feature birleşmesiyle tüm grafta `fs`, `process`, `io-std`, `signal`
  vb. açılır. Çakışma yok, yalnızca derleme süresi/boyut.
- Derleme: `automotive` + bağımlılıkları temiz release ≈ **21.8 s** (4 çekirdek). `libautomotive.rlib` 3.9 MB.
  Spike release binary (nexus-hal + tokio + automotive) 2.76 MB.
- **MSRV:** crate `rust-version` bildirmiyor. Rust 1.80 ile derlenmiyor: `Option::is_none_or` (1.82),
  `Ipv6Addr::is_unicast_link_local` (1.84, DoIP modülü, feature'la kapatılamıyor) → **etkin MSRV ≥ 1.84**.
  Not: ürünün kendi beyanı (`rust-version = "1.80"`) zaten geçersiz: `serialport 4.10 → unescaper 0.1.10`
  edition 2024 (≥ 1.85) ve kilitli `tokio 1.54.1` Rust 1.85 istiyor.
- Çapraz OS: `cargo check --target x86_64-pc-windows-msvc`, `x86_64-apple-darwin`, `aarch64-apple-darwin`
  **geçti** (spike + nexus-hal + automotive). Tek uyarı üründe: `nexus-hal/src/drivers/slcan_drv.rs:291`
  gereksiz `mut` (yalnızca Linux dışı hedeflerde).

## Önerilen D-003 entegrasyon mimarisi

```
                ┌────────────── nexus-bus-io-{id} (tek sahip, Box<dyn CanChannel>) ───────────────┐
 CanChannel ──► │ recv_batch ─► frame_tx (bounded) ──────────────────────────► aggregator/StateTable│
                │            └► taps[0..4]: filter → try_send(TapEvent::Rx(RawCanFrame))  (0 alloc)  │
 TxDispatch ──► │ gate.check() (listen_only / armed / panic) ─► send_frame ─► TxConfirmed→origin tap │
 (origin'li)    └──────────────────────────────────────────────────────────────────────────────────┘
                      ▲ TxReq{frame, origin: Tap(n)}            │ TapEvent (bounded crossbeam)
                      │                                         ▼
          nexus-protocols::diag::HalCanAdapter (impl automotive::can::CanAdapter)  ── ConversationLog (HAL ts)
                      │  1 adet AsyncCanAdapter / bus ("diag port", ilk oturumda tembel açılır)
                      ▼
          IsoTP::new_owned (ECU başına tx/rx) ─► UDSClient::with_owned_transport   (tokio görevleri)
                      │
          uds::interpret (kendi pasif ISO-TP birleştiricimiz + kurallar) ◄── aynı tap çerçeveleri (aktif + pasif)
```

- **Trait yeri:** `HalCanAdapter` `nexus-protocols` içinde (veya yeni `nexus-diag`). `nexus-hal`'e yalnızca tap
  API'si eklenir, `automotive` bağımlılığı HAL'e girmez.
- **Kanal sahipliği:** kanal yine yalnızca bus-io thread'inde. Diag tarafı yalnızca kuyruklar tutar. Bus başına
  bir `AsyncCanAdapter` (bir worker thread), birden çok ECU için birden çok `IsoTP`. Tap filtresi yalnızca diag
  ID'lerini geçirir, böylece crate'in `Vec`/broadcast tahsisleri 50 kfps trafiğe değil yalnızca diag çerçevelerine uygulanır.
- **Güvenlik kapısı:** yetkili kontrol bus-io thread'inde `send_frame`'den hemen önce (mevcut kod zaten böyle).
  `HalCanAdapter::send`'deki erken kontrol yalnızca hızlı hata için. Ret → `TapEvent::TxRejected` → `recv()` `Err` →
  worker ölür → istemci `Error::IoError(PermissionDenied, "...PanicLatched")` görür. Panic/disarm/mod değişimi
  "diag port"u düşürür. Yeniden Arm sonrası yeni `AsyncCanAdapter` açılır (spike'ta kanıtlandı). Listen-Only bus'ta
  aktif diag portu açılmaz. Pasif analiz yalnızca tap okur.
- **Runtime:** HAL thread tabanlı kalır (tokio yok). UDS çağrıları Tauri'de `tauri::async_runtime` (tokio)
  üzerinde async komutlarda, `nexus_bridge`'de mevcut `#[tokio::main]` runtime'ında. `AsyncCanAdapter::close()`
  bloklayıcıdır, `spawn_blocking` ile çağrılmalı.
- **Konuşma günlüğü:** sözleşmenin istediği zamanlı/durumlu günlük crate'ten değil, tap'ten (HAL zaman damgası)
  ve `uds::interpret`'ten gelir. Aynı motor pasif "story mode"u da besler.

## Ürün kodunda gerekecek değişiklikler (yapılmadı)

1. **`nexus-hal` pipeline: tap API'si.** `ConnectedBusHandle`'a sabit boyutlu tap tablosu (`[Option<(filters, Sender<TapEvent>)>; N]`),
   kontrol mesajıyla ekle/çıkar, `run_bus_io_loop` RX döngüsüne filtre + `try_send` (spike'taki `owner_loop` birebir).
   `PipelineEngine::open_diag_tap(bus_id, filters, active) -> Tap`.
2. **`TxDispatchRequest`'e `origin` ve onay yönlendirmesi:** başarılı `send_frame` sonrası `TxConfirmed(echo)`
   yalnızca kaynak tap'e, `TxRejected(reason)` reddedilende. Diğer tap'ler bu çerçeveyi normal bus trafiği olarak görür.
3. **Panic Stop / disarm / bus mod değişimi / disconnect** diag tap'lerini kapatmalı (tap kuyruğu düşer → `Disconnected`).
4. **SocketCAN:** isteğe bağlı `CAN_RAW_RECV_OWN_MSGS` (gerçek TX onayı + doğru TX zaman damgası, `FLAG_TX` ile işaretle)
   ve `SO_TIMESTAMPING`/`SO_TIMESTAMP` (şu an `supports_hw_timestamps: true` ilan edilip uygulanmıyor).
5. **Güvenlik (spike dışı ama ilgili): SocketCAN Listen-Only yalnızca yazılım bayrağı.** Denetleyici `listen-only`
   ctrlmode'a alınmıyor, yani fiziksel `can0`'da kartımız hâlâ **ACK** basar. CLAUDE.md §3.4'e aykırı.
   Netlink ile `ctrlmode listen-only on` yapılmalı (yetki gerekiyorsa kullanıcıya açıkça bildirilmeli).
6. **TX gecikmesi:** bus-io döngüsü TX'i yalnızca döngü başında alıyor ve `recv_batch(…, 1 ms)` `poll()`'da bekliyor.
   TX en fazla ~1 ms gecikiyor (STmin/FC gecikmesine yansıyor). `eventfd`/self-pipe ile `poll` uyandırması önerilir.
7. **MSRV beyanı** `rust-version = "1.80"` gerçek durumu yansıtmıyor (≥ 1.85). `automotive` eklenince en az 1.84 gerekir.
8. `nexus-hal/src/drivers/slcan_drv.rs:291` Linux dışı hedeflerde `unused_mut` uyarısı.

## Bilinen sınırlamalar / açık noktalar

- Bu spike'ta onay = "sürücü kabul etti" (ürünle aynı). Gerçek kablodaki ACK/arbitration kaybı onaya yansımaz (madde 4).
- Bir CAN denetleyicisine/qdisc'e zaten verilmiş çerçeveler Panic Stop ile geri alınamaz. vcan'da kuyruk yok.
  Gerçek `can0`'da `txqueuelen` ve donanım FIFO derinliği kadar çerçeve (birkaç adet) yine de çıkabilir.
- `automotive` worker'ı `assert!` ile panic edebilir (eşleşmeyen echo). Köprü bunu tasarımla önlüyor
  (onay yalnızca kaynak tap'e). Worker panic ederse yalnızca o thread ölür (`panic = "abort"` yok), oturum `Disconnected` olur.
- Uzun flash testi (0x34/0x36/0x37) ve 0x27 bu spike'ın kapsamı dışında (UDS servis kapsamı protocol-specialist'te, `spikes/automotive-eval/`).
- Gerçek donanım (gs_usb/PCAN/SLCAN) ile denenmedi. Köprü yalnızca `CanChannel` trait'ine bağlı, sürücüye özel kod yok.
