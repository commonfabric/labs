import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  $conn,
  CellHandle,
  type CellRef,
  type RuntimeClient,
  type VNode,
} from "@commonfabric/runtime-client";
import { getLogger } from "@commonfabric/logger";
import { captureLogsForTestingOnly } from "@commonfabric/logger/for-testing-only";
import { MockDoc } from "../src/mock-doc.ts";
import {
  VDomRenderer,
  type VDomRendererOptions,
} from "../src/main/renderer.ts";
import { getActiveRenders, render } from "../src/render.ts";
import * as client from "../src/client.ts";

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

/** The renderer's mount id, which a test reads once it has rendered. */
function activeMountId(renderer: VDomRenderer): number {
  const mountId = renderer.getMountId();
  if (mountId === null) {
    throw new Error("expected renderer to have an active mount");
  }
  return mountId;
}

describe("main-renderer", () => {
  describe("VDomRenderer", () => {
    const setup = (
      options:
        & { mountRootId?: number | null }
        & Pick<
          VDomRendererOptions,
          "onError" | "setProp"
        > = {},
    ) => {
      const { mountRootId = null, ...rendererOptions } = options;
      const connection = new MockConnection();
      connection.mountRootId = mountRootId;
      const mock = new MockDoc(
        '<!DOCTYPE html><html><body><div id="root"></div></body></html>',
      );
      const renderer = new VDomRenderer({
        runtimeClient: {} as any,
        connection: connection as any,
        document: mock.document,
        ...rendererOptions,
      });
      const cellRef = {
        space: "did:key:test",
        id: "cell-id",
        path: [],
        type: "application/json",
      } as unknown as CellRef;
      const container = mock.document.getElementById(
        "root",
      ) as unknown as HTMLElement;
      return { connection, renderer, cellRef, container };
    };

    describe("the mount response's `rootId`", () => {
      it("reports no root when the mount reports none", async () => {
        const { renderer, cellRef, container } = setup();

        await renderer.render(container, cellRef);

        expect(renderer.getRootNode()).toBe(null);

        await renderer.dispose();
      });

      it("reports the node the mount named", async () => {
        const { renderer, cellRef, container } = setup({ mountRootId: 1 });

        await renderer.render(container, cellRef);
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
      it("leaves the caller's container when the mount reported no root", async () => {
        const { renderer, cellRef, container } = setup();
        await renderer.render(container, cellRef);

        await renderer.stopRendering();

        expect(container.parentNode).not.toBe(null);
        await renderer.dispose();
      });

      it("removes the root the mount reported, and leaves the container", async () => {
        const { renderer, cellRef, container } = setup({ mountRootId: 1 });
        await renderer.render(container, cellRef);
        renderer.getApplicator().applyBatch({
          batchId: 1,
          ops: [
            { op: "create-element", nodeId: 1, tagName: "button" },
            { op: "insert-child", parentId: 0, childId: 1, beforeId: null },
          ],
        });
        const root = renderer.getApplicator().getNode(1);
        expect(container.childNodes.length).toBe(1);

        await renderer.stopRendering();

        // The root goes and the container stays: teardown reaches into the
        // container rather than removing it, which is the distinction the two
        // steps together pin.
        expect(root?.parentNode).toBe(null);
        expect(container.parentNode).not.toBe(null);
        await renderer.dispose();
      });
    });

    it("forwards trusted event provenance through delivery", async () => {
      const { connection, renderer, cellRef, container } = setup();
      await renderer.render(container, cellRef);
      const mountId = activeMountId(renderer);

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
      const { connection, renderer, cellRef, container } = setup();
      await renderer.render(container, cellRef);
      const mountId = activeMountId(renderer);

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

    it("records mounts, batches and unmounts under one timing key each", async () => {
      const logger = getLogger("vdom-renderer");
      const countOf = (key: string) => logger.getTimeStats(key)?.count ?? 0;
      const before = ["mount", "batch", "unmount"].map(countOf);
      const { connection, renderer, cellRef, container } = setup();
      await renderer.render(container, cellRef);
      const mountId = activeMountId(renderer);
      for (const batchId of [7, 8]) {
        connection.emit("vdombatch", {
          type: "vdom:batch",
          batchId,
          mountId,
          ops: [{ op: "create-element", nodeId: batchId, tagName: "b" }],
        });
      }
      await renderer.stopRendering();

      expect(["mount", "batch", "unmount"].map(countOf)).toEqual([
        before[0] + 1,
        before[1] + 2,
        before[2] + 1,
      ]);
      expect(
        Object.keys(logger.timeStats).filter((key) =>
          /^(mount|batch|unmount)\//.test(key)
        ),
      ).toEqual([]);
      await renderer.dispose();
    });

    it("describes mounts, batches and unmounts in its debug log while turned on", async () => {
      using logs = captureLogsForTestingOnly("vdom-renderer");
      const { connection, renderer, cellRef, container } = setup();

      await renderer.render(container, cellRef);
      connection.emit("vdombatch", {
        batchId: 7,
        mountId: activeMountId(renderer),
        ops: [{ op: "create-element", nodeId: 1, tagName: "b" }],
      });
      await renderer.dispose();

      const keys = new Set(["render-mount", "vdom-batch", "stop-rendering"]);
      expect(
        logs.logs.map(({ key }) => key).filter((key) => keys.has(key)),
      ).toEqual(["render-mount", "vdom-batch", "stop-rendering"]);
    });

    it("clears the tracked root when a batch's `rootId` is `null`", async () => {
      const { connection, renderer, cellRef, container } = setup();
      await renderer.render(container, cellRef);
      const mountId = activeMountId(renderer);

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

    describe("lifecycle", () => {
      it("throws on a second mount, and mounts again once cancelled", async () => {
        const { connection, renderer, cellRef, container } = setup();
        const cancel = await renderer.render(container, cellRef);
        const firstMount = renderer.getMountId();

        await expect(renderer.render(container, cellRef)).rejects.toThrow(
          "VDomRenderer already has an active mount. Call cancel first.",
        );
        expect(renderer.getMountId()).toBe(firstMount);

        await cancel();
        expect(connection.unmountCalls).toEqual([firstMount]);
        expect(renderer.getMountId()).toBe(null);

        await renderer.render(container, cellRef);
        expect(renderer.getMountId()).not.toBe(null);
        expect(renderer.getMountId()).not.toBe(firstMount);
        await renderer.dispose();
      });

      it("resets after a failed mount so that it can mount again", async () => {
        const { connection, renderer, cellRef, container } = setup();
        connection.mountVDom = () => Promise.reject(new Error("mount failed"));

        await expect(renderer.render(container, cellRef)).rejects.toThrow(
          "mount failed",
        );
        expect(renderer.getMountId()).toBe(null);

        connection.mountVDom = () => Promise.resolve({ rootId: null });
        await renderer.render(container, cellRef);
        expect(renderer.getMountId()).not.toBe(null);
        await renderer.dispose();
      });

      it("mounts nothing when disposed while the mount is in flight", async () => {
        const { connection, renderer, cellRef, container } = setup();
        const mount = Promise.withResolvers<{ rootId: number | null }>();
        connection.mountVDom = () => mount.promise;

        const rendering = renderer.render(container, cellRef);
        await renderer.dispose();
        mount.resolve({ rootId: 1 });
        const cancel = await rendering;

        expect(renderer.getMountId()).toBe(null);
        expect(renderer.getRootNode()).toBe(null);
        await cancel();
        expect(connection.unmountCalls.length).toBe(1);
      });

      it("does nothing when disposed a second time", async () => {
        const { connection, renderer, cellRef, container } = setup();
        await renderer.render(container, cellRef);

        await renderer.dispose();
        await renderer.dispose();

        expect(connection.unmountCalls.length).toBe(1);
      });

      it("does nothing when stopped without a mount", async () => {
        const { connection, renderer } = setup();

        await renderer.stopRendering();

        expect(connection.unmountCalls).toEqual([]);
        await renderer.dispose();
      });

      it("ignores a batch addressed to another mount", async () => {
        const { connection, renderer, cellRef, container } = setup();
        await renderer.render(container, cellRef);
        const mountId = activeMountId(renderer);

        connection.emit("vdombatch", {
          batchId: 1,
          mountId: mountId + 1,
          rootId: 1,
          ops: [{ op: "create-element", nodeId: 1, tagName: "b" }],
        });

        expect(renderer.getApplicator().getNode(1)).toBeUndefined();
        expect(connection.acknowledgedBatches).toEqual([]);
        await renderer.dispose();
      });

      it("applies a batch naming no mount without acknowledging it", async () => {
        const { connection, renderer, cellRef, container } = setup();
        await renderer.render(container, cellRef);

        connection.emit("vdombatch", {
          batchId: 1,
          rootId: 1,
          ops: [{ op: "create-element", nodeId: 1, tagName: "b" }],
        });

        expect(renderer.getRootNode()).toBe(
          renderer.getApplicator().getNode(1),
        );
        expect(renderer.getRootNode()).not.toBe(null);
        expect(connection.acknowledgedBatches).toEqual([]);
        await renderer.dispose();
      });

      it("ignores batches once disposed", async () => {
        const { connection, renderer, cellRef, container } = setup();
        await renderer.render(container, cellRef);
        const mountId = activeMountId(renderer);
        const batch = {
          batchId: 1,
          mountId,
          rootId: 1,
          ops: [{ op: "create-element", nodeId: 1, tagName: "b" }],
        };

        await renderer.dispose();
        connection.emit("vdombatch", batch);

        expect(renderer.getApplicator().getNode(1)).toBeUndefined();
        expect(connection.acknowledgedBatches).toEqual([]);
      });

      it("reports a batch that fails to apply through `onError`", async () => {
        const errors: Error[] = [];
        const refused = new Error("setter refused");
        const { connection, renderer, cellRef, container } = setup({
          onError: (error) => errors.push(error),
          setProp: () => {
            throw refused;
          },
        });
        await renderer.render(container, cellRef);
        const mountId = activeMountId(renderer);

        connection.emit("vdombatch", {
          batchId: 1,
          mountId,
          ops: [
            { op: "create-element", nodeId: 1, tagName: "b" },
            { op: "set-prop", nodeId: 1, key: "title", value: "x" },
          ],
        });
        connection.ackVDomBatch = () => {
          throw "ack refused";
        };
        connection.emit("vdombatch", { batchId: 2, mountId, ops: [] });

        expect(errors[0]).toBe(refused);
        expect(errors[1]).toBeInstanceOf(Error);
        expect(errors[1].message).toBe("ack refused");
        expect(errors).toHaveLength(2);
        await renderer.dispose();
      });

      it("forwards no event once stopped", async () => {
        const { connection, renderer, cellRef, container } = setup();
        await renderer.render(container, cellRef);
        renderer.getApplicator().applyBatch({
          batchId: 1,
          ops: [
            { op: "create-element", nodeId: 1, tagName: "button" },
            { op: "set-event", nodeId: 1, eventType: "click", handlerId: 9 },
          ],
        });
        const button = renderer.getApplicator().getNode(1);
        if (button === undefined) throw new Error("expected a button node");
        button.dispatchEvent(new Event("click"));
        expect(connection.sentEvents.length).toBe(1);

        await renderer.stopRendering();
        button.dispatchEvent(new Event("click"));

        expect(connection.sentEvents.length).toBe(1);
        await renderer.dispose();
      });
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
    it("is what the package's client entry point exports", () => {
      expect(client.render).toBe(render);
    });

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

    it("drops the registry entry when the connection is disposed", () => {
      const connection = new MockConnection();
      const mock = new MockDoc(
        '<!DOCTYPE html><html><body><div id="root"></div></body></html>',
      );
      const container = mock.document.getElementById(
        "root",
      ) as unknown as HTMLElement;
      const errors: Error[] = [];
      const cancel = render(
        container,
        workerCellHandle(connection, "of:disposed") as CellHandle<VNode>,
        { document: mock.document, onError: (error) => errors.push(error) },
      );
      expect(getActiveRenders().has(container)).toBe(true);

      connection.abort();

      expect(getActiveRenders().has(container)).toBe(false);
      expect(errors).toEqual([]);
      cancel();
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
