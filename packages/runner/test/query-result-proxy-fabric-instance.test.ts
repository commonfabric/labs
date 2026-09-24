/**
 * A `FabricInstance` holds all of its state in private fields and exposes it
 * through accessors on its prototype. Reading one through the query-result
 * proxy has to evaluate the accessor against the instance itself: a private
 * field is unreachable from the proxy, which does not declare it, so an
 * accessor run with the proxy as receiver throws outright rather than
 * returning a wrong answer.
 *
 * A method is the same problem one step later. The proxy hands the function
 * back and the caller invokes it, with the proxy as `this`, so a method
 * returned as it was found reads its private fields through the proxy and
 * throws in the same way. It has to come back bound to the instance.
 *
 * `FabricError` stands in for the whole tree here because it is the instance a
 * cell write actually produces -- `Cell.set()` of a JS `Error` wraps one --
 * and it is the state-heaviest of the concrete classes.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  resetModernCellRepConfig,
  setModernCellRepConfig,
} from "@commonfabric/data-model/cell-rep";
import {
  FabricError,
  FabricLink,
} from "@commonfabric/data-model/fabric-instances";
import { Identity } from "@commonfabric/identity";
import {
  createQueryResultProxy,
  ViewDriftError,
} from "../src/query-result-proxy.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("test proxy fabric instance");
const space = signer.did();

describe("query-result proxy: a FabricInstance's members reach the instance", () => {
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

  it("returns each fixed-schema slot of a stored `FabricError`", () => {
    const cell = runtime.getCell<unknown>(space, "errorCell", undefined, tx);
    cell.set(new TypeError("something went wrong"));

    const result = cell.get() as {
      type: string;
      name: string;
      message: string;
      stack: string;
    };
    expect(result.type).toBe("TypeError");
    expect(result.name).toBe("TypeError");
    expect(result.message).toBe("something went wrong");
    expect(typeof result.stack).toBe("string");
  });

  it("returns a slot of a nested `FabricError` reached through `cause`", () => {
    const cell = runtime.getCell<unknown>(space, "causeCell", undefined, tx);
    cell.set(new Error("outer", { cause: new RangeError("inner") }));

    const result = cell.get() as {
      message: string;
      cause: { type: string; message: string };
    };
    expect(result.message).toBe("outer");
    expect(result.cause.type).toBe("RangeError");
    expect(result.cause.message).toBe("inner");
  });

  it("runs a method of a stored `FabricError` against the instance", () => {
    const cell = runtime.getCell<unknown>(space, "extrasCell", undefined, tx);
    cell.set(Object.assign(new Error("boom"), { code: 42, where: "here" }));

    const result = cell.get() as FabricError;
    expect(result.extraSize).toBe(2);
    expect(result.getExtra("code")).toBe(42);
    expect(result.hasExtra("where")).toBe(true);
    expect(result.hasExtra("absent")).toBe(false);
    expect([...result.extraKeys()]).toEqual(["code", "where"]);
    expect([...result.extraEntries()]).toEqual([
      ["code", 42],
      ["where", "here"],
    ]);
  });

  it("runs a method the class inherits against the instance", () => {
    const cell = runtime.getCell<unknown>(space, "cloneCell", undefined, tx);
    cell.set(Object.assign(new Error("boom"), { code: 42 }));

    const clone = (cell.get() as FabricError).deepClone(false);
    expect(clone).toBeInstanceOf(FabricError);
    expect(Object.isFrozen(clone)).toBe(false);
    expect((clone as FabricError).message).toBe("boom");
    expect((clone as FabricError).getExtra("code")).toBe(42);
  });

  it("reads a method's receiver through the transaction, not the view's snapshot", () => {
    // A view is cached for its transaction, and a method is called after
    // the trap returns. Its receiver has to be the instance the document
    // holds at the call, read through the transaction the way the
    // symbol-keyed members already are -- not the instance the view was
    // built over. Both are checked, since `deepClone` reaches its core by
    // symbol and `getExtra` by name.
    const cell = runtime.getCell<unknown>(space, "rewriteCell", undefined, tx);
    cell.set(Object.assign(new Error("before"), { code: 1 }));
    const view = cell.get() as FabricError;
    expect(view.getExtra("code")).toBe(1);

    cell.set(Object.assign(new Error("after"), { code: 2 }));

    expect(view.getExtra("code")).toBe(2);
    const clone = view.deepClone(false) as FabricError;
    expect(clone.message).toBe("after");
    expect(clone.getExtra("code")).toBe(2);
  });

  it("reads an accessor through the transaction as well", () => {
    // The same rule for the accessors an instance exposes, which are its
    // data: a fixed-schema slot follows the document, not the snapshot.
    const cell = runtime.getCell<unknown>(
      space,
      "rewriteAccessor",
      undefined,
      tx,
    );
    cell.set(new Error("before"));
    const view = cell.get() as FabricError;
    expect(view.message).toBe("before");

    cell.set(new Error("after"));

    expect(view.message).toBe("after");
  });

  it("resolves a saved method's instance when it is called, not when it was read", () => {
    // A method is read off the view once and may be called any time later.
    // The instance it runs against is the one the document holds at the
    // call, however the caller holds the method -- detached, or rebound to
    // the view.
    const cell = runtime.getCell<unknown>(space, "savedMethod", undefined, tx);
    cell.set(Object.assign(new Error("before"), { code: 1 }));
    const view = cell.get() as FabricError;
    const getExtra = view.getExtra;
    const clone = view.deepClone.bind(view);

    cell.set(Object.assign(new Error("after"), { code: 2 }));

    expect(getExtra("code")).toBe(2);
    const copy = clone(false) as FabricError;
    expect(copy.message).toBe("after");
    expect(copy.getExtra("code")).toBe(2);
  });

  it("refuses a saved method once the document no longer holds an instance", () => {
    const cell = runtime.getCell<unknown>(space, "savedDrift", undefined, tx);
    cell.set(new Error("before"));
    const view = cell.get() as FabricError;
    const getExtra = view.getExtra;
    const clone = view.deepClone.bind(view);

    cell.set({ getExtra: 1 });

    expect(() => getExtra("code")).toThrow(ViewDriftError);
    expect(() => clone(false)).toThrow(ViewDriftError);
  });

  it("refuses a saved method on a pinned view whose transaction has finished", async () => {
    const seedTx = runtime.edit();
    const cell = runtime.getCell<unknown>(
      space,
      "savedPinned",
      undefined,
      seedTx,
    );
    cell.set(Object.assign(new Error("boom"), { code: 42 }));
    await seedTx.commit();

    const readTx = runtime.edit();
    readTx.markLazyMaterialize(true);
    const view = createQueryResultProxy<FabricError>(
      runtime,
      readTx,
      cell.getAsNormalizedFullLink(),
    );
    const getExtra = view.getExtra;
    const clone = view.deepClone.bind(view);
    expect(getExtra("code")).toBe(42);
    await readTx.commit();

    expect(() => getExtra("code")).toThrow("Transaction is complete");
    expect(() => clone(false)).toThrow("Transaction is complete");
  });

  it("follows a rewrite to an instance of another class", () => {
    // The kind check keeps a view to the kind it was built over, and an
    // instance of another class is the same kind. So membership is decided
    // against the instance the document holds now, when a name is read and
    // again when a saved method is called: a name the new class lacks is not
    // a member, a saved method of the old class refuses at the call, naming
    // the class it met, and a saved generic member still runs against the
    // view. A \`FabricLink\` is stored as a plain instance only under the
    // legacy cell representation, so this pins that representation.
    setModernCellRepConfig(false);
    try {
      const cell = runtime.getCell<unknown>(
        space,
        "classChange",
        undefined,
        tx,
      );
      cell.set(Object.assign(new Error("before"), { code: 1 }));
      const view = cell.get() as Record<string, unknown>;
      const getExtra = view.getExtra as (key: string) => unknown;
      const valueOf = view.valueOf as () => unknown;
      expect(getExtra("code")).toBe(1);

      cell.set(new FabricLink({ id: "of:fid1:class-change-target" }) as never);

      expect(view.constructor).toBe(FabricLink);
      expect(typeof view.getExtra).not.toBe("function");
      expect(() => getExtra("code")).toThrow(
        "`getExtra` is not a method of the `FabricLink`",
      );
      expect(valueOf()).toBe(view);
    } finally {
      resetModernCellRepConfig();
    }
  });

  it("refuses a member once the document no longer holds an instance", () => {
    // The kind a view was built over is the kind it reads (`ViewDriftError`
    // otherwise), so a method name, an accessor, or an inherited member read
    // off an instance view after the document was rewritten to a record
    // refuses rather than answering for either value.
    const cell = runtime.getCell<unknown>(space, "shapeChange", undefined, tx);
    cell.set(Object.assign(new Error("before"), { code: 1 }));
    const view = cell.get() as Record<string, unknown>;
    expect(typeof view.getExtra).toBe("function");

    cell.set({ getExtra: { nested: 1 }, message: "record" });

    for (const name of ["getExtra", "message", "hasOwnProperty", "valueOf"]) {
      expect(() => view[name], name).toThrow(ViewDriftError);
    }
    expect(() => view.constructor).toThrow(ViewDriftError);
    // A fresh read is a view over the record.
    const fresh = cell.get() as { getExtra: { nested: number } };
    expect(fresh.getExtra.nested).toBe(1);
  });

  it("refuses a method call on a pinned view whose transaction has finished", async () => {
    // A pinned view describes the instant its transaction saw, and refuses
    // a read once that transaction is done. A method's receiver is such a
    // read, so calling one after the commit refuses rather than answering
    // from the snapshot.
    const seedTx = runtime.edit();
    const cell = runtime.getCell<unknown>(
      space,
      "pinnedCell",
      undefined,
      seedTx,
    );
    cell.set(Object.assign(new Error("boom"), { code: 42 }));
    await seedTx.commit();

    const readTx = runtime.edit();
    readTx.markLazyMaterialize(true);
    const view = createQueryResultProxy<FabricError>(
      runtime,
      readTx,
      cell.getAsNormalizedFullLink(),
    );
    expect(view.getExtra("code")).toBe(42);
    expect(view.message).toBe("boom");
    await readTx.commit();

    expect(() => view.getExtra("code")).toThrow("Transaction is complete");
    expect(() => view.deepClone(false)).toThrow("Transaction is complete");
    expect(() => view.message).toThrow("Transaction is complete");
  });

  it("meets a mutator with the stored instance's own refusal", () => {
    // An instance's own mutator runs against the instance, and what refuses
    // it is that a stored instance is deep-frozen. (A generic mutator the
    // instance inherits meets a different refusal; the case below.)
    const cell = runtime.getCell<unknown>(space, "mutatorCell", undefined, tx);
    cell.set(new Error("boom"));

    const result = cell.get() as FabricError;
    expect(() => result.setExtra("code", 42)).toThrow(
      "Cannot modify frozen `FabricError`",
    );
    expect(() => result.deleteExtra("code")).toThrow(
      "Cannot modify frozen `FabricError`",
    );
  });

  it("leaves `constructor` the class rather than a bound copy of it", () => {
    // Binding is for methods. `constructor` names the class, and a bound
    // function is a different function that reports itself as
    // `bound FabricError`.
    const cell = runtime.getCell<unknown>(space, "ctorCell", undefined, tx);
    cell.set(new Error("boom"));

    const result = cell.get() as object;
    expect(result.constructor).toBe(FabricError);
    expect(result.constructor.name).toBe("FabricError");
  });

  it("still runs what an instance inherits from `Object.prototype` against the view", () => {
    // Binding is for what the class hierarchy declares, which is what may
    // touch private state. A member inherited unchanged from
    // `Object.prototype` is generic, and has to keep running against the
    // view: bound to the instance, `valueOf()` would hand the stored
    // instance out from behind its view.
    const cell = runtime.getCell<unknown>(space, "genericCell", undefined, tx);
    cell.set(new Error("boom"));

    const result = cell.get() as FabricError;
    expect(result.valueOf()).toBe(result);
    expect(result.valueOf()).not.toBeInstanceOf(FabricError);
    // deno-lint-ignore no-prototype-builtins
    expect(result.hasOwnProperty("message")).toBe(false);
  });

  it("meets a generic mutator with the view's own refusal", () => {
    // Unbound, `__defineGetter__` runs against the view, so the refusal is
    // the view's trap rather than the instance's frozen state.
    const cell = runtime.getCell<unknown>(
      space,
      "genericMutator",
      undefined,
      tx,
    );
    cell.set(new Error("boom"));

    const result = cell.get() as {
      __defineGetter__: (name: string, getter: () => unknown) => void;
    };
    expect(() => result.__defineGetter__("x", () => 1)).toThrow(
      "Cannot define properties on a live cell-result proxy",
    );
  });

  it("still runs a plain record's prototype method against the view", () => {
    // Only an instance's methods are bound. A plain record's have to keep
    // running against the view, so that what they read goes through its
    // traps, live, rather than off the snapshot the view was built over.
    const cell = runtime.getCell<Record<string, unknown>>(
      space,
      "plainRecordCell",
      undefined,
      tx,
    );
    cell.set({ a: 1 });
    const view = cell.get();
    // deno-lint-ignore no-prototype-builtins
    expect(view.hasOwnProperty("a")).toBe(true);

    cell.set({ b: 2 });
    // deno-lint-ignore no-prototype-builtins
    expect(view.hasOwnProperty("a")).toBe(false);
    // deno-lint-ignore no-prototype-builtins
    expect(view.hasOwnProperty("b")).toBe(true);
  });
});
