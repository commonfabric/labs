/**
 * Measures selection through ordered dependency chains and unrelated nodes,
 * through the cones of visible handlers, and through inputs the view binds.
 */

import { expect } from "@std/expect";

import type { NormalizedFullLink } from "../src/link-utils.ts";
import type { IMemorySpaceAddress } from "../src/storage/interface.ts";
import {
  selectViewData,
  type ViewExecutionNode,
} from "../src/view-replication.ts";

function address(id: string): NormalizedFullLink & IMemorySpaceAddress {
  return {
    space: "did:key:z6Mk-view-bench",
    id: `of:${id}`,
    type: "application/json",
    scope: "space",
    path: [],
  };
}

for (const size of [100, 300, 1000]) {
  const nodes: ViewExecutionNode[] = [];
  for (let index = 0; index < size; index++) {
    for (const branch of ["visible", "hidden"]) {
      const writes = [address(`${branch}-${index + 1}`)];
      nodes.push({
        id: `${branch}-${index}`,
        piece: address("piece"),
        kind: "computation",
        log: {
          reads: [address(`${branch}-${index}`), address("side-input")],
          shallowReads: [],
          writes,
        },
        writes,
      });
    }
  }
  Deno.bench({
    name: `${size} visible and ${size} hidden nodes`,
    group: "view selection chain",
    fn(b) {
      b.start();
      const selection = selectViewData(
        nodes,
        [address(`visible-${size}`)],
        [address("visible-0")],
        new Set(),
      );
      b.end();
      expect(selection.actions.length).toBe(size);
      expect(selection.actions.every((id) => id.startsWith("visible-"))).toBe(
        true,
      );
    },
  });
}

for (const size of [100, 300, 1000]) {
  // A list view of `size` rows. Each row's handler edits its row's vote, a
  // tally reads the vote, and a label reads the names of nine rows, which no
  // handler edits: the labels are the ancestors whose reads match no edit.
  const nodes: ViewExecutionNode[] = [];
  const handlers = new Set<string>();
  const renderReads: (NormalizedFullLink & IMemorySpaceAddress)[] = [];
  for (let index = 0; index < size; index++) {
    const piece = address(`row-piece-${index}`);
    const edits = [{ ...address(`row-${index}`), path: ["value", "vote"] }];
    nodes.push({
      id: `handler-${index}`,
      piece,
      kind: "handler",
      log: {
        reads: [address(`row-${index}`)],
        shallowReads: [],
        writes: edits,
      },
      writes: edits,
    });
    handlers.add(`handler-${index}`);
    for (const role of ["tally", "label"]) {
      const writes = [address(`${role}-${index}`)];
      nodes.push({
        id: `${role}-${index}`,
        piece,
        kind: "computation",
        log: {
          reads: role === "tally" ? edits : Array.from(
            { length: 9 },
            (_, offset) => ({
              ...address(`row-${(index + offset) % size}`),
              path: ["value", "name"],
            }),
          ),
          shallowReads: [],
          writes,
        },
        writes,
      });
      renderReads.push(address(`${role}-${index}`));
    }
  }
  Deno.bench({
    name: `${size} visible handlers, their tallies and labels`,
    group: "view selection with visible handlers",
    fn(b) {
      b.start();
      const selection = selectViewData(nodes, renderReads, [], handlers);
      b.end();
      expect(selection.actions.length).toBe(2 * size);
    },
  });
}

for (const size of [100, 300, 1000]) {
  // A list view of `size` rows, each with an input bound to its row's vote
  // and a tally that reads the vote: the view's bindings write one entity per
  // row.
  const nodes: ViewExecutionNode[] = [];
  const renderReads: (NormalizedFullLink & IMemorySpaceAddress)[] = [];
  const bindingWrites: IMemorySpaceAddress[] = [];
  for (let index = 0; index < size; index++) {
    const vote = { ...address(`row-${index}`), path: ["value", "vote"] };
    bindingWrites.push(vote);
    const writes = [address(`tally-${index}`)];
    nodes.push({
      id: `tally-${index}`,
      piece: address(`row-piece-${index}`),
      kind: "computation",
      log: { reads: [vote], shallowReads: [], writes },
      writes,
    });
    renderReads.push(address(`tally-${index}`));
  }
  Deno.bench({
    name: `${size} rows whose tallies read their bound inputs`,
    group: "view selection with bound inputs",
    fn(b) {
      b.start();
      const selection = selectViewData(
        nodes,
        renderReads,
        bindingWrites,
        new Set(),
      );
      b.end();
      expect(selection.actions.length).toBe(size);
    },
  });
}
