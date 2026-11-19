/** RE row inspector: exact row detail, on-demand classification, field overlay grid, entropy, period/jitter, markers. */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useI18n, type TranslationKey } from '../../i18n';
import { reClassify, reRowDetail } from '../../services/reClient';
import { reDebugLogger } from '../../store/reDebugLog';
import type { ReMarkerDto, ReClassificationDto, ReFieldDto, ReFieldKind, ReRowDetailDto } from '../../types/re';
import type { ReRowView } from '../../store/reStore';
import { bitIsSet, fieldBits, formatArbId, formatElapsed, hexToBytes, KIND_ORDER } from './reModel';
import { kindColors, RE_MONO_FONT, useReTheme, withAlpha } from './reTheme';
import { DIAG_BTN, DiagBadge, diagToneButtonClass } from '../diagnostics/diagUi';

const KIND_KEYS: Record<ReFieldKind, TranslationKey> = {
  constant: 're.kind.constant',
  counter: 're.kind.counter',
  checksum: 're.kind.checksum',
  flag: 're.kind.flag',
  physical: 're.kind.physical',
  unknown: 're.kind.unknown',
};

const NOT_TRACKED = '\u0000not-tracked';
const GRID_ROW_H = 20;
const GRID_LABEL_W = 34;
const GRID_CELL = 22;
const ENT_X = GRID_LABEL_W + 8 * GRID_CELL + 16;
const ENT_BAR = 8;
const GRID_W = ENT_X + 8 * ENT_BAR + 8;
const HEAD_H = 16;

interface GridProps {
  dlcBytes: number;
  fields: readonly ReFieldDto[];
  diff: Uint8Array;
  noisy: Uint8Array | null;
  entropy: readonly number[];
}

/** byte x bit grid (MSB left, like BitLayoutMatrix) with field kind overlay, diff outline and per-bit entropy bars. */
function ReFieldGrid({ dlcBytes, fields, diff, noisy, entropy }: GridProps): React.ReactElement {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const theme = useReTheme();
  useEffect(() => {
    const canvas = ref.current;
    if (canvas === null) return;
    const h = HEAD_H + dlcBytes * GRID_ROW_H;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(GRID_W * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = `${GRID_W}px`;
    canvas.style.height = `${h}px`;
    const ctx = canvas.getContext('2d');
    if (ctx === null) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const kc = kindColors(theme);
    ctx.fillStyle = theme.bgCanvas;
    ctx.fillRect(0, 0, GRID_W, h);
    ctx.font = `10px ${RE_MONO_FONT}`;
    ctx.textBaseline = 'middle';
    ctx.fillStyle = theme.textMuted;
    for (let k = 7; k >= 0; k -= 1) {
      ctx.textAlign = 'center';
      ctx.fillText(String(k), GRID_LABEL_W + (7 - k) * GRID_CELL + GRID_CELL / 2, HEAD_H / 2);
    }
    ctx.fillText('H(bit)', ENT_X + 4 * ENT_BAR, HEAD_H / 2);
    const owner = new Int16Array(dlcBytes * 8).fill(-1);
    fields.forEach((f, i) => {
      for (const b of fieldBits(f, dlcBytes * 8)) owner[b] = i;
    });
    for (let b = 0; b < dlcBytes; b += 1) {
      const y = HEAD_H + b * GRID_ROW_H;
      ctx.textAlign = 'left';
      ctx.fillStyle = theme.textMuted;
      ctx.fillText(`B${b}`, 4, y + GRID_ROW_H / 2);
      for (let k = 7; k >= 0; k -= 1) {
        const bit = b * 8 + k;
        const x = GRID_LABEL_W + (7 - k) * GRID_CELL;
        const o = owner[bit];
        if (o >= 0) {
          const f = fields[o];
          ctx.globalAlpha = f.kind === 'constant' ? 0.45 : 0.35 + 0.65 * Math.max(0, Math.min(1, f.confidence));
          ctx.fillStyle = kc[f.kind];
        } else {
          ctx.globalAlpha = 1;
          ctx.fillStyle = theme.bgElevated;
        }
        ctx.fillRect(x + 1, y + 1, GRID_CELL - 2, GRID_ROW_H - 2);
        ctx.globalAlpha = 1;
        if (bitIsSet(diff, bit)) {
          ctx.strokeStyle = theme.warn;
          ctx.lineWidth = 2;
          ctx.strokeRect(x + 2, y + 2, GRID_CELL - 4, GRID_ROW_H - 4);
        }
        if (noisy !== null && bitIsSet(noisy, bit)) {
          ctx.fillStyle = withAlpha(theme.warn, 0.6);
          ctx.fillRect(x + GRID_CELL - 7, y + 2, 5, 5);
        }
        const e = entropy[bit] ?? 0;
        const bx = ENT_X + (7 - k) * ENT_BAR;
        ctx.fillStyle = theme.bgSurface;
        ctx.fillRect(bx, y + 2, ENT_BAR - 1, GRID_ROW_H - 4);
        ctx.fillStyle = theme.textSecondary;
        const bh = Math.round((GRID_ROW_H - 4) * Math.max(0, Math.min(1, e)));
        ctx.fillRect(bx, y + GRID_ROW_H - 2 - bh, ENT_BAR - 1, bh);
      }
    }
  }, [dlcBytes, fields, diff, noisy, entropy, theme]);
  return <canvas ref={ref} />;
}

function fieldDetail(f: ReFieldDto): string {
  const parts: string[] = [];
  if (f.counterModulo !== undefined) parts.push(`mod ${f.counterModulo}`);
  if (f.counterStep !== undefined) parts.push(`step ${f.counterStep}`);
  if (f.checksumAlgo !== undefined) parts.push(f.checksumAlgo);
  if (f.checksumInit !== undefined) parts.push(`init 0x${f.checksumInit.toString(16).toUpperCase().padStart(2, '0')}`);
  if (f.checksumCoverage !== undefined) parts.push(`cov ${f.checksumCoverage}`);
  if (f.min !== undefined && f.max !== undefined) parts.push(`[${f.min} .. ${f.max}]`);
  return parts.join('  ');
}

export interface ReRowInspectorProps {
  row: ReRowView | null;
  markers: readonly ReMarkerDto[];
  startedAtUs: number | null;
  demo: boolean;
  /** Opens the R2a Signal Inspector for this row; `field` seeds a candidate (classifier physical field) or null. */
  onInspect: (field: ReFieldDto | null) => void;
}

export function ReRowInspector({ row, markers, startedAtUs, demo, onInspect }: ReRowInspectorProps): React.ReactElement {
  const { t } = useI18n();
  const [detail, setDetail] = useState<ReRowDetailDto | null>(null);
  const [cls, setCls] = useState<ReClassificationDto | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const keyRef = useRef<string | null>(null);
  const theme = useReTheme();
  const kc = kindColors(theme);

  const bus = row?.bus;
  const arbId = row?.arbId;
  const ext = row?.extended;
  const key = row?.key ?? null;

  const load = useCallback(
    async (withClassify: boolean): Promise<void> => {
      if (bus === undefined || arbId === undefined || ext === undefined) return;
      const k = { bus, arbId, isExtended: ext };
      const mine = `${bus}:${ext}:${arbId}`;
      setBusy(true);
      setErr(null);
      let step: 're.row_detail' | 're.classify' = 're.row_detail';
      try {
        const d = await reRowDetail(k);
        step = 're.classify';
        const c = withClassify ? await reClassify(k) : null;
        if (keyRef.current !== mine) return;
        setDetail(d);
        if (c !== null) setCls(c);
      } catch (e) {
        reDebugLogger.error(
          step,
          step === 're.row_detail' ? 'RE row detail failed' : 'RE classify failed',
          e,
          `bus=${k.bus} id=0x${k.arbId.toString(16).toUpperCase()}${k.isExtended ? 'x' : ''}`,
        );
        if (keyRef.current === mine) {
          const msg = e instanceof Error ? e.message : String(e);
          setErr(/not found/i.test(msg) ? NOT_TRACKED : msg);
        }
      } finally {
        if (keyRef.current === mine) setBusy(false);
      }
    },
    [bus, arbId, ext],
  );

  useEffect(() => {
    keyRef.current = row === null ? null : `${row.bus}:${row.extended}:${row.arbId}`;
    setDetail(null);
    setCls(null);
    setErr(null);
    if (row !== null) void load(false);
    // reload only when the selected row identity changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const mono = 'font-mono tabular-nums';
  const panelStyle = { backgroundColor: 'var(--bg-panel)', borderColor: 'var(--border-strong)' } as const;

  if (row === null) {
    return (
      <div className="h-full p-3 text-[12px] text-[var(--text-muted)]" style={panelStyle}>
        {t('re.inspector.empty')}
      </div>
    );
  }

  const toggleTotal = detail === null ? 0 : detail.toggles.reduce((a, b) => a + b, 0);
  const diff = detail === null ? row.diff : hexToBytes(detail.diffMask);
  const fields = cls?.fields ?? [];
  const noisy = detail?.noisyMask !== undefined ? hexToBytes(detail.noisyMask) : null;

  return (
    <div className="h-full overflow-auto text-[12px] text-[var(--text-primary)]" style={panelStyle}>
      <div className="px-3 py-2 border-b border-hairline flex items-center gap-2 flex-wrap">
        <span className={`${mono} text-[14px] font-semibold`}>0x{formatArbId(row.arbId, row.extended)}</span>
        <span className={`${mono} text-[var(--text-muted)]`}>
          bus {row.bus} {row.fd ? 'FD' : 'CAN'} {row.extended ? 'EXT' : 'STD'} DLC {row.dlcBytes}
        </span>
        {demo && <DiagBadge tone="warn" title={t('re.demo.tooltip')}>{t('re.demo.badge')}</DiagBadge>}
        <button
          type="button"
          onClick={() => onInspect(null)}
          className={`ml-auto ${diagToneButtonClass('nominal', true)}`}
        >
          {t('re.inspector.inspectSignal')}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void load(true)}
          className={DIAG_BTN}
        >
          {busy ? t('re.inspector.analyzing') : t('re.inspector.analyze')}
        </button>
      </div>

      {err === NOT_TRACKED && <div className="px-3 py-1.5 text-[var(--text-muted)]">{t('re.inspector.notTracked')}</div>}
      {err !== null && err !== NOT_TRACKED && <div className="px-3 py-1.5 text-critical">{err}</div>}

      <div className="px-3 py-2 grid grid-cols-2 gap-x-4 gap-y-0.5">
        <span className="text-[var(--text-muted)]">{t('re.inspector.rx')}</span>
        <span className={mono}>{detail?.rxCount ?? row.rxCount}</span>
        <span className="text-[var(--text-muted)]">{t('re.inspector.toggles')}</span>
        <span className={mono}>{toggleTotal}</span>
        <span className="text-[var(--text-muted)]">{t('re.inspector.history')}</span>
        <span className={mono}>{detail?.historyLen ?? 0}</span>
        <span className="text-[var(--text-muted)]">{t('re.inspector.period')}</span>
        <span className={mono}>{cls?.periodMs != null ? `${cls.periodMs.toFixed(2)} ms` : '-'}</span>
        <span className="text-[var(--text-muted)]">{t('re.inspector.jitter')}</span>
        <span className={mono}>{cls?.jitterMs != null ? `${cls.jitterMs.toFixed(3)} ms` : '-'}</span>
        <span className="text-[var(--text-muted)]">{t('re.inspector.diffMask')}</span>
        <span className={`${mono} break-all`}>{detail?.diffMask ?? '-'}</span>
        <span className="text-[var(--text-muted)]">{t('re.inspector.constMask')}</span>
        <span className={`${mono} break-all`}>{detail?.constantMask ?? '-'}</span>
      </div>

      <div className="px-3 pt-1 pb-1 text-[11px] uppercase tracking-wide text-[var(--text-muted)]">
        {t('re.inspector.fieldMap')}
        {cls !== null && <span className={`${mono} normal-case ml-2`}>({t('re.inspector.samples', { n: cls.samples })})</span>}
      </div>
      {cls !== null && cls.fields.length === 0 && (
        <div className="px-3 pb-1 text-warn">{t('re.inspector.notEnough')}</div>
      )}
      <div className="px-3 pb-2 overflow-x-auto">
        <ReFieldGrid dlcBytes={row.dlcBytes} fields={fields} diff={diff} noisy={noisy} entropy={cls?.bitEntropy ?? []} />
      </div>

      <div className="px-3 pb-2 flex flex-wrap gap-x-3 gap-y-1">
        {KIND_ORDER.map((k) => (
          <span key={k} className="inline-flex items-center gap-1.5 text-[11px]">
            <span className="inline-block w-3 h-3" style={{ backgroundColor: kc[k] }} />
            {t(KIND_KEYS[k])}
          </span>
        ))}
        <span className="inline-flex items-center gap-1.5 text-[11px]">
          <span className="inline-block w-3 h-3 border-2 border-warn" />
          {t('re.legend.diff')}
        </span>
        <span className="inline-flex items-center gap-1.5 text-[11px]">
          <span className="inline-block w-2 h-2" style={{ backgroundColor: withAlpha(theme.warn, 0.6) }} />
          {t('re.legend.noisy')}
        </span>
      </div>

      {fields.length > 0 && (
        <div className="px-3 pb-2">
          {fields.map((f) => (
            <div key={`${f.startBit}:${f.bitLength}`} className={`${mono} flex gap-2 py-0.5 border-t border-hairline`}>
              <span className="inline-block w-2.5 h-2.5 mt-1 shrink-0" style={{ backgroundColor: kc[f.kind] }} />
              <span className="w-[74px] shrink-0">{t(KIND_KEYS[f.kind])}</span>
              <span className="w-[92px] shrink-0 text-[var(--text-muted)]">
                @{f.startBit} +{f.bitLength} {f.byteOrder === 'intel' ? 'I' : 'M'}
              </span>
              <span className="w-[40px] shrink-0">{Math.round(f.confidence * 100)}%</span>
              <span className="text-[var(--text-secondary)]">{fieldDetail(f)}</span>
              {f.kind === 'physical' && (
                <button
                  type="button"
                  onClick={() => onInspect(f)}
                  className={`ml-auto ${diagToneButtonClass('nominal', true, 'sm')}`}
                >
                  {t('re.inspector.inspectField')}
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="px-3 pt-1 pb-1 text-[11px] uppercase tracking-wide text-[var(--text-muted)]">
        {t('re.inspector.markers')} <span className={mono}>({markers.length})</span>
      </div>
      <div className="px-3 pb-3">
        {markers.length === 0 && <div className="text-[var(--text-muted)]">{t('re.inspector.noMarkers')}</div>}
        {markers
          .slice()
          .reverse()
          .map((m) => (
            <div key={m.id} className={`${mono} flex gap-2 py-0.5`}>
              <span className="w-[26px] text-[var(--text-muted)]">#{m.id}</span>
              <span className="w-[70px]">{startedAtUs === null ? '-' : formatElapsed(m.tsUs - startedAtUs)}</span>
              <span className="w-[56px] text-[var(--text-muted)]">{m.phase}</span>
              <span className="font-sans truncate">{m.label === '' ? '-' : m.label}</span>
            </div>
          ))}
      </div>
    </div>
  );
}
