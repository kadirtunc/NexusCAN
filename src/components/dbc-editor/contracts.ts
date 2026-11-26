/**
 * Local contract barrel for the DBC editor. Desktop netdb DTOs are re-exported from `src/types/netdb.ts`;
 * editor-only DTOs (not part of the Rust IPC contract) are defined here as plain TS types.
 */
import type { SignalSchemaDto } from '../../types/netdb';

export type {
  BitCellDto,
  DatabaseSchemaDto,
  EcuNodeDto,
  MessageSchemaDto,
  ParseDiagnosticDto,
  SignalSchemaDto,
} from '../../types/netdb';

export {
  VALID_CAN_DLC_BYTES,
  VALID_CAN_FD_DLC_BYTES,
  computePhysicalMinMaxFromEncoding,
  createStarterDbcSchema,
  formatCanMessageKey,
  sanitizeDbcIdentifier,
  serializeDatabaseSchemaToDbc,
  type ReusableValueTableDto,
} from './dbcSerializer';

export type ByteOrderKind = SignalSchemaDto['byteOrder'];
export type SignalValueTypeKind = SignalSchemaDto['valueType'];
export type MuxRoleKind = SignalSchemaDto['muxRole'];

/** Two signals claiming the same bit of a message (derived locally from the compiled bit layout). */
export interface BitOverlapDiagnosticDto {
  messageKey: string;
  messageName: string;
  byteIndex: number;
  bitInByte: number;
  signalNames: string[];
  description: string;
}

/** Legacy Cloud version-history row; desktop has no version history (kept for prop compatibility). */
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
