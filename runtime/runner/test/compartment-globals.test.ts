import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { createSafeConsoleGlobal } from "../src/sandbox/compartment-globals.ts";

describe("createSafeConsoleGlobal()", () => {
  it("keeps standard console methods callable when the host console is partial", () => {
    const calls: unknown[][] = [];
    const safeConsole = createSafeConsoleGlobal({
      log: (...args: unknown[]) => calls.push(args),
    });

    expect(typeof safeConsole.log).toBe("function");
    expect(typeof safeConsole.warn).toBe("function");
    expect(typeof safeConsole.error).toBe("function");

    (safeConsole.log as (...args: unknown[]) => void)("hello", 42);
    expect(() => (safeConsole.warn as (...args: unknown[]) => void)("warn"))
      .not.toThrow();
    expect(() => (safeConsole.error as (...args: unknown[]) => void)("error"))
      .not.toThrow();

    expect(calls).toEqual([["hello", 42]]);
  });
});
