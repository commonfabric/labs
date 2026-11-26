import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import {
  compareCreated,
  compareDefaulted,
  compareIsEdited,
  comparePassed,
  compareSmall,
  compareStateDeclared,
  runHandler,
  runSmall,
} from "../scenarios.ts";
import { categoryOf } from "../template.ts";
import { type Row, runScenario } from "../harness.ts";
import { runBesideExecutor } from "../values.ts";

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

  it("has the container of a map tighter with the static part and without it", async () => {
    // The container holds the elements' clause on an entry of origin
    // `declared` and on its `enumerate` and `shape` entries, which are of
    // origin `structure`: stamps of the coordinator's run, which are
    // compared (PL §3.1, "Which entries are the static part"; §3.6).
    for (const flag of [true, false]) {
      const rows = await overall(flag);

      expect(rows.titles).toBe("tighter, tighter");
      expect(rows.loud).toBe("tighter, tighter");
    }
  });

  it("has an ifElse without the condition's label once the static part is left out", async () => {
    // The document of an `ifElse` result stores one entry, of origin
    // `declared`. The label of the condition reaches a reader through that
    // entry alone, so without it the template, which has the condition's
    // label, is the wider one. The comparison of a conditional is made
    // with the static part included (PL §3.5; section 8, question 69).
    expect((await overall(true)).direct).toBe("equal, looser");
    expect((await overall(false)).direct).toBe("tighter, looser");
  });
});

describe("the static part, by the document an entry is in", () => {
  it("keeps the clause the type of a state cell declares, which the template reads through its slot", async () => {
    // PL §3.1, "Which entries are the static part": a `declared` entry in
    // the document of a state cell is the label of the place a slot of
    // the template is bound in, and is compared. The one stored entry
    // that holds the clause of `pinned` is that entry.
    const [row] = await compareStateDeclared();

    expect(row.path).toEqual(["pinned"]);
    expect([...new Set(row.reached.label.confidentiality)]).toEqual(["alice"]);
    expect([...new Set(row.runtimeByOrigin.withoutStatic.confidentiality)])
      .toEqual(["alice"]);
    expect(row.comparisonWithoutStatic.confidentiality).toBe("equal");
  });
});

describe("a reference a site of a body made", () => {
  it("is compared with both sides reading the cell the stored link leads to", async () => {
    // PL §3.9, "A reference a site of the body made": the template of a
    // path that passes the handle on is the label of the reference, and
    // the clause the created cell's type declares stays at the cell. PL
    // §3.1, "A reference whose target no slot names": the template's side
    // is joined with what a value read through the stored link consumes.
    const rows = Object.fromEntries(
      (await compareCreated()).map((row) => [row.path.join("/"), row]),
    );
    const direct = rows["$UI/children/0/props/$value"];
    const throughFunction = rows["$UI/children/1"];

    for (const row of [direct, throughFunction]) {
      // The label of the reference alone has no clause.
      expect(row.stored.label.confidentiality).toEqual([]);
      expect([...new Set(row.runtime.confidentiality)]).toEqual(["alice"]);
      expect(row.comparison.confidentiality).toBe("equal");
    }
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
      // The run's join has the label of the input the handler read, and
      // not the clause the event's schema declares for `text`. The label
      // of an event slot is the label the event arrived with, which for
      // an event the test sends is none: the declaration is no lower
      // bound of it (PL §3.12, "The label of an event slot").
      expect(clauses(row.runtime.confidentiality)).toEqual(["alice"]);
      expect(clauses(row.template.label.confidentiality)).toEqual(["alice"]);
      expect(row.comparison.confidentiality).toBe("equal");
      expect(row.comparison.integrity).toBe("equal");
      // The target of a write edge gets no atom of the pattern added
      // (PL §3.2, "What does not get the atom"): the atom of each side
      // names the handler's body.
      expect(row.comparison.patternForOtherCode).toBe(0);
    }
  });

  it("says for each event whether its transaction was committed", async () => {
    const { events } = await runHandler();

    expect(events).toEqual([
      { binding: 0, handler: "record", outcome: "committed" },
    ]);
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

describe("a pattern written as a tag", () => {
  it("is read at the tag's position, where the run holds the callee's result", async () => {
    // "The entries of the enclosing rendered tree at the tag's position
    // are those of the callee's `[UI]`" (PL §1.1). The run holds the
    // result of `Row` at the position, with its tree under `$UI`.
    const read = (name: string) =>
      Deno.readTextFile(new URL(`../fixtures/${name}`, import.meta.url));
    const modules = JSON.parse(await read("tagged.plan.json"));
    const { plan } = modules[0].patterns.find((pattern: { name: string }) =>
      pattern.name === "default"
    );
    const run = await runScenario({
      program: {
        main: "/main.tsx",
        files: [{ name: "/main.tsx", contents: await read("tagged.tsx") }],
      },
      plan,
      argument: { secret: "s3cret" },
    });

    expect(run.missing).toEqual([]);
    const row = run.rows.find((row) =>
      row.path.join("/") === "$UI/children/0/children/0"
    );
    expect([...new Set(row?.runtime.confidentiality)]).toEqual(["alice"]);
    // The expression is written in `Row`, so it mints the atom of `Row`
    // and the output carries the atom of the plan's pattern beside it.
    expect(row && verdict(row)).toBe("C equal, I tighter, by name");
  });
});

describe("a handler bound in an element body", () => {
  const run = async () => {
    const read = (name: string) =>
      Deno.readTextFile(new URL(`../fixtures/${name}`, import.meta.url));
    const modules = JSON.parse(await read("element-handlers.emit.json"));
    const artifact = modules[0].patterns.find((pattern: { name: string }) =>
      pattern.name === "default"
    );
    const { plan } = artifact;
    return await runBesideExecutor(artifact, {
      program: {
        main: "/main.tsx",
        files: [{
          name: "/main.tsx",
          contents: await read("element-handlers.tsx"),
        }],
      },
      plan,
      argument: { items: [{ title: "a" }, { title: "b" }], note: "n" },
      events: [{ binding: 0, event: {} }, { binding: 1, event: {} }],
    });
  };

  it("gets its event at the stream of the last element of each enclosing collection", async () => {
    // The harness takes the positions at which the executor stored the
    // link, the last element of each collection first (ruling Z43). The
    // run of today stores the assembled array as one child of the view
    // node, so the element is at the position of that child and then at
    // its own.
    const { events } = await run();

    expect(events).toEqual([
      {
        binding: 0,
        handler: "choose",
        outcome: "committed",
        elements: [{ collection: 0, key: "1" }],
        stream: [
          "$UI",
          "children",
          "1",
          "children",
          "1",
          "1",
          "props",
          "onClick",
        ],
      },
      {
        binding: 1,
        handler: "mark",
        outcome: "committed",
        elements: [{ collection: 1, key: "1" }],
        stream: [
          "$UI",
          "children",
          "2",
          "children",
          "0",
          "1",
          "$UI",
          "props",
          "onClick",
        ],
      },
    ]);
  });

  it("compares its write edges with the element bound", async () => {
    const { writes, skipped } = await run();
    const clauses = (atoms: unknown[]) => [...new Set(atoms)].sort();

    expect(
      skipped.filter(({ what }) => what.startsWith("event of")),
    ).toEqual([]);
    expect(writes.map((row) => [row.handler, row.write, row.path])).toEqual([
      ["choose", 0, []],
      ["mark", 0, []],
    ]);
    // `choose` reads the title of its element and the input `note`, and
    // writes a state cell of the pattern.
    expect(clauses(writes[0].runtime.confidentiality)).toEqual([
      "alice",
      "bob",
    ]);
    expect(writes[0].comparison.overall).toBe("equal");
    // `mark` writes the state cell of the instance of `Row` for the
    // element: a cell of a pattern compiled in, which the run of today
    // names in the manifest of that instance's result.
    expect(clauses(writes[1].runtime.confidentiality)).toEqual(["alice"]);
    expect(writes[1].comparison.overall).toBe("equal");
  });
});

describe("an element body where one node reads the index", () => {
  // `fixtures/index-nodes.tsx`. The list declares `carol` on the array
  // itself and `alice` on the title of each element. `pickAt` closes over
  // the index, `clear` over a cell of the pattern alone, and the output
  // `numbered` reads the index and nothing of the element.
  const run = async () => {
    const read = (name: string) =>
      Deno.readTextFile(new URL(`../fixtures/${name}`, import.meta.url));
    const [{ patterns }] = JSON.parse(await read("index-nodes.emit.json"));
    return await runBesideExecutor(patterns[0], {
      program: {
        main: "/main.tsx",
        files: [{ name: "/main.tsx", contents: await read("index-nodes.tsx") }],
      },
      plan: patterns[0].plan,
      argument: { items: [{ title: "a" }, { title: "b" }] },
      events: [{ binding: 0, event: {} }, { binding: 1, event: {} }],
    });
  };
  const clauses = (atoms: unknown[]) => [...new Set(atoms)].sort();

  it("gives the index the label of the list's own array, and nothing of an element", async () => {
    // Ruling Y2: "the label of the index is the label of the collection's
    // own array: its length and which link each slot holds. It holds
    // nothing of what the links point to."
    const { rows, writes, skipped } = await run();

    expect(skipped.filter(({ what }) => what.startsWith("event of")))
      .toEqual([]);
    const numbered = rows.find((row) => row.path.join("/") === "numbered/1");
    expect(clauses(numbered?.stored.label.confidentiality ?? [])).toEqual([
      "carol",
    ]);
    expect(numbered?.comparison.confidentiality).not.toBe("looser");
    // A handler whose state holds the index is given the position, under
    // the same label (PL §1.3, "A handler binding of the reactive tier").
    const pickAt = writes.find((row) => row.handler === "pickAt");
    expect(clauses(pickAt?.template.label.confidentiality ?? [])).toEqual([
      "carol",
    ]);
    expect(pickAt?.comparison.confidentiality).not.toBe("looser");
  });

  it("gives a handler that closes over a captured cell alone nothing of the list", async () => {
    // PL §3.12, "A handler of an element body": "A handler that closes
    // over a captured cell alone ... writes under the event and the
    // label of the link to that cell, and under nothing of the element
    // or of the collection." PL §3.1, "The coordinator's join on an
    // element's argument document": the row is tighter by each clause of
    // that join, "it is expected, it is counted as tighter, and it is
    // reported apart".
    const { writes } = await run();

    const clear = writes.find((row) => row.handler === "clear");
    expect(clear?.template.label.confidentiality).toEqual([]);
    // The elements are stored in place in the list's document, so the
    // coordinator's join has the clause of every element.
    expect(clauses(clear?.runtime.confidentiality ?? [])).toEqual([
      "alice",
      "carol",
    ]);
    expect(clauses(clear?.lacking ?? [])).toEqual(["alice", "carol"]);
    expect(clear?.comparison.confidentiality).toBe("tighter");
    // A template with no clause mints no atom (PL §3.2, question 66), and
    // the runtime's label has the join and so the atom of the run. The
    // row is looser in integrity by that atom alone, and is counted
    // apart from the rows that are tighter by the join.
    expect(clear?.comparison.integrity).toBe("looser");
    expect(clear?.byCoordinatorJoin).toBe(false);
    expect(clear?.noAtomBesideCoordinatorJoin).toBe(true);
    // `pickAt` has the clause of the array through the index, and lacks
    // the clause of the elements, which the join has.
    const pickAt = writes.find((row) => row.handler === "pickAt");
    expect(clauses(pickAt?.lacking ?? [])).toEqual(["alice"]);
    expect(pickAt?.comparison.overall).toBe("tighter");
    expect(pickAt?.byCoordinatorJoin).toBe(true);
    expect(pickAt?.noAtomBesideCoordinatorJoin).toBe(false);
  });
});

describe("a state cell in an element body over two equal plain values", () => {
  // `fixtures/equal-values.tsx`. PL §1.3, "A state cell is per
  // occurrence": "A state cell with an `element` step in `within` is legal
  // over every collection, a collection of plain values included ... Two
  // rows that show the same value have a flag each."
  it("is a cell of each occurrence, and the handler of one occurrence writes its own", async () => {
    const read = (name: string) =>
      Deno.readTextFile(new URL(`../fixtures/${name}`, import.meta.url));
    const [{ patterns }] = JSON.parse(await read("equal-values.emit.json"));
    const [{ plan, unsupported }] = patterns;
    expect(unsupported).toEqual([]);
    expect(plan.stateCells).toEqual([
      {
        name: "opened",
        scope: "space",
        within: [{ element: 0 }],
        schema: plan.stateCells[0].schema,
      },
    ]);
    const run = await runBesideExecutor(patterns[0], {
      program: {
        main: "/main.tsx",
        files: [{
          name: "/main.tsx",
          contents: await read("equal-values.tsx"),
        }],
      },
      plan,
      argument: { tags: ["a", "a"] },
      events: [{ binding: 0, event: {} }],
    });

    expect(run.events.map((event) => [event.outcome, event.elements]))
      .toEqual([["committed", [{ collection: 0, key: "1" }]]]);
    expect(run.skipped.filter(({ what }) => what.startsWith("event of")))
      .toEqual([]);
    expect(run.writes.map((row) => [row.handler, row.write, row.path]))
      .toEqual([["open", 0, []]]);
    expect(run.writes[0].comparison.overall).not.toBe("looser");
  });
});

describe("a binding whose stream the result holds at several paths", () => {
  // `fixtures/outer-stream.tsx`: the binding is made outside every element
  // body. Its first path is in a branch of a conditional, its second in
  // each element of a list, and its third at a position of its own.
  const run = async (shown: boolean, items: string[]) => {
    const read = (name: string) =>
      Deno.readTextFile(new URL(`../fixtures/${name}`, import.meta.url));
    const [{ patterns }] = JSON.parse(await read("outer-stream.emit.json"));
    return await runBesideExecutor(patterns[0], {
      program: {
        main: "/main.tsx",
        files: [{
          name: "/main.tsx",
          contents: await read("outer-stream.tsx"),
        }],
      },
      plan: patterns[0].plan,
      argument: { items, shown },
      events: [{ binding: 0, event: { by: 2 } }],
    });
  };

  it("gets its event at the first path the run holds the stream at", async () => {
    // The branch is not selected, so the first path holds no stream. The
    // second passes through a collection the binding is not within: any
    // position of it holds the one stream, and no element is bound.
    const { events, writes } = await run(false, ["a", "b"]);

    expect(events).toEqual([
      { binding: 0, handler: "inc", outcome: "committed" },
    ]);
    expect(writes.map((row) => [row.handler, row.write, row.path])).toEqual([
      ["inc", 0, []],
    ]);
  });

  it("goes on to a later path where a collection on the way has no element", async () => {
    const { events } = await run(false, []);

    expect(events.map((event) => event.outcome)).toEqual(["committed"]);
  });
});
