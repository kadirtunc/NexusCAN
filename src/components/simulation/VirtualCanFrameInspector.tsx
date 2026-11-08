'use client';

import React from 'react';
import { ChevronDown, ChevronUp, Cpu, Lock } from 'lucide-react';
import {
  type SimulationRuntimeBus,
  useRuntimePackedFrames,
} from './simulationRuntimeBus';
import type { SimulationTelemetrySource } from './SimulationWidgets';

export interface VirtualCanFrameInspectorProps {
  runtimeBus: SimulationRuntimeBus;
  telemetrySource: SimulationTelemetrySource;
  open: boolean;
  onToggleOpen: () => void;
}

export function VirtualCanFrameInspector({
  runtimeBus,
  telemetrySource,
  open,
  onToggleOpen,
}: VirtualCanFrameInspectorProps): React.JSX.Element {
  const frames = useRuntimePackedFrames(runtimeBus);

  return (
    <section
      aria-label="Sanal CAN Çerçeve Denetçisi"
      className="shrink-0 border-t border-hairline bg-surface"
    >
      <div className="flex h-8 items-center justify-between gap-2 bg-elevated px-3 font-mono text-[10px] tabular-nums">
        <button
          type="button"
          onClick={onToggleOpen}
          aria-expanded={open}
          className="inline-flex cursor-pointer items-center gap-1.5 font-semibold uppercase tracking-wider text-ink hover:text-focus"
        >
          {open ? (
            <ChevronDown className="h-3.5 w-3.5 text-focus" aria-hidden="true" />
          ) : (
            <ChevronUp className="h-3.5 w-3.5 text-focus" aria-hidden="true" />
          )}
          <Cpu className="h-3 w-3 text-nominal" aria-hidden="true" />
          <span>
            {telemetrySource === 'virtual'
              ? `VIRTUAL CAN / CAN-FD FRAME INSPECTOR (${frames.length} FRAMES)`
              : `LIVE BRIDGE FRAME MIRROR (${frames.length} FRAMES)`}
          </span>
        </button>

        <div className="flex items-center gap-2">
          <span className="hidden text-muted sm:inline">
            {telemetrySource === 'virtual'
              ? 'INTEL (@1) & MOTOROLA (@0) BIT-PACKED IN BROWSER MEMORY'
              : 'PASSIVE LISTEN-ONLY STREAM MIRROR'}
          </span>
          <span
            className="inline-flex items-center gap-1 rounded-[2px] border px-1.5 py-0.5 text-[9px] font-semibold uppercase"
            style={{
              backgroundColor: 'var(--status-nominal-bg)',
              borderColor: 'var(--status-nominal-border)',
              color: 'var(--status-nominal)',
            }}
          >
            <Lock className="h-2.5 w-2.5" aria-hidden="true" />
            NO REMOTE TX
          </span>
        </div>
      </div>

      {open && (
        <div className="max-h-52 overflow-auto bg-canvas">
          {frames.length === 0 ? (
            <div className="px-4 py-6 text-center font-mono text-[11px] text-muted">
              {telemetrySource === 'virtual'
                ? 'HENÜZ PAKETLENECEK SANAL CAN ÇERÇEVESİ YOK // WIDGET VEYA ÜRETEÇ SİNYALİ BAĞLAYIN.'
                : 'CANLI KÖPRÜDEN AKTİF CAN ÇERÇEVESİ BEKLENİYOR...'}
            </div>
          ) : (
            <table className="w-full border-collapse text-left font-mono text-[11px] tabular-nums">
              <thead className="sticky top-0 z-10 border-b border-hairline bg-surface text-[9px] uppercase tracking-wider text-muted">
                <tr>
                  <th className="px-3 py-1.5 font-semibold">BUS</th>
                  <th className="px-3 py-1.5 font-semibold">KEY / ARB ID</th>
                  <th className="px-3 py-1.5 font-semibold">SYMBOL</th>
                  <th className="px-3 py-1.5 font-semibold">DLC</th>
                  <th className="px-3 py-1.5 font-semibold">
                    RAW PAYLOAD (HEX)
                  </th>
                  <th className="px-3 py-1.5 font-semibold">
                    DECODED / PACKED SIGNALS
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-hairline">
                {frames.map((frame) => {
                  const changedSet = new Set(frame.changedByteIndices);
                  return (
                    <tr
                      key={`${frame.busId}-${frame.messageKey}`}
                      className="hover:bg-surface/60"
                    >
                      <td className="px-3 py-1.5 text-muted">
                        CAN{frame.busId}
                      </td>
                      <td className="px-3 py-1.5">
                        <span className="font-bold text-focus">
                          {frame.messageKey}
                        </span>
                        <span className="ml-1.5 rounded-[2px] border border-hairline bg-surface px-1 py-0.5 text-[9px] text-muted">
                          {frame.isFd ? 'FD' : 'CAN'}
                        </span>
                      </td>
                      <td className="px-3 py-1.5 font-medium text-ink">
                        <span>{frame.messageName}</span>
                        <span className="ml-1.5 text-[9px] text-subtle">
                          {frame.fromDbcSchema ? '[DBC]' : '[SYNTH]'}
                        </span>
                      </td>
                      <td className="px-3 py-1.5 text-muted">[{frame.dlc}]</td>
                      <td className="px-3 py-1.5">
                        <div className="flex flex-wrap gap-1">
                          {frame.rawBytes.map((b, idx) => {
                            const changed = changedSet.has(idx);
                            return (
                              <span
                                key={idx}
                                className={`px-0.5 ${
                                  changed
                                    ? 'bg-elevated font-bold text-focus'
                                    : 'text-ink'
                                }`}
                              >
                                {b.toString(16).toUpperCase().padStart(2, '0')}
                              </span>
                            );
                          })}
                        </div>
                      </td>
                      <td className="px-3 py-1.5 text-[10px] text-muted">
                        <div className="flex flex-wrap gap-x-3 gap-y-0.5">
                          {frame.signals.map((sig) => {
                            const dec =
                              typeof sig.decimals === 'number'
                                ? sig.decimals
                                : Number.isInteger(sig.physicalValue)
                                  ? 0
                                  : 2;
                            return (
                              <span key={sig.signalName}>
                                <span className="text-ink">{sig.signalName}</span>
                                =
                                <strong className="text-nominal">
                                  {sig.physicalValue.toFixed(dec)}
                                </strong>
                                {sig.unit ? ` ${sig.unit}` : ''}{' '}
                                <span className="text-subtle">
                                  ({sig.startBit}|{sig.bitLength}
                                  {sig.byteOrder === 'littleEndian' ? '@1' : '@0'})
                                </span>
                              </span>
                            );
                          })}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      )}
    </section>
  );
}
