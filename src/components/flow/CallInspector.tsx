/** Inspector section of a call block: pinned callee, newer revision, enter / edit / update actions, label. */
import React, { useEffect, useState, useSyncExternalStore } from 'react';
import { useI18n } from '../../i18n';
import { DIAG_BTN_SM, DIAG_SECTION_TITLE, DiagBadge } from '../diagnostics/diagUi';
import { callIndex, readCallRef } from './callIndex';
import { flowStore } from './FlowStore';
import type { FlowBlock } from './types';
import { flowRegistry } from './registry/flowRegistryStore';

export const CallInspector: React.FC<{ block: FlowBlock }> = ({ block }) => {
  const { t } = useI18n();
  useSyncExternalStore(callIndex.subscribe, callIndex.getVersion, callIndex.getVersion);
  const ref = readCallRef(block);
  const info = ref ? callIndex.get(ref) : undefined;
  const latest = ref ? callIndex.latestOf(ref.flowId) : undefined;
  const outdated = ref !== null && latest !== undefined && latest > ref.revision;
  const [label, setLabel] = useState(block.label);
  useEffect(() => setLabel(block.label), [block.label]);
  return (
    <div className="border-b border-hairline px-3 py-2.5">
      <div className={`${DIAG_SECTION_TITLE} mb-2`}>{t('flowNest.callee')}</div>
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink">{info?.name ?? ref?.flowId ?? '—'}</span>
          {ref && <span className="shrink-0 font-mono text-[11.5px] tabular-nums text-muted">r{ref.revision}</span>}
          {info && <DiagBadge tone={info.kind === 'nexuscan.block' ? 'warn' : 'neutral'}>{t(info.kind === 'nexuscan.block' ? 'flowReg.customBlock' : 'flowNest.flow')}</DiagBadge>}
        </div>
        {!info && <div className="border border-critical bg-canvas px-2 py-1 text-[11.5px] leading-snug text-critical">{t('flowNest.unresolved')}</div>}
        {outdated && ref && (
          <div className="flex items-center gap-2 border border-warn bg-canvas px-2 py-1">
            <span className="flex-1 font-mono text-[11.5px] tabular-nums text-warn">r{ref.revision} → r{latest}</span>
            <button type="button" className={DIAG_BTN_SM} onClick={() => void flowRegistry.repin(block.id)}>{t('flowNest.update')}</button>
          </div>
        )}
        <div>
          <label className="mb-0.5 block text-[11.5px] text-muted">{t('flowNest.blockLabel')}</label>
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            onBlur={() => label.trim() !== '' && label !== block.label && flowStore.updateBlockLabel(block.id, label.trim())}
            onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
            className="h-[28px] w-full rounded-[2px] border border-hairline bg-canvas px-2 text-[12px] text-ink outline-none focus:border-focus"
          />
        </div>
        <div className="flex flex-wrap gap-1.5">
          <button type="button" className={DIAG_BTN_SM} disabled={!ref} onClick={() => void flowRegistry.enterCall(block.id)}>{t('flowNest.enter')}</button>
          <button type="button" className={DIAG_BTN_SM} disabled={!ref} onClick={() => ref && void flowRegistry.editLatest(ref.flowId)}>{t('flowNest.editLatest')}</button>
        </div>
      </div>
    </div>
  );
};
