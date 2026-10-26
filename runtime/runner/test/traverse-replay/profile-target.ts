/**
 * Profiling target: replays a fixture repeatedly so profile-driver.ts can
 * sample it via the V8 inspector. Run through the driver, not directly:
 *
 *   deno run --allow-all test/traverse-replay/profile-driver.ts \
 *     [fixture-name] [rounds]
 */

import { fromFileUrl } from "@std/path";
import { loadFixture, replayFixture } from "./replay.ts";

const name = Deno.args[0] ?? "notebook-test";
const rounds = Number(Deno.args[1] ?? "2");

/** Optional: replay only the invocation at this index (tail analysis). */
const onlyInvocation = Deno.args[2] !== undefined
  ? Number(Deno.args[2])
  : undefined;

const fixture = await loadFixture(
  fromFileUrl(new URL(`./fixtures/${name}.json.gz`, import.meta.url)),
);
if (onlyInvocation !== undefined) {
  fixture.invocations = [fixture.invocations[onlyInvocation]];
}

// Warm-up: intern caches, JIT.
replayFixture(fixture, { limit: 200 });

console.log("PROFILE_START");
const t0 = performance.now();
for (let i = 0; i < rounds; i++) {
  replayFixture(fixture);
}
const elapsed = performance.now() - t0;
console.log(`PROFILE_DONE ${elapsed.toFixed(0)}ms for ${rounds} rounds`);

// Stay alive so the driver can stop the profiler and collect the data.
await new Promise((resolve) => setTimeout(resolve, 120_000));
