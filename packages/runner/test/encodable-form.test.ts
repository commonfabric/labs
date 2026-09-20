/**
 * The walk that replaces artifacts, and the two single-value questions
 * underneath it.
 *
 * A serializing member may be accessor-backed, so reading it twice can produce
 * two different answers; several cases here assert a single read rather than a
 * particular result. Structure is the other recurring subject: what the walk
 * did not have to rebuild comes back by identity, a shared artifact stays
 * shared, and a hole in an array is still a hole afterward.
 *
 * A cell and the reactive standing for it are the interesting non-artifacts.
 * They carry the member the walk looks for, so the single-value questions
 * answer for them, while the walk itself leaves them alone -- they are no
 * builder's artifact, and what they encode to is the link naming the cell.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { fabricFromConvertibleJsValue } from "@commonfabric/data-model";
import { dataUriFromValue } from "@commonfabric/data-model/codec-data-uri";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import {
  encodableFormOf,
  hasEncodableForm,
  replaceArtifacts,
} from "../src/encodable-form.ts";
import { createRef } from "../src/create-ref.ts";
import { Runtime } from "../src/runtime.ts";
import { type IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

/**
 * The walk under test, with the copy callback ignored -- what a caller that
 * only wants the replacement passes. The callback has its own cases below.
 */
function flatten<T>(value: T): T {
  return replaceArtifacts(value, () => {});
}

/** Builds an artifact of the shape `builder/module.ts` produces. */
function artifact(serialized: unknown): Record<string, unknown> {
  return {
    type: "javascript",
    implementation: () => "not representable",
    toEncodableForm: () => serialized,
  };
}

/** A factory: a function carrying its module's members. */
function factoryArtifact(serialized: unknown): () => void {
  return Object.assign(() => {}, artifact(serialized));
}

describe("encodable-form", () => {
  describe("replaceArtifacts()", () => {
    describe("values carrying no artifact", () => {
      it("returns a record by identity", () => {
        const value = { a: 1, b: { c: [1, 2, 3] } };
        expect(flatten(value)).toBe(value);
      });

      it("returns a nested array by identity", () => {
        const value = [{ a: 1 }, [2, [3]]];
        expect(flatten(value)).toBe(value);
      });

      it("returns a value carrying a sparse hole by identity", () => {
        const value = [1, , 3];
        const result = flatten(value);
        expect(result).toBe(value);
        expect(1 in result).toBe(false);
      });
    });

    describe("replacement", () => {
      it("replaces a top-level artifact with its serialized form", () => {
        const result = flatten(
          artifact({ type: "javascript", implementation: "source" }),
        );
        expect(result).toEqual({
          type: "javascript",
          implementation: "source",
        });
      });

      it("replaces an artifact nested under records and arrays", () => {
        const value = {
          tools: { send: { handler: artifact({ serialized: true }) } },
          list: [artifact({ second: true })],
        };
        expect(flatten(value)).toEqual({
          tools: { send: { handler: { serialized: true } } },
          list: [{ second: true }],
        });
      });

      it("replaces a _function_-shaped artifact", () => {
        // A factory is a function carrying its module's members, so an artifact
        // is reached in two shapes and both have to be covered. This is the
        // shape the live idiom produces: `tools: { x: { pattern: SomePattern } }`.
        const value = { tool: { pattern: factoryArtifact({ flat: true }) } };
        expect(flatten(value))
          .toEqual({ tool: { pattern: { flat: true } } });
      });

      it("reads each element once", () => {
        // The array sibling of the record case below, and the same hazard: a
        // copy built by re-reading runs an accessor-backed element a second
        // time and keeps that second answer, storing a value the array never
        // held at any single moment and which the walk never inspected.
        //
        // Order matters. The accessor sits _before_ the artifact, so it has
        // already been read by the time the artifact forces a copy -- which is
        // exactly the window a copy-by-re-reading reads it in again.
        let reads = 0;
        const value: unknown[] = [];
        Object.defineProperty(value, 0, {
          enumerable: true,
          configurable: true,
          get() {
            reads++;
            return reads;
          },
        });
        value[1] = artifact({ flat: true });

        const result = flatten(value) as unknown[];
        expect(reads).toBe(1);
        expect(result[0]).toBe(1);
        expect(result[1]).toEqual({ flat: true });
      });

      it("reads each member once", () => {
        // A copy built by re-reading would run an accessor twice and keep the
        // second answer, recording a value the object never held at any single
        // moment.
        let reads = 0;
        const value = {
          artifact: artifact({ flat: true }),
          get accessor() {
            reads++;
            return reads;
          },
        };
        const result = flatten(value) as Record<string, unknown>;
        expect(reads).toBe(1);
        expect(result.accessor).toBe(1);
      });

      it("reads an accessor-backed serializer once", () => {
        // The member itself can be accessor-backed, and the walk classifies a
        // value by reading it before invoking it. Reading a second time to
        // invoke would run the accessor again and serialize whatever the second
        // read produced -- the same hazard as the element and member cases
        // above, one level up, on the serializer rather than on the data.
        let reads = 0;
        const value = {
          get toEncodableForm() {
            reads++;
            const nth = reads;
            return () => ({ fromRead: nth });
          },
        };
        expect(flatten(value)).toEqual({ fromRead: 1 });
        expect(reads).toBe(1);
      });

      it("reads an accessor-backed serializer on a _function_ once", () => {
        // The function branch classifies and invokes separately too, and a
        // factory is a function carrying its module's members.
        let reads = 0;
        const value = Object.defineProperty(() => {}, "toEncodableForm", {
          configurable: true,
          get() {
            reads++;
            const nth = reads;
            return () => ({ fromRead: nth });
          },
        });
        expect(flatten(value)).toEqual({ fromRead: 1 });
        expect(reads).toBe(1);
      });

      it(
        "invokes a _function_ artifact's serializer once, on the artifact",
        () => {
          // The object branch has the shared-artifact case below to pin its
          // invoke count, and the pre-existing receiver case under
          // `encodableFormOf()` pins the shared invoke. Neither reaches the
          // function branch, which reads and invokes on its own.
          let calls = 0;
          const value = Object.assign(() => {}, {
            marker: "factory",
            toEncodableForm(this: { marker?: string }) {
              calls++;
              return { saw: this?.marker, nth: calls };
            },
          });
          expect(flatten(value)).toEqual({ saw: "factory", nth: 1 });
          expect(calls).toBe(1);
        },
      );

      it("invokes an object artifact's serializer on the artifact", () => {
        const value = {
          marker: "module",
          toEncodableForm(this: { marker?: string }) {
            return { saw: this?.marker };
          },
        };
        expect(flatten(value)).toEqual({ saw: "module" });
      });

      it("descends into the serialized form", () => {
        const value = artifact({ inner: artifact({ deep: true }) });
        expect(flatten(value)).toEqual({ inner: { deep: true } });
      });

      it("shares the subtrees it did not have to rebuild", () => {
        const untouched = { c: 3 };
        const value = { a: artifact({ flat: true }), b: untouched };
        const result = flatten(value);
        expect(result).not.toBe(value);
        expect(result.b).toBe(untouched);
      });

      it("preserves a hole in an array it rebuilds", () => {
        const value = [artifact({ flat: true }), , 3];
        const result = flatten(value);
        expect(result[0]).toEqual({ flat: true });
        expect(1 in result).toBe(false);
        expect(result[2]).toBe(3);
      });

      it("serializes a shared artifact once and keeps it shared", () => {
        let calls = 0;
        const shared = {
          toEncodableForm: () => {
            calls++;
            return { serialized: true };
          },
        };
        const result = flatten({
          first: shared,
          second: shared,
        });
        expect(calls).toBe(1);
        expect(result.first).toBe(result.second);
        expect(result.first).toEqual({ serialized: true });
      });

      it("makes the result representable as a `FabricValue`", () => {
        const value = { tools: { send: { handler: artifact({ ok: true }) } } };
        expect(fabricFromConvertibleJsValue(flatten(value)))
          .toEqual({ tools: { send: { handler: { ok: true } } } });
      });

      it("encodes to the same bytes as the serialized form written inline", () => {
        // The encoded form is what a content-derived id is minted from, so a
        // difference here is a difference in every id derived from a value
        // carrying an artifact. Flattening must arrive at exactly the encoding
        // of the form the artifact serializes to, key order included.
        const value = { tools: { send: { handler: artifact({ ok: true }) } } };
        const inline = { tools: { send: { handler: { ok: true } } } };
        expect(dataUriFromValue(fabricFromConvertibleJsValue(
          flatten(value),
        )))
          .toBe(dataUriFromValue(fabricFromConvertibleJsValue(inline)));
      });

      it("is the only route by which an artifact becomes representable", () => {
        // The conversion has no route of its own to an artifact's serializer:
        // an artifact names it `toEncodableForm`, which the conversion knows
        // nothing about. So flattening is load-bearing rather than an
        // optimization, and skipping it is a loud rejection.
        const value = { tools: { send: { handler: artifact({ ok: true }) } } };
        expect(() => fabricFromConvertibleJsValue(value))
          .toThrow(/Not representable as a `FabricValue`: function/);
      });
    });

    describe("values the conversion decides for itself", () => {
      it("leaves an array carrying an own serializer alone", () => {
        // An array is handled by the array rule whatever it carries.
        const value = Object.assign([1, 2], {
          toEncodableForm: () => "replaced",
        });
        expect(flatten(value)).toBe(value);
      });

      it("leaves a plain object carrying a non-function `toEncodableForm` alone", () => {
        // A query-result proxy reports an own property for any key its record
        // holds, so the name alone does not make a value an artifact. A fabric
        // record has no function-valued member, and that is what the walk keys
        // on; without it this value would reach the invoke and throw.
        const value = { toEncodableForm: 1 };
        expect(flatten({ value }).value).toBe(value);
      });

      it("leaves a plain object carrying an own `toJSON` alone", () => {
        // `toJSON` is not how a builder artifact spells its serializer, so an
        // object bearing one is ordinary data as far as this is concerned, and
        // what becomes of it is the conversion's to decide.
        const value = { secret: "internal", toJSON: () => ({ exposed: true }) };
        expect(flatten({ value }).value).toBe(value);
      });

      it("leaves a class instance with a prototype serializer alone", () => {
        class Serializable {
          toEncodableForm() {
            return { serialized: true };
          }
        }
        const value = new Serializable();
        expect(flatten({ value }).value).toBe(value);
      });

      it("leaves a class instance with an own serializer alone", () => {
        class Bare {}
        const value = Object.assign(new Bare(), {
          toEncodableForm: () => "replaced",
        });
        expect(flatten({ value }).value).toBe(value);
      });

      it("leaves a null-prototype record alone", () => {
        const value: Record<string, unknown> = Object.assign(
          Object.create(null),
          { toEncodableForm: () => "replaced" },
        );
        expect(flatten({ value }).value).toBe(value);
      });

      it("leaves a cycle for the conversion to reject", () => {
        const value: Record<string, unknown> = { a: 1 };
        value.self = value;
        expect(flatten(value)).toBe(value);
        expect(() => fabricFromConvertibleJsValue(value)).toThrow(/circular/);
      });
    });

    describe("the `isLeaf` hook", () => {
      // The hook is how a caller names a value the walk must not read into.
      // In the runtime that is a live query-result view, whose members
      // resolve through a transaction as they are asked for.
      const viaLeaf = (value: unknown, isLeaf: (v: object) => boolean) =>
        replaceArtifacts(value, () => {}, { isLeaf });

      /** A value whose members cost something to read, counting each read. */
      function watched(record: Record<string, unknown>) {
        const reads: (string | symbol)[] = [];
        const marker = Symbol("a leaf to its caller");
        const value = new Proxy(record, {
          get(target, prop, receiver) {
            if (prop === marker) return true;
            reads.push(prop);
            return Reflect.get(target, prop, receiver);
          },
          ownKeys(target) {
            reads.push("[[ownKeys]]");
            return Reflect.ownKeys(target);
          },
        });
        function isLeaf(v: object) {
          return (v as Record<symbol, unknown>)[marker] === true;
        }
        return { value, reads, isLeaf };
      }

      it("reads no member of a value the hook claims", () => {
        const { value, reads, isLeaf } = watched({ a: 1, b: { c: 2 } });
        viaLeaf({ held: value }, isLeaf);
        expect(reads).toEqual([]);
      });

      it("leaves an artifact inside a claimed value alone", () => {
        const { value, isLeaf } = watched({ tool: artifact({ ok: true }) });
        expect((viaLeaf({ held: value }, isLeaf) as { held: unknown }).held)
          .toBe(value);
      });

      it("descends into the same value when no hook is given", () => {
        const { value, reads } = watched({ tool: artifact({ ok: true }) });
        const held = (flatten({ held: value }) as { held: { tool: unknown } })
          .held;
        expect(held.tool).toEqual({ ok: true });
        expect(reads).toContain("[[ownKeys]]");
      });
    });

    describe("the `replaceOther` hook", () => {
      // The hook is how a caller names what _else_ has no fabric
      // representation -- a `Cell`, in the runtime.
      const viaHook = (
        value: unknown,
        replaceOther: (v: object) => unknown,
      ) => {
        const seen: { copy: unknown; original: unknown }[] = [];
        const result = replaceArtifacts(
          value,
          (copy, original) => seen.push({ copy, original }),
          { replaceOther },
        );
        return { result, seen };
      };

      it("returns what the hook puts in a value's place", () => {
        const stood = new Date(0);
        const { result } = viaHook(
          { held: stood },
          (v) => v === stood ? "stand-in" : v,
        );
        expect(result).toEqual({ held: "stand-in" });
      });

      it("tells the copy callback about a hook's replacement", () => {
        // The hook's replacement is a copy like any other, and identity-keyed
        // facts have to be able to follow it.
        const stood = new Date(0);
        const { seen } = viaHook(
          { held: stood },
          (v) => v === stood ? "stand-in" : v,
        );
        expect(seen).toContainEqual({ copy: "stand-in", original: stood });
      });

      it("returns a value the hook left alone by identity", () => {
        const untouched = new Date(0);
        const value = { held: untouched };
        const { result, seen } = viaHook(value, (v) => v);
        expect(result).toBe(value);
        expect(seen).toEqual([]);
      });
    });

    describe("the copy callback", () => {
      // Identity-keyed facts -- trust, the content-addressed entry ref -- do not
      // travel with the bytes, so a caller is told about each copy in order to
      // carry them across. A copy nobody is told about is a dead end that no
      // comparison of the resulting value can detect.
      const copies = (value: unknown) => {
        const seen: { copy: unknown; original: unknown }[] = [];
        const result = replaceArtifacts(
          value,
          (copy, original) => seen.push({ copy, original }),
        );
        return { result, seen };
      };

      it("is told about a replaced artifact, naming the original", () => {
        const original = artifact({ flat: true });
        const { seen } = copies({ held: original });
        expect(seen.some((c) => c.original === original)).toBe(true);
      });

      it("is told about every container rebuilt around a replacement", () => {
        // The record holding the artifact is itself a new object, so it is a
        // copy too and has to be announced as one.
        const value = { outer: { inner: artifact({ flat: true }) } };
        const { result, seen } = copies(value);
        const originals = seen.map((c) => c.original);
        expect(originals).toContain(value);
        expect(originals).toContain(value.outer);
        const announced = seen.find((c) => c.original === value);
        expect(announced!.copy).toBe(result);
      });

      it("is _not_ told about a value that came back unchanged", () => {
        // Returned by identity, so there is no copy and nothing to carry.
        const { seen } = copies({ a: 1, b: { c: [1, 2, 3] } });
        expect(seen).toEqual([]);
      });

      it("is told once about an artifact reached twice", () => {
        const shared = artifact({ flat: true });
        const { seen } = copies({ first: shared, second: shared });
        expect(seen.filter((c) => c.original === shared).length).toBe(1);
      });
    });
  });

  describe("hasEncodableForm()", () => {
    it("returns true for a value carrying `toEncodableForm`", () => {
      expect(hasEncodableForm({ toEncodableForm: () => ({}) })).toBe(true);
    });

    it("returns false for a value carrying only `toSigilLinkOrNull`", () => {
      // A cell returns the link that stands in for it, and it returns
      // under the one name asked here. The link accessor is not that name, so
      // a value that merely names a link does not become storable by saying so.
      expect(hasEncodableForm({ toSigilLinkOrNull: () => ({}) })).toBe(false);
    });

    it("returns false for a value carrying only `toJSON`", () => {
      // The JSON protocol's name gets no standing here. A cell carries it too,
      // for `JSON.stringify`, and reading storage's answer off it would mean
      // every value bearing the protocol's member counted as well.
      expect(hasEncodableForm({ toJSON: () => ({}) })).toBe(false);
    });

    it("returns true for an _inherited_ member", () => {
      // Deliberately broader than the walk's own test: callers here ask about
      // a specific value they hold, not about every object in a graph.
      class Serializable {
        toEncodableForm() {
          return {};
        }
      }
      expect(hasEncodableForm(new Serializable())).toBe(true);
    });

    it("returns true for a _function_ carrying the member", () => {
      expect(hasEncodableForm(Object.assign(() => {}, {
        toEncodableForm: () => ({}),
      }))).toBe(true);
    });

    it("returns false for a value carrying neither name", () => {
      expect(hasEncodableForm({ a: 1 })).toBe(false);
    });

    it("returns false for a non-callable `toEncodableForm`", () => {
      expect(hasEncodableForm({ toEncodableForm: 1 })).toBe(false);
    });

    it("returns false for `null` and for a primitive", () => {
      expect(hasEncodableForm(null)).toBe(false);
      expect(hasEncodableForm(7)).toBe(false);
      expect(hasEncodableForm("x")).toBe(false);
      expect(hasEncodableForm(undefined)).toBe(false);
    });
  });

  describe("encodableFormOf()", () => {
    it("returns the result of `toEncodableForm`", () => {
      expect(encodableFormOf({ toEncodableForm: () => ({ a: 1 }) }))
        .toEqual({ a: 1 });
    });

    it("calls the member _on_ the value, so `this` is the receiver", () => {
      const value = {
        marker: "self",
        toEncodableForm(this: { marker: string }) {
          return { saw: this.marker };
        },
      };
      expect(encodableFormOf(value)).toEqual({ saw: "self" });
    });

    it("returns the result of a member only `Reflect.apply` can call", () => {
      // A method can arrive wrapped in a proxy that answers _every_ property
      // read with something of its own, so nothing read off the method --
      // `.call` included -- is callable, while the method itself still is. So
      // the invoke has to reach a function's call behavior rather than read a
      // property that names it.
      //
      // The live producer of that shape is the reactive proxy in `cell.ts`: a
      // `cellMethods` name comes back as a proxy over the bound method, and
      // every read off _that_ is data navigation.
      const method = new Proxy(function () {
        return { invoked: true };
      }, { get: () => ({ notAFunction: true }) });
      expect(encodableFormOf({ toEncodableForm: method }))
        .toEqual({ invoked: true });
    });

    it("returns the value itself when it carries no such member", () => {
      const value = { a: 1 };
      expect(encodableFormOf(value)).toBe(value);
    });

    it("returns the form, not the value, when the member is there", () => {
      // Including when the form is itself nullish, which the value-fallback
      // must not swallow: a caller telling those apart asks
      // `hasEncodableForm()`.
      expect(encodableFormOf({ toEncodableForm: () => null })).toBe(null);
      expect(encodableFormOf({ toEncodableForm: () => undefined }))
        .toBe(undefined);
    });

    it("returns `ifNone` instead of the value when given one", () => {
      const value = { a: 1 };
      expect(encodableFormOf(value, "none")).toBe("none");
    });

    it("tells an explicit `undefined` `ifNone` from an omitted one", () => {
      // The distinction is what lets a caller stand a computed fallback behind
      // a `??`: omitting it returns the value, which is never nullish for an
      // object, so a `??` would never reach the fallback.
      const value = { a: 1 };
      expect(encodableFormOf(value)).toBe(value);
      expect(encodableFormOf(value, undefined)).toBe(undefined);
    });

    it("returns the form, not `ifNone`, when the member is there", () => {
      expect(encodableFormOf({ toEncodableForm: () => ({ a: 1 }) }, "none"))
        .toEqual({ a: 1 });
    });

    it("reads the member once when given an `ifNone`", () => {
      let reads = 0;
      const value = {
        get toEncodableForm() {
          reads++;
          const nth = reads;
          return () => ({ fromRead: nth });
        },
      };
      expect(encodableFormOf(value, undefined)).toEqual({ fromRead: 1 });
      expect(reads).toBe(1);
    });

    it("reads the member once", () => {
      // One question instead of two. Asking `hasEncodableForm()` first and then
      // calling this reads an accessor-backed member twice, and the second read
      // is what would get serialized.
      let reads = 0;
      const value = {
        get toEncodableForm() {
          reads++;
          const nth = reads;
          return () => ({ fromRead: nth });
        },
      };
      expect(encodableFormOf(value)).toEqual({ fromRead: 1 });
      expect(reads).toBe(1);
    });
  });

  describe("a cell and the reactive that stands for it", () => {
    let runtime: Runtime;
    let storageManager: ReturnType<typeof StorageManager.emulate>;
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

    /** A cell, and the `Reactive` proxy a pattern holds it through. */
    function subjects() {
      const cell = runtime.getCell<{ value: number }>(
        space,
        "encodable-form-cell",
        undefined,
        tx,
      );
      cell.set({ value: 42 });
      return { cell, reactive: cell.getAsReactiveProxy() };
    }

    it("both return the link the cell names", () => {
      const { cell, reactive } = subjects();
      expect(hasEncodableForm(cell)).toBe(true);
      expect(hasEncodableForm(reactive)).toBe(true);
      expect(encodableFormOf(cell)).toEqual(cell.toSigilLinkOrNull());
      expect(encodableFormOf(reactive)).toEqual(cell.toSigilLinkOrNull());
    });

    it("derive the id their own link derives as plain data", () => {
      // An id is derived from a value's encodable form, so the reference is the
      // link itself written out as data -- a value that reaches `createRef`
      // through none of the cell or proxy machinery. Comparing the two subjects
      // only to each other would hold just as well if _both_ moved; comparing
      // each to the link pins where they land, without naming a hash that a
      // later change to link shape would have to come back and edit.
      const { cell, reactive } = subjects();
      const idOf = (held: unknown) => createRef({ held }, "cause").toString();
      const link = idOf(cell.toSigilLinkOrNull());

      expect(idOf(cell)).toBe(link);
      expect(idOf(reactive)).toBe(link);

      // And the comparison discriminates: a different cell's link is a
      // different id, so the three above do not agree merely by being ids.
      const other = runtime.getCell<{ value: number }>(
        space,
        "encodable-form-other-cell",
        undefined,
        tx,
      );
      other.set({ value: 42 });
      expect(idOf(other.toSigilLinkOrNull())).not.toBe(link);
    });

    it("are left alone by the walk, being no builder's artifacts", () => {
      // Neither is a plain object, so the walk does not descend into one --
      // the member each carries never comes up. What stands in for a cell is
      // `replaceArtifacts`'s `replaceOther` hook, whose caller knows an
      // `isCell()` when it holds one.
      const { cell, reactive } = subjects();
      const held = { cell, reactive };
      expect(flatten(held)).toBe(held);
    });
  });

  describe("a query result holding a stream", () => {
    let runtime: Runtime;
    let storageManager: ReturnType<typeof StorageManager.emulate>;
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

    it("encodes a stream member as the link naming the cell", () => {
      // A query result is not uniformly a leaf to the walk. Reading a member
      // declared a stream yields a `Cell`, which has no fabric
      // representation of its own and reaches the conversion only as the link
      // naming it. So a caller that goes on to serialize what it gets back
      // reads into a query result rather than claiming it with `isLeaf`.
      //
      // An immutable cell derives its id from the bytes of what it is given,
      // so two ids agreeing is the two values encoding the same way.
      const cell = runtime.getCell<{ handler: unknown; other: number }>(
        space,
        "encodable-form-stream-holder",
        undefined,
        tx,
      );
      const handler = runtime.getCell<unknown>(
        space,
        "encodable-form-stream",
        { asCell: ["stream"] },
        tx,
      );
      cell.set({ handler, other: 1 });
      const view = cell.get() as unknown as {
        handler: { toSigilLinkOrNull(): unknown };
      };

      const idOf = (held: unknown) =>
        runtime.getImmutableCell(space, { held }, undefined, tx)
          .getAsNormalizedFullLink().id;
      const link = view.handler.toSigilLinkOrNull();

      expect(idOf(view)).toBe(idOf({ handler: link, other: 1 }));
      // And the comparison discriminates: the link is what carries the
      // difference, so a different member in its place is a different id.
      expect(idOf({ handler: link, other: 2 })).not.toBe(idOf(view));
    });
  });
});
