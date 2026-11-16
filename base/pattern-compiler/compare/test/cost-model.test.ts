import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import {
  coneCollections,
  coneInstances,
  type CostPlan,
  eventCost,
  instancesWithin,
  settledCost,
} from "../cost-model.ts";

// A pattern with one `map` over the argument's `rows` (collection 0), a
// nested `map` over each row's `tags` (collection 1), a state cell of the
// pattern and one per row, and two handlers: one of the pattern, which
// sets the pattern's state cell, and one per row, which writes nothing.
//
// Cone 0 reads the argument alone. Cone 1 is the row body. Cone 2 reads
// the output of cone 1 and no element slot. Cone 3 is the tag body. Cone
// 4 reads the pattern's state cell, and cone 5 reads the output of cone 4.
const PLAN: CostPlan = {
  slots: [
    { root: { kind: "argument" }, path: ["rows"] },
    { root: { kind: "element", collection: 0 }, path: ["title"] },
    { root: { kind: "element", collection: 1 }, path: [] },
    { root: { kind: "state", cell: 0 }, path: [] },
    { root: { kind: "binding", handler: 0 }, path: ["count"] },
    { root: { kind: "index", collection: 0 }, path: [] },
  ],
  cones: [
    { slots: [0] },
    { slots: [1, 5] },
    { slots: [] },
    { slots: [2] },
    { slots: [3] },
    { slots: [] },
  ],
  edges: [
    { from: 1, to: 2, via: { kind: "output" } },
    { from: 4, to: 5, via: { kind: "output" } },
    { from: 0, to: 4, via: { kind: "state" } },
  ],
  outputs: [
    { cone: 0, kept: true, path: ["total"], template: { op: "slot" } },
    {
      cone: 1,
      kept: true,
      path: ["rows", "*", "title"],
      template: { op: "slot" },
    },
    {
      cone: 1,
      kept: true,
      path: ["rows", "*", "kind"],
      template: { op: "const" },
    },
    { cone: 2, kept: false, path: [], template: { op: "derive" } },
    { cone: 4, kept: true, path: ["count"], template: { op: "slot" } },
  ],
  collections: [
    { construct: "map", within: [] },
    { construct: "map", within: [{ element: 0 }] },
  ],
  stateCells: [{ within: [] }, { within: [{ site: "row" }, { element: 0 }] }],
  operations: [{ kind: "reduce", within: [{ element: 0 }] }],
  children: [{ within: [] }],
  bindings: [
    {
      within: [],
      handler: { body: 0 },
      state: [{ path: ["count"], capture: "link", place: { slot: 3 } }],
    },
    { within: [{ element: 0 }], handler: { body: 1 }, state: [] },
  ],
  bodies: [
    { kind: "handler", writes: [{ target: { kind: "handle", slot: 4 } }] },
    { kind: "action", writes: [] },
  ],
};

const sizes = (rows: number, tags: number) => (collection: number) =>
  collection === 0 ? rows : tags;

describe("instancesWithin", () => {
  it("is one for a record of no element body", () => {
    expect(instancesWithin([{ site: "a" }], sizes(3, 2))).toBe(1);
    expect(instancesWithin(undefined, sizes(3, 2))).toBe(1);
  });

  it("multiplies the element keys of the enclosing collections", () => {
    expect(
      instancesWithin(
        [{ element: 0 }, { site: "a" }, { element: 1 }],
        sizes(3, 2),
      ),
    ).toBe(6);
  });
});

describe("coneCollections", () => {
  it("names the collection of an element or an index slot", () => {
    const of = coneCollections(PLAN);
    expect(of[0]).toBeUndefined();
    expect(of[1]).toBe(0);
    expect(of[3]).toBe(1);
  });

  it("gives a cone the collection of the element cone whose output it reads", () => {
    expect(coneCollections(PLAN)[2]).toBe(0);
  });

  it("does not follow an edge that is not of kind output", () => {
    expect(coneCollections(PLAN)[4]).toBeUndefined();
  });
});

describe("coneInstances", () => {
  it("counts an element cone once per element key, and a nested one per pair", () => {
    expect(coneInstances(PLAN, sizes(3, 2))).toEqual([1, 3, 3, 6, 1, 1]);
  });

  it("counts no instance of an element cone over an empty collection", () => {
    expect(coneInstances(PLAN, sizes(0, 2))).toEqual([1, 0, 0, 0, 1, 1]);
  });
});

describe("settledCost", () => {
  const cost = settledCost(PLAN, sizes(3, 2));

  it("counts the cone instances and the streams", () => {
    expect(cost.coneInstances).toBe(15);
    expect(cost.streams).toBe(4);
  });

  it("counts the documents of ES §4.1 that do not depend on a size in bytes", () => {
    expect(cost.documents.operationState).toBe(3);
    expect(cost.documents.children).toEqual({ min: 0, max: 2 });
    expect(cost.documents.stateCells).toEqual({ min: 0, max: 4 });
    expect(cost.documents.rows).toEqual({ min: 0, max: 3 });
    expect(cost.documents.total).toEqual({ min: 5, max: 14 });
  });

  it("counts the root entry alone at least, and two entries per labeled kept output and one per kept collection at most", () => {
    // The root entry, `total` and `count` with two each, `rows/*/title`
    // with two shared or two per row, and the `enumerate` entry of the
    // one kept collection. `rows/*/kind` is `const` and has none.
    expect(cost.labelEntries).toEqual({
      min: 1,
      shared: 1 + 4 + 2 + 1,
      max: 1 + 4 + 6 + 1,
    });
  });

  it("gives two transactions whatever the sizes", () => {
    expect(cost.transactions).toBe(2);
    expect(settledCost(PLAN, sizes(100, 100)).transactions).toBe(2);
  });
});

describe("eventCost", () => {
  it("counts the cones that read the place a written state path is bound to, and the cones behind them", () => {
    const cost = eventCost(PLAN, 0, sizes(3, 2));
    expect(cost.coneEvaluations).toEqual({ min: 0, max: 2 });
    expect(cost.transactions).toEqual({ min: 1, max: 2 });
  });

  it("gives one transaction and no evaluation for a handler that writes nothing", () => {
    const cost = eventCost(PLAN, 1, sizes(3, 2));
    expect(cost.coneEvaluations).toEqual({ min: 0, max: 0 });
    expect(cost.transactions).toEqual({ min: 1, max: 1 });
  });
});
