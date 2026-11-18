import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import {
  type By,
  categoryOf,
  compareLabels,
  evaluateTemplate,
  keptOutputLabel,
  type Label,
  patternAtom,
  type Template,
  type TemplateInputs,
  TRANSFORMED_BY,
} from "../template.ts";

const ENDORSED = { type: "endorsed" };
const BOUND = { type: "bound" };

// Slots 0 to 2 are plain inputs. Slot 3 is the element slot of collection
// 0, whose elements are `x` and `y`.
const SLOTS: Label[] = [
  { confidentiality: ["a"], integrity: [ENDORSED, BOUND] },
  { confidentiality: ["b"], integrity: [ENDORSED] },
  { confidentiality: ["c"], integrity: [] },
];
const ELEMENTS: Record<string, Label> = {
  x: { confidentiality: ["x"], integrity: [ENDORSED] },
  y: { confidentiality: ["y"], integrity: [ENDORSED] },
};

const inputs = (selected?: number): TemplateInputs => ({
  slot: (slot, elements) =>
    slot === 3 ? ELEMENTS[elements.at(-1)!.key] : SLOTS[slot],
  selected: () => selected,
  elementKeys: () => Object.keys(ELEMENTS),
  membership: () => ({ confidentiality: ["m"], integrity: [] }),
  picked: () => ({ collection: 0, key: "y" }),
  hereditary: (atom) => atom === ENDORSED,
});

const slot = (index: number): Template => ({ op: "slot", slot: index });
const PATTERNS = ["outer", "row"];
const BODY = { body: 4 };
const EXPRESSION = { expression: true } as const;
const mintedByBody = {
  type: TRANSFORMED_BY,
  identity: { kind: "body", body: 4 },
};
const atomOf = (pattern: string) => ({
  type: TRANSFORMED_BY,
  identity: { kind: "pattern", pattern },
});

describe("evaluateTemplate", () => {
  it("gives a constant no clause and the neutral integrity", () => {
    expect(evaluateTemplate({ op: "const" }, inputs()).label).toEqual({
      confidentiality: [],
      integrity: "neutral",
    });
  });

  it("passes a slot's label through with every atom", () => {
    expect(evaluateTemplate(slot(0), inputs()).label).toEqual(SLOTS[0]);
  });

  it("joins the inputs of a derive, keeps the hereditary atoms all have, and mints", () => {
    const template: Template = {
      op: "derive",
      inputs: [slot(0), { op: "const" }, slot(1)],
      by: BODY,
    };

    expect(evaluateTemplate(template, inputs()).label).toEqual({
      confidentiality: ["a", "b"],
      integrity: [ENDORSED, mintedByBody],
    });
  });

  it("mints the atom of the pattern an expression is written in", () => {
    // PL §3.2, "The atom of the pattern": entry `pattern` of
    // `Plan.patterns`, and entry 0 where the node has no `pattern` member.
    const derive = (by: By): Template => ({
      op: "derive",
      inputs: [slot(0)],
      by,
    });
    const integrity = (template: Template) =>
      evaluateTemplate(template, inputs(), [], { patterns: PATTERNS }).label
        .integrity;

    expect(integrity(derive(EXPRESSION))).toEqual([ENDORSED, atomOf("outer")]);
    expect(integrity(derive({ expression: true, pattern: 1 }))).toEqual([
      ENDORSED,
      atomOf("row"),
    ]);
    expect(integrity({ op: "fold", collection: 0, body: slot(3), pattern: 1 }))
      .toEqual([ENDORSED, atomOf("row")]);
  });

  it("adds the atom of the plan's pattern to a kept output, whatever its template", () => {
    // PL §3.2, "Every kept output": with no condition, beside no label
    // too, and once where a `derive` of the same pattern minted it.
    const kept = (template: Template) =>
      evaluateTemplate(template, inputs(1), [], {
        patterns: PATTERNS,
        kept: true,
      }).label;

    expect(kept(slot(1))).toEqual({
      confidentiality: ["b"],
      integrity: [ENDORSED, atomOf("outer")],
    });
    expect(kept({ op: "const" })).toEqual({
      confidentiality: [],
      integrity: [atomOf("outer")],
    });
    expect(
      kept({
        op: "select",
        selector: 0,
        condition: slot(2),
        branches: [slot(0), slot(1)],
      }).integrity,
    ).toEqual([ENDORSED, atomOf("outer")]);
    expect(kept({ op: "derive", inputs: [slot(1)], by: EXPRESSION }).integrity)
      .toEqual([ENDORSED, atomOf("outer")]);
    expect(
      kept({
        op: "derive",
        inputs: [slot(1)],
        by: { expression: true, pattern: 1 },
      }).integrity,
    ).toEqual([ENDORSED, atomOf("row"), atomOf("outer")]);
    expect(keptOutputLabel({ confidentiality: [], integrity: [] }, PATTERNS))
      .toEqual({ confidentiality: [], integrity: [patternAtom(PATTERNS)] });
  });

  it("mints for a derive over unlabeled inputs only when told to", () => {
    const template: Template = {
      op: "derive",
      inputs: [{ op: "const" }],
      by: BODY,
    };

    expect(evaluateTemplate(template, inputs()).label.integrity).toEqual([]);
    expect(
      evaluateTemplate(template, inputs(), [], { mintWithoutLabel: true })
        .label.integrity,
    ).toEqual([mintedByBody]);
  });

  it("joins the condition with the selected branch alone", () => {
    const template: Template = {
      op: "select",
      selector: 0,
      condition: slot(2),
      branches: [slot(0), slot(1)],
    };

    expect(evaluateTemplate(template, inputs(1))).toEqual({
      label: { confidentiality: ["c", "b"], integrity: [ENDORSED] },
      bound: false,
      unsupported: [],
    });
  });

  it("bounds a select whose selector was not observed by every branch", () => {
    const template: Template = {
      op: "select",
      selector: 0,
      condition: slot(2),
      branches: [slot(0), slot(1)],
    };

    expect(evaluateTemplate(template, inputs())).toEqual({
      label: { confidentiality: ["c", "a", "b"], integrity: [ENDORSED] },
      bound: true,
      unsupported: [],
    });
  });

  it("joins the membership of a fold with its body over every element", () => {
    const template: Template = { op: "fold", collection: 0, body: slot(3) };

    expect(evaluateTemplate(template, inputs()).label).toEqual({
      confidentiality: ["m", "x", "y"],
      integrity: [ENDORSED, atomOf("unlisted:0")],
    });
  });

  it("joins the choice of a pick with its body at the chosen element", () => {
    const template: Template = {
      op: "pick",
      pick: 0,
      choice: slot(2),
      body: slot(3),
    };

    expect(evaluateTemplate(template, inputs()).label).toEqual({
      confidentiality: ["c", "y"],
      integrity: [ENDORSED],
    });
  });

  it("says for each slot whether it stands for the value the template passes on", () => {
    // PL §3.1, "What is compared": the `slot` node that is the template,
    // the selected branch of a `select`, and the chosen child of a `pick`
    // stand for the reference an output passes on. An input of a `derive`,
    // a condition, a choice, and the body of a `fold` do not.
    const seen: [number, boolean][] = [];
    const recording: TemplateInputs = {
      ...inputs(0),
      slot: (index, elements, passed) => {
        seen.push([index, passed ?? false]);
        return inputs().slot(index, elements);
      },
    };
    const template: Template = {
      op: "select",
      selector: 0,
      condition: slot(0),
      branches: [
        {
          op: "pick",
          pick: 0,
          choice: slot(1),
          body: slot(3),
        },
        slot(2),
      ],
    };
    evaluateTemplate(template, recording);
    evaluateTemplate(
      { op: "derive", inputs: [slot(2)], by: BODY },
      recording,
    );
    evaluateTemplate({ op: "fold", collection: 0, body: slot(3) }, recording);
    evaluateTemplate(slot(1), recording);

    expect(seen).toEqual([
      [0, false],
      [1, false],
      [3, true],
      [2, false],
      [3, false],
      [3, false],
      [1, true],
    ]);
  });

  it("gives a slot of root `index` the label of the array its collection iterates", () => {
    // PL §2.2, "The label of a slot of root `index`": "Its label is
    // defined by rule and not by a read." Ruling Y2: "the label of the
    // collection's own array: its length and which link each slot holds
    // ... the label of the whole array". Slot 4 is the index of
    // collection 0, read inside the element `x` of it.
    const seen: unknown[] = [];
    const withIndex: TemplateInputs = {
      ...inputs(),
      slot: () => {
        throw new Error("an index slot is not read at an address");
      },
      indexOf: (slot) => slot === 4 ? 0 : undefined,
      array: (collection, elements) => {
        seen.push([collection, elements]);
        return { confidentiality: ["array"], integrity: [ENDORSED] };
      },
    };
    const inside = [{ collection: 7, key: "outer" }, {
      collection: 0,
      key: "x",
    }];

    expect(evaluateTemplate(slot(4), withIndex, inside).label).toEqual({
      confidentiality: ["array"],
      integrity: [ENDORSED],
    });
    // The array is that of the collection, evaluated outside the element
    // of it: the label is the same for every element.
    expect(seen).toEqual([[0, [{ collection: 7, key: "outer" }]]]);
    // Without `array`, the membership the collection iterates stands in.
    const { array: _, ...withoutArray } = withIndex;
    expect(evaluateTemplate(slot(4), withoutArray, inside).label).toEqual({
      confidentiality: ["m"],
      integrity: [],
    });
  });

  it("reports a dynamic node it has no reads for", () => {
    const template: Template = { op: "dynamic", reads: 0 };

    expect(evaluateTemplate(template, inputs()).unsupported).toEqual([
      "dynamic",
    ]);
  });
});

describe("compareLabels", () => {
  const label = (confidentiality: unknown[], integrity: unknown[]): Label => ({
    confidentiality,
    integrity,
  });

  it("calls fewer clauses tighter and more clauses looser", () => {
    expect(compareLabels(label(["a"], []), label(["a", "b"], [])).overall)
      .toBe("tighter");
    expect(compareLabels(label(["a", "b"], []), label(["a"], [])).overall)
      .toBe("looser");
  });

  it("calls more integrity atoms tighter and fewer looser", () => {
    expect(compareLabels(label([], [ENDORSED]), label([], [])).overall)
      .toBe("tighter");
    expect(compareLabels(label([], []), label([], [ENDORSED])).overall)
      .toBe("looser");
  });

  it("is looser where one axis is looser and the other tighter", () => {
    expect(compareLabels(label([], []), label(["a"], [ENDORSED]))).toEqual({
      confidentiality: "tighter",
      integrity: "looser",
      overall: "looser",
      runtimeInputWitnesses: 0,
      patternForOtherCode: 0,
    });
  });

  it("counts a TransformedBy atom without comparing its identity", () => {
    const runtime = label([], [{ type: TRANSFORMED_BY, identity: "lift" }]);

    expect(compareLabels(label([], [mintedByBody]), runtime).overall)
      .toBe("equal");
  });

  it("takes an atom that names the pattern as corresponding to the runtime's atom for other code", () => {
    // PL §3.1, "An atom that names code": equal on the atoms where each
    // side has its atom, and counted in a category of its own.
    const callback = { type: TRANSFORMED_BY, identity: "callback" };
    const pattern = atomOf("outer");
    const promoted = compareLabels(label([], [pattern]), label([], [callback]));

    expect(promoted.integrity).toBe("equal");
    expect(promoted.patternForOtherCode).toBe(1);
    expect(categoryOf(promoted)).toBe("atom names the pattern");
    // A value the pattern passes on: an atom where the runtime has none.
    const passed = compareLabels(label([], [pattern]), label([], []));
    expect(passed.patternForOtherCode).toBe(0);
    expect(categoryOf(passed)).toBe("tighter");
    // A body keeps its atom, and the pattern's stands beside it.
    const body = compareLabels(
      label([], [mintedByBody, pattern]),
      label([], [callback]),
    );
    expect(body.patternForOtherCode).toBe(0);
    expect(categoryOf(body)).toBe("tighter");
    // A row that is looser is looser, whatever its atoms name.
    expect(
      categoryOf(compareLabels(label(["a"], [pattern]), label([], [callback]))),
    ).toBe("looser");
    expect(categoryOf(compareLabels(label([], []), label([], [])))).toBe(
      "equal",
    );
  });

  it("leaves a witness-bearing atom out of the relation and counts it", () => {
    const runtime = label([], [
      { type: TRANSFORMED_BY, identity: "lift" },
      { type: TRANSFORMED_BY, identity: "lift", inputWitness: ENDORSED },
    ]);

    expect(compareLabels(label([], [mintedByBody]), runtime)).toEqual({
      confidentiality: "equal",
      integrity: "equal",
      overall: "equal",
      runtimeInputWitnesses: 1,
      patternForOtherCode: 0,
    });
  });
});

// Ruling Z58: a template names the template of another output by
// reference.
describe("a reference to the template of an output", () => {
  const derive = (...of: Template[]): Template => ({
    op: "derive",
    inputs: of,
    by: EXPRESSION,
  });
  const reference = (output: number): Template => ({ op: "output", output });

  it("has the label of the template it names, written in its place", () => {
    const outputs = [{ template: derive(slot(0), slot(1)) }];
    const options = { patterns: PATTERNS, outputs };

    expect(
      evaluateTemplate(derive(reference(0), slot(2)), inputs(), [], options),
    ).toEqual(
      evaluateTemplate(
        derive(derive(slot(0), slot(1)), slot(2)),
        inputs(),
        [],
        options,
      ),
    );
  });

  it("evaluates each output once, however many templates name it", () => {
    // A chain in which each output names the two before it: the last
    // depends on the first by more than a hundred thousand ways.
    const outputs: { template: Template }[] = [
      { template: derive(slot(0)) },
      { template: derive(slot(1)) },
    ];
    for (let index = 2; index < 25; index++) {
      outputs.push({
        template: derive(reference(index - 1), reference(index - 2)),
      });
    }
    let reads = 0;
    const counting: TemplateInputs = {
      ...inputs(),
      slot: (index) => {
        reads += 1;
        return SLOTS[index];
      },
    };

    const evaluated = evaluateTemplate(reference(24), counting, [], {
      patterns: PATTERNS,
      outputs,
    });

    expect(reads).toBe(2);
    expect([...evaluated.label.confidentiality].sort()).toEqual(["a", "b"]);
  });

  it("carries a selector that was not observed to every template that names it", () => {
    const select: Template = {
      op: "select",
      selector: 0,
      condition: slot(2),
      branches: [slot(0), slot(1)],
    };
    const options = { patterns: PATTERNS, outputs: [{ template: select }] };

    const evaluated = evaluateTemplate(
      derive(reference(0), reference(0)),
      inputs(),
      [],
      options,
    );

    expect(evaluated.bound).toBe(true);
  });
});
