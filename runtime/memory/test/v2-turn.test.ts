// `armTurn` schedules a callback onto a later turn of the event loop. A
// zero-delay turn is claimed two ways — a timer, which every host has and
// which a fake-clock harness accounts for, and `setImmediate`, which is the
// same turn for a fraction of the cost. A delayed turn is a real wait and
// only the timer can give one.

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { armTurn } from "../v2/turn.ts";

// Counts zero-delay timers that are armed and have not yet run — what the
// runner's fake-clock harness looks at to decide a test has settled.
const withTimerCensus = async (
  body: (armed: Set<number>) => Promise<void>,
): Promise<void> => {
  const armed = new Set<number>();
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  globalThis.setTimeout = ((
    handler: () => void,
    delay?: number,
    ...rest: unknown[]
  ) => {
    if (delay !== 0) return realSetTimeout(handler, delay, ...rest);
    let id = 0;
    id = realSetTimeout(
      () => {
        armed.delete(id);
        handler();
      },
      0,
      ...rest,
    ) as unknown as number;
    armed.add(id);
    return id;
  }) as unknown as typeof setTimeout;
  globalThis.clearTimeout = ((id?: number) => {
    if (id !== undefined) armed.delete(id);
    realClearTimeout(id);
  }) as unknown as typeof clearTimeout;
  try {
    await body(armed);
  } finally {
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
  }
};

describe("turn", () => {
  describe("armTurn()", () => {
    it("runs the handler on a later turn, not inside a microtask cascade", async () => {
      let ran = 0;
      const done = new Promise<void>((resolve) =>
        armTurn(() => {
          ran++;
          resolve();
        })
      );
      for (let hop = 0; hop < 50; hop++) await Promise.resolve();
      expect(ran).toBe(0);

      await done;
      expect(ran).toBe(1);
    });

    it("runs the handler once when both claims are live", async () => {
      let ran = 0;
      await new Promise<void>((resolve) =>
        armTurn(() => {
          ran++;
          resolve();
        })
      );
      // Two turns' worth of slack for a second claim to fire in, had one
      // survived the first.
      await new Promise<void>((resolve) => armTurn(resolve));
      await new Promise<void>((resolve) => armTurn(resolve));
      expect(ran).toBe(1);
    });

    it("runs the handler once when a cancelled claim fires anyway", async () => {
      // Cancelling a claim does not everywhere stop it: a scheduler that
      // dispatches a batch from a snapshot can call a callback cleared
      // earlier in that same batch, which the fake-clock harness did until it
      // was taught otherwise. This stands in for such a scheduler by ignoring
      // `clearImmediate`, and fires the cancelled claim by hand.
      const holder = globalThis as {
        setImmediate?: (handler: () => void) => unknown;
        clearImmediate?: (handle: unknown) => void;
      };
      const realSetImmediate = holder.setImmediate;
      const realClearImmediate = holder.clearImmediate;
      let cancelledClaim: (() => void) | undefined;
      holder.setImmediate = (handler: () => void) => {
        cancelledClaim = handler;
        return 0;
      };
      holder.clearImmediate = () => {};

      let ran = 0;
      const arrived = Promise.withResolvers<void>();
      try {
        // The stubbed claim never fires on its own, so the timer takes the
        // turn and cancels it.
        armTurn(() => {
          ran++;
          arrived.resolve();
        });
      } finally {
        holder.setImmediate = realSetImmediate;
        holder.clearImmediate = realClearImmediate;
      }
      await arrived.promise;
      expect(ran).toBe(1);

      cancelledClaim!();
      expect(ran).toBe(1);
    });

    it("keeps a zero-delay timer armed until the turn arrives", async () => {
      await withTimerCensus(async (armed) => {
        const before = armed.size;
        const done = new Promise<void>((resolve) => armTurn(resolve));
        expect(armed.size).toBe(before + 1);
        await done;
        expect(armed.size).toBe(before);
      });
    });

    it("runs a zero-delay turn with the timer stubbed out", async () => {
      // The timer is the claim that is always available; `setImmediate` is
      // the one that makes the turn cheap. With `setTimeout` unable to fire,
      // the turn still has to arrive, or this wait never resolves.
      const realSetTimeout = globalThis.setTimeout;
      globalThis.setTimeout = (() => 0) as unknown as typeof setTimeout;
      try {
        await new Promise<void>((resolve) => armTurn(resolve));
      } finally {
        globalThis.setTimeout = realSetTimeout;
      }
    });

    it("runs a zero-delay turn with setImmediate absent", async () => {
      const holder = globalThis as { setImmediate?: unknown };
      const original = holder.setImmediate;
      delete holder.setImmediate;
      let done: Promise<void>;
      try {
        done = new Promise<void>((resolve) => armTurn(resolve));
      } finally {
        holder.setImmediate = original;
      }
      await done;
    });

    it("claims a delayed turn with the timer alone", async () => {
      // A delay above zero asks for a real wait, and `setImmediate` would
      // collapse it to the next turn — which for the server's subscription
      // refresh would mean no coalescing window at all.
      const holder = globalThis as {
        setImmediate?: (handler: () => void) => unknown;
      };
      const original = holder.setImmediate!;
      let calls = 0;
      holder.setImmediate = (handler: () => void) => {
        calls++;
        return original(handler);
      };
      try {
        const zero = new Promise<void>((resolve) => armTurn(resolve, 0));
        await zero;
        expect(calls).toBe(1);

        const delayed = new Promise<void>((resolve) => armTurn(resolve, 1));
        await delayed;
        expect(calls).toBe(1);
      } finally {
        holder.setImmediate = original;
      }
    });

    it("does not run the handler after cancel()", async () => {
      let ran = 0;
      const turn = armTurn(() => {
        ran++;
      });
      turn.cancel();
      await new Promise<void>((resolve) => armTurn(resolve));
      await new Promise<void>((resolve) => armTurn(resolve));
      expect(ran).toBe(0);
    });
  });
});
