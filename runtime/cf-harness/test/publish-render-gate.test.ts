import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { JSONSchema } from "@commonfabric/api";
import { MockDoc } from "@commonfabric/html/mock-doc";
import {
  classifyRenderedHtml,
  cutTreeToNodeBudget,
  PATTERN_PUBLICATION_MESSAGES,
  renderPatternUiToHtml,
  syntheticArgument,
} from "../src/pattern-index/publish-render-gate.ts";

/**
 * The argument schema of the sortable table that is live in the index and
 * renders every cell as `[object Object]`, copied from what `getPattern`
 * answers for it. The `default: []` on both optional arrays is the trap: a
 * generator that honors defaults builds a table with no rows and no columns,
 * which renders cleanly and publishes the defect.
 */
const LIVE_SORTABLE_TABLE_SCHEMA = {
  type: "object",
  properties: {
    rows: {
      anyOf: [
        { type: "array", items: { $ref: "#/$defs/Row" } },
        { type: "undefined" },
      ],
      default: [],
    },
    columns: {
      anyOf: [
        { type: "array", items: { type: "string" } },
        { type: "undefined" },
      ],
      default: [],
    },
  },
  $defs: {
    Row: {
      type: "object",
      properties: {},
      additionalProperties: { type: "unknown" },
    },
  },
} as const;

describe("publish-render-gate", () => {
  describe("syntheticArgument()", () => {
    it("gives a pattern that declares no arguments the empty instance, in full", () => {
      expect(syntheticArgument(false)).toEqual({ value: {}, complete: true });
    });

    it("reports a schema declaring no shape as an instance it could not complete", () => {
      // `{}` is a legal instance of `true`, and says nothing about what would
      // have exercised the pattern — so an empty render under it is evidence
      // about the instance rather than about the pattern.
      expect(syntheticArgument(true)).toEqual({ value: {}, complete: false });
      expect(syntheticArgument(undefined)).toEqual({
        value: {},
        complete: false,
      });
    });

    it("fills every declared property, required or not", () => {
      const { value } = syntheticArgument({
        type: "object",
        properties: {
          required: { type: "string" },
          optional: { type: "integer" },
          flag: { type: "boolean" },
        },
        required: ["required"],
      });
      expect(value).toEqual({
        required: "alpha",
        optional: 2,
        flag: true,
      });
    });

    it("gives an array more than one item", () => {
      // One item cannot distinguish a renderer that maps from one that
      // renders only its first element.
      const { value } = syntheticArgument({
        type: "object",
        properties: { names: { type: "array", items: { type: "string" } } },
      });
      expect((value as { names: string[] }).names).toHaveLength(2);
    });

    it("takes the arm of an optional union that supplies the field", () => {
      const { value } = syntheticArgument({
        type: "object",
        properties: {
          maybe: {
            anyOf: [{ type: "undefined" }, { type: "string" }],
          },
        },
      });
      expect((value as { maybe: unknown }).maybe).toBe("alpha");
    });

    it("ignores `default`, which is the least exercising instance a schema admits", () => {
      const { value } = syntheticArgument(LIVE_SORTABLE_TABLE_SCHEMA);
      const argument = value as { rows: unknown[]; columns: string[] };
      expect(argument.rows).toHaveLength(2);
      expect(argument.columns).toHaveLength(2);
      // The live defect needs a row to index and a column to index it by,
      // and the column has to name a key the row actually has. Under
      // `default: []` there would be neither row nor column; drawn from two
      // vocabularies the lookup would find nothing and the table would
      // render two empty cells and pass.
      expect(Object.keys(argument.rows[0] as object)).toEqual(
        argument.columns,
      );
    });

    it("reports the live sortable table's instance as partial", () => {
      // Its unions, its open `Row` and its `unknown` values are each a choice
      // the schema left open and the generator made.
      expect(syntheticArgument(LIVE_SORTABLE_TABLE_SCHEMA).complete).toBe(
        false,
      );
    });

    it("stops at a cyclic $ref rather than following it", () => {
      const { value, complete } = syntheticArgument({
        type: "object",
        properties: { node: { $ref: "#/$defs/Node" } },
        $defs: {
          Node: {
            type: "object",
            properties: {
              name: { type: "string" },
              child: { $ref: "#/$defs/Node" },
            },
          },
        },
      });
      expect(complete).toBe(false);
      expect(value).toEqual({ node: { name: "alpha" } });
    });

    it("takes a const and the first member of an enum", () => {
      const { value } = syntheticArgument({
        type: "object",
        properties: {
          kind: { const: "fixed" },
          mode: { enum: ["first", "second"] },
        },
      });
      expect(value).toEqual({ kind: "fixed", mode: "first" });
    });
  });

  describe("syntheticArgument() bounds", () => {
    // Every arm below reports the instance as incomplete. That is the whole
    // point of the flag: an empty render under a bounded instance is evidence
    // about the bound, not about the pattern, and the gate must be able to
    // tell those apart.

    it("stops at the depth bound and says so", () => {
      let schema: JSONSchema = { type: "string" };
      for (let depth = 0; depth < 12; depth++) {
        schema = { type: "object", properties: { next: schema } };
      }
      const { value, complete } = syntheticArgument(schema);
      expect(complete).toBe(false);
      // It built what it could reach before the stop rather than nothing.
      expect(value).toHaveProperty("next");
    });

    it("stops at the node budget and says so", () => {
      // Wide rather than deep: 400 properties of 4 fields each outruns the
      // 256-node budget without ever approaching the depth bound.
      const properties: Record<string, JSONSchema> = {};
      for (let i = 0; i < 400; i++) {
        properties[`p${i}`] = {
          type: "object",
          properties: {
            a: { type: "string" },
            b: { type: "string" },
            c: { type: "string" },
            d: { type: "string" },
          },
        };
      }
      expect(syntheticArgument({ type: "object", properties }).complete).toBe(
        false,
      );
    });

    it("reports a property the schema forbids outright", () => {
      const { value, complete } = syntheticArgument({
        type: "object",
        properties: { nothing: false, name: { type: "string" } },
      });
      expect(complete).toBe(false);
      // `name` is the second declared property, so it takes the second name
      // in the vocabulary — the slot is positional, which is what makes an
      // open bag's keys line up with a sibling list of strings.
      expect(value).toEqual({ name: "beta" });
    });

    it("reports a schema node that is not a schema", () => {
      const { value, complete } = syntheticArgument({
        type: "object",
        properties: {
          nonsense: 42 as unknown as JSONSchema,
          named: { type: "string" },
        },
      });
      expect(complete).toBe(false);
      expect(value).toEqual({ named: "beta" });
    });

    it("reports a $ref it cannot resolve", () => {
      for (
        const ref of ["#/definitions/Row", "#/$defs/Missing", "external.json"]
      ) {
        const { value, complete } = syntheticArgument({
          type: "object",
          properties: { row: { $ref: ref } },
          $defs: { Row: { type: "string" } },
        });
        expect(complete).toBe(false);
        expect(value).toEqual({});
      }
    });

    it("reports an array that does not say what it holds", () => {
      const { value, complete } = syntheticArgument({
        type: "object",
        properties: { items: { type: "array" } },
      });
      expect(complete).toBe(false);
      expect(value).toEqual({ items: [] });
    });

    it("reports a position that constrains nothing", () => {
      const { value, complete } = syntheticArgument({
        type: "object",
        properties: { anything: {}, named: { type: "string" } },
      });
      expect(complete).toBe(false);
      expect(value).toEqual({ named: "beta" });
    });

    it("fills a declared null", () => {
      expect(
        syntheticArgument({
          type: "object",
          properties: { nothing: { type: "null" } },
        }).value,
      ).toEqual({ nothing: null });
    });

    it("leaves a declared property alone when an open bag would take its name", () => {
      // `alpha` is the first synthetic name. The declared number must survive:
      // a synthetic string written over it is the wrong type for whatever
      // reads it, and would fail a pattern that is behaving correctly.
      const { value } = syntheticArgument({
        type: "object",
        properties: {
          row: {
            type: "object",
            properties: { alpha: { type: "integer" } },
            additionalProperties: { type: "string" },
          },
        },
      });
      const row = (value as { row: Record<string, unknown> }).row;
      expect(row.alpha).toBe(1);
      expect(row.beta).toBe("beta");
    });
  });

  describe("cutTreeToNodeBudget()", () => {
    const treeOf = (count: number) => {
      const mock = new MockDoc(
        `<!DOCTYPE html><html><body><div id="root">${
          "<p><span>x</span></p>".repeat(count)
        }</div></body></html>`,
      );
      const container = mock.document.getElementById("root");
      if (container === null) throw new Error("no container");
      return container;
    };

    it("leaves a tree inside the budget untouched", () => {
      const container = treeOf(3);
      expect(cutTreeToNodeBudget(container, 100)).toBe(false);
      expect(container.innerHTML.match(/<p>/g)).toHaveLength(3);
    });

    it("bounds a single child that is itself oversized", () => {
      // The adversarial shape, and the one the wide tree above does not
      // reach: one top-level child with a hundred descendants. Removing
      // whole children after the budget is crossed never touches the child
      // that crossed it, so the bound reported true and retained everything.
      const mock = new MockDoc(
        `<!DOCTYPE html><html><body><div id="root"><section>${
          "<span>x</span>".repeat(100)
        }</section></div></body></html>`,
      );
      const container = mock.document.getElementById("root");
      if (container === null) throw new Error("no container");
      expect(cutTreeToNodeBudget(container, 6)).toBe(true);
      const kept = (container.innerHTML.match(/<span>/g) ?? []).length;
      expect(kept).toBeLessThanOrEqual(6);
    });

    it("bounds every shape, not the one the author thought of", () => {
      // The wide test below passed while a deep child retained a hundred
      // nodes, so the shapes are enumerated rather than sampled: a chain, a
      // single oversized child, a pyramid, and the two degenerate cases.
      const shapes: Record<string, string> = {
        chain: "<i>".repeat(200) + "x" + "</i>".repeat(200),
        oneWideChild: `<section>${"<span>x</span>".repeat(100)}</section>`,
        pyramid: `<a>${`<b>${"<c>y</c>".repeat(50)}</b>`.repeat(5)}</a>`,
        empty: "",
        single: "<p>p</p>",
        // Position matters when the walk is order-sensitive, and "every
        // child fits but the total does not" is the case a per-child check
        // passes and a shared budget catches.
        oversizedLast: `<p>a</p><p>b</p><section>${
          "<span>x</span>".repeat(100)
        }</section>`,
        eachUnderTotalOver: "<p>a</p>".repeat(50),
        twoOversized: `<section>${"<span>x</span>".repeat(60)}</section>` +
          `<section>${"<span>x</span>".repeat(60)}</section>`,
        textOnly: "just text with no elements at all",
      };
      for (const [name, html] of Object.entries(shapes)) {
        const mock = new MockDoc(
          `<!DOCTYPE html><html><body><div id="root">${html}</div></body></html>`,
        );
        const container = mock.document.getElementById("root");
        if (container === null) throw new Error("no container");
        cutTreeToNodeBudget(container, 6);
        const tags = (container.innerHTML.match(/<[a-z]/g) ?? []).length;
        expect(`${name}:${tags <= 6}`).toBe(`${name}:true`);
      }
    });

    it("cuts a tree past the budget and says it did", () => {
      // Serializing first and truncating after would build the whole string;
      // what a pattern renders is bounded by nothing but the pattern.
      const container = treeOf(20);
      expect(cutTreeToNodeBudget(container, 6)).toBe(true);
      const kept = container.innerHTML.match(/<p>/g) ?? [];
      expect(kept.length).toBeGreaterThan(0);
      expect(kept.length).toBeLessThan(20);
    });
  });

  describe("renderPatternUiToHtml() error channel", () => {
    it("collects what the reconciler reports", async () => {
      // Nothing a pattern can express reaches this channel — see the doc
      // comment — so the mount is supplied to exercise it. Without this the
      // arm that reads `errors` would be a check nobody had seen run.
      const cell = {
        asSchema: () => ({
          sync: () => Promise.resolve(),
          get: () => ({ $UI: { type: "vnode" } }),
          key: () => ({}),
        }),
      } as unknown as Parameters<typeof renderPatternUiToHtml>[0];
      const rendered = await renderPatternUiToHtml(
        cell,
        () => Promise.resolve(),
        ((_container: unknown, _vdom: unknown, options: {
          onError?: (error: Error) => void;
        }) => {
          options.onError?.(new Error("reconciler complained"));
          return { flush: () => {}, cancel: () => {} };
        }) as unknown as Parameters<typeof renderPatternUiToHtml>[2],
      );
      expect(rendered?.errors).toEqual(["reconciler complained"]);
    });

    it("reports no $UI when the result declares none", async () => {
      const cell = {
        asSchema: () => ({
          sync: () => Promise.resolve(),
          get: () => ({}),
        }),
      } as unknown as Parameters<typeof renderPatternUiToHtml>[0];
      expect(await renderPatternUiToHtml(cell, () => Promise.resolve()))
        .toBeUndefined();
    });
  });

  describe("classifyRenderedHtml()", () => {
    it("refuses output carrying a default-toString marker", () => {
      expect(classifyRenderedHtml("<td>[object Object]</td>")).toBe(
        "ui-default-tostring",
      );
    });

    it("refuses the whole default-toString family, not one spelling of it", () => {
      // The defect is a value stringified by `Object.prototype.toString`;
      // which internal class it names is incidental.
      expect(classifyRenderedHtml("<p>[object Map]</p>")).toBe(
        "ui-default-tostring",
      );
      expect(classifyRenderedHtml("<p>[object Function]</p>")).toBe(
        "ui-default-tostring",
      );
    });

    it("does not read prose that merely resembles the marker as one", () => {
      expect(classifyRenderedHtml("<p>[object oriented]</p>")).toBe(
        "ui-rendered",
      );
    });

    it("names an output whose tree carries nothing at all", () => {
      expect(classifyRenderedHtml("   \n  ")).toBe("ui-rendered-empty");
      // What an empty fragment renders as, which is not literally empty.
      expect(classifyRenderedHtml("<cf-fragment></cf-fragment>")).toBe(
        "ui-rendered-empty",
      );
    });

    it("reads a form of labelled fields as rendered, though it carries no text", () => {
      // `email.tsx` in the seed corpus, verbatim. Weighing text alone hid it.
      expect(
        classifyRenderedHtml(
          '<cf-vstack gap="3"><cf-field label="Email"><cf-input value="[binding]" placeholder="email@example.com" type="email"></cf-input></cf-field></cf-vstack>',
        ),
      ).toBe("ui-rendered");
    });

    it("reports a render the reconciler complained about as no verdict", () => {
      expect(classifyRenderedHtml("<p>half a tree</p>", ["reconciler said no"]))
        .toBe("probe-failed");
    });

    it("lets a marker outrank a complaint", () => {
      // A marker is positive evidence about what the pattern does, however
      // incomplete the render that surfaced it.
      expect(
        classifyRenderedHtml("<td>[object Object]</td>", [
          "reconciler said no",
        ]),
      ).toBe("ui-default-tostring");
    });

    it("passes output that rendered content", () => {
      expect(classifyRenderedHtml("<table><tr><td>Avery</td></tr></table>"))
        .toBe("ui-rendered");
    });
  });

  describe("PATTERN_PUBLICATION_MESSAGES", () => {
    it("claims a checkable property and not that the component works", () => {
      const passed = PATTERN_PUBLICATION_MESSAGES["ui-rendered"];
      expect(passed).toContain("That is all this certifies");
      expect(passed).toContain("not that the component works");
    });

    it("does not promise a copy of the render it does not keep", () => {
      // The artifact root is not a confidentiality boundary, so the gate
      // keeps no rendered output; a message promising one would send a
      // reader looking for something that is not there.
      for (const message of Object.values(PATTERN_PUBLICATION_MESSAGES)) {
        expect(message).not.toContain("retained in the run artifact");
      }
      // And does not over-claim the other way either: a pattern that reads
      // the space renders from state nothing records, so reproducibility is
      // stated for the case it holds in and denied for the case it does not.
      const withheld = PATTERN_PUBLICATION_MESSAGES["ui-default-tostring"];
      expect(withheld).toContain("not retained anywhere");
      expect(withheld).toContain("a pattern that reads the space it cannot");
    });

    it("reports every publication as queued and unconfirmed", () => {
      for (const message of Object.values(PATTERN_PUBLICATION_MESSAGES)) {
        expect(message).toMatch(/^queued for /);
        expect(message).toContain("publication is not confirmed");
      }
    });

    it("distinguishes requested search visibility from recording alone", () => {
      for (
        const reason of [
          "recorded-automatically",
          "ui-default-tostring",
          "ui-rendered-empty",
          "probe-failed",
          "superseded",
        ] as const
      ) {
        expect(PATTERN_PUBLICATION_MESSAGES[reason]).toContain(
          "without requesting search discoverability",
        );
      }
      for (const reason of ["ui-rendered", "no-ui"] as const) {
        expect(PATTERN_PUBLICATION_MESSAGES[reason]).toContain(
          "with search discoverability requested",
        );
      }
    });

    it("carries no placeholder a caller could interpolate into", () => {
      // Every message is a constant. A message with a slot in it is a message
      // someone will eventually fill from the rendered DOM.
      for (const message of Object.values(PATTERN_PUBLICATION_MESSAGES)) {
        expect(message).not.toMatch(/\$\{|%s|\{\d/);
      }
    });
  });
});
