/**
 * Operator prompt host (`io_user_prompt`): mounted ONCE at the app shell (`App.tsx`) so a prompt raised by any
 * engine run (Flow Editor Test Run, Diagnostics Workbench) is visible in every tab. Answer / Cancel resolve
 * `flowPrompt`; Stop / Panic Stop cancel it through the engine's existing path.
 */
import React, { useEffect, useState } from 'react';
import { useI18n } from '../../i18n';
import { DIAG_BTN, DIAG_BTN_PRIMARY } from '../diagnostics/diagUi';
import { flowPrompt, useFlowPrompt } from './flowPrompt';
import { ModalShell } from './ModalShell';

export const FlowPromptHost: React.FC = () => {
  const { t } = useI18n();
  const prompt = useFlowPrompt();
  const [text, setText] = useState('');
  useEffect(() => {
    if (prompt) setText('');
  }, [prompt]);
  if (!prompt) return null;
  return (
    <ModalShell title={prompt.message} onClose={() => flowPrompt.cancel()} width={420}>
      <form
        className="flex flex-col gap-3 p-3.5"
        onSubmit={(e) => {
          e.preventDefault();
          flowPrompt.answer(text);
        }}
      >
        <input
          autoFocus
          type="text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          className="w-full rounded-[2px] border border-hairline bg-canvas px-2 py-1.5 font-mono text-[12px] tabular-nums text-ink outline-none focus:border-focus"
        />
        <div className="flex justify-end gap-2">
          <button type="button" onClick={() => flowPrompt.cancel()} className={DIAG_BTN}>
            {t('diagReal.flow.promptCancel')}
          </button>
          <button type="submit" className={DIAG_BTN_PRIMARY}>
            {t('diagReal.flow.promptOk')}
          </button>
        </div>
      </form>
    </ModalShell>
  );
};
