/** Builds labeled reads and reference-container writes for prepare benchmarks. */

import { Identity } from "@commonfabric/identity";

import { cfcLabelViewFromMetadata } from "../src/cfc/label-view-state.ts";
import type { LabelMapEntry } from "../src/cfc/types.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import type { ExtendedStorageTransaction } from "../src/storage/extended-storage-transaction.ts";
import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "./cfc-seed-envelope.ts";

/** Constructs a reusable source; each sample receives a fresh transaction. */
export async function prepareLadderFixture(entries: number) {
  const signer = await Identity.fromPassphrase("cfc-prepare-ladder");
  const space = signer.did();
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
    cfcEnforcementMode: "enforce-explicit",
    cfcFlowLabels: "persist",
  });
  const seed = runtime.edit();
  const source = runtime.getCell(space, "source", undefined, seed);
  const address = source.getAsNormalizedFullLink();
  const labels: LabelMapEntry[] = [];
  const value: Record<string, { text: string }> = {};
  for (let i = 0; i < entries; i++) {
    const container = `row${Math.floor(i / 4)}`;
    value[container] = { text: "payload" };
    const slot = i % 4;
    labels.push({
      path: slot === 0 ? [container] : [container, "*"],
      origin: "structure",
      observes: (["enumerate", "shape", "value", "followRef"] as const)[slot],
      label: { confidentiality: ["secret"] },
    });
  }
  writeSeedEnvelopeDoc(seed, space);
  seedStoredEnvelope(seed, { ...address, path: [] }, {
    value,
    cfc: {
      version: 1,
      schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
      labelMap: { version: 1, entries: labels },
    },
  });
  const destination = runtime.getCell(space, "destination", undefined, seed);
  seed.writeOrThrow({ ...destination.getAsNormalizedFullLink(), path: [] }, {
    value: {},
  });
  const committed = await seed.commit();
  if (committed.error) throw committed.error;
  return {
    runtime,
    make(reads: number, paths: number, directWrites = false) {
      const tx = runtime.edit() as ExtendedStorageTransaction;
      const target = runtime.getCell(space, "destination", undefined, tx);
      for (let p = 0; p < paths; p++) {
        const sourcePath = [`row${p % Math.ceil(entries / 4)}`];
        const view = cfcLabelViewFromMetadata({
          version: 1,
          schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
          labelMap: { version: 1, entries: labels },
        }, sourcePath);
        const sourceCell = runtime.getCellFromLink(
          { ...address, path: sourcePath },
          undefined,
          tx,
          view,
        );
        if (directWrites) {
          const targetAddress = target.getAsNormalizedFullLink();
          tx.writeOrThrow({
            ...targetAddress,
            path: ["value", `container${p}`],
          }, [sourceCell.getAsLink()]);
          tx.recordCfcWritePolicyInput({
            kind: "link-write",
            target: { ...targetAddress, path: [`container${p}`, "0"] },
            source: { ...address, path: sourcePath },
            cfcLabelView: view,
          });
        } else target.key(`container${p}`).set([sourceCell]);
      }
      for (let r = 0; r < reads; r++) {
        tx.readOrThrow({
          ...address,
          path: ["value", `row${r % Math.ceil(entries / 4)}`],
        });
      }
      runtime.resetCfcStats();
      return tx;
    },
    async dispose() {
      await runtime.dispose();
      await storageManager.close();
    },
  };
}
