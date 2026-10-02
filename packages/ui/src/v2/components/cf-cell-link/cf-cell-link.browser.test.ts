/**
 * Native DOM lifecycle checks for a `cf-cell-link` bound to a cell holding a
 * link. Lit runs unchanged; only the link's resolution and its subscription
 * are controlled.
 */

import { expect } from "@std/expect";
import type { CellHandle, CellRef } from "@commonfabric/runtime-client";
import { createMockCellHandle } from "../../test-utils/mock-cell-handle.ts";
import type { CFCellLink } from "./index.ts";
// The entrypoint registers cf-cell-link in the browser.
import "./index.ts";

/** A cell standing in for one room, with id `id`. */
function roomCell(id: string): CellHandle {
  return createMockCellHandle({}, {
    id: id as CellRef["id"],
    space: "did:key:test-space" as CellRef["space"],
  }) as CellHandle;
}

/**
 * A link whose target the test moves with `publish()`. It counts the
 * subscriptions taken on it and released, and `nextSubscribe()` returns a
 * promise settled by the next one taken.
 */
function retargetableLink(initialTarget: CellHandle) {
  const link = createMockCellHandle({}, {
    id: "of:fid1:row-holder" as CellRef["id"],
    space: "did:key:test-space" as CellRef["space"],
    path: ["rooms", "0", "room"],
  }) as CellHandle;
  let currentTarget = initialTarget;
  const callbacks = new Set<(value: CellHandle) => void>();
  const counts = { subscribed: 0, unsubscribed: 0 };
  let subscribed = Promise.withResolvers<void>();
  link.resolveAsCell = () => Promise.resolve(currentTarget);
  Object.defineProperty(link, "asSchema", {
    value: () => ({
      sync: () => Promise.resolve(currentTarget),
      subscribe(callback: (value: CellHandle) => void) {
        callback(currentTarget);
        callbacks.add(callback);
        counts.subscribed++;
        subscribed.resolve();
        return () => {
          callbacks.delete(callback);
          counts.unsubscribed++;
        };
      },
    }),
  });
  return {
    link,
    counts,
    nextSubscribe() {
      subscribed = Promise.withResolvers<void>();
      return subscribed.promise;
    },
    publish(value: CellHandle) {
      currentTarget = value;
      for (const callback of [...callbacks]) callback(value);
    },
  };
}

/** The piece id a click on `element`'s pill navigates to. */
function clickedPieceId(element: CFCellLink): string | undefined {
  let pieceId: string | undefined;
  const listener = (event: Event) =>
    pieceId = (event as CustomEvent).detail.pieceId;
  globalThis.addEventListener("cf-navigate", listener);
  try {
    (element.shadowRoot!.querySelector("cf-chip") as HTMLElement).click();
  } finally {
    globalThis.removeEventListener("cf-navigate", listener);
  }
  return pieceId;
}

Deno.test("cf-cell-link releases a link's subscription when detached and follows the link again when reattached", async () => {
  const view = retargetableLink(roomCell("of:fid1:first"));
  const element = document.createElement("cf-cell-link") as CFCellLink;
  const container = document.createElement("div");
  document.body.append(container);
  try {
    const firstSubscribe = view.nextSubscribe();
    element.cell = view.link;
    container.append(element);
    await firstSubscribe;
    await element.updateComplete;
    expect(view.counts).toEqual({ subscribed: 1, unsubscribed: 0 });

    element.remove();
    expect(view.counts).toEqual({ subscribed: 1, unsubscribed: 1 });

    const secondSubscribe = view.nextSubscribe();
    container.append(element);
    await secondSubscribe;
    view.publish(roomCell("of:fid1:second"));
    await element.updateComplete;
    expect(view.counts).toEqual({ subscribed: 2, unsubscribed: 1 });
    expect(clickedPieceId(element)).toBe("of:fid1:second");
  } finally {
    container.remove();
  }
});
