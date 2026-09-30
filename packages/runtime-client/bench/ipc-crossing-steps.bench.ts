/**
 * Where the cost of a worker-to-client crossing sits, one step at a time.
 *
 * `ipc-crossing.bench.ts` times the whole round trip, which is what a reader
 * means by "what does a message cost" and is the number to quote. It cannot
 * say which step to work on, because it reports one figure for five walks. This
 * file takes the same payloads and times each walk on its own, so a
 * work-reduction candidate can be picked by size rather than by guess.
 *
 * The five steps, in the order a message meets them:
 *
 * | step | status quo | envelope |
 * | --- | --- | --- |
 * | worker: `convertCellsToLinks()` | yes | yes |
 * | worker: encode | -- | yes |
 * | transport | yes | yes |
 * | client: decode | -- | yes |
 * | client: hydrate refs into handles | yes | yes |
 *
 * Each step is timed on an input the previous steps already produced, hoisted
 * out of the timed region. So the figures are the steps' own costs and do not
 * compose into the round trip: what a step hands the next one is built once
 * here and rebuilt every iteration in the real crossing, and the allocation
 * pressure that comes of it lands on whichever step is running.
 *
 * The two client-side steps read an arrival this file built once, so each
 * iteration decodes and hydrates a tree already resident in cache. What they
 * report is therefore a lower bound. Handing each iteration an arrival of its
 * own does not fix that so much as move it: the figure rises with the size of
 * the working set rather than settling anywhere, from 360 us over one tree to
 * 403 over 64 and 438 over 256, on the 1000-record subject. Neither number is
 * what a crossing pays, one message being neither one of many resident trees
 * nor one of hundreds. `ipc-crossing.bench.ts` is what pays the real cost, on
 * a tree `postMessage()` has just written; this file is for ranking the steps
 * against each other and for comparing a change against its base, and a bound
 * that holds on both sides of such a comparison does not disturb it.
 *
 * The transport step is `structuredClone()` rather than a real
 * `postMessage()`, which is a proxy and not the thing: it serializes and
 * deserializes as the crossing does, on the calling thread and without the
 * scheduling that dominates a small message. `ipc-crossing.bench.ts` measures
 * the real one and bounds this.
 *
 * Both flavors of payload are measured, because which one is representative
 * changes over time. A tree whose cells carry no `cfcLabelView` is what
 * crosses today. A tree whose every cell carries one is what crosses once CFC
 * is meaningful, and there the conversion attaches the display form of each
 * view to the link it mints, which is where the labeled flavor pays.
 *
 * Run with:
 *
 *     deno task bench
 */

import { CFC_ATOM_TYPE } from "@commonfabric/api/cfc";
import type { FabricValue } from "@commonfabric/data-model";
import {
  fabricFromRealmValue,
  realmFromFabricValue,
} from "@commonfabric/data-model/codecs";
import { linkRefFrom } from "@commonfabric/data-model/cell-rep";
import {
  type CellLinkInput,
  convertCellsToLinks,
  KeepAsCell,
  type SigilLink,
} from "@commonfabric/runner";
import { type CfcLabelView, linkCfcLabelView } from "@commonfabric/runner/cfc";
import { isObjectOrArray } from "@commonfabric/utils/types";

import { CellHandle } from "@/cell-handle.ts";
import { $conn, type RuntimeClient } from "@/runtime-client.ts";

import {
  cellCarryingLabelView,
  readRecordList,
} from "./fixtures/schema-read.ts";

/** The options the IPC response and notification paths convert under. */
const CONVERT_OPTIONS = {
  includeSchema: true,
  keepAsCell: KeepAsCell.All,
  doNotConvertCellResults: true,
  includeCfcLabelView: true,
} as const;

/**
 * A label view of the shape a link-write policy input carries: one entry, whose
 * confidentiality holds a caveat with a `source` for the redaction to drop.
 */
function makeLabelView(index: number): CfcLabelView {
  return {
    version: 1,
    entries: [{
      path: [],
      label: {
        confidentiality: [{
          type: CFC_ATOM_TYPE.Caveat,
          kind: "benchmark",
          source: { type: CFC_ATOM_TYPE.Builtin, name: `principal-${index}` },
        }],
      },
    }],
  } as CfcLabelView;
}

/**
 * Builds what a record's `source` holds, distinct per index: the link a
 * converted cell becomes, or when `labeled` a cell carrying a label view, for
 * the conversion to mint the link from.
 */
function makeSource(index: number, labeled: boolean): CellLinkInput {
  if (labeled) {
    return cellCarryingLabelView(
      `steps-labeled-${index}`,
      makeLabelView(index),
    );
  }

  return linkRefFrom({
    id: `of:${"0".repeat(56)}${index.toString(16).padStart(8, "0")}`,
    space: `did:key:z${"a".repeat(47)}`,
    path: ["items", String(index)],
  }) as unknown as FabricValue;
}

/**
 * A list of records, each with a few scalars, a nested array, and one
 * `source`.
 */
function makeList(items: number, labeled: boolean): CellLinkInput {
  const list: CellLinkInput[] = [];

  for (let i = 0; i < items; i++) {
    list.push({
      title: `item number ${i}`,
      count: i,
      done: (i % 3) === 0,
      tags: [`tag-${i % 7}`, `tag-${i % 11}`],
      source: makeSource(i, labeled),
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
 * A handle for the hydration to walk from. `deserialize()` reads its ref, to
 * rebase a relative link, and its client, to hand to a hydrated child -- so a
 * stand-in serves, and building a real `RuntimeClient` here would put a
 * connection this benchmark does not use behind every iteration.
 */
const base = new CellHandle(
  { [$conn]: () => ({}) } as unknown as RuntimeClient,
  {
    id: `of:${"0".repeat(64)}`,
    space: `did:key:z${"a".repeat(47)}`,
    scope: "space",
    path: [],
  },
);

/** One subject: a payload, and what each step of the crossing turns it into. */
type Subject = {
  readonly name: string;
  readonly value: CellLinkInput;

  /** Whether the payload's cells carry a label view. */
  readonly labeled: boolean;
};

const SUBJECTS: readonly Subject[] = [
  { name: "flat 100 members", value: makeFlat(100), labeled: false },
  { name: "100 records", value: makeList(100, false), labeled: false },
  { name: "100 records, labeled", value: makeList(100, true), labeled: true },
  { name: "1000 records", value: makeList(1000, false), labeled: false },
  { name: "1000 records, labeled", value: makeList(1000, true), labeled: true },
  // The read subjects are the same records as a schema-bearing read hands
  // them back, which is what the worker actually converts: every container
  // annotated and frozen, and each `source` a `Cell` rather than a link.
  {
    name: "100 records, read",
    value: await readRecordList(100) as CellLinkInput,
    labeled: false,
  },
  {
    name: "1000 records, read",
    value: await readRecordList(1000) as CellLinkInput,
    labeled: false,
  },
];

for (const { name, value, labeled } of SUBJECTS) {
  const converted = convertCellsToLinks(value, CONVERT_OPTIONS);
  const encoded = realmFromFabricValue(converted);

  // What each far side is handed: a message arrives as a clone, never as the
  // object the sender held, and a decode reading a fresh clone is what the
  // crossing does.
  const encodedArrival = structuredClone(encoded);
  const rawArrival = structuredClone(converted);
  const decoded = fabricFromRealmValue(encodedArrival);

  // A labeled subject whose links carry no view would be a second copy of the
  // labelless one under a different name, and would read as a result; and a
  // view still naming its source would say the conversion attached the wrong
  // form. The first record's link is the check, on every subject that has one.
  const first = (converted as { items?: readonly { source: SigilLink }[] })
    .items?.[0];
  const attached = first === undefined
    ? undefined
    : linkCfcLabelView(first.source);
  if ((attached !== undefined) !== labeled) {
    throw new Error(`Fixture is not what it claims: ${name}`);
  }
  const caveat = attached?.entries[0].label.confidentiality?.[0];
  if (isObjectOrArray(caveat) && "source" in caveat) {
    throw new Error(`Fixture carries an unredacted view: ${name}`);
  }

  Deno.bench({
    name: `convert — ${name}`,
    group: name,
    baseline: true,
  }, () => {
    convertCellsToLinks(value, CONVERT_OPTIONS);
  });

  Deno.bench({ name: `encode — ${name}`, group: name }, () => {
    realmFromFabricValue(converted);
  });

  Deno.bench({ name: `transport, raw — ${name}`, group: name }, () => {
    structuredClone(converted);
  });

  Deno.bench({ name: `transport, encoded — ${name}`, group: name }, () => {
    structuredClone(encoded);
  });

  Deno.bench({ name: `decode — ${name}`, group: name }, () => {
    fabricFromRealmValue(encodedArrival);
  });

  Deno.bench({ name: `hydrate, raw — ${name}`, group: name }, () => {
    CellHandle.deserialize(base, rawArrival);
  });

  Deno.bench({ name: `hydrate, decoded — ${name}`, group: name }, () => {
    CellHandle.deserialize(base, decoded);
  });
}
