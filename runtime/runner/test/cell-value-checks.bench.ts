/**
 * What a value costs to be checked before a cell takes it. `Cell.of()` checks
 * that its initial value holds only static data and no cycle, and
 * `addUnique()` checks each candidate for a cycle before comparing it against
 * what the list holds. Each check is a walk over every container of the
 * value.
 *
 * Three shapes:
 *
 *   - **records**: a list of records, each holding a tag list and an address,
 *     which is the shape a document takes. Three containers per record under
 *     one root.
 *   - **flat**: one object holding a hundred scalars. A single container, so a
 *     per-container cost has nothing to save here; it is the control.
 *   - **chain**: a hundred objects nested one inside the next. The walk is a
 *     hundred deep at the bottom, with every ancestor in play.
 *
 * `Cell.of()` creates no link and writes nothing, so the call is the check
 * plus wrapping the value in a schema, and what the check costs is a real
 * share of it. It is timed as a batch of `BATCH` calls on as many values,
 * each figure being the cost of the batch: one call on the smallest shape
 * runs well under the length at which Deno honors an explicit timer, and a
 * body timed whole would report its scaffolding.
 *
 * `addUnique()` is timed against a list holding one element of the same
 * shape, with a candidate that differs from it in content, so the call reads
 * the list, checks the candidate, compares it against the element, and then
 * writes it. The write is most of the call and grows with the value as the
 * check does, so these figures say what the whole call costs by shape, and
 * whether the check's share of it has moved is a question for the `Cell.of()`
 * figures. Each iteration opens a transaction outside the timed window and
 * aborts it afterward, so no iteration pays for one and none leaves anything
 * behind for the next.
 *
 * Both are run under a frame, as a handler runs, and it is pushed and popped
 * around each iteration so that none is left behind for whatever runs next in
 * the same process.
 */

import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import { popFrame, pushFrame } from "../src/builder/pattern.ts";
import { Runtime } from "../src/runtime.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";

const signer = await Identity.fromPassphrase("bench cell value checks");
const space = signer.did();

/** Records in the `records` shape. */
const RECORDS = 100;

/** Scalars in the `flat` shape. */
const FLAT_MEMBERS = 100;

/** Objects in the `chain` shape, which is also how deep the walk goes. */
const CHAIN_DEPTH = 100;

/** How many `Cell.of()` calls one timed batch makes. */
const BATCH = 16;

/**
 * A list of `RECORDS` records, each a small tree of its own. Two builds with
 * the same `seed` are equal by content, and two with different seeds are not.
 */
function records(seed: number): unknown {
  return Array.from({ length: RECORDS }, (_, index) => ({
    id: index,
    name: `Record ${seed}-${index}`,
    tags: [`tag-${index % 7}`, `tag-${index % 11}`, `tag-${index % 13}`],
    address: {
      street: `${index} Main Street`,
      city: "Springfield",
      zip: String(10000 + index),
    },
  }));
}

/** One object holding `FLAT_MEMBERS` scalars; `seed` as for `records()`. */
function flat(seed: number): unknown {
  return Object.fromEntries(
    Array.from(
      { length: FLAT_MEMBERS },
      (_, index) => [`m${index}`, index + seed],
    ),
  );
}

/** `CHAIN_DEPTH` objects, each holding the next; `seed` as for `records()`. */
function chain(seed: number): unknown {
  let node: unknown = { depth: CHAIN_DEPTH, seed };

  for (let depth = CHAIN_DEPTH - 1; depth > 0; depth--) {
    node = { depth, next: node };
  }

  return node;
}

/** The shapes. Every case builds its own value, so none sees another's. */
const SHAPES = [
  { name: "records", build: records },
  { name: "flat", build: flat },
  { name: "chain", build: chain },
] as const;

const storageManager = StorageManager.emulate({ as: signer });
const runtime = new Runtime({
  apiUrl: new URL(import.meta.url),
  storageManager,
});

const { commonfabric: { Cell } } = createTrustedBuilder(runtime);

//
// Cell.of()
//

{
  const tx = runtime.edit();

  for (const shape of SHAPES) {
    const values = Array.from({ length: BATCH }, () => shape.build(0));

    Deno.bench(shape.name, { group: `Cell.of() x${BATCH}` }, (b) => {
      const frame = pushFrame({ runtime, tx, space });

      try {
        b.start();
        for (const value of values) Cell.of(value);
        b.end();
      } finally {
        popFrame(frame);
      }
    });
  }
}

//
// addUnique()
//

for (const shape of SHAPES) {
  const cause = `cell-value-checks-${shape.name}`;
  const held = shape.build(0);

  {
    const tx = runtime.edit();

    runtime.getCell<unknown[]>(space, cause, undefined, tx).set([held]);
    await tx.commit().settled;
  }

  Deno.bench(shape.name, { group: "addUnique()" }, (b) => {
    const tx = runtime.edit();
    // Pushed before the cell is made, which is when a cell takes its frame.
    const frame = pushFrame({ runtime, tx, space });

    try {
      const cell = runtime.getCell<unknown[]>(space, cause, undefined, tx);
      const candidate = shape.build(1);

      b.start();
      cell.addUnique(candidate);
      b.end();
    } finally {
      popFrame(frame);
      tx.abort("bench");
    }
  });
}
