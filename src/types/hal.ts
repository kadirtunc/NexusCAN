export type DriverFamilyId =
  | 'mock'
  | 'socketcan'
  | 'slcan'
  | 'pcan'
  | 'kvaser'
  | 'gs_usb';

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
  mockFpsPreset: number | null;
  driverFamily?: string | null; // 'mock' | 'socketcan' | 'slcan' | 'pcan' | 'kvaser' | 'gs_usb'
  serialPort?: string | null; // e.g. 'COM3', '/dev/ttyUSB0', '/dev/ttyACM0'
  serialBaudRate?: number | null; // e.g. 115200, 230400, 460800, 921600, 1000000, 2000000
  serialDtrRts?: boolean | null; // USB-CDC DTR/RTS assertion
  adapterChannel?: string | null; // e.g. 'PCAN_USBBUS1', '0', 'can0', 'vcan0'
}

export type BusStateKind = 'active' | 'warning' | 'passive' | 'busOff' | 'disconnected';

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
}

export interface SerialPortInfoDto {
  portName: string;
  portType: string;
  vidPid: string | null;
  manufacturer: string | null;
  product: string | null;
}

export interface DriverFamilyStatusDto {
  familyId: string; // 'mock' | 'socketcan' | 'slcan' | 'pcan' | 'kvaser' | 'gs_usb'
  displayName: string;
  installed: boolean;
  statusLabel: string;
  detectedLibraryOrModule: string | null;
  searchedPaths: string[];
  detectedChannels: string[];
  installHint: string;
}

export interface DriverProbeReportDto {
  hostOs: string;
  checkedAtMs: number;
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
