import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { CFC_ATOM_TYPE, type CfcAtom } from "@commonfabric/api/cfc";

import {
  type DerivedBy,
  type ElementInputs,
  emptyTemplateWork,
  instantiateTemplate,
  type InternedLabel,
  LabelTable,
  NEUTRAL,
  type Template,
  type TemplateInputs,
  TemplateInstantiationError,
} from "../../src/cfc/plan-template.ts";
import type { IFCLabel } from "../../src/cfc/types.ts";

const certified: CfcAtom = {
  type: CFC_ATOM_TYPE.PolicyCertified,
  policy: "p",
};
const injectionSafe: CfcAtom = { type: CFC_ATOM_TYPE.InjectionSafe };
const bodyAtom = (by: DerivedBy): CfcAtom => ({
  type: CFC_ATOM_TYPE.TransformedBy,
  identity: { kind: "builtin", builtinId: JSON.stringify(by) },
});
const witnessed: CfcAtom = {
  type: CFC_ATOM_TYPE.TransformedBy,
  identity: { kind: "builtin", builtinId: "upstream" },
};

/** Inputs over fixed slot labels, with each other member overridable. */
const inputsOf = (
  table: LabelTable,
  slots: readonly IFCLabel[],
  rest: Partial<TemplateInputs> = {},
): TemplateInputs & { bounds: string[]; minted: unknown[] } => {
  const bounds: string[] = [];
  const minted: unknown[] = [];
  return {
    bounds,
    minted,
    slotLabel: (slot) => table.intern(slots[slot]),
    selection: () => undefined,
    elements: () => ({ groups: [] }),
    chosen: () => undefined,
    children: () => ({ groups: [] }),
    membership: () => table.empty,
    outputLabel: () => NEUTRAL,
    sharedLabel: () => NEUTRAL,
    dynamicLabel: () => table.empty,
    mint: (by, witnesses) => {
      minted.push({ by, witnesses: witnesses?.integrity });
      return table.intern({
        integrity: [bodyAtom(by), ...(witnesses?.integrity ?? [])],
      });
    },
    noteBound: (kind, index) => bounds.push(`${kind}:${index}`),
    ...rest,
  };
};

const slot = (index: number): Template => ({ op: "slot", slot: index });
const literal: Template = { op: "const" };
const expression: DerivedBy = { expression: true };

/** Instantiates with a fresh record of work, returning both. */
const run = (
  template: Template,
  inputs: TemplateInputs,
  table: LabelTable,
) => {
  const work = emptyTemplateWork();
  return { label: instantiateTemplate(template, inputs, table, work), work };
};

/** A label's interned form, for comparison. */
const label = (table: LabelTable, value: IFCLabel): InternedLabel =>
  table.intern(value);

describe("instantiateTemplate()", () => {
  describe("const", () => {
    it("returns NEUTRAL", () => {
      const table = new LabelTable();
      expect(run(literal, inputsOf(table, []), table).label).toBe(NEUTRAL);
    });
  });

  describe("slot", () => {
    it("returns the slot's label unchanged", () => {
      const table = new LabelTable();
      const inputs = inputsOf(table, [{
        confidentiality: ["a"],
        integrity: [certified],
      }]);
      const { label: result, work } = run(slot(0), inputs, table);
      expect(result).toBe(
        label(table, { confidentiality: ["a"], integrity: [certified] }),
      );
      expect(work.slotLabels).toBe(1);
    });
  });

  describe("derive", () => {
    it("joins confidentiality, meets hereditary integrity and mints", () => {
      const table = new LabelTable();
      const inputs = inputsOf(table, [
        { confidentiality: ["a"], integrity: [certified, injectionSafe] },
        { confidentiality: ["b"], integrity: [certified] },
      ]);
      const result = run(
        { op: "derive", inputs: [slot(0), slot(1)], by: expression },
        inputs,
        table,
      ).label as InternedLabel;
      expect([...result.confidentiality].sort()).toEqual(["a", "b"]);
      expect(result.integrity).toContainEqual(certified);
      expect(result.integrity).toContainEqual(bodyAtom(expression));
      expect(result.integrity).not.toContainEqual(injectionSafe);
    });

    it("leaves a neutral part out of the join and the meet", () => {
      const table = new LabelTable();
      const inputs = inputsOf(table, [
        { confidentiality: ["a"], integrity: [certified] },
      ]);
      const result = run(
        { op: "derive", inputs: [slot(0), literal], by: expression },
        inputs,
        table,
      ).label as InternedLabel;
      expect(result.confidentiality).toEqual(["a"]);
      expect(result.integrity).toContainEqual(certified);
    });

    it("mints nothing beside a label with no clause and no hereditary atom", () => {
      const table = new LabelTable();
      const inputs = inputsOf(table, [{}]);
      const result = run(
        { op: "derive", inputs: [slot(0), literal], by: { body: 2 } },
        inputs,
        table,
      ).label;
      expect(result).toBe(table.empty);
      expect(inputs.minted).toEqual([]);
    });

    it("passes the witnesses met over the inputs that carry a clause", () => {
      const table = new LabelTable();
      const inputs = inputsOf(table, [
        { confidentiality: ["a"], integrity: [witnessed] },
        { confidentiality: ["b"], integrity: [witnessed, certified] },
        { integrity: [] },
      ]);
      run(
        {
          op: "derive",
          inputs: [slot(0), slot(1), slot(2)],
          by: { body: 1 },
        },
        inputs,
        table,
      );
      expect(inputs.minted).toEqual([{
        by: { body: 1 },
        witnesses: [witnessed],
      }]);
    });

    it("passes no witnesses where no input carries a clause", () => {
      const table = new LabelTable();
      const inputs = inputsOf(table, [{ integrity: [certified] }]);
      run(
        { op: "derive", inputs: [slot(0)], by: { body: 0 } },
        inputs,
        table,
      );
      expect(inputs.minted).toEqual([{
        by: { body: 0 },
        witnesses: undefined,
      }]);
    });
  });

  describe("select", () => {
    const template: Template = {
      op: "select",
      selector: 3,
      condition: slot(0),
      branches: [slot(1), slot(2)],
    };
    const slots: IFCLabel[] = [
      { confidentiality: ["c"] },
      { confidentiality: ["x"], integrity: [certified] },
      { confidentiality: ["y"], integrity: [certified, injectionSafe] },
    ];

    it("joins the condition with the selected branch and keeps its integrity", () => {
      const table = new LabelTable();
      const inputs = inputsOf(table, slots, { selection: () => 1 });
      const result = run(template, inputs, table).label as InternedLabel;
      expect([...result.confidentiality].sort()).toEqual(["c", "y"]);
      expect(result.integrity).toHaveLength(2);
      expect(inputs.bounds).toEqual([]);
    });

    it("returns the bound and notes it where the selection was not reported", () => {
      const table = new LabelTable();
      const inputs = inputsOf(table, slots);
      const result = run(template, inputs, table).label as InternedLabel;
      expect([...result.confidentiality].sort()).toEqual(["c", "x", "y"]);
      expect(result.integrity).toEqual([certified]);
      expect(inputs.bounds).toEqual(["select:3"]);
    });

    it("returns the condition's confidentiality alone for a neutral branch", () => {
      const table = new LabelTable();
      const inputs = inputsOf(table, slots, { selection: () => 0 });
      const result = run(
        { ...template, branches: [literal] } as Template,
        inputs,
        table,
      ).label;
      expect(result).toBe(label(table, { confidentiality: ["c"] }));
    });

    it("throws for a selection that names no branch", () => {
      const table = new LabelTable();
      const inputs = inputsOf(table, slots, { selection: () => 5 });
      expect(() => run(template, inputs, table)).toThrow(
        TemplateInstantiationError,
      );
    });
  });

  describe("pick", () => {
    const template: Template = {
      op: "pick",
      pick: 0,
      from: { collection: 0 },
      choice: slot(0),
      body: slot(1),
    };

    it("joins the choice with the chosen child", () => {
      const table = new LabelTable();
      const child = inputsOf(table, [{}, { confidentiality: ["child"] }]);
      const inputs = inputsOf(table, [{ confidentiality: ["key"] }], {
        chosen: () => ({ chosen: child }),
      });
      const result = run(template, inputs, table).label as InternedLabel;
      expect([...result.confidentiality].sort()).toEqual(["child", "key"]);
    });

    it("returns the choice's confidentiality where no child was chosen", () => {
      const table = new LabelTable();
      const inputs = inputsOf(table, [{ confidentiality: ["key"] }], {
        chosen: () => ({ chosen: undefined }),
      });
      expect(run(template, inputs, table).label).toBe(
        label(table, { confidentiality: ["key"] }),
      );
    });

    it("returns the bound over every child where the choice was not reported", () => {
      const table = new LabelTable();
      const children: ElementInputs = {
        groups: ["p", "q"].map((clause) => ({
          inputs: inputsOf(table, [{}, { confidentiality: [clause] }]),
          count: 1,
        })),
      };
      const inputs = inputsOf(table, [{ confidentiality: ["key"] }], {
        children: () => children,
      });
      const result = run(template, inputs, table).label as InternedLabel;
      expect([...result.confidentiality].sort()).toEqual(["key", "p", "q"]);
      expect(inputs.bounds).toEqual(["pick:0"]);
    });
  });

  describe("fold", () => {
    const template: Template = { op: "fold", collection: 0, body: slot(0) };

    it("joins the membership with every group and mints the pattern atom", () => {
      const table = new LabelTable();
      const inputs = inputsOf(table, [], {
        membership: () => table.intern({ confidentiality: ["m"] }),
        elements: () => ({
          groups: [
            {
              inputs: inputsOf(table, [{
                confidentiality: ["e1"],
                integrity: [certified],
              }]),
              count: 3,
            },
            {
              inputs: inputsOf(table, [{
                confidentiality: ["e2"],
                integrity: [certified],
              }]),
              count: 1,
            },
            {
              inputs: inputsOf(table, [{ confidentiality: ["gone"] }]),
              count: 0,
            },
          ],
        }),
      });
      const { label: result, work } = run(template, inputs, table);
      const folded = result as InternedLabel;
      expect([...folded.confidentiality].sort()).toEqual(["e1", "e2", "m"]);
      expect(folded.integrity).toContainEqual(certified);
      expect(folded.integrity).toContainEqual(bodyAtom(expression));
      // The fold itself, and one body per group that holds an element.
      expect(work.instantiations).toBe(3);
    });

    it("instantiates the body once for uniform elements", () => {
      const table = new LabelTable();
      const inputs = inputsOf(table, [], {
        elements: () => ({
          uniform: inputsOf(table, [{ confidentiality: ["each"] }]),
        }),
      });
      const { label: result, work } = run(template, inputs, table);
      expect((result as InternedLabel).confidentiality).toEqual(["each"]);
      expect(work.instantiations).toBe(2);
    });

    it("throws for uniform elements under a body that depends on a value", () => {
      const table = new LabelTable();
      const inputs = inputsOf(table, [], {
        elements: () => ({ uniform: inputsOf(table, [{}]) }),
      });
      expect(() =>
        run(
          {
            op: "fold",
            collection: 0,
            body: {
              op: "select",
              selector: 0,
              condition: slot(0),
              branches: [slot(0)],
            },
          },
          inputs,
          table,
        )
      ).toThrow(TemplateInstantiationError);
    });

    it("covers every group and notes the bound for a fold with through", () => {
      const table = new LabelTable();
      const inputs = inputsOf(table, [], {
        selection: () => 0,
        elements: () => ({
          groups: ["a", "b"].map((clause) => ({
            inputs: inputsOf(table, [{ confidentiality: [clause] }]),
            count: 1,
          })),
        }),
      });
      const result = run(
        { ...template, through: 4 } as Template,
        inputs,
        table,
      ).label as InternedLabel;
      expect([...result.confidentiality].sort()).toEqual(["a", "b"]);
      expect(inputs.bounds).toEqual(["fold:4"]);
    });

    it("counts the same work for one changed element among 10 and among 1,000", () => {
      // An array of references whose elements fall into two groups by label:
      // the group form carries one entry per group and its count, so the
      // instantiation does not depend on how many elements share a group.
      const countsFor = (size: number) => {
        const table = new LabelTable();
        const groups = (changed: number) => [
          {
            inputs: inputsOf(table, [{ confidentiality: ["common"] }]),
            count: size - changed,
          },
          {
            inputs: inputsOf(table, [{ confidentiality: ["changed"] }]),
            count: changed,
          },
        ];
        const before = inputsOf(table, [], {
          elements: () => ({ groups: groups(0) }),
        });
        run(template, before, table);
        const after = inputsOf(table, [], {
          elements: () => ({ groups: groups(1) }),
        });
        return run(template, after, table).work;
      };
      expect(countsFor(1000)).toEqual(countsFor(10));
    });
  });

  describe("output, shared and dynamic", () => {
    it("returns the labels the inputs give for them", () => {
      const table = new LabelTable();
      const out = table.intern({ confidentiality: ["out"] });
      const shared = table.intern({ confidentiality: ["shared"] });
      const dynamic = table.intern({ confidentiality: ["dyn"] });
      const inputs = inputsOf(table, [], {
        outputLabel: () => out,
        sharedLabel: () => shared,
        dynamicLabel: () => dynamic,
      });
      expect(run({ op: "output", output: 0 }, inputs, table).label).toBe(out);
      expect(run({ op: "shared", template: 0 }, inputs, table).label).toBe(
        shared,
      );
      expect(run({ op: "dynamic", reads: 0 }, inputs, table).label).toBe(
        dynamic,
      );
    });
  });
});

describe("LabelTable", () => {
  describe("instance members", () => {
    describe("trim()", () => {
      it("empties a table over its limit, keeping `empty` and the identifiers of labels interned again", () => {
        const table = new LabelTable();
        const a = table.intern({ confidentiality: ["a"] });
        table.intern({ confidentiality: ["b"] });
        table.trim(10);
        expect(table.size).toBe(3);
        table.trim(2);
        expect(table.size).toBe(1);
        expect(table.intern({}).id).toBe(table.empty.id);
        expect(table.intern({ confidentiality: ["a"] }).id).toBe(a.id);
        expect(
          table.combine([table.intern({ confidentiality: ["a"] })]).label.id,
        )
          .toBe(a.id);
      });
    });

    describe("intern()", () => {
      it("returns one object for labels equal up to order and repetition", () => {
        const table = new LabelTable();
        expect(table.intern({
          confidentiality: ["a", "b", "a"],
          integrity: [certified, injectionSafe],
        })).toBe(table.intern({
          confidentiality: ["b", "a"],
          integrity: [injectionSafe, { ...certified }],
        }));
      });
    });

    describe("combine()", () => {
      it("returns the memoized result for the same set of labels", () => {
        const table = new LabelTable();
        const a = table.intern({ confidentiality: ["a"] });
        const b = table.intern({ confidentiality: ["b"] });
        const work = emptyTemplateWork();
        const first = table.counting(work, () => table.combine([a, b]));
        const second = table.counting(work, () => table.combine([b, a, b]));
        expect(second).toBe(first);
        expect(work.memoHits).toBe(1);
      });

      it("returns the empty label with no witnesses for no part", () => {
        const table = new LabelTable();
        expect(table.combine([])).toEqual({
          label: table.empty,
          witnesses: undefined,
        });
      });
    });
  });
});
