import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { spy, stub } from "@std/testing/mock";

import { taggedHashStringOf } from "@commonfabric/data-model";
import { createSession, Identity } from "@commonfabric/identity";
import { type Cell, isCell, Runtime } from "@commonfabric/runner";
import { viewPieceSchema } from "@commonfabric/runner/schemas";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import { createBuilder } from "../../runner/src/builder/factory.ts";
import { patchableCell } from "../../runner/test/support/patchable-cell.ts";
import { PiecesController } from "../src/ops/pieces-controller.ts";
import { pieceId } from "../src/piece-id.ts";

const signer = await Identity.fromPassphrase("piece address form tests");

describe("piece address forms", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let pieces: PiecesController;

  beforeEach(async () => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    const session = createSession({
      identity: signer,
      spaceDid: await runtime.createSpace(),
    });
    pieces = new PiecesController(session, runtime);
    await pieces.synced();
  });

  afterEach(async () => {
    await runtime?.dispose({ closeStorage: false });
    await storageManager?.close();
  });

  async function createPiece(cause: string) {
    const { commonfabric } = createBuilder();
    const piecePattern = commonfabric.pattern<{ value: number }>((
      { value },
    ) => ({ value }));
    return await pieces.runPersistent(piecePattern, { value: 1 }, cause);
  }

  it("resolves one piece through its bare hash and through its `of:` URI", async () => {
    const piece = await createPiece("address-forms-target");
    const id = pieceId(piece)!;

    const viaHash = await pieces.getPieceCell(id);
    const viaUri = await pieces.getPieceCell(`of:${id}`);

    expect(pieceId(viaUri)).toBe(id);
    expect(viaUri.equals(viaHash)).toBe(true);
    expect(viaUri.get()).toEqual(viaHash.get());
  });

  it("throws for a `computed:` address, naming the address it was given", async () => {
    // The `of:` id over the same hash is a DIFFERENT entity, so the scheme
    // cannot be dropped to reach a piece — the address is refused instead.
    const piece = await createPiece("address-forms-computed");
    const id = pieceId(piece)!;

    await expect(pieces.getPieceCell(`computed:${id}`)).rejects.toThrow(
      `Kinded entity id \`computed:${id}\``,
    );
  });

  it("enables view replication in the space addressed by a Cell", async () => {
    const viewer = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      clientClass: "web",
      experimental: { serverExecution: true, viewScopedReplication: true },
    });
    try {
      const session = createSession({
        identity: signer,
        spaceDid: await runtime.createSpace(),
      });
      const controller = new PiecesController(session, viewer);
      const remote = viewer.getCell(
        pieces.getSpace(),
        "other-space-piece",
        undefined,
      );
      const local = viewer.getCell(
        controller.getSpace(),
        "local-piece",
        undefined,
      );
      const calls: string[] = [];
      using _enabling = stub(viewer.viewReplication, "enable", (space) => {
        calls.push(space);
        return Promise.resolve(false);
      });
      await viewer.editWithRetry((tx) => {
        remote.withTx(tx).set({ $NAME: "Remote" });
        local.withTx(tx).set({ $NAME: "Local" });
      });
      await controller.getPieceCell(remote, { start: false, reconcile: false });
      expect(calls).toEqual([remote.space]);
      calls.length = 0;
      await controller.getPieceCell(local.getAsNormalizedFullLink().id, {
        start: false,
        reconcile: false,
      });
      expect(calls).toEqual([controller.getSpace()]);
    } finally {
      await viewer.dispose({ closeStorage: false });
    }
  });

  it("starts a view piece by synchronizing its UI tip without executing the graph", async () => {
    const viewer = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      clientClass: "web",
      experimental: { serverExecution: true, viewScopedReplication: true },
    });
    try {
      const session = createSession({
        identity: signer,
        spaceDid: await runtime.createSpace(),
      });
      const controller = new PiecesController(session, viewer);
      const remote = patchableCell(viewer.getCell(
        pieces.getSpace(),
        "view-start-piece",
        undefined,
      ));
      await viewer.editWithRetry((tx) => {
        remote.withTx(tx).set({ $NAME: "Server output", $UI: "Rendered UI" });
      });
      using enabling = stub(
        viewer.viewReplication,
        "enable",
        () => Promise.resolve(true),
      );
      using starting = spy(viewer, "start");
      using projecting = spy(remote, "asSchema");
      await controller.startPiece(remote);
      expect(enabling.calls.map((call) => call.args)).toEqual([[remote.space]]);
      expect(starting.calls).toHaveLength(0);
      expect(projecting.calls.map((call) => call.args)).toEqual([[
        viewPieceSchema,
      ]]);
      const syncError = new Error("UI tip synchronization failed");
      {
        using syncing = stub(
          storageManager,
          "syncCell",
          () => Promise.reject(syncError),
        );
        await expect(controller.startPiece(remote)).rejects.toBe(syncError);
        expect(syncing.calls).toHaveLength(1);
        expect(syncing.calls[0].args[0]).toBe(projecting.calls[1].returned);
      }
      const tip = projecting.calls[0].returned?.asSchema<{
        $NAME: string;
        $UI: Cell<unknown>;
      }>(viewPieceSchema).get();
      expect(tip?.$NAME).toBe("Server output");
      expect(isCell(tip?.$UI)).toBe(true);
      if (!isCell(tip?.$UI)) throw new Error("Expected an opaque UI Cell");
      expect(tip.$UI.getAsNormalizedFullLink().path).toEqual(["$UI"]);
      expect(tip.$UI.asSchema<string>({ type: "string" }).get()).toBe(
        "Rendered UI",
      );
    } finally {
      await viewer.dispose({ closeStorage: false });
    }
  });

  describe("link()", () => {
    function plainCell(cause: string) {
      return runtime.getCellFromLink({
        id: `of:${taggedHashStringOf(cause)}`,
        path: [],
        space: pieces.getSpace(),
      });
    }

    it("links into a piece named by its `of:` URI", async () => {
      const source = plainCell("address-forms-link-piece-source");
      const target = await createPiece("address-forms-link-piece-target");
      const targetId = pieceId(target)!;
      await runtime.editWithRetry((tx) => {
        source.withTx(tx).set({ value: 9 });
      });
      await runtime.idle();

      await pieces.link(
        source.getAsNormalizedFullLink().id,
        ["value"],
        `of:${targetId}`,
        ["value"],
      );
      await runtime.idle();

      // The link landed in the piece's argument, so the piece's own result
      // reports the source's value.
      expect(pieces.getResult(target).key("value").get()).toBe(9);
    });

    /** Stands the piece registry up over `entries` for one test. */
    function registryOf(entries: Cell<unknown>[]) {
      pieces.getPieceRegistry = () =>
        Promise.resolve(
          { get: () => entries } as unknown as Awaited<
            ReturnType<typeof pieces.getPieceRegistry>
          >,
        );
    }

    it("links into a plain cell named by its `of:` URI", async () => {
      // A plain cell has no pattern to start, so the target resolves through
      // the arbitrary-cell path — the one that asks the piece registry
      // whether the address names a piece. A registry entry is what makes
      // that question reach a comparison: over an empty registry it is
      // answered without looking at an id at all.
      registryOf([await createPiece("address-forms-link-registered")]);
      const source = plainCell("address-forms-link-cell-source");
      const target = plainCell("address-forms-link-cell-target");
      await runtime.editWithRetry((tx) => {
        source.withTx(tx).set({ data: "linked value" });
        target.withTx(tx).set({ linked: null });
      });
      await runtime.idle();

      await pieces.link(
        source.getAsNormalizedFullLink().id,
        ["data"],
        target.getAsNormalizedFullLink().id,
        ["linked"],
      );

      expect(target.key("linked").get()).toBe("linked value");
    });

    it("takes an `of:` address registered as a piece for the piece it names", async () => {
      // The registry reports each entry's id as the bare tagged hash, so an
      // `of:` address reaches a match only against that one spelling. A
      // matched target is written through a piece's argument cell, and the
      // registered cell here has none — which is how the match, rather than
      // the plain-cell write above, shows in what comes back.
      const source = plainCell("address-forms-registered-uri-source");
      const target = plainCell("address-forms-registered-uri-target");
      await runtime.editWithRetry((tx) => {
        source.withTx(tx).set({ data: "linked value" });
        target.withTx(tx).set({ linked: null });
      });
      await runtime.idle();
      registryOf([target]);

      // The failure arrives as the transaction's own error value rather than
      // as a thrown `Error`, so it is read from the rejection directly.
      const failure = await pieces.link(
        source.getAsNormalizedFullLink().id,
        ["data"],
        target.getAsNormalizedFullLink().id,
        ["linked"],
      ).then(() => undefined, (error: unknown) => error);

      expect((failure as { message?: string } | undefined)?.message).toContain(
        "Target piece has no argument cell",
      );
    });

    it("refuses a `computed:` target, naming the address it was given", async () => {
      const source = plainCell("address-forms-link-computed-source");
      const targetId = taggedHashStringOf("address-forms-link-computed-target");
      await runtime.editWithRetry((tx) => {
        source.withTx(tx).set({ data: "linked value" });
      });
      await runtime.idle();

      // The refusal reaches the caller: an address this seam cannot resolve
      // is a different report from a target that was looked for and missing.
      await expect(
        pieces.link(
          source.getAsNormalizedFullLink().id,
          ["data"],
          `computed:${targetId}`,
          ["linked"],
        ),
      ).rejects.toThrow(`Kinded entity id \`computed:${targetId}\``);
    });
  });
});
