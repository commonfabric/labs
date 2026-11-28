/**
 * Cells whose documents carry a stored CFC label, for tests of what the
 * reconciler shows and hides on a label's account.
 */

import type { CfcAtom } from "@commonfabric/api/cfc";
import type { Cell, MemorySpace, Runtime } from "@commonfabric/runner";
import { expect } from "@std/expect";

import {
  asStoredValue,
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "../../runner/test/cfc-seed-envelope.ts";

/** The label a document stores at its root. */
export type RootLabel = {
  confidentiality?: CfcAtom[];
  integrity?: CfcAtom[];
};

/**
 * Writes `value` to the document `id` in `space`, labeled at its root with
 * `label` when one is given and carrying no label otherwise, and returns a
 * cell on it, typed as the value it holds.
 */
export async function writeLabeledCell<T>(
  runtime: Runtime,
  space: MemorySpace,
  id: string,
  value: T,
  label?: RootLabel,
): Promise<Cell<T>> {
  const tx = runtime.edit();
  const cell = runtime.getCell<unknown>(space, id, undefined, tx);
  writeSeedEnvelopeDoc(tx, space);
  seedStoredEnvelope(tx, { ...cell.getAsNormalizedFullLink(), path: [] }, {
    value: asStoredValue(value),
    ...(label === undefined ? {} : {
      cfc: {
        version: 1,
        schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
        labelMap: { version: 1, entries: [{ path: [], label }] },
      },
    }),
  });
  expect((await tx.commit().settled).error).toBeUndefined();
  return runtime.getCell<T>(space, id);
}
