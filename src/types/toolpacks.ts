/**
 * Modular Engineering Toolpacks (`Mühendislik Paketleri`)
 *
 * Keeps the desktop workspace lean and responsive. Advanced protocol, discovery
 * and test runner modules stay hidden and consume 0 CPU until explicitly enabled
 * per project (`.nexusproj.json`).
 *
 * 100% Type-compatible with NexusCANCloud `src/contracts/workspace.ts`.
 */

export type EngineeringToolpackId =
  | 'core'
  | 'simulation_replay'
  | 'reverse_engineering'
  | 'automotive_diagnostics'
  | 'heavy_duty_j1939'
  | 'robotics_canopen'
  | 'hil_automation';

export const DEFAULT_ENABLED_TOOLPACKS: readonly EngineeringToolpackId[] = [
  'core',
  'simulation_replay',
] as const;

export type EngineeringToolpackReleaseStage = 'active' | 'phase_2' | 'phase_3';

export interface EngineeringToolpackDefinitionDto {
  id: EngineeringToolpackId;
  title: string;
  shortBadge: string;
  category: string;
  description: string;
  targetAudience: string;
  alwaysEnabled: boolean;
  releaseStage: EngineeringToolpackReleaseStage;
  clientModules: readonly string[];
  cloudModules: readonly string[];
}

export const ENGINEERING_TOOLPACK_CATALOG: readonly EngineeringToolpackDefinitionDto[] = [
  {
    id: 'core',
    title: 'Core Telemetry & DBC Pack',
    shortBadge: 'CORE',
    category: 'Temel Çekirdek',
    description:
      'CAN / CAN-FD bağlantıları, sabit satırlı Rx/Tx tablosu, kronolojik Trace, 60 FPS Osiloskop, DBC Studio ve Canlı Bulut Köprüsü.',
    targetAudience: 'Tüm CAN / CAN-FD mühendislik ekipleri',
    alwaysEnabled: true,
    releaseStage: 'active',
    clientModules: [
      'Bağlantılar',
      'Rx / Tx',
      'Trace',
      'Plotter (60 FPS)',
      'DBC Studio',
      'Cloud Köprüsü',
    ],
    cloudModules: [
      'DBC Studio & Semantik Diff',
      'Canlı İzleme Odaları',
      'Kayıt Oynatıcı & CSV/ASC Export',
    ],
  },
  {
    id: 'simulation_replay',
    title: 'Simulation, Virtual Panels & Replay Pack',
    shortBadge: 'SIM & REPLAY',
    category: 'Simülasyon & Sanal Test',
    description:
      'Sanal gösterge ve OpenStreetMap/GNSS panelleri, gelişmiş sinyal üreteçleri, buton/slider/switch uyaranları ve kayıttan hatta geri basma (Restbus Lite).',
    targetAudience: 'HIL masası, BMS/VCU masaüstü doğrulama ve saha simülasyonu',
    alwaysEnabled: false,
    releaseStage: 'active',
    clientModules: [
      'Simülasyon & Sanal Paneller',
      'Gelişmiş Buton/Dalga Uyaranları',
      'ID-Filtreli Restbus Replay & Vector .blf',
    ],
    cloudModules: [
      'Bulut Sanal Gösterge & GNSS Stüdyosu',
      '.nexuspanel.json Senkronizasyonu',
    ],
  },
  {
    id: 'reverse_engineering',
    title: 'Discovery & Reverse-Engineering Pack',
    shortBadge: 'DISCOVERY',
    category: 'Keşif & Sinyal Çözümleme',
    description:
      'DBC olmadan bilinmeyen CAN hattında rölanti (baseline) maskeleme, 64-bit canlı bit değişim ısı haritası ve tek tıkla DBC Studio sinyal aktarımı.',
    targetAudience: 'Tersine mühendislik, aftermarket entegrasyon ve dokümansız ECU analizi',
    alwaysEnabled: false,
    releaseStage: 'phase_2',
    clientModules: [
      'Baseline Rölanti Maskeleme',
      '64-Bit Canlı Isı Haritası',
      'Tek Tıkla DBC Sinyal Keşfi',
    ],
    cloudModules: ['Keşfedilen Sinyal Taslaklarını DBC Studio’ya Aktarma'],
  },
  {
    id: 'automotive_diagnostics',
    title: 'Automotive Diagnostics Pack (ISO-TP / OBD-II / UDS)',
    shortBadge: 'UDS / OBD-II',
    category: 'Otomotiv Tanılama',
    description:
      'ISO 15765-2 çok paketli çerçeve birleştirme, standart OBD-II PID/DTC arıza kodu okuma-silme ve UDS (0x10, 0x19, 0x22, 0x3E) servis konsolu.',
    targetAudience: 'EV, binek araç ve ECU yazılım doğrulama mühendisleri',
    alwaysEnabled: false,
    releaseStage: 'phase_3',
    clientModules: [
      'ISO-TP Çoklu Paket Motoru',
      'OBD-II Canlı PID & DTC Ekranı',
      'UDS Servis Konsolu',
    ],
    cloudModules: ['DID Sözlük (.json) Senkronizasyonu & Arıza Anlık Görüntüleri'],
  },
  {
    id: 'heavy_duty_j1939',
    title: 'Heavy-Duty & Defense Pack (SAE J1939)',
    shortBadge: 'J1939',
    category: 'Ağır Vasıta & Savunma',
    description:
      '29-bit Extended ID üzerinde otomatik Priority / PGN / Source Address ayrıştırma ve BAM / TP.DT çoklu paket birleştirici.',
    targetAudience: 'Kamyon, otobüs, tarım, denizcilik, jeneratör ve savunma platformları',
    alwaysEnabled: false,
    releaseStage: 'phase_3',
    clientModules: ['PGN / SA Sütun Görünümü', 'J1939-21 BAM / TP.DT Birleştirici'],
    cloudModules: ['Kayıt Analizinde PGN Filtreleme'],
  },
  {
    id: 'robotics_canopen',
    title: 'Robotics & Industrial Motion Pack (CANopen)',
    shortBadge: 'CANOPEN',
    category: 'Robotik & Endüstriyel',
    description:
      'Node ID bazlı NMT durum makinesi, Heartbeat (0x700+ID), EMCY acil durum kodları ve TPDO/RPDO/SDO sözlük trafiği denetçisi.',
    targetAudience: 'Robotik aktüatör, AGV/AMR ve endüstriyel servo sürücü geliştiricileri',
    alwaysEnabled: false,
    releaseStage: 'phase_3',
    clientModules: ['Node ID Durum Tablosu', 'NMT / Heartbeat / EMCY / SDO Denetçisi'],
    cloudModules: ['Düğüm Kopma & EMCY Zaman Çizelgesi İşaretleri'],
  },
  {
    id: 'hil_automation',
    title: 'Automated ECU Test Runner Pack',
    shortBadge: 'AUTO-TEST',
    category: 'Otomasyon & Doğrulama',
    description:
      'Adım adım otomatik doğrulama senaryoları koşturma, sınır/zamanlama kontrolü ve otomatik PASS / FAIL mühendislik test raporu üretimi.',
    targetAudience: 'Kalite doğrulama, üretim sonu (EOL) ve HIL test mühendisleri',
    alwaysEnabled: false,
    releaseStage: 'phase_3',
    clientModules: ['Senaryo Koşturucu', 'Yerel PASS / FAIL Doğrulama Motoru'],
    cloudModules: ['Test Raporu Arşivi & Kayıt Eşleştirme'],
  },
] as const;

export const ENGINEERING_TOOLPACK_CATALOG_EN: readonly EngineeringToolpackDefinitionDto[] = [
  {
    id: 'core',
    title: 'Core Telemetry & DBC Pack',
    shortBadge: 'CORE',
    category: 'Core Engine',
    description:
      'CAN / CAN-FD connections, fixed-row Rx/Tx table, chronological Trace, 60 FPS Oscilloscope, DBC Studio, and Live Cloud Bridge.',
    targetAudience: 'All CAN / CAN-FD engineering teams',
    alwaysEnabled: true,
    releaseStage: 'active',
    clientModules: [
      'Connections',
      'Rx / Tx',
      'Trace',
      'Plotter (60 FPS)',
      'DBC Studio',
      'Cloud Bridge',
    ],
    cloudModules: [
      'DBC Studio & Semantic Diff',
      'Live Monitoring Rooms',
      'Trace Replay & CSV/ASC Export',
    ],
  },
  {
    id: 'simulation_replay',
    title: 'Simulation, Virtual Panels & Replay Pack',
    shortBadge: 'SIM & REPLAY',
    category: 'Simulation & Virtual Testing',
    description:
      'Virtual gauges and OpenStreetMap/GNSS panels, advanced signal generators, button/slider/switch stimuli, and bus replay from recordings (Restbus Lite).',
    targetAudience: 'HIL bench, BMS/VCU desktop validation and field simulation',
    alwaysEnabled: false,
    releaseStage: 'active',
    clientModules: [
      'Simulation & Virtual Panels',
      'Advanced Button/Wave Stimuli',
      'ID-Filtered Restbus Replay & Vector .blf',
    ],
    cloudModules: [
      'Cloud Virtual Gauge & GNSS Studio',
      '.nexuspanel.json Synchronization',
    ],
  },
  {
    id: 'reverse_engineering',
    title: 'Discovery & Reverse-Engineering Pack',
    shortBadge: 'DISCOVERY',
    category: 'Discovery & Signal Decoding',
    description:
      'Idle baseline masking on undocumented CAN buses, 64-bit live bit change heatmap, and 1-click DBC Studio signal export.',
    targetAudience: 'Reverse engineering, aftermarket integration, and undocumented ECU analysis',
    alwaysEnabled: false,
    releaseStage: 'phase_2',
    clientModules: [
      'Baseline Idle Masking',
      '64-Bit Live Heatmap',
      '1-Click DBC Signal Discovery',
    ],
    cloudModules: ['Export Discovered Signal Drafts to DBC Studio'],
  },
  {
    id: 'automotive_diagnostics',
    title: 'Automotive Diagnostics Pack (ISO-TP / OBD-II / UDS)',
    shortBadge: 'UDS / OBD-II',
    category: 'Automotive Diagnostics',
    description:
      'ISO 15765-2 multi-frame defragmentation, standard OBD-II PID/DTC trouble code read/clear, and UDS (0x10, 0x19, 0x22, 0x3E) service console.',
    targetAudience: 'EV, passenger vehicle, and ECU software validation engineers',
    alwaysEnabled: false,
    releaseStage: 'phase_3',
    clientModules: [
      'ISO-TP Multi-Packet Engine',
      'OBD-II Live PID & DTC Display',
      'UDS Service Console',
    ],
    cloudModules: ['DID Dictionary (.json) Sync & Trouble Snapshots'],
  },
  {
    id: 'heavy_duty_j1939',
    title: 'Heavy-Duty & Defense Pack (SAE J1939)',
    shortBadge: 'J1939',
    category: 'Heavy-Duty & Defense',
    description:
      'Automatic Priority / PGN / Source Address parsing on 29-bit Extended IDs and BAM / TP.DT multi-packet defragmentation.',
    targetAudience: 'Truck, bus, agricultural, marine, generator, and defense platforms',
    alwaysEnabled: false,
    releaseStage: 'phase_3',
    clientModules: ['PGN / SA Column View', 'J1939-21 BAM / TP.DT Reassembler'],
    cloudModules: ['PGN Filtering in Trace Analysis'],
  },
  {
    id: 'robotics_canopen',
    title: 'Robotics & Industrial Motion Pack (CANopen)',
    shortBadge: 'CANOPEN',
    category: 'Robotics & Industrial',
    description:
      'Node ID based NMT state machine, Heartbeat (0x700+ID), EMCY emergency codes, and TPDO/RPDO/SDO dictionary traffic monitor.',
    targetAudience: 'Robotic actuators, AGV/AMR, and industrial servo drive developers',
    alwaysEnabled: false,
    releaseStage: 'phase_3',
    clientModules: ['Node ID State Table', 'NMT / Heartbeat / EMCY / SDO Inspector'],
    cloudModules: ['Node Drop & EMCY Timeline Markers'],
  },
  {
    id: 'hil_automation',
    title: 'Automated ECU Test Runner Pack',
    shortBadge: 'AUTO-TEST',
    category: 'Automation & Validation',
    description:
      'Step-by-step automated verification scenarios, limit/timing assertions, and automated PASS / FAIL engineering test report generation.',
    targetAudience: 'Quality verification, end-of-line (EOL), and HIL test engineers',
    alwaysEnabled: false,
    releaseStage: 'phase_3',
    clientModules: ['Scenario Runner', 'Local PASS / FAIL Assertion Engine'],
    cloudModules: ['Test Report Archive & Trace Linking'],
  },
] as const;

export function getLocalizedToolpackCatalog(
  locale: 'tr' | 'en',
): readonly EngineeringToolpackDefinitionDto[] {
  return locale === 'en' ? ENGINEERING_TOOLPACK_CATALOG_EN : ENGINEERING_TOOLPACK_CATALOG;
}

const VALID_TOOLPACK_IDS = new Set<EngineeringToolpackId>(
  ENGINEERING_TOOLPACK_CATALOG.map((item) => item.id),
);

export function normalizeEnabledToolpacks(
  raw: readonly (EngineeringToolpackId | string)[] | undefined | null,
): EngineeringToolpackId[] {
  const source = raw && raw.length > 0 ? raw : DEFAULT_ENABLED_TOOLPACKS;
  const set = new Set<EngineeringToolpackId>(['core']);
  for (const item of source) {
    if (typeof item === 'string' && VALID_TOOLPACK_IDS.has(item as EngineeringToolpackId)) {
      set.add(item as EngineeringToolpackId);
    }
  }
  return ENGINEERING_TOOLPACK_CATALOG.map((item) => item.id).filter((id) => set.has(id));
}

export function isToolpackEnabled(
  list: readonly EngineeringToolpackId[] | undefined | null,
  id: EngineeringToolpackId,
): boolean {
  if (id === 'core') return true;
  if (!list || list.length === 0) return false;
  return list.includes(id);
}
