import React, { useCallback, useState } from 'react';
import { Settings2, Trash2 } from 'lucide-react';
import type { FlowBlock, BlockDef, ConfigField } from './types';
import { useFlowStore, flowStore } from './FlowStore';
import { bindableFields, boundPortId, FUNCTIONAL_OK_BLOCKS, getBlockDefFor, readBoundParams, REQUEST_OPTION_BLOCKS, SPR_BLOCKS, type BindableField } from './blockDefs';
import { useDiagnosticsSelector } from '../../store/diagnosticsStore';
import { portColor } from './BlockNode';
import { blockDescription, blockLabel, fieldPlaceholder, localizedText } from './blockText';
import { useI18n } from '../../i18n';
import { isLegacyJsKeyScript } from './flowAlgos';
import { flowFiles, useFlowFilesVersion } from './flowFiles';
import { FlashImagePanel, FlashRunPanel } from './FlashImagePanel';
import { DIAG_BTN_SM } from '../diagnostics/diagUi';
import { IssueList, useCoreIssues, VariablesPanel } from './FlowVariablesPanel';
import { PortSpecEditor } from './PortSpecsEditor';
import { bindableLabel } from './boundParams';
import { FLOW_IN, FLOW_OUT } from './flowPorts';
import { CallInspector } from './CallInspector';
import { isCallType } from './callIndex';
import { gotoTargetId, listTerminals, resolveGotoTarget, terminalName, terminalReferences } from './flowTerminals';
import {
  DIAG_BTN_DANGER,
  DIAG_CHECKBOX,
  DIAG_SECTION_TITLE,
  DiagBadge,
  type DiagTone,
} from '../diagnostics/diagUi';

// ─── Config field renderers ───────────────────────────────────────────────────

interface FieldProps {
  field: ConfigField;
  value: unknown;
  onChange: (val: unknown) => void;
}

const FIELD_CLASS =
  'w-full rounded-[2px] border border-hairline bg-canvas px-2 py-1 text-[12px] text-ink outline-none placeholder:text-subtle focus:border-focus';

/** Real file for `io_file_input` (File API; bytes stay in memory only). */
const FlowFilePicker: React.FC<{ blockId: string }> = ({ blockId }) => {
  const { t } = useI18n();
  useFlowFilesVersion();
  const file = flowFiles.get(blockId);
  return (
    <div className="flex flex-col gap-1.5">
      <input
        type="file"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void flowFiles.set(blockId, f);
          e.target.value = '';
        }}
        className="w-full text-[12px] text-muted file:mr-2 file:cursor-pointer file:rounded-[2px] file:border file:border-hairline file:bg-elevated file:px-2 file:py-1 file:text-[12px] file:text-ink"
        aria-label={t('diagReal.flow.fileChoose')}
      />
      <div className="flex items-center gap-2 font-mono text-[11.5px] tabular-nums">
        {file ? (
          <>
            <span className="truncate text-ink" title={file.name}>{file.name}</span>
            <span className="shrink-0 text-subtle">{file.bytes.length} B</span>
            <button type="button" onClick={() => flowFiles.clear(blockId)} className={DIAG_BTN_SM}>
              {t('diagReal.flow.fileClear')}
            </button>
          </>
        ) : (
          <span className="text-warn">{t('diagReal.flow.fileNone')}</span>
        )}
      </div>
    </div>
  );
};

/** Select of the flow's declared variables (stores the variable name). */
const VariableSelect: React.FC<{ value: string; onChange: (val: unknown) => void }> = ({ value, onChange }) => {
  const { t } = useI18n();
  const { diagram } = useFlowStore();
  const decls = diagram.variables ?? [];
  const known = decls.some((d) => d.name === value);
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={`${FIELD_CLASS} h-[28px] cursor-pointer font-mono ${value !== '' && !known ? '!border-critical' : ''}`}
    >
      {(value === '' || !known) && <option value={value}>{value === '' ? '—' : `${value} ${t('flowCore.vars.undeclared')}`}</option>}
      {decls.map((d) => (
        <option key={d.name} value={d.name}>{d.name}</option>
      ))}
    </select>
  );
};

/** Comma-separated identifier list (stored as `string[]`); free typing, commits the parsed list on every change. */
const NameListInput: React.FC<{ value: unknown; placeholder?: string; onChange: (val: unknown) => void }> = ({ value, placeholder, onChange }) => {
  const initial = Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string').join(', ') : '';
  const [text, setText] = useState(initial);
  return (
    <input
      type="text"
      value={text}
      spellCheck={false}
      onChange={(e) => {
        setText(e.target.value);
        onChange(e.target.value.split(',').map((x) => x.trim()).filter((x) => x.length > 0));
      }}
      placeholder={placeholder}
      className={`${FIELD_CLASS} h-[28px] font-mono`}
    />
  );
};

const ConfigFieldInput: React.FC<FieldProps> = ({ field, value, onChange }) => {
  const { t } = useI18n();
  const strVal = value !== undefined && value !== null ? String(value) : '';

  switch (field.type) {
    case 'variable':
      return <VariableSelect value={strVal} onChange={onChange} />;

    case 'namelist':
      return <NameListInput value={value} placeholder={fieldPlaceholder(field)} onChange={onChange} />;

    case 'select':
      return (
        <select
          value={strVal}
          onChange={(e) => onChange(e.target.value)}
          className={`${FIELD_CLASS} h-[28px] cursor-pointer`}
        >
          {field.options?.map((o) => (
            <option key={o.value} value={o.value}>{localizedText(o)}</option>
          ))}
        </select>
      );

    case 'boolean':
      return (
        <label className="flex cursor-pointer items-center gap-2">
          <input
            type="checkbox"
            checked={!!value}
            onChange={(e) => onChange(e.target.checked)}
            className={DIAG_CHECKBOX}
          />
          <span className="text-[12px] text-muted">
            {value ? t('diagHmi.flow.yes') : t('diagHmi.flow.no')}
          </span>
        </label>
      );

    case 'number':
      return (
        <input
          type="number"
          value={strVal}
          onChange={(e) => onChange(Number(e.target.value))}
          placeholder={fieldPlaceholder(field)}
          className={`${FIELD_CLASS} h-[28px] font-mono tabular-nums`}
        />
      );

    case 'textarea':
      return (
        <textarea
          value={strVal}
          onChange={(e) => onChange(e.target.value)}
          placeholder={fieldPlaceholder(field)}
          rows={3}
          className={`${FIELD_CLASS} resize-y`}
        />
      );

    case 'hex':
      return (
        <div className="flex items-center">
          <span className="flex h-[28px] items-center rounded-l-[2px] border border-r-0 border-hairline bg-elevated px-1.5 font-mono text-[11px] text-muted">
            0x
          </span>
          <input
            type="text"
            value={strVal}
            onChange={(e) => onChange(e.target.value.replace(/[^0-9a-fA-F]/g, '').toUpperCase())}
            placeholder={fieldPlaceholder(field)}
            className="h-[28px] flex-1 rounded-r-[2px] border border-hairline bg-canvas px-2 font-mono text-[12px] tabular-nums text-ink outline-none placeholder:text-subtle focus:border-focus"
          />
        </div>
      );

    case 'code':
      return (
        <div className="relative">
          <div className="pointer-events-none absolute left-1.5 top-1 select-none font-mono text-[10px] tracking-widest text-subtle">
            Rhai
          </div>
          <textarea
            value={strVal}
            onChange={(e) => onChange(e.target.value)}
            placeholder={fieldPlaceholder(field)}
            rows={8}
            spellCheck={false}
            className="w-full resize-y rounded-[2px] border border-hairline bg-canvas px-2 pb-2 pt-5 font-mono text-[11.5px] leading-[1.55] text-ink outline-none focus:border-focus"
            style={{ tabSize: 2 }}
          />
          <div className="mt-1 text-[11px] leading-snug text-subtle">
            {t('flow.rhaiHint')}
          </div>
          {isLegacyJsKeyScript(strVal) && (
            <div className="mt-1 border border-warn bg-canvas px-2 py-1 text-[11px] text-warn">
              {t('flow.legacyJsKey')}
            </div>
          )}
        </div>
      );

    default:
      return (
        <input
          type="text"
          value={strVal}
          onChange={(e) => onChange(e.target.value)}
          placeholder={fieldPlaceholder(field)}
          className={`${FIELD_CLASS} h-[28px]`}
        />
      );
  }
};

// ─── Terminal / Goto ──────────────────────────────────────────────────────────

/** Goto target: dropdown of all terminals by name (stored value = terminal BLOCK id). */
const GotoTargetSelect: React.FC<{ block: FlowBlock; onChange: (val: unknown) => void }> = ({ block, onChange }) => {
  const { t } = useI18n();
  const { diagram } = useFlowStore();
  const terminals = listTerminals(diagram);
  const current = gotoTargetId(block);
  const resolved = resolveGotoTarget(diagram, block) !== null;
  return (
    <div>
      <select
        value={resolved ? current : ''}
        onChange={(e) => onChange(e.target.value)}
        className={`${FIELD_CLASS} h-[28px] cursor-pointer font-mono`}
      >
        <option value="">{t('udsFlow.term.noTarget')}</option>
        {terminals.map((tb) => (
          <option key={tb.id} value={tb.id}>{terminalName(tb) || tb.id}</option>
        ))}
      </select>
      {terminals.length === 0 && <div className="mt-0.5 text-[11px] text-subtle">{t('udsFlow.term.noTerminals')}</div>}
      {current !== '' && !resolved && <div className="mt-0.5 text-[11px] text-critical">{t('udsFlow.term.missing')}</div>}
    </div>
  );
};

/** Goto blocks that jump to this terminal; click selects one. */
const TerminalReferences: React.FC<{ block: FlowBlock }> = ({ block }) => {
  const { t } = useI18n();
  const { diagram } = useFlowStore();
  const refs = terminalReferences(diagram, block.id);
  return (
    <div>
      <div className={`${DIAG_SECTION_TITLE} mb-2`}>
        {t('udsFlow.term.refs', { n: refs.length })}
      </div>
      {refs.length === 0 ? (
        <div className="text-[11px] text-subtle">{t('udsFlow.term.noRefs')}</div>
      ) : (
        <div className="flex flex-col gap-1">
          {refs.map((g) => (
            <button
              key={g.id}
              type="button"
              onClick={() => flowStore.selectBlock(g.id, false)}
              className="truncate rounded-[2px] border border-hairline bg-canvas px-2 py-1 text-left font-mono text-[11.5px] tabular-nums text-ink hover:border-strong hover:bg-hover"
            >
              {g.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

// ─── Common per-request options (all request-sending uds_* blocks) ───────────

const SMALL_LABEL = 'mb-0.5 block text-[11.5px] text-muted';

function numText(v: unknown): string {
  const n = Number(v);
  return v === undefined || v === null || v === '' || !Number.isFinite(n) || n === 0 ? '' : String(Math.trunc(n));
}

/**
 * Addressing / SPR / timeout / 0x21 busy retry of one request block. Keys absent = physical, no SPR,
 * backend timing, no retry (saved flows from before this section behave exactly as before).
 */
const RequestOptionsSection: React.FC<{ block: FlowBlock; onChange: (key: string, val: unknown) => void }> = ({ block, onChange }) => {
  const { t } = useI18n();
  const functionalId = useDiagnosticsSelector((s) => s.tabs.find((x) => x.id === s.activeTabId)?.session.config.functionalId ?? null);
  const cfg = block.config;
  const functionalOk = FUNCTIONAL_OK_BLOCKS.has(block.type);
  const functional = cfg['req_addressing'] === 'functional';
  const sprOk = SPR_BLOCKS.has(block.type);
  const fidText = functionalId === null ? null : `0x${functionalId.toString(16).toUpperCase().padStart(3, '0')}`;
  const setNum = (key: string, raw: string): void => {
    const n = parseInt(raw.replace(/[^0-9]/g, ''), 10);
    onChange(key, Number.isFinite(n) && n > 0 ? n : 0);
  };
  return (
    <div className="flex flex-col gap-2">
      <div>
        <label className={SMALL_LABEL}>{t('udsFlow.req.addressing')}</label>
        <select
          value={functional && functionalOk ? 'functional' : 'physical'}
          onChange={(e) => onChange('req_addressing', e.target.value)}
          className={`${FIELD_CLASS} h-[28px] cursor-pointer`}
        >
          <option value="physical">{t('udsFlow.req.physical')}</option>
          <option value="functional" disabled={!functionalOk || (functionalId === null && !functional)}>
            {fidText ? t('udsFlow.req.functionalId', { id: fidText }) : t('udsFlow.req.functional')}
          </option>
        </select>
        {!functionalOk && <div className="mt-0.5 text-[11px] text-subtle">{t('udsFlow.req.functionalNa')}</div>}
        {functionalOk && functionalId === null && (
          <div className={`mt-0.5 text-[11px] ${functional ? 'text-critical' : 'text-subtle'}`}>{t('udsFlow.req.noFunctionalId')}</div>
        )}
      </div>
      {sprOk ? (
        <label className="flex cursor-pointer items-center gap-2">
          <input
            type="checkbox"
            checked={cfg['req_spr'] === true}
            onChange={(e) => onChange('req_spr', e.target.checked)}
            className={DIAG_CHECKBOX}
          />
          <span className="text-[12px] text-muted">{t('udsFlow.req.spr')}</span>
        </label>
      ) : (
        <div className="text-[11px] text-subtle">{t(block.type === 'uds_tester_present' ? 'udsFlow.req.sprOwn' : 'udsFlow.req.sprNa')}</div>
      )}
      <div>
        <label className={SMALL_LABEL}>{t('udsFlow.req.timeout')}</label>
        <input
          type="text"
          inputMode="numeric"
          value={numText(cfg['req_timeout_ms'])}
          onChange={(e) => setNum('req_timeout_ms', e.target.value)}
          placeholder={t('udsFlow.req.timeoutPh')}
          className={`${FIELD_CLASS} h-[28px] font-mono tabular-nums`}
        />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className={SMALL_LABEL}>{t('udsFlow.req.busyRetry')}</label>
          <input
            type="text"
            inputMode="numeric"
            value={numText(cfg['req_busy_retry'])}
            onChange={(e) => setNum('req_busy_retry', e.target.value)}
            placeholder="0"
            disabled={functional && functionalOk}
            className={`${FIELD_CLASS} h-[28px] font-mono tabular-nums disabled:opacity-50`}
          />
        </div>
        <div>
          <label className={SMALL_LABEL}>{t('udsFlow.req.busyDelay')}</label>
          <input
            type="text"
            inputMode="numeric"
            value={numText(cfg['req_busy_delay_ms'])}
            onChange={(e) => setNum('req_busy_delay_ms', e.target.value)}
            placeholder="50"
            disabled={functional && functionalOk}
            className={`${FIELD_CLASS} h-[28px] font-mono tabular-nums disabled:opacity-50`}
          />
        </div>
      </div>
      <div className="text-[11px] leading-snug text-subtle">
        {functional && functionalOk ? t('udsFlow.req.functionalNote') : t('udsFlow.req.busyNote')}
      </div>
    </div>
  );
};

// ─── Port type badge ──────────────────────────────────────────────────────────

function portTypeTone(type: string): DiagTone {
  switch (type) {
    case 'data':  return 'focus';
    case 'bool':  return 'warn';
    case 'bytes': return 'nominal';
    default:      return 'neutral';
  }
}

// ─── Parameter binding ("Porta bağla" / "Flow girişine yükselt") ──────────────

/** Bind / unbind / promote controls of one bindable field (flow-interface-v2 §3). */
const BindControls: React.FC<{ block: FlowBlock; f: BindableField }> = ({ block, f }) => {
  const { t } = useI18n();
  const { diagram, readOnly } = useFlowStore();
  const bound = readBoundParams(block.config).includes(f.key);
  const port = boundPortId(f.key);
  const wired = diagram.connections.some((c) => c.toBlockId === block.id && c.toPortId === port);
  const [msg, setMsg] = useState<string | null>(null);
  const promote = (): void => {
    const r = flowStore.promoteParam(block.id, f.key);
    setMsg(r.ok ? null : t(r.reason === 'wired' ? 'flowIface.promote.wired' : 'flowIface.promote.unknown'));
  };
  return (
    <div className="mt-1 flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-1.5">
        {bound ? (
          <>
            <span className="font-mono text-[11px] tabular-nums text-focus">{t('flowIface.bind.bound', { port })}</span>
            <button type="button" disabled={readOnly} className={DIAG_BTN_SM} onClick={() => flowStore.unbindParam(block.id, f.key)}>
              {t('flowIface.bind.unbind')}
            </button>
          </>
        ) : (
          <button type="button" disabled={readOnly} className={DIAG_BTN_SM} title={t('flowIface.bind.toggleTip', { key: f.key })} onClick={() => flowStore.bindParam(block.id, f.key)}>
            {t('flowIface.bind.toggle')}
          </button>
        )}
        {(!bound || !wired) && (
          <button type="button" disabled={readOnly} className={DIAG_BTN_SM} title={t('flowIface.bind.promoteTip')} onClick={promote}>
            {t('flowIface.bind.promote')}
          </button>
        )}
      </div>
      {bound && !wired && <div className="text-[11px] leading-snug text-warn">{t('flowIface.bind.unwired')}</div>}
      {bound && f.kind === 'file' && <div className="text-[11px] leading-snug text-subtle">{t('flowIface.bind.file')}</div>}
      {msg !== null && <div className="text-[11px] text-critical">{msg}</div>}
    </div>
  );
};

/** Migration conflict of a `flow_out` (never silent): explained here; it clears only when the output is rewired / edited. */
const MigrateConflictBox: React.FC<{ block: FlowBlock }> = ({ block }) => {
  const conflict = block.config['migrateConflict'];
  if (typeof conflict !== 'string' || conflict === '') return null;
  return (
    <div className="border border-critical bg-canvas px-2 py-1.5" role="alert">
      <div className="text-[11.5px] leading-snug text-critical">{conflict}</div>
    </div>
  );
};

// ─── Single block inspector ───────────────────────────────────────────────────

interface BlockInspectorProps {
  block: FlowBlock;
  def: BlockDef;
}

const BlockInspector: React.FC<BlockInspectorProps> = ({ block, def }) => {
  const { t } = useI18n();
  const handleConfigChange = useCallback(
    (key: string, val: unknown) => {
      flowStore.updateBlockConfig(block.id, { [key]: val });
    },
    [block.id],
  );

  const handleDelete = useCallback(() => {
    flowStore.removeBlock(block.id);
  }, [block.id]);

  const sectionClass = 'border-b border-hairline px-3 py-2.5';
  const issues = useCoreIssues(block.id);
  const boundKeys = readBoundParams(block.config);

  return (
    <div className="flex h-full flex-col gap-0 overflow-y-auto">
      {/* Header */}
      <div className={sectionClass}>
        <div className="text-[13px] font-semibold text-ink">{block.label}</div>
        <div className="mt-0.5 font-mono text-[11.5px] text-muted">{blockLabel(def)}</div>
        <div className="mt-1 text-[12px] text-subtle">{blockDescription(def)}</div>
      </div>

      <IssueList issues={issues} titled={false} />

      {isCallType(block.type) && <CallInspector block={block} />}

      {(block.type === FLOW_IN || block.type === FLOW_OUT) && (
        <div className={sectionClass}>
          <div className={`${DIAG_SECTION_TITLE} mb-2`}>{t('flowIface.spec.title')}</div>
          <div className="flex flex-col gap-2">
            {block.type === FLOW_OUT && <MigrateConflictBox block={block} />}
            <PortSpecEditor block={block} side={block.type === FLOW_IN ? 'input' : 'output'} />
          </div>
        </div>
      )}

      {/* Config */}
      {(def.configSchema.length > 0 || bindableFields(block.type).length > 0) && (
        <div className={sectionClass}>
          <div className={`${DIAG_SECTION_TITLE} mb-2`}>{t('diagHmi.flow.configuration')}</div>
          <div className="flex flex-col gap-2">
            {block.type === 'uds_flash_image' && <FlashImagePanel blockId={block.id} config={block.config} />}
            {def.configSchema.filter((field) => field.visibleWhen === undefined || field.visibleWhen(block.config)).map((field) => {
              const bind = bindableFields(block.type).find((f) => f.key === field.key);
              const isBound = bind !== undefined && boundKeys.includes(field.key);
              return (
                <div key={field.key}>
                  <label className="mb-0.5 block text-[11.5px] text-muted">{localizedText(field)}</label>
                  {block.type === 'flow_goto' && field.key === 'target_terminal_id' ? (
                    <GotoTargetSelect block={block} onChange={(val) => handleConfigChange(field.key, val)} />
                  ) : (
                    // A bound field is read-only: its value comes from the `p:` port at run time.
                    <fieldset disabled={isBound} className={isBound ? 'opacity-60' : undefined}>
                      <ConfigFieldInput
                        field={field}
                        value={block.config[field.key]}
                        onChange={(val) => handleConfigChange(field.key, val)}
                      />
                    </fieldset>
                  )}
                  {bind !== undefined && <BindControls block={block} f={bind} />}
                </div>
              );
            })}
            {bindableFields(block.type).filter((f) => f.field === null).map((f) => (
              <div key={f.key}>
                <label className="mb-0.5 block text-[11.5px] text-muted">{bindableLabel(f)}</label>
                <BindControls block={block} f={f} />
              </div>
            ))}
            {block.type === 'io_file_input' && <FlowFilePicker blockId={block.id} />}
            {block.type === 'uds_security_access' && (
              <div className="border border-hairline bg-canvas px-2 py-1 text-[11px] leading-snug text-subtle">{t('udsFlow.secNote')}</div>
            )}
          </div>
        </div>
      )}

      {block.type === 'flow_terminal' && (
        <div className={sectionClass}>
          <TerminalReferences block={block} />
        </div>
      )}

      {REQUEST_OPTION_BLOCKS.has(block.type) && (
        <div className={sectionClass}>
          <div className={`${DIAG_SECTION_TITLE} mb-2`}>{t('udsFlow.req.title')}</div>
          <RequestOptionsSection block={block} onChange={handleConfigChange} />
        </div>
      )}

      {block.type === 'uds_flash_image' && (
        <div className={sectionClass}>
          <div className={`${DIAG_SECTION_TITLE} mb-2`}>{t('flash.run.title')}</div>
          <FlashRunPanel blockId={block.id} />
        </div>
      )}

      {/* Ports */}
      <div className={sectionClass}>
        <div className={`${DIAG_SECTION_TITLE} mb-2`}>{t('diagHmi.flow.ports')}</div>
        <div className="flex flex-col gap-1">
          {def.ports.map((port) => (
            <div key={port.id} className="flex items-center gap-2">
              <span
                className="h-2 w-2 shrink-0 rounded-full border"
                style={{
                  borderColor: portColor(port.type),
                  backgroundColor: port.direction === 'output' ? portColor(port.type) : 'transparent',
                }}
              />
              <span className="flex-1 truncate font-mono text-[11.5px] text-ink">{port.id}</span>
              <DiagBadge tone={portTypeTone(port.type)}>{port.type}</DiagBadge>
              {port.optional && <span className="font-mono text-[11px] text-subtle">{t('diagHmi.flow.optional')}</span>}
            </div>
          ))}
        </div>
      </div>

      {/* Last result */}
      {block.lastResult !== undefined && (
        <div className={sectionClass}>
          <div className={`${DIAG_SECTION_TITLE} mb-1`}>{t('diagHmi.flow.lastResult')}</div>
          <div className="break-all rounded-[2px] border border-hairline bg-canvas px-2 py-1 font-mono text-[11.5px] text-muted">
            {typeof block.lastResult === 'object'
              ? JSON.stringify(block.lastResult, null, 2)
              : String(block.lastResult)}
          </div>
        </div>
      )}

      {/* Delete */}
      <div className="mt-auto px-3 py-3">
        <button type="button" onClick={handleDelete} className={`${DIAG_BTN_DANGER} w-full`}>
          <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
          {t('diagHmi.flow.deleteBlock')}
        </button>
      </div>
    </div>
  );
};

// ─── FlowInspector ───────────────────────────────────────────────────────────

export const FlowInspector: React.FC = () => {
  const { t } = useI18n();
  const state = useFlowStore();
  const { diagram, selectedBlockIds, selectedConnectionId } = state;
  const allIssues = useCoreIssues();

  const selectedBlock =
    selectedBlockIds.length === 1
      ? diagram.blocks.find((b) => b.id === selectedBlockIds[0])
      : undefined;

  const selectedConn = selectedConnectionId
    ? diagram.connections.find((c) => c.id === selectedConnectionId)
    : undefined;

  const handleDeleteConn = useCallback(() => {
    if (selectedConnectionId) {
      flowStore.removeConnection(selectedConnectionId);
    }
  }, [selectedConnectionId]);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">

      {selectedBlock ? (
        (() => {
          const def = getBlockDefFor(selectedBlock);
          if (!def) return null;
          return <BlockInspector key={selectedBlock.id} block={selectedBlock} def={def} />;
        })()
      ) : selectedBlockIds.length > 1 ? (
        <div className="flex flex-col gap-3 p-3">
          <div className="font-mono text-[12px] font-semibold uppercase tracking-wider text-ink tabular-nums">
            {t('flowNest.sel.count', { n: selectedBlockIds.length })}
          </div>
          <div className="flex flex-col gap-0.5">
            {selectedBlockIds.map((id) => {
              const b = diagram.blocks.find((x) => x.id === id);
              return b ? <div key={id} className="truncate font-mono text-[11.5px] text-muted">{b.label}</div> : null;
            })}
          </div>
          <div className="text-[11.5px] leading-snug text-subtle">{t('flowNest.sel.hint')}</div>
          <button type="button" onClick={() => flowStore.removeBlocks(selectedBlockIds)} className={DIAG_BTN_DANGER}>
            <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
            {t('diagHmi.flow.deleteBlock')}
          </button>
        </div>
      ) : selectedConn ? (
        <div className="flex flex-col gap-3 p-3">
          <div>
            <div className={`${DIAG_SECTION_TITLE} mb-2`}>{t('diagHmi.flow.connection')}</div>
            <div className="font-mono text-[11.5px] text-muted">
              <div>{t('diagHmi.flow.source')}: <span className="text-ink">{selectedConn.fromBlockId}</span></div>
              <div>{t('diagHmi.flow.port')}: <span className="text-ink">{selectedConn.fromPortId}</span></div>
              <div className="mt-1">{t('diagHmi.flow.target')}: <span className="text-ink">{selectedConn.toBlockId}</span></div>
              <div>{t('diagHmi.flow.port')}: <span className="text-ink">{selectedConn.toPortId}</span></div>
            </div>
          </div>
          <button type="button" onClick={handleDeleteConn} className={DIAG_BTN_DANGER}>
            <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
            {t('diagHmi.flow.deleteConnection')}
          </button>
        </div>
      ) : (
        <div className="flex flex-1 flex-col overflow-y-auto">
          <VariablesPanel />
          <IssueList issues={allIssues} />
          {state.migrationNotes.length > 0 && (
            <div className="border-b border-hairline px-3 py-2.5">
              <div className={`${DIAG_SECTION_TITLE} mb-1.5`}>{t('flowCore.vars.migration')}</div>
              <div className="flex flex-col gap-1">
                {state.migrationNotes.map((n, i) => (
                  <div key={i} className="text-[11.5px] leading-snug text-muted">{n}</div>
                ))}
              </div>
            </div>
          )}
          <div className="flex flex-col items-center gap-2 px-4 py-6 text-center">
            <Settings2 className="h-5 w-5 text-subtle" aria-hidden="true" />
            <div className="font-mono text-[12px] font-semibold uppercase tracking-wider text-muted">
              {t('diagHmi.flow.selectHint')}
            </div>
            <div className="text-[12px] text-subtle">{t('diagHmi.flow.multiHint')}</div>
          </div>
        </div>
      )}
    </div>
  );
};
