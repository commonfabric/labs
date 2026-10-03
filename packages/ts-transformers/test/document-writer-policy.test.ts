import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import ts from "typescript";

import { COMMONFABRIC_TYPES } from "./commonfabric-test-types.ts";
import {
  callSchemas,
  literalToValue,
  parseModule,
  patternSchemas,
} from "./transformed-ast.ts";
import type { TransformationDiagnostic } from "../src/mod.ts";
import { transformFiles, transformSource } from "./utils.ts";

const PRELUDE = `/// <cts-enable />
import { Cfc, CurrentPrincipal, Default, RepresentsCurrentUser, UI, Writable, WriteAuthorizedBy, cell, computed, handler, pattern, schema as schemaOf, toSchema, wish } from "commonfabric";
const setName = handler<{ name: string }, { name: Writable<string> }>((event, { name }) => { name.set(event.name); });
type Owned<T, B> = RepresentsCurrentUser<Cfc<WriteAuthorizedBy<T, B>, { ownerPrincipal: CurrentPrincipal }>>;
`;

/** The policy the cases protect fields with, written in place. */
const POLICY = "WriteAuthorizedBy<string, typeof setName>";

/**
 * A type reaching `POLICY` where no syntax names its writer, so a schema that
 * defines a document fails on it and one that views a document drops it.
 */
const UNREAD = `{ byId: { [key: string]: ${POLICY} } }`;

/**
 * What became of a writer policy a document's schema reaches: its claim is in
 * the schema, its compilation fails as `cfc-write-authorized-by:unread`, or
 * neither, which leaves the document writable by anyone.
 */
type Outcome = "kept" | "refused" | "dropped";

const isUnreadWriter = (diagnostic: TransformationDiagnostic) =>
  diagnostic.type === "cfc-write-authorized-by:unread" &&
  diagnostic.severity === "error";

/** Whether `diagnostic` reports a schema reference that could not be followed. */
const isUnfollowedReference = (diagnostic: TransformationDiagnostic) =>
  diagnostic.message.includes("could not be read back");

const holdsClaim = (schema: unknown) =>
  JSON.stringify(schema ?? null).includes('"writeAuthorizedBy"');

async function transform(
  source: string,
): Promise<{ root: ts.SourceFile; diagnostics: TransformationDiagnostic[] }> {
  const diagnostics: TransformationDiagnostic[] = [];
  const root = parseModule(
    await transformSource(`${PRELUDE}${source}`, {
      types: COMMONFABRIC_TYPES,
      typeCheck: true,
      pipelineDiagnostics: diagnostics,
    }),
  );
  return { root, diagnostics };
}

/** The schema each cell constructor or factory call in `root` creates its cell with. */
function creationSchemas(root: ts.SourceFile): unknown[] {
  const schemas: unknown[] = [];
  const visit = (node: ts.Node) => {
    const callee = ts.isNewExpression(node) || ts.isCallExpression(node)
      ? node.expression.getText(root)
      : undefined;
    if (
      callee && /^(Writable|Writable\.of|cell)$/.test(callee) &&
      (node as ts.CallExpression | ts.NewExpression).arguments?.[1]
    ) {
      schemas.push(
        literalToValue(
          (node as ts.CallExpression | ts.NewExpression).arguments![1]!,
        ),
      );
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return schemas;
}

/** The input schema of the pattern `root` exports by default. */
function inputSchema(root: ts.SourceFile): unknown {
  return defaultPatternSchemas(root)[0];
}

/** The input and result schemas of the pattern `root` exports by default. */
function defaultPatternSchemas(root: ts.SourceFile): unknown[] {
  const call = root.statements.filter(ts.isExportAssignment).map((statement) =>
    statement.expression
  ).find(ts.isCallExpression);
  return call
    ? call.arguments.slice(1).map((argument) => literalToValue(argument))
    : [];
}

function outcome(
  { diagnostics }: { diagnostics: TransformationDiagnostic[] },
  schemas: unknown[],
): Outcome {
  if (diagnostics.some(isUnreadWriter)) return "refused";
  return schemas.some(holdsClaim) ? "kept" : "dropped";
}

describe("document writer policy", () => {
  describe("an authored pattern's input", () => {
    // The input schema is what the pattern's argument document stores its
    // policy envelope from, so a writer it reaches is either in it or fails
    // compilation; it never goes missing.

    const shapes: readonly (readonly [string, string, string])[] = [
      ["a generic alias", "type Box<T> = { value: T };", `Box<${POLICY}>`],
      [
        "a generic interface",
        "interface Box<T> { value: T }",
        `Box<${POLICY}>`,
      ],
      [
        "a generic class",
        "class Box<T> { value!: T }",
        `{ box: Box<${POLICY}> }`,
      ],
      [
        "an interface's generic base",
        `interface Base<T> { value: T }\ninterface In extends Base<${POLICY}> {}`,
        "In",
      ],
      ["`Record`", "", `{ byId: Record<string, ${POLICY}> }`],
      [
        "a generic alias of `Record`",
        "type Dict<T> = Record<string, T>;",
        `{ byId: Dict<${POLICY}> }`,
      ],
      ["an index signature", "", `{ byId: { [key: string]: ${POLICY} } }`],
      ["a tuple", "", `{ pair: [${POLICY}] }`],
      [
        "a generic alias of a tuple",
        "type Tup<T> = [T];",
        `{ pair: Tup<${POLICY}> }`,
      ],
      [
        "a generic alias of `Array`",
        "type List<T> = Array<T>;",
        `{ items: List<${POLICY}> }`,
      ],
      [
        "a generic alias of `ReadonlyArray`",
        "type List<T> = ReadonlyArray<T>;",
        `{ items: List<${POLICY}> }`,
      ],
      [
        "a generic nullable alias",
        "type Maybe<T> = T | null;",
        `{ name: Maybe<${POLICY}> }`,
      ],
      [
        "a `Default` around a generic alias",
        "type Box<T> = { value: T };",
        `{ box?: Default<Box<${POLICY}>, { value: "" }> }`,
      ],
      [
        "an alias of the whole input",
        `type Box<T> = { value: T };\ntype In = Box<${POLICY}>;`,
        "In",
      ],
      [
        "an owner policy in a generic alias",
        "type Box<T> = { value: T };",
        "Box<Owned<string, typeof setName>>",
      ],
      ["`NonNullable`", "", `{ name: NonNullable<${POLICY} | undefined> }`],
      [
        "a default-library alias over the policy",
        "",
        "{ box: Readonly<WriteAuthorizedBy<{ a: string }, typeof setName>> }",
      ],
      [
        "a default-library alias over a named policy alias",
        "type Protected = WriteAuthorizedBy<{ a: string }, typeof setName>;",
        "{ box: Readonly<Protected> }",
      ],
    ];

    for (const [reach, declarations, input] of shapes) {
      it(`keeps or refuses a writer reached through ${reach}`, async () => {
        const result = await transform(`${declarations}
export default pattern<${input}>((input) => ({ input }));`);

        expect(outcome(result, [inputSchema(result.root)])).not.toBe(
          "dropped",
        );
      });
    }
  });

  describe("a schema the author wrote with `toSchema`", () => {
    // Written where SchemaInjection would otherwise inject one, it defines
    // the same document, written in place or through a constant.

    it("refuses a writer a pattern's input schema reads where no syntax names it", async () => {
      const result = await transform(`
export default pattern((input: ${UNREAD}) => ({ input }), toSchema<${UNREAD}>());`);

      expect(outcome(result, [inputSchema(result.root)])).toBe("refused");
    });

    for (
      const [which, input, output] of [
        ["input", UNREAD, "{ value: string }"],
        ["result", "{ value: string }", UNREAD],
      ] as const
    ) {
      it(`refuses a writer a pattern's ${which} schema, written beside the other, reads where no syntax names it`, async () => {
        const result = await transform(`
export default pattern(
  (_: { value: string }) => ({ value: "" }),
  toSchema<${input}>(),
  toSchema<${output}>(),
);`);

        expect(outcome(result, defaultPatternSchemas(result.root)))
          .toBe("refused");
      });
    }

    it("refuses a writer the callback's return annotation reads where no syntax names it, beside an authored input schema", async () => {
      const result = await transform(`
export default pattern(
  (_: { value: string }): ${UNREAD} => ({ byId: {} }),
  toSchema<{ value: string }>(),
);`);

      expect(outcome(result, defaultPatternSchemas(result.root).slice(1)))
        .toBe("refused");
    });

    for (
      const creation of [
        "new Writable",
        "Writable.of",
      ] as const
    ) {
      it(`refuses a writer the schema of a cell \`${creation}\` creates reads where no syntax names it`, async () => {
        const result = await transform(`
export default pattern<{}>(() => {
  const a = ${creation}({ byId: {} }, toSchema<${UNREAD}>()).for("a");
  return { a };
});`);

        expect(outcome(result, creationSchemas(result.root))).toBe("refused");
      });
    }

    for (
      const [how, declaration, reference] of [
        ["a constant", `const schema = toSchema<${UNREAD}>();`, "schema"],
        [
          "a constant's property",
          `const schemas = { input: toSchema<${UNREAD}>() } as const;`,
          "schemas.input",
        ],
        [
          "a constant bound to a constant",
          `const generated = toSchema<${UNREAD}>();\nconst schema = generated;`,
          "schema",
        ],
        [
          "a property of a constant bound to an object literal",
          `const generated = { input: toSchema<${UNREAD}>() };\nconst schemas = generated;`,
          "schemas.input",
        ],
        [
          "a nested property",
          `const schemas = { outer: { input: toSchema<${UNREAD}>() } };`,
          "schemas.outer.input",
        ],
        [
          "a property a spread holds",
          `const base = { input: toSchema<${UNREAD}>() };\nconst schemas = { ...base, other: 1 };`,
          "schemas.input",
        ],
        [
          "a function written in the program that returns it",
          `const make = () => toSchema<${UNREAD}>();`,
          "make()",
        ],
        [
          "a function that wraps its argument",
          "const wrap = (schema: any) => ({ ...schema, $defs: { ...schema.$defs } });",
          `wrap(toSchema<${UNREAD}>())`,
        ],
        [
          "a function given a callback beside it",
          "const visit = <T,>(schema: T, _each: (value: T) => void) => schema;",
          `visit(toSchema<${UNREAD}>(), () => {})`,
        ],
        [
          "a library function that returns its argument",
          "",
          `schemaOf(toSchema<${UNREAD}>())`,
        ],
        [
          "a conditional",
          "const pick = true as boolean;",
          `pick ? toSchema<${UNREAD}>() : toSchema<${UNREAD}>()`,
        ],
        [
          "a schema literal holding a `toSchema` call",
          `const schema = { type: "object", properties: { byId: toSchema<${UNREAD}>() } } as const;`,
          "schema",
        ],
      ] as const
    ) {
      it(`refuses a writer a pattern's input schema, passed through ${how}, reads where no syntax names it`, async () => {
        // The generator reports the writer, from the `toSchema` call the
        // reference was followed to; it is not reported as a reference that
        // could not be followed.
        const result = await transform(`${declaration}
export default pattern((input: ${UNREAD}) => ({ input }), ${reference});`);
        const unread = result.diagnostics.filter(isUnreadWriter);

        expect(unread).not.toEqual([]);
        expect(unread.filter(isUnfollowedReference)).toEqual([]);
      });
    }

    it("reports a schema that cannot be read back to its sources", async () => {
      // A `let` binding may hold any schema by the time the pattern reads it.
      const result = await transform(`
let schema = toSchema<${UNREAD}>();
export default pattern((input: ${UNREAD}) => ({ input }), schema);`);

      expect(
        result.diagnostics.filter(isUnreadWriter).map(isUnfollowedReference),
      ).toEqual([true]);
    });

    for (
      const [how, declaration, reference] of [
        [
          "a constant's property",
          `const schemas = { input: toSchema<{ value: string }>(), other: toSchema<${UNREAD}>() } as const;`,
          "schemas.input",
        ],
        [
          "a property of a constant bound to an object literal",
          `const generated = { input: toSchema<{ value: string }>(), other: toSchema<${UNREAD}>() };\nconst schemas = generated;`,
          "schemas.input",
        ],
        [
          "a nested property",
          `const schemas = { outer: { input: toSchema<{ value: string }>(), other: toSchema<${UNREAD}>() } };`,
          "schemas.outer.input",
        ],
        [
          "a property a spread holds",
          `const base = { input: toSchema<{ value: string }>(), other: toSchema<${UNREAD}>() };\nconst schemas = { ...base };`,
          "schemas.input",
        ],
      ] as const
    ) {
      it(`reports nothing for the members a reference through ${how} does not read`, async () => {
        // Only the member the reference reads defines the document.
        const result = await transform(`${declaration}
export default pattern((input: { value: string }) => ({ input }), ${reference});`);

        expect(result.diagnostics.filter(isUnreadWriter)).toEqual([]);
      });
    }

    it("reports nothing for a schema literal naming a declared constant", async () => {
      // A value of a primitive type holds no schema.
      const result = await transform(`
declare const KEY: "value";
const schema = { type: "object", properties: { value: { type: "string" } }, required: [KEY] } as const;
export default pattern((input: { value: string }) => ({ input }), schema);`);

      expect(result.diagnostics.filter(isUnreadWriter)).toEqual([]);
    });

    it("reports nothing for a schema written out as a literal", async () => {
      const result = await transform(`
const schema = { type: "object", properties: { value: { type: "string" } } } as const;
export default pattern((input: { value: string }) => ({ input }), schema);`);

      expect(result.diagnostics.filter(isUnreadWriter)).toEqual([]);
    });

    for (
      const [what, schemaType, reported] of [
        ["holding a writer policy", `{ value: ${POLICY} }`, true],
        ["holding none", "{ value: string }", false],
      ] as const
    ) {
      it(
        `${
          reported ? "reports" : "reports nothing for"
        } an imported schema ${what}, which its own module generates as one that views a document`,
        async () => {
          const diagnostics: TransformationDiagnostic[] = [];
          await transformFiles({
            "/schemas.ts": `/// <cts-enable />
import { Writable, WriteAuthorizedBy, handler, toSchema } from "commonfabric";
export const setName = handler<{ name: string }, { name: Writable<string> }>((event, { name }) => { name.set(event.name); });
export const inputSchema = toSchema<${schemaType}>();`,
            "/main.tsx": `/// <cts-enable />
import { pattern } from "commonfabric";
import { inputSchema } from "./schemas.ts";
export default pattern((input: { value: string }) => ({ input }), inputSchema);`,
          }, {
            types: COMMONFABRIC_TYPES,
            typeCheck: true,
            pipelineDiagnostics: diagnostics,
          });

          expect(
            diagnostics.filter(isUnreadWriter).map((diagnostic) =>
              diagnostic.message.includes("in another module")
            ),
          ).toEqual(reported ? [true] : []);
        },
      );
    }

    it("refuses a writer the schema of a created cell, passed through a constant, reads where no syntax names it", async () => {
      const result = await transform(`const schema = toSchema<${UNREAD}>();
export default pattern<{}>(() => {
  const a = new Writable({ byId: {} }, schema).for("a");
  return { a };
});`);
      const unread = result.diagnostics.filter(isUnreadWriter);

      expect(unread).not.toEqual([]);
      expect(unread.filter(isUnfollowedReference)).toEqual([]);
    });
  });

  describe("an authored pattern's result", () => {
    // A result type the author wrote is what the result document stores its
    // envelope from. An inferred one views the documents its fields link to.

    it("keeps or refuses a writer an authored result type reaches through a generic alias", async () => {
      const result = await transform(`type Box<T> = { value: T };
export default pattern<{ value: ${POLICY} }, { box: Box<${POLICY}> }>(
  ({ value }) => ({ box: { value } }),
);`);
      const [, output] = defaultPatternSchemas(result.root);

      expect(outcome(result, [
        (output as { properties?: { box?: unknown } })
          ?.properties?.box,
      ])).not.toBe("dropped");
    });

    it("refuses a writer the callback's return annotation reads where no syntax names it", async () => {
      const result = await transform(`
export default pattern<{}>((): ${UNREAD} => ({ byId: {} }));`);

      expect(outcome(result, defaultPatternSchemas(result.root).slice(1)))
        .toBe("refused");
    });

    for (
      const [what, body] of [
        ["returns in place", `return { value: "" as ${POLICY} };`],
        [
          "returns through a constant",
          `const value = "" as ${POLICY};\n  return { value, count: 1 };`,
        ],
        [
          "returns inside an object",
          `return { box: { value: "" } as Box<${POLICY}> };`,
        ],
        [
          "returns as an object the policy protects whole",
          'return { box: { a: "" } as WriteAuthorizedBy<{ a: string }, typeof setName> };',
        ],
        ["returns inside an array", `return { list: ["" as ${POLICY}] };`],
        [
          "returns beside a spread",
          `return { ...{ count: 1 }, value: "" as ${POLICY} };`,
        ],
        [
          "returns inside a spread object",
          `return { ...{ value: "" as ${POLICY} } };`,
        ],
        [
          "returns through a spread constant",
          `const fresh = { value: "" as ${POLICY} };\n  return { ...fresh };`,
        ],
        [
          "returns under a static computed key",
          `return { box: { ["value"]: "" as ${POLICY} } };`,
        ],
        [
          "returns under a static computed key, in an object cast to the policy's type",
          `return { box: { ["value"]: "" } as Box<${POLICY}> };`,
        ],
        [
          "returns nested past the bound on reading it",
          `return { a: { b: { c: { d: { e: { f: { g: { h: { i: { value: "" as ${POLICY} } } } } } } } } } };`,
        ],
        [
          "returns as a constant holding the whole result",
          `const result = { value: "" as ${POLICY} };\n  return result;`,
        ],
        [
          "returns nested twenty objects deep",
          `return { box: ${"{ nested: ".repeat(20)}"" as ${POLICY}${
            " }".repeat(20)
          } };`,
        ],
        [
          "returns through a constant whose declared type is an index signature",
          `const fresh: { [key: string]: ${POLICY} } = { value: "" };\n  return { box: fresh };`,
        ],
        [
          "returns under a dynamic computed key",
          `const key = "value" as string;\n  return { box: { [key]: "" as ${POLICY} } };`,
        ],
        [
          "returns inside an array spread",
          `return { list: [...["" as ${POLICY}]] };`,
        ],
        [
          "returns through a `let` binding",
          `let value = "" as ${POLICY};\n  return { value };`,
        ],
        [
          "returns as a plain function's result",
          `const make = () => "" as ${POLICY};\n  return { value: make() };`,
        ],
      ] as const
    ) {
      it(`refuses a writer read from the type of fresh data an inferred result ${what}`, async () => {
        // The result document holds that data itself, so its schema defines
        // the document there, and the cast names no writer.
        const result = await transform(`type Box<T> = { value: T };
export default pattern<{}>(() => {
  ${body}
});`);

        expect(outcome(result, defaultPatternSchemas(result.root).slice(1)))
          .toBe("refused");
      });
    }

    it("keeps the claim on fresh data whose declaration names its writer, beside a protected value it views", async () => {
      const result = await transform(`
export default pattern<{ owned: Owned<string, typeof setName> }>(({ owned }) => {
  const seed: ${POLICY} = "" as never;
  return { seed, owned };
});`);
      const { output } = patternSchemas(result.root);

      expect(result.diagnostics.filter(isUnreadWriter)).toEqual([]);
      expect(output).toMatchObject({
        properties: {
          seed: {
            ifc: {
              writeAuthorizedBy: {
                __ctWriterIdentityOf: { path: ["setName"] },
              },
            },
          },
        },
      });
      expect(JSON.stringify(output.properties)).not.toMatch(
        /ownerPrincipal|__ctCurrentPrincipal/,
      );
    });

    it("reports nothing for an inferred result that returns a constant bound to its input's field", async () => {
      // The constant links to the input's document, which stores the policy.
      const result = await transform(`
export default pattern<{ value: Owned<string, typeof setName> }>((input) => {
  const value = input.value;
  return { value };
});`);

      expect(result.diagnostics.filter(isUnreadWriter)).toEqual([]);
    });

    it("reports nothing for an inferred result that returns a protected value through a generic alias", async () => {
      const result = await transform(`type Box<T> = { value: T };
export default pattern<{ value: ${POLICY} }>(({ value }) => ({ box: { value } as Box<${POLICY}> }));`);

      expect(result.diagnostics.filter(isUnreadWriter)).toEqual([]);
    });
  });

  describe("a created cell", () => {
    // A cell's schema is what its document stores its policy envelope from.

    for (
      const [what, creation] of [
        ["a constructor", "new Writable(seed)"],
        ["`Writable.of`", "Writable.of(seed)"],
      ] as const
    ) {
      it(`refuses a writer ${what} reads only from its value's type`, async () => {
        // No syntax at the creation names the writer: the cell's type is the
        // value's, inferred.
        const result = await transform(`
export default pattern<{ initial: string }>(({ initial }) => {
  const seed = initial as ${POLICY};
  const x = ${creation}.for("x");
  return { x };
});`);

        expect(outcome(result, creationSchemas(result.root))).toBe("refused");
      });
    }

    it("refuses a writer read from an annotated value's type", async () => {
      const result = await transform(`
export default pattern<{ initial: string }>(({ initial }) => {
  const seed: ${POLICY} = initial as never;
  const x = new Writable(seed).for("x");
  return { x };
});`);

      expect(outcome(result, creationSchemas(result.root))).toBe("refused");
    });

    it("keeps or refuses a writer a generic type argument reaches", async () => {
      const result = await transform(`type Box<T> = { value: T };
export default pattern<{ initial: string }>(({ initial }) => {
  const x = new Writable<Box<${POLICY}>>({ value: "" }).for("x");
  return { x };
});`);

      expect(outcome(result, creationSchemas(result.root))).not.toBe(
        "dropped",
      );
    });

    it("keeps a policy written as the type argument, whose claim the transformer mints", async () => {
      const result = await transform(`
export default pattern<{ initial: string }>(({ initial }) => {
  const a = new Writable<${POLICY}>("").for("a");
  const b = Writable.of<${POLICY}>("").for("b");
  const c = cell<${POLICY}>("");
  return { a, b, c };
});`);

      expect(result.diagnostics.filter(isUnreadWriter)).toEqual([]);
      const schemas = creationSchemas(result.root);
      expect(schemas).toHaveLength(3);
      for (const schema of schemas) {
        expect(schema).toMatchObject({
          ifc: {
            writeAuthorizedBy: { __ctWriterIdentityOf: { path: ["setName"] } },
          },
        });
      }
    });
  });

  describe("a policy written as a cell's type argument, whose claim the transformer mints", () => {
    // The generator is handed the payload's node, and reports the root
    // writer it cannot read there; the claim answers it.

    it("keeps a policy over a nullable payload, whose alias the checker drops", async () => {
      // `null & carrier` is `never`, so the checker reduces the policy's type
      // to `string & carrier`, which carries no alias name to read it by.
      const result = await transform(`
export default pattern<{ initial: string }>(({ initial }) => {
  const a = new Writable<WriteAuthorizedBy<string | null, typeof setName>>(null as never).for("a");
  const b = Writable.of<WriteAuthorizedBy<{ text: string } | undefined, typeof setName>>(undefined as never).for("b");
  return { a, b };
});`);

      expect(result.diagnostics.filter(isUnreadWriter)).toEqual([]);
      const schemas = creationSchemas(result.root);
      expect(schemas).toHaveLength(2);
      for (const schema of schemas) {
        expect(schema).toMatchObject({
          ifc: {
            writeAuthorizedBy: { __ctWriterIdentityOf: { path: ["setName"] } },
          },
        });
      }
    });

    it("keeps the owner and the claim naming the current principal that its payload carries, in a created cell and in a wish", async () => {
      // With the writer the transformer supplies, the policy is read whole.
      const owned =
        "WriteAuthorizedBy<RepresentsCurrentUser<Cfc<string, { ownerPrincipal: CurrentPrincipal }>>, typeof setName>";
      const result = await transform(`
export default pattern<{}>(() => {
  const a = new Writable<${owned}>("").for("a");
  const b = Writable.of<${owned}>("").for("b");
  const found = wish<${owned}>({ query: "#found" });
  return { a, b, found };
});`);
      const ownerPolicy = {
        ifc: {
          ownerPrincipal: { __ctCurrentPrincipal: true },
          addIntegrity: [{ subject: { __ctCurrentPrincipal: true } }],
          writeAuthorizedBy: { __ctWriterIdentityOf: { path: ["setName"] } },
        },
      };

      expect(result.diagnostics.filter(isUnreadWriter)).toEqual([]);
      const schemas = creationSchemas(result.root);
      expect(schemas).toHaveLength(2);
      for (const schema of schemas) expect(schema).toMatchObject(ownerPolicy);
      expect(callSchemas(result.root, "wish")).toMatchObject([ownerPolicy]);
    });

    it("refuses a second writer over a nullable payload, read from its type", async () => {
      // The root policy's writer is the one the transformer supplies; the
      // policy under `NonNullable` is read from its type alone.
      const result = await transform(`
const setOther = handler<{ name: string }, { name: Writable<string> }>((event, { name }) => { name.set(event.name); });
export default pattern<{}>(() => {
  const a = new Writable<WriteAuthorizedBy<NonNullable<WriteAuthorizedBy<string, typeof setOther> | undefined> | null, typeof setName>>(null as never).for("a");
  return { a };
});`);

      expect(outcome(result, [])).toBe("refused");
    });

    it("refuses a writer its payload reaches where no syntax names it", async () => {
      // Only the root policy's writer is the transformer's to supply.
      const result = await transform(`
export default pattern<{ initial: string }>(({ initial }) => {
  const a = new Writable<WriteAuthorizedBy<{ inner: { [key: string]: ${POLICY} } }, typeof setName>>({ inner: {} }).for("a");
  return { a };
});`);

      expect(outcome(result, [])).toBe("refused");
    });
  });

  describe("an owner policy a view reads in part", () => {
    // Without its writer, an owner, or a claim naming the current principal,
    // refuses every write against it, its own writer's included. A view
    // leaves them out with the writer, as the document it reads stores the
    // whole policy.

    const holdsPrincipalClaims = (schema: unknown) =>
      /ownerPrincipal|__ctCurrentPrincipal/.test(
        JSON.stringify(schema ?? null),
      );

    it("leaves them out of a computed's result, read from its type, and keeps the whole policy its input reads", async () => {
      const result = await transform(
        `type ProfileOut = { bio: Owned<string, typeof setName> };
export default pattern<{}>(() => {
  const profileWish = wish<ProfileOut>({ query: "#profile" });
  const bio = computed(() => profileWish.result!.bio);
  return { bio };
});`,
      );

      expect(result.diagnostics.filter(isUnreadWriter)).toEqual([]);
      const [input, output] = callSchemas(result.root, "lift");
      expect(holdsPrincipalClaims(output)).toBe(false);
      // The input reaches `ProfileOut`'s declaration, which names the writer.
      expect(input).toMatchObject({
        $defs: {
          ProfileOut: {
            properties: {
              bio: {
                ifc: {
                  ownerPrincipal: { __ctCurrentPrincipal: true },
                  writeAuthorizedBy: {
                    __ctWriterIdentityOf: { path: ["setName"] },
                  },
                },
              },
            },
          },
        },
      });
      expect(holdsClaim(callSchemas(result.root, "wish"))).toBe(true);
    });

    it("leaves them out of an inferred result, and keeps the whole policy in the input", async () => {
      const result = await transform(`
export default pattern<{ value: Owned<string, typeof setName> }>(({ value }) => ({ value }));`);
      const { input, output } = patternSchemas(result.root);

      expect(result.diagnostics.filter(isUnreadWriter)).toEqual([]);
      expect(holdsPrincipalClaims(output)).toBe(false);
      expect(input).toMatchObject({
        properties: {
          value: {
            ifc: {
              ownerPrincipal: { __ctCurrentPrincipal: true },
              writeAuthorizedBy: {
                __ctWriterIdentityOf: { path: ["setName"] },
              },
            },
          },
        },
      });
    });
  });

  describe("a schema that views a document", () => {
    // The document a view reads stores its own envelope, so a writer the
    // view's schema reads from a type alone leaves only the view without it.

    it("reports nothing for a wished value, a computed's capture of it, or a list it maps", async () => {
      const result = await transform(`type Box<T> = { value: T };
interface Found { box: Box<${POLICY}>; list: Box<${POLICY}>[] }
export default pattern<{}>(() => {
  const found = wish<Found>({ query: "#found" });
  const value = computed(() => found.result?.box.value);
  return {
    value,
    [UI]: <div>{found.result?.list.map((item) => <span>{item.value}</span>)}</div>,
  };
});`);

      expect(result.diagnostics.filter(isUnreadWriter)).toEqual([]);
    });

    it("reports nothing for a handler's state", async () => {
      const result = await transform(`type Box<T> = { value: T };
export const bump = handler<void, { box: Writable<Box<${POLICY}>> }>(
  (_, { box }) => { box.set({ value: "x" }); },
);
export default pattern<{}>(() => ({}));`);

      expect(result.diagnostics.filter(isUnreadWriter)).toEqual([]);
    });
  });
});
