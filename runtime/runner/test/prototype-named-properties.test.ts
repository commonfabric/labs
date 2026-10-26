// A property whose NAME happens to match a member of `Object.prototype` is
// ordinary data. `toString`, `valueOf`, `hasOwnProperty` and the rest are legal
// keys — unlike `__proto__`/`constructor` they are not refused by the
// FabricValue boundary (#5264), so they store and round-trip like any other.
//
// Several paths asked whether such a key was present with `in`, which walks the
// prototype chain. The answer was always yes, for every object, so:
//
//   - schema defaults were never applied for those names, and the caller got
//     `Object.prototype`'s FUNCTION where the schema promised a value;
//   - a binding keyed on such a name matched every object and forwarded the
//     inherited function as the bound value;
//   - writing `undefined` to such a key looked like a no-op and was dropped.
//
// These pin the fix on the paths below, each through the surface a caller
// actually uses. Each has a control case using an ordinary name, so a harness
// that stops exercising the path fails loudly rather than passing vacuously.
//
// Sibling of the same bug class in the query-result proxy's
// `getOwnPropertyDescriptor` trap (#5357).

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import "@commonfabric/utils/equal-ignoring-symbols";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { type JSONSchema } from "../src/builder/types.ts";
import { Runtime } from "../src/runtime.ts";
import {
  getValueAtPath,
  hasValueAtPath,
  setValueAtPath,
} from "../src/path-utils.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

// Every name here is an own property of `Object.prototype`, so `k in {}` is
// true for all of them while `Object.hasOwn({}, k)` is false.
const PROTOTYPE_NAMES = [
  "toString",
  "valueOf",
  "hasOwnProperty",
  "isPrototypeOf",
  "propertyIsEnumerable",
  "toLocaleString",
] as const;

describe("properties named after Object.prototype members", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;
  let seq = 0;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    tx = runtime.edit();
  });

  afterEach(async () => {
    await tx.commit().settled;
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("the premise: `in` sees these names, `Object.hasOwn` does not", () => {
    for (const name of PROTOTYPE_NAMES) {
      expect(name in {}).toBe(true);
      expect(Object.hasOwn({}, name)).toBe(false);
    }
  });

  it("CONTROL: an ordinary missing property gets its schema default", () => {
    const c = runtime.getCell<{ name: string }>(
      space,
      `proto-names-control-${seq++}`,
      undefined,
      tx,
    );
    c.set({ name: "John" });

    const schema = {
      type: "object",
      properties: {
        name: { type: "string" },
        age: { type: "number", default: 30 },
      },
    } as const satisfies JSONSchema;

    const value = c.asSchema(schema).get() as Record<string, unknown>;
    expect(value.age).toBe(30);
  });

  it("a string-typed default applies to a property named `toString`", () => {
    const c = runtime.getCell<{ name: string }>(
      space,
      `proto-names-tostring-${seq++}`,
      undefined,
      tx,
    );
    c.set({ name: "John" });

    const schema = {
      type: "object",
      properties: {
        name: { type: "string" },
        toString: { type: "string", default: "the-default" },
      },
    } as const satisfies JSONSchema;

    const value = c.asSchema(schema).get() as Record<string, unknown>;
    // Before the fix this was `Object.prototype.toString` — a function, where
    // the schema promised a string. Silent, wrong-typed data.
    expect(typeof value.toString).toBe("string");
    expect(value.toString).toBe("the-default");
  });

  it("defaults apply for every Object.prototype-named property", () => {
    for (const name of PROTOTYPE_NAMES) {
      const c = runtime.getCell<{ name: string }>(
        space,
        `proto-names-each-${name}-${seq++}`,
        undefined,
        tx,
      );
      c.set({ name: "John" });

      const schema = {
        type: "object",
        properties: {
          name: { type: "string" },
          [name]: { type: "number", default: 7 },
        },
      } as unknown as JSONSchema;

      const value = c.asSchema(schema).get() as Record<string, unknown>;
      expect(value[name]).toBe(7);
    }
  });

  it("an explicitly stored value at such a name survives a read", () => {
    const c = runtime.getCell<Record<string, unknown>>(
      space,
      `proto-names-stored-${seq++}`,
      undefined,
      tx,
    );
    c.set({ name: "John", valueOf: 99 });

    const schema = {
      type: "object",
      properties: {
        name: { type: "string" },
        valueOf: { type: "number", default: 7 },
      },
    } as unknown as JSONSchema;

    const value = c.asSchema(schema).get() as Record<string, unknown>;
    // The stored value wins over the default — the fix must not have swapped
    // one wrong answer for another.
    expect(value.valueOf).toBe(99);
  });

  it("writes to such a name are not dropped as no-ops", () => {
    const c = runtime.getCell<Record<string, unknown>>(
      space,
      `proto-names-write-${seq++}`,
      undefined,
      tx,
    );
    c.set({ name: "John" });
    c.set({ name: "John", toLocaleString: "written" });

    const stored = c.get() as Record<string, unknown>;
    expect(stored.toLocaleString).toBe("written");
  });

  it("removing such a property actually removes it", () => {
    const c = runtime.getCell<Record<string, unknown>>(
      space,
      `proto-names-remove-${seq++}`,
      undefined,
      tx,
    );
    c.set({ name: "John", toString: "stored" });
    // The new value omits `toString`, so it must be deleted. The removal pass
    // asked `"toString" in newValue` — true through the prototype — and left
    // the stored property behind.
    c.set({ name: "John" });

    const stored = c.get() as Record<string, unknown>;
    expect(Object.hasOwn(stored, "toString")).toBe(false);
  });

  it("CONTROL: removing an ordinary property removes it", () => {
    const c = runtime.getCell<Record<string, unknown>>(
      space,
      `proto-names-remove-control-${seq++}`,
      undefined,
      tx,
    );
    c.set({ name: "John", nickname: "Johnny" });
    c.set({ name: "John" });

    const stored = c.get() as Record<string, unknown>;
    expect(Object.hasOwn(stored, "nickname")).toBe(false);
  });

  it("a missing REQUIRED property named for a prototype member is not accepted", () => {
    const c = runtime.getCell<Record<string, unknown>>(
      space,
      `proto-names-required-${seq++}`,
      undefined,
      tx,
    );
    c.set({ name: "John" });

    const schema = {
      type: "object",
      properties: {
        name: { type: "string" },
        toString: { type: "number" },
      },
      required: ["toString"],
    } as unknown as JSONSchema;

    // An ordinary missing required property makes the read reject the value;
    // a prototype-named one was silently satisfied by `Object.prototype`.
    const ordinary = {
      type: "object",
      properties: {
        name: { type: "string" },
        missingField: { type: "number" },
      },
      required: ["missingField"],
    } as unknown as JSONSchema;

    const protoResult = c.asSchema(schema).get();
    const ordinaryResult = c.asSchema(ordinary).get();
    // Whatever the runtime does for a missing required field, it must do the
    // same for both — the property NAME cannot change the answer.
    expect(protoResult).toEqual(ordinaryResult);
  });
});

describe("path helpers and prototype-named segments", () => {
  // `path-utils` is an exported surface, so it gets direct coverage rather
  // than being exercised only through a cell.

  it("getValueAtPath does not hand back an inherited member", () => {
    expect(getValueAtPath({}, ["toString"])).toBe(undefined);
    expect(getValueAtPath({}, ["valueOf"])).toBe(undefined);
    // A stored value at the same name still reads back.
    expect(getValueAtPath({ toString: "stored" }, ["toString"])).toBe("stored");
    // CONTROL: ordinary names are unaffected.
    expect(getValueAtPath({ a: 1 }, ["a"])).toBe(1);
    expect(getValueAtPath({}, ["a"])).toBe(undefined);
  });

  it("hasValueAtPath reports absence for an inherited member", () => {
    expect(hasValueAtPath({}, ["toString"])).toBe(false);
    expect(hasValueAtPath({ toString: "stored" }, ["toString"])).toBe(true);
    // CONTROL
    expect(hasValueAtPath({}, ["a"])).toBe(false);
    expect(hasValueAtPath({ a: 1 }, ["a"])).toBe(true);
  });

  it("setValueAtPath writes such a name instead of throwing", () => {
    const target: Record<string, unknown> = {};
    // Threw "Cannot compare a function value": the current value was read
    // through the prototype and handed to `valueEqual`.
    expect(setValueAtPath(target, ["toString"], "stored")).toBe(true);
    expect(target.toString).toBe("stored");
    // Writing the same value again is still a no-op.
    expect(setValueAtPath(target, ["toString"], "stored")).toBe(false);
  });

  it("getValueAtPath keeps own properties of primitives", () => {
    // Narrowing the read to own properties must not cost the OWN properties a
    // primitive genuinely has. `Object.hasOwn` coerces with `ToObject`, so it
    // keeps a string's `length` and indices while still refusing its prototype
    // methods — callers reconstructing write details walk over primitive
    // subtrees and would otherwise see a valid value as absent.

    expect(getValueAtPath("abc", ["length"])).toBe(3);
    expect(getValueAtPath("abc", ["0"])).toBe("a");
    expect(getValueAtPath({ a: "xy" }, ["a", "length"])).toBe(2);
    expect(getValueAtPath([1, 2, 3], ["length"])).toBe(3);
    // ...but a String.prototype member is still not data.
    expect(getValueAtPath("abc", ["toUpperCase"])).toBe(undefined);
    expect(getValueAtPath("abc", ["toString"])).toBe(undefined);
  });

  it("setValueAtPath still creates intermediate containers", () => {
    const target: Record<string, unknown> = {};
    expect(setValueAtPath(target, ["toString", "nested"], 1)).toBe(true);
    // `as unknown as` rather than a direct cast: on a `Record<string, unknown>`
    // TypeScript still resolves the NAME `toString` to `Object.prototype`'s
    // `() => string` signature, which does not overlap a record — the type
    // system reproducing, in miniature, the very confusion under test.
    const nested = target["toString"] as unknown as Record<string, unknown>;
    expect(nested.nested).toBe(1);
    // CONTROL
    const control: Record<string, unknown> = {};
    expect(setValueAtPath(control, ["a", "b"], 1)).toBe(true);
    expect((control.a as Record<string, unknown>).b).toBe(1);
  });
});
