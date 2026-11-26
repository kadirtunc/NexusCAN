# CANsub Integration — Contract v1 (CSS Electronics CANsub.2 / CANsub.4)

Durum: **ONAYLI PLAN** (team-lead) · 2026-11-23 · Sahip: team-lead
Amaç: (1) NexusCAN'de Win/mac/Linux native CANsub desteği, (2) crates.io'da yayınlanabilir bağımsız Rust SDK
(`cansub-rs`), (3) CSS Electronics "software & API tools" sayfasında listelenme.

Resmi kaynaklar (alt ajanlar buradan okur, tahmin etmez):
- Doküman dizini: https://canlogger.csselectronics.com/cansub-docs/cansub4/llms.txt (her sayfa `.html.md` ile Markdown)
  - WebSocket: `…/cansub4/api/api_ws.html.md` (HDLC + çerçeve formatı + **TV-01..TV-20**)
  - REST: `…/cansub4/api/api_rest.html.md` · OpenAPI: `…/cansub4/_downloads/4a3e03d1a36cd461061b9dfaa58ddec7/openapi.json`
  - Bit-timing tablosu: `…/cansub4/bit_timing.html.md` · TLS: `…/cansub4/connection/security/index.html.md`
  - Keşif: `…/cansub4/connection/discovery.html.md` · Saat: `…/cansub4/time/index.html.md`
- Referans implementasyon (MIT): `github.com/CSS-Electronics/c-cpp-sdk-cansub` →
  `src/src/cansub_protocol/cansub_protocol_decode.c` (wire formatının kesin kaynağı), `docs/implementer_notes.md`,
  `src/src/cansub_root_cert.crt`.
- CANsub.2 ile CANsub.4 arasındaki tek fark kanal sayısı (2 × DB9 / 1 × DB25 4 kanal). Firmware/API/protokol aynı
  (doküman sürümü 02.05.01, API 05.00).

---

## 1. Kapsam

| Kapsamda (v1) | Kapsam dışı (v2+) |
|---|---|
| USB (CDC-NCM) ve Ethernet, aynı kod | mTLS istemci sertifikası |
| mDNS keşfi + elle host/IP | PTP durum ekranı (yalnızca okunur, gösterim yok) |
| RX, TX, TX-ack, error frame, CAN-FD 64 B, BRS/ESI | Cihazda periyodik TX sekansları (`/transmit`) — v1 bunları yalnızca **siler** (Panic Stop) |
| Listen-Only varsayılan (cihazda zorunlu), Arm, Panic Stop | Donanım filtreleri (`/filter`) — v1 yazılım filtresi |
| Cihaz saatini ayarlama (`PUT /api/time`) | Saat kayması düzeltme (rate correction) |
| `cansub-sim` emülatörü (2/4 kanal) | `cansub-socketcan` Rust köprüsü (Python daemon'ın yerine) |
| `nexus-cli cansub-selftest` | python-can uyumluluk katmanı |

---

## 2. Wire formatı (kesin — C SDK decode.c ve TV'lerden doğrulandı)

### 2.1 Taşıma
- Her şey HTTPS/WSS, port 443. REST: `https://<host>/api/...` · WS: `wss://<host>/api/can/{ch}/ws` (ch = 1..N).
- WS kanal başına **tek istemci**. Bağlanmak kanalı açar, kapatmak kapatır. Veri yalnızca **binary** mesajdır.
- HDLC çerçeveleri WS mesaj sınırlarına **hizalı değildir** (TV-10: bir HDLC 7 mesaja bölünmüş; TV-11/12: bir mesajda
  birden fazla CAN/HDLC). Decoder akış tabanlıdır.
- Gönderimde tek HDLC çerçevesi ≤ **1400 B**.

### 2.2 HDLC
```
0x7E | stuff( payload ‖ CRC32_BE(payload) ) | 0x7E
stuff: 0x7E → 7D 5E ,  0x7D → 7D 5D   (decode: 7D sonrası byte ^ 0x20)
CRC32: IEEE 802.3 (reflected poly 0xEDB88320, init 0xFFFFFFFF, xorout 0xFFFFFFFF), unstuffed payload üzerinde, big-endian
```
Hata davranışı (TV-13..18): bozuk CRC'li HDLC atılır, diğerleri okunur; çerçeveler öncesindeki/arasındaki çöp byte'lar
atlanır; payload içinde yarım kalan CAN çerçevesi atılır, aynı HDLC'deki önceki tam çerçeveler teslim edilir. Hiçbir
girdi panik üretmez.

### 2.3 CAN çerçevesi (payload içinde art arda)
```
byte 0..5 : TIMESTAMP  u48 big-endian, µs, epoch 2025-01-01T00:00:00Z  (unix_us = ts + 1_735_689_600_000_000)
byte 6    : FLAGS
   if (FLAGS & 0xE0) == 0x20  → ERROR FRAME (toplam 7 byte, ID ve veri yok)
        err = FLAGS & 0x1F : 0 Bit · 1 Ack · 2 Form · 3 Stuff · 4 CRC · diğer = Other(code)
              (C SDK'ya uyuldu: teslim edilir VE `unknown_errors`'da sayılır)
   else
        bit7 FDF · bit6 RTR (FDF=0) / BRS (FDF=1) · bit5 ESI (yalnızca FDF=1) · bit4 TX(ack) · bit3..0 DLC
byte 7..8 : u16 BE.  bit15 = IDE.
   IDE=0 → id = u16 & 0x7FF                         (header 9 byte)
   IDE=1 → id = ((u16 << 16) | next u16 BE) & 0x1FFFFFFF   (header 11 byte)
data      : RTR ise YOK (DLC korunur, TV-03). Değilse dlc_to_len(FDF, DLC) byte.
dlc_to_len: 0..8 → aynı; FD'de 9..15 → 12,16,20,24,32,48,64; klasikte 9..15 → 8.
```

### 2.4 REST (v1'de kullanılanlar)
| Uç | Kullanım |
|---|---|
| `GET /api/version` | Major `05` değilse `UnsupportedCapability("CANsub API <v>; NexusCAN requires 05.x")` |
| `GET /api/info` | device id, variant, fw — DeviceDescriptor alanları |
| `GET /api/can` | kanal listesi (2 veya 4) |
| `GET /api/can/{ch}` | `state`, `frame_rate`, `bus_load`, `rx_error_count`, `tx_error_count`, `bus_error_count` → `health()` |
| `GET/PUT /api/time` | açılışta host saatini yaz (PTP kilitliyse atla — `GET /api/time/ptp`) |
| `PUT /api/can/{ch}/phy` | `listen_only`, `auto_reset`, `error_frames`, `tx_ack_frames`, `timing{brp,seg1,seg2,sjw}`, `timing_data{…}` |
| `GET/DELETE /api/can/{ch}/transmit[/{id}]` | yalnızca Panic Stop'ta cihazdaki sekansları silmek |
| `DELETE /api/can/{ch}/ws` | TX kuyruğunu at + kapanışı hızlandır (Panic Stop, kapanış timeout'u) |

JSON alan adları ve `state` enum değerleri **OpenAPI dosyasından** alınır; bu tablo yalnızca özet.
**C2 bulguları:** `PUT /phy` gövdesinde OpenAPI'ye göre altı alanın hepsi zorunlu → kısmi gövde 400; istemci (Panic Stop
dahil) her zaman tam `PhyConfig` gönderir (son uygulanan config saklanır, yalnızca `listen_only` değiştirilir).
İkinci WS istemcisi: doküman kod belirtmiyor, sim 409 döner → istemci 409'u `Error::Busy`'ye eşler.
`GET /api/time/ptp` elle saat ayarından sonra `disabled` döner (doküman: manuel set PTP'yi kapatır).
`ConnectOptions.host` `name[:port]` / `[v6]:port` kabul eder (varsayılan 443; sim rastgele port kullanır).

### 2.5 Bit timing (80 MHz)
`bitrate = 80_000_000 / (brp × (1 + seg1 + seg2))`. Doküman tablosundaki `NSEG1/NSEG2/NSJW` ve `DSEG1/DSEG2/DSJW`
sütunları doğrudan `timing.seg1/seg2/sjw` ve `timing_data.*` alanlarına karşılık gelir. Varsayılan örnekleme noktası
%80 (qt-cansub ile aynı). Hesaplayıcı fonksiyon doküman tablosunun **tüm satırlarına karşı** test edilir (golden).
Tam bölünemeyen bitrate → `UnsupportedCapability`, yaklaşık değer seçilmez.
**C1 bulguları (tablodan çıkarıldı, 290/290 satır):** BRP nominal ve data fazında ortaktır ve data bitrate'e bağlıdır →
FD için `fd_timing(nominal, data, sp)` kullanılır. Seçim: en küçük BRP; sample point ±0.5‰; `sjw = min(4, seg2)`;
nominal seg1 1..=256, seg2 2..=128; data seg1 2..=32, seg2 2..=16, ≤25 tq (tabloyla 20..35 arası her değer uyumlu).
"Tam bölünme" kuralı tablonun kendisiyle çelişir (666 667, 95 238, 83 333 listede) → kabul koşulu
`round(80 MHz / (brp·tq)) == bitrate` (ör. 666 666 → None).

### 2.6 TLS
TLS 1.2, tek suite `ECDHE-ECDSA-AES128-GCM-SHA256`, ECDSA P-256 cihaz sertifikası, CSS root CA
(SHA-256 `D064C85905195400216A11BB50D754865ED2B5F997D36A9EA2EA97883B15D0F1`). SAN: `<id>-usb.local`, `<id>-eth.local`.
Doğrulama sırası (C SDK `implementer_notes.md` ile aynı):
1. `device_id` verildiyse → zincir CSS root'a + sertifikadaki SAN `<device_id>-usb.local|-eth.local` içeriyor mu. Host IP olabilir.
2. `device_id` yok, `accept_any_device = true` → yalnızca zincir. UI bunu açıkça uyarıyla gösterir.
3. İkisi de yok → standart hostname doğrulaması (yalnızca `.local` adlarıyla çalışır; IP ile bağlanınca handshake hatası
   ve "Device ID girin" mesajı).

### 2.7 Kapanış
WS close gönder → onayı bekle (**500 ms**) → gelmezse `DELETE /api/can/{ch}/ws` → onayı bekle (500 ms) → TCP kapat.
TCP doğrudan kesilmez. (Cihaz WS close aldığında kuyruktaki TX'leri timeout'suz bitirir; DELETE kuyruğu atar.)

---

## 3. Crate yapısı

### 3.1 `crates/cansub/` — yayınlanabilir SDK (paket adı `cansub-rs`, lib adı `cansub`)
NexusCAN'e **hiçbir** bağımlılığı yoktur. Lisans `MIT OR Apache-2.0` (workspace `license` devralınmaz).
`[package] publish = false` CSS isim onayı gelene kadar kalır.

```
crates/cansub/
  Cargo.toml          features: default=[] · std (iç) · blocking · tokio · discovery · serde · sim
                      (blocking/tokio/discovery/sim → std; sim → blocking)
  src/lib.rs          #![cfg_attr(not(feature = "std"), no_std)]  #![forbid(unsafe_code)]  #![warn(missing_docs)]
  src/certs.rs        CSS_ROOT_CA_PEM (include_str!) + CSS_ROOT_CA_SHA256 (no_std)
  src/proto/mod.rs    no_std, alloc'suz: CanFrame, Event, ErrorKind, flags, dlc tabloları, EPOCH
  src/proto/crc.rs    CRC32 (tablo const, bağımlılıksız)
  src/proto/hdlc.rs   Decoder (akış) + encode
  src/proto/frame.rs  CAN çerçevesi serialize/deserialize
  src/timing.rs       bitrate → BitTiming (no_std)
  src/client/…        [blocking] tls.rs · rest.rs · ws.rs · device.rs · channel.rs
  src/discovery.rs    [discovery] mdns-sd `_cansub._tcp`
  src/sim/…           [sim] emülatör sunucusu (§5)
  src/bin/cansub-sim.rs [sim]
  certs/cansub_root_cert.crt   (C SDK'dan, MIT; fingerprint testle sabit)
  tests/vectors.rs    TV-01..TV-20 (hex sabitleri elle aktarılır, doküman kopyalanmaz)
  tests/proptest_roundtrip.rs
  examples/list_devices.rs · candump.rs · send_frame.rs
  README.md · CHANGELOG.md · LICENSE-MIT · LICENSE-APACHE
```

### 3.2 Kesin public API (proto — no_std)
```rust
pub const DEVICE_EPOCH_UNIX_US: u64 = 1_735_689_600_000_000;
pub const MAX_WIRE_HDLC: usize = 1400;   // gönderim üst sınırı
pub const MAX_RX_HDLC: usize = 4096;     // decoder iç tamponu; aşarsa overflow sayılır ve resync

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub struct FrameFlags(u8);
impl FrameFlags {
    pub const EXTENDED: Self; pub const RTR: Self; pub const FD: Self;
    pub const BRS: Self; pub const ESI: Self; pub const TX_ACK: Self;
    pub const fn contains(self, other: Self) -> bool; pub const fn union(self, other: Self) -> Self;
    pub const fn bits(self) -> u8;
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CanFrame {
    pub timestamp_us: u64,   // DEVICE epoch (2025-01-01) µs; unix için + DEVICE_EPOCH_UNIX_US
    pub id: u32,
    pub flags: FrameFlags,
    pub dlc: u8,             // 0..15 ham DLC
    pub data: [u8; 64],      // geçerli uzunluk = self.len()
}
impl CanFrame { pub const fn len(&self) -> usize; pub fn payload(&self) -> &[u8]; pub const fn unix_us(&self) -> u64; }

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ErrorKind { Bit, Ack, Form, Stuff, Crc, Other(u8) }

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Event { Frame(CanFrame), Error { timestamp_us: u64, kind: ErrorKind } }

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct DecoderStats { pub hdlc_ok: u64, pub crc_errors: u64, pub overflows: u64,
                          pub truncated_frames: u64, pub garbage_bytes: u64, pub unknown_errors: u64 }

pub struct Decoder { /* [u8; MAX_RX_HDLC], durum makinesi; heap yok */ }
impl Decoder {
    pub const fn new() -> Self;
    pub fn push(&mut self, bytes: &[u8], sink: &mut impl FnMut(Event));
    pub fn stats(&self) -> DecoderStats;
    pub fn reset(&mut self);
}

#[derive(Debug, PartialEq, Eq)]
pub enum EncodeError { BufferTooSmall, InvalidFrame }  // ör. FD olmayan çerçevede DLC>8 veriyle, id aralık dışı

/// `frames` başından sığdığı kadarını TEK HDLC çerçevesine kodlar (≤ min(out.len(), MAX_WIRE_HDLC)).
/// Dönüş: (yazılan byte, tüketilen çerçeve sayısı). Tek çerçeve bile sığmazsa BufferTooSmall.
pub fn encode_hdlc(frames: &[CanFrame], out: &mut [u8]) -> Result<(usize, usize), EncodeError>;

pub const fn dlc_to_len(fd: bool, dlc: u8) -> usize;
pub const fn len_to_dlc(fd: bool, len: usize) -> Option<u8>;

// timing.rs
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BitTiming { pub brp: u16, pub seg1: u16, pub seg2: u16, pub sjw: u16 }
pub const CAN_CLOCK_HZ: u32 = 80_000_000; pub const DEFAULT_SAMPLE_POINT_PERMILLE: u16 = 800;
pub fn nominal_timing(bitrate: u32, sample_point_permille: u16) -> Option<BitTiming>;      // yalnızca klasik CAN
pub fn fd_timing(nominal: u32, data_bitrate: u32, sp: u16) -> Option<(BitTiming, BitTiming)>; // FD: ortak BRP
pub fn data_timing(nominal: u32, data_bitrate: u32, sample_point_permille: u16) -> Option<BitTiming>; // fd_timing().1
```
TX'te `TX_ACK` bayrağı her zaman 0 kodlanır; RX'te TX_ACK=1 çerçeve = cihazın gönderdiğini onayladığı çerçeve.

### 3.3 Public API (feature `blocking`)
```rust
pub struct ConnectOptions {
    pub host: String,                 // "aabbccdd-usb.local" | "10.123.45.1"
    pub device_id: Option<String>,    // 8 hex, §2.6 kural 1
    pub accept_any_device: bool,      // §2.6 kural 2
    pub timeout: std::time::Duration, // bağlantı + REST; varsayılan 3 s
}
pub struct Device { /* ureq Agent + rustls config */ }
impl Device {
    pub fn connect(opts: ConnectOptions) -> Result<Device, Error>;      // GET /api/version + /api/info
    pub fn info(&self) -> &DeviceInfo;            // id, variant, hw, fw, api, channels
    pub fn channel_status(&self, ch: u8) -> Result<ChannelStatus, Error>;
    pub fn set_time_now(&self) -> Result<(), Error>;                    // PTP kilitliyse no-op
    pub fn configure(&self, ch: u8, phy: &PhyConfig) -> Result<(), Error>;
    pub fn delete_transmit_jobs(&self, ch: u8) -> Result<usize, Error>;
    pub fn abort_ws(&self, ch: u8) -> Result<(), Error>;                // DELETE /api/can/{ch}/ws
    pub fn open(&self, ch: u8) -> Result<Channel, Error>;
}
pub struct PhyConfig { pub listen_only: bool, pub auto_reset: bool, pub error_frames: bool,
                       pub tx_ack_frames: bool, pub timing: BitTiming, pub timing_data: BitTiming }
pub struct Channel { /* tungstenite WebSocket<rustls::StreamOwned<…>>, Decoder, tx buf [u8;1500] */ }
impl Channel {
    /// Gelen olayları sink'e verir; en fazla `timeout` bekler. Dönüş: teslim edilen olay sayısı.
    pub fn poll(&mut self, timeout: Duration, sink: &mut impl FnMut(Event)) -> Result<usize, Error>;
    pub fn send(&mut self, frames: &[CanFrame]) -> Result<(), Error>;   // gerekirse birden çok HDLC
    pub fn close(self, device: &Device) -> Result<(), Error>;           // §2.7 sırası
    pub fn stats(&self) -> DecoderStats;
}
#[derive(Debug, thiserror::Error)] pub enum Error { Tls(String), Http{status:u16, body:String},
    Ws(String), Io(std::io::Error), UnsupportedApi(String), Busy /* WS zaten başka istemcide */, Protocol(String) }
```
Hot-path kuralı: `poll` ve `send` çerçeve başına heap tahsisi yapmaz; WS okuma tamponu yeniden kullanılır.
`tokio` feature aynı yüzeyi `async fn` olarak sunar (v1'de opsiyonel, NexusCAN kullanmaz).

### 3.4 NexusCAN adaptörü — `crates/nexus-hal/src/drivers/cansub_drv.rs`
- `CansubDriver: AdapterDriver`, `driver_id() = "cansub"`, `display_name() = "CSS Electronics CANsub"`.
  `registry.rs` içinde tüm platformlarda kayıt (mDNS/ağ yoksa `discover_devices` boş `Ok(vec![])`, hata değil).
- `discover_devices`: mDNS (≤ 1.5 s) + kullanıcının kaydettiği hostlar. **C3b bulgusu:** TXT yalnızca `api` ve
  `channels` taşır; device_id yalnızca host adından (`<id>-usb|-eth.local`) gelir; variant/fw için `GET /api/info`
  gerekir. VPN/başka alt ağdaki cihazlar mDNS'te görünmez → elle host yolu zorunlu. Her cihaz × kanal → bir descriptor:
  `device_id = "cansub:<devid>@<ch>"`, `channel_name = "<host>@<ch>"`, `display_name = "CANsub.<n> <devid> CH<ch>"`,
  capabilities: FD=true, hw timestamp=true, hw listen-only=true.
- `ChannelConfigDto`'ya eklenen alanlar (`#[serde(default)]`, TS aynası `src/types/hal.ts`):
  ```rust
  pub network_host: Option<String>,       // elle host/IP (mDNS yoksa)
  pub network_device_id: Option<String>,  // §2.6 kural 1
  pub network_accept_any_device: bool,    // §2.6 kural 2
  ```
- `open_channel` sırası: `Device::connect` → `set_time_now` → `configure(listen_only = config.listen_only,
  error_frames = true, tx_ack_frames = true, timing = FD ise fd_timing(bitrate, data_bitrate, 800), değilse
  nominal_timing(bitrate, 800))` → `open(ch)`.
  `listen_only_enforcement() = Hardware`. `require_hardware_listen_only` her zaman sağlanır.
- `recv_batch`: `Channel::poll` → `Event::Frame` → `RawCanFrame`:
  `timestamp_us = unix_us()`, flags: EXTENDED/RTR/FD/BRS/ESI eşlenir, `FLAG_HW_TIMESTAMP` her zaman,
  `TX_ACK → FLAG_TX`. `Event::Error` → `FLAG_ERROR` çerçevesi, `data[0] = ErrorKind` kodu (mevcut error-frame
  sözleşmesiyle uyumlu; bkz. `crates/nexus-hal/src/error_frame.rs`).
- `send_frame`: `listen_only` iken `AdapterError::ListenOnlyMode`. Değilse `Channel::send`.
- `health()`: ayrı bir durum thread'i `GET /api/can/{ch}` ile **1 Hz** yoklar, sonuç atomiklerde; `health()` bloklamaz.
  Bağlantı koparsa `BusState::Disconnected`.
- **C4a kararları:** TX-ack açıkken pipeline kendi TX yankısını `cansub` için de bastırır (mock ile aynı; aksi halde
  trace'te çift TX). Panic Stop sonrası kanal donanımsal listen-only kalır; TX için bus yeniden bağlanır. mDNS sonucu
  süreç geneli önbellekte (ilk keşif 1.5 s, sonra 5 s'den eski sonuçlar arka planda yenilenir). `"cansub:"` id'leri
  keşifsiz doğrudan açılır; `adapterChannel` cansub için okunmaz. Test root `CansubDriver::with_connector` ile.
- **C7 düzeltmeleri:** sample point 800‰'den başlayıp [700, 900] aralığında aranır (`select_fd_timing` /
  `select_nominal_timing`, selftest de aynısını kullanır). FD matrisi 28/45: 10k/20k nominalde FD yok; 50k/100k →
  4M/5M/8M yok; 125k → 8M yok (ortak BRP 1..32, ≤385 nominal tq, ≤25 data tq). Arayüz bunları devre dışı bırakır
  (`isCansubBitrateSupported`, Rust bitrate-matris testiyle senkron tutulur). TX yankı bastırma `pipeline/echo_suppress.rs`
  (64 girdi, kimlik eşlemesi, 500 ms). RX taşma halkası sınırlı, düşenler `driver_dropped_frames()` ile pipeline'a.
- **Panic Stop**: `CanChannel` trait'ine default no-op metot eklenir:
  `fn abort_pending_tx(&mut self) -> Result<(), AdapterError> { Ok(()) }`. Pipeline panic yolu bunu çağırır
  (bkz. `crates/nexus-hal/src/pipeline/mod.rs` `disarm_barrier`, `tx_panic_latched`). CANsub impl:
  `abort_ws` + `delete_transmit_jobs` + `configure(listen_only = true)`; toplam bütçe ≤ 100 ms (sim'de ölçülür).
  Diğer sürücüler değişmez.
- **C3a kararı:** REST elle HTTP/1.1 (ureq 3 özel `ServerCertVerifier` kabul etmiyor); `ureq` cansub'dan çıkarıldı.
  `DeviceInfo.variant` kanal sayısından türetilir (OpenAPI `/api/info`'da variant yok). `abort_ws` 404'ü başarı sayar.
- Tauri: `src-tauri` içinde `cmd_cansub_probe_host(host, deviceId?, acceptAny) -> Vec<DeviceDescriptorDto>` komutu
  (sürücü tarafı `CansubDriver::add_known_host`; frontend elle hostları `localStorage` `nexuscan.cansub.knownHosts`'ta tutar)
  (elle eklenen cihazı doğrulayıp kanallarını listeler) + `capabilities/default.json` izni.

### 3.5 Bağımlılıklar
`crates/cansub`: `tungstenite` (`rustls-tls-native-roots` DEĞİL — kendi root store'umuz; `__rustls-tls` muadili),
`rustls` (workspace'teki `ureq` ile aynı crypto provider), `ureq` (rustls, json), `serde`/`serde_json` (`serde` feature),
`mdns-sd` (`discovery`), `thiserror`. Dev: `proptest`, `rcgen` (sim sertifikaları), `hex`.
**C0 ile sabitlendi** (workspace `[workspace.dependencies]`): `rustls 0.23` (`std,tls12,ring`, default kapalı — ureq ile
aynı `ring` provider), `rustls-pki-types 1.12`, `tungstenite 0.30` (yalnızca `handshake`; TLS akışını biz kurup
`tungstenite::client::client(req, StreamOwned)` ile veririz, tungstenite TLS feature'ı YOK), `mdns-sd 0.22`
(default kapalı), `rcgen 0.14` (`crypto,pem,ring`), `proptest 1.6`. `serde` crate içinde doğrudan
`default-features=false` (no_std için workspace'ten devralınmaz). Dev: `hex 0.4`, `sha2 0.11`, `base64`.
Yeni bağımlılık eklemek gerekirse (ör. sim HTTP sunucusu) aynı yöntemle workspace'e eklenir ve rapora yazılır.
**MSRV = 1.85** (`ureq 3` ve `tungstenite 0.30` zaten 1.85 ister; workspace 1.80 değeri hiçbir crate'te
devralınmıyor). `sim` feature ve dev-dep'ler (`rcgen`, `proptest`) 1.88 ister — kabul edildi, README'de belirtilir.
**REST notu (C3):** `ureq` opsiyonel olarak bağlı, ama §2.6 SAN doğrulaması (IP ile bağlanıp sertifikada
`<id>-usb.local` arama) özel `ServerCertVerifier` ister. ureq 3 buna izin vermiyorsa C3, REST'i aynı rustls
akışı üzerinde elle HTTP/1.1 (küçük GET/PUT/DELETE + `serde_json`) olarak yazar ve `ureq`'i feature'dan çıkarır.

---

## 4. Doğrulama katmanları (cihazsız)

| # | Katman | İçerik | Geçme koşulu |
|---|---|---|---|
| L1 | Resmi vektörler | TV-01..TV-20: decode (beklenen Event listesi + `DecoderStats`) **ve** tek-HDLC TV'lerde encode → byte-eşit | 20/20 |
| L1b | Bit timing golden | doküman tablosunun tüm satırları | %100 |
| L2 | Property | rastgele `CanFrame` → `encode_hdlc` → rastgele parçalara böl (1..N) → `Decoder` = özdeş; rastgele çöp/bit-flip → panik yok, stats tutarlı | proptest 10 000 vaka |
| L2b | Fuzz | `cargo fuzz` hedefi `Decoder::push` | 10 dk, 0 crash (faz sonu) |
| L3 | `cansub-sim` uçtan uca | gerçek TLS + REST + WSS üzerinden NexusCAN sürücüsü (§5 senaryoları) | tüm senaryolar PASS |
| L4 | Performans | sim → sürücü, 50 000 fps CAN-FD 64 B, 60 s, loopback | `dropped_frames == 0`, `crc_errors == 0`, RSS sapması < 5 MB |
| L5 | Çapraz-referans (ops.) | C SDK'yı `cc` ile derleyip aynı rastgele girdilerle encode/decode karşılaştır | byte-eşit (CI dışı) |

**Bağımsızlık kuralı:** `cansub-sim`'in kendi wire kodlayıcısı (`src/sim/wire.rs`) `proto` modülünü **kullanmaz**;
§2'den bağımsız yazılır ve kendisi de L1 vektörleriyle test edilir. Böylece iki bağımsız implementasyon birbirini
doğrular; ortak bir hata simülasyonda gizlenemez.

---

## 5. `cansub-sim` emülatörü

`cargo run -p cansub-rs --features sim --bin cansub-sim -- --channels 2|4 --source mock|vcan0|replay:<file> --fps N`
- rustls sunucu, **TLS 1.2 + tek suite** zorunlu (istemcimiz başka suite isterse test kırılmalı).
- `rcgen` ile çalışma anında: test root CA (ECDSA P-256) + cihaz sertifikası (SAN `<id>-usb.local`, `<id>-eth.local`).
  İstemci testte root'u `ConnectOptions`'a test-only bir kanaldan alır (`#[cfg(any(test, feature = "sim"))]`
  `Device::connect_with_root(opts, der)`); üretim kodunda gömülü CSS root dışında root kabul edilmez.
- REST alt kümesi §2.4 (OpenAPI alan adlarıyla), WSS kanal başına tek istemci (ikinci bağlantı reddedilir → `Error::Busy`).
- Davranış sadakati: `listen_only` iken gelen TX düşürülür ve sayılır; `tx_ack_frames` açıkken TX-ack üretilir;
  `error_frames` açıkken `--inject-errors` ile error frame; close semantiği (kuyruk boşalana kadar bekle, DELETE ile at);
  saat `PUT /api/time` ile ayarlanmazsa timestamp'ler 0'dan başlar (gerçek cihaz gibi).
- Kontrol/gözlem: `GET /sim/log` (test-only JSON: alınan REST istekleri + gövdeleri, düşen TX sayısı) — kabul
  testleri buradan kanıt toplar.
- Kaos seçenekleri: `--split-ws` (HDLC'leri rastgele WS mesajlarına böl), `--corrupt-crc P`, `--garbage P`.

Senaryolar (L3):
1. Keşif yok, elle host + device_id ile bağlan → 2 ve 4 kanal listelenir.
2. Varsayılan açılışta sim log'unda `PUT /phy {"listen_only": true, ...}` görülür; Arm'sız TX → `ListenOnlyMode`.
3. Arm → TX → TX-ack, trace'te `FLAG_TX` + hw timestamp.
4. Panic Stop → sim'de `DELETE /ws` + `DELETE /transmit/*` + `listen_only:true`, ≤ 100 ms.
5. `--split-ws --corrupt-crc 0.01 --garbage 0.01` altında: kayıp yalnızca bozuk HDLC'ler kadar, panik yok.
6. Yanlış device_id → TLS hatası, anlamlı mesaj. IP + device_id yok + accept_any yok → "Device ID girin" hatası.
7. İkinci istemci → `Busy`. Sim kapanınca → `Disconnected`, uygulama çökmez.
8. Kapanış §2.7 sırasıyla (sim log'unda close → gerekirse DELETE).

---

## 6. Gerçek cihaz kapısı (yayın ve listeleme öncesi zorunlu)
Cihazsız kanıtlanamayanlar: gerçek sertifika zinciri/SAN biçimi, Windows/macOS'ta CDC-NCM arayüzü, mDNS davranışı,
bit timing'in gerçek hatta doğruluğu, gerçek veri hızı/gecikme, CSS'in SocketCAN köprüsü ile Linux'ta çalışma.
- `nexus-cli cansub-selftest <host> [--device-id X] [--ch N] [--tx-loopback]` → JSON rapor: version/info/time/phy,
  30 s listen-only RX istatistiği, (izinliyse) iki kanal arası loopback TX + timestamp farkı.
- Cihaz kaynağı: CSS'ten ödünç istendi (mail 2026-11-23). Gelmezse CANsub.2 satın alınır (~440 USD). CANsub.2 yeterli.
- Kontrol listesi: Win 11 / macOS 14+ / Ubuntu 24.04 × USB / Ethernet; 125k/250k/500k/1M + FD 2M/5M; 2 kanal loopback.

---

## 7. İş paketleri ve sıralama

| ID | Ajan | Kapsam (sahip olduğu dosyalar) | Bağımlılık |
|---|---|---|---|
| **C0** ✅ | team-lead | `crates/cansub/` iskeleti: `Cargo.toml` (features, `publish=false`), `lib.rs` modül stub'ları, lisans dosyaları, root cert + fingerprint testi | — |
| **C1** ✅ | protocol-specialist | `src/proto/**`, `src/timing.rs`, `tests/vectors.rs`, `tests/proptest_roundtrip.rs` (L1, L1b, L2) | C0 |
| **C2** ✅ | backend-dev | `src/sim/**`, `src/bin/cansub-sim.rs` (kendi `sim/wire.rs`; L1 vektörlerini sim wire'ına da uygular) | C0 (C1 ile paralel) |
| **C3a** ✅ | backend-dev | `src/client/**` (tls, rest, ws, device, channel), `examples/`, `tests/client_sim.rs`, sim'e `close_ack_delay` | C1, C2 |
| **C3b** ✅ | backend-dev | `src/discovery.rs` (mDNS) | C0 (C3a ile paralel) |
| **C4a** ✅ | backend-dev | `nexus-hal`: `cansub_drv.rs`, `registry.rs`, `dto.rs` alanları, `traits.rs` `abort_pending_tx` + pipeline çağrısı, `tests/cansub_sim.rs` | C3 |
| **C4b+C6** ✅ | backend-dev | `src-tauri` `cmd_cansub_probe_host` + capability; `nexus-cli cansub-selftest` | C4a |
| **C5** ✅ | frontend-dev (sonnet) | `NewConnectionModal.tsx`: "CSS CANsub" ailesi — keşfedilen cihazlar, elle host/IP + Device ID, "Accept any CANsub" (uyarılı), kanal, bitrate/FD bitrate; TLS/sürüm hatalarının okunur gösterimi; `src/types/hal.ts` alanları; i18n (en/tr). Renk kuralı CLAUDE.md §3.6, `check-theme-tokens` PASS | C4 DTO'su (§3.4) sabit olduğu için C4 ile paralel |
| **C7** ✅ | qa-hil-verifier (opus, faz sonu) | L1–L4 + L2b fuzz + §5 senaryoları + Win/mac/Linux derleme | C1–C6 |
| **C8** | team-lead | Gerçek cihaz kapısı (§6), CSS'e sonuç raporu | Cihaz |
| **C9** | team-lead | Yayın: README (CSS onaylı isim), `publish=true`, crates.io, CSS listeleme başvurusu | C8 + CSS onayı |

Her paket ≤ ~3 dosya grubu / ~100k token. Ajan teslimde §9 kontrol listesini kendisi doğrular.

---

## 8. Kabul kriterleri (faz kapısı)
- L1 20/20, L1b %100, L2 10 000 vaka, L2b 10 dk 0 crash, L3 8/8 senaryo, L4 `dropped_frames == 0`.
- `cargo build -p cansub-rs --no-default-features` `no_std` derlenir (`thumbv7em-none-eabihf` hedefinde `check`).
- `cargo clippy -p cansub-rs --all-features -- -D warnings` temiz; `cargo doc` uyarısız (yayınlanabilir kalite).
- Ağ/mDNS yokken NexusCAN açılır, CANsub listesi boş, hata yok.
- Win/mac/Linux CI derlemesi yeşil.
- `CHANGELOG.md` `[Unreleased] → Added`: "CSS Electronics CANsub.2 / CANsub.4 support over USB and Ethernet
  (Windows, macOS, Linux), with hardware timestamps and device-enforced Listen-Only."
- `graphify update .` her kod teslimatından sonra.

---

## 9. Kontrol Listesi (uygulayıcı teslimden önce doğrular; QA buldukça büyür)
- [ ] Decoder WS mesaj sınırına güvenmiyor (TV-10, TV-11, TV-12).
- [ ] CRC big-endian; stuffing CRC byte'larına da uygulanıyor (TV-17).
- [ ] Veride 0x7E/0x7D stuffing (TV-16).
- [ ] Bozuk CRC'li HDLC atılıyor, komşuları okunuyor (TV-15); çöp atlanıyor (TV-13/14); yarım çerçeve (TV-18).
- [ ] Error frame 7 byte, `(flags & 0xE0) == 0x20`, `err = flags & 0x1F` (TV-19/20); bilinmeyen kod panik değil.
- [ ] RTR: veri yok, DLC korunuyor (TV-03). ESI yalnızca FDF=1'de anlamlı.
- [ ] IDE = byte7 bit7; standart 2 byte, extended 4 byte BE.
- [ ] Timestamp epoch 2025-01-01, u48 BE (TV-01/02); `unix_us` ofseti doğru.
- [ ] DLC→uzunluk: klasikte 9..15 → 8; FD'de 12..64.
- [ ] FD açılışında `fd_timing` (ortak BRP) kullanılıyor; `nominal_timing` + `data_timing` ayrı ayrı birleştirilmiyor.
- [ ] Gönderilen HDLC ≤ 1400 B; büyük batch birden çok HDLC'ye bölünüyor.
- [ ] TX'te TX_ACK biti 0.
- [ ] Hot path'te (`poll`, `send`, `recv_batch`, `send_frame`) çerçeve başına `Vec`/`String` yok.
- [ ] Kapanış: close → 500 ms → DELETE → 500 ms; TCP doğrudan kesilmiyor.
- [ ] Üretim kodunda yalnızca gömülü CSS root; test root yalnızca `cfg(test|sim)`.
- [ ] Açılışta varsayılan `listen_only: true`; `send_frame` listen-only'de `ListenOnlyMode`.
- [ ] (QA) `pipeline/mod.rs` cansub TX-yankı bastırma: bus'ta ACK'lenmeyen bastırılmış replay çerçevesi sonraki gerçek TX-ack'i yutmuyor.
- [ ] (Gerçek cihaz) selftest loopback ve "WS açıkken listen_only PUT" yalnızca §6'da kanıtlanabilir (sim kanalları ortak hat değil).
- [ ] (C7) REST okuyucusunda tüm boyut aritmetiği `checked_*`; chunk boyutu taşması panik değil hata.
- [ ] (C7) 1xx döngüsü ve gövde okuma toplam süre sınırına (ConnectOptions.timeout) tabi.
- [ ] (C7) WebSocket `max_message_size`/`max_frame_size` ≤ 1 MiB.
- [ ] (C7) `Channel::send` / `send_frame` kararlı durumda çerçeve başına heap tahsisi yok (`cansub_alloc` testi).
  **Kabul edilen sapma (v1):** SDK tarafı 0 tahsis (yeniden kullanılan `BytesMut` + tungstenite yazma tamponu);
  rustls her flush'ta 1 TLS kayıt tamponu ayırır → tek çerçeve `send` = 1 tahsis, 32'lik batch = 0.031/çerçeve.
  TX hızı kullanıcı kaynaklı (RX 50k fps hot path'i 0.019/çerçeve) olduğu için kabul edildi. v2: `TlsStream`'i
  rustls `UnbufferedClientConnection`'a taşı.
- [ ] (C7) Bastırılan TX yankıları kimlikle (id+dlc+veri) eşlenir ve süre aşımıyla temizlenir; sayaç kullanılmaz.
- [ ] (C7) Sürücü sample point'i 800‰'e sabitlemez; arayüzün sunduğu bitrate matrisi sürücünün açabildiği timing'lerle uyumlu.
- [ ] (C7) Sürücü RX taşma halkası sınırlı (taşarsa dropped sayılır, sınırsız büyümez).
- [ ] (C7) CI: thumbv7em check, `cargo doc -D warnings`, cansub fuzz (kısa) adımları.
- [ ] `crates/cansub` NexusCAN crate'lerine bağımlı değil (`cargo tree -p cansub-rs | grep nexus` boş).
- [ ] `cargo check -p cansub-rs --no-default-features --target thumbv7em-none-eabihf` geçiyor (proto/timing'de std/alloc yok).
- [ ] Yeni public öğelerin hepsinde doc yorumu (`#![warn(missing_docs)]` + clippy `-D warnings`).
- [ ] `RUSTDOCFLAGS="-D warnings" cargo doc -p cansub-rs --all-features --no-deps` temiz (kırık intra-doc link yok).
- [ ] Cargo'nun "unused dependency" uyarısı C0 stub'larından gelir; sahibi olduğun feature'ın bağımlılığını kullanınca kaybolmalı.
