# NexusCAN — Tam Kapsamlı Endüstriyel Test & HIL Doğrulama Paketi (`test/`)

Bu dizin, **NexusCAN** masaüstü analizörü, Web/Bridge arayüzü ve `nexuscan` Headless Saha Ajanı tarafından desteklenen **tüm dosya formatlarını** birbirleriyle %100 uyumlu tek bir sinyal/mesaj evreni üzerinde uçtan uca test edebilmeniz için hazırlanmıştır.

`ev_powertrain_full_test.dbc` yüklendiğinde `test/traces/` altındaki **5 farklı trace formatının tamamı** (`.blf`, `.trc`, `.asc`, `.log`, `.csv`) aynı 10.00 saniyelik elektrikli araç ivmelenme, sabit hız ve rejeneratif frenleme sürüş çevrimini anlamlı fiziksel eğriler (`PackVoltage_V`, `PackCurrent_A`, `MotorSpeed_RPM`, `PhaseCurrentU_A`, `MuxPage 0..3`, `GNSS` rotası) halinde çözümler.

---

## Dizin Yapısı ve Dosya Özeti

```text
test/
├── databases/
│   ├── ev_powertrain_full_test.dbc      # Ana EV Powertrain DBC (5 ECU, Intel + Motorola, Mux, 64B CAN-FD Float, 29-bit Ext)
│   ├── cascaded_mux_stress.dbc          # 3-katmanlı SG_MUL_VAL_ kaskad mux + sınır geçişli bit dizilimi stres testi DBC
│   └── industrial_charger_station.kcd   # 350 kW DC Hızlı Şarj İstasyonu Kayak XML (.kcd) veritabanı (EVSE/PLC/METER)
├── traces/
│   ├── ev_drive_cycle_canfd.blf         # İkili (Binary) zlib sıkıştırmalı Vector BLF (64B CAN-FD BRS + Extended TX dahil)
│   ├── ev_drive_cycle_pcan.trc          # PCAN-Trace v2.1 formatı (DT + FB CAN-FD BRS satırları)
│   ├── ev_drive_cycle_vector.asc        # Vector ASCII (.asc) formatı (Klasik CAN + CANFD BRS satırları)
│   ├── ev_drive_cycle_socketcan.log     # Linux SocketCAN candump -L (.log) formatı (101#... ve 205##1... CAN-FD)
│   └── ev_drive_cycle_table.csv         # NexusCAN sütunlu CSV trace kaydı
├── panels/
│   └── ev_cockpit_hil.nexuspanel.json   # Simülasyon Kokpiti (Gauge, Bar, LED, Graph, Harita + 5 Buton Modu + Çift Onay)
├── projects/
│   └── ev_restbus_hil_demo.nexusproj.json # Tek tıkla tüm çalışma alanını kuran tam masaüstü proje paketi (.dbc gömülü)
└── agent/
    ├── agent.mock.toml                  # Donanımsız mock0 + yerel Read-Only Web HMI (:8090) saha ajanı yapılandırması
    └── agent.vcan0.toml                 # Linux vcan0 CAN-FD + yerel Read-Only Web HMI (:8091) saha ajanı yapılandırması
```

---

## Adım Adım Test Senaryoları

### 1. Tek Adımda Tam Proje Açılışı (`test/projects/ev_restbus_hil_demo.nexusproj.json`)
1. Üst araç çubuğundan **Proje** menüsünü açın ve **Proje İçe Aktar (.nexusproj.json)** düğmesine tıklayın.
2. `test/projects/ev_restbus_hil_demo.nexusproj.json` dosyasını seçin.
3. Proje açıldığında otomatik olarak:
   - `ev_powertrain_full_test.dbc` veritabanı kataloğa yüklenir,
   - `mock0` ve `vcan0` bağlantı profilleri tanımlanır,
   - **Transmit** listesine sembolik (`0x310 VCU_DriverControls`, `0x18FF50E5 OBC_ChargerStatusExt`) ve ham UDS (`0x7E0`) çerçeveleri eklenir,
   - **Plotter (Osiloskop)** ekranına 4 temel sinyal (`MotorSpeed_RPM`, `PackVoltage_V`, `PackCurrent_A`, `PhaseCurrentU_A`) bağlanır,
   - **Simulation & Replay** başta olmak üzere tüm mühendislik araç paketleri (`Toolpacks`) etkinleşir.

### 2. Ağ Veritabanları & Bit Matrisi Testi (`DBC Studio` / `Databases`)
1. Sol gezginden **Databases** sekmesine geçin ve **Veritabanı Yükle** ile sırasıyla şu dosyaları deneyin:
   - `test/databases/ev_powertrain_full_test.dbc`:
     - `0x102 MCU_MotorDrive` mesajını seçip **Bit Layout Matrix** üzerinde Motorola Big-Endian (`@0-` / `@0+`) yerleşimini inceleyin.
     - `0x205 MCU_FastDiagnosticsFD` mesajını seçip 64-byte (`512 bit`) CAN-FD matrisinde IEEE-754 `Float32` (`PhaseCurrentU_A`), `Float64` (`TotalMechanicalEnergy_kWh`) ve son byte (`FdCrc8Checksum`, bit `504..511`) yerleşimini doğrulayın.
   - `test/databases/cascaded_mux_stress.dbc`:
     - `0x180 CascadedMuxDiag3Level` mesajında `RootDomainMux -> ClusterSubMux -> ChannelLeafMux` 3 katmanlı kaskad multiplexer ağacını ve `MUX ×N` çakışma rozetlerini inceleyin.
   - `test/databases/industrial_charger_station.kcd`:
     - Kayak XML (`.kcd`) formatındaki `EVSE`, `PLC`, `METER` düğümlerini ve `LabelSet` durum tablolarını doğrulayın.

### 3. 5 Trace Formatı & ID-Filtreli Restbus Replay Testi (`Trace` & `Plotter`)
1. `ev_powertrain_full_test.dbc` yüklüyken **Trace** sekmesinde **Dosya Aç / İçe Aktar** düğmesiyle `test/traces/` altındaki 5 dosyadan herhangi birini (`.blf`, `.trc`, `.asc`, `.log` veya `.csv`) seçin.
2. **Replay Başlat** düğmesine basın ve **Plotter** sekmesine geçin:
   - `0–4 sn` ivmelenme (`0 -> 9600 RPM`, `+320 A` akım, batarya gerilim çökmesi),
   - `4–7 sn` yüksek hızda sabit sürüş,
   - `7–10 sn` rejeneratif frenleme (`-165 A` geri kazanım akımı, gerilim yükselmesi) eğrilerini canlı 60 FPS osiloskopta izleyin.
3. **Restbus ECU Susturma (ID Filtresi) Testi:**
   - Replay panelinde **Exclude (Hariç Tut)** modunu seçip `MCU` (`STD:0x102` / `STD:0x205`) çipine tıklayın: oynatma durmadan motor mesajlarının anında susturulduğunu ve `Filtered Out` sayacının arttığını gözlemleyin.
   - Oynatma devam ederken modu **Include (Yalnızca Seçililer)** olarak değiştirip filtrenin kesintisiz tersine döndüğünü doğrulayın.
   - Gerçek donanım / `vcan0` hattına çıkış testi için kanalı `Arm Active Bus` ile silahlandırıp `Hardware TX` kutusunu açın; ardından üst bardaki kırmızı **PANIC STOP** düğmesiyle donanım çıkışının `< 5 ms` içinde kesildiğini doğrulayın.

### 4. Etkileşimli Simülasyon Kokpiti & 5 Gelişmiş Buton Modu (`Panels`)
1. Sol gezginden **Panels (Simülasyon)** sekmesine geçin ve **Panel İçe Aktar (.nexuspanel.json)** ile `test/panels/ev_cockpit_hil.nexuspanel.json` dosyasını yükleyin (veya demo projesini açtıysanız doğrudan hazırdır).
2. Sağ üstten modu **DESIGN -> RUN** konumuna alın:
   - **1. Momentary (`Space`):** Basılı tutulduğu sürece `HornPulseCmd = 1`, bırakıldığında `0` üretir.
   - **2. Toggle:** Her tıklamada `ContactorState` değerini `0 (OPEN)` <-> `2 (CLOSED)` arasında kilitler; üstteki LED göstergesi anında tepki verir.
   - **3. Pulse (`H` tuşu):** Tek basışta `350 ms` boyunca `1` gönderip otomatik olarak `0` değerine döner.
   - **4. Step (`R` tuşu):** `RegenLevelStep` sinyalini `0..5` aralığında `+1` artırır ve sınırda başa sarar (`stepWrap`).
   - **5. Cycle (`G` tuşu):** `DriveGearMode` sinyalini `P -> R -> N -> D -> S` seçenekleri arasında döndürür.
   - **Çift Onay Kapaklı Acil Kesici (`HV ACİL KESİCİ`):** Yanlışlıkla tetiklemeyi önlemek için ilk tıklamada onay kapağını açar, ikinci onayda `EmergencyLatchCmd = 1` gönderir.
   - **Hedef Tork Slider & Dalga Üreteçleri:** Slider ile `TargetTorquePct` değerini sürükleyin; sağ çekmecedeki **Generators** bölümünden `MotorSpeed_RPM` (sinüs) ve `PackCurrent_A` (üçgen) otomatik sinyal üreteçlerini açıp kapatın.

### 5. CLI Linter & Headless Saha Ajanı (`nexuscan`) Testi
Proje kök dizininde terminal üzerinden derlenmiş `nexuscan` ikilisini doğrudan test edebilirsiniz:

```bash
# 1. Veritabanı doğrulama (DBC & KCD Linter — çıkış kodu 0):
./target/release/nexuscan dbc lint test/databases/ev_powertrain_full_test.dbc
./target/release/nexuscan dbc lint test/databases/cascaded_mux_stress.dbc
./target/release/nexuscan dbc lint test/databases/industrial_charger_station.kcd

# 2. Donanımsız mock0 ile Headless Ajan + Yerel Read-Only Web HMI (http://127.0.0.1:8090):
./target/release/nexuscan agent run --config test/agent/agent.mock.toml

# 3. Linux SocketCAN vcan0 ile Headless Ajan + Yerel Read-Only Web HMI (http://127.0.0.1:8091):
./target/release/nexuscan agent run --config test/agent/agent.vcan0.toml
```
