import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import type { createBuilder } from "../src/builder/factory.ts";
import { getTopFrame, popFrame, pushFrame } from "../src/builder/pattern.ts";
import type { Frame } from "../src/builder/types.ts";
import { Runtime } from "../src/runtime.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { mintedWritesOfTx } from "../src/storage/reactivity-log.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";

const signer = await Identity.fromPassphrase("minted writes test operator");
const space = signer.did();

type Builder = ReturnType<typeof createBuilder>["commonfabric"];

describe("minted-writes", () => {
  let runtime: Runtime;
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let Writable: Builder["Writable"];

  /** The cause of the computation these cases run, kept across its runs. */
  const computation = { test: "minting computation" };

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    ({ Writable } = createTrustedBuilder(runtime).commonfabric);
  });

  afterEach(async () => {
    await runtime.dispose();
    await storageManager.close();
  });

  /**
   * Runs `fn` as a run of the computation whose cause is `cause`, in a
   * transaction of its own under a frame of `frameKind`, commits the run,
   * and returns the transaction with what `fn` returned.
   */
  const run = async <T>(
    fn: () => T,
    options: { cause?: unknown; frameKind?: Frame["frameKind"] } = {},
  ): Promise<{ tx: IExtendedStorageTransaction; result: T }> => {
    const tx = runtime.edit();
    const pushed = pushFrame({
      runtime,
      space,
      tx,
      cause: options.cause ?? computation,
      generatedIdCounter: 0,
      reactives: new Set(),
      frameKind: options.frameKind ?? "lift",
      unsafe_binding: { space, tx } as Frame["unsafe_binding"],
    });
    let result: T;
    try {
      result = fn();
    } finally {
      popFrame(pushed);
    }
    expect((await tx.commit().settled).error).toBeUndefined();
    return { tx, result };
  };

  /** The ids `tx` records as documents its run minted and set. */
  const mintedIdsOf = (tx: IExtendedStorageTransaction) =>
    mintedWritesOfTx(tx).map(({ id }) => id);

  it("records a whole-value `set()` of a cell a lift's run minted with `.for()`", async () => {
    const { tx, result } = await run(() =>
      Writable.for<{ label: string }>("row").set({ label: "A" })
    );

    expect(mintedIdsOf(tx)).toEqual([result.getAsNormalizedFullLink().id]);
  });

  it("records a `set()` of the value the minted document already holds, which writes nothing", async () => {
    await run(() => Writable.for<{ label: string }>("row").set({ label: "A" }));

    const { tx, result } = await run(() =>
      Writable.for<{ label: string }>("row").set({ label: "A" })
    );

    const id = result.getAsNormalizedFullLink().id;
    expect(mintedIdsOf(tx)).toEqual([id]);
    expect(tx.getReactivityLog().writes.map((write) => write.id)).not
      .toContain(id);
  });

  it("records nothing for a cell a lift's run minted with `.for()` and did not set", async () => {
    const { tx } = await run(() => {
      Writable.for<{ label: string }>("row").getAsNormalizedFullLink();
    });

    expect(mintedIdsOf(tx)).toEqual([]);
  });

  it("records nothing for a `set()` below the minted document's root", async () => {
    const { tx } = await run(() => {
      Writable.for<{ label: string }>("row").key("label").set("A");
    });

    expect(mintedIdsOf(tx)).toEqual([]);
  });

  it("records nothing for a `set()` of a cell the run did not mint", async () => {
    const handed = runtime.getCell<{ label: string }>(space, "handed row");

    const { tx } = await run(() => {
      handed.withTx(getTopFrame()!.tx).set({ label: "A" });
    });

    expect(mintedIdsOf(tx)).toEqual([]);
  });

  it("records nothing for a cell minted with `.for()` under a handler's frame", async () => {
    const { tx } = await run(
      () => Writable.for<{ label: string }>("row").set({ label: "A" }),
      { frameKind: "handler" },
    );

    expect(mintedIdsOf(tx)).toEqual([]);
  });

  it("records nothing for a `set()` in a run of another computation", async () => {
    const minted = await run(() => {
      const cell = Writable.for<{ label: string }>("row");
      cell.getAsNormalizedFullLink();
      return cell;
    });

    const { tx } = await run(
      () => minted.result.withTx(getTopFrame()!.tx).set({ label: "A" }),
      { cause: { test: "another computation" } },
    );

    expect(mintedIdsOf(tx)).toEqual([]);
  });
});
