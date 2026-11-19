/** Real files chosen by the user for `io_file_input` blocks (kept in memory, never persisted with the diagram). */
import { useSyncExternalStore } from 'react';

import type { FlowFileValue } from '../../types/flowLibrary';

export type FlowFile = FlowFileValue;

const files = new Map<string, FlowFile>();
const listeners = new Set<() => void>();
let version = 0;

export const flowFiles = {
  get(blockId: string): FlowFile | undefined {
    return files.get(blockId);
  },
  async set(blockId: string, file: File): Promise<void> {
    const bytes = new Uint8Array(await file.arrayBuffer());
    files.set(blockId, { name: file.name, bytes });
    version += 1;
    for (const l of listeners) l();
  },
  clear(blockId: string): void {
    if (files.delete(blockId)) {
      version += 1;
      for (const l of listeners) l();
    }
  },
  subscribe(l: () => void): () => void {
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  },
  getVersion(): number {
    return version;
  },
};

/** Re-renders when any registered file changes. */
export function useFlowFilesVersion(): number {
  return useSyncExternalStore(flowFiles.subscribe, flowFiles.getVersion, flowFiles.getVersion);
}
