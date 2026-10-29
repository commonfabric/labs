/**
 * The update events a wrapped `CellHandle` fires carry what the handle holds
 * of its cell: the value, or the refusal that stands in its place, so that a
 * listener such as the page title never takes a refused read for a cell that
 * holds nothing.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import {
  $conn,
  $onCellRefused,
  $onCellUpdate,
  CellHandle,
  type CellHandleRead,
  type CellRef,
  type RuntimeClient,
} from "@commonfabric/runtime-client";

import {
  CellEventTarget,
  type CellUpdateEvent,
} from "../src/lib/cell-event-target.ts";

const ref: CellRef = {
  id: "of:titled",
  space: "did:key:titled",
  scope: "space",
  path: [],
  schema: { type: "string" },
};

const runtime = {
  [$conn]: () => ({
    request: () => Promise.resolve({}),
    subscribe: () => Promise.resolve(),
    unsubscribe: () => Promise.resolve(),
    peersOf: () => [],
    signal: new AbortController().signal,
  }),
} as unknown as RuntimeClient;

describe("CellEventTarget", () => {
  it("fires each value, and each refusal, as the read it is", () => {
    const cell = new CellHandle<string>(runtime, ref);
    const target = new CellEventTarget(cell);
    const reads: CellHandleRead<string>[] = [];
    const listener = (event: Event) => {
      reads.push((event as CellUpdateEvent<string>).detail);
    };
    target.addEventListener("update", listener);

    cell[$onCellUpdate]("A title");
    cell[$onCellRefused]({ refusedBy: "display-ceiling" });
    target.removeEventListener("update", listener);

    expect(reads).toEqual([
      { value: "A title" },
      { refused: { refusedBy: "display-ceiling" } },
    ]);
  });
});
