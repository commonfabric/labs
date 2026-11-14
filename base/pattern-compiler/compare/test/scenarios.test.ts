import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { compareIsEdited, compareSmall } from "../scenarios.ts";

// The comparison of stage 3
// (`docs/specs/compiled-pattern-language/README.md`, "Staging") for one
// fixture: each output's template, evaluated on the labels the run stored
// for its slots, against the label the run stored for the output. Notes 177
// to 186 of `SPEC-NOTES.md` explain each row that is not `equal`.

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
  // `items.length` is the collection's membership (PL §3.8): the
  // `enumeration` slot at `items`, which has no label.
  count: EQUAL,
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

describe("the template of a message row's isEdited against the runtime's label", () => {
  const isEdited = async (edited: boolean) => {
    const [row] = await compareIsEdited(edited);
    return {
      runtime: [...new Set(row.runtime.confidentiality)].sort(),
      template: [...row.reached.label.confidentiality].sort(),
      overall: row.comparison.overall,
    };
  };

  it("leaves out the field the value does not depend on when the message was edited", async () => {
    expect(await isEdited(true)).toEqual({
      runtime: ["body", "edited", "sent"],
      template: ["body", "edited"],
      overall: "tighter",
    });
  });

  it("has no clause when the message was not edited, since no label is stored for an absent field", async () => {
    expect(await isEdited(false)).toEqual({
      runtime: ["body", "edited", "sent"],
      template: [],
      overall: "tighter",
    });
  });
});
