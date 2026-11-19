import React, { useEffect, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import type { FlowVariableType } from '../../types/flowLibrary';
import { useI18n } from '../../i18n';
import { flowStore, useFlowStore } from './FlowStore';
import { validateCore } from './coreValidate';
import { validateEcuRefs, validateInterface, type FlowIssue } from './flowInterface';
import { canUseVariableName, variableReferences } from './flowVars';
import { DIAG_BTN_SM, DIAG_SECTION_TITLE } from '../diagnostics/diagUi';

const FIELD =
  'h-[26px] w-full rounded-[2px] border border-hairline bg-canvas px-1.5 font-mono text-[12px] tabular-nums text-ink outline-none placeholder:text-subtle focus:border-focus';

const VAR_TYPES: FlowVariableType[] = ['number', 'text', 'bool', 'bytes'];

/** Name editor: free typing, commits on blur / Enter only when valid and unique (a rename updates every reference). */
const VarNameInput: React.FC<{ name: string }> = ({ name }) => {
  const { t } = useI18n();
  const { diagram } = useFlowStore();
  const [text, setText] = useState(name);
  useEffect(() => setText(name), [name]);
  const decls = diagram.variables ?? [];
  const valid = text === name || canUseVariableName(decls, name, text);
  const commit = (): void => {
    if (text !== name && valid) flowStore.updateVariable(name, { name: text });
    else setText(name);
  };
  return (
    <div>
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
        }}
        spellCheck={false}
        aria-label={t('flowCore.vars.name')}
        className={`${FIELD} ${valid ? '' : '!border-critical'}`}
      />
      {!valid && <div className="mt-0.5 text-[11px] text-critical">{t('flowCore.vars.badName')}</div>}
    </div>
  );
};

const TYPE_LABEL = {
  number: 'flowCore.vars.tNumber',
  text: 'flowCore.vars.tText',
  bool: 'flowCore.vars.tBool',
  bytes: 'flowCore.vars.tBytes',
} as const;

/** Variable declarations of the flow (name, type, initial); reset to the typed initial at every run start. */
export const VariablesPanel: React.FC = () => {
  const { t } = useI18n();
  const { diagram } = useFlowStore();
  const decls = diagram.variables ?? [];
  return (
    <div className="border-b border-hairline px-3 py-2.5">
      <div className="mb-2 flex items-center">
        <span className={DIAG_SECTION_TITLE}>{t('flowCore.vars.title')}</span>
        <span className="ml-auto" />
        <button type="button" onClick={() => flowStore.addVariable()} className={DIAG_BTN_SM}>
          <Plus className="h-3 w-3" aria-hidden="true" />
          {t('flowCore.vars.add')}
        </button>
      </div>
      {decls.length === 0 ? (
        <div className="text-[11.5px] leading-snug text-subtle">{t('flowCore.vars.none')}</div>
      ) : (
        <div className="flex flex-col gap-2">
          {decls.map((d) => {
            const refs = variableReferences(diagram, d.name).length;
            return (
              <div key={d.name} className="flex flex-col gap-1 border border-hairline bg-canvas p-1.5">
                <VarNameInput name={d.name} />
                <div className="flex items-center gap-1">
                  <select
                    value={d.type}
                    onChange={(e) => flowStore.updateVariable(d.name, { type: e.target.value as FlowVariableType })}
                    aria-label={t('flowCore.vars.type')}
                    className={`${FIELD} w-[96px] shrink-0 cursor-pointer`}
                  >
                    {VAR_TYPES.map((ty) => (
                      <option key={ty} value={ty}>{t(TYPE_LABEL[ty])}</option>
                    ))}
                  </select>
                  {d.type === 'bool' ? (
                    <select
                      value={d.initial === 'true' ? 'true' : 'false'}
                      onChange={(e) => flowStore.updateVariable(d.name, { initial: e.target.value })}
                      aria-label={t('flowCore.vars.initial')}
                      className={`${FIELD} cursor-pointer`}
                    >
                      <option value="false">false</option>
                      <option value="true">true</option>
                    </select>
                  ) : (
                    <input
                      value={d.initial}
                      onChange={(e) => flowStore.updateVariable(d.name, { initial: e.target.value })}
                      spellCheck={false}
                      aria-label={t('flowCore.vars.initial')}
                      className={FIELD}
                    />
                  )}
                  <button
                    type="button"
                    onClick={() => flowStore.removeVariable(d.name)}
                    title={t('flowCore.vars.delete')}
                    aria-label={t('flowCore.vars.delete')}
                    className={`${DIAG_BTN_SM} hover:!border-critical hover:!text-critical`}
                  >
                    <Trash2 className="h-3 w-3" aria-hidden="true" />
                  </button>
                </div>
                <div className="font-mono text-[11px] tabular-nums text-subtle">{t('flowCore.vars.refs', { n: refs })}</div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

/** Core-pack and flow-interface validation errors (all blocks, or the ones of `blockId`). */
export function useCoreIssues(blockId?: string): FlowIssue[] {
  const { diagram } = useFlowStore();
  const all: FlowIssue[] = [...validateCore(diagram), ...validateInterface(diagram), ...validateEcuRefs(diagram)];
  return blockId === undefined ? all : all.filter((i) => i.blockId === blockId);
}

export const IssueList: React.FC<{ issues: FlowIssue[]; titled?: boolean }> = ({ issues, titled = true }) => {
  const { t } = useI18n();
  if (issues.length === 0) return null;
  return (
    <div className="border-b border-hairline px-3 py-2.5">
      {titled && <div className={`${DIAG_SECTION_TITLE} mb-1.5 !text-critical`}>{t('flowCore.vars.issues', { n: issues.length })}</div>}
      <div className="flex flex-col gap-1">
        {issues.map((i, idx) => (
          <button
            key={`${i.blockId}:${i.code}:${idx}`}
            type="button"
            onClick={() => i.blockId !== '' && flowStore.selectBlock(i.blockId, false)}
            className="border border-critical bg-canvas px-2 py-1 text-left text-[11.5px] leading-snug text-critical hover:bg-hover"
          >
            {i.message}
          </button>
        ))}
      </div>
    </div>
  );
};
