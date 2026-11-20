# NexusCAN — Industrial Engineering & Multi-Agent Constitution

NexusCAN, Tauri v2 (Modüler Rust Workspace + React/TypeScript) üzerine inşa edilen; **BUSMASTER, PCAN-Explorer ve SavvyCAN'i aşmayı hedefleyen, platform-bağımsız (Linux / Windows / macOS) ve donanım-bağımsız endüstriyel CAN / CAN-FD Bus Analizörü, Sinyal Veritabanı Motoru ve Telemetri Platformudur**.

> **TEMEL İLKE:** Bu projede tüketici tipi "vibe-coding SaaS" yaklaşımları kesinlikle yasaktır. Yazılan her satır kod deterministik bellek kullanımına, çoklu işletim sistemi taşınabilirliğine, donanım güvenliğine (`Listen-Only` varsayılanı), mikrosaniye hassasiyetine ve 60 FPS kilitli endüstriyel HMI ergonomisine uymak zorundadır.

---

## 1. Çoklu Ajan (Multi-Agent) Takım Yapısı ve Sorumluluk Sınırları

`.claude/agents/` altında tanımlı uzman ajanlar (skill'ler `.claude/skills/` altında) yalnızca kendi sorumluluk sınırlarında çalışır ve veri kontratları üzerinden haberleşir:

| Ajan (`claude --agent <ad>` / `Agent` aracı) | Rol | Sorumlu Olduğu Dizinler | Zorunlu Temel Skill'ler |
| :--- | :--- | :--- | :--- |
| **`team-lead`** | Baş Sistem Mimarı & Orkestratör | `Cargo.toml`, `project_details.md`, `AGENTS.md`, IPC Kontratları | Mimari planlama, faz yönetimi, `Agent` aracıyla delegasyon (yalnızca ana oturumda: `claude --agent team-lead`) |
| **`protocol-specialist`** | Sinyal DB Derleyicisi & Protokol Uzmanı | `crates/nexus-netdb/`, `crates/nexus-protocols/` (`J1939`, `ISO-TP`, `UDS`, `CANopen`, `XCP`) | `nexuscan-dbc-pipeline`, `nexuscan-ev-protocols`, `canopen-integration`, `can-bus-industrial` |
| **`backend-dev`** | Evrensel Rust HAL, Kaydedici & 60Hz Pipeline | `crates/nexus-core/`, `crates/nexus-hal/`, `crates/nexus-recorder/`, `src-tauri/` | `nexuscan-hal-drivers`, `nexuscan-dbc-pipeline`, `rust-concurrency`, `tauri-v2`, `tauri-ipc`, `tauri-security` |
| **`frontend-dev`** | Endüstriyel HMI & Tauri v2 60 FPS UI *(Varsayılan `sonnet`; yalnızca kullanıcı açıkça "çok detaylı" / "özellikle iyice" derse `opus`)* | `src/`, `package.json`, `vite.config.ts`, `tsconfig.json` | `tauri-v2`, `tauri-ipc`, `ui-ux-pro-max` *(yalnızca endüstriyel koyu HMI modunda)* |
| **`qa-hil-verifier`** | Stres Testi, Bit Doğrulama & `vcan0` HIL | `scripts/`, `tests/`, `benches/` | `nexuscan-vcan-hil`, `automotive-testing-hil-test-engineer`, `can-bus-industrial`, `tauri-build` |

---

## 2. Evrensel İşletim Sistemi ve Donanım Matrisi (Universal HAL)

Rust ile geliştirme nedenimiz **sıfır kod tekrarıyla her işletim sistemi ve her CAN donanımında** çalışmaktır. Platforma özgü tüm sürücüler `#[cfg(target_os = "...")]` veya çalışma zamanı dinamik kütüphane yükleme (`libloading`) ile yalıtılır; bir işletim sistemindeki sürücü diğer platformun derlemesini **asla** kıramaz:

1. **Linux Native:** `SocketCAN` (`can*`, `vcan*`, `slcan*`, çekirdek `CAN_RAW_FILTER` ve donanım `SO_TIMESTAMPING`).
2. **Cross-OS Sürücüsüz USB-CAN (`Windows` + `macOS` + `Linux`):** Saf Rust `nusb` üzerinden `gs_usb` / `candleLight` protokolü (`CANable 2.0`, `CANtact`, `rusEFI`, `OpenMoko` tabanlı tüm açık donanımlar).
3. **Cross-OS Seri / USB-CDC:** `serialport` üzerinden Lawicel `SLCAN` (`CAN232`, `USBtin`, STM32 sanal COM adaptörler).
4. **Ticari Endüstriyel Adaptörler (Runtime `libloading` FFI — DLL/SO yoksa uygulama yine sorunsuz açılır!):**
   - `PCAN-Basic` (`PCANBasic.dll` / `libpcanbasic.so` / `PCBUSB`)
   - `Kvaser CANlib` (`canlib32.dll` / `libcanlib.so`)
   - `Vector XL Driver Library` (`vxlapi64.dll`) ve `SAE J2534 PassThru`
5. **Donanımsız & Çevrimdışı (Offline) Kaynaklar:**
   - `mock0`: Deterministik 1kHz–50kHz çoklu-mux EV/BMS/Motor sentetik üreteci.
   - **Kara Kutu Kayıt & Yeniden Oynatıcı (`Replay Channel`):** Vector `.blf`, `.asc`, ASAM `.mf4` (MDF4) ve `candump .log` dosyalarını gerçek bir CAN donanımıymış gibi zaman-kontrollü oynatma ve kaydetme.

---

## 3. Değiştirilemez Mimari Kurallar (Strict Invariants)

1. **Sıfır Tahsisli (Zero-Allocation) Hot-Path & Donanım Saati:**
   - `RawCanFrame` (`#[repr(C)]`, `Copy`, sabit `80 byte`, `[u8; 64]` stack dizisi, `bus_id: u8`) dışında RX/TX sıcak hattında `Vec<u8>` veya `String` tahsisi yapılamaz. Donanım zaman damgası (`hw_timestamp`) varsa sistem saatine göre önceliklendirilir.
2. **Paket Başına IPC Kesinlikle Yasaktır (60Hz + Binary Akış):**
   - Gelen her çerçeve için `app.emit()` çağrılamaz. Okuyucu thread `recv_batch` ile toplu okur, bounded kanaldan `StateTable`'ı günceller ve önyüze **saniyede 60 kez (`16.6ms`)** `tauri::ipc::Channel` üzerinden (yüksek kanal sayısında binary `tauri::ipc::Response` / `ArrayBuffer` destekli) kompakt anlık görüntü aktarır.
3. **İki Düzlemli (Two-Plane) Veri Kontratı:**
   - **Statik Şema Düzlemi (`DatabaseSchemaDto`):** `.dbc`/`.kcd` yüklendiğinde Tauri `invoke` ile 1 kez gönderilir (ECU'lar, birimler, yorumlar, enum tabloları, hazır `BitLayoutMatrix` hücreleri).
   - **Canlı Telemetri Düzlemi (`TelemetrySnapshotDto`):** 60Hz akışta string tekrarı yapılmaz; yalnızca yoğun `signalId: u32` anahtarları, `changed_bytes_mask: u64` ve **Retained Mux State** (sayfa hafızası) taşınır.
4. **Saha ve Donanım Güvenliği (`Listen-Only` & `Clamp`):**
   - Fiziksel CAN kanalları varsayılan olarak **`Listen-Only` (Pasif Dinleme)** modunda açılır; aktif TX / ACK modu kullanıcı tarafından açıkça (`Arm Active Bus`) etkinleştirilir ve tek tuşla **Panic Stop (Stop All TX)** her ekranda erişilebilir olur.
   - Tüm bit çıkarıcı/paketleyiciler `0..512` bit CAN-FD aralığını destekler ve TX paketlemede tüm değerler `[min, max]` aralığına kırpılır (`clamp`).
5. **Endüstriyel HMI Ergonomisi:**
   - Tüm sayısal/hex alanlarda `font-mono tabular-nums` zorunludur.
   - `backdrop-blur`, ağır DOM animasyonları ve `any` tipleri yasaktır; grafikler HTML5 Canvas/WebGL ile, büyük trace/log tabloları satır sanallaştırma ile çizilir.

---

## 4. Adım Adım Geliştirme Yol Haritası (Step-by-Step Phases)

`team-lead` her fazı sırayla, bir önceki fazın tüm `qa-hil-verifier` test kapılarını geçtikten sonra başlatır:
- **Faz 1:** Cargo Workspace + `nexus-core` (`RawCanFrame` 80B) + `nexus-netdb` (`.dbc` & `.kcd` 3-aşamalı derleyici, Intel/Motorola/Float/Kaskad-Mux RX/TX motoru, `DatabaseSchemaDto` + birim testleri).
- **Faz 2:** `nexus-hal` (`AdapterDriver` + `CanChannel`, Linux `SocketCAN` CAN/CAN-FD + çoklu-mux `mock0`, `Listen-Only` kilidi) + `src-tauri` 60Hz `StateTable` & `Channel` IPC hattı.
- **Faz 3:** Tauri v2 Endüstriyel Koyu HMI (`TopBar`, Overwrite & Chronological `FixedTraceTable`, `BitLayoutMatrix`, `DatabaseExplorer`, Panic-Stop'lu `Signal TX Composer`).
- **Faz 4:** Kara Kutu Ham Kayıt & Offline Replay Motoru (`.log`, `.asc`, `.blf`) + 60 FPS Çok Kanallı Canvas/WebGL Sinyal Osiloskobu.
- **Faz 5:** Evrensel Donanım Eklentileri (Saf Rust `nusb` `gs_usb`/candleLight, `SLCAN`, `libloading` ile `PCAN-Basic` / `Kvaser` / `Vector XL`).
- **Faz 6:** Üst Katman Protokol Analizörleri & Tanılama Konsolu (`SAE J1939`, `ISO-TP` + `UDS` DID/DTC istemcisi, `CANopen` Object Dictionary, Otomasyon/Makro Gönderici).

---

## 5. Token Disiplini (Tüm Ajanlar İçin Zorunlu)

1. **Model & Effort Kademesi:** Ajanlar `effort: medium` ile çalışır. `team-lead` yalnızca mimari tasarım, zor eşzamanlılık/kilit analizi ve faz sonu tam QA kapısı için `Agent` çağrısında `effort: "high"` ve/veya `model: "opus"` verebilir (bu madde o izni açıkça verir). `qa-hil-verifier` varsayılan `sonnet`; `frontend-dev` kuralı (§1) aynen geçerli.
2. **Kademeli QA:** İterasyonlarda **hafif kapı** (derleme + ilgili crate testleri + değişen dosyaların incelemesi). **Tam kapı** (saldırı/fuzz matrisi, 50k fps benchmark, bellek ölçümü, tüm workspace) yalnızca faz sonunda. Birkaç satırlık düzeltmeleri `team-lead` kendisi `cargo test -q -p <crate>` ile doğrular; ayrı QA ajanı açılmaz.
3. **Kısa Rapor:** Alt ajan nihai raporu **en fazla 25 satır**: değişen dosyalar, PASS/FAIL tablosu (sayılarla), kontrattan sapmalar, açık riskler (`dosya:satır`). Kod alıntısı, uzun açıklama ve tekrar yok.
4. **Sessiz Derleme/Test Çıktısı:** `cargo build/check/clippy -q --message-format short`, `cargo test -q`, `cargo nextest run --status-level fail --final-status-level fail`; çıktıyı `| grep -E "^(error|warning: unused)|test result|FAILED|panicked" | head -50` ile süz. Tam log gerekiyorsa dosyaya yaz, yalnızca ilgili satırları oku.
5. **Gereksiz Okuma Yok:** `CLAUDE.md` otomatik yüklenir, tekrar okunmaz. `project_details.md` ve büyük dosyalar baştan sona okunmaz; `grep -n` + `offset/limit` ile yalnızca gereken bölüm. Aktif kontrat `planning/contracts/<faz>.md` dosyasındadır; prompt'lar uzun açıklama yerine o dosyanın bölümüne referans verir.
6. **Kalıcı Kontrol Listeleri:** QA'nın bulduğu hata sınıfları ilgili kontrat dosyasının "Kontrol Listesi" bölümüne eklenir; uygulayıcı ajan teslimden önce bu listeyi kendisi doğrular (düzeltme turlarını önlemek için).
7. **Tur Ekonomisi:** Küçük işler biriktirilip tek mesajla gönderilir. **Bağlam eşiği:** Bağlamı ~120k token'ı aşmış bir ajana yeni iş verilmez (`SendMessage` ile devam ettirilmez); kontrat dosyasına referansla yeni ajan başlatılır. **Görev boyutu:** Her `Agent` görevi ~100k token içinde bitecek büyüklükte bölünür — somut sınır: bir backend görevi **en fazla 4–5 yeni araç/komut** veya **en fazla ~3 dosyalık değişiklik**; aşarsa paralel ajanlara bölünür (ayrı dosya/router iskeletiyle). Çalışan bir ajan görev ortasında eşiği aşarsa durdurulmaz (yarım işi devretmek daha pahalı); bitince ona yeni iş verilmez (ör. bir faz = backend-A, backend-B ayrı ajanlar); bir ajana art arda birden fazla faz yüklenmez. Revizyon için `SendMessage` yalnızca ajan eşiğin altındaysa ve düzeltme küçükse kullanılır. Gerekmedikçe `WebSearch`/`WebFetch` kullanılmaz (bağımlılık sürüm/feature doğrulaması hariç).
