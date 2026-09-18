/**
 * Deterministic discrete-event scheduler (binary min-heap).
 *
 * Items are ordered by (time, priority, insertion sequence). The priority classes fix the
 * order of things that happen "at the same simulated millisecond":
 *
 *   MARKET   market observations (book snapshots, trades) become visible / can fill orders
 *   EXCHANGE order state transitions (order goes live, cancel takes effect)
 *   OUTCOME  fill outcome (markout) measurements whose horizon elapsed
 *   WINDOW   controller window boundary (review + steering instruction)
 *   TICK     fast policy decision tick
 *
 * Consequences (all deliberate, all pessimistic for a passive quoter):
 *   - a trade at t is processed before an order that goes live at t -> no fill for that trade
 *   - a trade at t is processed before a cancel that takes effect at t -> the fill wins the race
 *   - the controller runs before the first policy tick of the next window at the same t
 */
export const Priority = {
  MARKET: 0,
  EXCHANGE: 10,
  OUTCOME: 20,
  WINDOW: 30,
  TICK: 40,
} as const;

export type Handler = () => void | Promise<void>;

export interface ScheduledItem {
  readonly time: number;
  readonly priority: number;
  readonly seq: number;
  readonly run: Handler;
}

export class Scheduler {
  private heap: ScheduledItem[] = [];
  private seq = 0;
  private lastPopped: ScheduledItem | null = null;

  schedule(time: number, priority: number, run: Handler): void {
    if (!Number.isFinite(time) || !Number.isInteger(time)) {
      throw new RangeError(`schedule time must be an integer millisecond, got ${time}`);
    }
    const last = this.lastPopped;
    if (last && (time < last.time || (time === last.time && priority < last.priority))) {
      throw new Error(
        `causality violation: cannot schedule (t=${time}, p=${priority}) while processing (t=${last.time}, p=${last.priority})`,
      );
    }
    const item: ScheduledItem = { time, priority, seq: this.seq++, run };
    this.heap.push(item);
    this.siftUp(this.heap.length - 1);
  }

  get size(): number {
    return this.heap.length;
  }

  peek(): ScheduledItem | undefined {
    return this.heap[0];
  }

  pop(): ScheduledItem | undefined {
    const heap = this.heap;
    if (heap.length === 0) return undefined;
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      this.siftDown(0);
    }
    this.lastPopped = top;
    return top;
  }

  private less(a: ScheduledItem, b: ScheduledItem): boolean {
    if (a.time !== b.time) return a.time < b.time;
    if (a.priority !== b.priority) return a.priority < b.priority;
    return a.seq < b.seq;
  }

  private siftUp(i: number): void {
    const heap = this.heap;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.less(heap[i]!, heap[parent]!)) {
        [heap[i], heap[parent]] = [heap[parent]!, heap[i]!];
        i = parent;
      } else break;
    }
  }

  private siftDown(i: number): void {
    const heap = this.heap;
    const n = heap.length;
    for (;;) {
      const l = 2 * i + 1;
      const r = l + 1;
      let m = i;
      if (l < n && this.less(heap[l]!, heap[m]!)) m = l;
      if (r < n && this.less(heap[r]!, heap[m]!)) m = r;
      if (m === i) return;
      [heap[i], heap[m]] = [heap[m]!, heap[i]!];
      i = m;
    }
  }
}
