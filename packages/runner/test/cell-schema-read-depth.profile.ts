/**
 * CPU-profile harness for the fresh-transaction whole-array read benchmark.
 *
 * Example:
 *
 *   deno run -A --cpu-prof --cpu-prof-md --cpu-prof-flamegraph \
 *     --cpu-prof-dir=/tmp/schema-read-profile \
 *     packages/runner/test/cell-schema-read-depth.profile.ts full
 *
 * Environment controls:
 * - SCHEMA_READ_DEPTH_N: list size, default 1000
 * - SCHEMA_READ_PROFILE_ITERATIONS: measured reads, default 500
 * - SCHEMA_READ_PROFILE_WARMUP: unmeasured warm-up reads, default 20
 */

import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import type { JSONSchema } from "../src/builder/types.ts";
import { Runtime } from "../src/runtime.ts";

const signer = await Identity.fromPassphrase("profile schema read depth");
const space = signer.did();
const count = Number(Deno.env.get("SCHEMA_READ_DEPTH_N") ?? "1000");
const iterations = Number(
  Deno.env.get("SCHEMA_READ_PROFILE_ITERATIONS") ?? "500",
);
const warmup = Number(Deno.env.get("SCHEMA_READ_PROFILE_WARMUP") ?? "20");
const variant = Deno.args[0] ?? "full";

const items = Array.from({ length: count }, (_, i) => ({
  data: {
    group: "Pages",
    id: `People/P${i % 40}/Notes/entry-${i}.md`,
    kind: "page",
    label: `entry-${i}`,
    name: `entry-${i}`,
    path: `People/P${i % 40}/Notes/entry-${i}.md`,
  },
  group: "Pages",
  label: `entry-${i}`,
  searchAliases: [`People/P${i % 40}/Notes/entry-${i}.md`],
  value: `page:People/P${i % 40}/Notes/entry-${i}.md`,
}));

const fullSchema = {
  type: "array",
  items: {
    type: "object",
    properties: {
      data: {
        type: "object",
        properties: {
          group: { type: "string" },
          id: { type: "string" },
          kind: { type: "string" },
          label: { type: "string" },
          name: { type: "string" },
          path: { type: "string" },
        },
      },
      group: { type: "string" },
      label: { type: "string" },
      searchAliases: { type: "array", items: { type: "string" } },
      value: { type: "string" },
    },
  },
} as const satisfies JSONSchema;

const schema = variant === "full"
  ? fullSchema
  : variant === "schemaless"
  ? undefined
  : (() => {
    throw new Error(`Unknown variant ${variant}; use full or schemaless`);
  })();

const storageManager = StorageManager.emulate({ as: signer });
const runtime = new Runtime({
  apiUrl: new URL(import.meta.url),
  storageManager,
});

const seedTx = runtime.edit();
runtime.getCell<typeof items>(space, "schema-read-depth-doc", undefined, seedTx)
  .set(items);
await seedTx.commit().settled;

function readOnce(): number {
  const tx = runtime.edit();
  const cell = runtime.getCell(
    space,
    "schema-read-depth-doc",
    schema,
    tx,
  );
  const start = performance.now();
  const value = cell.get();
  const elapsed = performance.now() - start;
  if (tx.status().status === "ready") tx.abort();
  // Keep the result observably live without forcing the schemaless proxy.
  if (value === null) throw new Error("Unexpected null read");
  return elapsed;
}

try {
  for (let i = 0; i < warmup; i++) readOnce();

  let elapsed = 0;
  for (let i = 0; i < iterations; i++) elapsed += readOnce();
  console.log(JSON.stringify({
    variant,
    count,
    iterations,
    meanMs: elapsed / iterations,
  }));
} finally {
  await runtime.dispose();
  await storageManager.close();
}
