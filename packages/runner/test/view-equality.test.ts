import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { FabricError } from "@commonfabric/data-model/fabric-instances";
import { FabricBytes } from "@commonfabric/data-model/fabric-primitives";
import { Identity } from "@commonfabric/identity";

import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import { isCellResult } from "../src/query-result-proxy.ts";
import { fabricAwareEqualThroughViews } from "../src/view-equality.ts";

const signer = await Identity.fromPassphrase("view-equality");
const space = signer.did();

describe("view-equality", () => {
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

  /** A cell holding `{ v: value }`, stored under `cause`. */
  const holding = (cause: string, value: unknown) => {
    const cell = runtime.getCell<{ v: unknown }>(space, cause, undefined, tx);
    cell.set({ v: value } as never);
    return cell;
  };

  it("answers as `fabricAwareEqual()` for operands holding no view", () => {
    const bytes = () => new FabricBytes(new Uint8Array([1, 2]));

    expect(fabricAwareEqualThroughViews({ v: bytes() }, { v: bytes() }))
      .toBe(true);
    expect(
      fabricAwareEqualThroughViews(
        { v: bytes() },
        { v: new FabricBytes(new Uint8Array([9])) },
      ),
    ).toBe(false);
    expect(fabricAwareEqualThroughViews({ v: bytes() }, { v: {} })).toBe(false);
    expect(fabricAwareEqualThroughViews({ a: [1] }, { a: [1] })).toBe(true);
    expect(fabricAwareEqualThroughViews({ a: [1] }, { a: [2] })).toBe(false);
  });

  it("decides a view of a stored `FabricError` as the stored instance", () => {
    const cell = holding(
      "view-of-error",
      FabricError.fromNativeError(new Error("boom")),
    );
    const view = cell.get().v;
    const stored = (cell.getRaw() as { v: unknown }).v;

    expect(isCellResult(view)).toBe(true);
    expect(fabricAwareEqualThroughViews(view, stored)).toBe(true);
    expect(
      fabricAwareEqualThroughViews(
        view,
        FabricError.fromNativeError(new Error("other")),
      ),
    ).toBe(false);
  });

  it("finds views of two stored `FabricError`s with different messages unequal", () => {
    const left = holding(
      "error-aaa",
      FabricError.fromNativeError(new Error("AAA")),
    );
    const right = holding(
      "error-zzz",
      FabricError.fromNativeError(new Error("ZZZ")),
    );

    expect(fabricAwareEqualThroughViews(left.get(), right.get())).toBe(false);
  });

  it("decides a `FabricError` reached through a link as the stored instance", () => {
    const target = runtime.getCell<unknown>(
      space,
      "linked-error",
      undefined,
      tx,
    );
    target.set(FabricError.fromNativeError(new Error("linked")) as never);
    const holder = holding("holds-link", target);

    expect(
      fabricAwareEqualThroughViews(
        (holder.asSchema(undefined).get() as { v: unknown }).v,
        target.getRaw(),
      ),
    ).toBe(true);
  });

  it("finds the views of one link an array holds twice equal", () => {
    const target = runtime.getCell<unknown>(space, "shared", undefined, tx);
    target.set(FabricError.fromNativeError(new Error("shared")) as never);
    const list = runtime.getCell<unknown[]>(space, "twice", undefined, tx);
    list.set([target, target] as never);
    const [first, second] = list.get();

    expect(fabricAwareEqualThroughViews(first, second)).toBe(true);
  });

  it("compares two views of one location read through different schemas by what they read", () => {
    const cell = holding("two-schemas", { a: 1 });
    const typed = cell.asSchema({
      type: "object",
      properties: { v: { type: "object" } },
    }).get();

    expect(fabricAwareEqualThroughViews(typed, cell.asSchema(undefined).get()))
      .toBe(true);
  });
});
