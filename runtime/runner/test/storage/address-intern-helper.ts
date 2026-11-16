/**
 * Helper for `address-intern.test.ts`. Runs in its own process so that it can
 * force a collection (`--v8-flags=--expose-gc`) and cross a real task
 * boundary, which a `WeakRef` needs before it can report its target collected;
 * the package's fake-clock preload would freeze that boundary.
 *
 * It prints one JSON report as its last line. The first argument names the
 * scenario:
 *
 * - `growth`: on a new table, interns 4,095 addresses nobody holds, collects,
 *   and interns one more. On another, interns and holds `HELD` addresses,
 *   sweeps, interns `HELD - 1` that nobody holds, collects, and interns one
 *   more. It reports the slot count after each step, so a test can see each
 *   sweep run at the threshold the class states and drop what nobody holds.
 * - `release`: interns one address, drops it, collects and sweeps, then
 *   interns it again. It reports whether the first address was collected,
 *   and `size` and the count of path nodes after the sweep and after the
 *   second call.
 */

import { AddressInterner } from "../../src/storage/address-intern.ts";
import type {
  IMemorySpaceAddress,
  MemorySpace,
  URI,
} from "../../src/storage/interface.ts";

/** Addresses the `growth` scenario holds across its second sweep. */
const HELD = 5_000;

const scenario = Deno.args[0];
if (scenario !== "growth" && scenario !== "release") {
  throw new Error(`Unknown scenario: \`${scenario}\``);
}

const gc = (globalThis as { gc?: () => void }).gc;
if (!gc) throw new Error("run with --v8-flags=--expose-gc");

const space = "did:key:z6Mk-address-intern" as MemorySpace;
const interner = new AddressInterner();

/**
 * Makes every address nobody holds collectable and collects it. A `WeakRef`
 * target created in a turn survives that turn whatever holds it, so this
 * crosses one task boundary first. This is an event-loop yield, not a wait.
 */
async function collect(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  gc!();
  gc!();
}

if (scenario === "growth") {
  const size = (of: AddressInterner) => of.accessForTestingOnly.size();
  const internFresh = (into: AddressInterner, label: string, count: number) => {
    const made: IMemorySpaceAddress[] = [];
    for (let i = 0; i < count; i++) {
      made.push(
        into.address(space, "space", `of:${label}-${i}` as URI, undefined, [
          "value",
          `${i % 100}`,
        ]),
      );
    }
    return made;
  };

  // Floor: a table that has never swept sweeps at 4,096 slots.
  const fresh = new AddressInterner();
  internFresh(fresh, "floor", 4095);
  const floorBefore = size(fresh);
  await collect();
  internFresh(fresh, "floor-last", 1);
  const floorAfter = size(fresh);

  // Doubling: after a sweep that finds `HELD` live addresses, the next sweep
  // runs when the slots reach twice that.
  const held = internFresh(interner, "held", HELD);
  interner.accessForTestingOnly.sweep();
  const sizeAfterSweep = size(interner);
  internFresh(interner, "dropped", HELD - 1);
  const sizeBelowThreshold = size(interner);
  await collect();
  internFresh(interner, "dropped-last", 1);
  const sizeAtThreshold = size(interner);

  console.log(JSON.stringify({
    floorBefore,
    floorAfter,
    sizeAfterSweep,
    sizeBelowThreshold,
    sizeAtThreshold,
    stillHeld: held.length,
  }));
} else {
  const intern = () =>
    interner.address(space, "space", "of:released" as URI, undefined, [
      "value",
      "a",
      "b",
    ]);

  let first: IMemorySpaceAddress | undefined = intern();
  const firstRef = new WeakRef(first);
  first = undefined;
  await collect();
  interner.accessForTestingOnly.sweep();
  const collected = firstRef.deref() === undefined;
  const sizeAfterSweep = interner.accessForTestingOnly.size();
  const nodesAfterSweep = interner.accessForTestingOnly.pathNodeCount();

  const second = intern();
  console.log(JSON.stringify({
    collected,
    sizeAfterSweep,
    nodesAfterSweep,
    sizeAfterSecond: interner.accessForTestingOnly.size(),
    nodesAfterSecond: interner.accessForTestingOnly.pathNodeCount(),
    secondPath: second.path,
  }));
}
