/**
 * Measures commit-boundary verification as the number of protected targets grows.
 *
 * Every target depends on one endorsed source document. The verifier must inspect
 * that source for each target, while a prepare-local metadata resolver can share
 * the validated envelope. Sizes 10, 30, and 100 expose read amplification without
 * changing source or label-map width.
 *
 * Source seeding, target construction, validation, counters, and cleanup are
 * outside timing. Each sample uses a fresh transaction, so its verifier journal
 * and metadata resolver start empty. The benchmark measures elapsed prepare time;
 * it does not claim process CPU or isolate storage from schema and label work.
 */

import { Identity } from "@commonfabric/identity";

import type { JSONSchema } from "../src/builder/types.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { isInternalVerifierRead } from "../src/storage/reactivity-log.ts";
import { benchDiagnostic } from "./bench-diagnostics.ts";
import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "./cfc-seed-envelope.ts";

const signer = await Identity.fromPassphrase("cfc-verifier-metadata-bench");
const storageManager = StorageManager.emulate({ as: signer });
const runtime = new Runtime({
  apiUrl: new URL("https://example.com"),
  storageManager,
});
const endorsement = "screened-input";
const sinkSchema = {
  type: "object",
  properties: {
    out: {
      type: "string",
      ifc: {
        requiredIntegrity: [endorsement],
        addIntegrity: [endorsement],
      },
    },
  },
  required: ["out"],
} as const satisfies JSONSchema;

const seed = runtime.edit();
const source = runtime.getCell(signer.did(), "source", undefined, seed);
const sourceAddress = source.getAsNormalizedFullLink();
writeSeedEnvelopeDoc(seed, signer.did());
seedStoredEnvelope(seed, { ...sourceAddress, path: [] }, {
  value: "trusted",
  cfc: {
    version: 1,
    schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
    labelMap: {
      version: 1,
      entries: [{ path: [], label: { integrity: [endorsement] } }],
    },
  },
});
const seeded = await seed.commit();
if (seeded.error) throw seeded.error;

for (const targets of [10, 30, 100]) {
  /** One boundary preparation with a fresh transaction and verifier journal. */
  const measure = (timer?: Deno.BenchContext): number => {
    const tx = runtime.edit();
    try {
      source.withTx(tx).get();
      const sinks = Array.from({ length: targets }, (_, index) => {
        const sink = runtime.getCell(
          signer.did(),
          `sink-${targets}-${index}`,
          sinkSchema,
          tx,
        );
        sink.set({ out: `value-${index}` });
        return sink;
      });

      timer?.start();
      tx.prepareCfc();
      timer?.end();

      const internalReads =
        [...(tx.getReadActivities?.() ?? [])].filter((read) =>
          isInternalVerifierRead(read.meta)
        ).length;
      for (const [index, sink] of sinks.entries()) {
        if (sink.withTx(tx).get()?.out !== `value-${index}`) {
          throw new Error(`Unexpected target value at ${targets}/${index}`);
        }
      }
      return internalReads;
    } finally {
      tx.abort();
    }
  };

  const internalReads = measure();
  benchDiagnostic(JSON.stringify({
    targets,
    endorsedSources: 1,
    labelEntries: 1,
    prepareCalls: 1,
    internalReads,
  }));
  Deno.bench({
    name: `${targets} targets`,
    group: "cfc verifier metadata",
    fn: (timer) => {
      measure(timer);
    },
  });
}

globalThis.addEventListener("unload", () => {
  void (async () => {
    await runtime.dispose({ closeStorage: false });
    await storageManager.close();
  })();
});
