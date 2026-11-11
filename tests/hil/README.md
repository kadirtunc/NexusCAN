# NexusCAN HIL test tezgâhı (`tests/hil/`)

Diagnostics (UDS / ISO-TP / OBD-II) özelliklerini donanım olmadan, `vcan0` üzerinde doğrulayan tezgâh.

```
            vcan0 (MTU 72)                          tarafsız gözlemci
  ┌──────────────────────────┐   ISO-TP (çekirdek)  ┌──────────────────────┐
  │ udsoncan + python-isotp  │ ◄──────────────────► │ ecusim (C)           │
  │ (pytest)                 │  0x7E0/0x7E8/0x7DF   │ iso14229 0.11.0      │
  └──────────────────────────┘                      │ + JSON yapılandırma  │
           ▲                                        └─────────┬────────────┘
           │ JSON-lines olay günlüğü ("ECU şunu aldı mı?")              │
           └────────────────────────────────────────────────────────────┘
  candump / isotpdump  ──►  golden/  (altın kayıt)
```

| Yol | İçerik |
|---|---|
| `ecusim/` | Sanal ECU: kaynak, Makefile, `config/default.json`, `third_party/` (iso14229, cJSON). Ayrıntı: [`ecusim/README.md`](ecusim/README.md) |
| `conftest.py` | ECU süreç yönetimi, olay günlüğü okuyucu, udsoncan istemci fabrikası, ham ISO-TP yardımcıları, `candump`/`isotpdump` gözlemcileri |
| `test_ecusim_conformance.py` | ecusim'in bağımsız istemciyle uygunluk testleri |
| `golden/` | `uds_session_security_vin.candump` (çerçeve dizisi) ve `.isotpdump` (ISO-TP/UDS çözümlü). `UPDATE_GOLDEN=1` ile yeniden üretilir |
| `requirements.txt` | Sabit sürümlü `udsoncan`, `can-isotp`, `python-can`, `pytest` |
| `run.sh` | Tek komutla çalıştırma |

## Çalıştırma

```bash
tests/hil/run.sh               # venv kur/güncelle, ecusim + ASan derle, pytest iki ikili üzerinde
tests/hil/run.sh --no-asan     # yalnızca release ikilisi
tests/hil/run.sh -- -k flash   # "--" sonrası pytest'e gider
```

Gereksinimler: MTU 72 ile açık `vcan0` (`scripts/setup_vcan.sh`), `can-isotp` çekirdek modülü
(soket açılınca otomatik yüklenir; yüklenmezse `run.sh` `sudo -n modprobe can-isotp` dener),
`can-utils` (`candump`, `isotpdump`), `gcc`, `make` ve `python3 -m venv`.
JUnit çıktıları `results/junit-{release,asan}.xml` altına yazılır.

Paylaşılan `vcan0` için: testler yalnızca şu ID'leri kullanır: 0x7E0/0x7E8/0x7DF (klasik örnek),
0x7E1/0x7E9/0x7DE (CAN-FD örneği) ve 0x5FF (yalnızca gönderen fonksiyonel soket). Bridge ve diğer
trafik etkilenmez. Ancak **bu ID'lerde** başka trafik olursa testler bozulur.

Not: Aynı rx ID'sine bağlı her çekirdek ISO-TP soketi her yanıtın bir kopyasını alır. Bu yüzden
bir test içindeki ham istekler udsoncan istemcisinin kendi bağlantısını kullanır (`ConnTp`).
0x7E8 üzerinde ikinci bir alıcı soket açmayın.

## Ürün testleri nasıl eklenecek (NexusCAN UDS istemcisi, D-003)

Bugün test edilen şey ecusim'in kendisidir. NexusCAN UDS istemcisi (D-003) geldiğinde aynı tezgâh
şöyle kullanılır:

1. **Ayrı dosya:** `tests/hil/test_product_<konu>.py`. Uygunluk dosyasını değiştirmeyin; ECU'nun
   doğru olduğunun kanıtı olarak kalır. Ürün testi ancak uygunluk yeşilse anlamlıdır.
2. **Fikstürler:** `ecu` (her testten önce SIGUSR1 ile durum sıfırlanır) ve gerekirse `ecu_fd`.
   Senaryo farklı bir ECU davranışı istiyorsa yeni bir `ecusim/config/<senaryo>.json` ekleyin ve
   süreci `EcuProcess(tmp_path, "ad", cfg_src=...)` ile başlatın. `default.json`'ı ürün testine
   göre değiştirmeyin.
3. **Ürünü sürme:** NexusCAN kodu burada içe aktarılmaz. Ürün ayrı süreç olarak çalışır; örneğin
   başsız `nexus-cli` ikilisi ya da Tauri bridge (`:14210`). Aynı `vcan0` ve aynı ID'ler
   (0x7E0/0x7E8) kullanılır. Test ürün komutunu başlatır, çıktısını beklenen değerlerle karşılaştırır.
4. **İki taraflı doğrulama:** Ürünün çıktısının yanında, ECU tarafında "gerçekten aldı mı?" kontrolünü
   `ecu.log` (`rx`/`tx` olayları) ile yapın. Örnek: flash testinde 0x36 dizisi, TesterPresent'te
   0x3E'nin olmaması, 0x78 sonrası beklemeler. Veri yolu kaydı `Candump`/`IsoTpDump` ile alınabilir.
5. **Hata senaryoları:** 0x78/P2*, gecikme, yanıtsızlık, 0x21 ve NRC'lerde ürün davranışı `faults`
   kurallarıyla test edilir (deterministik; rastgele davranış yok).
6. **ASan:** `run.sh` her yeni testi sanitizer ikilisiyle de koşar. ecusim'in çıkış kodu ya da
   stderr'i temiz değilse teardown başarısız olur.

### Mevcut ürün testleri

- `test_product_uds.py` (D-003, 18 test): `nexus_bridge` (kendi örneği, `NEXUS_TEST_BRIDGE_ADDR`,
  varsayılan `127.0.0.1:14298`) HTTP API'si üzerinden kara kutu. ECU kimlikleri: klasik
  0x7E6/0x7EE/0x7DC, CAN-FD 0x7E7/0x7EF/0x7DA. Yapılandırmalar `configs/` altında
  (`product_classic.json`, `product_slow_fc.json`). İkili: `NEXUS_BRIDGE_BIN`
  (varsayılan `target/release/nexus_bridge`, yoksa `run.sh` derler).
- 0x7E0/0x7E8/0x7DF'de başka bir ECU çalışıyorsa (örneğin elle başlatılmış ecusim), uygunluk
  takımını başka kimliklerle koşun: `ECUSIM_REQ=0x7E2 ECUSIM_RESP=0x7EA ECUSIM_FUNC=0x7DB tests/hil/run.sh`.
  Golden karşılaştırması kimlikleri 0x7E0/0x7E8'e geri çevirir.
