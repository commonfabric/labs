import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import {
  compareLabels,
  evaluateTemplate,
  type Label,
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
const minted = (by: unknown) => ({
  type: TRANSFORMED_BY,
  identity: { kind: "template", by },
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
      by: "f",
    };

    expect(evaluateTemplate(template, inputs()).label).toEqual({
      confidentiality: ["a", "b"],
      integrity: [ENDORSED, minted("f")],
    });
  });

  it("mints for a derive over unlabeled inputs unless told not to", () => {
    const template: Template = {
      op: "derive",
      inputs: [{ op: "const" }],
      by: "f",
    };

    expect(evaluateTemplate(template, inputs()).label.integrity).toEqual([
      minted("f"),
    ]);
    expect(
      evaluateTemplate(template, inputs(), [], { mintWithoutLabel: false })
        .label.integrity,
    ).toEqual([]);
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
      integrity: [ENDORSED, minted("fold")],
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
    });
  });

  it("counts a TransformedBy atom without comparing its identity", () => {
    const runtime = label([], [{ type: TRANSFORMED_BY, identity: "lift" }]);

    expect(compareLabels(label([], [minted("f")]), runtime).overall)
      .toBe("equal");
  });

  it("leaves a witness-bearing atom out of the relation and counts it", () => {
    const runtime = label([], [
      { type: TRANSFORMED_BY, identity: "lift" },
      { type: TRANSFORMED_BY, identity: "lift", inputWitness: ENDORSED },
    ]);

    expect(compareLabels(label([], [minted("f")]), runtime)).toEqual({
      confidentiality: "equal",
      integrity: "equal",
      overall: "equal",
      runtimeInputWitnesses: 1,
    });
  });
});
