/**
 * Replay benchmarks over captured traverse fixtures — realistic traversal
 * load, unlike the synthetic micro-benches. See test/traverse-replay/README.md
 * for the capture/replay/golden workflow.
 *
 * Large fixtures are sliced to keep CI iterations fast; set
 * CF_REPLAY_BENCH_FULL=1 to replay every recorded invocation (the
 * optimization-loop metric). Set BENCH_DIAGNOSTICS=1 to print traverser
 * counter totals per fixture on exit — wall-time wins should come with a
 * counter explanation (e.g. anyOfBranches down 80%).
 */

import { listFixturePaths } from "./traverse-replay/goldens.ts";
import {
  loadFixture,
  replayFixture,
  type ReplayMetrics,
} from "./traverse-replay/replay.ts";

const FULL = Deno.env.get("CF_REPLAY_BENCH_FULL") === "1";
const DIAGNOSTICS = Deno.env.get("BENCH_DIAGNOSTICS") === "1";

/** Per-iteration invocation caps for slow fixtures (CI keeps trend lines). */
const SLICE: Record<string, number> = {
  "notebook-test": 500,
};

const lastMetrics = new Map<string, ReplayMetrics>();

for (const { name, path } of listFixturePaths()) {
  const fixture = await loadFixture(path);
  const limit = FULL ? undefined : SLICE[name];
  const label = limit !== undefined
    ? `replay ${name} [first ${limit} of ${fixture.invocations.length}]`
    : `replay ${name}`;
  Deno.bench(label, () => {
    const { metrics } = replayFixture(fixture, { limit });
    lastMetrics.set(name, metrics);
  });
}

const lastLatency = new Map<string, string>();
if (DIAGNOSTICS) {
  // One latency-collected pass per fixture for tail tracking (p99/max are
  // the tail metrics; see docs/history/packages/runner/test/traverse-replay/
  // OPTIMIZATION-JOURNAL.md "tail round").
  for (const { name, path } of listFixturePaths()) {
    const fixture = await loadFixture(path);
    replayFixture(fixture); // warm
    const { latency } = replayFixture(fixture, { collectLatency: true });
    if (latency !== undefined) {
      lastLatency.set(
        name,
        `p50=${latency.p50.toFixed(3)} p99=${latency.p99.toFixed(2)} ` +
          `p99.9=${latency.p999.toFixed(2)} max=${latency.max.toFixed(2)} ` +
          `mean=${latency.mean.toFixed(3)} (ms/invocation)`,
      );
    }
  }
}

if (DIAGNOSTICS) {
  globalThis.addEventListener("unload", () => {
    for (const [name, m] of lastMetrics) {
      console.error(
        `[diagnostics] ${name}: invocations=${m.invocations} ` +
          `schemaCalls=${m.traverseWithSchemaCalls} ` +
          `pointer=${m.traversePointerCalls} array=${m.traverseArrayCalls} ` +
          `object=${m.traverseObjectCalls} dag=${m.traverseDAGCalls} ` +
          `anyOf=${m.anyOfBranches} anyOfFastRejects=${m.anyOfFastRejects} ` +
          `getDocAtPath=${m.getDocAtPathCalls} ` +
          `memoHits=${m.schemaMemoHits}`,
      );
      const latency = lastLatency.get(name);
      if (latency !== undefined) {
        console.error(`[diagnostics] ${name}: latency ${latency}`);
      }
    }
  });
}
