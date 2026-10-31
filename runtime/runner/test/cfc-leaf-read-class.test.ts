/**
 * What a read that does not recurse observes, when the node it reads holds a
 * scalar.
 *
 * A read that stops at a node observes the node's existence, its kind and
 * which members it has (a shape observation, CFC spec §4.5.2). A scalar has
 * no members: what the read returns is the scalar itself, so the read is a
 * read of the payload (§4.5.2, "read scalar"), and it consumes the `value`
 * label at the path. The runtime records a scalar's read without recursion
 * whenever a cell is read through its schema, so this is the ordinary way a
 * computed number or string is read.
 *
 * The two labels differ on a document whose value changed: the `shape` stamp
 * is minted once, when the document is created (§8.12.8), and the `value`
 * stamp is replaced on every write. The entries seeded below are the ones a
 * computed count stores after its input gained a row labeled `B`: the shape
 * stamp still says `A`, the value stamp says `A` and `B`.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";

import type { FabricValue } from "@commonfabric/data-model";
import { deriveFlowJoin } from "../src/cfc/prepare.ts";
import type { LabelMapEntry } from "../src/cfc/types.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import type {
  IExtendedStorageTransaction,
  IMemorySpaceAddress,
} from "../src/storage/interface.ts";
import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "./cfc-seed-envelope.ts";

const signer = await Identity.fromPassphrase("runner-cfc-leaf-read-class");
const space = signer.did();

const A = "did:test:a";
const B = "did:test:b";

/** The labels a computed scalar stores once its input widened from A to A∪B. */
const STALE_SHAPE_ENTRIES: readonly LabelMapEntry[] = [
  {
    path: [],
    label: { confidentiality: [A] },
    origin: "derived",
    observes: "shape",
  },
  {
    path: [],
    label: { confidentiality: [A, B] },
    origin: "derived",
    observes: "value",
  },
];

describe("CFC flow labels: a read that stops at a scalar", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      cfcEnforcementMode: "enforce-strict",
      cfcFlowLabels: "persist",
    });
  });

  afterEach(async () => {
    await runtime.dispose({ closeStorage: false });
    await storageManager.close();
  });

  const seeded = async (
    id: string,
    value: FabricValue,
    entries: readonly LabelMapEntry[],
  ): Promise<IMemorySpaceAddress> => {
    const seed = runtime.edit();
    const address: IMemorySpaceAddress = {
      space,
      scope: "space",
      id: runtime.getCell(space, id, undefined, seed).getAsNormalizedFullLink()
        .id,
      path: [],
    };
    writeSeedEnvelopeDoc(seed, space);
    seedStoredEnvelope(seed, address, {
      value,
      cfc: {
        version: 1,
        schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
        labelMap: { version: 1, entries: [...entries] },
      },
    });
    expect((await seed.commit().settled).ok).toBeDefined();
    return address;
  };

  /** The confidentiality join of the reads `observe` makes, and nothing else. */
  const joinOf = (
    observe: (tx: IExtendedStorageTransaction) => void,
  ): unknown[] => {
    const tx = runtime.edit();
    try {
      observe(tx);
      return deriveFlowJoin(tx).confidentiality;
    } finally {
      tx.abort("observation only");
    }
  };

  const atoms = (join: unknown[]): string[] =>
    join.flat().map((atom) => String(atom)).sort();

  it("consumes the scalar's value label, not only its shape label", async () => {
    const doc = await seeded("count", 3, STALE_SHAPE_ENTRIES);
    const shallow = joinOf((tx) =>
      tx.readOrThrow({ ...doc, path: ["value"] }, { nonRecursive: true })
    );
    const deep = joinOf((tx) => tx.readOrThrow({ ...doc, path: ["value"] }));
    expect(atoms(shallow)).toEqual([A, B]);
    expect(atoms(shallow)).toEqual(atoms(deep));
  });

  it("consumes only the shape label when the node is a container", async () => {
    const doc = await seeded("record", { n: 3 }, STALE_SHAPE_ENTRIES);
    const shallow = joinOf((tx) =>
      tx.readOrThrow({ ...doc, path: ["value"] }, { nonRecursive: true })
    );
    expect(atoms(shallow)).toEqual([A]);
  });

  it("consumes a scalar member's value label through its container", async () => {
    const doc = await seeded("fields", { n: 3, m: "x" }, [
      {
        path: [],
        label: { confidentiality: [A] },
        origin: "derived",
        observes: "shape",
      },
      {
        path: ["n"],
        label: { confidentiality: [B] },
        origin: "derived",
        observes: "value",
      },
    ]);
    const member = joinOf((tx) =>
      tx.readOrThrow({ ...doc, path: ["value", "n"] }, {
        nonRecursive: true,
      })
    );
    const sibling = joinOf((tx) =>
      tx.readOrThrow({ ...doc, path: ["value", "m"] }, {
        nonRecursive: true,
      })
    );
    expect(atoms(member)).toContain(B);
    expect(atoms(sibling)).not.toContain(B);
  });

  it("a cell read of the scalar carries its value label", async () => {
    const doc = await seeded("cell-count", 3, STALE_SHAPE_ENTRIES);
    const read = joinOf((tx) => {
      const value = runtime.getCellFromLink<number>(
        { ...doc, schema: { type: "number" } },
        undefined,
        tx,
      ).get();
      expect(value).toBe(3);
    });
    expect(atoms(read)).toEqual([A, B]);
  });
});
