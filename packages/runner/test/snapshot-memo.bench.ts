/** Measures repeated label-view derivation within one metadata and epoch scope. */

import { CFC_ATOM_TYPE } from "@commonfabric/api/cfc";
import { Identity } from "@commonfabric/identity";

import { cfcLabelViewForDereference } from "../src/cfc/label-view-state.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { machineryRead } from "../src/storage/reactivity-log.ts";
import { benchDiagnostic } from "./bench-diagnostics.ts";
import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "./cfc-seed-envelope.ts";

const signer = await Identity.fromPassphrase("scoped-snapshot-memo-bench");
const storageManager = StorageManager.emulate({ as: signer });
const runtime = new Runtime({
  apiUrl: new URL("https://example.com"),
  storageManager,
});
const seed = runtime.edit();
const address = runtime.getCell(signer.did(), "labeled-source", undefined, seed)
  .getAsNormalizedFullLink();
writeSeedEnvelopeDoc(seed, signer.did());
seedStoredEnvelope(seed, { ...address, path: [] }, {
  value: "source",
  cfc: {
    version: 1,
    schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
    labelMap: {
      version: 1,
      entries: [{
        path: [],
        label: {
          confidentiality: [{
            type: CFC_ATOM_TYPE.User,
            subject: signer.did(),
          }],
        },
      }],
    },
  },
});
const committed = await seed.commit();
if (committed.error) throw committed.error;

/** Times derivation alone; fresh transactions bound retained journals and memos. */
function measure(
  count: number,
  historical: boolean,
  cold: boolean,
  timer?: Deno.BenchContext,
): number {
  const tx = runtime.edit();
  let previous: number | undefined;
  try {
    if (historical) {
      const epoch = tx.issueReadEpoch()!;
      runtime.getCell(signer.did(), "epoch-advance", undefined, tx).set(count);
      previous = tx.enterReadEpoch(epoch);
    }
    const before = [...(tx.getReadActivities?.() ?? [])].length;
    tx.runWithAmbientReadMeta(machineryRead, () => {
      timer?.start();
      for (let index = 0; index < count; index++) {
        // Clearing only this memo supplies a repeated-derivation control;
        // storage's own read caches remain active in both measurements.
        if (cold) tx.getSnapshotMemo?.()?.clear();
        cfcLabelViewForDereference(tx, address, address);
      }
      timer?.end();
    });
    return [...(tx.getReadActivities?.() ?? [])].length - before;
  } finally {
    if (historical) tx.exitReadEpoch(previous);
    tx.abort();
  }
}

for (const historical of [false, true]) {
  for (const count of [74, 296, 1184]) {
    const scope = historical ? "epoch and metadata" : "metadata";
    const warmReads = measure(count, historical, false);
    const coldReads = measure(count, historical, true);
    if (warmReads !== 1 || coldReads !== count) {
      throw new Error(
        `Unexpected label-read counts: ${warmReads}/${coldReads}`,
      );
    }
    benchDiagnostic(JSON.stringify({ scope, count, warmReads, coldReads }));
    for (const cold of [false, true]) {
      Deno.bench({
        name: `${count} calls ${cold ? "cleared memo" : "reused memo"}`,
        group: `label views ${scope}`,
        fn: (timer) => {
          measure(count, historical, cold, timer);
        },
      });
    }
  }
}

globalThis.addEventListener("unload", () => {
  void (async () => {
    await runtime.dispose();
    await storageManager.close();
  })();
});
