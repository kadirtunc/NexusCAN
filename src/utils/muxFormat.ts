import type { FrameTelemetryDto } from '../types/telemetry';
import type { MessageSchemaDto, SignalSchemaDto } from '../types/netdb';

/**
 * Builds a unique row key per frame instance.
 * For non-multiplexed frames: `${busId}:${messageKey}`
 * For multiplexed frames with active switch branches: `${busId}:${messageKey}#Sw1=val1/Sw2=val2`
 */
export function buildFrameInstanceKey(
  frame: Pick<FrameTelemetryDto, 'busId' | 'messageKey' | 'activeMuxSwitches'>,
): string {
  const entries = frame.activeMuxSwitches ? Object.entries(frame.activeMuxSwitches) : [];
  if (entries.length === 0) {
    return `${frame.busId}:${frame.messageKey}`;
  }
  return `${frame.busId}:${frame.messageKey}#${entries.map(([k, v]) => `${k}=${v}`).join('/')}`;
}

/**
 * Formats an individual multiplexer switch value into a clean segment name.
 * Uses the enum label if present (with spaces replaced by underscores),
 * otherwise defaults to `m${intVal}` (or `m_${Math.abs(intVal)}` if negative).
 */
export function formatMuxSegmentLabel(
  switchSig: SignalSchemaDto | undefined,
  rawVal: number,
): string {
  const intVal = Math.trunc(rawVal);
  const enumLabel = switchSig?.enumTable[String(intVal)];
  if (enumLabel && enumLabel.trim().length > 0) {
    return enumLabel.trim().replace(/\s+/g, '_');
  }
  return intVal < 0 ? `m_${Math.abs(intVal)}` : `m${intVal}`;
}

export interface FormattedMuxSymbol {
  fullSymbol: string;
  baseName: string;
  muxSuffix: string | null;
}

/**
 * Formats a multiplexed message symbol in PCAN-Explorer style:
 * `BaseMessageName` (if non-multiplexed) or `BaseMessageName.OuterMux.InnerMux` (if multiplexed).
 */
export function formatMultiplexedSymbol(
  msgSchema: MessageSchemaDto | undefined,
  signalsById: readonly (SignalSchemaDto | undefined)[],
  activeMuxSwitches: Readonly<Record<string, number>>,
): FormattedMuxSymbol {
  if (!msgSchema) {
    return { fullSymbol: '—', baseName: '—', muxSuffix: null };
  }
  const entries = activeMuxSwitches ? Object.entries(activeMuxSwitches) : [];
  if (!msgSchema.isMultiplexed || entries.length === 0) {
    return { fullSymbol: msgSchema.name, baseName: msgSchema.name, muxSuffix: null };
  }

  const segments: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const [swName, rawVal] = entries[i];
    let swSig: SignalSchemaDto | undefined;
    for (let j = 0; j < msgSchema.signalIds.length; j++) {
      const s = signalsById[msgSchema.signalIds[j]];
      if (s && s.name === swName) {
        swSig = s;
        break;
      }
    }
    segments.push(formatMuxSegmentLabel(swSig, rawVal));
  }

  const muxSuffix = segments.join('.');
  return {
    fullSymbol: `${msgSchema.name}.${muxSuffix}`,
    baseName: msgSchema.name,
    muxSuffix,
  };
}

/**
 * Resolves active switches, active signal IDs, and PCAN-Explorer formatted symbol from signal physical values.
 * Used for symbolic Transmit (TX) rows and TxMessageModal.
 */
export function resolveMuxChainFromSignalValues(
  msgSchema: MessageSchemaDto | undefined,
  signalsById: readonly (SignalSchemaDto | undefined)[],
  signalValues: Readonly<Record<number, number>>,
): {
  activeSwitches: Record<string, number>;
  activeSignalIds: Set<number>;
  formatted: FormattedMuxSymbol;
} {
  if (!msgSchema) {
    return {
      activeSwitches: {},
      activeSignalIds: new Set<number>(),
      formatted: { fullSymbol: '—', baseName: '—', muxSuffix: null },
    };
  }

  if (!msgSchema.isMultiplexed) {
    return {
      activeSwitches: {},
      activeSignalIds: new Set<number>(msgSchema.signalIds),
      formatted: { fullSymbol: msgSchema.name, baseName: msgSchema.name, muxSuffix: null },
    };
  }

  const activeSwitches: Record<string, number> = {};
  const activeSignalIds = new Set<number>();

  // Identify which signals act as switches: masterSwitchId + every non-null switchSignalId
  const switchIds = new Set<number>();
  if (msgSchema.masterSwitchId !== null) {
    switchIds.add(msgSchema.masterSwitchId);
  }
  for (let i = 0; i < msgSchema.signalIds.length; i++) {
    const sigId = msgSchema.signalIds[i];
    const sig = signalsById[sigId];
    if (sig) {
      if (sig.muxRole === 'masterSwitch') {
        switchIds.add(sig.signalId);
      }
      if (sig.switchSignalId !== null) {
        switchIds.add(sig.switchSignalId);
      }
      if (
        sig.muxRole === 'static' ||
        (sig.switchSignalId === null &&
          sig.muxRole !== 'multiplexed' &&
          sig.muxRole !== 'masterSwitch')
      ) {
        activeSignalIds.add(sig.signalId);
      }
    }
  }

  const rootSwitchId =
    msgSchema.masterSwitchId ??
    msgSchema.signalIds.find((id) => signalsById[id]?.muxRole === 'masterSwitch');

  if (rootSwitchId !== null && rootSwitchId !== undefined) {
    const rootSig = signalsById[rootSwitchId];
    if (rootSig) {
      const visited = new Set<number>();

      const evaluateSwitch = (switchSig: SignalSchemaDto): void => {
        if (visited.has(switchSig.signalId)) return;
        visited.add(switchSig.signalId);
        activeSignalIds.add(switchSig.signalId);

        const physVal =
          signalValues[switchSig.signalId] ??
          switchSig.initialValue ??
          (Number.isFinite(switchSig.min) ? switchSig.min : 0);
        const factor = Math.abs(switchSig.factor) > 1e-12 ? switchSig.factor : 1;
        const rawInt = Math.round((physVal - switchSig.offset) / factor);
        activeSwitches[switchSig.name] = rawInt;

        for (let j = 0; j < msgSchema.signalIds.length; j++) {
          const childId = msgSchema.signalIds[j];
          const childSig = signalsById[childId];
          if (!childSig) continue;

          if (
            childSig.switchSignalId === switchSig.signalId &&
            childSig.muxRanges.some(([lo, hi]) => rawInt >= lo && rawInt <= hi)
          ) {
            activeSignalIds.add(childSig.signalId);
            if (switchIds.has(childSig.signalId)) {
              evaluateSwitch(childSig);
            }
          }
        }
      };

      evaluateSwitch(rootSig);
    }
  }

  const formatted = formatMultiplexedSymbol(msgSchema, signalsById, activeSwitches);
  return { activeSwitches, activeSignalIds, formatted };
}
