/**
 * The labels a read reaches through a reference, for tests that hold a link
 * slot to the contract of CFC §8.2: the slot stores the reference's own
 * label, and the labels of what the reference reaches are read where they
 * are, composed with the slot's restriction at the dereference.
 */
import type { MemorySpace } from "@commonfabric/memory/interface";

import { cfcLabelViewForResolvedCell } from "../../src/cfc/label-view.ts";
import { cfcLabelViewForDereference } from "../../src/cfc/label-view-state.ts";
import type { NormalizedFullLink } from "../../src/link-utils.ts";
import type { Runtime } from "../../src/runtime.ts";

/** Every clause of a view, by axis, across all of its entries. */
export type ReachedLabels = {
  confidentiality: unknown[];
  integrity: unknown[];
};

const flatten = (
  entries: readonly {
    label: { confidentiality?: unknown[]; integrity?: unknown[] };
  }[],
): ReachedLabels => ({
  confidentiality: entries.flatMap((entry) =>
    entry.label.confidentiality ?? []
  ),
  integrity: entries.flatMap((entry) => entry.label.integrity ?? []),
});

/**
 * The labels a reader of the value at `path` of the document `link` names
 * answers to: the labels stored along the path in that document, and those
 * of the document the path resolves to through every link on the way,
 * rebased onto the value.
 */
export const labelsReached = (
  runtime: Runtime,
  link: NormalizedFullLink,
  path: readonly string[] = [],
): ReachedLabels => {
  const tx = runtime.edit();
  try {
    let cell = runtime.getCellFromLink(link, undefined, tx);
    for (const segment of path) cell = cell.key(segment);
    return flatten(cfcLabelViewForResolvedCell(cell)?.entries ?? []);
  } finally {
    tx.abort();
  }
};

/**
 * The labels a dereference from the link slot at `slot` to `target` consumes:
 * the slot's own entries and restriction composed with the target's stored
 * labels, one hop.
 */
export const labelsThroughLink = (
  runtime: Runtime,
  slot: { space: MemorySpace; id: string; path: readonly string[] },
  target: { space: MemorySpace; id: string; path: readonly string[] },
): ReachedLabels => {
  const tx = runtime.edit();
  try {
    return flatten(
      cfcLabelViewForDereference(
        tx,
        { ...slot, scope: "space", path: [...slot.path] },
        { ...target, scope: "space", path: [...target.path] },
      )?.entries ?? [],
    );
  } finally {
    tx.abort();
  }
};
