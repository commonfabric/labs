/**
 * A read declared onward, and the declaration a map makes from one.
 *
 * The flow join charges everything a transaction writes with every read the
 * transaction made. A reader that declares a read's confidentiality on the
 * one document it writes from it marks the read `declaredOnwardRead`: the
 * join then leaves what the read consumed at its own path — the membership —
 * out, keeps its integrity in the meet, and answers that confidentiality as
 * `declaredOnward`, resolved by its own rules. What the read consumed at
 * the slots — each item's shape, the reference scalar there, the pointer a
 * probe finds — is per-item and stays in the join: a child is set up from
 * exactly that and carries it. The cases below hold the partition to the
 * join over a list document carrying one entry of each kind a read can
 * consume: a `map` over it declares on its
 * container's membership what a read consumes at the list itself, and
 * carries what it consumed at the slots onto its container's slots.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { deepEqual } from "@commonfabric/js-values/deep-equal";

import type { FabricValue } from "@commonfabric/data-model";

import type { FactoryInput } from "../src/builder/types.ts";
import type { Cell } from "../src/cell.ts";
import { readStoredCfcMetadata } from "../src/cfc/metadata.ts";
import { deriveFlowJoin } from "../src/cfc/prepare.ts";
import type { LabelMapEntry } from "../src/cfc/types.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import type {
  IExtendedStorageTransaction,
  IMemorySpaceAddress,
} from "../src/storage/interface.ts";
import { declaredOnwardRead } from "../src/storage/reactivity-log.ts";
import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "./cfc-seed-envelope.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";

const signer = await Identity.fromPassphrase("runner-cfc-declared-onward");
const space = signer.did();

/** Where the reads below are declared onward to: any document will do. */
const ONTO: IMemorySpaceAddress = {
  space,
  scope: "space",
  id: "of:declared-onward-target",
  path: [],
};

/** An integrity atom the join carries through its meet. */
const CERTIFIED = { type: "https://commonfabric.org/cfc/atom/PolicyCertified" };

/**
 * One entry of each kind a read of the list can consume: content labels at
 * the root and below it, the membership's own, a child's shape, the pointer
 * label the probe of each slot consumes, and the runtime-minted template
 * that materializing a slot's reference scalar consumes.
 */
const LIST_ENTRIES: LabelMapEntry[] = [
  {
    path: [],
    label: { confidentiality: ["root-value"], integrity: [CERTIFIED] },
  },
  { path: [], label: { confidentiality: ["root-derived"] }, origin: "derived" },
  {
    path: [],
    label: { confidentiality: ["root-membership"] },
    origin: "declared",
    observes: "enumerate",
  },
  {
    path: ["0"],
    label: { confidentiality: ["slot-value"] },
    origin: "derived",
  },
  {
    path: ["*"],
    label: { confidentiality: ["slot-pointer"] },
    origin: "declared",
    observes: "followRef",
  },
  {
    path: ["1"],
    label: { confidentiality: ["child-shape"] },
    origin: "structure",
    observes: "shape",
  },
  {
    path: ["*"],
    label: { confidentiality: ["slot-template"] },
    origin: "structure",
    observes: "value",
  },
];

describe("a read declared onward", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      // Each probe below writes a labeled value into a document declaring
      // no ceiling; at this rung that is flagged and lands, and the derived
      // join is what the document then stores.
      cfcEnforcementMode: "enforce-explicit",
      cfcFlowLabels: "persist",
    });
  });

  afterEach(async () => {
    await runtime.dispose({ closeStorage: false });
    await storageManager.close();
  });

  /** A list document storing `entries` over two inline elements. */
  const seededList = async (
    cause: string,
    entries: readonly LabelMapEntry[],
  ): Promise<IMemorySpaceAddress> => {
    const seed = runtime.edit();
    const cell = runtime.getCell(space, cause, undefined, seed);
    const address: IMemorySpaceAddress = {
      space,
      scope: "space",
      id: cell.getAsNormalizedFullLink().id,
      path: [],
    };
    writeSeedEnvelopeDoc(seed, space);
    seedStoredEnvelope(seed, address, {
      value: [{ n: 1 }, { n: 2 }],
      cfc: {
        version: 1,
        schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
        labelMap: { version: 1, entries: [...entries] },
      },
    });
    expect((await seed.commit().settled).ok).toBeDefined();
    return address;
  };

  /** The join of one raw read of `list`, made under `meta` if given. */
  const joinOfRead = (
    list: IMemorySpaceAddress,
    onto?: IMemorySpaceAddress,
  ) => {
    const tx = runtime.edit();
    try {
      const read = () => runtime.getCellFromLink(list, undefined, tx).getRaw();
      if (onto === undefined) read();
      else tx.runWithAmbientReadMeta(declaredOnwardRead(onto), read);
      return deriveFlowJoin(tx);
    } finally {
      tx.abort("observation only");
    }
  };

  const sameAtoms = (left: readonly unknown[], right: readonly unknown[]) =>
    left.length === right.length &&
    left.every((atom) => right.some((other) => deepEqual(atom, other)));

  /** What a read of the list consumes at the list itself: its membership. */
  const NODE_ATOMS = ["root-value", "root-derived", "root-membership"];

  /**
   * What it consumes at the slots: each item's shape, scalar and pointer,
   * and the list's covering labels, which reach its items — not the
   * membership's own, which is about the set.
   */
  const ITEM_ATOMS = [
    "slot-value",
    "child-shape",
    "slot-pointer",
    "slot-template",
    "root-value",
    "root-derived",
  ];

  it("keeps what the read consumed at the slots in the join, and its integrity", async () => {
    const list = await seededList("declared-onward-join", LIST_ENTRIES);

    const ordinary = joinOfRead(list);
    const declared = joinOfRead(list, ONTO);

    expect(
      sameAtoms(ordinary.confidentiality, [
        ...new Set([...NODE_ATOMS, ...ITEM_ATOMS]),
      ]),
    ).toBe(true);
    expect(sameAtoms(declared.confidentiality, ITEM_ATOMS)).toBe(true);
    expect(declared.confidentiality).not.toContainEqual("root-membership");
    expect(declared.integrity).toEqual(ordinary.integrity);
    expect(declared.integrity).toContainEqual(CERTIFIED);
  });

  it("answers what the reads declared onward consumed at the list itself", async () => {
    const list = await seededList("declared-onward-answer", LIST_ENTRIES);

    const ordinary = joinOfRead(list);
    const declared = joinOfRead(list, ONTO);

    expect(sameAtoms(declared.declaredOnward, NODE_ATOMS)).toBe(true);
    const at = [...declared.declaredOnwardAt.values()];
    expect(at).toHaveLength(1);
    expect(at[0].target).toEqual(ONTO);
    expect(sameAtoms(at[0].confidentiality, NODE_ATOMS)).toBe(true);
    expect(ordinary.declaredOnward).toEqual([]);
    expect(ordinary.declaredOnwardAt.size).toBe(0);
  });

  /**
   * Maps `double` over the list at `list`, and returns the container the
   * map writes, settled.
   */
  const mapOver = async (cause: string, list: IMemorySpaceAddress) => {
    const { commonfabric: cf } = createTrustedBuilder(runtime);
    const { lift } = cf as unknown as {
      lift: (fn: (value: any) => unknown) => (value: unknown) => unknown;
    };
    const double = lift((value: { n: number }) => ({ doubled: value.n * 2 }));
    const page = cf.pattern<{ values: unknown[] }>(({ values }) => ({
      // deno-lint-ignore no-explicit-any -- the builder's list type is untyped
      mapped: (values as any).mapWithPattern(
        cf.pattern(({ element }: FactoryInput<any>) => double(element)),
        {},
      ),
    }));
    const tx = runtime.edit();
    const values = runtime.getCellFromLink(list, undefined, tx);
    const resultCell = runtime.getCell(space, cause, undefined, tx);
    const result = runtime.run(tx, page, { values }, resultCell);
    tx.prepareCfc();
    expect((await tx.commit().settled).ok).toBeDefined();
    await result.pull();
    await runtime.idle();
    // deno-lint-ignore no-explicit-any -- the page's output is untyped
    const mapped = result.key("mapped") as Cell<any>;
    expect((mapped.get() as { doubled: number }[]).map((m) => m?.doubled))
      .toEqual([2, 4]);
    return mapped.resolveAsCell();
  };

  /** The confidentiality the runtime stamped on `container`'s membership. */
  // deno-lint-ignore no-explicit-any -- any container
  const stampedMembership = (container: Cell<any>): unknown[] => {
    const tx: IExtendedStorageTransaction = runtime.edit();
    try {
      const link = container.getAsNormalizedFullLink();
      const entries = readStoredCfcMetadata(tx, link)?.labelMap.entries ?? [];
      return entries
        .filter((entry) =>
          entry.origin === "structure" && entry.observes === "enumerate" &&
          entry.path.length === link.path.length
        )
        .flatMap((entry) => entry.label.confidentiality ?? []);
    } finally {
      tx.abort("label read");
    }
  };

  /**
   * The confidentiality the runtime stamped on `container`'s slots: the
   * `*` pointer template, minted from the coordinator's own join.
   */
  // deno-lint-ignore no-explicit-any -- any container
  const stampedSlotPointer = (container: Cell<any>): unknown[] => {
    const tx: IExtendedStorageTransaction = runtime.edit();
    try {
      const link = container.getAsNormalizedFullLink();
      const entries = readStoredCfcMetadata(tx, link)?.labelMap.entries ?? [];
      return entries
        .filter((entry) =>
          entry.origin === "structure" && entry.observes === "followRef" &&
          entry.path.length === link.path.length + 1 &&
          entry.path[entry.path.length - 1] === "*"
        )
        .flatMap((entry) => entry.label.confidentiality ?? []);
    } finally {
      tx.abort("label read");
    }
  };

  it("map lands on its container's membership what a read consumes at the list itself", async () => {
    const list = await seededList("map-declares", LIST_ENTRIES);
    const container = await mapOver("map-declares-page", list);

    // The membership stamp carries the coordinator's join as well: what it
    // consumed at the slots is part of the container's membership too.
    const stamped = stampedMembership(container);
    expect(sameAtoms(stamped, [...new Set([...NODE_ATOMS, ...ITEM_ATOMS])]))
      .toBe(true);
  });

  it("map carries what it consumed at the slots onto its container's slots", async () => {
    const list = await seededList("map-carries-slots", LIST_ENTRIES);
    const container = await mapOver("map-carries-slots-page", list);

    // The reference the page holds to the list carries the list's content
    // label (§8.2), which the coordinator's resolution of its input consumes
    // on a later reconcile; so the slots carry at least the per-item part,
    // and never the membership, which went onward.
    const stamped = stampedSlotPointer(container);
    for (const atom of ITEM_ATOMS) expect(stamped).toContainEqual(atom);
    expect(stamped).not.toContainEqual("root-membership");
  });

  /** Rewrites the stored envelope of `list`: its rows and its entries. */
  const reseedList = async (
    list: IMemorySpaceAddress,
    value: FabricValue,
    entries: readonly LabelMapEntry[],
  ): Promise<void> => {
    const seed = runtime.edit();
    seedStoredEnvelope(seed, list, {
      value,
      cfc: {
        version: 1,
        schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
        labelMap: { version: 1, entries: [...entries] },
      },
    });
    expect((await seed.commit().settled).ok).toBeDefined();
  };

  it("map lands a label the list carries only at itself on the membership and on the slots", async () => {
    const list = await seededList("map-node-only", [
      { path: [], label: { confidentiality: ["root-only"] } },
    ]);
    const container = await mapOver("map-node-only-page", list);

    // A label on the list itself covers its items (§4.6.3 replace-down), so
    // it is part of what a read of each slot resolves to, and a child is set
    // up under it; the membership carries it too.
    expect(stampedMembership(container)).toContainEqual("root-only");
    expect(stampedSlotPointer(container)).toContainEqual("root-only");
  });

  it("map lands a label the list inherits from a labeled ancestor", async () => {
    const seed = runtime.edit();
    writeSeedEnvelopeDoc(seed, space);
    const doc = runtime.getCell(space, "map-ancestor-doc", undefined, seed);
    const address: IMemorySpaceAddress = {
      space,
      scope: "space",
      id: doc.getAsNormalizedFullLink().id,
      path: [],
    };
    seedStoredEnvelope(seed, address, {
      value: { secret: 1, items: [{ n: 1 }, { n: 2 }] },
      cfc: {
        version: 1,
        schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
        labelMap: {
          version: 1,
          entries: [{ path: [], label: { confidentiality: ["doc-root"] } }],
        },
      },
    });
    expect((await seed.commit().settled).ok).toBeDefined();
    const container = await mapOver("map-ancestor-page", {
      ...address,
      path: ["items"],
    });

    expect(stampedMembership(container)).toContainEqual("doc-root");
  });

  it("map re-lands the membership when a later reconcile adds a labeled row", async () => {
    const membership = (atoms: string[]): LabelMapEntry[] => [{
      path: [],
      label: { confidentiality: atoms },
      origin: "declared",
      observes: "enumerate",
    }];
    const list = await seededList("map-grows", membership(["m1"]));
    const container = await mapOver("map-grows-page", list);
    expect(stampedMembership(container)).toContainEqual("m1");

    await reseedList(
      list,
      [{ n: 1 }, { n: 2 }, { n: 3 }],
      membership(["m1", "m2"]),
    );
    await runtime.idle();
    // deno-lint-ignore no-explicit-any -- the container's elements are untyped
    const mapped = container as Cell<any>;
    await mapped.pull();
    await runtime.idle();
    expect((mapped.get() as { doubled: number }[]).map((m) => m?.doubled))
      .toEqual([2, 4, 6]);

    expect(stampedMembership(container)).toContainEqual("m2");
  });

  it("map stamps nothing over a list whose membership carries nothing", async () => {
    const list = await seededList("map-declares-nothing", []);
    const container = await mapOver("map-declares-nothing-page", list);

    expect(stampedMembership(container)).toEqual([]);
    expect(stampedSlotPointer(container)).toEqual([]);
  });
});
