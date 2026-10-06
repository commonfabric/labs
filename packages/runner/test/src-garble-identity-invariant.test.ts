import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import type { RuntimeProgram } from "../src/harness/types.ts";
import { Runtime } from "../src/runtime.ts";

// Identity is derived from content-addressed provenance, never from the
// sidecar-backed debug source. These integration tests pin the externally
// observable scheduler IDs now that the old `.src` garbling seam no longer
// exists. (`.src`-independence of the CFC verified-implementation identity
// is pinned in `cfc-implementation-identity.test.ts`; fingerprint
// content-addressing in the content-addressed-identity suites.)

const signer = await Identity.fromPassphrase("src identity invariant");
const space = signer.did();

function newRuntime(storageManager: ReturnType<typeof StorageManager.emulate>) {
  return new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
}

/**
 * The durable identity of every registered scheduler action for this
 * pattern, read from the live scheduler graph. Restart-stable action
 * identity stays load-bearing for server-execution v2 (the basis index's
 * `action` column — serving-loop.md §3b), so this invariant keeps its
 * guard even with the persisted-observation instrument deleted.
 */
function collectIdentities(
  runtime: Runtime,
): { actionId: string }[] {
  return runtime.scheduler.getGraphSnapshot().nodes
    .map((node) => ({ actionId: node.id }))
    .filter(({ actionId }) => actionId.startsWith("cf:module/"))
    .sort((a, b) => a.actionId.localeCompare(b.actionId));
}

async function runAndCollect(
  program: RuntimeProgram,
  resultId: string,
  argument: Record<string, number>,
  expected: unknown,
): Promise<{ actionId: string }[]> {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = newRuntime(storageManager);
  try {
    const compiled = await runtime.patternManager.compilePattern(program);
    const tx = runtime.edit();
    const resultCell = runtime.getCell<unknown>(space, resultId, undefined, tx);
    const handle = runtime.run(tx, compiled, argument, resultCell);
    await tx.commit().settled;
    for (let attempt = 0; attempt < 8; attempt++) {
      await handle.pull();
      await runtime.idle();
    }
    await runtime.storageManager.synced();
    expect(resultCell.getAsQueryResult()).toEqual(expected);
    return collectIdentities(runtime);
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
}

const DISTINCT_SYMBOLS_PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "import { pattern, computed, lift } from 'commonfabric';",
      "const dbl = lift((n: number) => n * 2);",
      "const inc = lift((n: number) => n + 1);",
      "export default pattern<{ value: number }>(({ value }) => {",
      "  const doubled = dbl(value);",
      "  const incremented = inc(value);",
      "  const sum = computed(() => (doubled as any) + (incremented as any));",
      "  return { doubled, incremented, sum };",
      "});",
    ].join("\n"),
  }],
};

Deno.test(
  "sidecar-backed debug sources do not replace content-addressed scheduler identity",
  async () => {
    const identities = await runAndCollect(
      DISTINCT_SYMBOLS_PROGRAM,
      "distinct-symbols",
      { value: 5 },
      { doubled: 10, incremented: 6, sum: 16 },
    );

    expect(identities.length).toBeGreaterThan(0);
    expect(new Set(identities.map(({ actionId }) => actionId)).size).toBe(
      identities.length,
    );
    for (const { actionId } of identities) {
      expect(actionId).toMatch(/^cf:module\//);
      expect(actionId).not.toMatch(/:\d+:\d+$/);
    }
  },
);

const MULTI_INSTANCE_PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "import { pattern, lift } from 'commonfabric';",
      "const dbl = lift((n: number) => n * 2);",
      "export default pattern<{ a: number; b: number }>(({ a, b }) => {",
      "  const da = dbl(a);",
      "  const db = dbl(b);",
      "  return { da, db };",
      "});",
    ].join("\n"),
  }],
};

Deno.test(
  "two instances of one lift retain distinct source-independent IDs",
  async () => {
    const identities = await runAndCollect(
      MULTI_INSTANCE_PROGRAM,
      "multi-instance",
      { a: 5, b: 9 },
      { da: 10, db: 18 },
    );

    expect(identities.length).toBe(2);
    expect(new Set(identities.map(({ actionId }) => actionId)).size).toBe(2);
    for (const { actionId } of identities) {
      expect(actionId).toMatch(/^cf:module\/[^:]+:dbl:[^:]+$/);
      expect(actionId).not.toMatch(/:\d+:\d+$/);
    }
  },
);
