import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import ts from "typescript";

import { COMMONFABRIC_TYPES } from "./commonfabric-test-types.ts";
import { callsNamed, literalToValue, parseModule } from "./transformed-ast.ts";
import { transformSource } from "./utils.ts";

/** The options argument on the single emitted `generateObject()` call. */
async function generatedOptions(source: string): Promise<ts.Expression> {
  const output = await transformSource(
    `import {
      generateObject, pattern,
      type BuiltInLLMGenerateObjectState, type Reactive,
    } from "commonfabric";
${source}`,
    { types: COMMONFABRIC_TYPES, typeCheck: true },
  );
  const calls = callsNamed(parseModule(output), "generateObject");
  expect(calls).toHaveLength(1);
  return calls[0]!.arguments[0]!;
}

/** The schema option on the single emitted `generateObject()` call. */
async function generatedSchema(source: string): Promise<unknown> {
  const options = await generatedOptions(source);
  if (!ts.isObjectLiteralExpression(options)) {
    throw new Error("Expected generateObject options to be an object literal");
  }
  const schemas = options.properties.filter(ts.isPropertyAssignment).filter(
    (property) =>
      ts.isIdentifier(property.name) && property.name.text === "schema",
  );
  expect(schemas.length).toBeLessThanOrEqual(1);
  return schemas[0] ? literalToValue(schemas[0].initializer) : undefined;
}

describe("generateObject schema inference", () => {
  const titleSchema = {
    type: "object",
    properties: { title: { type: "string" } },
    required: ["title"],
  };

  for (
    const { context, source } of [
      {
        context: "a state annotation",
        source: `const state: BuiltInLLMGenerateObjectState<{ title: string }> =
  generateObject({ prompt: "Return a title" });`,
      },
      {
        context: "an aliased reactive state",
        source: `type State<T> = Reactive<BuiltInLLMGenerateObjectState<T>>;
const state: State<{ title: string }> =
  generateObject({ prompt: "Return a title" });`,
      },
      {
        context: "a function return type",
        source:
          `export function makeState(): BuiltInLLMGenerateObjectState<{ title: string }> {
  return generateObject({ prompt: "Return a title" });
}`,
      },
      {
        context: "an argument type",
        source:
          `declare function consume(state: BuiltInLLMGenerateObjectState<{ title: string }>): void;
consume(generateObject({ prompt: "Return a title" }));`,
      },
      {
        context: "a state annotation with non-literal options",
        source: `const options = { prompt: "Return a title" };
const state: BuiltInLLMGenerateObjectState<{ title: string }> = generateObject(options);`,
      },
    ]
  ) {
    it(`injects the result schema inferred from ${context}`, async () => {
      expect(await generatedSchema(source)).toEqual(titleSchema);
    });
  }

  it("uses the explicit type argument within a broader contextual type", async () => {
    expect(
      await generatedSchema(
        `const state: BuiltInLLMGenerateObjectState<unknown> =
  generateObject<{ title: string }>({ prompt: "Return a title" });`,
      ),
    ).toEqual(titleSchema);
  });

  it("emits unknown for an unresolved contextual type parameter", async () => {
    expect(
      await generatedSchema(
        `export function makeState<T>(): BuiltInLLMGenerateObjectState<T> {
  return generateObject({ prompt: "Return an object" });
}`,
      ),
    ).toEqual({ type: "unknown" });
  });

  it("leaves an authored schema in place when the result has a contextual type", async () => {
    expect(
      await generatedSchema(
        `const state: BuiltInLLMGenerateObjectState<{ title: string }> =
  generateObject({ prompt: "Return a title", schema: { type: "object" } as const });`,
      ),
    ).toEqual({ type: "object" });
  });

  it("leaves a call without a contextual type without an injected schema", async () => {
    expect(
      await generatedSchema(
        `const state = generateObject({ prompt: "Return an object" });`,
      ),
    ).toBeUndefined();
  });

  it("omits an inferred schema when the contextual type supplies no result type", async () => {
    expect(
      await generatedSchema(
        `export default pattern(() => ({
  state: generateObject({ prompt: "Return an object" }),
}));`,
      ),
    ).toBeUndefined();
  });

  it("omits an inferred schema when destructuring supplies no result type", async () => {
    expect(
      await generatedSchema(
        `const { result } = generateObject({ prompt: "Return an object" });`,
      ),
    ).toBeUndefined();
  });

  it("omits an inferred schema when the contextual result type is any", async () => {
    expect(
      await generatedSchema(
        `const state: BuiltInLLMGenerateObjectState<any> =
  generateObject({ prompt: "Return an object" });`,
      ),
    ).toBeUndefined();
  });

  describe("authored schema precedence", () => {
    for (
      const [form, argument] of [
        ["an options variable", "config"],
        ["spread options", "{ ...config }"],
        [
          "an asserted literal",
          '{ prompt: "Return a title", schema: authoredSchema } as any',
        ],
        [
          "a quoted key",
          '{ prompt: "Return a title", "schema": authoredSchema }',
        ],
        [
          "a computed key",
          '{ prompt: "Return a title", [schemaKey]: authoredSchema }',
        ],
      ]
    ) {
      for (
        const [context, binding, typeArguments] of [
          [
            "an inferred result type",
            "const state: BuiltInLLMGenerateObjectState<{ title: string }>",
            "",
          ],
          ["destructuring without a result type", "const { result }", ""],
          ["an explicit result type", "const state", "<{ title: string }>"],
        ]
      ) {
        it(`preserves a schema from ${form} with ${context}`, async () => {
          const options = await generatedOptions(`
const authoredSchema = { type: "object", properties: { title: { type: "string", minLength: 5 } } } as const;
const config = { prompt: "Return a title", schema: authoredSchema };
const schemaKey = "schema";
export function makeState() {
  ${binding} = generateObject${typeArguments}(${argument});
}`);
          // Evaluate only the emitted options with known test values so spread
          // order and every spelling of the schema key follow JavaScript rules.
          const printed = ts.createPrinter().printNode(
            ts.EmitHint.Expression,
            options,
            options.getSourceFile(),
          );
          const { outputText } = ts.transpileModule(
            `const options = (${printed});`,
            { compilerOptions: { target: ts.ScriptTarget.ESNext } },
          );
          const authoredSchema = {
            type: "object",
            properties: { title: { type: "string", minLength: 5 } },
          };
          const config = { prompt: "Return a title", schema: authoredSchema };
          const evaluated = new Function(
            "config",
            "authoredSchema",
            "schemaKey",
            `${outputText}\nreturn options;`,
          )(config, authoredSchema, "schema");

          expect(evaluated).toEqual(config);
          expect(evaluated.schema).toBe(authoredSchema);
        });
      }
    }
  });
});
