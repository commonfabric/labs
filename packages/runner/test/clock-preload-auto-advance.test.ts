// The auto-advance clock (`packages/test-support/test/clock-preload.ts`,
// installed by this package's preload) fires the runtime's own positive-delay
// timers when the event loop is idle. Two properties of that pump are easy to
// lose and cheap to pin. "Idle" includes the zero-delay turns still armed: the
// loopback transport delivers a frame per turn and the memory server's refresh
// takes turns of its own, so a caught-up frame reaches a replica across a chain
// of them, and a pump that jumped to a production timer as soon as the current
// turn ended fired a 30 s backstop in the middle of that chain (the conflict
// read-repair wait in `src/storage/v2.ts`; see
// `silent-backstop-guard.test.ts`). And a timer armed for the instant the
// clock already stands at — the second of two armed together, once the first
// has fired — is due, not past.

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { sleep } from "@commonfabric/utils/sleep";

describe("clock-preload auto-advance", () => {
  it("runs a chain of zero-delay turns to its end before jumping to a production timer", async () => {
    const started = Date.now();
    // Armed from `src/` (the utils sleep), so the pump owns it.
    const timer = sleep(30_000).then(() => "timer" as const);
    // A chain of turns, each armed only once the one before it has run —
    // the shape of a frame delivered a turn at a time.
    const hops = 8;
    let completed = 0;
    const chain = new Promise<"chain">((resolve) => {
      const hop = () => {
        completed++;
        if (completed === hops) resolve("chain");
        else setTimeout(hop, 0);
      };
      setTimeout(hop, 0);
    });

    expect(await Promise.race([timer, chain])).toBe("chain");
    expect(completed).toBe(hops);
    expect(Date.now() - started, "no logical time passed during the chain")
      .toBe(0);

    // With the chain done, the timer is the only pending work: the pump
    // jumps to it.
    expect(await timer).toBe("timer");
    expect(Date.now() - started).toBe(30_000);
  });

  it("fires both of two production timers armed for the same instant", async () => {
    const started = Date.now();
    const both = await Promise.all([
      sleep(100).then(() => "first" as const),
      sleep(100).then(() => "second" as const),
    ]);
    expect(both).toEqual(["first", "second"]);
    expect(Date.now() - started).toBe(100);
  });
});
