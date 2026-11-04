import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { runInActionExecution } from "../src/builder/action-context.ts";
import { popFrame, pushFrame } from "../src/builder/pattern.ts";
import { handler, lift } from "../src/builder/module.ts";

/**
 * Identity E5 (design Phase 4): builder artifacts are module-scope
 * declarations — the transformer hoists every authored builder call, and
 * content-addressed identity only exists for module-scope artifacts. Minting
 * a lift/handler INSIDE a running action used to limp along through the
 * legacy registry channel (in-session only, never rehydratable); with that
 * channel gone the mint fails loudly at creation time, pointing at the
 * module-level rule and the possibility of a transformer bug.
 */
describe("builder calls inside a running action throw", () => {
  it("lift() inside the action window throws with module-level guidance", () => {
    runInActionExecution(() => {
      expect(() => lift((x: number) => x + 1)).toThrow(
        /define the lift at module level/,
      );
      expect(() => lift((x: number) => x + 1)).toThrow(
        /transformer bug/,
      );
    });
  });

  it("handler() inside the action window throws with module-level guidance", () => {
    runInActionExecution(() => {
      expect(() =>
        handler(
          { type: "object" },
          { type: "object" },
          () => {},
        )
      ).toThrow(
        /define the handler at module level/,
      );
    });
  });

  it("the same calls are fine outside the action window", () => {
    expect(() => lift((x: number) => x + 1)).not.toThrow();
    expect(() =>
      handler(
        { type: "object" },
        { type: "object" },
        () => {},
      )
    ).not.toThrow();
  });

  it("the window is re-entrant and restores correctly", () => {
    runInActionExecution(() => {
      runInActionExecution(() => {});
      expect(() => lift((x: number) => x)).toThrow(/module level/);
    });
    expect(() => lift((x: number) => x)).not.toThrow();
  });

  it("the window survives awaits: an async action's continuation still throws", async () => {
    // An async handler can mint AFTER its first await — long past the sync
    // call frame. The window rides AsyncLocalStorage, so the continuation is
    // still covered (Codex/cubic P1 on the E5 PR).
    await runInActionExecution(async () => {
      await Promise.resolve();
      expect(() => lift((x: number) => x)).toThrow(/module level/);
      await clock.settle();
      expect(() => lift((x: number) => x)).toThrow(/module level/);
    });
    expect(() => lift((x: number) => x)).not.toThrow();
  });

  it("module evaluation interleaving with an awaiting action is NOT blocked", async () => {
    // While an async action awaits, the scheduler may evaluate a module
    // (sync, under an engine frame marked `moduleEvaluation`) — its
    // module-scope builder calls are the LEGAL mints the transformer
    // produces. The window must not leak into them.
    const pending = runInActionExecution(async () => {
      await clock.settle();
    });
    const frame = pushFrame({ moduleEvaluation: true });
    try {
      expect(() => lift((x: number) => x)).not.toThrow();
    } finally {
      popFrame(frame);
    }
    await pending;
  });
});
