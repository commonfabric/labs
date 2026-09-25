import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import ts from "typescript";

import { CrossStageState } from "../src/core/mod.ts";
import { COMMONFABRIC_TYPES } from "./commonfabric-test-types.ts";
import {
  callSchemas,
  callsNamed,
  collect,
  emittedSchemas,
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

/**
 * The element schema of a list `computed()` declares as `element[]`, whose
 * `profile` cell the view reads only for display, so narrowing unfolds each
 * printed element.
 */
async function narrowedElement(
  element: string,
  declarations = "",
): Promise<unknown> {
  const output = await transformSource(
    `import { type Cell, computed, pattern, type Stream, UI } from "commonfabric";
type ProfileCell = Cell<{ name?: string }>;
${declarations}
export default pattern<{ profiles: ProfileCell[] }>(({ profiles }) => {
  const participants = computed<${element}[]>(() =>
    profiles.map((profile) => ({ name: "someone", profile } as ${element}))
  );
  return {
    [UI]: <div>{participants.map((p) => <cf-profile-badge $profile={p.profile} />)}</div>,
  };
});`,
    { types: COMMONFABRIC_TYPES, typeCheck: true },
  );
  return emittedSchemas(parseModule(output))
    .map((schema) =>
      (schema.properties as Schema | undefined)?.element as Schema | undefined
    )
    .find((found) => found !== undefined);
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
    for (
      const [item, itemSchema] of [
        ["string", { type: "string" }],
        ["unknown", { type: "unknown" }],
        ["Writable<{ title: string }>", {
          type: "object",
          properties: { title: { type: "string" } },
          required: ["title"],
          asCell: ["cell"],
        }],
      ] as const
    ) {
      for (
        const resource of [
          `Default<${item}[], []>`,
          `${item}[] | Default<[]>`,
        ]
      ) {
        it(`injects the resource schema for a contextual wish of \`${resource}\``, async () => {
          const output = await transformSource(
            `import { type Default, type Writable, wish, type WishState } from "commonfabric";
export default function contextualWish() {
  const contextual: WishState<${resource}> = wish({ query: "#items" });
  return contextual;
}`,
            { types: COMMONFABRIC_TYPES, typeCheck: true },
          );
          const expected = { type: "array", items: itemSchema, default: [] };

          expect(callSchemas(parseModule(output), "wish")).toEqual([expected]);
        });
      }
    }

    for (
      const resource of ["Default<string[], []>", "string[] | Default<[]>"]
    ) {
      it(`injects the contextual \`${resource}\` schema on \`Cell.for()\``, async () => {
        const output = await transformSource(
          `import { Cell, type Default, type Writable } from "commonfabric";
export default function contextualCell() {
  const cell: Writable<${resource}> = Cell.for("items");
  return cell;
}`,
          { types: COMMONFABRIC_TYPES, typeCheck: true },
        );

        expect(callSchemas(parseModule(output), "asSchema")).toEqual([{
          type: "array",
          items: { type: "string" },
          default: [],
        }]);
      });

      it(`injects the contextual \`${resource}\` schema and user scope on \`new Writable()\``, async () => {
        const output = await transformSource(
          `import { type Default, type PerUser, Writable } from "commonfabric";
export default function contextualCell() {
  const cell: PerUser<Writable<${resource}>> = new Writable();
  return cell;
}`,
          { types: COMMONFABRIC_TYPES, typeCheck: true },
        );
        const [cell] = collect(parseModule(output), ts.isNewExpression);

        expect(cell!.arguments).toHaveLength(2);
        expect(literalToValue(cell!.arguments![1]!)).toEqual({
          type: "array",
          items: { type: "string" },
          default: [],
          scope: "user",
        });
      });
    }

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

    describe("a CFC alias whose type the checker reduced", () => {
      // `Confidential<string | null, …>` is `string & carrier` once
      // `null & carrier` is nothing, and the reduced type keeps no alias name.
      // A written reference still names the policy; a type alone has only its
      // carrier, which holds the labels but cannot spell a writer binding.
      for (
        const [spelling, declaration, a, input, output] of [
          [
            "a nullable value written directly",
            "",
            `Confidential<string | null, ["secret"]>`,
            {
              anyOf: [{ type: "string" }, { type: "null" }],
              ifc: { confidentiality: ["secret"] },
            },
            { type: "string", ifc: { confidentiality: ["secret"] } },
          ],
          [
            "a nullable object written directly",
            "",
            `Confidential<{ title: string } | null, ["secret"]>`,
            {
              anyOf: [
                {
                  type: "object",
                  properties: { title: { type: "string" } },
                  required: ["title"],
                },
                { type: "null" },
              ],
              ifc: { confidentiality: ["secret"] },
            },
            {
              type: "object",
              properties: { title: { type: "string" } },
              required: ["title"],
              ifc: { confidentiality: ["secret"] },
            },
          ],
          [
            "a nullable value's writer written directly",
            `const setName = handler<{ name: string }, { name: Writable<string | null> }>((event, { name }) => { name.set(event.name); });`,
            "WriteAuthorizedBy<string | null, typeof setName>",
            {
              anyOf: [{ type: "string" }, { type: "null" }],
              ifc: {
                writeAuthorizedBy: {
                  __ctWriterIdentityOf: {
                    file: "/main.tsx",
                    path: ["setName"],
                  },
                },
              },
            },
            { type: "string" },
          ],
          [
            "a nullable projection",
            `type P<T, Path extends readonly string[]> = ProjectionOf<T | null, Path>;`,
            `P<{ t: string }, ["x/y", "m~n"]>`,
            {
              anyOf: [
                {
                  type: "object",
                  properties: { t: { type: "string" } },
                  required: ["t"],
                },
                { type: "null" },
              ],
              ifc: { projection: { from: "/", path: "/x~1y/m~0n" } },
            },
            {
              type: "object",
              properties: { t: { type: "string" } },
              required: ["t"],
              ifc: { projection: { from: "/", path: "/x~1y/m~0n" } },
            },
          ],
          [
            "a nullable value",
            `type Sec<T> = Confidential<T | null, ["secret"]>;`,
            "Sec<string>",
            {
              anyOf: [{ type: "string" }, { type: "null" }],
              ifc: { confidentiality: ["secret"] },
            },
            { type: "string", ifc: { confidentiality: ["secret"] } },
          ],
          [
            "a nullable array in another label's payload",
            `type Sec<T> = Confidential<T[] | null, ["secret"]>;`,
            `Integrity<Sec<string>, ["trusted"]>`,
            {
              anyOf: [
                { type: "array", items: { type: "string" } },
                { type: "null" },
              ],
              ifc: { confidentiality: ["secret"], integrity: ["trusted"] },
            },
            {
              type: "array",
              items: { type: "string" },
              ifc: { confidentiality: ["secret"], integrity: ["trusted"] },
            },
          ],
        ] as const
      ) {
        it(`keeps the metadata of ${spelling}`, async () => {
          const files = await transformFiles({
            "/main.tsx": `/// <cts-enable />
import { Confidential, handler, Integrity, pattern, ProjectionOf, Writable, WriteAuthorizedBy } from "commonfabric";
${declaration}
export default pattern<{ a: ${a} }>(({ a }) => ({ a }));`,
          }, { types: COMMONFABRIC_TYPES, typeCheck: true });
          const schemas = patternSchemas(parseModule(files["/main.tsx"]!));
          // The argument is read from its written reference, which keeps
          // `null`; the result from the reduced type, which has none.
          expect((schemas.input.properties as Schema).a).toEqual(input);
          expect((schemas.output.properties as Schema).a).toEqual(output);
        });
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

  describe("a pass reading inside a print", () => {
    // A pass that narrows, shrinks, or marks identity inside a print reads the
    // print's unfolding, each part printed afresh from its type, and leaves no
    // piece of the print for schema generation to read as a node.

    it("reads a member naming a type the module does not import by its type", async () => {
      const output = await transformSource(
        `import { computed, generateObject, pattern, UI } from "commonfabric";
interface Item { content: string; }
interface Sentiment { label: string; }
export default pattern<{ items: Item[] }>(({ items }) => {
  const analyses = items.map((item) => ({
    content: item.content,
    analysis: generateObject<Sentiment>({ prompt: item.content }),
  }));
  return {
    [UI]: (
      <div>
        {analyses.map((entry, i) => (
          <div key={i}>
            {computed(() => {
              const pending = entry.analysis.pending;
              const label = entry.analysis.result?.label;
              return pending ? "…" : label;
            })}
          </div>
        ))}
      </div>
    ),
  };
});`,
        { types: COMMONFABRIC_TYPES, typeCheck: true },
      );
      // The element schema of the callback mapping `analyses`.
      const element = emittedSchemas(parseModule(output))
        .map((schema) =>
          (schema.properties as Schema | undefined)?.element as
            | Schema
            | undefined
        )
        .find((element) =>
          (element?.properties as Schema | undefined)?.analysis
        );

      expect(element).toMatchObject({
        properties: {
          analysis: {
            type: "object",
            properties: {
              pending: { type: "boolean" },
              result: {
                anyOf: [{ type: "undefined" }, { $ref: "#/$defs/Sentiment" }],
              },
            },
          },
        },
      });
    });

    it("narrows a cell inside a printed literal and reads its other members by type", async () => {
      const output = await transformSource(
        `import { type Cell, computed, pattern, UI } from "commonfabric";
type ProfileCell = Cell<{ name?: string }>;
export default pattern<{ profiles: ProfileCell[] }>(({ profiles }) => {
  const participants = computed<{ name: string; profile: ProfileCell }[]>(() =>
    profiles.map((profile) => ({ name: "someone", profile }))
  );
  return {
    [UI]: <div>{participants.map((p) => <cf-profile-badge $profile={p.profile} />)}</div>,
  };
});`,
        { types: COMMONFABRIC_TYPES, typeCheck: true },
      );
      const element = emittedSchemas(parseModule(output))
        .map((schema) =>
          (schema.properties as Schema | undefined)?.element as
            | Schema
            | undefined
        )
        .find((element) => element !== undefined);

      expect(element).toEqual({
        type: "object",
        properties: {
          name: { type: "string" },
          profile: {
            type: "object",
            properties: { name: { type: "string" } },
            asCell: ["readonly"],
          },
        },
        required: ["name", "profile"],
      });
    });

    it("narrows a scoped cell inside its scope wrapper", async () => {
      // Only the scope wrapper names the scope, so the narrowed cell is put
      // back inside it.
      const output = await transformSource(
        `import { computed, pattern, UI, Writable } from "commonfabric";
export default pattern<Record<string, never>>(() => {
  const confirming = Writable.perSession.of<boolean>(false);
  const isConfirming = computed(() => confirming.get());
  return { [UI]: <div>{isConfirming ? "yes" : "no"}</div> };
});`,
        { types: COMMONFABRIC_TYPES, typeCheck: true },
      );
      const root = parseModule(output);
      const [lift] = callsNamed(root, "lift");
      const captures = lift!.typeArguments![0]! as ts.TypeLiteralNode;
      const confirming = captures.members.find(ts.isPropertySignature)!;

      expect(confirming.type!.getText(root)).toBe(
        "__cfHelpers.PerSession<__cfHelpers.ReadonlyCell<boolean>>",
      );
      expect((callSchemas(root, "lift")[0]!.properties as Schema).confirming)
        .toEqual({
          type: "boolean",
          asCell: [{ kind: "readonly", scope: "session" }],
        });
    });

    it("reads a scoped cell inside a printed value by its type", async () => {
      // The optional member prints as a union holding the scoped cell: the
      // union unfolds, and the scoped cell is kept whole rather than taken
      // apart.
      const [capture] = await liftSchemas(
        `import { computed, pattern, wish, Writable, type PerUser } from "commonfabric";
interface Note { title: string; }
export default pattern<{ x: string }>(() => {
  const found = wish<{ note?: PerUser<Writable<Note>>; count: number }>({
    query: "#note",
    headless: true,
  });
  return { title: computed(() => found.result?.note?.get()?.title) };
});`,
      );

      expect((capture as Schema).properties).toMatchObject({
        found: {
          properties: {
            result: {
              properties: {
                note: {
                  $ref: "#/$defs/Note",
                  asCell: [{ kind: "cell", scope: "user" }],
                },
              },
            },
          },
        },
      });
    });

    it("reads elements compared only by identity inside a printed value as comparable", async () => {
      // Reading `title` as well leaves nothing to shrink, so the node the
      // identity pass builds is the one schema generation reads.
      const [capture] = await liftSchemas(
        `import { computed, equals, pattern, Writable } from "commonfabric";
interface Note { title: string; body: string; }
export default pattern<{
  doc: Writable<{ notes?: Note[]; title: string }>;
  self: Note;
}>(({ doc, self }) => ({
  found: computed(() =>
    doc.get().title +
    String((doc.get().notes ?? []).some((n) => equals(n, self)))
  ),
}));`,
      );

      expect((capture as Schema).properties).toMatchObject({
        doc: {
          properties: {
            notes: {
              type: "array",
              items: { type: "unknown", asCell: ["comparable"] },
            },
            title: { type: "string" },
          },
        },
      });
    });

    it("keeps the alias a cell inside a printed value is given", async () => {
      // The cell's value type expands `EntriesValue`; the type argument its
      // wrapper was given keeps the name.
      const [capture] = await liftSchemas(
        `import { Cell, computed, Default, pattern, wish } from "commonfabric";
interface Entry { readonly profile: Cell<{ name: string }>; }
type EntriesValue = Entry[] | Default<[]>;
export default pattern<{ x: string }>(() => {
  const found = wish<{ entries: Cell<EntriesValue>; label: string }>({
    query: "#entries",
    headless: true,
  });
  return {
    out: computed(() =>
      found.result?.label + String(found.result?.entries.get().length)
    ),
  };
});`,
      );

      expect((capture as Schema).properties).toMatchObject({
        found: {
          properties: {
            result: {
              anyOf: [{
                properties: {
                  entries: { $ref: "#/$defs/EntriesValue", asCell: ["cell"] },
                },
              }, { type: "undefined" }],
            },
          },
        },
      });
    });

    it("shrinks the aliased value of a cell inside a printed value", async () => {
      // The value is printed expanded, so shrinking reaches inside the union
      // the alias names.
      const [capture] = await liftSchemas(
        `import { computed, pattern, Writable } from "commonfabric";
type Item =
  | { kind: "a"; x: string; extra: string }
  | { kind: "b"; y: string; extra: string };
export default pattern<{ list: Writable<Item>[] }>(({ list }) => ({
  first: computed(() => list[1]?.get().kind),
}));`,
      );

      const kindOnly = (kind: string) => ({
        type: "object",
        properties: { kind: { type: "string", enum: [kind] } },
        required: ["kind"],
      });
      expect((capture as Schema).properties).toEqual({
        list: {
          type: "array",
          items: { anyOf: [kindOnly("a"), kindOnly("b")], asCell: ["cell"] },
        },
      });
    });

    it("keeps a printed literal with a symbol-keyed property whole", async () => {
      // A symbol-keyed property says something only as a whole, so the print
      // is not shrunk to the member read.
      const [capture] = await liftSchemas(
        `import { computed, pattern, Writable } from "commonfabric";
declare const tag: unique symbol;
export default pattern<{
  doc: Writable<{ name: string; extra: string; [tag]: number }>;
}>(({ doc }) => ({
  n: computed(() => doc.get().name),
}));`,
      );

      expect((capture as Schema).properties).toEqual({
        doc: {
          type: "object",
          properties: {
            name: { type: "string" },
            extra: { type: "string" },
          },
          required: ["name", "extra"],
          asCell: ["readonly"],
        },
      });
    });

    it("keeps a symbol-keyed printed literal whole where a cell in it would be narrowed", async () => {
      const element = await narrowedElement(
        `{ name: string; profile: ProfileCell; [tag]: number }`,
        "declare const tag: unique symbol;",
      );

      expect(element).toMatchObject({
        properties: { profile: { asCell: ["cell"] } },
      });
    });

    it("keeps a symbol-keyed printed literal whole where identity paths reach inside", async () => {
      const [capture] = await liftSchemas(
        `import { computed, equals, pattern, Writable } from "commonfabric";
declare const tag: unique symbol;
interface Note { title: string; body: string; }
export default pattern<{
  doc: Writable<{ notes: Note[]; title: string; [tag]: number }>;
  self: Note;
}>(({ doc, self }) => ({
  found: computed(() =>
    doc.get().title + String(doc.get().notes.some((n) => equals(n, self)))
  ),
}));`,
      );

      expect((capture as Schema).properties).toMatchObject({
        doc: {
          properties: { notes: { items: { $ref: "#/$defs/Note" } } },
        },
      });
    });

    it("keeps the index signature of a printed literal a cell is narrowed in", async () => {
      const element = await narrowedElement(
        `{ name: string; profile: ProfileCell; [key: string]: unknown }`,
      );

      expect(element).toMatchObject({
        properties: { profile: { asCell: ["readonly"] } },
        additionalProperties: { type: "unknown" },
      });
    });

    it("leaves a method out of a printed literal a cell is narrowed in", async () => {
      const element = await narrowedElement(
        `{ name: string; profile: ProfileCell; send(): Stream<number> }`,
      );

      expect(Object.keys((element as Schema).properties as Schema)).toEqual([
        "name",
        "profile",
      ]);
    });

    it("holds a printed nullable scoped value's nullish alternatives inside its scope wrapper", async () => {
      const [capture] = await liftSchemas(
        `import { pattern, wish, Writable, type PerUser } from "commonfabric";
interface Named { name: string; }
export default pattern<{ x: string }>(() => {
  const found = wish<Writable<PerUser<Named>>>({ query: "#named", headless: true });
  const name = found.result?.get()?.name;
  return { name };
});`,
      );

      expect((capture as Schema).properties).toEqual({
        found: {
          type: "object",
          properties: {
            result: {
              anyOf: [{ type: "undefined" }, { $ref: "#/$defs/Named" }],
              scope: "user",
              asCell: ["readonly"],
            },
          },
        },
      });
    });

    it("refuses a type argument that holds a piece of a print", async () => {
      // A state saying each `string` keyword was built below a print stands in
      // for a pass that took a print apart.
      const root = ts.factory.createKeywordTypeNode(
        ts.SyntaxKind.UnknownKeyword,
      );
      class PieceState extends CrossStageState {
        override printedWithin(node: ts.Node): ts.TypeNode | undefined {
          return node.kind === ts.SyntaxKind.StringKeyword
            ? root
            : super.printedWithin(node);
        }
      }

      await expect(transformSource(
        `import { toSchema } from "commonfabric";
export const schema = toSchema<{ name: string }>();`,
        { types: COMMONFABRIC_TYPES, state: new PieceState() },
      )).rejects.toThrow("reached schema generation outside that node");
    });
  });
});
