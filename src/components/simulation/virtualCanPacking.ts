import type {
  BitCellDto,
  DatabaseSchemaDto,
  DatabaseVersionDto,
  EcuNodeDto,
  MessageSchemaDto,
  NetworkDatabaseSummaryDto,
  SignalSchemaDto,
  SimulationAccentColor,
  SimulationComboOptionDto,
  SimulationGeneratorSpecDto,
  SimulationSignalBindingDto,
  SimulationWidgetConfigDto,
  SimulationWidgetDto,
  SimulationWidgetKind,
  SimulationWidgetLayoutDto,
} from './contracts';

export interface LoadedSimulationDatabaseEntry {
  db: NetworkDatabaseSummaryDto;
  version: DatabaseVersionDto;
  schema: DatabaseSchemaDto;
  inferredBusId: number;
}

export interface SignalBindingDbMeta {
  databaseId?: string;
  databaseName?: string;
}

export function inferBusIdFromAssignment(
  busAssignment: string | null | undefined
): number {
  if (!busAssignment) return 0;
  const match = /\b(?:can|bus|ch|channel)[\s_-]*(\d{1,2})\b/i.exec(
    busAssignment
  );
  if (match && match[1] !== undefined) {
    const parsed = Number.parseInt(match[1], 10);
    if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 15) {
      return parsed;
    }
  }
  return 0;
}

export function formatDatabaseShortBus(
  db: Pick<NetworkDatabaseSummaryDto, 'busAssignment'>
): string {
  const trimmed = db.busAssignment.trim();
  if (!trimmed) {
    return 'CAN0';
  }
  const token = trimmed.split(/[\s—–-]+/)[0]?.trim() ?? '';
  if (/^can\d+$/i.test(token)) {
    return token.toUpperCase();
  }
  return `CAN${inferBusIdFromAssignment(trimmed)}`;
}

export function formatDatabaseDisplayLabel(
  db: Pick<NetworkDatabaseSummaryDto, 'name' | 'format' | 'busAssignment'>
): string {
  const ext = `.${db.format.toLowerCase()}`;
  const hasExt = db.name.toLowerCase().endsWith(ext);
  const fileTitle = hasExt ? db.name : `${db.name}${ext}`;
  return `${fileTitle} (${formatDatabaseShortBus(db)})`;
}

export function makeCompositeMessageKey(
  databaseId: string,
  messageKey: string
): string {
  return `${databaseId}::${messageKey}`;
}

export function mergeDatabaseSchemas(
  entries: readonly LoadedSimulationDatabaseEntry[]
): DatabaseSchemaDto | null {
  if (entries.length === 0) {
    return null;
  }
  if (entries.length === 1) {
    return entries[0]!.schema;
  }

  const ecuByName = new Map<string, EcuNodeDto>();
  const messageByKey = new Map<string, MessageSchemaDto>();
  const mergedSignals: SignalSchemaDto[] = [];
  const seenMsgSignalKey = new Set<string>();
  let nextGlobalSignalId = 0;

  for (const entry of entries) {
    const { schema } = entry;
    const localToGlobalSigId = new Map<number, number>();

    for (const ecu of schema.ecus) {
      const existingEcu = ecuByName.get(ecu.name);
      if (!existingEcu) {
        ecuByName.set(ecu.name, {
          name: ecu.name,
          comment: ecu.comment,
          txMessageKeys: [...ecu.txMessageKeys],
          rxMessageKeys: [...ecu.rxMessageKeys],
        });
      } else {
        const txSet = new Set([
          ...existingEcu.txMessageKeys,
          ...ecu.txMessageKeys,
        ]);
        const rxSet = new Set([
          ...existingEcu.rxMessageKeys,
          ...ecu.rxMessageKeys,
        ]);
        ecuByName.set(ecu.name, {
          ...existingEcu,
          txMessageKeys: Array.from(txSet),
          rxMessageKeys: Array.from(rxSet),
        });
      }
    }

    // First assign global dense signalIds for signals in this schema
    for (const sig of schema.signals) {
      const dedupKey = `${sig.messageKey}::${sig.name}`;
      if (seenMsgSignalKey.has(dedupKey)) {
        continue;
      }
      const assignedId = nextGlobalSignalId;
      nextGlobalSignalId += 1;
      localToGlobalSigId.set(sig.signalId, assignedId);
    }

    for (const sig of schema.signals) {
      const assignedId = localToGlobalSigId.get(sig.signalId);
      if (assignedId === undefined) continue;
      const dedupKey = `${sig.messageKey}::${sig.name}`;
      seenMsgSignalKey.add(dedupKey);

      const remappedSwitch =
        sig.switchSignalId !== null
          ? (localToGlobalSigId.get(sig.switchSignalId) ?? null)
          : null;

      mergedSignals.push({
        ...sig,
        signalId: assignedId,
        switchSignalId: remappedSwitch,
      });
    }

    for (const msg of schema.messages) {
      const remappedSignalIds = msg.signalIds
        .map((localId) => localToGlobalSigId.get(localId))
        .filter((id): id is number => id !== undefined);

      const remappedBitLayout: BitCellDto[] = msg.bitLayout
        .map((cell) => {
          const mappedSigId = localToGlobalSigId.get(cell.signalId);
          if (mappedSigId === undefined) return null;
          return {
            ...cell,
            signalId: mappedSigId,
            switchSignalId:
              cell.switchSignalId !== null
                ? (localToGlobalSigId.get(cell.switchSignalId) ?? null)
                : null,
          };
        })
        .filter((cell): cell is BitCellDto => cell !== null);

      const existingMsg = messageByKey.get(msg.messageKey);
      if (!existingMsg) {
        messageByKey.set(msg.messageKey, {
          ...msg,
          signalIds: remappedSignalIds,
          bitLayout: remappedBitLayout,
          masterSwitchId:
            msg.masterSwitchId !== null
              ? (localToGlobalSigId.get(msg.masterSwitchId) ?? null)
              : null,
        });
      } else {
        messageByKey.set(msg.messageKey, {
          ...existingMsg,
          dlc: Math.max(existingMsg.dlc, msg.dlc),
          signalIds: [...existingMsg.signalIds, ...remappedSignalIds],
          bitLayout: [...existingMsg.bitLayout, ...remappedBitLayout],
        });
      }
    }
  }

  const mergedMessages = Array.from(messageByKey.values());
  return {
    info: {
      name: `${entries.length} .DBC / .KCD`,
      version: null,
      format: 'MULTI',
      sourceEncoding: 'UTF-8',
      messageCount: mergedMessages.length,
      signalCount: mergedSignals.length,
      diagnostics: [],
    },
    ecus: Array.from(ecuByName.values()),
    messages: mergedMessages,
    signals: mergedSignals,
  };
}

export const ACCENT_HEX_MAP: Record<SimulationAccentColor, string> = {
  steel: '#8b94a0',
  cyan: '#0e8ac8',
  emerald: '#2ea043',
  amber: '#d29922',
  red: '#e5534b',
  blue: '#3b82f6',
};

export const TRACE_PALETTE = [
  '#0e8ac8',
  '#2ea043',
  '#d29922',
  '#e5534b',
  '#3b82f6',
  '#14b8a6',
] as const;

export type SignalThresholdZone = 'nominal' | 'warning' | 'critical';

export function makeSignalBusKey(messageKey: string, signalName: string): string {
  return `${messageKey}::${signalName}`;
}

export function createClientUid(prefix: string): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
  }
  return `${prefix}-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 7)}`;
}

export function inferDecimalsFromFactor(factor: number): number {
  const abs = Math.abs(factor);
  if (!Number.isFinite(abs) || abs === 0 || Number.isInteger(abs)) {
    return 0;
  }
  if (abs >= 0.1) return 1;
  if (abs >= 0.01) return 2;
  if (abs >= 0.001) return 3;
  if (abs >= 0.0001) return 4;
  if (abs >= 0.00001) return 5;
  return 6;
}

function splitSignalTokens(signalName: string): string[] {
  return signalName
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0);
}

export function isLatitudeSignalName(signalName: string): boolean {
  const lower = signalName.toLowerCase();
  if (
    lower.includes('lateral') ||
    lower.includes('latacc') ||
    lower.includes('latch') ||
    lower.includes('latency')
  ) {
    return false;
  }
  if (lower.includes('latitude')) {
    return true;
  }
  const tokens = splitSignalTokens(signalName);
  return tokens.includes('lat');
}

export function isLongitudeSignalName(signalName: string): boolean {
  const lower = signalName.toLowerCase();
  if (lower.includes('longitudinal') || lower.includes('longacc')) {
    return false;
  }
  if (lower.includes('longitude')) {
    return true;
  }
  const tokens = splitSignalTokens(signalName);
  return (
    tokens.includes('lon') ||
    tokens.includes('lng') ||
    tokens.includes('long')
  );
}

export function isHeadingSignalName(signalName: string): boolean {
  const lower = signalName.toLowerCase();
  if (lower.includes('yawrate') || lower.includes('yaw_rate')) {
    return false;
  }
  if (
    lower.includes('heading') ||
    lower.includes('course') ||
    lower.includes('bearing') ||
    lower.includes('azimuth')
  ) {
    return true;
  }
  const tokens = splitSignalTokens(signalName);
  return (
    tokens.includes('hdg') ||
    tokens.includes('cog') ||
    tokens.includes('yaw')
  );
}

export function isSpeedSignalName(signalName: string): boolean {
  const lower = signalName.toLowerCase();
  if (
    lower.includes('wheelspeed') ||
    lower.includes('enginespeed') ||
    lower.includes('fanspeed') ||
    lower.includes('motorspeed')
  ) {
    return false;
  }
  if (
    lower.includes('groundspeed') ||
    lower.includes('gpsspeed') ||
    lower.includes('gnssspeed') ||
    lower.includes('vehiclespeed') ||
    lower.includes('vehspeed')
  ) {
    return true;
  }
  const tokens = splitSignalTokens(signalName);
  return (
    tokens.includes('sog') ||
    tokens.includes('speed') ||
    tokens.includes('spd') ||
    tokens.includes('velocity')
  );
}

export interface GnssSiblingSet {
  lat: { msg: MessageSchemaDto; sig: SignalSchemaDto } | null;
  lon: { msg: MessageSchemaDto; sig: SignalSchemaDto } | null;
  heading: { msg: MessageSchemaDto; sig: SignalSchemaDto } | null;
  speed: { msg: MessageSchemaDto; sig: SignalSchemaDto } | null;
}

export function findGnssSiblingsInMessage(
  msg: MessageSchemaDto,
  schema: DatabaseSchemaDto
): GnssSiblingSet {
  const msgSignals = schema.signals.filter(
    (s) => s.messageKey === msg.messageKey
  );
  const latSig = msgSignals.find((s) => isLatitudeSignalName(s.name)) ?? null;
  const lonSig =
    msgSignals.find(
      (s) => s.name !== latSig?.name && isLongitudeSignalName(s.name)
    ) ?? null;
  const headingSig =
    msgSignals.find(
      (s) =>
        s.name !== latSig?.name &&
        s.name !== lonSig?.name &&
        isHeadingSignalName(s.name)
    ) ?? null;
  const speedSig =
    msgSignals.find(
      (s) =>
        s.name !== latSig?.name &&
        s.name !== lonSig?.name &&
        s.name !== headingSig?.name &&
        isSpeedSignalName(s.name)
    ) ?? null;

  return {
    lat: latSig ? { msg, sig: latSig } : null,
    lon: lonSig ? { msg, sig: lonSig } : null,
    heading: headingSig ? { msg, sig: headingSig } : null,
    speed: speedSig ? { msg, sig: speedSig } : null,
  };
}

export function findSchemaGnssPair(
  schema: DatabaseSchemaDto
): GnssSiblingSet | null {
  const msgMap = new Map<string, MessageSchemaDto>();
  for (const m of schema.messages) {
    msgMap.set(m.messageKey, m);
  }

  // Prefer a single CAN message containing both lat & lon
  for (const msg of schema.messages) {
    const siblings = findGnssSiblingsInMessage(msg, schema);
    if (siblings.lat && siblings.lon) {
      if (!siblings.heading || !siblings.speed) {
        for (const sig of schema.signals) {
          const sMsg = msgMap.get(sig.messageKey);
          if (!sMsg) continue;
          if (!siblings.heading && isHeadingSignalName(sig.name)) {
            siblings.heading = { msg: sMsg, sig };
          } else if (!siblings.speed && isSpeedSignalName(sig.name)) {
            siblings.speed = { msg: sMsg, sig };
          }
        }
      }
      return siblings;
    }
  }

  // Fallback: lat & lon across different messages in the same schema
  let latPair: { msg: MessageSchemaDto; sig: SignalSchemaDto } | null = null;
  let lonPair: { msg: MessageSchemaDto; sig: SignalSchemaDto } | null = null;
  let headingPair: { msg: MessageSchemaDto; sig: SignalSchemaDto } | null = null;
  let speedPair: { msg: MessageSchemaDto; sig: SignalSchemaDto } | null = null;

  for (const sig of schema.signals) {
    const msg = msgMap.get(sig.messageKey);
    if (!msg) continue;
    if (!latPair && isLatitudeSignalName(sig.name)) {
      latPair = { msg, sig };
    } else if (!lonPair && isLongitudeSignalName(sig.name)) {
      lonPair = { msg, sig };
    } else if (!headingPair && isHeadingSignalName(sig.name)) {
      headingPair = { msg, sig };
    } else if (!speedPair && isSpeedSignalName(sig.name)) {
      speedPair = { msg, sig };
    }
  }

  if (latPair && lonPair) {
    return {
      lat: latPair,
      lon: lonPair,
      heading: headingPair,
      speed: speedPair,
    };
  }
  return null;
}

export function resolveSignalZone(
  value: number,
  config: Pick<
    SimulationWidgetConfigDto,
    'warnLow' | 'warnHigh' | 'critLow' | 'critHigh'
  >
): SignalThresholdZone {
  if (
    typeof config.critLow === 'number' &&
    Number.isFinite(config.critLow) &&
    value <= config.critLow
  ) {
    return 'critical';
  }
  if (
    typeof config.critHigh === 'number' &&
    Number.isFinite(config.critHigh) &&
    value >= config.critHigh
  ) {
    return 'critical';
  }
  if (
    typeof config.warnLow === 'number' &&
    Number.isFinite(config.warnLow) &&
    value <= config.warnLow
  ) {
    return 'warning';
  }
  if (
    typeof config.warnHigh === 'number' &&
    Number.isFinite(config.warnHigh) &&
    value >= config.warnHigh
  ) {
    return 'warning';
  }
  return 'nominal';
}

export function zoneColorCss(
  zone: SignalThresholdZone,
  accent: SimulationAccentColor
): string {
  if (zone === 'critical') return 'var(--status-critical)';
  if (zone === 'warning') return 'var(--status-warn)';
  return ACCENT_HEX_MAP[accent];
}

export function synthesizeWaveformValue(
  spec: SimulationGeneratorSpecDto,
  tSec: number
): number {
  if (spec.waveform === 'constant') {
    return spec.constantValue;
  }

  const lo = Math.min(spec.min, spec.max);
  const hi = Math.max(spec.min, spec.max);
  const span = hi - lo;
  if (span <= 1e-9) {
    return lo;
  }

  const freq = Math.max(0.05, Math.min(50, spec.frequencyHz));
  const phase = ((tSec * freq) % 1 + 1) % 1;

  switch (spec.waveform) {
    case 'sine': {
      const mid = (lo + hi) * 0.5;
      const amp = span * 0.5;
      return mid + amp * Math.sin(phase * Math.PI * 2);
    }
    case 'triangle': {
      return phase < 0.5
        ? lo + span * (phase * 2)
        : hi - span * ((phase - 0.5) * 2);
    }
    case 'sawtooth': {
      return lo + span * phase;
    }
    case 'square': {
      return phase < 0.5 ? hi : lo;
    }
    default:
      return lo;
  }
}

export function physicalToRawIntAndHex(
  physicalValue: number,
  binding: SimulationSignalBindingDto | null,
  schemaSig?: SignalSchemaDto | null
): { rawInt: number; hex: string } {
  const factor =
    schemaSig?.factor ??
    (binding && binding.factor !== 0 ? binding.factor : 1);
  const offset = schemaSig?.offset ?? binding?.offset ?? 0;
  const bitLength = Math.max(1, Math.min(64, schemaSig?.bitLength ?? 16));
  const safeFactor = Math.abs(factor) < 1e-12 ? 1 : factor;

  const rawFloat = (physicalValue - offset) / safeFactor;

  if (schemaSig?.valueType === 'float32' && bitLength === 32) {
    const buf = new ArrayBuffer(4);
    const dv = new DataView(buf);
    dv.setFloat32(0, physicalValue, true);
    const u32 = dv.getUint32(0, true);
    return {
      rawInt: u32,
      hex: `0x${u32.toString(16).toUpperCase().padStart(8, '0')}`,
    };
  }

  if (schemaSig?.valueType === 'float64' && bitLength === 64) {
    const buf = new ArrayBuffer(8);
    const dv = new DataView(buf);
    dv.setFloat64(0, physicalValue, true);
    const u64 = dv.getBigUint64(0, true);
    return {
      rawInt: Math.round(rawFloat),
      hex: `0x${u64.toString(16).toUpperCase().padStart(16, '0')}`,
    };
  }

  const rounded = Number.isFinite(rawFloat) ? Math.round(rawFloat) : 0;
  let bigVal = BigInt(rounded);

  if (schemaSig?.valueType === 'unsigned') {
    const maxUnsigned = (1n << BigInt(bitLength)) - 1n;
    if (bigVal < 0n) bigVal = 0n;
    if (bigVal > maxUnsigned) bigVal = maxUnsigned;
  } else if (schemaSig?.valueType === 'signed') {
    const minSigned = -(1n << BigInt(bitLength - 1));
    const maxSigned = (1n << BigInt(bitLength - 1)) - 1n;
    if (bigVal < minSigned) bigVal = minSigned;
    if (bigVal > maxSigned) bigVal = maxSigned;
  }

  const unsignedBits = BigInt.asUintN(bitLength, bigVal);
  const nibbles = Math.max(2, Math.ceil(bitLength / 4));
  return {
    rawInt: Number(bigVal),
    hex: `0x${unsignedBits.toString(16).toUpperCase().padStart(nibbles, '0')}`,
  };
}

function encodeSignalBits(
  physicalValue: number,
  sig: Pick<
    SignalSchemaDto,
    'startBit' | 'bitLength' | 'byteOrder' | 'valueType' | 'factor' | 'offset'
  >,
  bytes: Uint8Array
): void {
  const bitLen = Math.max(1, Math.min(64, sig.bitLength));
  const safeFactor = Math.abs(sig.factor) < 1e-12 ? 1 : sig.factor;
  let rawUnsigned = 0n;

  if (sig.valueType === 'float32' && bitLen === 32) {
    const buf = new ArrayBuffer(4);
    const dv = new DataView(buf);
    dv.setFloat32(0, physicalValue, true);
    rawUnsigned = BigInt(dv.getUint32(0, true));
  } else if (sig.valueType === 'float64' && bitLen === 64) {
    const buf = new ArrayBuffer(8);
    const dv = new DataView(buf);
    dv.setFloat64(0, physicalValue, true);
    rawUnsigned = dv.getBigUint64(0, true);
  } else {
    const rawFloat = (physicalValue - sig.offset) / safeFactor;
    let rawInt = BigInt(Number.isFinite(rawFloat) ? Math.round(rawFloat) : 0);
    if (sig.valueType === 'unsigned') {
      const maxU = (1n << BigInt(bitLen)) - 1n;
      if (rawInt < 0n) rawInt = 0n;
      if (rawInt > maxU) rawInt = maxU;
    } else {
      const minS = -(1n << BigInt(bitLen - 1));
      const maxS = (1n << BigInt(bitLen - 1)) - 1n;
      if (rawInt < minS) rawInt = minS;
      if (rawInt > maxS) rawInt = maxS;
    }
    rawUnsigned = BigInt.asUintN(bitLen, rawInt);
  }

  if (sig.byteOrder === 'littleEndian') {
    for (let i = 0; i < bitLen; i += 1) {
      const bitVal = Number((rawUnsigned >> BigInt(i)) & 1n);
      const linearBit = sig.startBit + i;
      const byteIdx = Math.floor(linearBit / 8);
      const bitInByte = linearBit % 8;
      if (byteIdx >= 0 && byteIdx < bytes.length && bitVal === 1) {
        bytes[byteIdx] = (bytes[byteIdx] ?? 0) | (1 << bitInByte);
      }
    }
  } else {
    // Big-Endian Motorola (@0 sawtooth): startBit is MSB
    let byteIdx = Math.floor(sig.startBit / 8);
    let bitInByte = sig.startBit % 8;
    for (let i = 0; i < bitLen; i += 1) {
      const sigBitIdx = bitLen - 1 - i;
      const bitVal = Number((rawUnsigned >> BigInt(sigBitIdx)) & 1n);
      if (byteIdx >= 0 && byteIdx < bytes.length && bitVal === 1) {
        bytes[byteIdx] = (bytes[byteIdx] ?? 0) | (1 << bitInByte);
      }
      if (bitInByte === 0) {
        byteIdx += 1;
        bitInByte = 7;
      } else {
        bitInByte -= 1;
      }
    }
  }
}

export interface PackedVirtualSignalSummary {
  signalName: string;
  physicalValue: number;
  unit: string;
  startBit: number;
  bitLength: number;
  byteOrder: 'littleEndian' | 'bigEndian';
  decimals?: number;
}

export interface PackedVirtualCanFrame {
  busId: number;
  messageKey: string;
  messageName: string;
  arbId: number;
  isExtended: boolean;
  isFd: boolean;
  dlc: number;
  rawBytes: number[];
  changedByteIndices: number[];
  fromDbcSchema: boolean;
  signals: PackedVirtualSignalSummary[];
}

export function collectPanelBindings(
  widgets: readonly SimulationWidgetDto[],
  generators: readonly SimulationGeneratorSpecDto[]
): SimulationSignalBindingDto[] {
  const map = new Map<string, SimulationSignalBindingDto>();
  for (const w of widgets) {
    if (w.binding) {
      map.set(
        makeSignalBusKey(w.binding.messageKey, w.binding.signalName),
        w.binding
      );
    }
    if (w.config.lonBinding) {
      map.set(
        makeSignalBusKey(
          w.config.lonBinding.messageKey,
          w.config.lonBinding.signalName
        ),
        w.config.lonBinding
      );
    }
    if (w.config.headingBinding) {
      map.set(
        makeSignalBusKey(
          w.config.headingBinding.messageKey,
          w.config.headingBinding.signalName
        ),
        w.config.headingBinding
      );
    }
    if (w.config.speedBinding) {
      map.set(
        makeSignalBusKey(
          w.config.speedBinding.messageKey,
          w.config.speedBinding.signalName
        ),
        w.config.speedBinding
      );
    }
    if (w.config.extraBindings) {
      for (const extra of w.config.extraBindings) {
        map.set(makeSignalBusKey(extra.messageKey, extra.signalName), extra);
      }
    }
  }
  for (const g of generators) {
    map.set(
      makeSignalBusKey(g.binding.messageKey, g.binding.signalName),
      g.binding
    );
  }
  return Array.from(map.values());
}

export function packVirtualCanFrames(
  bindings: readonly SimulationSignalBindingDto[],
  signalBus: ReadonlyMap<string, number>,
  schema: DatabaseSchemaDto | null,
  prevBytesByMsgKey: Map<string, number[]>
): PackedVirtualCanFrame[] {
  if (bindings.length === 0) {
    return [];
  }

  const schemaMsgByKey = new Map<string, MessageSchemaDto>();
  const schemaSignalsByMsgKey = new Map<string, SignalSchemaDto[]>();
  if (schema) {
    for (const m of schema.messages) {
      schemaMsgByKey.set(m.messageKey, m);
    }
    for (const s of schema.signals) {
      const list = schemaSignalsByMsgKey.get(s.messageKey) ?? [];
      list.push(s);
      schemaSignalsByMsgKey.set(s.messageKey, list);
    }
  }

  const bindingsByFrameKey = new Map<string, SimulationSignalBindingDto[]>();
  for (const b of bindings) {
    const frameKey = `${b.busId}::${b.messageKey}`;
    const arr = bindingsByFrameKey.get(frameKey) ?? [];
    arr.push(b);
    bindingsByFrameKey.set(frameKey, arr);
  }

  const frames: PackedVirtualCanFrame[] = [];

  for (const [frameGroupKey, msgBindings] of bindingsByFrameKey.entries()) {
    const firstBinding = msgBindings[0];
    if (!firstBinding) continue;
    const messageKey = firstBinding.messageKey;

    const schemaMsg = schemaMsgByKey.get(messageKey) ?? null;
    const schemaSigs = schemaSignalsByMsgKey.get(messageKey) ?? [];
    const synthBytesNeeded = msgBindings.reduce(
      (sum, mb) => sum + (mb.decimals >= 4 && mb.factor === 1 ? 4 : 2),
      0
    );
    const dlc = schemaMsg
      ? Math.max(1, Math.min(64, schemaMsg.dlc || 8))
      : Math.min(64, Math.max(8, synthBytesNeeded));
    const bytes = new Uint8Array(dlc);
    const summaries: PackedVirtualSignalSummary[] = [];

    if (schemaMsg && schemaSigs.length > 0) {
      for (const sig of schemaSigs) {
        const key = makeSignalBusKey(messageKey, sig.name);
        const phys =
          signalBus.get(key) ??
          (sig.initialValue !== null ? sig.initialValue : 0);
        encodeSignalBits(phys, sig, bytes);
        const matchedBinding = msgBindings.find(
          (mb) => mb.signalName === sig.name
        );
        if (signalBus.has(key) || matchedBinding) {
          const inferredDec =
            isLatitudeSignalName(sig.name) || isLongitudeSignalName(sig.name)
              ? Math.max(5, inferDecimalsFromFactor(sig.factor))
              : sig.valueType === 'float32' || sig.valueType === 'float64'
                ? 2
                : inferDecimalsFromFactor(sig.factor);
          summaries.push({
            signalName: sig.name,
            physicalValue: phys,
            unit: sig.unit,
            startBit: sig.startBit,
            bitLength: sig.bitLength,
            byteOrder: sig.byteOrder,
            decimals: matchedBinding?.decimals ?? inferredDec,
          });
        }
      }

      // Also pack any bound manual signal on that message not found in schemaSigs
      let fallbackBit = schemaSigs.reduce(
        (acc, s) => Math.max(acc, s.startBit + s.bitLength),
        0
      );
      fallbackBit = Math.ceil(fallbackBit / 8) * 8;
      for (const mb of msgBindings) {
        if (schemaSigs.some((s) => s.name === mb.signalName)) continue;
        const key = makeSignalBusKey(messageKey, mb.signalName);
        const phys = signalBus.get(key) ?? mb.min;
        const useFloat32 = mb.decimals >= 4 && mb.factor === 1;
        const bitWidth = useFloat32 ? 32 : 16;
        if (fallbackBit + bitWidth <= dlc * 8) {
          encodeSignalBits(
            phys,
            {
              startBit: fallbackBit,
              bitLength: bitWidth,
              byteOrder: 'littleEndian',
              valueType: useFloat32
                ? 'float32'
                : mb.min < 0
                  ? 'signed'
                  : 'unsigned',
              factor: mb.factor,
              offset: mb.offset,
            },
            bytes
          );
          summaries.push({
            signalName: mb.signalName,
            physicalValue: phys,
            unit: mb.unit,
            startBit: fallbackBit,
            bitLength: bitWidth,
            byteOrder: 'littleEndian',
            decimals: mb.decimals,
          });
          fallbackBit += bitWidth;
        }
      }
    } else {
      // Synthetic Intel packing when no DBC schema is uploaded yet (IEEE-754 float32 for high-precision GPS coords)
      let startBit = 0;
      for (const mb of msgBindings) {
        const key = makeSignalBusKey(messageKey, mb.signalName);
        const phys = signalBus.get(key) ?? mb.min;
        const useFloat32 = mb.decimals >= 4 && mb.factor === 1;
        const bitWidth = useFloat32 ? 32 : 16;
        if (startBit + bitWidth <= dlc * 8) {
          encodeSignalBits(
            phys,
            {
              startBit,
              bitLength: bitWidth,
              byteOrder: 'littleEndian',
              valueType: useFloat32
                ? 'float32'
                : mb.min < 0
                  ? 'signed'
                  : 'unsigned',
              factor: mb.factor,
              offset: mb.offset,
            },
            bytes
          );
        }
        summaries.push({
          signalName: mb.signalName,
          physicalValue: phys,
          unit: mb.unit,
          startBit,
          bitLength: bitWidth,
          byteOrder: 'littleEndian',
          decimals: mb.decimals,
        });
        startBit += bitWidth;
      }
    }

    const rawBytes = Array.from(bytes);
    const prev = prevBytesByMsgKey.get(frameGroupKey);
    const changedByteIndices: number[] = [];
    if (prev && prev.length === rawBytes.length) {
      for (let i = 0; i < rawBytes.length; i += 1) {
        if (prev[i] !== rawBytes[i]) {
          changedByteIndices.push(i);
        }
      }
    }
    prevBytesByMsgKey.set(frameGroupKey, rawBytes);

    frames.push({
      busId: firstBinding.busId,
      messageKey,
      messageName:
        schemaMsg?.name || firstBinding.messageName || 'VirtualMessage',
      arbId: schemaMsg?.arbId ?? firstBinding.arbId,
      isExtended: schemaMsg?.isExtended ?? firstBinding.isExtended,
      isFd: schemaMsg ? schemaMsg.protocol === 'CAN_FD' || dlc > 8 : dlc > 8,
      dlc,
      rawBytes,
      changedByteIndices,
      fromDbcSchema: schemaMsg !== null && schemaSigs.length > 0,
      signals: summaries,
    });
  }

  frames.sort((a, b) => a.busId - b.busId || a.arbId - b.arbId);
  return frames;
}

export function signalSchemaToBinding(
  msg: MessageSchemaDto,
  sig: SignalSchemaDto,
  busId = 0,
  color = '#0e8ac8',
  dbMeta?: SignalBindingDbMeta
): SimulationSignalBindingDto {
  const hasValidBounds =
    Number.isFinite(sig.min) &&
    Number.isFinite(sig.max) &&
    sig.max > sig.min;
  const defaultMax =
    sig.bitLength === 1
      ? 1
      : Math.max(
          100,
          sig.offset +
            ((1 << Math.min(16, sig.bitLength)) - 1) * Math.abs(sig.factor || 1)
        );
  const min = hasValidBounds ? sig.min : sig.offset;
  const max = hasValidBounds ? sig.max : defaultMax;

  const isGnssCoord =
    isLatitudeSignalName(sig.name) || isLongitudeSignalName(sig.name);
  const baseDecimals = inferDecimalsFromFactor(sig.factor);
  const decimals = isGnssCoord
    ? Math.max(baseDecimals, 6)
    : sig.valueType === 'float32' || sig.valueType === 'float64'
      ? Math.max(baseDecimals, 2)
      : baseDecimals;

  return {
    ...(dbMeta?.databaseId ? { databaseId: dbMeta.databaseId } : {}),
    ...(dbMeta?.databaseName ? { databaseName: dbMeta.databaseName } : {}),
    busId,
    messageKey: msg.messageKey,
    messageName: msg.name,
    arbId: msg.arbId,
    isExtended: msg.isExtended,
    signalName: sig.name,
    unit: sig.unit,
    min,
    max,
    factor: sig.factor !== 0 ? sig.factor : 1,
    offset: sig.offset,
    decimals: Math.min(6, decimals),
    color,
  };
}

export function enumTableToComboOptions(
  enumTable: Record<string, string>
): SimulationComboOptionDto[] {
  const entries: SimulationComboOptionDto[] = [];
  for (const [k, label] of Object.entries(enumTable)) {
    const num = Number(k);
    if (Number.isFinite(num) && label.trim().length > 0) {
      entries.push({
        value: num,
        label: `${num} : ${label.trim()}`,
      });
    }
  }
  entries.sort((a, b) => a.value - b.value);
  return entries;
}

export const DEFAULT_WIDGET_SIZES: Record<
  SimulationWidgetKind,
  { w: number; h: number; title: string; accent: SimulationAccentColor }
> = {
  gauge: { w: 6, h: 6, title: 'Dial Gauge', accent: 'cyan' },
  bar: { w: 6, h: 4, title: 'Level Meter', accent: 'emerald' },
  numeric: { w: 5, h: 3, title: 'Digital Readout', accent: 'cyan' },
  led: { w: 4, h: 3, title: 'Status Lamp', accent: 'emerald' },
  enum_badge: { w: 5, h: 3, title: 'Symbolic State', accent: 'blue' },
  graph: { w: 12, h: 6, title: 'Oscilloscope Trend', accent: 'cyan' },
  map: { w: 10, h: 7, title: 'GNSS Slippy Map', accent: 'cyan' },
  button: { w: 4, h: 3, title: 'Push Control', accent: 'amber' },
  checkbox: { w: 4, h: 3, title: 'Enable Switch', accent: 'emerald' },
  combobox: { w: 6, h: 3, title: 'State Selector', accent: 'blue' },
  slider: { w: 8, h: 3, title: 'Setpoint Fader', accent: 'cyan' },
  group: { w: 12, h: 8, title: 'ECU Subsystem Group', accent: 'steel' },
};

function rectanglesOverlap(
  a: SimulationWidgetLayoutDto,
  b: SimulationWidgetLayoutDto
): boolean {
  return !(
    a.col + a.w <= b.col ||
    b.col + b.w <= a.col ||
    a.row + a.h <= b.row ||
    b.row + b.h <= a.row
  );
}

export function isWidgetInsideGroup(
  widget: SimulationWidgetDto,
  group: SimulationWidgetDto
): boolean {
  if (
    widget.id === group.id ||
    widget.kind === 'group' ||
    group.kind !== 'group'
  ) {
    return false;
  }
  const centerX = widget.layout.col + widget.layout.w / 2;
  const centerY = widget.layout.row + widget.layout.h / 2;
  return (
    centerX >= group.layout.col &&
    centerX <= group.layout.col + group.layout.w &&
    centerY >= group.layout.row &&
    centerY <= group.layout.row + group.layout.h
  );
}

export function findContainingGroup(
  layout: SimulationWidgetLayoutDto,
  widgets: readonly SimulationWidgetDto[]
): SimulationWidgetDto | null {
  const centerX = layout.col + layout.w / 2;
  const centerY = layout.row + layout.h / 2;
  let bestGroup: SimulationWidgetDto | null = null;
  let bestArea = Number.POSITIVE_INFINITY;

  for (const item of widgets) {
    if (item.kind !== 'group') continue;
    const g = item.layout;
    if (
      centerX >= g.col &&
      centerX <= g.col + g.w &&
      centerY >= g.row &&
      centerY <= g.row + g.h
    ) {
      const area = g.w * g.h;
      if (area < bestArea) {
        bestArea = area;
        bestGroup = item;
      }
    }
  }

  return bestGroup;
}

export function findNextFreeGridSlot(
  existing: readonly SimulationWidgetDto[],
  w: number,
  h: number,
  gridCols: number
): SimulationWidgetLayoutDto {
  const safeW = Math.max(1, Math.min(gridCols, w));
  const safeH = Math.max(1, Math.min(48, h));

  for (let row = 0; row < 400; row += 1) {
    for (let col = 0; col <= gridCols - safeW; col += 1) {
      const candidate: SimulationWidgetLayoutDto = {
        col,
        row,
        w: safeW,
        h: safeH,
      };
      const collides = existing.some((item) =>
        rectanglesOverlap(candidate, item.layout)
      );
      if (!collides) {
        return candidate;
      }
    }
  }

  const maxBottom = existing.reduce(
    (acc, item) => Math.max(acc, item.layout.row + item.layout.h),
    0
  );
  return { col: 0, row: Math.min(399, maxBottom), w: safeW, h: safeH };
}

export function placeWidgetInsideGroup(
  group: SimulationWidgetDto,
  existing: readonly SimulationWidgetDto[],
  w: number,
  h: number,
  gridCols: number,
  preferredCell?: { col: number; row: number }
): {
  childLayout: SimulationWidgetLayoutDto;
  updatedGroupLayout: SimulationWidgetLayoutDto;
} {
  const minRow = Math.min(399, group.layout.row + 1);
  const safeH = Math.max(1, Math.min(48, h));
  const maxAllowedGroupW = Math.max(1, Math.min(24, gridCols - group.layout.col));
  const nextGroupW =
    w > group.layout.w
      ? Math.min(maxAllowedGroupW, Math.max(group.layout.w, w))
      : Math.min(maxAllowedGroupW, group.layout.w);
  const safeW = Math.max(1, Math.min(w, nextGroupW));

  const obstacles = existing.filter(
    (item) => item.kind !== 'group' && item.id !== group.id
  );

  const maxColInGroup = Math.min(
    23,
    Math.max(group.layout.col, group.layout.col + nextGroupW - safeW)
  );
  const maxRowForGroup = Math.min(
    399,
    Math.max(minRow, group.layout.row + 48 - safeH)
  );

  let chosen: SimulationWidgetLayoutDto | null = null;

  if (preferredCell) {
    const prefCol = Math.max(
      group.layout.col,
      Math.min(maxColInGroup, Math.floor(preferredCell.col))
    );
    const prefRow = Math.max(
      minRow,
      Math.min(maxRowForGroup, Math.floor(preferredCell.row))
    );
    const prefCandidate: SimulationWidgetLayoutDto = {
      col: prefCol,
      row: prefRow,
      w: safeW,
      h: safeH,
    };
    const collides = obstacles.some((obs) =>
      rectanglesOverlap(prefCandidate, obs.layout)
    );
    if (!collides) {
      chosen = prefCandidate;
    }
  }

  if (!chosen) {
    for (let row = minRow; row <= maxRowForGroup; row += 1) {
      for (let col = group.layout.col; col <= maxColInGroup; col += 1) {
        const candidate: SimulationWidgetLayoutDto = {
          col,
          row,
          w: safeW,
          h: safeH,
        };
        const collides = obstacles.some((obs) =>
          rectanglesOverlap(candidate, obs.layout)
        );
        if (!collides) {
          chosen = candidate;
          break;
        }
      }
      if (chosen) break;
    }
  }

  const childLayout: SimulationWidgetLayoutDto = chosen ?? {
    col: group.layout.col,
    row: minRow,
    w: safeW,
    h: safeH,
  };

  const neededGroupH = childLayout.row + childLayout.h - group.layout.row;
  const nextGroupH = Math.min(48, Math.max(2, group.layout.h, neededGroupH));

  const updatedGroupLayout: SimulationWidgetLayoutDto = {
    col: group.layout.col,
    row: group.layout.row,
    w: nextGroupW,
    h: nextGroupH,
  };

  return { childLayout, updatedGroupLayout };
}

export interface SignalBoundContextInput {
  msg: MessageSchemaDto;
  sig: SignalSchemaDto;
  db?: Pick<NetworkDatabaseSummaryDto, 'id' | 'name' | 'busAssignment'>;
  busId?: number;
}

export const SIM_PALETTE_DRAG_MIME = 'application/x-nexus-sim-palette';

export interface PaletteDragPayload {
  kind: SimulationWidgetKind;
  boundContext?: SignalBoundContextInput | null;
}

const VALID_WIDGET_KINDS: ReadonlySet<string> = new Set<SimulationWidgetKind>([
  'gauge',
  'bar',
  'numeric',
  'led',
  'enum_badge',
  'graph',
  'map',
  'button',
  'checkbox',
  'combobox',
  'slider',
  'group',
]);

export function parsePaletteDragPayload(raw: string): PaletteDragPayload | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || !('kind' in parsed)) {
      return null;
    }
    const candidate = parsed as Record<string, unknown>;
    if (
      typeof candidate.kind !== 'string' ||
      !VALID_WIDGET_KINDS.has(candidate.kind)
    ) {
      return null;
    }
    const kind = candidate.kind as SimulationWidgetKind;
    let boundContext: SignalBoundContextInput | null = null;
    if (
      typeof candidate.boundContext === 'object' &&
      candidate.boundContext !== null &&
      'msg' in candidate.boundContext &&
      'sig' in candidate.boundContext
    ) {
      boundContext = candidate.boundContext as SignalBoundContextInput;
    }
    return { kind, boundContext };
  } catch {
    return null;
  }
}

export function createDefaultWidget(
  kind: SimulationWidgetKind,
  existing: readonly SimulationWidgetDto[],
  gridCols: number,
  boundContext?: SignalBoundContextInput | null,
  schema?: DatabaseSchemaDto | null
): SimulationWidgetDto {
  const meta = DEFAULT_WIDGET_SIZES[kind];
  const layout = findNextFreeGridSlot(existing, meta.w, meta.h, gridCols);
  const resolvedBusId =
    boundContext?.busId ??
    (boundContext?.db
      ? inferBusIdFromAssignment(boundContext.db.busAssignment)
      : 0);
  const dbMeta: SignalBindingDbMeta | undefined = boundContext?.db
    ? { databaseId: boundContext.db.id, databaseName: boundContext.db.name }
    : undefined;

  let binding =
    kind === 'group' || !boundContext
      ? null
      : signalSchemaToBinding(
          boundContext.msg,
          boundContext.sig,
          resolvedBusId,
          ACCENT_HEX_MAP[meta.accent],
          dbMeta
        );

  const enumMap = boundContext?.sig.enumTable ?? {};
  const comboOptions = enumTableToComboOptions(enumMap);
  const min = binding?.min ?? 0;
  const max = binding?.max ?? 100;
  const span = Math.max(1, max - min);

  let resolvedTitle = boundContext ? boundContext.sig.name : meta.title;
  const config: SimulationWidgetConfigDto = {};

  switch (kind) {
    case 'gauge':
      config.min = min;
      config.max = max;
      config.majorTicks = 6;
      config.warnHigh = Number((min + span * 0.8).toFixed(2));
      config.critHigh = Number((min + span * 0.92).toFixed(2));
      config.showNeedle = true;
      config.showDigital = true;
      break;
    case 'bar':
      config.min = min;
      config.max = max;
      config.orientation = 'horizontal';
      config.majorTicks = 5;
      config.warnHigh = Number((min + span * 0.8).toFixed(2));
      config.critHigh = Number((min + span * 0.92).toFixed(2));
      config.showPeakHold = true;
      break;
    case 'numeric':
      config.fontSize = 'lg';
      config.showRawHex = true;
      break;
    case 'led':
      config.ledOperator = 'gte';
      config.ledThreshold = 1;
      config.onLabel = 'ACTIVE';
      config.offLabel = 'IDLE';
      break;
    case 'enum_badge':
      config.enumMap = { ...enumMap };
      break;
    case 'graph':
      config.timeWindowSec = 15;
      config.autoScaleY = true;
      config.showLegend = true;
      config.extraBindings = [];
      break;
    case 'map': {
      config.mapZoom = 15;
      config.mapCenterLat = 41.0082;
      config.mapCenterLon = 28.9784;
      config.mapTileStyle = 'osm_standard';
      config.mapAutoFollow = true;
      config.mapShowTrail = true;
      config.mapTrailMaxPoints = 400;
      config.mapClickToSimulate = true;
      config.lonBinding = null;
      config.headingBinding = null;
      config.speedBinding = null;

      if (boundContext && schema) {
        const siblings = findGnssSiblingsInMessage(boundContext.msg, schema);
        if (isLongitudeSignalName(boundContext.sig.name) && siblings.lat) {
          binding = signalSchemaToBinding(
            siblings.lat.msg,
            siblings.lat.sig,
            resolvedBusId,
            ACCENT_HEX_MAP[meta.accent],
            dbMeta
          );
          config.lonBinding = signalSchemaToBinding(
            boundContext.msg,
            boundContext.sig,
            resolvedBusId,
            TRACE_PALETTE[1],
            dbMeta
          );
          resolvedTitle = `${boundContext.msg.name} // GNSS MAP`;
        } else {
          if (binding) {
            binding = { ...binding, decimals: Math.max(binding.decimals, 6) };
          }
          if (siblings.lon) {
            config.lonBinding = signalSchemaToBinding(
              siblings.lon.msg,
              siblings.lon.sig,
              resolvedBusId,
              TRACE_PALETTE[1],
              dbMeta
            );
            resolvedTitle = `${boundContext.msg.name} // GNSS MAP`;
          }
        }
        if (siblings.heading) {
          config.headingBinding = signalSchemaToBinding(
            siblings.heading.msg,
            siblings.heading.sig,
            resolvedBusId,
            TRACE_PALETTE[2],
            dbMeta
          );
        }
        if (siblings.speed) {
          config.speedBinding = signalSchemaToBinding(
            siblings.speed.msg,
            siblings.speed.sig,
            resolvedBusId,
            TRACE_PALETTE[3],
            dbMeta
          );
        }
      } else if (!boundContext && schema) {
        const gnssSet = findSchemaGnssPair(schema);
        if (gnssSet?.lat && gnssSet.lon) {
          binding = signalSchemaToBinding(
            gnssSet.lat.msg,
            gnssSet.lat.sig,
            resolvedBusId,
            ACCENT_HEX_MAP[meta.accent],
            dbMeta
          );
          config.lonBinding = signalSchemaToBinding(
            gnssSet.lon.msg,
            gnssSet.lon.sig,
            resolvedBusId,
            TRACE_PALETTE[1],
            dbMeta
          );
          if (gnssSet.heading) {
            config.headingBinding = signalSchemaToBinding(
              gnssSet.heading.msg,
              gnssSet.heading.sig,
              resolvedBusId,
              TRACE_PALETTE[2],
              dbMeta
            );
          }
          if (gnssSet.speed) {
            config.speedBinding = signalSchemaToBinding(
              gnssSet.speed.msg,
              gnssSet.speed.sig,
              resolvedBusId,
              TRACE_PALETTE[3],
              dbMeta
            );
          }
          resolvedTitle = `${gnssSet.lat.msg.name} // GNSS MAP`;
        }
      }
      break;
    }
    case 'button':
      config.buttonMode = 'momentary';
      config.pressValue = 1;
      config.releaseValue = 0;
      config.buttonLabel = boundContext?.sig.name ?? 'TRIGGER';
      break;
    case 'checkbox':
      config.checkedValue = 1;
      config.uncheckedValue = 0;
      config.checkLabel = boundContext?.sig.name ?? 'ENABLE';
      break;
    case 'combobox':
      config.options =
        comboOptions.length > 0
          ? comboOptions
          : [
              { label: '0 : OFF', value: 0 },
              { label: '1 : ON', value: 1 },
            ];
      break;
    case 'slider':
      config.min = min;
      config.max = max;
      config.step =
        binding && binding.factor > 0 && binding.factor < 1
          ? binding.factor
          : Math.max(0.1, Number((span / 100).toFixed(2)));
      config.showNumericInput = true;
      break;
    case 'group':
      config.subtitle = 'CAN / CAN-FD SUBSYSTEM';
      break;
  }

  return {
    id: createClientUid(`w-${kind}`),
    kind,
    title: resolvedTitle,
    accentColor: meta.accent,
    layout,
    binding,
    config,
  };
}

export interface DraftPanelPreviewCounts {
  gauges: number;
  bars: number;
  numerics: number;
  enums: number;
  leds: number;
  graphs: number;
  maps: number;
  controls: number;
  groups: number;
  generators: number;
  totalInstruments: number;
  sourceDatabaseCount: number;
  selectedMessageCount: number;
  selectedSignalCount: number;
}

export interface DraftPanelPlanResult {
  widgets: SimulationWidgetDto[];
  generators: SimulationGeneratorSpecDto[];
  counts: DraftPanelPreviewCounts;
}

function summarizeDraftPanelCounts(
  widgets: readonly SimulationWidgetDto[],
  generators: readonly SimulationGeneratorSpecDto[],
  sourceDatabaseCount: number,
  selectedMessageCount: number,
  selectedSignalCount: number
): DraftPanelPreviewCounts {
  let gauges = 0;
  let bars = 0;
  let numerics = 0;
  let enums = 0;
  let leds = 0;
  let graphs = 0;
  let maps = 0;
  let controls = 0;
  let groups = 0;

  for (const w of widgets) {
    switch (w.kind) {
      case 'gauge':
        gauges += 1;
        break;
      case 'bar':
        bars += 1;
        break;
      case 'numeric':
        numerics += 1;
        break;
      case 'enum_badge':
        enums += 1;
        break;
      case 'led':
        leds += 1;
        break;
      case 'graph':
        graphs += 1;
        break;
      case 'map':
        maps += 1;
        break;
      case 'button':
      case 'checkbox':
      case 'combobox':
      case 'slider':
        controls += 1;
        break;
      case 'group':
        groups += 1;
        break;
    }
  }

  return {
    gauges,
    bars,
    numerics,
    enums,
    leds,
    graphs,
    maps,
    controls,
    groups,
    generators: generators.length,
    totalInstruments:
      gauges + bars + numerics + enums + leds + graphs + maps + controls,
    sourceDatabaseCount,
    selectedMessageCount,
    selectedSignalCount,
  };
}

export function formatDraftPanelPreviewSummary(
  counts: DraftPanelPreviewCounts
): string {
  if (counts.totalInstruments === 0) {
    return 'Önizleme: Seçili kriterlerde sinyal bulunamadı (0 bileşen oluşturulacak).';
  }
  const parts: string[] = [];
  if (counts.gauges > 0) parts.push(`${counts.gauges} Kadran`);
  if (counts.bars > 0) parts.push(`${counts.bars} Seviye Çubuğu`);
  if (counts.numerics > 0) parts.push(`${counts.numerics} Sayısal Gösterge`);
  if (counts.enums > 0) parts.push(`${counts.enums} Enum Göstergesi`);
  if (counts.leds > 0) parts.push(`${counts.leds} Durum LED`);
  if (counts.graphs > 0) parts.push(`${counts.graphs} Osiloskop`);
  if (counts.maps > 0) parts.push(`${counts.maps} GNSS Haritası`);
  if (counts.controls > 0) parts.push(`${counts.controls} Sanal Kontrol`);
  if (counts.generators > 0) parts.push(`${counts.generators} Dalga Üreteci`);
  return `Önizleme: ${parts.join(', ')} oluşturulacak`;
}

interface ScopedSignalCandidate {
  msg: MessageSchemaDto;
  sig: SignalSchemaDto;
  db?: Pick<NetworkDatabaseSummaryDto, 'id' | 'name' | 'busAssignment'>;
  busId: number;
  schema: DatabaseSchemaDto;
}

function buildPanelLayoutFromScopedPairs(
  scopedPairs: readonly ScopedSignalCandidate[],
  headerTitle: string,
  sourceDatabaseCount: number,
  selectedMessageCount: number
): DraftPanelPlanResult {
  if (scopedPairs.length === 0) {
    return {
      widgets: [],
      generators: [],
      counts: summarizeDraftPanelCounts(
        [],
        [],
        sourceDatabaseCount,
        selectedMessageCount,
        0
      ),
    };
  }

  // Detect GNSS Lat + Lon pair across the user-selected messages
  let gnssLatCandidate: ScopedSignalCandidate | null = null;
  let gnssLonCandidate: ScopedSignalCandidate | null = null;
  let gnssHdgCandidate: ScopedSignalCandidate | null = null;
  let gnssSpdCandidate: ScopedSignalCandidate | null = null;

  // Prefer Lat + Lon within the same CAN message first
  const byCompositeMsg = new Map<string, ScopedSignalCandidate[]>();
  for (const cand of scopedPairs) {
    const compKey = `${cand.db?.id ?? 'default'}::${cand.msg.messageKey}`;
    const list = byCompositeMsg.get(compKey) ?? [];
    list.push(cand);
    byCompositeMsg.set(compKey, list);
  }
  for (const msgCandidates of byCompositeMsg.values()) {
    const latC =
      msgCandidates.find((c) => isLatitudeSignalName(c.sig.name)) ?? null;
    const lonC =
      msgCandidates.find(
        (c) =>
          c.sig.name !== latC?.sig.name && isLongitudeSignalName(c.sig.name)
      ) ?? null;
    if (latC && lonC) {
      gnssLatCandidate = latC;
      gnssLonCandidate = lonC;
      gnssHdgCandidate =
        msgCandidates.find(
          (c) =>
            c.sig.name !== latC.sig.name &&
            c.sig.name !== lonC.sig.name &&
            isHeadingSignalName(c.sig.name)
        ) ?? null;
      gnssSpdCandidate =
        msgCandidates.find(
          (c) =>
            c.sig.name !== latC.sig.name &&
            c.sig.name !== lonC.sig.name &&
            c.sig.name !== gnssHdgCandidate?.sig.name &&
            isSpeedSignalName(c.sig.name)
        ) ?? null;
      break;
    }
  }
  if (!gnssLatCandidate || !gnssLonCandidate) {
    for (const cand of scopedPairs) {
      if (!gnssLatCandidate && isLatitudeSignalName(cand.sig.name)) {
        gnssLatCandidate = cand;
      } else if (!gnssLonCandidate && isLongitudeSignalName(cand.sig.name)) {
        gnssLonCandidate = cand;
      } else if (!gnssHdgCandidate && isHeadingSignalName(cand.sig.name)) {
        gnssHdgCandidate = cand;
      } else if (!gnssSpdCandidate && isSpeedSignalName(cand.sig.name)) {
        gnssSpdCandidate = cand;
      }
    }
    if (!gnssLatCandidate || !gnssLonCandidate) {
      gnssLatCandidate = null;
      gnssLonCandidate = null;
    }
  }

  const gnssCoordKeys = new Set<string>();
  if (gnssLatCandidate && gnssLonCandidate) {
    gnssCoordKeys.add(
      makeSignalBusKey(
        gnssLatCandidate.msg.messageKey,
        gnssLatCandidate.sig.name
      )
    );
    gnssCoordKeys.add(
      makeSignalBusKey(
        gnssLonCandidate.msg.messageKey,
        gnssLonCandidate.sig.name
      )
    );
  }

  const enumPairs = scopedPairs.filter(
    (p) => Object.keys(p.sig.enumTable).length > 0
  );
  const boolPairs = scopedPairs.filter(
    (p) =>
      p.sig.bitLength === 1 && Object.keys(p.sig.enumTable).length === 0
  );
  const nonGnssAnalog = scopedPairs.filter((p) => {
    const lower = p.sig.name.toLowerCase();
    const key = makeSignalBusKey(p.msg.messageKey, p.sig.name);
    return (
      p.sig.bitLength > 1 &&
      Object.keys(p.sig.enumTable).length === 0 &&
      !gnssCoordKeys.has(key) &&
      !lower.includes('crc') &&
      !lower.includes('checksum') &&
      !lower.includes('counter')
    );
  });
  const analogNonCounter =
    nonGnssAnalog.length > 0
      ? nonGnssAnalog
      : scopedPairs.filter((p) => {
          const lower = p.sig.name.toLowerCase();
          return (
            p.sig.bitLength > 1 &&
            Object.keys(p.sig.enumTable).length === 0 &&
            !lower.includes('crc') &&
            !lower.includes('checksum') &&
            !lower.includes('counter')
          );
        });
  const analogPairs =
    analogNonCounter.length > 0
      ? analogNonCounter
      : scopedPairs.filter((p) => p.sig.bitLength > 1);

  const widgets: SimulationWidgetDto[] = [];
  const generators: SimulationGeneratorSpecDto[] = [];

  // 1. Structural group header for telemetry deck
  widgets.push({
    id: createClientUid('w-group'),
    kind: 'group',
    title: `${headerTitle} // TELEMETRY MONITORING`,
    accentColor: 'steel',
    layout: { col: 0, row: 0, w: 24, h: 11 },
    binding: null,
    config: {
      subtitle: `${selectedMessageCount} MESAJ · ${scopedPairs.length} SİNYAL`,
    },
  });

  // 2. Up to two 240-deg Dial Gauges (cols 0..5, 6..11, rows 1..6)
  const g0 = analogPairs[0] ?? scopedPairs[0];
  if (g0) {
    const w = createDefaultWidget('gauge', [], 24, g0, g0.schema);
    w.layout = { col: 0, row: 1, w: 6, h: 6 };
    widgets.push(w);
  }

  const g1 = analogPairs[1] ?? scopedPairs[1];
  if (g1) {
    const w = createDefaultWidget('gauge', [], 24, g1, g1.schema);
    w.accentColor = 'emerald';
    if (w.binding) w.binding.color = ACCENT_HEX_MAP.emerald;
    w.layout = { col: 6, row: 1, w: 6, h: 6 };
    widgets.push(w);
  }

  // 3. 60 FPS Multi-Signal Oscilloscope (cols 12..23, rows 1..6)
  const plotPrimary = analogPairs[0] ?? scopedPairs[0];
  if (plotPrimary) {
    const plotWidget = createDefaultWidget(
      'graph',
      [],
      24,
      plotPrimary,
      plotPrimary.schema
    );
    plotWidget.title = `${plotPrimary.msg.name} // MULTI-SIGNAL TREND`;
    plotWidget.layout = { col: 12, row: 1, w: 12, h: 6 };
    const extraCandidates = analogPairs.slice(1, 3);
    plotWidget.config.extraBindings = extraCandidates.map((pair, idx) =>
      signalSchemaToBinding(
        pair.msg,
        pair.sig,
        pair.busId,
        TRACE_PALETTE[(idx + 1) % TRACE_PALETTE.length] ?? '#2ea043',
        pair.db
          ? { databaseId: pair.db.id, databaseName: pair.db.name }
          : undefined
      )
    );
    widgets.push(plotWidget);
  }

  // 4. Level Bar + Digital Readout + Enum Badge / LED row (rows 7..10)
  const barTarget = analogPairs[2] ?? analogPairs[0] ?? scopedPairs[0];
  if (barTarget) {
    const barW = createDefaultWidget('bar', [], 24, barTarget, barTarget.schema);
    barW.layout = { col: 0, row: 7, w: 8, h: 4 };
    widgets.push(barW);
  }

  const numTarget = analogPairs[3] ?? analogPairs[1] ?? scopedPairs[0];
  if (numTarget) {
    const numW = createDefaultWidget(
      'numeric',
      [],
      24,
      numTarget,
      numTarget.schema
    );
    numW.layout = { col: 8, row: 7, w: 6, h: 4 };
    widgets.push(numW);
  }

  const enumTarget = enumPairs[0];
  if (enumTarget) {
    const enumW = createDefaultWidget(
      'enum_badge',
      [],
      24,
      enumTarget,
      enumTarget.schema
    );
    enumW.layout = { col: 14, row: 7, w: 5, h: 4 };
    widgets.push(enumW);
  } else if (g0) {
    const fallbackNum = createDefaultWidget('numeric', [], 24, g0, g0.schema);
    fallbackNum.layout = { col: 14, row: 7, w: 5, h: 4 };
    widgets.push(fallbackNum);
  }

  const ledTarget = boolPairs[0] ?? enumPairs[1] ?? scopedPairs[0];
  if (ledTarget) {
    const ledW = createDefaultWidget('led', [], 24, ledTarget, ledTarget.schema);
    ledW.layout = { col: 19, row: 7, w: 5, h: 4 };
    widgets.push(ledW);
  }

  let nextRowCursor = 11;

  // 5. Optional GNSS / OpenStreetMap Slippy Map Deck when selected messages contain Lat + Lon
  if (gnssLatCandidate && gnssLonCandidate) {
    widgets.push({
      id: createClientUid('w-group'),
      kind: 'group',
      title: 'GNSS NAVIGATION // OPENSTREETMAP TELEMETRY',
      accentColor: 'cyan',
      layout: { col: 0, row: nextRowCursor, w: 24, h: 8 },
      binding: null,
      config: {
        subtitle: `${gnssLatCandidate.sig.name} · ${gnssLonCandidate.sig.name}`,
      },
    });

    const mapWidget = createDefaultWidget(
      'map',
      [],
      24,
      gnssLatCandidate,
      gnssLatCandidate.schema
    );
    mapWidget.config.lonBinding = signalSchemaToBinding(
      gnssLonCandidate.msg,
      gnssLonCandidate.sig,
      gnssLonCandidate.busId,
      TRACE_PALETTE[1],
      gnssLonCandidate.db
        ? {
            databaseId: gnssLonCandidate.db.id,
            databaseName: gnssLonCandidate.db.name,
          }
        : undefined
    );
    if (gnssHdgCandidate) {
      mapWidget.config.headingBinding = signalSchemaToBinding(
        gnssHdgCandidate.msg,
        gnssHdgCandidate.sig,
        gnssHdgCandidate.busId,
        TRACE_PALETTE[2],
        gnssHdgCandidate.db
          ? {
              databaseId: gnssHdgCandidate.db.id,
              databaseName: gnssHdgCandidate.db.name,
            }
          : undefined
      );
    }
    if (gnssSpdCandidate) {
      mapWidget.config.speedBinding = signalSchemaToBinding(
        gnssSpdCandidate.msg,
        gnssSpdCandidate.sig,
        gnssSpdCandidate.busId,
        TRACE_PALETTE[3],
        gnssSpdCandidate.db
          ? {
              databaseId: gnssSpdCandidate.db.id,
              databaseName: gnssSpdCandidate.db.name,
            }
          : undefined
      );
    }
    mapWidget.layout = { col: 0, row: nextRowCursor + 1, w: 24, h: 7 };
    widgets.push(mapWidget);

    nextRowCursor += 8;
  }

  // 6. Interactive Virtual Stimulus Group
  widgets.push({
    id: createClientUid('w-group'),
    kind: 'group',
    title: 'VIRTUAL STIMULUS // CLOSED-LOOP CONTROLS',
    accentColor: 'amber',
    layout: { col: 0, row: nextRowCursor, w: 24, h: 5 },
    binding: null,
    config: {
      subtitle: 'LOCAL BROWSER VIRTUAL CAN BUS ONLY (CLOUD TX LOCKED)',
    },
  });

  const stimRow = nextRowCursor + 1;
  const sliderTarget = analogPairs[0] ?? scopedPairs[0];
  if (sliderTarget) {
    const slW = createDefaultWidget(
      'slider',
      [],
      24,
      sliderTarget,
      sliderTarget.schema
    );
    slW.layout = { col: 0, row: stimRow, w: 9, h: 4 };
    widgets.push(slW);
  }

  if (enumTarget) {
    const cbW = createDefaultWidget(
      'combobox',
      [],
      24,
      enumTarget,
      enumTarget.schema
    );
    cbW.layout = { col: 9, row: stimRow, w: 7, h: 4 };
    widgets.push(cbW);
  } else if (analogPairs[1]) {
    const sl2 = createDefaultWidget(
      'slider',
      [],
      24,
      analogPairs[1],
      analogPairs[1].schema
    );
    sl2.layout = { col: 9, row: stimRow, w: 7, h: 4 };
    widgets.push(sl2);
  }

  const chkTarget = boolPairs[0] ?? scopedPairs[scopedPairs.length - 1];
  if (chkTarget) {
    const chkW = createDefaultWidget(
      'checkbox',
      [],
      24,
      chkTarget,
      chkTarget.schema
    );
    chkW.layout = { col: 16, row: stimRow, w: 4, h: 4 };
    widgets.push(chkW);
  }

  const btnTarget = boolPairs[1] ?? boolPairs[0] ?? scopedPairs[0];
  if (btnTarget) {
    const btnW = createDefaultWidget(
      'button',
      [],
      24,
      btnTarget,
      btnTarget.schema
    );
    btnW.layout = { col: 20, row: stimRow, w: 4, h: 4 };
    widgets.push(btnW);
  }

  // 7. Real-time waveform generators on up to 2 non-GNSS analog signals
  const genCandidates = nonGnssAnalog.length > 0 ? nonGnssAnalog : [];
  const genPairA = genCandidates[1] ?? genCandidates[0];
  if (genPairA) {
    const bA = signalSchemaToBinding(
      genPairA.msg,
      genPairA.sig,
      genPairA.busId,
      TRACE_PALETTE[1],
      genPairA.db
        ? { databaseId: genPairA.db.id, databaseName: genPairA.db.name }
        : undefined
    );
    generators.push({
      id: createClientUid('gen'),
      enabled: true,
      binding: bA,
      waveform: 'sine',
      min: bA.min,
      max: bA.max,
      constantValue: bA.min,
      frequencyHz: 0.35,
    });
  }

  const genPairB = genCandidates[2];
  if (genPairB) {
    const bB = signalSchemaToBinding(
      genPairB.msg,
      genPairB.sig,
      genPairB.busId,
      TRACE_PALETTE[2],
      genPairB.db
        ? { databaseId: genPairB.db.id, databaseName: genPairB.db.name }
        : undefined
    );
    generators.push({
      id: createClientUid('gen'),
      enabled: true,
      binding: bB,
      waveform: 'triangle',
      min: bB.min,
      max: bB.max,
      constantValue: bB.min,
      frequencyHz: 0.2,
    });
  }

  const counts = summarizeDraftPanelCounts(
    widgets,
    generators,
    sourceDatabaseCount,
    selectedMessageCount,
    scopedPairs.length
  );

  return { widgets, generators, counts };
}

/**
 * Builds a draft simulation panel STRICTLY from the databases and CAN messages
 * explicitly chosen by the engineer in the "DBC'den Taslak Oluştur" modal.
 */
export function planDraftPanelFromSelectedDatabases(
  entries: readonly LoadedSimulationDatabaseEntry[],
  selectedDbIds: ReadonlySet<string>,
  selectedMsgCompositeKeys?: ReadonlySet<string> | null
): DraftPanelPlanResult {
  const chosenEntries = entries.filter((e) => selectedDbIds.has(e.db.id));
  if (chosenEntries.length === 0) {
    return {
      widgets: [],
      generators: [],
      counts: summarizeDraftPanelCounts([], [], 0, 0, 0),
    };
  }

  const scopedPairs: ScopedSignalCandidate[] = [];
  let selectedMessageCount = 0;

  for (const entry of chosenEntries) {
    const allowedMsgs = new Map<string, MessageSchemaDto>();
    for (const msg of entry.schema.messages) {
      const compKey = makeCompositeMessageKey(entry.db.id, msg.messageKey);
      if (!selectedMsgCompositeKeys || selectedMsgCompositeKeys.has(compKey)) {
        allowedMsgs.set(msg.messageKey, msg);
      }
    }
    selectedMessageCount += allowedMsgs.size;

    for (const sig of entry.schema.signals) {
      const msg = allowedMsgs.get(sig.messageKey);
      if (!msg) continue;
      scopedPairs.push({
        msg,
        sig,
        db: entry.db,
        busId: entry.inferredBusId,
        schema: entry.schema,
      });
    }
  }

  const headerTitle =
    chosenEntries.length === 1
      ? chosenEntries[0]!.db.name.toUpperCase()
      : `${chosenEntries.map((e) => e.db.name).join(' + ').toUpperCase()}`;

  return buildPanelLayoutFromScopedPairs(
    scopedPairs,
    headerTitle,
    chosenEntries.length,
    selectedMessageCount
  );
}

/**
 * Single-schema draft panel helper (kept for standalone schema callers).
 */
export function buildStarterPanelFromSchema(schema: DatabaseSchemaDto): {
  widgets: SimulationWidgetDto[];
  generators: SimulationGeneratorSpecDto[];
} {
  const msgByKey = new Map<string, MessageSchemaDto>();
  for (const m of schema.messages) {
    msgByKey.set(m.messageKey, m);
  }
  const scoped: ScopedSignalCandidate[] = [];
  for (const sig of schema.signals) {
    const msg = msgByKey.get(sig.messageKey);
    if (msg) {
      scoped.push({ msg, sig, busId: 0, schema });
    }
  }
  const plan = buildPanelLayoutFromScopedPairs(
    scoped,
    (schema.info.name || 'NETWORK').toUpperCase(),
    1,
    schema.messages.length
  );
  return { widgets: plan.widgets, generators: plan.generators };
}
