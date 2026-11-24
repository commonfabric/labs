/**
 * What a `#profile` wish does with the documents it reads beyond the profile
 * itself: the documents the profile's `name` resolves through, which decide
 * whether the profile is the user's own, and the profile's live name, which it
 * subscribes to. Each case drives the wish's action directly, one run at a
 * time.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { stub } from "@std/testing/mock";
import { Identity } from "@commonfabric/identity";
import { getLogger } from "@commonfabric/logger";
import { defer } from "@commonfabric/async/defer";

import { wish } from "../../src/builtins/wish.ts";
import type { Cell } from "../../src/cell.ts";
import { Runtime } from "../../src/runtime.ts";
import type { IExtendedStorageTransaction } from "../../src/storage/interface.ts";
import { EmulatedStorageManager } from "../../src/storage/v2-emulate.ts";
import { seedProfileOwner } from "../cfc-seed-envelope.ts";

const user = await Identity.fromPassphrase("wish profile reads user");
const profileSpace = await Identity.fromPassphrase("wish profile reads space");

describe("wish-profile-reads", () => {
  let storage: EmulatedStorageManager;
  let runtime: Runtime;
  let cancels: (() => void)[];

  beforeEach(() => {
    storage = EmulatedStorageManager.emulate({ as: user });
    runtime = new Runtime({
      apiUrl: new URL("https://example.invalid"),
      storageManager: storage,
      experimental: { serverExecution: false },
    });
    cancels = [];
  });

  afterEach(async () => {
    cancels.forEach((cancel) => cancel());
    await runtime.dispose({ closeStorage: false });
    await storage.close();
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
   * Seeds a profile of the user's own, whose `name` is `name`, and a Home
   * listing it; returns the profile.
   */
  async function seedProfile(
    name: (tx: IExtendedStorageTransaction) => unknown,
  ): Promise<Cell<unknown>> {
    let profile: Cell<unknown>;
    await commit((tx) => {
      profile = runtime.getCell(profileSpace.did(), "profile", undefined, tx);
      profile.set({ name: name(tx), initialNameApplied: "Ada", avatar: "" });
      seedProfileOwner(tx, profile.getAsNormalizedFullLink(), user.did());
    });
    await commit((tx) => {
      const root = runtime.getCell(user.did(), "home root", undefined, tx);
      root.key("profiles").set([profile]);
      runtime.getHomeSpaceCell(tx).asSchema(undefined).key("defaultPattern")
        .set(root);
    });
    await runtime.idle();
    return profile!;
  }

  /**
   * A headless `#profile` wish, and a function that runs its action once and
   * returns what the run sent, if anything.
   */
  async function driven(): Promise<
    (settle?: boolean) => Promise<Cell<any> | undefined>
  > {
    const owner = runtime.getCell(user.did(), "owner");
    const input = runtime.getCell(user.did(), "input");
    await commit((tx) => {
      owner.withTx(tx).set({});
      input.withTx(tx).set({ query: "#profile", headless: true });
    });
    const sent: Cell<any>[] = [];
    const builtin = wish(
      input as Cell<[unknown, unknown]>,
      (_tx, value) => {
        sent.push(value as Cell<any>);
      },
      (cancel) => cancels.push(cancel),
      [owner],
      owner,
      runtime,
    );
    // A run settles, by default, once the loads it started are done.
    return async (settle = true) => {
      const before = sent.length;
      await commit((tx) => builtin.action(tx));
      if (settle) {
        await storage.synced();
        await runtime.idle();
      }
      return sent.length > before ? sent.at(-1)!.withTx(undefined) : undefined;
    };
  }

  describe("the documents the profile's name resolves through", () => {
    // The profile's `name` links to a document nobody has written, so the
    // wish loads it to decide whether the profile is the user's own.

    /** The id of the document a profile's name links to. */
    let nameDocument: string;

    async function seedLinkedName(): Promise<void> {
      await seedProfile((tx) => {
        const linked = runtime.getCell(
          profileSpace.did(),
          "profile name",
          undefined,
          tx,
        );
        nameDocument = linked.getAsNormalizedFullLink().id;
        return linked;
      });
    }

    it("reports the profile's failure when one of them fails to load", async () => {
      await seedLinkedName();
      const sync = storage.syncCell.bind(storage);
      using _sync = stub(
        storage,
        "syncCell",
        (cell, options) =>
          cell.getAsNormalizedFullLink().id === nameDocument
            ? Promise.reject(new Error("name document load failed"))
            : sync(cell, options),
      );
      const run = await driven();

      // The first run asks for the document, and the second reads that its
      // load failed.
      await run();
      const state = await run();

      expect(state).toBeDefined();
      expect(state!.key("error").get()).toBe("Error: Could not load document");
      expect(state!.key("result").get()).toBeUndefined();
    });

    it("sends nothing while one of them is loading", async () => {
      await seedLinkedName();
      const sync = storage.syncCell.bind(storage);
      const loading = Promise.withResolvers<void>();
      using _sync = stub(
        storage,
        "syncCell",
        async (cell, options) => {
          if (cell.getAsNormalizedFullLink().id === nameDocument) {
            await loading.promise;
          }
          return await sync(cell, options);
        },
      );
      const run = await driven();

      expect(await run(false)).toBeUndefined();

      loading.resolve();
      await storage.synced();
      expect(await run()).toBeDefined();
    });
  });

  it("logs, and still answers with the profile, when its live name cannot be pulled", async () => {
    // A terminal session failure in the profile's space is what makes a pull
    // of a document there reject.
    await seedProfile(() => "Ada");
    const sessionError = storage.spaceSessionError?.bind(storage);
    using _session = stub(
      storage,
      "spaceSessionError",
      (space) =>
        space === profileSpace.did()
          ? new Error("profile session lost")
          : sessionError?.(space),
    );
    const wishFlow = getLogger("runner.wish-flow");
    const warned = new Map([
      ["profile-pull", defer<void>()],
      ["profile-name-pull", defer<void>()],
    ]);
    const warn = wishFlow.warn.bind(wishFlow);
    using _warn = stub(wishFlow, "warn", (key, ...messages) => {
      warned.get(key)?.resolve();
      warn(key, ...messages);
    });
    const run = await driven();

    const state = await run();

    expect(state!.key("result").key("name").get()).toBe("Ada");
    // Each pull is made without waiting on it, so its failure is logged when
    // it arrives.
    await Promise.all([...warned.values()].map((each) => each.promise));
  });
});
