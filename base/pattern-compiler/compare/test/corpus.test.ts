import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { eventOrder, type ResultRow, resultRow, tally } from "../corpus.ts";
import type { WriteRow } from "../harness.ts";
import { compareLabels } from "../template.ts";

const row = (fields: Partial<ResultRow>): ResultRow => ({
  kind: "output",
  path: "",
  root: "slot",
  runtime: "",
  runtimeWithoutStatic: "",
  template: "",
  confidentiality: "equal",
  integrity: "equal",
  overall: "equal",
  category: "equal",
  withoutStatic: "equal",
  bound: false,
  ...fields,
});

describe("tally", () => {
  it("classifies each output without the atom of a kept output and with it", () => {
    // PL §3.1, "The atom of a kept output": the first classification is
    // the test of the rule the row's template follows, and the second is
    // the label the design stores.
    const counts = tally([
      row({ templateAlone: "equal", category: "tighter" }),
      row({ templateAlone: "equal", category: "tighter" }),
      row({ templateAlone: "looser", category: "atom names the pattern" }),
      // The fourth exception of PL §3.1: with the atom neither integrity
      // holds the other.
      row({ templateAlone: "looser", category: "incomparable" }),
      row({ templateAlone: "tighter", category: "tighter", bound: true }),
      row({ kind: "write", category: "looser" }),
    ], "output");

    expect(counts.compared).toBe(4);
    expect(counts.bounds).toBe(1);
    expect(counts.withoutAtom).toEqual({
      equal: 2,
      tighter: 0,
      "atom names the pattern": 0,
      looser: 2,
      incomparable: 0,
    });
    expect(counts.withAtom).toEqual({
      equal: 0,
      tighter: 2,
      "atom names the pattern": 1,
      looser: 0,
      incomparable: 1,
    });
  });

  it("classifies a write edge once, and counts the rows that are looser by the stamp of a passed link", () => {
    // PL §2.2: the label of the `identity` slot of a handle that is only
    // passed on is the stamp of the run that wrote the link. The runtime's
    // transaction reads nothing at such a position, "so with the stamp
    // the template can be looser than today" (PL §8, question 81).
    const counts = tally([
      row({ kind: "write", category: "looser", looserByLinkStamp: true }),
      row({ kind: "write", category: "looser", looserByLinkStamp: false }),
      row({ kind: "write", category: "equal", looserByLinkStamp: false }),
    ], "write");

    expect(counts.withAtom.looser).toBe(2);
    expect(counts.withAtom.equal).toBe(1);
    expect(counts.looserByLinkStamp).toBe(1);
  });

  it("counts the write edges of handlers in an element body and in a pattern compiled in apart", () => {
    const rows = [
      row({ kind: "write", category: "equal" }),
      row({ kind: "write", category: "tighter", within: "site" }),
      row({ kind: "write", category: "equal", within: "element" }),
      row({ kind: "write", category: "looser", within: "element" }),
    ];

    expect(tally(rows, "write").compared).toBe(4);
    expect(tally(rows, "write", "none").withAtom.equal).toBe(1);
    expect(tally(rows, "write", "site").withAtom.tighter).toBe(1);
    expect(tally(rows, "write", "element").compared).toBe(2);
    expect(tally(rows, "write", "element").withAtom.looser).toBe(1);
  });

  it("counts the rows that are tighter by the coordinator's join as tighter, and apart", () => {
    // PL §3.1, "The coordinator's join on an element's argument
    // document": "It is expected, it is counted as tighter, and it is
    // reported apart".
    const rows = [
      row({
        kind: "write",
        category: "tighter",
        within: "element",
        coordinatorJoin: "tighter",
      }),
      row({ kind: "write", category: "tighter", within: "element" }),
      // The template has no clause and so mints no atom, where the
      // runtime's label has the join and the atom: looser in integrity.
      row({
        kind: "write",
        category: "looser",
        within: "element",
        coordinatorJoin: "no atom",
      }),
    ];
    const counts = tally(rows, "write", "element");

    expect(counts.withAtom.tighter).toBe(2);
    expect(counts.withAtom.looser).toBe(1);
    expect(counts.byCoordinatorJoin).toBe(1);
    expect(counts.noAtomBesideCoordinatorJoin).toBe(1);
  });
});

describe("eventOrder", () => {
  const plan = {
    slots: [],
    collections: [],
    outputs: [],
    bindings: [
      { name: "outer", handler: { body: 0 } },
      { name: "inner", handler: { body: 1 }, within: [{ element: 0 }] },
      { name: "later", handler: { body: 2 } },
      { name: "no handler" },
    ],
  };

  it("has the bindings with no `within` step first, each group in the order of the plan", () => {
    expect(eventOrder(plan, "outside first")).toEqual([0, 2, 1]);
  });

  it("has the bindings in the order of the plan", () => {
    expect(eventOrder(plan, "plan")).toEqual([0, 1, 2]);
  });
});

describe("resultRow", () => {
  it("names the binding of a write row, which the name of an inline handler does not", () => {
    // Two inline handlers of one module can have one name: the plan
    // numbers the handlers of each body from 1.
    const empty = { confidentiality: [], integrity: [] };
    const evaluated = { label: empty, bound: false, unsupported: [] };
    const equal = compareLabels(empty, empty);
    const write = (binding: number): WriteRow => ({
      binding,
      handler: "onClick#1",
      write: 0,
      path: [],
      runtime: empty,
      template: evaluated,
      comparison: equal,
      runtimeByOrigin: { all: empty, withoutStatic: empty },
      comparisonWithoutStatic: equal,
      looserByLinkStamp: false,
      byCoordinatorJoin: binding === 9,
      noAtomBesideCoordinatorJoin: false,
      lacking: binding === 9 ? ["stops"] : [],
    });

    const rows = [4, 9].map((binding) =>
      resultRow("write", write(binding), undefined)
    );
    // A row that is tighter by the coordinator's join says so, and names
    // the clauses the template lacks.
    expect(rows.map((row) => [row.coordinatorJoin, row.lacks])).toEqual([
      [undefined, undefined],
      ["tighter", "C {stops} I {}"],
    ]);

    expect(rows.map((row) => row.path)).toEqual([
      "onClick#1#0/",
      "onClick#1#0/",
    ]);
    expect(rows.map((row) => row.binding)).toEqual([4, 9]);
  });
});
