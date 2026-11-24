/**
 * Measurement scaffold for scheduler liveness maintenance cost.
 *
 * Drives a growing list through the real scheduler: each append adds one card
 * (a computation that reads the list and writes the card, plus an effect that
 * reads the card) and then re-renders, which remounts every existing card. That
 * is the shape a UI list has — each render builds fresh closures, so the old
 * pair is torn down and new actions are registered with new edges.
 *
 * Reports counted work rather than elapsed time: the runtime worker spends most
 * of an append-driven window idle, and run-to-run noise swamps the signal.
 *
 * Run: deno run -A test/liveness-scaling.profile.ts [sizes...]
 */

import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import type { Action } from "../src/scheduler.ts";
import type { ReactivityLog } from "../src/scheduler/types.ts";
import { toMemorySpaceAddress } from "../src/link-utils.ts";
import {
  livenessWork,
  resetLivenessWork,
} from "../src/scheduler/dependency-graph.ts";

const signer = await Identity.fromPassphrase("liveness scaling operator");
const space = signer.did();

interface Row {
  topics: number;
  operations: number;
  nodeWrites: number;
  edgeVisits: number;
}

async function runBoard(topics: number): Promise<Row> {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const tx = runtime.edit();
  const scheduler = runtime.scheduler;

  const list = runtime.getCell<number[]>(
    space,
    `board-${topics}`,
    undefined,
    tx,
  );
  list.set([]);
  const listAddress = toMemorySpaceAddress(list.getAsNormalizedFullLink());

  interface Card {
    computeLog: ReactivityLog;
    sinkLog: ReactivityLog;
    cancelCompute: () => void;
    cancelSink: () => void;
  }
  const cards: Card[] = [];

  const mount = (card: Card): void => {
    const compute: Action = () => {};
    const sink: Action = () => {};
    card.cancelCompute = scheduler.subscribe(compute, card.computeLog);
    card.cancelSink = scheduler.subscribe(sink, card.sinkLog, {
      isEffect: true,
    });
  };

  resetLivenessWork();
  for (let i = 0; i < topics; i++) {
    const cell = runtime.getCell<number>(
      space,
      `board-${topics}-card-${i}`,
      undefined,
      tx,
    );
    cell.set(0);
    const cardAddress = toMemorySpaceAddress(cell.getAsNormalizedFullLink());

    const card: Card = {
      computeLog: {
        reads: [listAddress],
        shallowReads: [],
        writes: [cardAddress],
      },
      sinkLog: { reads: [cardAddress], shallowReads: [], writes: [] },
      cancelCompute: () => {},
      cancelSink: () => {},
    };
    mount(card);
    cards.push(card);

    // Appending re-renders the list: every existing card remounts.
    for (const existing of cards) {
      if (existing === card) continue;
      existing.cancelCompute();
      existing.cancelSink();
      mount(existing);
    }
  }
  const row: Row = {
    topics,
    operations: livenessWork.operations,
    nodeWrites: livenessWork.nodeWrites,
    edgeVisits: livenessWork.edgeVisits,
  };

  await tx.commit().settled;
  await runtime.dispose();
  await storageManager.close();
  return row;
}

function fmt(n: number, digits = 0): string {
  return n.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

const sizes = Deno.args.length > 0
  ? Deno.args.map((a) => Number(a))
  : [10, 20, 30, 40];

const rows: Row[] = [];
for (const topics of sizes) {
  rows.push(await runBoard(topics));
}

console.log(
  "\n| board | maintenance ops | node writes | edge visits | node writes/op | node writes/append |",
);
console.log("|---|---|---|---|---|---|");
for (const row of rows) {
  console.log(
    `| ${row.topics} | ${fmt(row.operations)} | ${fmt(row.nodeWrites)} | ${
      fmt(row.edgeVisits)
    } | ${fmt(row.nodeWrites / row.operations, 1)} | ${
      fmt(row.nodeWrites / row.topics, 1)
    } |`,
  );
}

function slope(key: (row: Row) => number): string {
  const first = rows[0];
  const last = rows[rows.length - 1];
  return (
    Math.log(key(last) / key(first)) / Math.log(last.topics / first.topics)
  ).toFixed(2);
}

console.log(
  `\nLog-log slopes over board size ${rows[0].topics}->${
    rows[rows.length - 1].topics
  }:`,
);
console.log("  maintenance ops:      " + slope((r) => r.operations));
console.log("  node writes total:    " + slope((r) => r.nodeWrites));
console.log("  edge visits total:    " + slope((r) => r.edgeVisits));
console.log(
  "  node writes per op:   " + slope((r) => r.nodeWrites / r.operations),
);
