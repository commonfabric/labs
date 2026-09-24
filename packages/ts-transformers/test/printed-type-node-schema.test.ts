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

    /**
     * The labels of `a` in the argument and the result of a pattern that
     * returns its input.
     */
    async function labels(
      declarations: string,
      a: string,
    ): Promise<{ input: unknown; output: unknown }> {
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
      const { input, output } = patternSchemas(
        parseModule(files["/main.tsx"]!),
      );
      const labelsOf = (schema: Schema) =>
        ((schema.properties as Schema | undefined)?.a as Schema | undefined)
          ?.ifc;
      return { input: labelsOf(input), output: labelsOf(output) };
    }

    /** The labels of `a` in the result of a pattern that returns its input. */
    async function resultLabels(
      declarations: string,
      a: string,
    ): Promise<unknown> {
      return (await labels(declarations, a)).output;
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

    it("reads an optional member's annotation", async () => {
      const expected = { confidentiality: ["reader"] };
      expect(
        await labels("", `Cfc<string, { confidentiality?: ["reader"] }>`),
      ).toEqual({ input: expected, output: expected });
    });

    it("reads an optional member of a generic declaration from its type", async () => {
      const expected = { confidentiality: ["reader"] };
      expect(
        await labels(
          "interface Meta<X> { confidentiality?: X }",
          `Cfc<string, Meta<["reader"]>>`,
        ),
      ).toEqual({ input: expected, output: expected });
    });

    it("reads the binding an optional member names", async () => {
      const { input, output } = await labels(
        "",
        "Cfc<string, { confidentiality?: [PolicyOf<typeof rules>] }>",
      );
      expect(input).toMatchObject({ confidentiality: [policy] });
      expect(output).toMatchObject({ confidentiality: [policy] });
    });

    it("reads `AnyOf` with no alternatives from its type", async () => {
      // A generic interface's member is read from its instantiated type, the
      // brand's payload here an empty tuple. (A result holding an empty tuple
      // is not printed, so the argument's labels are the ones read.)
      const { input } = await labels(
        "interface Meta<X extends readonly unknown[]> { confidentiality: [AnyOf<X>] }",
        "Cfc<string, Meta<readonly []>>",
      );
      expect(input).toEqual({ confidentiality: [{ anyOf: [] }] });
    });

    describe("a generic CFC alias read from its type", () => {
      // Read from its type, a chain has no argument nodes; its payload is read
      // from the type it instantiates, which holds `T`'s argument wherever the
      // declaration wrote `T`.
      const labelled = (
        payload: Schema,
        ifc: Schema = { confidentiality: ["secret"], integrity: ["trusted"] },
      ) => ({ ...payload, ifc });
      const strings = { type: "array", items: { type: "string" } };
      const value = {
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
      };
      for (
        const [spelling, declaration, a, expected] of [
          [
            "a bare parameter",
            'type Sec<T> = Confidential<T, ["secret"]>;',
            `Integrity<Sec<string>, ["trusted"]>`,
            labelled({ type: "string" }),
          ],
          [
            "an array of it",
            'type Sec<T> = Confidential<T[], ["secret"]>;',
            `Integrity<Sec<string>, ["trusted"]>`,
            labelled(strings),
          ],
          [
            "an object holding it",
            'type Sec<T> = Confidential<{ value: T }, ["secret"]>;',
            `Integrity<Sec<string>, ["trusted"]>`,
            labelled(value),
          ],
          [
            "a tuple of it",
            'type Sec<T> = Confidential<[T], ["secret"]>;',
            `Integrity<Sec<string>, ["trusted"]>`,
            labelled(strings),
          ],
          [
            "a mapped record of it",
            `type Sec<T> = Confidential<Record<"value", T>, ["secret"]>;`,
            `Integrity<Sec<string>, ["trusted"]>`,
            labelled(value),
          ],
          [
            "an intersection holding it",
            `type Sec<T> = Confidential<{ value: T } & { tag: string }, ["secret"]>;`,
            `Integrity<Sec<string>, ["trusted"]>`,
            labelled({
              type: "object",
              properties: {
                value: { type: "string" },
                tag: { type: "string" },
              },
              required: ["value", "tag"],
            }),
          ],
          [
            "a discriminated union holding it",
            `type Sec<T> = Confidential<{ kind: "a"; value: T } | { kind: "b"; count: number }, ["secret"]>;`,
            `Integrity<Sec<string>, ["trusted"]>`,
            labelled({
              anyOf: [
                {
                  type: "object",
                  properties: {
                    kind: { type: "string", enum: ["a"] },
                    value: { type: "string" },
                  },
                  required: ["kind", "value"],
                },
                {
                  type: "object",
                  properties: {
                    kind: { type: "string", enum: ["b"] },
                    count: { type: "number" },
                  },
                  required: ["kind", "count"],
                },
              ],
            }),
          ],
          [
            "a union holding it",
            'type Sec<T> = Confidential<T | number, ["secret"]>;',
            `Integrity<Sec<string>, ["trusted"]>`,
            labelled({ anyOf: [{ type: "string" }, { type: "number" }] }),
          ],
          [
            "a union of an array and an object holding it",
            'type Sec<T> = Confidential<T[] | { value: T }, ["secret"]>;',
            `Integrity<Sec<string>, ["trusted"]>`,
            labelled({ anyOf: [strings, value] }),
          ],
          [
            "a union holding another generic alias over a union",
            `type Inner<U> = Confidential<{ value: U } | number, ["inner"]>;
type Sec<T> = Confidential<Inner<T> | boolean, ["secret"]>;`,
            `Integrity<Sec<string>, ["trusted"]>`,
            labelled({
              anyOf: [
                {
                  anyOf: [value, { type: "number" }],
                  ifc: { confidentiality: ["inner"] },
                },
                { type: "boolean" },
              ],
            }),
          ],
          [
            "another generic alias holding it",
            `type Sec<T> = Confidential<Integrity<T[], ["inner"]>, ["secret"]>;`,
            `MaxConfidentiality<Sec<string>, ["top"]>`,
            labelled(strings, {
              integrity: ["inner"],
              confidentiality: ["secret"],
              maxConfidentiality: ["top"],
            }),
          ],
        ] as const
      ) {
        it(`keeps a payload that is ${spelling}`, async () => {
          const files = await transformFiles({
            "/main.tsx": `/// <cts-enable />
import { Confidential, Integrity, MaxConfidentiality, pattern } from "commonfabric";
${declaration}
export default pattern<{ a: ${a} }>(({ a }) => ({ a }));`,
          }, { types: COMMONFABRIC_TYPES, typeCheck: true });
          const { input, output } = patternSchemas(
            parseModule(files["/main.tsx"]!),
          );
          expect((input.properties as Schema).a).toEqual(expected);
          expect((output.properties as Schema).a).toEqual(expected);
        });
      }

      for (const order of [["a", "b"], ["b", "a"]] as const) {
        it(
          `reads each instantiation of a recursive payload apart, ${
            order.join(" before ")
          }`,
          async () => {
            // `Link<T>` is one declared type read under two bindings, so each
            // binding stores its own recursive definition.
            const fields = {
              a: `a: Integrity<Sec<string>, ["trusted"]>`,
              b: `b: Integrity<Sec<number>, ["trusted"]>`,
            };
            const files = await transformFiles({
              "/main.tsx": `/// <cts-enable />
import { Confidential, Integrity, pattern } from "commonfabric";
interface Link<U> { value: U; next?: Link<U> }
type Sec<T> = Confidential<Link<T> & { tag: string }, ["secret"]>;
export default pattern<{ ${fields[order[0]]}; ${fields[order[1]]} }>(
  ({ a, b }) => ({ ${order[0]}, ${order[1]} }),
);`,
            }, { types: COMMONFABRIC_TYPES, typeCheck: true });
            const { output } = patternSchemas(parseModule(files["/main.tsx"]!));
            const defs = output.$defs as Record<string, Schema>;
            const valueTypes = (field: "a" | "b") => {
              const link =
                (output.properties as Record<string, Schema>)[field]!;
              const properties = link.properties as Record<string, Schema>;
              const next = (properties.next!.anyOf as Schema[]).find((arm) =>
                arm.$ref
              )!;
              const def = defs[(next.$ref as string).split("/").pop()!]!;
              const defProperties = def.properties as Record<string, Schema>;
              const defNext = (defProperties.next!.anyOf as Schema[]).find((
                arm,
              ) => arm.$ref)!;
              return {
                value: properties.value,
                recursive: defProperties.value,
                self: defNext.$ref === next.$ref,
              };
            };
            expect(valueTypes("a")).toEqual({
              value: { type: "string" },
              recursive: { type: "string" },
              self: true,
            });
            expect(valueTypes("b")).toEqual({
              value: { type: "number" },
              recursive: { type: "number" },
              self: true,
            });
          },
        );
      }
    });

    describe("an object label with a member the syntax reader cannot name", () => {
      const user = {
        type: "https://commonfabric.org/cfc/atom/User",
        subject: "did:key:alice",
      };
      for (
        const [spelling, declarations, a, expected] of [
          [
            "a computed key",
            `const key = "subject" as const;
interface Meta { confidentiality: [{ type: "https://commonfabric.org/cfc/atom/User"; [key]: "did:key:alice" }] }`,
            "Cfc<string, Meta>",
            user,
          ],
          [
            "an accessor",
            `interface Meta { confidentiality: [{ type: "https://commonfabric.org/cfc/atom/User"; get subject(): "did:key:alice" }] }`,
            "Cfc<string, Meta>",
            user,
          ],
          [
            "an empty name",
            `interface Meta { confidentiality: [{ type: "t"; "": "empty" }] }`,
            "Cfc<string, Meta>",
            { type: "t", "": "empty" },
          ],
          [
            "a computed key written in place",
            `const key = "subject" as const;`,
            `Cfc<string, { confidentiality: [{ type: "https://commonfabric.org/cfc/atom/User"; [key]: "did:key:alice" }] }>`,
            user,
          ],
        ] as const
      ) {
        it(`keeps every member beside ${spelling}`, async () => {
          const labelled = { confidentiality: [expected] };
          expect(await labels(declarations, a)).toEqual({
            input: labelled,
            output: labelled,
          });
        });
      }
    });

    it("reads the binding under a computed key", async () => {
      // The syntax reader leaves a computed key to the type, whose member is
      // read at its annotation, binding and all.
      const { input, output } = await labels(
        `const k = "confidentiality" as const;`,
        "Cfc<string, { [k]: [PolicyOf<typeof rules>] }>",
      );
      expect(input).toMatchObject({ confidentiality: [policy] });
      expect(output).toMatchObject({ confidentiality: [policy] });
    });

    describe("an annotation whose syntax the label reader does not evaluate", () => {
      for (
        const [spelling, declarations, expected] of [
          [
            "a conditional alias",
            `type Labels<T> = T extends string ? ["reader"] : ["admin"];
interface Meta { confidentiality: Labels<string> }`,
            ["reader"],
          ],
          [
            "a mapped alias",
            `type Labels<T> = { [K in keyof T]: T[K] };
interface Meta { confidentiality: Labels<["reader"]> }`,
            ["reader"],
          ],
          [
            "a named tuple member",
            `interface Meta { confidentiality: [reader: "reader"] }`,
            ["reader"],
          ],
          [
            "a tuple spread",
            `interface Meta { confidentiality: [...["reader", "admin"]] }`,
            ["reader", "admin"],
          ],
          [
            "an alias's default argument",
            `type Labels<T = "reader"> = [T];
interface Meta { confidentiality: Labels }`,
            ["reader"],
          ],
        ] as const
      ) {
        it(`reads ${spelling} from the type it denotes`, async () => {
          const labelled = { confidentiality: expected };
          expect(await labels(declarations, "Cfc<string, Meta>")).toEqual({
            input: labelled,
            output: labelled,
          });
        });
      }
    });
  });
});
