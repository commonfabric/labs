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
 * A cell holding a link to `target`, counting the subscriptions taken on it
 * and those torn down.
 * `beforeSync` runs as each synchronization of the link is answered.
 * `deliver()` reports another target to every subscription ever taken, torn
 * down or not, as a report already in flight from the worker would reach it.
 */
function linkTo(target: CellHandle, beforeSync: () => void = () => {}) {
  const link = createMockCellHandle({}, {
    id: "of:fid1:link-holder" as CellRef["id"],
    space: "did:key:test-space" as CellRef["space"],
    path: ["piece"],
  }) as CellHandle;
  const counts = { subscribed: 0, unsubscribed: 0 };
  const callbacks: Array<(value: CellHandle) => void> = [];
  Object.defineProperty(link, "asSchema", {
    value: () => ({
      sync: () => {
        beforeSync();
        return Promise.resolve(target);
      },
      subscribe(callback: (value: CellHandle) => void) {
        callback(target);
        callbacks.push(callback);
        counts.subscribed++;
        return () => counts.unsubscribed++;
      },
    }),
  });
  const deliver = (next: CellHandle) => {
    for (const callback of callbacks) callback(next);
  };
  return { link, counts, deliver };
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

      it("rethrows a failed synchronization, and subscribes on a later watch", async () => {
        const target = pieceCell("of:fid1:piece");
        const failure = new Error("unreadable");
        let failing = true;
        const { link, counts } = linkTo(target, () => {
          if (failing) throw failure;
        });
        const watch = new LinkTargetWatch({ onRetarget: () => {} });

        await expect(watch.watch(link, target)).rejects.toBe(failure);
        expect(counts.subscribed).toBe(0);

        failing = false;
        expect(await watch.watch(link, target)).toBe(target);
        expect(counts.subscribed).toBe(1);
        watch.cancel();
      });
      it("returns `undefined` for a watch cancelled while synchronizing, and subscribes to nothing", async () => {
        const target = pieceCell("of:fid1:piece");
        let cancel = () => {};
        const { link, counts } = linkTo(target, () => cancel());
        const watch = new LinkTargetWatch({ onRetarget: () => {} });
        cancel = () => watch.cancel();

        expect(await watch.watch(link, target)).toBeUndefined();
        expect(counts.subscribed).toBe(0);
      });

      it("reports no retarget that reaches it after `cancel()`", async () => {
        const target = pieceCell("of:fid1:piece");
        const { link, deliver } = linkTo(target);
        const retargets: Array<CellHandle | undefined> = [];
        const watch = new LinkTargetWatch({
          onRetarget: (next) => retargets.push(next),
        });
        await watch.watch(link, target);
        watch.cancel();

        deliver(pieceCell("of:fid1:moved"));

        expect(retargets).toEqual([]);
      });

      it("reports no retarget while its cell is not current", async () => {
        const target = pieceCell("of:fid1:piece");
        const { link, deliver } = linkTo(target);
        let current = true;
        const retargets: Array<CellHandle | undefined> = [];
        const watch = new LinkTargetWatch({
          isCurrent: () => current,
          onRetarget: (next) => retargets.push(next),
        });
        await watch.watch(link, target);
        current = false;

        deliver(pieceCell("of:fid1:moved"));

        expect(retargets).toEqual([]);
        watch.cancel();
      });

      it("tears down a subscription whose first report cancelled the watch", async () => {
        const target = pieceCell("of:fid1:piece");
        const moved = pieceCell("of:fid1:moved");
        const link = createMockCellHandle({}, {
          id: "of:fid1:link-holder" as CellRef["id"],
          space: "did:key:test-space" as CellRef["space"],
          path: ["piece"],
        }) as CellHandle;
        let unsubscribed = 0;
        Object.defineProperty(link, "asSchema", {
          value: () => ({
            sync: () => Promise.resolve(target),
            subscribe(callback: (value: CellHandle) => void) {
              callback(moved);
              return () => unsubscribed++;
            },
          }),
        });
        const watch = new LinkTargetWatch({
          onRetarget: () => watch.cancel(),
        });

        expect(await watch.watch(link, target)).toBe(moved);
        expect(unsubscribed).toBe(1);
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
        const { link, counts } = linkTo(target);
        const watch = new LinkTargetWatch({ onRetarget: () => {} });
        await watch.watch(link, target);
        expect(watch.accessForTestingOnly.unsubscribe).toBeDefined();

        watch.cancel();

        expect(watch.accessForTestingOnly.unsubscribe).toBeUndefined();
        expect(counts.unsubscribed).toBe(1);
      });
    });
  });
});
