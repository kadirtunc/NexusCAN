/**
 * "ECU Kayit" sub-tab: vehicle -> flat groups -> ECU records. Left: groups + ECU rows (actions: Edit, Duplicate,
 * Delete, Open Session). Right: the draft ECU form, or the empty state when the vehicle has no ECU.
 */
import React, { useMemo, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  Copy,
  Download,
  FolderPlus,
  Pencil,
  Play,
  Plus,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { useI18n, type TranslationKey } from '../../../i18n';
import { apiSeedKeyListProfiles } from '../../../services/ipcClient';
import {
  ECU_GROUP_COLORS,
  OPERABLE_PROTOCOLS,
  type EcuGroupColor,
  type EcuGroupV1,
  type EcuRecordV1,
} from '../../../types/diagWorkspace';
import {
  DIAG_BTN,
  DIAG_BTN_DANGER,
  DIAG_BTN_PRIMARY,
  DIAG_BTN_SM,
  DIAG_INPUT,
  DIAG_PANEL,
  DIAG_SECTION_TITLE,
  DIAG_TOOLBAR,
  DiagBadge,
  DiagNotice,
} from '../diagUi';
import { diagWorkspaceStore, selectActiveVehicle, useDiagWorkspace, type StoreResult } from './diagWorkspaceStore';
import { newEcuRecord, uniqueName } from './ecuDefaults';
import { EcuEmptyState } from './EcuEmptyState';
import { EcuForm } from './EcuForm';
import { buildEcuFile, ecuFileName, prepareEcuImport, serializeEcuFile, type EcuExportSelection } from './ecuExchange';
import { validateVehicle } from './ecuValidation';
import { fmtId } from './ecuViewHelpers';
import { downloadTextFile, pickTextFile } from './fileIo';

const GROUP_COLOR_HEX: Record<EcuGroupColor, string> = {
  amber: '#F59E0B',
  red: '#EF4444',
  orange: '#F97316',
  cyan: '#06B6D4',
  violet: '#8B5CF6',
  emerald: '#10B981',
  slate: '#64748B',
};

const ICON_BTN =
  'inline-flex h-[24px] w-[24px] shrink-0 cursor-pointer items-center justify-center rounded-[2px] border border-transparent text-muted hover:border-strong hover:text-ink disabled:cursor-not-allowed disabled:opacity-40';

type NameDialog =
  | { kind: 'newVehicle' }
  | { kind: 'renameVehicle'; value: string }
  | { kind: 'newGroup' }
  | { kind: 'renameGroup'; groupId: string; value: string };

type Confirm =
  | { kind: 'deleteVehicle' }
  | { kind: 'deleteEcu'; ecuId: string }
  | { kind: 'deleteGroup'; groupId: string; moveTo: string };

interface Banner {
  tone: 'warn' | 'critical' | 'nominal';
  text: string;
}

interface PendingImport {
  fileName: string;
  raw: unknown;
  ecuCount: number;
  groupCount: number;
  targetVehicleId: string;
}

interface Props {
  onOpenSession: (ecu: EcuRecordV1) => void;
  onFindEcu: () => void;
  onSimulate: () => void;
}

function reasonKey(r: Extract<StoreResult, { ok: false }>['reason']): TranslationKey {
  switch (r) {
    case 'empty_name': return 'diagWs.err.emptyName';
    case 'duplicate_name': return 'diagWs.err.duplicateName';
    case 'not_empty': return 'diagWs.err.groupNotEmpty';
    case 'group_not_found': return 'diagWs.err.groupNotFound';
    default: return 'diagWs.err.notFound';
  }
}

export const EcuRegistryView: React.FC<Props> = ({ onOpenSession, onFindEcu, onSimulate }) => {
  const { t } = useI18n();
  const diag = useDiagWorkspace();
  const vehicle = selectActiveVehicle(diag);
  const [editing, setEditing] = useState<{ ecu: EcuRecordV1; isNew: boolean } | null>(null);
  const [naming, setNaming] = useState<NameDialog | null>(null);
  const [nameText, setNameText] = useState('');
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [banner, setBanner] = useState<Banner | null>(null);
  const [pendingImport, setPendingImport] = useState<PendingImport | null>(null);

  const validation = useMemo(() => (vehicle ? validateVehicle(vehicle, t) : null), [vehicle, t]);

  const groups = useMemo(() => (vehicle ? [...vehicle.groups].sort((a, b) => a.order - b.order) : []), [vehicle]);
  const ecusIn = (groupId: string | null): EcuRecordV1[] =>
    vehicle ? vehicle.ecus.filter((e) => e.groupId === groupId).sort((a, b) => a.order - b.order) : [];

  function fail(r: Extract<StoreResult, { ok: false }>): void {
    setBanner({ tone: 'critical', text: t(reasonKey(r.reason)) });
  }

  // ── ECU actions ──
  function startNewEcu(groupId: string | null): void {
    let vid = vehicle?.id ?? null;
    if (vid === null) {
      const created = diagWorkspaceStore.createVehicle(t('diagWs.defaultVehicle'));
      if (!created.ok) return fail(created);
      vid = created.value;
    }
    const veh = diagWorkspaceStore.getState().vehicles.find((v) => v.id === vid);
    if (!veh) return;
    let requestId = 0x7e0;
    for (let i = 0; i < 8; i += 1) {
      if (!veh.ecus.some((e) => e.addressing.requestId === 0x7e0 + i)) {
        requestId = 0x7e0 + i;
        break;
      }
    }
    setEditing({
      isNew: true,
      ecu: newEcuRecord({
        name: uniqueName(`ECU ${veh.ecus.length + 1}`, veh.ecus.map((e) => e.name)),
        groupId,
        addressing: { requestId, responseId: requestId + 8 },
      }),
    });
    setBanner(null);
  }

  function saveDraft(draft: EcuRecordV1): void {
    if (!vehicle || !editing) return;
    const r = editing.isNew ? diagWorkspaceStore.createEcu(vehicle.id, draft) : diagWorkspaceStore.updateEcu(vehicle.id, draft);
    if (!r.ok) return fail(r);
    setEditing(null);
    setBanner({ tone: 'nominal', text: t('diagWs.msg.saved', { name: draft.name }) });
  }

  function exportSel(sel: EcuExportSelection): void {
    if (!vehicle) return;
    const file = buildEcuFile(vehicle, sel);
    if (!file) return;
    downloadTextFile(ecuFileName(vehicle, sel), serializeEcuFile(file));
    setBanner({ tone: 'nominal', text: t('diagWs.msg.exported', { count: file.ecus.length }) });
  }

  async function chooseImportFile(): Promise<void> {
    try {
      const picked = await pickTextFile('.json,application/json');
      if (picked === null) return;
      const raw: unknown = JSON.parse(picked.text);
      const rec = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
      setPendingImport({
        fileName: picked.name,
        raw,
        ecuCount: Array.isArray(rec['ecus']) ? rec['ecus'].length : 0,
        groupCount: Array.isArray(rec['groups']) ? rec['groups'].length : 0,
        targetVehicleId: vehicle?.id ?? '',
      });
      setBanner(null);
    } catch (e) {
      setBanner({ tone: 'critical', text: t('diagWs.msg.importFailed', { error: e instanceof Error ? e.message : String(e) }) });
    }
  }

  async function runImport(p: PendingImport): Promise<void> {
    let targetId = p.targetVehicleId;
    if (targetId === '') {
      const created = diagWorkspaceStore.createVehicle(t('diagWs.defaultVehicle'));
      if (!created.ok) return fail(created);
      targetId = created.value;
    }
    const target = diagWorkspaceStore.getState().vehicles.find((v) => v.id === targetId);
    if (!target) return;
    let known = new Set<string>();
    try {
      known = new Set((await apiSeedKeyListProfiles()).map((x) => x.id));
    } catch {
      // Profile store unreachable: every referenced profile is treated as absent (cleared + reported).
    }
    const res = prepareEcuImport(p.raw, target, known);
    if (!res.ok) {
      setBanner({ tone: 'critical', text: t('diagWs.msg.importFailed', { error: res.error }) });
      return;
    }
    const r = diagWorkspaceStore.appendImported(target.id, res.groups, res.ecus);
    if (!r.ok) return fail(r);
    diagWorkspaceStore.selectVehicle(target.id);
    setPendingImport(null);
    const parts = [t('diagWs.msg.imported', { count: res.ecus.length })];
    if (res.report.renamedEcus.length + res.report.renamedGroups.length > 0) {
      parts.push(t('diagWs.msg.renamed', { names: [...res.report.renamedGroups, ...res.report.renamedEcus].join(', ') }));
    }
    if (res.report.clearedSeedKeyProfiles.length > 0) {
      parts.push(
        t('diagWs.msg.seedCleared', {
          list: res.report.clearedSeedKeyProfiles.map((c) => `${c.ecuName} (${c.profileId})`).join(', '),
        }),
      );
    }
    setBanner({ tone: res.report.clearedSeedKeyProfiles.length > 0 ? 'warn' : 'nominal', text: parts.join(' ') });
  }

  // ── name dialog ──
  function openNaming(d: NameDialog, initial = ''): void {
    setNaming(d);
    setNameText(initial);
    setConfirm(null);
    setBanner(null);
  }

  function submitNaming(): void {
    if (!naming) return;
    let r: StoreResult<unknown>;
    if (naming.kind === 'newVehicle') r = diagWorkspaceStore.createVehicle(nameText);
    else if (naming.kind === 'renameVehicle' && vehicle) r = diagWorkspaceStore.renameVehicle(vehicle.id, nameText);
    else if (naming.kind === 'newGroup' && vehicle) r = diagWorkspaceStore.createGroup(vehicle.id, nameText, 'slate');
    else if (naming.kind === 'renameGroup' && vehicle) r = diagWorkspaceStore.renameGroup(vehicle.id, naming.groupId, nameText);
    else return;
    if (!r.ok) return fail(r);
    setNaming(null);
    setEditing(null);
  }

  // ── confirmations ──
  function runConfirm(c: Confirm): void {
    if (!vehicle) return;
    let r: StoreResult<unknown>;
    if (c.kind === 'deleteVehicle') r = diagWorkspaceStore.deleteVehicle(vehicle.id);
    else if (c.kind === 'deleteEcu') r = diagWorkspaceStore.deleteEcu(vehicle.id, c.ecuId);
    else r = diagWorkspaceStore.deleteGroup(vehicle.id, c.groupId, c.moveTo === '' ? null : c.moveTo);
    if (!r.ok) return fail(r);
    setConfirm(null);
    setEditing(null);
  }

  function renderConfirm(c: Confirm): React.ReactNode {
    if (!vehicle) return null;
    let body: React.ReactNode;
    if (c.kind === 'deleteVehicle') {
      body = (
        <p>
          {t('diagWs.confirm.deleteVehicle', {
            name: vehicle.name,
            ecus: vehicle.ecus.length,
            bindings: vehicle.bindings.length,
          })}
        </p>
      );
    } else if (c.kind === 'deleteEcu') {
      const ecu = vehicle.ecus.find((e) => e.id === c.ecuId);
      const bindings = diagWorkspaceStore.bindingsOfEcu(vehicle.id, c.ecuId);
      body = (
        <>
          <p>{t('diagWs.confirm.deleteEcu', { name: ecu?.name ?? '' })}</p>
          {bindings.length > 0 && (
            <div className="mt-1">
              <p className="font-semibold">{t('diagWs.confirm.bindings', { count: bindings.length })}</p>
              <ul className="ml-4 list-disc font-mono tabular-nums">
                {bindings.map((b) => (
                  <li key={b.id}>
                    {b.label ?? b.flowRef.flowId} (r{b.flowRef.revision})
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      );
    } else {
      const grp = vehicle.groups.find((g) => g.id === c.groupId);
      const count = vehicle.ecus.filter((e) => e.groupId === c.groupId).length;
      body = (
        <>
          <p>{t('diagWs.confirm.deleteGroup', { name: grp?.name ?? '' })}</p>
          {count > 0 && (
            <label className="mt-1 flex items-center gap-2">
              <span>{t('diagWs.confirm.moveTo', { count })}</span>
              <select
                value={c.moveTo}
                onChange={(e) => setConfirm({ ...c, moveTo: e.target.value })}
                className={`${DIAG_INPUT} !h-[26px] !w-auto`}
              >
                <option value="">{t('diagWs.ungrouped')}</option>
                {vehicle.groups
                  .filter((g) => g.id !== c.groupId)
                  .map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.name}
                    </option>
                  ))}
              </select>
            </label>
          )}
        </>
      );
    }
    return (
      <div className="flex shrink-0 items-start gap-3 border-b border-hairline bg-canvas px-3.5 py-2">
        <div className="min-w-0 flex-1">
          <DiagNotice tone="warn">{body}</DiagNotice>
        </div>
        <button type="button" onClick={() => runConfirm(c)} className={DIAG_BTN_DANGER}>
          {t('diagWs.confirm.delete')}
        </button>
        <button type="button" onClick={() => setConfirm(null)} className={DIAG_BTN}>
          {t('diagWs.form.cancel')}
        </button>
      </div>
    );
  }

  // ── rows ──
  function renderEcuRow(e: EcuRecordV1, idx: number, total: number): React.ReactNode {
    if (!vehicle) return null;
    const issues = validation?.ecu.get(e.id) ?? [];
    const operable = OPERABLE_PROTOCOLS.includes(e.protocol);
    const blockReason = issues.length > 0 ? t('diagWs.row.openInvalid') : !operable ? t('diagWs.protocol.unsupported') : undefined;
    const selected = editing !== null && !editing.isNew && editing.ecu.id === e.id;
    return (
      <div
        key={e.id}
        className={`flex flex-col gap-1 border-b border-hairline px-3 py-1.5 ${selected ? 'bg-[var(--status-focus-bg)]' : 'hover:bg-[var(--bg-row-hover)]'}`}
      >
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate font-sans text-[12.5px] font-semibold text-ink" title={e.name}>
            {e.name}
          </span>
          <DiagBadge tone={operable ? 'focus' : 'neutral'}>{t(`diagWs.protocol.${e.protocol}`)}</DiagBadge>
          {issues.length > 0 ? (
            <DiagBadge tone="critical" title={issues.map((i) => i.message).join('\n')}>
              {t('diagWs.row.invalid', { count: issues.length })}
            </DiagBadge>
          ) : (
            <DiagBadge tone="nominal">{t('diagWs.row.valid')}</DiagBadge>
          )}
        </div>
        <div className="flex items-center gap-1">
          <span className="font-mono text-[11.5px] tabular-nums text-muted">
            {t('diagTabs.reqShort')} {fmtId(e.addressing.requestId, e.addressing.isExtendedId)}
            {'  '}
            {t('diagTabs.respShort')} {fmtId(e.addressing.responseId, e.addressing.isExtendedId)}
          </span>
          <div className="flex-1" />
          <button
            type="button"
            disabled={blockReason !== undefined}
            title={blockReason}
            onClick={() => onOpenSession(e)}
            className={`${DIAG_BTN_SM} !border-focus !text-focus`}
          >
            <Play className="h-3 w-3" aria-hidden="true" />
            {t('diagWs.row.openSession')}
          </button>
          <button type="button" className={ICON_BTN} title={t('diagWs.row.edit')} aria-label={t('diagWs.row.edit')} onClick={() => { setEditing({ ecu: e, isNew: false }); setBanner(null); }}>
            <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
          <button
            type="button"
            className={ICON_BTN}
            title={t('diagWs.row.duplicate')}
            aria-label={t('diagWs.row.duplicate')}
            onClick={() => {
              const r = diagWorkspaceStore.duplicateEcu(vehicle.id, e.id);
              if (!r.ok) fail(r);
            }}
          >
            <Copy className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
          <button type="button" className={ICON_BTN} title={t('diagWs.row.export')} aria-label={t('diagWs.row.export')} onClick={() => exportSel({ kind: 'ecu', ecuId: e.id })}>
            <Download className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
          <button type="button" className={ICON_BTN} title={t('diagWs.row.up')} aria-label={t('diagWs.row.up')} disabled={idx === 0} onClick={() => diagWorkspaceStore.reorderEcu(vehicle.id, e.id, idx - 1)}>
            <ArrowUp className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
          <button type="button" className={ICON_BTN} title={t('diagWs.row.down')} aria-label={t('diagWs.row.down')} disabled={idx === total - 1} onClick={() => diagWorkspaceStore.reorderEcu(vehicle.id, e.id, idx + 1)}>
            <ArrowDown className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
          <button type="button" className={`${ICON_BTN} hover:!text-[color:var(--status-critical)]`} title={t('diagWs.row.delete')} aria-label={t('diagWs.row.delete')} onClick={() => { setConfirm({ kind: 'deleteEcu', ecuId: e.id }); setNaming(null); setBanner(null); }}>
            <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </div>
      </div>
    );
  }

  function renderGroup(g: EcuGroupV1 | null, gIdx: number): React.ReactNode {
    if (!vehicle) return null;
    const list = ecusIn(g?.id ?? null);
    if (g === null && list.length === 0) return null;
    const groupIssue = g ? validation?.groups.find((x) => x.groupId === g.id) : undefined;
    return (
      <div key={g?.id ?? '__none__'} className="flex flex-col">
        <div className="flex items-center gap-1.5 border-b border-hairline bg-elevated px-3 py-1">
          {g ? (
            <button
              type="button"
              title={t('diagWs.group.recolor')}
              aria-label={t('diagWs.group.recolor')}
              onClick={() => {
                const next = ECU_GROUP_COLORS[(ECU_GROUP_COLORS.indexOf(g.color) + 1) % ECU_GROUP_COLORS.length];
                diagWorkspaceStore.recolorGroup(vehicle.id, g.id, next);
              }}
              className="h-3 w-3 shrink-0 cursor-pointer rounded-[2px] border border-strong"
              style={{ backgroundColor: GROUP_COLOR_HEX[g.color] }}
            />
          ) : (
            <span className="h-3 w-3 shrink-0 rounded-[2px] border border-strong" />
          )}
          <span className={`${DIAG_SECTION_TITLE} min-w-0 flex-1 truncate`} title={groupIssue?.message}>
            {g ? g.name : t('diagWs.ungrouped')}
            {groupIssue && <span className="ml-1.5 text-[color:var(--status-critical)]">{groupIssue.message}</span>}
          </span>
          <span className="font-mono text-[11px] tabular-nums text-muted">{list.length}</span>
          <button type="button" className={ICON_BTN} title={t('diagWs.group.addEcu')} aria-label={t('diagWs.group.addEcu')} onClick={() => startNewEcu(g?.id ?? null)}>
            <Plus className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
          {g && (
            <>
              <button type="button" className={ICON_BTN} title={t('diagWs.group.rename')} aria-label={t('diagWs.group.rename')} onClick={() => openNaming({ kind: 'renameGroup', groupId: g.id, value: g.name }, g.name)}>
                <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
              <button type="button" className={ICON_BTN} title={t('diagWs.group.export')} aria-label={t('diagWs.group.export')} onClick={() => exportSel({ kind: 'group', groupId: g.id })}>
                <Download className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
              <button type="button" className={ICON_BTN} title={t('diagWs.row.up')} aria-label={t('diagWs.row.up')} disabled={gIdx === 0} onClick={() => diagWorkspaceStore.reorderGroup(vehicle.id, g.id, gIdx - 1)}>
                <ArrowUp className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
              <button type="button" className={ICON_BTN} title={t('diagWs.row.down')} aria-label={t('diagWs.row.down')} disabled={gIdx === groups.length - 1} onClick={() => diagWorkspaceStore.reorderGroup(vehicle.id, g.id, gIdx + 1)}>
                <ArrowDown className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
              <button
                type="button"
                className={`${ICON_BTN} hover:!text-[color:var(--status-critical)]`}
                title={t('diagWs.group.delete')}
                aria-label={t('diagWs.group.delete')}
                onClick={() => {
                  setConfirm({ kind: 'deleteGroup', groupId: g.id, moveTo: '' });
                  setNaming(null);
                  setBanner(null);
                }}
              >
                <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            </>
          )}
        </div>
        {list.map((e, i) => renderEcuRow(e, i, list.length))}
        {list.length === 0 && <p className="border-b border-hairline px-3 py-2 text-[12px] text-subtle">{t('diagWs.group.empty')}</p>}
      </div>
    );
  }

  const showEmpty = (vehicle === null || vehicle.ecus.length === 0) && editing === null;
  const importTargets = diag.vehicles;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-canvas">
      {/* Toolbar: vehicle + exchange */}
      <div className={DIAG_TOOLBAR}>
        <span className={DIAG_SECTION_TITLE}>{t('diagWs.vehicle')}</span>
        <select
          value={vehicle?.id ?? ''}
          onChange={(e) => {
            diagWorkspaceStore.selectVehicle(e.target.value);
            setEditing(null);
            setConfirm(null);
          }}
          disabled={diag.vehicles.length === 0}
          aria-label={t('diagWs.vehicle')}
          className={`${DIAG_INPUT} !w-[220px]`}
        >
          {diag.vehicles.length === 0 && <option value="">{t('diagWs.noVehicle')}</option>}
          {diag.vehicles.map((v) => (
            <option key={v.id} value={v.id}>
              {v.name}
            </option>
          ))}
        </select>
        <button type="button" className={DIAG_BTN_SM} onClick={() => openNaming({ kind: 'newVehicle' })}>
          <Plus className="h-3 w-3" aria-hidden="true" />
          {t('diagWs.vehicle.new')}
        </button>
        {vehicle && (
          <>
            <button type="button" className={ICON_BTN} title={t('diagWs.vehicle.rename')} aria-label={t('diagWs.vehicle.rename')} onClick={() => openNaming({ kind: 'renameVehicle', value: vehicle.name }, vehicle.name)}>
              <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
            <button type="button" className={`${ICON_BTN} hover:!text-[color:var(--status-critical)]`} title={t('diagWs.vehicle.delete')} aria-label={t('diagWs.vehicle.delete')} onClick={() => { setConfirm({ kind: 'deleteVehicle' }); setNaming(null); setBanner(null); }}>
              <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </>
        )}
        <div className="flex-1" />
        {vehicle && (
          <>
            <button type="button" className={DIAG_BTN_SM} onClick={() => openNaming({ kind: 'newGroup' })}>
              <FolderPlus className="h-3 w-3" aria-hidden="true" />
              {t('diagWs.group.new')}
            </button>
            <button type="button" className={DIAG_BTN_SM} disabled={vehicle.ecus.length === 0} onClick={() => exportSel({ kind: 'vehicle' })}>
              <Download className="h-3 w-3" aria-hidden="true" />
              {t('diagWs.vehicle.export')}
            </button>
          </>
        )}
        <button type="button" className={DIAG_BTN_SM} onClick={() => void chooseImportFile()}>
          <Upload className="h-3 w-3" aria-hidden="true" />
          {t('diagWs.import')}
        </button>
      </div>

      {/* Inline name entry */}
      {naming && (
        <div className="flex shrink-0 items-center gap-2 border-b border-hairline bg-canvas px-3.5 py-2">
          <span className={DIAG_SECTION_TITLE}>
            {naming.kind === 'newVehicle' || naming.kind === 'renameVehicle' ? t('diagWs.vehicle') : t('diagWs.group')}
          </span>
          <input
            autoFocus
            value={nameText}
            maxLength={64}
            onChange={(e) => setNameText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submitNaming();
              if (e.key === 'Escape') setNaming(null);
            }}
            aria-label={t('diagWs.nameField')}
            className={`${DIAG_INPUT} !w-[260px]`}
          />
          <button type="button" className={DIAG_BTN_PRIMARY} onClick={submitNaming}>
            {t('diagWs.form.save')}
          </button>
          <button type="button" className={DIAG_BTN} onClick={() => setNaming(null)}>
            {t('diagWs.form.cancel')}
          </button>
        </div>
      )}

      {confirm && renderConfirm(confirm)}

      {/* Import target selection */}
      {pendingImport && (
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-hairline bg-canvas px-3.5 py-2">
          <span className="font-mono text-[12px] tabular-nums text-ink">
            {t('diagWs.import.summary', { file: pendingImport.fileName, ecus: pendingImport.ecuCount, groups: pendingImport.groupCount })}
          </span>
          <span className={DIAG_SECTION_TITLE}>{t('diagWs.import.target')}</span>
          {importTargets.length === 0 ? (
            <span className="text-[12px] text-muted">{t('diagWs.import.newVehicle')}</span>
          ) : (
            <select
              value={pendingImport.targetVehicleId}
              onChange={(e) => setPendingImport({ ...pendingImport, targetVehicleId: e.target.value })}
              aria-label={t('diagWs.import.target')}
              className={`${DIAG_INPUT} !w-[220px]`}
            >
              {importTargets.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                </option>
              ))}
            </select>
          )}
          <button type="button" className={DIAG_BTN_PRIMARY} onClick={() => void runImport(pendingImport)}>
            {t('diagWs.import.run')}
          </button>
          <button type="button" className={DIAG_BTN} onClick={() => setPendingImport(null)}>
            {t('diagWs.form.cancel')}
          </button>
        </div>
      )}

      {banner && (
        <div className="flex shrink-0 items-center gap-2 border-b border-hairline bg-canvas px-3.5 py-1.5">
          <div className="min-w-0 flex-1">
            <DiagNotice tone={banner.tone}>{banner.text}</DiagNotice>
          </div>
          <button type="button" className={ICON_BTN} title={t('diagWs.dismiss')} aria-label={t('diagWs.dismiss')} onClick={() => setBanner(null)}>
            <X className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </div>
      )}

      {showEmpty ? (
        <EcuEmptyState onAddEcu={() => startNewEcu(null)} onFindEcu={onFindEcu} onSimulate={onSimulate} />
      ) : (
        vehicle && (
          <div className="flex min-h-0 flex-1 overflow-hidden">
            <div className={`${DIAG_PANEL} m-3 mr-0 flex min-h-0 w-[480px] shrink-0 flex-col overflow-y-auto !border-hairline`}>
              {groups.map((g, i) => renderGroup(g, i))}
              {renderGroup(null, -1)}
              <div className="p-2">
                <button type="button" className={DIAG_BTN_SM} onClick={() => startNewEcu(null)}>
                  <Plus className="h-3 w-3" aria-hidden="true" />
                  {t('diagWs.empty.add')}
                </button>
              </div>
            </div>
            <div className={`${DIAG_PANEL} m-3 flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden`}>
              {editing ? (
                <EcuForm
                  key={`${editing.ecu.id}:${editing.isNew ? 'new' : editing.ecu.revision}`}
                  initial={editing.ecu}
                  isNew={editing.isNew}
                  vehicle={vehicle}
                  onSave={saveDraft}
                  onCancel={() => setEditing(null)}
                />
              ) : (
                <div className="flex flex-1 items-center justify-center p-6 text-[12.5px] text-muted">{t('diagWs.selectHint')}</div>
              )}
            </div>
          </div>
        )
      )}
    </div>
  );
};
