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
});
