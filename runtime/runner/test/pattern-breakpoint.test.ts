import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { patternBreakpoint } from "../src/pattern-breakpoint.ts";

describe("patternBreakpoint", () => {
  // patternBreakpoint stands in for `fn(argument)` when a debugger breakpoint
  // is set: it logs context, pauses at `debugger` (a no-op with no debugger
  // attached), then calls through only when the argument validated.

  it("calls the function with the argument when the argument is valid", () => {
    const logs: unknown[][] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args);
    };
    try {
      const seen: number[] = [];
      const result = patternBreakpoint(
        (value: number) => {
          seen.push(value);
          return value * 2;
        },
        true,
        21,
        undefined,
        undefined,
        undefined,
      );
      expect(result).toBe(42);
      expect(seen).toEqual([21]);
      expect(logs.length).toBe(1);
      expect(logs[0][0]).toContain("[Breakpoint]");
    } finally {
      console.log = originalLog;
    }
  });

  it("returns undefined without calling the function when the argument is invalid", () => {
    const originalLog = console.log;
    console.log = () => {};
    try {
      let called = false;
      const result = patternBreakpoint(
        () => {
          called = true;
          return "ran";
        },
        false,
        { bad: true },
        { type: "object" },
        { type: "string" },
        undefined,
      );
      expect(result).toBeUndefined();
      expect(called).toBe(false);
    } finally {
      console.log = originalLog;
    }
  });
});
