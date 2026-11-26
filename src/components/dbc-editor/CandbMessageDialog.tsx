'use client';

import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Copy,
  Edit3,
  Plus,
  Trash2,
} from 'lucide-react';
import {
   VALID_CAN_DLC_BYTES,
  VALID_CAN_FD_DLC_BYTES,
  formatCanMessageKey,
  type BitOverlapDiagnosticDto,
  type DatabaseSchemaDto,
  type MessageSchemaDto,
  type SignalSchemaDto,
} from './contracts';
import { useDbcStudioI18n } from './i18n/dbcStudio';
import { CandbInteractiveBitMatrixTab } from './CandbInteractiveBitMatrixTab';
import { CandbModalShell, type CandbModalTabItem } from './CandbModalShell';
import {
  buildMessageIdFormatPatch,
  formatHexArbId,
  formatMuxRangesText,
  getMessageIdFormat,
  getSignalColor,
  parseDecimalArbIdInput,
  parseHexArbIdInput,
  type CandbMessageIdFormat,
  type MessageDialogTab,
} from './dbcEditorUtils';

interface CandbMessageDialogProps {
  mode?: 'create' | 'edit';
  message: MessageSchemaDto;
  schema: DatabaseSchemaDto;
  bitOverlaps: readonly BitOverlapDiagnosticDto[];
  initialTab?: MessageDialogTab;
  canMutate: boolean;
  onUpdateMessage: (
    messageKey: string,
    patch: Partial<MessageSchemaDto> & {
      nextArbId?: number;
      nextIsExtended?: boolean;
    }
  ) => void;
  onCreateMessage?: () => void;
  onDeleteMessage: (messageKey: string) => void;
  onAddSignal: (
    messageKey: string,
    overrideStartBit?: number,
    openDialogAfter?: boolean
  ) => void;
  onUpdateSignal: (signalId: number, patch: Partial<SignalSchemaDto>) => void;
  onCloneSignal: (signalId: number) => void;
  onDeleteSignal: (signalId: number) => void;
  onOpenSignalDialog: (signalId: number, returnToMessageKey: string) => void;
  onAddEcu: () => void;
  onClose: () => void;
}

export function CandbMessageDialog({
  mode = 'edit',
  message,
  schema,
  bitOverlaps,
  initialTab = 'definition',
  canMutate,
  onUpdateMessage,
  onCreateMessage,
  onDeleteMessage,
  onAddSignal,
  onUpdateSignal,
  onCloneSignal,
  onDeleteSignal,
  onOpenSignalDialog,
  onAddEcu,
  onClose,
}: CandbMessageDialogProps): React.JSX.Element {
  const { t } = useDbcStudioI18n();
  const [activeTab, setActiveTab] = useState<MessageDialogTab>(initialTab);
  const [hexDraft, setHexDraft] = useState<string>(() =>
    formatHexArbId(message.arbId, message.isExtended)
  );
  const [decDraft, setDecDraft] = useState<string>(() =>
    String(message.arbId)
  );
  const [idCollision, setIdCollision] = useState<{
    hexId: string;
    name: string;
  } | null>(null);
  const [selectedSignalId, setSelectedSignalId] = useState<number | null>(null);

  useEffect(() => {
    setActiveTab(initialTab);
  }, [initialTab]);

  useEffect(() => {
    setHexDraft(formatHexArbId(message.arbId, message.isExtended));
    setDecDraft(String(message.arbId));
    setIdCollision(null);
  }, [message.arbId, message.isExtended, message.messageKey]);

  const messageSignals = useMemo(
    () => schema.signals.filter((s) => s.messageKey === message.messageKey),
    [message.messageKey, schema.signals]
  );

  useEffect(() => {
    if (
      selectedSignalId !== null &&
      !messageSignals.some((s) => s.signalId === selectedSignalId)
    ) {
      setSelectedSignalId(messageSignals[0]?.signalId ?? null);
    } else if (selectedSignalId === null && messageSignals[0]) {
      setSelectedSignalId(messageSignals[0].signalId);
    }
  }, [messageSignals, selectedSignalId]);

  const activeLayoutSignal = useMemo(
    () =>
      selectedSignalId !== null
        ? (messageSignals.find((s) => s.signalId === selectedSignalId) ?? null)
        : null,
    [messageSignals, selectedSignalId]
  );

  const messageOverlaps = useMemo(
    () => bitOverlaps.filter((o) => o.messageKey === message.messageKey),
    [bitOverlaps, message.messageKey]
  );

  const idFormat = getMessageIdFormat(message);
  const validDlcs = useMemo(
    () =>
      message.protocol.toUpperCase().includes('FD')
        ? VALID_CAN_FD_DLC_BYTES
        : VALID_CAN_DLC_BYTES,
    [message.protocol]
  );

  const checkCollisionAndCommitArbId = (nextArb: number) => {
    const candidateKey = formatCanMessageKey(nextArb, message.isExtended);
    const collidingMsg = schema.messages.find(
      (m) =>
        m.messageKey === candidateKey &&
        (mode === 'create' || m.messageKey !== message.messageKey)
    );
    if (collidingMsg) {
      setIdCollision({
        hexId: formatHexArbId(nextArb, message.isExtended),
        name: collidingMsg.name,
      });
      return;
    }
    setIdCollision(null);
    if (nextArb !== message.arbId) {
      onUpdateMessage(message.messageKey, {
        nextArbId: nextArb,
        nextIsExtended: message.isExtended,
      });
    }
  };

  const handleHexChange = (val: string) => {
    setHexDraft(val);
    const parsed = parseHexArbIdInput(val, message.isExtended);
    if (parsed !== null) {
      setDecDraft(String(parsed));
      checkCollisionAndCommitArbId(parsed);
    }
  };

  const handleDecChange = (val: string) => {
    setDecDraft(val);
    const parsed = parseDecimalArbIdInput(val, message.isExtended);
    if (parsed !== null) {
      setHexDraft(formatHexArbId(parsed, message.isExtended));
      checkCollisionAndCommitArbId(parsed);
    }
  };

  const handleHexDecBlur = () => {
    setHexDraft(formatHexArbId(message.arbId, message.isExtended));
    setDecDraft(String(message.arbId));
    setIdCollision(null);
  };

  const handlePrimaryTxChange = (ecuName: string) => {
    if (!canMutate) return;
    if (!ecuName) {
      onUpdateMessage(message.messageKey, { transmitters: [] });
      return;
    }
    const others = message.transmitters.filter((t) => t !== ecuName);
    onUpdateMessage(message.messageKey, {
      transmitters: [ecuName, ...others],
    });
  };

  const toggleTransmitter = (ecuName: string) => {
    if (!canMutate) return;
    const exists = message.transmitters.includes(ecuName);
    const nextTx = exists
      ? message.transmitters.filter((t) => t !== ecuName)
      : [...message.transmitters, ecuName];
    onUpdateMessage(message.messageKey, { transmitters: nextTx });
  };

  const idCollisionWarning = idCollision
    ? t('msgDialog.idCollisionWarn', {
        hexId: idCollision.hexId,
        name: idCollision.name,
      })
    : null;

  const tabs: ReadonlyArray<CandbModalTabItem<MessageDialogTab>> = [
    { id: 'definition', label: t('msgDialog.tab.definition') },
    {
      id: 'signals',
      label: t('msgDialog.tab.signals'),
      count: messageSignals.length,
    },
    {
      id: 'layout',
      label: t('msgDialog.tab.layout'),
      alertCount: messageOverlaps.length,
    },
    {
      id: 'transmitters',
      label: t('msgDialog.tab.transmitters'),
      count: message.transmitters.length,
    },
    { id: 'comment', label: t('msgDialog.tab.comment') },
  ];

  const isNameEmpty = message.name.trim().length === 0;
  const hasActiveKeyCollision =
    mode === 'create' &&
    schema.messages.some((m) => m.messageKey === message.messageKey);

  return (
    <CandbModalShell<MessageDialogTab>
      badge={
        mode === 'create' ? t('msgDialog.badgeCreate') : t('msgDialog.badgeEdit')
      }
      title={
        mode === 'create'
          ? t('msgDialog.titleCreate', {
              name: message.name.trim() || t('msgDialog.untitledMessage'),
            })
          : t('msgDialog.titleEdit', { name: message.name })
      }
      subtitle={t('msgDialog.subtitle', {
        hexId: formatHexArbId(message.arbId, message.isExtended),
        decId: message.arbId,
        dlc: message.dlc,
      })}
      maxWidthClass="max-w-5xl"
      heightClass="h-[78vh] max-h-[760px]"
      tabs={tabs}
      activeTab={activeTab}
      onTabChange={setActiveTab}
      onClose={onClose}
      footer={
        mode === 'create' ? (
          <>
            <div className="flex items-center gap-2 text-xs">
              {messageOverlaps.length > 0 ? (
                <span className="inline-flex items-center gap-1 font-mono text-[11px] text-critical">
                  <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>
                    {t('msgDialog.overlapCellWarn', {
                      count: messageOverlaps.length,
                    })}
                  </span>
                </span>
              ) : (
                <span className="text-[11px] text-muted">
                  {t('msgDialog.cancelDraftHint')}
                </span>
              )}
            </div>
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
                disabled={
                  !canMutate ||
                  isNameEmpty ||
                  Boolean(idCollisionWarning) ||
                  hasActiveKeyCollision
                }
                onClick={() => onCreateMessage?.()}
                className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-[2px] px-3.5 text-xs font-semibold text-on-accent transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-45"
                style={{ backgroundColor: 'var(--status-nominal)' }}
              >
                <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                <span>{t('msgDialog.createBtn')}</span>
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="flex items-center gap-2 text-xs">
              {canMutate && (
                <button
                  type="button"
                  onClick={() => {
                    onDeleteMessage(message.messageKey);
                    onClose();
                  }}
                  className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-[2px] border border-hairline bg-surface px-2.5 text-xs text-critical transition-colors hover:border-critical"
                >
                  <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>{t('msgDialog.deleteBtn')}</span>
                </button>
              )}
              {messageOverlaps.length > 0 && (
                <span className="inline-flex items-center gap-1 font-mono text-[11px] text-critical">
                  <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>
                    {t('msgDialog.overlapCellWarn', {
                      count: messageOverlaps.length,
                    })}
                  </span>
                </span>
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
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="sm:col-span-2 space-y-1.5">
              <label className="block text-xs font-medium text-muted">
                {t('msgDialog.fieldName')}
              </label>
              <input
                type="text"
                disabled={!canMutate}
                value={message.name}
                placeholder={t('msgDialog.placeholderName')}
                onChange={(e) =>
                  onUpdateMessage(message.messageKey, { name: e.target.value })
                }
                className="h-8 w-full rounded-[2px] border border-hairline bg-canvas px-3 font-mono text-xs font-semibold text-ink placeholder:text-subtle focus:border-focus focus:outline-none disabled:opacity-60"
              />
              {isNameEmpty && (
                <p className="font-mono text-[11px] text-critical">
                  {t('msgDialog.emptyNameError')}
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <label className="block text-xs font-medium text-muted">
                {t('msgDialog.fieldIdHex')}
              </label>
              <input
                type="text"
                disabled={!canMutate}
                value={hexDraft}
                onChange={(e) => handleHexChange(e.target.value)}
                onBlur={handleHexDecBlur}
                className="h-8 w-full rounded-[2px] border border-hairline bg-canvas px-3 font-mono text-xs font-semibold tabular-nums text-focus focus:border-focus focus:outline-none disabled:opacity-60"
              />
            </div>

            <div className="space-y-1.5">
              <label className="block text-xs font-medium text-muted">
                {t('msgDialog.fieldIdDec')}
              </label>
              <input
                type="text"
                disabled={!canMutate}
                value={decDraft}
                onChange={(e) => handleDecChange(e.target.value)}
                onBlur={handleHexDecBlur}
                className="h-8 w-full rounded-[2px] border border-hairline bg-canvas px-3 font-mono text-xs tabular-nums text-ink focus:border-focus focus:outline-none disabled:opacity-60"
              />
            </div>

            {idCollisionWarning && (
              <div className="sm:col-span-2 rounded-[2px] border border-critical bg-canvas px-3 py-2 font-mono text-[11px] text-critical">
                {idCollisionWarning}
              </div>
            )}

            <div className="space-y-1.5">
              <label className="block text-xs font-medium text-muted">
                {t('msgDialog.fieldIdFormat')}
              </label>
              <select
                disabled={!canMutate}
                value={idFormat}
                onChange={(e) => {
                  const fmt = e.target.value as CandbMessageIdFormat;
                  const patch = buildMessageIdFormatPatch(message, fmt);
                  onUpdateMessage(message.messageKey, patch);
                }}
                className="h-8 w-full cursor-pointer rounded-[2px] border border-hairline bg-canvas px-2.5 text-xs text-ink focus:border-focus focus:outline-none disabled:opacity-60"
              >
                <option value="CAN_STD">{t('msgDialog.optCanStd')}</option>
                <option value="CAN_EXT">{t('msgDialog.optCanExt')}</option>
                <option value="CAN_FD_STD">{t('msgDialog.optCanFdStd')}</option>
                <option value="CAN_FD_EXT">{t('msgDialog.optCanFdExt')}</option>
                <option value="J1939_PG">{t('msgDialog.optJ1939Pg')}</option>
              </select>
            </div>

            <div className="space-y-1.5">
              <label className="block text-xs font-medium text-muted">
                {t('msgDialog.fieldDlc')}
              </label>
              <select
                disabled={!canMutate}
                value={message.dlc}
                onChange={(e) =>
                  onUpdateMessage(message.messageKey, {
                    dlc: Number.parseInt(e.target.value, 10) || 8,
                  })
                }
                className="h-8 w-full cursor-pointer rounded-[2px] border border-hairline bg-canvas px-2.5 font-mono text-xs tabular-nums text-ink focus:border-focus focus:outline-none disabled:opacity-60"
              >
                {validDlcs.map((dlc) => (
                  <option key={dlc} value={dlc}>
                    {t('msgDialog.optDlcBytesBits', { dlc, bits: dlc * 8 })}
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-1.5">
              <label className="block text-xs font-medium text-muted">
                {t('msgDialog.fieldCycleTime')}
              </label>
              <input
                type="number"
                min={0}
                max={65535}
                disabled={!canMutate}
                value={message.expectedCycleMs ?? ''}
                placeholder={t('msgDialog.placeholderCycleTime')}
                onChange={(e) => {
                  const raw = e.target.value.trim();
                  const parsed = raw === '' ? null : Number.parseInt(raw, 10);
                  onUpdateMessage(message.messageKey, {
                    expectedCycleMs:
                      parsed !== null && Number.isFinite(parsed) && parsed > 0
                        ? parsed
                        : null,
                  });
                }}
                className="h-8 w-full rounded-[2px] border border-hairline bg-canvas px-3 font-mono text-xs tabular-nums text-ink placeholder:text-subtle focus:border-focus focus:outline-none disabled:opacity-60"
              />
            </div>

            <div className="space-y-1.5">
              <label className="block text-xs font-medium text-muted">
                {t('msgDialog.fieldPrimaryTx')}
              </label>
              <select
                disabled={!canMutate}
                value={message.transmitters[0] ?? ''}
                onChange={(e) => handlePrimaryTxChange(e.target.value)}
                className="h-8 w-full cursor-pointer rounded-[2px] border border-hairline bg-canvas px-2.5 font-mono text-xs text-ink focus:border-focus focus:outline-none disabled:opacity-60"
              >
                <option value="">{t('msgDialog.unassignedTxOption')}</option>
                {schema.ecus.map((ecu) => (
                  <option key={ecu.name} value={ecu.name}>
                    {ecu.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>
      )}

      {/* TAB 2: MAPPED SIGNALS */}
      {activeTab === 'signals' && (
        <div className="flex flex-col">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-hairline bg-elevated/60 px-4 py-2.5">
            <span className="text-xs text-muted">
              {t('msgDialog.signalsHintPrefix')}
              <strong className="text-ink">{t('common.edit')}</strong>
              {t('msgDialog.signalsHintSuffix')}
            </span>

            <div className="flex flex-wrap items-center gap-1.5">
              {canMutate && (
                <button
                  type="button"
                  onClick={() => onAddSignal(message.messageKey, undefined, true)}
                  className="inline-flex h-7 cursor-pointer items-center gap-1 rounded-[2px] bg-focus px-2.5 text-xs font-semibold text-on-accent transition-opacity hover:opacity-90"
                >
                  <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>{t('msgDialog.addNewSignalBtn')}</span>
                </button>
              )}

              <button
                type="button"
                disabled={selectedSignalId === null}
                onClick={() => {
                  if (selectedSignalId !== null) {
                    onOpenSignalDialog(selectedSignalId, message.messageKey);
                  }
                }}
                className="inline-flex h-7 cursor-pointer items-center gap-1 rounded-[2px] border border-hairline bg-surface px-2.5 text-xs text-ink hover:border-strong disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Edit3 className="h-3 w-3 text-focus" aria-hidden="true" />
                <span>{t('common.edit')}</span>
              </button>

              {canMutate && (
                <>
                  <button
                    type="button"
                    disabled={selectedSignalId === null}
                    onClick={() => {
                      if (selectedSignalId !== null) {
                        onCloneSignal(selectedSignalId);
                      }
                    }}
                    className="inline-flex h-7 cursor-pointer items-center gap-1 rounded-[2px] border border-hairline bg-surface px-2.5 text-xs text-ink hover:border-strong disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <Copy className="h-3 w-3 text-muted" aria-hidden="true" />
                    <span>{t('common.duplicate')}</span>
                  </button>
                  <button
                    type="button"
                    disabled={selectedSignalId === null}
                    onClick={() => {
                      if (selectedSignalId !== null) {
                        onDeleteSignal(selectedSignalId);
                      }
                    }}
                    className="inline-flex h-7 cursor-pointer items-center gap-1 rounded-[2px] border border-hairline bg-surface px-2.5 text-xs text-critical hover:border-critical disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <Trash2 className="h-3 w-3" aria-hidden="true" />
                    <span>{t('common.delete')}</span>
                  </button>
                </>
              )}
            </div>
          </div>

          {messageSignals.length === 0 ? (
            <div className="p-10 text-center text-xs text-muted">
              {t('msgDialog.emptySignals')}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-left text-xs select-none">
                <thead className="border-b border-hairline bg-elevated text-[11px] font-semibold text-muted">
                  <tr>
                    <th className="py-2 px-4">{t('list.col.signalName')}</th>
                    <th className="py-2 px-3 text-right">
                      {t('list.col.startBit')}
                    </th>
                    <th className="py-2 px-3 text-right">
                      {t('list.col.lengthBits')}
                    </th>
                    <th className="py-2 px-3">{t('list.col.byteOrder')}</th>
                    <th className="py-2 px-3 text-right">
                      {t('list.col.factor')}
                    </th>
                    <th className="py-2 px-3 text-right">
                      {t('list.col.offset')}
                    </th>
                    <th className="py-2 px-3 text-right">
                      {t('list.col.minMax')}
                    </th>
                    <th className="py-2 px-3">{t('list.col.unit')}</th>
                    <th className="py-2 px-4">{t('list.col.muxShort')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-hairline bg-surface">
                  {messageSignals.map((sig) => {
                    const isSel = selectedSignalId === sig.signalId;
                    return (
                      <tr
                        key={sig.signalId}
                        onClick={() => setSelectedSignalId(sig.signalId)}
                        onDoubleClick={() =>
                          onOpenSignalDialog(sig.signalId, message.messageKey)
                        }
                        className={`cursor-pointer transition-colors ${
                          isSel ? 'bg-elevated' : 'hover:bg-elevated/50'
                        }`}
                      >
                        <td className="py-2 px-4 font-mono font-semibold text-ink">
                          <span className="inline-flex items-center gap-2">
                            <span
                              className="h-3 w-1 shrink-0 rounded-[1px]"
                              style={{
                                backgroundColor: getSignalColor(sig.signalId),
                              }}
                            />
                            <span>{sig.name}</span>
                          </span>
                        </td>
                        <td className="py-2 px-3 text-right font-mono tabular-nums text-ink">
                          {sig.startBit}
                        </td>
                        <td className="py-2 px-3 text-right font-mono tabular-nums text-ink">
                          {sig.bitLength}
                        </td>
                        <td className="py-2 px-3 font-mono text-[11px] tabular-nums text-muted">
                          {sig.byteOrder === 'bigEndian'
                            ? 'Motorola (@0)'
                            : 'Intel (@1)'}
                        </td>
                        <td className="py-2 px-3 text-right font-mono tabular-nums text-ink">
                          {sig.factor}
                        </td>
                        <td className="py-2 px-3 text-right font-mono tabular-nums text-ink">
                          {sig.offset}
                        </td>
                        <td className="py-2 px-3 text-right font-mono tabular-nums text-muted">
                          [{sig.min} | {sig.max}]
                        </td>
                        <td className="py-2 px-3 font-mono text-ink">
                          {sig.unit || '—'}
                        </td>
                        <td className="py-2 px-4 font-mono text-[11px] tabular-nums text-muted">
                          {sig.muxRole === 'masterSwitch'
                            ? t('common.switchMaster')
                            : sig.muxRole === 'multiplexed'
                              ? `m (${formatMuxRangesText(sig.muxRanges)})`
                              : t('common.static')}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* TAB 3: BIT LAYOUT MATRIX */}
      {activeTab === 'layout' && (
        <div className="h-full">
          <CandbInteractiveBitMatrixTab
            selectedMessage={message}
            messageSignals={messageSignals}
            selectedSignal={activeLayoutSignal}
            messageBitOverlaps={messageOverlaps}
            canMutate={canMutate}
            onSelectSignal={(sigId) => setSelectedSignalId(sigId)}
            onMoveSignalStartBit={(sigId, nextStartBit) =>
              onUpdateSignal(sigId, { startBit: nextStartBit })
            }
            onAddSignalAtBit={(msgKey, startBit) =>
              onAddSignal(msgKey, startBit, false)
            }
            onOpenSignalDialog={(sigId) =>
              onOpenSignalDialog(sigId, message.messageKey)
            }
          />
        </div>
      )}

      {/* TAB 4: TRANSMITTERS (BO_TX_BU_) */}
      {activeTab === 'transmitters' && (
        <div className="p-5 space-y-4 text-xs">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="font-semibold text-ink">
                {t('msgDialog.txTitle')}
              </h3>
              <p className="mt-0.5 text-muted">
                {t('msgDialog.txDescription')}
              </p>
            </div>
            {canMutate && (
              <button
                type="button"
                onClick={onAddEcu}
                className="inline-flex h-7 cursor-pointer items-center gap-1 rounded-[2px] border border-hairline bg-elevated px-2.5 text-xs text-ink hover:border-strong"
              >
                <Plus className="h-3.5 w-3.5 text-focus" aria-hidden="true" />
                <span>{t('msgDialog.addNewEcuBtn')}</span>
              </button>
            )}
          </div>

          {schema.ecus.length === 0 ? (
            <div className="rounded-[2px] border border-hairline bg-canvas p-6 text-center text-muted">
              {t('msgDialog.emptyEcus')}
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 md:grid-cols-3">
              {schema.ecus.map((ecu) => {
                const checked = message.transmitters.includes(ecu.name);
                const isPrimary = message.transmitters[0] === ecu.name;
                return (
                  <label
                    key={ecu.name}
                    className={`flex cursor-pointer items-center justify-between gap-2 rounded-[2px] border px-3 py-2 transition-colors ${
                      checked
                        ? 'border-strong bg-elevated text-ink'
                        : 'border-hairline bg-canvas text-muted hover:text-ink'
                    }`}
                  >
                    <span className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        disabled={!canMutate}
                        checked={checked}
                        onChange={() => toggleTransmitter(ecu.name)}
                        className="accent-focus"
                      />
                      <span className="font-mono font-semibold text-ink">
                        {ecu.name}
                      </span>
                    </span>
                    {isPrimary ? (
                      <span className="rounded-[2px] border border-hairline bg-surface px-1.5 py-0.5 font-mono text-[10px] font-semibold text-nominal">
                        {t('msgDialog.primaryTxBadge')}
                      </span>
                    ) : checked ? (
                      <span className="rounded-[2px] border border-hairline bg-surface px-1.5 py-0.5 font-mono text-[10px] text-focus">
                        BO_TX_BU_
                      </span>
                    ) : null}
                  </label>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* TAB 5: COMMENT (CM_ BO_) */}
      {activeTab === 'comment' && (
        <div className="p-5 space-y-2 text-xs">
          <label className="block font-medium text-muted">
            {t('msgDialog.commentLabel')}
          </label>
          <textarea
            rows={7}
            disabled={!canMutate}
            value={message.comment ?? ''}
            placeholder={t('msgDialog.commentPlaceholder')}
            onChange={(e) =>
              onUpdateMessage(message.messageKey, {
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
