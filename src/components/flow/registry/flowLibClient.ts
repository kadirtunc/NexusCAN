/** Flow library client seam: the real implementation wraps the IPC / bridge commands; tests inject a fake. */
import type { FlowLibEntryDto, FlowLibRevisionDto } from '../../../types/flowLibrary';
import {
  apiFlowLibDelete,
  apiFlowLibList,
  apiFlowLibLoad,
  apiFlowLibRevisions,
  apiFlowLibSave,
} from '../../../services/ipcClient';

export interface FlowLibClient {
  list(includeDeleted: boolean): Promise<FlowLibEntryDto[]>;
  revisions(id: string): Promise<FlowLibRevisionDto[]>;
  load(id: string, revision: number | null): Promise<string>;
  save(fileJson: string): Promise<FlowLibEntryDto>;
  delete(id: string): Promise<void>;
}

export const ipcFlowLibClient: FlowLibClient = {
  list: apiFlowLibList,
  revisions: apiFlowLibRevisions,
  load: apiFlowLibLoad,
  save: apiFlowLibSave,
  delete: apiFlowLibDelete,
};
