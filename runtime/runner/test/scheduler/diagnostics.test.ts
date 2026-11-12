import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { stub } from "@std/testing/mock";
import { MAX_TRIGGER_TRACE_HISTORY } from "../../src/scheduler/constants.ts";
import {
  handleSchedulerError,
  materializeHostVisibleStack,
  recordTriggerTrace,
  summarizeTriggerTraceValue,
} from "../../src/scheduler/diagnostics.ts";
import type { TriggerTraceEntry } from "../../src/scheduler/types.ts";
import type { ErrorHandler, ErrorWithContext } from "../../src/runtime.ts";

/** A trace entry told apart from its neighbors by `changeIndex`. */
function traceEntry(changeIndex: number): TriggerTraceEntry {
  return {
    recordedAt: 0,
    notificationType: "commit",
    changeIndex,
    matchedActionCount: 1,
    mode: "pull",
    space: "did:key:diagnostics",
    entityId: "of:cell",
    path: [],
    before: { kind: "undefined" },
    after: { kind: "undefined" },
    triggered: [],
  };
}

/**
 * Runs `body` with `getStackString` installed on the global object as `host`
 * installs it, and removes it afterwards.
 */
function withHostStackString(
  getStackString: (error: Error) => string,
  body: () => void,
): void {
  Reflect.set(globalThis, "getStackString", getStackString);
  try {
    body();
  } finally {
    Reflect.deleteProperty(globalThis, "getStackString");
  }
}

describe("diagnostics", () => {
  describe("recordTriggerTrace()", () => {
    it("drops the oldest entry once the history is full", () => {
      const state = { triggerTrace: [] as TriggerTraceEntry[] };
      for (let index = 0; index <= MAX_TRIGGER_TRACE_HISTORY; index++) {
        recordTriggerTrace(state, traceEntry(index));
      }

      expect(state.triggerTrace.length).toBe(MAX_TRIGGER_TRACE_HISTORY);
      expect(state.triggerTrace[0].changeIndex).toBe(1);
      expect(state.triggerTrace.at(-1)?.changeIndex).toBe(
        MAX_TRIGGER_TRACE_HISTORY,
      );
    });
  });

  describe("summarizeTriggerTraceValue()", () => {
    it("returns a short string whole, with its length", () => {
      expect(summarizeTriggerTraceValue("abc")).toEqual({
        kind: "string",
        size: 3,
        preview: "abc",
      });
    });

    it("returns a string longer than 80 characters cut to 77 and an ellipsis", () => {
      const long = "x".repeat(81);

      expect(summarizeTriggerTraceValue(long)).toEqual({
        kind: "string",
        size: 81,
        preview: `${"x".repeat(77)}...`,
      });
    });

    it("returns an array's length", () => {
      expect(summarizeTriggerTraceValue([1, 2])).toEqual({
        kind: "array",
        size: 2,
      });
    });

    it("returns an object's key count", () => {
      expect(summarizeTriggerTraceValue({ a: 1, b: 2, c: 3 })).toEqual({
        kind: "object",
        size: 3,
      });
    });

    it("returns any other value by its object tag", () => {
      expect(summarizeTriggerTraceValue(() => {})).toEqual({
        kind: "other",
        preview: "[object Function]",
      });
    });
  });

  describe("materializeHostVisibleStack()", () => {
    it("keeps a stack the error already has", () => {
      const error = new Error("boom");
      error.stack = "Error: boom\n    at here";

      withHostStackString(() => "\n    at host", () => {
        materializeHostVisibleStack(error);
      });

      expect(error.stack).toBe("Error: boom\n    at here");
    });

    it("leaves an empty stack when the host provides no `getStackString`", () => {
      const error = new Error("boom");
      error.stack = "";

      materializeHostVisibleStack(error);

      expect(error.stack).toBe("");
    });

    it("leaves an empty stack when the host has no frames for the error", () => {
      const error = new Error("boom");
      error.stack = "";

      withHostStackString(() => "", () => {
        materializeHostVisibleStack(error);
      });

      expect(error.stack).toBe("");
    });

    it("builds the stack from the error and the host's frames", () => {
      const error = new Error("boom");
      error.stack = "";

      withHostStackString(() => "    at host", () => {
        materializeHostVisibleStack(error);
      });

      expect(error.stack).toBe("Error: boom\n    at host");
    });

    it("adds no second line break before frames that open with one", () => {
      const error = new Error("boom");
      error.stack = "";

      withHostStackString(() => "\n    at host", () => {
        materializeHostVisibleStack(error);
      });

      expect(error.stack).toBe("Error: boom\n    at host");
    });
  });

  describe("handleSchedulerError()", () => {
    it("passes the error on to the handlers after one that throws, and reports the throw", () => {
      const action = function failingAction() {};
      const thrown = new Error("handler failed");
      const received: ErrorWithContext[] = [];
      using consoleError = stub(console, "error");

      handleSchedulerError(
        {
          errorHandlers: new Set<ErrorHandler>([
            () => {
              throw thrown;
            },
            (error) => received.push(error),
          ]),
          parseStack: (stack) => stack,
        },
        new Error("action failed"),
        action,
        "event-1",
      );

      expect(received.length).toBe(1);
      expect(received[0].message).toBe("action failed");
      expect(received[0].action).toBe(action);
      expect(received[0].eventId).toBe("event-1");
      expect(consoleError.calls[0].args).toEqual([
        "Error in error handler:",
        thrown,
      ]);
      expect(consoleError.calls[1].args.slice(0, 2)).toEqual([
        "Error in action:",
        "Error: action failed",
      ]);
    });
  });
});
