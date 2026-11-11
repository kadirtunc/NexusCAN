/**
 * Dependency-free checks for the UDS response interpreter.
 * Run: `npm run test:decode` (esbuild bundle -> node; throws on the first failure).
 */
import { decodeDidRecord, decodeDidValue, formatDtc3, interpretUdsResponse } from './udsDecode';
import { sidName } from '../components/diagnostics/traffic/trafficModel';
import { IsoTpReassembler } from './isoTpDecode';

function eq<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) throw new Error(`FAIL ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const ascii = (s: string): number[] => Array.from(s).map((c) => c.charCodeAt(0));

const VIN_PDU = [0x62, 0xf1, 0x90, 0x57, 0x4e, 0x58, 0x30, 0x45, 0x43, 0x55, 0x53, 0x49, 0x4d, 0x30, 0x30, 0x30, 0x30, 0x30, 0x31, 0x37];
eq(decodeDidRecord(VIN_PDU.slice(3)), 'WNX0ECUSIM0000017', 'VIN record');
eq(decodeDidRecord([0x26, 0x11, 0x10]), '261110', 'non-printable -> hex');
eq(decodeDidRecord([...ascii('SW-0001'), 0, 0, 0]), 'SW-0001', 'trailing 00 trimmed');
eq(decodeDidRecord([0x41, 0x00, 0x42, 0x00]), '41004200', 'embedded 00 -> whole hex');
eq(decodeDidValue(0xf186, [0x03]), 'Extended', 'F186 session name');
eq(decodeDidValue(0xf18b, [0x26, 0x11, 0x10]), '2026-11-10 (BCD)', 'F18B BCD YYMMDD');
eq(decodeDidValue(0xf199, [0x20, 0x26, 0x01, 0x31]), '2026-01-31 (BCD)', 'F199 BCD YYYYMMDD');
eq(decodeDidValue(0xf18b, [0x26, 0x13, 0x10]), '261310', 'F18B invalid month → generic hex');
eq(decodeDidValue(0xf18b, [0x2a, 0x11, 0x10]), '2A1110', 'F18B non-BCD nibble → generic hex');
eq(decodeDidValue(0xf18c, [0x26, 0x11, 0x10]), '261110', 'non-date DID never date-decoded');
eq(decodeDidValue(0xf188, [0x53, 0x57, 0x2d, 0x30, 0x30, 0x30, 0x31]), 'SW-0001', 'F188 ASCII');

const vin = interpretUdsResponse([0x22, 0xf1, 0x90], VIN_PDU);
eq(vin.kind, 'did', 'VIN kind');
eq(vin.title, '0xF190 VIN', 'VIN title');
eq(vin.value, 'WNX0ECUSIM0000017', 'VIN value');
eq(vin.brief, 'VIN=WNX0…017', 'VIN brief');

const ses = interpretUdsResponse([0x10, 0x03], [0x50, 0x03, 0x00, 0x32, 0x01, 0xf4]);
eq(ses.value, 'P2=50 ms, P2*=5000 ms', 'session timing');
eq(interpretUdsResponse([], [0x67, 0x01, 0xde, 0xad]).value, 'DE AD', 'seed');
eq(interpretUdsResponse([], [0x67, 0x02]).kind, 'securityKey', 'key');
eq(interpretUdsResponse([], [0x59, 0x01, 0xff, 0x01, 0x00, 0x03]).value, '3 DTC', 'DTC count');
eq(interpretUdsResponse([], [0x7e, 0x00]).kind, 'testerPresent', 'tester present');
eq(interpretUdsResponse([], [0x7f, 0x22, 0x31]).brief, 'NRC 0x31 requestOutOfRange', 'NRC');
eq(interpretUdsResponse([], [0xaa, 0x01]).kind, 'unknown', 'unknown');
eq(formatDtc3(0x01, 0x00, 0x09), 'P0100-09', 'DTC format');
eq(formatDtc3(0xc1, 0x23, 0x00), 'U0123-00', 'DTC format U');

// OBD-II Mode 01 (SAE J1979) is not UDS: 41 0C 1A F8 -> (256*0x1A + 0xF8)/4 = 1726 rpm.
const obd = interpretUdsResponse([0x01, 0x0c], [0x41, 0x0c, 0x1a, 0xf8]);
eq(obd.kind, 'obd', 'OBD kind');
eq(obd.title, 'OBD-II Mode 01 · PID 0x0C Engine RPM', 'OBD title');
eq(obd.value, '1726 rpm', 'OBD value');
eq(obd.brief, 'PID 0C Engine RPM = 1726 rpm', 'OBD brief');
eq(interpretUdsResponse([0x01, 0x0c], [0x7f, 0x01, 0x12]).title.startsWith('OBD-II Mode 01'), true, 'OBD NRC service name');
eq(sidName(0x01), 'OBD-II Mode 01 (Current Data)', 'sidName 01');
eq(sidName(0x41), 'OBD-II Mode 01 (Current Data)', 'sidName 41');

// ISO-TP reassembly: FF total=10 (6 B) + CF SN=1 (4 B) -> complete message; wrong SN drops it.
const r = new IsoTpReassembler();
eq(r.feed('rx', 'first', [0x10, 0x0a, 1, 2, 3, 4, 5, 6]), null, 'FF pending');
const full = r.feed('rx', 'consecutive', [0x21, 7, 8, 9, 10, 0xaa, 0xaa, 0xaa]);
eq(full?.join(',') ?? '', '1,2,3,4,5,6,7,8,9,10', 'CF completes');
r.feed('rx', 'first', [0x10, 0x0a, 1, 2, 3, 4, 5, 6]);
eq(r.feed('rx', 'consecutive', [0x23, 7, 8, 9, 10, 0, 0, 0]), null, 'bad SN dropped');
console.log('udsDecode: all checks passed');
