'use client';

import React, { useEffect, useMemo, useState } from 'react';
import {
  BookmarkPlus,
  Calculator,
  Grid,
  Plus,
  Trash2,
} from 'lucide-react';
import {
  computePhysicalMinMaxFromEncoding,
  sanitizeDbcIdentifier,
  type ByteOrderKind,
  type DatabaseSchemaDto,
  type MuxRoleKind,
  type ReusableValueTableDto,
  type SignalSchemaDto,
  type SignalValueTypeKind,
} from './contracts';
import { useDbcStudioI18n } from './i18n/dbcStudio';
import { CandbModalShell, type CandbModalTabItem } from './CandbModalShell';
import {
  formatHexArbId,
  formatMuxRangesText,
  parseMuxRangesText,
  type SignalDialogTab,
} from './dbcEditorUtils';

interface CandbSignalDialogProps {
  mode?: 'create' | 'edit';
  signal: SignalSchemaDto;
  schema: DatabaseSchemaDto;
  valueTables: readonly ReusableValueTableDto[];
  initialTab?: SignalDialogTab;
  returnToMessageKey?: string;
  lockParentMessage?: boolean;
  canMutate: boolean;
  onUpdateSignal: (signalId: number, patch: Partial<SignalSchemaDto>) => void;
  onCreateSignal?: () => void;
  onDeleteSignal: (signalId: number) => void;
  onSaveValueTableTemplate: (vt: ReusableValueTableDto) => void;
  onAddEcu: () => void;
  onOpenParentMessage: (messageKey: string, openLayoutTab: boolean) => void;
  onClose: () => void;
}

export function CandbSignalDialog({
  mode = 'edit',
  signal,
  schema,
  valueTables,
  initialTab = 'definition',
  returnToMessageKey,
  lockParentMessage = false,
  canMutate,
  onUpdateSignal,
  onCreateSignal,
  onDeleteSignal,
  onSaveValueTableTemplate,
  onAddEcu,
  onOpenParentMessage,
  onClose,
}: CandbSignalDialogProps): React.JSX.Element {
  const { t } = useDbcStudioI18n();
  const [activeTab, setActiveTab] = useState<SignalDialogTab>(initialTab);
  const [muxRangesDraft, setMuxRangesDraft] = useState<string>(() =>
    formatMuxRangesText(signal.muxRanges)
  );
  const [selectedTemplateIdx, setSelectedTemplateIdx] = useState<string>(
    valueTables.length > 0 ? '0' : ''
  );
  const [newEnumVal, setNewEnumVal] = useState<string>('0');
  const [newEnumDesc, setNewEnumDesc] = useState<string>('');
  const [savedTemplateFlash, setSavedTemplateFlash] = useState<boolean>(false);

  useEffect(() => {
    setActiveTab(initialTab);
  }, [initialTab]);

  useEffect(() => {
    setMuxRangesDraft(formatMuxRangesText(signal.muxRanges));
  }, [signal.muxRanges, signal.signalId]);

  const parentMessage = useMemo(
    () =>
      schema.messages.find((m) => m.messageKey === signal.messageKey) ?? null,
    [schema.messages, signal.messageKey]
  );

  const siblingSignals = useMemo(
    () =>
      schema.signals.filter(
        (s) =>
          s.messageKey === signal.messageKey && s.signalId !== signal.signalId
      ),
    [schema.signals, signal.messageKey, signal.signalId]
  );

  const sortedEnumEntries = useMemo(
    () =>
      Object.entries(signal.enumTable ?? {}).sort(
        ([a], [b]) => Number(a) - Number(b)
      ),
    [signal.enumTable]
  );

  const handleAddEnumPair = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canMutate) return;
    const num = Math.trunc(Number(newEnumVal));
    if (!Number.isFinite(num) || !newEnumDesc.trim()) return;
    onUpdateSignal(signal.signalId, {
      enumTable: {
        ...(signal.enumTable ?? {}),
        [String(num)]: newEnumDesc.trim(),
      },
    });
    setNewEnumVal(String(num + 1));
    setNewEnumDesc('');
  };

  const handleApplyTemplate = () => {
    if (!canMutate || selectedTemplateIdx === '') return;
    const idx = Number.parseInt(selectedTemplateIdx, 10);
    const tpl = valueTables[idx];
    if (!tpl) return;
    onUpdateSignal(signal.signalId, {
      enumTable: { ...tpl.entries },
    });
  };

  const handleSaveAsTemplate = () => {
    if (!canMutate || sortedEnumEntries.length === 0) return;
    onSaveValueTableTemplate({
      name: sanitizeDbcIdentifier(`VT_${signal.name}`, 'VT_SignalEnum'),
      entries: { ...signal.enumTable },
    });
    setSavedTemplateFlash(true);
    window.setTimeout(() => setSavedTemplateFlash(false), 1800);
  };

  const tabs: ReadonlyArray<CandbModalTabItem<SignalDialogTab>> = [
    { id: 'definition', label: t('sigDialog.tab.definition') },
    {
      id: 'values',
      label: t('sigDialog.tab.values'),
      count: sortedEnumEntries.length,
    },
    {
      id: 'receivers',
      label: t('sigDialog.tab.receivers'),
      count: signal.receivers.length,
    },
    { id: 'comment', label: t('sigDialog.tab.comment') },
  ];

  const isNameEmpty = signal.name.trim().length === 0;

  return (
    <CandbModalShell<SignalDialogTab>
      badge={
        mode === 'create' ? t('sigDialog.badgeCreate') : t('sigDialog.badgeEdit')
      }
      title={
        mode === 'create'
          ? t('sigDialog.titleCreate', {
              name: signal.name.trim() || t('sigDialog.untitledSignal'),
            })
          : t('sigDialog.titleEdit', { name: signal.name })
      }
      subtitle={
        parentMessage
          ? t('sigDialog.subtitleWithParent', {
              msgName: parentMessage.name,
              hexId: formatHexArbId(
                parentMessage.arbId,
                parentMessage.isExtended
              ),
              start: signal.startBit,
              length: signal.bitLength,
            })
          : t('sigDialog.subtitleNoParent', {
              start: signal.startBit,
              length: signal.bitLength,
            })
      }
      maxWidthClass="max-w-5xl"
      heightClass="h-[78vh] max-h-[760px]"
      tabs={tabs}
      activeTab={activeTab}
      onTabChange={setActiveTab}
      backLabel={returnToMessageKey ? t('sigDialog.backToMessage') : undefined}
      onBack={
        returnToMessageKey
          ? mode === 'create'
            ? onClose
            : () => onOpenParentMessage(returnToMessageKey, false)
          : undefined
      }
      headerRight={
        mode === 'edit' && parentMessage ? (
          <button
            type="button"
            onClick={() => onOpenParentMessage(parentMessage.messageKey, true)}
            className="inline-flex h-7 cursor-pointer items-center gap-1 rounded-[2px] border border-hairline bg-surface px-2.5 text-xs text-ink transition-colors hover:border-strong"
          >
            <Grid className="h-3.5 w-3.5 text-focus" aria-hidden="true" />
            <span>{t('sigDialog.messageLayoutBtn')}</span>
          </button>
        ) : undefined
      }
      onClose={onClose}
      footer={
        mode === 'create' ? (
          <>
            <span className="text-[11px] text-muted">
              {t('sigDialog.cancelDraftHint')}
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onClose}
                className="inline-flex h-7 cursor-pointer items-center rounded-[2px] border border-hairline bg-surface px-3 text-xs text-ink transition-colors hover:border-strong"
              >
                {t('common.cancel')}
              </button>
              <button
                type="button"
                disabled={!canMutate || isNameEmpty}
                onClick={() => onCreateSignal?.()}
                className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-[2px] px-3.5 text-xs font-semibold text-on-accent transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-45"
                style={{ backgroundColor: 'var(--status-nominal)' }}
              >
                <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                <span>{t('sigDialog.createBtn')}</span>
              </button>
            </div>
          </>
        ) : (
          <>
            <div>
              {canMutate && (
                <button
                  type="button"
                  onClick={() => {
                    onDeleteSignal(signal.signalId);
                    if (returnToMessageKey) {
                      onOpenParentMessage(returnToMessageKey, false);
                    } else {
                      onClose();
                    }
                  }}
                  className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-[2px] border border-hairline bg-surface px-2.5 text-xs text-critical transition-colors hover:border-critical"
                >
                  <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>{t('sigDialog.deleteBtn')}</span>
                </button>
              )}
            </div>
            <button
              type="button"
              onClick={onClose}
              className="inline-flex h-7 cursor-pointer items-center rounded-[2px] bg-focus px-4 text-xs font-semibold text-on-accent transition-opacity hover:opacity-90"
            >
              {t('common.ok')}
            </button>
          </>
        )
      }
    >
      {/* TAB 1: DEFINITION */}
      {activeTab === 'definition' && (
        <div className="p-5 space-y-5 text-xs">
          {/* Identity & Parent Message */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <label className="block text-xs font-medium text-muted">
                {t('sigDialog.fieldName')}
              </label>
              <input
                type="text"
                disabled={!canMutate}
                value={signal.name}
                placeholder={t('sigDialog.placeholderName')}
                onChange={(e) =>
                  onUpdateSignal(signal.signalId, { name: e.target.value })
                }
                className="h-8 w-full rounded-[2px] border border-hairline bg-canvas px-3 font-mono text-xs font-semibold text-ink placeholder:text-subtle focus:border-focus focus:outline-none disabled:opacity-60"
              />
              {isNameEmpty && (
                <p className="font-mono text-[11px] text-critical">
                  {t('sigDialog.emptyNameError')}
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <label className="block text-xs font-medium text-muted">
                {t('sigDialog.fieldLongName')}
              </label>
              <input
                type="text"
                disabled={!canMutate}
                value={signal.longName ?? ''}
                placeholder={t('sigDialog.placeholderLongName')}
                onChange={(e) =>
                  onUpdateSignal(signal.signalId, {
                    longName:
                      e.target.value.trim().length > 0 ? e.target.value : null,
                  })
                }
                className="h-8 w-full rounded-[2px] border border-hairline bg-canvas px-3 text-xs text-ink placeholder:text-subtle focus:border-focus focus:outline-none disabled:opacity-60"
              />
            </div>

            <div className="sm:col-span-2 space-y-1.5">
              <label className="block text-xs font-medium text-muted">
                {t('sigDialog.fieldParentMsg')}
              </label>
              <select
                disabled={!canMutate || lockParentMessage}
                value={signal.messageKey}
                onChange={(e) => {
                  const nextMsgKey = e.target.value;
                  if (nextMsgKey && nextMsgKey !== signal.messageKey) {
                    onUpdateSignal(signal.signalId, {
                      messageKey: nextMsgKey,
                      switchSignalId: null,
                    });
                  }
                }}
                className="h-8 w-full cursor-pointer rounded-[2px] border border-hairline bg-canvas px-2.5 font-mono text-xs tabular-nums text-ink focus:border-focus focus:outline-none disabled:opacity-60"
              >
                {schema.messages.map((m) => (
                  <option key={m.messageKey} value={m.messageKey}>
                    {t('sigDialog.optParentMsg', {
                      name: m.name,
                      hexId: formatHexArbId(m.arbId, m.isExtended),
                      dlc: m.dlc,
                    })}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Bit Placement & Encoding */}
          <div className="rounded-[2px] border border-hairline bg-canvas p-4 space-y-3.5">
            <h3 className="text-xs font-semibold text-ink">
              {t('sigDialog.sectionBitEncoding')}
            </h3>
            <div className="grid grid-cols-2 gap-3.5 sm:grid-cols-4">
              <div className="space-y-1">
                <label className="block text-[11px] text-muted">
                  {t('sigDialog.fieldStartBit')}
                </label>
                <input
                  type="number"
                  min={0}
                  max={511}
                  disabled={!canMutate}
                  value={signal.startBit}
                  onChange={(e) =>
                    onUpdateSignal(signal.signalId, {
                      startBit: Math.max(
                        0,
                        Math.min(
                          511,
                          Number.parseInt(e.target.value, 10) || 0
                        )
                      ),
                    })
                  }
                  className="h-8 w-full rounded-[2px] border border-hairline bg-surface px-2.5 font-mono text-xs tabular-nums text-ink focus:border-focus focus:outline-none disabled:opacity-60"
                />
              </div>

              <div className="space-y-1">
                <label className="block text-[11px] text-muted">
                  {t('sigDialog.fieldBitLength')}
                </label>
                <input
                  type="number"
                  min={1}
                  max={64}
                  disabled={
                    !canMutate ||
                    signal.valueType === 'float32' ||
                    signal.valueType === 'float64'
                  }
                  value={signal.bitLength}
                  onChange={(e) =>
                    onUpdateSignal(signal.signalId, {
                      bitLength: Math.max(
                        1,
                        Math.min(64, Number.parseInt(e.target.value, 10) || 1)
                      ),
                    })
                  }
                  className="h-8 w-full rounded-[2px] border border-hairline bg-surface px-2.5 font-mono text-xs tabular-nums text-ink focus:border-focus focus:outline-none disabled:opacity-60"
                />
              </div>

              <div className="space-y-1">
                <label className="block text-[11px] text-muted">
                  {t('sigDialog.fieldByteOrder')}
                </label>
                <select
                  disabled={!canMutate}
                  value={signal.byteOrder}
                  onChange={(e) =>
                    onUpdateSignal(signal.signalId, {
                      byteOrder: e.target.value as ByteOrderKind,
                    })
                  }
                  className="h-8 w-full cursor-pointer rounded-[2px] border border-hairline bg-surface px-2 font-mono text-xs tabular-nums text-ink focus:border-focus focus:outline-none disabled:opacity-60"
                >
                  <option value="littleEndian">
                    {t('sigDialog.optIntelLe')}
                  </option>
                  <option value="bigEndian">
                    {t('sigDialog.optMotorolaBe')}
                  </option>
                </select>
              </div>

              <div className="space-y-1">
                <label className="block text-[11px] text-muted">
                  {t('sigDialog.fieldValueType')}
                </label>
                <select
                  disabled={!canMutate}
                  value={signal.valueType}
                  onChange={(e) => {
                    const vt = e.target.value as SignalValueTypeKind;
                    const nextLen =
                      vt === 'float32'
                        ? 32
                        : vt === 'float64'
                          ? 64
                          : signal.bitLength;
                    const { min, max } = computePhysicalMinMaxFromEncoding({
                      bitLength: nextLen,
                      valueType: vt,
                      factor: signal.factor,
                      offset: signal.offset,
                    });
                    onUpdateSignal(signal.signalId, {
                      valueType: vt,
                      bitLength: nextLen,
                      min,
                      max,
                    });
                  }}
                  className="h-8 w-full cursor-pointer rounded-[2px] border border-hairline bg-surface px-2 text-xs text-ink focus:border-focus focus:outline-none disabled:opacity-60"
                >
                  <option value="unsigned">{t('sigDialog.optUnsigned')}</option>
                  <option value="signed">{t('sigDialog.optSigned')}</option>
                  <option value="float32">{t('sigDialog.optFloat32')}</option>
                  <option value="float64">{t('sigDialog.optFloat64')}</option>
                </select>
              </div>
            </div>
          </div>

          {/* Physical Scaling */}
          <div className="rounded-[2px] border border-hairline bg-canvas p-4 space-y-3.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-xs font-semibold text-ink">
                {t('sigDialog.sectionScalingBounds')}
              </h3>
              {canMutate && (
                <button
                  type="button"
                  onClick={() => {
                    const { min, max } = computePhysicalMinMaxFromEncoding({
                      bitLength: signal.bitLength,
                      valueType: signal.valueType,
                      factor: signal.factor,
                      offset: signal.offset,
                    });
                    onUpdateSignal(signal.signalId, { min, max });
                  }}
                  className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-[2px] border border-hairline bg-elevated px-2.5 text-xs font-medium text-focus transition-colors hover:border-strong hover:text-ink"
                >
                  <Calculator className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>{t('sigDialog.autoCalcMinMax')}</span>
                </button>
              )}
            </div>

            <div className="grid grid-cols-2 gap-3.5 sm:grid-cols-3">
              <div className="space-y-1">
                <label className="block text-[11px] text-muted">
                  {t('sigDialog.fieldFactor')}
                </label>
                <input
                  type="number"
                  step="any"
                  disabled={!canMutate}
                  value={signal.factor}
                  onChange={(e) => {
                    const v = Number.parseFloat(e.target.value);
                    if (Number.isFinite(v) && v !== 0) {
                      onUpdateSignal(signal.signalId, { factor: v });
                    }
                  }}
                  className="h-8 w-full rounded-[2px] border border-hairline bg-surface px-2.5 font-mono text-xs tabular-nums text-ink focus:border-focus focus:outline-none disabled:opacity-60"
                />
              </div>

              <div className="space-y-1">
                <label className="block text-[11px] text-muted">
                  {t('sigDialog.fieldOffset')}
                </label>
                <input
                  type="number"
                  step="any"
                  disabled={!canMutate}
                  value={signal.offset}
                  onChange={(e) => {
                    const v = Number.parseFloat(e.target.value);
                    if (Number.isFinite(v)) {
                      onUpdateSignal(signal.signalId, { offset: v });
                    }
                  }}
                  className="h-8 w-full rounded-[2px] border border-hairline bg-surface px-2.5 font-mono text-xs tabular-nums text-ink focus:border-focus focus:outline-none disabled:opacity-60"
                />
              </div>

              <div className="space-y-1">
                <label className="block text-[11px] text-muted">
                  {t('sigDialog.fieldUnit')}
                </label>
                <input
                  type="text"
                  disabled={!canMutate}
                  value={signal.unit}
                  placeholder="V, A, km/h, °C, rpm"
                  onChange={(e) =>
                    onUpdateSignal(signal.signalId, { unit: e.target.value })
                  }
                  className="h-8 w-full rounded-[2px] border border-hairline bg-surface px-2.5 font-mono text-xs text-ink placeholder:text-subtle focus:border-focus focus:outline-none disabled:opacity-60"
                />
              </div>

              <div className="space-y-1">
                <label className="block text-[11px] text-muted">
                  {t('sigDialog.fieldMin')}
                </label>
                <input
                  type="number"
                  step="any"
                  disabled={!canMutate}
                  value={signal.min}
                  onChange={(e) => {
                    const v = Number.parseFloat(e.target.value);
                    if (Number.isFinite(v)) {
                      onUpdateSignal(signal.signalId, { min: v });
                    }
                  }}
                  className="h-8 w-full rounded-[2px] border border-hairline bg-surface px-2.5 font-mono text-xs tabular-nums text-ink focus:border-focus focus:outline-none disabled:opacity-60"
                />
              </div>

              <div className="space-y-1">
                <label className="block text-[11px] text-muted">
                  {t('sigDialog.fieldMax')}
                </label>
                <input
                  type="number"
                  step="any"
                  disabled={!canMutate}
                  value={signal.max}
                  onChange={(e) => {
                    const v = Number.parseFloat(e.target.value);
                    if (Number.isFinite(v)) {
                      onUpdateSignal(signal.signalId, { max: v });
                    }
                  }}
                  className="h-8 w-full rounded-[2px] border border-hairline bg-surface px-2.5 font-mono text-xs tabular-nums text-ink focus:border-focus focus:outline-none disabled:opacity-60"
                />
              </div>

              <div className="space-y-1">
                <label className="block text-[11px] text-muted">
                  {t('sigDialog.fieldInitialValue')}
                </label>
                <input
                  type="number"
                  step="any"
                  disabled={!canMutate}
                  value={signal.initialValue ?? ''}
                  placeholder="0"
                  onChange={(e) => {
                    const raw = e.target.value.trim();
                    const v = raw === '' ? null : Number.parseFloat(raw);
                    onUpdateSignal(signal.signalId, {
                      initialValue:
                        v !== null && Number.isFinite(v) ? v : null,
                    });
                  }}
                  className="h-8 w-full rounded-[2px] border border-hairline bg-surface px-2.5 font-mono text-xs tabular-nums text-ink placeholder:text-subtle focus:border-focus focus:outline-none disabled:opacity-60"
                />
              </div>
            </div>
          </div>

          {/* Multiplexing */}
          <div className="rounded-[2px] border border-hairline bg-canvas p-4 space-y-3.5">
            <h3 className="text-xs font-semibold text-ink">
              {t('sigDialog.sectionMultiplexing')}
            </h3>
            <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-3">
              <div className="space-y-1">
                <label className="block text-[11px] text-muted">
                  {t('sigDialog.fieldMuxRole')}
                </label>
                <select
                  disabled={!canMutate}
                  value={signal.muxRole}
                  onChange={(e) => {
                    const role = e.target.value as MuxRoleKind;
                    const master = siblingSignals.find(
                      (s) => s.muxRole === 'masterSwitch'
                    );
                    if (role === 'static' || role === 'masterSwitch') {
                      onUpdateSignal(signal.signalId, {
                        muxRole: role,
                        switchSignalId: null,
                        muxRanges: [],
                      });
                    } else {
                      onUpdateSignal(signal.signalId, {
                        muxRole: 'multiplexed',
                        switchSignalId: master ? master.signalId : null,
                        muxRanges:
                          signal.muxRanges.length > 0
                            ? signal.muxRanges
                            : [[0, 0]],
                      });
                    }
                  }}
                  className="h-8 w-full cursor-pointer rounded-[2px] border border-hairline bg-surface px-2 text-xs text-ink focus:border-focus focus:outline-none disabled:opacity-60"
                >
                  <option value="static">{t('sigDialog.optMuxStatic')}</option>
                  <option value="masterSwitch">
                    {t('sigDialog.optMuxMaster')}
                  </option>
                  <option value="multiplexed">
                    {t('sigDialog.optMuxSignal')}
                  </option>
                </select>
              </div>

              {signal.muxRole === 'multiplexed' && (
                <>
                  <div className="space-y-1">
                    <label className="block text-[11px] text-muted">
                      {t('sigDialog.fieldSwitchSignal')}
                    </label>
                    <select
                      disabled={!canMutate}
                      value={signal.switchSignalId ?? ''}
                      onChange={(e) => {
                        const id =
                          e.target.value === ''
                            ? null
                            : Number.parseInt(e.target.value, 10);
                        onUpdateSignal(signal.signalId, {
                          switchSignalId:
                            id !== null && Number.isFinite(id) ? id : null,
                        });
                      }}
                      className="h-8 w-full cursor-pointer rounded-[2px] border border-hairline bg-surface px-2 font-mono text-xs text-ink focus:border-focus focus:outline-none disabled:opacity-60"
                    >
                      <option value="">{t('sigDialog.optDefaultMaster')}</option>
                      {siblingSignals.map((sib) => (
                        <option key={sib.signalId} value={sib.signalId}>
                          {sib.name}{' '}
                          {sib.muxRole === 'masterSwitch' ? '[M]' : '[mX]'}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="space-y-1">
                    <label className="block text-[11px] text-muted">
                      {t('sigDialog.fieldMuxRanges')}
                    </label>
                    <input
                      type="text"
                      disabled={!canMutate}
                      value={muxRangesDraft}
                      onChange={(e) => setMuxRangesDraft(e.target.value)}
                      onBlur={() => {
                        const parsed = parseMuxRangesText(muxRangesDraft);
                        setMuxRangesDraft(formatMuxRangesText(parsed));
                        onUpdateSignal(signal.signalId, { muxRanges: parsed });
                      }}
                      className="h-8 w-full rounded-[2px] border border-hairline bg-surface px-2.5 font-mono text-xs tabular-nums text-warn focus:border-focus focus:outline-none disabled:opacity-60"
                    />
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* TAB 2: VALUE DESCRIPTIONS (VAL_) */}
      {activeTab === 'values' && (
        <div className="p-5 space-y-4 text-xs">
          {/* Apply Reusable Value Table Template */}
          <div className="flex flex-wrap items-end justify-between gap-3 rounded-[2px] border border-hairline bg-canvas p-3.5">
            <div className="flex-1 min-w-[220px] space-y-1">
              <label className="block text-[11px] font-medium text-muted">
                {t('sigDialog.applyTemplateLabel')}
              </label>
              <select
                disabled={!canMutate || valueTables.length === 0}
                value={selectedTemplateIdx}
                onChange={(e) => setSelectedTemplateIdx(e.target.value)}
                className="h-8 w-full cursor-pointer rounded-[2px] border border-hairline bg-surface px-2.5 font-mono text-xs text-ink disabled:opacity-60"
              >
                {valueTables.length === 0 ? (
                  <option value="">{t('sigDialog.noTemplatesOption')}</option>
                ) : (
                  valueTables.map((vt, idx) => (
                    <option key={`${vt.name}-${idx}`} value={String(idx)}>
                      {t('sigDialog.templateOption', {
                        name: vt.name,
                        count: Object.keys(vt.entries).length,
                      })}
                    </option>
                  ))
                )}
              </select>
            </div>

            <div className="flex items-center gap-2">
              {canMutate && valueTables.length > 0 && (
                <button
                  type="button"
                  onClick={handleApplyTemplate}
                  className="inline-flex h-8 cursor-pointer items-center rounded-[2px] bg-focus px-3 text-xs font-semibold text-on-accent transition-opacity hover:opacity-90"
                >
                  {t('sigDialog.applyTemplateBtn')}
                </button>
              )}

              {canMutate && sortedEnumEntries.length > 0 && (
                <button
                  type="button"
                  onClick={handleSaveAsTemplate}
                  className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-[2px] border border-hairline bg-elevated px-3 text-xs text-ink hover:border-strong"
                >
                  <BookmarkPlus
                    className="h-3.5 w-3.5 text-focus"
                    aria-hidden="true"
                  />
                  <span>
                    {savedTemplateFlash
                      ? t('sigDialog.templateSavedFlash')
                      : t('sigDialog.saveAsTemplateBtn')}
                  </span>
                </button>
              )}
            </div>
          </div>

          {/* Enum Pairs Table */}
          <div className="overflow-hidden rounded-[2px] border border-hairline bg-canvas">
            <table className="w-full border-collapse text-left text-xs">
              <thead className="border-b border-hairline bg-elevated text-[11px] font-semibold text-muted">
                <tr>
                  <th className="w-28 py-2 px-3">
                    {t('sigDialog.colIntValue')}
                  </th>
                  <th className="py-2 px-3">{t('sigDialog.colStateDesc')}</th>
                  {canMutate && <th className="w-12 py-2 px-3 text-right" />}
                </tr>
              </thead>
              <tbody className="divide-y divide-hairline bg-surface">
                {sortedEnumEntries.length === 0 ? (
                  <tr>
                    <td
                      colSpan={canMutate ? 3 : 2}
                      className="py-6 text-center text-muted"
                    >
                      {t('sigDialog.emptyValEntries')}
                    </td>
                  </tr>
                ) : (
                  sortedEnumEntries.map(([k, desc]) => (
                    <tr key={k}>
                      <td className="py-1.5 px-3 font-mono font-semibold tabular-nums text-nominal">
                        {k}
                      </td>
                      <td className="py-1.5 px-3">
                        <input
                          type="text"
                          disabled={!canMutate}
                          value={desc}
                          onChange={(e) =>
                            onUpdateSignal(signal.signalId, {
                              enumTable: {
                                ...signal.enumTable,
                                [k]: e.target.value,
                              },
                            })
                          }
                          className="h-7 w-full rounded-[2px] border border-hairline bg-canvas px-2.5 font-mono text-xs text-ink focus:border-focus focus:outline-none disabled:opacity-60"
                        />
                      </td>
                      {canMutate && (
                        <td className="py-1.5 px-3 text-right">
                          <button
                            type="button"
                            onClick={() => {
                              const next = { ...signal.enumTable };
                              delete next[k];
                              onUpdateSignal(signal.signalId, {
                                enumTable: next,
                              });
                            }}
                            aria-label={t('sigDialog.deleteValEntryAria', {
                              key: k,
                            })}
                            className="cursor-pointer rounded-[2px] p-1 text-muted hover:text-critical"
                          >
                            <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                          </button>
                        </td>
                      )}
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          {canMutate && (
            <form onSubmit={handleAddEnumPair} className="flex items-center gap-2">
              <input
                type="number"
                step={1}
                value={newEnumVal}
                onChange={(e) => setNewEnumVal(e.target.value)}
                placeholder={t('sigDialog.placeholderEnumVal')}
                className="h-8 w-28 rounded-[2px] border border-hairline bg-canvas px-2.5 font-mono text-xs tabular-nums text-ink focus:border-focus focus:outline-none"
              />
              <input
                type="text"
                value={newEnumDesc}
                onChange={(e) => setNewEnumDesc(e.target.value)}
                placeholder={t('sigDialog.placeholderEnumDesc')}
                className="h-8 flex-1 rounded-[2px] border border-hairline bg-canvas px-3 font-mono text-xs text-ink placeholder:text-subtle focus:border-focus focus:outline-none"
              />
              <button
                type="submit"
                className="inline-flex h-8 cursor-pointer items-center gap-1 rounded-[2px] border border-hairline bg-elevated px-3 text-xs font-medium text-ink hover:border-strong"
              >
                <Plus className="h-3.5 w-3.5 text-nominal" aria-hidden="true" />
                <span>{t('sigDialog.addEnumValueBtn')}</span>
              </button>
            </form>
          )}
        </div>
      )}

      {/* TAB 3: RECEIVERS (BU_) */}
      {activeTab === 'receivers' && (
        <div className="p-5 space-y-4 text-xs">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="font-semibold text-ink">
                {t('sigDialog.rxTitle')}
              </h3>
              <p className="mt-0.5 text-muted">{t('sigDialog.rxDescription')}</p>
            </div>

            {canMutate && (
              <div className="flex items-center gap-1.5">
                {schema.ecus.length > 0 && (
                  <>
                    <button
                      type="button"
                      onClick={() =>
                        onUpdateSignal(signal.signalId, {
                          receivers: schema.ecus.map((e) => e.name),
                        })
                      }
                      className="h-7 cursor-pointer rounded-[2px] border border-hairline bg-elevated px-2.5 text-xs text-ink hover:border-strong"
                    >
                      {t('common.selectAll')}
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        onUpdateSignal(signal.signalId, { receivers: [] })
                      }
                      className="h-7 cursor-pointer rounded-[2px] border border-hairline bg-elevated px-2.5 text-xs text-muted hover:text-ink"
                    >
                      {t('common.clear')}
                    </button>
                  </>
                )}
                <button
                  type="button"
                  onClick={onAddEcu}
                  className="inline-flex h-7 cursor-pointer items-center gap-1 rounded-[2px] border border-hairline bg-elevated px-2.5 text-xs text-ink hover:border-strong"
                >
                  <Plus className="h-3.5 w-3.5 text-focus" aria-hidden="true" />
                  <span>{t('sigDialog.addNewEcuShort')}</span>
                </button>
              </div>
            )}
          </div>

          {schema.ecus.length === 0 ? (
            <div className="rounded-[2px] border border-hairline bg-canvas p-6 text-center text-muted">
              {t('sigDialog.emptyEcus')}
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 md:grid-cols-3">
              {schema.ecus.map((ecu) => {
                const checked = signal.receivers.includes(ecu.name);
                return (
                  <label
                    key={ecu.name}
                    className={`flex cursor-pointer items-center gap-2 rounded-[2px] border px-3 py-2 transition-colors ${
                      checked
                        ? 'border-strong bg-elevated text-ink'
                        : 'border-hairline bg-canvas text-muted hover:text-ink'
                    }`}
                  >
                    <input
                      type="checkbox"
                      disabled={!canMutate}
                      checked={checked}
                      onChange={() => {
                        const next = checked
                          ? signal.receivers.filter((r) => r !== ecu.name)
                          : [...signal.receivers, ecu.name];
                        onUpdateSignal(signal.signalId, { receivers: next });
                      }}
                      className="accent-focus"
                    />
                    <span className="font-mono font-semibold text-ink">
                      {ecu.name}
                    </span>
                  </label>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* TAB 4: COMMENT (CM_ SG_) */}
      {activeTab === 'comment' && (
        <div className="p-5 space-y-2 text-xs">
          <label className="block font-medium text-muted">
            {t('sigDialog.commentLabel')}
          </label>
          <textarea
            rows={7}
            disabled={!canMutate}
            value={signal.comment ?? ''}
            placeholder={t('sigDialog.commentPlaceholder')}
            onChange={(e) =>
              onUpdateSignal(signal.signalId, {
                comment: e.target.value.length > 0 ? e.target.value : null,
              })
            }
            className="w-full rounded-[2px] border border-hairline bg-canvas p-3 text-xs text-ink placeholder:text-subtle focus:border-focus focus:outline-none disabled:opacity-60"
          />
        </div>
      )}
    </CandbModalShell>
  );
}
