/**
 * Measures source collection over labeled transaction reads as their count grows.
 *
 * The sizes are the axis: scanning every source already kept costs the square
 * of the consumed-source count. Each address contributes two distinct atoms,
 * so 458 and 2668 sources mean 229 and 1334 reads, with nothing to deduplicate.
 * All reads share a document, exercising path identity on every comparison.
 *
 * `root label` holds label-map width at one. `field labels` puts the same two
 * atoms at each read path, holding read and source counts fixed while growing
 * metadata width. This separates source dedup from per-read label-map work.
 * Both use four-segment logical paths and real emulated storage transactions.
 * They measure the collector, not lift/map execution or pane startup.
 *
 * Construction, value reads, assertions, and cleanup are outside timing. Each
 * sample uses a fresh transaction so verifier-read journals cannot accumulate.
 */

import { CFC_ATOM_TYPE } from "@commonfabric/api/cfc";
import { Identity } from "@commonfabric/identity";

import { collectConsumedLabel } from "../src/cfc/prepare.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { benchDiagnostic } from "./bench-diagnostics.ts";
import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "./cfc-seed-envelope.ts";

const signer = await Identity.fromPassphrase("cfc-consumed-source-dedup-bench");
const storageManager = StorageManager.emulate({ as: signer });
const runtime = new Runtime({
  apiUrl: new URL("https://example.com"),
  storageManager,
});
const confidentiality = [
  { type: CFC_ATOM_TYPE.User, subject: "did:key:alice" },
  { type: CFC_ATOM_TYPE.User, subject: "did:key:bob" },
];

for (const size of [128, 458, 916, 1832, 2668]) {
  const reads = size / 2;
  const paths = Array.from(
    { length: reads },
    (_, index) => ["rows", String(index), "profile", "name"],
  );
  for (const fieldLabels of [false, true]) {
    const layout = fieldLabels ? "field labels" : "root label";
    const seed = runtime.edit();
    const address = runtime.getCell(
      signer.did(),
      `${layout}-${size}`,
      undefined,
      seed,
    ).getAsNormalizedFullLink();
    writeSeedEnvelopeDoc(seed, signer.did());
    seedStoredEnvelope(seed, { ...address, path: [] }, {
      value: {
        rows: paths.map((_, index) => ({
          profile: { name: `person-${index}` },
        })),
      },
      cfc: {
        version: 1,
        schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
        labelMap: {
          version: 1,
          entries: (fieldLabels ? paths : [[]]).map((path) => ({
            path,
            label: { confidentiality },
          })),
        },
      },
    });
    const committed = await seed.commit();
    if (committed.error) throw committed.error;

    /** One collector call with a fixed read set and a fresh verifier journal. */
    const measure = (timer?: Deno.BenchContext): void => {
      const tx = runtime.edit();
      try {
        for (const path of paths) tx.readValueOrThrow({ ...address, path });
        const activities = [...(tx.getReadActivities?.() ?? [])].length;
        timer?.start();
        const result = collectConsumedLabel(tx);
        timer?.end();
        if (
          activities !== reads || result.sources.length !== size ||
          result.confidentiality.length !== 2
        ) {
          throw new Error(
            `Unexpected consumed-source fixture: ${layout} ${size}`,
          );
        }
      } finally {
        tx.abort();
      }
    };

    measure();
    benchDiagnostic(JSON.stringify({
      layout,
      sources: size,
      reads,
      labelEntries: fieldLabels ? reads : 1,
      collectorCalls: 1,
    }));
    Deno.bench({
      name: `${layout} ${size}`,
      group: "cfc consumed sources",
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
