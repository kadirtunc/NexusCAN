/** Open documents of the Flow Editor as tabs (name, revision, dirty marker, close with unsaved-changes confirm). */
import React from 'react';
import { Box, Workflow, X } from 'lucide-react';
import { useI18n } from '../../../i18n';
import { useFlowStore } from '../FlowStore';
import { flowRegistry, useFlowRegistry, type FlowDocument } from './flowRegistryStore';

/** Tab title: the live name for the active document (renames are not stashed until a tab switch). */
export function docTitle(doc: FlowDocument, liveName: string | null): string {
  const name = liveName ?? doc.diagram.name;
  return doc.readOnly && doc.viewRevision !== null ? `${name} r${doc.viewRevision}` : name;
}

export function closeWithConfirm(doc: FlowDocument, confirmText: string): boolean {
  if (doc.dirty && !doc.readOnly && !window.confirm(confirmText)) return false;
  return flowRegistry.close(doc.key);
}

export const FlowDocTabs: React.FC = () => {
  const { t } = useI18n();
  const { docs, activeKey } = useFlowRegistry();
  const { diagram, isRunning } = useFlowStore();
  if (docs.length === 0) return null;
  return (
    <div role="tablist" className="flex h-8 shrink-0 items-stretch overflow-x-auto border-b border-hairline bg-surface">
      {docs.map((d) => {
        const active = d.key === activeKey;
        const title = docTitle(d, active ? diagram.name : null);
        const Icon = d.kind === 'nexuscan.block' ? Box : Workflow;
        return (
          <div
            key={d.key}
            role="tab"
            aria-selected={active}
            className={`flex max-w-[220px] shrink-0 items-center gap-1.5 border-r border-hairline px-2.5 ${
              active ? 'border-t-2 border-t-focus bg-canvas text-ink' : 'border-t-2 border-t-transparent text-muted hover:text-ink'
            }`}
          >
            <button
              type="button"
              disabled={isRunning && !active}
              onClick={() => flowRegistry.activate(d.key)}
              title={isRunning && !active ? t('flowReg.tabs.running') : title}
              className="flex min-w-0 cursor-pointer items-center gap-1.5 disabled:cursor-not-allowed"
            >
              <Icon className="h-3 w-3 shrink-0" aria-hidden="true" />
              <span className="min-w-0 truncate text-[12px]">{title}</span>
              {d.readOnly && <span className="shrink-0 font-mono text-[10px] uppercase text-subtle">{t('flowReg.readOnlyShort')}</span>}
              {!d.readOnly && d.dirty && (
                <span className="shrink-0 text-warn" title={t('flowReg.unsaved')} aria-label={t('flowReg.unsaved')}>●</span>
              )}
            </button>
            <button
              type="button"
              disabled={isRunning && active}
              onClick={() => closeWithConfirm(d, t('flowReg.closeConfirm', { name: title }))}
              title={t('flowReg.closeTab')}
              aria-label={t('flowReg.closeTab')}
              className="shrink-0 cursor-pointer rounded-[2px] p-0.5 text-muted hover:text-critical disabled:cursor-not-allowed disabled:opacity-40"
            >
              <X className="h-3 w-3" aria-hidden="true" />
            </button>
          </div>
        );
      })}
    </div>
  );
};
