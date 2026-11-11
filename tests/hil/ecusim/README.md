# ecusim — test amaçlı sanal UDS ECU

`ecusim`, NexusCAN Diagnostics özelliklerini donanım olmadan doğrulamak için kullanılan
**yalnızca test amaçlı** bir sanal ECU'dur. Ürüne girmez.

- **Çekirdek:** [driftregion/iso14229](https://github.com/driftregion/iso14229) 0.11.0
  (MIT, `third_party/iso14229/`, değiştirilmeden vendored; bkz. `VERSION`).
- **ISO-TP:** Linux çekirdeğinin `CAN_ISOTP` soketi (`src/tp.c`). Segmentasyon, FC ve
  N_xx zamanlamaları çekirdekte yapılır.
- **JSON:** cJSON 1.7.19 (MIT, `third_party/cjson/`). Yalnızca yapılandırma yüklenirken kullanılır.
- **Bağımsızlık:** `crates/`, `src-tauri/`, `src/` altından hiçbir kod almaz. Ürün kodu da
  ecusim'e bağımlı değildir.

## Derleme

```bash
make -C tests/hil/ecusim          # build/ecusim        (-Wall -Wextra -Werror)
make -C tests/hil/ecusim asan     # build/asan/ecusim   (-fsanitize=address,undefined)
```

Vendored dosyalar yerinde değiştirilmez. Makefile bunları `build/gen/` altına kopyalar ve
`third_party/iso14229/patches/*.patch` dosyalarını (sıralı, `patch -p1`) o kopyaya uygular.
Şu an yama yok: desteklenmeyen SID'ler upstream'in `UDS_EVT_Custom` olayıyla karşılanıyor.

Derleme tanımları:

| Tanım | Neden |
|---|---|
| `UDS_CUSTOM_MILLIS` | Upstream `UDSMillis()` `gettimeofday()` kullanıyor (monotonik değil). `src/log.c` `CLOCK_MONOTONIC` sağlar. |
| `UDS_SERVER_0x27_BRUTE_FORCE_MITIGATION_*_DELAY_MS=0` | Kütüphanenin sabit 1 s'lik kaba kuvvet zamanlayıcıları kapatılır. Deneme sayacı, 0x36/0x37 ve açılış gecikmesi JSON'dan gelir (`src/ecu.c`, `src/main.c`). |

## Çalıştırma

```
ecusim -i vcan0 -c config/default.json [--req 0x7E0] [--resp 0x7E8] [--func 0x7DF] [--fd] [-l events.jsonl]
```

| Seçenek | Varsayılan | Anlamı |
|---|---|---|
| `-i/--iface` | `vcan0` | CAN arayüzü |
| `-c/--config` | (zorunlu) | JSON yapılandırma |
| `--req` | `0x7E0` | Fiziksel istek ID'si (ECU dinler) |
| `--resp` | `0x7E8` | Fiziksel yanıt ID'si (fonksiyonel isteklerin yanıtları da buradan gider) |
| `--func` | `0x7DF` | Fonksiyonel istek ID'si. Socket listen-only olduğu için FC göndermez. |
| `--fd` | kapalı | CAN-FD bağlantı katmanı (`CAN_ISOTP_LL_OPTS`: MTU 72, TX_DL 64, BRS) |
| `-l/--log` | stdout | JSON-lines olay günlüğü |

`0x7FF` üstündeki ID'ler otomatik olarak 29 bit (EFF) kabul edilir.

### Kontrol (sinyaller)

| Sinyal | Etki | Günlük olayı |
|---|---|---|
| `SIGHUP` | Yapılandırma dosyası yeniden okunur ve tüm durum sıfırlanır (soketler yeniden açılır). Dosya bozuksa eski yapılandırma ile devam edilir. | `{"ev":"reloaded","ok":true/false}` |
| `SIGUSR1` | Dosya okunmadan tüm durum yapılandırmadaki başlangıç değerlerine döner (oturum, güvenlik, DID'ler, bellek, DTC'ler, hata sayaçları). Kuyruktaki istekler atılır. | `{"ev":"state_reset"}` |
| `SIGTERM`/`SIGINT` | Temiz çıkış. Tüm bellek serbest bırakılır (LeakSanitizer için). | `{"ev":"exit"}` |

### Olay günlüğü (JSON lines)

Her satır `{"t": <başlangıçtan beri ms, monotonik>, "wall": <unix s>, "ev": ..., ...}`.

| `ev` | Alanlar | Anlamı |
|---|---|---|
| `ready` | `pid, iface, req, resp, func, fd, lib` | Soketler açık, istek kabul ediliyor |
| `rx` | `ta` (`phys`/`func`), `session`, `len`, `data` (hex) | ECU'nun aldığı tam UDS isteği |
| `tx` | `len`, `data` | ECU'nun gönderdiği yanıt (0x78 dahil) |
| `tx_drop` | `reason`, `data` | Hata enjeksiyonuyla bilerek gönderilmeyen yanıt |
| `tx_suppressed` | `reason:"functional_nrc"`, `data` | ISO 14229-1'e göre bastırılan fonksiyonel NRC |
| `fault` | `index, kind, hit` | Bir hata kuralı bu isteğe uygulandı |
| `session` | `from, to, why` (`0x10` / `s3_timeout`) | Oturum geçişi |
| `s3_timeout` | `session` | S3 doldu |
| `security_unlocked` / `security_invalid_key` / `security_lockout` / `security_lockout_end` | | 0x27 durum makinesi |
| `ecu_reset_scheduled` / `ecu_reset` | `type`, `dropped_requests` | 0x11. Güç kesik penceresinde gelen istekler atılır. |
| `download_start` / `download_done` / `download_incomplete` | `addr, size, crc32` | 0x34/0x37 |
| `did_written`, `io_control`, `routine`, `comm_ctrl`, `dtc_setting`, `dtc_cleared` | | Servis yan etkileri |
| `isotp_error`, `uds_err`, `error` | | Taşıma/kütüphane hataları |

## Yapılandırma dosyası

Örnek: `config/default.json` (testlerin kullandığı referans ECU). Kurallar:

- Bilinmeyen anahtar **hatadır** (yazım hataları sessizce yutulmaz). `_` ile başlayan anahtarlar yorumdur.
- Sayılar JSON sayısı ya da `"0x1A"` / `"26"` biçiminde dize olabilir. Hex veri dizelerinde boşluk ve `:` yok sayılır.
- `sessions` listesi boş ya da hiç yoksa "her oturum" anlamına gelir. `security: L`, L seviyesinin
  (tek sayı, requestSeed alt fonksiyonu) açılmış olmasını ister. `0` ya da hiç yoksa güvenlik gerekmez.

```jsonc
{
  "timing": {
    "p2_ms": 50,                    // 0x10 yanıtında bildirilir; P2server
    "p2_star_ms": 2000,             // 0x10 yanıtında bildirilir; ardışık 0x78 aralığı = 0.3 * P2*
    "s3_ms": 3000,                  // S3server (her istekte yeniden başlar)
    "security_boot_delay_ms": 0,    // açılış/reset/reload sonrası 0x27 -> 0x37 süresi
    "reset_power_down_ms": 100,     // 0x11 pozitif yanıtı ile reset arası (istekler kaybolur)
    "response_delay_ms": 0          // tüm yanıtlara eklenen sabit gecikme
  },
  "isotp": { "bs": 0, "stmin": 0, "tx_padding": "0xAA" },   // tx_padding: null => padding yok

  "sessions": [ { "id": 1 }, { "id": 2, "from": [2, 3] }, { "id": 3 } ],
  //   listede olmayan oturum -> 0x12; "from" dışından geçiş -> 0x22

  "services": {                     // SID bazlı kapı (servis olayından önce uygulanır)
    "0x2E": { "sessions": [2, 3] },             // yanlış oturum -> 0x7F
    "0x34": { "sessions": [2], "security": 17 },// güvenlik yok -> 0x33
    "0x35": { "enabled": false }                // -> 0x11
  },

  "security": [ {
    "level": 1,                     // requestSeed alt fonksiyonu (sendKey = level+1)
    "seed": "11223344",             // sabit seed (seed uzunluğu = anahtar uzunluğu)
    "seed_mode": "fixed",           // "fixed" | "counter" (seed + n, big endian, deterministik)
    "algorithm": "xor_const",       // "xor_ff": key[i]=seed[i]^0xFF
    "constant": "A5A5A5A5",         // "xor_const": key[i]=seed[i]^constant[i % len]
    "sessions": [3],                // başka oturumda -> 0x7E
    "max_attempts": 3,              // N. yanlış anahtar -> 0x36 (öncekiler 0x35)
    "lockout_ms": 1500              // kilit süresince seed/key -> 0x37; sonra sayaç sıfırlanır
  } ],

  "dids": [
    { "id": "0xF190", "ascii": "WNX0ECUSIM0000017",       // ya "hex": "..."
      "size": 17,                                          // ops.: 0x00 ile doldurur
      "read": true, "write": true, "io_control": false,
      "read_sessions": [], "read_security": 0,             // okunamıyorsa -> 0x31, güvenlik -> 0x33
      "write_sessions": [3], "write_security": 1,          // uzunluk farklı -> 0x13
      "io_sessions": [], "io_security": 0 },
    { "id": "0xF186", "source": "active_session" }         // canlı oturum baytı
  ],

  "routines": [
    { "id": "0x0203", "sessions": [3], "security": 0,
      "action": "static",           // "static" | "erase" (download bölgelerini fill ile siler) |
                                    // "crc32" (son indirmenin CRC32'si, 4 bayt BE)
      "start_result": "00", "stop_result": "01", "results": "AA55" }
  ],

  "memory": {
    "max_block_length": 130,        // 0x34 yanıtı; 0x36 isteği SID+BSC dahil bunu aşamaz (-> 0x13)
    "regions": [
      { "name": "flash", "address": "0x00080000", "size": "0x20000", "fill": "0xFF",
        "read": true,               // 0x23 ile okunabilir
        "download": true,           // 0x34 hedefi olabilir
        "init_hex": "..." }         // ops.: ofset 0'dan başlangıç içeriği
    ]
  },

  "dtc": {
    "availability_mask": "0xFF",
    "dtcs": [ { "dtc": "0x012345", "status": "0x2F",
      "snapshots": [ { "record": 1, "dids": [ { "id": "0x1001", "hex": "1234" } ] } ],
      "ext_data":  [ { "record": 1, "hex": "05" } ] } ]
  },

  "obd": { "mode01": { "0x0C": "1AF8", "0x0D": "3C", "0x05": "7B" } },
  //   0x00/0x20/0x40... destek bitmap'leri otomatik hesaplanır

  "faults": [                       // deterministik; ilk eşleşen kural uygulanır
    { "sid": "0x22", "id": "0xFA01", "nrc": "0x22" },          // sabit NRC
    { "sid": "0x22", "id": "0xFA02", "pending": 2 },           // 2 x 0x78, sonra gerçek yanıt
    { "sid": "0x22", "id": "0xFA03", "delay_ms": 400 },        // yanıt gecikmesi
    { "sid": "0x22", "id": "0xFA04", "no_response": true },    // hiç yanıt yok
    { "sid": "0x31", "id": "0xFA05", "nrc": "0x21", "count": 2 }, // ilk 2 istek busy
    { "sid": "0x10", "sub": "0x03", "nrc": "0x22" }            // alt fonksiyonla eşleşme
  ]
}
```

Hata kuralı eşleşmesi: `sid` zorunludur. `id`, 0x22'de istenen DID'lerden herhangi biri,
0x2E/0x2F ve diğerlerinde bayt 1-2, 0x31'de RID (bayt 2-3) ile karşılaştırılır. `sub`, bayt 1'in
alt 7 biti ile karşılaştırılır. `count`, kuralı ilk N eşleşen istekle sınırlar (0 = her zaman).
Sayaçlar `SIGUSR1`/`SIGHUP` ile sıfırlanır. `nrc` ve `pending` servis olayı gerektirir; bu yüzden
0x3E (kütüphane içinde yanıtlanır) için yalnızca `delay_ms` ve `no_response` etkilidir. Bastırma
bitli bir isteğe `pending` uygulanırsa, ISO 14229-1 gereği son pozitif yanıt yine gönderilir.

DTC kayıt biçimleri: 0x04 yanıtı `DTC(3) status [record numIds (DID data)...]...`, 0x06 yanıtı
`DTC(3) status [record data]...`. `0xFF` tüm kayıtlar, 0x06 için `0xFE` de tümü (OBD). 0x14 sonrası
statü `0x00` olur, snapshot ve ext-data silinir. DTC desteklenmeye devam eder (0x0A listeler).

## Kapsam

"iso14229" sütunu kütüphanenin yaptığını, "ecusim" sütunu bizim eklediğimizi gösterir.
Testler: `tests/hil/test_ecusim_conformance.py`.

| SID | Servis | iso14229 0.11.0 | ecusim | Test |
|---|---|---|---|---|
| 0x10 | DiagnosticSessionControl | ayrıştırma, yanıt çerçevesi, S3 başlatma | oturum listesi/geçiş kuralları, P2/P2* bildirimi (kütüphane istemci sabitlerini koyuyor), güvenliği yeniden kilitleme, default'a dönüşte IO/0x28/0x85 sıfırlama | evet |
| 0x11 | ECUReset | ayrıştırma, güç kesme zamanlaması, `DoScheduledReset` | tip 1–3, gerçek reset (uçucu durum, kuyruk boşaltma), 0x12 | evet (+SPR) |
| 0x14 | ClearDiagnosticInformation | ayrıştırma | JSON DTC tablosunu gerçekten temizleme, grup/tek DTC, 0x31 | evet |
| 0x19 | ReadDTCInformation | tüm alt fonksiyonları ayrıştırma, yanıt uzunluk denetimi | 0x01, 0x02, 0x04, 0x06, 0x0A verisi; diğerleri 0x12 | evet |
| 0x22 | ReadDataByIdentifier | ayrıştırma, çoklu DID döngüsü | DID tablosu, oturum/güvenlik, ISO uyumlu kısmi destek (desteklenmeyen DID atlanır) | evet |
| 0x23 | ReadMemoryByAddress | adres/uzunluk formatı | bellek bölgeleri (flash ile aynı model) | evet |
| 0x27 | SecurityAccess | ayrıştırma, "zaten açık → sıfır seed" | seviyeler, sabit/sayaç seed, `xor_ff`/`xor_const`, deneme limiti, 0x35/0x36/0x37, açılış gecikmesi, 0x24 | evet |
| 0x28 | CommunicationControl | ayrıştırma | kontrol tipi 0–3, iletişim tipi doğrulama | evet |
| 0x2E | WriteDataByIdentifier | ayrıştırma | yazılabilirlik, oturum/güvenlik, uzunluk | evet |
| 0x2F | InputOutputControlByIdentifier | ayrıştırma | parametre 00–03, controlState, default oturumda bırakma | evet |
| 0x31 | RoutineControl | ayrıştırma | start/stop/results, `static`/`erase`/`crc32`, 0x24 | evet |
| 0x34/0x36/0x37 | Download | ayrıştırma, BSC takibi ve FF→00 sarması, toplam uzunluk | bölge kontrolü, veriyi bellekte tutma, blok uzunluğu, CRC32 | evet (0x73 sapması: başarısız) |
| 0x3E | TesterPresent | tamamı (bastırma biti dahil) | – | evet |
| 0x85 | ControlDTCSetting | ayrıştırma | açık/kapalı durumu | evet |
| 0x01 | OBD-II mode 01 | – (`UDS_EVT_Custom`) | PID tablosu, destek bitmap'leri, fonksiyonel adresleme | evet |
| 0x35, 0x38, 0x3D, 0x2C, 0x87 ve handler'ı olmayan SID'ler | | ayrıştırma / `UDS_EVT_Custom` | 0x11 (0x38 için bayat yanıt düzeltmesi) | 0x35, 0x38, 0xBA |
| — | ISO-TP | (kendi soket taşıması kullanılmıyor, bkz. `src/tp.c`) | çekirdek ISO-TP soketi, CAN-FD, padding, BS/STmin | evet |
| — | Hata enjeksiyonu, günlük, kontrol | – | tamamı | evet |

## iso14229 0.11.0'da bulunan sorunlar ve ecusim'deki karşılıkları

| # | Sorun (kaynak: `iso14229.c`) | Etki | ecusim'de |
|---|---|---|---|
| 1 | `evaluateServiceResponse`: `UDS_EVT_Custom` yolu ve `SID > 0xBF` yolu `return NegativeResponse(...)` ile erken dönüyor. Fonksiyonel istekler için NRC bastırma bloğu atlanıyor. | Fonksiyonel 0x7DF isteğine `7F xx 11/31` gidiyor (ISO 14229-1 7.5 ihlali) | `ecu_on_tx` bastırır (`tx_suppressed`). Test: `test_obd_mode01_functional`, `test_functional_uds_addressing` |
| 2 | `Handle_0x38_RequestFileTransfer` NRC'leri `NegativeResponse()` çağırmadan döndürüyor | Önceki yanıt (bayat `send_buf`) yeniden gönderiliyor | `ecu_on_rx` `7F 38 11`'i önceden yazar. Test: `test_nrc_0x11_request_file_transfer_not_stale` |
| 3 | `Handle_0x10`: yanıttaki P2/P2* `UDS_CLIENT_DEFAULT_P2_MS` (150) / `_P2_STAR_MS` (1500) ile dolduruluyor, `srv->p2_ms` ile değil | Sunucu yanlış zamanlama bildiriyor | Olay işleyicisi yapılandırma değerlerini yazar |
| 4 | S3 zamanlayıcısı yalnızca 0x10 ve 0x3E'de yeniden başlıyor | Başka isteklerle canlı tutulan oturum düşüyor (ISO 14229-2) | Her rx/tx'te yeniden başlatılır. Test: `test_s3_kept_alive_by_any_request` |
| 5 | `p2_timer` yanıtlar arasında **en az** `p2_ms` bekletiyor | Arka arkaya isteklerde yanıt ~50 ms gecikiyor | Her yeni istekte zamanlayıcı bırakılır (`response_delay_ms` kadar) |
| 6 | 0x78 sonrası bastırma biti hâlâ uygulanıyor (koddaki TODO) | ISO'nun istediği son pozitif yanıt kayboluyor | `pending` kuralında bit kütüphaneden önce temizlenir. Test: `test_fault_pending_forces_response_despite_suppress_bit` |
| 7 | 0x36: yanlış blockSequenceCounter → `0x24`. ISO 14229-1:2020: `0x73`. Tekrarlanan blok (BSC = önceki) kabul edilmiyor. Aktarım yokken `0x70` (ISO 2020: `0x24`). | Negatif flash testleri ISO'dan sapar | **Düzeltilmedi.** Kontrol olaydan önce yapılıyor; yama gerekir. Test **başarısız**: `test_transfer_data_wrong_block_sequence_counter_iso_nrc` |
| 8 | 0x22 çoklu DID: ilk desteklenmeyen DID'de tüm istek NRC ile bitiyor | ISO: desteklenmeyen DID'ler atlanmalı | Olay işleyicisi yankılanan DID'i `send_len`'den geri alır (kütüphane iç alanına dayanır). Test: `test_rdbi_multi_did_partial_support` |
| 9 | 0x27: herhangi bir yanlış anahtardan sonra 1 s boyunca **tüm** 0x27 istekleri 0x36 alıyor, açılışta 1 s 0x37. Süreler derleme sabiti. Ayrılmış alt fonksiyon → 0x13 (ISO: 0x12). "Zaten açık" seed'i sabit 2 bayt. | Deneme sayısı semantiği yok | Zamanlayıcılar 0 ile derlenir, durum makinesi ecusim'de |
| 10 | `UDS_TP_ISOTP_SOCK`: `CAN_ISOTP_LL_OPTS` yok (CAN-FD imkânsız). `ioctl(SIOCGIFINDEX)` dönüşü kontrol edilmiyor (bilinmeyen arayüzde ifindex 0 = tüm CAN arayüzleri). Padding/BS/STmin ayarı yok. | | Kendi taşıma katmanı (`src/tp.c`) |
| 11 | `UDSMillis()` `gettimeofday()` kullanıyor | NTP adımında P2/S3 bozulur | `UDS_CUSTOM_MILLIS` + `CLOCK_MONOTONIC` |
| 12 | 0x28 ve 0x19, `recv_buf[1..2]`'yi uzunluk kontrolünden önce okuyor (tampon içinde, zararsız ama bayat veri). Uzunluk kontrolleri oturum/güvenlik kontrolünden önce (ISO 14229-1 Şekil 5'te 0x7F/0x33 önce gelir). | Küçük NRC önceliği farkı | – |
| 13 | 0.11.0 git etiketindeki birleşik `iso14229.c/.h` eski. Release asset'leri farklı. | | Release asset'leri kullanıldı (`VERSION`) |
