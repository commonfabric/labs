/**
 * Measures the flow join of an attributed transaction that recursively reads
 * one document of N per-key derived entries, every one of which carries the
 * same `TransformedBy`. That is the worst case for the input-witness meet
 * (`observationInputWitnesses` in prepare.ts): every entry below the read is
 * its own location, and the witness survives every one of them, so no early
 * exit applies. A per-location scan of the entries makes the pass quadratic in
 * N; the pass should grow about linearly.
 */

import { CFC_ATOM_TYPE, type CfcAtom } from "@commonfabric/api/cfc";
import { Identity } from "@commonfabric/identity";
import { deepEqual } from "@commonfabric/utils/deep-equal";
import { isObjectNotArray } from "@commonfabric/utils/types";

import { deriveFlowJoin } from "../src/cfc/prepare.ts";
import type {
  ImplementationIdentity,
  LabelMapEntry,
} from "../src/cfc/types.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { benchDiagnostic } from "./bench-diagnostics.ts";
import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "./cfc-seed-envelope.ts";

const signer = await Identity.fromPassphrase("cfc-input-witness-bench");
const space = signer.did();
const storageManager = StorageManager.emulate({ as: signer });
const runtime = new Runtime({
  apiUrl: new URL("https://example.com"),
  storageManager,
});

const identity = (symbol: string): ImplementationIdentity => ({
  kind: "verified",
  moduleIdentity: "module:bench",
  symbol,
  bindingPath: [symbol],
});
const WRITER = identity("writer");
const READER = identity("reader");

for (const count of [500, 2000, 4000]) {
  const derived = (path: string[]): LabelMapEntry => ({
    path,
    origin: "derived",
    observes: "value",
    label: {
      confidentiality: ["room"],
      integrity: [{ type: CFC_ATOM_TYPE.TransformedBy, identity: WRITER }],
    },
  });
  const entries: LabelMapEntry[] = [
    { path: [], origin: "declared", label: { confidentiality: ["room"] } },
    derived([]),
  ];
  const value: Record<string, string> = {};
  for (let index = 0; index < count; index++) {
    value[`k${index}`] = "payload";
    entries.push(derived([`k${index}`]));
  }
  const seed = runtime.edit();
  const address = runtime.getCell(space, `witness-${count}`, undefined, seed)
    .getAsNormalizedFullLink();
  writeSeedEnvelopeDoc(seed, space);
  seedStoredEnvelope(seed, { ...address, path: [] }, {
    value,
    cfc: {
      version: 1,
      schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
      labelMap: { version: 1, entries },
    },
  });
  const committed = await seed.commit();
  if (committed.error) throw committed.error;
  const output = runtime.getCell(space, `witness-out-${count}`, undefined)
    .getAsNormalizedFullLink();

  /** Journals one recursive root read and one attributed write, then times the join. */
  const measure = (timer?: Deno.BenchContext): void => {
    const tx = runtime.edit();
    try {
      tx.setCfcImplementationIdentity(READER);
      tx.readOrThrow({ ...address, path: ["value"] });
      tx.writeOrThrow({ ...output, path: ["value"] }, 1);
      timer?.start();
      const join = deriveFlowJoin(tx);
      timer?.end();
      // The witness must be the writer's, so a fixture whose per-key entries
      // stopped resolving fails here rather than timing a degenerate read.
      const witnessed = join.integrity.some((atom) => {
        const witness = (atom as { inputWitness?: CfcAtom }).inputWitness;
        return isObjectNotArray(witness) &&
          witness.type === CFC_ATOM_TYPE.TransformedBy &&
          deepEqual(witness.identity, WRITER);
      });
      if (!witnessed) throw new Error(`Expected a witness at N=${count}`);
    } finally {
      tx.abort();
    }
  };
  measure();
  benchDiagnostic(JSON.stringify({ entries: count }));
  Deno.bench({
    name: `N=${count}`,
    group: "input witness",
    fn: measure,
  });
}

globalThis.addEventListener("unload", () => {
  void (async () => {
    await runtime.dispose();
    await storageManager.close();
  })();
});
