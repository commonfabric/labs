/**
 * Helper for `address-intern.test.ts`. Runs in its own process so that it can
 * force a collection (`--v8-flags=--expose-gc`) and cross a real task
 * boundary, which a `WeakRef` needs before it can report its target collected;
 * the package's fake-clock preload would freeze that boundary.
 *
 * It prints one JSON report as its last line. The first argument names the
 * scenario:
 *
 * - `growth`: interns `PHASE` distinct addresses and holds them, releases
 *   them, collects, then interns and holds `PHASE` more. It reports the
 *   largest `size` seen after any call, the most addresses held at once, and
 *   `size` at the end of each phase.
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

/** Addresses each phase of the `growth` scenario interns. */
const PHASE = 10_000;

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
  let largestSize = 0;
  let held: IMemorySpaceAddress[] = [];
  let mostHeld = 0;

  const internPhase = (phase: number) => {
    for (let i = 0; i < PHASE; i++) {
      held.push(
        interner.address(
          space,
          "space",
          `of:doc-${phase}-${i}` as URI,
          undefined,
          ["value", `${i % 100}`],
        ),
      );
      mostHeld = Math.max(mostHeld, held.length);
      largestSize = Math.max(largestSize, interner.size);
    }
  };

  internPhase(1);
  const sizeAfterFirst = interner.size;
  held = [];
  await collect();
  internPhase(2);

  console.log(JSON.stringify({
    largestSize,
    mostHeld,
    sizeAfterFirst,
    sizeAfterSecond: interner.size,
    heldAfterSecond: held.length,
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
  const sizeAfterSweep = interner.size;
  const nodesAfterSweep = interner.accessForTestingOnly.pathNodeCount();

  const second = intern();
  console.log(JSON.stringify({
    collected,
    sizeAfterSweep,
    nodesAfterSweep,
    sizeAfterSecond: interner.size,
    nodesAfterSecond: interner.accessForTestingOnly.pathNodeCount(),
    secondPath: second.path,
  }));
}
