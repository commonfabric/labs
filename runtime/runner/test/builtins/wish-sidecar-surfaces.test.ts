/**
 * The surfaces a wish opens beside its state: the suggestion surface a
 * multi-match search offers, and the picker a `#profile` wish offers between
 * profiles none of which is the default. Each case drives the wish's action
 * directly, one run at a time, and serves the surface's pattern from a stand-in
 * for the source reconciler, so a case decides when, and whether, the surface
 * opens.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { stub } from "@std/testing/mock";
import { Identity } from "@commonfabric/identity";

import { NAME, type Pattern, UI } from "../../src/builder/types.ts";
import { wish, wishSidecarDiagnostics } from "../../src/builtins/wish.ts";
import type { Cell } from "../../src/cell.ts";
import { parseLink } from "../../src/link-utils.ts";
import { Runtime } from "../../src/runtime.ts";
import type { IExtendedStorageTransaction } from "../../src/storage/interface.ts";
import { StateInconsistency } from "../../src/storage/transaction/attestation.ts";
import { EmulatedStorageManager } from "../../src/storage/v2-emulate.ts";
import { seedProfileOwner } from "../cfc-seed-envelope.ts";
import { createTrustedBuilder } from "../support/trusted-builder.ts";

const user = await Identity.fromPassphrase("wish sidecar surfaces user");
const profileSpaces = [
  await Identity.fromPassphrase("wish sidecar surfaces profile one"),
  await Identity.fromPassphrase("wish sidecar surfaces profile two"),
];

describe("wish-sidecar-surfaces", () => {
  let runtime: Runtime;
  let cancels: (() => void)[];
  let opened: string[];
  let surface: Pattern;
  let open: Runtime["sourceReconciler"]["open"];

  beforeEach(() => {
    runtime = new Runtime({
      apiUrl: new URL("https://example.invalid"),
      storageManager: EmulatedStorageManager.emulate({ as: user }),
      experimental: { serverExecution: false },
    });
    cancels = [];
    opened = [];
    const { pattern } = createTrustedBuilder(runtime).commonfabric;
    // A surface that says it is one, and shows the situation it was handed.
    surface = pattern<{ situation?: string }>(({ situation }) => ({
      shown: "surface",
      situation,
    }));
    open = runtime.sourceReconciler.open;
    runtime.sourceReconciler.open = (_piece, origin) => {
      opened.push(origin);
      return Promise.resolve(surface);
    };
  });

  afterEach(async () => {
    cancels.forEach((cancel) => cancel());
    runtime.sourceReconciler.open = open;
    await runtime.storageManager.synced();
    await runtime.dispose();
  });

  /** Runs `write` in a transaction of its own and commits it. */
  async function commit(
    write: (tx: IExtendedStorageTransaction) => void,
  ): Promise<void> {
    const tx = runtime.edit();
    write(tx);
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit().settled).error).toBeUndefined();
  }

  /**
   * A wish over `params`, and a function that runs its action once and
   * returns what the run sent.
   */
  async function driven(
    label: string,
    params: Record<string, unknown>,
  ): Promise<{ run: (settle?: boolean) => Promise<Cell<any>> }> {
    const owner = runtime.getCell(user.did(), `${label} owner`);
    const input = runtime.getCell(user.did(), `${label} input`);
    await commit((tx) => {
      owner.withTx(tx).set({});
      input.withTx(tx).set(params);
    });
    await runtime.idle();
    let output: Cell<any> | undefined;
    const builtin = wish(
      input as Cell<[unknown, unknown]>,
      (_tx, value) => {
        output = value as Cell<any>;
      },
      (cancel) => cancels.push(cancel),
      [owner],
      owner,
      runtime,
    );
    return {
      // A run settles, by default, once what it started is done, the opening
      // of a surface among it.
      run: async (settle = true) => {
        output = undefined;
        await commit((tx) => builtin.action(tx));
        if (settle) {
          await runtime.storageManager.synced();
          await runtime.idle();
        }
        expect(output).toBeDefined();
        return output!.withTx(undefined);
      },
    };
  }

  /** The surface cell a state's `[UI]` renders. */
  function surfaceOf(state: Cell<any>): Cell<any> {
    const ui = state.key(UI).key("props").key("$cell");
    return runtime.getCellFromLink(parseLink(ui.getRaw(), ui)!);
  }

  describe("the suggestion surface", () => {
    beforeEach(async () => {
      // Two mentionables of one name, so a search for it matches both.
      await commit((tx) => {
        const first = runtime.getCell(
          user.did(),
          "first gadget",
          undefined,
          tx,
        );
        first.set({ [NAME]: "gadget", kind: "first" });
        const second = runtime.getCell(
          user.did(),
          "second gadget",
          undefined,
          tx,
        );
        second.set({ [NAME]: "gadget", kind: "second" });
        const root = runtime.getCell(user.did(), "space root", undefined, tx);
        root.set({ backlinksIndex: { mentionable: [first, second] } });
        runtime.getCell<{ defaultPattern?: unknown }>(
          user.did(),
          user.did(),
          undefined,
          tx,
        ).key("defaultPattern").set(root);
      });
    });

    it("sends the first match while the surface opens, and the surface once it has", async () => {
      const { run } = await driven("suggestion", {
        query: "#gadget",
        scope: ["."],
      });

      const before = await run();
      expect(before.key("result").get()).toEqual({
        [NAME]: "gadget",
        kind: "first",
      });
      expect(opened).toEqual(["system:system/suggestion/suggestion.tsx"]);

      const after = await run();
      await after.pull();
      expect(after.key("situation").get()).toBe("#gadget");
      // The surface opened once, and the second run used what it opened.
      expect(opened).toEqual(["system:system/suggestion/suggestion.tsx"]);
    });
  });

  describe("the profile picker", () => {
    beforeEach(async () => {
      // Two profiles of the user's own, and no default between them.
      const profiles: Cell<unknown>[] = [];
      for (const [index, space] of profileSpaces.entries()) {
        await commit((tx) => {
          const profile = runtime.getCell(
            space.did(),
            `profile ${index}`,
            undefined,
            tx,
          );
          profile.set({
            name: `Profile ${index}`,
            initialNameApplied: `Profile ${index}`,
            avatar: "",
          });
          seedProfileOwner(tx, profile.getAsNormalizedFullLink(), user.did());
          profiles.push(profile);
        });
      }
      await commit((tx) => {
        const root = runtime.getCell(user.did(), "home root", undefined, tx);
        root.key("profiles").set(profiles);
        runtime.getHomeSpaceCell(tx).asSchema(undefined).key("defaultPattern")
          .set(root);
      });
    });

    it("runs the picker it has opened in the run that finds it open", async () => {
      const { run } = await driven("picker", { query: "#profile" });

      const first = await run();
      expect(first.key("result").key("name").get()).toBe("Profile 0");
      expect(opened).toEqual([
        "system:system/profile-picker/profile-picker.tsx",
      ]);
      expect(await surfaceOf(first).key("shown").pull()).toBe("surface");

      const second = await run();
      expect(second.key("result").key("name").get()).toBe("Profile 0");
      expect(await surfaceOf(second).key("shown").pull()).toBe("surface");
      expect(opened.length).toBe(1);
    });

    it("writes why into the picker when opening it throws", async () => {
      runtime.sourceReconciler.open = (_piece, origin) => {
        opened.push(origin);
        return Promise.reject(new Error("picker source unavailable"));
      };
      const { run } = await driven("picker failure", { query: "#profile" });

      const state = await run();
      const picker = surfaceOf(state);
      await picker.pull();

      expect(state.key("result").key("name").get()).toBe("Profile 0");
      expect(String(picker.key("sidecarError").get())).toContain(
        "picker source unavailable",
      );
      expect(picker.key("shown").get()).toBeUndefined();
    });

    it("leaves the picker alone when the wish is cancelled before it opens", async () => {
      const opening = Promise.withResolvers<Pattern>();
      runtime.sourceReconciler.open = (_piece, origin) => {
        opened.push(origin);
        return opening.promise;
      };
      const { run } = await driven("picker cancelled", { query: "#profile" });

      const state = await run(false);
      const picker = surfaceOf(state);
      cancels.splice(0).forEach((cancel) => cancel());
      opening.resolve(surface);
      await opening.promise;
      await runtime.idle();
      await runtime.storageManager.synced();

      expect(opened.length).toBe(1);
      expect(picker.getRaw()).toBeUndefined();
    });

    describe("when running the picker fails", () => {
      // The picker runs in a transaction of its own once it has opened. A
      // conflict there means another writer moved a document the run read:
      // the run is tried again, at most three times in all, unless a picker
      // is in the cell by then, which the run then leaves alone. Any other
      // failure is written into the cell.

      /** The picker runs started, each with what it threw, if anything. */
      function failRuns(
        failures: (Error | { name: string; message: string } | undefined)[],
      ): { attempts: number } {
        const runs = { attempts: 0 };
        const realRun = runtime.runner.run.bind(runtime.runner);
        runtime.runner.run = ((...args: Parameters<typeof realRun>) => {
          if (args[1] === surface) {
            const failure = failures[runs.attempts++];
            if (failure !== undefined) throw failure;
          }
          return realRun(...args);
        }) as typeof realRun;
        return runs;
      }

      /**
       * Refuses the commits of the first `count` picker runs as stale, and
       * records the id of the picker's cell.
       */
      function refuseCommits(
        count: number,
      ): { attempts: number; picker?: string } {
        const commits: { attempts: number; picker?: string } = {
          attempts: 0,
        };
        const replica = runtime.storageManager.open(user.did()).replica;
        const commitNative = replica.commitNative!;
        const stampServerRun = runtime.stampServerRun;
        const pickerRuns = new WeakSet<object>();
        runtime.stampServerRun = (tx, info) => {
          stampServerRun.call(runtime, tx, info);
          if (info.actionId.startsWith("wish/sidecar-run/")) {
            pickerRuns.add(tx.tx);
            commits.picker = info.actionId.slice("wish/sidecar-run/".length);
          }
        };
        replica.commitNative = (native, source, options) => {
          if (source && pickerRuns.has(source)) {
            if (commits.attempts++ < count) {
              return Promise.resolve({
                error: StateInconsistency({
                  address: {
                    id: "of:picker-run",
                    type: "application/json",
                    path: [],
                  },
                }),
              });
            }
          }
          return commitNative.call(replica, native, source, options);
        };
        return commits;
      }

      it("runs it again after a conflict at its commit", async () => {
        const commits = refuseCommits(1);
        const { run } = await driven("picker commit retry", {
          query: "#profile",
        });

        const picker = surfaceOf(await run());

        expect(await picker.key("shown").pull()).toBe("surface");
        expect(commits.attempts).toBe(2);
      });

      it("runs it again after a conflict at its commit when its cell then fails to load", async () => {
        // A conflict asks whether a picker is in the cell already, which
        // loads the cell. A failed load leaves the answer to what the replica
        // holds, which here is nothing.
        const commits = refuseCommits(1);
        const failedLoads: string[] = [];
        const sync = runtime.storageManager.syncCell.bind(
          runtime.storageManager,
        );
        using _sync = stub(
          runtime.storageManager,
          "syncCell",
          (cell, options) => {
            const id = cell.getAsNormalizedFullLink().id;
            if (
              id === commits.picker && commits.attempts === 1 &&
              failedLoads.length === 0
            ) {
              failedLoads.push(id);
              return Promise.reject(new Error("picker cell load failed"));
            }
            return sync(cell, options);
          },
        );
        const { run } = await driven("picker probe failure", {
          query: "#profile",
        });

        const picker = surfaceOf(await run());

        expect(await picker.key("shown").pull()).toBe("surface");
        expect(failedLoads).toEqual([commits.picker]);
        expect(commits.attempts).toBe(2);
      });

      it("writes the conflict into it when every attempt meets one at its commit", async () => {
        const commits = refuseCommits(3);
        const { run } = await driven("picker commit refused", {
          query: "#profile",
        });

        const picker = surfaceOf(await run());
        await picker.pull();

        expect(commits.attempts).toBe(3);
        expect(String(picker.key("sidecarError").get())).toContain(
          "StorageTransactionInconsistent",
        );
        expect(picker.key("shown").get()).toBeUndefined();
      });

      it("runs it again after a run that throws a conflict", async () => {
        const runs = failRuns([{
          name: "ConflictError",
          message: "picker input moved",
        }]);
        const { run } = await driven("picker thrown retry", {
          query: "#profile",
        });

        const picker = surfaceOf(await run());

        expect(await picker.key("shown").pull()).toBe("surface");
        expect(runs.attempts).toBe(2);
      });

      it("writes why into it when its run throws anything else", async () => {
        const runs = failRuns([new Error("picker run crashed")]);
        const { run } = await driven("picker thrown", { query: "#profile" });

        const picker = surfaceOf(await run());
        await picker.pull();

        expect(runs.attempts).toBe(1);
        expect(String(picker.key("sidecarError").get())).toContain(
          "picker run crashed",
        );
        expect(picker.key("shown").get()).toBeUndefined();
      });

      it("leaves a picker already in its cell alone when its run throws a conflict", async () => {
        const opening = Promise.withResolvers<Pattern>();
        runtime.sourceReconciler.open = () => opening.promise;
        const runs = failRuns([{
          name: "ConflictError",
          message: "picker raced",
        }]);
        const raced = wishSidecarDiagnostics.sidecarRunsRaced;
        const { run } = await driven("picker raced", { query: "#profile" });

        const picker = surfaceOf(await run(false));
        await commit((tx) => picker.withTx(tx).set({ shown: "the winner" }));
        opening.resolve(surface);
        await runtime.idle();

        expect(runs.attempts).toBe(1);
        expect(wishSidecarDiagnostics.sidecarRunsRaced).toBe(raced + 1);
        expect(picker.key("shown").get()).toBe("the winner");
      });
    });
  });
});
