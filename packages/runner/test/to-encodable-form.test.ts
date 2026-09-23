/**
 * The walk that puts a value into the form storage takes, which owes two
 * things that pull in different directions.
 *
 * Structure has to survive. An object reached twice is written once and
 * aliased afterward, so sharing is preserved rather than duplicated, and the
 * same bookkeeping is what lets a cycle be caught instead of followed. Where
 * the walk converts a value in place, the sharing around it still has to
 * hold.
 *
 * And nothing may be laundered. A value that is not inert is refused outright
 * rather than copied into something that would look inert on the far side, and
 * a `FabricInstance` is refused rather than flattened into its parts for the
 * same reason.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import {
  FabricBytes,
  FabricEpochNsec,
} from "@commonfabric/data-model/fabric-primitives";
import { FabricError } from "@commonfabric/data-model/fabric-instances";

import { withAliasBindings } from "../src/builder/to-encodable-form.ts";
import { Runtime } from "../src/runtime.ts";
import { createCell } from "../src/cell.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

describe("to-encodable-form", () => {
  let runtime: Runtime;
  let storageManager: ReturnType<typeof StorageManager.emulate>;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });

    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  describe("withAliasBindings", () => {
    it("should serialize shared object references correctly", () => {
      // Regression test: shared style objects used across siblings in .map()
      // should all serialize with full data, not {} for the 3rd+ occurrence.
      const sharedStyle = {
        background: "white",
        borderRadius: "8px",
        padding: "16px",
      };

      // Simulate a VNode-like tree where multiple siblings share the same style
      const tree = {
        type: "vnode",
        children: [
          { type: "vnode", props: { style: sharedStyle }, children: ["A"] },
          { type: "vnode", props: { style: sharedStyle }, children: ["B"] },
          { type: "vnode", props: { style: sharedStyle }, children: ["C"] },
          { type: "vnode", props: { style: sharedStyle }, children: ["D"] },
          { type: "vnode", props: { style: sharedStyle }, children: ["E"] },
        ],
      };

      const result = withAliasBindings(tree as any) as any;

      // All 5 children should have the full style object
      for (let i = 0; i < 5; i++) {
        expect(result.children[i].props.style).toEqual({
          background: "white",
          borderRadius: "8px",
          padding: "16px",
        });
      }
    });

    it("should still guard against circular references", () => {
      const circular: any = { name: "root", child: {} };
      circular.child.parent = circular; // true circular reference

      const result = withAliasBindings(circular as any) as any;

      // The root should serialize, but the circular back-reference should be {}
      expect(result.name).toEqual("root");
      expect(result.child.parent).toEqual({});
    });

    it("should handle shared nested objects at different depths", () => {
      const sharedMeta = { author: "test", version: 1 };
      const tree = {
        items: [
          { data: "a", meta: sharedMeta },
          { data: "b", meta: sharedMeta },
          { data: "c", nested: { deep: { meta: sharedMeta } } },
        ],
      };

      const result = withAliasBindings(tree as any) as any;

      expect(result.items[0].meta).toEqual({ author: "test", version: 1 });
      expect(result.items[1].meta).toEqual({ author: "test", version: 1 });
      expect(result.items[2].nested.deep.meta).toEqual({
        author: "test",
        version: 1,
      });
    });

    it("should preserve false schema", () => {
      const cellWithFalseSchema = createCell(runtime, {
        space,
        schema: false,
        path: [],
      });

      const result = withAliasBindings(
        cellWithFalseSchema as any,
        (cell) => {
          const { schema, scope } = cell.export();
          return {
            "$alias": {
              partialCause: "placeholder", // we have no way to represent an alias binding to this fake cell
              path: ["path", "to", "cell"],
              ...(schema !== undefined && { schema }),
              ...(scope !== undefined && { scope }),
            },
          };
        },
      );

      expect(result).toEqual({
        "$alias": {
          partialCause: "placeholder",
          path: [
            "path",
            "to",
            "cell",
          ],
          schema: false,
          scope: "space",
        },
      });
    });

    it("passes a nested FabricPrimitive through as an atomic value", () => {
      // A `FabricBytes` (a `FabricPrimitive`) keeps its state in private fields
      // and exposes zero enumerable own-props, so the `for...in` copy branch
      // flattens it to `{}`, silently dropping its bytes. It is atomic and must
      // pass through unchanged.
      const bytes = new FabricBytes(new Uint8Array([1, 2, 3]));

      const result = withAliasBindings({ payload: bytes } as any) as any;

      expect(result.payload).toBe(bytes);
    });

    it("converts a native to its canonical fabric form", () => {
      // A `Uint8Array` is NOT a `FabricValue`. Left to the `for...in` copy it
      // is rebuilt by property name into `{"0":7,"1":9}` -- which IS an inert
      // plain object and so passes `isValidFabricValue()`. That is the hazard:
      // not a lost value, but a legal one meaning something else, stored with
      // no trace of what it was. A `Date` goes the same way, to `{}`.
      const fromBytes = withAliasBindings(new Uint8Array([7, 9]) as any) as any;
      expect(fromBytes).toBeInstanceOf(FabricBytes);
      expect([...fromBytes.slice()]).toEqual([7, 9]);

      const fromDate = withAliasBindings(new Date(0) as any) as any;
      expect(fromDate).toBeInstanceOf(FabricEpochNsec);

      const nested = withAliasBindings(
        { v: new Uint8Array([4, 5]) } as any,
      ) as any;
      expect(nested.v).toBeInstanceOf(FabricBytes);
      expect([...nested.v.slice()]).toEqual([4, 5]);
    });

    it("refuses a FabricInstance rather than flattening it", () => {
      // A `FabricInstance` is a CONTAINER reached by its codec contents, not by
      // property name. The `for...in` copy would rebuild it from zero
      // enumerable own-props as `{}`, so it refuses instead -- the same
      // disposition the sibling binding walk uses.
      const err = FabricError.fromNativeError(new Error("boom"));
      expect(() => withAliasBindings(err as any)).toThrow("FabricError");
      expect(() => withAliasBindings({ e: err } as any)).toThrow("FabricError");

      // ...including one the conversion itself mints, from a JS `Error`.
      expect(() => withAliasBindings({ e: new Error("x") } as any)).toThrow(
        "FabricError",
      );
    });

    it("keeps shared and circular structure intact around a converted native", () => {
      // The conversion can hand back a DIFFERENT object than it was given (it
      // clones in order to freeze), and this walk keys circularity on object
      // identity. So conversion and the `seen` bookkeeping have to agree, or a
      // cycle stops being detected and recurses until the stack dies. This
      // pins the two working together rather than each alone.
      const shared = { tag: "s" };
      const tree: Record<string, unknown> = {
        a: shared,
        b: shared,
        blob: new Uint8Array([1, 2]),
      };
      tree.self = tree;

      const out = withAliasBindings(tree as any) as any;

      // the native converted...
      expect(out.blob).toBeInstanceOf(FabricBytes);
      expect([...out.blob.slice()]).toEqual([1, 2]);
      // ...a shared (non-circular) reference still serializes at each site...
      expect(out.a).toEqual({ tag: "s" });
      expect(out.b).toEqual({ tag: "s" });
      // ...and the cycle is still caught rather than followed.
      expect(out.self).toEqual({});
    });

    it("rejects a plain object that is not inert, rather than laundering it", () => {
      // These are the cases that separate `isInertPlainObject()` from a plain
      // `isPlainObject()` at the routing test above. Were they excluded from
      // the conversion, the `for...in` rebuild would silently drop the symbol
      // key, EVALUATE the accessor into a data property, and reparent the
      // null-prototype object -- each producing a plain object that satisfies
      // `isValidFabricValue()` while meaning something else, with nothing
      // downstream able to notice. They must be refused here.
      const sym = Symbol("s");
      expect(() => withAliasBindings({ a: 1, [sym]: "x" } as any)).toThrow(
        "Not representable",
      );
      expect(() =>
        withAliasBindings({
          a: 1,
          get live() {
            return 42;
          },
        } as any)
      ).toThrow("Not representable");
      expect(() =>
        withAliasBindings(
          Object.assign(Object.create(null), { a: 1 }) as any,
        )
      ).toThrow("Not representable");

      // ...while an ordinary inert plain object still walks through untouched.
      expect(withAliasBindings({ a: 1 } as any)).toEqual({ a: 1 });
    });

    it("throws given an array that is not inert, rather than laundering it", () => {
      // The array analog of the plain-object case above, and it matters for
      // the same reason: `.map()` rebuilds by index, so a named property is
      // dropped and an accessor-backed index is EVALUATED into a data
      // property, each yielding an array that satisfies `isValidFabricValue()`
      // while meaning something else. An `Array` subclass is worse than
      // laundered -- `.map()` honors `Symbol.species`, so the result is still
      // a subclass instance, carrying a live prototype that `isInertArray()`
      // exists to reject.
      // Each names the ARRAY refusal specifically. "Not representable" alone is
      // shared with the plain-object refusal, so it would still pass if one of
      // these were classified as an object instead -- which is exactly the
      // regression that would make the reported reason wrong.
      expect(() =>
        withAliasBindings(Object.assign([1, 2], { extra: "x" }) as any)
      ).toThrow("array that is not an inert array");
      const accessorIndexed = [1, 2];
      Object.defineProperty(accessorIndexed, 0, {
        get: () => 42,
        enumerable: true,
        configurable: true,
      });
      expect(() => withAliasBindings(accessorIndexed as any)).toThrow(
        "array that is not an inert array",
      );
      class Subclassed extends Array {}
      expect(() => withAliasBindings(Subclassed.from([1, 2]) as any)).toThrow(
        "array that is not an inert array",
      );
      expect(() =>
        withAliasBindings(Object.setPrototypeOf([1, 2], null) as any)
      ).toThrow("array that is not an inert array");

      // ...while an ordinary inert array still walks through untouched.
      expect(withAliasBindings([1, 2] as any)).toEqual([1, 2]);
    });

    it("leaves ordinary containers alone", () => {
      // The conversion above must not reach an inert plain object or an array;
      // those are already `FabricValue`s and are walked, not converted.
      const obj = withAliasBindings({ a: 1, b: "x" } as any) as any;
      expect(obj).toEqual({ a: 1, b: "x" });
      expect(obj.constructor).toBe(Object);

      const arr = withAliasBindings([1, "x"] as any) as any;
      expect(arr).toEqual([1, "x"]);
      expect(Array.isArray(arr)).toBe(true);
    });
  });
});
