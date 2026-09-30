/**
 * Measures one flow-join pass over independently varied read and label counts.
 * Paths have three to six segments, with the value, shape, and followRef
 * templates of a persisted collection alongside its concrete entries. Runtime
 * setup, journaling, and assertions stay outside timing; index construction
 * belongs to the measured pass. Fresh transactions keep verifier reads bounded.
 */

import { Identity } from "@commonfabric/identity";

import { deriveFlowJoin } from "../src/cfc/prepare.ts";
import type { LabelMapEntry } from "../src/cfc/types.ts";
import { setValueAtPath } from "../src/path-utils.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { benchDiagnostic } from "./bench-diagnostics.ts";
import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "./cfc-seed-envelope.ts";

const signer = await Identity.fromPassphrase("cfc-flow-join-bench");
const storageManager = StorageManager.emulate({ as: signer });
const runtime = new Runtime({
  apiUrl: new URL("https://example.com"),
  storageManager,
});

for (const entries of [100, 300, 1000]) {
  const paths = Array.from({ length: entries - 3 }, (_, index) => [
    "rows",
    String(index),
    ...["profile", "detail", "name", "text"].slice(0, 1 + index % 4),
  ]);
  const labels: LabelMapEntry[] = paths.map((path) => ({
    path,
    origin: "derived",
    observes: "value",
    label: { confidentiality: ["content"] },
  }));
  for (const observes of ["value", "shape", "followRef"] as const) {
    labels.push({
      path: ["rows", "*"],
      origin: "structure",
      observes,
      label: { confidentiality: ["membership"] },
    });
  }
  const value = {};
  for (const path of paths) setValueAtPath(value, path, "payload");
  const seed = runtime.edit();
  const address = runtime.getCell(
    signer.did(),
    `entries-${entries}`,
    undefined,
    seed,
  ).getAsNormalizedFullLink();
  writeSeedEnvelopeDoc(seed, signer.did());
  seedStoredEnvelope(seed, { ...address, path: [] }, {
    value,
    cfc: {
      version: 1,
      schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
      labelMap: { version: 1, entries: labels },
    },
  });
  const committed = await seed.commit();
  if (committed.error) throw committed.error;
  const inspection = runtime.edit();
  try {
    const stored = inspection.readOrThrow({
      ...address,
      path: ["cfc", "labelMap", "entries"],
    });
    if (!Array.isArray(stored) || stored.length !== entries) {
      throw new Error(`Expected ${entries} stored label entries`);
    }
  } finally {
    inspection.abort();
  }

  for (const reads of [50, 200, 800]) {
    /** Journals exactly R overlapping reads, then times one complete pass. */
    const measure = (timer?: Deno.BenchContext): void => {
      const tx = runtime.edit();
      try {
        for (let index = 0; index < reads; index++) {
          const read = tx.readOrThrow({
            ...address,
            path: ["value", ...paths[index % paths.length]],
          });
          if (read !== "payload") throw new Error("Missing benchmark payload");
        }
        const count = [...(tx.getReadActivities?.() ?? [])].length;
        timer?.start();
        const join = deriveFlowJoin(tx);
        timer?.end();
        if (
          count !== reads || join.confidentiality.length !== 2 ||
          !join.confidentiality.includes("content") ||
          !join.confidentiality.includes("membership") ||
          join.integrity.length !== 0
        ) throw new Error(`Invalid flow fixture: E=${entries} R=${reads}`);
      } finally {
        tx.abort();
      }
    };
    measure();
    benchDiagnostic(JSON.stringify({ entries, reads, depth: "3-6" }));
    Deno.bench({
      name: `E=${entries} R=${reads}`,
      group: "flow join",
      fn: measure,
    });
  }
}

globalThis.addEventListener("unload", () => {
  void (async () => {
    await runtime.dispose();
    await storageManager.close();
  })();
});
