/**
 * ReadDTCInformation (0x19) report types and the request-parameter builder for
 * `cmd_diag_read_dtc_report`. Pure (no React): callers localize via `nameKey` and the error codes.
 */
import type { TranslationKey } from '../../i18n';

/** Parameter layout per reportType (bytes AFTER the sub-function). */
export type DtcParamKind = 'none' | 'statusMask' | 'severityAndMask' | 'dtcAndRecord';

export interface DtcReportType {
  sub: number;
  nameKey: TranslationKey;
  params: DtcParamKind;
}

export const DTC_REPORT_TYPES: readonly DtcReportType[] = [
  { sub: 0x01, nameKey: 'diag.dtcReport.type.01', params: 'statusMask' },
  { sub: 0x02, nameKey: 'diag.dtcReport.type.02', params: 'statusMask' },
  { sub: 0x03, nameKey: 'diag.dtcReport.type.03', params: 'none' },
  { sub: 0x04, nameKey: 'diag.dtcReport.type.04', params: 'dtcAndRecord' },
  { sub: 0x06, nameKey: 'diag.dtcReport.type.06', params: 'dtcAndRecord' },
  { sub: 0x07, nameKey: 'diag.dtcReport.type.07', params: 'severityAndMask' },
  { sub: 0x0a, nameKey: 'diag.dtcReport.type.0A', params: 'none' },
  { sub: 0x0f, nameKey: 'diag.dtcReport.type.0F', params: 'statusMask' },
  { sub: 0x11, nameKey: 'diag.dtcReport.type.11', params: 'statusMask' },
  { sub: 0x12, nameKey: 'diag.dtcReport.type.12', params: 'statusMask' },
  { sub: 0x13, nameKey: 'diag.dtcReport.type.13', params: 'statusMask' },
  { sub: 0x15, nameKey: 'diag.dtcReport.type.15', params: 'none' },
];

export function findDtcReportType(sub: number): DtcReportType | null {
  return DTC_REPORT_TYPES.find((r) => r.sub === sub) ?? null;
}

export interface DtcParamInput {
  /** Status mask (hex byte), default 'FF'. */
  statusMask: string;
  /** Severity mask (hex byte), only for 0x07. */
  severityMask: string;
  /** DTC number (up to 6 hex digits = 3 bytes), only for 0x04 / 0x06. */
  dtc: string;
  /** DTC record number (hex byte, FF = all records), only for 0x04 / 0x06. */
  record: string;
}

export const DEFAULT_DTC_PARAM_INPUT: DtcParamInput = { statusMask: 'FF', severityMask: 'FF', dtc: '', record: 'FF' };

export type DtcParamField = 'statusMask' | 'severityMask' | 'dtc' | 'record';

export type DtcParamBuild = { ok: true; params: number[] } | { ok: false; field: DtcParamField };

function hexByte(text: string): number | null {
  const clean = text.trim().replace(/^0x/i, '');
  return /^[0-9a-fA-F]{1,2}$/.test(clean) ? parseInt(clean, 16) : null;
}

function hexDtc(text: string): number | null {
  const clean = text.trim().replace(/^0x/i, '');
  return /^[0-9a-fA-F]{1,6}$/.test(clean) ? parseInt(clean, 16) : null;
}

/**
 * Parameter bytes for `sub`: 1 byte status mask (01 02 0F 11 12 13), severity + status mask (07),
 * DTC (3 bytes, big endian) + record number (04 06), none (03 0A 15). `null` = unsupported reportType.
 */
export function buildDtcReportParams(sub: number, input: DtcParamInput): DtcParamBuild | null {
  const type = findDtcReportType(sub);
  if (type === null) return null;
  switch (type.params) {
    case 'none':
      return { ok: true, params: [] };
    case 'statusMask': {
      const mask = hexByte(input.statusMask);
      return mask === null ? { ok: false, field: 'statusMask' } : { ok: true, params: [mask] };
    }
    case 'severityAndMask': {
      const sev = hexByte(input.severityMask);
      if (sev === null) return { ok: false, field: 'severityMask' };
      const mask = hexByte(input.statusMask);
      return mask === null ? { ok: false, field: 'statusMask' } : { ok: true, params: [sev, mask] };
    }
    case 'dtcAndRecord': {
      const dtc = hexDtc(input.dtc);
      if (dtc === null) return { ok: false, field: 'dtc' };
      const rec = hexByte(input.record);
      if (rec === null) return { ok: false, field: 'record' };
      return { ok: true, params: [(dtc >> 16) & 0xff, (dtc >> 8) & 0xff, dtc & 0xff, rec] };
    }
  }
}
