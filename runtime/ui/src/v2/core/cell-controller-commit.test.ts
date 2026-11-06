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
  type CellPullRequest,
  type CellRef,
  type CellSetRequest,
  type InitializedRuntimeConnection,
  RequestType,
  type RuntimeClient,
} from "@commonfabric/runtime-client";

import { buildProcessor } from "../../../../runtime-client/test/backends/build-processor.ts";
import {
  BooleanCellController,
  StringCellController,
} from "./cell-controller.ts";

/** Result of the runtime's UI write transaction. */
type CommitResult = Awaited<ReturnType<Runtime["commitUiCellWrite"]>>;

/** A read request of either kind. */
type ReadRequest = CellGetRequest | CellPullRequest;

/**
 * Drives real handles and the processor's acknowledgment handler, with each
 * storage outcome controlled by the test. Subscription deliveries are
 * explicit, and reads answer from `stored` unless held.
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
    signal: lifetime.signal,
    peersOf: () => [],
    request: async (request: CellSetRequest | ReadRequest) => {
      if (
        request.type === RequestType.CellGet ||
        request.type === RequestType.CellPull
      ) {
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
  const handle = <T = string>(
    value: T | undefined,
    extra: Partial<CellRef> = {},
  ) => {
    const cell = new CellHandle<T>(runtime, {
      id: "of:tab" as CellRef["id"],
      space: "did:key:test",
      scope: "space",
      path: [],
      schema: { type: "string" },
      ...extra,
    }, { value });
    if (!stored.has(cell.ref().id)) stored.set(cell.ref().id, value);
    for (const method of ["sync", "pull"] as const) {
      const original = cell[method].bind(cell);
      cell[method] = (...args: Parameters<typeof original>) => {
        const read = original(...args);
        reads.push(read);
        return read;
      };
    }
    // Capture the actual completion promise, whichever write the controller
    // makes.
    for (const method of ["set", "setStrict", "setForUI"] as const) {
      const original = cell[method].bind(cell);
      cell[method] = (value) => {
        const write = original(value);
        writes.push(write);
        return write;
      };
    }
    const update = cell.update.bind(cell);
    cell.update = (updater, options) => {
      const write = update(updater, options);
      writes.push(write);
      return write;
    };
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
    host,
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

/** A label view that makes a rebind install a fresh handle on the cell. */
const readerView = (reader: string): CellRef["cfcLabelView"] => ({
  version: 1,
  entries: [{ path: [], label: { confidentiality: [`did:key:${reader}`] } }],
});

/** The refusal a held commit answers with. */
const refusal = (message: string): CommitResult => ({
  error: {
    name: "StorageTransactionAborted",
    message,
    reason: "test refusal",
  },
});

describe("CellController commit acknowledgment", () => {
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

  it("keeps a toggle through a matching echo and a stale delivery until commit", async () => {
    const f = setup();
    const controller = new BooleanCellController(f.host);
    const cell = f.handle<boolean>(false, { schema: { type: "boolean" } });
    controller.bind(cell);
    try {
      void controller.toggle();
      const request = await f.started(0);
      expect(controller.getValue()).toBe(true);
      cell[$onCellUpdate](true);
      cell[$onCellUpdate](false);
      expect(controller.getValue()).toBe(true);
      expect(request.awaitCommit).toBe(true);

      await f.finish(0);
      expect(controller.getValue()).toBe(true);
      cell[$onCellUpdate](false);
      expect(controller.getValue()).toBe(false);
    } finally {
      await f.finish(0);
      controller.hostDisconnected();
      f.controller.hostDisconnected();
    }
  });

  it("keeps a pending edit across a same-cell rebind and its pre-commit echoes", async () => {
    const f = setup();
    try {
      f.controller.setValue("profile");
      await f.started(0);
      const rebound = f.handle("spaces", { cfcLabelView: readerView("one") });
      f.controller.bind(rebound);
      expect(f.controller.getCell()).toBe(rebound);
      rebound[$onCellUpdate]("profile");
      rebound[$onCellUpdate]("spaces");
      expect(f.controller.getValue()).toBe("profile");
      await f.finish(0);
      expect(f.controller.getValue()).toBe("profile");
      const afterCommit = f.handle("profile", {
        cfcLabelView: readerView("two"),
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

  it("shows what the read finds when the cell was cleared with no delivery at all", async () => {
    const f = setup();
    try {
      f.controller.setValue("hello");
      await f.started(0);
      f.store("");
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
      const rebound = f.handle("spaces", { cfcLabelView: readerView("one") });
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
      expect(f.controller.getValue()).toBe("profile");
      expect(errors.calls).toHaveLength(1);
      expect(errors.calls[0].args[0]).toContain("Reconciliation failed");
      f.cell[$onCellUpdate]("spaces");
      expect(f.controller.getValue()).toBe("spaces");
    } finally {
      f.answerRead(0, "profile");
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
      expect(f.controller.getValue()).toBe("profile");
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
      f.cell[$onCellUpdate]("spaces");
      const before = f.updates;
      await f.finish(0, refusal("write refused"));
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
      await f.finish(0, refusal("write refused"));
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
      const rebound = f.handle<string>(undefined, {
        cfcLabelView: readerView("one"),
      });
      f.controller.bind(rebound);
      expect(f.controller.getValue()).toBe("profile");
      await f.finish(0, refusal("write refused"));
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
      await f.finish(0, refusal("runtime disposed"));
      expect(f.controller.getValue()).toBe("profile");
      expect(errors.calls).toHaveLength(0);
    } finally {
      await f.finish(0);
      f.controller.hostDisconnected();
    }
  });
});
