import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { FakeTime } from "@std/testing/time";

import {
  sleep,
  timeout,
  unrefTimer,
  yieldToEventLoop,
} from "@commonfabric/utils/sleep";

// `sleep` and `timeout` are delay utilities, so their tests want controlled
// time rather than a padded real-time bound. Each opens a `FakeTime` (from
// `@std/testing/time`) with `using`, which freezes the real timer `sleep` and
// `timeout` arm and restores the clock when the block ends.
// `time.tickAsync(ms)` advances the fake clock and settles the promises the
// fired timers resolve, and `Date.now()` reports the faked time, so the timing
// assertions are exact and cannot flake. The suites below that measure real
// elapsed time or touch real Deno timers -- `yieldToEventLoop` and
// `unrefTimer` -- open no `FakeTime` and run on the real clock.

/** Hold the event loop synchronously for ~ms, like a CPU-bound compile step. */
const busySpin = (ms: number) => {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    // burn
  }
};

describe("sleep()", () => {
  it("resolves once logical time reaches the delay, not before", async () => {
    using time = new FakeTime();
    const start = Date.now();
    let resolved = false;
    const done = sleep(5).then(() => {
      resolved = true;
    });

    await time.tickAsync(4);
    expect(resolved).toBe(false); // four of five milliseconds have elapsed

    await time.tickAsync(1);
    await done;
    expect(resolved).toBe(true);
    // The promise resolved after exactly five milliseconds of faked time.
    expect(Date.now() - start).toBe(5);
  });
});

describe("timeout()", () => {
  it("rejects with the given message once the delay elapses, not before", async () => {
    using time = new FakeTime();
    let state: "pending" | "rejected" = "pending";
    let caught: unknown;
    const settled = timeout(3, "took too long").catch((error) => {
      state = "rejected";
      caught = error;
    });

    await time.tickAsync(2);
    expect(state).toBe("pending"); // still one millisecond short of rejecting

    await time.tickAsync(1);
    await settled;
    expect(state).toBe("rejected");
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe("took too long");
  });
});

describe("yieldToEventLoop()", () => {
  it("runs a message task queued before the yield ahead of the continuation", async () => {
    // Awaiting a resolved promise only yields a MICROtask, which would leave
    // this already-queued message event unhandled. yieldToEventLoop must be a
    // real macrotask turn through the posted-message task source, so the
    // message queued BEFORE the yield runs BEFORE the continuation.
    const order: string[] = [];
    const { port1, port2 } = new MessageChannel();
    const delivered = new Promise<void>((resolve) => {
      port1.onmessage = () => {
        order.push("queued-message");
        resolve();
      };
    });
    port2.postMessage(null);

    await yieldToEventLoop();
    order.push("continuation");

    await delivered;
    port1.close();
    port2.close();
    expect(order).toEqual(["queued-message", "continuation"]);
  });

  it("lets due timers fire across a yield chain (timer-turn budget)", async () => {
    // A pure posted-message chain starves timers on some hosts (measured in
    // Deno: an armed interval never fires behind a MessageChannel chain).
    // Every TIMER_TURN_BUDGET_MS the yield additionally takes one
    // setTimeout(0) hop, so a long CPU-bound loop that yields between steps
    // still lets due timers run. Spin a few ms per iteration so the budget
    // elapses and the hop is taken within a bounded number of yields.
    let ticks = 0;
    const id = setInterval(() => {
      ticks++;
    }, 1);
    try {
      for (let i = 0; i < 20 && ticks === 0; i++) {
        busySpin(3);
        await yieldToEventLoop();
      }
    } finally {
      clearInterval(id);
    }
    expect(ticks).toBeGreaterThan(0);
  });

  it("falls back to a plain timeout when `MessageChannel` is unavailable", async () => {
    const holder = globalThis as { MessageChannel?: unknown };
    const original = holder.MessageChannel;
    holder.MessageChannel = undefined;
    try {
      // The fallback must not touch MessageChannel at all: reaching the
      // message path with the constructor stubbed away would throw.
      await yieldToEventLoop();
    } finally {
      holder.MessageChannel = original;
    }
    expect(typeof MessageChannel).toBe("function");
  });
});

describe("unrefTimer()", () => {
  it("returns the id and is safe to call on a live interval", () => {
    const id = setInterval(() => {}, 60_000);
    try {
      expect(unrefTimer(id)).toBe(id);
    } finally {
      clearInterval(id);
    }
  });

  it("detaches the timer through `Deno.unrefTimer()`", () => {
    const deno = (globalThis as {
      Deno?: { unrefTimer?: (id: number) => void };
    }).Deno!;
    const original = deno.unrefTimer!;
    const seen: number[] = [];
    deno.unrefTimer = (id: number) => {
      seen.push(id);
      original(id);
    };
    let id: ReturnType<typeof setInterval> | undefined;
    try {
      id = setInterval(() => {}, 60_000);
      const returned = unrefTimer(id);
      expect(returned).toBe(id);
      expect(seen).toEqual([id as unknown as number]);
    } finally {
      deno.unrefTimer = original;
      if (id !== undefined) clearInterval(id);
    }
  });

  it("is a no-op that still returns the id when `Deno.unrefTimer()` is unavailable", () => {
    // In the browser there is no Deno namespace; the nearest equivalent here
    // is a Deno namespace without unrefTimer. The call must not throw and
    // must still hand the id back for chaining.
    const deno = (globalThis as { Deno?: { unrefTimer?: unknown } }).Deno!;
    const original = deno.unrefTimer;
    deno.unrefTimer = undefined;
    try {
      const id = setInterval(() => {}, 60_000);
      try {
        expect(unrefTimer(id)).toBe(id);
      } finally {
        clearInterval(id);
      }
    } finally {
      deno.unrefTimer = original;
    }
  });
});
