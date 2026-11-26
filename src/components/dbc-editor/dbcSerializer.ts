import type {
  DatabaseSchemaDto,
  EcuNodeDto,
  MessageSchemaDto,
  SignalSchemaDto,
} from '../../types/netdb';

type SignalValueTypeKind = SignalSchemaDto['valueType'];

/**
 * Valid CAN & CAN-FD payload lengths (in bytes) per ISO 11898-1:2015.
 */
export const VALID_CAN_DLC_BYTES = [0, 1, 2, 3, 4, 5, 6, 7, 8] as const;
export const VALID_CAN_FD_DLC_BYTES = [
  0, 1, 2, 3, 4, 5, 6, 7, 8, 12, 16, 20, 24, 32, 48, 64,
] as const;

const DBC_EXT_ID_FLAG = 0x80000000;

/**
 * Canonical messageKey matching `nexus_core::CanIdKey::schema_key()` (`STD:0x101` / `EXT:0x18FF50E5`).
 */
export function formatCanMessageKey(arbId: number, isExtended: boolean): string {
  const cleanId = Math.max(0, Math.trunc(arbId)) >>> 0;
  if (isExtended) {
    const masked = (cleanId & 0x1fffffff) >>> 0;
    return `EXT:0x${masked.toString(16).toUpperCase().padStart(8, '0')}`;
  }
  const masked = cleanId & 0x7ff;
  return `STD:0x${masked.toString(16).toUpperCase().padStart(3, '0')}`;
}

/**
 * Sanitizes an identifier into a legal Vector DBC C-identifier (`[A-Za-z_][A-Za-z0-9_]*`).
 */
export function sanitizeDbcIdentifier(
  raw: string,
  fallback = 'Unnamed_Item'
): string {
  const trimmed = raw.trim();
  const base = trimmed.length > 0 ? trimmed : fallback;
  const cleaned = base.replace(/[^A-Za-z0-9_]/g, '_');
  if (/^[0-9]/.test(cleaned)) {
    return `N_${cleaned}`;
  }
  return cleaned.length > 0 ? cleaned : fallback;
}

function escapeDbcQuotes(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function formatDbcNumber(val: number, fallback = 0): string {
  if (!Number.isFinite(val)) {
    return String(fallback);
  }
  if (Object.is(val, -0) || val === 0) {
    return '0';
  }
  if (Number.isInteger(val) && Math.abs(val) <= Number.MAX_SAFE_INTEGER) {
    return String(val);
  }
  return String(Number(val.toPrecision(12)));
}

/**
 * Computes physical engineering `[min, max]` range from bit width, sign/float type, factor & offset
 * (standard DBC Studio "Calculate Minimum and Maximum" behavior).
 */
export function computePhysicalMinMaxFromEncoding(params: {
  bitLength: number;
  valueType: SignalValueTypeKind;
  factor: number;
  offset: number;
}): { min: number; max: number } {
  const bits = Math.max(1, Math.min(64, Math.trunc(params.bitLength)));
  const factor = Number.isFinite(params.factor) ? params.factor : 1;
  const offset = Number.isFinite(params.offset) ? params.offset : 0;

  if (params.valueType === 'float32' || params.valueType === 'float64') {
    const span = 1_000_000 * Math.abs(factor || 1);
    return {
      min: Number((-span + offset).toPrecision(10)),
      max: Number((span + offset).toPrecision(10)),
    };
  }

  let rawMin = 0;
  let rawMax = 0;
  if (params.valueType === 'signed') {
    if (bits >= 53) {
      rawMin = -Number.MAX_SAFE_INTEGER;
      rawMax = Number.MAX_SAFE_INTEGER;
    } else {
      const half = 2 ** (bits - 1);
      rawMin = -half;
      rawMax = half - 1;
    }
  } else {
    rawMin = 0;
    rawMax = bits >= 53 ? Number.MAX_SAFE_INTEGER : 2 ** bits - 1;
  }

  const p1 = rawMin * factor + offset;
  const p2 = rawMax * factor + offset;
  const lo = Math.min(p1, p2);
  const hi = Math.max(p1, p2);
  return {
    min: Number(lo.toPrecision(12)),
    max: Number(hi.toPrecision(12)),
  };
}

/**
 * Creates a clean starter `DatabaseSchemaDto` for DBC Studio
 * when creating a brand-new `.dbc` database from scratch.
 */
export function createStarterDbcSchema(databaseName = 'New_Vehicle_CAN'): DatabaseSchemaDto {
  const defaultMsgKey = formatCanMessageKey(0x100, false);
  const ecus: EcuNodeDto[] = [
    {
      name: 'VCU',
      comment: 'Vehicle Control Unit',
      txMessageKeys: [defaultMsgKey],
      rxMessageKeys: [],
    },
    {
      name: 'BMS',
      comment: 'Battery Management System',
      txMessageKeys: [],
      rxMessageKeys: [defaultMsgKey],
    },
  ];

  const starterSignal: SignalSchemaDto = {
    signalId: 0,
    messageKey: defaultMsgKey,
    name: 'VehicleSpeed',
    longName: 'Vehicle Ground Speed',
    startBit: 0,
    bitLength: 16,
    byteOrder: 'littleEndian',
    valueType: 'unsigned',
    factor: 0.01,
    offset: 0,
    min: 0,
    max: 655.35,
    unit: 'km/h',
    receivers: ['BMS'],
    comment: 'Vehicle longitudinal speed',
    muxRole: 'static',
    switchSignalId: null,
    muxRanges: [],
    enumTable: {},
    initialValue: 0,
  };

  const starterMessage: MessageSchemaDto = {
    messageKey: defaultMsgKey,
    arbId: 0x100,
    isExtended: false,
    protocol: 'CAN_FD',
    name: 'VCU_Status_01',
    dlc: 8,
    transmitters: ['VCU'],
    expectedCycleMs: 20,
    comment: 'Primary VCU status frame',
    signalIds: [0],
    bitLayout: [],
    isMultiplexed: false,
    masterSwitchId: null,
  };

  return {
    info: {
      name: sanitizeDbcIdentifier(databaseName, 'New_Vehicle_CAN'),
      version: '1.0.0',
      format: 'DBC',
      sourceEncoding: 'utf-8',
      messageCount: 1,
      signalCount: 1,
      diagnostics: [],
    },
    ecus,
    messages: [starterMessage],
    signals: [starterSignal],
  };
}

export interface ReusableValueTableDto {
  name: string;
  entries: Record<string, string>;
}

/**
 * Full-fidelity canonical `.dbc` text serializer (`DatabaseSchemaDto` -> `.dbc`).
 *
 * Emits 100% standard `.dbc` grammar sections compatible with `nexus-netdb` Rust->WASM:
 * - `VERSION`, `NS_`, `BS_`, `BU_`
 * - `VAL_TABLE_` (optional global reusable value tables)
 * - `BO_` & `SG_` (Intel `@1`, Vector Motorola `@0`, Signed/Unsigned, `M` / `mX` / `mXM` mux)
 * - `BO_TX_BU_` (multi-transmitter messages)
 * - `CM_` (`BU_`, `BO_`, `SG_` comments)
 * - `BA_DEF_` / `BA_DEF_DEF_` / `BA_` (`BusType`, `VFrameFormat` for CAN/CAN-FD/J1939,
 *   `GenMsgCycleTime`, `GenSigStartValue`, `SystemSignalLongSymbol`)
 * - `VAL_` (per-signal enum value descriptions)
 * - `SIG_VALTYPE_` (`1` = IEEE Float32, `2` = IEEE Double64)
 * - `SG_MUL_VAL_` (extended / multi-range / cascaded multiplexers)
 */
export function serializeDatabaseSchemaToDbc(
  schema: DatabaseSchemaDto,
  options?: {
    valueTables?: readonly ReusableValueTableDto[];
    networkComment?: string | null;
  }
): string {
  const lines: string[] = [];
  const versionStr = escapeDbcQuotes(schema.info.version ?? '1.0.0');
  lines.push(`VERSION "${versionStr}"`);
  lines.push('');

  lines.push('NS_ :');
  for (const sym of [
    'NS_DESC_',
    'CM_',
    'BA_DEF_',
    'BA_',
    'VAL_',
    'CAT_DEF_',
    'CAT_',
    'FILTER',
    'BA_DEF_DEF_',
    'EV_DATA_',
    'ENVVAR_DATA_',
    'SGTYPE_',
    'SGTYPE_VAL_',
    'BA_DEF_SGTYPE_',
    'BA_SGTYPE_',
    'SIG_TYPE_REF_',
    'VAL_TABLE_',
    'SIG_GROUP_',
    'SIG_VALTYPE_',
    'SIGTYPE_VALTYPE_',
    'BO_TX_BU_',
    'BA_DEF_REL_',
    'BA_REL_',
    'BA_DEF_DEF_REL_',
    'BU_SG_REL_',
    'BU_EV_REL_',
    'BU_BO_REL_',
    'SG_MUL_VAL_',
  ]) {
    lines.push(`\t${sym}`);
  }
  lines.push('');
  lines.push('BS_:');
  lines.push('');

  // Collect deterministic ECU nodes (explicit ECUs + any referenced TX/RX nodes)
  const ecuNameMap = new Map<string, { sanitized: string; comment: string | null }>();
  for (const ecu of schema.ecus) {
    const clean = sanitizeDbcIdentifier(ecu.name, 'ECU');
    if (clean !== 'Vector__XXX' && !ecuNameMap.has(clean)) {
      ecuNameMap.set(clean, { sanitized: clean, comment: ecu.comment });
    }
  }
  for (const msg of schema.messages) {
    for (const tx of msg.transmitters) {
      const clean = sanitizeDbcIdentifier(tx, '');
      if (clean && clean !== 'Vector__XXX' && !ecuNameMap.has(clean)) {
        ecuNameMap.set(clean, { sanitized: clean, comment: null });
      }
    }
  }
  for (const sig of schema.signals) {
    for (const rx of sig.receivers) {
      const clean = sanitizeDbcIdentifier(rx, '');
      if (clean && clean !== 'Vector__XXX' && !ecuNameMap.has(clean)) {
        ecuNameMap.set(clean, { sanitized: clean, comment: null });
      }
    }
  }

  const allEcuNames = Array.from(ecuNameMap.keys());
  lines.push(allEcuNames.length > 0 ? `BU_: ${allEcuNames.join(' ')}` : 'BU_:');
  lines.push('');

  // Optional global VAL_TABLE_ definitions
  if (options?.valueTables && options.valueTables.length > 0) {
    for (const vt of options.valueTables) {
      const vtName = sanitizeDbcIdentifier(vt.name, 'VT_Table');
      const entries = Object.entries(vt.entries)
        .filter(([k]) => Number.isFinite(Number(k)))
        .sort(([a], [b]) => Number(a) - Number(b));
      if (entries.length > 0) {
        const pairs = entries
          .map(([k, desc]) => `${Math.trunc(Number(k))} "${escapeDbcQuotes(desc)}"`)
          .join(' ');
        lines.push(`VAL_TABLE_ ${vtName} ${pairs} ;`);
      }
    }
    lines.push('');
  }

  // Group signals by messageKey and build sanitized unique names
  const signalsByMessageKey = new Map<string, SignalSchemaDto[]>();
  for (const sig of schema.signals) {
    const bucket = signalsByMessageKey.get(sig.messageKey);
    if (bucket) {
      bucket.push(sig);
    } else {
      signalsByMessageKey.set(sig.messageKey, [sig]);
    }
  }

  // Detect signals that act as a sub-switch for cascaded multiplexing (`m0M`)
  const subSwitchSignalIds = new Set<number>();
  for (const sig of schema.signals) {
    if (sig.muxRole === 'multiplexed' && sig.switchSignalId !== null) {
      subSwitchSignalIds.add(sig.switchSignalId);
    }
  }

  interface PreparedSignal {
    dto: SignalSchemaDto;
    dbcName: string;
  }
  interface PreparedMessage {
    dto: MessageSchemaDto;
    rawId: number;
    dbcName: string;
    txList: string[];
    signals: PreparedSignal[];
    signalNameById: Map<number, string>;
  }

  const usedMsgNames = new Set<string>();
  const preparedMessages: PreparedMessage[] = [];

  for (const msg of schema.messages) {
    const cleanArbId = Math.max(0, Math.trunc(msg.arbId)) >>> 0;
    const rawId = msg.isExtended
      ? (((cleanArbId & 0x1fffffff) | DBC_EXT_ID_FLAG) >>> 0)
      : cleanArbId & 0x7ff;

    let msgName = sanitizeDbcIdentifier(
      msg.name,
      `MSG_0x${cleanArbId.toString(16).toUpperCase()}`
    );
    if (usedMsgNames.has(msgName)) {
      msgName = `${msgName}_${cleanArbId.toString(16).toUpperCase()}`;
    }
    usedMsgNames.add(msgName);

    const txList = msg.transmitters
      .map((t) => sanitizeDbcIdentifier(t, ''))
      .filter((t) => t.length > 0 && t !== 'Vector__XXX');

    const rawSignals = signalsByMessageKey.get(msg.messageKey) ?? [];
    const usedSigNames = new Set<string>();
    const preparedSignals: PreparedSignal[] = [];
    const signalNameById = new Map<number, string>();

    rawSignals.forEach((sig, idx) => {
      let sName = sanitizeDbcIdentifier(sig.name, `Signal_${idx + 1}`);
      if (usedSigNames.has(sName)) {
        sName = `${sName}_${idx + 1}`;
      }
      usedSigNames.add(sName);
      signalNameById.set(sig.signalId, sName);
      preparedSignals.push({ dto: sig, dbcName: sName });
    });

    preparedMessages.push({
      dto: msg,
      rawId,
      dbcName: msgName,
      txList,
      signals: preparedSignals,
      signalNameById,
    });
  }

  // 6. BO_ & SG_
  for (const pm of preparedMessages) {
    const primaryTx = pm.txList[0] ?? 'Vector__XXX';
    const dlc = Math.max(0, Math.min(64, Math.trunc(pm.dto.dlc)));
    lines.push(`BO_ ${pm.rawId} ${pm.dbcName}: ${dlc} ${primaryTx}`);

    for (const ps of pm.signals) {
      const sig = ps.dto;
      let muxToken = '';
      if (sig.muxRole === 'masterSwitch') {
        muxToken = ' M';
      } else if (sig.muxRole === 'multiplexed') {
        const primaryVal = Math.trunc(sig.muxRanges[0]?.[0] ?? 0);
        const isSubSwitch = subSwitchSignalIds.has(sig.signalId);
        muxToken = isSubSwitch ? ` m${primaryVal}M` : ` m${primaryVal}`;
      }

      const byteOrderChar = sig.byteOrder === 'bigEndian' ? '0' : '1';
      const signChar = sig.valueType === 'signed' ? '-' : '+';
      const factor =
        Number.isFinite(sig.factor) && sig.factor !== 0 ? sig.factor : 1;
      const offset = Number.isFinite(sig.offset) ? sig.offset : 0;
      const minVal = Number.isFinite(sig.min) ? sig.min : 0;
      const maxVal = Number.isFinite(sig.max) ? sig.max : 0;
      const startBit = Math.max(0, Math.min(511, Math.trunc(sig.startBit)));
      const bitLength = Math.max(1, Math.min(64, Math.trunc(sig.bitLength)));
      const unitStr = escapeDbcQuotes(sig.unit ?? '');
      const cleanReceivers = sig.receivers
        .map((r) => sanitizeDbcIdentifier(r, ''))
        .filter((r) => r.length > 0 && r !== 'Vector__XXX');
      const rxText =
        cleanReceivers.length > 0 ? cleanReceivers.join(',') : 'Vector__XXX';

      lines.push(
        ` SG_ ${ps.dbcName}${muxToken} : ${startBit}|${bitLength}@${byteOrderChar}${signChar} (${formatDbcNumber(factor, 1)},${formatDbcNumber(offset, 0)}) [${formatDbcNumber(minVal, 0)}|${formatDbcNumber(maxVal, 0)}] "${unitStr}" ${rxText}`
      );
    }
    lines.push('');
  }

  // 7. BO_TX_BU_ (multiple transmitters)
  let emittedBoTxBu = false;
  for (const pm of preparedMessages) {
    if (pm.txList.length > 1) {
      lines.push(`BO_TX_BU_ ${pm.rawId} : ${pm.txList.join(',')} ;`);
      emittedBoTxBu = true;
    }
  }
  if (emittedBoTxBu) {
    lines.push('');
  }

  // 8. CM_ Comments (Network, Node, Message, Signal)
  const commentLines: string[] = [];
  if (options?.networkComment && options.networkComment.trim().length > 0) {
    commentLines.push(`CM_ "${escapeDbcQuotes(options.networkComment.trim())}" ;`);
  }
  for (const ecu of ecuNameMap.values()) {
    if (ecu.comment && ecu.comment.trim().length > 0) {
      commentLines.push(
        `CM_ BU_ ${ecu.sanitized} "${escapeDbcQuotes(ecu.comment.trim())}" ;`
      );
    }
  }
  for (const pm of preparedMessages) {
    if (pm.dto.comment && pm.dto.comment.trim().length > 0) {
      commentLines.push(
        `CM_ BO_ ${pm.rawId} "${escapeDbcQuotes(pm.dto.comment.trim())}" ;`
      );
    }
    for (const ps of pm.signals) {
      if (ps.dto.comment && ps.dto.comment.trim().length > 0) {
        commentLines.push(
          `CM_ SG_ ${pm.rawId} ${ps.dbcName} "${escapeDbcQuotes(ps.dto.comment.trim())}" ;`
        );
      }
    }
  }
  if (commentLines.length > 0) {
    lines.push(...commentLines);
    lines.push('');
  }

  // 9. BA_DEF_ & BA_DEF_DEF_ & BA_ (Standard .dbc Network & Frame Attributes)
  const hasCanFd = preparedMessages.some(
    (pm) => pm.dto.protocol.toUpperCase().includes('FD') || pm.dto.dlc > 8
  );
  const busTypeVal = hasCanFd ? 'CAN FD' : 'CAN';

  lines.push('BA_DEF_ "BusType" STRING ;');
  lines.push(
    'BA_DEF_ BO_ "VFrameFormat" ENUM "StandardCAN","ExtendedCAN","reserved","J1939PG","reserved","reserved","reserved","reserved","reserved","reserved","reserved","reserved","reserved","reserved","StandardCAN_FD","ExtendedCAN_FD" ;'
  );
  lines.push('BA_DEF_ BO_ "GenMsgCycleTime" INT 0 65535 ;');
  lines.push('BA_DEF_ SG_ "GenSigStartValue" FLOAT -1000000000 1000000000 ;');
  lines.push('BA_DEF_ SG_ "SystemSignalLongSymbol" STRING ;');

  lines.push('BA_DEF_DEF_ "BusType" "CAN" ;');
  lines.push('BA_DEF_DEF_ "VFrameFormat" "StandardCAN" ;');
  lines.push('BA_DEF_DEF_ "GenMsgCycleTime" 0 ;');
  lines.push('BA_DEF_DEF_ "GenSigStartValue" 0 ;');
  lines.push('BA_DEF_DEF_ "SystemSignalLongSymbol" "" ;');

  lines.push(`BA_ "BusType" "${busTypeVal}" ;`);

  for (const pm of preparedMessages) {
    const protoUpper = pm.dto.protocol.toUpperCase();
    const isFd = protoUpper.includes('FD') || pm.dto.dlc > 8;
    const isJ1939 = protoUpper.includes('J1939');
    let vFrameIdx = pm.dto.isExtended ? 1 : 0;
    if (isFd) {
      vFrameIdx = pm.dto.isExtended ? 15 : 14;
    } else if (isJ1939) {
      vFrameIdx = 3;
    }
    lines.push(`BA_ "VFrameFormat" BO_ ${pm.rawId} ${vFrameIdx} ;`);

    if (
      pm.dto.expectedCycleMs !== null &&
      Number.isFinite(pm.dto.expectedCycleMs) &&
      pm.dto.expectedCycleMs > 0
    ) {
      lines.push(
        `BA_ "GenMsgCycleTime" BO_ ${pm.rawId} ${Math.round(pm.dto.expectedCycleMs)} ;`
      );
    }

    for (const ps of pm.signals) {
      const sig = ps.dto;
      if (sig.initialValue !== null && Number.isFinite(sig.initialValue)) {
        const factor =
          Number.isFinite(sig.factor) && sig.factor !== 0 ? sig.factor : 1;
        const offset = Number.isFinite(sig.offset) ? sig.offset : 0;
        const rawStart = (sig.initialValue - offset) / factor;
        if (Number.isFinite(rawStart)) {
          lines.push(
            `BA_ "GenSigStartValue" SG_ ${pm.rawId} ${ps.dbcName} ${formatDbcNumber(rawStart, 0)} ;`
          );
        }
      }
      if (sig.longName && sig.longName.trim().length > 0) {
        lines.push(
          `BA_ "SystemSignalLongSymbol" SG_ ${pm.rawId} ${ps.dbcName} "${escapeDbcQuotes(sig.longName.trim())}" ;`
        );
      }
    }
  }
  lines.push('');

  // 10. VAL_ (Signal Value Descriptions / Enum Tables)
  const valLines: string[] = [];
  for (const pm of preparedMessages) {
    for (const ps of pm.signals) {
      const entries = Object.entries(ps.dto.enumTable ?? {})
        .filter(([k]) => Number.isFinite(Number(k)))
        .sort(([a], [b]) => Number(a) - Number(b));
      if (entries.length > 0) {
        const formattedPairs = entries
          .map(
            ([k, label]) =>
              `${Math.trunc(Number(k))} "${escapeDbcQuotes(String(label))}"`
          )
          .join(' ');
        valLines.push(`VAL_ ${pm.rawId} ${ps.dbcName} ${formattedPairs} ;`);
      }
    }
  }
  if (valLines.length > 0) {
    lines.push(...valLines);
    lines.push('');
  }

  // 11. SIG_VALTYPE_ (IEEE-754 Float32 / Double64)
  const valTypeLines: string[] = [];
  for (const pm of preparedMessages) {
    for (const ps of pm.signals) {
      if (ps.dto.valueType === 'float32') {
        valTypeLines.push(`SIG_VALTYPE_ ${pm.rawId} ${ps.dbcName} : 1 ;`);
      } else if (ps.dto.valueType === 'float64') {
        valTypeLines.push(`SIG_VALTYPE_ ${pm.rawId} ${ps.dbcName} : 2 ;`);
      }
    }
  }
  if (valTypeLines.length > 0) {
    lines.push(...valTypeLines);
    lines.push('');
  }

  // 12. SG_MUL_VAL_ (Extended / Multi-Range / Cascaded Multiplexing)
  const extMuxLines: string[] = [];
  for (const pm of preparedMessages) {
    const masterSwitchSig = pm.signals.find(
      (s) => s.dto.muxRole === 'masterSwitch'
    );
    for (const ps of pm.signals) {
      const sig = ps.dto;
      if (sig.muxRole === 'multiplexed' && sig.muxRanges.length > 0) {
        const switchName =
          (sig.switchSignalId !== null
            ? pm.signalNameById.get(sig.switchSignalId)
            : undefined) ?? masterSwitchSig?.dbcName;
        const needsExtMux =
          sig.muxRanges.length > 1 ||
          (sig.muxRanges[0] !== undefined &&
            sig.muxRanges[0][0] !== sig.muxRanges[0][1]) ||
          (switchName !== undefined &&
            masterSwitchSig !== undefined &&
            switchName !== masterSwitchSig.dbcName);

        if (switchName && needsExtMux) {
          const rangeText = sig.muxRanges
            .map(([lo, hi]) => `${Math.trunc(lo)}-${Math.trunc(hi)}`)
            .join(', ');
          extMuxLines.push(
            `SG_MUL_VAL_ ${pm.rawId} ${ps.dbcName} ${switchName} ${rangeText} ;`
          );
        }
      }
    }
  }
  if (extMuxLines.length > 0) {
    lines.push(...extMuxLines);
    lines.push('');
  }

  return `${lines.join('\n').trimEnd()}\n`;
}
