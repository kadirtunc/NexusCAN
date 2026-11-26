/**
 * Dependency-free checks for the CANsub bitrate matrix helper.
 * Run: `npm run test:cansub-bitrate`. Mirrors nexus-hal cansub_drv select_fd_timing matrix test.
 */
import {
  isCansubBitrateSupported as ok,
  isCansubFdAvailable,
  nearestCansubDataBitrate,
} from './connectionStore';

let failed = 0;
function eq(name: string, got: unknown, want: unknown): void {
  if (got !== want) {
    failed += 1;
    console.error(`FAIL ${name}: got ${String(got)} want ${String(want)}`);
  }
}

const bad: Array<[number, number]> = [
  ...[10_000, 20_000].flatMap((n) =>
    [1_000_000, 2_000_000, 4_000_000, 5_000_000, 8_000_000].map((d): [number, number] => [n, d]),
  ),
  ...[50_000, 100_000].flatMap((n) =>
    [4_000_000, 5_000_000, 8_000_000].map((d): [number, number] => [n, d]),
  ),
  [125_000, 8_000_000],
];
eq('unsupported count', bad.length, 17);
for (const [n, d] of bad) eq(`bad ${n}/${d}`, ok(n, d, true), false);
eq('500k/5M', ok(500_000, 5_000_000, true), true);
eq('125k/5M', ok(125_000, 5_000_000, true), true);
eq('125k/8M', ok(125_000, 8_000_000, true), false);
eq('1M/8M', ok(1_000_000, 8_000_000, true), true);
eq('classic 10k', ok(10_000, null, false), true);
eq('fd null data', ok(500_000, null, true), false);
eq('fd avail 20k', isCansubFdAvailable(20_000), false);
eq('fd avail 50k', isCansubFdAvailable(50_000), true);
eq('nearest 50k/5M', nearestCansubDataBitrate(50_000, 5_000_000), 2_000_000);
eq('nearest 125k/8M', nearestCansubDataBitrate(125_000, 8_000_000), 5_000_000);
eq('nearest 10k', nearestCansubDataBitrate(10_000, 2_000_000), null);

if (failed > 0) throw new Error(`${failed} cansubBitrate check(s) failed`);
console.log('cansubBitrate: all checks passed');
