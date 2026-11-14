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
