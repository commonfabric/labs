import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { STUCK_NET_MS, stuckNet, withStuckNet } from "./stuck-net.ts";

describe("stuck-net", () => {
  let armed: number[];
  let live: Map<number, () => void>;
  let realSetTimeout: typeof setTimeout;
  let realClearTimeout: typeof clearTimeout;
  let fire: (() => void) | undefined;

  beforeEach(() => {
    armed = [];
    live = new Map();
    fire = undefined;
    realSetTimeout = globalThis.setTimeout;
    realClearTimeout = globalThis.clearTimeout;
    let next = 1;
    // The net's own timer, captured rather than waited on: what the tests
    // below are about is which promise settles and whether the timer is
    // released, neither of which needs the delay to elapse. `live` holds
    // the timers a real runtime would still fire, so clearing one is
    // observable without waiting for a delay that then must not happen.
    globalThis.setTimeout = ((callback: () => void, ms: number) => {
      const id = next++;
      armed.push(ms);
      live.set(id, callback);
      fire = callback;
      return id;
    }) as typeof setTimeout;
    globalThis.clearTimeout = ((id: number) => {
      live.delete(id);
    }) as typeof clearTimeout;
  });

  afterEach(() => {
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
  });

  it("arms its timer at the shared span unless given one", () => {
    stuckNet("a condition");
    stuckNet("a condition", 25);
    expect(armed).toEqual([STUCK_NET_MS, 25]);
  });

  it("rejects naming the condition and the span once the timer fires", async () => {
    const net = stuckNet("the intent", 40);
    fire!();
    await expect(net.rejects).rejects.toThrow(
      "the intent never arrived after 40 ms",
    );
  });

  it("stays pending while the timer has not fired", async () => {
    const net = stuckNet("the intent", 40);
    const raced = await Promise.race([
      net.rejects.then(() => "net" as const, () => "net" as const),
      Promise.resolve("still waiting" as const),
    ]);
    expect(raced).toBe("still waiting");
  });

  it("leaves nothing to fire once cleared, and stays pending", async () => {
    const net = stuckNet("the intent", 40);
    expect(live.size).toBe(1);
    net.clear();
    expect(live.size).toBe(0);
    const raced = await Promise.race([
      net.rejects.then(() => "net" as const, () => "net" as const),
      Promise.resolve("still pending" as const),
    ]);
    expect(raced).toBe("still pending");
  });

  it("carries the value through when the awaited promise wins", async () => {
    expect(await withStuckNet(Promise.resolve(7), "a value", 40)).toBe(7);
    expect(live.size).toBe(0);
  });

  it("carries the awaited promise's own rejection through", async () => {
    await expect(
      withStuckNet(Promise.reject(new Error("its own")), "a value", 40),
    ).rejects.toThrow("its own");
    expect(live.size).toBe(0);
  });

  it("rejects and releases the timer when the net wins", async () => {
    const netted = withStuckNet(
      new Promise<never>(() => {}),
      "a value that never arrives",
      40,
    );
    fire!();
    await expect(netted).rejects.toThrow(
      "a value that never arrives never arrived after 40 ms",
    );
    expect(live.size).toBe(0);
  });

  it("raises a failure whose stack names the caller, not the timer", async () => {
    const net = stuckNet("the intent", 40);
    fire!();
    const error = await net.rejects.catch((raised: Error) => raised);
    expect(error.stack).toContain("stuck-net.test.ts");
  });
});
