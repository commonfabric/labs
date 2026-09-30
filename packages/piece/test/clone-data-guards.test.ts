/**
 * Exercises the fail-closed validation around piece data snapshots. These
 * tests use storage-shaped cells and transactions so every rejected condition
 * is observed before clone creation can begin.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type {
  Cell,
  IExtendedStorageTransaction,
  MemorySpace,
} from "@commonfabric/runner";
import { FabricInstance, FabricPrimitive } from "@commonfabric/data-model";
import { commitPreconditionValueHash } from "@commonfabric/memory/v2";
import {
  assertNoCloneFabricInstance,
  cloneCellKey,
  cloneEntityKey,
  cloneInternalManifest,
  pinCloneSnapshotCells,
} from "../src/ops/clone-data-guards.ts";

const SPACE_A = "did:key:z6MkCloneGuardA" as MemorySpace;
const SPACE_B = "did:key:z6MkCloneGuardB" as MemorySpace;

function cellWith(
  id: `${string}:${string}`,
  space = SPACE_A,
  path: readonly (string | number)[] = [],
): Cell<unknown> {
  return {
    getAsNormalizedFullLink: () => ({
      id,
      space,
      scope: "space",
      path,
    }),
  } as unknown as Cell<unknown>;
}

class CloneInstance extends FabricInstance {
  deepClone(): FabricInstance {
    return this;
  }

  shallowClone(): FabricInstance {
    return this;
  }
}

class ClonePrimitive extends FabricPrimitive {
  readonly nested = new CloneInstance();

  get schemaType(): never {
    throw new Error("Unimplemented.");
  }
}

describe("clone data guards", () => {
  it("keys cell paths separately but groups paths by entity", () => {
    const first = cellWith("of:first", SPACE_A, ["left"]);
    const second = cellWith("of:first", SPACE_A, ["right"]);

    expect(cloneCellKey(first)).not.toBe(cloneCellKey(second));
    expect(cloneEntityKey(first)).toBe(cloneEntityKey(second));
  });

  it("walks arrays, objects, and cycles while rejecting FabricInstance", () => {
    const cycle: { self?: unknown; values: unknown[] } = { values: [] };
    cycle.self = cycle;
    cycle.values.push(new ClonePrimitive());

    expect(() => assertNoCloneFabricInstance(cycle)).not.toThrow();
    expect(() => assertNoCloneFabricInstance({ nested: [new CloneInstance()] }))
      .toThrow("piece data containing FabricInstance values cannot be copied");
  });

  it("accepts absent and valid manifests and rejects malformed ones", () => {
    const manifest = (value: unknown) =>
      ({ getMetaRaw: () => value }) as unknown as Cell<unknown>;

    expect(cloneInternalManifest(manifest(undefined))).toEqual([]);
    expect(cloneInternalManifest(manifest([{
      partialCause: { root: true },
      link: { id: "of:internal", path: [] },
    }]))).toHaveLength(1);
    expect(() => cloneInternalManifest(manifest("invalid"))).toThrow(
      "piece has invalid internal data metadata",
    );
    expect(() => cloneInternalManifest(manifest([null]))).toThrow(
      "piece has invalid internal data metadata",
    );
    expect(() =>
      cloneInternalManifest(manifest([{
        link: { id: "of:internal", path: [] },
      }]))
    ).toThrow("piece has invalid internal data metadata");
    expect(() =>
      cloneInternalManifest(manifest([{
        partialCause: { root: true },
      }]))
    ).toThrow("piece has invalid internal data metadata");
  });

  it("pins each mutable entity once and skips immutable data links", () => {
    const reads: unknown[] = [];
    const preconditions: unknown[] = [];
    const tx = {
      readOrThrow: (address: unknown) => {
        reads.push(address);
        return { stored: true };
      },
      addCommitPrecondition: (space: MemorySpace, condition: unknown) => {
        preconditions.push({ space, condition });
      },
    } as unknown as IExtendedStorageTransaction;

    pinCloneSnapshotCells(tx, [
      cellWith("of:mutable", SPACE_A, ["first"]),
      cellWith("of:mutable", SPACE_A, ["second"]),
      cellWith("data:immutable", SPACE_A),
    ]);

    expect(reads).toEqual([{
      space: SPACE_A,
      id: "of:mutable",
      scope: "space",
      type: "application/json",
      path: ["value"],
    }]);
    expect(preconditions).toEqual([{
      space: SPACE_A,
      condition: {
        kind: "entity-value-hash",
        id: "of:mutable",
        scope: "space",
        valueHash: commitPreconditionValueHash({ stored: true }),
      },
    }]);
  });

  it("pins an absent entity with a null value hash", () => {
    const preconditions: unknown[] = [];
    const tx = {
      readOrThrow: () => undefined,
      addCommitPrecondition: (_space: MemorySpace, condition: unknown) => {
        preconditions.push(condition);
      },
    } as unknown as IExtendedStorageTransaction;

    pinCloneSnapshotCells(tx, [cellWith("of:absent")]);

    expect(preconditions).toEqual([{
      kind: "entity-value-hash",
      id: "of:absent",
      scope: "space",
      valueHash: null,
    }]);
  });

  it("rejects snapshots spanning spaces or lacking precondition support", () => {
    const supported = {
      readOrThrow: () => undefined,
      addCommitPrecondition: () => undefined,
    } as unknown as IExtendedStorageTransaction;
    expect(() =>
      pinCloneSnapshotCells(supported, [
        cellWith("of:first", SPACE_A),
        cellWith("of:second", SPACE_B),
      ])
    ).toThrow(
      "piece data linked from another space cannot be copied consistently",
    );

    const unsupported = {
      readOrThrow: () => undefined,
    } as unknown as IExtendedStorageTransaction;
    expect(() => pinCloneSnapshotCells(unsupported, [cellWith("of:first")]))
      .toThrow("storage cannot validate a piece data snapshot");
  });
});
