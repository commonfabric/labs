/**
 * Measurement scaffold for what one write costs the scheduler's trigger index.
 *
 * Drives a growing keyed collection through the real scheduler: each member
 * gets an action that reads that member alone, so the document accumulates one
 * subscriber per member, and then one member is written. That is the shape a
 * keyed collection has under a pattern that renders a row per member, and it
 * is the shape the lunch-poll read-scale fixture reaches 1,184 of.
 *
 * Reports counted work rather than elapsed time: a write's own cost is
 * microseconds against a settle that waits on storage, and run-to-run noise
 * swamps it.
 *
 * Read the last two columns. The member write reaches one member, so the paths
 * a scan visits say whether the index narrowed the readership or walked all of
 * it: a count that holds steady as the collection grows is the narrowing, and
 * one that grows with the collection is the walk. The append changes the
 * collection's length, so its change lands on the collection itself and
 * reaches every member's reader — the case the narrowing cannot help, here so
 * that the scaffold can report a cost as well as a saving.
 *
 * Run: deno run -A test/trigger-scaling.profile.ts [sizes...]
 */

import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import type { Action } from "../src/scheduler.ts";
import {
  resetTriggerScanWork,
  triggerScanWork,
} from "../src/scheduler/entity-triggers.ts";

const signer = await Identity.fromPassphrase("trigger scaling operator");
const space = signer.did();

interface Row {
  members: number;
  memberWrite: Work;
  append: Work;
}

/** What one write's scans looked at. */
interface Work {
  scans: number;
  pathsVisited: number;
  pathsMatched: number;
}

function work(): Work {
  return {
    scans: triggerScanWork.scans,
    pathsVisited: triggerScanWork.pathsVisited,
    pathsMatched: triggerScanWork.pathsMatched,
  };
}

async function runCollection(members: number): Promise<Row> {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const tx = runtime.edit();
  const scheduler = runtime.scheduler;

  const collection = runtime.getCell<number[]>(
    space,
    `collection-${members}`,
    undefined,
    tx,
  );
  collection.set(Array.from({ length: members }, () => 0));
  for (let i = 0; i < members; i++) {
    const member = collection.key(i);
    const reader: Action = (readerTx) => {
      member.withTx(readerTx).get();
    };
    scheduler.subscribe(reader, { isEffect: true });
  }

  await tx.commit();
  await runtime.idle();

  // One write to one member, which reaches that member's reader and no other.
  resetTriggerScanWork();
  const memberTx = runtime.edit();
  collection.withTx(memberTx).key(members >> 1).set(1);
  await memberTx.commit();
  await runtime.idle();
  const memberWrite = work();

  // One append, whose change of length lands on the collection itself and so
  // reaches every member's reader.
  resetTriggerScanWork();
  const appendTx = runtime.edit();
  collection.withTx(appendTx).set([...collection.get(), 0]);
  await appendTx.commit();
  await runtime.idle();
  const row: Row = { members, memberWrite, append: work() };

  // Closes the storage manager too, by default.
  await runtime.dispose();
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
  : [74, 296, 1184];

const rows: Row[] = [];
for (const members of sizes) {
  rows.push(await runCollection(members));
}

console.log(
  "\n| members | member write: scans, visited, visited/scan | append: scans, visited, visited/scan |",
);
console.log("|---|---|---|");
const cells = (w: Work) =>
  `${fmt(w.scans)}, ${fmt(w.pathsVisited)}, ${
    fmt(w.pathsVisited / w.scans, 1)
  }`;
for (const row of rows) {
  console.log(
    `| ${row.members} | ${cells(row.memberWrite)} | ${cells(row.append)} |`,
  );
}

function slope(key: (row: Row) => number): string {
  const first = rows[0];
  const last = rows[rows.length - 1];
  return (
    Math.log(key(last) / key(first)) / Math.log(last.members / first.members)
  ).toFixed(2);
}

console.log(
  `\nLog-log slopes over collection size ${rows[0].members}->${
    rows[rows.length - 1].members
  }:`,
);
console.log(
  "  member write, visited/scan:    " +
    slope((r) => r.memberWrite.pathsVisited / r.memberWrite.scans),
);
console.log(
  "  append, visited/scan:          " +
    slope((r) => r.append.pathsVisited / r.append.scans),
);
