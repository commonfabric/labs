/**
 * `writeDetailValueForTarget` reconstructs "the value this transaction wrote
 * at a path" from the recorded write-details. A value may be recorded either
 * as a single coarse write (whole object) OR split across granular writes (an
 * envelope `{}` at the path plus per-field writes at deeper paths) — e.g. when
 * the value is deep-frozen and therefore written field-by-field. Both shapes
 * MUST reconstruct to the same value; otherwise CFC's writeAuthorizedBy
 * enforcement evaluates an item's policy against an incomplete value (e.g. the
 * bare envelope `{}`) and mis-authorizes it.
 */

import { assertEquals, assertStrictEquals, assertThrows } from "@std/assert";

import { deepFreeze } from "@commonfabric/data-model";
import { FabricError } from "@commonfabric/data-model/fabric-instances";
import type { MemorySpace, URI } from "@commonfabric/memory/interface";
import { isObjectOrArray } from "@commonfabric/utils/types";

import { writeDetailValueForTarget } from "../src/cfc/prepare.ts";
import { normalizeCellScope } from "../src/scope.ts";
import type {
  IExtendedStorageTransaction,
  TransactionWriteDetail,
} from "../src/storage/interface.ts";

const SPACE = "did:key:test-space" as MemorySpace;
const ID = "of:fid1:test-entity" as URI;
const SCOPE = normalizeCellScope(undefined);

const txWith = (
  details: TransactionWriteDetail[],
): IExtendedStorageTransaction =>
  ({
    getWriteDetails: (_space: MemorySpace) => details,
  }) as unknown as IExtendedStorageTransaction;

const detail = (
  path: readonly string[],
  value: unknown,
): TransactionWriteDetail => ({
  address: { space: SPACE, id: ID, scope: SCOPE, path },
  // deno-lint-ignore no-explicit-any
  value: value as any,
});

const target = (path: readonly string[]) => ({
  space: SPACE,
  id: ID,
  scope: SCOPE,
  path,
});

// Counts the object/array nodes present in both trees but NOT shared by
// reference (i.e. that were copied). Used to make a "lost the shared
// structure" failure loud and quantified.
const countUnsharedNodes = (orig: unknown, copy: unknown): number => {
  if (orig === copy) return 0; // shared subtree -- stop descending
  if (
    !isObjectOrArray(orig) ||
    !isObjectOrArray(copy)
  ) {
    return 0; // primitives aren't "copies"
  }
  let n = 1; // this container differs by reference
  if (Array.isArray(orig) && Array.isArray(copy)) {
    const len = Math.min(orig.length, copy.length);
    for (let i = 0; i < len; i++) n += countUnsharedNodes(orig[i], copy[i]);
  } else {
    const o = orig as Record<string, unknown>;
    const c = copy as Record<string, unknown>;
    for (const k of Object.keys(o)) n += countUnsharedNodes(o[k], c[k]);
  }
  return n;
};

Deno.test("writeDetailValueForTarget: coarse whole-object write reconstructs as-is", () => {
  const tx = txWith([
    detail(["value"], { origin: "imported", body: "allowed" }),
  ]);
  assertEquals(writeDetailValueForTarget(tx, target([]), "value"), {
    origin: "imported",
    body: "allowed",
  });
});

Deno.test("writeDetailValueForTarget: uses document-narrowed write details when available", () => {
  const wanted = detail(["value"], { body: "bounded" });
  const tx = {
    getWriteDetails: () => {
      throw new Error("must not scan every document in the space");
    },
    getWriteDetailsForTarget: (requested: {
      space: MemorySpace;
      id: URI;
      scope?: string;
      path?: readonly PropertyKey[];
    }) => {
      assertEquals(requested, {
        space: SPACE,
        id: ID,
        scope: SCOPE,
        path: [],
      });
      return [wanted];
    },
  } as unknown as IExtendedStorageTransaction;

  assertEquals(writeDetailValueForTarget(tx, target([]), "value"), {
    body: "bounded",
  });
});

Deno.test("writeDetailValueForTarget: granular envelope + field writes reconstruct the full object", () => {
  // This is the shape produced when an object is written field-by-field (e.g.
  // a deep-frozen value): an empty envelope at the root plus per-field writes.
  // The pre-fix behavior returned just the `{}` envelope, dropping the fields.
  const tx = txWith([
    detail(["value"], {}),
    detail(["value", "origin"], "imported"),
    detail(["value", "body"], "allowed"),
  ]);
  assertEquals(writeDetailValueForTarget(tx, target([]), "value"), {
    origin: "imported",
    body: "allowed",
  });
});

Deno.test("writeDetailValueForTarget: deeper writes win over a stale envelope field", () => {
  const tx = txWith([
    detail(["value"], { origin: "stale" }),
    detail(["value", "origin"], "imported"),
    detail(["value", "body"], "allowed"),
  ]);
  assertEquals(writeDetailValueForTarget(tx, target([]), "value"), {
    origin: "imported",
    body: "allowed",
  });
});

Deno.test("writeDetailValueForTarget: descendant writes overlay onto a base (no base => undefined)", () => {
  // Composition overlays deeper field-writes onto a base write at the target;
  // it does not synthesize a base when none exists. With no write at the
  // target itself, reconstruction returns undefined (unchanged from before
  // this fix). In practice the cases that matter (e.g. a deep-frozen object
  // written field-by-field) always include the envelope write at the target.
  const tx = txWith([
    detail(["value", "origin"], "imported"),
    detail(["value", "body"], "allowed"),
  ]);
  assertEquals(writeDetailValueForTarget(tx, target([]), "value"), undefined);
});

Deno.test("writeDetailValueForTarget: array-index granular writes reconstruct an array", () => {
  const tx = txWith([
    detail(["value"], []),
    detail(["value", "0"], "a"),
    detail(["value", "1"], "b"),
  ]);
  assertEquals(writeDetailValueForTarget(tx, target([]), "value"), ["a", "b"]);
});

Deno.test("writeDetailValueForTarget: reconstructs nested target path", () => {
  const tx = txWith([
    detail(["value", "item"], {}),
    detail(["value", "item", "origin"], "imported"),
  ]);
  assertEquals(writeDetailValueForTarget(tx, target(["item"]), "value"), {
    origin: "imported",
  });
});

Deno.test("writeDetailValueForTarget: previousValue uses the coarse ancestor snapshot", () => {
  // The previousValue of the longest ancestor write already captures the whole
  // pre-write subtree, so per-field previous-values are not composed.
  const tx = txWith([
    {
      address: { space: SPACE, id: ID, scope: SCOPE, path: ["value"] },
      // deno-lint-ignore no-explicit-any
      value: {} as any,
      // deno-lint-ignore no-explicit-any
      previousValue: { origin: "old", body: "old-body" } as any,
    },
    {
      address: {
        space: SPACE,
        id: ID,
        scope: SCOPE,
        path: ["value", "origin"],
      },
      // deno-lint-ignore no-explicit-any
      value: "new" as any,
    },
  ]);
  assertEquals(writeDetailValueForTarget(tx, target([]), "previousValue"), {
    origin: "old",
    body: "old-body",
  });
});

Deno.test("writeDetailValueForTarget: no matching write returns undefined", () => {
  const tx = txWith([
    detail(["value", "other"], "x"),
  ]);
  // A different entity entirely.
  assertEquals(
    writeDetailValueForTarget(
      tx,
      { space: SPACE, id: "of:fid1:nope" as URI, scope: SCOPE, path: [] },
      "value",
    ),
    undefined,
  );
});

Deno.test("writeDetailValueForTarget: composition preserves large off-spine subtrees by reference (no deep copy)", () => {
  // Deliberately ginormous, synthetic-but-realistic base: a large array of
  // records plus a small sibling field, deep-frozen (as stored values are).
  // It's recorded as a coarse base write at the target PLUS a granular write
  // to the *small* field. Reconstruction must overlay the small field WITHOUT
  // deep-copying the large array -- under arbitrary user data the base is
  // unbounded, so a full deep clone here would be an O(size) cost per check.
  const bigList = Array.from({ length: 50_000 }, (_, i) => ({
    id: i,
    body: `message number ${i}`,
    meta: { seen: false, tags: ["a", "b"] },
  }));
  const base = deepFreeze(
    { items: bigList, status: "draft" },
  ) as unknown as Record<string, unknown>;

  const tx = txWith([
    detail(["value"], base),
    detail(["value", "status"], "published"),
  ]);

  const result = writeDetailValueForTarget(tx, target([]), "value") as Record<
    string,
    unknown
  >;

  // Correctness: the small field is overlaid.
  assertEquals(result.status, "published");
  // The top-level container is a fresh thawed copy (its spine changed)...
  assertStrictEquals(result === base, false);
  // ...but the large off-spine subtree MUST be preserved by reference -- not
  // deep-copied. If it isn't (e.g. a regression back to a full-clone
  // reconstruction), fail loudly with the damage quantified.
  if (result.items !== base.items) {
    const copies = countUnsharedNodes(base.items, result.items);
    const mb = (JSON.stringify(result.items).length / (1024 * 1024)).toFixed(1);
    throw new Error(
      `Failed to maintain large shared structure: reconstruction created ` +
        `${copies.toLocaleString()} separate copies using ~${mb} unnecessary ` +
        `megabytes. Off-spine subtrees must be preserved by reference (use ` +
        `copy-on-write spine-thawing, not a full deep clone).`,
    );
  }
});

//
// A `FabricInstance` holds its state privately, so an overlay path addresses
// nothing in one. Both arms are covered: the base itself, and an instance
// nested deeper -- reached only through a descendant's parent path, which the
// base check does not see.
//

Deno.test("writeDetailValueForTarget: refuses an overlay onto a `FabricInstance` base", () => {
  const err = FabricError.fromNativeError(new Error("boom"));
  const tx = txWith([
    detail(["value"], deepFreeze(err)),
    detail(["value", "extra"], 42),
  ]);

  assertThrows(
    () => writeDetailValueForTarget(tx, target([]), "value"),
    Error,
    "FabricInstance",
  );
  assertEquals(Object.getOwnPropertyNames(err), []);
});

Deno.test("writeDetailValueForTarget: refuses an overlay through a nested `FabricInstance`", () => {
  const err = FabricError.fromNativeError(new Error("boom"));
  const tx = txWith([
    detail(["value"], deepFreeze({ err })),
    detail(["value", "err", "extra"], 42),
  ]);

  assertThrows(
    () => writeDetailValueForTarget(tx, target([]), "value"),
    Error,
    "FabricInstance",
  );
  assertEquals(Object.getOwnPropertyNames(err), []);
});
