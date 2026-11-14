import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import {
  compareDefaulted,
  compareIsEdited,
  comparePassed,
  compareSmall,
  runHandler,
  runSmall,
} from "../scenarios.ts";
import { categoryOf } from "../template.ts";
import type { Row } from "../harness.ts";

// The comparison of stage 3
// (`docs/specs/compiled-pattern-language/README.md`, "Staging") for one
// fixture: each output's template, evaluated on the labels the run stored
// for its slots, against the label the run stored for the output. Notes 177
// to 186 of `SPEC-NOTES.md` explain each row that is not `equal`.

// The relation on each axis, and where an atom of the template names the
// pattern and the runtime's names other code, that it does (PL §3.1, "An
// atom that names code").
const verdict = (row: Row) =>
  `C ${row.comparison.confidentiality}, I ${row.comparison.integrity}` +
  (categoryOf(row.comparison) === "atom names the pattern" ? ", by name" : "");

const verdicts = async (flag: boolean) =>
  Object.fromEntries(
    (await compareSmall(flag)).map((row) => [row.path.join("/"), verdict(row)]),
  );

// A promoted `computed` over a labeled input: the template mints the atom
// of the pattern, where the runtime's lift mints one for the callback.
const NAMED = "C equal, I equal, by name";
// A value the pattern passes on, or one with no label: the template has
// the atom of the pattern that every kept output carries, and the runtime
// stores no atom (PL §3.2, "Every kept output").
const PASSED = "C equal, I tighter";

// The rows that do not depend on which branch the conditionals take.
const UNCONDITIONAL = {
  shout: NAMED,
  echo: NAMED,
  both: NAMED,
  // No input of `greeting` has a label, and neither side mints
  // `TransformedBy` beside none (PL §3.2, question 66). The output
  // carries the pattern's atom all the same.
  greeting: PASSED,
  // The runtime's container carries the label the result schema declares
  // for the elements. The template is the source's membership.
  titles: "C tighter, I tighter",
  "titles/0": PASSED,
  "titles/1": PASSED,
  loud: "C tighter, I tighter",
  "loud/0": NAMED,
  "loud/1": NAMED,
  note: PASSED,
  secret: PASSED,
  // `items.length` is the collection's membership (PL §3.8): the
  // `enumeration` slot at `items`, which has no label.
  count: PASSED,
};

describe("the small fixture's templates against the runtime's labels", () => {
  it("compares each output when the conditionals select the labeled branch", async () => {
    expect(await verdicts(true)).toEqual({
      ...UNCONDITIONAL,
      // A conditional inside a `computed` is a lift today: it copies the
      // value and mints `TransformedBy` for the callback. A `select` has
      // the integrity of the selected branch, and the kept output the
      // atom of the pattern (PL §3.5).
      chosen: NAMED,
      // The same conditional in the pattern body: the runtime mints none.
      direct: PASSED,
    });
  });

  it("compares each output when the conditionals select the unlabeled branch", async () => {
    expect(await verdicts(false)).toEqual({
      ...UNCONDITIONAL,
      chosen: "C tighter, I equal, by name",
      // The runtime's label is the one the result schema declares, which
      // joins both branches whichever is selected.
      direct: "C tighter, I tighter",
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
    // With no clause the template mints no `TransformedBy` (PL §3.2,
    // question 66), and the runtime's label has one beside its clauses.
    // The output is kept, so it carries the pattern's atom all the same
    // (PL §3.2; note 197 had it looser on integrity).
    expect(await isEdited(false)).toEqual({
      runtime: ["body", "edited", "sent"],
      template: [],
      overall: "tighter",
    });
  });
});

describe("an object with a declared integrity atom and a defaulted property (ruling T1)", () => {
  const relations = async (given: boolean) =>
    Object.fromEntries(
      (await compareDefaulted(given)).map((row) => [
        row.path.join("/"),
        verdict(row),
      ]),
    );

  it("has the object's integrity on a whole read and none at the property a default fills", async () => {
    expect(await relations(false)).toEqual({
      whole: PASSED,
      name: PASSED,
      // The runtime gives the defaulted property the object's atom. The
      // slot has the empty integrity there, which is the exception by
      // ruling of PL §3.1. The output has the pattern's atom, which the
      // runtime lacks, so the two sets of atoms are incomparable.
      nick: "C equal, I incomparable",
      derived: PASSED,
    });
  });

  it("is equal at the property where the argument supplies it", async () => {
    expect(await relations(true)).toEqual({
      whole: PASSED,
      name: PASSED,
      nick: PASSED,
      derived: PASSED,
    });
  });
});

describe("the runtime's labels read by origin (ruling T2)", () => {
  // The confidentiality with the static part, and without it. The
  // integrity does not depend on the static part here.
  const overall = async (flag: boolean) =>
    Object.fromEntries(
      (await compareSmall(flag)).map((row) => [
        row.path.join("/"),
        `${row.comparison.confidentiality}, ${row.comparisonWithoutStatic.confidentiality}`,
      ]),
    );

  it("reads the same clauses by origin as the label view has", async () => {
    for (const row of await compareSmall(false)) {
      const clauses = (atoms: unknown[]) => [...new Set(atoms)].sort();

      expect(clauses(row.runtimeByOrigin.all.confidentiality)).toEqual(
        clauses(row.runtime.confidentiality),
      );
    }
  });

  it("has the container of a map tighter with the static part and equal without it", async () => {
    for (const flag of [true, false]) {
      const rows = await overall(flag);

      expect(rows.titles).toBe("tighter, equal");
      expect(rows.loud).toBe("tighter, equal");
    }
  });

  it("has an ifElse without the condition's label once the static part is left out", async () => {
    // The document of an `ifElse` result stores one entry, of origin
    // `declared`. The label of the condition reaches a reader through that
    // entry alone, so without it the template, which has the condition's
    // label, is the wider one.
    expect((await overall(true)).direct).toBe("equal, looser");
    expect((await overall(false)).direct).toBe("tighter, looser");
  });
});

describe("the write edges of a handler against the labels its event's run stored", () => {
  it("compares the cell the handler sets and the element it pushes", async () => {
    const { writes, skipped } = await runHandler();
    const clauses = (atoms: unknown[]) => [...new Set(atoms)].sort();

    expect(skipped).toEqual([]);
    expect(writes.map((row) => [row.handler, row.write, row.path])).toEqual([
      ["record", 0, []],
      ["record", 1, ["0"]],
    ]);
    for (const row of writes) {
      // The run's join has the label of the input the handler read. The
      // template also has the clause the event's schema declares for
      // `text`, which the runtime's join does not hold (note 198).
      expect(clauses(row.runtime.confidentiality)).toEqual(["alice"]);
      expect(clauses(row.template.label.confidentiality)).toEqual([
        "alice",
        "erin",
      ]);
      expect(row.comparison.confidentiality).toBe("looser");
      expect(row.comparison.integrity).toBe("equal");
      // The target of a write edge gets no atom of the pattern added
      // (PL §3.2, "What does not get the atom"): the atom of each side
      // names the handler's body.
      expect(row.comparison.patternForOtherCode).toBe(0);
    }
  });

  it("reads the state cells the handler writes as outputs with no label before the event", async () => {
    const { rows } = await runHandler();

    expect(
      Object.fromEntries(
        rows.map((row) => [row.path.join("/"), row.comparison.overall]),
      ),
    ).toEqual({ last: "tighter", log: "tighter", note: "tighter" });
  });
});

describe("the branch a selector took, found from the run", () => {
  it("finds every branch of the small fixture from the stored values", async () => {
    for (const flag of [true, false]) {
      // `chosen` and `direct` each hold the value of one of two inputs.
      expect((await runSmall(flag)).decided).toEqual({
        byValue: 2,
        byCondition: 0,
        stated: 0,
        unobserved: 0,
      });
    }
  });
});

describe("a computed whose template is not a derive (note 202)", () => {
  it("has the atom of the pattern where the runtime's lift mints one for the callback", async () => {
    const rows = Object.fromEntries(
      (await comparePassed()).map((row) => [row.path.join("/"), verdict(row)]),
    );

    expect(rows).toEqual({
      // A slot passed on, and the membership of a collection. The template
      // mints nothing, and the kept output carries the pattern's atom.
      same: NAMED,
      count: NAMED,
      // The container entry of a constructed value is `const`, and the
      // lift's label is on the container too.
      tagged: "C tighter, I equal, by name",
      "tagged/who": NAMED,
    });
  });
});
