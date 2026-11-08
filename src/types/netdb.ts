export type DiagnosticSeverity = 'warning' | 'error' | 'info';

export interface ParseDiagnosticDto {
  severity: DiagnosticSeverity;
  code: string;
  message: string;
  line: number | null;
  column: number | null;
  context: string | null;
}

export interface DatabaseInfoDto {
  name: string;
  version: string | null;
  format: string;
  sourceEncoding: string;
  messageCount: number;
  signalCount: number;
  diagnostics: ParseDiagnosticDto[];
}

export interface EcuNodeDto {
  name: string;
  comment: string | null;
  txMessageKeys: string[];
  rxMessageKeys: string[];
}

export interface BitCellDto {
  byteIndex: number;
  bitInByte: number;
  signalId: number;
  signalBitIndex: number;
  isMsb: boolean;
  isLsb: boolean;
  isMuxSwitch: boolean;
  isMultiplexed: boolean;
  switchSignalId: number | null;
  muxRanges: [number, number][];
}

export interface MessageSchemaDto {
  messageKey: string; // e.g. "STD:0x101" or "EXT:0x18FF50E5"
  arbId: number;
  isExtended: boolean;
  protocol: string; // "CAN" | "CAN_FD" | "J1939"
  name: string;
  dlc: number;
  transmitters: string[];
  expectedCycleMs: number | null;
  comment: string | null;
  signalIds: number[];
  bitLayout: BitCellDto[];
  isMultiplexed: boolean;
  masterSwitchId: number | null;
}

export interface SignalSchemaDto {
  signalId: number; // Dense 0..N index: signals[signalId].signalId === signalId!
  messageKey: string;
  name: string;
  longName: string | null;
  startBit: number;
  bitLength: number;
  byteOrder: 'littleEndian' | 'bigEndian';
  valueType: 'unsigned' | 'signed' | 'float32' | 'float64';
  factor: number;
  offset: number;
  min: number;
  max: number;
  unit: string;
  receivers: string[];
  comment: string | null;
  muxRole: 'static' | 'masterSwitch' | 'multiplexed';
  switchSignalId: number | null;
  muxRanges: [number, number][];
  enumTable: Record<string, string>;
  initialValue: number | null;
}

export interface DatabaseSchemaDto {
  info: DatabaseInfoDto;
  ecus: EcuNodeDto[];
  messages: MessageSchemaDto[];
  signals: SignalSchemaDto[];
}
