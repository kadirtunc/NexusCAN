import React, { useCallback } from 'react';
import { Settings2, Trash2 } from 'lucide-react';
import type { FlowBlock, BlockDef, ConfigField } from './types';
import { useFlowStore, flowStore } from './FlowStore';
import { getBlockDef } from './blockDefs';
import { portColor } from './BlockNode';
import { blockDescription, blockLabel, fieldPlaceholder, localizedText } from './blockText';
import { useI18n } from '../../../i18n';
import { flowFiles, useFlowFilesVersion } from './flowFiles';
import { DIAG_BTN_SM } from '../diagUi';
import {
  DIAG_BTN_DANGER,
  DIAG_CHECKBOX,
  DIAG_SECTION_TITLE,
  DiagBadge,
  type DiagTone,
} from '../diagUi';

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

const ConfigFieldInput: React.FC<FieldProps> = ({ field, value, onChange }) => {
  const { t } = useI18n();
  const strVal = value !== undefined && value !== null ? String(value) : '';

  switch (field.type) {
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
            JS
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

// ─── Port type badge ──────────────────────────────────────────────────────────

function portTypeTone(type: string): DiagTone {
  switch (type) {
    case 'data':  return 'focus';
    case 'bool':  return 'warn';
    case 'bytes': return 'nominal';
    default:      return 'neutral';
  }
}

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

  return (
    <div className="flex h-full flex-col gap-0 overflow-y-auto">
      {/* Header */}
      <div className={sectionClass}>
        <div className="text-[13px] font-semibold text-ink">{block.label}</div>
        <div className="mt-0.5 font-mono text-[11.5px] text-muted">{blockLabel(def)}</div>
        <div className="mt-1 text-[12px] text-subtle">{blockDescription(def)}</div>
      </div>

      {/* Config */}
      {def.configSchema.length > 0 && (
        <div className={sectionClass}>
          <div className={`${DIAG_SECTION_TITLE} mb-2`}>{t('diagHmi.flow.configuration')}</div>
          <div className="flex flex-col gap-2">
            {def.configSchema.map((field) => (
              <div key={field.key}>
                <label className="mb-0.5 block text-[11.5px] text-muted">{localizedText(field)}</label>
                <ConfigFieldInput
                  field={field}
                  value={block.config[field.key]}
                  onChange={(val) => handleConfigChange(field.key, val)}
                />
              </div>
            ))}
            {block.type === 'io_file_input' && <FlowFilePicker blockId={block.id} />}
          </div>
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
    <div className="flex w-[260px] shrink-0 flex-col overflow-hidden border-l border-hairline bg-surface">
      {/* Inspector header */}
      <div className="flex h-10 shrink-0 items-center border-b border-hairline bg-elevated px-3">
        <span className="font-mono text-xs font-semibold uppercase tracking-wider text-ink">
          {t('diagHmi.flow.properties')}
        </span>
      </div>

      {selectedBlock ? (
        (() => {
          const def = getBlockDef(selectedBlock.type);
          if (!def) return null;
          return <BlockInspector block={selectedBlock} def={def} />;
        })()
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
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-4 text-center">
          <Settings2 className="h-5 w-5 text-subtle" aria-hidden="true" />
          <div className="font-mono text-[12px] font-semibold uppercase tracking-wider text-muted">
            {t('diagHmi.flow.selectHint')}
          </div>
          <div className="text-[12px] text-subtle">{t('diagHmi.flow.multiHint')}</div>
        </div>
      )}
    </div>
  );
};
