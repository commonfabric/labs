/**
 * What it costs to walk a list of links through a materialized view.
 *
 * This is the shape a derivation takes when it reads a list whose elements are
 * references: the view materializes an element on access, materializing it
 * resolves the link the element is, and resolving a link records a dereference
 * hop on the transaction. So the cost of the walk is the cost of one hop times
 * the number of them, and a derivation declared over a whole list pays it
 * again on every change to any element of that list.
 *
 * The fixture is a row list of the shape a pivot table has: each element is a
 * link to a row document, and each row names its subject with a second link.
 * Touching a row therefore costs two hops, which is what makes a scan's hop
 * count a property of the list rather than of the walk that reads it.
 *
 * Three groups, each measuring the same walk against a different state of the
 * transaction it runs on:
 *
 *   - **first**: the walk that pulls each row document into the transaction
 *     for the first time. The floor for a view that has to load.
 *   - **repeat**: the same walk again on the same transaction, where every hop
 *     is one this transaction has already resolved and already recorded. What
 *     separates it from **first** is what a resolution keeps.
 *   - **past a write**: the same walk with a write in front of it, which is
 *     the shape a board is actually read in — something is always being
 *     written — and drops the resolution memo the repeat walk hits.
 *
 * One runtime and one seeded list serve the whole file, and every iteration
 * aborts its transaction, so no iteration pays for a runtime, a store, or a
 * document write, and none leaves state behind for the next.
 *
 * **repeat** and **past a write** each walk once untimed before the bracket,
 * so their timed window finds every row already in the transaction and
 * measures only what the interlude cost. **first** times its only walk, which
 * is what makes it the cold baseline: the load is the thing it is there to
 * report.
 *
 * Environment controls:
 * - LINK_SCAN_ROWS: rows in the list, default 50
 */

import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import { type JSONSchema } from "../src/builder/types.ts";
import { Runtime } from "../src/runtime.ts";
import { benchDiagnostic } from "./bench-diagnostics.ts";

const signer = await Identity.fromPassphrase("bench link scan");
const space = signer.did();

/**
 * Rows in the list.
 *
 * Fifty is the size a board reaches while still feeling like one screen of
 * work, and the size at which a per-row derivation over the whole list already
 * costs a person real time.
 */
const ROWS = Number(Deno.env.get("LINK_SCAN_ROWS") ?? "50");

/**
 * What a reader of the list declares.
 *
 * Both reference fields are declared `unknown`: they hold links that a reader
 * compares by identity and never reads through, and declaring them any wider
 * would expand the subject document into the walk and measure that instead.
 * That is also what a pattern declaring `unknown` compiles to, which matters
 * more than it looks — the empty schema `{}` narrows to the `true` schema on
 * every child, and a fixture written that way measures the cost of THAT and
 * reports it as the cost of walking a list.
 */
const ROW_LIST_SCHEMA = {
  type: "array",
  items: {
    type: "object",
    properties: {
      subject: { type: "unknown" },
      mentionedBy: { type: "array", items: { type: "unknown" } },
    },
  },
} as const satisfies JSONSchema;

const storageManager = StorageManager.emulate({ as: signer });
const runtime = new Runtime({
  apiUrl: new URL(import.meta.url),
  storageManager,
});

const LIST_CAUSE = "link-scan-row-list";
const SCRATCH_CAUSE = "link-scan-scratch";

{
  const tx = runtime.edit();
  const subjects = Array.from({ length: ROWS }, (_, index) => {
    const cell = runtime.getCell<{ title: string }>(
      space,
      `link-scan-subject-${index}`,
      undefined,
      tx,
    );
    cell.set({ title: `Subject ${index}` });
    return cell;
  });
  // `setRaw` with an explicit link, so each row holds a reference to its
  // subject rather than a copy of it. A row read through the schema above then
  // resolves that reference, which is the second hop each row costs.
  const rows = subjects.map((subject, index) => {
    const cell = runtime.getCell<unknown>(
      space,
      `link-scan-row-${index}`,
      undefined,
      tx,
    );
    cell.setRaw({ subject: subject.getAsLink(), mentionedBy: [] });
    return cell;
  });
  runtime.getCell<unknown>(space, LIST_CAUSE, undefined, tx)
    .setRaw(rows.map((row) => row.getAsLink()));
  runtime.getCell<{ epoch: number }>(space, SCRATCH_CAUSE, undefined, tx)
    .set({ epoch: 0 });
  await tx.commit().settled;
}

/**
 * Open a transaction that materializes lazily, which is what puts an element
 * read on the view path a derivation's argument takes.
 */
const open = () => {
  const tx = runtime.edit();
  tx.markLazyMaterialize(true);
  return {
    tx,
    list: runtime.getCell(space, LIST_CAUSE, ROW_LIST_SCHEMA, tx),
    scratch: runtime.getCell<{ epoch: number }>(
      space,
      SCRATCH_CAUSE,
      undefined,
      tx,
    ),
  };
};

/**
 * Touch every row's subject reference, which is what materializes the row and
 * resolves both of its links. Returns a count so the walk cannot be optimized
 * away, and so a fixture that stopped resolving fails loudly rather than
 * reporting a fast empty walk.
 */
const walk = (list: ReturnType<typeof open>["list"]): number => {
  const view = list.get() as { subject: unknown }[];
  let touched = 0;
  for (let index = 0; index < view.length; index++) {
    if (view[index].subject !== undefined) touched++;
  }
  if (touched !== ROWS) {
    throw new Error(`walk resolved ${touched} of ${ROWS} rows`);
  }
  return touched;
};

Deno.bench({
  name: `walk ${ROWS} rows - first`,
  group: "link scan",
  baseline: true,
  fn(b) {
    const { tx, list } = open();
    b.start();
    walk(list);
    b.end();
    tx.abort("bench");
  },
});

Deno.bench({
  name: `walk ${ROWS} rows - repeat`,
  group: "link scan",
  fn(b) {
    const { tx, list } = open();
    // Untimed: the timed walk below finds every row already in the
    // transaction, so what it measures is what a resolution keeps rather than
    // what a load costs.
    walk(list);
    b.start();
    walk(list);
    b.end();
    tx.abort("bench");
  },
});

Deno.bench({
  name: `walk ${ROWS} rows - past a write`,
  group: "link scan",
  fn(b) {
    const { tx, list, scratch } = open();
    walk(list);
    // A write to an unrelated document, which is enough to drop the
    // transaction's resolution memo: the walk below re-resolves every link it
    // just resolved.
    scratch.withTx(tx).key("epoch").set(1);
    b.start();
    walk(list);
    b.end();
    tx.abort("bench");
  },
});

// Hops are what the walk actually costs, and the count is a property of the
// fixture rather than of any one iteration. Reported once, outside every timed
// window, so the timings can be read per hop.
benchDiagnostic(
  `[link-scan] ${ROWS} rows, 2 link hops each: ${ROWS * 2} hops per walk`,
);
