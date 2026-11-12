import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { identitySourceMap } from "@commonfabric/js-compiler/source-map";

import {
  ensureSESLockdown,
  evaluateFunctionSourceInSES,
  SESRuntime,
} from "../src/sandbox/ses-runtime.ts";

type StackHook = ((error: Error) => string) | undefined;

/**
 * Runs `fn` with SES's `getStackString` global replaced by `hook`, or removed
 * when `hook` is undefined, and restores it afterwards.
 */
function withStackHook<T>(hook: StackHook, fn: () => T): T {
  const global = globalThis as { getStackString?: StackHook };
  const original = Object.getOwnPropertyDescriptor(
    globalThis,
    "getStackString",
  );
  if (hook === undefined) {
    delete global.getStackString;
  } else {
    global.getStackString = hook;
  }
  try {
    return fn();
  } finally {
    if (original === undefined) {
      delete global.getStackString;
    } else {
      Object.defineProperty(globalThis, "getStackString", original);
    }
  }
}

/** An error whose own `stack` is `stack`, as a host error carries one. */
function errorWithStack(stack: string): Error {
  const error = new Error("boom");
  Object.defineProperty(error, "stack", {
    value: stack,
    writable: true,
    configurable: true,
  });
  return error;
}

describe("ses-runtime", () => {
  ensureSESLockdown();

  describe("SESRuntime.exec()", () => {
    it("rethrows a thrown non-error value as it was thrown", async () => {
      const runtime = new SESRuntime();
      const thrown = { reason: "not an error" };

      let caught: unknown;
      try {
        runtime.exec(() => {
          throw thrown;
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBe(thrown);
      await expect(runtime.exec(() => Promise.reject("plain"))).rejects.toBe(
        "plain",
      );
    });
  });

  describe("SESRuntime.mapThrownError()", () => {
    it("maps a stack the error already carries, and maps it only once", () => {
      // `a.js` maps to `b.js`, and `b.js` to `c.js`, so a second mapping of
      // the same error would move its frame on to `c.js`.

      const runtime = new SESRuntime();
      runtime.loadSourceMapLazy("a.js", () => identitySourceMap(3, "b.js"));
      runtime.loadSourceMapLazy("b.js", () => identitySourceMap(3, "c.js"));
      const error = errorWithStack("Error: boom\n    at fn (a.js:2:0)");

      withStackHook(() => "\n    at other (z.js:9:9)", () => {
        expect(runtime.mapThrownError(error)).toBe(error);
        expect(error.stack).toBe("Error: boom\n    at fn (b.js:2:0)");
        runtime.mapThrownError(error);
      });
      expect(error.stack).toBe("Error: boom\n    at fn (b.js:2:0)");
    });

    it("builds an empty stack from the frames SES reports", () => {
      const runtime = new SESRuntime();
      runtime.loadSourceMapLazy("a.js", () => identitySourceMap(3, "b.js"));
      const error = new Error("boom");
      expect(error.stack).toBe("");

      withStackHook(
        () => "\n    at fn (a.js:1:0)",
        () => runtime.mapThrownError(error),
      );
      expect(error.stack).toBe("Error: boom\n    at fn (b.js:1:0)");
    });

    it("leaves an empty stack empty when SES reports no frames", () => {
      const runtime = new SESRuntime();
      const absent = new Error("absent hook");
      const noFrames = new Error("no frames");

      withStackHook(undefined, () => runtime.mapThrownError(absent));
      withStackHook(() => "", () => runtime.mapThrownError(noFrames));
      expect(absent.stack).toBe("");
      expect(noFrames.stack).toBe("");
    });
  });

  describe("SESRuntime.evaluateCallback()", () => {
    it("evaluates each distinct source once and reuses its creator", () => {
      const runtime = new SESRuntime();
      const cache = runtime.accessForTestingOnly.callbackEvaluator
        .accessForTestingOnly.callbackCreatorCache;

      const first = runtime.evaluateCallback("(x) => x + 1") as (
        x: number,
      ) => number;
      const creator = cache.get("(x) => x + 1");
      const second = runtime.evaluateCallback(" (x) => x + 1 ") as (
        x: number,
      ) => number;

      expect(first(1)).toBe(2);
      expect(second(2)).toBe(3);
      expect([...cache.keys()]).toEqual(["(x) => x + 1"]);
      expect(cache.get("(x) => x + 1")).toBe(creator);
    });

    it("throws for an empty source", () => {
      const runtime = new SESRuntime();

      expect(() => runtime.evaluateCallback("  ")).toThrow(
        "Callback source must not be empty",
      );
    });

    it("throws when called if the source is not a function", () => {
      const runtime = new SESRuntime();
      const callback = runtime.evaluateCallback("42") as () => unknown;

      expect(() => callback()).toThrow(
        "Callback source did not produce a function",
      );
    });
  });

  describe("evaluateFunctionSourceInSES()", () => {
    it("evaluates a function in a compartment without asking for lockdown", () => {
      const add = evaluateFunctionSourceInSES("(a, b) => a + b") as (
        a: number,
        b: number,
      ) => number;

      expect(add(1, 2)).toBe(3);
      expect(() => evaluateFunctionSourceInSES("globalThis.Deno.exit"))
        .toThrow();
    });
  });
});
