/**
 * The routes by which `createRef()` gets an encodable form out of something
 * cell-shaped: a cell, the query result standing for one, a cell whose link
 * nothing has materialized yet, and a builder artifact that happens to be a
 * function.
 *
 * Two cells at different paths of one document holding equal contents run
 * through most of it, because anything identifying a cell by its contents
 * rather than by what names it returns the same for both. The one input that
 * fails closed is a cell method: a reactive proxy makes it and a same-named
 * data key one object with one encodable form, so a derived id cannot say
 * which was meant.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import { createRef } from "../src/create-ref.ts";
import { createCell } from "../src/cell.ts";
import { Runtime } from "../src/runtime.ts";
import { type IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

describe("create-ref-cell-routes", () => {
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
    await tx.commit().settled;
    await runtime?.dispose();
    await storageManager?.close();
  });

  /**
   * Two cells at different paths of one document, holding equal contents, and
   * the query-result proxy for each. Equal contents is what makes the pair
   * discriminating: anything that identifies these by value rather than by
   * position returns the same for both.
   */
  function siblings() {
    const root = runtime.getCell<{ a: { v: number }; b: { v: number } }>(
      space,
      "create-ref-cell-routes",
      undefined,
      tx,
    );
    root.set({ a: { v: 1 }, b: { v: 1 } });
    const a = root.key("a");
    const b = root.key("b");
    return {
      a,
      b,
      aResult: a.getAsQueryResult(),
      bResult: b.getAsQueryResult(),
    };
  }

  const idOf = (held: unknown) => createRef({ held }, "cause").toString();

  it("derives different ids for two cells at different paths", () => {
    const { a, b } = siblings();
    expect(idOf(a)).not.toBe(idOf(b));
  });

  it("derives different ids for the query results of those cells", () => {
    // A query result stands for the cell it dereferences to, so it carries the
    // same amount of identity: the path is part of what names a cell, and two
    // cells of one document derive two ids.
    const { aResult, bResult } = siblings();
    expect(idOf(aResult)).not.toBe(idOf(bResult));
  });

  it("derives an id for a cell whose link an explicit cause materializes", () => {
    // A cell can carry a space and a cause without a link having been built
    // yet, and reading the entity id is what builds one. So the id is derivable,
    // and a route that only asked whether a link were already there would fail
    // closed on a cell that can name itself perfectly well.
    const causable = createCell<{ v: number }>(runtime, { space, path: [] }, tx)
      .for("explicit-cause");

    // Taken before anything materializes the link, which is what both
    // assertions below turn on: once a link exists, deriving through the cell
    // and deriving through the link agree anyway.
    const first = idOf(causable);

    // Idempotent: a second derivation returns what the first did, rather than
    // one preimage before the link exists and another after.
    expect(idOf(causable)).toBe(first);

    // And what it derives from is the link, not the document's id -- checked
    // against that link written out as plain data, which reaches `createRef`
    // through none of the cell machinery.
    expect(first).toBe(idOf(causable.toEncodableForm()));
  });

  it("throws for a cell's method, which is not a value", () => {
    // For a name in `cellMethods`, a `Reactive` returns a proxy that is callable
    // _and_ a projection of the cell at that name, so a method and a same-named
    // data key are one object with one encodable form -- a derived id cannot say
    // which was meant. It fails closed like the other inputs that cannot resolve
    // (audit S14).
    const { a } = siblings();
    const reactive = a.getAsReactiveProxy() as unknown as Record<
      string,
      unknown
    >;
    const method = reactive.get;
    expect(typeof method).toBe("function");
    expect(() => idOf(method)).toThrow(/Cell method is not a value/);
  });

  it("derives from a builder artifact that is a function", () => {
    // A factory is a function carrying `toEncodableForm` too, and is not
    // reactive, which is what separates it from a method proxy: it derives from
    // its serialized form.
    const factory = Object.assign(() => {}, {
      toEncodableForm: () => ({ serialized: true }),
    });
    expect(idOf(factory)).toBe(idOf({ serialized: true }));
  });

  it("derives one id for a cell and its own query result", () => {
    const { a, aResult } = siblings();
    expect(idOf(aResult)).toBe(idOf(a));
  });
});
