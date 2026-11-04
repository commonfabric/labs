import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";

import { Identity } from "@commonfabric/identity";

import { Runtime } from "../src/runtime.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";

/**
 * A runtime whose storage manager serves `home`, so that it refuses every
 * scoped read of any other space, as a serving runtime's does, or, with
 * `serving` false, a client runtime whose manager refuses nothing.
 */
async function servingFixture(serving = true) {
  const signer = await Identity.fromPassphrase("derivation refused read");
  const home = signer.did();
  const foreign = (await Identity.fromPassphrase("derivation foreign space"))
    .did();
  const storage = EmulatedStorageManager.emulate({
    as: signer,
    ...(serving ? { servingHomeSpace: home } : {}),
  });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager: storage,
  });
  return {
    runtime,
    storage,
    home,
    foreign,
    async close() {
      await storage.synced();
      await runtime.dispose();
      await storage.close();
    },
  };
}

describe("scheduler-derivation-refused-read", () => {
  for (
    const scope of [
      { name: "session", refused: true },
      { name: "space", refused: false },
    ] as const
  ) {
    it(
      `${
        scope.refused ? "commits nothing from" : "commits the output of"
      } a derivation that read a foreign ${scope.name}-scoped document`,
      async () => {
        const { runtime, home, foreign, close } = await servingFixture();
        try {
          const input = runtime.getCell<string[]>(
            foreign,
            `derivation-refused-read-input-${scope.name}`,
            undefined,
            undefined,
            scope.name,
          );
          const output = runtime.getCell<string>(
            home,
            `derivation-refused-read-output-${scope.name}`,
          );
          const seed = runtime.edit();
          output.withTx(seed).set("as it was");
          expect((await seed.commit().settled).error).toBeUndefined();

          let runs = 0;
          const derive = (tx: IExtendedStorageTransaction) => {
            runs++;
            const items = input.withTx(tx).get();
            output.withTx(tx).set(
              items === undefined ? "derived from nothing" : "derived",
            );
          };
          runtime.scheduler.subscribe(derive, {
            reads: [],
            shallowReads: [],
            writes: [],
          }, { isEffect: true });
          await runtime.idle();
          await runtime.storageManager.synced();

          expect(runs).toBe(1);
          expect(output.get()).toBe(
            scope.refused ? "as it was" : "derived from nothing",
          );
        } finally {
          await close();
        }
      },
    );
  }

  for (const serving of [true, false]) {
    it(
      `finishes a derivation whose storage transaction records no read activities without an error, on a ${
        serving ? "serving" : "client"
      } runtime`,
      async () => {
        const { runtime, home, close } = await servingFixture(serving);
        const errors: Error[] = [];
        runtime.scheduler.onError((error) => errors.push(error));
        const edit = runtime.edit.bind(runtime);
        const strip = stub(runtime, "edit", (...args) => {
          const tx = edit(...args);
          Object.defineProperty(tx.tx, "getReadActivities", {
            configurable: true,
            value: undefined,
          });
          return tx;
        });
        try {
          const input = runtime.getCell<string>(
            home,
            `derivation-refused-read-unrecorded-input-${serving}`,
          );
          const output = runtime.getCell<string>(
            home,
            `derivation-refused-read-unrecorded-output-${serving}`,
          );
          let runs = 0;
          const derive = (tx: IExtendedStorageTransaction) => {
            runs++;
            output.withTx(tx).set(`derived from ${input.withTx(tx).get()}`);
          };
          runtime.scheduler.subscribe(derive, {
            reads: [],
            shallowReads: [],
            writes: [],
          }, { isEffect: true });
          await runtime.idle();
          await runtime.storageManager.synced();

          expect(runs).toBeGreaterThan(0);
          expect(errors).toEqual([]);
        } finally {
          strip.restore();
          await close();
        }
      },
    );
  }
});
