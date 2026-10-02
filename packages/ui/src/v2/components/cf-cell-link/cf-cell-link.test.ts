import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import type { CellHandle, CellRef } from "@commonfabric/runtime-client";

import { endDrag, getCurrentDrag, isDragging } from "../../core/drag-state.ts";
import { createMockCellHandle } from "../../test-utils/mock-cell-handle.ts";
import { installMockDocument } from "../../test-utils/mock-document.ts";
import { createRenderableCellHandle } from "../../test-utils/mock-vdom-connection.ts";
import { CFCellLink } from "./index.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function markConnected(element: CFCellLink, isConnected = true): void {
  Object.defineProperty(element, "isConnected", {
    configurable: true,
    value: isConnected,
  });
}

describe("CFCellLink", () => {
  it("navigates to the linked space and scope even inside a named space", () => {
    const element = new CFCellLink() as any;
    element.spaceName = "current-space";
    element._resolvedCell = {
      ref: () => ({
        space: "did:key:foreign",
        id: "of:fid1:same",
        scope: "user",
        path: [],
      }),
      space: () => "did:key:foreign",
      id: () => "of:fid1:same",
    };
    const seen: unknown[] = [];
    const listener = (event: Event) => seen.push((event as CustomEvent).detail);
    globalThis.addEventListener("cf-navigate", listener);
    try {
      element._handleClick({ stopPropagation() {} });
      expect(seen).toEqual([{
        spaceDid: "did:key:foreign",
        pieceId: "of:fid1:same",
        pieceScope: "user",
      }]);
    } finally {
      globalThis.removeEventListener("cf-navigate", listener);
    }
  });
  it("navigates to a nested view without losing its scoped target", () => {
    const element = new CFCellLink() as any;
    element.spaceName = "current-space";
    element._resolvedCell = {
      ref: () => ({
        space: "did:key:foreign",
        id: "of:fid1:same",
        scope: "user",
        path: ["view", "a/b"],
      }),
      space: () => "did:key:foreign",
      id: () => "of:fid1:same",
    };
    const seen: unknown[] = [];
    const listener = (event: Event) => seen.push((event as CustomEvent).detail);
    globalThis.addEventListener("cf-navigate", listener);
    try {
      element._handleClick({ stopPropagation() {} });
      expect(seen).toEqual([{
        spaceDid: "did:key:foreign",
        pieceId: "of:fid1:same",
        pieceScope: "user",
        piecePath: ["view", "a/b"],
      }]);
    } finally {
      globalThis.removeEventListener("cf-navigate", listener);
    }
  });
  it("should be defined", () => {
    expect(CFCellLink).toBeDefined();
  });

  it("should have customElement definition", () => {
    const definition = customElements.get("cf-cell-link");
    expect(definition).toBeDefined();
    expect(definition).toBe(CFCellLink);
  });

  it("should create element instance", () => {
    const element = new CFCellLink();
    expect(element).toBeInstanceOf(CFCellLink);
  });

  it("should have default properties", () => {
    const element = new CFCellLink();
    expect(element.link).toBeUndefined();
    expect(element.cell).toBeUndefined();
    expect(element.runtime).toBeUndefined();
    expect(element.space).toBeUndefined();
  });

  it("does not resubscribe when the resolved cell ref is unchanged", () => {
    const ref: CellRef = {
      id: "of:test-cell" as CellRef["id"],
      space: "did:key:test-space" as CellRef["space"],
      scope: "space",
      path: [],
      schema: { type: "object" },
    };
    let subscribeCount = 0;
    let unsubscribeCount = 0;
    const makeCell = (cellRef: CellRef) =>
      ({
        ref: () => cellRef,
        asSchema: () => ({
          subscribe: () => {
            subscribeCount++;
            return () => {
              unsubscribeCount++;
            };
          },
        }),
      }) as any;

    const element = new CFCellLink() as any;
    markConnected(element);
    element._resolvedCell = makeCell(ref);
    element._updateSubscription();
    element._updateSubscription();

    expect(subscribeCount).toBe(1);
    expect(unsubscribeCount).toBe(0);

    element._resolvedCell = makeCell({
      ...ref,
      id: "of:other-cell" as CellRef["id"],
    });
    element._updateSubscription();

    expect(subscribeCount).toBe(2);
    expect(unsubscribeCount).toBe(1);
  });

  it("resubscribes when the resolved handle changes with the same ref", () => {
    const ref: CellRef = {
      id: "of:test-cell" as CellRef["id"],
      space: "did:key:test-space" as CellRef["space"],
      scope: "space",
      path: [],
      schema: { type: "object" },
    };
    const activeSubscriptions = new Set<string>();
    let unsubscribeCount = 0;
    const makeCell = (label: string) =>
      ({
        ref: () => ref,
        asSchema: () => ({
          subscribe: () => {
            activeSubscriptions.add(label);
            return () => {
              activeSubscriptions.delete(label);
              unsubscribeCount++;
            };
          },
        }),
      }) as any;

    const element = new CFCellLink() as any;
    markConnected(element);
    element._setResolvedCell(makeCell("first"));
    element._updateSubscription();

    element._setResolvedCell(makeCell("second"));
    element._updateSubscription();

    expect(activeSubscriptions.has("first")).toBe(false);
    expect(activeSubscriptions.has("second")).toBe(true);
    expect(unsubscribeCount).toBe(1);
  });

  it("ignores stale async cell resolutions after a later cell is selected", async () => {
    const refA: CellRef = {
      id: "of:slow-cell" as CellRef["id"],
      space: "did:key:test-space" as CellRef["space"],
      scope: "space",
      path: [],
      schema: { type: "object" },
    };
    const refB: CellRef = {
      ...refA,
      id: "of:fast-cell" as CellRef["id"],
    };

    const activeSubscriptions = new Set<string>();
    const subscribeCounts = new Map<string, number>();
    const unsubscribeCounts = new Map<string, number>();
    const makeResolvedCell = (cellRef: CellRef) =>
      ({
        ref: () => cellRef,
        // Each cell here resolves to itself, so it holds no link to follow.
        equals: (other: { ref(): CellRef }) => other.ref().id === cellRef.id,
        asSchema: () => ({
          subscribe: () => {
            activeSubscriptions.add(cellRef.id);
            subscribeCounts.set(
              cellRef.id,
              (subscribeCounts.get(cellRef.id) ?? 0) + 1,
            );
            return () => {
              activeSubscriptions.delete(cellRef.id);
              unsubscribeCounts.set(
                cellRef.id,
                (unsubscribeCounts.get(cellRef.id) ?? 0) + 1,
              );
            };
          },
        }),
      }) as any;

    const slowResolution = deferred<any>();
    const slowCell = {
      ref: () => refA,
      resolveAsCell: () => slowResolution.promise,
    };
    const fastCell = {
      ref: () => refB,
      resolveAsCell: () => Promise.resolve(makeResolvedCell(refB)),
    };

    const element = new CFCellLink() as any;
    markConnected(element);
    element.cell = slowCell;
    const slowResolveStarted = element._resolveCell();

    element.cell = fastCell;
    await element._resolveCell();
    element._updateSubscription();

    expect(activeSubscriptions.has(refB.id)).toBe(true);
    expect(activeSubscriptions.has(refA.id)).toBe(false);

    slowResolution.resolve(makeResolvedCell(refA));
    await slowResolveStarted;
    element._updateSubscription();

    expect(subscribeCounts.get(refA.id) ?? 0).toBe(0);
    expect(unsubscribeCounts.get(refB.id) ?? 0).toBe(0);
    expect(activeSubscriptions.has(refB.id)).toBe(true);
    expect(activeSubscriptions.has(refA.id)).toBe(false);
  });

  describe("following a link's target", () => {
    // The `cell` property keeps its identity throughout, as a list row's does
    // when an entry is prepended above it and the row's link moves to a
    // different target.

    function roomCell(id: string): CellHandle {
      return createMockCellHandle({}, {
        id: id as CellRef["id"],
        space: "did:key:test-space" as CellRef["space"],
      }) as CellHandle;
    }

    /**
     * A link whose target the test moves with `publish()`, a promise settled
     * when something first subscribes to it, and a count of the subscriptions
     * taken on it and released. Each resolution waits for `resolution`.
     */
    function retargetableLink(
      initialTarget: CellHandle,
      { resolution = Promise.resolve() }: { resolution?: Promise<void> } = {},
    ) {
      const link = createMockCellHandle({}, {
        id: "of:fid1:row-holder" as CellRef["id"],
        space: "did:key:test-space" as CellRef["space"],
        path: ["rooms", "0", "room"],
      }) as CellHandle;
      let currentTarget = initialTarget;
      const callbacks = new Set<(value: CellHandle) => void>();
      const subscribed = deferred<void>();
      const counts = { subscribed: 0, unsubscribed: 0 };
      (link as unknown as { resolveAsCell(): Promise<CellHandle> })
        .resolveAsCell = () => resolution.then(() => currentTarget);
      (link as unknown as {
        asSchema(): {
          sync(): Promise<CellHandle>;
          subscribe(callback: (value: CellHandle) => void): () => void;
        };
      }).asSchema = () => ({
        sync: () => Promise.resolve(currentTarget),
        subscribe(callback) {
          callback(currentTarget);
          callbacks.add(callback);
          counts.subscribed++;
          subscribed.resolve();
          return () => {
            callbacks.delete(callback);
            counts.unsubscribed++;
          };
        },
      });
      const publish = (value: CellHandle) => {
        currentTarget = value;
        for (const callback of [...callbacks]) callback(value);
      };
      return { link, counts, publish, subscribed: subscribed.promise };
    }

    /** Disconnects `element`, giving it the slice of `document` that touches. */
    function disconnect(element: any): void {
      const globals = globalThis as { document?: unknown };
      const had = Object.hasOwn(globals, "document");
      const previous = globals.document;
      globals.document = { removeEventListener() {} };
      try {
        markConnected(element, false);
        element.disconnectedCallback();
      } finally {
        if (had) globals.document = previous;
        else delete globals.document;
      }
    }

    /** The piece ids navigated to while `act()` runs. */
    function navigations(act: () => void): string[] {
      const seen: string[] = [];
      const listener = (event: Event) =>
        seen.push((event as CustomEvent).detail.pieceId);
      globalThis.addEventListener("cf-navigate", listener);
      try {
        act();
      } finally {
        globalThis.removeEventListener("cf-navigate", listener);
      }
      return seen;
    }

    it("navigates to a link's new target after the link is retargeted", async () => {
      const { link, publish } = retargetableLink(roomCell("of:fid1:first"));
      const element = new CFCellLink() as any;
      markConnected(element);
      element.cell = link;
      await element._resolveCell();

      const seen = navigations(() => {
        element._handleClick({ stopPropagation() {} });
        publish(roomCell("of:fid1:second"));
        element._handleClick({ stopPropagation() {} });
      });
      expect(seen).toEqual(["of:fid1:first", "of:fid1:second"]);
    });

    it("navigates to a target published while its first resolution finishes", async () => {
      const { link, publish, subscribed } = retargetableLink(
        roomCell("of:fid1:first"),
      );
      const element = new CFCellLink() as any;
      markConnected(element);
      element.cell = link;
      const resolving = element._resolveCell();
      await subscribed;
      publish(roomCell("of:fid1:second"));
      await resolving;

      const seen = navigations(() =>
        element._handleClick({ stopPropagation() {} })
      );
      expect(seen).toEqual(["of:fid1:second"]);
    });

    it("takes no subscription when it disconnects while resolving", async () => {
      const resolution = deferred<void>();
      const view = retargetableLink(roomCell("of:fid1:first"), {
        resolution: resolution.promise,
      });
      const element = new CFCellLink() as any;
      markConnected(element);
      element.cell = view.link;
      const resolving = element._resolveCell();
      disconnect(element);
      resolution.resolve();
      await resolving;

      expect(view.counts.subscribed).toBe(0);
      expect(element._resolvedCell).toBeUndefined();
    });

    it("keeps its `$NAME` subscription when a link resolves again to the same target", async () => {
      const { link } = retargetableLink(roomCell("of:fid1:first"));
      const element = new CFCellLink() as any;
      markConnected(element);
      element.cell = link;
      await element._resolveCell();
      element._updateSubscription();
      expect(element._unsubscribe).toBeDefined();

      await element._resolveCell();
      expect(element._unsubscribe).toBeDefined();
    });
  });

  it("does not subscribe before the element is connected", () => {
    const ref: CellRef = {
      id: "of:detached-cell" as CellRef["id"],
      space: "did:key:test-space" as CellRef["space"],
      scope: "space",
      path: [],
      schema: { type: "object" },
    };
    let subscribeCount = 0;
    const cell = {
      ref: () => ref,
      asSchema: () => ({
        subscribe: () => {
          subscribeCount++;
          return () => {};
        },
      }),
    };

    const element = new CFCellLink() as any;
    element._resolvedCell = cell;
    element._updateSubscription();

    expect(subscribeCount).toBe(0);

    markConnected(element);
    element._updateSubscription();

    expect(subscribeCount).toBe(1);
  });
});

describe("CFCellLink disposal handling", () => {
  // _resolveCell awaits resolveAsCell(); a disposal race rejects it with
  // AbortError. The guard must read the runtime the resolve ran on (the cell's
  // own runtime, or the client the linked cell was built from), since the
  // ambient `this.runtime` is cleared to undefined on logout. Exercised against
  // a minimal `this` so no Lit reactive lifecycle (and no re-resolve on the
  // runtime property change) runs.
  function captureConsoleError(): { calls: unknown[][]; restore(): void } {
    const calls: unknown[][] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => calls.push(args);
    return { calls, restore: () => (console.error = original) };
  }

  function resolveCellOn(fakeThis: Record<string, unknown>): Promise<void> {
    return (CFCellLink.prototype as unknown as {
      _resolveCell(this: unknown): Promise<void>;
    })._resolveCell.call(fakeThis);
  }

  function baseThis(): Record<string, unknown> {
    return {
      _resolveCellGeneration: 0,
      cell: undefined,
      link: undefined,
      // The ambient @consume runtime, cleared to undefined on logout.
      runtime: undefined,
      space: "did:key:test-space",
      _cellKey: () => "key",
      _prepareSubscriptionTarget: () => {},
      _setResolvedCell: () => {},
    };
  }

  function cellThat(aborted: boolean, error: unknown) {
    return {
      ref: () => ({
        id: "of:disposed-cell",
        space: "did:key:test-space",
        scope: "space",
        path: [],
      }),
      runtime: () => ({ signal: { aborted } }),
      resolveAsCell: () => Promise.reject(error),
    };
  }

  it("suppresses the resolve-cell log when the cell's runtime is disposed", async () => {
    const fakeThis = {
      ...baseThis(),
      cell: cellThat(true, new DOMException("aborted", "AbortError")),
    };
    const spy = captureConsoleError();
    try {
      await resolveCellOn(fakeThis);
    } finally {
      spy.restore();
    }
    expect(spy.calls.length).toBe(0);
  });

  it("logs a genuine resolve-cell failure while the runtime is alive", async () => {
    const fakeThis = {
      ...baseThis(),
      cell: cellThat(false, new Error("boom")),
    };
    const spy = captureConsoleError();
    try {
      await resolveCellOn(fakeThis);
    } finally {
      spy.restore();
    }
    expect(spy.calls.length).toBe(1);
  });

  it("suppresses the resolve-link log when the captured runtime is disposed", async () => {
    // The link branch reads `this.runtime` once, up front, to build the linked
    // cell. The guard checks that captured client (the one the resolve ran on),
    // which is aborted. Clearing the ambient `this.runtime` afterward — as
    // logout does — must not change the outcome; the old guard read it and
    // would log anyway.
    const runtime = {
      signal: { aborted: true },
      getCellFromRef: () => ({
        ref: () => ({
          id: "of:abc123",
          space: "did:key:test-space",
          scope: "space",
          path: [],
        }),
        resolveAsCell: () =>
          Promise.reject(new DOMException("aborted", "AbortError")),
      }),
    };
    const fakeThis: Record<string, unknown> = {
      ...baseThis(),
      link: "/of:abc123",
      runtime,
    };
    const spy = captureConsoleError();
    try {
      const resolving = resolveCellOn(fakeThis);
      fakeThis.runtime = undefined;
      await resolving;
    } finally {
      spy.restore();
    }
    expect(spy.calls.length).toBe(0);
  });
});

describe("CFCellLink drag preview", () => {
  let mockDocument: ReturnType<typeof installMockDocument>;

  beforeEach(() => {
    mockDocument = installMockDocument();
  });

  afterEach(() => {
    if (isDragging()) endDrag();
    mockDocument.restore();
  });

  /** The subset of a PointerEvent the drag handlers read. */
  function pointerEvent(x: number, y: number): PointerEvent {
    return { clientX: x, clientY: y, pointerId: 1 } as unknown as PointerEvent;
  }

  /**
   * An element built with `new` is never upgraded, so it has no `classList`.
   * Give it one that records, so the drag's own class toggle is observable.
   */
  function withClassList(element: object): Set<string> {
    const classes = new Set<string>();
    Object.defineProperty(element, "classList", {
      configurable: true,
      value: {
        add: (name: string) => classes.add(name),
        remove: (name: string) => classes.delete(name),
      },
    });
    return classes;
  }

  it("hands the preview's teardown to the drag state", () => {
    const { cell } = createRenderableCellHandle({
      $UI: { type: "vnode", name: "div", props: {}, children: [] },
    });
    const element = new CFCellLink() as any;
    const classes = withClassList(element);
    element._resolvedCell = cell;

    element._beginDrag(pointerEvent(30, 40));

    expect(classes.has("dragging")).toBe(true);
    const drag = getCurrentDrag();
    expect(drag).not.toBeNull();
    expect(drag!.type).toBe("cell-link");
    expect(drag!.cell).toBe(cell);
    // Without this the preview's render stays mounted after the drag ends.
    expect(typeof drag!.previewCleanup).toBe("function");
    expect(mockDocument.document.body.children).toContain(drag!.preview);
    expect(
      (drag!.preview as unknown as { style: Record<string, string> }).style,
    )
      .toMatchObject({ left: "40px", top: "50px" });
  });

  it("carries no teardown when the preview is a static pill", () => {
    const { cell } = createRenderableCellHandle(undefined);
    const element = new CFCellLink() as any;
    withClassList(element);
    element._resolvedCell = cell;

    element._beginDrag(pointerEvent(0, 0));

    expect(getCurrentDrag()!.previewCleanup).toBeUndefined();
  });

  it("does not begin a drag before a cell resolves", () => {
    const element = new CFCellLink() as any;
    withClassList(element);
    element._beginDrag(pointerEvent(0, 0));
    expect(isDragging()).toBe(false);
  });
});
