import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { compareSmall } from "../small.ts";

// The comparison of stage 3
// (`docs/specs/compiled-pattern-language/README.md`, "Staging") for one
// fixture: each output's template, evaluated on the labels the run stored
// for its slots, against the label the run stored for the output. Notes 177
// to 183 of `SPEC-NOTES.md` explain each row that is not `equal`.

const verdicts = async (flag: boolean) =>
  Object.fromEntries(
    (await compareSmall(flag)).map((row) => [
      row.path.join("/"),
      `C ${row.comparison.confidentiality}, I ${row.comparison.integrity}`,
    ]),
  );

const EQUAL = "C equal, I equal";

// The rows that do not depend on which branch the conditionals take.
const UNCONDITIONAL = {
  shout: EQUAL,
  echo: EQUAL,
  both: EQUAL,
  // The runtime mints `TransformedBy` beside a label only, and no input of
  // `greeting` has one.
  greeting: "C equal, I tighter",
  // The runtime's container carries the label the result schema declares
  // for the elements. The template is the source's membership.
  titles: "C tighter, I equal",
  "titles/0": EQUAL,
  "titles/1": EQUAL,
  loud: "C tighter, I equal",
  "loud/0": EQUAL,
  "loud/1": EQUAL,
  note: EQUAL,
  secret: EQUAL,
  // The crate emits `items.length` as an `identity` slot at `items/length`,
  // where PL §3.8 has the collection's membership. The dereferenced read of
  // that path matches the `*` of the elements' declared label.
  count: "C looser, I equal",
};

describe("the small fixture's templates against the runtime's labels", () => {
  it("compares each output when the conditionals select the labeled branch", async () => {
    expect(await verdicts(true)).toEqual({
      ...UNCONDITIONAL,
      // A conditional inside a `computed` is a lift today: it copies the
      // value and mints `TransformedBy`. A `select` has the integrity of
      // the selected branch.
      chosen: "C equal, I looser",
      direct: EQUAL,
    });
  });

  it("compares each output when the conditionals select the unlabeled branch", async () => {
    expect(await verdicts(false)).toEqual({
      ...UNCONDITIONAL,
      chosen: "C tighter, I looser",
      // The runtime's label is the one the result schema declares, which
      // joins both branches whichever is selected.
      direct: "C tighter, I equal",
    });
  });

  it("counts the witness-bearing atom of a derivation over a derivation", async () => {
    const echo = (await compareSmall(true)).find((row) =>
      row.path.join("/") === "echo"
    );

    expect(echo?.comparison.runtimeInputWitnesses).toBe(1);
  });
});
