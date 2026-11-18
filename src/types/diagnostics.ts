import type {
  AddressFormat,
  DiagErrorCode,
  DtcEntryDto as BackendDtcEntryDto,
  UdsAddressing,
  UdsResponseDto,
} from './udsClient';

export type UdsSessionType = 'default' | 'extended' | 'programming';
export type DiagProtocol = 'obd2' | 'uds';
export type IsoTpFrameType = 'SF' | 'FF' | 'CF' | 'FC' | 'UNK';

/** HMI session config; structurally a `DiagSessionConfigDto` (optional D-003 fields mirrored 1:1). */
export interface DiagSessionConfig {
  requestId: number;
  responseId: number;
  busId: number;
  isExtendedId: boolean;
  protocol: DiagProtocol;
  /** Functional request id (e.g. 0x7DF); `null`/absent = physical addressing only. */
  functionalId?: number | null;
  useFd?: boolean;
  /** ISO-TP padding byte, `null` = no padding, absent = backend default (0xAA). */
  padding?: number | null;
  /** Added to the ECU-reported P2 (ms); absent = backend default (100). */
  p2MarginMs?: number;
  /** ISO 15765-2 address format; absent = 'normal'. */
  addressFormat?: AddressFormat;
  targetAddress?: number | null;
  responseAddress?: number | null;
}

export interface DiagSessionState {
  connected: boolean;
  config: DiagSessionConfig;
  udsSession: UdsSessionType;
  testerPresentActive: boolean;
  lastResponseMs: number | null;
}

export type DtcEntryDto = BackendDtcEntryDto;

/** Error surfaced to the HMI: a backend `[diag:<code>]` error or a transport-level condition. */
export interface DiagUiError {
  code: DiagErrorCode | 'not_connected' | 'backend_missing' | 'duplicate_session' | 'unknown';
  message: string;
}

/** Last raw UDS request/response pair shown by the UDS console. */
export interface UdsExchange {
  id: number;
  atMs: number;
  requestBytes: number[];
  addressing: UdsAddressing;
  response: UdsResponseDto | null;
  error: DiagUiError | null;
}

export interface PidDefinition {
  pid: number;
  name: string;
  unit: string;
  min: number;
  max: number;
  bytes: number;
  formula: (b: number[]) => number;
  formatValue: (v: number) => string;
}

export interface LivePidValue {
  pid: number;
  rawValue: number;
  physicalValue: number;
  timestampMs: number;
}

/** Per-PID failure of the real OBD-II poll; the last good value (if any) stays in `livePidValues` and is shown stale. */
export type LivePidError =
  | { kind: 'nrc'; nrc: number | null; nrcName: string | null; atMs: number }
  | { kind: 'badResponse'; atMs: number }
  | { kind: 'transport'; error: DiagUiError; atMs: number };

export interface UdsServiceDef {
  sid: number;
  name: string;
  description: string;
  hasSubFunction: boolean;
  defaultSubFunction?: number;
  defaultData?: string;
}

export interface DidDefinition {
  did: number;
  name: string;
  description: string;
}

export interface DidValueEntry {
  did: number;
  raw: number[];
  decoded: string;
  timestampMs: number;
}

export interface DiagHistoryEntry {
  id: string;
  timestampMs: number;
  direction: 'tx' | 'rx' | 'info' | 'error';
  serviceId: number;
  subFunction: number | null;
  rawBytes: number[];
  description: string;
  latencyMs?: number;
}

export interface IsoTpFrameEntry {
  id: string;
  /** Monotonic store-local id (never reused, even across seq epochs). */
  uid: number;
  /** Backend ISO-TP tap seq (restarts at 1 per backend session; see `epoch`). */
  seq: number;
  /** Seq epoch: incremented whenever the backend session was reopened (seq restarted). */
  epoch: number;
  /** Conversation seq of the owning Request/KeepaliveSent event; null = outside any exchange. */
  requestSeq: number | null;
  timestampMs: number;
  canId: number;
  isExtended: boolean;
  frameType: IsoTpFrameType;
  rawBytes: number[];
  description: string;
  assembledPayload?: number[];
  /** Real frames only: backend direction and HAL timestamp (µs; epoch or monotonic). */
  direction?: 'tx' | 'rx';
  timestampUs?: number;
}

export const PID_CATALOG: PidDefinition[] = [
  {
    pid: 0x04,
    name: 'Engine Load',
    unit: '%',
    min: 0,
    max: 100,
    bytes: 1,
    formula: (b) => b[0] / 2.55,
    formatValue: (v) => v.toFixed(1),
  },
  {
    pid: 0x05,
    name: 'Coolant Temp',
    unit: '°C',
    min: -40,
    max: 215,
    bytes: 1,
    formula: (b) => b[0] - 40,
    formatValue: (v) => v.toFixed(0),
  },
  {
    pid: 0x0c,
    name: 'Engine RPM',
    unit: 'rpm',
    min: 0,
    max: 16383,
    bytes: 2,
    formula: (b) => (256 * b[0] + b[1]) / 4,
    formatValue: (v) => v.toFixed(0),
  },
  {
    pid: 0x0d,
    name: 'Vehicle Speed',
    unit: 'km/h',
    min: 0,
    max: 255,
    bytes: 1,
    formula: (b) => b[0],
    formatValue: (v) => v.toFixed(0),
  },
  {
    pid: 0x0f,
    name: 'Intake Air Temp',
    unit: '°C',
    min: -40,
    max: 215,
    bytes: 1,
    formula: (b) => b[0] - 40,
    formatValue: (v) => v.toFixed(0),
  },
  {
    pid: 0x10,
    name: 'MAF Air Flow',
    unit: 'g/s',
    min: 0,
    max: 655,
    bytes: 2,
    formula: (b) => (256 * b[0] + b[1]) / 100,
    formatValue: (v) => v.toFixed(2),
  },
  {
    pid: 0x11,
    name: 'Throttle Position',
    unit: '%',
    min: 0,
    max: 100,
    bytes: 1,
    formula: (b) => b[0] / 2.55,
    formatValue: (v) => v.toFixed(1),
  },
  {
    pid: 0x2f,
    name: 'Fuel Tank Level',
    unit: '%',
    min: 0,
    max: 100,
    bytes: 1,
    formula: (b) => b[0] / 2.55,
    formatValue: (v) => v.toFixed(1),
  },
  {
    pid: 0x33,
    name: 'Barometric Pressure',
    unit: 'kPa',
    min: 0,
    max: 255,
    bytes: 1,
    formula: (b) => b[0],
    formatValue: (v) => v.toFixed(0),
  },
  {
    pid: 0x42,
    name: 'Control Module Voltage',
    unit: 'V',
    min: 0,
    max: 65,
    bytes: 2,
    formula: (b) => (256 * b[0] + b[1]) / 1000,
    formatValue: (v) => v.toFixed(3),
  },
  {
    pid: 0x46,
    name: 'Ambient Air Temp',
    unit: '°C',
    min: -40,
    max: 215,
    bytes: 1,
    formula: (b) => b[0] - 40,
    formatValue: (v) => v.toFixed(0),
  },
  {
    pid: 0x5c,
    name: 'Engine Oil Temp',
    unit: '°C',
    min: -40,
    max: 215,
    bytes: 1,
    formula: (b) => b[0] - 40,
    formatValue: (v) => v.toFixed(0),
  },
];

export const UDS_SERVICES: UdsServiceDef[] = [
  {
    sid: 0x10,
    name: 'DiagnosticSessionControl',
    description: 'Switch between Default, Extended, and Programming sessions',
    hasSubFunction: true,
    defaultSubFunction: 0x01,
  },
  {
    sid: 0x11,
    name: 'ECUReset',
    description: 'Reset the ECU (Hard, Soft, or Key-Off/On)',
    hasSubFunction: true,
    defaultSubFunction: 0x01,
  },
  {
    sid: 0x14,
    name: 'ClearDiagnosticInformation',
    description: 'Clear stored and pending DTCs from ECU memory',
    hasSubFunction: false,
    defaultData: 'FF FF FF',
  },
  {
    sid: 0x19,
    name: 'ReadDTCInformation',
    description: 'Read DTC status, snapshot records, and extended data',
    hasSubFunction: true,
    defaultSubFunction: 0x02,
  },
  {
    sid: 0x22,
    name: 'ReadDataByIdentifier',
    description: 'Read a data record identified by a 2-byte DID',
    hasSubFunction: false,
    defaultData: 'F1 90',
  },
  {
    sid: 0x27,
    name: 'SecurityAccess',
    description: 'Unlock ECU security levels for privileged services',
    hasSubFunction: true,
    defaultSubFunction: 0x01,
  },
  {
    sid: 0x2e,
    name: 'WriteDataByIdentifier',
    description: 'Write a data record to an ECU DID (requires security access)',
    hasSubFunction: false,
    defaultData: 'F1 90',
  },
  {
    sid: 0x3e,
    name: 'TesterPresent',
    description: 'Keep the diagnostic session alive (suppress timeout)',
    hasSubFunction: true,
    defaultSubFunction: 0x00,
  },
  {
    sid: 0x85,
    name: 'ControlDTCSetting',
    description: 'Enable or disable DTC storage (sub-function: 01=on, 02=off)',
    hasSubFunction: true,
    defaultSubFunction: 0x01,
  },
  {
    sid: 0x23,
    name: 'ReadMemoryByAddress',
    description: 'Read a block of raw memory from the ECU at a specified address and length',
    hasSubFunction: false,
    defaultData: '04 08 00 00 00 10',
  },
  {
    sid: 0x24,
    name: 'ReadScalingDataByIdentifier',
    description: 'Read the scaling (unit/formula) information associated with a DID',
    hasSubFunction: false,
    defaultData: 'F1 90',
  },
  {
    sid: 0x28,
    name: 'CommunicationControl',
    description: 'Enable or disable transmission and/or reception of certain messages (sub-function: 00=enable, 01=disableTx, 02=disableRx, 03=disableTxRx)',
    hasSubFunction: true,
    defaultSubFunction: 0x03,
  },
  {
    sid: 0x2a,
    name: 'ReadDataByPeriodicIdentifier',
    description: 'Request periodic transmission of data records identified by one or more periodic DIDs',
    hasSubFunction: true,
    defaultSubFunction: 0x01,
  },
  {
    sid: 0x2c,
    name: 'DynamicallyDefineDataIdentifier',
    description: 'Build a composite DID dynamically from other DIDs or memory addresses',
    hasSubFunction: true,
    defaultSubFunction: 0x01,
  },
  {
    sid: 0x2f,
    name: 'InputOutputControlByIdentifier',
    description: 'Override or return control of an ECU input/output identified by a DID',
    hasSubFunction: false,
    defaultData: '30 01 03 00',
  },
  {
    sid: 0x31,
    name: 'RoutineControl',
    description: 'Start, stop, or request results of an ECU routine (sub-function: 01=start, 02=stop, 03=requestResult)',
    hasSubFunction: true,
    defaultSubFunction: 0x01,
    defaultData: 'FF 00',
  },
  {
    sid: 0x34,
    name: 'RequestDownload',
    description: 'Initiate a data download (flash programming) session to the ECU',
    hasSubFunction: false,
    defaultData: '00 44 08 00 00 00 24 00 01 00 00',
  },
  {
    sid: 0x35,
    name: 'RequestUpload',
    description: 'Initiate a data upload session from the ECU',
    hasSubFunction: false,
    defaultData: '00 44 08 00 00 00 24 00 01 00 00',
  },
  {
    sid: 0x36,
    name: 'TransferData',
    description: 'Transfer a block of data to or from the ECU during an active download/upload',
    hasSubFunction: false,
    defaultData: '01',
  },
  {
    sid: 0x37,
    name: 'RequestTransferExit',
    description: 'Terminate an active data transfer session and verify integrity',
    hasSubFunction: false,
    defaultData: '',
  },
  {
    sid: 0x38,
    name: 'RequestFileTransfer',
    description: 'Request transfer of a named file to or from the ECU file system',
    hasSubFunction: false,
    defaultData: '01 0B 46 57 2E 62 69 6E 00 44 00',
  },
  {
    sid: 0x3d,
    name: 'WriteMemoryByAddress',
    description: 'Write raw bytes directly into ECU memory at a specified address',
    hasSubFunction: false,
    defaultData: '44 08 00 00 00 10 00 01',
  },
  {
    sid: 0x83,
    name: 'AccessTimingParameter',
    description: 'Read or modify P2/P2* timing parameters for the active diagnostic session',
    hasSubFunction: true,
    defaultSubFunction: 0x01,
  },
  {
    sid: 0x84,
    name: 'SecuredDataTransmission',
    description: 'Transmit data protected by a cryptographic security layer',
    hasSubFunction: false,
    defaultData: '00',
  },
  {
    sid: 0x87,
    name: 'LinkControl',
    description: 'Control the communication baud rate on the diagnostic link (sub-function: 01=verifyBaudRate, 02=transitionBaudRate)',
    hasSubFunction: true,
    defaultSubFunction: 0x01,
  },
];

/**
 * ISO 14229-1 Annex C standardized identification DIDs (F180–F19F). The DID MEANING is standardized;
 * the VALUE comes from the ECU, support is optional (unsupported → NRC 0x31) and some byte layouts
 * (e.g. dates) are not fixed by the standard. Manufacturer ranges (F1A0–F1EF, F1F0–F1FF, …) are ECU-specific.
 */
export const DID_CATALOG: DidDefinition[] = [
  { did: 0xf180, name: 'BootSoftwareIdentification', description: 'Boot software identification (number of modules + module IDs)' },
  { did: 0xf181, name: 'ApplicationSoftwareIdentification', description: 'Application software identification' },
  { did: 0xf182, name: 'ApplicationDataIdentification', description: 'Application data (calibration) identification' },
  { did: 0xf183, name: 'BootSoftwareFingerprint', description: 'Fingerprint of the last boot software download (tester / date)' },
  { did: 0xf184, name: 'ApplicationSoftwareFingerprint', description: 'Fingerprint of the last application software download' },
  { did: 0xf185, name: 'ApplicationDataFingerprint', description: 'Fingerprint of the last application data download' },
  { did: 0xf186, name: 'ActiveDiagnosticSession', description: 'Currently active UDS diagnostic session' },
  { did: 0xf187, name: 'VehicleManufacturerSparePartNumber', description: 'Spare part number assigned by the vehicle manufacturer' },
  { did: 0xf188, name: 'VehicleManufacturerECUSoftwareNumber', description: 'ECU software number assigned by the vehicle manufacturer' },
  { did: 0xf189, name: 'VehicleManufacturerECUSoftwareVersionNumber', description: 'ECU software version number assigned by the vehicle manufacturer' },
  { did: 0xf18a, name: 'SystemSupplierIdentifier', description: 'Identifier of the system supplier' },
  { did: 0xf18b, name: 'ECUManufacturingDate', description: 'ECU manufacturing date (byte layout not fixed by ISO 14229; BCD YYMMDD is common)' },
  { did: 0xf18c, name: 'ECUSerialNumber', description: 'ECU serial number' },
  { did: 0xf18d, name: 'SupportedFunctionalUnits', description: 'Functional units supported by the ECU' },
  { did: 0xf18e, name: 'VehicleManufacturerKitAssemblyPartNumber', description: 'Kit assembly part number assigned by the vehicle manufacturer' },
  { did: 0xf190, name: 'VIN', description: 'Vehicle Identification Number (17 ASCII characters)' },
  { did: 0xf191, name: 'VehicleManufacturerECUHardwareNumber', description: 'ECU hardware number assigned by the vehicle manufacturer' },
  { did: 0xf192, name: 'SystemSupplierECUHardwareNumber', description: 'ECU hardware number assigned by the system supplier' },
  { did: 0xf193, name: 'SystemSupplierECUHardwareVersionNumber', description: 'ECU hardware version number assigned by the system supplier' },
  { did: 0xf194, name: 'SystemSupplierECUSoftwareNumber', description: 'ECU software number assigned by the system supplier' },
  { did: 0xf195, name: 'SystemSupplierECUSoftwareVersionNumber', description: 'ECU software version number assigned by the system supplier' },
  { did: 0xf196, name: 'ExhaustRegulationOrTypeApprovalNumber', description: 'Exhaust regulation / type approval number' },
  { did: 0xf197, name: 'SystemNameOrEngineType', description: 'System name or engine type' },
  { did: 0xf198, name: 'RepairShopCodeOrTesterSerialNumber', description: 'Repair shop code or serial number of the tester that last wrote the ECU' },
  { did: 0xf199, name: 'ProgrammingDate', description: 'Date of the last ECU programming (byte layout not fixed; BCD is common)' },
  { did: 0xf19a, name: 'CalibrationRepairShopCodeOrEquipmentSerialNumber', description: 'Repair shop code / serial number of the calibration equipment' },
  { did: 0xf19b, name: 'CalibrationDate', description: 'Date of the last calibration (byte layout not fixed; BCD is common)' },
  { did: 0xf19c, name: 'CalibrationEquipmentSoftwareNumber', description: 'Software number of the calibration equipment' },
  { did: 0xf19d, name: 'ECUInstallationDate', description: 'Date the ECU was installed in the vehicle (byte layout not fixed; BCD is common)' },
  { did: 0xf19e, name: 'ODXFile', description: 'Name of the ODX file describing the ECU diagnostics' },
  { did: 0xf19f, name: 'Entity', description: 'Entity identifier' },
];
