import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import type { CellHandle, CellRef } from "@commonfabric/runtime-client";

import { createMockCellHandle } from "../test-utils/mock-cell-handle.ts";
import { LinkTargetWatch } from "./link-target-watch.ts";

/** A cell standing in for one piece, with id `id`. */
function pieceCell(id: string): CellHandle {
  return createMockCellHandle({}, {
    id: id as CellRef["id"],
    space: "did:key:test-space" as CellRef["space"],
  }) as CellHandle;
}

/**
 * A cell holding a link to `target`, counting the subscriptions taken on it.
 * `beforeSync` runs as each synchronization of the link is answered.
 */
function linkTo(target: CellHandle, beforeSync: () => void = () => {}) {
  const link = createMockCellHandle({}, {
    id: "of:fid1:link-holder" as CellRef["id"],
    space: "did:key:test-space" as CellRef["space"],
    path: ["piece"],
  }) as CellHandle;
  const counts = { subscribed: 0 };
  Object.defineProperty(link, "asSchema", {
    value: () => ({
      sync: () => {
        beforeSync();
        return Promise.resolve(target);
      },
      subscribe(callback: (value: CellHandle) => void) {
        callback(target);
        counts.subscribed++;
        return () => {};
      },
    }),
  });
  return { link, counts };
}

describe("LinkTargetWatch", () => {
  describe("instance members", () => {
    describe("watch()", () => {
      it("subscribes on a later watch of a cell that stopped being current during its first setup", async () => {
        const target = pieceCell("of:fid1:piece");
        let current = true;
        let syncs = 0;
        const { link, counts } = linkTo(target, () => {
          syncs++;
          if (syncs === 1) current = false;
        });
        const watch = new LinkTargetWatch({
          isCurrent: () => current,
          onRetarget: () => {},
        });

        expect(await watch.watch(link, target)).toBeUndefined();
        expect(counts.subscribed).toBe(0);

        current = true;
        expect(await watch.watch(link, target)).toBe(target);
        expect(counts.subscribed).toBe(1);
        watch.cancel();
      });

      it("reports no target once the worker refuses the link", async () => {
        const target = pieceCell("of:fid1:piece");
        const link = createMockCellHandle({}, {
          id: "of:fid1:link-holder" as CellRef["id"],
          space: "did:key:test-space" as CellRef["space"],
          path: ["piece"],
        }) as CellHandle;
        let refuse = () => {};
        Object.defineProperty(link, "asSchema", {
          value: () => ({
            sync: () => Promise.resolve(target),
            subscribe(
              callback: (value: CellHandle) => void,
              options: { onRefused: () => void },
            ) {
              callback(target);
              refuse = options.onRefused;
              return () => {};
            },
          }),
        });
        const retargets: Array<CellHandle | undefined> = [];
        const watch = new LinkTargetWatch({
          isCurrent: () => true,
          onRetarget: (next) => retargets.push(next),
        });
        expect(await watch.watch(link, target)).toBe(target);

        refuse();

        expect(retargets).toEqual([undefined]);
        watch.cancel();
      });

      it("answers a second watch of a cell from the setup still in flight", async () => {
        const target = pieceCell("of:fid1:piece");
        const { link, counts } = linkTo(target);
        const watch = new LinkTargetWatch({ onRetarget: () => {} });

        const [first, second] = await Promise.all([
          watch.watch(link, target),
          watch.watch(link, target),
        ]);

        expect([first, second]).toEqual([target, target]);
        expect(counts.subscribed).toBe(1);
        watch.cancel();
      });

      it("rethrows a failed synchronization and follows nothing", async () => {
        const target = pieceCell("of:fid1:piece");
        const failure = new Error("unreadable");
        const { link } = linkTo(target, () => {
          throw failure;
        });
        const watch = new LinkTargetWatch({ onRetarget: () => {} });

        await expect(watch.watch(link, target)).rejects.toBe(failure);
        expect(watch.accessForTestingOnly.unsubscribe).toBeUndefined();
      });
    });

    describe("follow()", () => {
      it("returns `undefined` once superseded while resolving the moved link again", async () => {
        const first = pieceCell("of:fid1:first");
        const moved = pieceCell("of:fid1:moved");
        const { link } = linkTo(moved);
        let resolutions = 0;
        let superseded = false;
        Object.defineProperty(link, "resolveAsCell", {
          value: () => {
            resolutions++;
            if (resolutions === 2) superseded = true;
            return Promise.resolve(resolutions === 1 ? first : moved);
          },
        });
        const watch = new LinkTargetWatch({ onRetarget: () => {} });

        expect(await watch.follow(link, () => superseded)).toBeUndefined();
        expect(resolutions).toBe(2);
        watch.cancel();
      });
    });

    describe("cancel()", () => {
      it("drops the subscription a watch took", async () => {
        const target = pieceCell("of:fid1:piece");
        const { link } = linkTo(target);
        const watch = new LinkTargetWatch({ onRetarget: () => {} });
        await watch.watch(link, target);
        expect(watch.accessForTestingOnly.unsubscribe).toBeDefined();

        watch.cancel();

        expect(watch.accessForTestingOnly.unsubscribe).toBeUndefined();
      });
    });
  });
});
