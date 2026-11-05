import { assert, assertEquals } from "@std/assert";
import ts from "typescript";

import { COMMONFABRIC_TYPES } from "./commonfabric-test-types.ts";
import {
  callsNamed,
  hasKeyPathRead,
  literalToValue,
  parseModule,
} from "./transformed-ast.ts";
import { transformSource } from "./utils.ts";

const FAMILIES = [
  ["map", "mapWithPattern", "({ element, index, array, offset })"],
  [
    "filter",
    "filterWithPattern",
    "element + index + array.length > offset",
  ],
  [
    "flatMap",
    "flatMapWithPattern",
    "[element + index + array.length + offset]",
  ],
] as const;

function sourceFor(
  family: (typeof FAMILIES)[number][0],
  body: string,
  captured: boolean,
): string {
  const input = captured
    ? "{ items: number[]; offset: number }"
    : "{ items: number[] }";
  const argument = captured ? "({ items, offset })" : "({ items })";
  const callbackBody = captured
    ? body
    : family === "map"
    ? "({ element, index, array })"
    : family === "filter"
    ? "element + index + array.length > 0"
    : "[element + index + array.length]";
  return `
    import { pattern } from "commonfabric";
    export default pattern<${input}>(${argument} => ({
      result: items.${family}((element, index, array) => ${callbackBody}),
    }));
  `;
}

function schemaProperties(expression: ts.Expression): string[] {
  const schema = literalToValue(expression) as {
    properties?: Record<string, unknown>;
  };
  return Object.keys(schema.properties ?? {}).sort();
}

function findPatternForPublicListInput(
  root: ts.SourceFile,
): ts.CallExpression {
  const patternCall = callsNamed(root, "pattern").find((call) => {
    if (call.arguments.length !== 3 || !call.arguments[1]) return false;
    try {
      return schemaProperties(call.arguments[1]).includes("element");
    } catch {
      return false;
    }
  });
  assert(patternCall, root.getFullText());
  return patternCall;
}

for (const [family, lowered, capturedBody] of FAMILIES) {
  Deno.test(`${family} lowers captures through one bound PatternFactory`, async () => {
    const output = await transformSource(
      sourceFor(family, capturedBody, true),
      { types: COMMONFABRIC_TYPES },
    );
    const root = parseModule(output);
    const loweredCalls = callsNamed(root, lowered);
    assertEquals(loweredCalls.length, 1, output);
    const loweredCall = loweredCalls[0]!;
    assertEquals(loweredCall.arguments.length, 1, output);

    const curryCalls = callsNamed(root, "curry");
    assertEquals(curryCalls.length, 1, output);
    assertEquals(loweredCall.arguments[0], curryCalls[0]);
    const curryCall = curryCalls[0]!;
    assert(ts.isPropertyAccessExpression(curryCall.expression), output);
    assert(ts.isIdentifier(curryCall.expression.expression), output);
    assert(curryCall.expression.expression.text.startsWith("__cfPattern_"));
    assertEquals(curryCall.arguments.length, 1, output);
    const captures = curryCall.arguments[0];
    assert(captures && ts.isObjectLiteralExpression(captures), output);
    assert(
      captures.properties.some((property) =>
        ts.isPropertyAssignment(property) &&
        ts.isIdentifier(property.name) && property.name.text === "offset"
      ),
      output,
    );

    const carriers = callsNamed(root, "withPatternParamsSchema");
    assertEquals(carriers.length, 1, output);
    const carrier = carriers[0]!;
    assertEquals(carrier.arguments.length, 2, output);
    const callback = carrier.arguments[0];
    assert(
      callback &&
        (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)),
      output,
    );
    assertEquals(callback.parameters.length, 2, output);
    assert(ts.isIdentifier(callback.parameters[0]!.name), output);
    const privateParam = callback.parameters[1]!.name;
    assert(ts.isObjectBindingPattern(privateParam), output);
    assert(
      privateParam.elements.some((element) =>
        ts.isIdentifier(element.name) && element.name.text === "offset"
      ),
      output,
    );
    for (const field of ["element", "index", "array"]) {
      assert(hasKeyPathRead(callback.body, field), output);
    }

    const basePattern = findPatternForPublicListInput(root);
    assertEquals(basePattern.arguments.length, 3, output);
    assertEquals(basePattern.arguments[0], carrier);
    assertEquals(
      schemaProperties(basePattern.arguments[1]!),
      ["array", "element", "index"],
      output,
    );
    assertEquals(
      schemaProperties(carrier.arguments[1]!),
      ["offset"],
      output,
    );
  });

  Deno.test(`${family} keeps a capture-free PatternFactory uncurried`, async () => {
    const output = await transformSource(sourceFor(family, "", false), {
      types: COMMONFABRIC_TYPES,
    });
    const root = parseModule(output);
    const loweredCalls = callsNamed(root, lowered);
    assertEquals(loweredCalls.length, 1, output);
    assertEquals(loweredCalls[0]!.arguments.length, 1, output);
    assert(ts.isIdentifier(loweredCalls[0]!.arguments[0]!), output);
    assert(loweredCalls[0]!.arguments[0]!.text.startsWith("__cfPattern_"));
    assertEquals(callsNamed(root, "curry").length, 0, output);
    assertEquals(callsNamed(root, "withPatternParamsSchema").length, 0, output);

    const basePattern = findPatternForPublicListInput(root);
    assertEquals(
      schemaProperties(basePattern.arguments[1]!),
      ["array", "element", "index"],
      output,
    );
    const callback = basePattern.arguments[0];
    assert(
      callback &&
        (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)),
      output,
    );
    assertEquals(callback.parameters.length, 1, output);
  });
}

Deno.test("reactive array thisArg fails closed instead of becoming node params", async () => {
  const diagnostics: Array<{ type: string; message: string }> = [];
  const output = await transformSource(
    `
      import { pattern } from "commonfabric";
      export default pattern<{ items: number[] }>(({ items }) => ({
        result: items.map((element) => element, { ignored: true }),
      }));
    `,
    {
      types: COMMONFABRIC_TYPES,
      pipelineDiagnostics: diagnostics as never[],
    },
  );

  assert(
    diagnostics.some((diagnostic) =>
      diagnostic.type === "array-method:this-arg-unsupported" &&
      diagnostic.message.includes("thisArg")
    ),
    JSON.stringify(diagnostics, null, 2),
  );
  assertEquals(callsNamed(parseModule(output), "mapWithPattern").length, 0);
});
