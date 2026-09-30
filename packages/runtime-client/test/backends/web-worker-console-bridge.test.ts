// deno-lint-ignore-file cf-imports/no-inline-module-import -- evaluating the
// worker entry is the thing under test, and it must happen after the test has
// replaced the globals it posts through.

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  fabricFromRealmValue,
  realmFromFabricValue,
} from "@commonfabric/data-model/codecs";
import { getLogger } from "@commonfabric/utils/logger";
import { CompilerStackLoadError } from "@commonfabric/runner";
import { isObjectOrArray } from "@commonfabric/utils/types";

import {
  ClientNotificationType,
  isWorkerConsoleNotification,
  NotificationType,
  RequestType,
  RuntimeErrorCode,
  TransportNotificationType,
} from "@/protocol/mod.ts";
import { RuntimeProcessor } from "@/backends/mod.ts";

// The worker entry (`backends/web-worker/index.ts`) installs a `message`
// listener on `self` (which is `globalThis` under Deno) and reads
// `self.postMessage` at call time. We capture posted messages, import the
// module so its listener registers, then drive the handler by dispatching
// `MessageEvent`s — exercising the opt-in console bridge and the request
// branches without spawning a real worker or initializing the runtime.

type Posted = Record<string, unknown>;

function dispatch(data: unknown): Promise<void> {
  // Encoded as the client's transport sends it: the worker entry decodes the
  // envelope, so a raw object would arrive as something it cannot read.
  globalThis.dispatchEvent(
    new MessageEvent("message", { data: realmFromFabricValue(data as never) }),
  );
  // The handler is async; let its microtasks settle before asserting.
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("web-worker-console-bridge", () => {
  describe("web worker console bridge", () => {
    it("forwards console output only while enabled and restores native console", async () => {
      const posted: Posted[] = [];
      const realConsole = {
        log: console.log,
        warn: console.warn,
        error: console.error,
      };
      const originalPostMessage =
        (globalThis as { postMessage?: unknown }).postMessage;
      (globalThis as { postMessage: (m: Posted) => void }).postMessage = (
        m: Posted,
      ) => {
        posted.push(fabricFromRealmValue(m as never) as Posted);
      };

      try {
        // Importing registers the message listener and posts the ready
        // notification.
        await import("@/backends/web-worker/index.ts");
        expect(posted).toContainEqual({
          type: TransportNotificationType.WorkerReady,
          lifetimeLock: expect.any(String),
        });

        const consoleMessages = () =>
          posted.filter(isWorkerConsoleNotification).map(({ level, text }) => ({
            level,
            text,
          }));

        // A request before initialization is rejected (not patched yet, so no
        // forwarded copy reaches `posted`).
        posted.length = 0;
        await dispatch({ msgId: 1, data: { type: RequestType.Idle } });
        expect(posted).toEqual([
          { msgId: 1, error: "WorkerRuntime not initialized." },
        ]);
        expect(consoleMessages()).toHaveLength(0);

        // A one-way notification carries no msgId; with no worker it is dropped
        // silently (no response, no error).
        posted.length = 0;
        await dispatch({ type: ClientNotificationType.VDomBatchApplied });
        expect(posted).toEqual([]);

        // Disabling while forwarding is already off is a no-op that still acks
        // and leaves the native console untouched.
        posted.length = 0;
        await dispatch({
          msgId: 9,
          data: { type: RequestType.SetForwardWorkerConsole, enabled: false },
        });
        expect(posted).toEqual([{ msgId: 9 }]);
        expect(console.log).toBe(realConsole.log);

        // Enable forwarding: the worker patches its console and acks.
        posted.length = 0;
        await dispatch({
          msgId: 2,
          data: { type: RequestType.SetForwardWorkerConsole, enabled: true },
        });
        expect(posted).toContainEqual({ msgId: 2 });

        // A second enable is a no-op that still acks; the bridge stays installed.
        posted.length = 0;
        await dispatch({
          msgId: 21,
          data: { type: RequestType.SetForwardWorkerConsole, enabled: true },
        });
        expect(posted).toContainEqual({ msgId: 21 });

        // Now console output is mirrored. Cover each formatting branch.
        posted.length = 0;
        console.log("plain string");
        expect(consoleMessages()).toContainEqual({
          level: "log",
          text: "plain string",
        });

        posted.length = 0;
        console.warn({ a: 1 });
        expect(consoleMessages()).toContainEqual({
          level: "warn",
          text: '{"a":1}',
        });

        posted.length = 0;
        console.error(new Error("boom"));
        const errMsg = consoleMessages().find((m) => m.level === "error");
        expect(errMsg?.text).toContain("boom");

        // A circular value cannot be JSON.stringified; the bridge falls back to
        // String(...) rather than throwing.
        posted.length = 0;
        const circular: Record<string, unknown> = {};
        circular.self = circular;
        console.log(circular);
        expect(consoleMessages()).toContainEqual({
          level: "log",
          text: "[object Object]",
        });

        // A postMessage failure inside the patched method must not throw out of
        // the logging call.
        (globalThis as { postMessage: (m: Posted) => void }).postMessage =
          () => {
            throw new Error("channel closed");
          };
        expect(() => console.log("survives")).not.toThrow();
        (globalThis as { postMessage: (m: Posted) => void }).postMessage = (
          m: Posted,
        ) => {
          posted.push(fabricFromRealmValue(m as never) as Posted);
        };

        // Disable forwarding: native console is restored, so a subsequent log is
        // not forwarded.
        posted.length = 0;
        await dispatch({
          msgId: 3,
          data: { type: RequestType.SetForwardWorkerConsole, enabled: false },
        });
        expect(posted).toContainEqual({ msgId: 3 });
        expect(console.log).toBe(realConsole.log);

        posted.length = 0;
        console.log("after disable");
        expect(consoleMessages()).toHaveLength(0);

        // A structurally invalid IPC message is rejected with an error response.
        posted.length = 0;
        await dispatch({ msgId: 4, data: { type: "not-a-real-type" } });
        const errorResponse = posted.find(
          (m): m is { msgId: number; error: string } =>
            isObjectOrArray(m) && "error" in m,
        );
        expect(errorResponse?.msgId).toBe(4);
        expect(typeof errorResponse?.error).toBe("string");
      } finally {
        console.log = realConsole.log;
        console.warn = realConsole.warn;
        console.error = realConsole.error;
        if (originalPostMessage === undefined) {
          delete (globalThis as { postMessage?: unknown }).postMessage;
        } else {
          (globalThis as { postMessage?: unknown }).postMessage =
            originalPostMessage;
        }
      }
    });
  });

  describe("web worker request ledger and timing", () => {
    // NOTE: this describe must stay AFTER the console-bridge one. Initializing
    // the worker sets the entry module's `worker`/`workerInitialization` for
    // the rest of the file, and the bridge test asserts pre-initialization
    // behavior.

    const ledgerCount = (key: string) =>
      getLogger("runtime-worker.ipc").countsByKey[key]?.total ?? 0;
    const timingCount = (...keys: string[]) =>
      getLogger("runner.ipc").getTimeStats(...keys)?.count ?? 0;

    it("records delivery/handle timings and posts before counting responses", async () => {
      const posted: Posted[] = [];
      const originalPostMessage =
        (globalThis as { postMessage?: unknown }).postMessage;
      (globalThis as { postMessage: (m: Posted) => void }).postMessage = (
        m: Posted,
      ) => {
        posted.push(fabricFromRealmValue(m as never) as Posted);
      };
      // The handler logs every caught error; capture to keep output clean and
      // assert the error path ran.
      const consoleErrors: unknown[][] = [];
      const realConsoleError = console.error;
      console.error = (...args: unknown[]) => {
        consoleErrors.push(args);
      };

      // Initializing the real RuntimeProcessor needs identities and storage; the
      // ledger/timing seams live in the worker ENTRY, so a fake processor behind
      // the entry's Initialize branch drives them without a runtime.
      const originalInitialize = RuntimeProcessor.initialize;
      let disposed = false;
      const notifications: unknown[] = [];
      let notificationError: Error | undefined;
      const fakeWorker = {
        isDisposed: () => disposed,
        handleRequest: (request: { type: RequestType }) => {
          switch (request.type) {
            case RequestType.Idle:
              return Promise.resolve({ ok: true });
            case RequestType.CellGet:
              return Promise.resolve(undefined);
            case RequestType.PieceGet:
              return Promise.reject(new Error("handler exploded"));
            case RequestType.PieceGetSlug:
              // Intentionally a non-Error rejection: the entry must stringify it.
              return Promise.reject("string-boom");
            case RequestType.PieceStart:
              return Promise.reject(
                new CompilerStackLoadError(new TypeError("chunk fetch failed")),
              );
            default:
              return Promise.resolve(undefined);
          }
        },
        handleNotification: (notification: unknown) => {
          if (notificationError) throw notificationError;
          notifications.push(notification);
        },
      };
      RuntimeProcessor.initialize = (() =>
        Promise.resolve(
          fakeWorker as unknown as RuntimeProcessor,
        )) as typeof RuntimeProcessor.initialize;

      try {
        await import("@/backends/web-worker/index.ts");
        // Snapshot every counter this test asserts on: the loggers are global
        // singletons, so earlier tests in this file may already have ticked
        // some of them.
        const before = {
          deliveryInit: timingCount("delivery", RequestType.Initialize),
          deliveryIdle: timingCount("delivery", RequestType.Idle),
          handleIdle: timingCount("handle", RequestType.Idle),
          handlePieceGet: timingCount("handle", RequestType.PieceGet),
          respondedInit: ledgerCount(`responded/${RequestType.Initialize}`),
          respondedErrorInit: ledgerCount(
            `responded-error/${RequestType.Initialize}`,
          ),
          respondedIdle: ledgerCount(`responded/${RequestType.Idle}`),
          respondedErrorIdle: ledgerCount(
            `responded-error/${RequestType.Idle}`,
          ),
          respondedPieceGet: ledgerCount(`responded/${RequestType.PieceGet}`),
          respondedErrorPieceGet: ledgerCount(
            `responded-error/${RequestType.PieceGet}`,
          ),
          respondedSynced: ledgerCount(
            `responded/${RequestType.RuntimeSynced}`,
          ),
        };

        // Initialize with a send stamp from the past: the entry records how
        // long the request sat queued (delivery/<type>) before responding.
        posted.length = 0;
        await dispatch({
          msgId: 100,
          data: { type: RequestType.Initialize, data: {} },
          sentEpochMs: performance.timeOrigin + performance.now() - 5,
        });
        expect(posted).toEqual([{ msgId: 100 }]);
        expect(timingCount("delivery", RequestType.Initialize)).toBe(
          before.deliveryInit + 1,
        );
        expect(ledgerCount(`responded/${RequestType.Initialize}`)).toBe(
          before.respondedInit + 1,
        );

        // A second Initialize is refused and counted as a responded-error.
        posted.length = 0;
        await dispatch({
          msgId: 101,
          data: { type: RequestType.Initialize, data: {} },
        });
        expect(posted).toEqual([{
          msgId: 101,
          error: "Initialization of WorkerRuntime already attempted.",
        }]);
        expect(ledgerCount(`responded-error/${RequestType.Initialize}`)).toBe(
          before.respondedErrorInit + 1,
        );

        // A handled request records both timing halves (delivery from the send
        // stamp, handle around handleRequest) and responds with data.
        posted.length = 0;
        await dispatch({
          msgId: 102,
          data: { type: RequestType.Idle },
          sentEpochMs: performance.timeOrigin + performance.now() - 5,
        });
        expect(posted).toEqual([{ msgId: 102, data: { ok: true } }]);
        expect(timingCount("handle", RequestType.Idle)).toBe(
          before.handleIdle + 1,
        );
        expect(timingCount("delivery", RequestType.Idle)).toBe(
          before.deliveryIdle + 1,
        );
        expect(ledgerCount(`responded/${RequestType.Idle}`)).toBe(
          before.respondedIdle + 1,
        );

        // An undefined handler result acks with a bare { msgId }.
        posted.length = 0;
        await dispatch({ msgId: 103, data: { type: RequestType.CellGet } });
        expect(posted).toEqual([{ msgId: 103 }]);

        // A throwing handler still records handle/<type> (finally), and the
        // reply is counted as responded-error, never as responded.
        posted.length = 0;
        await dispatch({ msgId: 104, data: { type: RequestType.PieceGet } });
        expect(posted).toEqual([{ msgId: 104, error: "handler exploded" }]);
        expect(timingCount("handle", RequestType.PieceGet)).toBe(
          before.handlePieceGet + 1,
        );
        expect(ledgerCount(`responded/${RequestType.PieceGet}`)).toBe(
          before.respondedPieceGet,
        );
        expect(ledgerCount(`responded-error/${RequestType.PieceGet}`)).toBe(
          before.respondedErrorPieceGet + 1,
        );
        expect(
          consoleErrors.some((args) =>
            args.some((arg) =>
              arg instanceof Error && arg.message === "handler exploded"
            )
          ),
        ).toBe(true);

        // A non-Error throw is stringified into the error reply.
        posted.length = 0;
        await dispatch({
          msgId: 105,
          data: { type: RequestType.PieceGetSlug },
        });
        expect(posted).toEqual([{ msgId: 105, error: "string-boom" }]);

        // Compiler chunk load failures carry a lifecycle code so the shell can
        // replace the worker and its poisoned module map.
        posted.length = 0;
        await dispatch({ msgId: 107, data: { type: RequestType.PieceStart } });
        expect(posted).toEqual([{
          msgId: 107,
          error: "Failed to load the compiler stack",
          code: RuntimeErrorCode.CompilerStackLoadFailed,
        }]);

        // A failed response post: the success counter must NOT tick (the reply
        // never left). `postToClient()` substitutes an error reply naming what
        // could not go, and says so by returning `false`, which is what the
        // ledger counts instead.
        const respondedIdleBefore = ledgerCount(
          `responded/${RequestType.Idle}`,
        );
        let threwOnce = false;
        (globalThis as { postMessage: (m: Posted) => void }).postMessage = (
          m: Posted,
        ) => {
          if (!threwOnce) {
            threwOnce = true;
            throw new Error("post failed");
          }
          posted.push(fabricFromRealmValue(m as never) as Posted);
        };
        posted.length = 0;
        await dispatch({ msgId: 106, data: { type: RequestType.Idle } });
        expect(posted).toHaveLength(1);
        expect(posted[0].msgId).toBe(106);
        // Carries the reason and the message that could not go, rather than
        // the reason alone -- the rendering itself is not pinned here.
        expect(posted[0].error).toContain("Undeliverable message");
        expect(posted[0].error).toContain("post failed");
        expect(ledgerCount(`responded/${RequestType.Idle}`)).toBe(
          respondedIdleBefore,
        );
        expect(ledgerCount(`responded-error/${RequestType.Idle}`)).toBe(
          before.respondedErrorIdle + 1,
        );
        (globalThis as { postMessage: (m: Posted) => void }).postMessage = (
          m: Posted,
        ) => {
          posted.push(fabricFromRealmValue(m as never) as Posted);
        };

        // Notifications reach the live worker; a throwing notification handler
        // is contained (logged, no reply, no crash).
        await dispatch({ type: ClientNotificationType.VDomBatchApplied });
        expect(notifications).toEqual([
          { type: ClientNotificationType.VDomBatchApplied },
        ]);
        notificationError = new Error("notification exploded");
        const errorsBefore = consoleErrors.length;
        await dispatch({ type: ClientNotificationType.VDomBatchApplied });
        expect(consoleErrors.length).toBe(errorsBefore + 1);
        notificationError = undefined;

        // After disposal requests are silently acked (still counted responded),
        // and notifications are dropped without reaching the worker.
        disposed = true;
        posted.length = 0;
        await dispatch({
          msgId: 107,
          data: { type: RequestType.RuntimeSynced },
        });
        expect(posted).toEqual([{ msgId: 107 }]);
        expect(ledgerCount(`responded/${RequestType.RuntimeSynced}`)).toBe(
          before.respondedSynced + 1,
        );
        const notificationsBefore = notifications.length;
        await dispatch({ type: ClientNotificationType.VDomBatchApplied });
        expect(notifications.length).toBe(notificationsBefore);
      } finally {
        RuntimeProcessor.initialize = originalInitialize;
        console.error = realConsoleError;
        if (originalPostMessage === undefined) {
          delete (globalThis as { postMessage?: unknown }).postMessage;
        } else {
          (globalThis as { postMessage?: unknown }).postMessage =
            originalPostMessage;
        }
      }
    });

    it("reports a message that does not decode at all", async () => {
      // Dispatched raw rather than through `dispatch()`, which encodes: what
      // this needs is a message that is no encoding at all, which is what a
      // non-conforming or damaged sender would deliver. The companion below
      // goes the other way -- a well-formed encoding of a value that is no
      // message -- and the two reach different reports for the same reason,
      // that there is no `msgId` to answer under.
      const posted: Posted[] = [];
      const originalPostMessage =
        (globalThis as { postMessage?: unknown }).postMessage;
      (globalThis as { postMessage: (m: unknown) => void }).postMessage = (
        m: unknown,
      ) => {
        posted.push(fabricFromRealmValue(m as never) as Posted);
      };
      const realConsoleError = console.error;
      console.error = () => {};

      try {
        await import("@/backends/web-worker/index.ts");
        posted.length = 0;

        // Dispatched without a wait: the decode fails and the report is
        // posted before the listener reaches its first `await`, so there is
        // nothing to settle.
        globalThis.dispatchEvent(
          new MessageEvent("message", { data: { not: "an encoding" } }),
        );

        expect(posted).toHaveLength(1);
        expect(posted[0].type).toBe(NotificationType.ErrorReport);
        expect(posted[0].message).toContain("Undecodable message");
        // The reason this reports rather than replies, pinned rather than
        // stated: a reply is addressed by `msgId`, and a message that did not
        // decode has none to read.
        expect(Object.hasOwn(posted[0], "msgId")).toBe(false);
      } finally {
        console.error = realConsoleError;
        (globalThis as { postMessage?: unknown }).postMessage =
          originalPostMessage;
      }
    });

    it("reports a message that carries no `msgId` to reply under", async () => {
      // A reply is addressed by `msgId`, and `null` carries none. It reaches
      // the guard rather than the decode's `catch`: `null` is a `FabricValue`,
      // so the envelope decodes it to itself and it fails `isIPCClientMessage`
      // downstream, which is where `Invalid IPC request` is thrown.
      //
      // Decoded as the client's transport decodes it: `postToClient()` encodes
      // the envelope, so what a raw capture sees is the encoding.
      const posted: Posted[] = [];
      const originalPostMessage =
        (globalThis as { postMessage?: unknown }).postMessage;
      (globalThis as { postMessage: (m: unknown) => void }).postMessage = (
        m: unknown,
      ) => {
        posted.push(fabricFromRealmValue(m as never) as Posted);
      };
      const realConsoleError = console.error;
      console.error = () => {};

      try {
        await import("@/backends/web-worker/index.ts");
        posted.length = 0;

        await dispatch(null);

        expect(posted).toHaveLength(1);
        expect(posted[0].type).toBe(NotificationType.ErrorReport);
        expect(posted[0].message).toContain("Malformed message");
        expect(Object.hasOwn(posted[0], "msgId")).toBe(false);
      } finally {
        console.error = realConsoleError;
        (globalThis as { postMessage?: unknown }).postMessage =
          originalPostMessage;
      }
    });

    it("samples worker event-loop lag while the thread is blocked", async () => {
      // The entry arms its loop-lag probe at import. Block the thread past one
      // 100ms sample: the tick due during the block can only fire late, so a
      // positive workerLag is recorded. Counter existence only — the magnitude
      // is never asserted.
      await import("@/backends/web-worker/index.ts");
      const before =
        getLogger("runner.loop").getTimeStats("workerLag")?.count ??
          0;
      const end = performance.now() + 110;
      while (performance.now() < end) {
        // busy
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
      const after = getLogger("runner.loop").getTimeStats("workerLag")?.count ??
        0;
      expect(after).toBeGreaterThan(before);
    });
  });
});
