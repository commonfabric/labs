/**
 * MANUAL diagnostic script (not a test): measures the synchronous event-loop
 * wedge of a cold pattern compile, in-process, without browsers.
 *
 * Mirrors what the browser runtime worker does when a fresh space boots:
 * resolve system/default-app.tsx and run engine.compileToRecordGraph +
 * evaluateRecordGraph. A fine-grained timer probe measures the longest stretch
 * the event loop could not run macrotasks (the "workerLag" of the browser
 * instrumentation), and the js-compiler phase spans decompose where it goes.
 *
 * Run: deno run -A runtime/runner/test/manual-compile-wedge.ts
 */

import * as path from "@std/path";

import { Identity } from "@commonfabric/identity";
import { resolveLocalProgram } from "../src/harness/local-program.deno.ts";
import { getTimingStatsBreakdown } from "@commonfabric/utils/logger";

import type { Engine } from "../src/harness/engine.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";

const repoRoot = path.resolve(
  path.dirname(path.fromFileUrl(import.meta.url)),
  "..",
  "..",
  "..",
);

const signer = await Identity.fromPassphrase("test operator");
const storageManager = StorageManager.emulate({ as: signer });
const runtime = new Runtime({
  apiUrl: new URL(import.meta.url),
  storageManager,
});
const engine = runtime.harness as Engine;

const entry = path.join(
  repoRoot,
  "patterns",
  "system",
  "default-app",
  "default-app.tsx",
);
const root = path.join(repoRoot, "patterns");
const program = await resolveLocalProgram(
  (resolver) => engine.resolve(resolver),
  { main: entry, root },
);
console.log(`resolved files: ${program.files.length}`);

// Event-loop lag probe at 5ms period: max observed gap ≈ the longest single
// synchronous stretch (what the browser's runner.loop/workerLag would see).
let maxLag = 0;
let lagExpected = performance.now() + 5;
const probe = setInterval(() => {
  const now = performance.now();
  const lag = now - lagExpected;
  if (lag > maxLag) maxLag = lag;
  lagExpected = now + 5;
}, 5);

const compileStart = performance.now();
const compiled = await engine.compileToRecordGraph(program, {});
const compileMs = performance.now() - compileStart;

const compileMaxLag = maxLag;
maxLag = 0;

const evalStart = performance.now();
engine.evaluateRecordGraph(
  compiled.id,
  compiled.graph,
  compiled.mainSpecifier,
  program,
);
const evalMs = performance.now() - evalStart;
// One macrotask turn so the probe can observe the evaluate stretch.
await new Promise((resolve) => setTimeout(resolve, 12));
clearInterval(probe);
const evalMaxLag = maxLag;

console.log(
  `compileToRecordGraph: ${Math.round(compileMs)}ms ` +
    `(longest sync stretch ≈ ${Math.round(compileMaxLag)}ms), ` +
    `modules=${compiled.modules.length}`,
);
console.log(
  `evaluateRecordGraph: ${Math.round(evalMs)}ms ` +
    `(longest sync stretch ≈ ${Math.round(evalMaxLag)}ms)`,
);

const stats = getTimingStatsBreakdown();
for (const [loggerName, byKey] of Object.entries(stats)) {
  if (!/^(js-compiler|harness|runner\.harness)/.test(loggerName)) continue;
  for (const [key, s] of Object.entries(byKey)) {
    const row = s as { count: number; totalTime: number; max: number };
    console.log(
      `  ${loggerName}/${key}: n=${row.count} total=${
        Math.round(row.totalTime)
      }ms max=${Math.round(row.max)}ms`,
    );
  }
}

await runtime.dispose();
await storageManager.close();
