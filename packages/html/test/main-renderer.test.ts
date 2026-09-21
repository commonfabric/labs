import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  $conn,
  CellHandle,
  type CellRef,
  type RuntimeClient,
  type VNode,
} from "@commonfabric/runtime-client";
import { MockDoc } from "../src/mock-doc.ts";
import { VDomRenderer } from "../src/main/renderer.ts";
import { getActiveRenders, render } from "../src/render.ts";

class MockConnection {
  #listeners = new Map<string, Set<(payload: unknown) => void>>();
  #lifetime = new AbortController();
  public unmountCalls: number[] = [];
  public acknowledgedBatches: Array<{ mountId: number; batchId: number }> = [];
  public sentEvents: Array<{
    mountId: number;
    handlerId: number;
    event: unknown;
    nodeId: number;
  }> = [];

  get signal(): AbortSignal {
    return this.#lifetime.signal;
  }

  /** Dispose the connection, as a logout/runtime-swap would. */
  abort(): void {
    this.#lifetime.abort();
  }

  onDispose(teardown: () => void): () => void {
    if (this.#lifetime.signal.aborted) {
      teardown();
      return () => {};
    }
    this.#lifetime.signal.addEventListener("abort", teardown, { once: true });
    return () => this.#lifetime.signal.removeEventListener("abort", teardown);
  }

  /**
   * Attaches the VDOM capability, which is the only way the renderer obtains
   * it; the session delegates to the mock's recording methods below.
   */
  attachVDom(onDispose: () => void) {
    const unregister = this.onDispose(onDispose);
    return {
      signal: this.signal,
      mount: (mountId: number, cellRef: CellRef) =>
        this.mountVDom(mountId, cellRef),
      unmount: (mountId: number) => this.unmountVDom(mountId),
      sendEvent: (
        mountId: number,
        handlerId: number,
        event: unknown,
        nodeId: number,
      ) => this.sendVDomEvent(mountId, handlerId, event, nodeId),
      ackBatch: (mountId: number, batchId: number) =>
        this.ackVDomBatch(mountId, batchId),
      onBatch: (handler: (payload: unknown) => void) =>
        this.on("vdombatch", handler),
      offBatch: (handler: (payload: unknown) => void) =>
        this.off("vdombatch", handler),
      detach: unregister,
    };
  }

  on(event: string, callback: (payload: unknown) => void): void {
    let set = this.#listeners.get(event);
    if (!set) {
      set = new Set();
      this.#listeners.set(event, set);
    }
    set.add(callback);
  }

  off(event: string, callback: (payload: unknown) => void): void {
    this.#listeners.get(event)?.delete(callback);
  }

  /** What the next `mountVDom` reports as the tree's root. */
  public mountRootId: number | null = null;

  mountVDom(
    _mountId: number,
    _cellRef: CellRef,
  ): Promise<{ rootId: number | null }> {
    return Promise.resolve({ rootId: this.mountRootId });
  }

  unmountVDom(mountId: number): Promise<void> {
    this.unmountCalls.push(mountId);
    return Promise.resolve();
  }

  sendVDomEvent(
    mountId: number,
    handlerId: number,
    event: unknown,
    nodeId: number,
  ): void {
    this.sentEvents.push({ mountId, handlerId, event, nodeId });
  }

  ackVDomBatch(mountId: number, batchId: number): void {
    this.acknowledgedBatches.push({ mountId, batchId });
  }

  emit(event: string, payload: unknown): void {
    for (const listener of this.#listeners.get(event) ?? []) {
      listener(payload);
    }
  }
}

function workerCellHandle(
  connection: MockConnection,
  id: string,
): CellHandle<unknown> {
  const worker = { [$conn]: () => connection } as unknown as RuntimeClient;
  const cellRef = {
    space: "did:key:test",
    id,
    path: [],
    scope: "space",
    type: "application/json",
  } as unknown as CellRef;
  return new CellHandle(worker, cellRef);
}

describe("main-renderer", () => {
  describe("VDomRenderer", () => {
    describe("the mount response's `rootId`", () => {
      const setup = (mountRootId: number | null) => {
        const connection = new MockConnection();
        connection.mountRootId = mountRootId;
        const mock = new MockDoc(
          '<!DOCTYPE html><html><body><div id="root"></div></body></html>',
        );
        const renderer = new VDomRenderer({
          runtimeClient: {} as any,
          connection: connection as any,
          document: mock.document,
        });
        const cellRef = {
          space: "did:key:test",
          id: "cell-id",
          path: [],
          type: "application/json",
        } as unknown as CellRef;
        const container = mock.document.getElementById("root")!;
        return { connection, renderer, cellRef, container };
      };

      it("reports no root when the mount reports none", async () => {
        const { renderer, cellRef, container } = setup(null);

        await renderer.render(container as unknown as HTMLElement, cellRef);

        expect(renderer.getRootNode()).toBe(null);

        await renderer.dispose();
      });

      it("reports the node the mount named", async () => {
        const { renderer, cellRef, container } = setup(1);

        await renderer.render(container as unknown as HTMLElement, cellRef);
        // The mount names a node the applicator has yet to hear of, so create it
        // before reading back: `getRootNode()` resolves the id through the node
        // map, and an unresolved id would report no root for the wrong reason --
        // which is the answer the other step expects, so the two would agree
        // while measuring different things.
        renderer.getApplicator().applyBatch({
          batchId: 1,
          ops: [{ op: "create-element", nodeId: 1, tagName: "button" }],
        });

        expect(renderer.getRootNode()).toBe(
          renderer.getApplicator().getNode(1),
        );

        await renderer.dispose();
      });
    });

    describe("stopRendering()", () => {
      const setup = (mountRootId: number | null) => {
        const connection = new MockConnection();
        connection.mountRootId = mountRootId;
        const mock = new MockDoc(
          '<!DOCTYPE html><html><body><div id="root"></div></body></html>',
        );
        const renderer = new VDomRenderer({
          runtimeClient: {} as any,
          connection: connection as any,
          document: mock.document,
        });
        const cellRef = {
          space: "did:key:test",
          id: "cell-id",
          path: [],
          type: "application/json",
        } as unknown as CellRef;
        const container = mock.document.getElementById("root")!;
        return { renderer, cellRef, container };
      };

      it("leaves the caller's container when the mount reported no root", async () => {
        const { renderer, cellRef, container } = setup(null);
        await renderer.render(container as unknown as HTMLElement, cellRef);

        await renderer.stopRendering();

        expect((container as any).parentNode).not.toBe(null);
        await renderer.dispose();
      });

      it("removes the root the mount reported, and leaves the container", async () => {
        const { renderer, cellRef, container } = setup(1);
        await renderer.render(container as unknown as HTMLElement, cellRef);
        renderer.getApplicator().applyBatch({
          batchId: 1,
          ops: [
            { op: "create-element", nodeId: 1, tagName: "button" },
            { op: "insert-child", parentId: 0, childId: 1, beforeId: null },
          ],
        });
        const root = renderer.getApplicator().getNode(1);
        expect((container as any).childNodes.length).toBe(1);

        await renderer.stopRendering();

        // The root goes and the container stays: teardown reaches into the
        // container rather than removing it, which is the distinction the two
        // steps together pin.
        expect((root as any).parentNode).toBe(null);
        expect((container as any).parentNode).not.toBe(null);
        await renderer.dispose();
      });
    });

    it("forwards trusted event provenance through delivery", async () => {
      const connection = new MockConnection();
      const mock = new MockDoc(
        '<!DOCTYPE html><html><body><div id="root"></div></body></html>',
      );
      const renderer = new VDomRenderer({
        runtimeClient: {} as any,
        connection: connection as any,
        document: mock.document,
      });

      const cellRef = {
        space: "did:key:test",
        id: "cell-id",
        path: [],
        type: "application/json",
      } as unknown as CellRef;

      const container = mock.document.getElementById("root")!;
      await renderer.render(container as unknown as HTMLElement, cellRef);
      const mountId = renderer.getMountId();
      if (mountId === null) {
        throw new Error("expected renderer to have an active mount");
      }

      renderer.getApplicator().applyBatch({
        batchId: 1,
        ops: [
          { op: "create-element", nodeId: 1, tagName: "button" },
          { op: "set-event", nodeId: 1, eventType: "click", handlerId: 42 },
        ],
      });

      const button = renderer.getApplicator().getNode(1) as any;
      button.dispatchEvent({
        type: "click",
        target: button,
        isTrusted: true,
      });

      expect(connection.sentEvents.length).toBe(1);
      expect(connection.sentEvents[0]).toStrictEqual({
        mountId,
        handlerId: 42,
        nodeId: 1,
        event: {
          type: "click",
          target: {
            name: "button",
          },
          provenance: { origin: "dom", trusted: true },
        },
      });

      await renderer.dispose();
    });

    it("acknowledges applied batches", async () => {
      const connection = new MockConnection();
      const mock = new MockDoc(
        '<!DOCTYPE html><html><body><div id="root"></div></body></html>',
      );
      const renderer = new VDomRenderer({
        runtimeClient: {} as any,
        connection: connection as any,
        document: mock.document,
      });

      const cellRef = {
        space: "did:key:test",
        id: "cell-id",
        path: [],
        type: "application/json",
      } as unknown as CellRef;

      const container = mock.document.getElementById("root")!;
      await renderer.render(container as unknown as HTMLElement, cellRef);
      const mountId = renderer.getMountId();
      if (mountId === null) {
        throw new Error("expected renderer to have an active mount");
      }

      connection.emit("vdombatch", {
        type: "vdom:batch",
        batchId: 7,
        mountId,
        ops: [{ op: "create-element", nodeId: 1, tagName: "button" }],
        rootId: 1,
      });

      expect(connection.acknowledgedBatches).toStrictEqual([{
        mountId,
        batchId: 7,
      }]);

      await renderer.dispose();
    });

    it("clears the tracked root when a batch's `rootId` is `null`", async () => {
      const connection = new MockConnection();
      const mock = new MockDoc(
        '<!DOCTYPE html><html><body><div id="root"></div></body></html>',
      );
      const renderer = new VDomRenderer({
        runtimeClient: {} as any,
        connection: connection as any,
        document: mock.document,
      });

      const cellRef = {
        space: "did:key:test",
        id: "cell-id",
        path: [],
        type: "application/json",
      } as unknown as CellRef;

      const container = mock.document.getElementById("root")!;
      await renderer.render(container as unknown as HTMLElement, cellRef);
      const mountId = renderer.getMountId();
      if (mountId === null) {
        throw new Error("expected renderer to have an active mount");
      }

      const batch = (batchId: number, rootId: number | null | undefined) => ({
        type: "vdom:batch",
        batchId,
        mountId,
        ops: batchId === 1
          ? [{ op: "create-element", nodeId: 1, tagName: "button" }]
          : [],
        ...(rootId === undefined ? {} : { rootId }),
      });

      connection.emit("vdombatch", batch(1, 1));
      expect(renderer.getRootNode()).not.toBe(null);

      // Absent says nothing about the root, so the tracked one stands.
      connection.emit("vdombatch", batch(2, undefined));
      expect(renderer.getRootNode()).not.toBe(null);

      // `null` is what the reconciler reports for a tree with no root child, and
      // it is a statement rather than a silence: the tracked root goes away.
      connection.emit("vdombatch", batch(3, null));
      expect(renderer.getRootNode()).toBe(null);

      await renderer.dispose();
    });

    it("constructs without throwing against an already-disposed connection", async () => {
      const connection = new MockConnection();
      // Dispose before the renderer attaches: attachVDom runs the teardown
      // synchronously during construction, while `session` is still unassigned.
      connection.abort();

      const renderer = new VDomRenderer({
        runtimeClient: {} as any,
        connection: connection as any,
        document: {
          createElement: (tagName: string) => ({ tagName }),
          createTextNode: (text: string) => ({ text }),
        } as unknown as Document,
      });

      // The renderer is torn down, not half-built: no active mount, and the batch
      // subscription was never registered.
      expect(renderer.getMountId()).toBe(null);

      // A torn-down renderer refuses to mount rather than proceeding half-built.
      const cellRef = {
        space: "did:key:test",
        id: "cell-id",
        path: [],
        type: "application/json",
      } as unknown as CellRef;
      const cancel = await renderer.render(
        {} as unknown as HTMLElement,
        cellRef,
      );
      expect(renderer.getMountId()).toBe(null);
      expect(connection.unmountCalls.length).toBe(0);
      await cancel();
    });
  });

  describe("render()", () => {
    it("cancels local rendering before pending mount and unmount replies", async () => {
      const connection = new MockConnection();
      const mount = Promise.withResolvers<{ rootId: number | null }>();
      const unmount = Promise.withResolvers<void>();
      let mountId = 0;
      connection.mountVDom = (id) => {
        mountId = id;
        return mount.promise;
      };
      connection.unmountVDom = (id) => {
        connection.unmountCalls.push(id);
        return unmount.promise;
      };
      const mock = new MockDoc(
        '<!DOCTYPE html><html><body><div id="root"></div></body></html>',
      );
      const container = mock.document.getElementById("root")!;
      const cancel = render(
        container as unknown as HTMLElement,
        workerCellHandle(connection, "of:pending-mount") as CellHandle<VNode>,
        { document: mock.document },
      );
      let cancelReplacement: (() => void) | undefined;
      const batch = {
        mountId,
        batchId: 1,
        rootId: 1,
        ops: [
          { op: "create-element", nodeId: 1, tagName: "textarea" },
          { op: "insert-child", parentId: 0, childId: 1, beforeId: null },
        ],
      };
      try {
        connection.emit("vdombatch", batch);
        expect(container.children.length).toBe(1);
        cancel();
        expect(connection.unmountCalls).toEqual([mountId]);
        expect(container.children.length).toBe(0);
        connection.emit("vdombatch", { ...batch, batchId: 2 });
        expect(container.children.length).toBe(0);
        expect(getActiveRenders().has(container as unknown as HTMLElement))
          .toBe(false);
        let replacementId = 0;
        connection.mountVDom = (id) => {
          replacementId = id;
          return Promise.resolve({ rootId: 1 });
        };
        cancelReplacement = render(
          container as unknown as HTMLElement,
          workerCellHandle(connection, "of:replacement") as CellHandle<VNode>,
          { document: mock.document },
        );
        connection.emit("vdombatch", { ...batch, mountId: replacementId });
        const replacement = container.firstChild;
        expect(replacement).not.toBeNull();
        mount.resolve({ rootId: 1 });
        unmount.resolve();
        await Promise.all([mount.promise, unmount.promise]);
        connection.emit("vdombatch", { ...batch, batchId: 3 });
        expect(container.children.length).toBe(1);
        expect(container.firstChild).toBe(replacement);
        connection.emit("vdombatch", {
          mountId: replacementId,
          batchId: 2,
          ops: [{ op: "set-prop", nodeId: 1, key: "value", value: "Current" }],
        });
        expect((replacement as HTMLTextAreaElement).value).toBe("Current");
      } finally {
        cancel();
        cancelReplacement?.();
        mount.resolve({ rootId: 1 });
        unmount.resolve();
        await Promise.all([mount.promise, unmount.promise]);
        connection.abort();
      }
    });

    it("drives worker rendering and tears down via the connection", async () => {
      const connection = new MockConnection();
      const mock = new MockDoc(
        '<!DOCTYPE html><html><body><div id="root"></div></body></html>',
      );
      const container = mock.document.getElementById("root")!;
      const cellHandle = workerCellHandle(connection, "of:render-cell");

      const cancel = render(
        container as unknown as HTMLElement,
        cellHandle as CellHandle<any>,
        { document: mock.document },
      );

      // Let the async mount settle so the cancel closure is wired up and the
      // render is registered.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(getActiveRenders().has(container as unknown as HTMLElement))
        .toBe(true);

      cancel();
      // Cancelling drops the registry entry and unmounts worker-side.
      expect(getActiveRenders().has(container as unknown as HTMLElement))
        .toBe(false);
      expect(connection.unmountCalls.length).toBe(1);
      // Let the deferred renderer.dispose() settle.
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    it("reports a mount failure through `onError` while alive", async () => {
      const connection = new MockConnection();
      // The worker-side mount rejects; render() surfaces it through onError since
      // the connection is neither cancelled nor disposed.
      connection.mountVDom = () => Promise.reject(new Error("mount failed"));
      const mock = new MockDoc(
        '<!DOCTYPE html><html><body><div id="root"></div></body></html>',
      );
      const container = mock.document.getElementById("root")!;
      const cellHandle = workerCellHandle(connection, "of:render-cell-fail");

      const errors: Error[] = [];
      const cancel = render(
        container as unknown as HTMLElement,
        cellHandle as CellHandle<any>,
        { document: mock.document, onError: (error) => errors.push(error) },
      );

      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(errors.length).toBe(1);
      expect(errors[0].message).toBe("mount failed");

      cancel();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  });
});
