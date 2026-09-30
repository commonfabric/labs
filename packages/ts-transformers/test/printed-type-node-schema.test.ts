import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import ts from "typescript";

import { CrossStageState } from "../src/core/mod.ts";
import type { TransformationDiagnostic } from "../src/mod.ts";
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

/**
 * The input and result schemas of the one `lift()` in `source` whose callback
 * reads `read`.
 */
async function liftSchemas(
  source: string,
  read: string,
): Promise<{ input: unknown; result: unknown }> {
  const output = await transformSource(source, {
    types: COMMONFABRIC_TYPES,
    typeCheck: true,
  });
  const root = parseModule(output);
  const lifts = callsNamed(root, "lift").filter((lift) =>
    lift.arguments[0]?.getText(root).includes(read)
  );
  if (lifts.length !== 1) {
    throw new Error(`Expected one lift reading ${read}, found ${lifts.length}`);
  }
  const [, input, result] = lifts[0]!.arguments;
  const schema = (argument: ts.Expression | undefined) => {
    if (!argument || !ts.isSatisfiesExpression(argument)) {
      throw new Error("Expected a schema literal");
    }
    return literalToValue(argument.expression);
  };
  return { input: schema(input), result: schema(result) };
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

    it("reads the instantiated fields of a scoped tuple holding an empty tuple", async () => {
      const { capture, result } = await schemasOfBinding(
        "PerUser<[Box<T>, []]>",
        "number",
      );
      const scoped = {
        type: "array",
        items: {
          anyOf: [{ type: "array", items: false }, box({ type: "number" })],
        },
        scope: "user",
      };

      expect(capture).toEqual(scoped);
      expect(result).toEqual(scoped);
    });

    it("keeps a cell argument in a scoped tuple holding an empty tuple", async () => {
      const { capture, result } = await schemasOfBinding(
        "PerUser<[Box<T>, []]>",
        "Writable<{ text: string }>",
      );
      const scoped = {
        type: "array",
        items: {
          anyOf: [
            { type: "array", items: false },
            box({
              type: "object",
              properties: { text: { type: "string" } },
              required: ["text"],
              asCell: ["cell"],
            }),
          ],
        },
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

  describe("a type holding an empty tuple", () => {
    // `Default<[]>` resolves to `[] & brand`, and the checker prints a type
    // holding `[]` only when asked to.

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

    for (const tuple of ["readonly []", "[]"]) {
      const wrap = {
        type: "object",
        properties: {
          x: { type: "string" },
          l: { type: "array", items: false },
        },
        required: ["x", "l"],
      };

      it(`reads an alias given \`${tuple}\` in a pattern's inferred result as its instantiation, on both sides`, async () => {
        const diagnostics: TransformationDiagnostic[] = [];
        const files = await transformFiles({
          "/main.tsx": `/// <cts-enable />
import { pattern } from "commonfabric";
type Wrap<L extends readonly unknown[]> = { x: string; l: L };
export default pattern<{ a: Wrap<${tuple}> }>(({ a }) => ({ a }));`,
        }, {
          types: COMMONFABRIC_TYPES,
          typeCheck: true,
          pipelineDiagnostics: diagnostics,
        });
        const { input, output } = patternSchemas(
          parseModule(files["/main.tsx"]!),
        );

        for (const root of [input, output]) {
          expect(root).toEqual({
            type: "object",
            properties: { a: wrap },
            required: ["a"],
          });
        }
        expect(diagnostics).toEqual([]);
      });

      it(`reads an alias given \`${tuple}\` in a lift's inferred result as its instantiation`, async () => {
        const { result } = await liftSchemas(
          `import { lift } from "commonfabric";
type Wrap<L extends readonly unknown[]> = { x: string; l: L };
export const f = lift((a: { w: Wrap<${tuple}> }) => ({ out: a.w }));`,
          "a.w",
        );

        expect(result).toEqual({
          type: "object",
          properties: { out: wrap },
          required: ["out"],
        });
      });
    }

    it("keeps the cell boundary of an array of cells with an empty default", async () => {
      const { result } = await liftSchemas(
        `${IMPORTS}interface Item { title: string; attachments: Writable<any>[] | Default<[]>; }
interface Input { item: Item; }
export default pattern<Input>(({ item }) => {
  const attachments = computed(() => item.attachments ?? []);
  return { count: computed(() => attachments.length) };
});`,
        "item.attachments",
      );

      expect(result).toEqual({
        type: "array",
        items: { asCell: ["cell"] },
        default: [],
      });
    });

    it("keeps the items and default of an element type the module does not import through capability narrowing", async () => {
      const output = await transformFiles({
        "/queue.tsx":
          `import { type Default, pattern, type PerUser, Writable } from "commonfabric";
interface Run { status: string; }
export interface Entry { host: string; run: PerUser<Writable<Run>>; }
interface QueueIO { entries: Writable<Entry[] | Default<[]>>; }
export default pattern<QueueIO, QueueIO>(({ entries }) => ({ entries }));`,
        "/main.tsx":
          `import { computed, pattern, Writable } from "commonfabric";
import Queue from "./queue.tsx";
export default pattern<{ n: number }>(() => {
  const queue = Queue({ entries: Writable.of([]) });
  return {
    status: computed(() => queue.entries.get()[0]?.run.get().status ?? ""),
  };
});`,
      }, { types: COMMONFABRIC_TYPES, typeCheck: true });
      const [input] = callSchemas(parseModule(output["/main.tsx"]!), "lift");
      const queue = (input!.properties as Schema).queue as Schema;

      expect((queue.properties as Schema).entries).toEqual({
        type: "array",
        items: { $ref: "#/$defs/Entry" },
        default: [],
        asCell: ["readonly"],
      });
      expect((input!.$defs as Schema).Entry).toEqual({
        type: "object",
        properties: {
          host: { type: "string" },
          run: {
            $ref: "#/$defs/Run",
            asCell: [{ kind: "cell", scope: "user" }],
          },
        },
        required: ["host", "run"],
      });
    });

    for (
      const [position, declaration, holder] of [
        [
          "an index signature",
          "interface Dict<U> { [key: string]: U }",
          "Dict",
        ],
        ["a tuple", "interface Twice<U> { items: [U, U] }", "Twice"],
      ] as const
    ) {
      it(`reports an unsettled scope recursion reached through ${position} at its generic slot or concrete argument`, async () => {
        // The declared generic slot reads under bindings. A recursion that
        // cannot settle reports that slot at its nesting bound.
        const diagnostics: TransformationDiagnostic[] = [];
        await transformFiles({
          "/main.tsx": `/// <cts-enable />
import { Cell, pattern, PerUser } from "commonfabric";
${declaration}
type Wrap<L extends readonly unknown[]> = { x: string; l: L };
type Node<T> = PerUser<Cell<{ value: T; next?: ${holder}<Node<Readonly<T>>> }>>;
export default pattern<{ a: Node<Wrap<readonly []>> }>(({ a }) => ({ a }));`,
        }, {
          types: COMMONFABRIC_TYPES,
          typeCheck: true,
          pipelineDiagnostics: diagnostics,
        });
        const unread = diagnostics.filter((diagnostic) =>
          diagnostic.type === "schema-type:unread"
        );

        expect(unread.length).toBeGreaterThan(0);
        for (const diagnostic of unread) {
          expect(diagnostic.message).toMatch(
            new RegExp(`${holder}<Node<Readonly<T>>>|Wrap<readonly \\[\\]>`),
          );
        }
      });
    }
  });

  describe("a type the checker cannot print", () => {
    // The checker prints no type node for the instance type of an anonymous
    // class expression, which has no name to print it by, so each case below
    // reads a result whose type has no print.

    const makeObject =
      "const makeObject = () => ({ a: new (class { v = 1 })() });";
    const instance = {
      type: "object",
      properties: { v: { type: "number" } },
      required: ["v"],
    };

    /**
     * The transformed module whose `make()` returns an anonymous class
     * instance and whose remaining source is `body`, with the diagnostics its
     * transform reports.
     */
    async function transformWithMake(
      body: string,
    ): Promise<
      { root: ts.SourceFile; diagnostics: TransformationDiagnostic[] }
    > {
      const diagnostics: TransformationDiagnostic[] = [];
      const files = await transformFiles({
        "/main.tsx": `/// <cts-enable />
import { lift, pattern } from "commonfabric";
function make() { return new (class { v = 1 })(); }
${body}`,
      }, {
        types: COMMONFABRIC_TYPES,
        typeCheck: true,
        pipelineDiagnostics: diagnostics,
      });
      return { root: parseModule(files["/main.tsx"]!), diagnostics };
    }

    it("reads a pattern's inferred result as its type", async () => {
      const { root, diagnostics } = await transformWithMake(
        "export default pattern<{ n: number }>(({ n }) => ({ a: make(), n }));",
      );

      expect(patternSchemas(root).output).toEqual({
        type: "object",
        properties: { a: { $ref: "#/$defs/__class" }, n: { type: "number" } },
        required: ["a", "n"],
        $defs: { __class: instance },
      });
      expect(diagnostics).toEqual([]);
    });

    it("reports `pattern-result:unknown-type` for each field and array element of a pattern's inferred result typed `unknown`", async () => {
      const { diagnostics } = await transformWithMake(
        "export default pattern<{ u: unknown }>(({ u }) => ({ a: make(), u, us: [u] }));",
      );

      expect(diagnostics.map(({ severity, type }) => ({ severity, type })))
        .toEqual([{ severity: "error", type: "pattern-result:unknown-type" }]);
      expect(diagnostics[0]!.message).toContain("fields `u`, `us[]` have");
    });

    for (
      const [shape, result, fields] of [
        ["the result itself", "makeHolding()", "field `u` has"],
        ["a field of the result", "({ a: makeHolding() })", "field `a.u` has"],
        [
          "each of two fields of the result",
          "({ a: makeHolding(), b: makeHolding() })",
          "fields `a.u`, `b.u` have",
        ],
      ] as const
    ) {
      it(`reports \`pattern-result:unknown-type\` for the \`unknown\` field of an anonymous class instance that is ${shape}`, async () => {
        const { diagnostics } = await transformWithMake(
          `function makeHolding() { return new (class { v = 1; u: unknown = "u"; })(); }
export default pattern<Record<string, never>>(() => ${result});`,
        );

        expect(diagnostics.map(({ severity, type }) => ({ severity, type })))
          .toEqual([{
            severity: "error",
            type: "pattern-result:unknown-type",
          }]);
        expect(diagnostics[0]!.message).toContain(fields);
      });
    }

    for (
      const [holder, result] of [
        ["an anonymous class instance that is the result", "makeBranded()"],
        [
          "an anonymous class instance that is a field of the result",
          "({ a: makeBranded() })",
        ],
        ["the result itself", "({ a: make(), [brand]: u })"],
      ] as const
    ) {
      it(`reports nothing for an \`unknown\` symbol-keyed member of ${holder}, which the schema leaves out`, async () => {
        const { diagnostics } = await transformWithMake(
          `const brand = Symbol("brand");
function makeBranded() { return new (class { v = 1; [brand]: unknown = "b"; })(); }
export default pattern<{ u: unknown }>(({ u }) => ${result});`,
        );

        expect(diagnostics).toEqual([]);
      });
    }

    it("reads a pattern's inferred result holding a type that refers to itself through `typeof`", async () => {
      // The type of `tree` has no name, and holds itself through `typeof`.
      const { root, diagnostics } = await transformWithMake(
        `const tree: { children: (typeof tree)[] } = { children: [] };
export default pattern<Record<string, never>>(() => ({ a: make(), tree }));`,
      );

      expect(diagnostics).toEqual([]);
      expect(Object.keys(
        (patternSchemas(root).output.properties ?? {}) as Schema,
      )).toEqual(["a", "tree"]);
    });

    it("reports `pattern:any-result-schema` for a pattern whose result is its callback's type parameter", async () => {
      // A result typed by a bare type parameter has neither a print nor a
      // type to read, so it is read as permissive.
      const { diagnostics } = await transformWithMake(
        "export default pattern<{ v: string }>(<T,>({ v }: { v: T }) => v);",
      );

      expect(diagnostics.map(({ severity, type }) => ({ severity, type })))
        .toEqual([{ severity: "error", type: "pattern:any-result-schema" }]);
    });

    for (
      const [parameters, callback, schema] of [
        ["no parameters", "() => ({ a: make() })", {
          properties: { a: { $ref: "#/$defs/__class" } },
          required: ["a"],
        }],
        ["a parameter", "(n: number) => ({ a: make(), n })", {
          properties: {
            a: { $ref: "#/$defs/__class" },
            n: { type: "number" },
          },
          required: ["a", "n"],
        }],
      ] as const
    ) {
      it(`reads the result of a lift taking ${parameters} as its type`, async () => {
        const { root, diagnostics } = await transformWithMake(
          `export const f = lift(${callback});`,
        );

        expect(callSchemas(root, "lift").at(-1)).toEqual({
          type: "object",
          ...schema,
          $defs: { __class: instance },
        });
        expect(diagnostics).toEqual([]);
      });
    }

    it("reads a lift's result as its authored return annotation", async () => {
      const { result } = await liftSchemas(
        `import { lift } from "commonfabric";
${makeObject}
export const f = lift((n: number): ReturnType<typeof makeObject> =>
  n > 0 ? makeObject() : makeObject()
);`,
        "makeObject()",
      );

      expect(result).toEqual({
        type: "object",
        properties: { a: { $ref: "#/$defs/__class" } },
        required: ["a"],
        $defs: { __class: instance },
      });
    });

    it("reads a lift's projected result from its parameter's annotation", async () => {
      const { result } = await liftSchemas(
        `import { lift } from "commonfabric";
${makeObject}
export const f = lift((x: ReturnType<typeof makeObject>) => x.a);`,
        "x.a",
      );

      expect(result).toEqual(instance);
    });
  });

  describe("a pattern result holding `unknown` in a tuple, a `readonly` type, or a union", () => {
    // Each `unknown` below lowers to `{ type: "unknown" }` somewhere in the
    // schema, as a field typed `unknown` does, so it is reported the same
    // way, whether the result is printed or read from a placeholder for a
    // type with no print.

    /**
     * The diagnostics transforming a pattern over `u: unknown` whose callback
     * returns `result`, beside a module-level `make()` returning an anonymous
     * class instance.
     */
    async function diagnosticsFor(
      result: string,
    ): Promise<TransformationDiagnostic[]> {
      const diagnostics: TransformationDiagnostic[] = [];
      await transformFiles({
        "/main.tsx": `/// <cts-enable />
import { pattern } from "commonfabric";
function make() { return new (class { v = 1 })(); }
export default pattern<{ u: unknown }>(({ u }) => (${result}));`,
      }, {
        types: COMMONFABRIC_TYPES,
        typeCheck: true,
        pipelineDiagnostics: diagnostics,
      });
      return diagnostics;
    }

    for (
      const [reading, before] of [
        ["printed", ""],
        ["read from a placeholder for a type with no print", "a: make(), "],
      ] as const
    ) {
      for (
        const [value, field] of [
          ["[u, 1] as [unknown, number]", "f[0]"],
          ["[1, u] as [first: number, second: unknown]", "f[1]"],
          ["[1, u] as [number, unknown?]", "f[1]"],
          ["[1, u] as [number, ...unknown[]]", "f[1...]"],
          ["[u, 1] as const", "f[0]"],
          ["[[u], 1] as const", "f[0][0]"],
          ["[u] as readonly unknown[]", "f[]"],
          ["[1, { v: u }] as [number, { v: unknown }?]", "f[1].v"],
          ["[1, [u]] as [number, unknown[]?]", "f[1][]"],
          ["[1, [u]] as [number, [unknown]?]", "f[1][0]"],
          ["{ v: u } as { v: unknown } | null", "f.v"],
        ] as const
      ) {
        it(`reports \`pattern-result:unknown-type\` for \`${field}\` of \`${value}\` in a result ${reading}`, async () => {
          const diagnostics = await diagnosticsFor(
            `{ ${before}f: ${value} }`,
          );

          expect(diagnostics.map(({ severity, type }) => ({ severity, type })))
            .toEqual([{
              severity: "error",
              type: "pattern-result:unknown-type",
            }]);
          expect(diagnostics[0]!.message).toContain(`field \`${field}\` has`);
        });
      }
    }

    it("reports an `unknown` element as a warning over stored source, and as an error otherwise", async () => {
      // A reload of stored source reconstructs what was admitted when it was
      // deployed, which may hold a shape this check covers only since.

      /** The result diagnostics compiling the pattern as `storedSource`. */
      const reported = async (storedSource: boolean) => {
        const diagnostics: TransformationDiagnostic[] = [];
        await transformFiles({
          "/main.tsx": `/// <cts-enable />
import { pattern } from "commonfabric";
export default pattern<{ u: unknown }>(({ u }) => ({ f: [u, 1] as const }));`,
        }, {
          types: COMMONFABRIC_TYPES,
          typeCheck: true,
          pipelineDiagnostics: diagnostics,
          storedSource,
        });
        return diagnostics.map(({ type, severity }) => ({ type, severity }));
      };

      expect(await reported(true)).toEqual([
        { type: "pattern-result:unknown-type", severity: "warning" },
      ]);
      expect(await reported(false)).toEqual([
        { type: "pattern-result:unknown-type", severity: "error" },
      ]);
    });
  });

  describe("a pattern result holding a named type that declares `unknown`", () => {
    // `unknown` in a declaration is the form for a reference to another piece
    // (`docs/common/concepts/types-and-schemas/unknown.md`), so a result that
    // passes on a named type declaring one is not reported, whether the
    // result is printed or read from a placeholder for a type with no print.

    for (
      const [kind, declaration] of [
        ["an alias", "type Ref = { piece: unknown };"],
        ["an interface", "interface Ref { piece: unknown }"],
        ["an alias of an array", "type Ref = unknown[];"],
        ["an alias of a readonly array", "type Ref = readonly unknown[];"],
        ["an alias of a tuple", "type Ref = [unknown, number];"],
        ["an alias of a union", "type Ref = { piece: unknown } | number;"],
      ] as const
    ) {
      for (
        const [reading, before] of [
          ["printed", ""],
          ["read from a placeholder for a type with no print", "a: make(), "],
        ] as const
      ) {
        it(`reports nothing for the \`unknown\` ${kind} declares, in a result ${reading}`, async () => {
          const diagnostics: TransformationDiagnostic[] = [];
          await transformFiles({
            "/main.tsx": `/// <cts-enable />
import { pattern } from "commonfabric";
${declaration}
function make() { return new (class { v = 1 })(); }
export default pattern<{ ref: Ref }>(({ ref }) => ({ ${before}ref, refs: [ref] }));`,
          }, {
            types: COMMONFABRIC_TYPES,
            typeCheck: true,
            pipelineDiagnostics: diagnostics,
          });

          expect(diagnostics).toEqual([]);
        });
      }
    }
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
            const { input, output } = patternSchemas(
              parseModule(files["/main.tsx"]!),
            );
            const valueTypes = (schema: Schema, field: "a" | "b") => {
              const defs = schema.$defs as Record<string, Schema>;
              const link =
                (schema.properties as Record<string, Schema>)[field]!;
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
            for (const schema of [input, output]) {
              expect(valueTypes(schema, "a")).toEqual({
                value: { type: "string" },
                recursive: { type: "string" },
                self: true,
              });
              expect(valueTypes(schema, "b")).toEqual({
                value: { type: "number" },
                recursive: { type: "number" },
                self: true,
              });
            }
          },
        );
      }
    });

    describe("a CFC alias whose type the checker reduced", () => {
      // `Confidential<string | null, …>` is `string & carrier` once
      // `null & carrier` is nothing, and the reduced type keeps no alias name.
      // A written reference still names the policy; a type alone has only its
      // carrier, which holds the labels but cannot spell a writer binding.
      const TITLE_AND_RANK = {
        type: "object",
        properties: { title: { type: "string" }, rank: { type: "number" } },
        required: ["title", "rank"],
      };
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
          [
            "a nullable intersection written directly",
            "",
            `Confidential<({ title: string } & { rank: number }) | null, ["secret"]>`,
            {
              anyOf: [TITLE_AND_RANK, { type: "null" }],
              ifc: { confidentiality: ["secret"] },
            },
            { ...TITLE_AND_RANK, ifc: { confidentiality: ["secret"] } },
          ],
          [
            "a nullable intersection in another label's payload",
            `type Sec<T> = Confidential<(T & { rank: number }) | null, ["secret"]>;`,
            `Integrity<Sec<{ title: string }>, ["trusted"]>`,
            {
              anyOf: [TITLE_AND_RANK, { type: "null" }],
              ifc: { confidentiality: ["secret"], integrity: ["trusted"] },
            },
            {
              ...TITLE_AND_RANK,
              ifc: { confidentiality: ["secret"], integrity: ["trusted"] },
            },
          ],
          [
            "an intersection whose name `NonNullable` drops",
            "",
            `NonNullable<Confidential<{ title: string } & { rank: number }, ["secret"]>>`,
            { ...TITLE_AND_RANK, ifc: { confidentiality: ["secret"] } },
            { ...TITLE_AND_RANK, ifc: { confidentiality: ["secret"] } },
          ],
          [
            "a nullable intersection's writer written directly",
            `const setEntry = handler<{ title: string }, { entry: Writable<({ title: string } & { rank: number }) | null> }>((event, { entry }) => { entry.set({ title: event.title, rank: 0 }); });`,
            "WriteAuthorizedBy<({ title: string } & { rank: number }) | null, typeof setEntry>",
            {
              anyOf: [TITLE_AND_RANK, { type: "null" }],
              ifc: {
                writeAuthorizedBy: {
                  __ctWriterIdentityOf: {
                    file: "/main.tsx",
                    path: ["setEntry"],
                  },
                },
              },
            },
            TITLE_AND_RANK,
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

    describe("a generic CFC alias written with its arguments", () => {
      // Written with its arguments, a chain's payload is read from the last
      // alias's declaration with each parameter bound to the argument written
      // for it, so a generic declaration the payload names reads as its
      // result's does.
      const BOX = "interface Box<U> { value: U }";
      const labelled = (
        payload: Schema,
        ifc: Schema = { confidentiality: ["secret"], integrity: ["trusted"] },
      ) => ({ ...payload, ifc });
      const box = (value: Schema) => ({
        type: "object",
        properties: { value },
        required: ["value"],
      });
      const strings = { type: "array", items: { type: "string" } };
      for (
        const [spelling, declaration, a, expected] of [
          [
            "a generic interface holding it",
            `${BOX}
type Sec<T> = Confidential<Box<T> & { tag: string }, ["secret"]>;`,
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
            "an array of a generic interface holding it",
            `${BOX}
type Sec<T> = Confidential<Box<T>[], ["secret"]>;`,
            `Integrity<Sec<string>, ["trusted"]>`,
            labelled({ type: "array", items: box({ type: "string" }) }),
          ],
          [
            "a generic alias holding it",
            `type Pair<A> = { a: A; b: A };
type Sec<T> = Confidential<Pair<T>, ["secret"]>;`,
            `Integrity<Sec<string>, ["trusted"]>`,
            labelled({
              type: "object",
              properties: { a: { type: "string" }, b: { type: "string" } },
              required: ["a", "b"],
            }),
          ],
          [
            "another generic alias holding a generic interface",
            `${BOX}
type Sec<T> = Confidential<Integrity<Box<T>, ["inner"]>, ["secret"]>;`,
            `MaxConfidentiality<Sec<string>, ["top"]>`,
            labelled(box({ type: "string" }), {
              integrity: ["inner"],
              confidentiality: ["secret"],
              maxConfidentiality: ["top"],
            }),
          ],
          [
            "a union holding another generic alias over a generic interface",
            `${BOX}
type Inner<U> = Confidential<Box<U> | number, ["inner"]>;
type Sec<T> = Confidential<Inner<T> | boolean, ["secret"]>;`,
            `Integrity<Sec<string>, ["trusted"]>`,
            labelled({
              anyOf: [
                {
                  anyOf: [box({ type: "string" }), { type: "number" }],
                  ifc: { confidentiality: ["inner"] },
                },
                { type: "boolean" },
              ],
            }),
          ],
          [
            "a generic interface reached down a chain of aliases",
            `${BOX}
type Sec<T> = Confidential<Box<T>, ["secret"]>;
type Outer<X> = Sec<X[]>;`,
            `Integrity<Outer<string>, ["trusted"]>`,
            labelled(box(strings)),
          ],
          [
            "a generic interface an argument left out defaults to",
            `${BOX}
type Sec<T, U = Box<T>> = Confidential<U, ["secret"]>;`,
            `Integrity<Sec<string>, ["trusted"]>`,
            labelled(box({ type: "string" })),
          ],
          [
            "an indexed access in an alias whose chain is another's payload",
            // The outer chain's payload is read at the type it instantiates,
            // which, less every carrier, is the inner alias's payload.
            `type Sec<T extends { a: string }> = Confidential<{ pair: [T["a"]] }, ["secret"]>;
type Outer<X extends { a: string }> = Integrity<Sec<X>, ["trusted"]>;`,
            `Outer<{ a: string }>`,
            labelled({
              type: "object",
              properties: { pair: strings },
              required: ["pair"],
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

      for (
        const member of [
          "next: Writable<Sec<T | undefined>>",
          "next: Array<Sec<T | undefined>>",
          "next: [Sec<T | undefined>]",
          "next?: Sec<Readonly<T>>",
          "next: [Sec<T | undefined>, ...string[]]",
          "next: [...Sec<T | undefined>[]]",
          "next: Readonly<Sec<T | undefined>>",
          "next: Required<Sec<T | undefined>>",
          "next: Default<Sec<T | undefined> | null, null>",
          "next: Sec<T | undefined> | number",
        ]
      ) {
        it(`reads a recursion the checker settles, as \`${member}\`, as its definition on both sides`, async () => {
          const diagnostics: TransformationDiagnostic[] = [];
          const files = await transformFiles({
            "/main.tsx": `/// <cts-enable />
import { Confidential, Default, pattern, Writable } from "commonfabric";
type Sec<T> = Confidential<{ value: T; ${member} }, ["secret"]>;
export default pattern<{ a: Sec<{ a: string }> }>(({ a }) => ({ a }));`,
          }, {
            types: COMMONFABRIC_TYPES,
            typeCheck: true,
            pipelineDiagnostics: diagnostics,
          });
          const { input, output } = patternSchemas(
            parseModule(files["/main.tsx"]!),
          );
          for (const root of [input, output]) {
            const definitions = Object.entries(
              (root.$defs ?? {}) as Record<string, Schema>,
            );
            const recursive = definitions.find(([name, definition]) =>
              JSON.stringify(definition).includes(`"#/$defs/${name}"`)
            );
            expect(recursive).toBeDefined();
            expect(JSON.stringify((root.properties as Schema).a)).toContain(
              `"#/$defs/${recursive?.[0]}"`,
            );
          }
          expect(
            diagnostics.filter((diagnostic) =>
              diagnostic.type === "schema-type:unread" ||
              diagnostic.type === "cfc-schema:recursion-limit"
            ),
          ).toEqual([]);
        });
      }

      it("reports a recursion that instantiates the alias without end, on both sides", async () => {
        // Each `Nest<T[]>` is a new type, on the result side as much as the
        // argument side, so the nesting bound ends both readings.
        const diagnostics: TransformationDiagnostic[] = [];
        const files = await transformFiles({
          "/main.tsx": `/// <cts-enable />
import { Confidential, pattern } from "commonfabric";
type Nest<T> = Confidential<{ v: T; inner?: Nest<T[]> }, ["secret"]>;
export default pattern<{ a: Nest<string> }>(({ a }) => ({ a }));`,
        }, {
          types: COMMONFABRIC_TYPES,
          typeCheck: true,
          pipelineDiagnostics: diagnostics,
        });
        const { input, output } = patternSchemas(
          parseModule(files["/main.tsx"]!),
        );
        for (const root of [input, output]) {
          expect((root.properties as Record<string, Schema>).a).toBeDefined();
        }
        expect(
          diagnostics.filter((diagnostic) =>
            diagnostic.type === "schema-type:unread" ||
            diagnostic.type === "cfc-schema:recursion-limit"
          ).length,
        ).toBeGreaterThan(0);
      });

      for (
        const [position, declaration, holder] of [
          [
            "an index signature",
            "interface Dict<U> { [key: string]: U }",
            "Dict",
          ],
          ["a tuple", "interface Twice<U> { items: [U, U] }", "Twice"],
        ] as const
      ) {
        it(`reports a recursion reached through ${position} of a generic declaration, with no written reference, on both sides`, async () => {
          // Each `Sec<Readonly<…>>` is a new type, and a chain reached by type
          // has no written reference to settle by, so its alias bounds it.
          const diagnostics: TransformationDiagnostic[] = [];
          const files = await transformFiles({
            "/main.tsx": `/// <cts-enable />
import { Confidential, pattern } from "commonfabric";
${declaration}
type Sec<T> = Confidential<{ value: T; next?: ${holder}<Sec<Readonly<T>>> }, ["secret"]>;
export default pattern<{ a: Sec<{ a: string }> }>(({ a }) => ({ a }));`,
          }, {
            types: COMMONFABRIC_TYPES,
            typeCheck: true,
            pipelineDiagnostics: diagnostics,
          });
          const { input, output } = patternSchemas(
            parseModule(files["/main.tsx"]!),
          );
          for (const root of [input, output]) {
            expect((root.properties as Record<string, Schema>).a)
              .toBeDefined();
          }
          // Both schema uses point to the same recursive reference, so the
          // compilation reports one error at that declaration.
          const errors = diagnostics.filter((diagnostic) =>
            diagnostic.type === "cfc-schema:recursion-limit"
          );
          expect(errors).toHaveLength(1);
          expect(errors[0]!.severity).toBe("error");
        });
      }

      it("keeps each level's value in a recursion whose argument alternates, on both sides", async () => {
        // The payload is read from the instantiation, which leaves the
        // written argument's `T` unbound, so that argument reads as nothing
        // and the recursion settles only where it meets the same reading
        // again.
        const diagnostics: TransformationDiagnostic[] = [];
        const files = await transformFiles({
          "/main.tsx": `/// <cts-enable />
import { Confidential, pattern } from "commonfabric";
type Sec<T> = Confidential<{ v: T; next?: Sec<T extends string ? number : string> }, ["secret"]>;
export default pattern<{ a: Sec<string> }>(({ a }) => ({ a }));`,
        }, {
          types: COMMONFABRIC_TYPES,
          typeCheck: true,
          pipelineDiagnostics: diagnostics,
        });
        const { input, output } = patternSchemas(
          parseModule(files["/main.tsx"]!),
        );
        for (const root of [input, output]) {
          const definitions = (root.$defs ?? {}) as Record<string, Schema>;
          const resolve = (schema: Schema): Schema =>
            typeof schema.$ref === "string"
              ? definitions[schema.$ref.split("/").pop()!]!
              : schema;
          const values: unknown[] = [];
          let level = resolve((root.properties as Record<string, Schema>).a!);
          for (let depth = 0; depth < 4; depth++) {
            const properties = level.properties as Record<string, Schema>;
            values.push(properties.v!.type);
            level = resolve(properties.next!);
          }
          expect(values).toEqual(["string", "number", "string", "number"]);
        }
        expect(
          diagnostics.filter((diagnostic) =>
            diagnostic.type === "schema-type:unread" ||
            diagnostic.type === "cfc-schema:recursion-limit"
          ),
        ).toEqual([]);
      });

      it("keeps each level's value in a recursion that swaps tuple arguments another alias indexes, on both sides", async () => {
        // `[string, number]` and `[number, string]` read as one array schema,
        // but `First` reads position 0 of the type its argument denotes, so
        // the two levels differ, and the recursion settles only where the
        // same types come round again.
        const diagnostics: TransformationDiagnostic[] = [];
        const files = await transformFiles({
          "/main.tsx": `/// <cts-enable />
import { Confidential, pattern } from "commonfabric";
type First<X extends unknown[]> = Confidential<{ first: X[0] }, readonly ["b"]>;
type Sec<A extends unknown[], B extends unknown[]> = Confidential<{ value: First<A>; next?: Sec<B, A> }, readonly ["a"]>;
export default pattern<{ a: Sec<[string, number], [number, string]> }>(({ a }) => ({ a }));`,
        }, {
          types: COMMONFABRIC_TYPES,
          typeCheck: true,
          pipelineDiagnostics: diagnostics,
        });
        const { input, output } = patternSchemas(
          parseModule(files["/main.tsx"]!),
        );
        for (const root of [input, output]) {
          const definitions = (root.$defs ?? {}) as Record<string, Schema>;
          const resolve = (schema: Schema): Schema =>
            typeof schema.$ref === "string"
              ? definitions[schema.$ref.split("/").pop()!]!
              : schema;
          const firsts: unknown[] = [];
          let level = resolve((root.properties as Record<string, Schema>).a!);
          for (let depth = 0; depth < 4; depth++) {
            const properties = level.properties as Record<string, Schema>;
            const value = resolve(properties.value!);
            firsts.push(
              ((value.properties as Record<string, Schema>).first!).type,
            );
            level = resolve(properties.next!);
          }
          expect(firsts).toEqual(["string", "number", "string", "number"]);
        }
        expect(
          diagnostics.filter((diagnostic) =>
            diagnostic.type === "schema-type:unread" ||
            diagnostic.type === "cfc-schema:recursion-limit"
          ),
        ).toEqual([]);
      });

      for (
        const [spelling, outer, levels] of [
          [
            "references to two declarations",
            "Sec<One<U>, Two<U>>",
            ["one:one", "two:two", "one:one", "two:two"],
          ],
          [
            "an optional and a required member",
            "Sec<{ v?: U }, { v: U }>",
            ["v:", "v:v", "v:", "v:v"],
          ],
          [
            "an optional member and one named with the marker",
            'Sec<{ v?: U }, { "v?": U }>',
            ["v:", "v?:v?", "v:", "v?:v?"],
          ],
        ] as const
      ) {
        it(`keeps each level's value in a recursion that swaps ${spelling}, on both sides`, async () => {
          // The two arguments are one argument apart from what their written
          // form says, the declaration a reference names or whether a
          // member is optional, so each level is its own.
          const diagnostics: TransformationDiagnostic[] = [];
          const files = await transformFiles({
            "/main.tsx": `/// <cts-enable />
import { Confidential, pattern } from "commonfabric";
interface One<U> { one: U }
interface Two<U> { two: U }
type Sec<A, B> = Confidential<{ value: A; next?: Sec<B, A> }, readonly ["a"]>;
type Outer<U> = ${outer};
export default pattern<{ a: Outer<string> }>(({ a }) => ({ a }));`,
          }, {
            types: COMMONFABRIC_TYPES,
            typeCheck: true,
            pipelineDiagnostics: diagnostics,
          });
          const { input, output } = patternSchemas(
            parseModule(files["/main.tsx"]!),
          );
          for (const root of [input, output]) {
            const definitions = (root.$defs ?? {}) as Record<string, Schema>;
            const resolve = (schema: Schema): Schema =>
              typeof schema.$ref === "string"
                ? definitions[schema.$ref.split("/").pop()!]!
                : schema;
            const read: string[] = [];
            let level = resolve(
              (root.properties as Record<string, Schema>).a!,
            );
            for (let depth = 0; depth < 4; depth++) {
              const properties = level.properties as Record<string, Schema>;
              const value = resolve(properties.value!);
              read.push(
                Object.keys(value.properties as Schema).join("+") + ":" +
                  ((value.required ?? []) as string[]).join("+"),
              );
              level = resolve(properties.next!);
            }
            expect(read).toEqual([...levels]);
          }
          expect(
            diagnostics.filter((diagnostic) =>
              diagnostic.type === "schema-type:unread" ||
              diagnostic.type === "cfc-schema:recursion-limit"
            ),
          ).toEqual([]);
        });
      }

      it("keeps each level's writer in a recursion that swaps its writer bindings", async () => {
        // `f` and `g` have one type, so each level's instantiation is
        // assignable both ways with the one before, though its writer is the
        // other: a recursion whose arguments hold a `typeof` binding settles
        // only where it meets the same reading again.
        const files = await transformFiles({
          "/main.tsx": `/// <cts-enable />
import { pattern, WriteAuthorizedBy } from "commonfabric";
export function f(x: string): void {}
export function g(x: string): void {}
type Sec<T, A, B> = WriteAuthorizedBy<{ v: T; next?: Sec<T, B, A> }, A>;
export default pattern<{ a: Sec<string, typeof f, typeof g> }>(({ a }) => ({ a }));`,
        }, { types: COMMONFABRIC_TYPES, typeCheck: true });
        const { input } = patternSchemas(parseModule(files["/main.tsx"]!));
        const definitions = (input.$defs ?? {}) as Record<string, Schema>;
        const resolve = (schema: Schema): Schema =>
          typeof schema.$ref === "string"
            ? definitions[schema.$ref.split("/").pop()!]!
            : schema;
        const writers: unknown[] = [];
        let level = resolve((input.properties as Record<string, Schema>).a!);
        for (let depth = 0; depth < 4; depth++) {
          const writer = (level.ifc as Schema).writeAuthorizedBy as Schema;
          writers.push(
            (writer.__ctWriterIdentityOf as { path: string[] }).path[0],
          );
          level = resolve((level.properties as Record<string, Schema>).next!);
        }
        expect(writers).toEqual(["f", "g", "f", "g"]);
      });

      it("reads a recursion through the alias's optional member as its definition", async () => {
        // The result's member is `Sec<string> | undefined`, the `?` adding
        // `undefined` to the type the chain instantiates.
        const files = await transformFiles({
          "/main.tsx": `/// <cts-enable />
import { Confidential, pattern } from "commonfabric";
type Sec<T> = Confidential<{ v: T; next?: Sec<T> }, ["secret"]>;
export default pattern<{ a: Sec<string> }>(({ a }) => ({ a }));`,
        }, { types: COMMONFABRIC_TYPES, typeCheck: true });
        const { input, output } = patternSchemas(
          parseModule(files["/main.tsx"]!),
        );
        // An optional member may read as a union with `undefined`; its
        // definition is the arm holding the reference.
        const resolve = (root: Schema, schema: Schema): Schema => {
          const arm = Array.isArray(schema.anyOf)
            ? (schema.anyOf as Schema[]).find((member) => member.$ref)
            : schema;
          return typeof arm?.$ref === "string"
            ? (root.$defs as Record<string, Schema>)[
              arm.$ref.split("/").pop()!
            ]!
            : schema;
        };
        for (const root of [input, output]) {
          const sec = resolve(
            root,
            (root.properties as Record<string, Schema>).a!,
          );
          const properties = sec.properties as Record<string, Schema>;
          const next = resolve(root, properties.next!);
          expect(properties.v).toEqual({ type: "string" });
          expect((next.properties as Record<string, Schema>).v).toEqual({
            type: "string",
          });
        }
      });

      it("keeps a generic interface a generic scope wrapper alias holds", async () => {
        const files = await transformFiles({
          "/main.tsx": `/// <cts-enable />
import { pattern, PerUser } from "commonfabric";
${BOX}
type Rec<T> = PerUser<Box<T>>;
export default pattern<{ a: Rec<string> }>(({ a }) => ({ a }));`,
        }, { types: COMMONFABRIC_TYPES, typeCheck: true });
        const { input, output } = patternSchemas(
          parseModule(files["/main.tsx"]!),
        );
        const expected = { ...box({ type: "string" }), scope: "user" };
        expect((input.properties as Schema).a).toEqual(expected);
        expect((output.properties as Schema).a).toEqual(expected);
      });

      it("reads a generic declaration's member naming a generic alias as its instantiation", async () => {
        // `value: Inner<U>` is written in `Holder`'s parameter, whose argument
        // is in the type `Holder<string>`, not in the member's syntax.
        const files = await transformFiles({
          "/main.tsx": `/// <cts-enable />
import { Confidential, pattern } from "commonfabric";
type Inner<X> = Confidential<X[], ["inner"]>;
interface Holder<U> { value: Inner<U> }
export default pattern<{ a: Holder<string> }>(({ a }) => ({ a }));`,
        }, { types: COMMONFABRIC_TYPES, typeCheck: true });
        const { input, output } = patternSchemas(
          parseModule(files["/main.tsx"]!),
        );
        const expected = {
          type: "object",
          properties: {
            value: { ...strings, ifc: { confidentiality: ["inner"] } },
          },
          required: ["value"],
        };
        expect((input.properties as Schema).a).toEqual(expected);
        expect((output.properties as Schema).a).toEqual(expected);
      });

      it("reads a generic member's nullable payload as written", async () => {
        // A declared read retains the null arm just as the payload written
        // with the concrete argument in place does.
        const files = await transformFiles({
          "/main.tsx": `/// <cts-enable />
import { Confidential, pattern } from "commonfabric";
type Inner<T> = Confidential<{ v: T } | null, ["secret"]>;
interface Holder<U> { inner: Inner<U> }
export default pattern<{ a: Holder<string> }>(({ a }) => ({ a }));`,
        }, { types: COMMONFABRIC_TYPES, typeCheck: true });
        const { input, output } = patternSchemas(
          parseModule(files["/main.tsx"]!),
        );
        const expected = {
          type: "object",
          properties: {
            inner: {
              anyOf: [
                {
                  type: "object",
                  properties: { v: { type: "string" } },
                  required: ["v"],
                },
                { type: "null" },
              ],
              ifc: { confidentiality: ["secret"] },
            },
          },
          required: ["inner"],
        };
        expect((input.properties as Schema).a).toEqual(expected);
        expect((output.properties as Schema).a).toEqual(expected);
      });

      it("keeps a policy binding that only an argument's syntax names", async () => {
        const files = await transformFiles({
          "/main.tsx": `/// <cts-enable />
import { Confidential, pattern } from "commonfabric";
import type { PolicyOf } from "commonfabric/cfc";
import {
  cfcPattern, exchangeRule, exchangeRules, THIS_POLICY, v,
} from "commonfabric/cfc";
export const release = exchangeRule({
  appliesTo: THIS_POLICY,
  pre: { integrity: [cfcPattern.hasRole(v("user"), THIS_POLICY.subject, "reader")] },
  post: { addAlternatives: [cfcPattern.user(v("user"))] },
});
export const rules = exchangeRules([release]);
${BOX}
type Sec<T> = Confidential<Box<T> | null, ["secret"]>;
export default pattern<{
  a: Sec<Confidential<string, [PolicyOf<typeof rules>]>>;
}>(() => ({}));`,
        }, {
          types: COMMONFABRIC_TYPES,
          typeCheck: true,
          moduleIdentities: new Map([["/main.tsx", "sha256:module"]]),
        });
        const { input } = patternSchemas(parseModule(files["/main.tsx"]!));
        expect((input.properties as Schema).a).toMatchObject({
          anyOf: [
            box({
              type: "string",
              ifc: {
                confidentiality: [{
                  policyRefKind: "module",
                  moduleIdentity: "sha256:module",
                  symbol: "rules",
                }],
              },
            }),
            { type: "null" },
          ],
          ifc: { confidentiality: ["secret"] },
        });
      });

      it("reads a nested label that spreads a parameter as the list its argument writes, on both sides", async () => {
        // The spread element stands for the elements of the argument's list,
        // not for the list as one atom.
        const files = await transformFiles({
          "/main.tsx": `/// <cts-enable />
import { Confidential, pattern } from "commonfabric";
type Outer<L extends readonly unknown[]> = Confidential<
  { inner: Confidential<{ x: string }, readonly [...L, "b"]> },
  ["z"]
>;
export default pattern<{ a: Outer<readonly ["c", "d"]> }>(({ a }) => ({ a }));`,
        }, { types: COMMONFABRIC_TYPES, typeCheck: true });
        const { input, output } = patternSchemas(
          parseModule(files["/main.tsx"]!),
        );
        const expected = {
          type: "object",
          properties: {
            inner: {
              type: "object",
              properties: { x: { type: "string" } },
              required: ["x"],
              ifc: { confidentiality: ["c", "d", "b"] },
            },
          },
          required: ["inner"],
          ifc: { confidentiality: ["z"] },
        };
        expect((input.properties as Schema).a).toEqual(expected);
        expect((output.properties as Schema).a).toEqual(expected);
      });

      for (
        const [a, confidentiality] of [
          ['Tail<readonly ["c", "d"]>', ["c", "d", "b"]],
          ['Lead<readonly ["c", "d"]>', ["b", "c", "d"]],
          ['Named<readonly ["c", "d"]>', ["c", "d", "b"]],
          ['ForwardMore<readonly ["c", "d"]>', ["c", "d", "e", "b"]],
          ['Alternatives<readonly ["c", "d"]>', [{ anyOf: ["c", "d", "b"] }]],
        ] as const
      ) {
        it(`reads the spread in the label of \`${a}\` as the elements of the list it spreads, on both sides`, async () => {
          const files = await transformFiles({
            "/main.tsx": `/// <cts-enable />
import { Confidential, pattern } from "commonfabric";
import type { AnyOf } from "commonfabric/cfc";
type Tail<L extends readonly unknown[]> = Confidential<{ x: string }, readonly [...L, "b"]>;
type Lead<L extends readonly unknown[]> = Confidential<{ x: string }, readonly ["b", ...L]>;
type Named<L extends readonly unknown[]> =
  Confidential<{ x: string }, readonly [...rest: L, last: "b"]>;
type ForwardMore<L extends readonly unknown[]> = Tail<readonly [...L, "e"]>;
type Alternatives<L extends readonly unknown[]> =
  Confidential<{ x: string }, readonly [AnyOf<readonly [...L, "b"]>]>;
export default pattern<{ a: ${a} }>(({ a }) => ({ a }));`,
          }, { types: COMMONFABRIC_TYPES, typeCheck: true });
          const { input, output } = patternSchemas(
            parseModule(files["/main.tsx"]!),
          );
          const expected = {
            type: "object",
            properties: { x: { type: "string" } },
            required: ["x"],
            ifc: { confidentiality },
          };
          expect((input.properties as Schema).a).toEqual(expected);
          expect((output.properties as Schema).a).toEqual(expected);
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

    describe("a default-library alias mapping a labelled type's members", () => {
      // The alias folds the label's carrier into the object it builds, and
      // over a primitive builds an object of its methods. Both sides keep
      // the label and the payload, and neither holds the carrier.
      const secret = { confidentiality: ["secret"] };
      const x = { type: "string" };
      const y = { type: "number" };
      for (
        const [a, expected] of [
          [
            "Readonly<Sec<{ x?: string; y: number }>>",
            {
              type: "object",
              properties: { x, y },
              required: ["y"],
              ifc: secret,
            },
          ],
          [
            "Required<Sec<{ x?: string; y: number }>>",
            {
              type: "object",
              properties: { x, y },
              required: ["x", "y"],
              ifc: secret,
            },
          ],
          [
            'Pick<Sec<{ x?: string; y: number }>, "y">',
            {
              type: "object",
              properties: { y },
              required: ["y"],
              ifc: secret,
            },
          ],
          ["Readonly<Sec<string>>", { type: "string", ifc: secret }],
        ] as const
      ) {
        it(`keeps the label of \`${a}\` on both sides`, async () => {
          const files = await transformFiles({
            "/main.tsx": `/// <cts-enable />
import { Confidential, pattern } from "commonfabric";
type Sec<T> = Confidential<T, ["secret"]>;
export default pattern<{ a: ${a} }>(({ a }) => ({ a }));`,
          }, { types: COMMONFABRIC_TYPES, typeCheck: true });
          const { input, output } = patternSchemas(
            parseModule(files["/main.tsx"]!),
          );
          expect((input.properties as Schema).a).toEqual(expected);
          expect((output.properties as Schema).a).toEqual(expected);
        });
      }

      describe("a user's generic alias of one", () => {
        // The alias is read with each of its parameters as the argument it
        // is given, so both sides read it as the alias it names written out
        // with those arguments in place.

        const schemasOf = async (declarations: string, a: string) => {
          const files = await transformFiles({
            "/main.tsx": `/// <cts-enable />
import { Confidential, pattern } from "commonfabric";
type Sec<T> = Confidential<T, readonly ["a"]>;
${declarations}
export default pattern<{ a: ${a} }>(({ a }) => ({ a }));`,
          }, { types: COMMONFABRIC_TYPES, typeCheck: true });
          const { input, output } = patternSchemas(
            parseModule(files["/main.tsx"]!),
          );
          return {
            input: (input.properties as Schema).a,
            output: (output.properties as Schema).a,
          };
        };

        for (
          const [declarations, a, written, ifc] of [
            [
              'type Select<T extends { x: string }> = Pick<T, "x">;',
              "Select<Sec<{ x: string; y: number }>>",
              'Pick<Sec<{ x: string; y: number }>, "x">',
              { confidentiality: ["a"] },
            ],
            [
              'type Select<L extends readonly unknown[]> = Pick<Confidential<{ x: string; y: number }, L>, "x">;',
              'Select<readonly ["b"]>',
              'Pick<Confidential<{ x: string; y: number }, readonly ["b"]>, "x">',
              { confidentiality: ["b"] },
            ],
            [
              `type Select<T extends { x: string }> = Pick<T, "x">;
type Outer<T extends { x: string }> = Select<Sec<T>>;`,
              "Outer<{ x: string; y: number }>",
              'Pick<Sec<{ x: string; y: number }>, "x">',
              { confidentiality: ["a"] },
            ],
            [
              'type Select<L extends readonly unknown[]> = Pick<Confidential<{ x: string; y: number }, readonly [...L, "b"]>, "x">;',
              'Select<readonly ["c", "d"]>',
              'Pick<Confidential<{ x: string; y: number }, readonly ["c", "d", "b"]>, "x">',
              { confidentiality: ["c", "d", "b"] },
            ],
            [
              'type Select<L extends readonly unknown[]> = Omit<Confidential<{ x: string; y: number }, readonly [...L, "b"]>, "y">;',
              'Select<readonly ["c", "d"]>',
              'Omit<Confidential<{ x: string; y: number }, readonly ["c", "d", "b"]>, "y">',
              { confidentiality: ["c", "d", "b"] },
            ],
          ] as const
        ) {
          it(`reads \`${a}\` as \`${written}\`, on both sides`, async () => {
            const read = await schemasOf(declarations, a);
            const expected = {
              type: "object",
              properties: { x: { type: "string" } },
              required: ["x"],
              ifc,
            };
            expect(read).toEqual({ input: expected, output: expected });
            expect(await schemasOf(declarations, written)).toEqual(read);
          });
        }
      });
    });

    describe("a default-library alias mapping a labelled type the checker builds apart", () => {
      // The alias's value is the type the checker builds from the operand, and
      // its labels the operand's: a recursion through the alias keeps the
      // alias, a tuple its slots, and a pick of a primitive's members is an
      // object. Both sides read alike.
      const secret = { confidentiality: ["secret"] };
      for (
        const [spelling, declarations, check] of [
          [
            "`Partial` over a labelled type still being read",
            "type A = Sec<{ value: string; next?: Partial<A> }>;",
            (next: Schema) => expect(next.required).toBeUndefined(),
          ],
          [
            "`Required` over a labelled type still being read",
            "type A = Sec<{ value?: string; next?: Required<A> }>;",
            (next: Schema) => expect(next.required).toEqual(["value", "next"]),
          ],
          [
            "`Pick` over a labelled type still being read",
            'type A = Sec<{ value: string; secret: number; next?: Pick<A, "value" | "next"> }>;',
            (next: Schema) =>
              expect(Object.keys(next.properties as Schema)).toEqual([
                "value",
                "next",
              ]),
          ],
        ] as const
      ) {
        it(`keeps ${spelling}, on both sides`, async () => {
          const files = await transformFiles({
            "/main.tsx": `/// <cts-enable />
import { Confidential, pattern } from "commonfabric";
type Sec<T> = Confidential<T, ["secret"]>;
${declarations}
export default pattern<{ a: A }>(({ a }) => ({ a }));`,
          }, { types: COMMONFABRIC_TYPES, typeCheck: true });
          const { input, output } = patternSchemas(
            parseModule(files["/main.tsx"]!),
          );
          for (const root of [input, output]) {
            const definitions = (root.$defs ?? {}) as Record<string, Schema>;
            const resolve = (schema: Schema): Schema =>
              typeof schema.$ref === "string"
                ? definitions[schema.$ref.split("/").pop()!]!
                : schema;
            const top = resolve((root.properties as Record<string, Schema>).a!);
            const next = resolve(
              (top.properties as Record<string, Schema>).next!,
            );
            check(next);
            expect(next.ifc).toEqual(secret);
          }
        });
      }

      for (
        const [a, expected] of [
          [
            "Required<Sec<[string | undefined, number?]>>",
            {
              type: "array",
              items: { type: ["number", "string", "undefined"] },
              ifc: secret,
            },
          ],
          [
            'Pick<Sec<string>, "length">',
            {
              type: "object",
              properties: { length: { type: "number" } },
              required: ["length"],
              ifc: secret,
            },
          ],
        ] as const
      ) {
        it(`reads \`${a}\` as the type the checker builds, on both sides`, async () => {
          const files = await transformFiles({
            "/main.tsx": `/// <cts-enable />
import { Confidential, pattern } from "commonfabric";
type Sec<T> = Confidential<T, ["secret"]>;
export default pattern<{ a: ${a} }>(({ a }) => ({ a }));`,
          }, { types: COMMONFABRIC_TYPES, typeCheck: true });
          const { input, output } = patternSchemas(
            parseModule(files["/main.tsx"]!),
          );
          expect((input.properties as Schema).a).toEqual(expected);
          expect((output.properties as Schema).a).toEqual(expected);
        });
      }

      it("keeps the label of a `Pick` in a payload read under bindings, on both sides", async () => {
        const files = await transformFiles({
          "/main.tsx": `/// <cts-enable />
import { Confidential, pattern } from "commonfabric";
type Sec<T> = Confidential<T, ["secret"]>;
type Outer<T> = Confidential<{ inner: Pick<Sec<{ x: T; y: number }>, "x"> }, ["b"]>;
export default pattern<{ a: Outer<string> }>(({ a }) => ({ a }));`,
        }, { types: COMMONFABRIC_TYPES, typeCheck: true });
        const { input, output } = patternSchemas(
          parseModule(files["/main.tsx"]!),
        );
        for (const root of [input, output]) {
          const definitions = (root.$defs ?? {}) as Record<string, Schema>;
          const resolve = (schema: Schema): Schema =>
            typeof schema.$ref === "string"
              ? definitions[schema.$ref.split("/").pop()!]!
              : schema;
          const a = resolve((root.properties as Record<string, Schema>).a!);
          expect((a.properties as Record<string, Schema>).inner!.ifc).toEqual(
            secret,
          );
        }
      });
    });

    describe("an authored alias that shares a label operator's name", () => {
      // Both sides read such an alias as the type its author declared, not as
      // the library's `AnyOf` or `PolicyOf`, with or without a spread beside
      // it.

      for (
        const [declarations, a, confidentiality] of [
          [
            'type AnyOf<T> = "original";',
            'Confidential<{ x: string }, readonly [...CD, AnyOf<readonly ["reader"]>]>',
            ["c", "d", "original"],
          ],
          [
            'type AnyOf<T> = "original";',
            'Confidential<{ x: string }, readonly [AnyOf<readonly ["reader"]>]>',
            ["original"],
          ],
          [
            'type PolicyOf<T> = "plain";',
            "Confidential<{ x: string }, readonly [PolicyOf<typeof rules>]>",
            ["plain"],
          ],
          [
            `type AnyOf<T> = "original";
type Tail<L extends readonly unknown[]> =
  Confidential<{ x: string }, readonly [...L, AnyOf<readonly ["reader"]>]>;`,
            'Tail<readonly ["c"]>',
            ["c", "original"],
          ],
        ] as const
      ) {
        it(`reads \`${a}\` with the alias its author declared, on both sides`, async () => {
          const pipelineDiagnostics: TransformationDiagnostic[] = [];
          const files = await transformFiles({
            "/main.tsx": `/// <cts-enable />
import { Confidential, pattern } from "commonfabric";
type CD = readonly ["c", "d"];
const rules = { name: "r" } as const;
${declarations}
export default pattern<{ a: ${a} }>(({ a }) => ({ a }));`,
          }, {
            types: COMMONFABRIC_TYPES,
            typeCheck: true,
            pipelineDiagnostics,
          });
          const { input, output } = patternSchemas(
            parseModule(files["/main.tsx"]!),
          );
          const expected = {
            type: "object",
            properties: { x: { type: "string" } },
            required: ["x"],
            ifc: { confidentiality },
          };
          expect((input.properties as Schema).a).toEqual(expected);
          expect((output.properties as Schema).a).toEqual(expected);
          expect(pipelineDiagnostics).toEqual([]);
        });
      }
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

  describe("a captured print of a member whose annotation names a binding", () => {
    // A print spells `typeof rules` as the structural type of the value
    // `rules` names, so a capture printed from its type is read as the
    // annotation of the member it captures.

    const policy = {
      type: "https://commonfabric.org/cfc/atom/Policy",
      policyRefKind: "module",
      moduleIdentity: "sha256:rules",
      symbol: "rules",
    };

    /**
     * The schema of `name` in the first `computed()` capture of `/main.tsx`,
     * beside a module declaring the exchange rules `rules`.
     */
    async function captured(
      files: Record<string, string>,
      name: string,
    ): Promise<unknown> {
      const output = await transformFiles({
        "/rules.ts":
          `import { exchangeRule, exchangeRules, THIS_POLICY } from "commonfabric/cfc";
export const neverRelease = exchangeRule({
  appliesTo: THIS_POLICY,
  pre: { integrity: ["never"] },
  post: { dropClause: true },
});
export const rules = exchangeRules([neverRelease]);`,
        ...files,
      }, {
        types: COMMONFABRIC_TYPES,
        typeCheck: true,
        moduleIdentities: new Map([["/rules.ts", "sha256:rules"]]),
      });
      const [capture] = callSchemas(parseModule(output["/main.tsx"]!), "lift");
      return (capture!.properties as Schema)[name];
    }

    it("reads the policy of a value captured whole", async () => {
      expect(
        await captured({
          "/main.tsx":
            `import { computed, pattern, type Confidential } from "commonfabric";
import { type PolicyOf } from "commonfabric/cfc";
import { rules } from "./rules.ts";
interface Secret { a: string; b: string; }
export default pattern<{ secret: Confidential<Secret, [PolicyOf<typeof rules>]> }>(
  ({ secret }) => ({ out: computed(() => JSON.stringify(secret)) }),
);`,
        }, "secret"),
      ).toMatchObject({ ifc: { confidentiality: [policy] } });
    });

    it("reads the policy a declaration's annotation names of a value captured whole as a shorthand property", async () => {
      expect(
        await captured({
          "/main.tsx":
            `import { computed, pattern, type Confidential } from "commonfabric";
import { type PolicyOf } from "commonfabric/cfc";
import { rules } from "./rules.ts";
interface Secret { a: string; b: string; }
export default pattern<{ value: Secret }>(({ value }) => {
  const secret: Confidential<Secret, [PolicyOf<typeof rules>]> = value;
  return { out: computed(() => JSON.stringify({ secret })) };
});`,
        }, "secret"),
      ).toMatchObject({ ifc: { confidentiality: [policy] } });
    });

    it("reads the policy of a value an alias of a nullable union names", async () => {
      expect(
        await captured({
          "/main.tsx":
            `import { computed, pattern, type Confidential } from "commonfabric";
import { type PolicyOf } from "commonfabric/cfc";
import { rules } from "./rules.ts";
interface Secret { a: string; b: string; }
type MaybeSecret = Confidential<Secret, [PolicyOf<typeof rules>]> | undefined;
export default pattern<{ secret: MaybeSecret }>(
  ({ secret }) => ({ out: computed(() => JSON.stringify(secret)) }),
);`,
        }, "secret"),
      ).toMatchObject({
        anyOf: [
          { type: "undefined" },
          { ifc: { confidentiality: [policy] } },
        ],
      });
    });

    describe("an optional member whose annotation writes a union", () => {
      // The member's `?` adds `undefined` to the type its annotation denotes,
      // which the reader of an optional property may also take out again.

      /** The capture schema of `secret`, declared as `declaration`, read whole. */
      const optionalCapture = (declaration: string) =>
        captured({
          "/main.tsx":
            `import { computed, pattern, type Confidential } from "commonfabric";
import { type PolicyOf } from "commonfabric/cfc";
import { rules } from "./rules.ts";
interface Secret { a: string; b: string; }
interface Other { a: string; c: number; }
export default pattern<{ ${declaration} }>(
  ({ secret }) => ({ out: computed(() => JSON.stringify(secret)) }),
);`,
        }, "secret");

      it("reads the policy of a nullable value", async () => {
        expect(
          await optionalCapture(
            "secret?: Confidential<Secret, [PolicyOf<typeof rules>]> | null",
          ),
        ).toMatchObject({
          anyOf: [
            { type: ["null", "undefined"] },
            { ifc: { confidentiality: [policy] } },
          ],
        });
      });

      it("reads the policy of each labeled value the union holds", async () => {
        expect(
          await optionalCapture(
            "secret?: Confidential<Secret, [PolicyOf<typeof rules>]> | Confidential<Other, [PolicyOf<typeof rules>]>",
          ),
        ).toMatchObject({
          anyOf: [
            { type: "undefined" },
            { ifc: { confidentiality: [policy] } },
            { ifc: { confidentiality: [policy] } },
          ],
        });
      });

      it("reads the policy of a value whose annotation writes `undefined`", async () => {
        expect(
          await optionalCapture(
            "secret?: Confidential<Secret, [PolicyOf<typeof rules>]> | undefined",
          ),
        ).toMatchObject({ ifc: { confidentiality: [policy] } });
      });

      it("reads the policy of the members a CFC alias over a union distributes into", async () => {
        // `Confidential<Secret | Other, …>` is one node for two members.
        expect(
          await optionalCapture(
            "secret?: Confidential<Secret | Other, [PolicyOf<typeof rules>]>",
          ),
        ).toMatchObject({
          anyOf: [
            { type: "undefined" },
            { ifc: { confidentiality: [policy] } },
          ],
        });
      });
    });

    it("reads the policy of another pattern's result member", async () => {
      expect(
        await captured({
          "/release.tsx":
            `import { type Confidential, pattern } from "commonfabric";
import { type PolicyOf } from "commonfabric/cfc";
import { rules } from "./rules.ts";
export interface Released {
  message: Confidential<string, readonly [PolicyOf<typeof rules>]>;
}
export default pattern<{ message: string }, Released>(
  ({ message }) => ({ message }),
);`,
          "/main.tsx": `import { computed, pattern } from "commonfabric";
import Release from "./release.tsx";
export default pattern(() => {
  const release = Release({ message: "x" });
  return { same: computed(() => release.message === "x") };
});`,
        }, "release"),
      ).toMatchObject({
        properties: { message: { ifc: { confidentiality: [policy] } } },
      });
    });

    it("reads the policy of an optional member beside its `undefined`", async () => {
      // The `unknown` member sends the capture through the analysis of its
      // node, which reads `message` by its print's type, `undefined` and all.
      expect(
        await captured({
          "/release.tsx":
            `import { type Confidential, pattern } from "commonfabric";
import { type PolicyOf } from "commonfabric/cfc";
import { rules } from "./rules.ts";
export interface Entry { a: string; b: string; }
export interface Released {
  message?: Confidential<Entry, readonly [PolicyOf<typeof rules>]>;
  extra: unknown;
}
export default pattern<{ message?: Entry }, Released>(
  ({ message }) => ({ message, extra: 1 }),
);`,
          "/main.tsx": `import { computed, pattern } from "commonfabric";
import Release from "./release.tsx";
export default pattern(() => {
  const release = Release({});
  return { same: computed(() => release.message === release.extra) };
});`,
        }, "release"),
      ).toMatchObject({
        properties: {
          message: {
            anyOf: [
              { type: "undefined" },
              { ifc: { confidentiality: [policy] } },
            ],
          },
        },
      });
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
                anyOf: [{ $ref: "#/$defs/Sentiment" }, { type: "undefined" }],
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
      const { input: capture } = await liftSchemas(
        `import { computed, pattern, wish, Writable, type PerUser } from "commonfabric";
interface Note { title: string; }
export default pattern<{ x: string }>(() => {
  const found = wish<{ note?: PerUser<Writable<Note>>; count: number }>({
    query: "#note",
    headless: true,
  });
  return { title: computed(() => found.result?.note?.get()?.title) };
});`,
        "found.result?.note",
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
      const { input: capture } = await liftSchemas(
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
        "doc.get().notes",
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

    it("prints the value of a cell inside a printed value, expanded, where the expansion holds an empty tuple", async () => {
      // With empty tuples printable, the cell's value is printed expanded, and
      // keeps its items and default.
      const { input: capture } = await liftSchemas(
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
        "found.result?.entries",
      );

      expect((capture as Schema).properties).toMatchObject({
        found: {
          properties: {
            result: {
              anyOf: [{
                properties: {
                  entries: {
                    type: "array",
                    items: { $ref: "#/$defs/Entry" },
                    default: [],
                    asCell: ["cell"],
                  },
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
      const { input: capture } = await liftSchemas(
        `import { computed, pattern, Writable } from "commonfabric";
type Item =
  | { kind: "a"; x: string; extra: string }
  | { kind: "b"; y: string; extra: string };
export default pattern<{ list: Writable<Item>[] }>(({ list }) => ({
  first: computed(() => list[1]?.get().kind),
}));`,
        "list[1]",
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
      const { input: capture } = await liftSchemas(
        `import { computed, pattern, Writable } from "commonfabric";
declare const tag: unique symbol;
export default pattern<{
  doc: Writable<{ name: string; extra: string; [tag]: number }>;
}>(({ doc }) => ({
  n: computed(() => doc.get().name),
}));`,
        "doc.get().name",
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
      const { input: capture } = await liftSchemas(
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
        "doc.get().notes",
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
      const { input: capture } = await liftSchemas(
        `import { pattern, wish, Writable, type PerUser } from "commonfabric";
interface Named { name: string; }
export default pattern<{ x: string }>(() => {
  const found = wish<Writable<PerUser<Named>>>({ query: "#named", headless: true });
  const name = found.result?.get()?.name;
  return { name };
});`,
        "found.result",
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
