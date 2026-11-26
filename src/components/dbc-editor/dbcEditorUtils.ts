import {
  computePhysicalMinMaxFromEncoding,
  formatCanMessageKey,
  sanitizeDbcIdentifier,
  type BitCellDto,
  type DatabaseSchemaDto,
  type EcuNodeDto,
  type MessageSchemaDto,
  type SignalSchemaDto,
} from './contracts';
import {
  getLocale,
  translateShard,
  type CloudLocale,
} from './i18n/core';
import { dbcStudioShard } from './i18n/dbcStudio';

export type CandbFolderKind =
  | 'networks'
  | 'ecus'
  | 'messages'
  | 'signals'
  | 'valueTables';

export type CandbViewTarget =
  | { kind: 'folder'; folder: CandbFolderKind }
  | { kind: 'messageSignals'; messageKey: string }
  | { kind: 'ecuDetail'; ecuName: string };

export type CandbSelectedRow =
  | { kind: 'network' }
  | { kind: 'ecu'; ecuName: string }
  | { kind: 'message'; messageKey: string }
  | { kind: 'signal'; messageKey: string; signalId: number }
  | { kind: 'valueTable'; tableIndex: number };

export type MessageDialogTab =
  | 'definition'
  | 'signals'
  | 'layout'
  | 'transmitters'
  | 'comment';

export type SignalDialogTab =
  | 'definition'
  | 'values'
  | 'receivers'
  | 'comment';

export type EcuDialogTab = 'definition' | 'txMessages' | 'rxSignals';

export type CandbModalState =
  | { kind: 'none' }
  | { kind: 'message'; messageKey: string; initialTab?: MessageDialogTab }
  | { kind: 'createMessage'; initialTab?: MessageDialogTab }
  | {
      kind: 'signal';
      signalId: number;
      initialTab?: SignalDialogTab;
      returnToMessageKey?: string;
      editingStagedMessageSignal?: boolean;
    }
  | {
      kind: 'createSignal';
      initialTab?: SignalDialogTab;
      returnToMessageKey?: string;
      returnToMessageTab?: MessageDialogTab;
      targetIsStagedMessage?: boolean;
    }
  | { kind: 'ecu'; ecuName: string; initialTab?: EcuDialogTab }
  | { kind: 'createEcu'; initialTab?: EcuDialogTab }
  | { kind: 'valueTable'; tableIndex: number }
  | { kind: 'createValueTable' }
  | { kind: 'network' }
  | { kind: 'commMatrix' }
  | { kind: 'consistency' }
  | { kind: 'dbcSource' }
  | { kind: 'saveAs' };

export type CandbMessageIdFormat =
  | 'CAN_STD'
  | 'CAN_EXT'
  | 'CAN_FD_STD'
  | 'CAN_FD_EXT'
  | 'J1939_PG';

export function getMessageIdFormat(
  msg: Pick<MessageSchemaDto, 'protocol' | 'isExtended'>
): CandbMessageIdFormat {
  const proto = msg.protocol.toUpperCase();
  if (proto.includes('J1939')) {
    return 'J1939_PG';
  }
  if (proto.includes('FD')) {
    return msg.isExtended ? 'CAN_FD_EXT' : 'CAN_FD_STD';
  }
  return msg.isExtended ? 'CAN_EXT' : 'CAN_STD';
}

export function formatMessageIdFormatLabel(
  fmt: CandbMessageIdFormat,
  locale?: CloudLocale
): string {
  const activeLocale = locale ?? getLocale();
  switch (fmt) {
    case 'CAN_STD':
      return translateShard(dbcStudioShard, activeLocale, 'utils.idFormat.canStd');
    case 'CAN_EXT':
      return translateShard(dbcStudioShard, activeLocale, 'utils.idFormat.canExt');
    case 'CAN_FD_STD':
      return translateShard(
        dbcStudioShard,
        activeLocale,
        'utils.idFormat.canFdStd'
      );
    case 'CAN_FD_EXT':
      return translateShard(
        dbcStudioShard,
        activeLocale,
        'utils.idFormat.canFdExt'
      );
    case 'J1939_PG':
      return translateShard(
        dbcStudioShard,
        activeLocale,
        'utils.idFormat.j1939Pg'
      );
  }
}

export function buildMessageIdFormatPatch(
  msg: Pick<MessageSchemaDto, 'arbId' | 'dlc'>,
  fmt: CandbMessageIdFormat
): Partial<MessageSchemaDto> & {
  nextArbId: number;
  nextIsExtended: boolean;
} {
  switch (fmt) {
    case 'CAN_STD':
      return {
        protocol: 'CAN',
        nextIsExtended: false,
        nextArbId: msg.arbId & 0x7ff,
        ...(msg.dlc > 8 ? { dlc: 8 } : {}),
      };
    case 'CAN_EXT':
      return {
        protocol: 'CAN',
        nextIsExtended: true,
        nextArbId: (msg.arbId & 0x1fffffff) >>> 0,
        ...(msg.dlc > 8 ? { dlc: 8 } : {}),
      };
    case 'CAN_FD_STD':
      return {
        protocol: 'CAN_FD',
        nextIsExtended: false,
        nextArbId: msg.arbId & 0x7ff,
      };
    case 'CAN_FD_EXT':
      return {
        protocol: 'CAN_FD',
        nextIsExtended: true,
        nextArbId: (msg.arbId & 0x1fffffff) >>> 0,
      };
    case 'J1939_PG':
      return {
        protocol: 'J1939',
        nextIsExtended: true,
        nextArbId: (msg.arbId & 0x1fffffff) >>> 0,
        ...(msg.dlc > 8 ? { dlc: 8 } : {}),
      };
  }
}

export const CANDB_SIGNAL_PALETTE: readonly string[] = [
  'var(--series-1)',
  'var(--series-2)',
  'var(--series-3)',
  'var(--series-4)',
  'var(--series-5)',
  'var(--series-6)',
  'var(--series-7)',
  'var(--series-8)',
];

export function getSignalColor(signalId: number): string {
  const idx = Math.abs(Math.trunc(signalId)) % CANDB_SIGNAL_PALETTE.length;
  return CANDB_SIGNAL_PALETTE[idx] ?? 'var(--series-1)';
}

export function formatHexArbId(arbId: number, isExtended: boolean): string {
  const clean = Math.max(0, Math.trunc(arbId)) >>> 0;
  const masked = isExtended ? (clean & 0x1fffffff) >>> 0 : clean & 0x7ff;
  const padLen = isExtended ? 8 : 3;
  return `0x${masked.toString(16).toUpperCase().padStart(padLen, '0')}`;
}

export function parseHexArbIdInput(
  raw: string,
  isExtended: boolean
): number | null {
  const trimmed = raw.trim().replace(/^0x/i, '');
  if (!/^[0-9a-fA-F]+$/.test(trimmed)) {
    return null;
  }
  const parsed = Number.parseInt(trimmed, 16);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return null;
  }
  const maxId = isExtended ? 0x1fffffff : 0x7ff;
  return Math.min(maxId, parsed >>> 0);
}

export function parseDecimalArbIdInput(
  raw: string,
  isExtended: boolean
): number | null {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    return null;
  }
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return null;
  }
  const maxId = isExtended ? 0x1fffffff : 0x7ff;
  return Math.min(maxId, parsed >>> 0);
}

export interface VersioningPresetItem {
  id: 'patch' | 'minor' | 'major' | 'rc' | 'calver';
  strategyLabel: string;
  suggestedVersion: string;
}

/**
 * Builds 1-click versioning strategy presets from the current/latest semantic version
 * while allowing completely arbitrary industrial version strings.
 */
export function buildVersioningPresets(
  referenceLabel: string | undefined,
  now: Date = new Date(),
  locale?: CloudLocale
): VersioningPresetItem[] {
  const activeLocale = locale ?? getLocale();
  const patchLabel = translateShard(
    dbcStudioShard,
    activeLocale,
    'utils.preset.patch'
  );
  const minorLabel = translateShard(
    dbcStudioShard,
    activeLocale,
    'utils.preset.minor'
  );
  const majorLabel = translateShard(
    dbcStudioShard,
    activeLocale,
    'utils.preset.major'
  );
  const rcLabel = translateShard(
    dbcStudioShard,
    activeLocale,
    'utils.preset.rc'
  );
  const calverLabel = translateShard(
    dbcStudioShard,
    activeLocale,
    'utils.preset.calver'
  );

  const yyyy = String(now.getFullYear());
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const calVer = `${yyyy}.${mm}.${dd}`;

  if (!referenceLabel || !referenceLabel.trim()) {
    return [
      { id: 'patch', strategyLabel: patchLabel, suggestedVersion: 'v1.0.0' },
      { id: 'minor', strategyLabel: minorLabel, suggestedVersion: 'v1.1.0' },
      { id: 'major', strategyLabel: majorLabel, suggestedVersion: 'v2.0.0' },
      {
        id: 'rc',
        strategyLabel: rcLabel,
        suggestedVersion: 'v1.0.0-rc.1',
      },
      {
        id: 'calver',
        strategyLabel: calverLabel,
        suggestedVersion: calVer,
      },
    ];
  }

  const trimmed = referenceLabel.trim();
  const rcMatch = /^(v?)(\d+)\.(\d+)\.(\d+)-rc\.?(\d+)$/i.exec(trimmed);
  if (rcMatch) {
    const prefix = rcMatch[1] !== undefined ? rcMatch[1] : 'v';
    const maj = Number.parseInt(rcMatch[2] ?? '1', 10);
    const min = Number.parseInt(rcMatch[3] ?? '0', 10);
    const pat = Number.parseInt(rcMatch[4] ?? '0', 10);
    const rcNum = Number.parseInt(rcMatch[5] ?? '1', 10);
    return [
      {
        id: 'patch',
        strategyLabel: patchLabel,
        suggestedVersion: `${prefix}${maj}.${min}.${pat}`,
      },
      {
        id: 'minor',
        strategyLabel: minorLabel,
        suggestedVersion: `${prefix}${maj}.${min + 1}.0`,
      },
      {
        id: 'major',
        strategyLabel: majorLabel,
        suggestedVersion: `${prefix}${maj + 1}.0.0`,
      },
      {
        id: 'rc',
        strategyLabel: rcLabel,
        suggestedVersion: `${prefix}${maj}.${min}.${pat}-rc.${rcNum + 1}`,
      },
      {
        id: 'calver',
        strategyLabel: calverLabel,
        suggestedVersion: calVer,
      },
    ];
  }

  const semverMatch = /^(v?)(\d+)\.(\d+)(?:\.(\d+))?/i.exec(trimmed);
  if (semverMatch) {
    const prefix = semverMatch[1] !== undefined ? semverMatch[1] : 'v';
    const maj = Number.parseInt(semverMatch[2] ?? '1', 10);
    const min = Number.parseInt(semverMatch[3] ?? '0', 10);
    const pat =
      semverMatch[4] !== undefined ? Number.parseInt(semverMatch[4], 10) : 0;
    return [
      {
        id: 'patch',
        strategyLabel: patchLabel,
        suggestedVersion: `${prefix}${maj}.${min}.${pat + 1}`,
      },
      {
        id: 'minor',
        strategyLabel: minorLabel,
        suggestedVersion: `${prefix}${maj}.${min + 1}.0`,
      },
      {
        id: 'major',
        strategyLabel: majorLabel,
        suggestedVersion: `${prefix}${maj + 1}.0.0`,
      },
      {
        id: 'rc',
        strategyLabel: rcLabel,
        suggestedVersion: `${prefix}${maj}.${min + 1}.0-rc.1`,
      },
      {
        id: 'calver',
        strategyLabel: calverLabel,
        suggestedVersion: calVer,
      },
    ];
  }

  return [
    {
      id: 'patch',
      strategyLabel: patchLabel,
      suggestedVersion: `${trimmed}.1`,
    },
    { id: 'minor', strategyLabel: minorLabel, suggestedVersion: 'v1.1.0' },
    { id: 'major', strategyLabel: majorLabel, suggestedVersion: 'v2.0.0' },
    {
      id: 'rc',
      strategyLabel: rcLabel,
      suggestedVersion: `${trimmed}-rc.1`,
    },
    {
      id: 'calver',
      strategyLabel: calverLabel,
      suggestedVersion: calVer,
    },
  ];
}

/**
 * Auto-suggests the next semantic version label (e.g. `v2.4.0` -> `v2.4.1`).
 */
export function suggestNextVersionLabel(
  latestLabel: string | undefined,
  versionCount: number
): string {
  if (!latestLabel) {
    return versionCount === 0 ? 'v1.0.0' : `v${Math.max(1, versionCount + 1)}.0.0`;
  }
  const presets = buildVersioningPresets(latestLabel);
  return presets[0]?.suggestedVersion ?? `v${Math.max(1, versionCount + 1)}.0.0`;
}

/**
 * Normalizes dense `signalId` indices (`0..N-1`), `message.signalIds`, `isMultiplexed`,
 * `masterSwitchId`, `ecu.txMessageKeys` / `rxMessageKeys`, and header counts.
 */
export function normalizeSchemaInvariants(
  schema: DatabaseSchemaDto
): DatabaseSchemaDto {
  const idRemap = new Map<number, number>();
  const normalizedSignals: SignalSchemaDto[] = schema.signals.map((sig, idx) => {
    idRemap.set(sig.signalId, idx);
    return {
      ...sig,
      signalId: idx,
    };
  });

  // Remap switchSignalId references
  const finalSignals: SignalSchemaDto[] = normalizedSignals.map((sig) => ({
    ...sig,
    switchSignalId:
      sig.switchSignalId !== null
        ? (idRemap.get(sig.switchSignalId) ?? null)
        : null,
  }));

  const sigsByMsg = new Map<string, SignalSchemaDto[]>();
  for (const sig of finalSignals) {
    const list = sigsByMsg.get(sig.messageKey);
    if (list) {
      list.push(sig);
    } else {
      sigsByMsg.set(sig.messageKey, [sig]);
    }
  }

  const finalMessages: MessageSchemaDto[] = schema.messages.map((msg) => {
    const msgSigs = sigsByMsg.get(msg.messageKey) ?? [];
    const masterSig = msgSigs.find((s) => s.muxRole === 'masterSwitch') ?? null;
    const isMultiplexed =
      masterSig !== null || msgSigs.some((s) => s.muxRole === 'multiplexed');

    const remappedBitLayout: BitCellDto[] = [];
    for (const cell of msg.bitLayout) {
      const nextSigId = idRemap.get(cell.signalId);
      if (nextSigId !== undefined) {
        remappedBitLayout.push({
          ...cell,
          signalId: nextSigId,
          switchSignalId:
            cell.switchSignalId !== null
              ? (idRemap.get(cell.switchSignalId) ?? null)
              : null,
        });
      }
    }

    return {
      ...msg,
      signalIds: msgSigs.map((s) => s.signalId),
      isMultiplexed,
      masterSwitchId: masterSig ? masterSig.signalId : null,
      bitLayout: remappedBitLayout,
    };
  });

  // Ensure every referenced TX / RX ECU exists in schema.ecus and compute TX/RX message keys
  const knownEcus = new Map<string, EcuNodeDto>();
  for (const ecu of schema.ecus) {
    const clean = sanitizeDbcIdentifier(ecu.name, '');
    if (clean && clean !== 'Vector__XXX' && !knownEcus.has(clean)) {
      knownEcus.set(clean, {
        name: clean,
        comment: ecu.comment,
        txMessageKeys: [],
        rxMessageKeys: [],
      });
    }
  }
  for (const msg of finalMessages) {
    for (const tx of msg.transmitters) {
      const clean = sanitizeDbcIdentifier(tx, '');
      if (clean && clean !== 'Vector__XXX' && !knownEcus.has(clean)) {
        knownEcus.set(clean, {
          name: clean,
          comment: null,
          txMessageKeys: [],
          rxMessageKeys: [],
        });
      }
    }
  }
  for (const sig of finalSignals) {
    for (const rx of sig.receivers) {
      const clean = sanitizeDbcIdentifier(rx, '');
      if (clean && clean !== 'Vector__XXX' && !knownEcus.has(clean)) {
        knownEcus.set(clean, {
          name: clean,
          comment: null,
          txMessageKeys: [],
          rxMessageKeys: [],
        });
      }
    }
  }

  for (const msg of finalMessages) {
    for (const tx of msg.transmitters) {
      const ecu = knownEcus.get(sanitizeDbcIdentifier(tx, ''));
      if (ecu && !ecu.txMessageKeys.includes(msg.messageKey)) {
        ecu.txMessageKeys.push(msg.messageKey);
      }
    }
    const msgSigs = sigsByMsg.get(msg.messageKey) ?? [];
    for (const sig of msgSigs) {
      for (const rx of sig.receivers) {
        const ecu = knownEcus.get(sanitizeDbcIdentifier(rx, ''));
        if (ecu && !ecu.rxMessageKeys.includes(msg.messageKey)) {
          ecu.rxMessageKeys.push(msg.messageKey);
        }
      }
    }
  }

  return {
    info: {
      ...schema.info,
      messageCount: finalMessages.length,
      signalCount: finalSignals.length,
    },
    ecus: Array.from(knownEcus.values()),
    messages: finalMessages,
    signals: finalSignals,
  };
}

/**
 * Merges 100% authoritative `nexus-netdb` Rust->WASM `BitCellDto[]` coordinates from
 * `compiledSchema` onto `draftSchema` without performing any custom JS bit extraction math.
 */
export function mergeWasmBitLayoutIntoSchema(
  draft: DatabaseSchemaDto,
  compiled: DatabaseSchemaDto | null
): DatabaseSchemaDto {
  if (!compiled) {
    return draft;
  }

  const compiledSignalsById = new Map<number, SignalSchemaDto>();
  for (const cSig of compiled.signals) {
    compiledSignalsById.set(cSig.signalId, cSig);
  }

  const compiledMsgByKey = new Map<string, MessageSchemaDto>();
  for (const cMsg of compiled.messages) {
    compiledMsgByKey.set(cMsg.messageKey, cMsg);
  }

  // Group draft signals per message and compute deterministic sanitized names matching dbcSerializer
  const draftSigsByMsgKey = new Map<string, Map<string, SignalSchemaDto>>();
  const rawBucketByMsg = new Map<string, SignalSchemaDto[]>();
  for (const dSig of draft.signals) {
    const arr = rawBucketByMsg.get(dSig.messageKey);
    if (arr) {
      arr.push(dSig);
    } else {
      rawBucketByMsg.set(dSig.messageKey, [dSig]);
    }
  }

  for (const [msgKey, sigList] of rawBucketByMsg.entries()) {
    const usedNames = new Set<string>();
    const nameMap = new Map<string, SignalSchemaDto>();
    sigList.forEach((sig, idx) => {
      let sName = sanitizeDbcIdentifier(sig.name, `Signal_${idx + 1}`);
      if (usedNames.has(sName)) {
        sName = `${sName}_${idx + 1}`;
      }
      usedNames.add(sName);
      nameMap.set(sName, sig);
    });
    draftSigsByMsgKey.set(msgKey, nameMap);
  }

  const mergedMessages: MessageSchemaDto[] = draft.messages.map((dMsg) => {
    const canonicalKey = formatCanMessageKey(dMsg.arbId, dMsg.isExtended);
    const cMsg =
      compiledMsgByKey.get(dMsg.messageKey) ??
      compiledMsgByKey.get(canonicalKey);
    if (!cMsg) {
      return dMsg;
    }

    const nameMap = draftSigsByMsgKey.get(dMsg.messageKey);
    if (!nameMap) {
      return { ...dMsg, bitLayout: [] };
    }

    const mappedCells: BitCellDto[] = [];
    for (const cell of cMsg.bitLayout) {
      const cSig = compiledSignalsById.get(cell.signalId);
      if (!cSig) continue;
      const dSig =
        nameMap.get(cSig.name) ??
        nameMap.get(sanitizeDbcIdentifier(cSig.name, ''));
      if (!dSig) continue;

      let mappedSwitchId: number | null = null;
      if (cell.switchSignalId !== null) {
        const cSwitch = compiledSignalsById.get(cell.switchSignalId);
        if (cSwitch) {
          const dSwitch = nameMap.get(cSwitch.name);
          mappedSwitchId = dSwitch ? dSwitch.signalId : null;
        }
      }

      mappedCells.push({
        ...cell,
        signalId: dSig.signalId,
        switchSignalId: mappedSwitchId,
      });
    }

    return {
      ...dMsg,
      bitLayout: mappedCells,
    };
  });

  return {
    ...draft,
    info: {
      ...draft.info,
      diagnostics: compiled.info.diagnostics,
    },
    messages: mergedMessages,
  };
}

/**
 * Finds the next free non-overlapping bit position inside a message using WASM `bitLayout`
 * (and a basic startBit reservation fallback if a newly added signal hasn't round-tripped yet).
 */
export function findNextFreeSignalPlacement(
  message: MessageSchemaDto,
  msgSignals: readonly SignalSchemaDto[],
  preferredLength = 8
): { startBit: number; bitLength: number } {
  const totalBits = Math.max(8, Math.min(512, message.dlc * 8));
  const occupied = new Set<number>();

  for (const cell of message.bitLayout) {
    const linear = cell.byteIndex * 8 + cell.bitInByte;
    if (linear >= 0 && linear < totalBits) {
      occupied.add(linear);
    }
  }

  // Fallback reservation for signals whose WASM bitLayout hasn't returned yet
  const representedSignals = new Set(message.bitLayout.map((c) => c.signalId));
  for (const sig of msgSignals) {
    if (!representedSignals.has(sig.signalId)) {
      if (sig.byteOrder === 'littleEndian') {
        for (let i = 0; i < sig.bitLength; i += 1) {
          occupied.add(sig.startBit + i);
        }
      } else {
        occupied.add(sig.startBit);
      }
    }
  }

  const targetLen = Math.max(1, Math.min(preferredLength, totalBits));

  // Try contiguous Intel LE run of `targetLen` free bits first
  for (let start = 0; start <= totalBits - targetLen; start += 1) {
    let free = true;
    for (let offset = 0; offset < targetLen; offset += 1) {
      if (occupied.has(start + offset)) {
        free = false;
        break;
      }
    }
    if (free) {
      return { startBit: start, bitLength: targetLen };
    }
  }

  // Otherwise find first single free bit and fit maximum contiguous run
  for (let start = 0; start < totalBits; start += 1) {
    if (!occupied.has(start)) {
      let run = 1;
      while (
        run < targetLen &&
        start + run < totalBits &&
        !occupied.has(start + run)
      ) {
        run += 1;
      }
      return { startBit: start, bitLength: run };
    }
  }

  return { startBit: 0, bitLength: Math.min(8, totalBits) };
}

export function findNextFreeArbId(
  messages: readonly MessageSchemaDto[],
  isExtended = false
): number {
  const used = new Set<number>();
  for (const m of messages) {
    if (m.isExtended === isExtended) {
      used.add(m.arbId);
    }
  }
  let candidate = isExtended ? 0x18ff5000 : 0x100;
  const maxId = isExtended ? 0x1fffffff : 0x7ff;
  while (used.has(candidate) && candidate < maxId) {
    candidate += 1;
  }
  return candidate;
}

export function createDefaultSignal(params: {
  signalId: number;
  message: MessageSchemaDto;
  existingSignals: readonly SignalSchemaDto[];
  overrideStartBit?: number;
}): SignalSchemaDto {
  const placement =
    params.overrideStartBit !== undefined
      ? {
          startBit: Math.max(0, Math.min(511, params.overrideStartBit)),
          bitLength: 8,
        }
      : findNextFreeSignalPlacement(params.message, params.existingSignals, 8);

  const usedNames = new Set(params.existingSignals.map((s) => s.name));
  let idx = params.existingSignals.length + 1;
  let candidateName = `NewSignal_${String(idx).padStart(2, '0')}`;
  while (usedNames.has(candidateName)) {
    idx += 1;
    candidateName = `NewSignal_${String(idx).padStart(2, '0')}`;
  }

  const { min, max } = computePhysicalMinMaxFromEncoding({
    bitLength: placement.bitLength,
    valueType: 'unsigned',
    factor: 1,
    offset: 0,
  });

  return {
    signalId: params.signalId,
    messageKey: params.message.messageKey,
    name: candidateName,
    longName: null,
    startBit: placement.startBit,
    bitLength: placement.bitLength,
    byteOrder: 'littleEndian',
    valueType: 'unsigned',
    factor: 1,
    offset: 0,
    min,
    max,
    unit: '',
    receivers: [],
    comment: null,
    muxRole: 'static',
    switchSignalId: null,
    muxRanges: [],
    enumTable: {},
    initialValue: 0,
  };
}

export function formatMuxRangesText(
  ranges: ReadonlyArray<readonly [number, number]>
): string {
  if (ranges.length === 0) return '0';
  return ranges
    .map(([lo, hi]) => (lo === hi ? `${lo}` : `${lo}-${hi}`))
    .join(', ');
}

export function parseMuxRangesText(raw: string): Array<[number, number]> {
  const parts = raw
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  const result: Array<[number, number]> = [];
  for (const part of parts) {
    const rangeMatch = /^(\d+)\s*-\s*(\d+)$/.exec(part);
    if (rangeMatch) {
      const a = Number.parseInt(rangeMatch[1] ?? '0', 10);
      const b = Number.parseInt(rangeMatch[2] ?? '0', 10);
      if (Number.isFinite(a) && Number.isFinite(b)) {
        result.push([Math.min(a, b), Math.max(a, b)]);
      }
      continue;
    }
    const singleMatch = /^(\d+)$/.exec(part);
    if (singleMatch) {
      const v = Number.parseInt(singleMatch[1] ?? '0', 10);
      if (Number.isFinite(v)) {
        result.push([v, v]);
      }
    }
  }
  return result.length > 0 ? result : [[0, 0]];
}

export interface SignalScalingPreview {
  rawMin: number;
  rawMax: number;
  clampedRaw: number;
  physicalValue: number;
  isPhysicalOutOfRange: boolean;
  isRawOutOfBitDomain: boolean;
  rawHex: string;
  rawBinaryPreview: string;
  enumLabel: string | null;
}

export function computeSignalScalingPreview(
  signal: SignalSchemaDto,
  rawInput: number,
  locale?: CloudLocale
): SignalScalingPreview {
  const bits = Math.max(1, Math.min(64, Math.trunc(signal.bitLength)));
  const factor =
    Number.isFinite(signal.factor) && signal.factor !== 0 ? signal.factor : 1;
  const offset = Number.isFinite(signal.offset) ? signal.offset : 0;

  let rawMin = 0;
  let rawMax = 255;

  if (signal.valueType === 'float32' || signal.valueType === 'float64') {
    rawMin = -1_000_000_000;
    rawMax = 1_000_000_000;
  } else if (signal.valueType === 'signed') {
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

  const safeRaw = Number.isFinite(rawInput) ? rawInput : 0;
  const isFloat =
    signal.valueType === 'float32' || signal.valueType === 'float64';
  const quantizedRaw = isFloat ? safeRaw : Math.round(safeRaw);
  const isRawOutOfBitDomain =
    !isFloat && (quantizedRaw < rawMin || quantizedRaw > rawMax);
  const clampedRaw = isFloat
    ? quantizedRaw
    : Math.max(rawMin, Math.min(rawMax, quantizedRaw));

  const physicalValue = Number((clampedRaw * factor + offset).toPrecision(12));
  const hasExplicitBounds = !(signal.min === 0 && signal.max === 0);
  const isPhysicalOutOfRange =
    hasExplicitBounds &&
    (physicalValue < signal.min - 1e-9 || physicalValue > signal.max + 1e-9);

  let rawHex = '0x0';
  let rawBinaryPreview = '0';

  if (signal.valueType === 'float32') {
    const buf = new ArrayBuffer(4);
    const view = new DataView(buf);
    view.setFloat32(0, clampedRaw, false);
    const u32 = view.getUint32(0, false);
    rawHex = `0x${u32.toString(16).toUpperCase().padStart(8, '0')} (IEEE754)`;
    rawBinaryPreview = u32.toString(2).padStart(32, '0');
  } else if (signal.valueType === 'float64') {
    const buf = new ArrayBuffer(8);
    const view = new DataView(buf);
    view.setFloat64(0, clampedRaw, false);
    const hi = view.getUint32(0, false);
    const lo = view.getUint32(4, false);
    rawHex = `0x${hi.toString(16).toUpperCase().padStart(8, '0')}${lo
      .toString(16)
      .toUpperCase()
      .padStart(8, '0')} (IEEE754)`;
    rawBinaryPreview = `${hi.toString(2).padStart(32, '0')}…`;
  } else if (bits <= 52) {
    const bigVal =
      clampedRaw < 0
        ? (BigInt(1) << BigInt(bits)) + BigInt(clampedRaw)
        : BigInt(clampedRaw);
    const hexChars = Math.max(2, Math.ceil(bits / 4));
    rawHex = `0x${bigVal.toString(16).toUpperCase().padStart(hexChars, '0')}`;
    const binStr = bigVal.toString(2).padStart(bits, '0');
    rawBinaryPreview =
      binStr.length > 32 ? `${binStr.slice(0, 32)}… (${bits}b)` : binStr;
  } else {
    rawHex = `${clampedRaw}`;
    rawBinaryPreview = translateShard(
      dbcStudioShard,
      locale ?? getLocale(),
      'utils.scaling.bitInt',
      { bits }
    );
  }

  const enumLabel = !isFloat
    ? (signal.enumTable[String(clampedRaw)] ?? null)
    : null;

  return {
    rawMin,
    rawMax,
    clampedRaw,
    physicalValue,
    isPhysicalOutOfRange,
    isRawOutOfBitDomain,
    rawHex,
    rawBinaryPreview,
    enumLabel,
  };
}
