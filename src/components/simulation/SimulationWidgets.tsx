'use client';

import React, { useMemo, useState } from 'react';
import { Lock, Minus, Plus, RotateCcw } from 'lucide-react';
import type {
  DatabaseSchemaDto,
  SignalSchemaDto,
} from '../../types/netdb';
import type {
  SimulationLedOperator,
  SimulationSignalBindingDto,
  SimulationWidgetDto,
  SimulationWidgetKind,
} from '../../types/simulation';
import { SimulationGraphCanvas } from './SimulationGraphCanvas';
import { SimulationMapWidget } from './SimulationMapWidget';
import {
  type SimulationRuntimeBus,
  useRuntimePeakValue,
  useRuntimeSignalValue,
} from './simulationRuntimeBus';
import {
  ACCENT_HEX_MAP,
  enumTableToComboOptions,
  makeSignalBusKey,
  physicalToRawIntAndHex,
  resolveSignalZone,
  zoneColorCss,
} from './virtualCanPacking';

export type SimulationTelemetrySource = 'virtual' | 'live_bridge';

const EMPTY_GROUP_QUICK_KINDS: ReadonlyArray<{
  kind: SimulationWidgetKind;
  label: string;
}> = [
  { kind: 'button', label: '+ BTN' },
  { kind: 'checkbox', label: '+ CHK' },
  { kind: 'combobox', label: '+ CMB' },
  { kind: 'slider', label: '+ SLD' },
  { kind: 'gauge', label: '+ GAUGE' },
  { kind: 'numeric', label: '+ NUM' },
];

export interface SimulationWidgetBodyProps {
  widget: SimulationWidgetDto;
  runtimeBus: SimulationRuntimeBus;
  isRunMode: boolean;
  telemetrySource: SimulationTelemetrySource;
  activeSchema: DatabaseSchemaDto | null;
  allBindings: readonly SimulationSignalBindingDto[];
  isLiveBusArmed?: boolean;
  onLiveTransmitSignal?: (binding: SimulationSignalBindingDto, value: number, txCycleMs?: number) => void;
  canMutate?: boolean;
  groupChildCount?: number;
  onQuickAddToGroup?: (groupId: string, kind: SimulationWidgetKind) => void;
}

function polarPoint(cx: number, cy: number, r: number, angleDegFromTop: number): { x: number; y: number } {
  const rad = (angleDegFromTop * Math.PI) / 180;
  return {
    x: cx + r * Math.sin(rad),
    y: cy - r * Math.cos(rad),
  };
}

function describeArc(
  cx: number,
  cy: number,
  r: number,
  startAngleDeg: number,
  endAngleDeg: number
): string {
  const clampedStart = Math.max(-120, Math.min(120, startAngleDeg));
  const clampedEnd = Math.max(-120, Math.min(120, endAngleDeg));
  if (clampedEnd - clampedStart <= 0.15) {
    return '';
  }
  const pStart = polarPoint(cx, cy, r, clampedStart);
  const pEnd = polarPoint(cx, cy, r, clampedEnd);
  const largeArc = clampedEnd - clampedStart > 180 ? 1 : 0;
  return `M ${pStart.x.toFixed(2)} ${pStart.y.toFixed(2)} A ${r} ${r} 0 ${largeArc} 1 ${pEnd.x.toFixed(2)} ${pEnd.y.toFixed(2)}`;
}

function evaluateLedOperator(
  value: number,
  op: SimulationLedOperator,
  threshold: number
): boolean {
  switch (op) {
    case 'eq':
      return Math.abs(value - threshold) < 1e-5;
    case 'neq':
      return Math.abs(value - threshold) >= 1e-5;
    case 'gt':
      return value > threshold;
    case 'gte':
      return value >= threshold;
    case 'lt':
      return value < threshold;
    case 'lte':
      return value <= threshold;
  }
}

function formatLedOpSymbol(op: SimulationLedOperator): string {
  switch (op) {
    case 'eq':
      return '==';
    case 'neq':
      return '!=';
    case 'gt':
      return '>';
    case 'gte':
      return '>=';
    case 'lt':
      return '<';
    case 'lte':
      return '<=';
  }
}

function findBoundSchemaSignal(
  binding: SimulationSignalBindingDto | null,
  schema: DatabaseSchemaDto | null
): SignalSchemaDto | null {
  if (!binding || !schema) return null;
  return (
    schema.signals.find(
      (s) =>
        s.messageKey === binding.messageKey && s.name === binding.signalName
    ) ??
    schema.signals.find((s) => s.name === binding.signalName) ??
    null
  );
}

function ReadOnlyCloudLockStrip({ isListenOnly = true }: { isListenOnly?: boolean } = {}): React.JSX.Element {
  return (
    <div
      className="inline-flex items-center gap-1 rounded-[2px] border px-1.5 py-0.5 font-mono text-[9px] font-semibold uppercase tracking-wider"
      style={{
        backgroundColor: 'var(--status-nominal-bg)',
        borderColor: 'var(--status-nominal-border)',
        color: 'var(--status-nominal)',
      }}
      title={isListenOnly ? 'Saha Güvenliği: Listen-Only modunda veya bus bağlı değilken TX kilitlidir.' : 'Bulut köprü modunda uzaktan CAN TX kilitlidir.'}
    >
      <Lock className="h-2.5 w-2.5 shrink-0" aria-hidden="true" />
      <span>{isListenOnly ? '[LISTEN-ONLY]' : '[READ-ONLY CLOUD]'}</span>
    </div>
  );
}

function GaugeWidgetView({
  widget,
  value,
}: {
  widget: SimulationWidgetDto;
  value: number;
}): React.JSX.Element {
  const min = widget.config.min ?? widget.binding?.min ?? 0;
  const max = widget.config.max ?? widget.binding?.max ?? 100;
  const safeSpan = Math.max(1e-6, max - min);
  const norm = Math.max(0, Math.min(1, (value - min) / safeSpan));
  const valueAngle = -120 + norm * 240;

  const majorTicks = Math.max(2, Math.min(16, widget.config.majorTicks ?? 6));
  const showNeedle = widget.config.showNeedle ?? true;
  const showDigital = widget.config.showDigital ?? true;
  const decimals = widget.binding?.decimals ?? 1;
  const unit = widget.binding?.unit ?? '';

  const zone = resolveSignalZone(value, widget.config);
  const activeColor = zoneColorCss(zone, widget.accentColor);

  const cx = 110;
  const cy = 104;
  const rTrack = 70;
  const rZone = 78;

  const valToAngle = (v: number) =>
    -120 + Math.max(0, Math.min(1, (v - min) / safeSpan)) * 240;

  const needleTip = polarPoint(cx, cy, rTrack - 8, valueAngle);
  const needleTail = polarPoint(cx, cy, 12, valueAngle + 180);

  return (
    <div className="flex h-full w-full min-h-0 flex-col items-center justify-center p-1.5">
      <svg
        viewBox="0 0 220 168"
        className="h-full w-full max-h-[220px] select-none"
        role="img"
        aria-label={`${widget.title}: ${value.toFixed(decimals)} ${unit}`}
      >
        {/* Threshold zone outer segments */}
        {typeof widget.config.critLow === 'number' &&
          widget.config.critLow > min && (
            <path
              d={describeArc(cx, cy, rZone, -120, valToAngle(widget.config.critLow))}
              fill="none"
              stroke="var(--status-critical)"
              strokeWidth="3"
            />
          )}
        {typeof widget.config.warnLow === 'number' &&
          widget.config.warnLow > (widget.config.critLow ?? min) && (
            <path
              d={describeArc(
                cx,
                cy,
                rZone,
                valToAngle(widget.config.critLow ?? min),
                valToAngle(widget.config.warnLow)
              )}
              fill="none"
              stroke="var(--status-warn)"
              strokeWidth="3"
            />
          )}
        {typeof widget.config.warnHigh === 'number' &&
          widget.config.warnHigh < (widget.config.critHigh ?? max) && (
            <path
              d={describeArc(
                cx,
                cy,
                rZone,
                valToAngle(widget.config.warnHigh),
                valToAngle(widget.config.critHigh ?? max)
              )}
              fill="none"
              stroke="var(--status-warn)"
              strokeWidth="3"
            />
          )}
        {typeof widget.config.critHigh === 'number' &&
          widget.config.critHigh < max && (
            <path
              d={describeArc(cx, cy, rZone, valToAngle(widget.config.critHigh), 120)}
              fill="none"
              stroke="var(--status-critical)"
              strokeWidth="3"
            />
          )}

        {/* Base 240° dial track */}
        <path
          d={describeArc(cx, cy, rTrack, -120, 120)}
          fill="none"
          stroke="var(--border-strong)"
          strokeWidth="7"
        />

        {/* Active value arc */}
        {norm > 0.002 && (
          <path
            d={describeArc(cx, cy, rTrack, -120, valueAngle)}
            fill="none"
            stroke={activeColor}
            strokeWidth="7"
          />
        )}

        {/* Major & minor ticks + numeric scale labels */}
        {Array.from({ length: majorTicks + 1 }).map((_, idx) => {
          const frac = idx / majorTicks;
          const ang = -120 + frac * 240;
          const pOuter = polarPoint(cx, cy, rTrack - 5, ang);
          const pInner = polarPoint(cx, cy, rTrack - 13, ang);
          const pLabel = polarPoint(cx, cy, rTrack - 24, ang);
          const tickVal = min + frac * safeSpan;
          const labelTxt =
            Math.abs(safeSpan) >= 20
              ? `${Math.round(tickVal)}`
              : tickVal.toFixed(1);

          return (
            <g key={idx}>
              <line
                x1={pOuter.x}
                y1={pOuter.y}
                x2={pInner.x}
                y2={pInner.y}
                stroke="var(--text-muted)"
                strokeWidth="1.4"
              />
              {(idx === 0 ||
                idx === majorTicks ||
                majorTicks <= 8 ||
                idx % 2 === 0) && (
                <text
                  x={pLabel.x}
                  y={pLabel.y + 3}
                  textAnchor="middle"
                  fill="var(--text-muted)"
                  fontSize="8.5"
                  fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
                >
                  {labelTxt}
                </text>
              )}
              {/* Sub-ticks */}
              {idx < majorTicks &&
                [1, 2, 3].map((sub) => {
                  const subFrac = (idx + sub / 4) / majorTicks;
                  const subAng = -120 + subFrac * 240;
                  const sO = polarPoint(cx, cy, rTrack - 5, subAng);
                  const sI = polarPoint(cx, cy, rTrack - 9, subAng);
                  return (
                    <line
                      key={sub}
                      x1={sO.x}
                      y1={sO.y}
                      x2={sI.x}
                      y2={sI.y}
                      stroke="var(--border-strong)"
                      strokeWidth="1"
                    />
                  );
                })}
            </g>
          );
        })}

        {/* Precision needle */}
        {showNeedle && (
          <g>
            <line
              x1={needleTail.x}
              y1={needleTail.y}
              x2={needleTip.x}
              y2={needleTip.y}
              stroke={activeColor}
              strokeWidth="2.2"
            />
            <rect
              x={cx - 4.5}
              y={cy - 4.5}
              width="9"
              height="9"
              fill="var(--bg-elevated)"
              stroke="var(--text-ink)"
              strokeWidth="1.5"
            />
          </g>
        )}

        {/* Digital center-bottom readout */}
        {showDigital && (
          <g>
            <rect
              x="54"
              y="124"
              width="112"
              height="34"
              fill="var(--bg-canvas)"
              stroke="var(--border-hairline)"
              strokeWidth="1"
            />
            <text
              x={cx}
              y="142"
              textAnchor="middle"
              fill="var(--text-ink)"
              fontSize="14"
              fontWeight="700"
              fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
            >
              {value.toFixed(decimals)}
            </text>
            <text
              x={cx}
              y="153"
              textAnchor="middle"
              fill={zone === 'nominal' ? 'var(--text-muted)' : activeColor}
              fontSize="8.5"
              fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
            >
              {unit ? `${unit} · ` : ''}
              {zone === 'critical'
                ? 'CRIT'
                : zone === 'warning'
                  ? 'WARN'
                  : 'NOM'}
            </text>
          </g>
        )}
      </svg>
    </div>
  );
}

function BarWidgetView({
  widget,
  value,
  peakValue,
  onResetPeak,
}: {
  widget: SimulationWidgetDto;
  value: number;
  peakValue: number;
  onResetPeak: () => void;
}): React.JSX.Element {
  const min = widget.config.min ?? widget.binding?.min ?? 0;
  const max = widget.config.max ?? widget.binding?.max ?? 100;
  const safeSpan = Math.max(1e-6, max - min);
  const norm = Math.max(0, Math.min(1, (value - min) / safeSpan));
  const peakNorm = Math.max(0, Math.min(1, (peakValue - min) / safeSpan));
  const vertical = widget.config.orientation === 'vertical';
  const showPeak = widget.config.showPeakHold ?? false;
  const majorTicks = Math.max(2, Math.min(12, widget.config.majorTicks ?? 5));
  const decimals = widget.binding?.decimals ?? 1;
  const unit = widget.binding?.unit ?? '';

  const zone = resolveSignalZone(value, widget.config);
  const fillColor = zoneColorCss(zone, widget.accentColor);

  if (vertical) {
    return (
      <div className="flex h-full w-full min-h-0 items-stretch justify-between gap-2.5 p-2.5">
        <div className="flex flex-col justify-between font-mono text-[9px] tabular-nums text-muted">
          {Array.from({ length: majorTicks + 1 }).map((_, i) => {
            const v = max - (i / majorTicks) * safeSpan;
            return (
              <span key={i}>
                {Math.abs(safeSpan) >= 20 ? Math.round(v) : v.toFixed(1)}
              </span>
            );
          })}
        </div>

        <div className="relative w-8 shrink-0 border border-hairline bg-canvas">
          <div
            className="absolute right-0 bottom-0 left-0 transition-[height] duration-75"
            style={{
              height: `${(norm * 100).toFixed(2)}%`,
              backgroundColor: fillColor,
            }}
          />
          {showPeak && (
            <div
              className="absolute right-0 left-0 h-[2px]"
              style={{
                bottom: `${(peakNorm * 100).toFixed(2)}%`,
                backgroundColor: 'var(--text-ink)',
              }}
              title={`Peak: ${peakValue.toFixed(decimals)} ${unit}`}
            />
          )}
        </div>

        <div className="flex min-w-0 flex-1 flex-col justify-between font-mono tabular-nums">
          <div>
            <div className="text-sm font-bold text-ink">
              {value.toFixed(decimals)}
            </div>
            <div className="text-[10px] text-muted">{unit || 'RAW'}</div>
          </div>
          {showPeak && (
            <button
              type="button"
              onClick={onResetPeak}
              className="inline-flex items-center gap-1 self-start rounded-[2px] border border-hairline bg-elevated px-1.5 py-0.5 text-[9px] text-muted hover:border-strong hover:text-ink"
              title="Tepe tutucu değerini sıfırla"
            >
              <RotateCcw className="h-2.5 w-2.5" aria-hidden="true" />
              PK {peakValue.toFixed(decimals)}
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full w-full min-h-0 flex-col justify-between gap-1.5 p-2.5">
      <div className="flex items-baseline justify-between gap-2 font-mono tabular-nums">
        <div className="flex items-baseline gap-1.5">
          <span className="text-base font-bold text-ink">
            {value.toFixed(decimals)}
          </span>
          {unit && <span className="text-[11px] text-muted">{unit}</span>}
        </div>
        <div className="flex items-center gap-1.5">
          {showPeak && (
            <button
              type="button"
              onClick={onResetPeak}
              className="inline-flex cursor-pointer items-center gap-1 rounded-[2px] border border-hairline bg-elevated px-1.5 py-0.5 text-[9px] text-muted hover:border-strong hover:text-ink"
              title="Tepe tutucu değerini sıfırla"
            >
              <RotateCcw className="h-2.5 w-2.5" aria-hidden="true" />
              PK: {peakValue.toFixed(decimals)}
            </button>
          )}
          <span
            className="rounded-[2px] border border-hairline bg-canvas px-1 py-0.5 text-[9px] uppercase"
            style={{
              color: zone === 'nominal' ? 'var(--text-muted)' : fillColor,
            }}
          >
            {zone === 'critical' ? 'CRIT' : zone === 'warning' ? 'WARN' : 'NOM'}
          </span>
        </div>
      </div>

      {/* Segmented / Continuous Bar Track */}
      <div className="relative h-5 w-full border border-hairline bg-canvas">
        <div
          className="h-full transition-[width] duration-75"
          style={{
            width: `${(norm * 100).toFixed(2)}%`,
            backgroundColor: fillColor,
          }}
        />
        {/* Warning / Critical Hairline Markers */}
        {typeof widget.config.warnHigh === 'number' && (
          <div
            className="pointer-events-none absolute top-0 bottom-0 w-[1px]"
            style={{
              left: `${Math.max(0, Math.min(100, ((widget.config.warnHigh - min) / safeSpan) * 100)).toFixed(2)}%`,
              backgroundColor: 'var(--status-warn)',
            }}
          />
        )}
        {typeof widget.config.critHigh === 'number' && (
          <div
            className="pointer-events-none absolute top-0 bottom-0 w-[1px]"
            style={{
              left: `${Math.max(0, Math.min(100, ((widget.config.critHigh - min) / safeSpan) * 100)).toFixed(2)}%`,
              backgroundColor: 'var(--status-critical)',
            }}
          />
        )}
        {/* Peak-Hold Hairline */}
        {showPeak && (
          <div
            className="pointer-events-none absolute top-0 bottom-0 w-[2px]"
            style={{
              left: `calc(${(peakNorm * 100).toFixed(2)}% - 1px)`,
              backgroundColor: 'var(--text-ink)',
            }}
          />
        )}
      </div>

      {/* Scale Ticks */}
      <div className="flex items-center justify-between font-mono text-[9px] tabular-nums text-muted">
        {Array.from({ length: majorTicks + 1 }).map((_, idx) => {
          const tickVal = min + (idx / majorTicks) * safeSpan;
          return (
            <span key={idx}>
              {Math.abs(safeSpan) >= 20
                ? Math.round(tickVal)
                : tickVal.toFixed(1)}
            </span>
          );
        })}
      </div>
    </div>
  );
}

function NumericWidgetView({
  widget,
  value,
  schemaSig,
}: {
  widget: SimulationWidgetDto;
  value: number;
  schemaSig: SignalSchemaDto | null;
}): React.JSX.Element {
  const decimals = widget.binding?.decimals ?? 1;
  const unit = widget.binding?.unit ?? '';
  const min = widget.config.min ?? widget.binding?.min ?? 0;
  const max = widget.config.max ?? widget.binding?.max ?? 100;
  const fontSize = widget.config.fontSize ?? 'md';
  const showRawHex = widget.config.showRawHex ?? false;

  const clampedLow = value < min;
  const clampedHigh = value > max;
  const zone = resolveSignalZone(value, widget.config);
  const accentCss = zoneColorCss(zone, widget.accentColor);

  const rawInfo = useMemo(
    () => physicalToRawIntAndHex(value, widget.binding, schemaSig),
    [schemaSig, value, widget.binding]
  );

  const fontClass =
    fontSize === 'lg'
      ? 'text-[26px] leading-none'
      : fontSize === 'sm'
        ? 'text-[16px] leading-tight'
        : 'text-[21px] leading-none';

  return (
    <div className="flex h-full w-full min-h-0 flex-col justify-between p-2.5 font-mono tabular-nums">
      <div className="flex items-baseline justify-between gap-2">
        <span
          className={`truncate font-bold tracking-tight ${fontClass}`}
          style={{
            color: zone === 'nominal' ? 'var(--text-ink)' : accentCss,
          }}
        >
          {value.toFixed(decimals)}
        </span>
        {unit && (
          <span className="shrink-0 rounded-[2px] border border-hairline bg-elevated px-1.5 py-0.5 text-[10px] font-semibold text-muted">
            {unit}
          </span>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-1.5 border-t border-hairline pt-1.5 text-[10px]">
        {showRawHex ? (
          <span className="text-muted">
            RAW <strong className="text-ink">{rawInfo.rawInt}</strong> ·{' '}
            <strong className="text-focus">{rawInfo.hex}</strong>
          </span>
        ) : (
          <span className="text-subtle">
            [{min} .. {max}]
          </span>
        )}

        <span
          className="rounded-[2px] border border-hairline bg-canvas px-1 py-0.5 text-[9px] uppercase"
          style={{
            color:
              clampedLow || clampedHigh
                ? 'var(--status-warn)'
                : zone === 'nominal'
                  ? 'var(--text-subtle)'
                  : accentCss,
          }}
        >
          {clampedLow
            ? 'LOW-CLAMP'
            : clampedHigh
              ? 'HIGH-CLAMP'
              : zone === 'critical'
                ? 'CRITICAL'
                : zone === 'warning'
                  ? 'WARNING'
                  : 'IN-RANGE'}
        </span>
      </div>
    </div>
  );
}

function LedWidgetView({
  widget,
  value,
}: {
  widget: SimulationWidgetDto;
  value: number;
}): React.JSX.Element {
  const op = widget.config.ledOperator ?? 'gte';
  const threshold = widget.config.ledThreshold ?? 1;
  const onLabel = widget.config.onLabel || 'ACTIVE';
  const offLabel = widget.config.offLabel || 'IDLE';
  const decimals = widget.binding?.decimals ?? 0;
  const unit = widget.binding?.unit ?? '';

  const isLit = evaluateLedOperator(value, op, threshold);
  const litColor = ACCENT_HEX_MAP[widget.accentColor];

  return (
    <div className="flex h-full w-full min-h-0 items-center justify-between gap-3 p-2.5 font-mono tabular-nums">
      <div className="flex min-w-0 items-center gap-2.5">
        {/* Crisp square/machined annunciator lens (0–2px sharp geometry) */}
        <div
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[2px] border"
          style={
            isLit
              ? {
                  backgroundColor: `${litColor}26`,
                  borderColor: litColor,
                }
              : {
                  backgroundColor: 'var(--bg-canvas)',
                  borderColor: 'var(--border-strong)',
                }
          }
          aria-hidden="true"
        >
          <span
            className="h-3.5 w-3.5 rounded-[1px]"
            style={{
              backgroundColor: isLit ? litColor : 'var(--border-hairline)',
            }}
          />
        </div>

        <div className="min-w-0">
          <div
            className="truncate text-xs font-bold uppercase tracking-wider"
            style={{ color: isLit ? litColor : 'var(--text-muted)' }}
          >
            {isLit ? onLabel : offLabel}
          </div>
          <div className="truncate text-[10px] text-subtle">
            COND: VAL {formatLedOpSymbol(op)} {threshold}
          </div>
        </div>
      </div>

      <div className="shrink-0 text-right">
        <div className="text-xs font-semibold text-ink">
          {value.toFixed(decimals)}
        </div>
        {unit && <div className="text-[9px] text-muted">{unit}</div>}
      </div>
    </div>
  );
}

function EnumBadgeWidgetView({
  widget,
  value,
  schemaSig,
}: {
  widget: SimulationWidgetDto;
  value: number;
  schemaSig: SignalSchemaDto | null;
}): React.JSX.Element {
  const intKey = Math.round(value);
  const mergedMap = useMemo<Record<string, string>>(() => {
    return {
      ...(schemaSig?.enumTable ?? {}),
      ...(widget.config.enumMap ?? {}),
    };
  }, [schemaSig?.enumTable, widget.config.enumMap]);

  const resolvedLabel = mergedMap[String(intKey)];
  const accentHex = ACCENT_HEX_MAP[widget.accentColor];
  const entries = Object.entries(mergedMap).slice(0, 4);

  return (
    <div className="flex h-full w-full min-h-0 flex-col justify-between p-2.5 font-mono tabular-nums">
      <div
        className="flex items-center justify-between gap-2 rounded-[2px] border px-2.5 py-1.5"
        style={
          resolvedLabel
            ? {
                backgroundColor: `${accentHex}18`,
                borderColor: accentHex,
              }
            : {
                backgroundColor: 'var(--bg-canvas)',
                borderColor: 'var(--border-hairline)',
              }
        }
      >
        <span className="truncate text-xs font-bold uppercase tracking-wider text-ink">
          {resolvedLabel ? `${intKey} : ${resolvedLabel}` : `RAW: ${intKey}`}
        </span>
        <span className="shrink-0 text-[10px] text-muted">
          0x{(intKey >>> 0).toString(16).toUpperCase().padStart(2, '0')}
        </span>
      </div>

      {entries.length > 0 && (
        <div className="flex flex-wrap gap-1 pt-1 text-[9px]">
          {entries.map(([k, lbl]) => {
            const active = Number(k) === intKey;
            return (
              <span
                key={k}
                className={`rounded-[2px] border px-1 py-0.5 ${
                  active
                    ? 'border-strong bg-elevated font-semibold text-ink'
                    : 'border-hairline bg-canvas text-subtle'
                }`}
              >
                {k}:{lbl}
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ButtonWidgetView({
  widget,
  value,
  canStimulate,
  isLiveBridgeReadOnly,
  onWrite,
}: {
  widget: SimulationWidgetDto;
  value: number;
  canStimulate: boolean;
  isLiveBridgeReadOnly: boolean;
  onWrite: (
    nextVal: number,
    momentaryFlags?: { holdMomentary?: boolean; releaseMomentary?: boolean }
  ) => void;
}): React.JSX.Element {
  const mode = widget.config.buttonMode ?? 'momentary';
  const pressValue = widget.config.pressValue ?? 1;
  const releaseValue = widget.config.releaseValue ?? 0;
  const label = widget.config.buttonLabel || widget.title;
  const accentHex = ACCENT_HEX_MAP[widget.accentColor];

  const [momentaryPressed, setMomentaryPressed] = useState<boolean>(false);
  const isLatched =
    mode === 'toggle'
      ? Math.abs(value - pressValue) < 1e-5
      : momentaryPressed || Math.abs(value - pressValue) < 1e-5;

  const handleMomentaryDown = () => {
    if (!canStimulate || mode !== 'momentary') return;
    setMomentaryPressed(true);
    onWrite(pressValue, { holdMomentary: true });
  };

  const handleMomentaryUp = () => {
    if (!canStimulate || mode !== 'momentary' || !momentaryPressed) return;
    setMomentaryPressed(false);
    onWrite(releaseValue, { releaseMomentary: true });
  };

  const handleToggleClick = () => {
    if (!canStimulate || mode !== 'toggle') return;
    onWrite(isLatched ? releaseValue : pressValue);
  };

  return (
    <div className="flex h-full w-full min-h-0 flex-col justify-between gap-1.5 p-2 font-mono tabular-nums">
      <button
        type="button"
        disabled={!canStimulate}
        aria-pressed={isLatched}
        onClick={mode === 'toggle' ? handleToggleClick : undefined}
        onPointerDown={mode === 'momentary' ? handleMomentaryDown : undefined}
        onPointerUp={mode === 'momentary' ? handleMomentaryUp : undefined}
        onPointerLeave={mode === 'momentary' ? handleMomentaryUp : undefined}
        onPointerCancel={mode === 'momentary' ? handleMomentaryUp : undefined}
        onKeyDown={
          mode === 'momentary'
            ? (e) => {
                if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) {
                  e.preventDefault();
                  handleMomentaryDown();
                }
              }
            : undefined
        }
        onKeyUp={
          mode === 'momentary'
            ? (e) => {
                if (e.key === ' ' || e.key === 'Enter') {
                  e.preventDefault();
                  handleMomentaryUp();
                }
              }
            : undefined
        }
        className={`relative flex flex-1 items-center justify-center rounded-[2px] border px-3 py-1.5 text-xs font-bold uppercase tracking-wider transition-colors ${
          canStimulate ? 'cursor-pointer' : 'cursor-not-allowed opacity-65'
        }`}
        style={
          isLatched
            ? {
                backgroundColor: `${accentHex}28`,
                borderColor: accentHex,
                color: 'var(--text-ink)',
              }
            : {
                backgroundColor: 'var(--bg-elevated)',
                borderColor: 'var(--border-strong)',
                color: 'var(--text-ink)',
              }
        }
      >
        {/* Crisp top armed LED bar */}
        <span
          className="absolute top-0 right-0 left-0 h-[2px]"
          style={{
            backgroundColor: isLatched ? accentHex : 'transparent',
          }}
          aria-hidden="true"
        />
        <span className="truncate">{label}</span>
      </button>

      <div className="flex items-center justify-between gap-1 text-[9px] text-muted">
        <span>
          {mode === 'momentary' ? 'MOMENTARY' : 'LATCH'} · OUT:{' '}
          <strong className="text-ink">{value}</strong>
        </span>
        {isLiveBridgeReadOnly && <ReadOnlyCloudLockStrip />}
      </div>
    </div>
  );
}

function CheckboxWidgetView({
  widget,
  value,
  canStimulate,
  isLiveBridgeReadOnly,
  onWrite,
}: {
  widget: SimulationWidgetDto;
  value: number;
  canStimulate: boolean;
  isLiveBridgeReadOnly: boolean;
  onWrite: (nextVal: number) => void;
}): React.JSX.Element {
  const checkedVal = widget.config.checkedValue ?? 1;
  const uncheckedVal = widget.config.uncheckedValue ?? 0;
  const label = widget.config.checkLabel || widget.title;
  const isChecked = Math.abs(value - checkedVal) < 1e-5;
  const accentHex = ACCENT_HEX_MAP[widget.accentColor];

  return (
    <div className="flex h-full w-full min-h-0 flex-col justify-between gap-1.5 p-2.5 font-mono tabular-nums">
      <button
        type="button"
        role="switch"
        aria-checked={isChecked}
        disabled={!canStimulate}
        onClick={() => {
          if (!canStimulate) return;
          onWrite(isChecked ? uncheckedVal : checkedVal);
        }}
        className={`flex items-center justify-between gap-2 rounded-[2px] border px-2.5 py-1.5 text-left transition-colors ${
          canStimulate ? 'cursor-pointer' : 'cursor-not-allowed opacity-65'
        }`}
        style={
          isChecked
            ? {
                backgroundColor: `${accentHex}1A`,
                borderColor: accentHex,
              }
            : {
                backgroundColor: 'var(--bg-canvas)',
                borderColor: 'var(--border-hairline)',
              }
        }
      >
        <span className="truncate text-xs font-semibold text-ink">{label}</span>
        <span
          className="shrink-0 rounded-[2px] border px-1.5 py-0.5 text-[10px] font-bold uppercase"
          style={
            isChecked
              ? {
                  backgroundColor: accentHex,
                  borderColor: accentHex,
                  color: '#ffffff',
                }
              : {
                  backgroundColor: 'var(--bg-elevated)',
                  borderColor: 'var(--border-strong)',
                  color: 'var(--text-muted)',
                }
          }
        >
          {isChecked ? 'ON' : 'OFF'}
        </span>
      </button>

      <div className="flex items-center justify-between gap-1 text-[9px] text-muted">
        <span>
          BUS VAL: <strong className="text-ink">{value}</strong> ({uncheckedVal}
          /{checkedVal})
        </span>
        {isLiveBridgeReadOnly && <ReadOnlyCloudLockStrip />}
      </div>
    </div>
  );
}

function ComboBoxWidgetView({
  widget,
  value,
  schemaSig,
  canStimulate,
  isLiveBridgeReadOnly,
  onWrite,
}: {
  widget: SimulationWidgetDto;
  value: number;
  schemaSig: SignalSchemaDto | null;
  canStimulate: boolean;
  isLiveBridgeReadOnly: boolean;
  onWrite: (nextVal: number) => void;
}): React.JSX.Element {
  const options = useMemo(() => {
    if (widget.config.options && widget.config.options.length > 0) {
      return widget.config.options;
    }
    if (schemaSig && Object.keys(schemaSig.enumTable).length > 0) {
      return enumTableToComboOptions(schemaSig.enumTable);
    }
    return [
      { label: '0 : OFF', value: 0 },
      { label: '1 : ON', value: 1 },
    ];
  }, [schemaSig, widget.config.options]);

  const rounded = Math.round(value);
  const hasMatchingOption = options.some(
    (opt) => Math.abs(opt.value - value) < 1e-5
  );

  return (
    <div className="flex h-full w-full min-h-0 flex-col justify-between gap-1.5 p-2.5 font-mono tabular-nums">
      <select
        aria-label={widget.title}
        disabled={!canStimulate}
        value={hasMatchingOption ? String(value) : String(rounded)}
        onChange={(e) => {
          if (!canStimulate) return;
          const next = Number(e.target.value);
          if (Number.isFinite(next)) {
            onWrite(next);
          }
        }}
        className="h-8 w-full cursor-pointer rounded-[2px] border border-strong bg-canvas px-2 text-xs font-semibold text-ink disabled:cursor-not-allowed disabled:opacity-65"
      >
        {!hasMatchingOption && (
          <option value={String(rounded)}>RAW : {rounded}</option>
        )}
        {options.map((opt) => (
          <option key={`${opt.value}-${opt.label}`} value={String(opt.value)}>
            {opt.label}
          </option>
        ))}
      </select>

      <div className="flex items-center justify-between gap-1 text-[9px] text-muted">
        <span>
          SELECTED: <strong className="text-ink">{value}</strong> (
          {options.length} STATES)
        </span>
        {isLiveBridgeReadOnly && <ReadOnlyCloudLockStrip />}
      </div>
    </div>
  );
}

function SliderWidgetView({
  widget,
  value,
  canStimulate,
  isLiveBridgeReadOnly,
  onWrite,
}: {
  widget: SimulationWidgetDto;
  value: number;
  canStimulate: boolean;
  isLiveBridgeReadOnly: boolean;
  onWrite: (nextVal: number) => void;
}): React.JSX.Element {
  const min = widget.config.min ?? widget.binding?.min ?? 0;
  const max = widget.config.max ?? widget.binding?.max ?? 100;
  const step = widget.config.step ?? 1;
  const showNumeric = widget.config.showNumericInput ?? true;
  const decimals = widget.binding?.decimals ?? 1;
  const unit = widget.binding?.unit ?? '';
  const accentHex = ACCENT_HEX_MAP[widget.accentColor];

  const clampVal = (v: number): number => {
    const clamped = Math.max(min, Math.min(max, v));
    return Number(clamped.toFixed(Math.max(decimals, 3)));
  };

  return (
    <div className="flex h-full w-full min-h-0 flex-col justify-between gap-1.5 p-2.5 font-mono tabular-nums">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          <button
            type="button"
            disabled={!canStimulate}
            onClick={() => onWrite(clampVal(value - step))}
            aria-label="Adım azalt"
            className="inline-flex h-6 w-6 cursor-pointer items-center justify-center rounded-[2px] border border-hairline bg-elevated text-ink hover:border-strong disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Minus className="h-3 w-3" />
          </button>
          <button
            type="button"
            disabled={!canStimulate}
            onClick={() => onWrite(clampVal(value + step))}
            aria-label="Adım artır"
            className="inline-flex h-6 w-6 cursor-pointer items-center justify-center rounded-[2px] border border-hairline bg-elevated text-ink hover:border-strong disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Plus className="h-3 w-3" />
          </button>
        </div>

        <div className="flex items-center gap-1.5">
          {showNumeric ? (
            <input
              type="number"
              aria-label={`${widget.title} sayısal giriş`}
              disabled={!canStimulate}
              min={min}
              max={max}
              step={step}
              value={Number(value.toFixed(decimals))}
              onChange={(e) => {
                const parsed = Number(e.target.value);
                if (Number.isFinite(parsed)) {
                  onWrite(clampVal(parsed));
                }
              }}
              className="h-6 w-20 rounded-[2px] border border-hairline bg-canvas px-1.5 text-right text-xs font-semibold text-ink disabled:cursor-not-allowed disabled:opacity-60"
            />
          ) : (
            <span className="text-xs font-bold text-ink">
              {value.toFixed(decimals)}
            </span>
          )}
          {unit && <span className="text-[10px] text-muted">{unit}</span>}
        </div>
      </div>

      <input
        type="range"
        aria-label={widget.title}
        disabled={!canStimulate}
        min={min}
        max={max}
        step={step}
        value={Math.max(min, Math.min(max, value))}
        onChange={(e) => {
          const parsed = Number(e.target.value);
          if (Number.isFinite(parsed)) {
            onWrite(clampVal(parsed));
          }
        }}
        style={{ accentColor: accentHex }}
        className="h-2 w-full cursor-pointer rounded-none bg-canvas disabled:cursor-not-allowed disabled:opacity-60"
      />

      <div className="flex items-center justify-between gap-1 text-[9px] text-muted">
        <span>
          [{min} .. {max}] STEP {step}
        </span>
        {isLiveBridgeReadOnly && <ReadOnlyCloudLockStrip />}
      </div>
    </div>
  );
}

export function SimulationWidgetBody({
  widget,
  runtimeBus,
  isRunMode,
  telemetrySource,
  activeSchema,
  allBindings,
  isLiveBusArmed = false,
  onLiveTransmitSignal,
  canMutate = false,
  groupChildCount = 0,
  onQuickAddToGroup,
}: SimulationWidgetBodyProps): React.JSX.Element {
  const signalKey = widget.binding
    ? makeSignalBusKey(widget.binding.messageKey, widget.binding.signalName)
    : null;
  const fallbackVal =
    widget.binding && widget.binding.min <= 0 && widget.binding.max >= 0
      ? 0
      : (widget.binding?.min ?? 0);

  const liveValue = useRuntimeSignalValue(runtimeBus, signalKey, fallbackVal);
  const peakValue = useRuntimePeakValue(runtimeBus, signalKey, fallbackVal);

  const schemaSig = useMemo(
    () => findBoundSchemaSignal(widget.binding, activeSchema),
    [activeSchema, widget.binding]
  );

  if (widget.kind === 'group') {
    if (!isRunMode && groupChildCount === 0) {
      return (
        <div className="flex h-full w-full items-center justify-center p-3 font-mono">
          <div className="max-w-md space-y-2 rounded-[2px] border border-dashed border-strong bg-canvas px-3 py-2.5 text-center">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-muted">
              GRUP BOŞ — SOL PALETTEN SÜRÜKLEYİN VEYA HIZLI EKLEYİN
            </div>
            {canMutate && onQuickAddToGroup && (
              <div className="flex flex-wrap items-center justify-center gap-1">
                {EMPTY_GROUP_QUICK_KINDS.map((item) => (
                  <button
                    key={item.kind}
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onQuickAddToGroup(widget.id, item.kind);
                    }}
                    className="cursor-pointer rounded-[2px] border border-hairline bg-elevated px-2 py-0.5 font-mono text-[9px] font-semibold uppercase tracking-wider text-focus transition-colors hover:border-strong hover:text-ink"
                  >
                    [{item.label}]
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      );
    }

    return (
      <div className="pointer-events-none h-full w-full" aria-hidden="true" />
    );
  }

  if (widget.kind === 'graph') {
    return (
      <SimulationGraphCanvas
        widget={widget}
        runtimeBus={runtimeBus}
        isRunMode={isRunMode}
      />
    );
  }

  if (widget.kind === 'map') {
    return (
      <SimulationMapWidget
        widget={widget}
        runtimeBus={runtimeBus}
        isRunMode={isRunMode}
        telemetrySource={telemetrySource}
        activeSchema={activeSchema}
        allBindings={allBindings}
      />
    );
  }

  if (!widget.binding) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-canvas/50 p-2 text-center font-mono text-[10px] uppercase tracking-wider text-subtle">
        UNBOUND // SELECT SIGNAL IN INSPECTOR
      </div>
    );
  }

  const isLocked = isRunMode && (
    telemetrySource === 'live_bridge' ? !isLiveBusArmed : false
  );
  const isLiveBridgeReadOnly = isLocked;
  const canStimulate = isRunMode && !isLocked;

  const handleWriteStimulus = (
    nextVal: number,
    flags?: { holdMomentary?: boolean; releaseMomentary?: boolean }
  ) => {
    if (!widget.binding || !canStimulate) return;
    runtimeBus.writeStimulus(widget.binding, nextVal, {
      ...flags,
      allBindings,
      schema: activeSchema,
    });
    if (telemetrySource === 'live_bridge' && isLiveBusArmed && onLiveTransmitSignal) {
      onLiveTransmitSignal(widget.binding, nextVal, widget.config.txCycleMs);
    }
  };

  switch (widget.kind) {
    case 'gauge':
      return <GaugeWidgetView widget={widget} value={liveValue} />;
    case 'bar':
      return (
        <BarWidgetView
          widget={widget}
          value={liveValue}
          peakValue={peakValue}
          onResetPeak={() => {
            if (signalKey) runtimeBus.resetPeak(signalKey);
          }}
        />
      );
    case 'numeric':
      return (
        <NumericWidgetView
          widget={widget}
          value={liveValue}
          schemaSig={schemaSig}
        />
      );
    case 'led':
      return <LedWidgetView widget={widget} value={liveValue} />;
    case 'enum_badge':
      return (
        <EnumBadgeWidgetView
          widget={widget}
          value={liveValue}
          schemaSig={schemaSig}
        />
      );
    case 'button':
      return (
        <ButtonWidgetView
          widget={widget}
          value={liveValue}
          canStimulate={canStimulate}
          isLiveBridgeReadOnly={isLiveBridgeReadOnly}
          onWrite={handleWriteStimulus}
        />
      );
    case 'checkbox':
      return (
        <CheckboxWidgetView
          widget={widget}
          value={liveValue}
          canStimulate={canStimulate}
          isLiveBridgeReadOnly={isLiveBridgeReadOnly}
          onWrite={(v) => handleWriteStimulus(v)}
        />
      );
    case 'combobox':
      return (
        <ComboBoxWidgetView
          widget={widget}
          value={liveValue}
          schemaSig={schemaSig}
          canStimulate={canStimulate}
          isLiveBridgeReadOnly={isLiveBridgeReadOnly}
          onWrite={(v) => handleWriteStimulus(v)}
        />
      );
    case 'slider':
      return (
        <SliderWidgetView
          widget={widget}
          value={liveValue}
          canStimulate={canStimulate}
          isLiveBridgeReadOnly={isLiveBridgeReadOnly}
          onWrite={(v) => handleWriteStimulus(v)}
        />
      );
  }
}
