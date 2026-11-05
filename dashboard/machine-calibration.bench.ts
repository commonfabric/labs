/**
 * Measures the machine the Benchmarks workflow landed on, so the dashboard can
 * divide it out of what the repository did.
 *
 * The workflow runs this file alongside the product benchmarks and uploads its
 * timings in the same bench-results artifact. Nothing here imports or calls
 * repository code, so a change to these numbers between two runs on the same
 * processor is a change in the machine: its clock, its memory, its allocator,
 * or how much of it another tenant was using. The benchmark tile divides that
 * out of its per-processor index, so a run that landed on a busy host reads as
 * the busy host it was rather than as a code regression.
 *
 * The bodies below are the ruler, so they do not change. Editing one moves its
 * timings, and the tile reads that move as the machine changing under a
 * processor that did not. Adding a benchmark is safe: the tile compares each
 * pair of runs over the calibration benchmarks they share, so one that exists
 * on only the newer side takes no part until both sides carry it. Removing one
 * is safe for the same reason. Rewriting one is not.
 *
 * The set spans what a shared host actually slows down: arithmetic throughput,
 * allocation and collection, memory bandwidth, and the hash-table work every
 * interpreter leans on. It says nothing about anything else, and is not a
 * benchmark of the repository: the tile keeps these out of its index, its
 * benchmark count and its drill-down.
 */

// Every body accumulates into this. It is exported so the work behind it is
// observable outside the module and cannot be dropped as dead.
export let sink = 0;

// The warmup each body takes, in calls. Two things keep a ruler from wobbling
// on its own. Each body runs long enough — a few hundred microseconds — that
// the just-in-time compiler has settled by the time it is measured, because a
// body of a few tens of microseconds is measured partly interpreted and partly
// compiled, and which it is varies between runs by more than the machine does.
// And the warmup below puts that settling before the timings rather than
// inside them. Anything declared once belongs at module scope for the same
// reason: a class declared inside a body is a new class on every call, with
// new shapes for the compiler to learn each time.
const WARMUP = 200;

class Doubler {
  constructor(readonly value: number) {}
  get doubled(): number {
    return this.value * 2;
  }
}

interface Link {
  value: number;
  next: Link | null;
}

Deno.bench("machine calibration - integer arithmetic", {
  warmup: WARMUP,
}, () => {
  let total = 0;
  for (let i = 1; i <= 200_000; i++) {
    total = (total + i * 2654435761) | 0;
    total ^= total >>> 13;
  }
  sink += total;
});

Deno.bench("machine calibration - floating point arithmetic", {
  warmup: WARMUP,
}, () => {
  let total = 0;
  for (let i = 1; i <= 200_000; i++) {
    total += Math.sqrt(i) / (i + 0.5);
  }
  sink += total;
});

Deno.bench("machine calibration - short-lived object allocation", {
  warmup: WARMUP,
}, () => {
  let total = 0;
  for (let i = 0; i < 200_000; i++) {
    const point = { x: i, y: i + 1, z: i + 2 };
    total += point.x + point.y + point.z;
  }
  sink += total;
});

Deno.bench("machine calibration - retained object graph", {
  warmup: WARMUP,
}, () => {
  const held: Link[] = [];
  let previous: Link | null = null;
  for (let i = 0; i < 100_000; i++) {
    previous = { value: i, next: previous };
    if ((i & 1023) === 0) held.push(previous);
  }
  sink += held.length;
});

Deno.bench("machine calibration - array fill and sum", {
  warmup: WARMUP,
}, () => {
  const values = new Array<number>(200_000);
  for (let i = 0; i < values.length; i++) values[i] = i & 255;
  let total = 0;
  for (let i = 0; i < values.length; i++) total += values[i];
  sink += total;
});

Deno.bench("machine calibration - typed array write and read", {
  warmup: WARMUP,
}, () => {
  const values = new Float64Array(200_000);
  for (let i = 0; i < values.length; i++) values[i] = i * 0.5;
  let total = 0;
  for (let i = 0; i < values.length; i++) total += values[i];
  sink += total;
});

Deno.bench("machine calibration - string building", {
  warmup: WARMUP,
}, () => {
  let text = "";
  for (let i = 0; i < 40_000; i++) text += (i & 15).toString(16);
  sink += text.length;
});

Deno.bench("machine calibration - map insert and read", {
  warmup: WARMUP,
}, () => {
  const map = new Map<number, number>();
  for (let i = 0; i < 50_000; i++) map.set(i, i * 3);
  let total = 0;
  for (let i = 0; i < 50_000; i++) total += map.get(i)!;
  sink += total;
});

Deno.bench("machine calibration - set insert and lookup", {
  warmup: WARMUP,
}, () => {
  const set = new Set<string>();
  for (let i = 0; i < 20_000; i++) set.add(`k${i & 4095}`);
  let total = 0;
  for (let i = 0; i < 20_000; i++) if (set.has(`k${i}`)) total++;
  sink += total;
});

Deno.bench("machine calibration - property access through a prototype", {
  warmup: WARMUP,
}, () => {
  let total = 0;
  for (let i = 0; i < 200_000; i++) total += new Doubler(i).doubled;
  sink += total;
});

Deno.bench("machine calibration - closure allocation and call", {
  warmup: WARMUP,
}, () => {
  let total = 0;
  for (let i = 0; i < 200_000; i++) {
    const add = (value: number) => value + i;
    total = add(total) & 0xffffff;
  }
  sink += total;
});

Deno.bench("machine calibration - json round trip", {
  warmup: WARMUP,
}, () => {
  let total = 0;
  for (let i = 0; i < 4_000; i++) {
    const parsed = JSON.parse(
      JSON.stringify({ id: i, tags: ["a", "b", "c"], nested: { depth: i } }),
    ) as { id: number };
    total += parsed.id;
  }
  sink += total;
});
