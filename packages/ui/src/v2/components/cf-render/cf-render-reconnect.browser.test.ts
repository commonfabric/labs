/**
 * Native DOM lifecycle regressions for moving and reconnecting rendered pieces.
 * Worker messages are controlled while Lit and the DOM renderer run unchanged.
 */

import { expect } from "@std/expect";
import {
  $conn,
  type CellHandle,
  type CellRef,
  NotificationType,
  type VDomBatchNotification,
  type VDomConnection,
} from "@commonfabric/runtime-client";
import {
  createMockCellHandle,
  pushUpdate,
} from "../../test-utils/mock-cell-handle.ts";
// The entrypoint registers cf-render in the browser.
import { CFRender } from "./index.ts";

/** Creates a fixture with controlled worker messages and real DOM rendering. */
function fixture(linked = false, firstMountReply?: Promise<void>) {
  const cell = createMockCellHandle<Record<string, unknown>>({});
  const runtime = cell.runtime();
  const connection = runtime[$conn]();
  const lifetime = new AbortController();
  const disposals = new Set<() => void>();
  const mounted = new Map<number, (batch: VDomBatchNotification) => void>();
  const firstMount = Promise.withResolvers<void>();
  let lateBatch: (() => void) | undefined;
  let nextMount = Promise.withResolvers<void>();
  let nextUnmount = Promise.withResolvers<void>();
  let resolutions = 0;
  let gate: Promise<void> | undefined;
  let target = cell.key("first-target");
  let subscriptions = 0;
  let retarget = () => {};
  if (linked) {
    const watcher = createMockCellHandle<CellHandle>(target);
    watcher.sync = () => Promise.resolve(target);
    const subscribe = watcher.subscribe.bind(watcher);
    watcher.subscribe = (callback) => {
      subscriptions++;
      const cancel = subscribe(callback);
      return () => {
        subscriptions--;
        cancel();
      };
    };
    Object.defineProperty(cell, "asSchema", { value: () => watcher });
    cell.resolveAsCell = () =>
      Promise.resolve(target as CellHandle<Record<string, unknown>>);
    retarget = () => {
      target = cell.key(
        target.ref().path[0] === "first-target"
          ? "second-target"
          : "first-target",
      );
      pushUpdate(watcher, target);
    };
  }
  const pending: Promise<unknown>[] = [];
  const mountedCells: CellRef[] = [];
  const instrument = <T>(handle: CellHandle<T>): CellHandle<T> => {
    const resolve = handle.resolveAsCell.bind(handle);
    handle.resolveAsCell = () => {
      resolutions++;
      const result = (async () => {
        await gate;
        return await resolve();
      })();
      pending.push(result);
      return result;
    };
    return handle;
  };
  instrument(cell);
  Object.defineProperty(runtime, "signal", { value: lifetime.signal });
  Object.defineProperty(connection, "signal", { value: lifetime.signal });
  connection.onDispose = (callback) => {
    disposals.add(callback);
    return () => disposals.delete(callback);
  };
  connection.attachVDom = (onDispose): VDomConnection => {
    disposals.add(onDispose);
    let listener: ((batch: VDomBatchNotification) => void) | undefined;
    return {
      signal: lifetime.signal,
      onBatch: (callback) => listener = callback,
      offBatch: () => listener = undefined,
      detach: () => disposals.delete(onDispose),
      sendEvent: () => {},
      ackBatch: () => {},
      mount: (mountId, reference) => {
        mountedCells.push(reference);
        if (!listener) {
          throw new Error("The renderer must subscribe before mounting");
        }
        mounted.set(mountId, listener);
        const first = mountedCells.length === 1;
        if (first) {
          const receive = listener;
          lateBatch = () =>
            receive({
              type: NotificationType.VDomBatch,
              mountId,
              batchId: 2,
              ops: [
                { op: "create-element", nodeId: 2, tagName: "textarea" },
                {
                  op: "set-prop",
                  nodeId: 2,
                  key: "value",
                  value: "Stale notes",
                },
                { op: "insert-child", parentId: 0, childId: 2, beforeId: null },
              ],
            });
        }
        listener({
          type: NotificationType.VDomBatch,
          mountId,
          batchId: 1,
          rootId: 1,
          ops: [
            { op: "create-element", nodeId: 1, tagName: "textarea" },
            { op: "set-prop", nodeId: 1, key: "value", value: "Saved notes" },
            { op: "insert-child", parentId: 0, childId: 1, beforeId: null },
          ],
        });
        firstMount.resolve();
        nextMount.resolve();
        nextMount = Promise.withResolvers<void>();
        return first && firstMountReply
          ? firstMountReply.then(() => ({ rootId: 1 }))
          : Promise.resolve({ rootId: 1 });
      },
      unmount: (mountId) => {
        mounted.delete(mountId);
        nextUnmount.resolve();
        nextUnmount = Promise.withResolvers<void>();
        return Promise.resolve();
      },
    };
  };
  const container = document.createElement("div");
  const first = document.createElement("section");
  const card = document.createElement("section");
  const element = document.createElement("cf-render") as CFRender;
  expect(element).toBeInstanceOf(CFRender);
  element.cell = cell;
  card.append(element);
  container.append(first, card);
  document.body.append(container);
  return {
    cell,
    element,
    container,
    first,
    card,
    ready: firstMount.promise,
    lateBatch: () => lateBatch?.(),
    get subscriptions() {
      return subscriptions;
    },
    retarget,
    mountedCells,
    replacement: () => instrument(cell.key("replacement")),
    settleResolutions: () => Promise.all(pending),
    get resolutions() {
      return resolutions;
    },
    get mountCount() {
      return mounted.size;
    },
    nextMount: () => nextMount.promise,
    nextUnmount: () => nextUnmount.promise,
    blockResolution: (pending: Promise<void> | undefined) => gate = pending,
    update(value: string) {
      for (const [mountId, listener] of mounted) {
        listener({
          type: NotificationType.VDomBatch,
          mountId,
          batchId: 2,
          ops: [{ op: "set-prop", nodeId: 1, key: "value", value }],
        });
      }
    },
    abort() {
      lifetime.abort();
      for (const dispose of disposals) dispose();
    },
    close() {
      container.remove();
      lifetime.abort();
      for (const dispose of disposals) dispose();
    },
  };
}

/** Reads the notes value currently installed by the DOM renderer. */
function notes(element: CFRender): string | undefined {
  return element.shadowRoot?.querySelector("textarea")?.value;
}

Deno.test("cf-render reconnects unchanged cells after their card moves", async () => {
  const view = fixture();
  try {
    await view.ready;
    await view.element.updateComplete;
    expect(notes(view.element)).toBe("Saved notes");
    const mounted = view.nextMount();
    view.container.insertBefore(view.card, view.first);
    await view.element.updateComplete;
    await view.cell.sync();
    expect(view.resolutions).toBe(2);
    await mounted;
    expect(view.element.cell).toBe(view.cell);
    expect(notes(view.element)).toBe("Saved notes");
    view.update("Notes after moving");
    expect(notes(view.element)).toBe("Notes after moving");
  } finally {
    view.close();
  }
});

Deno.test("cf-render resumes after removal without resolving cells while detached", async () => {
  const view = fixture();
  try {
    await view.ready;
    const unmounted = view.nextUnmount();
    view.card.remove();
    await unmounted;
    await view.element.updateComplete;
    expect(view.mountCount).toBe(0);
    view.element.variant = "tile";
    view.element.variant = "full";
    await view.element.updateComplete;
    await view.cell.sync();
    expect(view.resolutions).toBe(1);
    const mounted = view.nextMount();
    view.container.append(view.card);
    await view.element.updateComplete;
    await view.cell.sync();
    expect(view.resolutions).toBe(2);
    await mounted;
    view.update("Notes after reconnecting");
    expect(notes(view.element)).toBe("Notes after reconnecting");
  } finally {
    view.close();
  }
});

Deno.test("cf-render reconnects despite an equal cell update queued before moving", async () => {
  const view = fixture();
  try {
    await view.ready;
    await view.element.updateComplete;
    const equal = await view.cell.resolveAsCell();
    const mounted = view.nextMount();
    view.element.cell = equal;
    view.container.insertBefore(view.card, view.first);
    await view.element.updateComplete;
    await view.cell.sync();
    await mounted;
    expect(notes(view.element)).toBe("Saved notes");
    view.update("Still subscribed");
    expect(notes(view.element)).toBe("Still subscribed");
  } finally {
    view.close();
  }
});

Deno.test("cf-render uses the newest cell assigned while detached", async () => {
  const view = fixture();
  try {
    await view.ready;
    const unmounted = view.nextUnmount();
    view.card.remove();
    await unmounted;
    const replacement = view.replacement();
    view.element.cell = replacement;
    await view.element.updateComplete;
    await view.cell.sync();
    expect(view.resolutions).toBe(1);
    const mounted = view.nextMount();
    view.container.append(view.card);
    await view.element.updateComplete;
    await view.cell.sync();
    expect(view.resolutions).toBe(2);
    await mounted;
    expect(view.mountedCells.at(-1)).toEqual(replacement.ref());
    view.update("Replacement notes");
    expect(notes(view.element)).toBe("Replacement notes");
  } finally {
    view.close();
  }
});

for (const abort of [false, true]) {
  Deno.test(`cf-render discards a pending resolution after ${abort ? "runtime disposal" : "reconnection"}`, async () => {
    const view = fixture();
    const gate = Promise.withResolvers<void>();
    try {
      await view.ready;
      await view.element.updateComplete;
      view.blockResolution(gate.promise);
      view.element.variant = "full";
      await view.element.updateComplete;
      expect(view.resolutions).toBe(2);
      view.card.remove();
      await view.element.updateComplete;
      view.blockResolution(undefined);
      if (abort) view.abort();
      const mounted = view.nextMount();
      view.container.append(view.card);
      await view.element.updateComplete;
      await view.cell.sync();
      expect(view.resolutions).toBe(abort ? 2 : 3);
      if (!abort) await mounted;
      gate.resolve();
      await view.settleResolutions();
      await view.element.updateComplete;
      expect(view.mountedCells.length).toBe(abort ? 1 : 2);
      if (abort) expect(notes(view.element)).toBeUndefined();
      else {
        view.update("Latest notes");
        expect(notes(view.element)).toBe("Latest notes");
      }
    } finally {
      gate.resolve();
      view.close();
    }
  });
}

Deno.test("cf-render reestablishes a linked target subscription after detachment", async () => {
  const view = fixture(true);
  try {
    await view.ready;
    expect(view.subscriptions).toBe(1);
    const unmounted = view.nextUnmount();
    view.card.remove();
    await unmounted;
    expect(view.subscriptions).toBe(0);
    view.retarget();
    const mounted = view.nextMount();
    view.container.append(view.card);
    await view.element.updateComplete;
    await view.cell.sync();
    expect(view.resolutions).toBe(2);
    await mounted;
    expect(view.subscriptions).toBe(1);
    const remounted = view.nextMount();
    view.retarget();
    await view.settleResolutions();
    expect(view.resolutions).toBe(3);
    await remounted;
    expect(view.subscriptions).toBe(1);
    view.update("Retargeted notes");
    expect(notes(view.element)).toBe("Retargeted notes");
    const detached = view.nextUnmount();
    view.card.remove();
    await detached;
    expect(view.subscriptions).toBe(0);
  } finally {
    view.close();
  }
});

Deno.test("cf-render does not remount an attached element when a disposed runtime finishes resolving", async () => {
  const view = fixture();
  const gate = Promise.withResolvers<void>();
  try {
    await view.ready;
    await view.element.updateComplete;
    view.blockResolution(gate.promise);
    view.element.variant = "full";
    await view.element.updateComplete;
    expect(view.resolutions).toBe(2);
    view.abort();
    gate.resolve();
    await view.settleResolutions();
    await view.element.updateComplete;
    expect(view.element.isConnected).toBe(true);
    expect(view.mountedCells.length).toBe(1);
    expect(notes(view.element)).toBeUndefined();
  } finally {
    gate.resolve();
    view.close();
  }
});

Deno.test("cf-render rejects late batches from a pending mount after reconnection", async () => {
  const reply = Promise.withResolvers<void>();
  const view = fixture(false, reply.promise);
  try {
    await view.ready;
    await view.element.updateComplete;
    const remounted = view.nextMount();
    view.container.insertBefore(view.card, view.first);
    await remounted;
    view.lateBatch();
    const editors = view.element.shadowRoot!.querySelectorAll("textarea");
    expect([...editors].map((editor) => editor.value)).toEqual(["Saved notes"]);
    view.update("Current notes");
    expect(notes(view.element)).toBe("Current notes");
  } finally {
    reply.resolve();
    view.close();
  }
});
