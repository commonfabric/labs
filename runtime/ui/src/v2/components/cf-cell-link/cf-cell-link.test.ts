// First, so that the document it installs is there when Lit loads.
import { mount, settle } from "../../test-utils/dom.ts";

import { expect } from "@std/expect";

import type { DID } from "@commonfabric/identity/did";
import type { CellHandle, CellRef } from "@commonfabric/runtime-client";

import { endDrag, getCurrentDrag, isDragging } from "../../core/drag-state.ts";
import { createMockCellHandle } from "../../test-utils/mock-cell-handle.ts";
import { createRenderableCellHandle } from "../../test-utils/mock-vdom-connection.ts";
import { setNewTabReservation } from "@commonfabric/navigation";
import {
  afterEach,
  beforeEach,
  describe,
  it,
} from "@commonfabric/test-support/test";

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
  it("warns, naming the link, and navigates nowhere on a click before an unlabelled link resolves", () => {
    const element = new CFCellLink() as any;
    element._name = "Team chat";
    element.cell = {
      ref: () => ({
        space: "did:key:home",
        id: "of:fid1:row",
        scope: "user",
        path: ["element", "room"],
      }),
    };
    const seen: unknown[] = [];
    const listener = (event: Event) => seen.push((event as CustomEvent).detail);
    const warnings: unknown[][] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(args);
    globalThis.addEventListener("cf-navigate", listener);
    try {
      element._handleClick({ stopPropagation() {} });
    } finally {
      globalThis.removeEventListener("cf-navigate", listener);
      console.warn = originalWarn;
    }
    expect(seen).toEqual([]);
    expect(warnings).toEqual([[
      "cf-cell-link: the click opens nothing: the link names no cell to open.",
      {
        label: "Team chat",
        cell: {
          space: "did:key:home",
          id: "of:fid1:row",
          scope: "user",
          path: ["element", "room"],
        },
      },
    ]]);
  });
  it("warns, naming the link string, on a click before a link given as a string resolves", () => {
    const element = new CFCellLink() as any;
    element.link = "/of:fid1:abc/path";
    const warnings: unknown[][] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(args);
    try {
      element._handleClick({ stopPropagation() {} });
    } finally {
      console.warn = originalWarn;
    }
    expect(warnings).toEqual([[
      "cf-cell-link: the click opens nothing: the link names no cell to open.",
      { label: undefined, link: "/of:fid1:abc/path" },
    ]]);
  });
  it("opens the linked view in a new tab on a click with the command key held", () => {
    const element = new CFCellLink() as any;
    element._resolvedCell = {
      ref: () => ({
        space: "did:key:foreign",
        id: "of:fid1:same",
        scope: "space",
        path: [],
      }),
      space: () => "did:key:foreign",
      id: () => "of:fid1:same",
    };
    const opened: unknown[] = [];
    const navigated: unknown[] = [];
    // A host that owns new-tab navigation takes the event, so nothing opens a
    // window here.
    const onOpen = (event: Event) => {
      event.preventDefault();
      opened.push((event as CustomEvent).detail);
    };
    const onNavigate = (event: Event) =>
      navigated.push((event as CustomEvent).detail);
    globalThis.addEventListener("cf-open-external", onOpen);
    globalThis.addEventListener("cf-navigate", onNavigate);
    try {
      element._handleClick({ stopPropagation() {}, metaKey: true });
    } finally {
      globalThis.removeEventListener("cf-open-external", onOpen);
      globalThis.removeEventListener("cf-navigate", onNavigate);
    }
    expect(opened).toEqual([{
      spaceDid: "did:key:foreign",
      pieceId: "of:fid1:same",
    }]);
    expect(navigated).toEqual([]);
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

    /** Disconnects `element`. */
    function disconnect(element: any): void {
      markConnected(element, false);
      element.disconnectedCallback();
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

/** A cell link with `properties` set, mounted in the document. */
function cellLink(
  properties: Partial<
    Pick<
      CFCellLink,
      "cell" | "link" | "label" | "isStatic" | "runtime" | "space"
    >
  > = {},
): Promise<CFCellLink> {
  return mount(Object.assign(new CFCellLink(), properties));
}

/** The chip `element` renders. */
function chip(element: CFCellLink): HTMLElement {
  const found = element.shadowRoot!.querySelector<HTMLElement>("cf-chip");
  if (!found) throw new Error("cf-cell-link rendered no chip");
  return found;
}

/** The text `element` shows, once what it is resolving has settled. */
async function shownText(element: CFCellLink): Promise<string> {
  await settle();
  await element.updateComplete;
  return chip(element).textContent!.trim();
}

/**
 * A cell standing in for a piece, with the id `id` and the name `name`. It
 * holds no link, so it resolves to itself.
 */
function pieceCell(id: string, name?: string): CellHandle {
  return selfResolving(
    createMockCellHandle(name === undefined ? {} : { $NAME: name }, {
      id: id as CellRef["id"],
      space: "did:key:test-space" as CellRef["space"],
    }) as CellHandle,
  );
}

/** `cell`, made to resolve to itself, as a cell holding no link does. */
function selfResolving<T>(cell: CellHandle<T>): CellHandle<T> {
  return Object.assign(cell, { resolveAsCell: () => Promise.resolve(cell) });
}

/** A cell whose drag preview can render, holding `value` and no link. */
function draggableCell(value?: unknown): CellHandle {
  return selfResolving(createRenderableCellHandle(value).cell);
}

/** The arguments `console.error` is called with while `act()` runs. */
async function errorsLogged(act: () => Promise<unknown>): Promise<unknown[][]> {
  const calls: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => calls.push(args);
  try {
    await act();
  } finally {
    console.error = original;
  }
  return calls;
}

/** A pointer event of `type` at (`x`, `y`) from the pointer `pointerId`. */
function pointer(type: string, x: number, y: number, pointerId = 1): Event {
  return new PointerEvent(type, {
    clientX: x,
    clientY: y,
    pointerId,
    bubbles: true,
    composed: true,
  });
}

/**
 * The reads `element`-side code makes of `cell` from now on: each
 * `resolveAsCell()`, and each `asSchema()`, through which both following a
 * link's target and asking for its `[NAME]` go.
 */
function countReads(cell: CellHandle): {
  resolutions: number;
  schemaReads: number;
} {
  const reads = { resolutions: 0, schemaReads: 0 };
  const resolveAsCell = cell.resolveAsCell.bind(cell);
  const asSchema = cell.asSchema.bind(cell);
  Object.assign(cell, {
    resolveAsCell: () => {
      reads.resolutions++;
      return resolveAsCell();
    },
    asSchema: (schema: Parameters<CellHandle["asSchema"]>[0]) => {
      reads.schemaReads++;
      return asSchema(schema);
    },
  });
  return reads;
}

/**
 * The piece ids navigated to while `act()` runs and once what it started
 * has settled, for a click whose target is resolved by the click.
 */
async function navigatedToOnceSettled(act: () => void): Promise<string[]> {
  const seen: string[] = [];
  const listener = (event: Event) =>
    seen.push((event as CustomEvent).detail.pieceId);
  globalThis.addEventListener("cf-navigate", listener);
  try {
    act();
    await settle();
    await new Promise((resolve) => setTimeout(resolve, 0));
  } finally {
    globalThis.removeEventListener("cf-navigate", listener);
  }
  return seen;
}

/**
 * A click a pointer makes, as opposed to one the keyboard makes: it carries
 * the click count in `detail`.
 */
function pointerClick(init: MouseEventInit = {}, pointerId?: number): Event {
  const options = { detail: 1, bubbles: true, composed: true, ...init };
  return pointerId === undefined
    ? new MouseEvent("click", options)
    : new PointerEvent("click", { ...options, pointerId });
}

/** The piece ids navigated to while `act()` runs. */
function navigatedTo(act: () => void): string[] {
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

describe("CFCellLink in a document", () => {
  afterEach(() => {
    if (isDragging()) endDrag();
    document.body.replaceChildren();
  });

  describe("text", () => {
    it("shows the label over the cell's name", async () => {
      const element = await cellLink({
        label: "Team chat",
        cell: pieceCell("of:fid1:piece-123456", "Inbox"),
      });

      expect(await shownText(element)).toBe("Team chat");
    });

    it("shows a resolved cell's name and the end of its id", async () => {
      const element = await cellLink({
        cell: pieceCell("of:fid1:piece-abcdef", "Inbox"),
      });

      expect(await shownText(element)).toBe("Inbox #abcdef");
    });

    it("hands back the target an unlabelled link already follows", async () => {
      const cell = pieceCell("of:fid1:piece-abcdef", "Inbox");
      const element = await cellLink({ cell });
      await shownText(element);

      expect(await element.resolveTarget()).toBe(cell);
    });

    it("shows only the end of the id of a resolved cell with no name", async () => {
      const element = await cellLink({
        cell: pieceCell("of:fid1:piece-abcdef"),
      });

      expect(await shownText(element)).toBe("#abcdef");
    });

    it("shows the start of the handle of a link it cannot resolve", async () => {
      const element = await cellLink({
        link: "/of:fid1:abcdefghijklmnopqrstuvwxyz/path",
      });

      expect(await shownText(element)).toBe("#abcdef");
    });

    it("shows a link that names no handle as it is", async () => {
      const element = await cellLink({ link: "not a link" });

      expect(await shownText(element)).toBe("not a link");
    });

    it("follows a change of the link it shows", async () => {
      const element = await cellLink({ link: "not a link" });
      await shownText(element);

      element.link = "still not a link";

      expect(await shownText(element)).toBe("still not a link");
    });

    it("shows Unknown Link once its link is cleared", async () => {
      const element = await cellLink({ link: "not a link" });
      await shownText(element);

      element.link = undefined;

      expect(await shownText(element)).toBe("Unknown Link");
    });

    it("shows Unknown Link with neither a cell nor a link", async () => {
      const element = await cellLink();

      expect(await shownText(element)).toBe("Unknown Link");
    });
  });

  describe("resolving a link", () => {
    /** A runtime whose every cell is `target`. */
    function runtimeOf(target: CellHandle) {
      return Object.assign(target.runtime(), {
        getCellFromRef: () => target,
      });
    }

    it("resolves a link in the space it is shown in", async () => {
      const target = pieceCell("of:fid1:piece-abcdef", "Inbox");
      const element = await cellLink({
        link: "/of:fid1:abcdefghijklmnopqrstuvwxyz",
        runtime: runtimeOf(target),
        space: "did:key:test-space" as DID,
      });

      expect(await shownText(element)).toBe("Inbox #abcdef");
      expect(navigatedTo(() => chip(element).click())).toEqual([
        "of:fid1:piece-abcdef",
      ]);
    });

    it("logs a link with no space to resolve it in, and resolves nothing", async () => {
      const target = pieceCell("of:fid1:piece-abcdef", "Inbox");
      let element: CFCellLink | undefined;

      const logged = await errorsLogged(async () => {
        element = await cellLink({
          link: "/of:fid1:abcdefghijklmnopqrstuvwxyz",
          runtime: runtimeOf(target),
        });
        await settle();
      });

      expect(logged).toEqual([[
        "Failed to resolve link:",
        new Error("Link missing space."),
      ]]);
      expect(await shownText(element!)).toBe("#abcdef");
    });

    it("logs nothing when a cell it stopped resolving fails", async () => {
      const failure = deferred<CellHandle>();
      const replaced = Object.assign(pieceCell("of:fid1:piece-abcdef"), {
        resolveAsCell: () => failure.promise,
      });

      const logged = await errorsLogged(async () => {
        const element = await cellLink({ cell: replaced });
        element.cell = pieceCell("of:fid1:piece-123456", "Archive");
        await element.updateComplete;
        failure.reject(new Error("boom"));
        expect(await shownText(element)).toBe("Archive #123456");
      });

      expect(logged).toEqual([]);
    });

    it("logs nothing when a link it stopped resolving fails", async () => {
      const failure = deferred<CellHandle>();
      const linked = Object.assign(pieceCell("of:fid1:piece-abcdef"), {
        resolveAsCell: () => failure.promise,
      });

      const logged = await errorsLogged(async () => {
        const element = await cellLink({
          link: "/of:fid1:abcdefghijklmnopqrstuvwxyz",
          runtime: runtimeOf(linked),
          space: "did:key:test-space" as DID,
        });
        element.link = undefined;
        await element.updateComplete;
        failure.reject(new Error("boom"));
        expect(await shownText(element)).toBe("Unknown Link");
      });

      expect(logged).toEqual([]);
    });

    it("resolves again when it is attached again", async () => {
      const element = await cellLink({
        cell: pieceCell("of:fid1:piece-abcdef", "Inbox"),
      });
      await shownText(element);
      element.remove();

      const replacement = pieceCell("of:fid1:piece-123456", "Archive");
      element.cell = replacement;
      document.body.append(element);

      expect(await shownText(element)).toBe("Archive #123456");
    });
  });

  describe("a labelled link", () => {
    /** A cell holding a link to `target`: it resolves to `target`. */
    function linkTo(...targets: CellHandle[]): CellHandle {
      const queue = [...targets];
      return Object.assign(pieceCell("of:fid1:row-000000"), {
        resolveAsCell: () =>
          Promise.resolve(queue.length > 1 ? queue.shift()! : queue[0]),
      });
    }

    it("reads nothing of its target while it is shown", async () => {
      const cell = linkTo(pieceCell("of:fid1:topic-111111", "Inbox"));
      const reads = countReads(cell);

      const element = await cellLink({ label: "Open", cell });

      expect(await shownText(element)).toBe("Open");
      expect(reads).toEqual({ resolutions: 0, schemaReads: 0 });
    });

    it("resolves when clicked, and opens where its link points", async () => {
      const cell = linkTo(pieceCell("of:fid1:topic-111111", "Inbox"));
      const element = await cellLink({ label: "Open", cell, isStatic: true });
      await shownText(element);

      expect(await navigatedToOnceSettled(() => chip(element).click()))
        .toEqual(["of:fid1:topic-111111"]);
    });

    it("opens where its link points at each click, not where it pointed before", async () => {
      const cell = linkTo(
        pieceCell("of:fid1:topic-111111"),
        pieceCell("of:fid1:topic-222222"),
      );
      const element = await cellLink({ label: "Open", cell, isStatic: true });
      await shownText(element);

      expect(await navigatedToOnceSettled(() => chip(element).click()))
        .toEqual(["of:fid1:topic-111111"]);
      expect(await navigatedToOnceSettled(() => chip(element).click()))
        .toEqual(["of:fid1:topic-222222"]);
    });

    it("resolves once for a press and the click that follows it", async () => {
      const cell = linkTo(pieceCell("of:fid1:topic-111111"));
      const reads = countReads(cell);
      const element = await cellLink({ label: "Open", cell, isStatic: true });
      await shownText(element);

      const opened = await navigatedToOnceSettled(() => {
        chip(element).dispatchEvent(pointer("pointerdown", 10, 10));
        chip(element).dispatchEvent(pointerClick());
      });

      expect(opened).toEqual(["of:fid1:topic-111111"]);
      expect(reads.resolutions).toBe(1);
    });

    it("resolves a keyboard's click on its own while a mouse press is held", async () => {
      const cell = linkTo(
        pieceCell("of:fid1:topic-111111"),
        pieceCell("of:fid1:topic-222222"),
      );
      const reads = countReads(cell);
      const element = await cellLink({ label: "Open", cell, isStatic: true });
      await shownText(element);

      chip(element).dispatchEvent(pointer("pointerdown", 10, 10));
      await settle();
      // The keyboard's click carries no detail: it is not the press's.
      const opened = await navigatedToOnceSettled(() => chip(element).click());

      expect(opened).toEqual(["of:fid1:topic-222222"]);
      expect(reads.resolutions).toBe(2);
    });

    it("asks the worker for where the links end, loading what they pass through", async () => {
      const target = pieceCell("of:fid1:topic-111111");
      const asked: unknown[] = [];
      const cell = Object.assign(pieceCell("of:fid1:row-000000"), {
        resolveAsCell: (options?: unknown) => {
          asked.push(options);
          return Promise.resolve(target);
        },
      });
      const element = await cellLink({ label: "Open", cell, isStatic: true });
      await shownText(element);

      expect(await navigatedToOnceSettled(() => chip(element).click()))
        .toEqual(["of:fid1:topic-111111"]);
      expect(asked).toEqual([{ loaded: true }]);
    });

    it("resolves again for a click after a press was let go", async () => {
      const cell = linkTo(
        pieceCell("of:fid1:topic-111111"),
        pieceCell("of:fid1:topic-222222"),
      );
      const element = await cellLink({ label: "Open", cell, isStatic: true });
      await shownText(element);

      chip(element).dispatchEvent(pointer("pointerdown", 10, 10));
      document.dispatchEvent(pointer("pointercancel", 10, 10));
      await settle();
      await new Promise((resolve) => setTimeout(resolve, 0));

      // The keyboard's click, with no press of its own: where the link
      // points now, not where the cancelled press found it.
      expect(await navigatedToOnceSettled(() => chip(element).click()))
        .toEqual(["of:fid1:topic-222222"]);
    });

    it("keeps a released touch press for its click, which comes later", async () => {
      const cell = linkTo(
        pieceCell("of:fid1:topic-111111"),
        pieceCell("of:fid1:topic-222222"),
      );
      const reads = countReads(cell);
      const element = await cellLink({ label: "Open", cell, isStatic: true });
      await shownText(element);

      chip(element).dispatchEvent(pointer("pointerdown", 10, 10, 7));
      await settle();
      document.dispatchEvent(pointer("pointerup", 10, 10, 7));
      // A touch screen's click comes a while after the release.
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));

      const opened = await navigatedToOnceSettled(() =>
        chip(element).dispatchEvent(pointerClick({}, 7))
      );
      expect(opened).toEqual(["of:fid1:topic-111111"]);
      expect(reads.resolutions).toBe(1);
    });

    it("lets a released press go once no click has followed it for a while", async () => {
      const hold = CFCellLink.releasedPressHoldMs;
      CFCellLink.releasedPressHoldMs = 0;
      try {
        const cell = linkTo(
          pieceCell("of:fid1:topic-111111"),
          pieceCell("of:fid1:topic-222222"),
        );
        const element = await cellLink({
          label: "Open",
          cell,
          isStatic: true,
        });
        await shownText(element);

        chip(element).dispatchEvent(pointer("pointerdown", 10, 10, 1));
        await settle();
        document.dispatchEvent(pointer("pointerup", 10, 10, 1));
        await new Promise((resolve) => setTimeout(resolve, 0));
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(
          await navigatedToOnceSettled(() =>
            chip(element).dispatchEvent(pointerClick({}, 1))
          ),
        ).toEqual(["of:fid1:topic-222222"]);
      } finally {
        CFCellLink.releasedPressHoldMs = hold;
      }
    });

    it("drags only what its current press resolved, once that lands", async () => {
      const first = draggableCell({ $NAME: "First" });
      const second = draggableCell({ $NAME: "Second" });
      const pending = deferred<CellHandle>();
      const answers: Promise<CellHandle>[] = [
        Promise.resolve(first),
        pending.promise,
      ];
      const cell = Object.assign(pieceCell("of:fid1:row-000000"), {
        resolveAsCell: () => answers.shift()!,
      });
      const element = await cellLink({ label: "Open", cell });
      await shownText(element);
      expect(await element.resolveTarget()).toBe(first);

      chip(element).dispatchEvent(pointer("pointerdown", 10, 10));
      document.dispatchEvent(pointer("pointermove", 30, 30));
      expect(isDragging()).toBe(false);

      pending.resolve(second);
      await settle();
      document.dispatchEvent(pointer("pointermove", 40, 40));

      expect(isDragging()).toBe(true);
      expect(getCurrentDrag()!.cell).toBe(second);
    });

    it("keeps its press when another pointer is released", async () => {
      const target = draggableCell({ $NAME: "Inbox" });
      const element = await cellLink({ label: "Open", cell: linkTo(target) });
      await shownText(element);

      chip(element).dispatchEvent(pointer("pointerdown", 10, 10, 1));
      await settle();
      document.dispatchEvent(pointer("pointerup", 200, 200, 2));
      await new Promise((resolve) => setTimeout(resolve, 0));
      document.dispatchEvent(pointer("pointermove", 40, 40, 1));

      expect(isDragging()).toBe(true);
      expect(getCurrentDrag()!.cell).toBe(target);
    });

    describe("with the command key held", () => {
      // A host that has turned tab reservation on, as the shell does; the
      // case for one that has not turns it off itself.
      let reserveAfterMs: number;
      beforeEach(() => {
        reserveAfterMs = CFCellLink.newTabReserveAfterMs;
        setNewTabReservation(true);
      });
      afterEach(() => {
        CFCellLink.newTabReserveAfterMs = reserveAfterMs;
        setNewTabReservation(false);
      });

      /** A tab `globalThis.open` hands back, recording what is done to it. */
      function fakeTab() {
        return {
          opener: {} as unknown,
          location: { href: "" },
          closed: false,
          close() {
            this.closed = true;
          },
        };
      }

      /**
       * Runs `act` with `globalThis.open` answering with `tab` and recording
       * each call, and restores it after `act` settles.
       */
      async function withOpen(
        tab: ReturnType<typeof fakeTab>,
        act: (openArgs: unknown[][]) => Promise<void>,
      ): Promise<void> {
        const openArgs: unknown[][] = [];
        const scope = globalThis as unknown as {
          open: (...args: unknown[]) => unknown;
        };
        const original = scope.open;
        scope.open = (...args: unknown[]) => {
          openArgs.push(args);
          return tab;
        };
        try {
          await act(openArgs);
        } finally {
          scope.open = original;
        }
      }

      /** A pointer's click on `element`'s chip with the command key held. */
      function commandClick(element: CFCellLink): void {
        chip(element).dispatchEvent(pointerClick({ metaKey: true }));
      }

      /** Lets a timer due now, and what it leads to, run. */
      const nextTask = () => new Promise((resolve) => setTimeout(resolve, 0));

      it("opens a target its press already resolved within the click", async () => {
        const element = await cellLink({
          label: "Open",
          cell: linkTo(pieceCell("of:fid1:topic-111111")),
          isStatic: true,
        });
        await shownText(element);
        const opened: unknown[] = [];
        const onOpen = (event: Event) => {
          event.preventDefault();
          opened.push((event as CustomEvent).detail.pieceId);
        };
        globalThis.addEventListener("cf-open-external", onOpen);
        const tab = fakeTab();
        try {
          await withOpen(tab, async (openArgs) => {
            chip(element).dispatchEvent(pointer("pointerdown", 10, 10));
            await settle();
            commandClick(element);
            expect(opened).toEqual(["of:fid1:topic-111111"]);
            expect(openArgs).toEqual([]);
          });
        } finally {
          globalThis.removeEventListener("cf-open-external", onOpen);
        }
      });

      it("reserves no tab for a target found soon, so a host can open its own", async () => {
        CFCellLink.newTabReserveAfterMs = 60_000;
        const pending = deferred<CellHandle>();
        const cell = Object.assign(pieceCell("of:fid1:row-000000"), {
          resolveAsCell: () => pending.promise,
        });
        const element = await cellLink({ label: "Open", cell, isStatic: true });
        await shownText(element);
        const opened: unknown[] = [];
        const onOpen = (event: Event) => {
          event.preventDefault();
          opened.push((event as CustomEvent).detail.pieceId);
        };
        globalThis.addEventListener("cf-open-external", onOpen);
        try {
          await withOpen(fakeTab(), async (openArgs) => {
            commandClick(element);
            // Later than a reservation due at once would be, well before one
            // due at the deadline.
            await nextTask();
            pending.resolve(pieceCell("of:fid1:topic-111111"));
            await settle();
            await nextTask();
            expect(openArgs).toEqual([]);
          });
        } finally {
          globalThis.removeEventListener("cf-open-external", onOpen);
        }
        expect(opened).toEqual(["of:fid1:topic-111111"]);
      });

      it("reserves no tab under a host that has not turned reservation on, and hands it the target once it lands", async () => {
        setNewTabReservation(false);
        CFCellLink.newTabReserveAfterMs = 0;
        const pending = deferred<CellHandle>();
        const cell = Object.assign(pieceCell("of:fid1:row-000000"), {
          resolveAsCell: () => pending.promise,
        });
        const element = await cellLink({ label: "Open", cell, isStatic: true });
        await shownText(element);
        const opened: unknown[] = [];
        const onOpen = (event: Event) => {
          event.preventDefault();
          opened.push((event as CustomEvent).detail.pieceId);
        };
        globalThis.addEventListener("cf-open-external", onOpen);
        try {
          await withOpen(fakeTab(), async (openArgs) => {
            commandClick(element);
            await nextTask();
            expect(openArgs).toEqual([]);
            pending.resolve(pieceCell("of:fid1:topic-111111"));
            await settle();
            await nextTask();
            expect(openArgs).toEqual([]);
          });
        } finally {
          globalThis.removeEventListener("cf-open-external", onOpen);
        }
        expect(opened).toEqual(["of:fid1:topic-111111"]);
      });

      it("reserves a tab for a slow target, and points it there once it lands", async () => {
        CFCellLink.newTabReserveAfterMs = 0;
        const pending = deferred<CellHandle>();
        const cell = Object.assign(pieceCell("of:fid1:row-000000"), {
          resolveAsCell: () => pending.promise,
        });
        const element = await cellLink({ label: "Open", cell, isStatic: true });
        await shownText(element);
        const tab = fakeTab();

        await withOpen(tab, async (openArgs) => {
          commandClick(element);
          await nextTask();
          expect(openArgs).toEqual([["", "_blank"]]);

          pending.resolve(pieceCell("of:fid1:topic-111111"));
          await settle();
          await nextTask();
        });

        expect(tab.location.href).toContain("of:fid1:topic-111111");
        expect(tab.opener).toBe(null);
        expect(tab.closed).toBe(false);
      });

      it("closes the reserved tab, without a warning, when the link is taken off the page first", async () => {
        CFCellLink.newTabReserveAfterMs = 0;
        const pending = deferred<CellHandle>();
        const cell = Object.assign(pieceCell("of:fid1:row-000000"), {
          resolveAsCell: () => pending.promise,
        });
        const element = await cellLink({ label: "Open", cell, isStatic: true });
        await shownText(element);
        const tab = fakeTab();
        const warnings: unknown[][] = [];
        const originalWarn = console.warn;
        console.warn = (...args: unknown[]) => warnings.push(args);
        try {
          await withOpen(tab, async () => {
            commandClick(element);
            await nextTask();
            element.remove();
            pending.resolve(pieceCell("of:fid1:topic-111111"));
            await settle();
            await nextTask();
          });
        } finally {
          console.warn = originalWarn;
        }

        expect(tab.closed).toBe(true);
        expect(warnings).toEqual([]);
      });

      it("closes the reserved tab, without a warning, when the link changes before its target arrives", async () => {
        CFCellLink.newTabReserveAfterMs = 0;
        const pending = deferred<CellHandle>();
        const cell = Object.assign(pieceCell("of:fid1:row-000000"), {
          resolveAsCell: () => pending.promise,
        });
        const element = await cellLink({ label: "Open", cell, isStatic: true });
        await shownText(element);
        const tab = fakeTab();
        const warnings: unknown[][] = [];
        const originalWarn = console.warn;
        console.warn = (...args: unknown[]) => warnings.push(args);
        try {
          await withOpen(tab, async () => {
            commandClick(element);
            await nextTask();
            element.cell = linkTo(pieceCell("of:fid1:topic-222222"));
            await element.updateComplete;
            pending.resolve(pieceCell("of:fid1:topic-111111"));
            await settle();
            await nextTask();
          });
        } finally {
          console.warn = originalWarn;
        }

        expect(tab.closed).toBe(true);
        expect(warnings).toEqual([]);
      });

      it("closes the reserved tab, and warns, when the click resolves nothing", async () => {
        CFCellLink.newTabReserveAfterMs = 0;
        const pending = deferred<CellHandle>();
        const cell = Object.assign(pieceCell("of:fid1:row-000000"), {
          resolveAsCell: () => pending.promise,
        });
        const element = await cellLink({ label: "Open", cell, isStatic: true });
        await shownText(element);
        const tab = fakeTab();
        const warnings: unknown[][] = [];
        const originalWarn = console.warn;
        console.warn = (...args: unknown[]) => warnings.push(args);
        try {
          await errorsLogged(() =>
            withOpen(tab, async () => {
              commandClick(element);
              await nextTask();
              pending.reject(new Error("boom"));
              await settle();
              await nextTask();
            })
          );
        } finally {
          console.warn = originalWarn;
        }

        expect(tab.closed).toBe(true);
        expect(warnings.map((call) => call[0])).toEqual([
          "cf-cell-link: the click opens nothing: the link names no cell to open.",
        ]);
      });
    });

    it("never asks for its target's name, even once resolved", async () => {
      const target = pieceCell("of:fid1:topic-111111", "Inbox");
      const targetReads = countReads(target);
      const element = await cellLink({
        label: "Open",
        cell: linkTo(target),
        isStatic: true,
      });

      expect(await element.resolveTarget()).toBe(target);
      expect(await shownText(element)).toBe("Open");
      expect(targetReads.schemaReads).toBe(0);
    });

    it("drags its target once its press has resolved it", async () => {
      const target = draggableCell({ $NAME: "Inbox" });
      const element = await cellLink({ label: "Open", cell: linkTo(target) });
      await shownText(element);

      chip(element).dispatchEvent(pointer("pointerdown", 10, 10));
      await settle();
      document.dispatchEvent(pointer("pointermove", 20, 20));

      expect(isDragging()).toBe(true);
      expect(getCurrentDrag()!.cell).toBe(target);
    });

    it("follows its target and shows its name once it loses its label", async () => {
      const cell = pieceCell("of:fid1:piece-123456", "Inbox");
      const reads = countReads(cell);
      const element = await cellLink({ label: "Open", cell });
      expect(await shownText(element)).toBe("Open");

      element.label = undefined;

      expect(await shownText(element)).toBe("Inbox #123456");
      expect(reads.resolutions).toBe(1);
    });

    it("warns, naming the link, when the click resolves nothing", async () => {
      const cell = Object.assign(pieceCell("of:fid1:row-000000"), {
        resolveAsCell: () => Promise.reject(new Error("boom")),
      });
      const element = await cellLink({ label: "Team chat", cell });
      await shownText(element);
      const warnings: unknown[][] = [];
      const originalWarn = console.warn;
      console.warn = (...args: unknown[]) => warnings.push(args);
      let opened: string[] = [];
      try {
        const logged = await errorsLogged(async () => {
          opened = await navigatedToOnceSettled(() => chip(element).click());
        });
        expect(logged.map((call) => call[0])).toEqual([
          "Failed to resolve cell:",
        ]);
      } finally {
        console.warn = originalWarn;
      }

      expect(opened).toEqual([]);
      expect(warnings).toEqual([[
        "cf-cell-link: the click opens nothing: the link names no cell to open.",
        {
          label: "Team chat",
          cell: {
            space: "did:key:test-space",
            id: "of:fid1:row-000000",
            scope: "space",
            path: [],
          },
        },
      ]]);
    });

    it("resolves nothing, and opens nothing, with neither a cell nor a link", async () => {
      const element = await cellLink({ label: "Open" });
      await shownText(element);

      expect(await element.resolveTarget()).toBeUndefined();
    });

    it("logs a link given as a string with no space to resolve it in, and resolves nothing", async () => {
      const target = pieceCell("of:fid1:topic-111111");
      const element = await cellLink({
        label: "Open",
        link: "/of:fid1:abcdefghijklmnopqrstuvwxyz",
        runtime: Object.assign(target.runtime(), {
          getCellFromRef: () => target,
        }),
      });
      await shownText(element);

      let resolved: CellHandle | undefined = target;
      const logged = await errorsLogged(async () => {
        resolved = await element.resolveTarget();
      });

      expect(resolved).toBeUndefined();
      expect(logged).toEqual([[
        "Failed to resolve link:",
        new Error("Link missing space."),
      ]]);
    });

    it("logs nothing when a resolution fails after it is detached", async () => {
      const pending = deferred<CellHandle>();
      const cell = Object.assign(pieceCell("of:fid1:row-000000"), {
        resolveAsCell: () => pending.promise,
      });
      const element = await cellLink({ label: "Open", cell });
      await shownText(element);

      let resolved: CellHandle | undefined = cell;
      const logged = await errorsLogged(async () => {
        const resolving = element.resolveTarget();
        element.remove();
        pending.reject(new Error("boom"));
        resolved = await resolving;
      });

      expect(resolved).toBeUndefined();
      expect(logged).toEqual([]);
    });

    it("opens nothing for a click that resolves after it is detached", async () => {
      const pending = deferred<CellHandle>();
      const cell = Object.assign(pieceCell("of:fid1:row-000000"), {
        resolveAsCell: () => pending.promise,
      });
      const element = await cellLink({ label: "Open", cell, isStatic: true });
      await shownText(element);

      const opened = await navigatedToOnceSettled(() => {
        chip(element).click();
        element.remove();
        pending.resolve(pieceCell("of:fid1:topic-111111"));
      });

      expect(opened).toEqual([]);
    });

    it("opens nothing, and warns nothing, for a click whose link changes before its target arrives", async () => {
      const pending = deferred<CellHandle>();
      const cell = Object.assign(pieceCell("of:fid1:row-000000"), {
        resolveAsCell: () => pending.promise,
      });
      const element = await cellLink({ label: "Open", cell, isStatic: true });
      await shownText(element);
      const warnings: unknown[][] = [];
      const originalWarn = console.warn;
      console.warn = (...args: unknown[]) => warnings.push(args);
      let opened: string[] = [];
      try {
        opened = await navigatedToOnceSettled(() => {
          chip(element).click();
          element.cell = linkTo(pieceCell("of:fid1:topic-222222"));
          // The input change lands in the element's next update; the click's
          // target arrives after it.
          void element.updateComplete.then(() =>
            pending.resolve(pieceCell("of:fid1:topic-111111"))
          );
        });
      } finally {
        console.warn = originalWarn;
      }

      expect(opened).toEqual([]);
      expect(warnings).toEqual([]);
    });
  });

  describe("dragging", () => {
    it("starts a drag once the pointer moves more than five pixels", async () => {
      const cell = draggableCell({ $NAME: "Inbox" });
      const element = await cellLink({ cell });
      await shownText(element);

      chip(element).dispatchEvent(pointer("pointerdown", 10, 10));
      document.dispatchEvent(pointer("pointermove", 13, 14));
      expect(isDragging()).toBe(false);

      document.dispatchEvent(pointer("pointermove", 20, 20));
      expect(isDragging()).toBe(true);
      expect(getCurrentDrag()!.cell).toBe(cell);
      expect(element.classList.contains("dragging")).toBe(true);

      document.dispatchEvent(pointer("pointermove", 50, 60));
      expect(getCurrentDrag()!.pointerX).toBe(50);
      expect(getCurrentDrag()!.preview.style.left).toBe("60px");
      expect(getCurrentDrag()!.preview.style.top).toBe("70px");
    });

    it("ends the drag, and swallows the click that follows, when the pointer is released", async () => {
      const element = await cellLink({
        cell: draggableCell({ $NAME: "Inbox" }),
      });
      await shownText(element);
      chip(element).dispatchEvent(pointer("pointerdown", 10, 10));
      document.dispatchEvent(pointer("pointermove", 30, 30));

      document.dispatchEvent(pointer("pointerup", 30, 30));

      expect(isDragging()).toBe(false);
      expect(element.classList.contains("dragging")).toBe(false);
      expect(navigatedTo(() => chip(element).click())).toEqual([]);
    });

    it("follows only the pointer that started it", async () => {
      const element = await cellLink({
        cell: draggableCell({ $NAME: "Inbox" }),
      });
      await shownText(element);
      chip(element).dispatchEvent(pointer("pointerdown", 10, 10, 1));

      document.dispatchEvent(pointer("pointermove", 40, 40, 2));
      expect(isDragging()).toBe(false);

      document.dispatchEvent(pointer("pointermove", 40, 40, 1));
      document.dispatchEvent(pointer("pointerup", 40, 40, 2));
      expect(isDragging()).toBe(true);
    });

    it("ends the drag when it leaves the document", async () => {
      const element = await cellLink({
        cell: draggableCell({ $NAME: "Inbox" }),
      });
      await shownText(element);
      chip(element).dispatchEvent(pointer("pointerdown", 10, 10));
      document.dispatchEvent(pointer("pointermove", 30, 30));

      element.remove();

      expect(isDragging()).toBe(false);
    });

    it("starts no drag when its cell goes away while the pointer is down", async () => {
      const element = await cellLink({
        cell: draggableCell({ $NAME: "Inbox" }),
      });
      await shownText(element);
      chip(element).dispatchEvent(pointer("pointerdown", 10, 10));

      element.cell = undefined;
      await shownText(element);
      document.dispatchEvent(pointer("pointermove", 40, 40));

      expect(isDragging()).toBe(false);
      expect(element.classList.contains("dragging")).toBe(false);
    });

    it("starts no drag when static", async () => {
      const element = await cellLink({
        cell: draggableCell({ $NAME: "Inbox" }),
        isStatic: true,
      });
      await shownText(element);

      chip(element).dispatchEvent(pointer("pointerdown", 10, 10));
      document.dispatchEvent(pointer("pointermove", 40, 40));

      expect(isDragging()).toBe(false);
    });

    it("starts no drag before a cell resolves", async () => {
      const element = await cellLink({ link: "not a link" });
      await shownText(element);

      chip(element).dispatchEvent(pointer("pointerdown", 10, 10));
      document.dispatchEvent(pointer("pointermove", 40, 40));

      expect(isDragging()).toBe(false);
    });
  });
});

describe("CFCellLink drag preview", () => {
  afterEach(() => {
    if (isDragging()) endDrag();
    document.body.replaceChildren();
  });

  /** Starts dragging `element` from (`x`, `y`) to 10 pixels right of it. */
  function drag(element: CFCellLink, x: number, y: number): void {
    chip(element).dispatchEvent(pointer("pointerdown", x - 10, y));
    document.dispatchEvent(pointer("pointermove", x, y));
  }

  it("hands the preview's teardown to the drag state", async () => {
    const cell = draggableCell({
      $UI: { type: "vnode", name: "div", props: {}, children: [] },
    });
    const element = await cellLink({ cell });
    await shownText(element);

    drag(element, 30, 40);

    const drag_ = getCurrentDrag();
    expect(drag_).not.toBeNull();
    expect(drag_!.type).toBe("cell-link");
    expect(drag_!.cell).toBe(cell);
    // Without this the preview's render stays mounted after the drag ends.
    expect(typeof drag_!.previewCleanup).toBe("function");
    expect(drag_!.preview.parentNode).toBe(document.body);
    expect(drag_!.preview.style.left).toBe("40px");
    expect(drag_!.preview.style.top).toBe("50px");
  });

  it("carries the teardown of the render that names the cell in its preview", async () => {
    const cell = draggableCell();
    const element = await cellLink({ cell });
    await shownText(element);

    drag(element, 30, 40);

    expect(getCurrentDrag()!.previewCleanup).toBeDefined();
  });
});
