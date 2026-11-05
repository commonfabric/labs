import { assert, assertEquals, assertStringIncludes } from "@std/assert";

import type { TransformationDiagnostic } from "../src/mod.ts";
import { COMMONFABRIC_TYPES } from "./commonfabric-test-types.ts";
import { validateSource } from "./utils.ts";

const CROSS_KIND = "factory-call:cross-kind-union";
const SCHEMA_MISMATCH = "factory-call:schema-mismatch-union";
const UNTRANSFORMABLE = "factory-call:untransformable-symbolic-proxy";
const SPREAD_ARGUMENT = "factory-call:spread-argument";

async function factoryDiagnostics(
  source: string,
): Promise<readonly TransformationDiagnostic[]> {
  const { diagnostics } = await validateSource(source, {
    types: COMMONFABRIC_TYPES,
  });
  return diagnostics.filter((diagnostic) =>
    diagnostic.type.startsWith("factory-call:")
  );
}

function onlyDiagnostic(
  diagnostics: readonly TransformationDiagnostic[],
  type: string,
): TransformationDiagnostic {
  const matching = diagnostics.filter((diagnostic) => diagnostic.type === type);
  assertEquals(matching.length, 1, `expected exactly one ${type} diagnostic`);
  return matching[0]!;
}

Deno.test(
  "symbolic factory call rejects a cross-kind callable union",
  async () => {
    const diagnostics = await factoryDiagnostics(`
      import {
        pattern,
        type HandlerFactory,
        type PatternFactory,
      } from "commonfabric";

      interface Input { value: number }
      interface Output { result: number }
      type Operation =
        | PatternFactory<Input, Output>
        | HandlerFactory<Input, Output>;

      export default pattern<{ operation: Operation; value: number }>((input) => {
        input.operation({ value: input.value });
        return {};
      });
    `);

    const diagnostic = onlyDiagnostic(diagnostics, CROSS_KIND);
    assertStringIncludes(diagnostic.message, "one factory kind");
    assertStringIncludes(diagnostic.message, "Reactive");
    assertStringIncludes(diagnostic.message, "Stream");
  },
);

Deno.test(
  "symbolic same-kind union requires equal normalized input schemas",
  async () => {
    const diagnostics = await factoryDiagnostics(`
      import { pattern, type PatternFactory } from "commonfabric";

      interface Output { result: number }
      type Operation =
        | PatternFactory<{ value: number }, Output>
        | PatternFactory<{ value: number; label?: string }, Output>;

      export default pattern<{ operation: Operation; value: number }>((input) => {
        input.operation({ value: input.value });
        return {};
      });
    `);

    const diagnostic = onlyDiagnostic(diagnostics, SCHEMA_MISMATCH);
    assertStringIncludes(diagnostic.message, "exactly equal normalized");
    assertStringIncludes(diagnostic.message, "input and output schemas");
  },
);

Deno.test(
  "symbolic same-kind union requires equal normalized output schemas",
  async () => {
    const diagnostics = await factoryDiagnostics(`
      import { pattern, type PatternFactory } from "commonfabric";

      interface Input { value: number }
      type Operation =
        | PatternFactory<Input, { numeric: number }>
        | PatternFactory<Input, { textual: string }>;

      export default pattern<{ operation: Operation; value: number }>((input) => {
        input.operation({ value: input.value });
        return {};
      });
    `);

    onlyDiagnostic(diagnostics, SCHEMA_MISMATCH);
  },
);

Deno.test(
  "ambiguous local mutation cannot leave a symbolic factory proxy call intact",
  async () => {
    const diagnostics = await factoryDiagnostics(`
      import { pattern, type PatternFactory } from "commonfabric";

      type Operation = PatternFactory<
        { value: number },
        { result: number }
      >;

      export default pattern<{ operation: Operation; value: number }>((input) => {
        let selected = input.operation;
        if (input.value < 0) selected = input.operation;
        selected({ value: input.value });
        return {};
      });
    `);

    const diagnostic = onlyDiagnostic(diagnostics, UNTRANSFORMABLE);
    assertStringIncludes(diagnostic.message, "cannot be proven live");
    assertStringIncludes(diagnostic.message, "eager pattern input");
  },
);

Deno.test(
  "a symbolic callable union with a non-factory arm fails closed",
  async () => {
    const diagnostics = await factoryDiagnostics(`
      import {
        pattern,
        type FactoryInput,
        type PatternFactory,
        type Reactive,
      } from "commonfabric";

      interface Input { value: number }
      interface Output { result: number }
      type PlainCallable =
        & ((input: FactoryInput<Input>) => Reactive<Output>)
        & { readonly plainCallable: true };
      type Operation = PatternFactory<Input, Output> | PlainCallable;

      export default pattern<{ operation: Operation; value: number }>((input) => {
        input.operation({ value: input.value });
        return {};
      });
    `);

    assert(
      diagnostics.some((diagnostic) => diagnostic.type === UNTRANSFORMABLE),
      "a non-factory callable arm must not suppress the symbolic-proxy diagnostic",
    );
  },
);

Deno.test(
  "a symbolic factory call rejects tuple spread input instead of shifting helper arguments",
  async () => {
    const diagnostics = await factoryDiagnostics(`
      import { pattern, type PatternFactory } from "commonfabric";

      interface Input { value: number }
      interface Output { result: number }

      export default pattern<{
        operation: PatternFactory<Input, Output>;
        args: [Input];
      }>((input) => {
        input.operation(...input.args);
        return {};
      });
    `);

    const diagnostic = onlyDiagnostic(diagnostics, SPREAD_ARGUMENT);
    assertStringIncludes(diagnostic.message, "exactly one explicit argument");
  },
);
