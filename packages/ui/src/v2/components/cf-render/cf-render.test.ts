import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import type { PropertyValues } from "lit";

import { $conn, type CellHandle } from "@commonfabric/runtime-client";
import { defer } from "@commonfabric/utils/defer";

import { providePieceBoundary } from "../../../../../html/src/main/space-context.ts";
import { createMockCellHandle } from "../../test-utils/mock-cell-handle.ts";
import {
  createMockElement,
  installMockDocument,
} from "../../test-utils/mock-document.ts";
import {
  CFRender,
  hasVariantValue,
  normalizeVariant,
  PIECE_CONTEXT_MENU_EVENT,
  type PieceContextMenuDetail,
} from "./index.ts";

// NOTE: Full rendering lifecycle tests (cell swap cleanup, subscription
// management, render-into-container) require a real DOM with document.body
// and Lit's rendering pipeline. These can't run in Deno's headless test
// runner. The tests below cover what's verifiable without DOM: property
// handling, cell assignment, variant configuration, and disconnectedCallback
// state reset. For full integration tests, use a browser-based test harness.

/** Record what a call logged as an error, leaving the console untouched. */
function captureConsoleError(fn: () => void): unknown[][] {
  const calls: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => calls.push(args);
  try {
    fn();
  } finally {
    console.error = original;
  }
  return calls;
}

describe("CFRender", () => {
  it("should be defined", () => {
    expect(CFRender).toBeDefined();
  });

  it("should have customElement definition", () => {
    expect(CFRender.name).toBe("CFRender");
  });

  it("should create element instance", () => {
    const element = new CFRender();
    expect(element).toBeInstanceOf(CFRender);
  });

  it("should have cell property initially undefined", () => {
    const element = new CFRender();
    expect(element.cell).toBeUndefined();
  });

  it("should have variant property initially undefined", () => {
    const element = new CFRender();
    expect(element.variant).toBeUndefined();
  });

  it("should accept a CellHandle as cell property", () => {
    const element = new CFRender();
    const cell = createMockCellHandle({ ui: "some-vnode" });
    element.cell = cell as CellHandle;
    expect(element.cell).toBe(cell);
  });
});

describe("CFRender variant handling", () => {
  it("should accept variant property", () => {
    const element = new CFRender();
    element.variant = "chip";
    expect(element.variant).toBe("chip");
  });

  it("should accept tile variant", () => {
    const element = new CFRender();
    element.variant = "tile";
    expect(element.variant).toBe("tile");
  });

  it("should accept all valid variants", () => {
    const element = new CFRender();
    const variants = ["full", "chip", "tile"] as const;

    for (const variant of variants) {
      element.variant = variant;
      expect(element.variant).toBe(variant);
    }
  });
});

describe("CFRender render concurrency", () => {
  it("does not resolve a cell after its runtime is disposed", async () => {
    const element = new CFRender();
    const cell = createMockCellHandle<unknown>({});
    Object.assign(cell.runtime(), { signal: AbortSignal.abort() });
    let resolutions = 0;
    cell.resolveAsCell = () => {
      resolutions++;
      return Promise.resolve(cell);
    };
    element.cell = cell;
    element.accessForTestingOnly.containerRef = {
      value: {} as HTMLDivElement,
    };
    await element.accessForTestingOnly.renderCell();
    expect(resolutions).toBe(0);
  });

  it("cleans up the mounted render when its cell is cleared", async () => {
    const element = new CFRender();
    let cleanups = 0;
    const internals = element as unknown as {
      _cleanup?: () => void;
      _containerRef: { value?: HTMLDivElement };
      _renderCell(): Promise<void>;
    };
    internals._containerRef = { value: {} as HTMLDivElement };
    internals._cleanup = () => cleanups++;
    element.cell = undefined;

    await internals._renderCell();

    expect(cleanups).toBe(1);
    expect(internals._cleanup).toBeUndefined();
  });

  it("cleans up an error render when its cell is cleared", async () => {
    const mockDocument = installMockDocument();
    try {
      const element = new CFRender();
      const container = createMockElement("div");
      const internals = element as unknown as {
        _cleanup?: () => void;
        _containerRef: { value?: HTMLDivElement };
        _handleRenderError(error: unknown): void;
        _renderCell(): Promise<void>;
      };
      internals._containerRef = {
        value: container as unknown as HTMLDivElement,
      };
      element.cell = {
        runtime: () => ({ signal: { aborted: false } }),
      } as unknown as CellHandle;

      captureConsoleError(() => {
        internals._handleRenderError(new Error("boom"));
      });
      expect(container.children.map((child) => child.textContent)).toEqual([
        "Error rendering content: boom",
      ]);

      element.cell = undefined;
      await internals._renderCell();

      expect(container.children).toEqual([]);
      expect(internals._cleanup).toBeUndefined();
    } finally {
      mockDocument.restore();
    }
  });

  it("renders a failure message as text rather than as markup", () => {
    const mockDocument = installMockDocument();
    try {
      const element = new CFRender();
      const container = createMockElement("div");
      const internals = element as unknown as {
        _containerRef: { value?: HTMLDivElement };
        _handleRenderError(error: unknown): void;
      };
      internals._containerRef = {
        value: container as unknown as HTMLDivElement,
      };
      element.cell = {
        runtime: () => ({ signal: { aborted: false } }),
      } as unknown as CellHandle;

      captureConsoleError(() => {
        internals._handleRenderError(
          new Error('<img src="x" onerror="alert(1)">'),
        );
      });

      // The message reaches the page whole, as the text of one element, so
      // markup in it describes nothing for the browser to build.
      expect(container.children.length).toBe(1);
      expect(container.children[0].textContent).toBe(
        'Error rendering content: <img src="x" onerror="alert(1)">',
      );
    } finally {
      mockDocument.restore();
    }
  });

  it("shows an unavailable state when a linked target cannot be read", async () => {
    const element = new CFRender();
    element.cell = createMockCellHandle({}) as CellHandle;
    const container = { textContent: "" };
    const internals = element as unknown as {
      _containerRef: { value: HTMLDivElement };
      _watchLinkTarget(): Promise<undefined>;
      _renderCell(): Promise<void>;
      _hasRendered: boolean;
    };
    internals._containerRef = { value: container as HTMLDivElement };
    internals._watchLinkTarget = () => Promise.resolve(undefined);
    await internals._renderCell();
    expect(container.textContent).toBe(
      "This piece is unavailable or you do not have access.",
    );
    expect(internals._hasRendered).toBe(true);
  });

  it("shows asynchronous mount refusals inside the panel", async () => {
    const mockDocument = installMockDocument();
    const element = new CFRender();
    const cell = createMockCellHandle({});
    const refusal = new Error("AuthorizationError: lacks READ");
    Object.assign(cell.runtime(), { signal: new AbortController().signal });
    Object.assign(cell.runtime()[$conn](), {
      onDispose: () => () => {},
      signal: new AbortController().signal,
      attachVDom: () => ({
        onBatch() {},
        offBatch() {},
        detach() {},
        mount: () => Promise.reject(refusal),
        dispose: () => Promise.resolve(),
        unmount: () => Promise.resolve(),
      }),
    });
    const container = createMockElement("div");
    const internals = element as unknown as {
      _containerRef: { value: HTMLDivElement };
      _renderCell(): Promise<void>;
      _handleRenderError(error: unknown): void;
    };
    internals._containerRef = {
      value: container as unknown as HTMLDivElement,
    };
    const rendered = defer<void>();
    const handleError = internals._handleRenderError.bind(element);
    internals._handleRenderError = (error) => {
      captureConsoleError(() => handleError(error));
      rendered.resolve();
    };
    element.cell = cell;
    try {
      await internals._renderCell();
      await rendered.promise;
      expect(container.children.map((child) => child.textContent)).toEqual([
        "Error rendering content: AuthorizationError: lacks READ",
      ]);
    } finally {
      element.disconnectedCallback();
      mockDocument.restore();
    }
  });

  it("accepts a retarget delivered before subscribe returns", async () => {
    const link = createMockCellHandle({ name: "piece link" }, {
      id: "of:fid1:link-holder" as never,
      space: "did:key:zSpace" as never,
      path: ["piece"],
    }) as CellHandle;
    const target = createMockCellHandle({ name: "piece" }, {
      id: "of:fid1:piece" as never,
      space: "did:key:zSpace" as never,
    }) as CellHandle;
    const nextTarget = createMockCellHandle({ name: "next piece" }, {
      id: "of:fid1:next-piece" as never,
      space: "did:key:zSpace" as never,
    }) as CellHandle;
    (link as unknown as {
      asSchema(): {
        sync(): Promise<CellHandle | undefined>;
        subscribe(
          callback: (value: CellHandle | undefined) => void,
        ): () => void;
      };
    }).asSchema = () => ({
      sync: () => Promise.resolve(target),
      subscribe(callback) {
        callback(target);
        callback(nextTarget);
        return () => {};
      },
    });

    const element = new CFRender();
    element.cell = link;
    let renders = 0;
    const internals = element as unknown as {
      _cleanupLinkTargetSubscription(): void;
      _renderCell(): Promise<void>;
      _watchLinkTarget(
        cell: CellHandle,
        resolved: CellHandle,
      ): Promise<CellHandle | undefined>;
    };
    internals._renderCell = () => {
      renders++;
      return Promise.resolve();
    };

    await internals._watchLinkTarget(link, target);
    expect(renders).toBe(1);
    internals._cleanupLinkTargetSubscription();
  });

  it("does not rerender when the followed target identity is unchanged", async () => {
    const link = createMockCellHandle({ name: "piece link" }, {
      id: "of:fid1:link-holder" as never,
      space: "did:key:zSpace" as never,
      path: ["piece"],
    }) as CellHandle;
    const target = createMockCellHandle({ name: "piece" }, {
      id: "of:fid1:piece" as never,
      space: "did:key:zSpace" as never,
    }) as CellHandle;
    let update: ((value: CellHandle | undefined) => void) | undefined;
    (link as unknown as {
      asSchema(): {
        sync(): Promise<CellHandle | undefined>;
        subscribe(
          callback: (value: CellHandle | undefined) => void,
        ): () => void;
      };
    }).asSchema = () => ({
      sync: () => Promise.resolve(target),
      subscribe(callback) {
        callback(target);
        update = callback;
        return () => {};
      },
    });

    const element = new CFRender();
    element.cell = link;
    let renders = 0;
    const internals = element as unknown as {
      _cleanupLinkTargetSubscription(): void;
      _renderCell(): Promise<void>;
      _watchLinkTarget(
        cell: CellHandle,
        resolved: CellHandle,
      ): Promise<CellHandle | undefined>;
    };
    internals._renderCell = () => {
      renders++;
      return Promise.resolve();
    };

    await internals._watchLinkTarget(link, target);
    update?.(target);
    update?.(target);

    expect(renders).toBe(0);
    internals._cleanupLinkTargetSubscription();
  });

  it("rerenders when only the followed target scope changes", async () => {
    const link = createMockCellHandle({ name: "piece link" }, {
      id: "of:fid1:link-holder" as never,
      space: "did:key:zSpace" as never,
      path: ["piece"],
    }) as CellHandle;
    const spaceTarget = createMockCellHandle({ name: "space piece" }, {
      id: "of:fid1:piece" as never,
      space: "did:key:zSpace" as never,
      scope: "space",
    }) as CellHandle;
    const userTarget = createMockCellHandle({ name: "user piece" }, {
      id: "of:fid1:piece" as never,
      space: "did:key:zSpace" as never,
      scope: "user",
    }) as CellHandle;
    let update: ((value: CellHandle | undefined) => void) | undefined;
    (link as unknown as {
      asSchema(): {
        sync(): Promise<CellHandle | undefined>;
        subscribe(
          callback: (value: CellHandle | undefined) => void,
        ): () => void;
      };
    }).asSchema = () => ({
      sync: () => Promise.resolve(spaceTarget),
      subscribe(callback) {
        callback(spaceTarget);
        update = callback;
        return () => {};
      },
    });

    const element = new CFRender();
    element.cell = link;
    let renders = 0;
    const internals = element as unknown as {
      _cleanupLinkTargetSubscription(): void;
      _renderCell(): Promise<void>;
      _watchLinkTarget(
        cell: CellHandle,
        resolved: CellHandle,
      ): Promise<CellHandle | undefined>;
    };
    internals._renderCell = () => {
      renders++;
      return Promise.resolve();
    };

    await internals._watchLinkTarget(link, spaceTarget);
    update?.(userTarget);

    expect(renders).toBe(1);
    internals._cleanupLinkTargetSubscription();
  });

  it("clears a missing target and rerenders when the target returns", async () => {
    const link = createMockCellHandle({ name: "piece link" }, {
      id: "of:fid1:link-holder" as never,
      space: "did:key:zSpace" as never,
      path: ["piece"],
    }) as CellHandle;
    const target = createMockCellHandle({ name: "piece" }, {
      id: "of:fid1:piece" as never,
      space: "did:key:zSpace" as never,
    }) as CellHandle;
    let update: ((value: CellHandle | undefined) => void) | undefined;
    (link as unknown as {
      asSchema(): {
        sync(): Promise<CellHandle | undefined>;
        subscribe(
          callback: (value: CellHandle | undefined) => void,
        ): () => void;
      };
    }).asSchema = () => ({
      sync: () => Promise.resolve(target),
      subscribe(callback) {
        callback(target);
        update = callback;
        return () => {};
      },
    });

    const element = new CFRender();
    element.cell = link;
    let cleanups = 0;
    let renders = 0;
    const internals = element as unknown as {
      _cleanup?: () => void;
      _cleanupLinkTargetSubscription(): void;
      _hasRendered: boolean;
      _renderCell(): Promise<void>;
      _resolvedCell?: CellHandle;
      _watchLinkTarget(
        cell: CellHandle,
        resolved: CellHandle,
      ): Promise<CellHandle | undefined>;
    };
    internals._cleanup = () => cleanups++;
    internals._renderCell = () => {
      renders++;
      return Promise.resolve();
    };

    expect(await internals._watchLinkTarget(link, target)).toBe(target);
    update?.(undefined);
    expect(cleanups).toBe(1);
    expect(renders).toBe(0);
    expect(internals._resolvedCell).toBeUndefined();
    expect(internals._hasRendered).toBe(true);

    update?.(target);
    expect(renders).toBe(1);
    internals._cleanupLinkTargetSubscription();
  });

  it("keeps watching an empty link across a variant change", async () => {
    const link = createMockCellHandle({ name: "piece link" }, {
      id: "of:fid1:link-holder" as never,
      space: "did:key:zSpace" as never,
      path: ["piece"],
    }) as CellHandle;
    const target = createMockCellHandle({ name: "piece" }, {
      id: "of:fid1:piece" as never,
      space: "did:key:zSpace" as never,
    }) as CellHandle;
    (target as unknown as { sync(): Promise<unknown> }).sync = () =>
      Promise.resolve();

    let currentTarget: CellHandle | undefined = target;
    let publish: ((value: CellHandle | undefined) => void) | undefined;
    let unsubscribes = 0;
    (link as unknown as { resolveAsCell(): Promise<CellHandle> })
      .resolveAsCell = () => Promise.resolve(currentTarget ?? link);
    (link as unknown as {
      asSchema(): {
        sync(): Promise<CellHandle | undefined>;
        subscribe(
          callback: (value: CellHandle | undefined) => void,
        ): () => void;
      };
    }).asSchema = () => ({
      sync: () => Promise.resolve(currentTarget),
      subscribe(callback) {
        callback(currentTarget);
        publish = (value) => {
          currentTarget = value;
          callback(value);
        };
        return () => unsubscribes++;
      },
    });

    const restored = defer();
    let renders = 0;
    const element = new CFRender();
    const internals = element as unknown as {
      _cleanupLinkTargetSubscription(): void;
      _containerRef: { value?: HTMLDivElement };
      _linkTargetUnsubscribe?: () => void;
      _renderCell(): Promise<void>;
      _renderChipDefault(
        container: HTMLElement,
        cell: CellHandle,
      ): () => void;
      _renderTileDefault(
        container: HTMLElement,
        cell: CellHandle,
      ): () => void;
      _resolvedCell?: CellHandle;
    };
    internals._containerRef = { value: {} as HTMLDivElement };
    const renderDefault = (_container: HTMLElement, cell: CellHandle) => {
      expect(cell).toBe(target);
      renders++;
      if (renders === 2) restored.resolve();
      return () => {};
    };
    internals._renderChipDefault = renderDefault;
    internals._renderTileDefault = renderDefault;
    element.cell = link;
    element.variant = "chip";

    await internals._renderCell();
    expect(renders).toBe(1);
    expect(internals._resolvedCell).toBe(target);

    publish?.(undefined);
    element.variant = "tile";
    await internals._renderCell();
    expect(internals._resolvedCell).toBeUndefined();
    expect(internals._linkTargetUnsubscribe).toBeDefined();
    expect(unsubscribes).toBe(0);

    publish?.(target);
    await restored.promise;
    expect(renders).toBe(2);
    expect(internals._resolvedCell).toBe(target);

    internals._cleanupLinkTargetSubscription();
    expect(unsubscribes).toBe(1);
  });

  it("reuses pending target setup across an empty-link variant change", async () => {
    const targetSync = defer<CellHandle | undefined>();
    const syncEntered = defer();
    const restored = defer();
    const link = createMockCellHandle({ name: "piece link" }, {
      id: "of:fid1:link-holder" as never,
      space: "did:key:zSpace" as never,
      path: ["piece"],
    }) as CellHandle;
    const target = createMockCellHandle({ name: "piece" }, {
      id: "of:fid1:piece" as never,
      space: "did:key:zSpace" as never,
    }) as CellHandle;
    (target as unknown as { sync(): Promise<unknown> }).sync = () =>
      Promise.resolve();

    let currentTarget: CellHandle | undefined = target;
    let publish: ((value: CellHandle | undefined) => void) | undefined;
    let subscriptions = 0;
    let unsubscribes = 0;
    (link as unknown as { resolveAsCell(): Promise<CellHandle> })
      .resolveAsCell = () => Promise.resolve(currentTarget ?? link);
    (link as unknown as {
      asSchema(): {
        sync(): Promise<CellHandle | undefined>;
        subscribe(
          callback: (value: CellHandle | undefined) => void,
        ): () => void;
      };
    }).asSchema = () => ({
      sync() {
        syncEntered.resolve();
        return targetSync.promise;
      },
      subscribe(callback) {
        subscriptions++;
        callback(currentTarget);
        publish = (value) => {
          currentTarget = value;
          callback(value);
        };
        return () => unsubscribes++;
      },
    });

    const element = new CFRender();
    const internals = element as unknown as {
      _cleanupLinkTargetSubscription(): void;
      _containerRef: { value?: HTMLDivElement };
      _renderCell(): Promise<void>;
      _renderTileDefault(
        container: HTMLElement,
        cell: CellHandle,
      ): () => void;
      _resolvedCell?: CellHandle;
    };
    internals._containerRef = { value: {} as HTMLDivElement };
    internals._renderTileDefault = (_container, cell) => {
      expect(cell).toBe(target);
      restored.resolve();
      return () => {};
    };
    element.cell = link;
    element.variant = "chip";

    const firstRender = internals._renderCell();
    await syncEntered.promise;

    currentTarget = undefined;
    element.variant = "tile";
    const variantRender = internals._renderCell();
    targetSync.resolve(undefined);
    await Promise.all([firstRender, variantRender]);

    expect(internals._resolvedCell).toBeUndefined();
    expect(subscriptions).toBe(1);
    expect(unsubscribes).toBe(0);

    publish?.(target);
    await restored.promise;
    expect(internals._resolvedCell).toBe(target);

    internals._cleanupLinkTargetSubscription();
    expect(unsubscribes).toBe(1);
  });

  it("observes a target cleared between resolution and subscription", async () => {
    const link = createMockCellHandle({ name: "piece link" }, {
      id: "of:fid1:link-holder" as never,
      space: "did:key:zSpace" as never,
      path: ["piece"],
    }) as CellHandle;
    const staleTarget = createMockCellHandle({ name: "stale piece" }, {
      id: "of:fid1:stale-piece" as never,
      space: "did:key:zSpace" as never,
    }) as CellHandle;
    const nextTarget = createMockCellHandle({ name: "next piece" }, {
      id: "of:fid1:next-piece" as never,
      space: "did:key:zSpace" as never,
    }) as CellHandle;
    let update: ((value: CellHandle | undefined) => void) | undefined;
    (link as unknown as {
      asSchema(): {
        sync(): Promise<CellHandle | undefined>;
        subscribe(
          callback: (value: CellHandle | undefined) => void,
        ): () => void;
      };
    }).asSchema = () => ({
      sync: () => Promise.resolve(undefined),
      subscribe(callback) {
        callback(undefined);
        update = callback;
        return () => {};
      },
    });

    const element = new CFRender();
    element.cell = link;
    let renders = 0;
    const internals = element as unknown as {
      _cleanupLinkTargetSubscription(): void;
      _renderCell(): Promise<void>;
      _watchLinkTarget(
        cell: CellHandle,
        resolved: CellHandle,
      ): Promise<CellHandle | undefined>;
    };
    internals._renderCell = () => {
      renders++;
      return Promise.resolve();
    };

    expect(await internals._watchLinkTarget(link, staleTarget)).toBeUndefined();
    expect(renders).toBe(0);

    update?.(nextTarget);
    expect(renders).toBe(1);
    internals._cleanupLinkTargetSubscription();
  });

  it("does not subscribe after disconnecting during target sync", async () => {
    const targetSync = defer<CellHandle | undefined>();
    const link = createMockCellHandle({ name: "piece link" }, {
      id: "of:fid1:link-holder" as never,
      space: "did:key:zSpace" as never,
      path: ["piece"],
    }) as CellHandle;
    const target = createMockCellHandle({ name: "piece" }, {
      id: "of:fid1:piece" as never,
      space: "did:key:zSpace" as never,
    }) as CellHandle;
    let subscriptions = 0;
    (link as unknown as {
      asSchema(): {
        sync(): Promise<CellHandle | undefined>;
        subscribe(
          callback: (value: CellHandle | undefined) => void,
        ): () => void;
      };
    }).asSchema = () => ({
      sync: () => targetSync.promise,
      subscribe() {
        subscriptions++;
        return () => {};
      },
    });

    const element = new CFRender();
    element.cell = link;
    const internals = element as unknown as {
      _watchLinkTarget(
        cell: CellHandle,
        resolved: CellHandle,
      ): Promise<CellHandle | undefined>;
    };

    const watching = internals._watchLinkTarget(link, target);
    element.disconnectedCallback();
    targetSync.resolve(target);

    expect(await watching).toBeUndefined();
    expect(subscriptions).toBe(0);
  });

  it("reuses one target sync for overlapping same-cell watches", async () => {
    const targetSync = defer<CellHandle | undefined>();
    const link = createMockCellHandle({ name: "piece link" }, {
      id: "of:fid1:link-holder" as never,
      space: "did:key:zSpace" as never,
      path: ["piece"],
    }) as CellHandle;
    const target = createMockCellHandle({ name: "piece" }, {
      id: "of:fid1:piece" as never,
      space: "did:key:zSpace" as never,
    }) as CellHandle;
    let syncs = 0;
    let subscriptions = 0;
    (link as unknown as {
      asSchema(): {
        sync(): Promise<CellHandle | undefined>;
        subscribe(
          callback: (value: CellHandle | undefined) => void,
        ): () => void;
      };
    }).asSchema = () => ({
      sync() {
        syncs++;
        return targetSync.promise;
      },
      subscribe(callback) {
        subscriptions++;
        callback(target);
        return () => {};
      },
    });

    const element = new CFRender();
    element.cell = link;
    const internals = element as unknown as {
      _cleanupLinkTargetSubscription(): void;
      _watchLinkTarget(
        cell: CellHandle,
        resolved: CellHandle,
      ): Promise<CellHandle | undefined>;
    };

    const firstWatch = internals._watchLinkTarget(link, target);
    const secondWatch = internals._watchLinkTarget(link, target);

    expect(syncs).toBe(1);
    targetSync.resolve(target);
    expect(await firstWatch).toBe(target);
    expect(await secondWatch).toBe(target);
    expect(subscriptions).toBe(1);
    internals._cleanupLinkTargetSubscription();
  });

  it("drops a delayed resolution after switching spaces", async () => {
    const firstResolution = defer<CellHandle>();
    const secondResolution = defer<CellHandle>();
    const sharedId = "of:fid1:shared-piece" as never;
    const first = createMockCellHandle({ name: "first link" }, {
      id: sharedId,
      space: "did:key:zFirstSpace" as never,
      path: ["piece"],
    }) as CellHandle;
    const second = createMockCellHandle({ name: "second link" }, {
      id: sharedId,
      space: "did:key:zSecondSpace" as never,
      path: ["piece"],
    }) as CellHandle;
    const firstTarget = createMockCellHandle({ name: "first piece" }, {
      id: sharedId,
      space: "did:key:zFirstSpace" as never,
    }) as CellHandle;
    const secondTarget = createMockCellHandle({ name: "second piece" }, {
      id: sharedId,
      space: "did:key:zSecondSpace" as never,
    }) as CellHandle;
    (first as unknown as { resolveAsCell(): Promise<CellHandle> })
      .resolveAsCell = () => firstResolution.promise;
    (second as unknown as { resolveAsCell(): Promise<CellHandle> })
      .resolveAsCell = () => secondResolution.promise;
    (second as unknown as {
      asSchema(): {
        sync(): Promise<CellHandle | undefined>;
        subscribe(
          callback: (value: CellHandle | undefined) => void,
        ): () => void;
      };
    }).asSchema = () => ({
      sync: () => Promise.resolve(secondTarget),
      subscribe(callback) {
        callback(secondTarget);
        return () => {};
      },
    });

    const element = new CFRender();
    const internals = element as unknown as {
      _containerRef: { value?: HTMLDivElement };
      _handleRenderError(error: unknown): void;
      _renderCell(): Promise<void>;
      _resolvedCell?: CellHandle;
    };
    internals._containerRef = { value: {} as HTMLDivElement };
    internals._handleRenderError = () => {};
    element.variant = "full";

    element.cell = first;
    const firstRender = internals._renderCell();
    element.cell = second;
    const secondRender = internals._renderCell();

    firstResolution.resolve(firstTarget);
    await firstRender;
    expect(internals._resolvedCell).toBeUndefined();

    secondResolution.resolve(secondTarget);
    await secondRender;
    expect(internals._resolvedCell).toBe(secondTarget);
  });

  it("re-resolves a link when its target changes", async () => {
    const secondResolutionEntered = defer();
    const secondResolution = defer<CellHandle>();
    const secondRendered = defer();
    const link = createMockCellHandle({ name: "piece link" }, {
      id: "of:fid1:link-holder" as never,
      space: "did:key:zSpace" as never,
      path: ["piece"],
    }) as CellHandle;
    const firstTarget = createMockCellHandle({ name: "first piece" }, {
      id: "of:fid1:first-piece" as never,
      space: "did:key:zSpace" as never,
    }) as CellHandle;
    const secondTarget = createMockCellHandle({ name: "second piece" }, {
      id: "of:fid1:second-piece" as never,
      space: "did:key:zSpace" as never,
    }) as CellHandle;
    (firstTarget as unknown as { sync(): Promise<unknown> }).sync = () =>
      Promise.resolve();
    (secondTarget as unknown as { sync(): Promise<unknown> }).sync = () =>
      Promise.resolve();

    let resolveCount = 0;
    (link as unknown as { resolveAsCell(): Promise<CellHandle> })
      .resolveAsCell = () => {
        resolveCount++;
        if (resolveCount === 1) return Promise.resolve(firstTarget);
        secondResolutionEntered.resolve();
        return secondResolution.promise;
      };
    const retargets: Array<
      (value: CellHandle | undefined) => void
    > = [];
    (link as unknown as {
      asSchema(): {
        sync(): Promise<CellHandle | undefined>;
        subscribe(
          callback: (value: CellHandle | undefined) => void,
        ): () => void;
      };
    }).asSchema = () => ({
      sync: () =>
        Promise.resolve(
          retargets.length === 0 ? firstTarget : secondTarget,
        ),
      subscribe(callback) {
        callback(retargets.length === 0 ? firstTarget : secondTarget);
        retargets.push(callback);
        return () => {};
      },
    });

    const element = new CFRender();
    const internals = element as unknown as {
      _containerRef: { value?: HTMLDivElement };
      _cleanupLinkTargetSubscription(): void;
      _renderCell(): Promise<void>;
      _renderChipDefault(
        container: HTMLElement,
        cell: CellHandle,
      ): () => void;
      _resolvedCell?: CellHandle;
      _watchLinkTarget(
        cell: CellHandle,
        resolved: CellHandle,
      ): Promise<CellHandle | undefined>;
    };
    internals._containerRef = { value: {} as HTMLDivElement };
    internals._renderChipDefault = (_container, cell) => {
      if (cell === secondTarget) secondRendered.resolve();
      return () => {};
    };
    element.variant = "chip";
    element.cell = link;

    await internals._renderCell();
    expect(internals._resolvedCell).toBe(firstTarget);

    retargets[0](secondTarget);
    await secondResolutionEntered.promise;
    secondResolution.resolve(secondTarget);
    await secondRendered.promise;
    expect(internals._resolvedCell).toBe(secondTarget);

    const oldRetarget = retargets[0];
    internals._cleanupLinkTargetSubscription();
    await internals._watchLinkTarget(link, secondTarget);
    expect(retargets).toHaveLength(2);
    oldRetarget(firstTarget);
    await Promise.resolve();
    expect(resolveCount).toBe(2);

    const queuedRetarget = retargets[1];
    element.disconnectedCallback();
    queuedRetarget(firstTarget);
    await Promise.resolve();
    expect(resolveCount).toBe(2);
  });
});

describe("normalizeVariant", () => {
  it("passes through the known spectrum", () => {
    expect(normalizeVariant("full")).toBe("full");
    expect(normalizeVariant("chip")).toBe("chip");
    expect(normalizeVariant("tile")).toBe("tile");
  });

  it("falls back to full for undefined and unknown/legacy values", () => {
    expect(normalizeVariant(undefined)).toBe("full");
    expect(normalizeVariant("")).toBe("full");
    expect(normalizeVariant("default")).toBe("full");
    expect(normalizeVariant("preview")).toBe("full");
    expect(normalizeVariant("embedded")).toBe("full");
  });
});

describe("hasVariantValue", () => {
  it("is true only when the key holds a renderable value", () => {
    expect(hasVariantValue({ "$CHIP_UI": { type: "vnode" } }, "$CHIP_UI"))
      .toBe(true);
    expect(hasVariantValue({ "$UI": {} }, "$TILE_UI")).toBe(false);
    expect(hasVariantValue({ "$TILE_UI": undefined }, "$TILE_UI")).toBe(false);
    expect(hasVariantValue({ "$TILE_UI": null }, "$TILE_UI")).toBe(false);
  });

  it("is false for non-object / empty values (failover to default)", () => {
    expect(hasVariantValue(undefined, "$CHIP_UI")).toBe(false);
    expect(hasVariantValue(null, "$CHIP_UI")).toBe(false);
    expect(hasVariantValue("nope", "$CHIP_UI")).toBe(false);
    expect(hasVariantValue({}, "$CHIP_UI")).toBe(false);
  });
});

describe("CFRender render-error handling", () => {
  function cellWithSignal(aborted: boolean): CellHandle {
    return {
      runtime: () => ({ signal: { aborted } }),
    } as unknown as CellHandle;
  }

  it("logs render errors while the runtime is alive", () => {
    const element = new CFRender();
    element.cell = cellWithSignal(false);
    const calls = captureConsoleError(() => {
      (element as unknown as { _handleRenderError(e: unknown): void })
        ._handleRenderError(new Error("boom"));
    });
    expect(calls.length).toBe(1);
  });

  it("suppresses render-error logging when the runtime is disposed", () => {
    const element = new CFRender();
    element.cell = cellWithSignal(true);
    const calls = captureConsoleError(() => {
      (element as unknown as { _handleRenderError(e: unknown): void })
        ._handleRenderError(new DOMException("aborted", "AbortError"));
    });
    expect(calls.length).toBe(0);
  });
});

describe("CFRender tile navigation", () => {
  /** Collect the navigation events the shell (or an embedder) listens for. */
  function captureNavigation(name: string, run: () => void): unknown[] {
    const seen: unknown[] = [];
    const listener = (e: Event) => seen.push((e as CustomEvent).detail);
    globalThis.addEventListener(name, listener);
    try {
      run();
    } finally {
      globalThis.removeEventListener(name, listener);
    }
    return seen;
  }

  function tileClick(modifiers: Partial<MouseEvent> = {}): MouseEvent {
    return {
      stopPropagation: () => {},
      ...modifiers,
    } as unknown as MouseEvent;
  }

  function navigatingElement(): CFRender {
    const element = new CFRender();
    element.cell = createMockCellHandle({ name: "piece" }, {
      id: "of:fid1:tile-piece" as never,
      space: "did:key:zSpace" as never,
    }) as CellHandle;
    return element;
  }

  it("keeps the linked piece scope in tile navigation", () => {
    const element = navigatingElement();
    element.cell = createMockCellHandle({}, {
      id: "of:fid1:same" as never,
      space: "did:key:foreign" as never,
      scope: "session",
    }) as CellHandle;
    const seen = captureNavigation("cf-navigate", () => {
      (element as unknown as { _navigateToPiece(e: MouseEvent): void })
        ._navigateToPiece(tileClick());
    });
    expect(seen).toEqual([{
      spaceDid: "did:key:foreign",
      pieceId: "of:fid1:same",
      pieceScope: "session",
    }]);
  });

  it("keeps the linked cell path in tile navigation", () => {
    const element = navigatingElement();
    element.cell = createMockCellHandle({}, {
      id: "of:fid1:same" as never,
      space: "did:key:foreign" as never,
      scope: "session",
      path: ["view", "a/b"],
    }) as CellHandle;
    const seen = captureNavigation("cf-navigate", () => {
      (element as unknown as { _navigateToPiece(e: MouseEvent): void })
        ._navigateToPiece(tileClick());
    });
    expect(seen).toEqual([{
      spaceDid: "did:key:foreign",
      pieceId: "of:fid1:same",
      pieceScope: "session",
      piecePath: ["view", "a/b"],
    }]);
  });

  it("navigates to the piece a clicked tile renders", () => {
    const element = navigatingElement();
    const seen = captureNavigation("cf-navigate", () => {
      (element as unknown as { _navigateToPiece(e: MouseEvent): void })
        ._navigateToPiece(tileClick());
    });

    expect(seen).toEqual([{
      spaceDid: "did:key:zSpace",
      pieceId: "of:fid1:tile-piece",
    }]);
  });

  it("offers the same target to a host on a modifier-click", () => {
    const element = navigatingElement();
    // The new-tab hook is cancellable so a host can own the new tab; cancelling
    // it here keeps the shell's `globalThis.open` fallback out of the test.
    const seen = captureNavigation("cf-open-external", () => {
      globalThis.addEventListener(
        "cf-open-external",
        (e: Event) => e.preventDefault(),
        { once: true },
      );
      (element as unknown as { _navigateToPiece(e: MouseEvent): void })
        ._navigateToPiece(tileClick({ metaKey: true }));
    });

    expect(seen).toEqual([{
      spaceDid: "did:key:zSpace",
      pieceId: "of:fid1:tile-piece",
    }]);
  });

  it("reports a navigation it could not address, rather than throwing", () => {
    const element = new CFRender();
    element.cell = {
      space: () => {
        throw new Error("no space");
      },
      id: () => "of:fid1:tile-piece",
    } as unknown as CellHandle;

    const calls = captureConsoleError(() => {
      (element as unknown as { _navigateToPiece(e: MouseEvent): void })
        ._navigateToPiece(tileClick());
    });
    expect(calls.length).toBe(1);
  });
});

describe("CFRender disconnectedCallback", () => {
  it("rerenders once after reconnecting with an equal queued cell update", async () => {
    class LifecycleRender extends CFRender {
      /** Runs the update hook without requiring Lit's DOM pipeline. */
      flushUpdated(changes: PropertyValues): void {
        super.updated(changes);
      }

      protected override createRenderRoot(): HTMLElement | DocumentFragment {
        return { adoptedStyleSheets: [] } as unknown as DocumentFragment;
      }

      protected override performUpdate(): void {}
    }
    const element = new LifecycleRender();
    const cell = createMockCellHandle<unknown>({ name: "stable" });
    let connected = true;
    Object.defineProperty(element, "isConnected", { get: () => connected });
    element.hasUpdated = true;
    element.cell = cell;
    element.flushUpdated(new Map([["cell", undefined]]));
    expect(element.accessForTestingOnly.renderGeneration).toBe(1);

    connected = false;
    element.disconnectedCallback();
    const equal = await cell.resolveAsCell();
    element.cell = equal;
    element.flushUpdated(new Map([["cell", cell]]));
    expect(element.accessForTestingOnly.renderGeneration).toBe(2);
    connected = true;
    element.connectedCallback();
    element.flushUpdated(new Map([["cell", cell]]));
    expect(element.accessForTestingOnly.renderGeneration).toBe(3);
    element.flushUpdated(new Map());
    expect(element.accessForTestingOnly.renderGeneration).toBe(3);
    element.disconnectedCallback();
  });

  it("listens for right-clicks while connected, and stops when disconnected", () => {
    const element = new CFRender();
    const listened: string[] = [];
    const removed: string[] = [];
    (element as unknown as { addEventListener(t: string): void })
      .addEventListener = (type: string) => listened.push(type);
    (element as unknown as { removeEventListener(t: string): void })
      .removeEventListener = (type: string) => removed.push(type);
    // Connecting makes Lit build a render root and schedule its first update,
    // both of which want a DOM. This test is about the listener the callback
    // wires, not about rendering.
    (element as unknown as { createRenderRoot(): unknown }).createRenderRoot =
      () => ({ adoptedStyleSheets: [] });
    (element as unknown as { performUpdate(): void }).performUpdate = () => {};

    element.connectedCallback();
    element.disconnectedCallback();

    expect(listened).toContain("contextmenu");
    expect(removed).toContain("contextmenu");
  });

  it("should reset state on disconnect", () => {
    const element = new CFRender();
    const cell = createMockCellHandle({ name: "test" });
    element.cell = cell as CellHandle;
    element.variant = "chip";

    // disconnectedCallback should clean up internal state without throwing
    element.disconnectedCallback();

    // Cell and variant are Lit properties — not cleared by disconnectedCallback
    // (Lit preserves properties across disconnect/reconnect).
    // The internal render generation and _hasRendered are reset though.
    // We verify it doesn't throw and the element is still usable.
    expect(element.cell).toBe(cell);
    expect(element.variant).toBe("chip");
  });

  it("should handle disconnect when no cell was set", () => {
    const element = new CFRender();
    // Should not throw even with no cell
    element.disconnectedCallback();
  });
});

describe("CFRender piece context menu", () => {
  /** A right-click, recording whether the platform menu was suppressed. */
  function contextMenuEvent(
    deepestTarget?: EventTarget,
    modifiers: { shiftKey?: boolean } = {},
    ancestors: EventTarget[] = [],
  ): MouseEvent & { defaultPrevented: boolean; propagationStopped: boolean } {
    const event = {
      clientX: 120,
      clientY: 48,
      shiftKey: modifiers.shiftKey ?? false,
      defaultPrevented: false,
      propagationStopped: false,
      composedPath: () => (deepestTarget ? [deepestTarget, ...ancestors] : []),
      preventDefault() {
        event.defaultPrevented = true;
      },
      stopPropagation() {
        event.propagationStopped = true;
      },
    };
    return event as unknown as MouseEvent & {
      defaultPrevented: boolean;
      propagationStopped: boolean;
    };
  }

  /**
   * Right-click `element`, with a listener that cancels the announcement — what
   * a host showing its own menu does, and what these tests use because opening
   * the built-in menu needs a real DOM (see the shell's integration test).
   */
  function rightClick(
    element: CFRender,
    event: ReturnType<typeof contextMenuEvent>,
  ): PieceContextMenuDetail | undefined {
    let detail: PieceContextMenuDetail | undefined;
    element.addEventListener(PIECE_CONTEXT_MENU_EVENT, (e: Event) => {
      detail = (e as CustomEvent<PieceContextMenuDetail>).detail;
      e.preventDefault();
    });
    (element as unknown as { _onContextMenu(e: MouseEvent): void })
      ._onContextMenu(event);
    return detail;
  }

  it("announces the piece under the pointer and takes the click", () => {
    const element = new CFRender();
    element.cell = createMockCellHandle({ name: "piece" }, {
      id: "of:fid1:piece" as never,
      space: "did:key:zSpace" as never,
    }) as CellHandle;
    const event = contextMenuEvent();
    const detail = rightClick(element, event);

    expect(detail).toEqual({
      space: "did:key:zSpace",
      pieceId: "of:fid1:piece",
      x: 120,
      y: 48,
      variant: "full",
    });
    // The platform menu is suppressed, and an enclosing piece does not also
    // claim the click.
    expect(event.defaultPrevented).toBe(true);
    expect(event.propagationStopped).toBe(true);
  });

  it("leaves the click alone when the rendered cell is not a whole piece", () => {
    const element = new CFRender();
    element.cell = createMockCellHandle({ name: "piece" }, {
      id: "of:fid1:piece" as never,
      space: "did:key:zSpace" as never,
      path: ["items", "0"],
    }) as CellHandle;
    const event = contextMenuEvent();

    expect(rightClick(element, event)).toBeUndefined();
    expect(event.defaultPrevented).toBe(false);
  });

  it("leaves text entry to the platform menu", () => {
    const element = new CFRender();
    element.cell = createMockCellHandle({ name: "piece" }, {
      id: "of:fid1:piece" as never,
      space: "did:key:zSpace" as never,
    }) as CellHandle;
    const event = contextMenuEvent(
      { tagName: "TEXTAREA" } as unknown as EventTarget,
    );

    expect(rightClick(element, event)).toBeUndefined();
    expect(event.defaultPrevented).toBe(false);
  });

  it("leaves a shift-held click to the platform menu", () => {
    const element = new CFRender();
    element.cell = createMockCellHandle({ name: "piece" }, {
      id: "of:fid1:piece" as never,
      space: "did:key:zSpace" as never,
    }) as CellHandle;
    const event = contextMenuEvent(undefined, { shiftKey: true });

    expect(rightClick(element, event)).toBeUndefined();
    expect(event.defaultPrevented).toBe(false);
  });

  it("opens the built-in menu when no host takes the click", () => {
    // The menu mounts on document.body, outside the piece — see cf-piece-menu.

    const mounted: unknown[] = [];
    const closedFor: Element[] = [];
    const original = Object.getOwnPropertyDescriptor(globalThis, "document");
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      writable: true,
      value: {
        createElement: () => ({
          open: () => {},
          close: () => {},
          closeFor: (piece: Element) => closedFor.push(piece),
          style: { setProperty: () => {}, removeProperty: () => {} },
        }),
        body: {
          appendChild: (element: unknown) => {
            mounted.push(element);
            (element as { isConnected?: boolean }).isConnected = true;
            return element;
          },
        },
      },
    });
    const originalComputed = Object.getOwnPropertyDescriptor(
      globalThis,
      "getComputedStyle",
    );
    Object.defineProperty(globalThis, "getComputedStyle", {
      configurable: true,
      writable: true,
      value: () => ({ getPropertyValue: () => "" }),
    });

    try {
      const element = new CFRender();
      element.cell = createMockCellHandle({ name: "piece" }, {
        id: "of:fid1:piece" as never,
        space: "did:key:zSpace" as never,
      }) as CellHandle;
      const event = contextMenuEvent();

      // No listener at all: the announcement goes uncancelled and cf-render
      // opens the menu itself.
      (element as unknown as { _onContextMenu(e: MouseEvent): void })
        ._onContextMenu(event);

      expect(mounted.length).toBe(1);
      expect(event.defaultPrevented).toBe(true);

      element.disconnectedCallback();
      expect(closedFor).toHaveLength(1);
      expect(closedFor[0]).toBe(element);
    } finally {
      if (original) Object.defineProperty(globalThis, "document", original);
      else Reflect.deleteProperty(globalThis, "document");
      if (originalComputed) {
        Object.defineProperty(globalThis, "getComputedStyle", originalComputed);
      } else Reflect.deleteProperty(globalThis, "getComputedStyle");
    }
  });

  it("reports the resolved root when full rendering resolved a link", () => {
    const element = new CFRender();
    element.variant = "full";
    element.cell = createMockCellHandle({ name: "link" }, {
      id: "of:fid1:list" as never,
      space: "did:key:zSpace" as never,
      path: ["0"],
    }) as CellHandle;
    (element as unknown as { _resolvedCell?: CellHandle })._resolvedCell =
      createMockCellHandle({ name: "piece" }, {
        id: "of:fid1:tile-piece" as never,
        space: "did:key:zSpace" as never,
      }) as CellHandle;

    const detail = rightClick(element, contextMenuEvent());
    expect(detail?.pieceId).toBe("of:fid1:tile-piece");
    expect(detail?.variant).toBe("full");
  });

  it("reports the innermost nested pattern in the click path", () => {
    const element = new CFRender();
    element.variant = "tile";
    element.cell = createMockCellHandle({ name: "outer" }, {
      id: "of:fid1:outer-piece" as never,
      space: "did:key:zSpace" as never,
    }) as CellHandle;
    const inner = createMockCellHandle({ name: "inner" }, {
      id: "of:fid1:inner-piece" as never,
      space: "did:key:zSpace" as never,
    }) as CellHandle;
    const innerRoot = new EventTarget() as unknown as Element;
    providePieceBoundary(innerRoot, inner);

    const detail = rightClick(
      element,
      contextMenuEvent(innerRoot, {}, [element]),
    );

    expect(detail?.pieceId).toBe("of:fid1:inner-piece");
    expect(detail?.variant).toBe("full");
  });

  it("does not inherit a piece boundary outside this renderer", () => {
    const element = new CFRender();
    element.cell = createMockCellHandle({ name: "inner" }, {
      id: "of:fid1:inner-piece" as never,
      space: "did:key:zSpace" as never,
    }) as CellHandle;
    const outer = createMockCellHandle({ name: "outer" }, {
      id: "of:fid1:outer-piece" as never,
      space: "did:key:zSpace" as never,
    }) as CellHandle;
    const outerRoot = new EventTarget() as unknown as Element;
    providePieceBoundary(outerRoot, outer);
    const innerTarget = {
      dispatchEvent: (event: Event) => outerRoot.dispatchEvent(event),
    } as EventTarget;

    const detail = rightClick(
      element,
      contextMenuEvent(innerTarget, {}, [element, outerRoot]),
    );

    expect(detail?.pieceId).toBe("of:fid1:inner-piece");
    expect(detail?.variant).toBe("full");
  });

  it("skips a nested provider that is not a whole piece", () => {
    const element = new CFRender();
    element.cell = createMockCellHandle({ name: "renderer" }, {
      id: "of:fid1:renderer-piece" as never,
      space: "did:key:zSpace" as never,
    }) as CellHandle;
    const outer = createMockCellHandle({ name: "outer" }, {
      id: "of:fid1:outer-piece" as never,
      space: "did:key:zSpace" as never,
    }) as CellHandle;
    const field = createMockCellHandle({ name: "field" }, {
      id: "of:fid1:field-piece" as never,
      space: "did:key:zSpace" as never,
      path: ["value"],
    }) as CellHandle;
    const outerRoot = new EventTarget() as unknown as Element;
    const fieldRoot = new EventTarget() as unknown as Element;
    providePieceBoundary(outerRoot, outer);
    providePieceBoundary(fieldRoot, field);
    const deepestTarget = {
      dispatchEvent(event: Event) {
        fieldRoot.dispatchEvent(event);
        if (!event.cancelBubble) outerRoot.dispatchEvent(event);
        return !event.defaultPrevented;
      },
    } as EventTarget;

    const detail = rightClick(
      element,
      contextMenuEvent(deepestTarget, {}, [fieldRoot, outerRoot, element]),
    );

    expect(detail?.pieceId).toBe("of:fid1:outer-piece");
    expect(detail?.variant).toBe("full");
  });
});
