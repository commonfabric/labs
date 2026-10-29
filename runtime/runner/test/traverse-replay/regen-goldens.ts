/**
 * Regenerate the golden oracles for all traverse replay fixtures.
 *
 * Run this ONLY when a semantic change to traversal is intended; the golden
 * diff in the PR is the artifact justifying the change. From runtime/runner:
 *
 *   deno run --allow-read --allow-write \
 *     test/traverse-replay/regen-goldens.ts
 */

import { listFixturePaths, writeGolden } from "./goldens.ts";
import { loadFixture, replayFixture } from "./replay.ts";

for (const { name, path } of listFixturePaths()) {
  const fixture = await loadFixture(path);
  const t0 = performance.now();
  const { oracle, metrics } = replayFixture(fixture, { collectOracle: true });
  const elapsed = performance.now() - t0;
  await writeGolden(name, oracle!);
  console.log(
    `${name}: ${fixture.invocations.length} invocations replayed in ` +
      `${elapsed.toFixed(0)}ms ` +
      `(schemaCalls=${metrics.traverseWithSchemaCalls} ` +
      `anyOf=${metrics.anyOfBranches} reads=${metrics.reads})`,
  );
}
