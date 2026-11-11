import React, { useState } from 'react';
import { Database, FileSearch, Loader2, RefreshCw } from 'lucide-react';
import { useI18n } from '../../i18n';
import { diagnosticsStore, useDiagnosticsStore } from '../../store/diagnosticsStore';
import { DID_CATALOG } from '../../types/diagnostics';
import { formatDiagError } from '../../services/diagErrors';
import {
  DIAG_BTN,
  DIAG_BTN_SM,
  DIAG_GRID,
  DIAG_PANEL,
  DIAG_ROW_HOVER,
  DIAG_SECTION_TITLE,
  DIAG_TITLE,
  DIAG_TOOLBAR,
  DiagDemoBadge,
  DiagErrorNotice,
} from './diagUi';

function toHex(n: number, w = 4): string {
  return '0x' + n.toString(16).toUpperCase().padStart(w, '0');
}

function bytesToHex(bytes: number[]): string {
  return bytes.map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
}

export const DidInspector: React.FC = () => {
  const { t } = useI18n();
  const state = useDiagnosticsStore();
  const { session, didValues, didErrors, lastError, mockMode } = state;
  const connected = session.connected;

  const [loadingDids, setLoadingDids] = useState<Set<number>>(new Set());
  const [isReadingAll, setIsReadingAll] = useState(false);

  function timeAgo(ms: number): string {
    const diff = Date.now() - ms;
    if (diff < 1000) return t('diagHmi.time.ago', { value: `${diff}ms` });
    if (diff < 60000) return t('diagHmi.time.ago', { value: `${(diff / 1000).toFixed(1)}s` });
    return t('diagHmi.time.ago', { value: `${Math.floor(diff / 60000)}m` });
  }

  async function handleReadDid(did: number) {
    setLoadingDids((prev) => new Set([...prev, did]));
    await diagnosticsStore.readDid(did);
    setLoadingDids((prev) => {
      const next = new Set(prev);
      next.delete(did);
      return next;
    });
  }

  async function handleReadAll() {
    setIsReadingAll(true);
    await diagnosticsStore.readAllDids();
    setIsReadingAll(false);
  }

  const vinEntry = didValues.get(0xf190);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-canvas">
      {/* Toolbar */}
      <div className={DIAG_TOOLBAR}>
        <FileSearch className="h-3.5 w-3.5 text-focus" aria-hidden="true" />
        <h2 className={DIAG_TITLE}>{t('diag.did.title')}</h2>
        <div className="flex-1" />
        {mockMode && <DiagDemoBadge />}
        <button type="button" onClick={handleReadAll} disabled={!connected || isReadingAll} className={DIAG_BTN}>
          {isReadingAll ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          ) : (
            <Database className="h-3.5 w-3.5" aria-hidden="true" />
          )}
          {t('diag.did.readAll')}
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <div className="space-y-3">
          {lastError && lastError.code !== 'negative_response' && (
            <DiagErrorNotice error={lastError} onDismiss={() => diagnosticsStore.clearError()} />
          )}

          {/* VIN highlight */}
          {vinEntry && (
            <div className={`${DIAG_PANEL} flex items-center gap-4 p-3`}>
              <span className={`${DIAG_SECTION_TITLE} shrink-0 text-focus`}>VIN</span>
              <span className="font-mono text-[20px] font-bold tracking-widest tabular-nums text-ink">
                {vinEntry.decoded}
              </span>
              <span className="ml-auto font-mono text-[11px] tabular-nums text-subtle">
                {toHex(0xf190)} · {timeAgo(vinEntry.timestampMs)}
              </span>
            </div>
          )}

          {/* Table */}
          <div className="overflow-hidden rounded-[2px] border border-hairline bg-surface">
            <table className={DIAG_GRID}>
              <colgroup>
                <col style={{ width: 90 }} />
                <col style={{ width: 300 }} />
                <col />
                <col style={{ width: 190 }} />
                <col style={{ width: 120 }} />
                <col style={{ width: 90 }} />
              </colgroup>
              <thead>
                <tr>
                  <th>{t('diag.did.colDid')}</th>
                  <th className="font-sans">{t('diag.did.colName')}</th>
                  <th className="font-sans">{t('diag.did.colValue')}</th>
                  <th>{t('diag.did.colRaw')}</th>
                  <th>{t('diag.did.colAge')}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {DID_CATALOG.map((def) => {
                  const entry = didValues.get(def.did);
                  const didError = didErrors.get(def.did);
                  const isLoading = loadingDids.has(def.did);
                  const isVin = def.did === 0xf190;

                  return (
                    <tr
                      key={def.did}
                      className={DIAG_ROW_HOVER}
                      style={isVin ? { backgroundColor: 'var(--status-focus-bg)' } : undefined}
                    >
                      <td>
                        <div className="pcan-cell text-focus">{toHex(def.did)}</div>
                      </td>
                      <td>
                        <div className="pcan-cell gap-2 font-sans" title={def.description}>
                          <span className="shrink-0 font-semibold text-ink">{def.name}</span>
                          <span className="truncate text-[11.5px] text-subtle">{def.description}</span>
                        </div>
                      </td>
                      <td>
                        <div className="pcan-cell">
                          {isLoading ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin text-focus" aria-hidden="true" />
                          ) : didError ? (
                            <span className="truncate text-critical" title={formatDiagError(t, didError)}>
                              {formatDiagError(t, didError)}
                            </span>
                          ) : entry ? (
                            <span className={isVin ? 'font-bold tracking-wider text-ink' : 'text-ink'}>
                              {entry.decoded}
                            </span>
                          ) : (
                            <span className="text-subtle">—</span>
                          )}
                        </div>
                      </td>
                      <td>
                        <div className="pcan-cell text-[11.5px] text-muted">
                          {entry && !didError ? bytesToHex(entry.raw) : <span className="text-subtle">—</span>}
                        </div>
                      </td>
                      <td>
                        <div className="pcan-cell text-[11.5px] text-muted">
                          {entry && !didError ? timeAgo(entry.timestampMs) : <span className="text-subtle">—</span>}
                        </div>
                      </td>
                      <td>
                        <div className="pcan-cell pcan-cell-right">
                          <button
                            type="button"
                            onClick={() => void handleReadDid(def.did)}
                            disabled={!connected || isLoading}
                            className={DIAG_BTN_SM}
                          >
                            {isLoading ? (
                              <Loader2 className="h-2.5 w-2.5 animate-spin" aria-hidden="true" />
                            ) : (
                              <RefreshCw className="h-2.5 w-2.5" aria-hidden="true" />
                            )}
                            {t('diag.did.read')}
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
};
