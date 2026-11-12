import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";

import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";

const signer = await Identity.fromPassphrase("runner clear in transaction");
const space = signer.did();

describe("Runner", () => {
  describe("instance members", () => {
    describe("clearInTransaction()", () => {
      // A runtime that is not serving keeps a keyless piece's pattern pointer
      // in the session alone, so what a clear does to it is visible only
      // through `sessionPatternPointerFor()`.

      let storage: ReturnType<typeof StorageManager.emulate>;
      let runtime: Runtime;

      beforeEach(() => {
        storage = StorageManager.emulate({ as: signer });
        runtime = new Runtime({
          apiUrl: new URL(import.meta.url),
          storageManager: storage,
        });
      });

      afterEach(async () => {
        await runtime.dispose();
        await storage.close();
      });

      /** Runs a keyless piece and returns its result cell. */
      async function keylessPiece(name: string) {
        const { lift, pattern } = createTrustedBuilder(runtime).commonfabric;
        const program = pattern<{ value: number }>(({ value }) => ({
          answer: lift((input: number) => input + 1)(value),
        }));
        const result = runtime.getCell<{ answer: number }>(
          space,
          name,
          program.resultSchema,
        );
        const tx = runtime.edit();
        runtime.run(tx, program, { value: 1 }, result.withTx(tx));
        expect((await tx.commit().settled).error).toBeUndefined();
        expect(await result.pull()).toEqual({ answer: 2 });
        const pointer = runtime.runner.sessionPatternPointerFor(result);
        expect(pointer?.identity.startsWith("keyless:")).toBe(true);
        return { result, pointer };
      }

      it("restores a keyless piece's session pointer when the clear's transaction aborts", async () => {
        const { result, pointer } = await keylessPiece("aborted-clear");
        const tx = runtime.edit();
        runtime.runner.clearInTransaction(tx, result);
        expect(runtime.runner.sessionPatternPointerFor(result)).toBeUndefined();

        expect(tx.abort("The clear is refused").error).toBeUndefined();

        expect(runtime.runner.sessionPatternPointerFor(result)).toEqual(
          pointer,
        );
      });

      it("leaves a keyless piece without a session pointer once the clear commits", async () => {
        const { result } = await keylessPiece("committed-clear");
        const tx = runtime.edit();
        runtime.runner.clearInTransaction(tx, result);

        expect((await tx.commit().settled).error).toBeUndefined();
        await runtime.idle();

        expect(runtime.runner.sessionPatternPointerFor(result)).toBeUndefined();
        expect(result.get()).toBeUndefined();
      });
    });
  });
});
