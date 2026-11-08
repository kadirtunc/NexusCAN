/**
 * Shared PCAN-Explorer / CANoe-Style Virtual Instrument & Simulation Panel Contracts
 * 1:1 Portable between NexusCANCloud and NexusCAN Desktop Client (.nexusproj.json & REST API)
 */

export type SimulationWidgetKind =
  | 'gauge'
  | 'bar'
  | 'numeric'
  | 'led'
  | 'enum_badge'
  | 'graph'
  | 'map'
  | 'button'
  | 'checkbox'
  | 'combobox'
  | 'slider'
  | 'group';

export type SimulationMapTileStyle = 'osm_standard' | 'osm_dark' | 'osm_hot' | 'custom';

export type SimulationAccentColor = 'steel' | 'cyan' | 'emerald' | 'amber' | 'red' | 'blue';
export type SimulationLedOperator = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte';
export type SimulationWaveformKind = 'constant' | 'sine' | 'triangle' | 'sawtooth' | 'square';

export interface SimulationSignalBindingDto {
  busId: number;
  messageKey: string; // e.g. "STD:0x101" or "EXT:0x18FF50E5"
  messageName: string;
  arbId: number;
  isExtended: boolean;
  signalName: string; // Deterministic key across DBC reloads
  unit: string;
  min: number;
  max: number;
  factor: number;
  offset: number;
  decimals: number;
  color: string;
  databaseId?: string;
  databaseName?: string;
}

export interface SimulationWidgetLayoutDto {
  col: number; // 0..23 (24-column grid)
  row: number; // 0..399
  w: number;   // 1..24
  h: number;   // 1..48
}

export interface SimulationComboOptionDto {
  label: string;
  value: number;
}

export interface SimulationWidgetConfigDto {
  // Gauge / Bar / Slider shared bounds & zones
  min?: number;
  max?: number;
  step?: number;
  warnLow?: number | null;
  warnHigh?: number | null;
  critLow?: number | null;
  critHigh?: number | null;
  majorTicks?: number;
  showNeedle?: boolean;
  showDigital?: boolean;

  // Bar options
  orientation?: 'horizontal' | 'vertical';
  showPeakHold?: boolean;

  // Numeric options
  showRawHex?: boolean;
  fontSize?: 'sm' | 'md' | 'lg';

  // LED options
  ledOperator?: SimulationLedOperator;
  ledThreshold?: number;
  onLabel?: string;
  offLabel?: string;

  // Enum Badge options
  enumMap?: Record<string, string>;

  // Multi-trace Graph options
  extraBindings?: SimulationSignalBindingDto[];
  timeWindowSec?: number;
  autoScaleY?: boolean;
  showLegend?: boolean;

  // OpenStreetMap / GNSS Map options (primary `widget.binding` = Latitude)
  lonBinding?: SimulationSignalBindingDto | null;
  headingBinding?: SimulationSignalBindingDto | null;
  speedBinding?: SimulationSignalBindingDto | null;
  mapZoom?: number;
  mapCenterLat?: number;
  mapCenterLon?: number;
  mapTileStyle?: SimulationMapTileStyle;
  mapCustomTileUrl?: string;
  mapAutoFollow?: boolean;
  mapShowTrail?: boolean;
  mapTrailMaxPoints?: number;
  mapClickToSimulate?: boolean;

  // Interactive Button options
  buttonMode?: 'momentary' | 'toggle';
  pressValue?: number;
  releaseValue?: number;
  buttonLabel?: string;

  // Interactive Checkbox options
  checkedValue?: number;
  uncheckedValue?: number;
  checkLabel?: string;

  // Interactive ComboBox options
  options?: SimulationComboOptionDto[];

  // Slider options
  showNumericInput?: boolean;

  // Desktop-only periodic TX interval hint (0 = on-change / manual)
  txCycleMs?: number;

  // Group Frame options
  subtitle?: string;
}

export interface SimulationWidgetDto {
  id: string;
  kind: SimulationWidgetKind;
  title: string;
  accentColor: SimulationAccentColor;
  layout: SimulationWidgetLayoutDto;
  binding: SimulationSignalBindingDto | null;
  config: SimulationWidgetConfigDto;
}

export interface SimulationGeneratorSpecDto {
  id: string;
  enabled: boolean;
  binding: SimulationSignalBindingDto;
  waveform: SimulationWaveformKind;
  min: number;
  max: number;
  constantValue: number;
  frequencyHz: number;
}

export interface SimulationPanelDto {
  id: string;
  projectId?: string;
  name: string;
  description: string;
  gridCols: number;     // default 24
  rowHeightPx: number;  // default 42
  targetDatabaseId: string | null;
  widgets: SimulationWidgetDto[];
  generators: SimulationGeneratorSpecDto[];
  createdAt: string;
  updatedAt: string;
}

export interface NexusSimulationPanelFileV1 {
  schemaVersion: 1;
  exportedAt: string;
  panel: SimulationPanelDto;
}

export type NexusSimulationPanelFileV1Dto = NexusSimulationPanelFileV1;

/**
 * Shared Database & Project Summary Adapter DTOs (1:1 with NexusCANCloud `@/contracts`)
 */
export interface DatabaseVersionDto {
  id: string;
  databaseId: string;
  projectId: string;
  versionLabel: string;
  versionNumber: number;
  fileName: string;
  format: 'dbc' | 'kcd';
  sha256Hash: string;
  sizeBytes: number;
  messageCount: number;
  signalCount: number;
  ecuCount: number;
  releaseNotes: string | null;
  uploadedByName: string;
  createdAt: string;
}

export interface NetworkDatabaseSummaryDto {
  id: string;
  projectId: string;
  name: string;
  slug: string;
  format: 'dbc' | 'kcd';
  description: string | null;
  busAssignment: string;
  latestVersion: DatabaseVersionDto;
  versionCount: number;
}

export interface CloudProjectDto {
  id: string;
  orgId: string;
  name: string;
  slug: string;
  code: string;
  description: string;
  vehiclePlatform: string;
  defaultProtocol: 'CAN' | 'CAN_FD' | 'J1939';
  databaseCount: number;
  activeVersionLabel: string;
  sessionCount: number;
  onlineDeviceCount: number;
  panelCount?: number;
  latestRevisionNumber?: number | null;
  hasWorkspace?: boolean;
  updatedAt: string;
}
