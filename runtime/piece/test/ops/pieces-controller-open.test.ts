import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { createSession, Identity } from "@commonfabric/identity";
import type * as MemoryV2Server from "@commonfabric/memory/v2/server";
import {
  type Cell,
  resolveEntryIdentity,
  Runtime,
  type RuntimeProgram,
  systemPatternSource,
} from "@commonfabric/runner";
import { rawMetaWriteAuthorization } from "@commonfabric/runner/meta-seam";
import {
  EmulatedStorageManager,
  newLoopbackServer,
} from "@commonfabric/runner/storage/cache.deno";
import { defer } from "@commonfabric/utils/defer";

import type { PieceController } from "../../src/ops/piece-controller.ts";
import { PiecesController } from "../../src/ops/pieces-controller.ts";

const signer = await Identity.fromPassphrase("pieces-controller open");

const markerSource = (marker: string) =>
  [
    "import { pattern } from 'commonfabric';",
    "export default pattern<Record<string, never>, { marker: string }>(() => {",
    `  return { marker: '${marker}' };`,
    "});",
    "",
  ].join("\n");

const programOf = (contents: string): RuntimeProgram => ({
  main: "/main.tsx",
  files: [{ name: "/main.tsx", contents }],
});

// A pattern the toolshed serves, and the release after it, which adds a
// handler and so a stream only its own graph registers a handler for.
const followedOrigin = systemPatternSource("system/open-follows.tsx");
const followedRoute = "/api/patterns/system/open-follows.tsx";
const COUNTER = [
  "import { pattern, Writable } from 'commonfabric';",
  "export default pattern<Record<string, never>>(() => {",
  "  const count = new Writable(0).for('count');",
  "  return { count };",
  "});",
  "",
].join("\n");
const COUNTER_WITH_HANDLER = [
  "import { handler, pattern, Writable } from 'commonfabric';",
  "const bump = handler<void, { count: Writable<number> }>((_, { count }) => {",
  "  count.set(count.get() + 1);",
  "});",
  "export default pattern<Record<string, never>>(() => {",
  "  const count = new Writable(0).for('count');",
  "  return { count, bump: bump({ count }) };",
  "});",
  "",
].join("\n");

describe("pieces-controller", () => {
  // A case that needs a follow in flight moves a running piece's pointer to a
  // pattern its runtime has never evaluated, so the watcher loads it from the
  // store and names what it reads before it swaps. The naming step is held
  // open through the runner's `dependencySyncer` test seam, which keeps the
  // follow in flight for as long as the case needs it to be.

  let server: MemoryV2Server.Server;
  let storageManager: EmulatedStorageManager;
  let runtime: Runtime;
  let controller: PiecesController;
  // What the toolshed route serves. A case replaces it to publish a release.
  let served: string;
  // Releases a naming step a case held open, so teardown can settle the
  // watcher chain even when an assertion failed before the case released it.
  let releaseHeld: (() => void) | undefined;

  beforeEach(async () => {
    served = COUNTER;
    server = newLoopbackServer();
    storageManager = EmulatedStorageManager.connectTo(server, { as: signer });
    runtime = new Runtime({
      apiUrl: new URL("https://open.test"),
      storageManager,
      fetch: async (input) => {
        const url = new URL(input instanceof Request ? input.url : input);
        if (url.pathname !== followedRoute) {
          return new Response("not found", { status: 404 });
        }
        return new Response(
          url.searchParams.has("identity")
            ? await resolveEntryIdentity(
              followedRoute,
              () => Promise.resolve(served),
            )
            : served,
        );
      },
    });
    controller = new PiecesController(
      createSession({
        identity: signer,
        spaceDid: await runtime.createSpace(),
      }),
      runtime,
    );
    await controller.synced();
  });

  afterEach(async () => {
    runtime.runner.accessForTestingOnly.dependencySyncer = undefined;
    releaseHeld?.();
    releaseHeld = undefined;
    await runtime.runner.idlePointerMaintenance();
    await runtime.dispose();
    await storageManager.close();
    await server.close();
  });

  const runMarker = (marker: string): Promise<PieceController> =>
    controller.create(programOf(markerSource(marker)));

  // The pattern is compiled and persisted by a runtime of its own, through a
  // replica of its own, so `runtime` has never evaluated it.
  const persistMarker = async (marker: string): Promise<string> => {
    const otherManager = EmulatedStorageManager.connectTo(server, {
      as: signer,
    });
    const other = new Runtime({
      apiUrl: new URL("https://open.test"),
      storageManager: otherManager,
    });
    try {
      const tx = other.edit();
      const pattern = await other.patternManager.compilePattern(
        programOf(markerSource(marker)),
        { space: controller.getSpace(), tx },
      );
      const identity =
        other.patternManager.getArtifactEntryRef(pattern)!.identity;
      other.prepareTxForCommit(tx);
      expect((await tx.commit().settled).error).toBeUndefined();
      await other.idle();
      await other.patternManager.flushCompileCacheWrites();
      await other.storageManager.synced();
      return identity;
    } finally {
      await other.dispose();
      await otherManager.close();
    }
  };

  // Holds the next naming step open. `entered` resolves once the step has
  // been entered, and `release` lets it proceed.
  const holdNextNaming = () => {
    const released = defer();
    const entered = defer();
    let held = false;
    runtime.runner.accessForTestingOnly.dependencySyncer = async (
      target,
      pattern,
      inputs,
      sync,
    ) => {
      if (held) return sync(target, pattern, inputs);
      held = true;
      entered.resolve();
      await released.promise;
      return sync(target, pattern, inputs);
    };
    releaseHeld = released.resolve;
    return { entered: entered.promise, release: released.resolve };
  };

  // Moves the pointer, lets the watcher observe the move, and returns once
  // the watcher's follow has reached the held naming step.
  const repointAndHold = async (
    cell: Cell<unknown>,
    identity: string,
  ): Promise<() => void> => {
    const hold = holdNextNaming();
    const tx = runtime.edit();
    cell.withTx(tx).setMetaRaw("patternIdentity", {
      identity,
      symbol: "default",
    }, rawMetaWriteAuthorization);
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit().settled).error).toBeUndefined();
    await runtime.idle();
    await hold.entered;
    return hold.release;
  };

  // Whether `promise` has settled, read through a flag its settlement sets.
  const settlementOf = <T>(promise: Promise<T>) => {
    const state = { settled: false, promise };
    const settle = () => {
      state.settled = true;
    };
    promise.then(settle, settle);
    return state;
  };

  // Opens a running piece whose pointer moved to a pattern the watcher is
  // still naming, and checks that `open` resolves only once it has swapped.
  //
  // The barrier is the same `open` of a second piece, whose pointer has not
  // moved, begun after the open under test. It takes every step that open
  // takes, so once it has resolved, an open that did not wait for the follow
  // would have resolved as well. It is also the control: it resolves while
  // the first piece's follow is held, so what keeps the open under test
  // pending is that follow.
  const expectOpenWaitsForFollow = async (
    open: (cell: Cell<unknown>) => Promise<unknown>,
  ): Promise<void> => {
    const incoming = await persistMarker("v2");
    const moved = await runMarker("v1");
    const unmoved = await runMarker("v1");
    const release = await repointAndHold(moved.getCell(), incoming);

    const opened = settlementOf(open(moved.getCell()));
    await open(unmoved.getCell());
    expect(opened.settled).toBe(false);
    expect(await moved.result.get(["marker"])).toBe("v1");

    release();
    await opened.promise;
    expect(await moved.result.get(["marker"])).toBe("v2");
  };

  // Follows `followedOrigin` on the release without a handler, running.
  const runFollowed = (): Promise<PieceController> =>
    controller.create({
      main: followedRoute,
      files: [{ name: followedRoute, contents: COUNTER }],
    }, { origin: followedOrigin });

  // Sends one event to the stream the later release adds, and returns the
  // count its handler increments. An event no handler is registered for is
  // dropped, which leaves the count at zero.
  const countAfterBump = async (piece: PieceController): Promise<unknown> => {
    (await piece.result.getCell()).key("bump").send(undefined);
    await runtime.idle();
    return await piece.result.get(["count"]);
  };

  describe("PiecesController", () => {
    describe("instance members", () => {
      describe("openPiece()", () => {
        it("resolves only once the watcher has swapped in the pattern the pointer moved to", async () => {
          await expectOpenWaitsForFollow((cell) => controller.openPiece(cell));
        });

        it("leaves a running piece handling the stream its own reconcile adopted", async () => {
          // This pins where the open's own reconcile leaves the piece, through
          // a real origin. It does not show that the open waited: the watcher
          // swaps in the pass that observes the move when it owes no read
          // from storage, and `countAfterBump()` idles the runtime itself.

          const piece = await runFollowed();
          served = COUNTER_WITH_HANDLER;

          await controller.openPiece(piece.getCell());

          expect(await countAfterBump(piece)).toBe(1);
        });
      });

      describe("getPieceCell()", () => {
        it("resolves only once the watcher has swapped in the pattern the pointer moved to, for an open that reconciles and starts", async () => {
          await expectOpenWaitsForFollow((cell) =>
            controller.getPieceCell(cell, true)
          );
        });

        it("resolves only once the watcher has swapped in the pattern the pointer moved to, for an open that reconciles without starting", async () => {
          await expectOpenWaitsForFollow((cell) =>
            controller.getPieceCell(cell, { reconcile: true, start: false })
          );
        });

        it("leaves a running piece handling the stream its own reconcile adopted", async () => {
          // This pins where the open's own reconcile leaves the piece, through
          // a real origin. It does not show that the open waited: the watcher
          // swaps in the pass that observes the move when it owes no read
          // from storage, and `countAfterBump()` idles the runtime itself.

          const piece = await runFollowed();
          served = COUNTER_WITH_HANDLER;

          await controller.getPieceCell(piece.getCell(), true);

          expect(await countAfterBump(piece)).toBe(1);
        });
      });
    });
  });
});
