/// <reference path="./clock.d.ts" />

/**
 * The SES pattern compartment endows no timers (part of the structural barrier
 * pinned by security-timing.test.ts). Code that wants a delay in both a host
 * context and a compartment must therefore guard its timer use: read
 * `globalThis.setTimeout` (a member access that yields undefined in-sandbox,
 * not a ReferenceError) and no-op when it is absent, so the wait degrades to an
 * immediate return rather than throwing. These tests pin that the compartment
 * omits the timers, that a RAW `setTimeout(...)` call throws inside it, and
 * that the guard resolves immediately there.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  ensureSESLockdown,
  evaluateFunctionSourceInSES,
} from "../src/sandbox/ses-runtime.ts";
import { createModuleCompartmentGlobals } from "../src/sandbox/compartment-globals.ts";

// A backoff guarded by a member-access read of `setTimeout`, which yields
// `undefined` in a compartment rather than raising a ReferenceError.
const GUARDED_BACKOFF_SRC = `async function () {
  const sleep = (ms) => {
    if (ms <= 0) return Promise.resolve();
    const timer = globalThis.setTimeout;
    if (typeof timer !== "function") return Promise.resolve();
    return new Promise((resolve) => { timer(resolve, ms); });
  };
  // A 30s backoff. In-sandbox this must resolve immediately (no timer), not throw.
  await sleep(30000);
  return "backoff-complete";
}`;

// The un-guarded form: a raw setTimeout call.
const RAW_BACKOFF_SRC = `async function () {
  await new Promise((resolve) => setTimeout(resolve, 30000));
  return "backoff-complete";
}`;

describe("sandbox timers (channel: no fine clock)", () => {
  it("the module compartment endows no setTimeout/setInterval", () => {
    ensureSESLockdown();
    const globals = createModuleCompartmentGlobals();
    expect("setTimeout" in globals).toBe(false);
    expect("setInterval" in globals).toBe(false);
    expect("queueMicrotask" in globals).toBe(false);
    expect("requestAnimationFrame" in globals).toBe(false);
  });

  it("a raw setTimeout call throws inside the compartment (the hazard)", async () => {
    ensureSESLockdown();
    const globals = createModuleCompartmentGlobals();
    const fn = evaluateFunctionSourceInSES(RAW_BACKOFF_SRC, {
      lockdown: true,
      globals,
    }) as () => Promise<string>;
    // setTimeout is absent from the compartment (SES resolves the bare global to
    // undefined), so calling it throws — the failure the guard exists to avoid.
    await expect(fn()).rejects.toThrow(
      /setTimeout is not (defined|a function)/,
    );
  });

  it("the guarded backoff resolves immediately inside the compartment", async () => {
    ensureSESLockdown();
    const globals = createModuleCompartmentGlobals();
    const fn = evaluateFunctionSourceInSES(GUARDED_BACKOFF_SRC, {
      lockdown: true,
      globals,
    }) as () => Promise<string>;
    // No timer in the sandbox: the 30s backoff must complete without throwing
    // and without actually waiting (the test itself would hang for 30s if it did).
    const result = await fn();
    expect(result).toBe("backoff-complete");
  });

  it("the same guard DOES wait when a timer is present (host behavior unchanged)", async () => {
    // Outside the sandbox (this test's own Deno global has setTimeout), the guard
    // takes the waiting branch. This runs under the package's fake clock, so the
    // waiting branch's `setTimeout` is a frozen test-file timer: it does not
    // resolve on its own, and `clock.tick` advances logical time to fire it.
    const sleep = (ms: number): Promise<void> => {
      if (ms <= 0) return Promise.resolve();
      const timer =
        (globalThis as { setTimeout?: typeof setTimeout }).setTimeout;
      if (typeof timer !== "function") return Promise.resolve();
      return new Promise((resolve) => {
        timer(resolve, ms);
      });
    };
    let fired = false;
    const p = sleep(10).then(() => {
      fired = true;
    });
    expect(fired).toBe(false); // did not resolve synchronously — the waiting branch
    await clock.tick(10);
    await p;
    expect(fired).toBe(true);
  });
});
