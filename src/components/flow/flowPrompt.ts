/** Real user-input dialog for the `io_user_prompt` block (no `window.prompt`: unavailable in some webviews). */
import { useSyncExternalStore } from 'react';

export interface FlowPromptState {
  message: string;
  resolve: (value: string | null) => void;
}

let current: FlowPromptState | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

export const flowPrompt = {
  /** Resolves with the entered text, or `null` when cancelled / the run was stopped. */
  request(message: string): Promise<string | null> {
    flowPrompt.cancel();
    return new Promise<string | null>((resolve) => {
      current = { message, resolve };
      emit();
    });
  },
  answer(value: string | null): void {
    const c = current;
    current = null;
    emit();
    c?.resolve(value);
  },
  cancel(): void {
    flowPrompt.answer(null);
  },
  subscribe(l: () => void): () => void {
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  },
  getSnapshot(): FlowPromptState | null {
    return current;
  },
};

export function useFlowPrompt(): FlowPromptState | null {
  return useSyncExternalStore(flowPrompt.subscribe, flowPrompt.getSnapshot, flowPrompt.getSnapshot);
}
