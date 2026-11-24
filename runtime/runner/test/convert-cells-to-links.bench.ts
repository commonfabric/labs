/**
 * What the conversion costs per container, and what frozenness costs on top of
 * it.
 *
 * The two arms carry the same data and differ only in whether it is frozen.
 * That is worth measuring because the shallow conversion at the top of each
 * container is asked for the frozenness the value already has, so that a value
 * already in fabric form comes back as itself rather than as a copy the
 * rebuild below would discard. **The two arms agreeing is the result**: a gap
 * between them is a copy being made on one side and not the other.
 *
 * The payload is shaped like a value a subscription carries -- a list of
 * records, each with a few scalars, a nested array, and one link -- rather
 * than a single wide container, since what the walk pays for is containers
 * visited rather than bytes moved.
 *
 * Run with:
 *
 *     deno task bench
 */

import { deepFreeze, type FabricValue } from "@commonfabric/data-model";

import { linkRefFrom } from "@commonfabric/data-model/cell-rep";

import { convertCellsToLinks } from "../src/cell.ts";
import { KeepAsCell } from "../src/link-utils.ts";

/** The options the IPC response and notification paths convert under. */
const OPTIONS = {
  includeSchema: true,
  keepAsCell: KeepAsCell.All,
  doNotConvertCellResults: true,
  includeCfcLabelView: true,
} as const;

/** Builds a list payload of the given length. */
function makePayload(items: number): FabricValue {
  const list: FabricValue[] = [];

  for (let i = 0; i < items; i++) {
    list.push({
      title: `item number ${i}`,
      count: i,
      done: (i % 3) === 0,
      tags: [`tag-${i % 7}`, `tag-${i % 11}`],
      source: linkRefFrom({
        id: `of:${"0".repeat(56)}${i.toString(16).padStart(8, "0")}`,
        space: `did:key:z${"a".repeat(47)}`,
        path: ["items", String(i)],
      }) as unknown as FabricValue,
    });
  }

  return { items: list, total: items, updatedAt: "2026-08-27T00:00:00Z" };
}

for (const size of [10, 100, 1000] as const) {
  const group = `list-${String(size).padStart(5, "0")}`;
  const unfrozen = makePayload(size);
  const frozen = deepFreeze(makePayload(size)) as FabricValue;

  Deno.bench({
    group,
    name: "unfrozen input",
    baseline: true,
    fn: () => {
      convertCellsToLinks(unfrozen as never, OPTIONS);
    },
  });

  Deno.bench({
    group,
    name: "deep-frozen input",
    fn: () => {
      convertCellsToLinks(frozen as never, OPTIONS);
    },
  });
}
