/**
 * Compares eager and lazy reads of one scalar or one field from every row.
 * Each sample uses a fresh transaction over the same fully declared schema.
 * Seeding, validation, journal inspection, and disposal are outside the timed
 * interval. Journal activity counts describe storage reads, not proxy accesses.
 */

import { Identity } from "@commonfabric/identity";

import type { JSONSchema } from "../src/builder/types.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { getTransactionReadActivities } from "../src/storage/transaction-inspection.ts";
import { benchDiagnostic } from "./bench-diagnostics.ts";

const identity = await Identity.fromPassphrase("schema read width benchmark");
const schema = {
  type: "array",
  items: {
    type: "object",
    properties: {
      amount: { type: "number" },
      title: { type: "string" },
      metadata: {
        type: "object",
        properties: {
          category: { type: "string" },
          tags: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
} as const satisfies JSONSchema;

for (const size of [74, 296, 1184]) {
  const rows = Array.from({ length: size }, (_, index) => ({
    amount: index + 1,
    title: `Row ${index}`,
    metadata: { category: "example", tags: ["first", "second"] },
  }));
  for (const width of ["one scalar", "all rows"]) {
    for (const lazy of [false, true]) {
      let reported = false;
      Deno.bench({
        name: `${lazy ? "lazy" : "eager"} ${width} (${size} rows)`,
        group: `schema-read-width-${size}-${width}`,
        baseline: !lazy,
        n: 5,
        warmup: 1,
        async fn(b) {
          await using cleanup = new AsyncDisposableStack();
          const storage = StorageManager.emulate({ as: identity });
          cleanup.defer(() => storage.close());
          const runtime = new Runtime({
            apiUrl: new URL(import.meta.url),
            storageManager: storage,
          });
          cleanup.defer(() => runtime.dispose({ closeStorage: false }));
          const seed = runtime.edit();
          cleanup.defer(() => {
            if (seed.status().status === "ready") seed.abort();
          });
          runtime.getCell(identity.did(), "rows", undefined, seed).set(rows);
          const committed = await seed.commit().settled;
          if (committed.error) throw new Error("Benchmark seeding failed");
          const tx = runtime.edit();
          cleanup.defer(() => {
            if (tx.status().status === "ready") tx.abort();
          });
          tx.markLazyMaterialize(lazy);
          const cell = runtime.getCell<typeof rows>(
            identity.did(),
            "rows",
            schema,
            tx,
          );
          b.start();
          const value = cell.get();
          const total = width === "one scalar"
            ? value[0].amount
            : value.reduce((sum, row) => sum + row.amount, 0);
          b.end();
          const expected = width === "one scalar" ? 1 : size * (size + 1) / 2;
          if (total !== expected) {
            throw new Error(`Expected ${expected}, received ${total}`);
          }
          const activities =
            Array.from(getTransactionReadActivities(tx)).length;
          if (activities === 0) {
            throw new Error("The read registered no activity");
          }
          if (!reported) {
            benchDiagnostic(
              JSON.stringify({ size, width, lazy, total, activities }),
            );
            reported = true;
          }
        },
      });
    }
  }
}
