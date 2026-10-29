/**
 * Compares whole-array materialization cost across schema DEPTH on one
 * unchanged doc.
 *
 * Each iteration seeds one list, creates one fresh transaction, binds the cell
 * to it, and times one get() of the whole array through schemas of increasing
 * depth:
 *
 *   - schemaless            → the baseline proxy path
 *   - items: true           → schema path entered, zero per-item validation
 *   - items: {type:object}  → permissive object schema (no properties)
 *   - full item schema      → every field declared
 *
 * The transaction is created outside the timed window: this benchmark isolates
 * Cell.get() materialization rather than transaction construction. A single
 * transaction spans the whole-array read, matching normal runtime use; it is
 * not the committed setup transaction and does not fall back to the ambient
 * tx-less read path.
 *
 * A separate read-journal group uses the full item schema to measure the
 * end-to-end cost of consuming recorded reads and isolate the readout itself:
 *
 *   - get() alone
 *   - get() followed by fully materializing getReadActivities()
 *   - materializing getReadActivities() after an untimed get()
 *
 * Environment controls:
 * - SCHEMA_READ_DEPTH_N: list size, default 1000
 */

import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import { type JSONSchema } from "../src/builder/types.ts";
import { getTransactionReadActivities } from "../src/storage/transaction-inspection.ts";

const signer = await Identity.fromPassphrase("bench schema read depth");
const space = signer.did();

const N = Number(Deno.env.get("SCHEMA_READ_DEPTH_N") ?? "1000");

const items = Array.from({ length: N }, (_, i) => ({
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

const FULL_ITEM_SCHEMA = {
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
} as const satisfies JSONSchema;

const VARIANTS: [string, JSONSchema | undefined][] = [
  ["schemaless", undefined],
  ["items:true (passthrough)", { type: "array", items: true }],
  ["items:{type:object} (permissive)", {
    type: "array",
    items: { type: "object" },
  }],
  ["full item schema", { type: "array", items: FULL_ITEM_SCHEMA }],
];

function setup() {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  return { runtime, storageManager };
}

async function seed(
  runtime: Runtime,
): Promise<void> {
  const tx = runtime.edit();
  runtime.getCell<typeof items>(space, "schema-read-depth-doc", undefined, tx)
    .set(items);
  await tx.commit().settled;
}

for (const [label, schema] of VARIANTS) {
  Deno.bench({
    name: `schema read depth - ${label} - fresh-tx get() (${N} items)`,
    group: "schema-read-depth",
    baseline: schema === undefined,
    async fn(b) {
      const { runtime, storageManager } = setup();
      await seed(runtime);
      const tx = runtime.edit();
      const cell = runtime.getCell(
        space,
        "schema-read-depth-doc",
        schema as JSONSchema | undefined,
        tx,
      );
      try {
        b.start();
        cell.get();
        b.end();
      } finally {
        if (tx.status().status === "ready") tx.abort();
        await runtime.dispose();
        await storageManager.close();
      }
    },
  });
}

const READ_JOURNAL_VARIANTS = [
  ["get() only", false],
  ["get() + materialize read activities", true],
] as const;

for (const [label, materializeReadActivities] of READ_JOURNAL_VARIANTS) {
  Deno.bench({
    name: `schema read journal - ${label} (${N} items)`,
    group: "schema-read-journal",
    baseline: !materializeReadActivities,
    async fn(b) {
      const { runtime, storageManager } = setup();
      await seed(runtime);
      const tx = runtime.edit();
      const cell = runtime.getCell(
        space,
        "schema-read-depth-doc",
        { type: "array", items: FULL_ITEM_SCHEMA },
        tx,
      );
      let readCount: number | undefined;
      try {
        b.start();
        cell.get();
        if (materializeReadActivities) {
          readCount = Array.from(getTransactionReadActivities(tx)).length;
        }
        b.end();
        if (readCount !== undefined && readCount < N) {
          throw new Error(
            `Expected at least ${N} read activities, got ${readCount}`,
          );
        }
      } finally {
        if (tx.status().status === "ready") tx.abort();
        await runtime.dispose();
        await storageManager.close();
      }
    },
  });
}

Deno.bench({
  name: `schema read journal - materialize read activities only (${N} items)`,
  group: "schema-read-journal-expansion",
  async fn(b) {
    const { runtime, storageManager } = setup();
    await seed(runtime);
    const tx = runtime.edit();
    const cell = runtime.getCell(
      space,
      "schema-read-depth-doc",
      { type: "array", items: FULL_ITEM_SCHEMA },
      tx,
    );
    let readCount = 0;
    try {
      cell.get();
      b.start();
      readCount = Array.from(getTransactionReadActivities(tx)).length;
      b.end();
      if (readCount < N) {
        throw new Error(
          `Expected at least ${N} read activities, got ${readCount}`,
        );
      }
    } finally {
      if (tx.status().status === "ready") tx.abort();
      await runtime.dispose();
      await storageManager.close();
    }
  },
});
