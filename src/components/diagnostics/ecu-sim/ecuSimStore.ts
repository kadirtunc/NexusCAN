import { useSyncExternalStore } from 'react';
import { t } from '../../../i18n';

// ─── Types ────────────────────────────────────────────────────────────────────

export type SimSession = 'default' | 'extended' | 'programming';

export interface SimSecurityLevel {
  level: number;        // odd subFunction (1, 3, 5…)
  algorithm: 'xor_ff' | 'xor_const' | 'sum_negate' | 'add_const' | 'right_rotate' | 'crc16' | 'crc32' | 'custom';
  constant: string;     // hex constant for xor_const / add_const / right_rotate
  unlocked: boolean;
  failedAttempts: number;
  lockedUntil: number;  // epoch ms, 0 = not locked
}

export interface SimDid {
  id: string;           // internal uuid
  did: string;          // 4-char hex e.g. 'F190'
  name: string;
  value: string;        // hex bytes string e.g. 'WNXSYNTH000000001' as ASCII or hex
  valueHex: string;     // hex representation
  writable: boolean;
}

export interface SimDtc {
  id: string;
  code: string;         // e.g. 'P0100'
  raw: string;          // 3-byte hex e.g. '010009'
  status: number;       // DTC status byte
  present: boolean;
  description: string;
}

export type SimLogLevel = 'tx' | 'rx' | 'nrc' | 'info' | 'warn';

export interface SimLogEntry {
  id: string;
  ts: number;
  level: SimLogLevel;
  sid: number;
  subFn: number | null;
  raw: string;          // hex bytes
  decoded: string;      // human readable
}

export interface EcuSimState {
  // ECU runtime state
  session: SimSession;
  securityLevels: SimSecurityLevel[];
  commControlEnabled: boolean;   // false = Tx/Rx disabled
  dtcSettingEnabled: boolean;    // false = DTC storage off
  busyMode: boolean;             // simulate NRC 0x21

  // ECU data
  dids: SimDid[];
  dtcs: SimDtc[];

  // Response config
  p2Ms: number;
  p2extMs: number;
  nrcInjectRate: number;  // 0-100 percent probability of random NRC

  // Log
  log: SimLogEntry[];

  // UI
  activeSection: 'state' | 'dids' | 'dtcs' | 'security' | 'timing';
}

// ─── Default seed DIDs ───────────────────────────────────────────────────────

function uuid(): string {
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

function strToHex(s: string): string {
  return Array.from(s).map((c) => c.charCodeAt(0).toString(16).padStart(2, '0').toUpperCase()).join(' ');
}

const DEFAULT_DIDS: SimDid[] = [
  { id: uuid(), did: 'F190', name: 'VIN',                  value: 'WNXSYNTH000000001', valueHex: strToHex('WNXSYNTH000000001'), writable: false },
  { id: uuid(), did: 'F188', name: 'ECU Software Version', value: 'SW_v2.3.1',          valueHex: strToHex('SW_v2.3.1'),         writable: true  },
  { id: uuid(), did: 'F187', name: 'ECU Part Number',      value: 'PN-7654321',         valueHex: strToHex('PN-7654321'),         writable: false },
  { id: uuid(), did: 'F18C', name: 'ECU Serial Number',    value: 'ECU-00123',          valueHex: strToHex('ECU-00123'),          writable: false },
  { id: uuid(), did: 'F197', name: 'System Name',          value: 'ENGINE_CTRL',        valueHex: strToHex('ENGINE_CTRL'),        writable: false },
  { id: uuid(), did: 'F180', name: 'Boot Software ID',     value: 'BOOT_1.0.2',         valueHex: strToHex('BOOT_1.0.2'),         writable: false },
  { id: uuid(), did: 'F182', name: 'App Software ID',      value: 'APP_2.3.1',          valueHex: strToHex('APP_2.3.1'),          writable: true  },
  { id: uuid(), did: 'F186', name: 'Active Session',       value: '01',                 valueHex: '01',                           writable: false },
  { id: uuid(), did: 'F1A0', name: 'Calibration ID',       value: 'CAL_2024-A',         valueHex: strToHex('CAL_2024-A'),         writable: true  },
];

/** Built per call so seed descriptions follow the active locale. */
const defaultDtcs = (): SimDtc[] => [
  { id: uuid(), code: 'P0100', raw: '010009', status: 0x08, present: true,  description: t('diagSim.dtcP0100') },
  { id: uuid(), code: 'P0300', raw: '030000', status: 0x09, present: true,  description: t('diagSim.dtcP0300') },
  { id: uuid(), code: 'U0100', raw: '500100', status: 0x08, present: false, description: t('diagSim.dtcU0100') },
  { id: uuid(), code: 'C0010', raw: 'C00100', status: 0x08, present: false, description: t('diagSim.dtcC0010') },
];

const DEFAULT_SECURITY_LEVELS: SimSecurityLevel[] = [
  { level: 0x01, algorithm: 'xor_ff',    constant: '5A3C1E8F', unlocked: false, failedAttempts: 0, lockedUntil: 0 },
  { level: 0x03, algorithm: 'xor_const', constant: 'DEADBEEF', unlocked: false, failedAttempts: 0, lockedUntil: 0 },
  { level: 0x11, algorithm: 'crc16',     constant: '',          unlocked: false, failedAttempts: 0, lockedUntil: 0 },
];

function initialState(): EcuSimState {
  return {
    session: 'default',
    securityLevels: DEFAULT_SECURITY_LEVELS.map((l) => ({ ...l })),
    commControlEnabled: true,
    dtcSettingEnabled: true,
    busyMode: false,

    dids: DEFAULT_DIDS.map((d) => ({ ...d })),
    dtcs: defaultDtcs(),

    p2Ms: 25,
    p2extMs: 500,
    nrcInjectRate: 2,

    log: [],
    activeSection: 'state',
  };
}

// ─── Store ────────────────────────────────────────────────────────────────────

class EcuSimStore {
  private _state: EcuSimState = initialState();
  private _listeners = new Set<() => void>();

  getSnapshot(): EcuSimState { return this._state; }

  subscribe(cb: () => void): () => void {
    this._listeners.add(cb);
    return () => this._listeners.delete(cb);
  }

  private _emit(next: Partial<EcuSimState>): void {
    this._state = { ...this._state, ...next };
    this._listeners.forEach((cb) => cb());
  }

  // ── ECU state ──────────────────────────────────────────────────────────────

  setSession(s: SimSession): void {
    this._emit({ session: s });
    this._addLog('info', 0x10, null, '', t('diagSim.sessionChanged', { s: s.toUpperCase() }));
  }

  setCommControl(enabled: boolean): void {
    this._emit({ commControlEnabled: enabled });
  }

  setDtcSetting(enabled: boolean): void {
    this._emit({ dtcSettingEnabled: enabled });
  }

  setBusyMode(v: boolean): void {
    this._emit({ busyMode: v });
  }

  resetState(): void {
    this._emit(initialState());
  }

  // ── Security levels ────────────────────────────────────────────────────────

  updateSecurityLevel(level: number, patch: Partial<SimSecurityLevel>): void {
    const levels = this._state.securityLevels.map((l) =>
      l.level === level ? { ...l, ...patch } : l,
    );
    this._emit({ securityLevels: levels });
  }

  unlockLevel(level: number): void     { this.updateSecurityLevel(level, { unlocked: true,  failedAttempts: 0 }); }
  lockLevel(level: number): void       { this.updateSecurityLevel(level, { unlocked: false }); }
  addSecurityLevel(): void {
    const existing = this._state.securityLevels.map((l) => l.level);
    const nextOdd  = [0x01,0x03,0x05,0x07,0x09,0x0B,0x11,0x13,0x15].find((l) => !existing.includes(l)) ?? 0x05;
    this._emit({
      securityLevels: [
        ...this._state.securityLevels,
        { level: nextOdd, algorithm: 'xor_ff', constant: '', unlocked: false, failedAttempts: 0, lockedUntil: 0 },
      ],
    });
  }
  removeSecurityLevel(level: number): void {
    this._emit({ securityLevels: this._state.securityLevels.filter((l) => l.level !== level) });
  }

  // ── DIDs ───────────────────────────────────────────────────────────────────

  addDid(): void {
    const blank: SimDid = { id: uuid(), did: 'F100', name: 'Yeni DID', value: '00', valueHex: '00', writable: true };
    this._emit({ dids: [...this._state.dids, blank] });
  }

  updateDid(id: string, patch: Partial<SimDid>): void {
    const dids = this._state.dids.map((d) => (d.id === id ? { ...d, ...patch } : d));
    this._emit({ dids });
  }

  removeDid(id: string): void {
    this._emit({ dids: this._state.dids.filter((d) => d.id !== id) });
  }

  resetDids(): void {
    this._emit({ dids: DEFAULT_DIDS.map((d) => ({ ...d, id: uuid() })) });
  }

  // ── DTCs ───────────────────────────────────────────────────────────────────

  addDtc(): void {
    const blank: SimDtc = { id: uuid(), code: 'P0000', raw: '000000', status: 0x08, present: false, description: t('diagSim.newDtc') };
    this._emit({ dtcs: [...this._state.dtcs, blank] });
  }

  updateDtc(id: string, patch: Partial<SimDtc>): void {
    const dtcs = this._state.dtcs.map((d) => (d.id === id ? { ...d, ...patch } : d));
    this._emit({ dtcs });
  }

  removeDtc(id: string): void {
    this._emit({ dtcs: this._state.dtcs.filter((d) => d.id !== id) });
  }

  clearAllDtcs(): void {
    const dtcs = this._state.dtcs.map((d) => ({ ...d, present: false }));
    this._emit({ dtcs });
    this._addLog('info', 0x14, null, '', t('diagSim.allDtcsCleared'));
  }

  // ── Timing ─────────────────────────────────────────────────────────────────

  setTiming(p2Ms: number, p2extMs: number): void   { this._emit({ p2Ms, p2extMs }); }
  setNrcRate(rate: number): void                    { this._emit({ nrcInjectRate: rate }); }

  // ── Log ────────────────────────────────────────────────────────────────────

  private _addLog(level: SimLogLevel, sid: number, subFn: number | null, raw: string, decoded: string): void {
    const entry: SimLogEntry = { id: uuid(), ts: Date.now(), level, sid, subFn, raw, decoded };
    const log = [...this._state.log.slice(-199), entry]; // keep last 200
    this._emit({ log });
  }

  clearLog(): void { this._emit({ log: [] }); }

  // ── Simulate UDS request ──────────────────────────────────────────────────

  simulateRequest(sid: number, subFn: number | null, dataHex: string): void {
    const raw = [
      sid.toString(16).toUpperCase().padStart(2, '0'),
      ...(subFn !== null ? [subFn.toString(16).toUpperCase().padStart(2, '0')] : []),
      ...(dataHex.trim() ? [dataHex.trim().toUpperCase()] : []),
    ].join(' ');

    this._addLog('tx', sid, subFn, raw, this._decodeSid(sid, subFn));

    // Simulate response after p2 delay
    const st = this._state;
    setTimeout(() => {
      // random NRC injection
      if (Math.random() * 100 < st.nrcInjectRate) {
        const nrcs = [0x22, 0x31, 0x11];
        const nrc  = nrcs[Math.floor(Math.random() * nrcs.length)];
        const nrcRaw = `7F ${sid.toString(16).padStart(2,'0').toUpperCase()} ${nrc.toString(16).padStart(2,'0').toUpperCase()}`;
        this._addLog('nrc', 0x7F, null, nrcRaw, `NRC 0x${nrc.toString(16).toUpperCase()} — ${this._nrcName(nrc)}`);
        return;
      }
      if (st.busyMode) {
        const nrcRaw = `7F ${sid.toString(16).padStart(2,'0').toUpperCase()} 21`;
        this._addLog('nrc', 0x7F, null, nrcRaw, 'NRC 0x21 — busyRepeatRequest');
        return;
      }
      this._simulateResponse(sid, subFn, dataHex);
    }, st.p2Ms);
  }

  private _simulateResponse(sid: number, subFn: number | null, _dataHex: string): void {
    const st  = this._state;
    const rsp = sid + 0x40;
    const sf  = subFn ?? 0x00;

    switch (sid) {
      case 0x10: { // DiagnosticSessionControl
        const labels: Record<number, SimSession> = { 0x01: 'default', 0x02: 'programming', 0x03: 'extended', 0x04: 'extended' };
        const next = labels[sf] ?? 'default';
        const p2h = Math.round(st.p2Ms * 2 / 100);
        const p2l = Math.round(st.p2Ms * 2 % 100);
        const p2xh = Math.round(st.p2extMs / 10 / 256);
        const p2xl = Math.round((st.p2extMs / 10) % 256);
        const raw = `${rsp.toString(16).padStart(2,'0').toUpperCase()} ${sf.toString(16).padStart(2,'0').toUpperCase()} 00 ${p2h.toString(16).padStart(2,'0').toUpperCase()} ${p2l.toString(16).padStart(2,'0').toUpperCase()} ${p2xh.toString(16).padStart(2,'0').toUpperCase()} ${p2xl.toString(16).padStart(2,'0').toUpperCase()}`;
        this._emit({ session: next });
        this._addLog('rx', rsp, sf, raw, `SessionCtrl+ → ${next.toUpperCase()}  P2=${st.p2Ms}ms`);
        break;
      }
      case 0x11: { // ECUReset
        const raw = `${rsp.toString(16).padStart(2,'0').toUpperCase()} ${sf.toString(16).padStart(2,'0').toUpperCase()}`;
        this._addLog('rx', rsp, sf, raw, 'ECUReset+ → Reset executing…');
        setTimeout(() => {
          this._emit({ session: 'default', securityLevels: st.securityLevels.map((l) => ({ ...l, unlocked: false })) });
          this._addLog('info', 0x11, null, '', t('diagSim.ecuRestarted'));
        }, 300);
        break;
      }
      case 0x14: { // ClearDiagnosticInformation
        const raw = `54`;
        this.clearAllDtcs();
        this._addLog('rx', 0x54, null, raw, `ClearDTC+ — ${t('diagSim.allDtcsClearedShort')}`);
        break;
      }
      case 0x19: { // ReadDTCInformation
        const activeDtcs = st.dtcs.filter((d) => d.present);
        if (sf === 0x01) {
          const cnt = activeDtcs.length;
          const raw = `59 01 FF 00 ${cnt.toString(16).padStart(2,'0').toUpperCase()}`;
          this._addLog('rx', 0x59, 0x01, raw, `ReadDTC+ → ${t('diagSim.activeDtcCount', { n: cnt })}`);
        } else {
          const raw = `59 ${sf.toString(16).padStart(2,'0').toUpperCase()} FF ` + activeDtcs.slice(0,3).map((d) => d.raw.match(/.{2}/g)?.join(' ') + ` ${d.status.toString(16).padStart(2,'0').toUpperCase()}`).join(' ');
          this._addLog('rx', 0x59, sf, raw, `ReadDTC+ → ${activeDtcs.length} DTC (${activeDtcs.map((d)=>d.code).join(', ')})`);
        }
        break;
      }
      case 0x22: { // ReadDataByIdentifier
        const didHex = _dataHex.replace(/\s/g,'').slice(0,4).toUpperCase();
        const did = st.dids.find((d) => d.did.toUpperCase() === didHex);
        const valHex = did?.valueHex ?? 'DE AD BE EF';
        const raw = `62 ${didHex.slice(0,2)} ${didHex.slice(2,4)} ${valHex}`;
        this._addLog('rx', 0x62, null, raw, `ReadDID+ 0x${didHex} → ${did ? did.value : t('diagSim.unknown')}`);
        break;
      }
      case 0x27: { // SecurityAccess
        if (sf % 2 === 1) { // requestSeed
          const seed = Array.from({length:4},()=>Math.floor(Math.random()*256));
          const raw  = `67 ${sf.toString(16).padStart(2,'0').toUpperCase()} ${seed.map((b)=>b.toString(16).padStart(2,'0').toUpperCase()).join(' ')}`;
          this._addLog('rx', 0x67, sf, raw, `SecAccess+ seed=${seed.map((b)=>b.toString(16).padStart(2,'0').toUpperCase()).join('')}`);
        } else { // sendKey
          const lvl = sf - 1;
          const level = st.securityLevels.find((l) => l.level === lvl);
          const reject = Math.random() < 0.1;
          if (reject) {
            const raw = `7F 27 35`;
            this._addLog('nrc', 0x7F, null, raw, `NRC 0x35 — invalidKey (level 0x${lvl.toString(16).padStart(2,'0').toUpperCase()})`);
          } else {
            const raw = `67 ${sf.toString(16).padStart(2,'0').toUpperCase()}`;
            if (level) this.updateSecurityLevel(level.level, { unlocked: true });
            this._addLog('rx', 0x67, sf, raw, `SecAccess+ UNLOCKED level=0x${lvl.toString(16).padStart(2,'0').toUpperCase()} ✓`);
          }
        }
        break;
      }
      case 0x28: { // CommunicationControl
        const enabled = sf === 0x00;
        this._emit({ commControlEnabled: enabled });
        const raw = `68 ${sf.toString(16).padStart(2,'0').toUpperCase()}`;
        this._addLog('rx', 0x68, sf, raw, `CommControl+ → ${enabled ? 'ENABLED' : 'DISABLED'}`);
        break;
      }
      case 0x2E: { // WriteDataByIdentifier
        const didHex = _dataHex.replace(/\s/g,'').slice(0,4).toUpperCase();
        const raw = `6E ${didHex.slice(0,2)} ${didHex.slice(2,4)}`;
        this._addLog('rx', 0x6E, null, raw, `WriteDID+ 0x${didHex} ${t('diagSim.written')}`);
        break;
      }
      case 0x31: { // RoutineControl
        const rid = _dataHex.replace(/\s/g,'').slice(0,4).toUpperCase();
        const raw = `71 ${sf.toString(16).padStart(2,'0').toUpperCase()} ${rid.slice(0,2)} ${rid.slice(2,4)} 00`;
        this._addLog('rx', 0x71, sf, raw, `RoutineCtrl+ 0x${rid} ${sf===1?'started':sf===2?'stopped':'results'}`);
        break;
      }
      case 0x34: { // RequestDownload
        const raw = `74 20 08 02`;
        this._addLog('rx', 0x74, null, raw, `RequestDownload+ maxBlockLen=0x0802`);
        break;
      }
      case 0x36: { // TransferData
        const bsq = sf;
        const raw = `76 ${bsq.toString(16).padStart(2,'0').toUpperCase()}`;
        this._addLog('rx', 0x76, bsq, raw, `TransferData+ blockSeq=0x${bsq.toString(16).padStart(2,'0').toUpperCase()}`);
        break;
      }
      case 0x37: { // TransferExit
        const raw = `77`;
        this._addLog('rx', 0x77, null, raw, `TransferExit+ ${t('diagSim.completed')}`);
        break;
      }
      case 0x3E: { // TesterPresent
        if (sf !== 0x80) {
          const raw = `7E 00`;
          this._addLog('rx', 0x7E, 0x00, raw, `TesterPresent+ (suppress=false)`);
        } else {
          this._addLog('info', 0x3E, sf, '', `TesterPresent — ${t('diagSim.responseSuppressed')}`);
        }
        break;
      }
      case 0x85: { // ControlDTCSetting
        const enabled = sf === 0x01;
        this._emit({ dtcSettingEnabled: enabled });
        const raw = `C5 ${sf.toString(16).padStart(2,'0').toUpperCase()}`;
        this._addLog('rx', 0xC5, sf, raw, `DTCSetting+ → ${enabled ? 'ON' : 'OFF'}`);
        break;
      }
      default: {
        if (st.session === 'default' && [0x27,0x28,0x85,0x34,0x35,0x36,0x37,0x87].includes(sid)) {
          const raw = `7F ${sid.toString(16).padStart(2,'0').toUpperCase()} 7F`;
          this._addLog('nrc', 0x7F, null, raw, `NRC 0x7F — serviceNotSupportedInActiveSession`);
        } else {
          const raw = `${rsp.toString(16).padStart(2,'0').toUpperCase()} ${sf.toString(16).padStart(2,'0').toUpperCase()}`;
          this._addLog('rx', rsp, sf, raw, `${this._decodeSid(sid, subFn)}+`);
        }
      }
    }
  }

  private _decodeSid(sid: number, subFn: number | null): string {
    const names: Record<number, string> = {
      0x10:'SessionCtrl', 0x11:'ECUReset', 0x14:'ClearDTC', 0x19:'ReadDTC',
      0x22:'ReadDID', 0x23:'ReadMem', 0x27:'SecAccess', 0x28:'CommCtrl',
      0x2E:'WriteDID', 0x2F:'IOCtrl', 0x31:'RoutineCtrl', 0x34:'ReqDownload',
      0x35:'ReqUpload', 0x36:'TransferData', 0x37:'TransferExit', 0x3D:'WriteMem',
      0x3E:'TesterPresent', 0x85:'DTCSetting', 0x87:'LinkCtrl',
    };
    const name = names[sid] ?? `SID_0x${sid.toString(16).toUpperCase()}`;
    const sfStr = subFn !== null ? `[0x${subFn.toString(16).padStart(2,'0').toUpperCase()}]` : '';
    return `${name}${sfStr}`;
  }

  private _nrcName(nrc: number): string {
    const map: Record<number,string> = {
      0x10:'generalReject', 0x11:'serviceNotSupported', 0x12:'subFnNotSupported',
      0x13:'incorrectLength', 0x21:'busyRepeatRequest', 0x22:'conditionsNotCorrect',
      0x24:'requestSequenceError', 0x31:'requestOutOfRange', 0x33:'securityAccessDenied',
      0x35:'invalidKey', 0x36:'exceededNumberOfAttempts', 0x37:'timeDelayNotExpired',
      0x70:'uploadDownloadNotAccepted', 0x72:'generalProgrammingFailure',
      0x7E:'subFnNotSupportedInSession', 0x7F:'serviceNotSupportedInSession',
    };
    return map[nrc] ?? 'unknown';
  }

  setActiveSection(s: EcuSimState['activeSection']): void {
    this._emit({ activeSection: s });
  }
}

export const ecuSimStore = new EcuSimStore();

export function useEcuSimStore(): EcuSimState {
  return useSyncExternalStore(
    ecuSimStore.subscribe.bind(ecuSimStore),
    ecuSimStore.getSnapshot.bind(ecuSimStore),
  );
}
