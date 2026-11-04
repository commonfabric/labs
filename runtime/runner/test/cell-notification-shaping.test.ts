import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { holdShapedCell, WakeShaper } from "../src/scheduler/wake-shaping.ts";

// The old CellNotificationShaper surface, expressed over the unified WakeShaper
// + holdShapedCell adapter, so the cell-path contract assertions below stay
// exactly as they were. Deterministic zero-length window so overflow releases
// on the next macrotask; the argument is the burst budget (bucket capacity).
function shaper(capacity = 10) {
  const engine = new WakeShaper(0, capacity);
  return {
    hold: (
      groupKey: string,
      itemKey: string,
      chargeKey: object,
      deliver: () => void,
    ) => holdShapedCell(engine, groupKey, itemKey, chargeKey, deliver),
    hasPending: () => engine.hasPending(),
    whenDrained: () => engine.whenDrained(),
    dispose: () => engine.dispose(),
  };
}

// A fresh charge key stands for a distinct source commit (a distinct gesture).
function commit(): object {
  return {};
}

describe("wake shaper (cell path)", () => {
  it("delivers a single isolated notification in realtime (deferred, not synchronous)", async () => {
    const s = shaper();
    const seen: string[] = [];
    s.hold("pattern-a", "cell-1", commit(), () => seen.push("1"));
    expect(seen).toEqual([]); // never delivered synchronously inside hold()
    expect(s.hasPending()).toBe(true); // delivery in flight
    await s.whenDrained();
    expect(seen).toEqual(["1"]);
    expect(s.hasPending()).toBe(false);
    s.dispose();
  });

  it("delivers each notification for a cell in realtime while burst tokens remain", async () => {
    const s = shaper(3); // burst budget of 3
    const delivered: number[] = [];
    s.hold("pattern-a", "cell-1", commit(), () => delivered.push(1));
    s.hold("pattern-a", "cell-1", commit(), () => delivered.push(2));
    s.hold("pattern-a", "cell-1", commit(), () => delivered.push(3));
    await s.whenDrained();
    // Three distinct commits within the burst: each keystroke delivered (realtime
    // typing), no intermediate value coalesced away.
    expect(delivered).toEqual([1, 2, 3]);
    s.dispose();
  });

  it("shares one burst token across all reader wakes from one commit", async () => {
    const s = shaper(1); // burst budget of just ONE
    const seen: string[] = [];
    const c = commit(); // one commit fanning out to two readers (two cells)
    s.hold("pattern-a", "cell-1", c, () => seen.push("r1"));
    s.hold("pattern-a", "cell-2", c, () => seen.push("r2"));
    // Both readers ride the single token and deliver in realtime, even though the
    // bucket held only one token — a token counts the gesture, not the fan-out.
    // (Per-reader charging would have overflowed r2 to the trailing flush.)
    await s.whenDrained();
    expect(seen.sort()).toEqual(["r1", "r2"]);
    s.dispose();
  });

  it("coalesces sustained overflow for a cell to the latest value (last-wins)", async () => {
    const s = shaper(1); // burst budget of 1, so the 2nd/3rd commits overflow
    const delivered: number[] = [];
    s.hold("pattern-a", "cell-1", commit(), () => delivered.push(1)); // burst
    s.hold("pattern-a", "cell-1", commit(), () => delivered.push(2)); // overflow, superseded
    s.hold("pattern-a", "cell-1", commit(), () => delivered.push(3)); // overflow, latest
    await s.whenDrained();
    // The burst value (1) plus the latest overflow (3); the intermediate (2) is
    // coalesced away — for a $value cell only the newest value matters.
    expect(delivered).toEqual([1, 3]);
    s.dispose();
  });

  it("delivers distinct cells of distinct commits without dropping any", async () => {
    const s = shaper(1); // burst budget of 1: commit A leads, commit B overflows
    const order: string[] = [];
    s.hold("pattern-a", "cell-1", commit(), () => order.push("c1"));
    s.hold("pattern-a", "cell-2", commit(), () => order.push("c2"));
    // One shared bucket, but distinct cells are each preserved (not last-wins).
    expect(s.hasPending()).toBe(true);
    await s.whenDrained();
    expect(order.sort()).toEqual(["c1", "c2"]);
    s.dispose();
  });

  it("keeps distinct groups (patterns) independent", async () => {
    const s = shaper(1);
    const seen: string[] = [];
    s.hold("pattern-a", "cell-1", commit(), () => seen.push("a"));
    s.hold("pattern-b", "cell-1", commit(), () => seen.push("b"));
    await s.whenDrained();
    expect(seen.sort()).toEqual(["a", "b"]);
    s.dispose();
  });

  it("isolates deliver thunks: one throwing does not skip the rest of the group", async () => {
    const s = shaper(1); // cell-1 is the burst (throws), cell-2 overflows
    const seen: string[] = [];
    s.hold("pattern-a", "cell-1", commit(), () => {
      throw new Error("boom");
    });
    s.hold("pattern-a", "cell-2", commit(), () => seen.push("c2"));
    await s.whenDrained();
    expect(seen).toEqual(["c2"]);
    s.dispose();
  });

  it("delivers nothing after dispose", async () => {
    const s = shaper();
    const seen: string[] = [];
    s.hold("pattern-a", "cell-1", commit(), () => seen.push("1"));
    s.dispose();
    expect(s.hasPending()).toBe(false);
    await clock.settle();
    expect(seen).toEqual([]); // the deferred delivery is cancelled by dispose
  });
});
