/**
 * A `FabricSpecialObject` survives the runner's structural walks.
 *
 * Several of these walks asked `isObjectOrArray()` -- "is this an object?" --
 * as a stand-in for "may I read this by property name?". A special object
 * returns `true` for the first and `false` for the second: its state lives in
 * private fields and it has no own properties at all. Those walks saw an empty
 * record and lost the value, each in its own way -- merged it to `{}`, rebuilt
 * it as `{}`, or wrote a property onto it. They ask
 * `isWalkableObjectOrArray()` now.
 *
 * Others already had the right answer by another route, `snapshotQueryResult()`
 * through its own leaf test and the four path readers through `Object.hasOwn`,
 * which consults no prototype. Their cases here pass before the change as well
 * as after, and are pins rather than proofs: what one walk decides is easy to
 * undo from a neighbor, and these are the walks a caller reaches in one pass.
 *
 * The suite runs over every special-object kind rather than a representative
 * one, because the kinds differ in what a naive walk does to them: a
 * `FabricBytes` resolves `"slice"` through its prototype where a
 * `FabricEpochNsec` does not, and a `FabricError` resolves `"message"`. A
 * walk fixed only for the kind it was reported against would keep passing a
 * one-kind test.
 *
 * Two axes cut across the kinds and decide what a case may assert. A walk that
 * only carries a value asserts identity. A walk that runs the value through
 * schema interning gets a deep-frozen copy of an unfrozen instance, so it
 * asserts the class instead -- which is the whole of what was being lost.
 * `FabricMap` and `FabricSet` have stub codecs and cannot be frozen or hashed
 * at all, so they take part only in the walks that touch neither.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";

import {
  FabricError,
  fabricInstanceClassesByName,
  FabricMap,
  FabricSet,
} from "@commonfabric/data-model/fabric-instances";
import {
  FabricBytes,
  fabricPrimitiveClassesByName,
} from "@commonfabric/data-model/fabric-primitives";
import {
  FABRIC_INSTANCE_EXAMPLE_MAKERS_FOR_TESTING_ONLY,
  FABRIC_PRIMITIVE_EXAMPLES_FOR_TESTING_ONLY,
} from "@commonfabric/data-model/for-testing-only";
import {
  fabricAwareEqual,
  type FabricSpecialObject,
  type FabricValue,
  isFabricSpecialObject,
} from "@commonfabric/data-model";

import { mergeDefaults } from "../src/schema.ts";
import { mergeAnyOfMatches } from "../src/traverse.ts";
import { snapshotQueryResult } from "../src/query-result-proxy.ts";
import { extractDefaultValues } from "../src/runner-utils.ts";
import { sanitizeSchemaForLinks } from "../src/link-utils.ts";
import {
  getValueAtPath,
  hasValueAtPath,
  setValueAtPath,
} from "../src/path-utils.ts";
import {
  hasValueAtPath as hasStoredValueAtPath,
  readValueAtPath,
} from "../src/storage/v2-path.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import type { JSONSchema } from "../src/builder/types.ts";

interface SpecialObjectKind {
  /** Class name, so a failure says which kind broke. */
  readonly name: string;
  /** The class itself, for the cases that can only assert the class. */
  // deno-lint-ignore no-explicit-any
  readonly cls: new (...args: any[]) => FabricSpecialObject;
  readonly make: () => FabricValue;
  /** Whether the kind's codec can freeze and hash it. */
  readonly storable: boolean;
  /**
   * Whether the kind is a `FabricInstance`. A walk carries a
   * `FabricPrimitive` through as the leaf it is, and refuses an instance,
   * which is a container it cannot descend yet.
   */
  readonly isInstance: boolean;
}

/**
 * One kind per concrete `FabricPrimitive` class, taken from the data model's
 * own examples, so that a class added there is driven through every walk here
 * with no edit to this file.
 */
const PRIMITIVE_KINDS: readonly SpecialObjectKind[] = Object.entries(
  FABRIC_PRIMITIVE_EXAMPLES_FOR_TESTING_ONLY,
).map(([name, [example]]): SpecialObjectKind => ({
  name,
  cls: fabricPrimitiveClassesByName()[
    name as keyof typeof FABRIC_PRIMITIVE_EXAMPLES_FOR_TESTING_ONLY
  ],
  make: () => example,
  storable: true,
  isInstance: false,
}));

/**
 * One kind per concrete `FabricInstance` class, taken likewise from the data
 * model's own makers. Each case gets an instance of its own, since an instance
 * can be mutable. No case consults `storable` for an instance.
 */
const INSTANCE_KINDS: readonly SpecialObjectKind[] = Object.entries(
  FABRIC_INSTANCE_EXAMPLE_MAKERS_FOR_TESTING_ONLY,
).map(([name, [make]]): SpecialObjectKind => ({
  name,
  cls: fabricInstanceClassesByName()[
    name as keyof typeof FABRIC_INSTANCE_EXAMPLE_MAKERS_FOR_TESTING_ONLY
  ],
  make,
  storable: false,
  isInstance: true,
}));

const SPECIAL_OBJECTS: readonly SpecialObjectKind[] = [
  ...PRIMITIVE_KINDS,
  ...INSTANCE_KINDS,
];

/**
 * The walks below carry a leaf through and refuse a container, so every case
 * that asserts carrying runs over the primitives. The instances get one suite
 * of their own, at the bottom, asserting the refusal instead.
 */
const signer = await Identity.fromPassphrase("fabric walks operator");
const space = signer.did();

const FABRIC_PRIMITIVES = SPECIAL_OBJECTS.filter((k) => !k.isInstance);
const FABRIC_INSTANCES = SPECIAL_OBJECTS.filter((k) => k.isInstance);
const STORABLE_PRIMITIVES = FABRIC_PRIMITIVES.filter((k) => k.storable);

/** Runs `body` once per kind in `kinds`, naming the kind in the case. */
function forEachSpecialObject(
  kinds: readonly SpecialObjectKind[],
  description: (name: string) => string,
  body: (kind: SpecialObjectKind, special: FabricValue) => void,
): void {
  for (const kind of kinds) {
    it(description(kind.name), () => body(kind, kind.make()));
  }
}

describe("fabric special objects through the runner's walks", () => {
  describe("mergeDefaults()", () => {
    forEachSpecialObject(
      STORABLE_PRIMITIVES,
      (name) => `keeps a \`${name}\` default rather than merging it to \`{}\``,
      (kind, special) => {
        const merged = mergeDefaults(
          { type: "object", default: { a: 1 } },
          special,
        );
        expect((merged as { default: unknown }).default)
          .toBeInstanceOf(kind.cls);
      },
    );

    forEachSpecialObject(
      STORABLE_PRIMITIVES,
      (name) => `keeps a \`${name}\` on both sides of the merge`,
      (kind, special) => {
        // Both sides are `type: "object"` shaped, which is what the schema
        // generator emits for the fabric-backed natives, so this is the arm a
        // `Cell` of one of those with an object default actually takes.
        const merged = mergeDefaults(
          { type: "object", default: special as never },
          special,
        );
        expect((merged as { default: unknown }).default)
          .toBeInstanceOf(kind.cls);
      },
    );

    it("still merges two plain-record defaults", () => {
      const merged = mergeDefaults(
        { type: "object", default: { a: 1, b: 2 } },
        { b: 3, c: 4 } as FabricValue,
      );
      expect((merged as { default: unknown }).default).toEqual({
        a: 1,
        b: 3,
        c: 4,
      });
    });
  });

  describe("mergeAnyOfMatches()", () => {
    forEachSpecialObject(
      FABRIC_PRIMITIVES,
      (name) => `returns a \`${name}\` matched by two branches whole`,
      (_kind, special) => {
        expect(mergeAnyOfMatches([special, special])).toBe(special);
      },
    );

    it("still merges the properties of two plain-record matches", () => {
      expect(mergeAnyOfMatches([{ a: 1 }, { b: 2 }])).toEqual({ a: 1, b: 2 });
    });
  });

  describe("snapshotQueryResult()", () => {
    forEachSpecialObject(
      FABRIC_PRIMITIVES,
      (name) => `snapshots a \`${name}\` by identity`,
      (_kind, special) => {
        expect(snapshotQueryResult(special)).toBe(special);
      },
    );

    forEachSpecialObject(
      FABRIC_PRIMITIVES,
      (name) => `snapshots a \`${name}\` held under a key by identity`,
      (_kind, special) => {
        const snapshot = snapshotQueryResult({ a: [{ b: special }] });
        expect(snapshot.a[0].b).toBe(special);
      },
    );

    it("still detaches a plain container", () => {
      const source = { a: [1, 2] };
      const snapshot = snapshotQueryResult(source);
      expect(snapshot).toEqual(source);
      expect(snapshot).not.toBe(source);
      expect(snapshot.a).not.toBe(source.a);
    });
  });

  describe("extractDefaultValues()", () => {
    forEachSpecialObject(
      STORABLE_PRIMITIVES,
      (name) => `returns a \`${name}\` default under a property schema`,
      (kind, special) => {
        // The property-defaults assembly below this return would clone the
        // default and assign to it, which a frozen special object refuses
        // outright and an unfrozen instance accepts as a graft its codec
        // never reads.
        const schema = {
          type: "object",
          properties: { a: { type: "string", default: "x" } },
          default: special as never,
        } as const satisfies JSONSchema;
        expect(extractDefaultValues(schema)).toBeInstanceOf(kind.cls);
      },
    );

    it("still assembles property defaults over a plain-record default", () => {
      const schema = {
        type: "object",
        properties: { a: { type: "string", default: "x" } },
        default: { b: 1 },
      } as const satisfies JSONSchema;
      expect(extractDefaultValues(schema)).toEqual({ a: "x", b: 1 });
    });
  });

  describe("sanitizeSchemaForLinks()", () => {
    forEachSpecialObject(
      STORABLE_PRIMITIVES,
      (name) => `carries a \`${name}\` schema default by reference`,
      (_kind, special) => {
        const sanitized = sanitizeSchemaForLinks({
          type: "object",
          default: special as never,
        }) as { default: unknown };
        expect(sanitized.default).toBe(special);
      },
    );

    it("still strips `asCell` from a subschema", () => {
      const sanitized = sanitizeSchemaForLinks({
        type: "object",
        properties: { a: { type: "string", asCell: ["cell"] } },
      }) as { properties: { a: Record<string, unknown> } };
      expect(sanitized.properties.a.asCell).toBeUndefined();
    });
  });

  describe("setValueAtPath()", () => {
    forEachSpecialObject(
      FABRIC_PRIMITIVES,
      (name) => `replaces a \`${name}\` spine slot rather than writing into it`,
      (_kind, special) => {
        const obj: Record<string, unknown> = { a: special };
        expect(setValueAtPath(obj, ["a", "b"], 1)).toBe(true);
        expect(obj).toEqual({ a: { b: 1 } });
      },
    );

    forEachSpecialObject(
      FABRIC_PRIMITIVES,
      (name) => `writes a \`${name}\` into a leaf slot`,
      (_kind, special) => {
        const obj: Record<string, unknown> = {};
        expect(setValueAtPath(obj, ["a", "b"], special)).toBe(true);
        expect((obj.a as Record<string, unknown>).b).toBe(special);
      },
    );
  });

  describe("path reads", () => {
    forEachSpecialObject(
      FABRIC_PRIMITIVES,
      (name) => `reports no path inside a \`${name}\``,
      (_kind, special) => {
        const root = { a: special };
        // `"slice"` and `"message"` resolve through the prototype of some of
        // these, so they are the segments worth naming: a path names data, and
        // none of that is data. All four readers already consult own
        // properties only, so these pin that rather than prove it.
        for (const segment of ["slice", "message", "length", "source"]) {
          expect(hasValueAtPath(root, ["a", segment])).toBe(false);
          expect(getValueAtPath(root, ["a", segment])).toBeUndefined();
          expect(hasStoredValueAtPath(root as FabricValue, ["a", segment]))
            .toBe(false);
          expect(readValueAtPath(root as FabricValue, ["a", segment]))
            .toBeUndefined();
        }
      },
    );

    forEachSpecialObject(
      SPECIAL_OBJECTS,
      (name) => `reads a \`${name}\` at its own path`,
      (_kind, special) => {
        const root = { a: special };
        expect(hasValueAtPath(root, ["a"])).toBe(true);
        expect(getValueAtPath(root, ["a"])).toBe(special);
        expect(hasStoredValueAtPath(root as FabricValue, ["a"])).toBe(true);
        expect(readValueAtPath(root as FabricValue, ["a"])).toBe(special);
      },
    );
  });

  describe("a `FabricInstance` in any of them", () => {
    // The refusal is the whole point of separating the two kinds. A
    // `FabricPrimitive` is a leaf and every walk above carries one through; an
    // instance is a container the walks cannot descend yet, so either boolean
    // would be wrong, in one direction or the other. When the codec-mediated
    // descent lands, these are the cases that change.
    //
    // These cases hand each walk a raw instance, which is what a walk reading
    // stored values gets. A walk handed the result of a cell read gets
    // something else: a query-result proxy erases the prototype, so
    // `instanceof FabricInstance` is `false` for a proxied one and neither this
    // refusal nor a guard testing for an instance ahead of it fires.
    // `query-result-proxy.ts` carries that gap and the marker for closing it,
    // and the identity case above pins it.

    for (const kind of FABRIC_INSTANCES) {
      it(`is refused by \`mergeAnyOfMatches()\` for a \`${kind.name}\``, () => {
        const special = kind.make();
        expect(() => mergeAnyOfMatches([special, special])).toThrow(
          "`FabricInstance`) in a structural walk",
        );
      });

      it(`is refused by \`snapshotQueryResult()\` for a \`${kind.name}\``, () => {
        expect(() => snapshotQueryResult({ a: kind.make() })).toThrow(
          "`FabricInstance`) in a structural walk",
        );
      });

      it(`is refused by \`setValueAtPath()\` for a \`${kind.name}\``, () => {
        const obj: Record<string, unknown> = { a: kind.make() };
        expect(() => setValueAtPath(obj, ["a", "b"], 1)).toThrow(
          "`FabricInstance`) in a structural walk",
        );
      });

      it(`reports no path inside a \`${kind.name}\` to the local read`, () => {
        // `hasValueAtPath()` reports what a path finds and rebuilds nothing,
        // so it answers for an instance rather than refusing, as the stored
        // reads do. Its `setValueAtPath()` sibling above still refuses,
        // because that one writes through the path it walks.

        const root = { a: kind.make() };
        expect(hasValueAtPath(root, ["a", "b"])).toBe(false);
        expect(hasValueAtPath(root, ["a"])).toBe(true);
      });

      it(`reports no path inside a \`${kind.name}\` to the stored read`, () => {
        // The two stored path reads are the exception among these. They are
        // read helpers on the write path, so refusing would take down an
        // ordinary write; they answer "absent" for an instance, as they do
        // for a leaf.

        const root = { a: kind.make() } as FabricValue;
        expect(hasStoredValueAtPath(root, ["a", "b"])).toBe(false);
        expect(readValueAtPath(root, ["a", "b"])).toBeUndefined();
      });
    }
  });

  describe("through `Cell.set()` rather than the walks directly", () => {
    // A stored value reaches several walks in one pass and the write path
    // decides which, so what each walk answers on its own settles nothing
    // about the write. These drive the write instead. `FabricError` is the
    // instance they use because it is the one with live traffic:
    // `sandbox/result-normalization.ts` mints one from any `Error` an action
    // returns.

    let storageManager: ReturnType<typeof StorageManager.emulate>;
    let runtime: Runtime;
    let tx: IExtendedStorageTransaction;

    beforeEach(() => {
      storageManager = StorageManager.emulate({ as: signer });
      runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager,
      });
      tx = runtime.edit();
    });

    afterEach(async () => {
      await tx.commit();
      await runtime?.dispose();
      await storageManager?.close();
    });

    it("stores an array holding a `FabricError`", () => {
      const cell = runtime.getCell<unknown[]>(
        space,
        "walks-array-of-error",
        { type: "array" },
        tx,
      );

      cell.set([FabricError.fromNativeError(new Error("boom"))] as never);

      expect((cell.get()[0] as { message: string }).message).toBe("boom");
    });

    it("hands back a stored `FabricError` that is not one by `instanceof`", () => {
      // The message above is what the assertion turns on because the class is
      // not available: a read hands back a query-result proxy whose target is
      // an empty stub with no `getPrototypeOf` trap, so `constructor` resolves
      // through the get trap while `instanceof` consults `Object.prototype`.
      // `query-result-proxy.ts` records that above the proxy construction,
      // where a `TODO(danfuzz)` names the fix and says it lands at around ten
      // guard sites at once.
      //
      // TODO(danfuzz): this test asserts the WRONG behavior on purpose. Once a
      // proxied `FabricInstance` is perceived as one, the class comes back and
      // this inverts. The work is at that `TODO` in `query-result-proxy.ts`.

      const cell = runtime.getCell<unknown[]>(
        space,
        "walks-array-of-error-identity",
        { type: "array" },
        tx,
      );

      cell.set([FabricError.fromNativeError(new Error("boom"))] as never);

      const read = cell.get()[0] as object;
      expect(read.constructor.name).toBe("FabricError");
      expect(read instanceof FabricError).toBe(false);
    });

    it("appends a `FabricError` to a stored array", () => {
      const cell = runtime.getCell<unknown[]>(
        space,
        "walks-append-error",
        { type: "array" },
        tx,
      );

      cell.set([FabricError.fromNativeError(new Error("one"))] as never);
      cell.push(FabricError.fromNativeError(new Error("two")) as never);

      const read = cell.get() as { message: string }[];
      expect(read.map((entry) => entry.message)).toEqual(["one", "two"]);
    });

    it("replaces a stored `FabricError` with a record", () => {
      const cell = runtime.getCell<Record<string, unknown>>(
        space,
        "walks-record-over-error",
        undefined,
        tx,
      );

      cell.set({ r: FabricError.fromNativeError(new Error("boom")) } as never);
      cell.set({ r: { a: 1 } } as never);

      expect(cell.get()).toEqual({ r: { a: 1 } });
    });

    it("writes below a `FabricError` stored by an earlier transaction", () => {
      // The cases around this one share the suite's `tx`, so the document's
      // value at transaction start is empty and no ancestor prefix ever holds
      // an instance. `buildReactivityPathsForChange` reads those prefixes from
      // the document as it stood when the transaction opened, so the walk it
      // feeds sees an instance only across a commit boundary.

      const first = runtime.edit();
      const before = runtime.getCell<Record<string, unknown>>(
        space,
        "walks-across-transactions",
        undefined,
        first,
      );
      before.set(
        { r: FabricError.fromNativeError(new Error("boom")) } as never,
      );
      return first.commit().then(() => {
        const second = runtime.edit();
        const after = runtime.getCell<Record<string, unknown>>(
          space,
          "walks-across-transactions",
          undefined,
          second,
        );
        after.set({ r: { a: 1 } } as never);
        return second.commit().then((result) => {
          expect(result?.error).toBeUndefined();
          expect(after.get()).toEqual({ r: { a: 1 } });
        });
      });
    });

    it("compares a stored `FabricBytes` read back by content", () => {
      // What a cell read hands back decides what `fabricAwareEqual()` is given
      // at the comparison sites this change adopts. A `FabricPrimitive` comes
      // back raw -- the proxy exempts one -- so the comparison reaches the
      // value model and decides it by content.

      const cell = runtime.getCell<Record<string, unknown>>(
        space,
        "walks-compare-bytes",
        undefined,
        tx,
      );
      cell.set({ v: new FabricBytes(new Uint8Array([1, 2])) } as never);
      const read = cell.get().v;

      expect(isFabricSpecialObject(read)).toBe(true);
      expect(fabricAwareEqual(read, new FabricBytes(new Uint8Array([1, 2]))))
        .toBe(true);
      expect(fabricAwareEqual(read, new FabricBytes(new Uint8Array([9]))))
        .toBe(false);
    });

    it("compares a stored `FabricError` by its stored value", () => {
      // A read hands back a `FabricInstance` proxied, and the proxy erases the
      // class, so a view of one is not an operand of `fabricAwareEqual()`: it
      // would reduce to a walk of a proxy with no own keys. The stored value
      // is one, and the comparison reaches the value model for it.

      const error = FabricError.fromNativeError(new Error("boom"));
      const cell = runtime.getCell<Record<string, unknown>>(
        space,
        "walks-compare-error",
        undefined,
        tx,
      );
      cell.set({ v: error } as never);
      const stored = (cell.getRaw() as { v: unknown }).v;

      expect(isFabricSpecialObject(stored)).toBe(true);
      expect(fabricAwareEqual(stored, error)).toBe(true);
    });

    it("compares two stored `FabricError`s by their stored values as unequal", () => {
      // Two views of these would both reduce to a proxy with no own keys and
      // compare equal whatever they hold, which is the fail-open that keeps a
      // view out of `fabricAwareEqual()`.

      const write = (id: string, message: string) => {
        const cell = runtime.getCell<Record<string, unknown>>(
          space,
          id,
          undefined,
          tx,
        );
        cell.set(
          { v: FabricError.fromNativeError(new Error(message)) } as never,
        );
        return (cell.getRaw() as { v: unknown }).v;
      };

      expect(
        fabricAwareEqual(
          write("walks-cmp-a", "AAA"),
          write("walks-cmp-b", "ZZZ"),
        ),
      ).toBe(false);
    });

    it("refuses to store a stub-codec instance at all", () => {
      // What a stored ancestor prefix can hold decides what the commit-time
      // comparison above can be handed. `FabricMap` and `FabricSet` do not
      // reach it: storage deep-clones a written value, and their codecs
      // refuse that, so the comparison meets only instances whose codecs are
      // real.

      const cell = runtime.getCell<Record<string, unknown>>(
        space,
        "walks-stub-codec",
        undefined,
        tx,
      );

      expect(() => cell.set({ r: new FabricMap(new Map([["a", 1]])) } as never))
        .toThrow("deep cloning of `FabricMap`");
      expect(() => cell.set({ r: new FabricSet(new Set([1])) } as never))
        .toThrow("deep cloning of `FabricSet`");
    });

    it("stores an array holding a `FabricBytes`", () => {
      // The primitive half of the same write. The walks decide both halves
      // with one predicate, and no instance guard is consulted for a
      // primitive, so this fixes the answer for the half the instance cases
      // do not cover.

      const cell = runtime.getCell<unknown[]>(
        space,
        "walks-array-of-bytes",
        { type: "array" },
        tx,
      );

      cell.set([new FabricBytes(new Uint8Array([1, 2]))] as never);

      expect((cell.get()[0] as FabricBytes).slice())
        .toEqual(new Uint8Array([1, 2]));
    });
  });
});
