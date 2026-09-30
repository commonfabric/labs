/**
 * A read hands back a stored `FabricInstance` as itself rather than as a view
 * over it. An instance keeps all of its state in private fields behind
 * accessors and methods on its prototype, and a proxy cannot carry the brand a
 * private-field read checks, so no view can stand in for one: `instanceof`,
 * the accessors, and the methods all need the instance itself.
 *
 * `FabricError` stands in for the whole tree here because it is the instance a
 * cell write actually produces -- `Cell.set()` of a JS `Error` wraps one --
 * and it is the state-heaviest of the concrete classes.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { deepFreeze, FabricInstance } from "@commonfabric/data-model";
import { FabricError } from "@commonfabric/data-model/fabric-instances";
import { Identity } from "@commonfabric/identity";
import { createQueryResultProxy } from "../src/query-result-proxy.ts";
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

  it("returns the stored instance itself, an instance of its class", () => {
    const cell = runtime.getCell<unknown>(space, "itselfCell", undefined, tx);
    cell.set(new TypeError("boom"));

    const result = cell.get();
    expect(result).toBe(cell.getRaw());
    expect(result).toBeInstanceOf(FabricError);
    // `FabricInstance` is abstract, so `toBeInstanceOf` will not take it.
    expect(result instanceof FabricInstance).toBe(true);
    expect(cell.get()).toBe(result);
  });

  it("returns the stored instance from a record, an array, and a link", () => {
    const target = runtime.getCell<unknown>(space, "linkedErr", undefined, tx);
    target.set(new Error("linked"));
    const holder = runtime.getCell<unknown>(space, "holderCell", undefined, tx);
    holder.set({
      wrap: new Error("wrapped"),
      list: [new Error("listed")],
      link: target,
    });

    const view = holder.get() as {
      wrap: unknown;
      list: unknown[];
      link: unknown;
    };
    const raw = holder.getRaw() as { wrap: unknown; list: unknown[] };
    expect(view.wrap).toBe(raw.wrap);
    expect(view.wrap).toBeInstanceOf(FabricError);
    expect(view.list[0]).toBe(raw.list[0]);
    expect([...view.list][0]).toBe(raw.list[0]);
    expect(view.list.map((entry) => entry)[0]).toBe(raw.list[0]);
    expect(view.link).toBe(target.getRaw());
  });

  it("keeps what it read after a rewrite, and a fresh read returns the rewrite", () => {
    // An instance is a value, as a primitive is: what a reader holds is what
    // the document held when it read, and the document is rewritten by
    // replacing it whole.
    const cell = runtime.getCell<unknown>(space, "rewriteCell", undefined, tx);
    cell.set(Object.assign(new Error("before"), { code: 1 }));
    const held = cell.get() as FabricError;

    cell.set(Object.assign(new Error("after"), { code: 2 }));

    expect(held.message).toBe("before");
    expect(held.getExtra("code")).toBe(1);
    expect((cell.get() as FabricError).message).toBe("after");
    expect((cell.get() as FabricError).getExtra("code")).toBe(2);
  });

  it("re-fires a reactive consumer when the stored instance is replaced", async () => {
    const cell = runtime.getCell<{ err: unknown }>(
      space,
      "reactCell",
      undefined,
      tx,
    );
    cell.set({ err: new Error("first") });
    await tx.commit();

    const seen: string[] = [];
    const cancel = cell.key("err").sink((value: unknown) => {
      seen.push((value as FabricError).message);
    });
    await runtime.idle();

    tx = runtime.edit();
    cell.withTx(tx).key("err").set(new Error("second"));
    await tx.commit();
    await runtime.idle();
    cancel();
    tx = runtime.edit();

    expect(seen).toEqual(["first", "second"]);
  });

  it("spreads and copies to an empty record", () => {
    // An instance has no enumerable own property by contract: its one own
    // key, the freeze shield, is not enumerable.
    const cell = runtime.getCell<unknown>(space, "spreadCell", undefined, tx);
    cell.set(Object.assign(new Error("boom"), { code: 1 }));
    const result = cell.get() as object;

    const spread = { ...result };
    const assigned = Object.assign({}, result);
    expect(Object.getPrototypeOf(spread)).toBe(Object.prototype);
    expect(Object.keys(spread)).toEqual([]);
    expect(Object.keys(assigned)).toEqual([]);
  });

  it("stays readable after a pinned read's transaction has finished", async () => {
    // What a pinned read hands back is the instance itself, not a view that
    // reads through the transaction, so it outlives the transaction as a
    // primitive read the same way does.
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
    const result = createQueryResultProxy<FabricError>(
      runtime,
      readTx,
      cell.getAsNormalizedFullLink(),
    );
    await readTx.commit();

    expect(result).toBeInstanceOf(FabricError);
    expect(result.getExtra("code")).toBe(42);
    expect((result.deepClone(false) as FabricError).message).toBe("boom");
  });

  it("hands back a link the instance holds as the link itself", () => {
    // What an instance holds comes back as it holds it, not as a view over
    // what a link points at (the marker on the special-object return in
    // `query-result-proxy.ts`). No cell write stores a link inside an
    // instance, so the document is written directly.
    const target = runtime.getCell<unknown>(
      space,
      "causeTarget",
      undefined,
      tx,
    );
    target.set({ greeting: "hi" });
    const holder = runtime.getCell<unknown>(space, "causeLink", undefined, tx);
    const stored = deepFreeze(
      new FabricError({
        type: "Error",
        message: "has a link",
        stack: undefined,
        cause: target.getAsLink() as never,
      }),
    );
    tx.writeValueOrThrow(holder.getAsNormalizedFullLink(), stored);

    const result = holder.get() as FabricError;
    expect(result).toBe(stored);
    expect(result.cause).toBe(stored.cause);
  });

  it("meets a mutator with the stored instance's own refusal", () => {
    // What refuses an instance's own mutator is that a stored instance is
    // deep-frozen.
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
    // `constructor` names the class, as it does on any instance of it.
    const cell = runtime.getCell<unknown>(space, "ctorCell", undefined, tx);
    cell.set(new Error("boom"));

    const result = cell.get() as object;
    expect(result.constructor).toBe(FabricError);
    expect(result.constructor.name).toBe("FabricError");
  });

  it("still runs a plain record's prototype method against the view", () => {
    // A plain record is read through a view, and its prototype methods run
    // against the view, so that what they read goes through its traps, live,
    // rather than off the snapshot the view was built over.
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
