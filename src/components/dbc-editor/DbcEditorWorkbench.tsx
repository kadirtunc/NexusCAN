'use client';

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  AlertCircle,
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  Cpu,
  FileCode2,
  FolderInput,
  Save,
  SaveAll,
  Settings,
  X,
} from 'lucide-react';
import { useI18n } from '../../i18n';
import {
  createStarterDbcSchema,
  formatCanMessageKey,
  sanitizeDbcIdentifier,
  serializeDatabaseSchemaToDbc,
  type BitOverlapDiagnosticDto,
  type DatabaseSchemaDto,
  type EcuNodeDto,
  type MessageSchemaDto,
  type ParseDiagnosticDto,
  type ReusableValueTableDto,
  type SignalSchemaDto,
} from './contracts';
import {
  loadEditorDatabase,
  saveDatabaseAs,
  saveDatabaseOverwrite,
  validateDbcText,
} from './host';
import { tShard } from './i18n/core';
import {
  dbcStudioShard,
  useDbcStudioI18n,
} from './i18n/dbcStudio';
import { CandbListView } from './CandbListView';
import { CandbMessageDialog } from './CandbMessageDialog';
import { CandbModalShell } from './CandbModalShell';
import { CandbSignalDialog } from './CandbSignalDialog';
import {
  CandbEcuDialog,
  CandbNetworkDialog,
  CandbValueTableDialog,
} from './CandbSupportDialogs';
import {
  CandbCommMatrixModal,
  CandbConsistencyModal,
  CandbDbcSourceModal,
} from './CandbToolModals';
import { CandbTreeSidebar } from './CandbTreeSidebar';
import { areMuxExclusive } from './muxView';
import {
  createDefaultSignal,
  findNextFreeArbId,
  mergeWasmBitLayoutIntoSchema,
  normalizeSchemaInvariants,
  type CandbFolderKind,
  type CandbModalState,
  type CandbSelectedRow,
  type CandbViewTarget,
  type MessageDialogTab,
} from './dbcEditorUtils';
import type { DbcEditorWorkbenchProps } from './index';

interface StagedNewMessageState {
  message: MessageSchemaDto;
  signals: SignalSchemaDto[];
}

interface StagedNewEcuState {
  ecu: EcuNodeDto;
  txMessageKeys: string[];
  rxSignalIds: number[];
  returnModalState: CandbModalState;
}

interface EditorToast {
  kind: 'success' | 'error' | 'info';
  message: string;
}

type LocalKey =
  | 'saveAs'
  | 'saveAsTooltip'
  | 'saveAsTitle'
  | 'saveAsFileLabel'
  | 'saveAsHint'
  | 'saveAsConfirm'
  | 'saved'
  | 'savedAs'
  | 'saveFailed'
  | 'kcdNotice'
  | 'exitTitle'
  | 'exitBody'
  | 'exitDiscard'
  | 'exitStay'
  | 'validatorUnreachable';

const LOCAL_STRINGS: Record<'tr' | 'en', Record<LocalKey, string>> = {
  tr: {
    saveAs: 'Farklı Kaydet…',
    saveAsTooltip: 'Yeni bir .dbc dosyası olarak kaydet',
    saveAsTitle: 'Farklı Kaydet',
    saveAsFileLabel: 'Dosya adı (.dbc)',
    saveAsHint: 'Aynı adlı başka bir veritabanının üzerine yazılmaz.',
    saveAsConfirm: 'Kaydet',
    saved: '{name} kaydedildi.',
    savedAs: '{name} yeni veritabanı olarak kaydedildi.',
    saveFailed: 'Kaydedilemedi: {error}',
    kcdNotice: '.kcd kaynağı DBC olarak yeni dosyaya kaydedilir.',
    exitTitle: 'Kaydedilmemiş değişiklikler',
    exitBody: 'Kaydedilmemiş değişiklikler var. Yine de çıkılsın mı?',
    exitDiscard: 'Değişiklikleri at',
    exitStay: 'Düzenlemeye dön',
    validatorUnreachable: 'Doğrulayıcıya ulaşılamadı.',
  },
  en: {
    saveAs: 'Save As…',
    saveAsTooltip: 'Save as a new .dbc file',
    saveAsTitle: 'Save As',
    saveAsFileLabel: 'File name (.dbc)',
    saveAsHint: 'An existing database with the same name is never overwritten.',
    saveAsConfirm: 'Save',
    saved: '{name} saved.',
    savedAs: '{name} saved as a new database.',
    saveFailed: 'Save failed: {error}',
    kcdNotice: 'A .kcd source is saved as a new DBC file.',
    exitTitle: 'Unsaved changes',
    exitBody: 'There are unsaved changes. Leave anyway?',
    exitDiscard: 'Discard changes',
    exitStay: 'Keep editing',
    validatorUnreachable: 'Validator unreachable.',
  },
};

function fillParams(
  template: string,
  params: Record<string, string>,
): string {
  return template.replace(/\{(\w+)\}/g, (_m, key: string) => params[key] ?? '');
}

interface DraftValidation {
  valid: boolean;
  dbcText: string;
  compiledSchema: DatabaseSchemaDto | null;
  diagnostics: ParseDiagnosticDto[];
  bitOverlaps: BitOverlapDiagnosticDto[];
  compileError: string | null;
}

/** Derives bit overlaps from the authoritative Rust bit layout (several signals on one bit cell). */
function deriveBitOverlaps(schema: DatabaseSchemaDto): BitOverlapDiagnosticDto[] {
  const nameById = new Map(schema.signals.map((s) => [s.signalId, s.name]));
  const sigById: ReadonlyMap<number, SignalSchemaDto> = new Map(
    schema.signals.map((s) => [s.signalId, s]),
  );
  const out: BitOverlapDiagnosticDto[] = [];
  for (const msg of schema.messages) {
    const cellSignals = new Map<string, { byte: number; bit: number; ids: Set<number> }>();
    for (const cell of msg.bitLayout) {
      const key = `${cell.byteIndex}:${cell.bitInByte}`;
      const hit = cellSignals.get(key);
      if (hit) hit.ids.add(cell.signalId);
      else
        cellSignals.set(key, {
          byte: cell.byteIndex,
          bit: cell.bitInByte,
          ids: new Set([cell.signalId]),
        });
    }
    for (const { byte, bit, ids } of cellSignals.values()) {
      if (ids.size < 2) continue;
      // Mux-aware: only signals with at least one non-exclusive partner collide.
      const idList = [...ids];
      const colliding = idList.filter((id) => {
        const a = sigById.get(id);
        return idList.some((other) => {
          if (other === id) return false;
          const b = sigById.get(other);
          return !a || !b || !areMuxExclusive(a, b, sigById);
        });
      });
      if (colliding.length < 2) continue;
      const names = colliding.map((id) => nameById.get(id) ?? `#${id}`);
      out.push({
        messageKey: msg.messageKey,
        messageName: msg.name,
        byteIndex: byte,
        bitInByte: bit,
        signalNames: names,
        description: `${msg.name} byte ${byte} bit ${bit}: ${names.join(', ')}`,
      });
    }
  }
  return out;
}

function toDraftValidation(
  res: Awaited<ReturnType<typeof validateDbcText>>,
  dbcText: string,
): DraftValidation {
  if (!res.ok) {
    return {
      valid: false,
      dbcText,
      compiledSchema: null,
      diagnostics: [],
      bitOverlaps: [],
      compileError: res.error,
    };
  }
  const diagnostics = res.schema.info.diagnostics;
  return {
    valid: !diagnostics.some((d) => d.severity === 'error'),
    dbcText,
    compiledSchema: res.schema,
    diagnostics,
    bitOverlaps: deriveBitOverlaps(res.schema),
    compileError: null,
  };
}

async function validateDraft(
  fileName: string,
  schema: DatabaseSchemaDto,
  valueTables: readonly ReusableValueTableDto[],
  networkComment: string | null,
): Promise<DraftValidation> {
  const dbcText = serializeDatabaseSchemaToDbc(schema, {
    valueTables,
    networkComment,
  });
  return toDraftValidation(await validateDbcText(fileName, dbcText), dbcText);
}

export function DbcEditorWorkbench({
  databaseId,
  onClose,
}: DbcEditorWorkbenchProps): React.JSX.Element {
  const { t } = useDbcStudioI18n();
  const { locale } = useI18n();
  const ls = useCallback(
    (key: LocalKey, params: Record<string, string> = {}): string =>
      fillParams(LOCAL_STRINGS[locale === 'en' ? 'en' : 'tr'][key], params),
    [locale],
  );
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Role is always editor on desktop (no multi-user roles).
  const canMutate = true;

  // Target database / metadata state
  const [resolvedDatabaseId, setResolvedDatabaseId] = useState<string>(databaseId);
  const [sourceFormat, setSourceFormat] = useState<'dbc' | 'kcd'>('dbc');
  const [sourceFileName, setSourceFileName] = useState<string>('');
  const [databaseName, setDatabaseName] = useState<string>('New_Vehicle_CAN');
  const busAssignment = '';

  // Core DBC Studio Draft State
  const [draftSchema, setDraftSchema] = useState<DatabaseSchemaDto>(() =>
    createStarterDbcSchema('New_Vehicle_CAN')
  );
  const [valueTables, setValueTables] = useState<ReusableValueTableDto[]>([
    {
      name: 'VT_SystemState',
      entries: {
        '0': 'INIT',
        '1': 'STANDBY',
        '2': 'ACTIVE',
        '3': 'FAULT',
      },
    },
  ]);
  const [networkComment, setNetworkComment] = useState<string>('');
  const [isDirty, setIsDirty] = useState<boolean>(false);

  // DBC Studio 2-Pane Navigation & Modal State
  const [treeWidthPx, setTreeWidthPx] = useState<number>(264);
  const [viewTarget, setViewTarget] = useState<CandbViewTarget>({
    kind: 'folder',
    folder: 'messages',
  });
  const [selectedRow, setSelectedRow] = useState<CandbSelectedRow | null>(
    () => {
      const starter = createStarterDbcSchema('New_Vehicle_CAN');
      const firstMsg = starter.messages[0];
      return firstMsg
        ? { kind: 'message', messageKey: firstMsg.messageKey }
        : null;
    }
  );
  const [modalState, setModalState] = useState<CandbModalState>({
    kind: 'none',
  });

  // Staged creation drafts (zero mutation to draftSchema / valueTables on Cancel / Esc)
  const [stagedNewMessage, setStagedNewMessage] =
    useState<StagedNewMessageState | null>(null);
  const [stagedMsgWasm, setStagedMsgWasm] = useState<{
    compiledSchema: DatabaseSchemaDto | null;
    bitOverlaps: BitOverlapDiagnosticDto[];
  }>({ compiledSchema: null, bitOverlaps: [] });
  const [stagedNewSignal, setStagedNewSignal] =
    useState<SignalSchemaDto | null>(null);
  const [stagedNewEcu, setStagedNewEcu] = useState<StagedNewEcuState | null>(
    null
  );
  const [stagedNewValueTable, setStagedNewValueTable] =
    useState<ReusableValueTableDto | null>(null);

  // Loading & WASM Validation State
  const [loadingInitial, setLoadingInitial] = useState<boolean>(true);
  const [loadErrorDbId, setLoadErrorDbId] = useState<string | null>(null);
  const [isValidatingWasm, setIsValidatingWasm] = useState<boolean>(false);
  const [wasmValid, setWasmValid] = useState<boolean>(true);
  const [compiledSchema, setCompiledSchema] =
    useState<DatabaseSchemaDto | null>(null);
  const [wasmDbcText, setWasmDbcText] = useState<string>('');
  const [wasmDiagnostics, setWasmDiagnostics] = useState<ParseDiagnosticDto[]>(
    []
  );
  const [bitOverlaps, setBitOverlaps] = useState<BitOverlapDiagnosticDto[]>([]);
  const [compileError, setCompileError] = useState<string | null>(null);

  // Save & Import State
  const [savingVersion, setSavingVersion] = useState<boolean>(false);
  const [saveAsName, setSaveAsName] = useState<string>('');
  const [exitPromptOpen, setExitPromptOpen] = useState<boolean>(false);
  const [importingFile, setImportingFile] = useState<boolean>(false);
  const [toast, setToast] = useState<EditorToast | null>(null);

  const validateSeqRef = useRef<number>(0);
  const stagedValidateSeqRef = useRef<number>(0);
  const dragStateRef = useRef<{ startX: number; startWidth: number } | null>(
    null
  );

  // Load the catalog database (schema from databaseStore / Rust parser)
  useEffect(() => {
    let cancelled = false;
    setLoadingInitial(true);
    setLoadErrorDbId(null);
    loadEditorDatabase(databaseId)
      .then((src) => {
        if (cancelled) return;
        const norm = normalizeSchemaInvariants(src.schema);
        setResolvedDatabaseId(src.databaseId);
        setSourceFormat(src.format);
        setSourceFileName(src.fileName);
        setDatabaseName(src.name);
        setDraftSchema(norm);
        setCompiledSchema(src.schema);
        setValueTables([]);
        setNetworkComment('');
        setIsDirty(false);
        const firstMsg = norm.messages[0];
        setViewTarget({ kind: 'folder', folder: 'messages' });
        setSelectedRow(
          firstMsg ? { kind: 'message', messageKey: firstMsg.messageKey } : null
        );
        setLoadingInitial(false);
      })
      .catch(() => {
        if (cancelled) return;
        setLoadErrorDbId(databaseId);
        setLoadingInitial(false);
      });
    return () => {
      cancelled = true;
    };
  }, [databaseId]);

  // Keep draftSchema.info.name synced with databaseName
  useEffect(() => {
    const clean = sanitizeDbcIdentifier(databaseName, 'New_Vehicle_CAN');
    setDraftSchema((prev) => {
      if (prev.info.name === clean) return prev;
      return {
        ...prev,
        info: {
          ...prev.info,
          name: clean,
        },
      };
    });
  }, [databaseName]);

  // Live 220ms Debounced `nexus-netdb` WASM Compiler Synchronization
  useEffect(() => {
    if (loadingInitial) return;

    const seq = validateSeqRef.current + 1;
    validateSeqRef.current = seq;
    setIsValidatingWasm(true);

    const timer = window.setTimeout(() => {
      void validateDraft(
        `${sanitizeDbcIdentifier(databaseName, 'Network')}.dbc`,
        draftSchema,
        valueTables,
        networkComment || null
      )
        .then((res) => {
          if (validateSeqRef.current !== seq) return;
          setWasmValid(res.valid);
          setWasmDbcText(res.dbcText);
          setCompiledSchema(res.compiledSchema);
          setWasmDiagnostics(res.diagnostics);
          setBitOverlaps(res.bitOverlaps);
          setCompileError(res.compileError);
        })
        .catch((err: unknown) => {
          if (validateSeqRef.current !== seq) return;
          setCompileError(
            err instanceof Error
              ? err.message
              : ls('validatorUnreachable')
          );
        })
        .finally(() => {
          if (validateSeqRef.current === seq) {
            setIsValidatingWasm(false);
          }
        });
    }, 220);

    return () => {
      window.clearTimeout(timer);
    };
  }, [
    databaseName,
    draftSchema,
    loadingInitial,
    ls,
    networkComment,
    valueTables,
  ]);

  // Merge authoritative WASM `bitLayout` onto `draftSchema`
  const effectiveSchema = useMemo(
    () => mergeWasmBitLayoutIntoSchema(draftSchema, compiledSchema),
    [compiledSchema, draftSchema]
  );

  // Stateless WASM bit-layout validation for `stagedNewMessage` while `createMessage` modal is open
  useEffect(() => {
    if (
      !stagedNewMessage ||
      stagedNewMessage.signals.length === 0 ||
      loadingInitial
    ) {
      setStagedMsgWasm({ compiledSchema: null, bitOverlaps: [] });
      return;
    }

    const seq = stagedValidateSeqRef.current + 1;
    stagedValidateSeqRef.current = seq;

    const timer = window.setTimeout(() => {
      const previewSchema = normalizeSchemaInvariants({
        ...draftSchema,
        messages: [...draftSchema.messages, stagedNewMessage.message],
        signals: [...draftSchema.signals, ...stagedNewMessage.signals],
      });

      void validateDraft(
        `${sanitizeDbcIdentifier(databaseName, 'Network')}.dbc`,
        previewSchema,
        valueTables,
        networkComment || null
      )
        .then((res) => {
          if (stagedValidateSeqRef.current !== seq) return;
          setStagedMsgWasm({
            compiledSchema: res.compiledSchema,
            bitOverlaps: res.bitOverlaps,
          });
        })
        .catch(() => undefined);
    }, 180);

    return () => {
      window.clearTimeout(timer);
    };
  }, [
    databaseName,
    draftSchema,
    loadingInitial,
    networkComment,
    stagedNewMessage,
    valueTables,
  ]);

  // Live canonical `.dbc` preview
  const liveCanonicalDbcText = useMemo(() => {
    const localSerialized = serializeDatabaseSchemaToDbc(effectiveSchema, {
      valueTables,
      networkComment: networkComment || null,
    });
    return localSerialized || wasmDbcText;
  }, [effectiveSchema, networkComment, valueTables, wasmDbcText]);

  // Mutation helper that normalizes invariants and marks dirty
  const commitDraftMutation = useCallback(
    (updater: (prev: DatabaseSchemaDto) => DatabaseSchemaDto) => {
      setDraftSchema((prev) => normalizeSchemaInvariants(updater(prev)));
      setIsDirty(true);
    },
    []
  );

  // --- Resizable Left Sidebar Drag Handler ---
  const handleStartTreeResize = (e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    dragStateRef.current = { startX: e.clientX, startWidth: treeWidthPx };

    const onMouseMove = (ev: MouseEvent) => {
      if (!dragStateRef.current) return;
      const delta = ev.clientX - dragStateRef.current.startX;
      const next = Math.max(
        210,
        Math.min(420, dragStateRef.current.startWidth + delta)
      );
      setTreeWidthPx(next);
    };

    const onMouseUp = () => {
      dragStateRef.current = null;
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  };

  // --- CRUD & Staged Creation Handlers for ECU, Message, Signal, ValueTables ---

  const handleOpenCreateEcuModal = useCallback(
    (returnModalState: CandbModalState = { kind: 'none' }) => {
      if (!canMutate) return;
      const existing = new Set(effectiveSchema.ecus.map((e) => e.name));
      let idx = effectiveSchema.ecus.length + 1;
      let candidate = `ECU_${String(idx).padStart(2, '0')}`;
      while (existing.has(candidate)) {
        idx += 1;
        candidate = `ECU_${String(idx).padStart(2, '0')}`;
      }
      setStagedNewEcu({
        ecu: {
          name: candidate,
          comment: null,
          txMessageKeys: [],
          rxMessageKeys: [],
        },
        txMessageKeys: [],
        rxSignalIds: [],
        returnModalState,
      });
      setModalState({ kind: 'createEcu', initialTab: 'definition' });
    },
    [canMutate, effectiveSchema.ecus]
  );

  const handleUpdateStagedEcu = useCallback(
    (_oldName: string, patch: { name?: string; comment?: string | null }) => {
      setStagedNewEcu((prev) => {
        if (!prev) return null;
        return {
          ...prev,
          ecu: {
            ...prev.ecu,
            ...(patch.name !== undefined ? { name: patch.name } : {}),
            ...(patch.comment !== undefined ? { comment: patch.comment } : {}),
          },
        };
      });
    },
    []
  );

  const handleToggleStagedEcuTx = useCallback((msgKey: string) => {
    setStagedNewEcu((prev) => {
      if (!prev) return null;
      const exists = prev.txMessageKeys.includes(msgKey);
      return {
        ...prev,
        txMessageKeys: exists
          ? prev.txMessageKeys.filter((k) => k !== msgKey)
          : [...prev.txMessageKeys, msgKey],
      };
    });
  }, []);

  const handleToggleStagedEcuRx = useCallback((sigId: number) => {
    setStagedNewEcu((prev) => {
      if (!prev) return null;
      const exists = prev.rxSignalIds.includes(sigId);
      return {
        ...prev,
        rxSignalIds: exists
          ? prev.rxSignalIds.filter((id) => id !== sigId)
          : [...prev.rxSignalIds, sigId],
      };
    });
  }, []);

  const handleCommitCreateEcu = useCallback(
    (finalRawName: string) => {
      if (!canMutate || !stagedNewEcu) return;
      const cleanName = sanitizeDbcIdentifier(finalRawName, '');
      if (!cleanName) return;

      const returnModal = stagedNewEcu.returnModalState;
      const stagedTx = stagedNewEcu.txMessageKeys;
      const stagedRx = stagedNewEcu.rxSignalIds;
      const stagedComment = stagedNewEcu.ecu.comment;

      commitDraftMutation((prev) => {
        if (
          prev.ecus.some(
            (e) => e.name.toLowerCase() === cleanName.toLowerCase()
          )
        ) {
          return prev;
        }
        return {
          ...prev,
          ecus: [
            ...prev.ecus,
            {
              name: cleanName,
              comment: stagedComment,
              txMessageKeys: [],
              rxMessageKeys: [],
            },
          ],
          messages: prev.messages.map((m) =>
            stagedTx.includes(m.messageKey) && !m.transmitters.includes(cleanName)
              ? { ...m, transmitters: [...m.transmitters, cleanName] }
              : m
          ),
          signals: prev.signals.map((s) =>
            stagedRx.includes(s.signalId) && !s.receivers.includes(cleanName)
              ? { ...s, receivers: [...s.receivers, cleanName] }
              : s
          ),
        };
      });

      if (returnModal.kind === 'createMessage') {
        setStagedNewMessage((prev) =>
          prev && !prev.message.transmitters.includes(cleanName)
            ? {
                ...prev,
                message: {
                  ...prev.message,
                  transmitters: [...prev.message.transmitters, cleanName],
                },
              }
            : prev
        );
      } else if (returnModal.kind === 'createSignal') {
        setStagedNewSignal((prev) =>
          prev && !prev.receivers.includes(cleanName)
            ? {
                ...prev,
                receivers: [...prev.receivers, cleanName],
              }
            : prev
        );
      } else if (returnModal.kind === 'none') {
        setSelectedRow({ kind: 'ecu', ecuName: cleanName });
      }

      setStagedNewEcu(null);
      setModalState(returnModal);
    },
    [canMutate, commitDraftMutation, stagedNewEcu]
  );

  const handleCancelCreateEcu = useCallback(() => {
    const returnModal = stagedNewEcu?.returnModalState ?? { kind: 'none' };
    setStagedNewEcu(null);
    setModalState(returnModal);
  }, [stagedNewEcu]);

  const handleUpdateEcu = useCallback(
    (oldName: string, patch: { name?: string; comment?: string | null }) => {
      if (!canMutate) return;
      const cleanNewName =
        patch.name !== undefined
          ? sanitizeDbcIdentifier(patch.name, oldName)
          : oldName;

      commitDraftMutation((prev) => ({
        ...prev,
        ecus: prev.ecus.map((e) =>
          e.name === oldName
            ? {
                ...e,
                name: cleanNewName,
                comment:
                  patch.comment !== undefined ? patch.comment : e.comment,
              }
            : e
        ),
        messages:
          cleanNewName !== oldName
            ? prev.messages.map((m) => ({
                ...m,
                transmitters: m.transmitters.map((t) =>
                  t === oldName ? cleanNewName : t
                ),
              }))
            : prev.messages,
        signals:
          cleanNewName !== oldName
            ? prev.signals.map((s) => ({
                ...s,
                receivers: s.receivers.map((r) =>
                  r === oldName ? cleanNewName : r
                ),
              }))
            : prev.signals,
      }));

      if (cleanNewName !== oldName) {
        setSelectedRow((prev) =>
          prev?.kind === 'ecu' && prev.ecuName === oldName
            ? { kind: 'ecu', ecuName: cleanNewName }
            : prev
        );
        setViewTarget((prev) =>
          prev.kind === 'ecuDetail' && prev.ecuName === oldName
            ? { kind: 'ecuDetail', ecuName: cleanNewName }
            : prev
        );
        setModalState((prev) =>
          prev.kind === 'ecu' && prev.ecuName === oldName
            ? { ...prev, ecuName: cleanNewName }
            : prev
        );
      }
    },
    [canMutate, commitDraftMutation]
  );

  const handleDeleteEcu = useCallback(
    (ecuName: string) => {
      if (!canMutate) return;
      commitDraftMutation((prev) => ({
        ...prev,
        ecus: prev.ecus.filter((e) => e.name !== ecuName),
        messages: prev.messages.map((m) => ({
          ...m,
          transmitters: m.transmitters.filter((t) => t !== ecuName),
        })),
        signals: prev.signals.map((s) => ({
          ...s,
          receivers: s.receivers.filter((r) => r !== ecuName),
        })),
      }));
      setSelectedRow(null);
      setViewTarget((prev) =>
        prev.kind === 'ecuDetail' && prev.ecuName === ecuName
          ? { kind: 'folder', folder: 'ecus' }
          : prev
      );
    },
    [canMutate, commitDraftMutation]
  );

  // Staged Message Creation (opens modal first — zero mutation to draftSchema on Cancel!)
  const handleOpenCreateMessageModal = useCallback(() => {
    if (!canMutate) return;
    const nextArbId = findNextFreeArbId(effectiveSchema.messages, false);
    const msgKey = formatCanMessageKey(nextArbId, false);
    const defaultTx = effectiveSchema.ecus[0]
      ? [effectiveSchema.ecus[0].name]
      : [];

    setStagedNewMessage({
      message: {
        messageKey: msgKey,
        arbId: nextArbId,
        isExtended: false,
        protocol: 'CAN_FD',
        name: `MSG_0x${nextArbId.toString(16).toUpperCase()}`,
        dlc: 8,
        transmitters: defaultTx,
        expectedCycleMs: 50,
        comment: null,
        signalIds: [],
        bitLayout: [],
        isMultiplexed: false,
        masterSwitchId: null,
      },
      signals: [],
    });
    setModalState({ kind: 'createMessage', initialTab: 'definition' });
  }, [canMutate, effectiveSchema.ecus, effectiveSchema.messages]);

  const handleUpdateStagedMessage = useCallback(
    (
      _msgKey: string,
      patch: Partial<MessageSchemaDto> & {
        nextArbId?: number;
        nextIsExtended?: boolean;
      }
    ) => {
      if (!canMutate) return;
      setStagedNewMessage((prev) => {
        if (!prev) return null;
        const nextArb =
          patch.nextArbId !== undefined ? patch.nextArbId : prev.message.arbId;
        const nextExt =
          patch.nextIsExtended !== undefined
            ? patch.nextIsExtended
            : prev.message.isExtended;
        const candidateKey = formatCanMessageKey(nextArb, nextExt);
        const collision = effectiveSchema.messages.some(
          (m) => m.messageKey === candidateKey
        );

        const finalArb = collision ? prev.message.arbId : nextArb;
        const finalExt = collision ? prev.message.isExtended : nextExt;
        const finalKey = collision ? prev.message.messageKey : candidateKey;

        const {
          nextArbId: _ignoreArb,
          nextIsExtended: _ignoreExt,
          ...restPatch
        } = patch;
        void _ignoreArb;
        void _ignoreExt;

        return {
          message: {
            ...prev.message,
            ...restPatch,
            arbId: finalArb,
            isExtended: finalExt,
            messageKey: finalKey,
          },
          signals: prev.signals.map((s) => ({
            ...s,
            messageKey: finalKey,
          })),
        };
      });
    },
    [canMutate, effectiveSchema.messages]
  );

  const handleCommitCreateMessage = useCallback(() => {
    if (!canMutate || !stagedNewMessage) return;
    const rawName = stagedNewMessage.message.name.trim();
    if (!rawName) return;

    const cleanName = sanitizeDbcIdentifier(
      rawName,
      `MSG_0x${stagedNewMessage.message.arbId.toString(16).toUpperCase()}`
    );
    const finalKey = formatCanMessageKey(
      stagedNewMessage.message.arbId,
      stagedNewMessage.message.isExtended
    );

    if (draftSchema.messages.some((m) => m.messageKey === finalKey)) {
      return;
    }

    const msgToCommit: MessageSchemaDto = {
      ...stagedNewMessage.message,
      name: cleanName,
      messageKey: finalKey,
      bitLayout: [],
    };
    const sigsToCommit = stagedNewMessage.signals;

    commitDraftMutation((prev) => {
      let nextSigId = prev.signals.length;
      const idRemap = new Map<number, number>();
      const preparedSignals: SignalSchemaDto[] = sigsToCommit.map((s, idx) => {
        idRemap.set(s.signalId, nextSigId);
        const mapped: SignalSchemaDto = {
          ...s,
          signalId: nextSigId,
          messageKey: finalKey,
          name: sanitizeDbcIdentifier(s.name, `Signal_${idx + 1}`),
        };
        nextSigId += 1;
        return mapped;
      });
      const finalPreparedSignals = preparedSignals.map((s) => ({
        ...s,
        switchSignalId:
          s.switchSignalId !== null
            ? (idRemap.get(s.switchSignalId) ?? null)
            : null,
      }));

      return {
        ...prev,
        messages: [...prev.messages, msgToCommit],
        signals: [...prev.signals, ...finalPreparedSignals],
      };
    });

    setSelectedRow({ kind: 'message', messageKey: finalKey });
    setStagedNewMessage(null);
    setStagedNewSignal(null);
    setModalState({ kind: 'none' });
  }, [canMutate, commitDraftMutation, draftSchema.messages, stagedNewMessage]);

  const handleCancelCreateMessage = useCallback(() => {
    setStagedNewMessage(null);
    setStagedNewSignal(null);
    setModalState({ kind: 'none' });
  }, []);

  const handleUpdateStagedMessageSignal = useCallback(
    (signalId: number, patch: Partial<SignalSchemaDto>) => {
      if (!canMutate) return;
      setStagedNewMessage((prev) => {
        if (!prev) return null;
        return {
          ...prev,
          signals: prev.signals.map((s) =>
            s.signalId === signalId ? { ...s, ...patch } : s
          ),
        };
      });
    },
    [canMutate]
  );

  const handleCloneStagedMessageSignal = useCallback(
    (signalId: number) => {
      if (!canMutate) return;
      setStagedNewMessage((prev) => {
        if (!prev) return null;
        const src = prev.signals.find((s) => s.signalId === signalId);
        if (!src) return prev;
        const nextSigId =
          prev.signals.reduce((mx, s) => Math.max(mx, s.signalId), 999) + 1;
        const placement = createDefaultSignal({
          signalId: nextSigId,
          message: prev.message,
          existingSignals: prev.signals,
        });
        return {
          ...prev,
          signals: [
            ...prev.signals,
            {
              ...src,
              signalId: nextSigId,
              name: `${src.name}_Copy`,
              startBit: placement.startBit,
              enumTable: { ...src.enumTable },
              receivers: [...src.receivers],
              muxRanges: src.muxRanges.map(
                ([a, b]) => [a, b] as [number, number]
              ),
            },
          ],
        };
      });
    },
    [canMutate]
  );

  const handleDeleteStagedMessageSignal = useCallback(
    (signalId: number) => {
      if (!canMutate) return;
      setStagedNewMessage((prev) =>
        prev
          ? {
              ...prev,
              signals: prev.signals.filter((s) => s.signalId !== signalId),
            }
          : null
      );
    },
    [canMutate]
  );

  const handleCloneMessage = useCallback(
    (sourceKey: string) => {
      if (!canMutate) return;
      let clonedKey = '';
      commitDraftMutation((prev) => {
        const src = prev.messages.find((m) => m.messageKey === sourceKey);
        if (!src) return prev;
        const nextArbId = findNextFreeArbId(prev.messages, src.isExtended);
        const nextKey = formatCanMessageKey(nextArbId, src.isExtended);
        clonedKey = nextKey;

        const clonedMsg: MessageSchemaDto = {
          ...src,
          messageKey: nextKey,
          arbId: nextArbId,
          name: `${src.name}_Copy`,
          bitLayout: [],
        };

        let nextSigId = prev.signals.length;
        const srcSigs = prev.signals.filter((s) => s.messageKey === sourceKey);
        const clonedSigs: SignalSchemaDto[] = srcSigs.map((s) => {
          const copy: SignalSchemaDto = {
            ...s,
            signalId: nextSigId,
            messageKey: nextKey,
            switchSignalId: null,
          };
          nextSigId += 1;
          return copy;
        });

        return {
          ...prev,
          messages: [...prev.messages, clonedMsg],
          signals: [...prev.signals, ...clonedSigs],
        };
      });

      if (clonedKey) {
        setSelectedRow({ kind: 'message', messageKey: clonedKey });
      }
    },
    [canMutate, commitDraftMutation]
  );

  const handleUpdateMessage = useCallback(
    (
      messageKey: string,
      patch: Partial<MessageSchemaDto> & {
        nextArbId?: number;
        nextIsExtended?: boolean;
      }
    ) => {
      if (!canMutate) return;
      let updatedKey = messageKey;

      commitDraftMutation((prev) => {
        const target = prev.messages.find((m) => m.messageKey === messageKey);
        if (!target) return prev;

        const nextArb =
          patch.nextArbId !== undefined ? patch.nextArbId : target.arbId;
        const nextExt =
          patch.nextIsExtended !== undefined
            ? patch.nextIsExtended
            : target.isExtended;
        const candidateKey = formatCanMessageKey(nextArb, nextExt);

        const collision = prev.messages.some(
          (m) => m.messageKey === candidateKey && m.messageKey !== messageKey
        );
        const finalArb = collision ? target.arbId : nextArb;
        const finalExt = collision ? target.isExtended : nextExt;
        const finalKey = collision ? messageKey : candidateKey;
        updatedKey = finalKey;

        const {
          nextArbId: _ignoreArb,
          nextIsExtended: _ignoreExt,
          ...restPatch
        } = patch;
        void _ignoreArb;
        void _ignoreExt;

        return {
          ...prev,
          messages: prev.messages.map((m) =>
            m.messageKey === messageKey
              ? {
                  ...m,
                  ...restPatch,
                  arbId: finalArb,
                  isExtended: finalExt,
                  messageKey: finalKey,
                }
              : m
          ),
          signals:
            finalKey !== messageKey
              ? prev.signals.map((s) =>
                  s.messageKey === messageKey
                    ? { ...s, messageKey: finalKey }
                    : s
                )
              : prev.signals,
        };
      });

      if (updatedKey !== messageKey) {
        setSelectedRow((prev) => {
          if (prev?.kind === 'message' && prev.messageKey === messageKey) {
            return { kind: 'message', messageKey: updatedKey };
          }
          if (prev?.kind === 'signal' && prev.messageKey === messageKey) {
            return { ...prev, messageKey: updatedKey };
          }
          return prev;
        });
        setViewTarget((prev) =>
          prev.kind === 'messageSignals' && prev.messageKey === messageKey
            ? { kind: 'messageSignals', messageKey: updatedKey }
            : prev
        );
        setModalState((prev) => {
          if (prev.kind === 'message' && prev.messageKey === messageKey) {
            return { ...prev, messageKey: updatedKey };
          }
          if (
            (prev.kind === 'signal' || prev.kind === 'createSignal') &&
            prev.returnToMessageKey === messageKey
          ) {
            return { ...prev, returnToMessageKey: updatedKey };
          }
          return prev;
        });
      }
    },
    [canMutate, commitDraftMutation]
  );

  const handleDeleteMessage = useCallback(
    (messageKey: string) => {
      if (!canMutate) return;
      commitDraftMutation((prev) => ({
        ...prev,
        messages: prev.messages.filter((m) => m.messageKey !== messageKey),
        signals: prev.signals.filter((s) => s.messageKey !== messageKey),
      }));
      setSelectedRow(null);
      setViewTarget((prev) =>
        prev.kind === 'messageSignals' && prev.messageKey === messageKey
          ? { kind: 'folder', folder: 'messages' }
          : prev
      );
    },
    [canMutate, commitDraftMutation]
  );

  // Staged Signal Creation (opens modal first — zero mutation to draftSchema on Cancel!)
  const handleOpenCreateSignalModal = useCallback(
    (params?: {
      preferredMessageKey?: string | undefined;
      overrideStartBit?: number | undefined;
      returnToMessageKey?: string | undefined;
      returnToMessageTab?: MessageDialogTab | undefined;
      targetIsStagedMessage?: boolean | undefined;
    }) => {
      if (!canMutate) return;

      if (params?.targetIsStagedMessage && stagedNewMessage) {
        const nextTempSigId =
          stagedNewMessage.signals.reduce(
            (mx, s) => Math.max(mx, s.signalId),
            999
          ) + 1;
        const draftSig = createDefaultSignal({
          signalId: nextTempSigId,
          message: stagedNewMessage.message,
          existingSignals: stagedNewMessage.signals,
          ...(params.overrideStartBit !== undefined
            ? { overrideStartBit: params.overrideStartBit }
            : {}),
        });
        setStagedNewSignal(draftSig);
        setModalState({
          kind: 'createSignal',
          initialTab: 'definition',
          returnToMessageKey: stagedNewMessage.message.messageKey,
          returnToMessageTab: params.returnToMessageTab ?? 'signals',
          targetIsStagedMessage: true,
        });
        return;
      }

      const targetMsgKey =
        params?.preferredMessageKey ??
        (viewTarget.kind === 'messageSignals'
          ? viewTarget.messageKey
          : selectedRow?.kind === 'message'
            ? selectedRow.messageKey
            : selectedRow?.kind === 'signal'
              ? selectedRow.messageKey
              : effectiveSchema.messages[0]?.messageKey);

      if (!targetMsgKey) {
        setToast({
          kind: 'info',
          message: tShard(dbcStudioShard, 'workbench.toast.createMessageFirst'),
        });
        return;
      }

      const liveMsg =
        effectiveSchema.messages.find((m) => m.messageKey === targetMsgKey) ??
        null;
      if (!liveMsg) return;

      const existingSigs = effectiveSchema.signals.filter(
        (s) => s.messageKey === targetMsgKey
      );
      const draftSig = createDefaultSignal({
        signalId: effectiveSchema.signals.length,
        message: liveMsg,
        existingSignals: existingSigs,
        ...(params?.overrideStartBit !== undefined
          ? { overrideStartBit: params.overrideStartBit }
          : {}),
      });

      setStagedNewSignal(draftSig);
      setModalState({
        kind: 'createSignal',
        initialTab: 'definition',
        ...(params?.returnToMessageKey
          ? {
              returnToMessageKey: params.returnToMessageKey,
              returnToMessageTab: params.returnToMessageTab ?? 'signals',
            }
          : {}),
      });
    },
    [canMutate, effectiveSchema, selectedRow, stagedNewMessage, viewTarget]
  );

  const handleUpdateStagedSignal = useCallback(
    (_signalId: number, patch: Partial<SignalSchemaDto>) => {
      if (!canMutate) return;
      setStagedNewSignal((prev) => (prev ? { ...prev, ...patch } : null));
    },
    [canMutate]
  );

  const handleCommitCreateSignal = useCallback(() => {
    if (!canMutate || !stagedNewSignal || modalState.kind !== 'createSignal') {
      return;
    }
    const cleanName = sanitizeDbcIdentifier(stagedNewSignal.name.trim(), '');
    if (!cleanName) return;

    if (modalState.targetIsStagedMessage) {
      setStagedNewMessage((prev) => {
        if (!prev) return null;
        return {
          ...prev,
          signals: [
            ...prev.signals,
            {
              ...stagedNewSignal,
              name: cleanName,
              messageKey: prev.message.messageKey,
            },
          ],
        };
      });
      const retTab = modalState.returnToMessageTab ?? 'signals';
      setStagedNewSignal(null);
      setModalState({ kind: 'createMessage', initialTab: retTab });
      return;
    }

    const nextId = draftSchema.signals.length;
    const targetMsgKey = stagedNewSignal.messageKey;
    commitDraftMutation((prev) => ({
      ...prev,
      signals: [
        ...prev.signals,
        {
          ...stagedNewSignal,
          name: cleanName,
          signalId: prev.signals.length,
        },
      ],
    }));

    setSelectedRow({
      kind: 'signal',
      messageKey: targetMsgKey,
      signalId: nextId,
    });
    const returnKey = modalState.returnToMessageKey;
    const returnTab = modalState.returnToMessageTab ?? 'signals';
    setStagedNewSignal(null);
    if (returnKey) {
      setModalState({
        kind: 'message',
        messageKey: returnKey,
        initialTab: returnTab,
      });
    } else {
      setModalState({ kind: 'none' });
    }
  }, [
    canMutate,
    commitDraftMutation,
    draftSchema.signals.length,
    modalState,
    stagedNewSignal,
  ]);

  const handleCancelCreateSignal = useCallback(() => {
    if (modalState.kind === 'createSignal') {
      if (modalState.targetIsStagedMessage) {
        const retTab = modalState.returnToMessageTab ?? 'signals';
        setStagedNewSignal(null);
        setModalState({ kind: 'createMessage', initialTab: retTab });
        return;
      }
      if (modalState.returnToMessageKey) {
        const retKey = modalState.returnToMessageKey;
        const retTab = modalState.returnToMessageTab ?? 'signals';
        setStagedNewSignal(null);
        setModalState({
          kind: 'message',
          messageKey: retKey,
          initialTab: retTab,
        });
        return;
      }
    }
    setStagedNewSignal(null);
    setModalState({ kind: 'none' });
  }, [modalState]);

  const handleCloneSignal = useCallback(
    (signalId: number) => {
      if (!canMutate) return;
      const src = effectiveSchema.signals.find((s) => s.signalId === signalId);
      const liveMsg = src
        ? effectiveSchema.messages.find((m) => m.messageKey === src.messageKey)
        : undefined;
      if (!src || !liveMsg) return;

      const msgSigs = effectiveSchema.signals.filter(
        (s) => s.messageKey === src.messageKey
      );
      const placement = createDefaultSignal({
        signalId: effectiveSchema.signals.length,
        message: liveMsg,
        existingSignals: msgSigs,
      });

      const nextId = draftSchema.signals.length;
      commitDraftMutation((prev) => ({
        ...prev,
        signals: [
          ...prev.signals,
          {
            ...src,
            signalId: prev.signals.length,
            name: `${src.name}_Copy`,
            startBit: placement.startBit,
            enumTable: { ...src.enumTable },
            receivers: [...src.receivers],
            muxRanges: src.muxRanges.map(
              ([a, b]) => [a, b] as [number, number]
            ),
          },
        ],
      }));
      setSelectedRow({
        kind: 'signal',
        messageKey: src.messageKey,
        signalId: nextId,
      });
    },
    [
      canMutate,
      commitDraftMutation,
      draftSchema.signals.length,
      effectiveSchema,
    ]
  );

  const handleUpdateSignal = useCallback(
    (signalId: number, patch: Partial<SignalSchemaDto>) => {
      if (!canMutate) return;
      commitDraftMutation((prev) => ({
        ...prev,
        signals: prev.signals.map((s) =>
          s.signalId === signalId ? { ...s, ...patch } : s
        ),
      }));
    },
    [canMutate, commitDraftMutation]
  );

  const handleDeleteSignal = useCallback(
    (signalId: number) => {
      if (!canMutate) return;
      commitDraftMutation((prev) => ({
        ...prev,
        signals: prev.signals.filter((s) => s.signalId !== signalId),
      }));
      setSelectedRow((prev) =>
        prev?.kind === 'signal' && prev.signalId === signalId ? null : prev
      );
    },
    [canMutate, commitDraftMutation]
  );

  const handleToggleMessageTx = useCallback(
    (msgKey: string, ecuName: string) => {
      const m = effectiveSchema.messages.find(
        (item) => item.messageKey === msgKey
      );
      if (!m) return;
      const exists = m.transmitters.includes(ecuName);
      handleUpdateMessage(msgKey, {
        transmitters: exists
          ? m.transmitters.filter((t) => t !== ecuName)
          : [...m.transmitters, ecuName],
      });
    },
    [effectiveSchema.messages, handleUpdateMessage]
  );

  const handleToggleSignalRx = useCallback(
    (sigId: number, ecuName: string) => {
      const s = effectiveSchema.signals.find(
        (item) => item.signalId === sigId
      );
      if (!s) return;
      const exists = s.receivers.includes(ecuName);
      handleUpdateSignal(sigId, {
        receivers: exists
          ? s.receivers.filter((r) => r !== ecuName)
          : [...s.receivers, ecuName],
      });
    },
    [effectiveSchema.signals, handleUpdateSignal]
  );

  // Staged ValueTable Creation (opens modal first — zero mutation to valueTables on Cancel!)
  const handleOpenCreateValueTableModal = useCallback(() => {
    if (!canMutate) return;
    const existingNames = new Set(valueTables.map((vt) => vt.name));
    let idx = valueTables.length + 1;
    let candidate = `VT_Table_${idx}`;
    while (existingNames.has(candidate)) {
      idx += 1;
      candidate = `VT_Table_${idx}`;
    }
    setStagedNewValueTable({
      name: candidate,
      entries: { '0': 'OFF', '1': 'ON' },
    });
    setModalState({ kind: 'createValueTable' });
  }, [canMutate, valueTables]);

  const handleCommitCreateValueTable = useCallback(() => {
    if (!canMutate || !stagedNewValueTable) return;
    const cleanName = sanitizeDbcIdentifier(
      stagedNewValueTable.name.trim(),
      ''
    );
    if (!cleanName) return;

    const nextIdx = valueTables.length;
    setValueTables((prev) => [
      ...prev,
      {
        name: cleanName,
        entries: { ...stagedNewValueTable.entries },
      },
    ]);
    setIsDirty(true);
    setSelectedRow({ kind: 'valueTable', tableIndex: nextIdx });
    setStagedNewValueTable(null);
    setModalState({ kind: 'none' });
  }, [canMutate, stagedNewValueTable, valueTables.length]);

  const handleCancelCreateValueTable = useCallback(() => {
    setStagedNewValueTable(null);
    setModalState({ kind: 'none' });
  }, []);

  const handleCloneValueTable = useCallback(
    (tableIndex: number) => {
      if (!canMutate) return;
      const src = valueTables[tableIndex];
      if (!src) return;
      const nextIdx = valueTables.length;
      setValueTables((prev) => [
        ...prev,
        {
          name: `${src.name}_Copy`,
          entries: { ...src.entries },
        },
      ]);
      setIsDirty(true);
      setSelectedRow({ kind: 'valueTable', tableIndex: nextIdx });
    },
    [canMutate, valueTables]
  );

  const handleDeleteValueTable = useCallback(
    (tableIndex: number) => {
      if (!canMutate) return;
      setValueTables((prev) => prev.filter((_, idx) => idx !== tableIndex));
      setIsDirty(true);
      setSelectedRow(null);
    },
    [canMutate]
  );

  // --- Left Tree Selection Handlers ---

  const handleTreeSelectFolder = useCallback((folder: CandbFolderKind) => {
    setViewTarget({ kind: 'folder', folder });
    setSelectedRow(folder === 'networks' ? { kind: 'network' } : null);
  }, []);

  const handleTreeSelectNetworkLeaf = useCallback((openDialog: boolean) => {
    setViewTarget({ kind: 'folder', folder: 'networks' });
    setSelectedRow({ kind: 'network' });
    if (openDialog) {
      setModalState({ kind: 'network' });
    }
  }, []);

  const handleTreeSelectEcuLeaf = useCallback(
    (ecuName: string, openDialog: boolean) => {
      setViewTarget({ kind: 'ecuDetail', ecuName });
      setSelectedRow({ kind: 'ecu', ecuName });
      if (openDialog) {
        setModalState({ kind: 'ecu', ecuName });
      }
    },
    []
  );

  const handleTreeSelectMessageLeaf = useCallback(
    (messageKey: string, openDialog: boolean) => {
      setViewTarget({ kind: 'messageSignals', messageKey });
      setSelectedRow({ kind: 'message', messageKey });
      if (openDialog) {
        setModalState({
          kind: 'message',
          messageKey,
          initialTab: 'definition',
        });
      }
    },
    []
  );

  const handleTreeSelectSignalLeaf = useCallback(
    (messageKey: string, signalId: number, openDialog: boolean) => {
      setViewTarget((prev) =>
        prev.kind === 'folder' && prev.folder === 'signals'
          ? prev
          : { kind: 'messageSignals', messageKey }
      );
      setSelectedRow({ kind: 'signal', messageKey, signalId });
      if (openDialog) {
        setModalState({
          kind: 'signal',
          signalId,
          initialTab: 'definition',
        });
      }
    },
    []
  );

  const handleTreeSelectValueTableLeaf = useCallback(
    (tableIndex: number, openDialog: boolean) => {
      setViewTarget({ kind: 'folder', folder: 'valueTables' });
      setSelectedRow({ kind: 'valueTable', tableIndex });
      if (openDialog) {
        setModalState({ kind: 'valueTable', tableIndex });
      }
    },
    []
  );

  // --- Disk Import (.dbc / .kcd) & Download (.dbc) ---

  const handleImportDiskFile = async (
    e: React.ChangeEvent<HTMLInputElement>
  ) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;

    setImportingFile(true);
    try {
      const rawText = await file.text();
      const res = toDraftValidation(
        await validateDbcText(file.name, rawText),
        rawText
      );

      if (!res.compiledSchema) {
        setToast({
          kind: 'error',
          message:
            res.compileError ||
            tShard(dbcStudioShard, 'workbench.toast.importParseFailed', {
              fileName: file.name,
            }),
        });
        return;
      }

      const norm = normalizeSchemaInvariants(res.compiledSchema);
      setDraftSchema(norm);
      setCompiledSchema(res.compiledSchema);
      setWasmValid(res.valid);
      setWasmDbcText(res.dbcText);
      setWasmDiagnostics(res.diagnostics);
      setBitOverlaps(res.bitOverlaps);
      setCompileError(res.compileError);

      setIsDirty(true);

      const firstMsg = norm.messages[0];
      setViewTarget({ kind: 'folder', folder: 'messages' });
      setSelectedRow(
        firstMsg ? { kind: 'message', messageKey: firstMsg.messageKey } : null
      );

      setToast({
        kind: 'success',
        message: tShard(dbcStudioShard, 'workbench.toast.importSuccess', {
          fileName: file.name,
          messages: norm.messages.length,
          signals: norm.signals.length,
          ecus: norm.ecus.length,
        }),
      });
    } catch (err: unknown) {
      setToast({
        kind: 'error',
        message:
          err instanceof Error
            ? err.message
            : tShard(dbcStudioShard, 'workbench.toast.importDiskError'),
      });
    } finally {
      setImportingFile(false);
    }
  };

  const handleDownloadDbc = useCallback(() => {
    const safeName = sanitizeDbcIdentifier(databaseName, 'Vehicle_CAN');
    const blob = new Blob([liveCanonicalDbcText], {
      type: 'text/plain;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${safeName}.dbc`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }, [databaseName, liveCanonicalDbcText]);

  // --- Save (overwrite, Ctrl+S) & Save As ---

  const saveBlockReason = useMemo<string | null>(() => {
    if (!databaseName.trim()) {
      return t('workbench.saveBlock.emptyDbName');
    }
    if (bitOverlaps.length > 0) {
      return t('workbench.saveBlock.bitOverlaps', {
        count: bitOverlaps.length,
      });
    }
    if (compileError) {
      return t('workbench.saveBlock.compileError', { error: compileError });
    }
    return null;
  }, [bitOverlaps.length, compileError, databaseName, t]);

  const currentVersionBadge = sourceFileName || t('workbench.badge.baseLoaded');

  const buildSaveText = useCallback(
    (): string =>
      serializeDatabaseSchemaToDbc(draftSchema, {
        valueTables,
        networkComment: networkComment.trim() || null,
      }),
    [draftSchema, networkComment, valueTables]
  );

  const reportSaveError = useCallback(
    (err: unknown) => {
      setToast({
        kind: 'error',
        message: ls('saveFailed', {
          error: err instanceof Error ? err.message : String(err),
        }),
      });
    },
    [ls]
  );

  const handleOpenSaveAs = useCallback(() => {
    const stem = sanitizeDbcIdentifier(databaseName, 'Network');
    setSaveAsName(`${stem}_edited.dbc`);
    setModalState({ kind: 'saveAs' });
  }, [databaseName]);

  const handleSave = useCallback(async () => {
    if (savingVersion || loadingInitial) return;
    if (sourceFormat === 'kcd') {
      handleOpenSaveAs();
      return;
    }
    if (saveBlockReason) {
      setToast({ kind: 'error', message: saveBlockReason });
      return;
    }
    setSavingVersion(true);
    try {
      const saved = await saveDatabaseOverwrite(
        resolvedDatabaseId,
        buildSaveText()
      );
      setSourceFileName(saved.fileName);
      setIsDirty(false);
      setToast({ kind: 'success', message: ls('saved', { name: saved.fileName }) });
    } catch (err: unknown) {
      reportSaveError(err);
    } finally {
      setSavingVersion(false);
    }
  }, [
    buildSaveText,
    handleOpenSaveAs,
    loadingInitial,
    ls,
    reportSaveError,
    resolvedDatabaseId,
    saveBlockReason,
    savingVersion,
    sourceFormat,
  ]);

  const executeSaveAs = useCallback(async () => {
    if (savingVersion) return;
    if (saveBlockReason) {
      setToast({ kind: 'error', message: saveBlockReason });
      setModalState({ kind: 'none' });
      return;
    }
    setSavingVersion(true);
    try {
      const saved = await saveDatabaseAs(saveAsName, buildSaveText(), {
        allowOverwriteId: sourceFormat === 'dbc' ? resolvedDatabaseId : undefined,
      });
      setResolvedDatabaseId(saved.id);
      setSourceFormat('dbc');
      setSourceFileName(saved.fileName);
      setDatabaseName(saved.name);
      setIsDirty(false);
      setModalState({ kind: 'none' });
      setToast({ kind: 'success', message: ls('savedAs', { name: saved.fileName }) });
    } catch (err: unknown) {
      reportSaveError(err);
    } finally {
      setSavingVersion(false);
    }
  }, [
    buildSaveText,
    ls,
    reportSaveError,
    resolvedDatabaseId,
    saveAsName,
    saveBlockReason,
    savingVersion,
    sourceFormat,
  ]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (e.shiftKey) {
          handleOpenSaveAs();
        } else {
          void handleSave();
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [handleOpenSaveAs, handleSave]);

  const handleRequestClose = useCallback(() => {
    if (isDirty) {
      setExitPromptOpen(true);
    } else {
      onClose();
    }
  }, [isDirty, onClose]);

  const stagedMessageWithWasmLayout = useMemo<MessageSchemaDto | null>(() => {
    if (!stagedNewMessage) return null;
    if (!stagedMsgWasm.compiledSchema || stagedNewMessage.signals.length === 0) {
      return stagedNewMessage.message;
    }
    const merged = mergeWasmBitLayoutIntoSchema(
      normalizeSchemaInvariants({
        ...draftSchema,
        messages: [...draftSchema.messages, stagedNewMessage.message],
        signals: [...draftSchema.signals, ...stagedNewMessage.signals],
      }),
      stagedMsgWasm.compiledSchema
    );
    const matched = merged.messages.find(
      (m) => m.messageKey === stagedNewMessage.message.messageKey
    );
    if (!matched) {
      return stagedNewMessage.message;
    }
    // Remap WASM bitLayout signalId back to stagedNewMessage.signals signalId by signal name
    const stagedIdByName = new Map<string, number>();
    stagedNewMessage.signals.forEach((s, idx) => {
      stagedIdByName.set(s.name, s.signalId);
      stagedIdByName.set(
        sanitizeDbcIdentifier(s.name, `Signal_${idx + 1}`),
        s.signalId
      );
    });
    const mergedSigById = new Map(merged.signals.map((s) => [s.signalId, s]));
    return {
      ...stagedNewMessage.message,
      bitLayout: matched.bitLayout.map((cell) => {
        const mSig = mergedSigById.get(cell.signalId);
        const origId = mSig ? stagedIdByName.get(mSig.name) : undefined;
        return origId !== undefined ? { ...cell, signalId: origId } : cell;
      }),
    };
  }, [draftSchema, stagedMsgWasm.compiledSchema, stagedNewMessage]);

  const stagedMessageDialogSchema = useMemo<DatabaseSchemaDto>(() => {
    return {
      info: effectiveSchema.info,
      ecus: effectiveSchema.ecus,
      messages: effectiveSchema.messages,
      signals: stagedNewMessage?.signals ?? [],
    };
  }, [effectiveSchema, stagedNewMessage]);

  if (loadingInitial) {
    return (
      <div className="flex h-[calc(100vh-3.25rem)] flex-col items-center justify-center bg-canvas p-6 font-mono text-xs text-muted">
        {t('workbench.loadingSchema')}
      </div>
    );
  }

  if (loadErrorDbId) {
    return (
      <div className="mx-auto max-w-2xl p-6">
        <div className="rounded-[2px] border border-strong bg-surface p-6 space-y-4">
          <div className="flex items-center gap-2 font-mono text-xs font-semibold text-critical">
            <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span>
              {t('workbench.error.loadDatabase', { id: loadErrorDbId })}
            </span>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-[2px] border border-hairline bg-elevated px-3 text-xs text-ink hover:border-strong"
          >
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
            <span>{t('workbench.backToDatabases')}</span>
          </button>
        </div>
      </div>
    );
  }

  const consistencyIssueCount =
    (compileError ? 1 : 0) +
    bitOverlaps.length +
    wasmDiagnostics.filter((d) => d.severity === 'error').length;

  // Resolve objects for currently active modal
  const activeDialogMessage =
    modalState.kind === 'message'
      ? (effectiveSchema.messages.find(
          (m) => m.messageKey === modalState.messageKey
        ) ?? null)
      : null;

  const activeDialogSignal =
    modalState.kind === 'signal'
      ? modalState.editingStagedMessageSignal
        ? (stagedNewMessage?.signals.find(
            (s) => s.signalId === modalState.signalId
          ) ?? null)
        : (effectiveSchema.signals.find(
            (s) => s.signalId === modalState.signalId
          ) ?? null)
      : null;

  const activeDialogEcu =
    modalState.kind === 'ecu'
      ? (effectiveSchema.ecus.find((e) => e.name === modalState.ecuName) ??
        null)
      : null;

  const activeDialogValueTable =
    modalState.kind === 'valueTable'
      ? (valueTables[modalState.tableIndex] ?? null)
      : null;

  return (
    <div className="flex h-[calc(100vh-3.25rem)] min-h-[620px] flex-col overflow-hidden bg-canvas">
      {/* Hidden File Input for Disk .dbc / .kcd Import */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".dbc,.kcd,.xml"
        onChange={(e) => void handleImportDiskFile(e)}
        className="hidden"
      />

      {/* Calm, Uncluttered Single-Row Top Toolbar (h-12) */}
      <header className="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-hairline bg-surface px-4">
        {/* Left: Back Link + Database Title Badge + Settings + Unsaved Indicator */}
        <div className="flex min-w-0 items-center gap-2.5">
          <button
            type="button"
            onClick={handleRequestClose}
            className="inline-flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-[2px] border border-hairline bg-elevated px-2.5 text-xs text-muted transition-colors hover:border-strong hover:text-ink"
          >
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
            <span className="hidden sm:inline">
              {t('workbench.backToDatabases')}
            </span>
          </button>

          <div className="flex min-w-0 items-center gap-2 rounded-[2px] border border-hairline bg-canvas px-3 py-1 text-xs">
            <span className="truncate font-mono font-semibold text-ink">
              {databaseName}
            </span>
            <span className="text-subtle">·</span>
            <span className="shrink-0 font-mono text-[11px] font-semibold tabular-nums text-nominal">
              {currentVersionBadge}
            </span>
          </div>

          <button
            type="button"
            onClick={() => setModalState({ kind: 'network' })}
            className="inline-flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-[2px] border border-hairline bg-elevated px-2.5 text-xs text-muted transition-colors hover:border-strong hover:text-ink"
          >
            <Settings className="h-3.5 w-3.5" aria-hidden="true" />
            <span>{t('workbench.settings')}</span>
          </button>

          {isDirty && (
            <span className="hidden shrink-0 items-center gap-1.5 text-[11px] text-warn lg:inline-flex">
              <span
                className="h-1.5 w-1.5 rounded-[1px]"
                style={{ backgroundColor: 'var(--status-warn)' }}
                aria-hidden="true"
              />
              <span>{t('workbench.unsaved')}</span>
            </span>
          )}
        </div>

        {/* Right: On-Demand Tool Modals + Primary Save CTA */}
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            disabled={!canMutate || importingFile}
            onClick={() => fileInputRef.current?.click()}
            className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-[2px] border border-hairline bg-elevated px-2.5 text-xs text-ink transition-colors hover:border-strong disabled:cursor-not-allowed disabled:opacity-45"
          >
            <FolderInput
              className="h-3.5 w-3.5 text-focus"
              aria-hidden="true"
            />
            <span>
              {importingFile ? t('workbench.importing') : t('workbench.import')}
            </span>
          </button>

          <button
            type="button"
            onClick={() => setModalState({ kind: 'commMatrix' })}
            className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-[2px] border border-hairline bg-elevated px-2.5 text-xs text-ink transition-colors hover:border-strong"
          >
            <Cpu className="h-3.5 w-3.5 text-focus" aria-hidden="true" />
            <span className="hidden md:inline">{t('workbench.commMatrix')}</span>
          </button>

          <button
            type="button"
            onClick={() => setModalState({ kind: 'consistency' })}
            className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-[2px] border px-2.5 font-mono text-[11px] font-semibold tabular-nums transition-colors"
            style={
              consistencyIssueCount > 0
                ? {
                    backgroundColor: 'var(--status-critical-bg)',
                    borderColor: 'var(--status-critical-border)',
                    color: 'var(--status-critical)',
                  }
                : {
                    backgroundColor: 'var(--status-nominal-bg)',
                    borderColor: 'var(--status-nominal-border)',
                    color: 'var(--status-nominal)',
                  }
            }
          >
            {consistencyIssueCount > 0 ? (
              <>
                <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
                <span>
                  {t('workbench.issueCount', { count: consistencyIssueCount })}
                </span>
              </>
            ) : (
              <>
                <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
                <span>
                  {isValidatingWasm
                    ? t('workbench.checking')
                    : t('workbench.consistent')}
                </span>
              </>
            )}
          </button>

          <button
            type="button"
            onClick={() => setModalState({ kind: 'dbcSource' })}
            className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-[2px] border border-hairline bg-elevated px-2.5 text-xs text-ink transition-colors hover:border-strong"
          >
            <FileCode2 className="h-3.5 w-3.5 text-focus" aria-hidden="true" />
            <span className="hidden sm:inline">{t('workbench.dbcSource')}</span>
          </button>

          <button
            type="button"
            disabled={savingVersion}
            title={sourceFormat === 'kcd' ? ls('kcdNotice') : t('workbench.saveTooltip')}
            onClick={() => void handleSave()}
            className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-[2px] px-3.5 text-xs font-semibold text-on-accent transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-45"
            style={{ backgroundColor: 'var(--status-nominal)' }}
          >
            <Save className="h-3.5 w-3.5" aria-hidden="true" />
            <span>{t('common.save')}</span>
          </button>

          <button
            type="button"
            disabled={savingVersion}
            title={ls('saveAsTooltip')}
            onClick={handleOpenSaveAs}
            className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-[2px] border border-hairline bg-elevated px-2.5 text-xs text-ink transition-colors hover:border-strong disabled:cursor-not-allowed disabled:opacity-45"
          >
            <SaveAll className="h-3.5 w-3.5 text-focus" aria-hidden="true" />
            <span className="hidden sm:inline">{ls('saveAs')}</span>
          </button>
        </div>
      </header>

      {/* Toast Feedback Strip */}
      {toast && (
        <div
          role="status"
          className="flex shrink-0 items-center justify-between gap-2 border-b border-hairline bg-elevated px-4 py-1.5 text-xs"
        >
          <div className="flex items-center gap-2">
            {toast.kind === 'error' ? (
              <AlertCircle
                className="h-3.5 w-3.5 shrink-0 text-critical"
                aria-hidden="true"
              />
            ) : (
              <CheckCircle2
                className="h-3.5 w-3.5 shrink-0 text-nominal"
                aria-hidden="true"
              />
            )}
            <span
              className={toast.kind === 'error' ? 'text-critical' : 'text-ink'}
            >
              {toast.message}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setToast(null)}
              aria-label={t('workbench.dismissToastAria')}
              className="cursor-pointer rounded-[2px] p-0.5 text-muted hover:text-ink"
            >
              <X className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </div>
        </div>
      )}

      {/* 2-Pane DBC Studio Workspace (Overall View Tree | List View Table) */}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <CandbTreeSidebar
          widthPx={treeWidthPx}
          databaseName={databaseName}
          schema={effectiveSchema}
          valueTables={valueTables}
          bitOverlaps={bitOverlaps}
          viewTarget={viewTarget}
          selectedRow={selectedRow}
          canMutate={canMutate}
          onSelectFolder={handleTreeSelectFolder}
          onSelectNetworkLeaf={handleTreeSelectNetworkLeaf}
          onSelectEcuLeaf={handleTreeSelectEcuLeaf}
          onSelectMessageLeaf={handleTreeSelectMessageLeaf}
          onSelectSignalLeaf={handleTreeSelectSignalLeaf}
          onSelectValueTableLeaf={handleTreeSelectValueTableLeaf}
          onAddEcu={() => handleOpenCreateEcuModal({ kind: 'none' })}
          onAddMessage={handleOpenCreateMessageModal}
          onAddSignal={() => handleOpenCreateSignalModal()}
          onAddValueTable={handleOpenCreateValueTableModal}
        />

        {/* 1px Hairline Resizer Handle */}
        <div
          role="separator"
          aria-orientation="vertical"
          onMouseDown={handleStartTreeResize}
          className="w-1 shrink-0 cursor-col-resize border-r border-hairline bg-surface transition-colors hover:bg-focus/40"
        />

        <CandbListView
          nodeGraphStorageKey={`nexuscan.dbcEditor.nodeGraph.${databaseId}`}
          databaseName={databaseName}
          busAssignment={busAssignment}
          versionLabel={currentVersionBadge}
          networkComment={networkComment}
          schema={effectiveSchema}
          valueTables={valueTables}
          bitOverlaps={bitOverlaps}
          viewTarget={viewTarget}
          selectedRow={selectedRow}
          canMutate={canMutate}
          onSelectRow={setSelectedRow}
          onOpenNetworkDialog={() => setModalState({ kind: 'network' })}
          onOpenEcuDialog={(ecuName) =>
            setModalState({ kind: 'ecu', ecuName })
          }
          onOpenMessageDialog={(messageKey, openLayoutTab = false) =>
            setModalState({
              kind: 'message',
              messageKey,
              initialTab: openLayoutTab ? 'layout' : 'definition',
            })
          }
          onOpenSignalDialog={(signalId, returnToMessageKey) =>
            setModalState({
              kind: 'signal',
              signalId,
              initialTab: 'definition',
              ...(returnToMessageKey ? { returnToMessageKey } : {}),
            })
          }
          onOpenValueTableDialog={(tableIndex) =>
            setModalState({ kind: 'valueTable', tableIndex })
          }
          onAddEcu={() => handleOpenCreateEcuModal({ kind: 'none' })}
          onDeleteEcu={handleDeleteEcu}
          onAddMessage={handleOpenCreateMessageModal}
          onCloneMessage={handleCloneMessage}
          onDeleteMessage={handleDeleteMessage}
          onAddSignal={(msgKey) =>
            handleOpenCreateSignalModal({ preferredMessageKey: msgKey })
          }
          onCloneSignal={handleCloneSignal}
          onDeleteSignal={handleDeleteSignal}
          onAddValueTable={handleOpenCreateValueTableModal}
          onCloneValueTable={handleCloneValueTable}
          onDeleteValueTable={handleDeleteValueTable}
        />
      </div>

      {/* ================================================================== */}
      {/* DEDICATED DBC STUDIO OBJECT & TOOL MODALS                          */}
      {/* ================================================================== */}

      {modalState.kind === 'createMessage' && stagedMessageWithWasmLayout && (
        <CandbMessageDialog
          mode="create"
          message={stagedMessageWithWasmLayout}
          schema={stagedMessageDialogSchema}
          bitOverlaps={stagedMsgWasm.bitOverlaps}
          initialTab={modalState.initialTab}
          canMutate={canMutate}
          onUpdateMessage={handleUpdateStagedMessage}
          onCreateMessage={handleCommitCreateMessage}
          onDeleteMessage={handleCancelCreateMessage}
          onAddSignal={(_msgKey, startBit, openAfter = true) =>
            handleOpenCreateSignalModal({
              overrideStartBit: startBit,
              returnToMessageKey: stagedMessageWithWasmLayout.messageKey,
              returnToMessageTab: openAfter ? 'signals' : 'layout',
              targetIsStagedMessage: true,
            })
          }
          onUpdateSignal={handleUpdateStagedMessageSignal}
          onCloneSignal={handleCloneStagedMessageSignal}
          onDeleteSignal={handleDeleteStagedMessageSignal}
          onOpenSignalDialog={(sigId) =>
            setModalState({
              kind: 'signal',
              signalId: sigId,
              initialTab: 'definition',
              returnToMessageKey: stagedMessageWithWasmLayout.messageKey,
              editingStagedMessageSignal: true,
            })
          }
          onAddEcu={() =>
            handleOpenCreateEcuModal({
              kind: 'createMessage',
              initialTab: 'transmitters',
            })
          }
          onClose={handleCancelCreateMessage}
        />
      )}

      {modalState.kind === 'message' && activeDialogMessage && (
        <CandbMessageDialog
          mode="edit"
          message={activeDialogMessage}
          schema={effectiveSchema}
          bitOverlaps={bitOverlaps}
          initialTab={modalState.initialTab}
          canMutate={canMutate}
          onUpdateMessage={handleUpdateMessage}
          onDeleteMessage={handleDeleteMessage}
          onAddSignal={(msgKey, startBit, openAfter = true) =>
            handleOpenCreateSignalModal({
              preferredMessageKey: msgKey,
              overrideStartBit: startBit,
              returnToMessageKey: msgKey,
              returnToMessageTab: openAfter ? 'signals' : 'layout',
            })
          }
          onUpdateSignal={handleUpdateSignal}
          onCloneSignal={handleCloneSignal}
          onDeleteSignal={handleDeleteSignal}
          onOpenSignalDialog={(sigId, returnToMessageKey) =>
            setModalState({
              kind: 'signal',
              signalId: sigId,
              initialTab: 'definition',
              returnToMessageKey,
            })
          }
          onAddEcu={() =>
            handleOpenCreateEcuModal({
              kind: 'message',
              messageKey: activeDialogMessage.messageKey,
              initialTab: 'transmitters',
            })
          }
          onClose={() => setModalState({ kind: 'none' })}
        />
      )}

      {modalState.kind === 'createSignal' && stagedNewSignal && (
        <CandbSignalDialog
          mode="create"
          signal={stagedNewSignal}
          schema={
            modalState.targetIsStagedMessage && stagedNewMessage
              ? {
                  ...effectiveSchema,
                  messages: [
                    ...effectiveSchema.messages,
                    stagedNewMessage.message,
                  ],
                  signals: stagedNewMessage.signals,
                }
              : effectiveSchema
          }
          valueTables={valueTables}
          initialTab={modalState.initialTab}
          returnToMessageKey={modalState.returnToMessageKey}
          lockParentMessage={Boolean(modalState.targetIsStagedMessage)}
          canMutate={canMutate}
          onUpdateSignal={handleUpdateStagedSignal}
          onCreateSignal={handleCommitCreateSignal}
          onDeleteSignal={handleCancelCreateSignal}
          onSaveValueTableTemplate={(vt) => {
            setValueTables((prev) => [...prev, vt]);
            setIsDirty(true);
          }}
          onAddEcu={() => handleOpenCreateEcuModal(modalState)}
          onOpenParentMessage={() => handleCancelCreateSignal()}
          onClose={handleCancelCreateSignal}
        />
      )}

      {modalState.kind === 'signal' && activeDialogSignal && (
        <CandbSignalDialog
          mode="edit"
          signal={activeDialogSignal}
          schema={
            modalState.editingStagedMessageSignal && stagedNewMessage
              ? {
                  ...effectiveSchema,
                  messages: [
                    ...effectiveSchema.messages,
                    stagedNewMessage.message,
                  ],
                  signals: stagedNewMessage.signals,
                }
              : effectiveSchema
          }
          valueTables={valueTables}
          initialTab={modalState.initialTab}
          returnToMessageKey={modalState.returnToMessageKey}
          lockParentMessage={Boolean(modalState.editingStagedMessageSignal)}
          canMutate={canMutate}
          onUpdateSignal={
            modalState.editingStagedMessageSignal
              ? handleUpdateStagedMessageSignal
              : handleUpdateSignal
          }
          onDeleteSignal={
            modalState.editingStagedMessageSignal
              ? handleDeleteStagedMessageSignal
              : handleDeleteSignal
          }
          onSaveValueTableTemplate={(vt) => {
            setValueTables((prev) => [...prev, vt]);
            setIsDirty(true);
          }}
          onAddEcu={() => handleOpenCreateEcuModal(modalState)}
          onOpenParentMessage={(msgKey, openLayoutTab) => {
            if (modalState.editingStagedMessageSignal) {
              setModalState({
                kind: 'createMessage',
                initialTab: openLayoutTab ? 'layout' : 'signals',
              });
            } else {
              setModalState({
                kind: 'message',
                messageKey: msgKey,
                initialTab: openLayoutTab ? 'layout' : 'signals',
              });
            }
          }}
          onClose={() => {
            if (modalState.editingStagedMessageSignal) {
              setModalState({ kind: 'createMessage', initialTab: 'signals' });
            } else {
              setModalState({ kind: 'none' });
            }
          }}
        />
      )}

      {modalState.kind === 'createEcu' && stagedNewEcu && (
        <CandbEcuDialog
          mode="create"
          ecu={stagedNewEcu.ecu}
          schema={effectiveSchema}
          initialTab={modalState.initialTab}
          stagedTxMessageKeys={stagedNewEcu.txMessageKeys}
          stagedRxSignalIds={stagedNewEcu.rxSignalIds}
          canMutate={canMutate}
          onUpdateEcu={handleUpdateStagedEcu}
          onCreateEcu={handleCommitCreateEcu}
          onDeleteEcu={handleCancelCreateEcu}
          onToggleMessageTx={(msgKey) => handleToggleStagedEcuTx(msgKey)}
          onToggleSignalRx={(sigId) => handleToggleStagedEcuRx(sigId)}
          onOpenMessageDialog={() => undefined}
          onOpenSignalDialog={() => undefined}
          onClose={handleCancelCreateEcu}
        />
      )}

      {modalState.kind === 'ecu' && activeDialogEcu && (
        <CandbEcuDialog
          mode="edit"
          ecu={activeDialogEcu}
          schema={effectiveSchema}
          initialTab={modalState.initialTab}
          canMutate={canMutate}
          onUpdateEcu={handleUpdateEcu}
          onDeleteEcu={handleDeleteEcu}
          onToggleMessageTx={handleToggleMessageTx}
          onToggleSignalRx={handleToggleSignalRx}
          onOpenMessageDialog={(msgKey) =>
            setModalState({
              kind: 'message',
              messageKey: msgKey,
              initialTab: 'definition',
            })
          }
          onOpenSignalDialog={(sigId) =>
            setModalState({
              kind: 'signal',
              signalId: sigId,
              initialTab: 'definition',
            })
          }
          onClose={() => setModalState({ kind: 'none' })}
        />
      )}

      {modalState.kind === 'createValueTable' && stagedNewValueTable && (
        <CandbValueTableDialog
          mode="create"
          valueTable={stagedNewValueTable}
          tableIndex={-1}
          schema={effectiveSchema}
          canMutate={canMutate}
          onUpdateValueTable={(_idx, next) => setStagedNewValueTable(next)}
          onCreateValueTable={handleCommitCreateValueTable}
          onDeleteValueTable={handleCancelCreateValueTable}
          onApplyToSignal={() => undefined}
          onClose={handleCancelCreateValueTable}
        />
      )}

      {modalState.kind === 'valueTable' && activeDialogValueTable && (
        <CandbValueTableDialog
          mode="edit"
          valueTable={activeDialogValueTable}
          tableIndex={modalState.tableIndex}
          schema={effectiveSchema}
          canMutate={canMutate}
          onUpdateValueTable={(idx, next) => {
            setValueTables((prev) =>
              prev.map((item, i) => (i === idx ? next : item))
            );
            setIsDirty(true);
          }}
          onDeleteValueTable={handleDeleteValueTable}
          onApplyToSignal={(sigId, entries) =>
            handleUpdateSignal(sigId, { enumTable: entries })
          }
          onClose={() => setModalState({ kind: 'none' })}
        />
      )}

      {modalState.kind === 'network' && (
        <CandbNetworkDialog
          databaseName={databaseName}
          onChangeDatabaseName={(name) => {
            setDatabaseName(name);
            setIsDirty(true);
          }}
          dbcVersionString={draftSchema.info.version ?? ''}
          onChangeDbcVersionString={(ver) =>
            commitDraftMutation((prev) => ({
              ...prev,
              info: { ...prev.info, version: ver },
            }))
          }
          currentVersionBadge={currentVersionBadge}
          networkComment={networkComment}
          onChangeNetworkComment={(comment) => {
            setNetworkComment(comment);
            setIsDirty(true);
          }}
          canMutate={canMutate}
          onClose={() => setModalState({ kind: 'none' })}
        />
      )}

      {modalState.kind === 'commMatrix' && (
        <CandbCommMatrixModal
          schema={effectiveSchema}
          canMutate={canMutate}
          onAddEcu={() => handleOpenCreateEcuModal({ kind: 'commMatrix' })}
          onOpenMessageDialog={(msgKey) =>
            setModalState({
              kind: 'message',
              messageKey: msgKey,
              initialTab: 'definition',
            })
          }
          onOpenSignalDialog={(sigId) =>
            setModalState({
              kind: 'signal',
              signalId: sigId,
              initialTab: 'definition',
            })
          }
          onToggleMessageTx={handleToggleMessageTx}
          onToggleSignalRx={handleToggleSignalRx}
          onClose={() => setModalState({ kind: 'none' })}
        />
      )}

      {modalState.kind === 'consistency' && (
        <CandbConsistencyModal
          schema={effectiveSchema}
          isValidatingWasm={isValidatingWasm}
          wasmValid={wasmValid}
          compileError={compileError}
          diagnostics={wasmDiagnostics}
          bitOverlaps={bitOverlaps}
          onOpenMessageLayout={(msgKey) =>
            setModalState({
              kind: 'message',
              messageKey: msgKey,
              initialTab: 'layout',
            })
          }
          onClose={() => setModalState({ kind: 'none' })}
        />
      )}

      {modalState.kind === 'dbcSource' && (
        <CandbDbcSourceModal
          databaseName={sanitizeDbcIdentifier(databaseName, 'Vehicle_CAN')}
          dbcText={liveCanonicalDbcText}
          onDownloadDbc={handleDownloadDbc}
          onClose={() => setModalState({ kind: 'none' })}
        />
      )}

      {modalState.kind === 'saveAs' && (
        <CandbModalShell
          title={ls('saveAsTitle')}
          maxWidthClass="max-w-md"
          heightClass="h-auto"
          onClose={() => setModalState({ kind: 'none' })}
          footer={
            <>
              <span className="text-[11px] text-muted">{ls('saveAsHint')}</span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setModalState({ kind: 'none' })}
                  className="inline-flex h-7 cursor-pointer items-center rounded-[2px] border border-hairline bg-elevated px-3 text-xs text-ink hover:border-strong"
                >
                  {t('common.cancel')}
                </button>
                <button
                  type="button"
                  disabled={savingVersion || !saveAsName.trim()}
                  onClick={() => void executeSaveAs()}
                  className="inline-flex h-7 cursor-pointer items-center rounded-[2px] bg-focus px-4 text-xs font-semibold text-on-accent transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-45"
                >
                  {ls('saveAsConfirm')}
                </button>
              </div>
            </>
          }
        >
          <div className="space-y-1.5 p-5 text-xs">
            <label
              htmlFor="dbc-editor-save-as-name"
              className="block font-medium text-muted"
            >
              {ls('saveAsFileLabel')}
            </label>
            <input
              id="dbc-editor-save-as-name"
              type="text"
              autoFocus
              spellCheck={false}
              value={saveAsName}
              onChange={(e) => setSaveAsName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void executeSaveAs();
                }
              }}
              className="h-8 w-full rounded-[2px] border border-hairline bg-canvas px-2.5 font-mono text-xs tabular-nums text-ink focus:border-focus focus:outline-none"
            />
            {sourceFormat === 'kcd' && (
              <p className="text-[11px] text-warn">{ls('kcdNotice')}</p>
            )}
          </div>
        </CandbModalShell>
      )}

      {exitPromptOpen && (
        <CandbModalShell
          title={ls('exitTitle')}
          maxWidthClass="max-w-md"
          heightClass="h-auto"
          onClose={() => setExitPromptOpen(false)}
          footer={
            <>
              <button
                type="button"
                onClick={() => setExitPromptOpen(false)}
                className="inline-flex h-7 cursor-pointer items-center rounded-[2px] bg-focus px-4 text-xs font-semibold text-on-accent transition-opacity hover:opacity-90"
              >
                {ls('exitStay')}
              </button>
              <button
                type="button"
                onClick={onClose}
                className="inline-flex h-7 cursor-pointer items-center rounded-[2px] border border-hairline bg-elevated px-3 text-xs text-critical hover:border-strong"
              >
                {ls('exitDiscard')}
              </button>
            </>
          }
        >
          <p className="p-5 text-xs text-ink">{ls('exitBody')}</p>
        </CandbModalShell>
      )}
    </div>
  );
}
