export interface DbcEditorWorkbenchProps {
  /** `ProjectDatabaseEntry.id` from `databaseStore`. */
  databaseId: string;
  /** Return to the DBC Studio list. */
  onClose: () => void;
}

export { DbcEditorWorkbench } from './DbcEditorWorkbench';
