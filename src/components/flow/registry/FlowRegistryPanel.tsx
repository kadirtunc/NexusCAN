/**
 * Left panel of the Flow Editor: the library of the user's flows and custom blocks (search, tag filter,
 * open / duplicate / rename / delete / restore / export / import, revision history).
 */
import React, { useMemo, useState } from 'react';
import { Copy, Download, FilePlus2, History, Library, Link2, Pencil, Plus, RotateCcw, Trash2, Upload, X } from 'lucide-react';
import { useI18n } from '../../../i18n';
import type { FlowLibEntryDto, FlowLibKind } from '../../../types/flowLibrary';
import { DIAG_BTN_SM, DIAG_CHECKBOX, DiagDot } from '../../diagnostics/diagUi';
import { ResizablePanel } from '../ResizablePanel';
import { flowRegistry, useFlowRegistry } from './flowRegistryStore';

const FIELD =
  'h-[26px] w-full rounded-[2px] border border-hairline bg-canvas px-2 text-[12px] text-ink outline-none placeholder:text-subtle focus:border-focus';

/** Local `YYYY-MM-DD HH:mm` of an ISO timestamp. */
export function formatStamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const UsageList: React.FC<{ id: string }> = ({ id }) => {
  const { t } = useI18n();
  const { usages } = useFlowRegistry();
  if (!usages || usages.id !== id) return null;
  return (
    <div className="border-t border-hairline bg-canvas px-2 py-1.5">
      <div className="mb-1 flex items-center">
        <span className="font-mono text-[10.5px] font-semibold uppercase tracking-wider text-subtle">{t('flowNest.usedIn')}</span>
        <button type="button" onClick={() => flowRegistry.closeUsages()} className="ml-auto cursor-pointer text-muted hover:text-ink" aria-label={t('flowReg.close')}>
          <X className="h-3 w-3" aria-hidden="true" />
        </button>
      </div>
      {usages.list.length === 0 ? (
        <div className="text-[11.5px] text-subtle">{t('flowNest.notUsed')}</div>
      ) : (
        usages.list.map((u) => (
          <button
            key={u.id}
            type="button"
            onClick={() => void flowRegistry.open(u.id)}
            className="flex w-full cursor-pointer items-center gap-1.5 py-0.5 text-left hover:text-focus"
          >
            <span className="min-w-0 flex-1 truncate text-[12px] text-ink">{u.name}</span>
            <span className="shrink-0 font-mono text-[10.5px] tabular-nums text-muted">{u.revisions.map((r) => `r${r}`).join(' ')}</span>
          </button>
        ))
      )}
    </div>
  );
};

const RevisionList: React.FC<{ id: string }> = ({ id }) => {
  const { t } = useI18n();
  const { revisions } = useFlowRegistry();
  if (!revisions || revisions.id !== id) return null;
  const list = [...revisions.list].sort((a, b) => b.revision - a.revision);
  return (
    <div className="border-t border-hairline bg-canvas px-2 py-1.5">
      <div className="mb-1 flex items-center">
        <span className="font-mono text-[10.5px] font-semibold uppercase tracking-wider text-subtle">{t('flowReg.history')}</span>
        <button type="button" onClick={() => flowRegistry.closeRevisions()} className="ml-auto cursor-pointer text-muted hover:text-ink" aria-label={t('flowReg.close')}>
          <X className="h-3 w-3" aria-hidden="true" />
        </button>
      </div>
      <div className="flex flex-col gap-1">
        {list.map((r) => (
          <div key={r.revision} className="flex items-center gap-1.5 font-mono text-[11px] tabular-nums">
            <span className="w-9 shrink-0 text-ink">r{r.revision}</span>
            <span className="min-w-0 flex-1 truncate text-subtle" title={`${formatStamp(r.updatedAt)}  ${r.contentHash}`}>
              {formatStamp(r.updatedAt)} {r.contentHash.slice(0, 8)}
            </span>
            <button type="button" className={DIAG_BTN_SM} onClick={() => void flowRegistry.openRevision(id, r.revision)} title={t('flowReg.openRevision')}>
              {t('flowReg.view')}
            </button>
            <button
              type="button"
              className={DIAG_BTN_SM}
              onClick={() => {
                if (window.confirm(t('flowReg.restoreRevisionConfirm', { rev: r.revision }))) void flowRegistry.restoreRevision(id, r.revision);
              }}
              title={t('flowReg.restoreRevision')}
            >
              <RotateCcw className="h-3 w-3" aria-hidden="true" />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
};

const LibRow: React.FC<{ entry: FlowLibEntryDto; selected: boolean; dirty: boolean; onSelect: () => void }> = ({ entry, selected, dirty, onSelect }) => {
  const { t } = useI18n();
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(entry.name);
  const commitRename = (): void => {
    setRenaming(false);
    if (name.trim() !== '' && name !== entry.name) void flowRegistry.rename(entry.id, name);
  };
  const act = 'h-[22px] px-1.5';
  return (
    <div className={`border-b border-hairline ${selected ? 'bg-hover' : ''}`}>
      <div
        role="button"
        tabIndex={0}
        onClick={onSelect}
        onDoubleClick={() => !entry.deleted && void flowRegistry.open(entry.id)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void flowRegistry.open(entry.id);
          if (e.key === ' ') {
            e.preventDefault();
            onSelect();
          }
        }}
        className="flex cursor-pointer items-center gap-1.5 px-2.5 py-1.5 hover:bg-hover focus:outline-none focus-visible:bg-hover"
      >
        <span className="flex w-2 shrink-0 justify-center">{dirty && <DiagDot tone="warn" title={t('flowReg.unsaved')} />}</span>
        {renaming ? (
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            onBlur={commitRename}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter') commitRename();
              if (e.key === 'Escape') setRenaming(false);
            }}
            className={`${FIELD} h-[22px]`}
          />
        ) : (
          <span className={`min-w-0 flex-1 truncate text-[12px] ${entry.deleted ? 'text-subtle line-through' : 'text-ink'}`} title={entry.name}>
            {entry.name}
          </span>
        )}
        <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted">r{entry.latestRevision}</span>
      </div>
      <div className="px-2.5 pb-1 pl-[26px] font-mono text-[10.5px] tabular-nums text-subtle">{formatStamp(entry.updatedAt)}</div>
      {selected && (
        <div className="flex flex-wrap gap-1 px-2.5 pb-1.5">
          {entry.deleted ? (
            <button type="button" className={`${DIAG_BTN_SM} ${act}`} onClick={() => void flowRegistry.restoreDeleted(entry.id)}>
              <RotateCcw className="h-3 w-3" aria-hidden="true" />
              {t('flowReg.restore')}
            </button>
          ) : (
            <>
              <button type="button" className={`${DIAG_BTN_SM} ${act}`} onClick={() => void flowRegistry.open(entry.id)}>
                {t('flowReg.open')}
              </button>
              <button type="button" className={`${DIAG_BTN_SM} ${act}`} onClick={() => void flowRegistry.insertCall(entry.id)} title={t('flowNest.insert')}>
                <Plus className="h-3 w-3" aria-hidden="true" />
                {t('flowNest.insertShort')}
              </button>
              <button type="button" className={`${DIAG_BTN_SM} ${act}`} onClick={() => void flowRegistry.whereUsed(entry.id)} title={t('flowNest.usedIn')} aria-label={t('flowNest.usedIn')}>
                <Link2 className="h-3 w-3" aria-hidden="true" />
              </button>
              <button type="button" className={`${DIAG_BTN_SM} ${act}`} onClick={() => void flowRegistry.duplicate(entry.id)} title={t('flowReg.duplicate')} aria-label={t('flowReg.duplicate')}>
                <Copy className="h-3 w-3" aria-hidden="true" />
              </button>
              <button
                type="button"
                className={`${DIAG_BTN_SM} ${act}`}
                onClick={() => {
                  setName(entry.name);
                  setRenaming(true);
                }}
                title={t('flowReg.rename')}
                aria-label={t('flowReg.rename')}
              >
                <Pencil className="h-3 w-3" aria-hidden="true" />
              </button>
              <button type="button" className={`${DIAG_BTN_SM} ${act}`} onClick={() => void flowRegistry.loadRevisions(entry.id)} title={t('flowReg.history')} aria-label={t('flowReg.history')}>
                <History className="h-3 w-3" aria-hidden="true" />
              </button>
              <button type="button" className={`${DIAG_BTN_SM} ${act}`} onClick={() => void flowRegistry.exportItem(entry.id)} title={t('flowReg.export')} aria-label={t('flowReg.export')}>
                <Download className="h-3 w-3" aria-hidden="true" />
              </button>
              <button
                type="button"
                className={`${DIAG_BTN_SM} ${act} hover:!border-critical hover:!text-critical`}
                onClick={() => {
                  if (window.confirm(t('flowReg.deleteConfirm', { name: entry.name }))) void flowRegistry.remove(entry.id);
                }}
                title={t('flowReg.delete')}
                aria-label={t('flowReg.delete')}
              >
                <Trash2 className="h-3 w-3" aria-hidden="true" />
              </button>
            </>
          )}
        </div>
      )}
      {selected && !entry.deleted && <RevisionList id={entry.id} />}
      {selected && !entry.deleted && <UsageList id={entry.id} />}
    </div>
  );
};

const Section: React.FC<{ kind: FlowLibKind; entries: FlowLibEntryDto[]; sel: string | null; setSel: (id: string) => void }> = ({ kind, entries, sel, setSel }) => {
  const { t } = useI18n();
  const { docs } = useFlowRegistry();
  return (
    <div>
      <div className="flex h-7 items-center border-b border-hairline bg-elevated px-2.5 font-mono text-[11px] font-semibold uppercase tracking-wider text-muted">
        {t(kind === 'nexuscan.flow' ? 'flowReg.sec.flows' : 'flowReg.sec.blocks')}
        <span className="ml-auto font-normal tabular-nums text-subtle">{entries.length}</span>
      </div>
      {entries.length === 0 ? (
        <div className="border-b border-hairline px-2.5 py-2 text-[11.5px] leading-snug text-subtle">
          {t(kind === 'nexuscan.flow' ? 'flowReg.sec.noFlows' : 'flowReg.sec.noBlocks')}
        </div>
      ) : (
        entries.map((e) => (
          <LibRow
            key={e.id}
            entry={e}
            selected={sel === e.id}
            dirty={docs.some((d) => d.id === e.id && !d.readOnly && d.dirty)}
            onSelect={() => setSel(e.id)}
          />
        ))
      )}
    </div>
  );
};

export const FlowRegistryPanel: React.FC<{ onNewFromTemplate: () => void }> = ({ onNewFromTemplate }) => {
  const { t } = useI18n();
  const { entries, showDeleted, error, migration, loading } = useFlowRegistry();
  const [query, setQuery] = useState('');
  const [tag, setTag] = useState('');
  const [sel, setSel] = useState<string | null>(null);

  const tags = useMemo(() => [...new Set(entries.flatMap((e) => e.tags))].sort(), [entries]);
  const q = query.trim().toLowerCase();
  const visible = entries.filter((e) => (q === '' || e.name.toLowerCase().includes(q)) && (tag === '' || e.tags.includes(tag)));
  const sorted = [...visible].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  return (
    <ResizablePanel
      id="registry"
      side="left"
      defaultWidth={240}
      minWidth={160}
      maxWidth={480}
      title={t('flowReg.title')}
      icon={<Library className="h-3.5 w-3.5" aria-hidden="true" />}
    >
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {error && (
          <div className="flex items-start gap-1.5 border-b border-critical bg-canvas px-2.5 py-1.5 text-[11.5px] leading-snug text-critical" role="alert">
            <span className="min-w-0 flex-1 break-words">{error}</span>
            <button type="button" onClick={() => flowRegistry.clearError()} aria-label={t('flowReg.close')} className="shrink-0 cursor-pointer">
              <X className="h-3 w-3" aria-hidden="true" />
            </button>
          </div>
        )}
        {migration && (migration.migrated > 0 || migration.failed.length > 0 || migration.notes.length > 0) && (
          <div className={`border-b bg-canvas px-2.5 py-1.5 text-[11.5px] leading-snug ${migration.failed.length > 0 ? 'border-warn text-warn' : 'border-hairline text-muted'}`}>
            <div className="flex items-start gap-1.5">
              <span className="min-w-0 flex-1 font-mono tabular-nums">
                {t('flowReg.migration.summary', { n: migration.migrated, failed: migration.failed.length })}
              </span>
              <button type="button" onClick={() => flowRegistry.dismissMigration()} aria-label={t('flowReg.close')} className="shrink-0 cursor-pointer">
                <X className="h-3 w-3" aria-hidden="true" />
              </button>
            </div>
            {migration.failed.map((f, i) => (
              <div key={i} className="mt-0.5 break-words text-critical">{f.name}: {f.message}</div>
            ))}
            {migration.notes.map((n, i) => (
              <div key={i} className="mt-0.5 break-words">{n}</div>
            ))}
          </div>
        )}

        <div className="grid grid-cols-2 gap-1 border-b border-hairline p-2">
          <button type="button" className={DIAG_BTN_SM} onClick={() => flowRegistry.newDocument('nexuscan.flow')}>
            <FilePlus2 className="h-3 w-3" aria-hidden="true" />
            {t('flowReg.newFlow')}
          </button>
          <button type="button" className={DIAG_BTN_SM} onClick={() => flowRegistry.newDocument('nexuscan.block')}>
            <FilePlus2 className="h-3 w-3" aria-hidden="true" />
            {t('flowReg.newBlock')}
          </button>
          <button type="button" className={DIAG_BTN_SM} onClick={onNewFromTemplate}>
            {t('flowReg.newFromTemplate')}
          </button>
          <button type="button" className={DIAG_BTN_SM} onClick={() => void flowRegistry.importFromFile()}>
            <Upload className="h-3 w-3" aria-hidden="true" />
            {t('flowReg.import')}
          </button>
        </div>

        <div className="flex flex-col gap-1.5 border-b border-hairline p-2">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('flowReg.search')}
            aria-label={t('flowReg.search')}
            className={FIELD}
          />
          <div className="flex items-center gap-2">
            <select value={tag} onChange={(e) => setTag(e.target.value)} aria-label={t('flowReg.tagFilter')} className={`${FIELD} cursor-pointer`}>
              <option value="">{t('flowReg.allTags')}</option>
              {tags.map((x) => (
                <option key={x} value={x}>{x}</option>
              ))}
            </select>
            <label className="flex shrink-0 cursor-pointer items-center gap-1 text-[11.5px] text-muted">
              <input type="checkbox" checked={showDeleted} onChange={(e) => void flowRegistry.setShowDeleted(e.target.checked)} className={DIAG_CHECKBOX} />
              {t('flowReg.showDeleted')}
            </label>
          </div>
        </div>

        {loading && entries.length === 0 && <div className="px-2.5 py-2 font-mono text-[11.5px] text-subtle">…</div>}
        <Section kind="nexuscan.flow" entries={sorted.filter((e) => e.kind === 'nexuscan.flow')} sel={sel} setSel={setSel} />
        <Section kind="nexuscan.block" entries={sorted.filter((e) => e.kind === 'nexuscan.block')} sel={sel} setSel={setSel} />
      </div>
    </ResizablePanel>
  );
};
