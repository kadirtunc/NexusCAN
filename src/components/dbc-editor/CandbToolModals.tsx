'use client';

import React, { useMemo, useState } from 'react';
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Copy,
  Download,
  Grid,
  Save,
} from 'lucide-react';
import type {
  BitOverlapDiagnosticDto,
  DatabaseSchemaDto,
  DatabaseVersionDto,
  ParseDiagnosticDto,
} from './contracts';
import { useDbcStudioI18n } from './i18n/dbcStudio';
import { CandbCommMatrixTab } from './CandbCommMatrixTab';
import { CandbModalShell } from './CandbModalShell';
import { buildVersioningPresets } from './dbcEditorUtils';

// ============================================================================
// 1. COMMUNICATION MATRIX MODAL
// ============================================================================

interface CandbCommMatrixModalProps {
  schema: DatabaseSchemaDto;
  canMutate: boolean;
  onAddEcu: () => void;
  onOpenMessageDialog: (messageKey: string) => void;
  onOpenSignalDialog: (signalId: number) => void;
  onToggleMessageTx: (messageKey: string, ecuName: string) => void;
  onToggleSignalRx: (signalId: number, ecuName: string) => void;
  onClose: () => void;
}

export function CandbCommMatrixModal({
  schema,
  canMutate,
  onAddEcu,
  onOpenMessageDialog,
  onOpenSignalDialog,
  onToggleMessageTx,
  onToggleSignalRx,
  onClose,
}: CandbCommMatrixModalProps): React.JSX.Element {
  const { t } = useDbcStudioI18n();

  return (
    <CandbModalShell
      badge={t('toolModal.commMatrix.badge')}
      title={t('toolModal.commMatrix.title')}
      subtitle={t('toolModal.commMatrix.subtitle', {
        messages: schema.messages.length,
        ecus: schema.ecus.length,
      })}
      maxWidthClass="max-w-5xl"
      heightClass="h-[78vh] max-h-[760px]"
      onClose={onClose}
      footer={
        <>
          <span className="text-[11px] text-muted">
            {t('toolModal.commMatrix.footerHint')}
          </span>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-7 cursor-pointer items-center rounded-[2px] bg-focus px-4 text-xs font-semibold text-on-accent transition-opacity hover:opacity-90"
          >
            {t('common.close')}
          </button>
        </>
      }
    >
      <CandbCommMatrixTab
        schema={schema}
        canMutate={canMutate}
        onAddEcu={onAddEcu}
        onSelectMessage={(msgKey) => onOpenMessageDialog(msgKey)}
        onSelectSignal={(_msgKey, sigId) => onOpenSignalDialog(sigId)}
        onToggleMessageTx={onToggleMessageTx}
        onToggleSignalRx={onToggleSignalRx}
      />
    </CandbModalShell>
  );
}

// ============================================================================
// 2. CONSISTENCY CHECK MODAL (WASM DIAGNOSTICS & BIT OVERLAPS)
// ============================================================================

interface CandbConsistencyModalProps {
  schema: DatabaseSchemaDto;
  isValidatingWasm: boolean;
  wasmValid: boolean;
  compileError: string | null;
  diagnostics: readonly ParseDiagnosticDto[];
  bitOverlaps: readonly BitOverlapDiagnosticDto[];
  onOpenMessageLayout: (messageKey: string) => void;
  onClose: () => void;
}

export function CandbConsistencyModal({
  schema,
  isValidatingWasm,
  wasmValid,
  compileError,
  diagnostics,
  bitOverlaps,
  onOpenMessageLayout,
  onClose,
}: CandbConsistencyModalProps): React.JSX.Element {
  const { t } = useDbcStudioI18n();
  const issueCount =
    (compileError ? 1 : 0) + bitOverlaps.length + diagnostics.length;

  return (
    <CandbModalShell
      badge={t('toolModal.consistency.badge')}
      title={t('toolModal.consistency.title')}
      subtitle={
        isValidatingWasm
          ? t('toolModal.consistency.validating')
          : issueCount === 0 && wasmValid
            ? t('toolModal.consistency.zeroIssues')
            : t('toolModal.consistency.issuesFound', { count: issueCount })
      }
      maxWidthClass="max-w-5xl"
      heightClass="h-[78vh] max-h-[760px]"
      onClose={onClose}
      footer={
        <>
          <span className="font-mono text-[11px] tabular-nums text-muted">
            {schema.messages.length} BO_ · {schema.signals.length} SG_ ·{' '}
            {schema.ecus.length} BU_
          </span>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-7 cursor-pointer items-center rounded-[2px] bg-focus px-4 text-xs font-semibold text-on-accent transition-opacity hover:opacity-90"
          >
            {t('common.close')}
          </button>
        </>
      }
    >
      <div className="p-5 space-y-4 text-xs">
        {/* Overall Banner */}
        {issueCount === 0 && wasmValid ? (
          <div
            className="flex items-center gap-3 rounded-[2px] border p-4"
            style={{
              backgroundColor: 'var(--status-nominal-bg)',
              borderColor: 'var(--status-nominal-border)',
              color: 'var(--status-nominal)',
            }}
          >
            <CheckCircle2 className="h-5 w-5 shrink-0" aria-hidden="true" />
            <div>
              <div className="font-semibold">
                {t('toolModal.consistency.passedTitle')}
              </div>
              <p className="mt-0.5 text-[11px] text-ink">
                {t('toolModal.consistency.passedBody')}
              </p>
            </div>
          </div>
        ) : (
          <div
            className="flex items-center gap-3 rounded-[2px] border p-4"
            style={{
              backgroundColor: 'var(--status-critical-bg)',
              borderColor: 'var(--status-critical)',
              color: 'var(--status-critical)',
            }}
          >
            <AlertTriangle className="h-5 w-5 shrink-0" aria-hidden="true" />
            <div>
              <div className="font-semibold">
                {t('toolModal.consistency.failedTitle', { count: issueCount })}
              </div>
              <p className="mt-0.5 text-[11px] text-ink">
                {t('toolModal.consistency.failedBody')}
              </p>
            </div>
          </div>
        )}

        {/* Compile Error */}
        {compileError && (
          <div className="space-y-1.5">
            <h3 className="font-semibold text-critical">
              {t('toolModal.consistency.compileErrorHeading')}
            </h3>
            <div className="rounded-[2px] border border-critical bg-canvas p-3 font-mono text-xs text-critical">
              {compileError}
            </div>
          </div>
        )}

        {/* Bit Overlaps */}
        {bitOverlaps.length > 0 && (
          <div className="space-y-2">
            <h3 className="font-semibold text-ink">
              {t('toolModal.consistency.bitOverlapsHeading', {
                count: bitOverlaps.length,
              })}
            </h3>
            <div className="divide-y divide-hairline overflow-hidden rounded-[2px] border border-hairline bg-canvas">
              {bitOverlaps.map((ov, idx) => (
                <div
                  key={`${ov.messageKey}-${ov.byteIndex}-${ov.bitInByte}-${idx}`}
                  className="flex flex-wrap items-center justify-between gap-3 bg-surface px-3.5 py-2.5"
                >
                  <div className="space-y-0.5">
                    <div className="font-mono text-xs">
                      <strong className="text-critical">{ov.messageName}</strong>{' '}
                      <span className="tabular-nums text-muted">
                        {t('toolModal.consistency.overlapCoord', {
                          byte: ov.byteIndex,
                          bit: ov.bitInByte,
                          linear: ov.byteIndex * 8 + ov.bitInByte,
                        })}
                      </span>
                    </div>
                    <div className="font-mono text-[11px] text-ink">
                      {ov.signalNames.join(' ↔ ')} —{' '}
                      <span className="text-muted">{ov.description}</span>
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={() => onOpenMessageLayout(ov.messageKey)}
                    className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-[2px] border border-hairline bg-elevated px-2.5 text-xs font-medium text-focus transition-colors hover:border-strong hover:text-ink"
                  >
                    <Grid className="h-3.5 w-3.5" aria-hidden="true" />
                    <span>{t('toolModal.consistency.openMsgLayoutBtn')}</span>
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Compiler Diagnostics */}
        {diagnostics.length > 0 && (
          <div className="space-y-2">
            <h3 className="font-semibold text-ink">
              {t('toolModal.consistency.diagnosticsHeading', {
                count: diagnostics.length,
              })}
            </h3>
            <div className="divide-y divide-hairline overflow-hidden rounded-[2px] border border-hairline bg-canvas">
              {diagnostics.map((d, idx) => (
                <div
                  key={`${d.code}-${idx}`}
                  className="bg-surface px-3.5 py-2 font-mono text-[11px] tabular-nums text-ink"
                >
                  <span
                    className={
                      d.severity === 'error'
                        ? 'font-semibold text-critical'
                        : 'font-semibold text-warn'
                    }
                  >
                    [{d.severity.toUpperCase()} {d.code}]
                  </span>{' '}
                  {d.line !== null
                    ? t('toolModal.consistency.linePrefix', { line: d.line })
                    : ''}
                  {d.message}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </CandbModalShell>
  );
}

// ============================================================================
// 3. .DBC SOURCE & DOWNLOAD MODAL
// ============================================================================

interface CandbDbcSourceModalProps {
  databaseName: string;
  dbcText: string;
  onDownloadDbc: () => void;
  onClose: () => void;
}

export function CandbDbcSourceModal({
  databaseName,
  dbcText,
  onDownloadDbc,
  onClose,
}: CandbDbcSourceModalProps): React.JSX.Element {
  const { t } = useDbcStudioI18n();
  const [copied, setCopied] = useState<boolean>(false);

  const lines = useMemo(() => dbcText.split('\n'), [dbcText]);
  const byteSize = useMemo(
    () => new TextEncoder().encode(dbcText).byteLength,
    [dbcText]
  );

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(dbcText);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      // Clipboard unavailable
    }
  };

  return (
    <CandbModalShell
      badge={t('toolModal.dbcSource.badge')}
      title={t('toolModal.dbcSource.title', { name: databaseName })}
      subtitle={t('toolModal.dbcSource.subtitle', {
        lines: lines.length,
        kb: (byteSize / 1024).toFixed(2),
      })}
      maxWidthClass="max-w-5xl"
      heightClass="h-[78vh] max-h-[760px]"
      headerRight={
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => void handleCopy()}
            className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-[2px] border border-hairline bg-surface px-2.5 text-xs text-ink transition-colors hover:border-strong"
          >
            {copied ? (
              <>
                <Check
                  className="h-3.5 w-3.5 text-nominal"
                  aria-hidden="true"
                />
                <span className="text-nominal">{t('common.copied')}</span>
              </>
            ) : (
              <>
                <Copy className="h-3.5 w-3.5 text-muted" aria-hidden="true" />
                <span>{t('common.copy')}</span>
              </>
            )}
          </button>

          <button
            type="button"
            onClick={onDownloadDbc}
            className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-[2px] bg-focus px-2.5 text-xs font-semibold text-on-accent transition-opacity hover:opacity-90"
          >
            <Download className="h-3.5 w-3.5" aria-hidden="true" />
            <span>{t('toolModal.dbcSource.downloadBtn')}</span>
          </button>
        </div>
      }
      onClose={onClose}
    >
      <div className="h-full overflow-auto bg-canvas p-2 font-mono text-[11px] leading-5">
        <table className="w-full border-collapse">
          <tbody>
            {lines.map((line, idx) => (
              <tr key={idx} className="hover:bg-elevated/40">
                <td className="w-12 select-none border-r border-hairline pr-2.5 text-right tabular-nums text-subtle">
                  {idx + 1}
                </td>
                <td className="whitespace-pre pl-3 text-ink">{line || ' '}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </CandbModalShell>
  );
}

// ============================================================================
// 4. SAVE VERSION MODAL
// ============================================================================

interface SaveProjectItem {
  id: string;
  code: string;
  name: string;
}

interface CandbSaveVersionModalProps {
  isExistingDatabase: boolean;
  projects: readonly SaveProjectItem[];
  activeProjectId: string;
  onChangeProjectId: (projectId: string) => void;
  databaseName: string;
  onChangeDatabaseName: (name: string) => void;
  busAssignment: string;
  onChangeBusAssignment: (bus: string) => void;
  baseVersionLabel: string | null;
  existingVersions: readonly DatabaseVersionDto[];
  versionLabel: string;
  onChangeVersionLabel: (label: string) => void;
  syncDbcVersionField: boolean;
  onChangeSyncDbcVersionField: (sync: boolean) => void;
  releaseNotes: string;
  onChangeReleaseNotes: (notes: string) => void;
  schema: DatabaseSchemaDto;
  saveBlockReason: string | null;
  savingVersion: boolean;
  onOpenConsistency: () => void;
  onExecuteSave: () => void;
  onClose: () => void;
}

export function CandbSaveVersionModal({
  isExistingDatabase,
  projects,
  activeProjectId,
  onChangeProjectId,
  databaseName,
  onChangeDatabaseName,
  busAssignment,
  onChangeBusAssignment,
  baseVersionLabel,
  existingVersions,
  versionLabel,
  onChangeVersionLabel,
  syncDbcVersionField,
  onChangeSyncDbcVersionField,
  releaseNotes,
  onChangeReleaseNotes,
  schema,
  saveBlockReason,
  savingVersion,
  onOpenConsistency,
  onExecuteSave,
  onClose,
}: CandbSaveVersionModalProps): React.JSX.Element {
  const { locale, t } = useDbcStudioI18n();
  const referenceVersion =
    existingVersions[0]?.versionLabel ?? baseVersionLabel ?? undefined;
  const presets = useMemo(
    () => buildVersioningPresets(referenceVersion, undefined, locale),
    [locale, referenceVersion]
  );

  const trimmedLabel = versionLabel.trim();
  const isLabelEmpty = trimmedLabel.length === 0;
  const isDuplicateVersionLabel = useMemo(
    () =>
      trimmedLabel.length > 0 &&
      existingVersions.some(
        (v) => v.versionLabel.trim().toLowerCase() === trimmedLabel.toLowerCase()
      ),
    [existingVersions, trimmedLabel]
  );

  return (
    <CandbModalShell
      badge={t('toolModal.saveVersion.badge')}
      title={t('toolModal.saveVersion.title', {
        label:
          trimmedLabel || t('toolModal.saveVersion.selectVersionFallback'),
      })}
      subtitle={`${schema.messages.length} BO_ · ${schema.signals.length} SG_ · ${schema.ecus.length} BU_`}
      maxWidthClass="max-w-2xl"
      heightClass="h-[620px] max-h-[84vh]"
      onClose={onClose}
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-7 cursor-pointer items-center rounded-[2px] border border-hairline bg-surface px-3 text-xs text-ink hover:border-strong"
          >
            {t('common.cancel')}
          </button>
          <button
            type="button"
            disabled={savingVersion || Boolean(saveBlockReason) || isLabelEmpty}
            onClick={onExecuteSave}
            className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-[2px] px-4 text-xs font-semibold text-on-accent transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-45"
            style={{ backgroundColor: 'var(--status-nominal)' }}
          >
            <Save className="h-3.5 w-3.5" aria-hidden="true" />
            <span>
              {savingVersion
                ? t('toolModal.saveVersion.savingBtn')
                : t('toolModal.saveVersion.commitBtn')}
            </span>
          </button>
        </>
      }
    >
      <div className="p-5 space-y-4 text-xs">
        {saveBlockReason && (
          <div
            className="flex flex-wrap items-center justify-between gap-2 rounded-[2px] border p-3"
            style={{
              backgroundColor: 'var(--status-critical-bg)',
              borderColor: 'var(--status-critical)',
              color: 'var(--status-critical)',
            }}
          >
            <span className="flex items-center gap-2 font-medium">
              <AlertTriangle
                className="h-4 w-4 shrink-0"
                aria-hidden="true"
              />
              <span>{saveBlockReason}</span>
            </span>
            <button
              type="button"
              onClick={onOpenConsistency}
              className="h-6 cursor-pointer rounded-[2px] border border-hairline bg-surface px-2 text-[11px] text-ink hover:border-strong"
            >
              {t('toolModal.saveVersion.inspectIssuesBtn')}
            </button>
          </div>
        )}

        {/* Base & Recent Version History Context Box */}
        <div className="rounded-[2px] border border-hairline bg-canvas p-3.5 space-y-2.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-[11px] font-medium text-muted">
              {t('toolModal.saveVersion.currentBaseLabel')}
            </span>
            <span className="rounded-[2px] border border-hairline bg-surface px-2 py-0.5 font-mono text-[11px] font-semibold tabular-nums text-focus">
              {isExistingDatabase && baseVersionLabel
                ? t('workbench.badge.baseWithLabel', {
                    label: baseVersionLabel,
                  })
                : t('toolModal.saveVersion.draftFirstCommit')}
            </span>
          </div>

          {existingVersions.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5 border-t border-hairline pt-2">
              <span className="mr-1 text-[11px] text-muted">
                {t('toolModal.saveVersion.recentVersionsLabel')}
              </span>
              {existingVersions.slice(0, 5).map((ver, idx) => (
                <span
                  key={ver.id}
                  className="inline-flex items-center gap-1 rounded-[2px] border border-hairline bg-surface px-2 py-0.5 font-mono text-[11px] tabular-nums text-ink"
                >
                  <span>{ver.versionLabel}</span>
                  {idx === 0 && (
                    <span className="text-[9px] font-semibold text-nominal">
                      {t('toolModal.saveVersion.latestBadge')}
                    </span>
                  )}
                </span>
              ))}
            </div>
          )}
        </div>

        {/* Flexible Versioning Strategy Presets + Free-Form Input */}
        <div className="rounded-[2px] border border-hairline bg-canvas p-3.5 space-y-3">
          <div className="space-y-1.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <label
                htmlFor="candb-save-version-label"
                className="font-semibold text-ink"
              >
                {t('toolModal.saveVersion.newLabelHeading')}
              </label>
              <span className="text-[11px] text-muted">
                {t('toolModal.saveVersion.newLabelHint')}
              </span>
            </div>

            {/* 1-Click Versioning Strategy Presets */}
            <div className="flex flex-wrap items-center gap-1.5">
              {presets.map((preset) => {
                const isActive = trimmedLabel === preset.suggestedVersion;
                return (
                  <button
                    key={preset.id}
                    type="button"
                    onClick={() => onChangeVersionLabel(preset.suggestedVersion)}
                    className={`inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-[2px] border px-2.5 text-[11px] transition-colors ${
                      isActive
                        ? 'border-strong bg-elevated font-semibold text-nominal'
                        : 'border-hairline bg-surface text-muted hover:border-strong hover:text-ink'
                    }`}
                  >
                    <span>{preset.strategyLabel}</span>
                    <span className="font-mono text-[10px] tabular-nums text-focus">
                      ({preset.suggestedVersion})
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="space-y-1.5">
            <input
              id="candb-save-version-label"
              type="text"
              maxLength={40}
              autoFocus
              value={versionLabel}
              onChange={(e) => onChangeVersionLabel(e.target.value)}
              placeholder={t('toolModal.saveVersion.labelPlaceholder')}
              className="h-9 w-full rounded-[2px] border border-hairline bg-surface px-3 font-mono text-sm font-semibold tabular-nums text-nominal placeholder:font-normal placeholder:text-subtle focus:border-focus focus:outline-none"
            />
            {isLabelEmpty && (
              <p className="font-mono text-[11px] text-critical">
                {t('toolModal.saveVersion.emptyLabelError')}
              </p>
            )}
            {isDuplicateVersionLabel && (
              <p className="flex items-center gap-1.5 rounded-[2px] border border-hairline bg-elevated px-2.5 py-1.5 text-[11px] text-warn">
                <AlertTriangle
                  className="h-3.5 w-3.5 shrink-0"
                  aria-hidden="true"
                />
                <span>{t('toolModal.saveVersion.duplicateLabelWarn')}</span>
              </p>
            )}
          </div>

          <label className="inline-flex cursor-pointer items-center gap-2 text-xs text-ink select-none">
            <input
              type="checkbox"
              checked={syncDbcVersionField}
              onChange={(e) => onChangeSyncDbcVersionField(e.target.checked)}
              className="accent-focus"
            />
            <span>
              {t('toolModal.saveVersion.syncDbcVersionPrefix')}
              <span className="font-mono">VERSION</span>
              {t('toolModal.saveVersion.syncDbcVersionSuffix')}
            </span>
          </label>
        </div>

        {/* Metadata & Release Notes */}
        <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
          {!isExistingDatabase && (
            <div className="sm:col-span-2 space-y-1">
              <label className="block font-medium text-muted">
                {t('toolModal.saveVersion.fieldProject')}
              </label>
              <select
                value={activeProjectId}
                onChange={(e) => onChangeProjectId(e.target.value)}
                className="h-8 w-full cursor-pointer rounded-[2px] border border-hairline bg-canvas px-2.5 text-xs text-ink focus:border-focus focus:outline-none"
              >
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.code} — {p.name}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div className="space-y-1">
            <label className="block font-medium text-muted">
              {t('toolModal.saveVersion.fieldDbName')}
            </label>
            <input
              type="text"
              value={databaseName}
              onChange={(e) => onChangeDatabaseName(e.target.value)}
              className="h-8 w-full rounded-[2px] border border-hairline bg-canvas px-3 font-mono text-xs font-semibold text-ink focus:border-focus focus:outline-none"
            />
          </div>

          <div className="space-y-1">
            <label className="block font-medium text-muted">
              {t('toolModal.saveVersion.fieldBus')}
            </label>
            <input
              type="text"
              value={busAssignment}
              onChange={(e) => onChangeBusAssignment(e.target.value)}
              placeholder="CAN0 - Powertrain FD"
              className="h-8 w-full rounded-[2px] border border-hairline bg-canvas px-3 font-mono text-xs text-ink focus:border-focus focus:outline-none"
            />
          </div>

          <div className="sm:col-span-2 space-y-1">
            <label
              htmlFor="candb-save-release-notes"
              className="block font-medium text-muted"
            >
              {t('toolModal.saveVersion.fieldReleaseNotes')}
            </label>
            <textarea
              id="candb-save-release-notes"
              rows={2}
              value={releaseNotes}
              onChange={(e) => onChangeReleaseNotes(e.target.value)}
              placeholder={t('toolModal.saveVersion.placeholderReleaseNotes')}
              className="w-full rounded-[2px] border border-hairline bg-canvas p-2.5 text-xs text-ink placeholder:text-subtle focus:border-focus focus:outline-none"
            />
          </div>
        </div>
      </div>
    </CandbModalShell>
  );
}
