import { getLocale, t } from '../../../i18n';
import type { FlowTemplate, FlowBlock, FlowConnection } from './types';

let _idCounter = 0;
function tid(): string {
  return `tpl_${++_idCounter}`;
}

function makeBlock(
  type: string,
  label: string,
  x: number,
  y: number,
  config: Record<string, unknown> = {},
): FlowBlock {
  return {
    id: tid(),
    type,
    label,
    x,
    y,
    config,
    status: 'idle',
    collapsed: false,
  };
}

function conn(
  fromBlock: FlowBlock,
  fromPort: string,
  toBlock: FlowBlock,
  toPort: string,
): FlowConnection {
  return {
    id: tid(),
    fromBlockId: fromBlock.id,
    fromPortId:  fromPort,
    toBlockId:   toBlock.id,
    toPortId:    toPort,
  };
}

// ─── ECU FLASHER ─────────────────────────────────────────────────────────────

function buildEcuFlasher(): FlowTemplate {
  // ISO 14229-1 compliant ECU flash sequence:
  // Session(prog) → CommControl(off) → DTCSetting(off) → Security → Erase → Download → Transfer(loop) → Exit → CheckProg → DTCSetting(on) → CommControl(on) → Reset

  const start      = makeBlock('start',               t('diagBlk.start'),                   100,  200);
  const extSession = makeBlock('uds_session',         'Extended Session',          350,  200, { session_type: 'extended' });
  const progSession= makeBlock('uds_session',         'Programming Session',       600,  200, { session_type: 'programming' });
  const commOff    = makeBlock('uds_comm_control',    t('diagTpl.commOff'),               850,  200, { control_type: '03', comm_type: '01' });
  const dtcOff     = makeBlock('uds_dtc_setting',     'DTC Setting OFF',          1100,  200, { setting_type: '02' });
  const security   = makeBlock('uds_security_access', 'Security Access L1',       1350,  200, { access_level: '11', algorithm: 'xor_ff' });
  const erase      = makeBlock('uds_routine_ctrl',    t('diagTpl.eraseMemory'),         1600,  200, { control_type: '01', routine_id: 'FF00' });
  const download   = makeBlock('uds_req_download',    'Request Download',          1850,  200, { memory_address: '08000000', memory_size: '00010000', data_format: '00' });
  const transfer   = makeBlock('uds_transfer_data',   'Transfer Data',             2100,  200, { chunk_size: '0800' });
  const exitT      = makeBlock('uds_transfer_exit',   'Transfer Exit',             2350,  200);
  const checkProg  = makeBlock('uds_routine_ctrl',    'Check Programming (0202)',  2600,  200, { control_type: '01', routine_id: '0202' });
  const dtcOn      = makeBlock('uds_dtc_setting',     'DTC Setting ON',            2850,  200, { setting_type: '01' });
  const commOn     = makeBlock('uds_comm_control',    t('diagTpl.commOn'),                 3100,  200, { control_type: '00', comm_type: '01' });
  const reset      = makeBlock('uds_ecu_reset',       'Hard Reset',               3350,  200, { reset_type: 'hardReset' });
  const end        = makeBlock('end',                 t('diagBlk.end'),                    3600,  200);
  const logErr     = makeBlock('log',                 t('diagTpl.flashError'),              1850,  420, { message: t('diagTpl.flashErrorMsg') });

  const blocks = [start, extSession, progSession, commOff, dtcOff, security, erase, download, transfer, exitT, checkProg, dtcOn, commOn, reset, end, logErr];

  const connections: FlowConnection[] = [
    conn(start,       'exec_out',    extSession,  'exec_in'),
    conn(extSession,  'exec_out',    progSession, 'exec_in'),
    conn(progSession, 'exec_out',    commOff,     'exec_in'),
    conn(commOff,     'exec_out',    dtcOff,      'exec_in'),
    conn(dtcOff,      'exec_out',    security,    'exec_in'),
    conn(security,    'success_out', erase,       'exec_in'),
    conn(erase,       'exec_out',    download,    'exec_in'),
    conn(download,    'exec_out',    transfer,    'exec_in'),
    conn(transfer,    'exec_out',    exitT,       'exec_in'),
    conn(exitT,       'exec_out',    checkProg,   'exec_in'),
    conn(checkProg,   'exec_out',    dtcOn,       'exec_in'),
    conn(dtcOn,       'exec_out',    commOn,      'exec_in'),
    conn(commOn,      'exec_out',    reset,       'exec_in'),
    conn(reset,       'exec_out',    end,         'exec_in'),
    // error paths
    conn(extSession,  'error_out',   logErr,      'exec_in'),
    conn(progSession, 'error_out',   logErr,      'exec_in'),
    conn(commOff,     'error_out',   logErr,      'exec_in'),
    conn(dtcOff,      'error_out',   logErr,      'exec_in'),
    conn(security,    'error_out',   logErr,      'exec_in'),
    conn(erase,       'error_out',   logErr,      'exec_in'),
    conn(download,    'error_out',   logErr,      'exec_in'),
    conn(transfer,    'error_out',   logErr,      'exec_in'),
    conn(exitT,       'error_out',   logErr,      'exec_in'),
    conn(checkProg,   'error_out',   logErr,      'exec_in'),
    conn(logErr,      'exec_out',    end,         'exec_in'),
  ];

  return {
    id: 'ecu_flasher',
    nameKey: 'diagTpl.ecuFlasher.name',
    descriptionKey: 'diagTpl.ecuFlasher.desc',
    category: 'firmware',
    icon: 'HardDrive',
    diagram: { blocks, connections },
  };
}

// ─── DTC RAPORU ──────────────────────────────────────────────────────────────

function buildDtcReport(): FlowTemplate {
  const start   = makeBlock('start',        t('diagBlk.start'),          100, 200);
  const session  = makeBlock('uds_session', 'Session Control', 350, 200, { session_type: 'extended' });
  const readDtc = makeBlock('uds_read_dtc', t('diagTpl.readDtc'),         600, 200, { sub_fn: '02', status_mask: 'FF' });
  const display = makeBlock('io_display',   t('diagTpl.showDtc'),      850, 200);
  const end     = makeBlock('end',          t('diagBlk.end'),          1100, 200);

  const blocks = [start, session, readDtc, display, end];
  const connections: FlowConnection[] = [
    conn(start,   'exec_out',    session,  'exec_in'),
    conn(session, 'exec_out',    readDtc,  'exec_in'),
    conn(readDtc, 'exec_out',    display,  'exec_in'),
    conn(readDtc, 'dtc_list_out',display,  'value_in'),
    conn(display, 'exec_out',    end,      'exec_in'),
  ];

  return {
    id: 'dtc_report',
    nameKey: 'diagTpl.dtcReport.name',
    descriptionKey: 'diagTpl.dtcReport.desc',
    category: 'diagnostics',
    icon: 'AlertTriangle',
    diagram: { blocks, connections },
  };
}

// ─── ECU KİMLİK OKUMA ────────────────────────────────────────────────────────

function buildEcuIdentity(): FlowTemplate {
  const start    = makeBlock('start',        t('diagBlk.start'),               100, 200);
  const session  = makeBlock('uds_session',  'Session Control',      350, 200, { session_type: 'extended' });
  const readVin  = makeBlock('uds_read_did', t('diagTpl.readVin'),       600, 200, { did: 'F190' });
  const dispVin  = makeBlock('io_display',   t('diagTpl.showVin'),           850, 200);
  const readSw   = makeBlock('uds_read_did', t('diagTpl.readSw'),  1100, 200, { did: 'F188' });
  const dispSw   = makeBlock('io_display',   t('diagTpl.showSw'),      1350, 200);
  const end      = makeBlock('end',          t('diagBlk.end'),               1600, 200);

  const blocks = [start, session, readVin, dispVin, readSw, dispSw, end];
  const connections: FlowConnection[] = [
    conn(start,   'exec_out', session, 'exec_in'),
    conn(session, 'exec_out', readVin, 'exec_in'),
    conn(readVin, 'exec_out', dispVin, 'exec_in'),
    conn(readVin, 'data_out', dispVin, 'value_in'),
    conn(dispVin, 'exec_out', readSw,  'exec_in'),
    conn(readSw,  'exec_out', dispSw,  'exec_in'),
    conn(readSw,  'data_out', dispSw,  'value_in'),
    conn(dispSw,  'exec_out', end,     'exec_in'),
  ];

  return {
    id: 'ecu_identity',
    nameKey: 'diagTpl.ecuIdentity.name',
    descriptionKey: 'diagTpl.ecuIdentity.desc',
    category: 'diagnostics',
    icon: 'IdCard',
    diagram: { blocks, connections },
  };
}

// ─── TAM TANILAMATIC ─────────────────────────────────────────────────────────

function buildFullDiag(): FlowTemplate {
  const start     = makeBlock('start',        t('diagBlk.start'),              100, 200);
  const session   = makeBlock('uds_session',  'Session Control',     350, 200, { session_type: 'extended' });
  const readDtc   = makeBlock('uds_read_dtc', t('diagTpl.readDtc'),             600, 200, { sub_fn: '02', status_mask: 'FF' });
  const logDtc    = makeBlock('log',          t('diagTpl.dtcResults'),       850, 200, { message: t('diagTpl.dtcListRead') });
  const readDid   = makeBlock('uds_read_did', t('diagTpl.readDid'),       1100, 200, { did: 'F190' });
  const display   = makeBlock('io_display',   t('diagTpl.showDid'),         1350, 200);
  const clearDtc  = makeBlock('uds_clear_dtc',t('diagTpl.clearDtc'),        1600, 200, { group: 'FFFFFF' });
  const end       = makeBlock('end',          t('diagBlk.end'),              1850, 200);

  const blocks = [start, session, readDtc, logDtc, readDid, display, clearDtc, end];
  const connections: FlowConnection[] = [
    conn(start,    'exec_out',    session,  'exec_in'),
    conn(session,  'exec_out',    readDtc,  'exec_in'),
    conn(readDtc,  'exec_out',    logDtc,   'exec_in'),
    conn(readDtc,  'dtc_list_out',logDtc,   'value_in'),
    conn(logDtc,   'exec_out',    readDid,  'exec_in'),
    conn(readDid,  'exec_out',    display,  'exec_in'),
    conn(readDid,  'data_out',    display,  'value_in'),
    conn(display,  'exec_out',    clearDtc, 'exec_in'),
    conn(clearDtc, 'exec_out',    end,      'exec_in'),
  ];

  return {
    id: 'full_diag',
    nameKey: 'diagTpl.fullDiag.name',
    descriptionKey: 'diagTpl.fullDiag.desc',
    category: 'diagnostics',
    icon: 'ClipboardList',
    diagram: { blocks, connections },
  };
}

/**
 * Block labels / messages inside a template are resolved with the active locale.
 * The diagram is therefore built lazily and cached per locale (a single build per
 * locale keeps block/connection ids consistent between reads).
 */
function lazyTemplate(build: () => FlowTemplate): FlowTemplate {
  const meta = build();
  let cache: { locale: string; diagram: FlowTemplate['diagram'] } | null = null;
  return {
    ...meta,
    get diagram(): FlowTemplate['diagram'] {
      const locale = getLocale();
      if (!cache || cache.locale !== locale) cache = { locale, diagram: build().diagram };
      return cache.diagram;
    },
  };
}

export const FLOW_TEMPLATES: FlowTemplate[] = [
  lazyTemplate(buildEcuFlasher),
  lazyTemplate(buildDtcReport),
  lazyTemplate(buildEcuIdentity),
  lazyTemplate(buildFullDiag),
];
