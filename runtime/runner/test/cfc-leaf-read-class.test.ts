/**
 * What a cell read of a scalar consumes.
 *
 * A read that stops at a node observes the node's existence, its kind and
 * which members it has (a shape observation, CFC spec §4.5.2), whatever the
 * node holds. Returning a scalar is a read of the payload (§4.5.2, "read
 * scalar"), which consumes the `value` label at the path. A cell read through
 * its schema returns the scalars it selects, so it carries their value
 * labels, and not the value label of a scalar it does not select.
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
import type { JSONSchema } from "../src/builder/types.ts";
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

describe("CFC flow labels: a cell read of a scalar", () => {
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

  /** The join of a cell read of `doc` through `schema`. */
  const cellRead = (doc: IMemorySpaceAddress, schema: JSONSchema): string[] =>
    atoms(joinOf((tx) => {
      runtime.getCellFromLink({ ...doc, schema }, undefined, tx).get();
    }));

  it("carries the scalar's value label, not only its shape label", async () => {
    const doc = await seeded("count", 3, STALE_SHAPE_ENTRIES);
    expect(cellRead(doc, { type: "number" })).toEqual([A, B]);
  });

  it("a handle to the scalar carries nothing of its value label", async () => {
    const doc = await seeded("count-handle", 3, STALE_SHAPE_ENTRIES);
    expect(cellRead(doc, { type: "number", asCell: ["cell"] })).toEqual([]);
  });

  it("a union of handles minted over a record carries nothing of its scalars' value labels", async () => {
    // The branches of a union of handles are traversed to find which one
    // applies, and the scalars they read are not what the reader gets.
    const doc = await seeded("record-union", { name: "x" }, [
      {
        path: [],
        label: { confidentiality: [A] },
        origin: "derived",
        observes: "shape",
      },
      {
        path: ["name"],
        label: { confidentiality: [B] },
        origin: "derived",
        observes: "value",
      },
    ]);
    const seed = runtime.edit();
    const holder = runtime.getCell(
      space,
      "count-union-holder",
      undefined,
      seed,
    );
    holder.setRaw({
      items: [runtime.getCellFromLink(doc, undefined, seed).getAsLink()],
    } as never);
    expect((await seed.commit().settled).ok).toBeDefined();
    const union = {
      type: "object",
      properties: {
        items: {
          type: "array",
          items: {
            anyOf: [
              {
                type: "object",
                properties: { name: { type: "string" } },
                asCell: ["cell"],
              },
              {
                type: "object",
                properties: { title: { type: "string" } },
                required: ["title"],
                asCell: ["cell"],
              },
            ],
          },
        },
      },
    } as const;
    const read = atoms(joinOf((tx) => {
      const items = (holder.withTx(tx).asSchema(union).get() as {
        items: unknown[];
      }).items;
      expect(items).toHaveLength(1);
    }));
    expect(read).not.toContain(B);
  });

  it("a read that stops at the scalar consumes only its shape label", async () => {
    const doc = await seeded("count-shape", 3, STALE_SHAPE_ENTRIES);
    const shallow = joinOf((tx) =>
      tx.readOrThrow({ ...doc, path: ["value"] }, { nonRecursive: true })
    );
    expect(atoms(shallow)).toEqual([A]);
  });

  it("carries the value label of a scalar member it selects, not of one it does not", async () => {
    const entries: readonly LabelMapEntry[] = [
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
    ];
    const both = await seeded("fields", { n: 3, m: "x" }, entries);
    expect(
      cellRead(both, {
        type: "object",
        properties: { n: { type: "number" }, m: { type: "string" } },
      }),
    ).toContain(B);
    const other = await seeded("fields-other", { n: 3, m: "x" }, entries);
    expect(
      cellRead(other, {
        type: "object",
        properties: { m: { type: "string" } },
      }),
    ).not.toContain(B);
  });

  it("carries the value label of a scalar in a list of scalars", async () => {
    const doc = await seeded("list", [3, 4], [
      {
        path: [],
        label: { confidentiality: [A] },
        origin: "derived",
        observes: "shape",
      },
      {
        path: ["1"],
        label: { confidentiality: [B] },
        origin: "derived",
        observes: "value",
      },
    ]);
    expect(cellRead(doc, { type: "array", items: { type: "number" } }))
      .toEqual([A, B]);
  });
});
