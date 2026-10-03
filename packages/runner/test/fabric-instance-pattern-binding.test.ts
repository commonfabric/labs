import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { deepFreeze } from "@commonfabric/data-model";
import { FabricError } from "@commonfabric/data-model/fabric-instances";
import { Identity } from "@commonfabric/identity";

import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";

const signer = await Identity.fromPassphrase("fabric instance pattern binding");
const space = signer.did();

describe("fabric-instance-pattern-binding", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let errors: Error[];

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({ apiUrl: new URL(import.meta.url), storageManager });
    errors = [];
    runtime.scheduler.onError((error: Error) => {
      errors.push(error);
    });
  });

  afterEach(async () => {
    await runtime.dispose();
    await storageManager.close();
  });

  /**
   * Runs a root whose computation calls a pattern with the given `error`, and
   * returns the `message` that pattern reads off it.
   */
  async function runCardWith(makeError: () => unknown) {
    const { cell, lift, pattern } = createTrustedBuilder(runtime).commonfabric;
    const card = pattern<{ error: unknown }>(({ error }) => ({
      message: lift((e: unknown) => (e as FabricError).message)(error),
    }));
    const produce = lift((_trigger: number) => card({ error: makeError() }));
    const root = pattern(() => ({ card: produce(cell(1)) }));

    const tx = runtime.edit();
    const rootCell = runtime.getCell<{ card: unknown }>(
      space,
      "instance binding root",
      undefined,
      tx,
    );
    const result = runtime.run(tx, root, {}, rootCell);
    await tx.commit();
    const stop = result.key("card").sink(() => {});
    try {
      await runtime.idle();
      await result.pull();
      expect(errors.map((error) => error.message)).toEqual([]);
      return result.key("card").key("message" as never).get();
    } finally {
      stop();
    }
  }

  it("hands a deep-frozen `FabricError` to a pattern a computation calls", async () => {
    // The builder walks, the rebinding, and the policy-input recording each
    // reach the instance on the way, and none of them can descend one; each
    // carries one holding nothing but fabric data whole.
    const message = await runCardWith(() =>
      deepFreeze(FabricError.fromNativeError(new Error("boom")))
    );

    expect(message).toBe("boom");
  });

  it("sets up a handler whose typed state holds a deep-frozen `FabricError`", async () => {
    // The argument walks that collect a handler's writable and scheduler-read
    // links reach the instance at its typed position, and cannot descend it;
    // one holding nothing but fabric data holds no link to collect.
    const { handler, pattern } = createTrustedBuilder(runtime).commonfabric;
    const root = pattern(() => ({
      note: handler(
        { type: "object", properties: {} },
        { type: "object", properties: { err: { type: "object" } } },
        () => {},
      )({
        // An object-typed slot is typed as a record, which an instance is
        // not, statically; at run time the slot admits one.
        err: deepFreeze(
          FabricError.fromNativeError(new Error("boom")),
        ) as never,
      }),
    }));

    const tx = runtime.edit();
    const rootCell = runtime.getCell<{ note: unknown }>(
      space,
      "instance handler root",
      undefined,
      tx,
    );
    runtime.run(tx, root, {}, rootCell);
    expect((await tx.commit()).error).toBeUndefined();
    await runtime.idle();

    expect(errors.map((error) => error.message)).toEqual([]);
  });
});
