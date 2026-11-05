import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import type { DebuggerController } from "../src/lib/debugger-controller.ts";
import { XDebuggerView } from "../src/views/DebuggerView.ts";
import { templateMarkup } from "./lit-template-markup.ts";

/**
 * Captures every `console.error` call until `restore()` puts the original
 * back.
 */
function captureConsoleError(): { calls: unknown[][]; restore(): void } {
  const calls: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => calls.push(args);
  return { calls, restore: () => (console.error = original) };
}

/**
 * Constructs a view whose runtime reports the given `aborted` state and whose
 * logger operations all run `rejecting`.
 */
function debuggerView(
  aborted: boolean,
  rejecting: () => Promise<void>,
): XDebuggerView {
  const rt = {
    signal: { aborted },
    resetLoggerBaselines: rejecting,
    setLoggerEnabled: rejecting,
    setLoggerLevel: rejecting,
    getLoggerCounts: rejecting,
  };
  const view = new XDebuggerView();
  // The controller stand-in offers only the runtime lookup, which is all
  // the three handlers read from it. Naming `worker` in the metadata is
  // what sends the toggle and level handlers down the worker path.
  view.debuggerController = {
    getRuntime: () => ({ runtime: () => rt }),
  } as unknown as DebuggerController;
  view.accessForTestingOnly.workerLoggerMetadata = {
    worker: { enabled: false, level: "info" },
  };
  return view;
}

/** Rejects the way a runtime operation does once its runtime is disposed. */
const reject = () => Promise.reject(new DOMException("aborted", "AbortError"));

/**
 * The handlers that log a failed runtime operation, each paired with the call
 * that drives it through the view's `accessForTestingOnly`.
 */
const handlers: Array<[string, (view: XDebuggerView) => Promise<void>]> = [
  ["resetBaseline", (view) => view.accessForTestingOnly.resetBaseline()],
  [
    "toggleLogger",
    (view) => view.accessForTestingOnly.toggleLogger("worker"),
  ],
  [
    "setLoggerLevel",
    (view) => view.accessForTestingOnly.setLoggerLevel("worker", "info"),
  ],
];

describe("XDebuggerView", () => {
  describe("instance members", () => {
    describe("renderDiagnosis()", () => {
      it("renders every run of a non-idempotent report and every cell it wrote, a `bigint` included", () => {
        // A run's reads and writes are `FabricValue`s, which a `bigint` is.
        // The method reads the controller's result and the duration off
        // `this`; the controller stand-in offers the two reads it makes, and
        // the duration is the view's default.
        // The run count and the write count both exceed the debugger's usual
        // array and property limits, so the panel showing the last of each
        // is what the assertions pin.

        const writes = Object.fromEntries(
          Array.from({ length: 25 }, (_, i) => [`out${i}`, BigInt(i)]),
        );
        const runs = Array.from({ length: 8 }, (_, i) => ({
          timestamp: i,
          reads: { in: 1 },
          writes,
        }));
        const result = {
          duration: 5000,
          busyTime: 100,
          cycles: [],
          nonIdempotent: [{
            actionId: "action-1",
            runs,
            differingWriteKeys: ["out0"],
          }],
        };
        const view = new XDebuggerView();
        view.debuggerController = {
          getIsDiagnosing: () => false,
          getDiagnosisResult: () => result,
        } as unknown as DebuggerController;

        const markup = templateMarkup(
          view.accessForTestingOnly.renderDiagnosis(),
        );
        expect(markup).toContain("timestamp: 7");
        expect(markup).toContain("out24: 24n");
        expect(markup).not.toContain("... length:");
        expect(markup).not.toContain("... count:");
      });
    });

    for (const [name, call] of handlers) {
      describe(`${name}()`, () => {
        // The handler runs fire-and-forget from `@click`, and logs a runtime
        // operation that fails. When the failure is a disposal race (logout, a
        // runtime swap) the operation was canceled rather than broken, so the
        // log is suppressed when the runtime's `signal.aborted` is set; such
        // a rejection must neither log nor escape as an unhandled rejection.

        it("logs a failure while the runtime is alive", async () => {
          const spy = captureConsoleError();
          try {
            await call(debuggerView(false, reject));
          } finally {
            spy.restore();
          }
          expect(spy.calls.length).toBe(1);
        });

        it("stays silent when the runtime is disposed", async () => {
          const spy = captureConsoleError();
          try {
            await call(debuggerView(true, reject));
          } finally {
            spy.restore();
          }
          expect(spy.calls.length).toBe(0);
        });
      });
    }
  });
});
