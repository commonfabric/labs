import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";

import type { CellHandle, CellRef } from "@commonfabric/runtime-client";

import { createMockCellHandle } from "../../test-utils/mock-cell-handle.ts";
import { AboutTarget } from "./about-target.ts";

/** A handle on its own cell, standing in for a piece. */
function piece(id: string): CellHandle {
  return createMockCellHandle<unknown>({}, {
    id: `of:${id}` as CellRef["id"],
  });
}

const here = piece("here");
const elsewhere = piece("elsewhere");

/**
 * A handle on the element of a `.map()`, a cell holding a link to `target`.
 * `publish()` moves the link to another thing, and `fail()` makes each later
 * resolution fail. Each resolution waits for `resolution`, and fails with
 * `failure` when one is given. `subscriptions()` counts the live
 * subscriptions on the link.
 */
function mapElementLinkingTo(
  target: CellHandle,
  { resolution = Promise.resolve(), failure, aborted = false }: {
    resolution?: Promise<void>;
    failure?: Error;
    aborted?: boolean;
  } = {},
) {
  const element = createMockCellHandle<unknown>({}, {
    id: "of:mapped-list" as CellRef["id"],
    path: ["element"],
  });
  let current = target;
  let failing = failure;
  const callbacks = new Set<(value: CellHandle) => void>();
  const signal = new AbortController();
  if (aborted) signal.abort();
  Object.assign(element, {
    resolveAsCell: () =>
      resolution.then(() => {
        if (failing) throw failing;
        return current;
      }),
    runtime: () => ({ signal: signal.signal }),
    asSchema: () => ({
      sync: () => Promise.resolve(current),
      subscribe(callback: (value: CellHandle) => void) {
        callback(current);
        callbacks.add(callback);
        return () => callbacks.delete(callback);
      },
    }),
  });
  const publish = (next: CellHandle) => {
    current = next;
    for (const callback of [...callbacks]) callback(next);
  };
  const fail = (error: Error) => {
    failing = error;
  };
  return { element, publish, fail, subscriptions: () => callbacks.size };
}

/** An `AboutTarget` whose owner is connected while `connected.value` is. */
function aboutTarget(connected = { value: true }) {
  const counts = { changes: 0 };
  const target = new AboutTarget({
    isConnected: () => connected.value,
    onChange: () => counts.changes++,
  });
  return { target, counts, connected };
}

describe("AboutTarget", () => {
  describe("instance members", () => {
    describe("resolve()", () => {
      it("sets `target` to the cell a map element links to", async () => {
        const { target, counts } = aboutTarget();
        target.resolve(mapElementLinkingTo(here).element);
        await target.resolution;
        expect(target.target?.equals(here)).toBe(true);
        expect(counts.changes).toBe(1);
        target.clear();
      });

      it("leaves `target` undefined until the link has resolved", async () => {
        const resolution = Promise.withResolvers<void>();
        const { target } = aboutTarget();
        target.resolve(
          mapElementLinkingTo(here, { resolution: resolution.promise })
            .element,
        );
        expect(target.target).toBeUndefined();
        resolution.resolve();
        await target.resolution;
        expect(target.target?.equals(here)).toBe(true);
        target.clear();
      });

      it("sets `target` to where the link moves", async () => {
        const { target } = aboutTarget();
        const { element, publish } = mapElementLinkingTo(here);
        target.resolve(element);
        await target.resolution;
        publish(elsewhere);
        expect(target.target).toBeUndefined();
        await target.resolution;
        expect(target.target?.equals(elsewhere)).toBe(true);
        target.clear();
      });

      it("keeps the later of two resolutions", async () => {
        const first = Promise.withResolvers<void>();
        const { target } = aboutTarget();
        target.resolve(
          mapElementLinkingTo(here, { resolution: first.promise }).element,
        );
        const stale = target.resolution;
        target.resolve(mapElementLinkingTo(elsewhere).element);
        await target.resolution;
        first.resolve();
        await stale;
        expect(target.target?.equals(elsewhere)).toBe(true);
        target.clear();
      });

      it("clears `target` for an `about` that is no cell", async () => {
        const { target, counts } = aboutTarget();
        const { element, subscriptions } = mapElementLinkingTo(here);
        target.resolve(element);
        await target.resolution;
        target.resolve(undefined);
        await target.resolution;
        expect(target.target).toBeUndefined();
        expect(counts.changes).toBe(2);
        expect(subscriptions()).toBe(0);
      });

      it("sets no `target` while the owner is disconnected", async () => {
        const { target } = aboutTarget({ value: false });
        target.resolve(mapElementLinkingTo(here).element);
        await target.resolution;
        expect(target.target).toBeUndefined();
      });

      it("logs a failed resolution and sets no `target`", async () => {
        const failure = new Error("unreadable");
        using error = stub(console, "error");
        const { target } = aboutTarget();
        target.resolve(mapElementLinkingTo(here, { failure }).element);
        await target.resolution;
        expect(target.target).toBeUndefined();
        expect(error.calls.map(({ args }) => args)).toEqual([
          ["Failed to resolve about:", failure],
        ]);
      });

      it("stops following a link whose resolution failed after it moved", async () => {
        const failure = new Error("unreadable");
        using error = stub(console, "error");
        const { target } = aboutTarget();
        const { element, publish, fail, subscriptions } = mapElementLinkingTo(
          here,
        );
        target.resolve(element);
        await target.resolution;
        fail(failure);
        publish(elsewhere);
        await target.resolution;
        expect(target.target).toBeUndefined();
        expect(subscriptions()).toBe(0);
        expect(error.calls.map(({ args }) => args)).toEqual([
          ["Failed to resolve about:", failure],
        ]);
      });

      it("logs nothing for a resolution its runtime's disposal cancelled", async () => {
        using error = stub(console, "error");
        const { target } = aboutTarget();
        target.resolve(
          mapElementLinkingTo(here, {
            failure: new Error("disposed"),
            aborted: true,
          }).element,
        );
        await target.resolution;
        expect(target.target).toBeUndefined();
        expect(error.calls).toEqual([]);
      });

      it("logs nothing for a failure a later resolution superseded", async () => {
        const first = Promise.withResolvers<void>();
        using error = stub(console, "error");
        const { target } = aboutTarget();
        target.resolve(
          mapElementLinkingTo(here, {
            resolution: first.promise,
            failure: new Error("stale"),
          }).element,
        );
        const stale = target.resolution;
        target.resolve(undefined);
        first.resolve();
        await stale;
        expect(error.calls).toEqual([]);
      });
    });

    describe("clear()", () => {
      it("drops `target` and ignores later moves of the link", async () => {
        const { target } = aboutTarget();
        const { element, publish } = mapElementLinkingTo(here);
        target.resolve(element);
        await target.resolution;
        target.clear();
        expect(target.target).toBeUndefined();
        publish(elsewhere);
        await target.resolution;
        expect(target.target).toBeUndefined();
      });

      it("drops a resolution still under way", async () => {
        const resolution = Promise.withResolvers<void>();
        const { target } = aboutTarget();
        target.resolve(
          mapElementLinkingTo(here, { resolution: resolution.promise })
            .element,
        );
        target.clear();
        resolution.resolve();
        await target.resolution;
        expect(target.target).toBeUndefined();
      });
    });
  });
});
