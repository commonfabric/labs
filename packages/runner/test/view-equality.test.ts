import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { FabricError } from "@commonfabric/data-model/fabric-instances";
import { FabricBytes } from "@commonfabric/data-model/fabric-primitives";
import { Identity } from "@commonfabric/identity";

import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import type { JSONSchema } from "../src/builder/types.ts";
import { validateSchemaValue } from "../src/cfc/schema-sanitization.ts";
import {
  createQueryResultProxy,
  isCellResult,
} from "../src/query-result-proxy.ts";
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

  it("compares two values whose links lead back into them without recursing forever", () => {
    // Each document links to itself, so the walk meets the pair of their
    // views again one level down, and again below that.

    const selfLinked = (cause: string, label: string) => {
      const cell = runtime.getCell<unknown>(space, cause, undefined, tx);
      cell.set({ label, next: cell } as never);
      return cell.get();
    };

    expect(
      fabricAwareEqualThroughViews(selfLinked("x", "a"), selfLinked("y", "a")),
    ).toBe(true);
    expect(
      fabricAwareEqualThroughViews(selfLinked("p", "a"), selfLinked("q", "b")),
    ).toBe(false);
  });

  it("decides a pinned view of a `FabricError` as the instance of its own instant", () => {
    // A later write in the view's transaction is not visible to the view, so
    // neither is it to the comparison.

    const cell = runtime.getCell<unknown>(space, "pinned-error", undefined, tx);
    cell.set(FabricError.fromNativeError(new Error("before")) as never);
    const before = cell.getRaw();
    tx.markLazyMaterialize(true);
    const view = createQueryResultProxy<{ message: string }>(
      runtime,
      tx,
      cell.getAsNormalizedFullLink(),
    );
    cell.set(FabricError.fromNativeError(new Error("after")) as never);
    const after = cell.getRaw();

    expect(view.message).toBe("before");
    expect(fabricAwareEqualThroughViews(view, before)).toBe(true);
    expect(fabricAwareEqualThroughViews(view, after)).toBe(false);
    expect(validateSchemaValue({ const: before } as JSONSchema, view))
      .toBeUndefined();
    expect(validateSchemaValue({ const: after } as JSONSchema, view))
      .toBe("value does not match const");
  });

  it("reads no more of a projected view than the comparison walks", async () => {
    // Reading `description`, which the schema leaves out, would carry its
    // confidentiality into the write below, and the commit would refuse it.

    const SECRET = {
      type: "https://commonfabric.org/cfc/atom/User",
      subject: "secret",
    };
    const storage = StorageManager.emulate({ as: signer });
    const strict = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage,
      cfcEnforcementMode: "enforce-strict",
      cfcFlowLabels: "persist",
    });
    try {
      const seed = strict.edit();
      const record = strict.getCell(space, "projected", {
        type: "object",
        properties: {
          description: { type: "string", ifc: { confidentiality: [SECRET] } },
          amount: { type: "number" },
        },
      }, seed);
      record.set({ description: "private note", amount: 12 });
      expect((await seed.commit()).error).toBeUndefined();
      await record.sync();

      const read = strict.edit();
      const projected = record.asSchema({
        type: "object",
        properties: { amount: { type: "number" } },
      }).withTx(read).get();
      const same = fabricAwareEqualThroughViews(projected, { amount: 12 });
      strict.getCell<boolean>(space, "projected-same", undefined, read)
        .set(same);

      expect(same).toBe(true);
      expect((await read.commit()).error).toBeUndefined();
    } finally {
      await strict.dispose();
      await storage.close();
    }
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
