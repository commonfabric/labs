import type { ReactiveControllerHost } from "lit";
import { expect } from "@std/expect";
import { stub } from "@std/testing/mock";
import { describe, it } from "@std/testing/bdd";

import type { Runtime } from "@commonfabric/runner";
import {
  $conn,
  $onCellUpdate,
  CellHandle,
  type CellRef,
  type CellSetRequest,
  type InitializedRuntimeConnection,
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
function setup() {
  const lifetime = new AbortController();
  const requests: CellSetRequest[] = [];
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
    request: async (request: CellSetRequest) => {
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
    },
  };
}

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
