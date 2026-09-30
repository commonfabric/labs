/** Reactive no-op runs retain changes arriving before subscription setup. */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";

import { Runtime } from "../src/runtime.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";

describe("scheduler-stale-noop", () => {
  for (const destination of ["commit", "seal"] as const) {
    for (const initial of [undefined, 0]) {
      it(`recomputes after a stale first no-op ${destination} with initial value ${initial}`, async () => {
        const signer = await Identity.fromPassphrase("scheduler-stale-noop");
        const storage = EmulatedStorageManager.emulate({ as: signer });
        const runtime = new Runtime({
          apiUrl: new URL(import.meta.url),
          storageManager: storage,
          experimental: { serverExecution: destination === "seal" },
        });
        const input = runtime.getCell<number | undefined>(
          signer.did(),
          "input",
        );
        const output = runtime.getCell<number | undefined>(
          signer.did(),
          "output",
        );
        const read = Promise.withResolvers<void>();
        const resume = Promise.withResolvers<void>();
        let runs = 0;
        let cancelAction: (() => void) | undefined;
        let cancelOutput: (() => void) | undefined;
        try {
          const seed = runtime.edit();
          input.withTx(seed).set(initial);
          output.withTx(seed).set(initial);
          expect((await seed.commit()).error).toBeUndefined();
          if (destination === "seal") {
            runtime.installSealDestination({
              seal: (tx) => {
                if (!tx.tx.sealInto) {
                  throw new Error("Expected a sealing transaction");
                }
                return tx.tx.sealInto({
                  sealSpaceCommit: (space, native, source) => {
                    const replica = storage.open(space).replica;
                    if (!replica.commitNative) {
                      throw new Error("Expected native commits");
                    }
                    return replica.commitNative(native, source);
                  },
                });
              },
            });
          }
          const action = Object.assign(
            async (tx: IExtendedStorageTransaction) => {
              const value = input.withTx(tx).get();
              if (++runs === 1) {
                read.resolve();
                await resume.promise;
              }
              output.withTx(tx).set(value);
            },
            { writes: [output.getAsNormalizedFullLink()] },
          );
          cancelAction = runtime.scheduler.subscribe(action);
          cancelOutput = output.sink(() => {});
          await read.promise;
          const update = runtime.edit();
          input.withTx(update).set(1);
          expect((await update.commit()).error).toBeUndefined();
          resume.resolve();
          await runtime.idle();
          expect(output.get()).toBe(1);
          expect(runs).toBe(2);
        } finally {
          resume.resolve();
          cancelOutput?.();
          cancelAction?.();
          runtime.clearSealDestination();
          await storage.synced();
          await runtime.dispose();
        }
      });
    }
  }
});
