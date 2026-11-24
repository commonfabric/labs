/**
 * Measures `hostValueOf()` over a schema-less read of a labeled document
 * whose value holds plain containers and links to other labeled documents:
 * the walk the worker makes for every value it hands a host, once per read
 * and once per subscription delivery.
 */

import type { FabricValue } from "@commonfabric/data-model";
import { Identity } from "@commonfabric/identity";

import { hostValueOf, sinkProjected } from "../src/cell.ts";
import { KeepAsCell } from "../src/link-utils.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "./cfc-seed-envelope.ts";

const signer = await Identity.fromPassphrase("host-value-of-bench");
const space = signer.did();
const ATOM = "host-value-of-bench-atom";

/** A labeled envelope holding `value`, labeled at its root with `ATOM`. */
const labeled = (value: FabricValue): FabricValue => ({
  value,
  cfc: {
    version: 1,
    schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
    labelMap: {
      version: 1,
      entries: [{ path: [], label: { confidentiality: [ATOM] } }],
    },
  },
});

/**
 * A runtime holding `linked` labeled documents of `width` fields each, and a
 * piece whose value links to every one of them beside `width` fields of its
 * own, every document labeled so that each view carries a label view.
 */
async function fixture(width: number, linked: number) {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    storageManager,
    apiUrl: new URL(import.meta.url),
  });
  const fields = (seed: string) =>
    Object.fromEntries(
      Array.from({ length: width }, (_, i) => [
        `field${i}`,
        i % 3 === 0 ? `${seed}-${i}` : i % 3 === 1 ? i : { nested: [i, seed] },
      ]),
    );
  const tx = runtime.edit();
  writeSeedEnvelopeDoc(tx, space);
  const targets = Array.from({ length: linked }, (_, i) => {
    const cell = runtime.getCell(space, `target-${i}`, undefined, tx);
    seedStoredEnvelope(
      tx,
      { ...cell.getAsNormalizedFullLink(), path: [] },
      labeled(fields(`target-${i}`)),
    );
    return cell.getAsLink({ includeSchema: true, keepAsCell: KeepAsCell.All });
  });
  const piece = runtime.getCell(space, "piece", undefined, tx);
  seedStoredEnvelope(
    tx,
    { ...piece.getAsNormalizedFullLink(), path: [] },
    labeled({ ...fields("piece"), refs: targets, author: targets[0] }),
  );
  const committed = await tx.commit().settled;
  if (committed.error) throw committed.error;
  await runtime.idle();
  return {
    runtime,
    piece: runtime.getCell(space, "piece"),
    async dispose() {
      await runtime.dispose();
      await storageManager.close();
    },
  };
}

for (const [width, linked] of [[20, 1], [40, 10]]) {
  Deno.bench({
    name: `hostValueOf() of a fresh read, ${width} fields, ${linked} links`,
    group: `read ${width}x${linked}`,
    n: 20,
    warmup: 3,
    async fn(b) {
      const { runtime, piece, dispose } = await fixture(width, linked);
      try {
        b.start();
        // A transaction of its own per read, so that no memo of an earlier
        // read answers for this one.
        hostValueOf(piece.withTx(runtime.readTx()).get());
        b.end();
      } finally {
        await dispose();
      }
    },
  });

  Deno.bench({
    name:
      `sinkProjected() delivery of hostValueOf(), ${width} fields, ${linked} links`,
    group: `deliver ${width}x${linked}`,
    n: 20,
    warmup: 3,
    async fn(b) {
      const { piece, dispose } = await fixture(width, linked);
      try {
        let deliveries = 0;
        b.start();
        const cancel = sinkProjected(piece, hostValueOf, () => {
          deliveries++;
        });
        b.end();
        cancel();
        if (deliveries !== 1) throw new Error(`delivered ${deliveries}`);
      } finally {
        await dispose();
      }
    },
  });
}
