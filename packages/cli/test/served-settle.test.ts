import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { Runtime } from "@commonfabric/runner";
import { servedConsequences, settleServed } from "../lib/served-settle.ts";

type Overlay = NonNullable<Runtime["speculationOverlay"]>;

/** A stand-in runtime whose overlay is `overlay`, or that has none. */
function runtimeWith(overlay: Partial<Overlay> | undefined): Runtime {
  const runtime: Partial<Runtime> = {
    speculationOverlay: overlay as Overlay | undefined,
  };
  return runtime as Runtime;
}

describe("served-settle", () => {
  describe("servedConsequences()", () => {
    it("resolves once the overlay's wait for intent quiescence does", async () => {
      const quiescence = Promise.withResolvers<void>();
      let resolved = false;
      const waiting = servedConsequences(
        runtimeWith({ waitForIntentQuiescence: () => quiescence.promise }),
      ).then(() => {
        resolved = true;
      });
      await Promise.resolve();
      expect(resolved).toBe(false);
      quiescence.resolve();
      await waiting;
      expect(resolved).toBe(true);
    });

    it("resolves for a runtime with no overlay", async () => {
      await expect(servedConsequences(runtimeWith(undefined))).resolves
        .toBeUndefined();
    });
  });

  describe("settleServed()", () => {
    it("runs the settle once when it ends with no event awaiting its consequence", async () => {
      let runs = 0;
      await settleServed(runtimeWith({ pendingIntentCount: 0 }), () => {
        runs++;
        return Promise.resolve();
      });
      expect(runs).toBe(1);
    });

    it("runs the settle again when it ends with an event awaiting its consequence", async () => {
      // The first run's last step fires an event, as a reaction to what its
      // last sync delivered can; the second run waits for its consequence.
      const overlay = { pendingIntentCount: 0 };
      let runs = 0;
      await settleServed(runtimeWith(overlay), () => {
        runs++;
        overlay.pendingIntentCount = runs === 1 ? 1 : 0;
        return Promise.resolve();
      });
      expect(runs).toBe(2);
    });

    it("runs the settle once for a runtime with no overlay", async () => {
      let runs = 0;
      await settleServed(runtimeWith(undefined), () => {
        runs++;
        return Promise.resolve();
      });
      expect(runs).toBe(1);
    });
  });
});
