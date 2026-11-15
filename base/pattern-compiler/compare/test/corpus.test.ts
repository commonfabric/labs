import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { type ResultRow, tally } from "../corpus.ts";

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
