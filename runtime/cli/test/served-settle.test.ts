import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { Runtime } from "@commonfabric/runner";
import { servedConsequences, settleServed } from "../lib/served-settle.ts";

type Overlay = NonNullable<Runtime["speculationOverlay"]>;

/**
 * A stand-in runtime whose overlay is `overlay`, or that has none, and whose
 * storage manager reports each round trip to `onPull`.
 */
function runtimeWith(
  overlay: Partial<Overlay> | undefined,
  onPull: () => void = () => {},
): Runtime {
  const runtime = {
    speculationOverlay: overlay as Overlay | undefined,
    storageManager: {
      pullOpenSpacesToHead: () => {
        onPull();
        return Promise.resolve();
      },
    },
  };
  return runtime as unknown as Runtime;
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

    it("waits for the serving loop's rest, and delivers it, before returning", async () => {
      const steps: string[] = [];
      await settleServed(
        runtimeWith(undefined, () => steps.push("pull")),
        () => {
          steps.push("settle");
          return Promise.resolve();
        },
        () => {
          steps.push("quiescence");
          return Promise.resolve(7);
        },
      );
      expect(steps).toStrictEqual([
        "settle",
        "quiescence",
        "pull",
        "settle",
        "quiescence",
      ]);
    });

    it("goes round again when the loop did something during the pass", async () => {
      // The reactions to what the first pass delivered gave the loop more to
      // do, so the second wait reaches a later rest.
      const rests = [1, 2, 2];
      let waits = 0;
      let runs = 0;
      await settleServed(
        runtimeWith(undefined),
        () => {
          runs++;
          return Promise.resolve();
        },
        () => Promise.resolve(rests[waits++]),
      );
      expect(waits).toBe(3);
      expect(runs).toBe(3);
    });

    it("waits for no serving loop while an event awaits its consequence", async () => {
      // The first run ends with an event outstanding, and the second without.
      const overlay = { pendingIntentCount: 0 };
      const outstanding = [1, 0, 0];
      const steps: string[] = [];
      await settleServed(
        runtimeWith(overlay),
        () => {
          steps.push("settle");
          overlay.pendingIntentCount = outstanding.shift()!;
          return Promise.resolve();
        },
        () => {
          steps.push("quiescence");
          return Promise.resolve(0);
        },
      );
      expect(steps).toStrictEqual([
        "settle",
        "settle",
        "quiescence",
        "settle",
        "quiescence",
      ]);
    });
  });
});
