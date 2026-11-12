import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  createModuleCompartmentGlobals,
  createSafeConsoleGlobal,
} from "../src/sandbox/compartment-globals.ts";
import { ensureSESLockdown } from "../src/sandbox/ses-runtime.ts";
import { popFrame, pushFrame } from "../src/builder/pattern.ts";

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

describe("createModuleCompartmentGlobals()", () => {
  it("returns the handler event's coarsened time when Date is called as a function", () => {
    ensureSESLockdown();
    const GatedDate = createModuleCompartmentGlobals().Date as () => string;

    const frame = pushFrame({ inHandler: true, eventTime: 1_700_000_123_456 });
    try {
      expect(GatedDate()).toBe(new Date(1_700_000_123_000).toString());
    } finally {
      popFrame(frame);
    }
    expect(() => GatedDate()).toThrow("not available in this context");
  });
});
