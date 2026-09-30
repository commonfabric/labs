import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";

import type { JSONSchema } from "../../src/builder/types.ts";
import { Runtime } from "../../src/runtime.ts";
import { StorageManager } from "../../src/storage/cache.deno.ts";
import { isInternalVerifierRead } from "../../src/storage/reactivity-log.ts";
import { getTransactionReadActivities } from "../../src/storage/transaction-inspection.ts";
import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "../cfc-seed-envelope.ts";

const signer = await Identity.fromPassphrase("cfc-verifier-read-amplification");
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

describe("prepareBoundaryCommit()", () => {
  for (const targets of [10, 30, 100]) {
    it(`bounds metadata reads for ${targets} targets and commits their values`, async () => {
      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = new Runtime({
        apiUrl: new URL("https://example.com"),
        storageManager,
      });
      try {
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
        expect((await seed.commit()).error).toBeUndefined();

        const tx = runtime.edit();
        source.withTx(tx).get();
        const sinks = Array.from({ length: targets }, (_, index) => {
          const sink = runtime.getCell(
            signer.did(),
            `sink-${index}`,
            sinkSchema,
            tx,
          );
          sink.set({ out: `value-${index}` });
          return sink;
        });
        tx.prepareCfc();
        const internalReads = [...getTransactionReadActivities(tx)].filter((
          read,
        ) => isInternalVerifierRead(read.meta));
        // This fixture currently records 3 reads per target plus 1 for the
        // shared source (see cfc-verifier-metadata.bench.ts). Budget twice that
        // per-target work and 10 fixed reads so small accounting changes fit.
        // Revisit this budget if legitimate per-target work changes; repeated
        // input resolution on each target grows quadratically and exceeds it.
        expect(internalReads.length).toBeLessThanOrEqual(6 * targets + 10);
        expect((await tx.commit()).error).toBeUndefined();

        const verify = runtime.edit();
        try {
          for (const [index, sink] of sinks.entries()) {
            expect(sink.withTx(verify).get()).toEqual({
              out: `value-${index}`,
            });
          }
        } finally {
          verify.abort();
        }
      } finally {
        await runtime.dispose({ closeStorage: false });
        await storageManager.close();
      }
    });
  }
});
