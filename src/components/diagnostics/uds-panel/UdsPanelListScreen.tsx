/**
 * Diagnostic Simulation panel directory (diag-simulation-v1 §2): the generalised Simulation
 * `SimulationPanelListView` fed by `udsPanelStore` (search / create / rename / duplicate / delete /
 * export `.nexusdiagpanel.json` / import / open). Opening a panel never starts polling; "Run" is the
 * explicit Run mode entry exactly like in Simulation.
 */
import React, { useMemo, useRef, useState } from 'react';
import { Wand2 } from 'lucide-react';
import { useI18n } from '../../../i18n';
import type { UdsPanelDto } from '../../../types/uds';
import {
  DEFAULT_PANEL_KIND_ORDER,
  SimulationPanelListView,
} from '../../simulation/SimulationPanelListView';
import {
  computeUdsDirtyById,
  udsPanelStore,
  useUdsPanelStore,
} from './udsInstrumentStore';
import {
  buildDiagPanelFile,
  DIAG_PANEL_FILE_SUFFIX,
  parseDiagPanelFile,
} from './udsPanelSanitize';

const KIND_ORDER = [...DEFAULT_PANEL_KIND_ORDER, 'textbox' as const];

function slugify(name: string): string {
  const s = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return s.length > 0 ? s.slice(0, 64) : 'diagnostic-panel';
}

interface NameDialogState {
  mode: 'create' | 'rename';
  id: string | null;
  name: string;
  description: string;
}

function NameDialog({
  state,
  onChange,
  onCancel,
  onCommit,
}: {
  state: NameDialogState;
  onChange: (next: NameDialogState) => void;
  onCancel: () => void;
  onCommit: () => void;
}): React.JSX.Element {
  const { t } = useI18n();
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-canvas/80 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={t(state.mode === 'create' ? 'udsPanel.list.createTitle' : 'udsPanel.list.renameTitle')}
    >
      <div className="w-full max-w-md space-y-3 rounded-[2px] border border-strong bg-surface p-4">
        <h2 className="font-mono text-xs font-bold uppercase tracking-wider text-ink">
          {t(state.mode === 'create' ? 'udsPanel.list.createTitle' : 'udsPanel.list.renameTitle')}
        </h2>
        <label className="block space-y-1">
          <span className="font-mono text-[10px] uppercase text-muted">{t('udsPanel.list.fieldName')}</span>
          <input
            autoFocus
            value={state.name}
            maxLength={128}
            onChange={(e) => onChange({ ...state, name: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onCommit();
              if (e.key === 'Escape') onCancel();
            }}
            className="h-8 w-full rounded-[2px] border border-hairline bg-canvas px-2 font-mono text-[12px] text-ink"
          />
        </label>
        <label className="block space-y-1">
          <span className="font-mono text-[10px] uppercase text-muted">{t('udsPanel.list.fieldDesc')}</span>
          <input
            value={state.description}
            maxLength={1024}
            onChange={(e) => onChange({ ...state, description: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onCommit();
              if (e.key === 'Escape') onCancel();
            }}
            className="h-8 w-full rounded-[2px] border border-hairline bg-canvas px-2 font-mono text-[12px] text-ink"
          />
        </label>
        <div className="flex justify-end gap-2 font-mono text-[11px] font-semibold uppercase">
          <button
            type="button"
            onClick={onCancel}
            className="h-8 cursor-pointer rounded-[2px] border border-hairline bg-canvas px-3 text-muted hover:border-strong hover:text-ink"
          >
            {t('udsPanel.list.cancel')}
          </button>
          <button
            type="button"
            disabled={state.name.trim().length === 0}
            onClick={onCommit}
            className="h-8 cursor-pointer rounded-[2px] px-3 text-white disabled:opacity-50"
            style={{ backgroundColor: 'var(--status-focus)' }}
          >
            {t(state.mode === 'create' ? 'udsPanel.list.create' : 'udsPanel.list.save')}
          </button>
        </div>
      </div>
    </div>
  );
}

export const UdsPanelListScreen: React.FC = () => {
  const { t } = useI18n();
  const { panels, savedSnapshots } = useUdsPanelStore();
  const [dialog, setDialog] = useState<NameDialogState | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const dirtyById = useMemo(() => computeUdsDirtyById(panels, savedSnapshots), [panels, savedSnapshots]);

  const commitDialog = (): void => {
    if (!dialog) return;
    const name = dialog.name.trim();
    if (name.length === 0) return;
    if (dialog.mode === 'create') udsPanelStore.createPanel(name, dialog.description.trim());
    else if (dialog.id) udsPanelStore.renamePanel(dialog.id, name, dialog.description.trim());
    setDialog(null);
  };

  const exportPanel = (panel: UdsPanelDto): void => {
    const blob = new Blob([JSON.stringify(buildDiagPanelFile(panel), null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${slugify(panel.name)}${DIAG_PANEL_FILE_SUFFIX}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const importFile = async (e: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    let text = '';
    try {
      text = await file.text();
    } catch {
      udsPanelStore.notify('error', 'udsPanel.notice.importInvalid');
      return;
    }
    const res = parseDiagPanelFile(text);
    if (!res.ok) {
      udsPanelStore.notify('error', 'udsPanel.notice.importInvalid');
      return;
    }
    udsPanelStore.addImportedPanel(res.panel);
    if (res.droppedWidgets > 0) {
      udsPanelStore.notify('warning', 'udsPanel.notice.importDropped', { count: res.droppedWidgets });
    }
  };

  const deletePanel = (panel: UdsPanelDto): void => {
    if (window.confirm(t('udsPanel.toolbar.deleteConfirm', { name: panel.name }))) {
      udsPanelStore.deletePanel(panel.id);
    }
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <input
        ref={fileRef}
        type="file"
        accept=".json,application/json"
        className="hidden"
        onChange={(e) => void importFile(e)}
      />
      <SimulationPanelListView<UdsPanelDto>
        canMutate
        allowProjectSwitch={false}
        projects={[]}
        resolvedProject={null}
        panels={panels}
        dirtyById={dirtyById}
        databases={[]}
        loadedDbEntries={[]}
        loadingPanels={false}
        savingPanel={false}
        showGenerators={false}
        showDatabases={false}
        kindOrder={KIND_ORDER}
        texts={{
          mainTitle: t('udsPanel.toolbar.title'),
          mainDesc: t('udsPanel.list.desc'),
          importLabel: t('udsPanel.list.import'),
          exportTitle: t('udsPanel.list.exportTitle'),
          emptyTitle: t('udsPanel.empty.title'),
          emptyDesc: t('udsPanel.empty.desc'),
          duplicateTitle: t('udsPanel.list.duplicate'),
        }}
        extraActions={
          <button
            type="button"
            onClick={() =>
              udsPanelStore.createStarterPanel(t('udsPanel.list.starterName'))
            }
            title={t('udsPanel.list.starterTitle')}
            className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-[2px] border border-hairline bg-canvas px-3 font-mono text-[11px] font-semibold uppercase text-ink hover:border-strong hover:bg-elevated"
          >
            <Wand2 className="h-3.5 w-3.5 text-focus" aria-hidden="true" />
            {t('udsPanel.list.starter')}
          </button>
        }
        onSelectProjectSlug={() => undefined}
        onEnterPanel={(id, mode) => udsPanelStore.enterPanel(id, mode === 'run' ? 'run' : 'design')}
        onOpenCreateModal={() =>
          setDialog({
            mode: 'create',
            id: null,
            name: t('udsPanel.toolbar.newPanelName', { n: panels.length + 1 }),
            description: '',
          })
        }
        onOpenGenerateFromDbcModal={() => undefined}
        onTriggerImportJson={() => fileRef.current?.click()}
        onExportPanelJson={exportPanel}
        onRequestRenamePanel={(p) =>
          setDialog({ mode: 'rename', id: p.id, name: p.name, description: p.description })
        }
        onRequestDeletePanel={deletePanel}
        onDuplicatePanel={(p) => udsPanelStore.duplicatePanel(p.id)}
      />
      {dialog && (
        <NameDialog
          state={dialog}
          onChange={setDialog}
          onCancel={() => setDialog(null)}
          onCommit={commitDialog}
        />
      )}
    </div>
  );
};
