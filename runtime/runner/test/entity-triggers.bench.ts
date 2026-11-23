/**
 * Measures one document's trigger index at large readerships: registering,
 * moving and removing readers, and the writes that consult them. Each sample
 * builds its index untimed and times one shape over the whole readership, so
 * a reported time is for all `n` operations unless the name says otherwise.
 *
 * Written against `set()`, `delete()` and `matching()` alone, the surface
 * every implementation of the index offers, so that two implementations can
 * be compared by running this file against each.
 */

import { EntityTriggers } from "../src/scheduler/entity-triggers.ts";
import type { Action } from "../src/scheduler/types.ts";

type Path = readonly string[];

const SIZES = [10_000, 40_000];

/** One action per reader, each a distinct function so the index tells them apart. */
function actions(count: number): Action[] {
  return Array.from({ length: count }, () => () => {});
}

/** The path of member `index`, padded so that path order is number order. */
function member(index: number): Path {
  return ["value", `member-${String(index).padStart(6, "0")}`];
}

/** One reader per member, and a reader of the whole list every 16th. */
function memberRows(triggers: EntityTriggers, readers: Action[]): void {
  for (let i = 0; i < readers.length; i++) {
    triggers.set(readers[i]!, i % 16 === 0 ? [["value"]] : [member(i)]);
  }
}

/** A stride through `0 .. n`, so that neighbors register far apart. */
function shuffled(n: number): number[] {
  return Array.from({ length: n }, (_, i) => (i * 7919) % n);
}

/** Throws unless `found` actions matched, so a shape cannot quietly time nothing. */
function expectMatched(found: number, expected: number, shape: string): void {
  if (found !== expected) {
    throw new Error(`${shape} matched ${found} actions, expected ${expected}`);
  }
}

for (const n of SIZES) {
  const group = `entity-triggers n=${n}`;
  const options = { group, n: 10, warmup: 2 };

  Deno.bench({
    ...options,
    name: `register one reader per member, n=${n}`,
    baseline: true,
    fn: (b) => {
      const readers = actions(n);
      const triggers = new EntityTriggers();
      b.start();
      memberRows(triggers, readers);
      b.end();
      expectMatched(triggers.size, n, "register");
    },
  });

  Deno.bench({
    ...options,
    name: `every reader moves to the next member, n=${n}`,
    fn: (b) => {
      const readers = actions(n);
      const triggers = new EntityTriggers();
      memberRows(triggers, readers);
      b.start();
      for (let i = 0; i < n; i++) {
        triggers.set(readers[i]!, [member((i + 1) % n)]);
      }
      b.end();
      expectMatched(triggers.size, n, "move");
    },
  });

  Deno.bench({
    ...options,
    name: `remove every reader in order, n=${n}`,
    fn: (b) => {
      const readers = actions(n);
      const triggers = new EntityTriggers();
      memberRows(triggers, readers);
      b.start();
      for (const reader of readers) triggers.delete(reader);
      b.end();
      expectMatched(triggers.size, 0, "remove in order");
    },
  });

  Deno.bench({
    ...options,
    name: `register shuffled, n=${n}`,
    fn: (b) => {
      const readers = actions(n);
      const order = shuffled(n);
      const triggers = new EntityTriggers();
      b.start();
      for (const i of order) triggers.set(readers[i]!, [member(i)]);
      b.end();
      expectMatched(triggers.size, n, "register shuffled");
    },
  });

  Deno.bench({
    ...options,
    name: `remove shuffled, n=${n}`,
    fn: (b) => {
      const readers = actions(n);
      const order = shuffled(n);
      const triggers = new EntityTriggers();
      for (let i = 0; i < n; i++) triggers.set(readers[i]!, [member(i)]);
      b.start();
      for (const i of order) triggers.delete(readers[i]!);
      b.end();
      expectMatched(triggers.size, 0, "remove shuffled");
    },
  });

  Deno.bench({
    ...options,
    name: `register in descending path order, n=${n}`,
    fn: (b) => {
      const readers = actions(n);
      const triggers = new EntityTriggers();
      b.start();
      for (let i = n - 1; i >= 0; i--) triggers.set(readers[i]!, [member(i)]);
      b.end();
      expectMatched(triggers.size, n, "register descending");
    },
  });

  Deno.bench({
    ...options,
    name: `register ${n} readers of one path, n=${n}`,
    fn: (b) => {
      const readers = actions(n);
      const triggers = new EntityTriggers();
      b.start();
      for (const reader of readers) triggers.set(reader, [["value"]]);
      b.end();
      expectMatched(triggers.size, n, "register one path");
    },
  });

  Deno.bench({
    ...options,
    name: `remove ${n} readers of one path, n=${n}`,
    fn: (b) => {
      const readers = actions(n);
      const triggers = new EntityTriggers();
      for (const reader of readers) triggers.set(reader, [["value"]]);
      b.start();
      for (let i = n - 1; i >= 0; i--) triggers.delete(readers[i]!);
      b.end();
      expectMatched(triggers.size, 0, "remove one path");
    },
  });

  // One action reads all `n` members, as a list's renderer does, and seven
  // one-path actions beside it re-register again and again, as the
  // computations of a list's count do.
  const bigPaths: Path[] = Array.from(
    { length: n },
    (_, i) => ["value", "items", String(i).padStart(6, "0"), "title"],
  );

  Deno.bench({
    ...options,
    name:
      `seven small readers re-register 2000 times beside a reader of n paths, n=${n}`,
    fn: (b) => {
      const big: Action = () => {};
      const small = actions(7);
      const triggers = new EntityTriggers();
      triggers.set(big, bigPaths);
      for (const reader of small) triggers.set(reader, [["value", "count"]]);
      b.start();
      for (let k = 0; k < 2000; k++) {
        triggers.set(
          small[k % 7]!,
          k % 2 === 0 ? [["value", "zcount"]] : [["value", "count"]],
        );
      }
      b.end();
      expectMatched(triggers.size, 8, "small re-register");
    },
  });

  Deno.bench({
    ...options,
    name:
      `a reader of n paths re-registers a list shifted by one and back, n=${n}`,
    fn: (b) => {
      const big: Action = () => {};
      const shifted: Path[] = [["value", "items", "-"], ...bigPaths.slice(1)];
      const triggers = new EntityTriggers();
      triggers.set(big, bigPaths);
      b.start();
      triggers.set(big, shifted);
      triggers.set(big, bigPaths);
      b.end();
      expectMatched(triggers.size, 1, "shift");
    },
  });

  Deno.bench({
    ...options,
    name: `a reader of n paths re-registers an equal copy 100 times, n=${n}`,
    fn: (b) => {
      const big: Action = () => {};
      const copies = Array.from({ length: 100 }, () => [...bigPaths]);
      const triggers = new EntityTriggers();
      triggers.set(big, bigPaths);
      b.start();
      for (const copy of copies) triggers.set(big, copy);
      b.end();
      expectMatched(triggers.size, 1, "equal copy");
    },
  });
}

{
  // The writes, against one index built once: they leave it as they found it.
  const n = 10_000;
  const group = `entity-triggers writes n=${n}`;
  const readers = actions(n);
  const rows = new EntityTriggers();
  memberRows(rows, readers);
  const onePath = new EntityTriggers();
  for (const reader of readers) onePath.set(reader, [["value"]]);
  const wholeListReaders = Math.ceil(n / 16);
  const written = member(n / 2 + 1);

  Deno.bench({
    group,
    name: `1000 writes to one member, n=${n}`,
    baseline: true,
    fn: () => {
      for (let k = 0; k < 1000; k++) {
        expectMatched(
          rows.matching(written).size,
          wholeListReaders + 1,
          "member write",
        );
      }
    },
  });

  Deno.bench({
    group,
    name: `a write to the document root, n=${n}`,
    fn: () => {
      expectMatched(rows.matching([]).size, n, "root write");
    },
  });

  Deno.bench({
    group,
    name: `a write below a path ${n} readers read, n=${n}`,
    fn: () => {
      expectMatched(onePath.matching(["value", "x"]).size, n, "one path write");
    },
  });
}
