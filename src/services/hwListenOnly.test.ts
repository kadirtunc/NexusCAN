/**
 * Dependency-free checks for HW_LISTEN_ONLY_UNAVAILABLE recognition and project sanitization.
 * Run: `npm run test:hwlo` (esbuild bundle -> node; throws on the first failure).
 */
import { hwListenOnlyHint, isHwListenOnlyUnavailableError } from './ipcClient';
import { sanitizeProject } from '../utils/projectSanitize';
import { buildChannelConfigForProfile } from '../store/connectionStore';
import type { SavedConnectionProfile } from '../store/connectionStore';

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}

const msg = 'HW_LISTEN_ONLY_UNAVAILABLE: grant CAP_NET_ADMIN on can0';
assert(isHwListenOnlyUnavailableError(msg), 'string with prefix');
assert(isHwListenOnlyUnavailableError(new Error(`connect failed: ${msg}`)), 'Error with prefix');
assert(!isHwListenOnlyUnavailableError('TX_IN_FLIGHT_TIMEOUT: x'), 'other prefix');
assert(!isHwListenOnlyUnavailableError(42), 'non-string');
assert(hwListenOnlyHint(msg) === 'grant CAP_NET_ADMIN on can0', 'hint extracted');
assert(hwListenOnlyHint('other') === '', 'no hint');

function project(value: unknown, mode: 'external' | 'own'): SavedConnectionProfile {
  const raw = {
    version: 1,
    name: 'p',
    connections: {
      profiles: [
        {
          id: 'a',
          name: 'a',
          busId: 0,
          driverFamily: 'socketcan',
          listenOnly: false,
          autoConnectOnProjectLoad: true,
          ...(value === undefined ? {} : { requireHardwareListenOnly: value }),
        },
      ],
    },
  };
  const out = sanitizeProject(raw, mode).project;
  const prof = out.connections.profiles[0];
  if (prof === undefined) throw new Error('FAIL: profile missing');
  return prof;
}

for (const mode of ['external', 'own'] as const) {
  assert(project(true, mode).requireHardwareListenOnly === true, `${mode}: true kept`);
  assert(project(false, mode).requireHardwareListenOnly === false, `${mode}: false kept`);
  assert(project(undefined, mode).requireHardwareListenOnly === false, `${mode}: missing -> false`);
  assert(project('true', mode).requireHardwareListenOnly === false, `${mode}: string -> false`);
  assert(project(1, mode).requireHardwareListenOnly === false, `${mode}: number -> false`);
}
const ext = project(true, 'external');
assert(ext.listenOnly === true, 'external still forced Listen-Only');
assert(ext.autoConnectOnProjectLoad === false, 'external still no auto-connect');

const cfg = buildChannelConfigForProfile(ext).config;
assert(cfg.requireHardwareListenOnly === true, 'config carries flag for socketcan');
const mock = buildChannelConfigForProfile({ ...ext, driverFamily: 'mock' }).config;
assert(mock.requireHardwareListenOnly === false, 'mock never requires hw');

console.log('hwListenOnly tests passed');
