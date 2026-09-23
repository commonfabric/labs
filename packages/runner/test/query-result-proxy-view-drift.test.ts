/**
 * A query-result view is bound to the kind of container it was built over:
 * the proxy target is a stub of that kind, `Array.isArray` on the view answers
 * for it, and the traps' array paths are keyed on it. The JS spec offers no
 * trap for `Array.isArray`, so the view cannot follow a document that changes
 * kind. Rather than answer for the old kind -- an array's `length` read off a
 * record, a record's keys read off an array, an instance's accessor read off
 * a record -- every trap first checks the kind and refuses with
 * `ViewDriftError` when it no longer matches. A fresh read of the cell builds
 * a view over the current value, because the view cache is keyed on the kind.
 *
 * The cases run over every ordered pair of kinds, since each pair used to
 * answer wrongly in its own way.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";

import {
  createQueryResultProxy,
  getCellOrThrow,
  ViewDriftError,
} from "../src/query-result-proxy.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("query-result-proxy view drift");
const space = signer.did();

type Kind = "array" | "plainObject" | "FabricInstance";

const KINDS: Record<Kind, { make: () => unknown; named: string }> = {
  array: { make: () => [1, 2, 3], named: "an array" },
  plainObject: { make: () => ({ a: 1, b: 2 }), named: "a plain object" },
  FabricInstance: {
    make: () => Object.assign(new Error("boom"), { code: 7 }),
    named: "a `FabricError`",
  },
};

/** What a caller asks of a view, each of which answers for the document. */
const OBSERVATIONS: Record<string, (view: any) => unknown> = {
  "a property": (v) => v.a,
  "an index": (v) => v[0],
  "`length`": (v) => v.length,
  "`message`": (v) => v.message,
  "`Object.keys`": (v) => Object.keys(v),
  "`in`": (v) => "a" in v,
  "`Object.hasOwn`": (v) => Object.hasOwn(v, "a"),
  "`Object.getOwnPropertyDescriptor`": (v) =>
    Object.getOwnPropertyDescriptor(v, "a"),
  "a spread": (v) => ({ ...v }),
  "`toString`": (v) => v.toString(),
};

describe("query-result-proxy view drift", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({ apiUrl: new URL(import.meta.url), storageManager });
    tx = runtime.edit();
  });

  afterEach(async () => {
    if (tx.status().status === "ready") await tx.commit();
    await runtime?.dispose();
    await storageManager?.close();
  });

  for (const from of Object.keys(KINDS) as Kind[]) {
    for (const to of Object.keys(KINDS) as Kind[]) {
      if (from === to) continue;
      describe(`${from} -> ${to}`, () => {
        it("refuses every observation, naming both kinds", () => {
          const cell = runtime.getCell<unknown>(
            space,
            `${from}-${to}`,
            undefined,
            tx,
          );
          cell.set(KINDS[from].make());
          const view = cell.get();
          cell.set(KINDS[to].make());

          for (const [what, observe] of Object.entries(OBSERVATIONS)) {
            let thrown: unknown;
            try {
              observe(view);
            } catch (error) {
              thrown = error;
            }
            expect(thrown, what).toBeInstanceOf(ViewDriftError);
            const message = (thrown as Error).message;
            expect(message, what).toContain(
              from === "FabricInstance"
                ? "a `FabricInstance`"
                : KINDS[from].named,
            );
            expect(message, what).toContain(`now holds ${KINDS[to].named}`);
          }
        });

        it("serves a fresh view over the current value on the next read", () => {
          const cell = runtime.getCell<unknown>(
            space,
            `${from}-${to}-fresh`,
            undefined,
            tx,
          );
          cell.set(KINDS[from].make());
          const stale = cell.get();
          cell.set(KINDS[to].make());

          const fresh = cell.get() as any;
          expect(fresh).not.toBe(stale);
          expect(Array.isArray(fresh)).toBe(to === "array");
          if (to === "array") expect([...fresh]).toEqual([1, 2, 3]);
          if (to === "plainObject") {
            expect({ ...fresh }).toEqual({ a: 1, b: 2 });
          }
          if (to === "FabricInstance") expect(fresh.message).toBe("boom");
          // The stale view goes on refusing.
          expect(() => Object.keys(stale as object)).toThrow(ViewDriftError);
        });
      });
    }
  }

  it("names a document that stopped holding a container", () => {
    const cell = runtime.getCell<unknown>(space, "to-string", undefined, tx);
    cell.set({ a: 1 });
    const view = cell.get() as { a: unknown };
    cell.set("gone");
    expect(() => view.a).toThrow("now holds a string");

    const other = runtime.getCell<unknown>(space, "to-nothing", undefined, tx);
    other.set([1]);
    const list = other.get() as unknown[];
    other.set(undefined);
    expect(() => list.length).toThrow("now holds nothing");
  });

  it("follows a rewrite that keeps the kind", () => {
    const cell = runtime.getCell<unknown>(space, "same-kind", undefined, tx);
    cell.set({ a: 1 });
    const view = cell.get() as { a?: number; b?: number };
    cell.set({ b: 2 });
    expect(view.a).toBeUndefined();
    expect(view.b).toBe(2);
    expect(Object.keys(view)).toEqual(["b"]);
    expect(cell.get()).toBe(view);
  });

  it("is classifiable", () => {
    const cell = runtime.getCell<unknown>(space, "classifiable", undefined, tx);
    cell.set([1]);
    const view = cell.get() as unknown[];
    cell.set({ a: 1 });
    let thrown: unknown;
    try {
      view.length;
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ViewDriftError);
    expect((thrown as ViewDriftError).name).toBe("ViewDriftError");
    expect((thrown as ViewDriftError).boundKind).toBe("array");
  });

  it("does not drift a pinned view, which reads its own instant", () => {
    // A pinned view describes the instant it was taken; a later write in its
    // transaction is not visible to it, so there is nothing for it to drift
    // from. It keeps answering for the record it was built over.
    const seed = runtime.getCell<unknown>(space, "pinned-drift", undefined, tx);
    seed.set({ a: 1 });
    tx.markLazyMaterialize(true);
    const view = createQueryResultProxy<{ a: number }>(
      runtime,
      tx,
      seed.getAsNormalizedFullLink(),
    );
    expect(view.a).toBe(1);
    seed.set([1]);
    expect(view.a).toBe(1);
    expect(Object.keys(view)).toEqual(["a"]);
  });

  it("does not let a fresh view vouch for the stale one", () => {
    // The fresh read after a rewrite derives a view at the same location.
    // That is evidence about the fresh view, not the stale one, whose every
    // access still refuses -- a property, a symbol probe, `length`.
    const cell = runtime.getCell<unknown>(space, "fresh-vouch", undefined, tx);
    cell.set([1, 2, 3]);
    const stale = cell.get() as number[] & { a?: unknown };
    cell.set({ a: 1 });
    expect((cell.get() as { a: number }).a).toBe(1);

    expect(() => stale.length).toThrow(ViewDriftError);
    expect(() => stale.a).toThrow(ViewDriftError);
    expect(() => stale[0]).toThrow(ViewDriftError);
    expect(() => Symbol.iterator in stale).toThrow(ViewDriftError);
    expect(() => stale.toString()).toThrow(ViewDriftError);

    const record = runtime.getCell<unknown>(
      space,
      "fresh-vouch-2",
      undefined,
      tx,
    );
    record.set({ a: 1 });
    const staleRecord = record.get() as { a?: unknown };
    record.set("scalar");
    expect(record.get()).toBe("scalar");
    expect(() => staleRecord.a).toThrow(ViewDriftError);
  });

  it("does not hand a stale view to a fresh read after a link is retargeted", () => {
    // A view checks the document its link resolved to when it was built.
    // Retarget the link and the old view still describes the old document,
    // as it did before; what must not happen is the check leaving that view
    // where a fresh read of the link would find it.
    const first = runtime.getCell<{ value: string }>(
      space,
      "retarget-a",
      undefined,
      tx,
    );
    first.set({ value: "first" });
    const second = runtime.getCell<{ value: string }>(
      space,
      "retarget-b",
      undefined,
      tx,
    );
    second.set({ value: "second" });
    const holder = runtime.getCell<{ target: unknown }>(
      space,
      "retarget-holder",
      undefined,
      tx,
    );
    holder.set({ target: first });
    const oldView = holder.key("target").get() as { value: string };
    expect(oldView.value).toBe("first");

    holder.set({ target: second });
    expect(oldView.value).toBe("first");
    expect((holder.key("target").get() as { value: string }).value).toBe(
      "second",
    );
    expect((holder.get() as { target: { value: string } }).target.value).toBe(
      "second",
    );
  });

  it("refuses from a saved array method called after the rewrite", () => {
    const cell = runtime.getCell<unknown>(space, "saved-method", undefined, tx);
    cell.set([1, 2, 3]);
    const view = cell.get() as number[];
    const map = view.map;
    expect(map((v) => v)).toEqual([1, 2, 3]);

    cell.set({ a: 1 });

    expect(() => map((v) => v)).toThrow(ViewDriftError);
  });

  it("refuses from an iterator held across the rewrite", () => {
    const cell = runtime.getCell<unknown>(
      space,
      "iterator-drift",
      undefined,
      tx,
    );
    cell.set([1, 2, 3]);
    const view = cell.get() as number[];
    const iterator = view[Symbol.iterator]();
    expect(iterator.next().value).toBe(1);

    cell.set({ a: 1 });

    expect(() => iterator.next()).toThrow(ViewDriftError);
  });

  it("still names its cell after the document changed kind", () => {
    // The back-pointer reads nothing and answers for the view, not the
    // document, so it is not subject to drift.
    const cell = runtime.getCell<unknown>(space, "tocell-drift", undefined, tx);
    cell.set({ a: 1 });
    const view = cell.get() as object;
    cell.set([1]);
    expect(getCellOrThrow(view).getAsNormalizedFullLink()).toEqual(
      cell.getAsNormalizedFullLink(),
    );
  });

  it("still names its cell from a pinned view whose transaction has finished", async () => {
    const seed = runtime.getCell<unknown>(
      space,
      "tocell-finished",
      undefined,
      tx,
    );
    seed.set({ a: 1 });
    await tx.commit();
    const readTx = runtime.edit();
    readTx.markLazyMaterialize(true);
    const view = createQueryResultProxy<{ a: number }>(
      runtime,
      readTx,
      seed.getAsNormalizedFullLink(),
    );
    await readTx.commit();
    expect(() => view.a).toThrow("Transaction is complete");
    expect(getCellOrThrow(view).getAsNormalizedFullLink()).toEqual(
      seed.getAsNormalizedFullLink(),
    );
    tx = runtime.edit();
  });

  it("refuses on a standing handle once a later commit changed the kind", async () => {
    const seed = runtime.getCell<unknown>(space, "handle-drift", undefined, tx);
    seed.set({ a: 1 });
    await tx.commit();

    // No transaction: a standing handle that resolves one per access.
    const handle = createQueryResultProxy<{ a: number }>(
      runtime,
      undefined,
      seed.getAsNormalizedFullLink(),
    );
    expect(handle.a).toBe(1);

    const later = runtime.edit();
    runtime.getCell<unknown>(space, "handle-drift", undefined, later).set([9]);
    await later.commit();

    expect(() => handle.a).toThrow(ViewDriftError);
    const fresh = createQueryResultProxy<number[]>(
      runtime,
      undefined,
      seed.getAsNormalizedFullLink(),
    );
    expect(Array.isArray(fresh)).toBe(true);
    expect(fresh[0]).toBe(9);
    tx = runtime.edit();
  });
});
