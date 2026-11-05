import { assertEquals, assertStringIncludes } from "@std/assert";

import { COMMONFABRIC_TYPES } from "./commonfabric-test-types.ts";
import { validateSource } from "./utils.ts";

const CALLABLE_CAPTURE = "ses-callback:callable-capture";

async function callableCaptureDiagnostics(source: string) {
  const { diagnostics } = await validateSource(source, {
    types: COMMONFABRIC_TYPES,
  });
  return diagnostics.filter((diagnostic) =>
    diagnostic.type === CALLABLE_CAPTURE
  );
}

Deno.test("nested pattern closure params admit all three first-class factory kinds", async () => {
  const source = await Deno.readTextFile(
    new URL(
      "./fixtures/closures/nested-pattern-capture-matrix.input.tsx",
      import.meta.url,
    ),
  );

  assertEquals(await callableCaptureDiagnostics(source), []);
});

Deno.test("nested patterns still reject arbitrary JavaScript function captures", async () => {
  const diagnostics = await callableCaptureDiagnostics(`
    import { pattern } from "commonfabric";

    export default pattern<{ value: number }>(({ value }) => {
      const adjust = (candidate: number) => candidate + 1;
      return {
        child: pattern<{ value: number }>(({ value: childValue }) => ({
          value: adjust(childValue) + value,
        })),
      };
    });
  `);

  assertEquals(diagnostics.length, 1);
  assertStringIncludes(diagnostics[0]!.message, "adjust");
});

Deno.test("a user callable named PatternFactory does not spoof first-class factory semantics", async () => {
  const diagnostics = await callableCaptureDiagnostics(`
    import { pattern } from "commonfabric";

    type PatternFactory<T, R> = (input: T) => R;

    export default pattern<{
      operation: PatternFactory<{ value: number }, { result: number }>;
    }>(({ operation }) => ({
      child: pattern(() => ({ operation })),
    }));
  `);

  assertEquals(diagnostics.length, 1);
  assertStringIncludes(diagnostics[0]!.message, "operation");
});

Deno.test("deprecated patternTool does not suppress nested factory closure conversion", async () => {
  const diagnostics = await callableCaptureDiagnostics(`
    import {
      pattern,
      patternTool,
      type PatternFactory,
    } from "commonfabric";

    type Operation = PatternFactory<
      { value: number },
      { result: number }
    >;

    export default pattern<{ operation: Operation }>(({ operation }) => ({
      tool: patternTool(pattern(() => ({ operation }))),
    }));
  `);

  assertEquals(diagnostics, []);
});

Deno.test("a non-nested pattern callback does not gain the factory-capture exception", async () => {
  const diagnostics = await callableCaptureDiagnostics(`
    import { pattern, type PatternFactory } from "commonfabric";

    type Operation = PatternFactory<
      { value: number },
      { result: number }
    >;

    function makePattern(operation: Operation) {
      return pattern(() => ({ operation }));
    }

    export default makePattern;
  `);

  assertEquals(diagnostics.length, 1);
  assertStringIncludes(diagnostics[0]!.message, "operation");
});
