/**
 * What a position declared `unknown` projects to.
 *
 * `unknown` is the declaration a pattern reaches for when a field holds a
 * REFERENCE it tests and compares but never reads through; anything wider
 * retrieves the piece instead of pointing at it. The schema generator emits
 * `{type: "unknown"}` for it, and neither read path descends into one.
 *
 * Not descending is not the same as having nothing. The projection answers
 * three questions and no others: is something there, is it the same thing as
 * that, and where does it point when written back. Both read paths — eager
 * traversal and the lazy view a lift's argument goes through — have to answer
 * them identically, or the same field means two things.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import {
  cellOfOpaqueReference,
  isOpaqueReference,
} from "../src/back-to-cell.ts";
import { areLinksSame, parseLink } from "../src/link-utils.ts";
import type { JSONSchema } from "../src/builder/types.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("unknown reference");
const space = signer.did();

const innerSchema = {
  type: "object",
  properties: { field: { type: "string" } },
  required: ["field"],
} as const satisfies JSONSchema;

const holderSchema = {
  type: "object",
  properties: {
    refs: { type: "array", items: { type: "unknown" } },
    ref: { type: "unknown" },
  },
} as JSONSchema;

describe("unknown-reference materialization", () => {
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
    seq++;
  });

  afterEach(async () => {
    await tx.commit();
    await runtime?.dispose();
    await storageManager?.close();
  });

  /** A holder whose `ref` and `refs[0]` both name a live target. */
  const holding = (write: boolean) => {
    const inner = runtime.getCell(space, `inner-${seq}`, innerSchema, tx);
    if (write) inner.set({ field: "secret" });
    const outer = runtime.getCell(space, `outer-${seq}`, holderSchema, tx);
    outer.set({ refs: [inner], ref: inner } as never);
    const whole = outer.get() as { refs: unknown[]; ref: unknown };
    return { inner, outer, element: whole.refs[0], property: whole.ref };
  };

  describe("a reference the declaration does not read through", () => {
    it("is truthy when the target holds a value", () => {
      const r = holding(true);
      expect(Boolean(r.element)).toBe(true);
      expect(Boolean(r.property)).toBe(true);
    });

    it("is falsy when the target was never written", () => {
      const r = holding(false);
      expect(Boolean(r.element)).toBe(false);
      expect(Boolean(r.property)).toBe(false);
    });

    it("compares equal to the cell it names", () => {
      const r = holding(true);
      const same = (v: unknown) =>
        areLinksSame(v, r.inner, undefined, true, tx, runtime);
      expect(same(r.element)).toBe(true);
      expect(same(r.property)).toBe(true);
    });

    it("carries none of the target's properties", () => {
      const r = holding(true);
      // Own enumerable keys: the back-to-cell annotation and the opaque
      // marker are non-enumerable symbols, and neither is content.
      expect(Object.keys(r.element as object)).toEqual([]);
      expect((r.element as { field?: string }).field).toBeUndefined();
      expect((r.property as { field?: string }).field).toBeUndefined();
    });

    it("names the cell it was read from, and nothing else names one", () => {
      const r = holding(true);
      const named = cellOfOpaqueReference(r.element);
      expect(named).toBeDefined();
      expect(areLinksSame(named!, r.inner, undefined, true, tx, runtime))
        .toBe(true);
      expect(cellOfOpaqueReference({ field: "secret" })).toBeUndefined();
      expect(cellOfOpaqueReference("secret")).toBeUndefined();
    });

    it("writes back as a link, not an inline copy", () => {
      const r = holding(true);
      const sink = runtime.getCell(space, `sink-${seq}`, holderSchema, tx);
      sink.set({ refs: [r.element], ref: r.element } as never);
      const stored = (sink.getRaw() as { refs: unknown[] }).refs[0];
      const link = parseLink(stored, sink.getAsNormalizedFullLink());
      expect(link?.id).toBe(r.inner.getAsNormalizedFullLink().id);
    });
  });

  describe("the two read paths", () => {
    /**
     * Read `v` eagerly and through the lazy view a lift's argument uses. Its
     * own runtime: the two reads need transactions of their own, and the
     * suite's shared one is already open.
     */
    const bothPaths = async <T>(
      schema: JSONSchema,
      value: unknown,
      project: (v: unknown) => T,
    ) => {
      const sm = StorageManager.emulate({ as: signer });
      const rt = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: sm,
      });
      try {
        const setup = rt.edit();
        const cell = rt.getCell(
          space,
          `paths-${seq}`,
          { type: "object", properties: { v: schema } } as JSONSchema,
          setup,
        );
        cell.set({ v: value } as never);
        await setup.commit();
        const read = async (lazy: boolean) => {
          const readTx = rt.edit();
          if (lazy) readTx.markLazyMaterialize(true);
          // Projected while the transaction is open: a lazy view resolves what
          // a reader touches when it touches it, and a closed one refuses.
          const out = project((cell.withTx(readTx).get() as { v: unknown }).v);
          await readTx.commit();
          return out;
        };
        return { eager: await read(false), lazy: await read(true) };
      } finally {
        // The suite's `afterEach` owns the shared pair, not this one, so a
        // failing projection would otherwise leave this runtime open.
        await rt.dispose();
        await sm.close();
      }
    };

    it("answer an opaque position identically", async () => {
      const r = await bothPaths(
        { type: "unknown" },
        { field: "secret" },
        (v) => ({
          opaque: isOpaqueReference(v),
          keys: Object.keys(v as object),
        }),
      );
      expect(r.eager).toEqual({ opaque: true, keys: [] });
      expect(r.lazy).toEqual({ opaque: true, keys: [] });
    });

    it("both honor a concrete type declared beside `unknown`", async () => {
      // `unknown` admits anything, so it decides only when nothing else in
      // the list does. A reader who declared `object` asked for the value.
      const schema = {
        type: ["object", "unknown"],
        properties: { field: { type: "string" } },
      } as JSONSchema;
      const r = await bothPaths(
        schema,
        { field: "secret" },
        (v) => (v as { field?: string }).field,
      );
      expect(r.eager).toBe("secret");
      expect(r.lazy).toBe("secret");
    });
  });

  describe("an anyOf merge", () => {
    const merged = (branches: JSONSchema[]) => {
      const schema = {
        type: "object",
        properties: { v: { anyOf: branches } },
      } as JSONSchema;
      const cell = runtime.getCell(space, `merge-${seq}`, schema, tx);
      cell.set({ v: { field: "secret", other: "x" } } as never);
      return (cell.get() as { v: Record<string, unknown> }).v;
    };
    const declared = {
      type: "object",
      properties: { field: { type: "string" } },
    } as JSONSchema;
    const bag = {
      type: "object",
      additionalProperties: { type: "unknown" },
    } as JSONSchema;

    it("lets a branch that looked beat one that declined, either order", () => {
      expect((merged([declared, bag]) as { field?: string }).field)
        .toBe("secret");
      expect((merged([bag, declared]) as { field?: string }).field)
        .toBe("secret");
    });

    it("does not mark the merged value as holding nothing", () => {
      // The opaque marker describes the branch it came from, not the merge:
      // carried onto a result that holds another branch's properties, the
      // rule above would let a later opaque branch overwrite it.
      expect(isOpaqueReference(merged([bag, declared]))).toBe(false);
    });
  });
});
