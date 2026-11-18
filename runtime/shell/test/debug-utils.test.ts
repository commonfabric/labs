import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { type Stub, stub } from "@std/testing/mock";

import {
  $conn,
  $onCellRefused,
  type CellHandle,
  CellReadRefusedError,
  RequestType,
  type RuntimeClient,
  type TriggerTraceEntry,
  type WriteStackTraceEntry,
  type WriteStackTraceMatcher,
} from "@commonfabric/runtime-client";
import type { DID } from "@commonfabric/identity";

import {
  clearRuntimeDebugGlobals,
  type CommonfabricDebugState,
  createDebugUtils,
  createViewSettled,
  exposeCommonfabricGlobals,
  normalizeEntityId,
  summarizeDebugValue,
  summarizeTriggerTraceEntries,
} from "../src/lib/debug-utils.ts";
import { installGlobals } from "./browser-globals.ts";

const space = "did:key:z6Mk-debug-utils-space" as DID;

/**
 * Builds a runtime whose connection answers each request with `answer`, and
 * records the requests, subscriptions and unsubscriptions it is given.
 * `members` adds the runtime's own calls.
 */
function connectedRuntime(
  answer: (message: { type: RequestType }) => Promise<unknown>,
  members: Record<string, unknown> = {},
) {
  const requests: unknown[] = [];
  const subscribed: CellHandle[] = [];
  const unsubscribed: CellHandle[] = [];
  const connection = {
    request: (message: { type: RequestType }) => {
      requests.push(message);
      return answer(message);
    },
    subscribe: (cell: CellHandle) => {
      subscribed.push(cell);
    },
    unsubscribe: (cell: CellHandle) => {
      unsubscribed.push(cell);
      return Promise.resolve();
    },
    peersOf: () => [],
  };
  const runtime = {
    [$conn]: () => connection,
    ...members,
  } as unknown as RuntimeClient;
  return { runtime, requests, subscribed, unsubscribed };
}

function triggerTraceEntry(
  entityId: TriggerTraceEntry["entityId"],
  path: string[],
): TriggerTraceEntry {
  return {
    recordedAt: 1,
    notificationType: "commit",
    changeIndex: 1,
    matchedActionCount: 0,
    mode: "pull",
    space,
    entityId,
    path,
    before: { kind: "undefined" },
    after: { kind: "object", size: 1 },
    triggered: [],
  };
}

describe("debug utils", () => {
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

  describe("summarizeDebugValue()", () => {
    it("returns the kind and value of a primitive", () => {
      expect(summarizeDebugValue(undefined)).toEqual({ kind: "undefined" });
      expect(summarizeDebugValue(null)).toEqual({
        kind: "null",
        preview: null,
      });
      expect(summarizeDebugValue(false)).toEqual({
        kind: "boolean",
        preview: false,
      });
      expect(summarizeDebugValue(0)).toEqual({ kind: "number", preview: 0 });
      expect(summarizeDebugValue("note")).toEqual({
        kind: "string",
        length: 4,
        preview: "note",
      });
    });

    it("cuts a string of more than 100 characters to 97 and an ellipsis", () => {
      expect(summarizeDebugValue("x".repeat(100)).preview).toBe(
        "x".repeat(100),
      );
      expect(summarizeDebugValue("x".repeat(101))).toEqual({
        kind: "string",
        length: 101,
        preview: `${"x".repeat(97)}...`,
      });
    });

    it("returns the length of an array", () => {
      expect(summarizeDebugValue([1, 2, 3])).toEqual({
        kind: "array",
        length: 3,
      });
    });

    it("returns the class tag of a value that is neither primitive nor object", () => {
      expect(summarizeDebugValue(10n)).toEqual({
        kind: "other",
        preview: "[object BigInt]",
      });
    });

    it("returns the first twelve keys of an object, and no resemblance for a plain one", () => {
      const keys = Array.from({ length: 13 }, (_, i) => `key${i}`);
      expect(
        summarizeDebugValue(Object.fromEntries(keys.map((key) => [key, 1]))),
      ).toEqual({
        kind: "object",
        topKeys: keys.slice(0, 12),
        internalKeys: undefined,
        looksLike: [],
      });
    });

    it("returns `note-like-state` for an object with a title or text", () => {
      expect(summarizeDebugValue({ title: "Groceries" }).looksLike).toEqual([
        "note-like-state",
      ]);
      expect(
        summarizeDebugValue({ internal: { text: "milk" } }).looksLike,
      ).toEqual(["runtime-metadata-doc", "note-like-state"]);
    });

    it("returns `ui-result` without a child count for a `$UI` that has no children", () => {
      const summary = summarizeDebugValue({ $UI: { type: "vnode" } });
      expect(summary.looksLike).toEqual(["ui-result"]);
      expect(summary.uiChildCount).toBeUndefined();
    });
  });

  describe("normalizeEntityId()", () => {
    it("returns a schemed `id` unchanged and gives a bare one the `of:` scheme", () => {
      expect(normalizeEntityId({ id: "of:abc" })).toBe("of:abc");
      expect(normalizeEntityId({ id: "abc" })).toBe("of:abc");
    });

    it("returns `did` with the `of:` scheme when there is no `id`", () => {
      expect(normalizeEntityId({ did: "abc" })).toBe("of:abc");
      expect(normalizeEntityId({ did: "of:abc", id: "" })).toBe("of:abc");
    });

    it("returns the piece in the page's URL when given neither", () => {
      const restore = installGlobals({
        location: { pathname: "/my-space/piece-in-url" },
      });
      try {
        expect(normalizeEntityId()).toBe("of:piece-in-url");
      } finally {
        restore();
      }
    });

    it("returns an empty string when the page's URL names no piece", () => {
      const restore = installGlobals({ location: { pathname: "/my-space" } });
      try {
        expect(normalizeEntityId()).toBe("");
      } finally {
        restore();
      }
    });
  });

  describe("createDebugUtils()", () => {
    let logged: unknown[][];
    let errors: unknown[][];
    let consoleLog: Stub<Console>;
    let consoleError: Stub<Console>;

    beforeEach(() => {
      logged = [];
      errors = [];
      consoleLog = stub(console, "log", (...args: unknown[]) => {
        logged.push(args);
      });
      consoleError = stub(console, "error", (...args: unknown[]) => {
        errors.push(args);
      });
    });

    afterEach(() => {
      consoleLog.restore();
      consoleError.restore();
    });

    describe("readCell()", () => {
      it("returns the value at the path in the piece, in the shell's space by default", async () => {
        const rt = connectedRuntime(() =>
          Promise.resolve({ value: { count: 1 } })
        );
        const { readCell } = createDebugUtils(() => space, () => rt.runtime);

        expect(await readCell({ did: "piece", path: ["internal"] })).toEqual({
          count: 1,
        });
        expect(rt.requests).toEqual([
          expect.objectContaining({
            type: RequestType.CellGet,
            cell: expect.objectContaining({
              id: "of:piece",
              space,
              path: ["internal"],
            }),
          }),
        ]);
        expect(logged).toContainEqual([
          "[debug] readCell value:",
          { count: 1 },
        ]);
      });

      it("returns `undefined` and logs why when there is no runtime, space or piece", async () => {
        const rt = connectedRuntime(() => Promise.resolve({ value: 1 }));
        const restore = installGlobals({ location: { pathname: "/" } });
        try {
          expect(
            await createDebugUtils(() => space, () => undefined).readCell({
              did: "piece",
            }),
          ).toBeUndefined();
          expect(
            await createDebugUtils(() => undefined, () => rt.runtime).readCell({
              did: "piece",
            }),
          ).toBeUndefined();
          expect(
            await createDebugUtils(() => space, () => rt.runtime).readCell(),
          ).toBeUndefined();
        } finally {
          restore();
        }
        expect(rt.requests).toEqual([]);
        expect(errors).toEqual([
          ["[debug] No runtime available"],
          ["[debug] No space available"],
          [
            "[debug] No piece DID — navigate to a piece first or pass { did } or { id }",
          ],
        ]);
      });
    });

    describe("readArgumentCell()", () => {
      it("returns the value of the piece's argument cell", async () => {
        const rt = connectedRuntime(() =>
          Promise.resolve({ value: { title: "Groceries" } })
        );
        const { readArgumentCell } = createDebugUtils(
          () => space,
          () => rt.runtime,
        );

        expect(await readArgumentCell({ id: "of:piece" })).toEqual({
          title: "Groceries",
        });
        expect(rt.requests).toEqual([
          expect.objectContaining({ meta: "argument" }),
        ]);
        expect(logged).toContainEqual([
          "[debug] read argument cell value:",
          { title: "Groceries" },
        ]);
      });
    });

    describe("subscribeToCell()", () => {
      it("logs each update and refusal until the returned function cancels it", () => {
        const rt = connectedRuntime(() => Promise.resolve({}));
        const { subscribeToCell } = createDebugUtils(
          () => space,
          () => rt.runtime,
        );

        const cancel = subscribeToCell({ id: "of:piece", path: ["count"] });
        expect(rt.subscribed).toHaveLength(1);
        const [cell] = rt.subscribed;
        expect(cell.ref()).toEqual(
          expect.objectContaining({ id: "of:piece", space, path: ["count"] }),
        );
        expect(logged).toContainEqual([
          expect.stringMatching(/^\[debug\] cell update \[.+\]:$/),
          undefined,
        ]);

        cell[$onCellRefused]({ refusedBy: "display-ceiling" });
        expect(logged).toContainEqual([
          expect.stringMatching(/^\[debug\] cell update refused \[.+\]:$/),
          { refusedBy: "display-ceiling" },
        ]);

        expect(rt.unsubscribed).toEqual([]);
        cancel?.();
        expect(rt.unsubscribed).toEqual([cell]);
      });

      it("returns `undefined` and logs why when there is no runtime, space or piece", () => {
        const rt = connectedRuntime(() => Promise.resolve({}));
        const restore = installGlobals({ location: { pathname: "/" } });
        try {
          expect(
            createDebugUtils(() => space, () => undefined).subscribeToCell({
              did: "piece",
            }),
          ).toBeUndefined();
          expect(
            createDebugUtils(() => undefined, () => rt.runtime)
              .subscribeToCell({ did: "piece" }),
          ).toBeUndefined();
          expect(
            createDebugUtils(() => space, () => rt.runtime).subscribeToCell(),
          ).toBeUndefined();
        } finally {
          restore();
        }
        expect(rt.subscribed).toEqual([]);
        expect(errors).toEqual([
          ["[debug] No runtime available"],
          ["[debug] No space available"],
          [
            "[debug] No piece DID — navigate to a piece first or pass { did } or { id }",
          ],
        ]);
      });
    });

    describe("watchWrites()", () => {
      function watchingRuntime() {
        const sent: WriteStackTraceMatcher[][] = [];
        const runtime = {
          setWriteStackTraceMatchers: (matchers: WriteStackTraceMatcher[]) => {
            sent.push(matchers);
            return Promise.resolve();
          },
        } as unknown as RuntimeClient;
        return { runtime, sent };
      }

      it("sends the worker each matcher, filled in from the shell's space", async () => {
        const rt = watchingRuntime();
        const { watchWrites } = createDebugUtils(() => space, () => rt.runtime);

        const matchers = await watchWrites([
          { did: "piece", path: ["items"], match: "prefix", label: "items" },
          { space: "did:key:other", id: "of:other" },
          {},
        ]);
        expect(matchers).toEqual([
          {
            space,
            entityId: "of:piece",
            path: ["items"],
            match: "prefix",
            label: "items",
          },
          {
            space: "did:key:other",
            entityId: "of:other",
            path: [],
            match: "exact",
            label: undefined,
          },
          {
            space,
            entityId: undefined,
            path: [],
            match: "exact",
            label: undefined,
          },
        ]);
        expect(rt.sent).toEqual([matchers]);
      });

      it("sends no matchers when given none, which stops the watch", async () => {
        const rt = watchingRuntime();
        const { watchWrites } = createDebugUtils(() => space, () => rt.runtime);
        expect(await watchWrites()).toEqual([]);
        expect(rt.sent).toEqual([[]]);
      });

      it("sends nothing without a space for every matcher", async () => {
        const rt = watchingRuntime();
        const { watchWrites } = createDebugUtils(
          () => undefined,
          () => rt.runtime,
        );

        expect(
          await watchWrites([{ space: "did:key:other" }, { did: "piece" }]),
        ).toBeUndefined();
        expect(rt.sent).toEqual([]);
        expect(errors).toEqual([[
          "[debug] No space available — pass { space } in each matcher",
        ]]);

        expect(await watchWrites({ space: "did:key:other" })).toEqual([
          expect.objectContaining({ space: "did:key:other" }),
        ]);
      });

      it("returns `undefined` without a runtime", async () => {
        const { watchWrites } = createDebugUtils(() => space, () => undefined);
        expect(await watchWrites()).toBeUndefined();
        expect(errors).toEqual([["[debug] No runtime available"]]);
      });
    });

    describe("getWriteStackTrace()", () => {
      it("returns the worker's write trace", async () => {
        const trace: WriteStackTraceEntry[] = [];
        const runtime = {
          getWriteStackTrace: () => Promise.resolve(trace),
        } as unknown as RuntimeClient;
        const { getWriteStackTrace } = createDebugUtils(
          () => space,
          () => runtime,
        );
        expect(await getWriteStackTrace()).toBe(trace);
      });

      it("returns `undefined` without a runtime", async () => {
        const { getWriteStackTrace } = createDebugUtils(
          () => space,
          () => undefined,
        );
        expect(await getWriteStackTrace()).toBeUndefined();
        expect(errors).toEqual([["[debug] No runtime available"]]);
      });
    });

    describe("explainTriggerTrace()", () => {
      it("summarizes the current value of each change, and returns the value only when asked", async () => {
        const rt = connectedRuntime(
          () => Promise.resolve({ value: { title: "Groceries" } }),
          {
            getTriggerTrace: () =>
              Promise.resolve([triggerTraceEntry("of:note", ["internal"])]),
          },
        );
        const { explainTriggerTrace } = createDebugUtils(
          () => undefined,
          () => rt.runtime,
        );

        const brief = await explainTriggerTrace();
        expect(brief?.topChanges[0].currentValueSummary).toEqual(
          summarizeDebugValue({ title: "Groceries" }),
        );
        expect(brief?.topChanges[0].currentValue).toBeUndefined();
        expect(rt.requests).toEqual([
          expect.objectContaining({
            cell: expect.objectContaining({
              id: "of:note",
              space,
              path: ["internal"],
            }),
          }),
        ]);

        const full = await explainTriggerTrace({ includeCurrentValue: true });
        expect(full?.topChanges[0].currentValue).toEqual({
          title: "Groceries",
        });
        expect(logged).toContainEqual(["[debug] explainTriggerTrace:", full]);
      });

      it("rejects with a read failure other than a refusal", async () => {
        const rt = connectedRuntime(
          () => Promise.reject(new Error("connection lost")),
          {
            getTriggerTrace: () =>
              Promise.resolve([triggerTraceEntry("of:note", [])]),
          },
        );
        const { explainTriggerTrace } = createDebugUtils(
          () => space,
          () => rt.runtime,
        );
        await expect(explainTriggerTrace()).rejects.toThrow("connection lost");
      });

      it("returns `undefined` without a runtime", async () => {
        const { explainTriggerTrace } = createDebugUtils(
          () => space,
          () => undefined,
        );
        expect(await explainTriggerTrace()).toBeUndefined();
        expect(errors).toEqual([["[debug] No runtime available"]]);
      });
    });
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

  it("idles the runtime only once the work `getPending` names has settled", async () => {
    // Draining the task queue (all microtasks, then one macrotask) runs every
    // continuation a settle that skipped the pending work would take to reach
    // the runtime's idle, so a correct settle has not reached it by then.

    let idleCalls = 0;
    const rt = {
      idle: () => {
        idleCalls += 1;
        return Promise.resolve();
      },
    };
    const pending = Promise.withResolvers<void>();
    let done = false;
    const settling = createViewSettled(
      () => asRuntime(rt),
      () => pending.promise,
    )().then(() => {
      done = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect({ idleCalls, done }).toEqual({ idleCalls: 0, done: false });

    pending.resolve();
    await settling;
    expect(idleCalls).toBeGreaterThan(0);
  });

  it("settles again for work `getPending` comes to name while the runtime idles", async () => {
    // The work is registered by the first idle, after that pass read
    // `getPending`, as the view's `updated()` can register the bring-up of
    // Home while the worker idles. A pass in which nothing churns ends the
    // settle, so only another settle reads the work and idles after it.

    const log: string[] = [];
    let pending: Promise<void> | undefined;
    const rt = {
      idle: () => {
        log.push("idle");
        pending ??= Promise.resolve().then(() => {
          log.push("pending settled");
        });
        return Promise.resolve();
      },
    };

    await createViewSettled(() => asRuntime(rt), () => pending)();
    expect(log).toEqual(["idle", "pending settled", "idle"]);
  });
});

describe("runtime debug globals", () => {
  type Globals = { commonfabric?: CommonfabricDebugState };

  it("exposeCommonfabricGlobals installs the console globals", async () => {
    let idleCalls = 0;
    const compressionModes: boolean[] = [];
    const detectResult = {
      nonIdempotent: [{ actionId: "action:a", differingWriteKeys: ["x", "y"] }],
      cycles: 0,
    };
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

    const tables: unknown[][] = [];
    const table = stub(console, "table", (...args: unknown[]) => {
      tables.push(args);
    });
    const log = stub(console, "log", () => {});
    try {
      expect(await cf.detectNonIdempotent!()).toBe(detectResult);
      expect(tables).toEqual([[[{
        action: "action:a",
        differingWrites: "x, y",
      }]]]);
    } finally {
      table.restore();
      log.restore();
    }
    await cf.setMemoryMessageCompression!(false);
    expect(compressionModes).toEqual([false]);
  });

  it("names a read the worker refuses, rather than returning an empty cell", async () => {
    const refusal = { refusedBy: "display-ceiling" } as const;
    const connection = {
      request: () => Promise.resolve({ refused: refusal }),
      subscribe: () => Promise.resolve(),
      unsubscribe: () => Promise.resolve(),
      peersOf: () => [],
      signal: new AbortController().signal,
    };
    const runtime = {
      [$conn]: () => connection,
      getTriggerTrace: () =>
        Promise.resolve(
          [{
            recordedAt: 1,
            notificationType: "commit",
            changeIndex: 1,
            matchedActionCount: 0,
            mode: "pull",
            writerActionId: "writer:a",
            space: "did:key:space",
            entityId: "of:sealed",
            path: ["secret"],
            before: { kind: "undefined" },
            after: { kind: "object", size: 1 },
            triggered: [],
          }] satisfies TriggerTraceEntry[],
        ),
    } as unknown as RuntimeClient;
    const global: Globals = {};
    exposeCommonfabricGlobals(global, runtime, () => runtime, () => undefined);
    const cf = global.commonfabric!;
    const logged: unknown[][] = [];
    const log = stub(console, "log", (...args: unknown[]) => {
      logged.push(args);
    });
    try {
      for (const read of [cf.readCell!, cf.readArgumentCell!]) {
        await expect(read({ space: "did:key:space", id: "of:sealed" }))
          .rejects.toThrow(CellReadRefusedError);
      }
      const explained = await cf.explainTriggerTrace!();
      expect(explained?.topChanges[0].currentValueSummary).toEqual({
        kind: "refused",
        refusedBy: "display-ceiling",
      });
    } finally {
      log.restore();
    }
    expect(logged).toContainEqual(["[debug] readCell refused:", refusal]);
    expect(logged).toContainEqual([
      "[debug] read argument cell refused:",
      refusal,
    ]);
  });

  it("exposeCommonfabricGlobals installs a `viewSettled` that waits for the work `getPending` names", async () => {
    const log: string[] = [];
    const runtime = {
      idle: () => {
        log.push("idle");
        return Promise.resolve();
      },
    } as unknown as RuntimeClient;
    const global: Globals = {};
    const pending = Promise.withResolvers<void>();
    exposeCommonfabricGlobals(
      global,
      runtime,
      () => runtime,
      () => undefined,
      () => pending.promise,
    );

    // Draining the task queue (all microtasks, then one macrotask) runs every
    // continuation a settle that skipped the pending work would take to reach
    // the runtime's idle, so a correct settle has not reached it by then.
    const settling = global.commonfabric!.viewSettled!();
    await new Promise((resolve) => setTimeout(resolve, 0));
    log.push("pending settled");
    pending.resolve();
    await settling;
    expect(log.slice(0, 2)).toEqual(["pending settled", "idle"]);
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

describe("readCell", () => {
  it("rejects with the refusal when the worker refuses a metadata read", async () => {
    const requests: unknown[] = [];
    const runtime = {
      [$conn]: () => ({
        request: (message: unknown) => {
          requests.push(message);
          return Promise.resolve({ refused: { refusedBy: "display-ceiling" } });
        },
      }),
    } as unknown as RuntimeClient;
    const { readCell } = createDebugUtils(
      () => "did:key:z6Mk-debug-utils-space",
      () => runtime,
    );

    const log = stub(console, "log", () => {});
    try {
      const read = readCell({ id: "of:debug-utils-piece", meta: "slug" });
      await expect(read).rejects.toThrow(CellReadRefusedError);
      await read.catch((error: CellReadRefusedError) => {
        expect(error.refusal).toEqual({ refusedBy: "display-ceiling" });
      });
    } finally {
      log.restore();
    }
    expect(requests).toEqual([
      expect.objectContaining({
        cell: expect.objectContaining({ id: "of:debug-utils-piece", path: [] }),
        meta: "slug",
      }),
    ]);
  });
});
