import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";

import { rawMetaWriteAuthorization } from "../src/meta-seam.ts";
import { Runtime } from "../src/runtime.ts";
import {
  EmulatedStorageManager,
  newLoopbackServer,
} from "../src/storage/cache.deno.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { isCfcEnforcementRejection } from "../src/storage/rejection.ts";
import { refuseAtCommitBoundary } from "./refused-commit.ts";

const signer = await Identity.fromPassphrase("pattern-swap-setup-verdict");
const space = signer.did();

/** A piece whose `slots` are its `input` times `factor`. */
function scaling(factor: number) {
  return {
    main: "/main.tsx",
    files: [{
      name: "/main.tsx",
      contents: `
        import { computed, pattern, Writable } from "commonfabric";
        export default pattern<{ input: Writable<number> }, { slots: number[] }>(
          ({ input }) => ({
            slots: [0].map(() => computed(() => input.get() * ${factor})),
          }),
        );
      `,
    }],
  };
}

/**
 * A piece whose `add` stream appends to a list made with `.for(listCause)`,
 * and which exposes that list as `list`. Two versions that differ only in that
 * cause bind the stream to two different cells. With `stream` false the piece
 * exposes the list alone.
 */
function appending(listCause: string, stream = true) {
  return {
    main: "/main.tsx",
    files: [{
      name: "/main.tsx",
      contents: `/// <cts-enable />
        import { handler, pattern, Writable } from "commonfabric";
        const add = handler<{ add: string }, { list: Writable<string[]> }>(
          (event, { list }) => {
            list.set([...list.get(), event.add]);
          },
        );
        export default pattern<Record<string, never>>(() => {
          const list = new Writable<string[]>([]).for("${listCause}");
          return ${stream ? "{ list, add: add({ list }) }" : "{ list }"};
        });
      `,
    }],
  };
}

describe("pattern-swap-setup-verdict", () => {
  let server: ReturnType<typeof newLoopbackServer>;
  let runtime: Runtime;
  let prepare: Runtime["prepareTxForCommit"];
  // Set by a case that disposes the runtime itself, keeping its storage.
  let disposedKeepingStorage: boolean;

  beforeEach(() => {
    disposedKeepingStorage = false;
    server = newLoopbackServer({ subscriptionRefreshDelayMs: 0 });
    runtime = new Runtime({
      apiUrl: new URL("http://toolshed.test"),
      storageManager: EmulatedStorageManager.connectTo(server, { as: signer }),
      experimental: { serverExecution: false },
    });
    prepare = runtime.prepareTxForCommit;
  });

  afterEach(async () => {
    runtime.prepareTxForCommit = prepare;
    if (disposedKeepingStorage) {
      await runtime.storageManager.close();
    } else {
      await runtime.idle();
      await runtime.patternManager.flushCompileCacheWrites();
      await runtime.storageManager.synced();
      await runtime.dispose();
    }
    await server.close();
  });

  /**
   * Waits until the piece's instantiation and the writes before it have
   * settled, so that a pointer move that follows cannot race them.
   */
  const settled = async () => {
    await runtime.idle();
    await runtime.runner.idlePieceInstantiationSettlements();
    await runtime.storageManager.synced();
    await runtime.idle();
  };

  /**
   * Refuse, at the commit boundary, the setup the pattern watcher stages for
   * `pieceId`, and record each refusal's verdict in the returned list. The
   * watcher's setup is the only commit that writes the piece's setup marker
   * after the piece has started.
   */
  const refuseWatcherSetup = (pieceId: string): boolean[] => {
    const refused: boolean[] = [];
    runtime.prepareTxForCommit = (tx: IExtendedStorageTransaction) => {
      const stagesSetup = [...tx.getWriteDetails?.(space) ?? []].some((
        { address },
      ) =>
        address.id === pieceId && address.path[0] === "patternSetupIdentity"
      );
      if (stagesSetup) {
        refuseAtCommitBoundary(tx, space, "refuse the watcher's setup");
        tx.addCommitCallback((_settled, result) => {
          refused.push(isCfcEnforcementRejection(result.error));
        });
      }
      prepare.call(runtime, tx);
    };
    return refused;
  };

  /**
   * Holds the settlement of the setup the pattern watcher stages for
   * `pieceId` until the returned resolver's promise resolves. The setup still
   * applies locally when it commits.
   */
  const holdWatcherSetup = (pieceId: string) => {
    const settle = Promise.withResolvers<void>();
    runtime.prepareTxForCommit = (tx: IExtendedStorageTransaction) => {
      const stagesSetup = [...tx.getWriteDetails?.(space) ?? []].some((
        { address },
      ) =>
        address.id === pieceId && address.path[0] === "patternSetupIdentity"
      );
      if (stagesSetup) {
        const commit = tx.commit.bind(tx);
        tx.commit = (...args) => {
          const receipt = commit(...args);
          return Object.create(receipt, {
            settled: { value: settle.promise.then(() => receipt.settled) },
          });
        };
      }
      prepare.call(runtime, tx);
    };
    return settle;
  };

  /**
   * Resolves the returned promise once the scheduler finds a piece
   * mid-change, which is when it holds the head event for it. Restore with
   * the returned `restore`.
   */
  const whenHeld = () => {
    const held = Promise.withResolvers<void>();
    const runner = runtime.runner;
    const consult = runner.pendingPatternChangeFor.bind(runner);
    runner.pendingPatternChangeFor = (pieces) => {
      const change = consult(pieces);
      if (change !== undefined) held.resolve();
      return change;
    };
    return {
      held: held.promise,
      restore: () => runner.pendingPatternChangeFor = consult,
    };
  };

  it("keeps the running graph reactive when the setup a pointer move needs is refused", async () => {
    expect(runtime.sealDestinationInstalled).toBe(false);
    const v1 = await runtime.patternManager.compilePattern(scaling(2), {
      space,
    });
    const v2 = await runtime.patternManager.compilePattern(scaling(3), {
      space,
    });
    const v2Ref = runtime.patternManager.getArtifactEntryRef(v2)!;
    const input = runtime.getCell<number>(space, "swap-verdict-input");
    const piece = runtime.getCell<{ slots: number[] }>(
      space,
      "swap-verdict-scaling",
    );
    const seed = runtime.edit();
    input.withTx(seed).set(1);
    await runtime.setup(seed, v1, { input }, piece);
    expect((await seed.commit().settled).error).toBeUndefined();
    expect(await runtime.start(piece)).toBe(true);
    const cancel = piece.sink(() => {});
    await settled();
    expect(piece.get()).toEqual({ slots: [2] });

    const refused = refuseWatcherSetup(piece.getAsNormalizedFullLink().id);
    const move = runtime.edit();
    piece.withTx(move).setMetaRaw(
      "patternIdentity",
      v2Ref,
      rawMetaWriteAuthorization,
    );
    expect((await move.commit().settled).error).toBeUndefined();
    await runtime.idle();
    runtime.prepareTxForCommit = prepare;
    expect(refused).toEqual([true]);

    expect(
      (await runtime.editWithRetry((tx) => input.withTx(tx).set(4))).error,
    ).toBeUndefined();
    await runtime.idle();
    expect(piece.get()).toEqual({ slots: [8] });
    cancel();
  });

  /**
   * Runs the `tags` version of `appending`, appends `before` through its
   * stream, and returns the piece with the reference of `incoming`, by default
   * the `labels` version.
   */
  const runAppending = async (incoming = appending("labels")) => {
    const v1 = await runtime.patternManager.compilePattern(
      appending("tags"),
      { space },
    );
    const v2 = await runtime.patternManager.compilePattern(incoming, {
      space,
    });
    const seed = runtime.edit();
    const piece = runtime.run(
      seed,
      v1,
      {},
      runtime.getCell(space, "swap-verdict-appending", v1.resultSchema, seed),
    );
    runtime.prepareTxForCommit(seed);
    expect((await seed.commit().settled).error).toBeUndefined();
    const cancel = piece.sink(() => {});
    await settled();
    piece.key("add").send({ add: "before" });
    await settled();
    expect(await piece.key("list").pull()).toEqual(["before"]);
    return {
      piece,
      v2Ref: runtime.patternManager.getArtifactEntryRef(v2)!,
      cancel,
    };
  };

  for (const refusal of [false, true]) {
    it(
      `delivers an event sent once a ${
        refusal ? "refused " : ""
      }pointer move commits to the ${
        refusal ? "running" : "incoming"
      } pattern's handler`,
      async () => {
        const { piece, v2Ref, cancel } = await runAppending();
        const refused = refusal
          ? refuseWatcherSetup(piece.getAsNormalizedFullLink().id)
          : [];
        const move = runtime.edit();
        piece.withTx(move).setMetaRaw(
          "patternIdentity",
          v2Ref,
          rawMetaWriteAuthorization,
        );
        expect((await move.commit().settled).error).toBeUndefined();
        piece.key("add").send({ add: "after" });
        await runtime.idle();
        runtime.prepareTxForCommit = prepare;
        expect(refused).toEqual(refusal ? [true] : []);

        // The incoming pattern's list is a cell the running one never wrote.
        expect(await piece.key("list").pull()).toEqual(
          refusal ? ["before", "after"] : ["after"],
        );
        cancel();
      },
    );
  }

  it("delivers events queued before the incoming pattern's setup settles to that pattern's handler", async () => {
    // The watcher's setup commit settles only once `settle` resolves. It
    // resolves when the scheduler finds the first event's piece mid-change,
    // or, if nothing holds the event, when the running pattern's handler
    // writes it to that pattern's list. The second event reaches the queue's
    // head once the swap has finished, still holding the outgoing pattern's
    // handler. The setup is applied locally before it settles, so the piece's
    // `list` names the incoming pattern's cell by then, and the running
    // pattern's list is watched where it lives.
    const { piece, v2Ref, cancel } = await runAppending();
    const outgoingAdd = piece.key("add").resolveAsCell();
    const settle = holdWatcherSetup(piece.getAsNormalizedFullLink().id);
    const runner = runtime.runner;
    const consult = runner.pendingPatternChangeFor.bind(runner);
    runner.pendingPatternChangeFor = (pieces) => {
      const change = consult(pieces);
      if (change !== undefined) settle.resolve();
      return change;
    };
    const outgoingList = piece.key("list").resolveAsCell();
    const watch = outgoingList.sink((list) => {
      if (Array.isArray(list) && list.includes("after")) settle.resolve();
    });
    try {
      const move = runtime.edit();
      piece.withTx(move).setMetaRaw(
        "patternIdentity",
        v2Ref,
        rawMetaWriteAuthorization,
      );
      expect((await move.commit().settled).error).toBeUndefined();
      outgoingAdd.send({ add: "after" });
      outgoingAdd.send({ add: "later" });
      await settle.promise;
      await runtime.idle();
    } finally {
      runtime.prepareTxForCommit = prepare;
      runner.pendingPatternChangeFor = consult;
      watch();
    }

    expect(await piece.key("list").pull()).toEqual(["after", "later"]);
    cancel();
  });

  it("drops events the incoming pattern registers no handler for", async () => {
    // Both events are sent to the outgoing pattern's stream while the swap's
    // setup is held, so both hold its handler, which nothing replaces. The
    // first reaches the queue's head while the swap is in flight and waits for
    // it, which releases the setup; the second reaches it once the swap has
    // finished. If nothing holds the first, the outgoing handler's write
    // releases it. The setup applies locally before it settles, and the
    // incoming result has no `add`, so the stream is resolved beforehand.
    const { piece, v2Ref, cancel } = await runAppending(
      appending("labels", false),
    );
    const outgoingList = piece.key("list").resolveAsCell();
    const outgoingAdd = piece.key("add").resolveAsCell();
    const settle = holdWatcherSetup(piece.getAsNormalizedFullLink().id);
    const runner = runtime.runner;
    const consult = runner.pendingPatternChangeFor.bind(runner);
    runner.pendingPatternChangeFor = (pieces) => {
      const change = consult(pieces);
      if (change !== undefined) settle.resolve();
      return change;
    };
    const watch = outgoingList.sink((list) => {
      if (Array.isArray(list) && list.length > 1) settle.resolve();
    });
    try {
      const move = runtime.edit();
      piece.withTx(move).setMetaRaw(
        "patternIdentity",
        v2Ref,
        rawMetaWriteAuthorization,
      );
      expect((await move.commit().settled).error).toBeUndefined();
      outgoingAdd.send({ add: "during" });
      outgoingAdd.send({ add: "after" });
      await settle.promise;
      await runtime.idle();
    } finally {
      runtime.prepareTxForCommit = prepare;
      runner.pendingPatternChangeFor = consult;
      watch();
    }

    expect(await outgoingList.pull()).toEqual(["before"]);
    expect(await piece.key("list").pull()).toEqual([]);
    cancel();
  });

  it("resolves `patternPointerFollowed()` only once the incoming pattern's setup settles", async () => {
    const { piece, v2Ref, cancel } = await runAppending();
    const settle = holdWatcherSetup(piece.getAsNormalizedFullLink().id);
    let released = false;
    try {
      const move = runtime.edit();
      piece.withTx(move).setMetaRaw(
        "patternIdentity",
        v2Ref,
        rawMetaWriteAuthorization,
      );
      expect((await move.commit().settled).error).toBeUndefined();
      await runtime.idle();
      const followed = runtime.runner.patternPointerFollowed(piece).then(() =>
        released
      );
      await runtime.idle();
      released = true;
      settle.resolve();
      expect(await followed).toBe(true);
    } finally {
      runtime.prepareTxForCommit = prepare;
    }

    piece.key("add").send({ add: "after" });
    await runtime.idle();
    expect(await piece.key("list").pull()).toEqual(["after"]);
    cancel();
  });

  it("delivers a held event to the outgoing pattern's handler when its piece stops", async () => {
    // Stopping the piece ends the wait without a swap, so the event keeps the
    // handler it was queued with, as an event for a stopped piece does.
    const { piece, v2Ref, cancel } = await runAppending();
    const outgoingList = piece.key("list").resolveAsCell();
    const outgoingAdd = piece.key("add").resolveAsCell();
    const settle = holdWatcherSetup(piece.getAsNormalizedFullLink().id);
    const { held, restore } = whenHeld();
    try {
      const move = runtime.edit();
      piece.withTx(move).setMetaRaw(
        "patternIdentity",
        v2Ref,
        rawMetaWriteAuthorization,
      );
      expect((await move.commit().settled).error).toBeUndefined();
      outgoingAdd.send({ add: "queued" });
      await held;
      runtime.runner.stop(piece);
      await runtime.idle();
      expect(await outgoingList.pull()).toEqual(["before", "queued"]);
    } finally {
      settle.resolve();
      restore();
      runtime.prepareTxForCommit = prepare;
    }
    cancel();
  });

  it("ends a held event's wait when its origin's commit is refused", async () => {
    // The origin commits locally and its server verdict is held, so the event
    // it sends is queued under a pending same-space origin and reaches the
    // hold. Refusing the origin drops the event while the swap's setup is
    // still held, and the drop has to end the wait for `idle()` to resolve.
    const { piece, v2Ref, cancel } = await runAppending();
    const outgoingList = piece.key("list").resolveAsCell();
    const outgoingAdd = piece.key("add").resolveAsCell();
    const settle = holdWatcherSetup(piece.getAsNormalizedFullLink().id);
    const { held, restore } = whenHeld();
    const transact = server.transact.bind(server);
    try {
      const move = runtime.edit();
      piece.withTx(move).setMetaRaw(
        "patternIdentity",
        v2Ref,
        rawMetaWriteAuthorization,
      );
      expect((await move.commit().settled).error).toBeUndefined();

      const verdict = Promise.withResolvers<void>();
      const reached = Promise.withResolvers<void>();
      server.transact = async (...args) => {
        server.transact = transact;
        reached.resolve();
        await verdict.promise;
        const [message, publishVerdict] = args;
        const response = {
          type: "response" as const,
          requestId: message.requestId,
          error: {
            name: "ConflictError",
            message: "refuse the origin",
          },
        };
        publishVerdict?.(response as never);
        return response as never;
      };
      const origin = runtime.edit();
      runtime.getCell<number>(space, "swap-verdict-origin").withTx(origin)
        .set(1);
      outgoingAdd.withTx(origin).send({ add: "orphan" });
      runtime.prepareTxForCommit(origin);
      const committed = origin.commit();
      await reached.promise;
      await held;
      verdict.resolve();
      expect((await committed.settled).error).toBeDefined();
      await runtime.idle();
      expect(await outgoingList.pull()).toEqual(["before"]);
    } finally {
      server.transact = transact;
      settle.resolve();
      restore();
      runtime.prepareTxForCommit = prepare;
    }
    cancel();
  });

  it("ends a held event's wait when the runtime is disposed keeping its storage", async () => {
    // The swap's setup never settles while the runtime is disposed, so only
    // the disposal can end the event's wait.
    const { piece, v2Ref, cancel } = await runAppending();
    const outgoingAdd = piece.key("add").resolveAsCell();
    const settle = holdWatcherSetup(piece.getAsNormalizedFullLink().id);
    const { held, restore } = whenHeld();
    try {
      const move = runtime.edit();
      piece.withTx(move).setMetaRaw(
        "patternIdentity",
        v2Ref,
        rawMetaWriteAuthorization,
      );
      expect((await move.commit().settled).error).toBeUndefined();
      outgoingAdd.send({ add: "queued" });
      await held;
      cancel();
      await runtime.dispose({ closeStorage: false });
      disposedKeepingStorage = true;
    } finally {
      settle.resolve();
      restore();
    }
  });
});
