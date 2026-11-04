import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  prefersReducedMotion,
  registerSeal,
  type SealLivenessClient,
  unregisterSeal,
} from "./seal-liveness.ts";

const noopClient = (): SealLivenessClient => ({
  updateSeal() {},
  clearSeal() {},
});

describe("seal-liveness", () => {
  it("reports a boolean for reduced-motion preference without throwing", () => {
    expect(typeof prefersReducedMotion()).toBe("boolean");
  });

  it("starts one pointer listener + rAF on the first seal and tears both down when the last unregisters", () => {
    // The visual sheen math needs a real browser (cursor geometry,
    // getBoundingClientRect) and is exercised by the prototype, not here. What
    // we CAN guard cheaply is the leak: the shared controller must add exactly
    // one pointer listener + rAF on the first seal and remove both when the
    // last seal unregisters — otherwise a mount/unmount churn leaks listeners
    // and frames.

    const g = globalThis as Record<string, unknown>;
    const saved = {
      raf: g.requestAnimationFrame,
      caf: g.cancelAnimationFrame,
      add: g.addEventListener,
      remove: g.removeEventListener,
    };
    const events: string[] = [];
    let scheduled = 0;
    let canceled = 0;
    g.requestAnimationFrame = () => {
      scheduled++;
      return 123; // never invoke the callback: we don't want the loop to run
    };
    g.cancelAnimationFrame = () => {
      canceled++;
    };
    g.addEventListener = (type: string) => {
      events.push(`add:${type}`);
    };
    g.removeEventListener = (type: string) => {
      events.push(`remove:${type}`);
    };
    try {
      const a = noopClient();
      const b = noopClient();

      registerSeal(a);
      registerSeal(b);
      expect(events).toContain("add:pointermove");
      expect(scheduled).toBe(1); // one shared rAF, not one per seal

      unregisterSeal(a);
      expect(events.filter((e) => e === "remove:pointermove").length).toBe(0);

      unregisterSeal(b); // last seal gone → teardown
      expect(events).toContain("remove:pointermove");
      expect(canceled).toBe(1);
    } finally {
      g.requestAnimationFrame = saved.raf;
      g.cancelAnimationFrame = saved.caf;
      g.addEventListener = saved.add;
      g.removeEventListener = saved.remove;
    }
  });
});
