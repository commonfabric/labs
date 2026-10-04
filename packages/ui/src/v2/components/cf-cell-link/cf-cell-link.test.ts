import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import {
  type CellHandle,
  CellReadRefusedError,
  type CellRef,
} from "@commonfabric/runtime-client";

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

  it("names a link the worker will not show the name of as withheld", () => {
    const ref: CellRef = {
      id: "of:sealed-cell",
      space: "did:key:test-space",
      scope: "space",
      path: [],
      schema: { type: "object" },
    };
    let deliver = (_value: unknown) => {};
    let refuse = () => {};
    const element = new CFCellLink() as any;
    markConnected(element);
    element._resolvedCell = {
      ref: () => ref,
      id: () => ref.id,
      asSchema: () => ({
        subscribe: (
          callback: (value: unknown) => void,
          options: { onRefused: () => void },
        ) => {
          deliver = callback;
          refuse = options.onRefused;
          return () => {};
        },
      }),
    };
    element._updateSubscription();
    deliver({ $NAME: "Inbox" });
    expect(element._name).toBe("Inbox");

    refuse();

    expect(element._name).toBe("Content hidden by policy");
  });

  it("names a link whose resolution the worker refuses as withheld, and reports no error", async () => {
    const errors: unknown[] = [];
    const consoleError = console.error;
    console.error = (...args: unknown[]) => errors.push(args);
    try {
      const element = new CFCellLink() as any;
      markConnected(element);
      element.cell = {
        ref: () => ({
          id: "of:refused-link",
          space: "did:key:test-space",
          scope: "space",
          path: [],
        }),
        resolveAsCell: () =>
          Promise.reject(
            new CellReadRefusedError({ refusedBy: "display-ceiling" }),
          ),
        runtime: () => ({ signal: { aborted: false } }),
      };
      await element._resolveCell();

      expect(element._name).toBe("Content hidden by policy");
      expect(element._resolvedCell).toBeUndefined();
      expect(errors).toEqual([]);
    } finally {
      console.error = consoleError;
    }
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
     * taken on it and released. The link is held by the cell `holderId`. Each
     * resolution waits for `resolution`, lands on `chainEnd` where the link's
     * target is itself a link, and runs `afterResolve` once it has read where
     * it lands.
     */
    function retargetableLink(
      initialTarget: CellHandle,
      {
        holderId = "of:fid1:row-holder",
        resolution = Promise.resolve(),
        chainEnd,
        afterResolve = () => {},
      }: {
        holderId?: string;
        resolution?: Promise<void>;
        chainEnd?: CellHandle;
        afterResolve?: () => void;
      } = {},
    ) {
      const link = createMockCellHandle({}, {
        id: holderId as CellRef["id"],
        space: "did:key:test-space" as CellRef["space"],
        path: ["rooms", "0", "room"],
      }) as CellHandle;
      let currentTarget = initialTarget;
      const callbacks = new Set<(value: CellHandle) => void>();
      const subscribed = deferred<void>();
      const counts = { subscribed: 0, unsubscribed: 0 };
      (link as unknown as { resolveAsCell(): Promise<CellHandle> })
        .resolveAsCell = () =>
          resolution.then(() => {
            const landed = chainEnd ?? currentTarget;
            afterResolve();
            return landed;
          });
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

    /** Resolves with the next target `element` installs. */
    function nextInstall(element: any): Promise<CellHandle | undefined> {
      const installed = deferred<CellHandle | undefined>();
      const install = element._setResolvedCell;
      element._setResolvedCell = (cell: CellHandle | undefined) => {
        element._setResolvedCell = install;
        install.call(element, cell);
        installed.resolve(cell);
      };
      return installed.promise;
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

      const before = navigations(() =>
        element._handleClick({ stopPropagation() {} })
      );
      const installed = nextInstall(element);
      publish(roomCell("of:fid1:second"));
      await installed;
      const after = navigations(() =>
        element._handleClick({ stopPropagation() {} })
      );
      expect([...before, ...after]).toEqual([
        "of:fid1:first",
        "of:fid1:second",
      ]);
    });

    it("navigates to a target published while its first resolution finishes", async () => {
      const { link, publish, subscribed } = retargetableLink(
        roomCell("of:fid1:first"),
      );
      const element = new CFCellLink() as any;
      markConnected(element);
      element.cell = link;
      void element._resolveCell();
      await subscribed;
      const installed = nextInstall(element);
      publish(roomCell("of:fid1:second"));
      await installed;

      const seen = navigations(() =>
        element._handleClick({ stopPropagation() {} })
      );
      expect(seen).toEqual(["of:fid1:second"]);
    });

    it("navigates to the end of a chain whose first link leads to another link", async () => {
      const { link } = retargetableLink(roomCell("of:fid1:hop"), {
        chainEnd: roomCell("of:fid1:room"),
      });
      const element = new CFCellLink() as any;
      markConnected(element);
      element.cell = link;
      await element._resolveCell();

      const seen = navigations(() =>
        element._handleClick({ stopPropagation() {} })
      );
      expect(seen).toEqual(["of:fid1:room"]);
    });

    it("navigates to the current cell's target when the cell it replaced retargets", async () => {
      const replaced = retargetableLink(roomCell("of:fid1:old-first"));
      const resolution = deferred<void>();
      const current = retargetableLink(roomCell("of:fid1:current"), {
        holderId: "of:fid1:other-row-holder",
        resolution: resolution.promise,
      });
      const element = new CFCellLink() as any;
      markConnected(element);
      element.cell = replaced.link;
      await element._resolveCell();

      element.cell = current.link;
      void element._resolveCell();
      const installed = nextInstall(element);
      replaced.publish(roomCell("of:fid1:old-second"));
      resolution.resolve();
      await installed;

      const seen = navigations(() =>
        element._handleClick({ stopPropagation() {} })
      );
      expect(seen).toEqual(["of:fid1:current"]);
    });

    it("releases the replaced link's subscription when the next cell fails to resolve", async () => {
      const replaced = retargetableLink(roomCell("of:fid1:first"));
      const failing = createMockCellHandle({}, {
        id: "of:fid1:failing" as CellRef["id"],
        space: "did:key:test-space" as CellRef["space"],
      }) as CellHandle;
      (failing as unknown as { resolveAsCell(): Promise<CellHandle> })
        .resolveAsCell = () => Promise.reject(new Error("boom"));
      const element = new CFCellLink() as any;
      markConnected(element);
      element.cell = replaced.link;
      await element._resolveCell();
      expect(replaced.counts).toEqual({ subscribed: 1, unsubscribed: 0 });

      element.cell = failing;
      const logError = console.error;
      console.error = () => {};
      try {
        await element._resolveCell();
      } finally {
        console.error = logError;
      }
      expect(replaced.counts).toEqual({ subscribed: 1, unsubscribed: 1 });
    });

    it("navigates to a target the link moved to between resolving and subscribing", async () => {
      let moved = false;
      const view = retargetableLink(roomCell("of:fid1:first"), {
        afterResolve: () => {
          if (moved) return;
          moved = true;
          view.publish(roomCell("of:fid1:second"));
        },
      });
      const element = new CFCellLink() as any;
      markConnected(element);
      element.cell = view.link;
      await element._resolveCell();

      const seen = navigations(() =>
        element._handleClick({ stopPropagation() {} })
      );
      expect(seen).toEqual(["of:fid1:second"]);
    });

    it("takes no subscription when it resolves while disconnected", async () => {
      const view = retargetableLink(roomCell("of:fid1:first"));
      const element = new CFCellLink() as any;
      markConnected(element, false);
      element.cell = view.link;
      await element._resolveCell();

      expect(view.counts.subscribed).toBe(0);
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
  // an element that is never connected, so no Lit reactive lifecycle (and no
  // re-resolve on the runtime property change) runs.
  function captureConsoleError(): { calls: unknown[][]; restore(): void } {
    const calls: unknown[][] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => calls.push(args);
    return { calls, restore: () => (console.error = original) };
  }

  /** Starts resolving on an unconnected element holding `fields`. */
  function resolveCellOn(fields: Record<string, unknown>): {
    element: Record<string, unknown>;
    resolving: Promise<void>;
  } {
    const element = Object.assign(new CFCellLink(), fields) as unknown as
      & Record<string, unknown>
      & { _resolveCell(): Promise<void> };
    return { element, resolving: element._resolveCell() };
  }

  function baseFields(): Record<string, unknown> {
    return {
      cell: undefined,
      link: undefined,
      // The ambient @consume runtime, cleared to undefined on logout.
      runtime: undefined,
      space: "did:key:test-space",
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
    const fields = {
      ...baseFields(),
      cell: cellThat(true, new DOMException("aborted", "AbortError")),
    };
    const spy = captureConsoleError();
    try {
      await resolveCellOn(fields).resolving;
    } finally {
      spy.restore();
    }
    expect(spy.calls.length).toBe(0);
  });

  it("logs a genuine resolve-cell failure while the runtime is alive", async () => {
    const fields = {
      ...baseFields(),
      cell: cellThat(false, new Error("boom")),
    };
    const spy = captureConsoleError();
    try {
      await resolveCellOn(fields).resolving;
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
    const fields: Record<string, unknown> = {
      ...baseFields(),
      link: "/of:abc123",
      runtime,
    };
    const spy = captureConsoleError();
    try {
      const { element, resolving } = resolveCellOn(fields);
      element.runtime = undefined;
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

  it("carries the teardown of the render that names the cell in its preview", () => {
    const { cell } = createRenderableCellHandle(undefined);
    const element = new CFCellLink() as any;
    withClassList(element);
    element._resolvedCell = cell;

    element._beginDrag(pointerEvent(0, 0));

    expect(getCurrentDrag()!.previewCleanup).toBeDefined();
  });

  it("does not begin a drag before a cell resolves", () => {
    const element = new CFCellLink() as any;
    withClassList(element);
    element._beginDrag(pointerEvent(0, 0));
    expect(isDragging()).toBe(false);
  });
});
