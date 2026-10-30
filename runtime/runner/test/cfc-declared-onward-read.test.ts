/**
 * A read declared onward, and the declaration a map makes from one.
 *
 * The flow join charges everything a transaction writes with every read the
 * transaction made. A reader that declares a read's confidentiality on the
 * one document it writes from it marks the read `declaredOnwardRead`: the
 * join then leaves that read's confidentiality out and keeps its integrity
 * in the meet, and answers what those reads consumed as `declaredOnward`,
 * resolved by its own rules, slot probes included. The cases below hold the
 * declaration to the join over a list document carrying one entry of each
 * kind a read can consume: a `map` over it declares on its container's
 * membership exactly the confidentiality an ordinary read of the list
 * joins.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { deepEqual } from "@commonfabric/js-values/deep-equal";

import type { FactoryInput } from "../src/builder/types.ts";
import type { Cell } from "../src/cell.ts";
import {
  cfcDeclaredLabelAt,
  readStoredCfcMetadata,
} from "../src/cfc/metadata.ts";
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

/** An integrity atom the join carries through its meet. */
const CERTIFIED = { type: "https://commonfabric.org/cfc/atom/PolicyCertified" };

/**
 * One entry of each kind a read of the list can consume: content labels at
 * the root and below it, the membership's own, a child's shape, and the
 * pointer label the probe of each slot consumes.
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
    meta?: typeof declaredOnwardRead,
  ) => {
    const tx = runtime.edit();
    try {
      const read = () => runtime.getCellFromLink(list, undefined, tx).getRaw();
      if (meta === undefined) read();
      else tx.runWithAmbientReadMeta(meta, read);
      return deriveFlowJoin(tx);
    } finally {
      tx.abort("observation only");
    }
  };

  const sameAtoms = (left: readonly unknown[], right: readonly unknown[]) =>
    left.length === right.length &&
    left.every((atom) => right.some((other) => deepEqual(atom, other)));

  it("leaves the read's confidentiality out of the join and keeps its integrity", async () => {
    const list = await seededList("declared-onward-join", LIST_ENTRIES);

    const ordinary = joinOfRead(list);
    const declared = joinOfRead(list, declaredOnwardRead);

    expect(ordinary.confidentiality.length).toBeGreaterThan(0);
    expect(declared.confidentiality).toEqual([]);
    expect(declared.integrity).toEqual(ordinary.integrity);
    expect(declared.integrity).toContainEqual(CERTIFIED);
  });

  it("answers what the reads declared onward consumed, as an ordinary read joins it", async () => {
    const list = await seededList("declared-onward-answer", LIST_ENTRIES);

    const ordinary = joinOfRead(list);
    const declared = joinOfRead(list, declaredOnwardRead);

    expect(sameAtoms(declared.declaredOnward, ordinary.confidentiality)).toBe(
      true,
    );
    expect(ordinary.declaredOnward).toEqual([]);
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

  /** The confidentiality `container` declares on its membership. */
  // deno-lint-ignore no-explicit-any -- any container
  const declaredMembership = (container: Cell<any>): unknown[] => {
    const tx: IExtendedStorageTransaction = runtime.edit();
    try {
      const link = container.getAsNormalizedFullLink();
      return cfcDeclaredLabelAt(
        readStoredCfcMetadata(tx, link),
        link.path,
        "enumerate",
        "node",
      ).confidentiality ?? [];
    } finally {
      tx.abort("label read");
    }
  };

  it("map declares on its container's membership what an ordinary read of the list joins", async () => {
    const list = await seededList("map-declares", LIST_ENTRIES);
    const container = await mapOver("map-declares-page", list);

    const declared = declaredMembership(container);
    expect(sameAtoms(declared, joinOfRead(list).confidentiality)).toBe(true);
    expect(declared).toContainEqual("root-membership");
  });

  it("map declares nothing over a list whose membership carries nothing", async () => {
    const list = await seededList("map-declares-nothing", []);
    const container = await mapOver("map-declares-nothing-page", list);

    expect(declaredMembership(container)).toEqual([]);
  });
});
