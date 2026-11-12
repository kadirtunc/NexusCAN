import type { BlockDef, BlockCategory } from './types';

// ─── FLOW CATEGORY ────────────────────────────────────────────────────────────

const flowBlocks: BlockDef[] = [
  {
    type: 'start',
    labelKey: 'diagBlk.start',
    category: 'flow',
    descriptionKey: 'diagBlk.startsTheFlow',
    icon: 'Play',
    ports: [
      { id: 'exec_out', label: 'exec_out', type: 'exec', direction: 'output' },
    ],
    defaultConfig: {},
    configSchema: [],
  },
  {
    type: 'end',
    labelKey: 'diagBlk.end',
    category: 'flow',
    descriptionKey: 'diagBlk.endsTheFlow',
    icon: 'Square',
    ports: [
      { id: 'exec_in', label: 'exec_in', type: 'exec', direction: 'input' },
    ],
    defaultConfig: {},
    configSchema: [],
  },
  {
    type: 'delay',
    labelKey: 'diagBlk.waitMs',
    category: 'flow',
    descriptionKey: 'diagBlk.waitsForTheGivenDuration',
    icon: 'Timer',
    ports: [
      { id: 'exec_in',  label: 'exec_in',  type: 'exec', direction: 'input' },
      { id: 'exec_out', label: 'exec_out', type: 'exec', direction: 'output' },
    ],
    defaultConfig: { delay_ms: 1000 },
    configSchema: [
      { key: 'delay_ms', labelKey: 'diagBlk.delayMs', type: 'number', placeholder: '1000' },
    ],
  },
  {
    type: 'condition',
    labelKey: 'diagBlk.condition',
    category: 'flow',
    descriptionKey: 'diagBlk.branchesOnABooleanValue',
    icon: 'GitBranch',
    ports: [
      { id: 'exec_in',   label: 'exec_in',   type: 'exec', direction: 'input' },
      { id: 'bool_in',   label: 'bool_in',   type: 'bool', direction: 'input' },
      { id: 'true_out',  label: 'true_out',  type: 'exec', direction: 'output' },
      { id: 'false_out', label: 'false_out', type: 'exec', direction: 'output' },
    ],
    defaultConfig: {},
    configSchema: [],
  },
  {
    type: 'loop',
    labelKey: 'diagBlk.loop',
    category: 'flow',
    descriptionKey: 'diagBlk.repeatsTheGivenNumberOfTimes',
    icon: 'RefreshCw',
    ports: [
      { id: 'exec_in',  label: 'exec_in',  type: 'exec', direction: 'input' },
      { id: 'body_out', label: 'body_out', type: 'exec', direction: 'output' },
      { id: 'done_out', label: 'done_out', type: 'exec', direction: 'output' },
    ],
    defaultConfig: { iterations: 3 },
    configSchema: [
      { key: 'iterations', labelKey: 'diagBlk.iterations', type: 'number', placeholder: '3' },
    ],
  },
  {
    type: 'assert',
    labelKey: 'diagBlk.assert',
    category: 'flow',
    descriptionKey: 'diagBlk.validatesAValueTakesTheFail',
    icon: 'CheckCircle',
    ports: [
      { id: 'exec_in',  label: 'exec_in',  type: 'exec', direction: 'input' },
      { id: 'value_in', label: 'value_in', type: 'data', direction: 'input' },
      { id: 'pass_out', label: 'pass_out', type: 'exec', direction: 'output' },
      { id: 'fail_out', label: 'fail_out', type: 'exec', direction: 'output' },
    ],
    defaultConfig: { expected: '', operator: 'eq' },
    configSchema: [
      { key: 'expected', labelKey: 'diagBlk.expectedValue', type: 'text', placeholder: '' },
      {
        key: 'operator',
        labelKey: 'diagBlk.operator',
        type: 'select',
        options: [
          { value: 'eq',       labelKey: 'diagBlk.equal' },
          { value: 'neq',      labelKey: 'diagBlk.notEqual' },
          { value: 'gt',       labelKey: 'diagBlk.greater' },
          { value: 'lt',       labelKey: 'diagBlk.less' },
          { value: 'contains', labelKey: 'diagBlk.contains' },
        ],
      },
    ],
  },
  {
    type: 'log',
    labelKey: 'diagBlk.writeToLog',
    category: 'flow',
    descriptionKey: 'diagBlk.writesTheMessageToTheRun',
    icon: 'FileText',
    ports: [
      { id: 'exec_in',  label: 'exec_in',  type: 'exec', direction: 'input' },
      { id: 'value_in', label: 'value_in', type: 'data', direction: 'input', optional: true },
      { id: 'exec_out', label: 'exec_out', type: 'exec', direction: 'output' },
    ],
    defaultConfig: { message: '' },
    configSchema: [
      { key: 'message', labelKey: 'diagBlk.message', type: 'text', placeholderKey: 'diagBlk.messageText' },
    ],
  },

  // ── While Loop ───────────────────────────────────────────────────────────────
  {
    type: 'flow_while',
    labelKey: 'diagBlk.whileLoop',
    category: 'flow',
    descriptionKey: 'diagBlk.loopsWhileTheBooleanConditionIs',
    icon: 'IterationCw',
    ports: [
      { id: 'exec_in',  label: 'exec_in',  type: 'exec', direction: 'input' },
      { id: 'bool_in',  label: 'bool_in',  type: 'bool', direction: 'input' },
      { id: 'body_out', label: 'body_out', type: 'exec', direction: 'output' },
      { id: 'done_out', label: 'done_out', type: 'exec', direction: 'output' },
    ],
    defaultConfig: { max_iterations: 100 },
    configSchema: [
      { key: 'max_iterations', labelKey: 'diagBlk.maxIterationsSafety', type: 'number', placeholder: '100' },
    ],
  },

  // ── Timeout Guard ────────────────────────────────────────────────────────────
  {
    type: 'flow_timeout_guard',
    labelKey: 'diagBlk.timeoutGuard',
    category: 'flow',
    descriptionKey: 'diagBlk.ifTheEnclosedBlocksDoNot',
    icon: 'Timer',
    ports: [
      { id: 'exec_in',     label: 'exec_in',     type: 'exec', direction: 'input' },
      { id: 'exec_out',    label: 'exec_out',    type: 'exec', direction: 'output' },
      { id: 'timeout_out', label: 'timeout_out', type: 'exec', direction: 'output' },
    ],
    defaultConfig: { timeout_ms: 5000 },
    configSchema: [
      { key: 'timeout_ms', labelKey: 'diagBlk.timeoutMs', type: 'number', placeholder: '5000' },
    ],
  },
];

// ─── UDS CATEGORY ─────────────────────────────────────────────────────────────

const udsBlocks: BlockDef[] = [
  // ── 0x10 DiagnosticSessionControl ──────────────────────────────────────────
  {
    type: 'uds_session',
    label: 'Session Control (0x10)',
    category: 'uds',
    descriptionKey: 'diagBlk.opensAUDSDiagnosticSessionThe',
    icon: 'Wifi',
    ports: [
      { id: 'exec_in',     label: 'exec_in',     type: 'exec', direction: 'input' },
      { id: 'exec_out',    label: 'exec_out',    type: 'exec', direction: 'output' },
      { id: 'error_out',   label: 'error_out',   type: 'exec', direction: 'output' },
      { id: 'session_out', label: 'session_out', type: 'data', direction: 'output' },
    ],
    defaultConfig: { session_type: 'extended' },
    configSchema: [
      {
        key: 'session_type',
        labelKey: 'diagBlk.sessionType',
        type: 'select',
        options: [
          { value: 'default',      label: 'Default (0x01)' },
          { value: 'programming',  label: 'Programming (0x02)' },
          { value: 'extended',     label: 'Extended Diagnostic (0x03)' },
          { value: 'safety',       label: 'Safety System (0x04)' },
        ],
      },
    ],
  },

  // ── 0x11 ECUReset ──────────────────────────────────────────────────────────
  {
    type: 'uds_ecu_reset',
    label: 'ECU Reset (0x11)',
    category: 'uds',
    descriptionKey: 'diagBlk.resetsTheECURequiresAProgramming',
    icon: 'RotateCcw',
    ports: [
      { id: 'exec_in',   label: 'exec_in',   type: 'exec', direction: 'input' },
      { id: 'exec_out',  label: 'exec_out',  type: 'exec', direction: 'output' },
      { id: 'error_out', label: 'error_out', type: 'exec', direction: 'output' },
    ],
    defaultConfig: { reset_type: 'hardReset' },
    configSchema: [
      {
        key: 'reset_type',
        labelKey: 'diagBlk.resetType',
        type: 'select',
        options: [
          { value: 'hardReset',               label: 'Hard Reset (0x01)' },
          { value: 'keyOffOnReset',           label: 'Key Off/On Reset (0x02)' },
          { value: 'softReset',               label: 'Soft Reset (0x03)' },
          { value: 'enableRapidPowerShutDown',label: 'Rapid Power Shutdown (0x04)' },
        ],
      },
    ],
  },

  // ── 0x14 ClearDiagnosticInformation ────────────────────────────────────────
  {
    type: 'uds_clear_dtc',
    label: 'Clear DTC (0x14)',
    category: 'uds',
    descriptionKey: 'diagBlk.clearsTheGivenDTCGroup0xFFFFFF',
    icon: 'Trash2',
    ports: [
      { id: 'exec_in',   label: 'exec_in',   type: 'exec', direction: 'input' },
      { id: 'exec_out',  label: 'exec_out',  type: 'exec', direction: 'output' },
      { id: 'error_out', label: 'error_out', type: 'exec', direction: 'output' },
    ],
    defaultConfig: { group: 'FFFFFF' },
    configSchema: [
      { key: 'group', labelKey: 'diagBlk.dtcGroupHex3Bytes', type: 'hex', placeholder: 'FFFFFF' },
    ],
  },

  // ── 0x19 ReadDTCInformation ─────────────────────────────────────────────────
  {
    type: 'uds_read_dtc',
    label: 'Read DTC (0x19)',
    category: 'uds',
    descriptionKey: 'diagBlk.readsFaultCodesTheReadType',
    icon: 'AlertTriangle',
    ports: [
      { id: 'exec_in',      label: 'exec_in',      type: 'exec', direction: 'input' },
      { id: 'exec_out',     label: 'exec_out',     type: 'exec', direction: 'output' },
      { id: 'error_out',    label: 'error_out',    type: 'exec', direction: 'output' },
      { id: 'dtc_list_out', label: 'dtc_list_out', type: 'data', direction: 'output' },
      { id: 'count_out',    label: 'count_out',    type: 'data', direction: 'output' },
    ],
    defaultConfig: { sub_fn: '02', status_mask: 'FF' },
    configSchema: [
      {
        key: 'sub_fn',
        labelKey: 'diagBlk.subFunction',
        type: 'select',
        options: [
          { value: '01', label: '0x01 — reportNumberOfDTCByStatusMask' },
          { value: '02', label: '0x02 — reportDTCByStatusMask' },
          { value: '03', label: '0x03 — reportDTCSnapshotIdentification' },
          { value: '04', label: '0x04 — reportDTCSnapshotRecordByDTCNumber' },
          { value: '05', label: '0x05 — reportDTCStoredDataByRecordNumber' },
          { value: '06', label: '0x06 — reportDTCExtDataRecordByDTCNumber' },
          { value: '07', label: '0x07 — reportNumberOfDTCBySeverityMask' },
          { value: '08', label: '0x08 — reportDTCBySeverityMaskRecord' },
          { value: '09', label: '0x09 — reportSeverityInformationOfDTC' },
          { value: '0A', label: '0x0A — reportSupportedDTC' },
          { value: '0B', label: '0x0B — reportFirstTestFailedDTC' },
          { value: '0C', label: '0x0C — reportFirstConfirmedDTC' },
          { value: '0D', label: '0x0D — reportMostRecentTestFailedDTC' },
          { value: '0E', label: '0x0E — reportMostRecentConfirmedDTC' },
          { value: '0F', label: '0x0F — reportMirrorMemoryDTCByStatusMask' },
          { value: '11', label: '0x11 — reportNumberOfMirrorMemoryDTCByStatusMask' },
          { value: '14', label: '0x14 — reportDTCFaultDetectionCounter' },
          { value: '15', label: '0x15 — reportDTCWithPermanentStatus' },
          { value: '42', label: '0x42 — reportWWHOBDDTCByMaskRecord' },
          { value: '55', label: '0x55 — reportWWHOBDDTCWithPermanentStatus' },
        ],
      },
      { key: 'status_mask', labelKey: 'diagBlk.statusMaskHex', type: 'hex', placeholder: 'FF' },
    ],
  },

  // ── 0x22 ReadDataByIdentifier ───────────────────────────────────────────────
  {
    type: 'uds_read_did',
    label: 'Read DID (0x22)',
    category: 'uds',
    descriptionKey: 'diagBlk.readsADataIdentifierDIDMultiple',
    icon: 'Download',
    ports: [
      { id: 'exec_in',   label: 'exec_in',   type: 'exec',  direction: 'input' },
      { id: 'exec_out',  label: 'exec_out',  type: 'exec',  direction: 'output' },
      { id: 'error_out', label: 'error_out', type: 'exec',  direction: 'output' },
      { id: 'data_out',  label: 'data_out',  type: 'bytes', direction: 'output' },
    ],
    defaultConfig: { did: 'F190' },
    configSchema: [
      { key: 'did', label: 'DID (hex, 2 byte)', type: 'hex', placeholder: 'F190' },
    ],
  },

  // ── 0x23 ReadMemoryByAddress ────────────────────────────────────────────────
  {
    type: 'uds_read_memory',
    label: 'Read Memory (0x23)',
    category: 'uds',
    descriptionKey: 'diagBlk.readsDataDirectlyFromAMemory',
    icon: 'Database',
    ports: [
      { id: 'exec_in',   label: 'exec_in',   type: 'exec',  direction: 'input' },
      { id: 'exec_out',  label: 'exec_out',  type: 'exec',  direction: 'output' },
      { id: 'error_out', label: 'error_out', type: 'exec',  direction: 'output' },
      { id: 'data_out',  label: 'data_out',  type: 'bytes', direction: 'output' },
    ],
    defaultConfig: { memory_address: '08000000', memory_size: '00000010' },
    configSchema: [
      { key: 'memory_address', labelKey: 'diagBlk.memoryAddressHex', type: 'hex', placeholder: '08000000' },
      { key: 'memory_size',    labelKey: 'diagBlk.sizeHexBytes',   type: 'hex', placeholder: '00000010' },
    ],
  },

  // ── 0x27 SecurityAccess ─────────────────────────────────────────────────────
  {
    type: 'uds_security_access',
    label: 'Security Access (0x27)',
    category: 'uds',
    descriptionKey: 'diagBlk.twoStepSecurityAccess1Request',
    icon: 'Lock',
    ports: [
      { id: 'exec_in',     label: 'exec_in',     type: 'exec',  direction: 'input' },
      { id: 'seed_out',    label: 'seed_out',    type: 'bytes', direction: 'output' },
      { id: 'key_in',      label: 'key_in',      type: 'bytes', direction: 'input', optional: true },
      { id: 'success_out', label: 'success_out', type: 'exec',  direction: 'output' },
      { id: 'error_out',   label: 'error_out',   type: 'exec',  direction: 'output' },
    ],
    defaultConfig: {
      access_level: '01',
      algorithm: 'xor_ff',
      constant: '5A3C1E8F',
      script: `// Rhai (sandboxed, runs in the backend). seed: blob, level: int
// Return a blob or an array of ints 0..255
fn calculate_key(seed, level) {
  let key = blob();
  for b in seed { key.push(b ^ 0xFF); }
  key
}`,
    },
    configSchema: [
      {
        key: 'access_level',
        labelKey: 'diagBlk.accessLevelOddSubFnHex',
        type: 'hex',
        placeholder: '01',
      },
      {
        key: 'algorithm',
        labelKey: 'diagBlk.keyAlgorithm',
        type: 'select',
        options: [
          { value: 'xor_ff',       label: 'XOR 0xFF  —  key[i] = seed[i] ^ 0xFF' },
          { value: 'xor_const',    labelKey: 'diagBlk.xorConstantKeySeedXORConstant' },
          { value: 'sum_negate',   label: 'Byte Sum Negate  —  key = ~sum(seed)' },
          { value: 'add_const',    labelKey: 'diagBlk.seedConstantKeySeedConstant' },
          { value: 'right_rotate', label: 'Right Rotate 2  —  key = ROR(seed,2) ^ const' },
          { value: 'crc16',        label: 'CRC-16/IBM  —  key = CRC16(seed)' },
          { value: 'crc32',        label: 'CRC-32  —  key = CRC32(seed)' },
          { value: 'custom',       label: 'Custom Script (Rhai)' },
        ],
      },
      {
        key: 'constant',
        labelKey: 'diagBlk.constantValueForXorConstAdd',
        type: 'hex',
        placeholder: '5A3C1E8F',
      },
      {
        key: 'script',
        labelKey: 'diagBlk.customScriptActiveWhenAlgorithmCustom',
        type: 'code',
        placeholder: 'fn calculate_key(seed, level) { ... }',
      },
    ],
  },

  // ── 0x28 CommunicationControl ───────────────────────────────────────────────
  {
    type: 'uds_comm_control',
    label: 'Comm. Control (0x28)',
    category: 'uds',
    descriptionKey: 'diagBlk.controlsNetworkCommunicationTxRxShould',
    icon: 'Radio',
    ports: [
      { id: 'exec_in',   label: 'exec_in',   type: 'exec', direction: 'input' },
      { id: 'exec_out',  label: 'exec_out',  type: 'exec', direction: 'output' },
      { id: 'error_out', label: 'error_out', type: 'exec', direction: 'output' },
    ],
    defaultConfig: { control_type: '03', comm_type: '01' },
    configSchema: [
      {
        key: 'control_type',
        labelKey: 'diagBlk.controlType',
        type: 'select',
        options: [
          { value: '00', label: '0x00 — enableRxAndTx' },
          { value: '01', label: '0x01 — enableRxAndDisableTx' },
          { value: '02', label: '0x02 — disableRxAndEnableTx' },
          { value: '03', labelKey: 'diagBlk.0x03DisableRxAndTxBeforeFlashing' },
        ],
      },
      {
        key: 'comm_type',
        labelKey: 'diagBlk.communicationType',
        type: 'select',
        options: [
          { value: '01', label: '0x01 — normalCommunicationMessages' },
          { value: '02', label: '0x02 — nmCommunicationMessages' },
          { value: '03', label: '0x03 — networkManagementCommunicationMessages' },
        ],
      },
    ],
  },

  // ── 0x2E WriteDataByIdentifier ──────────────────────────────────────────────
  {
    type: 'uds_write_did',
    label: 'Write DID (0x2E)',
    category: 'uds',
    descriptionKey: 'diagBlk.writesToADataIdentifierRequires',
    icon: 'Upload',
    ports: [
      { id: 'exec_in',   label: 'exec_in',   type: 'exec',  direction: 'input' },
      { id: 'data_in',   label: 'data_in',   type: 'bytes', direction: 'input' },
      { id: 'exec_out',  label: 'exec_out',  type: 'exec',  direction: 'output' },
      { id: 'error_out', label: 'error_out', type: 'exec',  direction: 'output' },
    ],
    defaultConfig: { did: 'F190' },
    configSchema: [
      { key: 'did', label: 'DID (hex, 2 byte)', type: 'hex', placeholder: 'F190' },
    ],
  },

  // ── 0x2F InputOutputControlByIdentifier ────────────────────────────────────
  {
    type: 'uds_io_control',
    label: 'IO Control (0x2F)',
    category: 'uds',
    descriptionKey: 'diagBlk.actuatorSensorControlUsedForDiagnostic',
    icon: 'Zap',
    ports: [
      { id: 'exec_in',   label: 'exec_in',   type: 'exec', direction: 'input' },
      { id: 'exec_out',  label: 'exec_out',  type: 'exec', direction: 'output' },
      { id: 'error_out', label: 'error_out', type: 'exec', direction: 'output' },
      { id: 'data_out',  label: 'data_out',  type: 'bytes', direction: 'output' },
    ],
    defaultConfig: { did: '3001', io_control: '03', control_value: '00' },
    configSchema: [
      { key: 'did', label: 'Data Identifier (hex)', type: 'hex', placeholder: '3001' },
      {
        key: 'io_control',
        label: 'Control Option',
        type: 'select',
        options: [
          { value: '00', label: '0x00 — returnControlToECU' },
          { value: '01', label: '0x01 — resetToDefault' },
          { value: '02', label: '0x02 — freezeCurrentState' },
          { value: '03', label: '0x03 — shortTermAdjustment' },
        ],
      },
      { key: 'control_value', label: 'Control Value (hex)', type: 'hex', placeholder: '00' },
    ],
  },

  // ── 0x31 RoutineControl ─────────────────────────────────────────────────────
  {
    type: 'uds_routine_ctrl',
    label: 'Routine Control (0x31)',
    category: 'uds',
    descriptionKey: 'diagBlk.routineControlForOperationsSuchAs',
    icon: 'Cpu',
    ports: [
      { id: 'exec_in',    label: 'exec_in',    type: 'exec', direction: 'input' },
      { id: 'exec_out',   label: 'exec_out',   type: 'exec', direction: 'output' },
      { id: 'result_out', label: 'result_out', type: 'data', direction: 'output' },
      { id: 'error_out',  label: 'error_out',  type: 'exec', direction: 'output' },
    ],
    defaultConfig: { control_type: '01', routine_id: 'FF00' },
    configSchema: [
      {
        key: 'control_type',
        labelKey: 'diagBlk.controlType',
        type: 'select',
        options: [
          { value: '01', label: '0x01 — startRoutine' },
          { value: '02', label: '0x02 — stopRoutine' },
          { value: '03', label: '0x03 — requestRoutineResults' },
        ],
      },
      {
        key: 'routine_id',
        labelKey: 'diagBlk.routineIDHex2Bytes',
        type: 'select',
        options: [
          { value: 'FF00', label: '0xFF00 — eraseMemory' },
          { value: '0202', label: '0x0202 — checkProgrammingDependencies' },
          { value: '0203', label: '0x0203 — eraseMirrorMemoryDTCs' },
          { value: 'DF01', label: '0xDF01 — checkMemoryIntegrity (CRC/Checksum)' },
          { value: 'E200', label: '0xE200 — requestSoftwareUpdate' },
          { value: 'custom', labelKey: 'diagBlk.customEnterInTheFieldBelow' },
        ],
      },
      { key: 'routine_id_custom', labelKey: 'diagBlk.customRoutineIDHex', type: 'hex', placeholder: '0203' },
    ],
  },

  // ── 0x34 RequestDownload ────────────────────────────────────────────────────
  {
    type: 'uds_req_download',
    label: 'Request Download (0x34)',
    category: 'uds',
    descriptionKey: 'diagBlk.memoryWriteRequestRequiresProgrammingSession',
    icon: 'HardDrive',
    ports: [
      { id: 'exec_in',   label: 'exec_in',   type: 'exec', direction: 'input' },
      { id: 'exec_out',  label: 'exec_out',  type: 'exec', direction: 'output' },
      { id: 'error_out', label: 'error_out', type: 'exec', direction: 'output' },
      { id: 'max_block_out', label: 'max_block_out', type: 'data', direction: 'output' },
    ],
    defaultConfig: { memory_address: '08000000', memory_size: '00010000', data_format: '00' },
    configSchema: [
      { key: 'memory_address', labelKey: 'diagBlk.memoryAddressHex', type: 'hex', placeholder: '08000000' },
      { key: 'memory_size',    labelKey: 'diagBlk.sizeHex',         type: 'hex', placeholder: '00010000' },
      {
        key: 'data_format',
        labelKey: 'diagBlk.dataFormat',
        type: 'select',
        options: [
          { value: '00', labelKey: 'diagBlk.0x00NoCompressionNoEncryption' },
          { value: '11', labelKey: 'diagBlk.0x11CompressedNotEncrypted' },
          { value: '01', labelKey: 'diagBlk.0x01EncryptedOEMDefined' },
        ],
      },
    ],
  },

  // ── 0x35 RequestUpload ──────────────────────────────────────────────────────
  {
    type: 'uds_req_upload',
    label: 'Request Upload (0x35)',
    category: 'uds',
    descriptionKey: 'diagBlk.uploadsReadsDataFromTheECU',
    icon: 'Upload',
    ports: [
      { id: 'exec_in',       label: 'exec_in',       type: 'exec', direction: 'input' },
      { id: 'exec_out',      label: 'exec_out',      type: 'exec', direction: 'output' },
      { id: 'error_out',     label: 'error_out',     type: 'exec', direction: 'output' },
      { id: 'max_block_out', label: 'max_block_out', type: 'data', direction: 'output' },
    ],
    defaultConfig: { memory_address: '08000000', memory_size: '00010000', data_format: '00' },
    configSchema: [
      { key: 'memory_address', labelKey: 'diagBlk.memoryAddressHex', type: 'hex', placeholder: '08000000' },
      { key: 'memory_size',    labelKey: 'diagBlk.sizeHex',         type: 'hex', placeholder: '00010000' },
      { key: 'data_format',    labelKey: 'diagBlk.dataFormatHex', type: 'hex', placeholder: '00' },
    ],
  },

  // ── 0x36 TransferData ───────────────────────────────────────────────────────
  {
    type: 'uds_transfer_data',
    label: 'Transfer Data (0x36)',
    category: 'uds',
    descriptionKey: 'diagBlk.transfersDataBlocksTheBlockSequence',
    icon: 'ArrowRightLeft',
    ports: [
      { id: 'exec_in',      label: 'exec_in',      type: 'exec',  direction: 'input' },
      { id: 'chunk_in',     label: 'chunk_in',     type: 'bytes', direction: 'input', optional: true },
      { id: 'exec_out',     label: 'exec_out',     type: 'exec',  direction: 'output' },
      { id: 'error_out',    label: 'error_out',    type: 'exec',  direction: 'output' },
      { id: 'progress_out', label: 'progress_out', type: 'data',  direction: 'output' },
    ],
    defaultConfig: { chunk_size: '0800' },
    configSchema: [
      { key: 'chunk_size', labelKey: 'diagBlk.chunkSizeHexBytes', type: 'hex', placeholder: '0800' },
    ],
  },

  // ── 0x37 RequestTransferExit ────────────────────────────────────────────────
  {
    type: 'uds_transfer_exit',
    label: 'Transfer Exit (0x37)',
    category: 'uds',
    descriptionKey: 'diagBlk.endsTheTransferSessionCalledAfter',
    icon: 'LogOut',
    ports: [
      { id: 'exec_in',   label: 'exec_in',   type: 'exec', direction: 'input' },
      { id: 'exec_out',  label: 'exec_out',  type: 'exec', direction: 'output' },
      { id: 'error_out', label: 'error_out', type: 'exec', direction: 'output' },
    ],
    defaultConfig: {},
    configSchema: [],
  },

  // ── 0x3D WriteMemoryByAddress ───────────────────────────────────────────────
  {
    type: 'uds_write_memory',
    label: 'Write Memory (0x3D)',
    category: 'uds',
    descriptionKey: 'diagBlk.writesDirectlyToAMemoryAddress',
    icon: 'PenLine',
    ports: [
      { id: 'exec_in',   label: 'exec_in',   type: 'exec',  direction: 'input' },
      { id: 'data_in',   label: 'data_in',   type: 'bytes', direction: 'input' },
      { id: 'exec_out',  label: 'exec_out',  type: 'exec',  direction: 'output' },
      { id: 'error_out', label: 'error_out', type: 'exec',  direction: 'output' },
    ],
    defaultConfig: { memory_address: '08000000', memory_size: '00000010' },
    configSchema: [
      { key: 'memory_address', labelKey: 'diagBlk.memoryAddressHex', type: 'hex', placeholder: '08000000' },
      { key: 'memory_size',    labelKey: 'diagBlk.sizeHex',         type: 'hex', placeholder: '00000010' },
    ],
  },

  // ── 0x3E TesterPresent ──────────────────────────────────────────────────────
  {
    type: 'uds_tester_present',
    label: 'Tester Present (0x3E)',
    category: 'uds',
    descriptionKey: 'diagBlk.keepsTheSessionAliveMustBe',
    icon: 'Activity',
    ports: [
      { id: 'exec_in',  label: 'exec_in',  type: 'exec', direction: 'input' },
      { id: 'exec_out', label: 'exec_out', type: 'exec', direction: 'output' },
    ],
    defaultConfig: { suppress: true },
    configSchema: [
      {
        key: 'suppress',
        labelKey: 'diagBlk.suppressResponseSuppressPosRspMsgIndicationBit',
        type: 'boolean',
      },
    ],
  },

  // ── 0x85 ControlDTCSetting ──────────────────────────────────────────────────
  {
    type: 'uds_dtc_setting',
    label: 'DTC Setting (0x85)',
    category: 'uds',
    descriptionKey: 'diagBlk.enablesDisablesDTCStorageMustBe',
    icon: 'BellOff',
    ports: [
      { id: 'exec_in',   label: 'exec_in',   type: 'exec', direction: 'input' },
      { id: 'exec_out',  label: 'exec_out',  type: 'exec', direction: 'output' },
      { id: 'error_out', label: 'error_out', type: 'exec', direction: 'output' },
    ],
    defaultConfig: { setting_type: '02' },
    configSchema: [
      {
        key: 'setting_type',
        label: 'DTC Setting Tipi',
        type: 'select',
        options: [
          { value: '01', label: '0x01 — on  (DTCSettingOn)' },
          { value: '02', label: '0x02 — off (DTCSettingOff)' },
        ],
      },
    ],
  },

  // ── Lockout Guard (NRC 0x36 protection) ────────────────────────────────────
  {
    type: 'uds_lockout_guard',
    label: 'Lockout Guard (0x36/0x37)',
    category: 'uds',
    descriptionKey: 'diagBlk.nrc0x36ExceededNumberOfAttemptsGuardFailedAttempts',
    icon: 'ShieldAlert',
    ports: [
      { id: 'exec_in',   label: 'exec_in',   type: 'exec', direction: 'input' },
      { id: 'exec_out',  label: 'exec_out',  type: 'exec', direction: 'output' },
      { id: 'delay_out', label: 'delay_out', type: 'exec', direction: 'output' },
      { id: 'error_out', label: 'error_out', type: 'exec', direction: 'output' },
    ],
    defaultConfig: { max_attempts: 3, lockout_ms: 10000 },
    configSchema: [
      { key: 'max_attempts', labelKey: 'diagBlk.maxAttempts', type: 'number', placeholder: '3' },
      { key: 'lockout_ms',   labelKey: 'diagBlk.lockoutTimeMs',       type: 'number', placeholder: '10000' },
    ],
  },

  // ── Seed/Key Validator ──────────────────────────────────────────────────────
  {
    type: 'uds_seed_validator',
    labelKey: 'diagBlk.seedKeyValidator',
    category: 'uds',
    descriptionKey: 'diagBlk.comparesTheComputedKeyWithThe',
    icon: 'KeyRound',
    ports: [
      { id: 'exec_in',    label: 'exec_in',    type: 'exec',  direction: 'input' },
      { id: 'seed_in',    label: 'seed_in',    type: 'bytes', direction: 'input' },
      { id: 'key_in',     label: 'key_in',     type: 'bytes', direction: 'input' },
      { id: 'pass_out',   label: 'pass_out',   type: 'exec',  direction: 'output' },
      { id: 'fail_out',   label: 'fail_out',   type: 'exec',  direction: 'output' },
      { id: 'result_out', label: 'result_out', type: 'data',  direction: 'output' },
    ],
    defaultConfig: { expected_key: 'C9A8', algorithm: 'xor_ff' },
    configSchema: [
      { key: 'expected_key', labelKey: 'diagBlk.expectedKeyHex', type: 'hex', placeholder: 'C9A8' },
      {
        key: 'algorithm',
        labelKey: 'diagBlk.keyAlgorithm',
        type: 'select',
        options: [
          { value: 'xor_ff',       label: 'XOR 0xFF  —  key[i] = seed[i] ^ 0xFF' },
          { value: 'xor_const',    labelKey: 'diagBlk.xorConstantKeySeedXORConstant' },
          { value: 'sum_negate',   label: 'Byte Sum Negate  —  key = ~sum(seed)' },
          { value: 'add_const',    labelKey: 'diagBlk.seedConstantKeySeedConstant' },
          { value: 'right_rotate', label: 'Right Rotate 2  —  key = ROR(seed,2) ^ const' },
          { value: 'crc16',        label: 'CRC-16/IBM  —  key = CRC16(seed)' },
          { value: 'crc32',        label: 'CRC-32  —  key = CRC32(seed)' },
          { value: 'custom',       label: 'Custom Script (Rhai)' },
        ],
      },
    ],
  },

  // ── 0x87 LinkControl ────────────────────────────────────────────────────────
  {
    type: 'uds_link_control',
    label: 'Link Control (0x87)',
    category: 'uds',
    descriptionKey: 'diagBlk.twoStepBaudrateChange1Verify',
    icon: 'Network',
    ports: [
      { id: 'exec_in',   label: 'exec_in',   type: 'exec', direction: 'input' },
      { id: 'exec_out',  label: 'exec_out',  type: 'exec', direction: 'output' },
      { id: 'error_out', label: 'error_out', type: 'exec', direction: 'output' },
    ],
    defaultConfig: { link_control_type: '01', link_baudrate_id: '05' },
    configSchema: [
      {
        key: 'link_control_type',
        labelKey: 'diagBlk.controlType',
        type: 'select',
        options: [
          { value: '01', label: '0x01 — verifyModeTransitionWithFixedParameter' },
          { value: '02', label: '0x02 — verifyModeTransitionWithSpecificParameter' },
          { value: '03', labelKey: 'diagBlk.0x03TransitionModeAfterVerification' },
        ],
      },
      {
        key: 'link_baudrate_id',
        labelKey: 'diagBlk.baudrateIDForFixedParameter',
        type: 'select',
        options: [
          { value: '01', label: '0x01 — PC9600Baud' },
          { value: '02', label: '0x02 — PC19200Baud' },
          { value: '03', label: '0x03 — PC38400Baud' },
          { value: '04', label: '0x04 — PC57600Baud' },
          { value: '05', label: '0x05 — PC115200Baud' },
          { value: '10', label: '0x10 — CAN125Kbps' },
          { value: '11', label: '0x11 — CAN250Kbps' },
          { value: '12', label: '0x12 — CAN500Kbps' },
          { value: '13', label: '0x13 — CAN1Mbps' },
          { value: '20', label: '0x20 — ProgrammingSetup' },
        ],
      },
    ],
  },
];

// ─── DATA CATEGORY ────────────────────────────────────────────────────────────

const dataBlocks: BlockDef[] = [
  {
    type: 'data_const',
    labelKey: 'diagBlk.constant',
    category: 'data',
    descriptionKey: 'diagBlk.outputsAConstantValue',
    icon: 'Hash',
    ports: [
      { id: 'value_out', label: 'value_out', type: 'data', direction: 'output' },
    ],
    defaultConfig: { value: '', format: 'text' },
    configSchema: [
      { key: 'value', labelKey: 'diagBlk.value', type: 'text', placeholder: '' },
      {
        key: 'format',
        label: 'Format',
        type: 'select',
        options: [
          { value: 'text', labelKey: 'diagBlk.text' },
          { value: 'hex',  label: 'Hex' },
          { value: 'dec',  label: 'Decimal' },
        ],
      },
    ],
  },
  {
    type: 'data_var',
    labelKey: 'diagBlk.variable',
    category: 'data',
    descriptionKey: 'diagBlk.storesAndReadsAValue',
    icon: 'Variable',
    ports: [
      { id: 'set_in',  label: 'set_in',  type: 'data', direction: 'input', optional: true },
      { id: 'get_out', label: 'get_out', type: 'data', direction: 'output' },
    ],
    defaultConfig: { name: 'myVar', initial: '' },
    configSchema: [
      { key: 'name',    labelKey: 'diagBlk.variableName', type: 'text', placeholder: 'myVar' },
      { key: 'initial', labelKey: 'diagBlk.initialValue', type: 'text', placeholder: '' },
    ],
  },
  {
    type: 'data_compare',
    labelKey: 'diagBlk.compare',
    category: 'data',
    descriptionKey: 'diagBlk.comparesTwoValues',
    icon: 'Equal',
    ports: [
      { id: 'left_in',    label: 'left_in',    type: 'data', direction: 'input' },
      { id: 'right_in',   label: 'right_in',   type: 'data', direction: 'input' },
      { id: 'result_out', label: 'result_out', type: 'bool', direction: 'output' },
    ],
    defaultConfig: { operator: 'eq' },
    configSchema: [
      {
        key: 'operator',
        labelKey: 'diagBlk.operator',
        type: 'select',
        options: [
          { value: 'eq',  labelKey: 'diagBlk.equal' },
          { value: 'neq', labelKey: 'diagBlk.notEqual' },
          { value: 'gt',  labelKey: 'diagBlk.greater' },
          { value: 'lt',  labelKey: 'diagBlk.less' },
        ],
      },
    ],
  },
  {
    type: 'data_extract',
    labelKey: 'diagBlk.extractBytes',
    category: 'data',
    descriptionKey: 'diagBlk.extractsAValueFromAByte',
    icon: 'Scissors',
    ports: [
      { id: 'bytes_in',  label: 'bytes_in',  type: 'bytes', direction: 'input' },
      { id: 'value_out', label: 'value_out', type: 'data',  direction: 'output' },
    ],
    defaultConfig: { offset: 0, length: 1 },
    configSchema: [
      { key: 'offset', labelKey: 'diagBlk.startByte', type: 'number', placeholder: '0' },
      { key: 'length', labelKey: 'diagBlk.lengthBytes',   type: 'number', placeholder: '1' },
    ],
  },

  // ── Byte Builder ─────────────────────────────────────────────────────────────
  {
    type: 'data_byte_builder',
    labelKey: 'diagBlk.byteBuilder',
    category: 'data',
    descriptionKey: 'diagBlk.buildsAByteArrayFromA',
    icon: 'Braces',
    ports: [
      { id: 'value_in',  label: 'value_in',  type: 'data',  direction: 'input', optional: true },
      { id: 'bytes_out', label: 'bytes_out', type: 'bytes', direction: 'output' },
    ],
    defaultConfig: { template: '00 00 00 00', format: 'hex' },
    configSchema: [
      { key: 'template', labelKey: 'diagBlk.templateHexBytes', type: 'hex', placeholder: '00 11 22 33' },
      {
        key: 'format',
        label: 'Format',
        type: 'select',
        options: [
          { value: 'hex',     label: 'Hex' },
          { value: 'ascii',   label: 'ASCII' },
          { value: 'decimal', labelKey: 'diagBlk.decimalCommaSeparated' },
        ],
      },
    ],
  },

  // ── Bitfield Extract ──────────────────────────────────────────────────────────
  {
    type: 'data_bitfield_extract',
    labelKey: 'diagBlk.extractBitField',
    category: 'data',
    descriptionKey: 'diagBlk.extractsABitRangeFromA',
    icon: 'SplitSquareHorizontal',
    ports: [
      { id: 'bytes_in',  label: 'bytes_in',  type: 'bytes', direction: 'input' },
      { id: 'value_out', label: 'value_out', type: 'data',  direction: 'output' },
    ],
    defaultConfig: { byte_offset: 0, bit_high: 7, bit_low: 0 },
    configSchema: [
      { key: 'byte_offset', labelKey: 'diagBlk.byteOffset',      type: 'number', placeholder: '0' },
      { key: 'bit_high',    labelKey: 'diagBlk.highBit70', type: 'number', placeholder: '7' },
      { key: 'bit_low',     labelKey: 'diagBlk.lowBit70',  type: 'number', placeholder: '0' },
    ],
  },

  // ── Checksum ──────────────────────────────────────────────────────────────────
  {
    type: 'data_checksum',
    labelKey: 'diagBlk.computeChecksum',
    category: 'data',
    descriptionKey: 'diagBlk.standaloneCRCChecksumCalculatorUsedFor',
    icon: 'Hash',
    ports: [
      { id: 'exec_in',      label: 'exec_in',      type: 'exec',  direction: 'input' },
      { id: 'data_in',      label: 'data_in',      type: 'bytes', direction: 'input' },
      { id: 'exec_out',     label: 'exec_out',     type: 'exec',  direction: 'output' },
      { id: 'checksum_out', label: 'checksum_out', type: 'data',  direction: 'output' },
    ],
    defaultConfig: { algorithm: 'crc32', output_format: 'hex' },
    configSchema: [
      {
        key: 'algorithm',
        labelKey: 'diagBlk.algorithm',
        type: 'select',
        options: [
          { value: 'crc16',    label: 'CRC-16/IBM' },
          { value: 'crc32',    label: 'CRC-32' },
          { value: 'xor_sum',  label: 'XOR Sum' },
          { value: 'add_sum',  label: 'Add Sum (8-bit)' },
        ],
      },
      {
        key: 'output_format',
        labelKey: 'diagBlk.outputFormat',
        type: 'select',
        options: [
          { value: 'hex',    label: 'Hex String' },
          { value: 'bytes',  label: 'Byte Array' },
          { value: 'number', label: 'Number' },
        ],
      },
    ],
  },
];

// ─── IO CATEGORY ──────────────────────────────────────────────────────────────

const ioBlocks: BlockDef[] = [
  {
    type: 'io_file_input',
    labelKey: 'diagBlk.fileInputBin',
    category: 'io',
    descriptionKey: 'diagBlk.readsDataFromAFile',
    icon: 'File',
    ports: [
      { id: 'exec_in',  label: 'exec_in',  type: 'exec',  direction: 'input' },
      { id: 'exec_out', label: 'exec_out', type: 'exec',  direction: 'output' },
      { id: 'data_out', label: 'data_out', type: 'bytes', direction: 'output' },
    ],
    defaultConfig: { file_path: '', chunk_size: 128 },
    configSchema: [
      { key: 'file_path',  labelKey: 'diagBlk.filePath', type: 'text',   placeholder: '/path/to/firmware.bin' },
      { key: 'chunk_size', labelKey: 'diagBlk.chunkSizeBytes', type: 'number', placeholder: '2048' },
    ],
  },
  {
    type: 'io_display',
    labelKey: 'diagBlk.showValue',
    category: 'io',
    descriptionKey: 'diagBlk.writesTheValueToTheRun',
    icon: 'Monitor',
    ports: [
      { id: 'exec_in',  label: 'exec_in',  type: 'exec', direction: 'input' },
      { id: 'exec_out', label: 'exec_out', type: 'exec', direction: 'output' },
      { id: 'value_in', label: 'value_in', type: 'data', direction: 'input' },
    ],
    defaultConfig: {},
    configSchema: [],
  },
  {
    type: 'io_user_prompt',
    labelKey: 'diagBlk.userInput',
    category: 'io',
    descriptionKey: 'diagBlk.promptsTheUserForAValue',
    icon: 'MessageSquare',
    ports: [
      { id: 'exec_in',   label: 'exec_in',   type: 'exec', direction: 'input' },
      { id: 'exec_out',  label: 'exec_out',  type: 'exec', direction: 'output' },
      { id: 'value_out', label: 'value_out', type: 'data', direction: 'output' },
    ],
    defaultConfig: {},
    defaultConfigKeys: { message: 'diagBlk.enterAValue' },
    configSchema: [
      { key: 'message', labelKey: 'diagBlk.message', type: 'text', placeholderKey: 'diagBlk.enterAValue' },
    ],
  },
];

// ─── EXPORTS ──────────────────────────────────────────────────────────────────

export const BLOCK_CATALOG: BlockDef[] = [
  ...flowBlocks,
  ...udsBlocks,
  ...dataBlocks,
  ...ioBlocks,
];

export const BLOCK_CATALOG_BY_CATEGORY: Record<BlockCategory, BlockDef[]> = {
  flow: flowBlocks,
  uds:  udsBlocks,
  data: dataBlocks,
  io:   ioBlocks,
};

export function getBlockDef(type: string): BlockDef | undefined {
  return BLOCK_CATALOG.find((d) => d.type === type);
}
