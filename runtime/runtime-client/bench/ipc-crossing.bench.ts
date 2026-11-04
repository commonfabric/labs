/**
 * What a whole message costs to cross the worker connection, against what the
 * same message cost before the envelope encoding carried it.
 *
 * `data-model`'s `bench/ipc-status-quo.bench.ts` measures the encoding's own
 * contribution: encode, `postMessage()`, decode. This file measures the
 * crossing that contribution sits inside, which is the larger thing and the
 * one a reader means by "what does a message cost". The walks around the codec
 * predate it and are unchanged by it, so a ratio taken across the codec alone
 * overstates what the connection as a whole pays.
 *
 * The subject is a cell update travelling worker to client, which is the
 * connection's highest-volume message. Both arms run the same three steps and
 * differ only in the two the envelope added:
 *
 * | | status quo | envelope |
 * | --- | --- | --- |
 * | worker: convert cells to links | yes | yes |
 * | worker: encode | -- | yes |
 * | `postMessage()` | yes | yes |
 * | client: decode | -- | yes |
 * | client: hydrate refs into handles | yes | yes |
 *
 * Every step is inside the timed region, including both encodes, because both
 * are what a sender pays. One message is in flight at a time: an iteration is
 * one round trip, and a pipeline of overlapping sends would report throughput
 * while the harness is timing latency.
 *
 * Payloads are records carrying links, since what these walks cost turns on
 * containers visited rather than bytes moved, and a link is what a converted
 * cell becomes. A payload the status quo cannot carry at all is deliberately
 * absent: timing a crossing that arrives damaged against one that arrives
 * whole yields a ratio that reads as a regression and says nothing.
 *
 * Run with:
 *
 *     deno task bench
 */

import { BenchWorker } from "@commonfabric/test-support/bench-worker";

import type { FabricValue } from "@commonfabric/data-model";
import { realmFromFabricValue } from "@commonfabric/data-model/codecs";
import { linkRefFrom } from "@commonfabric/data-model/cell-rep";
import {
  type CellLinkInput,
  convertCellsToLinks,
  KeepAsCell,
} from "@commonfabric/runner";

import type { CrossingRequest } from "./fixtures/ipc-far-side.ts";
import { readRecordList } from "./fixtures/schema-read.ts";

/** The options the IPC response and notification paths convert under. */
const CONVERT_OPTIONS = {
  includeSchema: true,
  keepAsCell: KeepAsCell.All,
  doNotConvertCellResults: true,
  includeCfcLabelView: true,
} as const;

const farSide = new BenchWorker<CrossingRequest>(
  import.meta.resolve("./fixtures/ipc-far-side.ts"),
);

/** Builds the link that a converted cell becomes, distinct per index. */
function makeLink(index: number): FabricValue {
  return linkRefFrom({
    id: `of:${"0".repeat(56)}${index.toString(16).padStart(8, "0")}`,
    space: `did:key:z${"a".repeat(47)}`,
    path: ["items", String(index)],
  }) as unknown as FabricValue;
}

/** A list of records, each with a few scalars, a nested array, and one link. */
function makeList(items: number): FabricValue {
  const list: FabricValue[] = [];

  for (let i = 0; i < items; i++) {
    list.push({
      title: `item number ${i}`,
      count: i,
      done: (i % 3) === 0,
      tags: [`tag-${i % 7}`, `tag-${i % 11}`],
      source: makeLink(i),
    });
  }

  return { items: list, total: items, updatedAt: "2026-08-27T00:00:00Z" };
}

/** A flat object of `count` scalar members: one container, many members. */
function makeFlat(count: number): FabricValue {
  const out: Record<string, FabricValue> = {};

  for (let i = 0; i < count; i++) out[`member${i}`] = i;

  return out;
}

/**
 * A spread of shapes rather than sizes of one shape: what a crossing costs
 * turns on how many containers the walks visit, and these differ in that as
 * well as in total size.
 */
const SUBJECTS: readonly (readonly [string, CellLinkInput])[] = [
  ["small record", { title: "a note", count: 3, source: makeLink(0) }],
  ["flat 100 members", makeFlat(100)],
  ["100 records with links", makeList(100)],
  ["1000 records with links", makeList(1000)],
  // The read subjects are the same records as a schema-bearing read hands
  // them back, which is what the worker actually converts: every container
  // annotated and frozen, and each `source` a `Cell` rather than a link.
  ["100 records, read", await readRecordList(100) as CellLinkInput],
  ["1000 records, read", await readRecordList(1000) as CellLinkInput],
];

for (const [name, value] of SUBJECTS) {
  /** The worker-side conversion both arms run before anything is sent. */
  const converted = (): FabricValue =>
    convertCellsToLinks(value, CONVERT_OPTIONS);

  Deno.bench({
    name: `status quo — ${name}`,
    group: name,
    baseline: true,
  }, async () => {
    await farSide.send({ kind: "status-quo", payload: converted() });
  });

  Deno.bench({ name: `envelope — ${name}`, group: name }, async () => {
    // Encoded here, inside the measurement: the send pays for it.
    await farSide.send({
      kind: "envelope",
      payload: realmFromFabricValue(converted()),
    });
  });
}

globalThis.addEventListener("unload", () => farSide.close());
