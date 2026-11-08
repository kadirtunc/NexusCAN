export const simWidgetsCanvasTr = {
  // Common
  'simWdg.common.na': 'N/A',
  'simWdg.common.raw': 'HAM',

  // Status & Zones
  'simWdg.status.crit': 'KRİT',
  'simWdg.status.warn': 'UYR',
  'simWdg.status.nom': 'NOM',
  'simWdg.status.lowClamp': 'ALT-KIRPMA',
  'simWdg.status.highClamp': 'ÜST-KIRPMA',
  'simWdg.status.critical': 'KRİTİK',
  'simWdg.status.warning': 'UYARI',
  'simWdg.status.inRange': 'ARALIK-İÇİ',

  // Locks & Safety
  'simWdg.lock.listenOnlyTitle': 'Saha Güvenliği: Listen-Only modunda veya veri yolu bağlı değilken TX kilitlidir.',
  'simWdg.lock.cloudReadOnlyTitle': 'Bulut köprü modunda uzaktan CAN TX kilitlidir.',
  'simWdg.lock.listenOnlyTag': '[LISTEN-ONLY]',
  'simWdg.lock.cloudReadOnlyTag': '[READ-ONLY CLOUD]',

  // Bar Widget
  'simWdg.bar.peakTitle': 'Tepe: {peak} {unit}',
  'simWdg.bar.resetPeakTitle': 'Tepe tutucu değerini sıfırla',
  'simWdg.bar.pk': 'TP',
  'simWdg.bar.pkColon': 'TP:',

  // Numeric Widget
  'simWdg.numeric.rawLabel': 'HAM',

  // LED Widget
  'simWdg.led.active': 'AKTİF',
  'simWdg.led.idle': 'BOŞTA',
  'simWdg.led.cond': 'ŞART: DEĞER {op} {threshold}',

  // Enum Badge
  'simWdg.enum.raw': 'HAM: {val}',

  // Button Widget
  'simWdg.button.confirmPromptFallback': 'Onaylamak için tekrar basın',
  'simWdg.button.armed': 'KURULU {sec}s',
  'simWdg.button.guardConfirm': 'ÇİFT ONAY',
  'simWdg.button.cancel': 'İptal',
  'simWdg.button.out': 'ÇIKIŞ',

  // Checkbox Widget
  'simWdg.checkbox.on': 'AÇIK',
  'simWdg.checkbox.off': 'KAPALI',
  'simWdg.checkbox.busVal': 'HAT DEĞERİ',

  // Combobox Widget
  'simWdg.combo.defaultOff': '0 : KAPALI',
  'simWdg.combo.defaultOn': '1 : AÇIK',
  'simWdg.combo.rawOption': 'HAM : {val}',
  'simWdg.combo.selected': 'SEÇİLİ',
  'simWdg.combo.states': '{count} DURUM',

  // Slider Widget
  'simWdg.slider.stepDown': 'Adım azalt',
  'simWdg.slider.stepUp': 'Adım artır',
  'simWdg.slider.numericInputAria': '{title} sayısal giriş',
  'simWdg.slider.step': 'ADIM',

  // Group Widget
  'simWdg.group.emptyTitle': 'GRUP BOŞ — SOL PALETTEN SÜRÜKLEYİN VEYA HIZLI EKLEYİN',

  // Unbound Body
  'simWdg.body.unbound': 'SİNYAL BAĞLANMADI // DENETÇİDEN SİNYAL SEÇİN',

  // Map Widget
  'simWdg.map.ariaLabel': '{title} OpenStreetMap GNSS Haritası',
  'simWdg.map.lat': 'ENL:',
  'simWdg.map.lon': 'BOY:',
  'simWdg.map.hdg': 'YÖN:',
  'simWdg.map.spd': 'HIZ:',
  'simWdg.map.trk': 'İZ:',
  'simWdg.map.unboundPill': 'BAĞLANTISIZ · DENETÇİDEN ENL & BOY BAĞLAYIN',
  'simWdg.map.readOnlyCloud': '[SALT-OKUNUR BULUT]',
  'simWdg.map.osmStandardTitle': 'OpenStreetMap Standart katmanı',
  'simWdg.map.osmDarkTitle': 'Düşük parlamalı koyu harita katmanı',
  'simWdg.map.followTitle': 'Canlı GNSS konumunu otomatik takip et / merkeze kilitle',
  'simWdg.map.followBtn': 'TAKİP',
  'simWdg.map.driveLoopTitle': 'Sanal CAN hattında ~50 km/s hızla kapalı pist GPS test sürüşünü başlat/durdur',
  'simWdg.map.driveLoopBtn': '[SÜRÜŞ DÖNGÜSÜ]',
  'simWdg.map.clearTrailTitle': 'GPS rota izini temizle',
  'simWdg.map.clearTrailBtn': 'TEMİZLE',
  'simWdg.map.zoomOutTitle': 'Uzaklaştır (-)',
  'simWdg.map.zoomOutAria': 'Haritayı uzaklaştır',
  'simWdg.map.zoomInTitle': 'Yakınlaştır (+)',
  'simWdg.map.zoomInAria': 'Haritayı yakınlaştır',
  'simWdg.map.hintLoop': 'SANAL DÖNGÜ ~50 KM/S · GEÇERSİZ KILMAK İÇİN HARİTAYA TIKLAYIN',
  'simWdg.map.hintClick': 'SANAL GPS BELİRLEMEK İÇİN HARİTAYA TIKLAYIN',

  // Graph Canvas Widget
  'simWdg.graph.noSignal': 'SİNYAL BAĞLANMADI // DENETÇİDEN BİRİNCİL SİNYAL BAĞLAYIN',
  'simWdg.graph.autoY': 'OTO-Y',
  'simWdg.graph.fixedY': 'SABİT-Y',
  'simWdg.graph.ariaLabel': '{title} 60 FPS Osiloskop Grafiği',

  // Virtual CAN Frame Inspector
  'simWdg.inspector.sectionAria': 'Sanal CAN Çerçeve Denetçisi',
  'simWdg.inspector.virtualTitle': 'SANAL CAN / CAN-FD ÇERÇEVE DENETÇİSİ ({count} ÇERÇEVE)',
  'simWdg.inspector.liveMirrorTitle': 'CANLI KÖPRÜ ÇERÇEVE AYNASI ({count} ÇERÇEVE)',
  'simWdg.inspector.virtualSubtext': 'TARAYICI BELLEĞİNDE INTEL (@1) & MOTOROLA (@0) BİT PAKETLİ',
  'simWdg.inspector.liveMirrorSubtext': 'PASİF YALNIZCA-DİNLEME AKIŞ AYNASI',
  'simWdg.inspector.noRemoteTx': 'UZAKTAN TX YOK',
  'simWdg.inspector.emptyVirtual': 'HENÜZ PAKETLENECEK SANAL CAN ÇERÇEVESİ YOK // WIDGET VEYA ÜRETEÇ SİNYALİ BAĞLAYIN.',
  'simWdg.inspector.emptyLive': 'CANLI KÖPRÜDEN AKTİF CAN ÇERÇEVESİ BEKLENİYOR...',
  'simWdg.inspector.thBus': 'HAT',
  'simWdg.inspector.thKeyArb': 'ANAHTAR / ARB ID',
  'simWdg.inspector.thSymbol': 'SEMBOL',
  'simWdg.inspector.thDlc': 'DLC',
  'simWdg.inspector.thPayload': 'HAM VERİ (HEX)',
  'simWdg.inspector.thSignals': 'ÇÖZÜLMÜŞ / PAKETLENMİŞ SİNYALLER',
} as const;

export const simWidgetsCanvasEn: Record<keyof typeof simWidgetsCanvasTr, string> = {
  // Common
  'simWdg.common.na': 'N/A',
  'simWdg.common.raw': 'RAW',

  // Status & Zones
  'simWdg.status.crit': 'CRIT',
  'simWdg.status.warn': 'WARN',
  'simWdg.status.nom': 'NOM',
  'simWdg.status.lowClamp': 'LOW-CLAMP',
  'simWdg.status.highClamp': 'HIGH-CLAMP',
  'simWdg.status.critical': 'CRITICAL',
  'simWdg.status.warning': 'WARNING',
  'simWdg.status.inRange': 'IN-RANGE',

  // Locks & Safety
  'simWdg.lock.listenOnlyTitle': 'Field Safety: TX is locked in Listen-Only mode or when bus is disconnected.',
  'simWdg.lock.cloudReadOnlyTitle': 'Remote CAN TX is locked in cloud bridge mode.',
  'simWdg.lock.listenOnlyTag': '[LISTEN-ONLY]',
  'simWdg.lock.cloudReadOnlyTag': '[READ-ONLY CLOUD]',

  // Bar Widget
  'simWdg.bar.peakTitle': 'Peak: {peak} {unit}',
  'simWdg.bar.resetPeakTitle': 'Reset peak hold value',
  'simWdg.bar.pk': 'PK',
  'simWdg.bar.pkColon': 'PK:',

  // Numeric Widget
  'simWdg.numeric.rawLabel': 'RAW',

  // LED Widget
  'simWdg.led.active': 'ACTIVE',
  'simWdg.led.idle': 'IDLE',
  'simWdg.led.cond': 'COND: VAL {op} {threshold}',

  // Enum Badge
  'simWdg.enum.raw': 'RAW: {val}',

  // Button Widget
  'simWdg.button.confirmPromptFallback': 'Press again to confirm',
  'simWdg.button.armed': 'ARMED {sec}s',
  'simWdg.button.guardConfirm': 'DOUBLE CONFIRM',
  'simWdg.button.cancel': 'Cancel',
  'simWdg.button.out': 'OUT',

  // Checkbox Widget
  'simWdg.checkbox.on': 'ON',
  'simWdg.checkbox.off': 'OFF',
  'simWdg.checkbox.busVal': 'BUS VAL',

  // Combobox Widget
  'simWdg.combo.defaultOff': '0 : OFF',
  'simWdg.combo.defaultOn': '1 : ON',
  'simWdg.combo.rawOption': 'RAW : {val}',
  'simWdg.combo.selected': 'SELECTED',
  'simWdg.combo.states': '{count} STATES',

  // Slider Widget
  'simWdg.slider.stepDown': 'Step down',
  'simWdg.slider.stepUp': 'Step up',
  'simWdg.slider.numericInputAria': '{title} numeric input',
  'simWdg.slider.step': 'STEP',

  // Group Widget
  'simWdg.group.emptyTitle': 'EMPTY GROUP — DRAG FROM PALETTE OR QUICK ADD',

  // Unbound Body
  'simWdg.body.unbound': 'UNBOUND // SELECT SIGNAL IN INSPECTOR',

  // Map Widget
  'simWdg.map.ariaLabel': '{title} OpenStreetMap GNSS Map',
  'simWdg.map.lat': 'LAT:',
  'simWdg.map.lon': 'LON:',
  'simWdg.map.hdg': 'HDG:',
  'simWdg.map.spd': 'SPD:',
  'simWdg.map.trk': 'TRK:',
  'simWdg.map.unboundPill': 'UNBOUND · BIND LAT & LON IN INSPECTOR',
  'simWdg.map.readOnlyCloud': '[READ-ONLY CLOUD]',
  'simWdg.map.osmStandardTitle': 'OpenStreetMap Standard layer',
  'simWdg.map.osmDarkTitle': 'Low-glare dark map layer',
  'simWdg.map.followTitle': 'Auto-follow / lock center to live GNSS position',
  'simWdg.map.followBtn': 'FOLLOW',
  'simWdg.map.driveLoopTitle': 'Start/stop closed-circuit GPS test drive at ~50 km/h on virtual CAN bus',
  'simWdg.map.driveLoopBtn': '[DRIVE LOOP]',
  'simWdg.map.clearTrailTitle': 'Clear GPS breadcrumb trail',
  'simWdg.map.clearTrailBtn': 'CLR',
  'simWdg.map.zoomOutTitle': 'Zoom out (-)',
  'simWdg.map.zoomOutAria': 'Zoom out map',
  'simWdg.map.zoomInTitle': 'Zoom in (+)',
  'simWdg.map.zoomInAria': 'Zoom in map',
  'simWdg.map.hintLoop': 'VIRTUAL LOOP ~50 KM/H · CLICK MAP TO OVERRIDE',
  'simWdg.map.hintClick': 'CLICK MAP TO SET VIRTUAL GPS',

  // Graph Canvas Widget
  'simWdg.graph.noSignal': 'NO SIGNAL BOUND // BIND PRIMARY SIGNAL IN INSPECTOR',
  'simWdg.graph.autoY': 'AUTO-Y',
  'simWdg.graph.fixedY': 'FIXED-Y',
  'simWdg.graph.ariaLabel': '{title} 60 FPS Oscilloscope Graph',

  // Virtual CAN Frame Inspector
  'simWdg.inspector.sectionAria': 'Virtual CAN Frame Inspector',
  'simWdg.inspector.virtualTitle': 'VIRTUAL CAN / CAN-FD FRAME INSPECTOR ({count} FRAMES)',
  'simWdg.inspector.liveMirrorTitle': 'LIVE BRIDGE FRAME MIRROR ({count} FRAMES)',
  'simWdg.inspector.virtualSubtext': 'INTEL (@1) & MOTOROLA (@0) BIT-PACKED IN BROWSER MEMORY',
  'simWdg.inspector.liveMirrorSubtext': 'PASSIVE LISTEN-ONLY STREAM MIRROR',
  'simWdg.inspector.noRemoteTx': 'NO REMOTE TX',
  'simWdg.inspector.emptyVirtual': 'NO VIRTUAL CAN FRAMES TO PACK YET // BIND A WIDGET OR GENERATOR SIGNAL.',
  'simWdg.inspector.emptyLive': 'WAITING FOR ACTIVE CAN FRAMES FROM LIVE BRIDGE...',
  'simWdg.inspector.thBus': 'BUS',
  'simWdg.inspector.thKeyArb': 'KEY / ARB ID',
  'simWdg.inspector.thSymbol': 'SYMBOL',
  'simWdg.inspector.thDlc': 'DLC',
  'simWdg.inspector.thPayload': 'RAW PAYLOAD (HEX)',
  'simWdg.inspector.thSignals': 'DECODED / PACKED SIGNALS',
};
