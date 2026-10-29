/**
 * What the instant a materialized read describes costs to keep.
 *
 * A view resolves each path against the epoch it was taken at, so reads made
 * after the reader has written have to find the root standing at that epoch
 * rather than the current one. Three groups measure that:
 *
 *   - **read**: walking a list through a view, on a transaction that has not
 *     written and on one that has. The first is the shape a lift takes — read
 *     the argument, never write through it — and is where the epoch has to cost
 *     nothing, because before the first write every epoch names the same root.
 *   - **write**: a run of writes with and without a reader holding an instant.
 *     Holding one puts the write path on the preserving branch, which
 *     deep-freezes the root it displaces so the next write clones instead of
 *     editing it where it stands.
 *   - **interleave**: a read taken between every write, which is the shape that
 *     makes every write preserve. The write group amortises one preserve over
 *     its whole run and so understates this.
 *
 * One runtime is built for the whole file and every iteration aborts its
 * transaction, so no iteration pays for a runtime, a store or a seeded document,
 * and none leaves state behind for the next. Each `fn` also runs its body once
 * untimed, so the timed window is not the one that pays for the transaction's
 * first document load.
 *
 * Environment controls:
 * - LAZY_VIEW_EPOCH_N: list size, default 1000
 * - LAZY_VIEW_EPOCH_WRITES: writes per iteration, default 50
 */

import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import { type JSONSchema } from "../src/builder/types.ts";

const signer = await Identity.fromPassphrase("bench lazy view epoch");
const space = signer.did();

const N = Number(Deno.env.get("LAZY_VIEW_EPOCH_N") ?? "1000");
const WRITES = Number(Deno.env.get("LAZY_VIEW_EPOCH_WRITES") ?? "50");

const SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    xs: { type: "array", items: { type: "number" } },
  },
} as const satisfies JSONSchema;

const storageManager = StorageManager.emulate({ as: signer });
const runtime = new Runtime({
  apiUrl: new URL(import.meta.url),
  storageManager,
});

const CAUSE = "lazy-view-epoch-doc";
{
  const tx = runtime.edit();
  runtime.getCell(space, CAUSE, undefined, tx).set({
    title: "bench",
    xs: Array.from({ length: N }, (_, index) => index),
  });
  await tx.commit().settled;
}

/**
 * Open a marked transaction over the seeded document.
 *
 * Every iteration aborts, so the document never moves and one seeded copy
 * serves the whole file.
 */
const open = () => {
  const tx = runtime.edit();
  tx.markLazyMaterialize(true);
  return { tx, cell: runtime.getCell(space, CAUSE, SCHEMA, tx) };
};

const READ_VARIANTS: [string, boolean][] = [
  ["no write taken", false],
  ["past one write", true],
];

for (const [label, writeFirst] of READ_VARIANTS) {
  const walk = () => {
    const { tx, cell } = open();
    if (writeFirst) cell.withTx(tx).key("title").set("written");
    const view = cell.get() as { xs: number[] };
    return { tx, view };
  };
  Deno.bench({
    name: `lazy view epoch - walk ${N} elements - ${label}`,
    group: "lazy-view-epoch-read",
    baseline: !writeFirst,
    fn(b) {
      // Untimed, so the timed window below is not the one paying for this
      // transaction's first look at the document.
      const warm = walk();
      for (const item of warm.view.xs) if (item < 0) throw new Error("no");
      warm.tx.abort("bench");

      const { tx, view } = walk();
      b.start();
      let total = 0;
      for (const item of view.xs) total += item;
      b.end();
      tx.abort("bench");
      if (total < 0) throw new Error("unreachable");
    },
  });
}

const WRITE_VARIANTS: [string, boolean][] = [
  ["no reader holding an instant", false],
  ["a reader holding an instant", true],
];

for (const [label, readerFirst] of WRITE_VARIANTS) {
  const setup = () => {
    const { tx, cell } = open();
    // The baseline reads RAW rather than skipping the read: it pulls the same
    // document into the transaction, so neither variant pays that load inside
    // the timed window, but it takes no view and so issues no epoch. Taking a
    // view is what puts the writes below on the preserving branch — and it is
    // the asking that does it, not the holding, since `get()` issues an epoch
    // whether or not the caller keeps what it returns.
    if (readerFirst) cell.get();
    else cell.getRaw();
    return { tx, cell };
  };
  Deno.bench({
    name: `lazy view epoch - ${WRITES} writes - ${label}`,
    group: "lazy-view-epoch-write",
    baseline: !readerFirst,
    fn(b) {
      const warm = setup();
      warm.cell.withTx(warm.tx).key("title").set("warm");
      warm.tx.abort("bench");

      const { tx, cell } = setup();
      b.start();
      for (let index = 0; index < WRITES; index++) {
        cell.withTx(tx).key("xs").key(index % N).set(index);
      }
      b.end();
      tx.abort("bench");
    },
  });
}

// A read between every write, so every write finds an instant to preserve.
// The write group above amortises one preserve over its whole run; this is the
// shape that pays for one per write.
const INTERLEAVE_VARIANTS: [string, boolean][] = [
  ["reading raw", false],
  ["taking a view", true],
];

for (const [label, takeView] of INTERLEAVE_VARIANTS) {
  Deno.bench({
    name: `lazy view epoch - ${WRITES} write/read rounds - ${label}`,
    group: "lazy-view-epoch-interleave",
    baseline: !takeView,
    fn(b) {
      const warm = open();
      if (takeView) warm.cell.get();
      else warm.cell.getRaw();
      warm.tx.abort("bench");

      const { tx, cell } = open();
      b.start();
      for (let index = 0; index < WRITES; index++) {
        cell.withTx(tx).key("xs").key(index % N).set(index);
        if (takeView) cell.get();
        else cell.getRaw();
      }
      b.end();
      tx.abort("bench");
    },
  });
}
