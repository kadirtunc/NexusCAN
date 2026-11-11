import { useCallback, useMemo, useSyncExternalStore } from 'react';
import type {
  DatabaseSchemaDto,
  SignalSchemaDto,
} from '../../types/netdb';
import type {
  FrameTelemetryDto,
  LiveSignalDto,
} from '../../types/telemetry';
import type {
  SimulationGeneratorSpecDto,
  SimulationSignalBindingDto,
} from '../../types/simulation';
import {
  makeSignalBusKey,
  packVirtualCanFrames,
  synthesizeWaveformValue,
  type PackedVirtualCanFrame,
} from './virtualCanPacking';

export interface SimTraceSample {
  tSec: number;
  val: number;
}

const MAX_HISTORY_SAMPLES = 3600;
const HISTORY_WINDOW_CAP_SEC = 310;
const EMPTY_FRAMES: readonly PackedVirtualCanFrame[] = [];

export class SimulationRuntimeBus {
  private values = new Map<string, number>();
  private peaks = new Map<string, number>();
  private histories = new Map<string, SimTraceSample[]>();
  private bytesByKey = new Map<string, Uint8Array>();
  private heldKeys = new Set<string>();
  private prevBytesByMsgKey = new Map<string, number[]>();
  private packedFrames: readonly PackedVirtualCanFrame[] = EMPTY_FRAMES;
  private elapsedSec = 0;

  private keyListeners = new Map<string, Set<() => void>>();
  private frameListeners = new Set<() => void>();
  private buttonHotkeyHandlers = new Map<
    string,
    { onKeyDown: () => void; onKeyUp: () => void }
  >();

  public registerButtonHotkeyHandler(
    widgetId: string,
    handlers: { onKeyDown: () => void; onKeyUp: () => void }
  ): () => void {
    this.buttonHotkeyHandlers.set(widgetId, handlers);
    return () => {
      const existing = this.buttonHotkeyHandlers.get(widgetId);
      if (existing === handlers) {
        this.buttonHotkeyHandlers.delete(widgetId);
      }
    };
  }

  public triggerButtonHotkeyDown(widgetId: string): boolean {
    const handler = this.buttonHotkeyHandlers.get(widgetId);
    if (!handler) return false;
    handler.onKeyDown();
    return true;
  }

  public triggerButtonHotkeyUp(widgetId: string): boolean {
    const handler = this.buttonHotkeyHandlers.get(widgetId);
    if (!handler) return false;
    handler.onKeyUp();
    return true;
  }

  public reset(initialBindings: readonly SimulationSignalBindingDto[] = [], schema: DatabaseSchemaDto | null = null): void {
    this.values.clear();
    this.peaks.clear();
    this.histories.clear();
    this.bytesByKey.clear();
    this.heldKeys.clear();
    this.prevBytesByMsgKey.clear();
    this.elapsedSec = 0;

    const schemaSigByKey = new Map<string, SignalSchemaDto>();
    if (schema) {
      for (const s of schema.signals) {
        schemaSigByKey.set(makeSignalBusKey(s.messageKey, s.name), s);
      }
    }

    for (const b of initialBindings) {
      const k = makeSignalBusKey(b.messageKey, b.signalName);
      const schemaSig = schemaSigByKey.get(k);
      const initVal =
        schemaSig && schemaSig.initialValue !== null
          ? schemaSig.initialValue
          : b.min <= 0 && b.max >= 0
            ? 0
            : b.min;
      this.values.set(k, initVal);
      this.peaks.set(k, initVal);
    }

    this.packedFrames = packVirtualCanFrames(
      initialBindings,
      this.values,
      schema,
      this.prevBytesByMsgKey
    );

    this.notifyAllKeys();
    this.notifyFrameListeners();
  }

  public ensureSeededBindings(
    bindings: readonly SimulationSignalBindingDto[],
    schema: DatabaseSchemaDto | null
  ): void {
    const schemaSigByKey = new Map<string, SignalSchemaDto>();
    if (schema) {
      for (const s of schema.signals) {
        schemaSigByKey.set(makeSignalBusKey(s.messageKey, s.name), s);
      }
    }

    let added = false;
    for (const b of bindings) {
      const k = makeSignalBusKey(b.messageKey, b.signalName);
      if (!this.values.has(k)) {
        const schemaSig = schemaSigByKey.get(k);
        const initVal =
          schemaSig && schemaSig.initialValue !== null
            ? schemaSig.initialValue
            : b.min <= 0 && b.max >= 0
              ? 0
              : b.min;
        this.values.set(k, initVal);
        this.peaks.set(k, initVal);
        added = true;
      }
    }

    if (added || this.packedFrames.length === 0) {
      this.packedFrames = packVirtualCanFrames(
        bindings,
        this.values,
        schema,
        this.prevBytesByMsgKey
      );
      this.notifyFrameListeners();
    }
  }

  /**
   * External (non-CAN) data sources, e.g. UDS DID polling, publish samples under their own
   * synthetic key namespace. Value / peak / history flow exactly like DBC signals.
   */
  public publishExternalSample(signalKey: string, value: number, tSec: number): void {
    if (!Number.isFinite(value)) return;
    if (tSec > this.elapsedSec) this.elapsedSec = tSec;
    const prev = this.values.get(signalKey);
    this.setInternalValue(signalKey, value, tSec);
    if (prev === undefined || Math.abs(prev - value) > 1e-7) {
      this.notifyKey(signalKey);
    }
  }

  /**
   * Byte channel for non-numeric external data (ASCII / hex DIDs). Shares the per-key listener
   * mechanism; listeners fire only when the byte content actually changes (memcmp).
   */
  public publishExternalBytes(signalKey: string, bytes: Uint8Array): void {
    const prev = this.bytesByKey.get(signalKey);
    if (prev && prev.length === bytes.length) {
      let same = true;
      for (let i = 0; i < bytes.length; i += 1) {
        if (prev[i] !== bytes[i]) {
          same = false;
          break;
        }
      }
      if (same) return;
    }
    this.bytesByKey.set(signalKey, bytes.slice());
    this.notifyKey(signalKey);
  }

  public getBytes(signalKey: string): Uint8Array | null {
    return this.bytesByKey.get(signalKey) ?? null;
  }

  /** Advances the shared time base (graph widgets scroll against it) without touching values. */
  public advanceClock(tSec: number): void {
    if (tSec > this.elapsedSec) this.elapsedSec = tSec;
  }

  public getValue(signalKey: string, fallback = 0): number {
    const v = this.values.get(signalKey);
    return v !== undefined ? v : fallback;
  }

  public getPeak(signalKey: string, fallback = 0): number {
    const p = this.peaks.get(signalKey);
    return p !== undefined ? p : fallback;
  }

  public resetPeak(signalKey: string): void {
    const cur = this.values.get(signalKey) ?? 0;
    this.peaks.set(signalKey, cur);
    this.notifyKey(signalKey);
  }

  public getHistory(signalKey: string): readonly SimTraceSample[] {
    return this.histories.get(signalKey) ?? [];
  }

  public getElapsedSec(): number {
    return this.elapsedSec;
  }

  public getPackedFrames(): readonly PackedVirtualCanFrame[] {
    return this.packedFrames;
  }

  public getValuesMap(): ReadonlyMap<string, number> {
    return this.values;
  }

  /**
   * Called by interactive stimulus widgets (button, checkbox, combobox, slider)
   * ONLY in local VIRTUAL BUS mode. Never transmits remote CAN frames.
   */
  public writeStimulus(
    binding: SimulationSignalBindingDto,
    physicalValue: number,
    options?: {
      holdMomentary?: boolean;
      releaseMomentary?: boolean;
      allBindings?: readonly SimulationSignalBindingDto[];
      schema?: DatabaseSchemaDto | null;
    }
  ): void {
    const key = makeSignalBusKey(binding.messageKey, binding.signalName);
    const safeVal = Number.isFinite(physicalValue) ? physicalValue : 0;

    if (options?.holdMomentary) {
      this.heldKeys.add(key);
    } else if (options?.releaseMomentary) {
      this.heldKeys.delete(key);
    }

    this.setInternalValue(key, safeVal, this.elapsedSec);
    this.notifyKey(key);

    if (options?.allBindings) {
      this.packedFrames = packVirtualCanFrames(
        options.allBindings,
        this.values,
        options.schema ?? null,
        this.prevBytesByMsgKey
      );
      this.notifyFrameListeners();
    }
  }

  /**
   * 60Hz Virtual Simulation Bus tick (browser-local closed-loop).
   */
  public tickVirtual(
    tSec: number,
    bindings: readonly SimulationSignalBindingDto[],
    generators: readonly SimulationGeneratorSpecDto[],
    schema: DatabaseSchemaDto | null
  ): void {
    this.elapsedSec = tSec;
    const changedKeys = new Set<string>();

    for (const gen of generators) {
      if (!gen.enabled) continue;
      const key = makeSignalBusKey(
        gen.binding.messageKey,
        gen.binding.signalName
      );
      if (this.heldKeys.has(key)) {
        continue;
      }
      const nextVal = synthesizeWaveformValue(gen, tSec);
      const prevVal = this.values.get(key);
      this.setInternalValue(key, nextVal, tSec);
      if (prevVal === undefined || Math.abs(prevVal - nextVal) > 1e-7) {
        changedKeys.add(key);
      }
    }

    // Record history sample for every active panel binding so oscilloscopes advance smoothly at 60 FPS
    for (const b of bindings) {
      const key = makeSignalBusKey(b.messageKey, b.signalName);
      const curVal = this.values.get(key) ?? (b.min <= 0 && b.max >= 0 ? 0 : b.min);
      if (!this.values.has(key)) {
        this.values.set(key, curVal);
        this.peaks.set(key, curVal);
      }
      this.appendHistoryPoint(key, tSec, curVal);
    }

    this.packedFrames = packVirtualCanFrames(
      bindings,
      this.values,
      schema,
      this.prevBytesByMsgKey
    );

    for (const k of changedKeys) {
      this.notifyKey(k);
    }
    this.notifyFrameListeners();
  }

  /**
   * 60Hz Live Bridge Read-Only ingestion tick from useLiveTelemetryStore.
   */
  public tickFromLiveBridge(
    tSec: number,
    frameByKey: Readonly<Record<string, FrameTelemetryDto>>,
    liveSignalById: Readonly<Record<number, LiveSignalDto>>,
    schemaSignalById: Readonly<Record<number, SignalSchemaDto>>,
    fallbackSchema: DatabaseSchemaDto | null,
    panelBindings: readonly SimulationSignalBindingDto[]
  ): void {
    this.elapsedSec = tSec;
    const changedKeys = new Set<string>();

    // Build fallback signal lookup if streamSchema isn't populated yet
    const fallbackById = new Map<number, SignalSchemaDto>();
    if (fallbackSchema) {
      for (const s of fallbackSchema.signals) {
        fallbackById.set(s.signalId, s);
      }
    }

    // Also map by arbId + signalName in case messageKey prefix differs
    const valByArbAndName = new Map<string, number>();

    for (const [sigIdStr, liveSig] of Object.entries(liveSignalById)) {
      const sigId = Number(sigIdStr);
      const meta = schemaSignalById[sigId] ?? fallbackById.get(sigId);
      if (!meta) continue;

      const key = makeSignalBusKey(meta.messageKey, meta.name);
      const prev = this.values.get(key);
      this.setInternalValue(key, liveSig.physicalValue, tSec);
      if (prev === undefined || Math.abs(prev - liveSig.physicalValue) > 1e-7) {
        changedKeys.add(key);
      }

      const frame = frameByKey[meta.messageKey];
      if (frame) {
        valByArbAndName.set(`${frame.arbId}::${meta.name}`, liveSig.physicalValue);
      }
    }

    // Resolve any panel binding matched by arbId + signalName
    for (const b of panelBindings) {
      const key = makeSignalBusKey(b.messageKey, b.signalName);
      const alt = valByArbAndName.get(`${b.arbId}::${b.signalName}`);
      if (alt !== undefined) {
        const prev = this.values.get(key);
        this.setInternalValue(key, alt, tSec);
        if (prev === undefined || Math.abs(prev - alt) > 1e-7) {
          changedKeys.add(key);
        }
      } else if (this.values.has(key)) {
        this.appendHistoryPoint(key, tSec, this.values.get(key) ?? 0);
      }
    }

    // Mirror live CAN frames into inspector format
    const mirroredFrames: PackedVirtualCanFrame[] = [];
    for (const frame of Object.values(frameByKey)) {
      const changedIndices: number[] = [];
      for (let i = 0; i < Math.min(32, frame.dlc); i += 1) {
        if ((frame.changedBytesLo & (1 << i)) !== 0) {
          changedIndices.push(i);
        }
      }
      for (let i = 32; i < Math.min(64, frame.dlc); i += 1) {
        if ((frame.changedBytesHi & (1 << (i - 32))) !== 0) {
          changedIndices.push(i);
        }
      }

      const sigSummaries = frame.signals
        .slice(0, 8)
        .map((ls) => {
          const meta =
            schemaSignalById[ls.signalId] ?? fallbackById.get(ls.signalId);
          return {
            signalName: meta?.name ?? `Sig_${ls.signalId}`,
            physicalValue: ls.physicalValue,
            unit: meta?.unit ?? '',
            startBit: meta?.startBit ?? 0,
            bitLength: meta?.bitLength ?? 16,
            byteOrder: meta?.byteOrder ?? ('littleEndian' as const),
          };
        });

      mirroredFrames.push({
        busId: frame.busId,
        messageKey: frame.messageKey,
        messageName:
          fallbackSchema?.messages.find((m) => m.messageKey === frame.messageKey)
            ?.name ?? frame.messageKey,
        arbId: frame.arbId,
        isExtended: frame.isExtended,
        isFd: frame.isFd,
        dlc: frame.dlc,
        rawBytes: frame.rawBytes,
        changedByteIndices: changedIndices,
        fromDbcSchema: true,
        signals: sigSummaries,
      });
    }
    mirroredFrames.sort((a, b) => a.arbId - b.arbId);
    this.packedFrames = mirroredFrames;

    for (const k of changedKeys) {
      this.notifyKey(k);
    }
    this.notifyFrameListeners();
  }

  public subscribeKey(signalKey: string, listener: () => void): () => void {
    let set = this.keyListeners.get(signalKey);
    if (!set) {
      set = new Set();
      this.keyListeners.set(signalKey, set);
    }
    set.add(listener);
    return () => {
      const target = this.keyListeners.get(signalKey);
      if (target) {
        target.delete(listener);
        if (target.size === 0) {
          this.keyListeners.delete(signalKey);
        }
      }
    };
  }

  public subscribeFrames(listener: () => void): () => void {
    this.frameListeners.add(listener);
    return () => {
      this.frameListeners.delete(listener);
    };
  }

  private setInternalValue(key: string, val: number, tSec: number): void {
    this.values.set(key, val);
    const prevPeak = this.peaks.get(key);
    if (prevPeak === undefined || val > prevPeak) {
      this.peaks.set(key, val);
    }
    this.appendHistoryPoint(key, tSec, val);
  }

  private appendHistoryPoint(key: string, tSec: number, val: number): void {
    let arr = this.histories.get(key);
    if (!arr) {
      arr = [];
      this.histories.set(key, arr);
    }
    const last = arr[arr.length - 1];
    if (last && tSec < last.tSec) {
      arr.length = 0;
    }
    if (last && Math.abs(tSec - last.tSec) < 0.008) {
      last.val = val;
      return;
    }
    arr.push({ tSec, val });
    const cutoff = tSec - HISTORY_WINDOW_CAP_SEC;
    while (
      arr.length > MAX_HISTORY_SAMPLES ||
      (arr.length > 2 && (arr[0]?.tSec ?? tSec) < cutoff)
    ) {
      arr.shift();
    }
  }

  private notifyKey(key: string): void {
    const listeners = this.keyListeners.get(key);
    if (!listeners) return;
    for (const fn of listeners) {
      fn();
    }
  }

  private notifyAllKeys(): void {
    for (const listeners of this.keyListeners.values()) {
      for (const fn of listeners) {
        fn();
      }
    }
  }

  private notifyFrameListeners(): void {
    for (const fn of this.frameListeners) {
      fn();
    }
  }
}

export function useRuntimeSignalValue(
  bus: SimulationRuntimeBus,
  signalKey: string | null,
  fallback = 0
): number {
  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      if (!signalKey) return () => undefined;
      return bus.subscribeKey(signalKey, onStoreChange);
    },
    [bus, signalKey]
  );

  const getSnapshot = useCallback(() => {
    if (!signalKey) return fallback;
    return bus.getValue(signalKey, fallback);
  }, [bus, fallback, signalKey]);

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function useRuntimePeakValue(
  bus: SimulationRuntimeBus,
  signalKey: string | null,
  fallback = 0
): number {
  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      if (!signalKey) return () => undefined;
      return bus.subscribeKey(signalKey, onStoreChange);
    },
    [bus, signalKey]
  );

  const getSnapshot = useCallback(() => {
    if (!signalKey) return fallback;
    return bus.getPeak(signalKey, fallback);
  }, [bus, fallback, signalKey]);

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function useRuntimeBytesValue(
  bus: SimulationRuntimeBus,
  signalKey: string | null
): Uint8Array | null {
  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      if (!signalKey) return () => undefined;
      return bus.subscribeKey(signalKey, onStoreChange);
    },
    [bus, signalKey]
  );
  const getSnapshot = useCallback(
    () => (signalKey ? bus.getBytes(signalKey) : null),
    [bus, signalKey]
  );
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * Payload byte range of a packed (virtual / mirrored live) message. The snapshot is a hex string
 * so the widget re-renders only when those bytes change, not on every 60 Hz frame notification.
 */
export function useRuntimeMessageBytes(
  bus: SimulationRuntimeBus,
  messageKey: string | null,
  byteOffset: number,
  byteLength: number
): Uint8Array | null {
  const subscribe = useCallback(
    (onStoreChange: () => void) => bus.subscribeFrames(onStoreChange),
    [bus]
  );
  const getSnapshot = useCallback((): string => {
    if (!messageKey) return '';
    const frame = bus.getPackedFrames().find((f) => f.messageKey === messageKey);
    if (!frame) return '';
    const end = byteLength > 0 ? byteOffset + byteLength : frame.rawBytes.length;
    return frame.rawBytes
      .slice(byteOffset, end)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }, [bus, messageKey, byteLength, byteOffset]);
  const hex = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return useMemo(() => {
    if (hex.length === 0) return null;
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return out;
  }, [hex]);
}

export function useRuntimePackedFrames(
  bus: SimulationRuntimeBus
): readonly PackedVirtualCanFrame[] {
  const subscribe = useCallback(
    (onStoreChange: () => void) => bus.subscribeFrames(onStoreChange),
    [bus]
  );
  const getSnapshot = useCallback(() => bus.getPackedFrames(), [bus]);
  return useSyncExternalStore(subscribe, getSnapshot, () => EMPTY_FRAMES);
}
