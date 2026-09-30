import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";

import type {
  CellHandle,
  CellRef,
  RuntimeClient,
  TriggerTraceEntry,
} from "@commonfabric/runtime-client";

import {
  clearRuntimeDebugGlobals,
  type CommonfabricDebugState,
  createDebugUtils,
  createViewSettled,
  exposeCommonfabricGlobals,
  summarizeDebugValue,
  summarizeTriggerTraceEntries,
} from "../src/lib/debug-utils.ts";

describe("debug utils", () => {
  it("acquires an address before reading its issued handle", async () => {
    const acquired: CellRef[] = [];
    let reads = 0;
    const ref: CellRef = {
      id: "of:debug-target",
      space: "did:key:debug",
      scope: "space",
      path: ["title"],
    };
    const cell = {
      ref: () => ({ ...ref, cfcReferenceToken: "issued" }),
      sync: () => {
        reads++;
        return Promise.resolve("Notebook");
      },
    } as unknown as CellHandle<unknown>;
    const runtime = {
      acquireCell: (address: CellRef) => {
        acquired.push(address);
        return Promise.resolve(cell);
      },
    } as unknown as RuntimeClient;
    const debug = createDebugUtils(() => ref.space, () => runtime);
    using _log = stub(console, "log", () => {});
    expect(await debug.readCell({ id: ref.id, path: [...ref.path] })).toBe(
      "Notebook",
    );
    expect(acquired).toEqual([{ ...ref, type: "application/json" }]);
    expect(reads).toBe(1);
  });

  it("cancels a subscription while address acquisition is pending", async () => {
    const pending = Promise.withResolvers<CellHandle<unknown>>();
    const acquired: CellRef[] = [];
    let subscriptions = 0;
    const runtime = {
      acquireCell: (address: CellRef) => {
        acquired.push(address);
        return pending.promise;
      },
    } as unknown as RuntimeClient;
    const debug = createDebugUtils(() => "did:key:debug", () => runtime);
    using _log = stub(console, "log", () => {});
    const cancel = debug.subscribeToCell({ id: "of:debug-target" });
    expect(acquired).toHaveLength(1);
    expect(cancel).toBeDefined();
    cancel!();
    pending.resolve({
      subscribe: () => {
        subscriptions++;
        return () => {};
      },
    } as unknown as CellHandle<unknown>);
    await pending.promise;
    expect(subscriptions).toBe(0);
  });

  it("summarizeDebugValue classifies common metadata/result shapes", () => {
    const summary = summarizeDebugValue({
      $NAME: "My Note",
      $TYPE: "notes/note",
      $UI: { children: [1, 2, 3] },
      internal: {
        pieceRegistry: [],
        visiblePieces: [],
        mentionable: [],
      },
    });

    expect(summary.kind).toBe("object");
    expect(summary.name).toBe("My Note");
    expect(summary.type).toBe("notes/note");
    expect(summary.uiChildCount).toBe(3);
    expect(summary.looksLike).toContain("named-piece-output");
    expect(summary.looksLike).toContain("pattern-result");
    expect(summary.looksLike).toContain("ui-result");
    expect(summary.looksLike).toContain("runtime-metadata-doc");
    expect(summary.looksLike).toContain("default-app-or-home-state");
    expect(summary.looksLike).toContain("index-state");
  });

  it("summarizeTriggerTraceEntries groups by precise change key", () => {
    const trace: TriggerTraceEntry[] = [
      {
        recordedAt: 1,
        notificationType: "commit",
        changeIndex: 1,
        matchedActionCount: 2,
        mode: "pull",
        writerActionId: "writer:a",
        space: "did:key:space-a",
        entityId: "of:entity-a",
        path: [],
        before: { kind: "undefined" },
        after: { kind: "object", size: 2 },
        triggered: [
          {
            actionId: "action:a",
            actionType: "computation",
            mode: "pull",
            decision: "mark-invalid",
            pendingBefore: false,
            pendingAfter: true,
            dirtyBefore: false,
            dirtyAfter: false,
          },
          {
            actionId: "action:b",
            actionType: "computation",
            mode: "pull",
            decision: "mark-invalid",
            pendingBefore: false,
            pendingAfter: true,
            dirtyBefore: false,
            dirtyAfter: false,
          },
        ],
      },
      {
        recordedAt: 2,
        notificationType: "commit",
        changeIndex: 2,
        matchedActionCount: 1,
        mode: "pull",
        writerActionId: "writer:a",
        space: "did:key:space-a",
        entityId: "of:entity-a",
        path: [],
        before: { kind: "object", size: 2 },
        after: { kind: "object", size: 3 },
        triggered: [{
          actionId: "action:a",
          actionType: "computation",
          mode: "pull",
          decision: "mark-invalid",
          pendingBefore: false,
          pendingAfter: true,
          dirtyBefore: false,
          dirtyAfter: false,
        }],
      },
      {
        recordedAt: 3,
        notificationType: "commit",
        changeIndex: 1,
        matchedActionCount: 1,
        mode: "pull",
        space: "did:key:space-a",
        entityId: "of:entity-b",
        path: ["internal", "count"],
        before: { kind: "number", preview: 1 },
        after: { kind: "number", preview: 2 },
        triggered: [{
          actionId: "action:c",
          actionType: "computation",
          mode: "pull",
          decision: "mark-invalid",
          pendingBefore: false,
          pendingAfter: true,
          dirtyBefore: false,
          dirtyAfter: false,
        }],
      },
    ];

    const summary = summarizeTriggerTraceEntries(trace, { limit: 5 });
    expect(summary.traceEntries).toBe(3);
    expect(summary.rootEntries).toBe(2);
    expect(summary.nestedEntries).toBe(1);
    expect(summary.pathLengthCounts).toEqual([[0, 2], [2, 1]]);
    expect(summary.topChanges[0]?.changeKey).toBe(
      "did:key:space-a/of:entity-a/",
    );
    expect(summary.topChanges[0]?.entryCount).toBe(2);
    expect(summary.topChanges[0]?.directSchedules).toBe(3);
    expect(summary.topChanges[0]?.writers).toEqual(["writer:a"]);
    expect(summary.topChanges[0]?.topDirectActions[0]).toEqual(["action:a", 2]);

    const rootOnly = summarizeTriggerTraceEntries(trace, {
      limit: 5,
      rootOnly: true,
    });
    expect(rootOnly.traceEntries).toBe(2);
    expect(rootOnly.nestedEntries).toBe(0);
    expect(rootOnly.topChanges).toHaveLength(1);
  });
});

describe("createViewSettled", () => {
  const asRuntime = (rt: { idle: () => Promise<void> } | undefined) =>
    rt as unknown as RuntimeClient | undefined;

  it("idles the runtime, then settles the view", async () => {
    let idleCalls = 0;
    const rt = {
      idle: () => {
        idleCalls += 1;
        return Promise.resolve();
      },
    };
    await createViewSettled(() => asRuntime(rt))();
    expect(idleCalls).toBeGreaterThan(0);
  });

  it("resolves without throwing when there is no runtime", async () => {
    await createViewSettled(() => undefined)();
  });

  it("reads the runtime on each call so it tracks replacement", async () => {
    const holder: { rt?: { idle: () => Promise<void> } } = {};
    let idleCalls = 0;
    const settled = createViewSettled(() => asRuntime(holder.rt));

    await settled();
    expect(idleCalls).toBe(0);

    holder.rt = {
      idle: () => {
        idleCalls += 1;
        return Promise.resolve();
      },
    };
    await settled();
    expect(idleCalls).toBeGreaterThan(0);
  });
});

describe("runtime debug globals", () => {
  type Globals = { commonfabric?: CommonfabricDebugState };

  it("exposeCommonfabricGlobals installs the console globals", async () => {
    let idleCalls = 0;
    const compressionModes: boolean[] = [];
    const detectResult = { nonIdempotent: [], cycles: 0 };
    const runtime = {
      idle: () => {
        idleCalls += 1;
        return Promise.resolve();
      },
      detectNonIdempotent: () => Promise.resolve(detectResult),
      setMemoryMessageCompression: (enabled: boolean) => {
        compressionModes.push(enabled);
        return Promise.resolve();
      },
    } as unknown as RuntimeClient;
    const global: Globals = {};

    exposeCommonfabricGlobals(global, runtime, () => runtime, () => undefined);

    const cf = global.commonfabric!;
    expect(cf.rt).toBe(runtime);
    expect(typeof cf.viewSettled).toBe("function");
    expect(typeof cf.vdom).toBe("object");
    expect(typeof cf.detectNonIdempotent).toBe("function");
    expect(typeof cf.setMemoryMessageCompression).toBe("function");
    expect(typeof cf.readCell).toBe("function");
    expect(typeof cf.watchWrites).toBe("function");

    await cf.viewSettled!();
    expect(idleCalls).toBeGreaterThan(0);

    const table = stub(console, "table", () => {});
    const log = stub(console, "log", () => {});
    try {
      expect(await cf.detectNonIdempotent!()).toBe(detectResult);
    } finally {
      table.restore();
      log.restore();
    }
    await cf.setMemoryMessageCompression!(false);
    expect(compressionModes).toEqual([false]);
  });

  it("clearRuntimeDebugGlobals clears runtime-bound helpers", () => {
    const global: Globals = {
      commonfabric: {
        rt: {} as RuntimeClient,
        viewSettled: () => Promise.resolve(),
        setMemoryMessageCompression: () => Promise.resolve(),
      },
    };
    clearRuntimeDebugGlobals(global);
    expect(global.commonfabric!.rt).toBeUndefined();
    expect(global.commonfabric!.viewSettled).toBeUndefined();
    expect(global.commonfabric!.setMemoryMessageCompression).toBeUndefined();
  });

  it("clearRuntimeDebugGlobals is a no-op without a commonfabric global", () => {
    const global: Globals = {};
    clearRuntimeDebugGlobals(global);
    expect(global.commonfabric).toBeUndefined();
  });
});
