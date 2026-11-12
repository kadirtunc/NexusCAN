/**
 * Dependency-free checks for TX_IN_FLIGHT_TIMEOUT recognition.
 * Run: `npm run test:inflight` (esbuild bundle -> node; throws on the first failure).
 */
import { formatInFlightBuses, isPanicLatchedError, isTxInFlightTimeoutError } from './ipcClient';

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}

assert(isTxInFlightTimeoutError('SafetyLock: TX_IN_FLIGHT_TIMEOUT: bus 1'), 'string with prefix');
assert(isTxInFlightTimeoutError(new Error('TX_IN_FLIGHT_TIMEOUT: write pending')), 'Error with prefix');
assert(!isTxInFlightTimeoutError('PANIC_LATCHED: clear first'), 'panic latch is not in-flight');
assert(!isTxInFlightTimeoutError(42), 'non-string');
assert(isPanicLatchedError('PANIC_LATCHED: x') && !isPanicLatchedError('TX_IN_FLIGHT_TIMEOUT: x'), 'distinct');
assert(formatInFlightBuses([0, 2]) === '1, 3', '1-based bus labels');
assert(formatInFlightBuses(undefined) === '', 'undefined -> empty');
console.log('txInFlight tests passed');
