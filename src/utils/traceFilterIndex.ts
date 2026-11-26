import type { ChronoRingBuffer } from '../store/telemetryStore';
import type { ChronologicalFrameDto } from '../types/telemetry';

const COMPACT_AFTER = 4096;

export interface TraceFilterSlice {
  readonly ids: readonly number[];
  readonly start: number;
  readonly end: number;
}

function lowerBound(ids: readonly number[], target: number, start: number, end: number): number {
  while (start < end) {
    const mid = (start + end) >>> 1;
    if (ids[mid] < target) start = mid + 1;
    else end = mid;
  }
  return start;
}

export function findFilteredFrame(slice: TraceFilterSlice, uid: number): number {
  const position = lowerBound(slice.ids, uid, slice.start, slice.end);
  return position < slice.end && slice.ids[position] === uid ? position - slice.start : -1;
}

/** Indexes stable frame UIDs. A slice remains valid while later updates append or compact the index. */
export class TraceFilterIndex {
  private ring: ChronoRingBuffer | null = null;
  private generation = -1;
  private scannedUntil = 0;
  private ids: number[] = [];
  private start = 0;
  private slice: TraceFilterSlice | null = null;

  constructor(private readonly matches: (frame: ChronologicalFrameDto) => boolean) {}

  update(ring: ChronoRingBuffer): TraceFilterSlice {
    const base = ring.baseSeq;
    const end = base + ring.length;
    if (ring !== this.ring || ring.generation !== this.generation) {
      this.ring = ring;
      this.generation = ring.generation;
      this.scannedUntil = base;
      this.ids = [];
      this.start = 0;
    }

    this.start = lowerBound(this.ids, base, this.start, this.ids.length);
    if (this.start >= COMPACT_AFTER && this.start * 2 >= this.ids.length) {
      this.ids = this.ids.slice(this.start);
      this.start = 0;
    }
    for (let uid = Math.max(base, this.scannedUntil); uid < end; uid += 1) {
      const frame = ring.getAt(uid - base);
      if (frame && this.matches(frame)) this.ids.push(uid);
    }
    this.scannedUntil = end;

    if (!this.slice || this.slice.ids !== this.ids || this.slice.start !== this.start || this.slice.end !== this.ids.length) {
      this.slice = { ids: this.ids, start: this.start, end: this.ids.length };
    }
    return this.slice;
  }
}
