import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";

import { wish } from "../../src/builtins/wish.ts";
import type { Cell } from "../../src/cell.ts";
import { Runtime } from "../../src/runtime.ts";
import { EmulatedStorageManager } from "../../src/storage/v2-emulate.ts";
import { createTrustedBuilder } from "../support/trusted-builder.ts";

const user = await Identity.fromPassphrase("freeform wish consumer");

describe("wish-freeform", () => {
  for (const headless of [false, true]) {
    it(`opens suggestions only for an interactive query (headless=${headless})`, async () => {
      const runtime = new Runtime({
        apiUrl: new URL("https://example.invalid"),
        storageManager: EmulatedStorageManager.emulate({ as: user }),
        experimental: { serverExecution: false },
      });
      const cancels: (() => void)[] = [];
      const originalOpen = runtime.sourceReconciler.open;
      const opened: string[] = [];
      try {
        const { pattern } = createTrustedBuilder(runtime).commonfabric;
        const suggestion = pattern<{
          situation: string;
          context: { note: string };
        }>(({ situation, context }) => ({ result: situation, context }));
        runtime.sourceReconciler.open = (_piece, origin) => {
          opened.push(origin);
          return Promise.resolve(suggestion);
        };
        const owner = runtime.getCell(user.did(), "freeform-owner");
        const input = runtime.getCell(user.did(), "freeform-input");
        const query = "help organize my notes";
        const seed = runtime.edit();
        owner.withTx(seed).set({});
        input.withTx(seed).set({
          query,
          context: { note: "Keep the project notes together" },
          headless,
        });
        runtime.prepareTxForCommit(seed);
        expect((await seed.commit()).error).toBeUndefined();
        let output: Cell<unknown> | undefined;
        const builtin = wish(
          input as Cell<[unknown, unknown]>,
          (_tx, value) => {
            output = value as Cell<unknown>;
          },
          (cancel) => cancels.push(cancel),
          [owner],
          owner,
          runtime,
        );
        const tx = runtime.edit();
        builtin.action(tx);
        runtime.prepareTxForCommit(tx);
        expect((await tx.commit()).error).toBeUndefined();
        await runtime.idle();
        expect(output).toBeDefined();
        const state = output!.withTx(undefined);
        if (headless) {
          expect(opened).toEqual([]);
          expect(state.key("result").get()).toBeUndefined();
          expect(state.key("candidates").get()).toEqual([]);
        } else {
          expect(opened).toEqual(["system:system/suggestion.tsx"]);
          await state.pull();
          expect(state.key("result").get()).toBe(query);
          expect(state.key("context").key("note").get()).toBe(
            "Keep the project notes together",
          );
        }
      } finally {
        cancels.forEach((cancel) => cancel());
        runtime.sourceReconciler.open = originalOpen;
        await runtime.storageManager.synced();
        await runtime.dispose();
      }
    });
  }
});
