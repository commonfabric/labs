import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import type { ReactiveControllerHost } from "lit";

import type { Runtime } from "@commonfabric/runner";
import {
  $conn,
  $onCellUpdate,
  type CellGetRequest,
  CellHandle,
  type CellRef,
  type CellSetRequest,
  type InitializedRuntimeConnection,
  RequestType,
  type RuntimeClient,
} from "@commonfabric/runtime-client";

import { buildProcessor } from "../../../../runtime-client/test/backends/build-processor.ts";
import { StringCellController } from "./cell-controller.ts";

/** Result of the runtime's UI write transaction. */
type CommitResult = Awaited<ReturnType<Runtime["commitUiCellWrite"]>>;

/**
 * Drives real handles and the processor's acknowledgment handler, with each
 * storage outcome controlled by the test. Subscription deliveries are explicit.
 */
function setup({ holdReads = false } = {}) {
  const lifetime = new AbortController();
  const requests: CellSetRequest[] = [];
  const stored = new Map<string, unknown>();
  const reads: Promise<unknown>[] = [];
  const readGates: Array<{
    started: ReturnType<typeof Promise.withResolvers<void>>;
    result: ReturnType<
      typeof Promise.withResolvers<{ value: string | undefined }>
    >;
  }> = [];
  const readGate = (index: number) =>
    readGates[index] ??= {
      started: Promise.withResolvers<void>(),
      result: Promise.withResolvers<{ value: string | undefined }>(),
    };
  let readCount = 0;
  const writes: Promise<void>[] = [];
  const changes: string[] = [];
  const commits: Array<{
    started: ReturnType<typeof Promise.withResolvers<CellSetRequest>>;
    result: ReturnType<typeof Promise.withResolvers<CommitResult>>;
  }> = [];
  const commit = (index: number) =>
    commits[index] ??= {
      started: Promise.withResolvers<CellSetRequest>(),
      result: Promise.withResolvers<CommitResult>(),
    };
  let updates = 0;
  const processor = buildProcessor({
    runtime: {
      getCellFromLink: () => ({}),
      commitUiCellWrite: () => commit(requests.length - 1).result.promise,
    },
  });
  const connection = {
    request: async (request: CellSetRequest | CellGetRequest) => {
      if (request.type === RequestType.CellGet) {
        const gate = readGate(readCount++);
        gate.started.resolve();
        if (holdReads) return await gate.result.promise;
        return { value: stored.get(request.cell.id) };
      }
      stored.set(request.cell.id, request.value);
      const index = requests.length;
      requests.push(request);
      commit(index).started.resolve(request);
      await processor.handleCellSet(request);
      return {};
    },
    subscribe: () => Promise.resolve(),
    unsubscribe: () => Promise.resolve(),
  } as unknown as InitializedRuntimeConnection;
  const runtime = {
    [$conn]: () => connection,
    signal: lifetime.signal,
  } as unknown as RuntimeClient;
  const host: ReactiveControllerHost = {
    addController() {},
    removeController() {},
    requestUpdate() {
      updates++;
    },
    updateComplete: Promise.resolve(true),
  };
  const controller = new StringCellController(host, {
    timing: { strategy: "immediate" },
    onChange: (value) => changes.push(value),
  });
  const handle = (value: string | undefined, extra: Partial<CellRef> = {}) => {
    const cell = new CellHandle<string>(runtime, {
      id: "of:tab" as CellRef["id"],
      space: "did:key:test",
      scope: "space",
      path: [],
      schema: { type: "string" },
      ...extra,
    }, value);
    if (!stored.has(cell.ref().id)) stored.set(cell.ref().id, value);
    const sync = cell.sync.bind(cell);
    cell.sync = () => {
      const read = sync();
      reads.push(read);
      return read;
    };
    // Capture the actual completion promise, including for the negative
    // control that uses ordinary `set()` instead of commit-aware UI writes.
    for (const method of ["set", "setStrict", "setForUI"] as const) {
      const original = cell[method].bind(cell);
      cell[method] = (value) => {
        const write = original(value);
        writes.push(write);
        return write;
      };
    }
    return cell;
  };
  const cell = handle("spaces");
  controller.bind(cell);
  changes.length = 0;
  return {
    cell,
    controller,
    handle,
    changes,
    store: (value: string | undefined) => stored.set(cell.ref().id, value),
    read: () => Promise.all(reads.map((read) => read.catch(() => {}))),
    readStarted: (index: number) => readGate(index).started.promise,
    answerRead: (index: number, value: string | undefined | Error) => {
      if (value instanceof Error) readGate(index).result.reject(value);
      else readGate(index).result.resolve({ value });
    },
    disposeRuntime: () => lifetime.abort(),
    get updates() {
      return updates;
    },
    started: (index: number) => commit(index).started.promise,
    finish: async (
      index: number,
      result: CommitResult = { ok: "committed" },
    ) => {
      commit(index).result.resolve(result);
      // The controller attached its outcome observer when it started this
      // write, before the test attaches this completion observer.
      await writes[index]?.catch(() => {});
      await Promise.all(reads.map((read) => read.catch(() => {})));
    },
  };
}

describe("CellController commit acknowledgment", () => {
  it("reads the current handle on reconnect", () => {
    const f = setup();
    const other = f.cell.subscribe(() => {});
    try {
      f.controller.hostDisconnected();
      f.cell[$onCellUpdate]("remote");
      f.controller.hostConnected();
      expect(f.cell.get()).toBe("remote");
      expect(f.controller.getValue()).toBe("remote");
    } finally {
      other();
      f.controller.hostDisconnected();
    }
  });
  it("reads an explicit sync refresh without a delivery", async () => {
    const f = setup();
    try {
      f.store("remote");
      await f.cell.sync();
      expect(f.cell.get()).toBe("remote");
      expect(f.controller.getValue()).toBe("remote");
    } finally {
      f.controller.hostDisconnected();
    }
  });
  it("accepts a refreshed rebound handle after an equal worker delivery", () => {
    const f = setup();
    try {
      f.store("remote");
      const rebound = f.handle("remote", {
        cfcLabelView: {
          version: 1,
          entries: [{
            path: [],
            label: {
              confidentiality: ["did:key:r"],
            },
          }],
        },
      });
      f.controller.bind(rebound);
      rebound[$onCellUpdate]("remote");
      expect(rebound.get()).toBe("remote");
      expect(f.controller.getValue()).toBe("remote");
    } finally {
      f.controller.hostDisconnected();
    }
  });
  it("reads an explicit sync refresh after its own edit has reconciled", async () => {
    const f = setup();
    try {
      f.controller.setValue("profile");
      await f.started(0);
      await f.finish(0);
      f.store("remote");
      await f.cell.sync();
      expect(f.cell.get()).toBe("remote");
      expect(f.controller.getValue()).toBe("remote");
    } finally {
      f.controller.hostDisconnected();
    }
  });

  it("refreshes an idle rebound handle even without a changed delivery", async () => {
    const f = setup({ holdReads: true });
    try {
      const rebound = f.handle("remote", {
        cfcLabelView: {
          version: 1,
          entries: [{ path: [], label: { confidentiality: ["did:key:r"] } }],
        },
      });
      f.controller.bind(rebound);
      expect(f.controller.getValue()).toBe("spaces");
      await f.readStarted(0);
      f.answerRead(0, "remote");
      await f.read();
      expect(f.controller.getValue()).toBe("remote");
      expect(f.changes.at(-1)).toBe("remote");
    } finally {
      f.answerRead(0, "remote");
      await f.read();
      f.controller.hostDisconnected();
    }
  });

  it("keeps a new blur edit over an idle rebind's in-flight read", async () => {
    const f = setup({ holdReads: true });
    try {
      f.controller.bind(f.handle("remote", {
        cfcLabelView: {
          version: 1,
          entries: [{ path: [], label: { confidentiality: ["did:key:r"] } }],
        },
      }));
      await f.readStarted(0);
      f.controller.updateTimingOptions({ strategy: "blur" });
      f.controller.setValue("new input");
      f.answerRead(0, "remote");
      await f.read();
      expect(f.controller.getValue()).toBe("new input");
    } finally {
      f.answerRead(0, "remote");
      await f.read();
      f.controller.cancel();
      f.controller.hostDisconnected();
    }
  });

  it("expires a read override when an unchanged worker value confirms the cache", async () => {
    const f = setup({ holdReads: true });
    try {
      f.controller.setValue("profile");
      await f.started(0);
      const finishing = f.finish(0);
      await f.readStarted(0);
      f.handle("spaces")[$onCellUpdate]("profile");
      f.answerRead(0, "profile");
      await finishing;
      expect(f.cell.get()).toBe("spaces");
      expect(f.controller.getValue()).toBe("profile");
      // Equal-value notifications refresh the cache without a callback.
      f.cell[$onCellUpdate]("spaces");
      expect(f.controller.getValue()).toBe("spaces");
    } finally {
      f.answerRead(0, "profile");
      await f.finish(0);
      f.controller.hostDisconnected();
    }
  });

  it("expires a read override when a later sync confirms the unchanged cache", async () => {
    const f = setup({ holdReads: true });
    try {
      f.controller.setValue("profile");
      await f.started(0);
      const finishing = f.finish(0);
      await f.readStarted(0);
      f.handle("spaces")[$onCellUpdate]("profile");
      f.answerRead(0, "profile");
      await finishing;
      expect(f.controller.getValue()).toBe("profile");
      const refresh = f.cell.sync();
      await f.readStarted(1);
      f.answerRead(1, "spaces");
      await refresh;
      expect(f.cell.get()).toBe("spaces");
      expect(f.controller.getValue()).toBe("spaces");
    } finally {
      f.answerRead(0, "profile");
      f.answerRead(1, "spaces");
      await f.finish(0);
      f.controller.hostDisconnected();
    }
  });

  it("keeps the optimistic display through a matching echo and a stale delivery until commit", async () => {
    const f = setup();
    try {
      f.controller.setValue("profile");
      const request = await f.started(0);
      expect(f.controller.getValue()).toBe("profile");
      f.cell[$onCellUpdate]("profile");
      f.cell[$onCellUpdate]("spaces");
      expect(f.controller.getValue()).toBe("profile");
      expect(f.changes).not.toContain("spaces");
      expect(request.awaitCommit).toBe(true);

      await f.finish(0);
      f.cell[$onCellUpdate]("profile");
      f.cell[$onCellUpdate]("favorites");
      expect(f.controller.getValue()).toBe("favorites");
      f.cell[$onCellUpdate](undefined);
      expect(f.controller.getValue()).toBe("");
    } finally {
      await f.finish(0);
      f.controller.hostDisconnected();
    }
  });

  it("keeps a pending edit across a same-cell rebind and its pre-commit echoes", async () => {
    const f = setup();
    try {
      f.controller.setValue("profile");
      await f.started(0);
      const rebound = f.handle("spaces", {
        cfcLabelView: {
          version: 1,
          entries: [{
            path: [],
            label: { confidentiality: ["did:key:reader"] },
          }],
        },
      });
      f.controller.bind(rebound);
      expect(f.controller.getCell()).toBe(rebound);
      rebound[$onCellUpdate]("profile");
      rebound[$onCellUpdate]("spaces");
      expect(f.controller.getValue()).toBe("profile");
      await f.finish(0);
      expect(f.controller.getValue()).toBe("profile");
      const afterCommit = f.handle("spaces", {
        cfcLabelView: {
          version: 1,
          entries: [{
            path: [],
            label: { confidentiality: ["did:key:other-reader"] },
          }],
        },
      });
      f.controller.bind(afterCommit);
      expect(f.controller.getCell()).toBe(afterCommit);
      expect(f.controller.getValue()).toBe("profile");
      afterCommit[$onCellUpdate]("favorites");
      expect(f.controller.getValue()).toBe("favorites");
    } finally {
      await f.finish(0);
      f.controller.hostDisconnected();
    }
  });

  it("keeps the reconciled value through matching and stale cache-only rebinds", async () => {
    const f = setup();
    try {
      f.controller.setValue("profile");
      await f.started(0);
      await f.finish(0);
      for (const [reader, cached] of [["one", "profile"], ["two", "spaces"]]) {
        f.controller.bind(f.handle(cached, {
          cfcLabelView: {
            version: 1,
            entries: [{
              path: [],
              label: {
                confidentiality: [`did:key:${reader}`],
              },
            }],
          },
        }));
        expect(f.controller.getValue()).toBe("profile");
      }
    } finally {
      f.controller.hostDisconnected();
    }
  });

  it("reconciles a clear that arrived before the acknowledgment without another delivery", async () => {
    const f = setup();
    try {
      f.controller.setValue("hello");
      await f.started(0);
      f.cell[$onCellUpdate]("hello");
      f.store("");
      f.cell[$onCellUpdate]("");
      expect(f.controller.getValue()).toBe("hello");
      await f.finish(0);
      expect(f.controller.getValue()).toBe("");
      expect(f.changes.at(-1)).toBe("");
    } finally {
      await f.finish(0);
      f.controller.hostDisconnected();
    }
  });

  it("keeps a newer unsent edit when the committed edit's read returns", async () => {
    const f = setup({ holdReads: true });
    try {
      f.controller.setValue("profile");
      await f.started(0);
      const finishing = f.finish(0);
      await f.readStarted(0);
      f.controller.updateTimingOptions({ strategy: "blur" });
      f.controller.setValue("favorites");
      f.answerRead(0, "profile");
      await finishing;
      expect(f.controller.getValue()).toBe("favorites");
    } finally {
      f.answerRead(0, "profile");
      await f.finish(0);
      f.controller.cancel();
      f.controller.hostDisconnected();
    }
  });

  it("reads the current view when rebinding during reconciliation", async () => {
    const f = setup({ holdReads: true });
    try {
      f.controller.setValue("profile");
      await f.started(0);
      const finishing = f.finish(0);
      await f.readStarted(0);
      const rebound = f.handle("spaces", {
        cfcLabelView: {
          version: 1,
          entries: [{
            path: [],
            label: {
              confidentiality: ["did:key:reader"],
            },
          }],
        },
      });
      f.controller.bind(rebound);
      f.answerRead(0, "old-view");
      await f.readStarted(1);
      expect(f.controller.getValue()).toBe("profile");
      f.answerRead(1, "current-view");
      await finishing;
      await f.read();
      expect(f.controller.getValue()).toBe("current-view");
      expect(f.changes).not.toContain("old-view");
    } finally {
      f.answerRead(0, "profile");
      f.answerRead(1, "profile");
      await f.finish(0);
      f.controller.hostDisconnected();
    }
  });

  it("keeps a live delivery that supersedes an in-flight reconciliation read", async () => {
    const f = setup({ holdReads: true });
    try {
      f.controller.setValue("profile");
      await f.started(0);
      const finishing = f.finish(0);
      await f.readStarted(0);
      f.cell[$onCellUpdate]("favorites");
      f.answerRead(0, "profile");
      await finishing;
      expect(f.controller.getValue()).toBe("favorites");
    } finally {
      f.answerRead(0, "profile");
      await f.finish(0);
      f.controller.hostDisconnected();
    }
  });

  it("uses the read result when another handle invalidates the shared read cache", async () => {
    const f = setup({ holdReads: true });
    try {
      f.controller.setValue("profile");
      await f.started(0);
      const finishing = f.finish(0);
      await f.readStarted(0);
      const sibling = f.handle("spaces");
      sibling[$onCellUpdate]("profile");
      f.answerRead(0, "profile");
      await finishing;
      expect(f.cell.get()).toBe("spaces");
      expect(f.controller.getValue()).toBe("profile");
    } finally {
      f.answerRead(0, "profile");
      await f.finish(0);
      f.controller.hostDisconnected();
    }
  });

  it("releases to the bound value and reports a failed reconciliation read", async () => {
    const f = setup({ holdReads: true });
    using errors = stub(console, "error");
    try {
      f.controller.setValue("profile");
      await f.started(0);
      const finishing = f.finish(0);
      await f.readStarted(0);
      f.answerRead(0, new Error("read failed"));
      await finishing;
      expect(f.controller.getValue()).toBe("spaces");
      expect(errors.calls).toHaveLength(1);
      expect(errors.calls[0].args[0]).toContain("Reconciliation failed");
    } finally {
      f.answerRead(0, "profile");
      await f.finish(0);
      f.controller.hostDisconnected();
    }
  });

  it("preserves a read of undefined across a stale cache-only rebind", async () => {
    const f = setup();
    try {
      f.controller.setValue("hello");
      await f.started(0);
      f.store(undefined);
      await f.finish(0);
      expect(f.controller.getValue()).toBe("");
      f.controller.bind(f.handle("hello", {
        cfcLabelView: {
          version: 1,
          entries: [{
            path: [],
            label: {
              confidentiality: ["did:key:reader"],
            },
          }],
        },
      }));
      expect(f.controller.getValue()).toBe("");
    } finally {
      await f.finish(0);
      f.controller.hostDisconnected();
    }
  });

  it("releases a reconciliation canceled by runtime disposal quietly", async () => {
    const f = setup({ holdReads: true });
    using errors = stub(console, "error");
    try {
      f.controller.setValue("profile");
      await f.started(0);
      const finishing = f.finish(0);
      await f.readStarted(0);
      f.disposeRuntime();
      f.answerRead(0, new Error("runtime disposed"));
      await finishing;
      expect(f.controller.getValue()).toBe("spaces");
      expect(errors.calls).toHaveLength(0);
    } finally {
      f.answerRead(0, "profile");
      await f.finish(0);
      f.controller.hostDisconnected();
    }
  });

  it("keeps the latest edit while successive writes commit in order", async () => {
    const f = setup();
    try {
      f.controller.setValue("profile");
      await f.started(0);
      f.controller.setValue("favorites");
      f.cell[$onCellUpdate]("profile");
      await f.finish(0);
      await f.started(1);
      f.cell[$onCellUpdate]("spaces");
      expect(f.controller.getValue()).toBe("favorites");
      await f.finish(1);
      f.cell[$onCellUpdate]("favorites");
      f.cell[$onCellUpdate]("profile");
      expect(f.controller.getValue()).toBe("profile");
    } finally {
      await f.finish(0);
      await f.finish(1);
      f.controller.hostDisconnected();
    }
  });

  it("keeps a newer unsent blur edit when an earlier write commits", async () => {
    const f = setup();
    try {
      f.controller.setValue("profile");
      await f.started(0);
      f.controller.updateTimingOptions({ strategy: "blur" });
      f.controller.setValue("favorites");
      await f.finish(0);
      f.cell[$onCellUpdate]("spaces");
      expect(f.controller.getValue()).toBe("favorites");
      f.controller.flush();
      await f.started(1);
      await f.finish(1);
      expect(f.controller.getValue()).toBe("favorites");
    } finally {
      f.controller.cancel();
      await f.finish(0);
      f.controller.hostDisconnected();
    }
  });

  it("releases a committed edit on another cell while the previous binding still has a pending write", async () => {
    const f = setup();
    try {
      f.controller.setValue("profile");
      await f.started(0);
      const other = f.handle("old", { id: "of:other-tab" as CellRef["id"] });
      f.controller.bind(other);
      f.controller.setValue("new");
      await f.started(1);
      await f.finish(1);
      other[$onCellUpdate]("remote");
      expect(f.controller.getValue()).toBe("remote");
      await f.finish(0);
      expect(f.controller.getValue()).toBe("remote");
    } finally {
      await f.finish(0);
      await f.finish(1);
      f.controller.hostDisconnected();
    }
  });

  it("reports refusal and repaints the bound value without waiting for another delivery", async () => {
    const f = setup();
    using errors = stub(console, "error");
    try {
      f.controller.setValue("profile");
      await f.started(0);
      const before = f.updates;
      await f.finish(0, {
        error: {
          name: "StorageTransactionAborted",
          message: "write refused",
          reason: "test refusal",
        },
      });
      expect(f.controller.getValue()).toBe("spaces");
      expect(f.changes.at(-1)).toBe("spaces");
      expect(f.updates).toBeGreaterThan(before);
      expect(errors.calls).toHaveLength(1);
      expect(errors.calls[0].args[1]).toBeInstanceOf(Error);
      f.cell[$onCellUpdate]("favorites");
      expect(f.controller.getValue()).toBe("favorites");
    } finally {
      await f.finish(0);
      f.controller.hostDisconnected();
    }
  });

  it("keeps a newer edit protected when an earlier write is refused", async () => {
    const f = setup();
    using errors = stub(console, "error");
    try {
      f.controller.setValue("profile");
      await f.started(0);
      f.controller.setValue("favorites");
      await f.started(1);
      await f.finish(0, {
        error: {
          name: "StorageTransactionAborted",
          message: "write refused",
          reason: "test refusal",
        },
      });
      f.cell[$onCellUpdate]("profile");
      expect(f.controller.getValue()).toBe("favorites");
      expect(errors.calls).toHaveLength(1);
      await f.finish(1);
      f.cell[$onCellUpdate]("favorites");
      f.cell[$onCellUpdate]("spaces");
      expect(f.controller.getValue()).toBe("spaces");
    } finally {
      await f.finish(0);
      await f.finish(1);
      f.controller.hostDisconnected();
    }
  });

  it("forgets a refused value across an unhydrated same-cell rebind", async () => {
    const f = setup();
    using errors = stub(console, "error");
    try {
      f.controller.setValue("profile");
      await f.started(0);
      const rebound = f.handle(undefined, {
        cfcLabelView: {
          version: 1,
          entries: [{
            path: [],
            label: { confidentiality: ["did:key:reader"] },
          }],
        },
      });
      f.controller.bind(rebound);
      expect(f.controller.getValue()).toBe("profile");
      await f.finish(0, {
        error: {
          name: "StorageTransactionAborted",
          message: "write refused",
          reason: "test refusal",
        },
      });
      expect(f.controller.getValue()).toBe("");
      expect(f.changes.at(-1)).toBe("");
      expect(errors.calls).toHaveLength(1);
      rebound[$onCellUpdate]("spaces");
      expect(f.controller.getValue()).toBe("spaces");
    } finally {
      await f.finish(0);
      f.controller.hostDisconnected();
    }
  });

  it("releases a write canceled by runtime disposal without reporting a failure", async () => {
    const f = setup();
    using errors = stub(console, "error");
    try {
      f.controller.setValue("profile");
      await f.started(0);
      f.disposeRuntime();
      await f.finish(0, {
        error: {
          name: "StorageTransactionAborted",
          message: "runtime disposed",
          reason: "test teardown",
        },
      });
      expect(f.controller.getValue()).toBe("spaces");
      expect(errors.calls).toHaveLength(0);
    } finally {
      await f.finish(0);
      f.controller.hostDisconnected();
    }
  });
});
