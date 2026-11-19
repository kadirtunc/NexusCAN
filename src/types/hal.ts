export type DriverFamilyId =
  | 'mock'
  | 'socketcan'
  | 'slcan'
  | 'pcan'
  | 'kvaser'
  | 'gs_usb'
  | 'vector_xl';

export interface AdapterCapabilitiesDto {
  supportsFd: boolean;
  supportsListenOnly: boolean;
  supportsHwTimestamps: boolean;
  maxBitrate: number;
  isVirtual: boolean;
}

export interface DeviceDescriptorDto {
  deviceId: string;
  driverId: string;
  channelName: string;
  displayName: string;
  capabilities: AdapterCapabilitiesDto;
}

export interface ChannelConfigDto {
  busId: number;
  bitrate: number;
  dataBitrate: number;
  enableFd: boolean;
  listenOnly: boolean; // MUST default to true in UI!
  /** Opt-in fail-closed: refuse to connect when hardware Listen-Only cannot be enforced (physical adapters only). */
  requireHardwareListenOnly?: boolean;
  mockFpsPreset: number | null;
  driverFamily?: string | null; // 'mock' | 'socketcan' | 'slcan' | 'pcan' | 'kvaser' | 'gs_usb' | 'vector_xl'
  serialPort?: string | null; // e.g. 'COM3', '/dev/ttyUSB0', '/dev/ttyACM0', '/dev/cu.usbmodem...'
  serialBaudRate?: number | null; // e.g. 115200, 230400, 460800, 921600, 1000000, 2000000
  serialDtrRts?: boolean | null; // USB-CDC DTR/RTS assertion
  adapterChannel?: string | null; // e.g. 'PCAN_USBBUS1', '0', 'can0', 'vcan0'
}

export type BusStateKind = 'active' | 'warning' | 'passive' | 'busOff' | 'disconnected';

/** How Listen-Only is enforced on a bus (backend `listen_only_enforcement`). */
export type ListenOnlyEnforcementKind = 'hardware' | 'softwareOnly' | 'virtual';

export interface BusHealthDto {
  busId: number;
  deviceId: string;
  channelName: string;
  connected: boolean;
  listenOnly: boolean;
  txArmed: boolean;
  busState: BusStateKind;
  txErrorCount: number;
  rxErrorCount: number;
  /** `null` when the backend did not report it (older build / not connected). */
  listenOnlyEnforcement?: ListenOnlyEnforcementKind | null;
}

export interface SerialPortInfoDto {
  portName: string;
  portType: string;
  vidPid: string | null;
  manufacturer: string | null;
  product: string | null;
  serialNumber?: string | null;
  osHint?: string | null;
}

export interface HostEnvironmentDto {
  os: string; // 'linux' | 'windows' | 'macos'
  arch: string; // 'x86_64' | 'aarch64'
  osRelease: string;
  isWsl: boolean;
  udevRulesPresent: boolean;
  serialPermissionHint: string | null;
  nativeStacks: string[];
  osNotes: string[];
}

export interface UsbCanDeviceDto {
  vidPid: string;
  vendorName: string;
  productName: string;
  serialNumber: string | null;
  busNumber: number;
  deviceAddress: number;
  matchedFamily: string; // 'gs_usb' | 'pcan' | 'kvaser' | 'vector_xl' | 'slcan' | 'dfu_bootloader'
  driverBound: boolean;
  accessStatus: string;
  suggestedChannel: string | null;
  locationInfo?: string | null;
}

export interface DetectedChannelDetailDto {
  channelId: string;
  deviceId: string;
  label: string;
  state: string; // 'up' | 'down' | 'ready' | 'busy' | 'needs_driver' | 'virtual'
  supportsFd: boolean;
  mtu: number | null;
  kernelOrUsbDriver: string | null;
  sourcePath: string;
  hardwareId: string | null;
  hintCommand: string | null;
}

export interface OsSetupStepDto {
  title: string;
  description: string;
  commandOrAction: string | null;
  docUrl: string | null;
}

export interface DriverFamilyStatusDto {
  familyId: string;
  displayName: string;
  installed: boolean;
  osSupported?: boolean;
  hardwarePresent?: boolean;
  statusLabel: string;
  detectedLibraryOrModule: string | null;
  architectureNote?: string | null;
  searchedPaths: string[];
  osSourceLocations?: string[];
  detectedChannels: string[];
  channelDetails?: DetectedChannelDetailDto[];
  setupSteps?: OsSetupStepDto[];
  installHint: string;
}

export interface DriverProbeReportDto {
  hostOs: string;
  checkedAtMs: number;
  hostEnv?: HostEnvironmentDto;
  usbDevices?: UsbCanDeviceDto[];
  families: DriverFamilyStatusDto[];
  serialPorts: SerialPortInfoDto[];
}

export interface ProjectSummaryDto {
  fileStem: string;
  name: string;
  updatedAt: string;
  sizeBytes: number;
}

export interface DbFileInputDto {
  fileName: string;
  contentBase64: string;
}

export interface HardwareWatchEventDto {
  reason: string; // 'initial' | 'usb_hotplug' | 'topology_poll'
  timestampMs: number;
  devices: DeviceDescriptorDto[];
  report: DriverProbeReportDto;
}

export type DebugSeverity = 'info' | 'success' | 'warn' | 'error' | 'safety';

export type DebugCategory =
  | 'CONN'
  | 'SAFETY'
  | 'TX'
  | 'NETDB'
  | 'TRACE'
  | 'BUS_ERR'
  | 'DIAG'
  | 'WORKBENCH'
  | 'RE';

export type DebugEventSource = 'backend' | 'ui' | 'os' | 'protocol';

export interface DebugEventDto {
  seq: number;
  timestampMs: number;
  monotonicUs: number;
  severity: DebugSeverity;
  category: DebugCategory;
  source: DebugEventSource;
  busId: number | null;
  action: string;
  title: string;
  details: string | null;
  repeatCount: number;
}

export interface AppendDebugEventInputDto {
  severity: DebugSeverity;
  category: DebugCategory;
  source?: DebugEventSource | null;
  busId?: number | null;
  action: string;
  title: string;
  details?: string | null;
}

export interface DebugWindowStateDto {
  detachedOpen: boolean;
  alwaysOnTop: boolean;
  reDockRequested: boolean;
  sessionLogPath: string | null;
}

export interface DebugEventBatchDto {
  kind: 'snapshot' | 'append' | 'cleared' | 'windowState';
  events: DebugEventDto[];
  totalBuffered?: number;
  windowState?: DebugWindowStateDto;
}
