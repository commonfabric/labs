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
});

describe("eventOrder", () => {
  const plan = {
    slots: [],
    collections: [],
    outputs: [],
    bindings: [
      { name: "outer", handler: { body: 0 }, result: [["a"]] },
      {
        name: "inner",
        handler: { body: 1 },
        result: [["b"]],
        within: [{ element: 0 }],
      },
      { name: "no path", handler: { body: 2 } },
      { name: "later", handler: { body: 3 }, result: [["c"]] },
      { name: "no handler", result: [["d"]] },
    ],
  };

  it("has the bindings with no `within` step first, each group in the order of the plan", () => {
    expect(eventOrder(plan, "outside first")).toEqual([0, 3, 1]);
  });

  it("has the bindings in the order of the plan", () => {
    expect(eventOrder(plan, "plan")).toEqual([0, 1, 3]);
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
    });

    const rows = [4, 9].map((binding) =>
      resultRow("write", write(binding), undefined)
    );

    expect(rows.map((row) => row.path)).toEqual([
      "onClick#1#0/",
      "onClick#1#0/",
    ]);
    expect(rows.map((row) => row.binding)).toEqual([4, 9]);
  });
});
