import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import ts from "typescript";

import { COMMONFABRIC_TYPES } from "./commonfabric-test-types.ts";
import { callsNamed, literalToValue, parseModule } from "./transformed-ast.ts";
import { transformSource } from "./utils.ts";

/** The schema option on the single emitted `generateObject()` call. */
async function generatedSchema(source: string): Promise<unknown> {
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
  const options = calls[0]!.arguments[0]!;
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

  it("emits the default any schema when the contextual type supplies no result type", async () => {
    expect(
      await generatedSchema(
        `export default pattern(() => ({
  state: generateObject({ prompt: "Return an object" }),
}));`,
      ),
    ).toBe(true);
  });
});
