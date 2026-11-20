# Deferred Backlog — kesin geri dönülecek konular

Bu dosya, tartışılıp bilinçli olarak ertelenen işleri ve alınmış/bekleyen kararları tutar.
Bir maddeye dönüldüğünde önce buradaki notu oku, kararları kullanıcıyla teyit et.

---

## D-001 · UDS Flow: AES / kripto desteği
**Durum:** ERTELENDİ (2026-11-10) — kullanıcı: "kesin geri döneceğiz".
**Bağlı iş:** D-002 (seed/key sağlayıcıları). AES sağlayıcısı saf Rust, native politikaya takılmaz.

### Kesinleşen gereksinim
- **Gizli anahtar kesinlikle gizli saklanacak** (kullanıcı şartı). Anahtar hiçbir zaman akış dosyasında,
  logda, Cloud senkronunda veya frontend belleğinde düz metin olarak bulunmayacak.

### Tartışılan tasarım (taslak, onaylanmadı)
- **Kullanım alanları:** 0x27 seed→key (`AES-128-ECB(K, seed)` / `AES-CMAC(K, seed)` + truncate),
  0x29 Authentication (simetrik ACR), şifreli flash (0x34 `dataFormatIdentifier`), flash sonrası CMAC/imza
  doğrulama, SecOC (AES-128-CMAC, truncated MAC).
- **Üç katman, tek backend kripto servisi:**
  - A. Flow "Crypto" blokları: AES Encrypt/Decrypt (ECB/CBC/CTR/GCM, padding none/zero/PKCS#7/ISO 9797-1 M2),
    AES-CMAC, HMAC-SHA256, SHA-256, Truncate/Slice, Random.
  - B. Seed/key sağlayıcısına bildirimsel `aes` türü: `{kind:"aes", mode, keyRef, inputTemplate, outputBytes}`.
  - C. Rhai sandbox'a `aes_ecb_encrypt(key_ref, blob)`, `aes_cmac(key_ref, blob)` vb.
- **Anahtar yönetimi:** Bloklar/profiller yalnızca `keyRef` taşır. İşlem backend'de `keyRef` ile yapılır,
  akışa sadece sonuç döner (akış anahtarı okuyamaz → CAN üzerinden sızdıramaz). Arayüz ve loglar
  yalnızca **KCV** (Key Check Value: sıfır bloğun şifresinin ilk 3 baytı) gösterir.
  - Depo adayları: OS anahtarlığı (`keyring` crate), parola ile şifreli proje kasası (headless `nexus-cli` için),
    oturumluk anahtar (diske yazılmaz), ileride HSM / PKCS#11 (test: SoftHSM).
- **Hesaplama yeri:** Rust backend (RustCrypto: `aes`, `cmac`, `cbc`, `ctr`, `aes-gcm`, `sha2`).
  WebCrypto yetersiz (ECB/CMAC yok, anahtar webview belleğinde kalır).
- **Doğrulama:** NIST SP 800-38A ve RFC 4493 test vektörleri birim testlerde + UI "Self-test".

### Geri dönünce sorulacak açık kararlar
1. İlk aşama modları? (öneri: ECB + CMAC; sonra CBC/CTR/GCM)
2. Anahtar deposu: OS anahtarlığı mı, şifreli proje kasası mı, ikisi mi? HSM şimdilik kapsam dışı mı?
3. "Lab modu": geliştirmede anahtarı hex girme izni (akış dosyasına kaydetmeden, açık etiketle)?
4. Kapsam: yalnız seed-key + 0x29 mı, SecOC (simülasyonda MAC'li çerçeve üretme/doğrulama) da dahil mi?

---

## D-002 · UDS SecurityAccess seed/key — kalan işler
**Durum:** KISMEN TAMAM, karar bekliyor.
**Kontrat:** `planning/contracts/seedkey-v1.md`, `crates/nexus-protocols/src/uds/security/mod.rs`, `src/types/seedkey.ts`.

- ✅ `nexus-protocols`: builtin (TS ile bayt-bayt parite, 680 vektör), table, Rhai script sandbox,
  `validate_profile`, `run_test_vectors` — 24/18 test, clippy temiz.
- ⏸ Backend: profil deposu + `cmd_seedkey_*` IPC komutları (Tauri + bridge).
- ⏸ Native sağlayıcılar (library / external_process / http): kapsam kullanıcıyla daraltılacak.
  Not: root `Cargo.toml`'da `nexus-seedkey-native` path bağımlılığı tanımlı, crate henüz yok.
- ⏸ Frontend: Security Access → Request Seed / Compute Key / Send Key + bileşik "Security Unlock" (Expand),
  profil yöneticisi, manuel anahtar girişi, legacy `custom` JS'in ana pencereden izole Worker'a alınması
  (güvenlik açığı: şu an `new Function` ile IPC erişimli bağlamda çalışıyor).
- Göç notu: legacy TS algoritma adı `crc16` → DTO `crc16_kermit`.

---

## D-003 · UDS backend komutları (Faz 6)
**Durum:** AÇIK. `cmd_diag_read_did`, `cmd_diag_send_uds`, `cmd_diag_read_stored_dtcs` frontend'den çağrılıyor
ama Tauri'de de bridge'de de yok. UDS Panel / textbox / Flow gerçek ECU ile çalışamıyor.
Kapsam: ISO-TP + UDS istemcisi (protocol-specialist), komut bağlantıları (backend-dev),
`vcan0` doğrulaması (qa-hil-verifier). Flow motorundaki rastgele simülasyon davranışları
(rastgele NRC, %90 assert, tek parça TransferData, sahte dosya okuma) da bu kapsamda dürüstleştirilecek;
otomatik "Flash Download" bloğu, 0x78 responsePending, arka plan TesterPresent.

---

## D-004 · ECU emülasyonu (Rust UDS sunucusu) ve ECU Simulator sekmesi
**Durum:** ERTELENDİ (2026-11-10).
- **Karar:** Diagnostics → "ECU Simulator" alt sekmesi arayüzden kaldırıldı, **kod silinmedi**
  (`src/components/diagnostics/ecu-sim/`). Kaldırma `DiagnosticsView.tsx` içinde (SUB_TABS, case, import).
  Gerekçe: sekme tarayıcı içinde çalışıyor, bus'a çıkmıyor; gerçek ECU varmış izlenimi veriyor
  (CLAUDE.md "sahte telemetri yasak").
- **Ürün odağı:** NexusCAN = analiz + tester (istemci tarafı: trace, DBC, Diagnostics istemcisi, Flow, flash).
  ECU emülasyonu sunucu rolü, ayrı bir ürün kapsamı.
- **Test ihtiyacı etkilenmiyor:** Doğrulama `tests/hil/ecusim/` (driftregion/iso14229 + çekirdek ISO-TP,
  udsoncan ile doğrulanmış) üzerinden yapılır; ürüne girmez.
- **Yeniden değerlendirme kriterleri (D-003 bittikten sonra):** somut kullanıcı/müşteri talebi
  (EOL, test tezgahı, eksik ECU taklidi); D-003'teki Rust ISO-TP/UDS tipleriyle ek maliyet;
  Faz 4–6 ana özelliklerinin durumu. Yapılırsa: bus'a çıkan Rust sunucu, udsoncan + iso14229 istemcisi
  + kendi istemcimizle çapraz doğrulama; mevcut sekme bunun kontrol paneline dönüştürülebilir.

---

## D-005 · GÜVENLİK: SocketCAN Listen-Only yalnızca yazılım bayrağı (CLAUDE.md §3.4 ihlali)
**Durum:** AÇIK, yüksek öncelik (2026-11-11, automotive-hal-bridge spike bulgusu, team-lead doğruladı).
- `crates/nexus-hal/src/drivers/socketcan_drv.rs:272`: Listen-Only sadece bizim TX'imizi reddediyor.
  CAN denetleyicisi `ctrlmode listen-only` moduna alınmıyor → fiziksel `can0`'da kartımız hâlâ **ACK basar**
  ve hattı etkiler (ör. tek alıcılı hatta vericinin başarılı sayılmasına yol açar). vcan'da fark görünmez.
- Gerekli: netlink ile `listen-only on` (arayüz down/up + CAP_NET_ADMIN gerektirir). Yetki yoksa uygulama
  "gerçek Listen-Only değil, yalnızca yazılım TX kilidi" uyarısı göstermeli; kullanıcıya yanlış güvence verilmemeli.
  Diğer sürücüler (SLCAN `L` komutu, gs_usb `GS_CAN_MODE_LISTEN_ONLY`, PCAN/Kvaser) aynı açıdan denetlenmeli.
- Aynı spike'ın diğer ürün notları: SocketCAN `supports_hw_timestamps: true` ilan ediyor ama `SO_TIMESTAMPING`
  uygulanmıyor; TX onayı için `CAN_RAW_RECV_OWN_MSGS` yok; io döngüsünde ~1 ms TX gecikmesi (eventfd önerisi);
  `rust-version` beyanı ≥ 1.85 olmalı. Ayrıntı: `spikes/automotive-hal-bridge/README.md`.

---

## D-006 · Anahtar sağlayıcı entegrasyonu (anahtar şirket sisteminde kalır) + özel bloklar/paneller
**Durum:** ERTELENDİ (2026-11-11) — kullanıcı: "şimdilik kaydet, sonradan yapacağımız bir sistem olacak".
Kullanıcı notu: farklı yöntemler (helper, HTTPS, HSM, DLL) **henüz hiç denenmedi** → dönüşte önce deneme/PoC.
**Bağlı işler:** D-001 (kripto blokları, `keyRef`), D-002 (seed/key sağlayıcıları, Rhai sandbox, seedkey-v1 kontratı).

### Kesinleşen gereksinim (kullanıcı)
- Şirketler gizli/private anahtarı araca **statik olarak girmez**. NexusCAN anahtarı tutmaz; anahtarın durduğu
  sistemle entegre olur, seed'i gönderip yalnızca o seferlik key'i (veya imzayı) alır.
- Sabit algoritma gömmek bakım yükü yaratır (her yeni algoritma = sürüm). Özel blok/algoritma eklenebilmeli.

### Tartışılan tasarım (taslak, onaylanmadı)
- **Soyutlama:** backend'de `KeyProvider` → genelleştirilmiş "kriptografik işlem iste" (0x27 key hesapla,
  0x29 challenge imzala). İstek: `{vin, ecu{rx,partNo}, level, seed, algorithmHint, user, nonce}`.
- **Güvenlik profili:** Flow / Panel / Console yalnızca profil adı bilir; profil (ECU eşleşmesi + level) → sağlayıcı.
  Paylaşılan JSON'larda sır yok. Tüm SecurityAccess çağrıları tek backend yolundan geçer.
- **Sağlayıcı adayları (öncelik sırası taslak):**
  1. Harici yardımcı program (git credential-helper modeli; stdin/stdout JSON, `{"v":1,"op":"computeKey",…}` →
     `{"ok":true,"key":"…"}`). Dil/platform bağımsız; şirket kendi HSM/Vault/sunucusuna bağlar.
  2. HTTPS uzak servis (mTLS + OIDC/SSO; yetki ve audit sunucuda).
  3. PKCS#11 (HSM / USB token / akıllı kart; anahtar donanımdan çıkmaz; `libloading`; test: SoftHSM).
  4. Vector SeedKey DLL (`GenerateKeyEx`; çoğu 32-bit → ayrı yardımcı süreç).
  5. Yerleşik TEST sağlayıcı (ecusim `xor_ff`/`xor_const`), arayüzde "TEST – gizli değil" etiketli.
  - Not: bulut KMS'ler genelde ham AES-ECB yapmaz (HMAC/imza var) → çoğunlukla şirket servisinin arkasında.
- **Kritik detaylar:** uzak çağrı sürerken TesterPresent ile S3 korunmalı; NRC 0x35/0x36/0x37 deneme sayacı ve
  kilit bekleme süresine uyum (otomatik tekrar yok); audit log (kim/VIN/ECU/level/zaman/sonuç; key yok, en fazla hash);
  sağlayıcı kimlik bilgileri OS anahtarlığında.
- **Özel blok manifesti (JSON):** `id@version`, tipli giriş/çıkışlar, config şeması (Inspector otomatik üretilir),
  `impl.kind ∈ {pipeline (D-001 hazır blokları), wasm|rhai (backend sandbox, CPU/bellek limiti, bus erişimi yok), dll}`,
  **zorunlu test vektörleri** (geçmeden kaydedilemez). Hesap backend'de → desktop / bridge / nexus-cli aynı sonuç.
- **Özel paneller (UDS Instrument Panel):** widget yerleşimi + DID bağlamaları veri olduğundan düşük risk;
  içe/dışa aktarma yeterli. Mantık panele gömülmez, panel Flow/özel blok tetikler.
- **Ters yön entegrasyon:** dış uygulamalar (MES, test otomasyonu) NexusCAN'i kullanır → `nexus_bridge` HTTP API +
  `nexus-cli`; sürümlü + kimlik doğrulamalı API gerekir (bugün bridge yerel ağda kimlik doğrulamasız → ayrı güvenlik konusu).

### Bilinen mevcut sorun (D-002'deki madde ile aynı, tekrar teyit edildi)
- `src/components/flow/flowAlgos.ts:106` `custom` algoritma `new Function` ile ana webview'da, IPC erişimli
  çalışıyor. Ayrıca desktop CSP (`default-src 'self'`, `unsafe-eval` yok) nedeniyle desktop'ta büyük olasılıkla çalışmıyor,
  tarayıcı modunda çalışıyor (desktop'ta denenmedi; GTK eksik). Bu sistem gelince kaldırılacak.

### Dönünce sorulacak açık kararlar
1. Somut entegrasyon hedefleri: kendi şirket altyapısı mı, belirli OEM'ler mi, müşteri sistemleri mi?
2. Kapsam: yalnız 0x27 mi, 0x29 Authentication da baştan mı? (öneri: arayüz baştan 0x29'u taşısın)
3. Dış uygulamaların NexusCAN'i kullanması bu işin parçası mı, ayrı iş mi?
4. Özel kod: WASM, Rhai (D-002'de mevcut) veya ikisi?
5. Deneme planı: önce ecusim + örnek helper ile uçtan uca PoC; sonra SoftHSM ile PKCS#11.

---

## D-007 · Diagnostics — ertelenen küçük işler (2026-11-11 oturumu)
- **UDS Console functional modu:** istek 0x7DF'ye gidiyor ama yalnız formdaki tek RX id dinleniyor → diğer ECU yanıtları
  kayboluyor. Discovery'deki toplama mantığıyla tüm yanıtlayanlar ayrı listelenmeli.
- **Live PIDs:** mod seçeneği OBD-II (`01 xx`) / OBDonUDS SAE J1979-2 (`22 F4xx`); adresleme fiziksel / functional 0x7DF
  (yanıtlayan her ECU ayrı). OBDonUDS testi için `tests/hil/ecusim/config/manual.json`'a F4xx DID'leri eklenmeli.
- **Session Setup "Protocol" alanı** backend'de yalnız bilgi amaçlı (OBD-II/UDS davranışı değiştirmiyor) → ya anlam kazanmalı ya kaldırılmalı.
- **UDS Flow `flow_timeout_guard`:** gerçek modda zaman aşımı uygulamıyor (geçiş bloğu, mesajında belirtiliyor).
- **Connect doğrulaması (opsiyonel, kapalı varsayılan):** bağlanınca `3E 00` ile ECU varlığını doğrulama.
- **Çalışma zamanında doğrulanmadı:** Traffic Dock 60 FPS (Live PIDs açıkken), newest-first kaydırma sabitleme,
  maximize sonrası Flow canvas yeniden ölçümü. `src-tauri` bu makinede derlenmedi (GTK/glib dev paketleri yok) →
  `cmd_diag_discover_ecus`, `cmd_diag_get_isotp_frames`, `origin` argümanları desktop'ta derlenip denenmeli.

---

## D-008 · README çekimi sırasında bulunan hatalar (2026-11-12)
Gerçek uygulama Playwright ile sürülürken (vcan0 + 4 ecusim + mock0) bulundu.
- **Trace kayıt sırasında boş:** "Start Trace" sonrası tampon dolarken (ör. 3.934 frame) tablo hiç satır göstermiyor;
  satırlar yalnızca "Stop" sonrası geliyor. Canlı trace görünümü çalışmıyor.
- **Soğuk açılışta sahte "PANIC LATCHED":** `src/App.tsx` (~131) kurtarılacak oturum yoksa güvenli sıfırlama için
  `cmd_panic_stop_tx` çağırıyor → her açılışta kırmızı PANIC / "TX LOCKED (PANIC)" yanıyor (alarm yorgunluğu).
  Öneri: sıfırlamayı latch'lemeyen bir yolla yap (ör. disarm + scheduler/replay temizliği) ya da sıfırlama sonrası latch'i temizle.
- **Trafik paneli satır genişletme butonu** `aria-label` olarak panelin "Expand panel / Collapse" metnini kullanıyor.
- **Durum çubuğu** bus arm edildikten sonra da "Connected Bus 2: vcan0 (Listen-Only)" mesajını göstermeye devam ediyor.
- **Bus ID gösterimi** (düzeltildi, 24a4247): ECU grafı ve Session Setup 0 tabanlı bus id gösteriyordu.
- **İngilizce arayüzde Türkçe metinler:** UDS Flow varsayılan diyagram adı "YENİ DİYAGRAM"; Simulation
  "Generate draft from DBC" önizlemesi "Önizleme: Seçili kriterlerde sinyal bulunamadı (0 bileşen oluşturulacak)."
- **Bus etiketi karmaşası (Simulation):** aynı bus "CAN0 · Bus 1 (mock0) (BUS 0)" olarak üç farklı numarayla yazılıyor.
- **Trafik paneli:** "OBD-II PID" kaynak rozeti ORIGIN sütununa sığmıyor, ADDR sütununun üstüne taşıyor.
- **Cloud sekmesi** sunucu olmadan yalnızca `localhost:3000` giriş formu gösteriyor → v0.1'de deneysel bayrak arkasına alınacak.
- **TX paneli:** "VIRTUAL"/"HW/SW LISTEN-ONLY" rozeti eklenince bus adı ("Bus 1 · mock0") "Bu…" diye kesiliyor; satır düzeni genişletilmeli. ✅ düzeltildi
- **Proje açma onayı:** ✅ KARAR (2026-11-12): onay kalıyor. Bir dosyanın "kullanıcının kendi projesi" olduğu içerikten güvenilir biçimde anlaşılamaz (kopyalanan/indirilen dosya da aynı görünür); açılan her proje Listen-Only, otomatik bağlantısız açılır, "Connect (Listen-Only)" tek tık.

- **MCP `re_dbc_generate` base merge:** add `PipelineEngine::database_ir(bus: Option<u8>) -> Option<NetworkDatabase>` so MCP can merge RE drafts into a loaded DBC (`planning/contracts/mcp-v1.md` §9).
