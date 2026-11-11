# automotive-eval: `automotive` crate değerlendirme denemesi (spike)

**Ürün kodu değildir.** [`automotive`](https://github.com/I-CAN-hack/automotive) crate'inin
(MIT, **`=0.6.0`**, yalnızca `socketcan` özelliği) ISO-TP ve UDS istemcisini NexusCAN test ECU'suna
(`tests/hil/ecusim`) karşı dener. Bağlam: D-003 (`planning/backlog-deferred.md`) ve
`planning/contracts/uds-interpretation-v1.md`.

Bağımsız bir cargo projesidir (kendi `[workspace]` tablosu var), root workspace'e girmez.
Ürün kodundan yalnızca `nexus-protocols` (seed/key sağlayıcıları, `default-features = false`)
path bağımlılığı olarak kullanılır.

## Gereksinimler

- MTU 72 ile açık `vcan0` (`scripts/setup_vcan.sh`), `can-isotp` çekirdek modülü
- `tests/hil/ecusim/build/ecusim` (yoksa `make -C tests/hil/ecusim`)
- `candump` (can-utils), `python3` (yalnızca standart kütüphane, `tools/*.py`)

## Çalıştırma

```bash
cd spikes/automotive-eval
cargo test -- --test-threads=1                    # tüm denemeler (~65 s)
cargo test -- --test-threads=1 --nocapture        # kanıt çıktılarıyla (candump, PDU günlüğü)
cargo test --test t05_pending -- --nocapture      # tek grup
cargo test --test t04_flash -- --ignored --nocapture   # F-P2: zamanlamaya duyarlı, varsayılan kapalı
```

`--test-threads=1` zorunludur: testler ECU süreçleri başlatır ve aynı CAN ID'lerini kullanır.
Kanıtlar `logs/` altına yazılır (git'e girmez): `<test>.ecu.jsonl` (ecusim olay günlüğü,
"ECU ne aldı"), `<test>.candump` (`candump -L`), `full_run.txt`.

## CAN ID'leri (paylaşılan vcan0)

| Kullanım | ID |
|---|---|
| Kullanıcının elle testi, **dokunulmaz** | 0x7E0 / 0x7E8 / 0x7DF |
| Paralel `automotive-hal-bridge` spike'ı | 0x7E4 / 0x7EC / 0x7DD, 0x7E5 / 0x7ED / 0x7DC |
| Klasik ecusim örneği | 0x7E2 / 0x7EA / fonksiyonel 0x7DE |
| CAN-FD ecusim örneği | 0x7E3 / 0x7EB / fonksiyonel 0x7D8 |
| 29-bit normal fixed | 0x18DA10F1 / 0x18DAF110 |
| Extended adresleme kahini (`tools/isotp_ext_echo.py`) | 0x6F0 / 0x6F8 |
| 32-bit FF kaçış kahini (`tools/isotp_fd_sink.py`) | 0x6C0 / 0x6C8 |
| Ham çerçeveli sahte ECU (bozuk yanıtlar) | 0x6E0 / 0x6E8 |
| Yanıtsız hedef | 0x6D0 / 0x6D8 |

`EcuSim` yalnızca kendi başlattığı PID'e sinyal gönderir ve yasak ID'lerle başlamayı reddeder.

## Yapılandırmalar (`config/`)

`tests/hil/ecusim/config/default.json` değiştirilmez; kopyaları:

| Dosya | Fark |
|---|---|
| `eval.json` | + DID FA07 (5 x 0x78), FA08 (12 x 0x78) |
| `isotp_bs2_st10.json` | ECU FC: BS=2, STmin=10 ms (istemcinin gönderici akış kontrolü) |
| `fd_bigblock.json` | `max_block_length` 4095 (ecusim üst sınırı, `UDS_TP_MTU`) |

## Test haritası

| Dosya | Madde | İçerik |
|---|---|---|
| `t01_basic.rs` | 1 | VIN (FF/FC/CF), 0x10 geçişleri + P2/P2* kaydı, 0x3E (bastırma), 0x11 |
| `t02_security.rs` | 2 | 0x27 seviye 1 (`xor_const`) ve 0x11 (`xor_ff`), 0x35/0x36/0x37, `sendKey` paniği |
| `t03_services.rs` | 3 | 0x22 çoklu (ham), 0x2E, 0x2F, 0x31, 0x28, 0x85, 0x14, 0x19 01/02/04/06/0A, 0x23 |
| `t04_flash.rs` | 4 | 0x34 → 128 KiB 0x36 (BSC sarması) → 0x37 → CRC32 rutini, verim |
| `t05_pending.rs` | 5 | 0x78 x2/x5, P2* süresi dolması, `request_timeout`, P2 ayarı, bastırma + 0x78 |
| `t06_s3.rs` | 6 | S3 düşmesi (otomatik 3E yok), sarmalayıcı keepalive |
| `t07_isotp.rs` | 7 | padding, STmin/BS (alıcı ve gönderici), extended, 29-bit, fonksiyonel, N_Bs/N_Cr |
| `t08_fd.rs` | 8 | FD VIN/200 B, FD flash (4095 B blok), 8192 B 32-bit FF kaçışı |
| `t09_observability.rs` | 9 | Transport dekoratörü, `tracing` olayları, ham çerçeve dinleme |
| `t10_robustness.rs` | 10 | yanıtsız ECU, geç yanıt zinciri, eşzamanlı istek, 15 bozuk yanıt, FC WAIT/OVFLW, çift FC, `Send` yoklaması |
| `t11_meta.rs` | 11 | boştaki adaptör worker'ının CPU maliyeti |

## Sarmalayıcı denemeleri (`src/lib.rs`)

Crate'teki eksikler için NexusCAN tarafında yazılacak katmanın prototipleri:

| Tip | Kapattığı eksik |
|---|---|
| `LoggingTransport` | Konuşma günlüğü (istek/yanıt/0x78 zaman damgaları) |
| `SplitTransport` | Fonksiyonel istek + fiziksel FC (çok çerçeveli yanıt) |
| `spawn_keepalive` + `SharedClient` | Arka plan TesterPresent, isteklerle kilitle sıralanmış |
| `PersistentTransport` + `response_matches` | Geç yanıt zinciri: kalıcı alıcı (FC her zaman), bayat PDU eleme |
| `flash()` + `flash_client_config()` | Flash dizisi; P2client = P2server + ΔP2 |

Değerlendirme raporu (madde madde sonuçlar, eksikler ve öneriler) protocol-specialist teslim
mesajındadır; test adları ve `logs/` dosyaları kanıt olarak kullanılır.
