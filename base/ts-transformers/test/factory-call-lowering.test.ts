import { assert, assertEquals } from "@std/assert";
import ts from "typescript";

import { COMMONFABRIC_TYPES } from "./commonfabric-test-types.ts";
import { callsNamed, literalToValue, parseModule } from "./transformed-ast.ts";
import { transformFiles, transformSource } from "./utils.ts";

const SOURCE = `
import { pattern, type PatternFactory } from "commonfabric";

type Operation = PatternFactory<
  { value: number },
  { doubled: number }
>;

const liveOperation = pattern<{ value: number }, { doubled: number }>(
  ({ value }) => ({ doubled: value * 2 }),
);

export default pattern<{
  operation: Operation;
  value: number;
}>((input) => {
  const direct = liveOperation({ value: input.value });
  const fromInput = input.operation({ value: input.value });
  const alias = input.operation;
  const fromAlias = alias({ value: input.value });
  return { direct, fromInput, fromAlias };
});
`;

function isInvokeFactoryCall(call: ts.CallExpression): boolean {
  return ts.isPropertyAccessExpression(call.expression) &&
    ts.isIdentifier(call.expression.expression) &&
    call.expression.expression.text === "__cfHelpers" &&
    call.expression.name.text === "invokeFactory";
}

Deno.test(
  "factory call lowering keeps live factories direct and lowers eager input aliases symbolically",
  async () => {
    const output = await transformSource(SOURCE, {
      types: COMMONFABRIC_TYPES,
      typeCheck: true,
    });
    const root = parseModule(output);

    assertEquals(
      callsNamed(root, "liveOperation").length,
      1,
      "the live module-scoped factory call must stay on the direct path",
    );

    const symbolicCalls = callsNamed(root, "invokeFactory").filter(
      isInvokeFactoryCall,
    );
    assertEquals(
      symbolicCalls.length,
      2,
      "the eager input call and its local alias must both use invokeFactory",
    );

    for (const call of symbolicCalls) {
      assertEquals(call.arguments.length, 3);
      const expected = literalToValue(call.arguments[2]!);
      assert(
        typeof expected === "object" && expected !== null &&
          !Array.isArray(expected),
      );
      assertEquals((expected as Record<string, unknown>).kind, "pattern");
    }
  },
);

Deno.test(
  "a factory imported from another authored module stays on the live direct path",
  async () => {
    const output = await transformFiles({
      "/factory-dependency.ts": `
        import type { PatternFactory } from "commonfabric";
        export declare const importedOperation: PatternFactory<
          { value: number },
          { result: number }
        >;
      `,
      "/test.tsx": `
        import { pattern } from "commonfabric";
        import { importedOperation } from "./factory-dependency.ts";

        export default pattern<{ value: number }>((input) => ({
          result: importedOperation({ value: input.value }),
        }));
      `,
    }, {
      types: COMMONFABRIC_TYPES,
      typeCheck: true,
    });

    const root = parseModule(output["/test.tsx"]!);
    assertEquals(callsNamed(root, "importedOperation").length, 1);
    assertEquals(callsNamed(root, "invokeFactory").length, 0);
  },
);
