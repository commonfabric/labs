import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { findOverlappingCells } from "../../src/scheduler/graph-snapshot.ts";
import { entityKey } from "../../src/scheduler/keys.ts";
import type { Action, ReactivityLog } from "../../src/scheduler/types.ts";
import type { IMemorySpaceAddress } from "../../src/storage/interface.ts";

const identity = { principal: "did:test:graph", sessionId: "session-1" };

const output: IMemorySpaceAddress = {
  space: "did:key:graph-snapshot",
  scope: "space",
  id: "of:output",
  path: ["value"],
};

/** Snapshot state in which `producer` writes `output`. */
function state(
  producer: Action,
  dependencies: [Action, ReactivityLog][],
) {
  return {
    dependencies: new WeakMap(dependencies),
    getSchedulingWrites: (action: Action) =>
      action === producer ? [output] : undefined,
    scopeKeyIdentity: () => identity,
  };
}

describe("findOverlappingCells()", () => {
  it("returns the cell a consumer reads that the producer writes", () => {
    const producer: Action = function producer() {};
    const consumer: Action = function consumer() {};

    expect(
      findOverlappingCells(
        state(producer, [[consumer, {
          reads: [{ ...output, path: ["value", "field"] }],
          shallowReads: [],
          writes: [],
        }]]),
        producer,
        consumer,
      ),
    ).toEqual([entityKey(output, identity)]);
  });

  it("returns no cell for a consumer that has no read log", () => {
    const producer: Action = function producer() {};
    const consumer: Action = function consumer() {};

    expect(findOverlappingCells(state(producer, []), producer, consumer))
      .toEqual([]);
  });
});
