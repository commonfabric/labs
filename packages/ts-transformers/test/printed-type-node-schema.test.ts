import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import ts from "typescript";

import { COMMONFABRIC_TYPES } from "./commonfabric-test-types.ts";
import {
  callSchemas,
  callsNamed,
  literalToValue,
  parseModule,
  patternSchemas,
} from "./transformed-ast.ts";
import { transformFiles, transformSource } from "./utils.ts";

const IMPORTS =
  `import { computed, type Default, pattern, Writable, type PerUser } from "commonfabric";
interface Box<T> { value: T; extra: string; }
`;

/** An emitted schema, read as a plain record. */
type Schema = Record<string, unknown>;

/**
 * The schemas of `c` in the first `computed()` capture and in the pattern
 * result, for a pattern returning its generic input binding `c`.
 */
async function schemasOfBinding(
  declaration: string,
  argument: string,
  read = "c",
): Promise<{ capture: unknown; result: unknown }> {
  const output = await transformSource(
    `${IMPORTS}interface Input<T> { c: ${declaration}; }
export default pattern<Input<${argument}>>(({ c }) => ({
  c,
  s: computed(() => JSON.stringify(${read})),
}));`,
    { types: COMMONFABRIC_TYPES, typeCheck: true },
  );
  const root = parseModule(output);
  const [capture] = callSchemas(root, "lift");
  return {
    capture: (capture!.properties as Schema).c,
    result: (patternSchemas(root).output.properties as Schema).c,
  };
}

/** The input and result schemas of the first `lift()` in `source`. */
async function liftSchemas(source: string): Promise<unknown[]> {
  const output = await transformSource(source, {
    types: COMMONFABRIC_TYPES,
    typeCheck: true,
  });
  const [lift] = callsNamed(parseModule(output), "lift");
  return lift!.arguments
    .filter(ts.isSatisfiesExpression)
    .map((argument) => literalToValue(argument.expression));
}

/** The schema of a `Box` whose `value` has the schema `value`. */
function box(value: unknown): Schema {
  return {
    type: "object",
    properties: { value, extra: { type: "string" } },
    required: ["value", "extra"],
  };
}

describe("printed type node schema", () => {
  describe("a generic binding whose printed type names a generic declaration", () => {
    it("reads the instantiated fields of a scoped array", async () => {
      const { capture, result } = await schemasOfBinding(
        "PerUser<Box<T>[]>",
        "number",
      );
      const scoped = {
        type: "array",
        items: box({ type: "number" }),
        scope: "user",
      };

      expect(capture).toEqual(scoped);
      expect(result).toEqual(scoped);
    });

    it("keeps a cell argument of the generic declaration", async () => {
      const { capture, result } = await schemasOfBinding(
        "PerUser<Box<T>[]>",
        "Writable<{ text: string }>",
      );
      const scoped = {
        type: "array",
        items: box({
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
          asCell: ["cell"],
        }),
        scope: "user",
      };

      expect(capture).toEqual(scoped);
      expect(result).toEqual(scoped);
    });

    it("reads the instantiated fields of an array held in a cell", async () => {
      const { capture } = await schemasOfBinding(
        "Writable<Box<T>[]>",
        "number",
        "c.get()",
      );

      expect(capture).toEqual({
        type: "array",
        items: box({ type: "number" }),
        asCell: ["readonly"],
      });
    });
  });

  describe("a printed result type that holds `any`", () => {
    it("reads an element type the emitting module does not import", async () => {
      const output = await transformFiles({
        "/lib.ts": `export interface Entry { host: string; }
export function entriesOf(): Entry[] { return []; }`,
        "/main.tsx": `import { computed, pattern } from "commonfabric";
import { entriesOf } from "./lib.ts";
export default pattern<{ n: number }>(({ n }) => ({
  view: computed(() => ({ entries: entriesOf(), extra: n as any })),
}));`,
      }, { types: COMMONFABRIC_TYPES, typeCheck: true });
      const [, result] = callSchemas(parseModule(output["/main.tsx"]!), "lift");

      expect(result).toEqual({
        type: "object",
        properties: {
          entries: { type: "array", items: { $ref: "#/$defs/Entry" } },
          extra: true,
        },
        required: ["entries", "extra"],
        $defs: {
          Entry: {
            type: "object",
            properties: { host: { type: "string" } },
            required: ["host"],
          },
        },
      });
    });
  });

  describe("a printed pattern result type that holds `any`", () => {
    it("reads an element type the emitting module does not import", async () => {
      const output = await transformFiles({
        "/lib.ts": `export interface Entry { host: string; }
export function entriesOf(): Entry[] { return []; }`,
        "/main.tsx": `import { pattern } from "commonfabric";
import { entriesOf } from "./lib.ts";
export default pattern<{ n: number }>(({ n }) => ({
  entries: entriesOf(),
  extra: n as any,
}));`,
      }, { types: COMMONFABRIC_TYPES, typeCheck: true });

      expect(patternSchemas(parseModule(output["/main.tsx"]!)).output).toEqual({
        type: "object",
        properties: {
          entries: { type: "array", items: { $ref: "#/$defs/Entry" } },
          extra: true,
        },
        required: ["entries", "extra"],
        $defs: {
          Entry: {
            type: "object",
            properties: { host: { type: "string" } },
            required: ["host"],
          },
        },
      });
    });
  });

  describe("a type the checker will not print", () => {
    it("reads an array of cells with an empty default by its type", async () => {
      const [, result] = await liftSchemas(
        `${IMPORTS}interface Item { title: string; attachments: Writable<any>[] | Default<[]>; }
interface Input { item: Item; }
export default pattern<Input>(({ item }) => {
  const attachments = computed(() => item.attachments ?? []);
  return { count: computed(() => attachments.length) };
});`,
      );

      expect(result).toEqual({
        type: "array",
        items: { asCell: ["cell"] },
        default: [],
      });
    });
  });

  describe("a printed result type that holds CFC labels", () => {
    const policy = {
      type: "https://commonfabric.org/cfc/atom/Policy",
      policyRefKind: "module",
      moduleIdentity: "sha256:rules",
      symbol: "rules",
    };

    /** The labels of `a` in the result of a pattern that returns its input. */
    async function resultLabels(
      declarations: string,
      a: string,
    ): Promise<unknown> {
      const files = await transformFiles({
        "/rules.ts": `/// <cts-enable />
import { cfcPattern, exchangeRule, exchangeRules, THIS_POLICY, v } from "commonfabric/cfc";
export const release = exchangeRule({
  appliesTo: THIS_POLICY,
  pre: { integrity: [cfcPattern.hasRole(v("user"), THIS_POLICY.subject, "reader")] },
  post: { addAlternatives: [cfcPattern.user(v("user"))] },
});
export const rules = exchangeRules([release]);`,
        "/other.ts": `export type AnyOf<T> = { label: "ordinary choice" };`,
        "/main.tsx": `/// <cts-enable />
import { AnyOf, Cfc, Confidential, pattern, PolicyOf } from "commonfabric";
import * as other from "./other.ts";
import { rules } from "./rules.ts";
${declarations}
export default pattern<{ a: ${a} }>(({ a }) => ({ a }));`,
      }, {
        types: COMMONFABRIC_TYPES,
        typeCheck: true,
        moduleIdentities: new Map([["/rules.ts", "sha256:rules"]]),
      });
      const output = patternSchemas(parseModule(files["/main.tsx"]!)).output;
      return ((output.properties as Schema).a as Schema).ifc;
    }

    it("reads the binding a payload's member names", async () => {
      expect(
        await resultLabels(
          "",
          "Cfc<string, { confidentiality: [PolicyOf<typeof rules>] }>",
        ),
      ).toMatchObject({ confidentiality: [policy] });
    });

    it("reads the binding a payload interface's member names", async () => {
      expect(
        await resultLabels(
          "interface Meta { confidentiality: [PolicyOf<typeof rules>] }",
          "Cfc<string, Meta>",
        ),
      ).toMatchObject({ confidentiality: [policy] });
    });

    it("reads a generic payload's member as its instantiation", async () => {
      expect(
        await resultLabels(
          "type Meta<L> = { confidentiality: [L] };",
          `Cfc<string, Meta<"secret">>`,
        ),
      ).toEqual({ confidentiality: ["secret"] });
    });

    it("reads `AnyOf` passed to a generic alias by its brand", async () => {
      expect(
        await resultLabels("", `Confidential<string, [AnyOf<["reader"]>]>`),
      ).toEqual({ confidentiality: [{ anyOf: ["reader"] }] });
    });

    it("reads an authored type named `AnyOf` as its own", async () => {
      expect(
        await resultLabels(
          "",
          `Confidential<string, [other.AnyOf<["reader"]>]>`,
        ),
      ).toEqual({ confidentiality: [{ label: "ordinary choice" }] });
    });
  });
});
