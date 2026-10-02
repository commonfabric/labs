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
    });
  });
});
