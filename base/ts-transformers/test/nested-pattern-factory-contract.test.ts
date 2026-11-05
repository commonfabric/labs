import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import type { JSONSchema } from "@commonfabric/api";
import { factorySchemasEqual } from "@commonfabric/data-model-schema";
import ts from "typescript";

import { COMMONFABRIC_TYPES } from "./commonfabric-test-types.ts";
import {
  callsNamed,
  emittedSchemas,
  literalToValue,
  parseModule,
} from "./transformed-ast.ts";
import { transformFiles, transformSource, validateSource } from "./utils.ts";

interface PatternContract {
  kind: "pattern";
  argumentSchema: JSONSchema;
  resultSchema: JSONSchema;
}

function patternCalls(root: ts.SourceFile): ts.CallExpression[] {
  return callsNamed(root, "pattern").filter((call) =>
    call.arguments.length === 3
  );
}

function basePatternCalls(root: ts.SourceFile): ts.CallExpression[] {
  return patternCalls(root).filter((call) =>
    ts.isPropertyAccessExpression(call.expression) &&
    call.expression.name.text === "pattern"
  );
}

function rootPatternCall(root: ts.SourceFile): ts.CallExpression {
  const call = patternCalls(root).find((candidate) =>
    ts.isIdentifier(candidate.expression) &&
    candidate.expression.text === "pattern"
  );
  assert(call, root.getFullText());
  return call;
}

function callContract(call: ts.CallExpression): PatternContract {
  return {
    kind: "pattern",
    argumentSchema: literalToValue(call.arguments[1]!) as JSONSchema,
    resultSchema: literalToValue(call.arguments[2]!) as JSONSchema,
  };
}

function assertPatternContractsEqual(
  actual: PatternContract,
  expected: PatternContract,
): void {
  assertEquals(actual.kind, expected.kind);
  assert(
    factorySchemasEqual(actual.argumentSchema, expected.argumentSchema),
    Deno.inspect({
      actual: actual.argumentSchema,
      expected: expected.argumentSchema,
    }),
  );
  assert(
    factorySchemasEqual(actual.resultSchema, expected.resultSchema),
    Deno.inspect({
      actual: actual.resultSchema,
      expected: expected.resultSchema,
    }),
  );
}

function resultProperties(call: ts.CallExpression): Record<string, unknown> {
  const schema = literalToValue(call.arguments[2]!) as {
    properties: Record<string, unknown>;
  };
  return schema.properties;
}

function propertyContract(value: unknown): PatternContract {
  return (value as { asFactory: PatternContract }).asFactory;
}

function collectPropertyContracts(value: unknown): PatternContract[] {
  const found: PatternContract[] = [];
  const visit = (entry: unknown): void => {
    if (Array.isArray(entry)) {
      for (const child of entry) visit(child);
      return;
    }
    if (!entry || typeof entry !== "object") return;
    const record = entry as Record<string, unknown>;
    if (record.asFactory) {
      const contract = record.asFactory as PatternContract;
      if (contract.kind === "pattern") found.push(contract);
    }
    for (const child of Object.values(record)) visit(child);
  };
  visit(value);
  return found;
}

function requiredFields(schema: unknown): readonly string[] {
  return (schema as { required?: readonly string[] }).required ?? [];
}

function resolvedPropertyAlternatives(
  schema: JSONSchema,
  property: string,
): readonly unknown[] {
  const object = schema as {
    properties: Record<string, unknown>;
    $defs?: Record<string, unknown>;
  };
  const value = object.properties[property] as { anyOf?: readonly unknown[] };
  const alternatives = value.anyOf ?? [value];
  return alternatives.map((alternative) => {
    const ref = (alternative as { $ref?: unknown }).$ref;
    if (typeof ref !== "string" || !ref.startsWith("#/$defs/")) {
      return alternative;
    }
    return object.$defs?.[ref.slice("#/$defs/".length)];
  });
}

Deno.test("nested factory schemas match the hoisted base contract exactly", async () => {
  const output = await transformSource(
    `
import { pattern } from "commonfabric";

export default pattern<{ prefix: string }>(({ prefix }) => ({
  child: pattern<{ suffix: string }>(({ suffix }) => ({ prefix, suffix })),
}));
`,
    { types: COMMONFABRIC_TYPES },
  );
  const root = parseModule(output);
  const calls = patternCalls(root);
  const base = calls.find((call) =>
    call.arguments[0] &&
    callsNamed(call.arguments[0], "withPatternParamsSchema").length === 1
  );
  assert(base, output);
  const outer = calls.find((call) =>
    ts.isIdentifier(call.expression) && call.expression.text === "pattern"
  );
  assert(outer, output);

  const baseArgumentSchema = literalToValue(base.arguments[1]!);
  const baseResultSchema = literalToValue(base.arguments[2]!);
  const outerResultSchema = literalToValue(outer.arguments[2]!) as {
    properties: {
      child: {
        asFactory: {
          argumentSchema: unknown;
          resultSchema: unknown;
        };
      };
    };
  };
  const childContract = outerResultSchema.properties.child.asFactory;

  assertEquals(childContract.argumentSchema, baseArgumentSchema);
  assertEquals(childContract.resultSchema, baseResultSchema);
});

Deno.test("nested factory result contracts retain captured factory leaves exactly", async () => {
  const output = await transformSource(
    `
import {
  pattern,
  type Cell,
  type HandlerFactory,
  type ModuleFactory,
  type PatternFactory,
} from "commonfabric";

interface Input { value: number }
interface Output { result: number }

export default pattern<{
  cell: Cell<string>;
  config: { label: string };
  patternOperation: PatternFactory<Input, Output>;
  moduleOperation: ModuleFactory<Input, Output>;
  handlerOperation: HandlerFactory<Input, Output>;
  reserved: string;
}>(({
  cell,
  config,
  patternOperation,
  moduleOperation,
  handlerOperation,
  reserved,
}) => ({
  child: pattern<Input>(({ value }) => ({
    value,
    cell,
    label: config.label,
    patternOperation,
    moduleOperation,
    handlerOperation,
    reserved,
  })),
}));
`,
    { types: COMMONFABRIC_TYPES, typeCheck: true },
  );
  const root = parseModule(output);
  const base = basePatternCalls(root).find((call) =>
    callsNamed(call.arguments[0]!, "withPatternParamsSchema").length === 1
  );
  assert(base, output);

  const baseContract = callContract(base);
  const nestedContract = propertyContract(
    resultProperties(rootPatternCall(root)).child,
  );

  assertEquals(nestedContract.kind, baseContract.kind, output);
  assert(
    factorySchemasEqual(
      nestedContract.argumentSchema,
      baseContract.argumentSchema,
    ),
    output,
  );
  assertEquals(nestedContract.resultSchema, baseContract.resultSchema, output);
  assert(
    factorySchemasEqual(nestedContract.resultSchema, baseContract.resultSchema),
    output,
  );
});

Deno.test("anonymous union factory captures retain every exact alternative", async () => {
  const output = await transformSource(
    `
import {
  pattern,
  type Cell,
  type ModuleFactory,
  type PatternFactory,
} from "commonfabric";

interface Input { value: number }
interface TextOutput { text: string }
interface CountOutput { count: number }

export default pattern<{
  cell: Cell<string>;
  sameKind:
    | PatternFactory<Input, TextOutput>
    | PatternFactory<Input, CountOutput>;
  crossKind:
    | PatternFactory<Input, TextOutput>
    | ModuleFactory<Input, TextOutput>;
  nullable: PatternFactory<Input, TextOutput> | null;
  optional?: PatternFactory<Input, TextOutput>;
}>(({ cell, sameKind, crossKind, nullable, optional }) => ({
  child: pattern<Input>(({ value }) => ({
    value,
    cell,
    sameKind,
    crossKind,
    nullable,
    optional,
  })),
}));
`,
    { types: COMMONFABRIC_TYPES, typeCheck: true },
  );
  const root = parseModule(output);
  const base = basePatternCalls(root).find((call) =>
    callsNamed(call.arguments[0]!, "withPatternParamsSchema").length === 1
  );
  assert(base, output);

  const baseContract = callContract(base);
  const nestedContract = propertyContract(
    resultProperties(rootPatternCall(root)).child,
  );
  assert(
    factorySchemasEqual(nestedContract.resultSchema, baseContract.resultSchema),
    output,
  );

  const properties = (baseContract.resultSchema as {
    properties: Record<string, { anyOf: readonly Record<string, unknown>[] }>;
  }).properties;
  assertEquals(
    properties.sameKind.anyOf.map((entry) =>
      (entry.asFactory as { kind: string }).kind
    ),
    ["pattern", "pattern"],
    output,
  );
  assertEquals(
    properties.crossKind.anyOf.map((entry) =>
      (entry.asFactory as { kind: string }).kind
    ),
    ["pattern", "module"],
    output,
  );
  assertEquals(properties.nullable.anyOf.at(-1), { type: "null" }, output);
  assertEquals(properties.optional.anyOf[0], { type: "undefined" }, output);
});

Deno.test("authored parent input factory metadata survives nested capture", async () => {
  const output = await transformSource(
    `
import { pattern, type Cell, type PatternFactory } from "commonfabric";

interface Input { value: number }
interface Output { result: number }

const parentInputSchema = {
  type: "object",
  properties: {
    cell: { type: "string", asCell: ["cell"] },
    operation: {
      asFactory: {
        kind: "pattern",
        argumentSchema: {
          type: "object",
          description: "authored operation input",
          properties: { value: { type: "number", minimum: 0 } },
          required: ["value"],
        },
        resultSchema: {
          type: "object",
          description: "authored operation output",
          properties: { result: { type: "number", maximum: 10 } },
          required: ["result"],
        },
      },
    },
  },
  required: ["cell", "operation"],
} as const;

export default pattern<{
  cell: Cell<string>;
  operation: PatternFactory<Input, Output>;
}>(({ cell, operation }) => ({
  child: pattern<Input>(({ value }) => ({ value, cell, operation })),
}), parentInputSchema);
`,
    { types: COMMONFABRIC_TYPES, typeCheck: true },
  );
  const root = parseModule(output);
  const base = basePatternCalls(root).find((call) =>
    callsNamed(call.arguments[0]!, "withPatternParamsSchema").length === 1
  );
  assert(base, output);
  const carrier = callsNamed(base.arguments[0]!, "withPatternParamsSchema")[0];
  assert(carrier, output);

  const expected = {
    asFactory: {
      kind: "pattern",
      argumentSchema: {
        type: "object",
        description: "authored operation input",
        properties: { value: { type: "number", minimum: 0 } },
        required: ["value"],
      },
      resultSchema: {
        type: "object",
        description: "authored operation output",
        properties: { result: { type: "number", maximum: 10 } },
        required: ["result"],
      },
    },
  };
  const paramsSchema = literalToValue(carrier.arguments[1]!) as {
    properties: Record<string, unknown>;
  };
  const baseOperation = (callContract(base).resultSchema as {
    properties: Record<string, unknown>;
  }).properties.operation;
  const nestedOperation = (propertyContract(
    resultProperties(rootPatternCall(root)).child,
  ).resultSchema as { properties: Record<string, unknown> }).properties
    .operation;

  assertEquals(paramsSchema.properties.operation, expected, output);
  assertEquals(baseOperation, expected, output);
  assertEquals(nestedOperation, expected, output);
});

Deno.test("authored same-kind anyOf and oneOf metadata survive exactly", async () => {
  for (const unionKeyword of ["anyOf", "oneOf"] as const) {
    const output = await transformSource(
      `
import { pattern, type Cell, type PatternFactory } from "commonfabric";

interface Input { value: number }
interface TextOutput { text: string }
interface CountOutput { count: number }

const parentInputSchema = {
  type: "object",
  properties: {
    cell: { type: "string", asCell: ["cell"] },
    operation: {
      ${unionKeyword}: [{
        asFactory: {
          kind: "pattern",
          argumentSchema: {
            type: "object",
            description: "text operation input",
            properties: { value: { type: "number", minimum: 0 } },
            required: ["value"],
          },
          resultSchema: {
            type: "object",
            description: "text operation output",
            properties: { text: { type: "string", minLength: 2 } },
            required: ["text"],
          },
        },
      }, {
        asFactory: {
          kind: "pattern",
          argumentSchema: {
            type: "object",
            description: "count operation input",
            properties: { value: { type: "number", maximum: 100 } },
            required: ["value"],
          },
          resultSchema: {
            type: "object",
            description: "count operation output",
            properties: {
              count: { type: "number", minimum: 1, maximum: 9 },
            },
            required: ["count"],
          },
        },
      }],
    },
  },
  required: ["cell", "operation"],
} as const;

export default pattern<{
  cell: Cell<string>;
  operation:
    | PatternFactory<Input, TextOutput>
    | PatternFactory<Input, CountOutput>;
}>(({ cell, operation }) => ({
  child: pattern<Input>(({ value }) => ({ value, cell, operation })),
}), parentInputSchema);
`,
      { types: COMMONFABRIC_TYPES, typeCheck: true },
    );
    const root = parseModule(output);
    const base = basePatternCalls(root).find((call) =>
      callsNamed(call.arguments[0]!, "withPatternParamsSchema").length === 1
    );
    assert(base, output);
    const carrier = callsNamed(
      base.arguments[0]!,
      "withPatternParamsSchema",
    )[0];
    assert(carrier, output);

    const expected = {
      anyOf: [{
        asFactory: {
          kind: "pattern",
          argumentSchema: {
            type: "object",
            description: "text operation input",
            properties: { value: { type: "number", minimum: 0 } },
            required: ["value"],
          },
          resultSchema: {
            type: "object",
            description: "text operation output",
            properties: { text: { type: "string", minLength: 2 } },
            required: ["text"],
          },
        },
      }, {
        asFactory: {
          kind: "pattern",
          argumentSchema: {
            type: "object",
            description: "count operation input",
            properties: { value: { type: "number", maximum: 100 } },
            required: ["value"],
          },
          resultSchema: {
            type: "object",
            description: "count operation output",
            properties: {
              count: { type: "number", minimum: 1, maximum: 9 },
            },
            required: ["count"],
          },
        },
      }],
    } as const satisfies JSONSchema;
    const paramsSchema = literalToValue(carrier.arguments[1]!) as {
      properties: Record<string, JSONSchema>;
    };
    const baseContract = callContract(base);
    const baseOperation = (baseContract.resultSchema as {
      properties: Record<string, JSONSchema>;
    }).properties.operation;
    const nestedContract = propertyContract(
      resultProperties(rootPatternCall(root)).child,
    );
    const nestedOperation = (nestedContract.resultSchema as {
      properties: Record<string, JSONSchema>;
    }).properties.operation;

    assertEquals(paramsSchema.properties.operation, expected, output);
    assertEquals(baseOperation, expected, output);
    assertEquals(nestedOperation, expected, output);
    assert(
      factorySchemasEqual(
        nestedContract.resultSchema,
        baseContract.resultSchema,
      ),
      output,
    );
  }
});

Deno.test("authored nullable factory metadata survives nested capture", async () => {
  const output = await transformSource(
    `
import { pattern, type Cell, type PatternFactory } from "commonfabric";

interface Input { value: number }
interface Output { result: number }

const parentInputSchema = {
  type: "object",
  properties: {
    cell: { type: "string", asCell: ["cell"] },
    operation: {
      anyOf: [{
        asFactory: {
          kind: "pattern",
          argumentSchema: {
            type: "object",
            description: "nullable operation input",
            properties: { value: { type: "number", minimum: 0 } },
            required: ["value"],
          },
          resultSchema: {
            type: "object",
            description: "nullable operation output",
            properties: { result: { type: "number", maximum: 10 } },
            required: ["result"],
          },
        },
      }, { type: "null" }],
    },
  },
  required: ["cell", "operation"],
} as const;

export default pattern<{
  cell: Cell<string>;
  operation: PatternFactory<Input, Output> | null;
}>(({ cell, operation }) => ({
  child: pattern<Input>(({ value }) => ({ value, cell, operation })),
}), parentInputSchema);
`,
    { types: COMMONFABRIC_TYPES, typeCheck: true },
  );
  const root = parseModule(output);
  const base = basePatternCalls(root).find((call) =>
    callsNamed(call.arguments[0]!, "withPatternParamsSchema").length === 1
  );
  assert(base, output);
  const carrier = callsNamed(base.arguments[0]!, "withPatternParamsSchema")[0];
  assert(carrier, output);

  const expected = {
    anyOf: [{
      asFactory: {
        kind: "pattern",
        argumentSchema: {
          type: "object",
          description: "nullable operation input",
          properties: { value: { type: "number", minimum: 0 } },
          required: ["value"],
        },
        resultSchema: {
          type: "object",
          description: "nullable operation output",
          properties: { result: { type: "number", maximum: 10 } },
          required: ["result"],
        },
      },
    }, { type: "null" }],
  } as const satisfies JSONSchema;
  const paramsSchema = literalToValue(carrier.arguments[1]!) as {
    properties: Record<string, JSONSchema>;
  };
  const baseContract = callContract(base);
  const baseOperation = (baseContract.resultSchema as {
    properties: Record<string, JSONSchema>;
  }).properties.operation;
  const nestedContract = propertyContract(
    resultProperties(rootPatternCall(root)).child,
  );
  const nestedOperation = (nestedContract.resultSchema as {
    properties: Record<string, JSONSchema>;
  }).properties.operation;

  assertEquals(paramsSchema.properties.operation, expected, output);
  assertEquals(baseOperation, expected, output);
  assertEquals(nestedOperation, expected, output);
});

Deno.test("authored nullable factory aliases preserve exact metadata", async () => {
  const output = await transformSource(
    `
import { pattern, type Cell, type PatternFactory } from "commonfabric";

interface Input { value: number }
interface Output { result: number }
type Operation = PatternFactory<Input, Output>;

const parentInputSchema = {
  type: "object",
  properties: {
    cell: { type: "string", asCell: ["cell"] },
    operation: {
      anyOf: [{
        asFactory: {
          kind: "pattern",
          argumentSchema: {
            type: "object",
            description: "aliased nullable input",
            properties: { value: { type: "number", minimum: 7 } },
            required: ["value"],
          },
          resultSchema: {
            type: "object",
            description: "aliased nullable output",
            properties: { result: { type: "number", maximum: 9 } },
            required: ["result"],
          },
        },
      }, { type: "null" }],
    },
  },
  required: ["cell", "operation"],
} as const;

export default pattern<{
  cell: Cell<string>;
  operation: Operation | null;
}>(({ cell, operation }) => ({
  child: pattern<Input>(({ value }) => ({ value, cell, operation })),
}), parentInputSchema);
`,
    { types: COMMONFABRIC_TYPES, typeCheck: true },
  );
  const root = parseModule(output);
  const base = basePatternCalls(root).find((call) =>
    callsNamed(call.arguments[0]!, "withPatternParamsSchema").length === 1
  );
  assert(base, output);
  const carrier = callsNamed(base.arguments[0]!, "withPatternParamsSchema")[0];
  assert(carrier, output);

  const expected = {
    anyOf: [{
      asFactory: {
        kind: "pattern",
        argumentSchema: {
          type: "object",
          description: "aliased nullable input",
          properties: { value: { type: "number", minimum: 7 } },
          required: ["value"],
        },
        resultSchema: {
          type: "object",
          description: "aliased nullable output",
          properties: { result: { type: "number", maximum: 9 } },
          required: ["result"],
        },
      },
    }, { type: "null" }],
  } as const satisfies JSONSchema;
  const paramsSchema = literalToValue(carrier.arguments[1]!) as JSONSchema;
  const baseSchema = callContract(base).resultSchema;
  const nestedSchema = propertyContract(
    resultProperties(rootPatternCall(root)).child,
  ).resultSchema;

  assertEquals(
    resolvedPropertyAlternatives(paramsSchema, "operation"),
    expected.anyOf,
    output,
  );
  assertEquals(
    resolvedPropertyAlternatives(baseSchema, "operation"),
    expected.anyOf,
    output,
  );
  assertEquals(
    resolvedPropertyAlternatives(nestedSchema, "operation"),
    expected.anyOf,
    output,
  );
});

Deno.test("authored mixed factory aliases preserve exact metadata", async () => {
  const output = await transformSource(
    `
import {
  pattern,
  type Cell,
  type HandlerFactory,
  type ModuleFactory,
  type PatternFactory,
} from "commonfabric";

interface Input { value: number }
interface PatternOutput { text: string }
interface ModuleOutput { count: number }
interface HandlerOutput { accepted: boolean }
type PatternOperation = PatternFactory<Input, PatternOutput>;
type ModuleOperation = ModuleFactory<Input, ModuleOutput>;
type HandlerOperation = HandlerFactory<Input, HandlerOutput>;

const parentInputSchema = {
  type: "object",
  properties: {
    cell: { type: "string", asCell: ["cell"] },
    operation: {
      anyOf: [{
        asFactory: {
          kind: "pattern",
          argumentSchema: {
            type: "object",
            description: "aliased pattern input",
            properties: { value: { type: "number", minimum: 1 } },
            required: ["value"],
          },
          resultSchema: {
            type: "object",
            description: "aliased pattern output",
            properties: { text: { type: "string", minLength: 2 } },
            required: ["text"],
          },
        },
      }, {
        asFactory: {
          kind: "module",
          argumentSchema: {
            type: "object",
            description: "aliased module input",
            properties: { value: { type: "number", maximum: 8 } },
            required: ["value"],
          },
          resultSchema: {
            type: "object",
            description: "aliased module output",
            properties: { count: { type: "number", maximum: 5 } },
            required: ["count"],
          },
        },
      }, {
        asFactory: {
          kind: "handler",
          contextSchema: {
            type: "object",
            description: "aliased handler context",
            properties: { value: { type: "number", minimum: 3 } },
            required: ["value"],
          },
          eventSchema: {
            type: "object",
            description: "aliased handler event",
            properties: { accepted: { type: "boolean" } },
            required: ["accepted"],
          },
        },
      }, { type: "null" }],
    },
  },
  required: ["cell", "operation"],
} as const;

export default pattern<{
  cell: Cell<string>;
  operation: PatternOperation | ModuleOperation | HandlerOperation | null;
}>(({ cell, operation }) => ({
  child: pattern<Input>(({ value }) => ({ value, cell, operation })),
}), parentInputSchema);
`,
    { types: COMMONFABRIC_TYPES, typeCheck: true },
  );
  const root = parseModule(output);
  const base = basePatternCalls(root).find((call) =>
    callsNamed(call.arguments[0]!, "withPatternParamsSchema").length === 1
  );
  assert(base, output);
  const carrier = callsNamed(base.arguments[0]!, "withPatternParamsSchema")[0];
  assert(carrier, output);

  const expected = {
    anyOf: [{ type: "null" }, {
      asFactory: {
        kind: "pattern",
        argumentSchema: {
          type: "object",
          description: "aliased pattern input",
          properties: { value: { type: "number", minimum: 1 } },
          required: ["value"],
        },
        resultSchema: {
          type: "object",
          description: "aliased pattern output",
          properties: { text: { type: "string", minLength: 2 } },
          required: ["text"],
        },
      },
    }, {
      asFactory: {
        kind: "module",
        argumentSchema: {
          type: "object",
          description: "aliased module input",
          properties: { value: { type: "number", maximum: 8 } },
          required: ["value"],
        },
        resultSchema: {
          type: "object",
          description: "aliased module output",
          properties: { count: { type: "number", maximum: 5 } },
          required: ["count"],
        },
      },
    }, {
      asFactory: {
        kind: "handler",
        contextSchema: {
          type: "object",
          description: "aliased handler context",
          properties: { value: { type: "number", minimum: 3 } },
          required: ["value"],
        },
        eventSchema: {
          type: "object",
          description: "aliased handler event",
          properties: { accepted: { type: "boolean" } },
          required: ["accepted"],
        },
      },
    }],
  } as const satisfies JSONSchema;
  const paramsSchema = literalToValue(carrier.arguments[1]!) as JSONSchema;
  const baseSchema = callContract(base).resultSchema;
  const nestedSchema = propertyContract(
    resultProperties(rootPatternCall(root)).child,
  ).resultSchema;

  assertEquals(
    resolvedPropertyAlternatives(paramsSchema, "operation"),
    expected.anyOf,
    output,
  );
  assertEquals(
    resolvedPropertyAlternatives(baseSchema, "operation"),
    expected.anyOf,
    output,
  );
  assertEquals(
    resolvedPropertyAlternatives(nestedSchema, "operation"),
    expected.anyOf,
    output,
  );
});

Deno.test("collapsed same-kind authored alternatives diagnose ambiguity", async () => {
  const { diagnostics } = await validateSource(
    `
import { pattern, type Cell, type PatternFactory } from "commonfabric";

interface Input { value: number }
interface Output { result: number }

const firstAlternative = {
  asFactory: {
    kind: "pattern",
    argumentSchema: {
      type: "object",
      properties: { value: { type: "number" } },
      required: ["value"],
    },
    resultSchema: {
      type: "object",
      description: "first",
      properties: { result: { type: "number" } },
      required: ["result"],
    },
  },
} as const;
const secondAlternative = {
  asFactory: {
    kind: "pattern",
    argumentSchema: {
      type: "object",
      properties: { value: { type: "number" } },
      required: ["value"],
    },
    resultSchema: {
      type: "object",
      description: "second",
      properties: { result: { type: "number" } },
      required: ["result"],
    },
  },
} as const;
const parentInputSchema = {
  type: "object",
  properties: {
    cell: { type: "string", asCell: ["cell"] },
    operation: {
      anyOf: [firstAlternative, secondAlternative],
    },
  },
  required: ["cell", "operation"],
} as const;

export default pattern<{
  cell: Cell<string>;
  operation:
    | PatternFactory<Input, Output>
    | PatternFactory<Input, Output>;
}>(({ cell, operation }) => ({
  child: pattern<Input>(({ value }) => ({ value, cell, operation })),
}), parentInputSchema);
`,
    { types: COMMONFABRIC_TYPES },
  );
  const contractDiagnostics = diagnostics.filter((diagnostic) =>
    diagnostic.type ===
      "pattern-factory:ambiguous-authored-union-contract"
  );

  assertEquals(contractDiagnostics.length, 1);
  assertStringIncludes(
    contractDiagnostics[0]!.message,
    "could not be mapped exactly",
  );
});

Deno.test("local aliases and shorthand properties retain exact factory contracts", async () => {
  const output = await transformSource(
    `
import { pattern } from "commonfabric";

export default pattern(() => {
  const child = pattern<{ value: string }>(({ value }) => ({ size: value.length }));
  return { child };
});
`,
    { types: COMMONFABRIC_TYPES },
  );
  const root = parseModule(output);
  const [base] = basePatternCalls(root);
  assert(base, output);

  assertEquals(
    propertyContract(resultProperties(rootPatternCall(root)).child),
    callContract(base),
  );
});

Deno.test("scheduled containers retain imported factory schema annotations", async () => {
  const output = await transformFiles({
    "/test.tsx": `
import { computed, pattern } from "commonfabric";
import { searchWeb } from "./dependency.tsx";

export default pattern(() => {
  const baseTools = { searchWeb: { pattern: searchWeb } };
  const tools = computed(() => ({ ...baseTools }));
  return { tools };
});
`,
    "/dependency.tsx": `
import { computed, ifElse, pattern } from "commonfabric";

/** Search the web for information. */
type SearchQuery = {
  /** The query to search the web for. */
  query: string;
};

export const searchWeb = pattern<SearchQuery>(({ query }) => {
  const pending = computed(() => query.length > 0);
  return ifElse(pending, undefined, {
    cell: query as any,
    error: query as any,
  });
});
`,
  }, {
    types: COMMONFABRIC_TYPES,
    typeCheck: true,
  });
  const dependency = parseModule(output["/dependency.tsx"]!);
  const test = parseModule(output["/test.tsx"]!);
  const [scheduled] = callsNamed(test, "lift");
  assert(scheduled, output["/test.tsx"]);

  const scheduledInputContracts = collectPropertyContracts(
    literalToValue(scheduled.arguments[1]!),
  );
  const scheduledResultContracts = collectPropertyContracts(
    literalToValue(scheduled.arguments[2]!),
  );
  const rootResultContracts = collectPropertyContracts(
    literalToValue(rootPatternCall(test).arguments[2]!),
  );
  assertEquals(scheduledInputContracts.length, 1);
  assertEquals(scheduledResultContracts.length, 1);
  assertEquals(rootResultContracts.length, 1);
  const expected = callContract(rootPatternCall(dependency));
  assertPatternContractsEqual(scheduledInputContracts[0]!, expected);
  assertPatternContractsEqual(scheduledResultContracts[0]!, expected);
  assertPatternContractsEqual(rootResultContracts[0]!, expected);
});

Deno.test("object-container aliases retain nested exact factory contracts", async () => {
  const output = await transformSource(
    `
import { pattern } from "commonfabric";

export default pattern(() => {
  const bag = {
    child: pattern<{ value: string }>(({ value }) => ({ size: value.length })),
  };
  return bag;
});
`,
    { types: COMMONFABRIC_TYPES },
  );
  const root = parseModule(output);
  const [base] = basePatternCalls(root);
  assert(base, output);
  assertEquals(
    propertyContract(resultProperties(rootPatternCall(root)).child),
    callContract(base),
  );
});

Deno.test("selected container members retain exact factory contracts", async () => {
  const output = await transformSource(
    `
import { pattern } from "commonfabric";

export default pattern(() => {
  const bag = {
    child: pattern<{ value: string }>(({ value }) => ({ size: value.length })),
  };
  const tuple = [
    pattern<{ count: number }>(({ count }) => ({ label: String(count) })),
  ] as const;
  const { child: destructured } = bag;
  return {
    property: bag.child,
    element: tuple[0],
    destructured,
  };
});
`,
    { types: COMMONFABRIC_TYPES },
  );
  const root = parseModule(output);
  const bases = basePatternCalls(root);
  const byInput = new Map(
    bases.map((call) => [
      requiredFields(callContract(call).argumentSchema)[0],
      callContract(call),
    ]),
  );
  const properties = resultProperties(rootPatternCall(root));

  assertEquals(propertyContract(properties.property), byInput.get("value"));
  assertEquals(propertyContract(properties.destructured), byInput.get("value"));
  assertEquals(propertyContract(properties.element), byInput.get("count"));
});

Deno.test("conditional containers retain every nested factory contract", async () => {
  const output = await transformSource(
    `
import { pattern } from "commonfabric";

export default pattern<{ enabled: boolean }>(({ enabled }) => {
  const text = {
    child: pattern<{ value: string }>(({ value }) => ({ text: value })),
  };
  const size = {
    child: pattern<{ value: string }>(({ value }) => ({ size: value.length })),
  };
  return enabled ? text : size;
});
`,
    { types: COMMONFABRIC_TYPES },
  );
  const root = parseModule(output);
  const expected = basePatternCalls(root).map(callContract);
  const actual = collectPropertyContracts(
    resultProperties(rootPatternCall(root)).child,
  );

  assertEquals(actual.length, 2, output);
  for (const contract of expected) {
    assert(
      actual.some((candidate) =>
        JSON.stringify(candidate) === JSON.stringify(contract)
      ),
      output,
    );
  }
});

Deno.test("capture-free and zero-input nested factories keep exact contracts", async () => {
  const output = await transformSource(
    `
import { pattern } from "commonfabric";

export default pattern(() => ({
  free: pattern<{ value: string }>(({ value }) => ({ value })),
  zero: pattern(() => ({ ready: true as boolean })),
}));
`,
    { types: COMMONFABRIC_TYPES },
  );
  const root = parseModule(output);
  const bases = basePatternCalls(root);
  assertEquals(bases.length, 2, output);
  const properties = resultProperties(rootPatternCall(root));
  const free = bases.find((call) =>
    requiredFields(callContract(call).argumentSchema).includes("value")
  );
  const zero = bases.find((call) =>
    callContract(call).argumentSchema === false
  );
  assert(free && zero, output);

  assertEquals(propertyContract(properties.free), callContract(free));
  assertEquals(propertyContract(properties.zero), callContract(zero));
});

Deno.test("nested wrapper contracts are exact at both factory boundaries", async () => {
  const output = await transformSource(
    `
import { pattern } from "commonfabric";

export default pattern<{ prefix: string }>(({ prefix }) => ({
  outer: pattern<{ suffix: string }>(({ suffix }) => ({
    inner: pattern<{ value: string }>(({ value }) => ({ prefix, suffix, value })),
  })),
}));
`,
    { types: COMMONFABRIC_TYPES },
  );
  const root = parseModule(output);
  const bases = basePatternCalls(root);
  const outerBase = bases.find((call) =>
    requiredFields(callContract(call).argumentSchema).includes("suffix")
  );
  const innerBase = bases.find((call) =>
    requiredFields(callContract(call).argumentSchema).includes("value")
  );
  assert(outerBase && innerBase, output);

  const rootOuter = propertyContract(
    resultProperties(rootPatternCall(root)).outer,
  );
  assertEquals(rootOuter, callContract(outerBase));
  const nestedInner = propertyContract(resultProperties(outerBase).inner);
  assertEquals(nestedInner, callContract(innerBase));
});

Deno.test("conditional factory unions match both input and output contracts", async () => {
  const output = await transformSource(
    `
import { pattern } from "commonfabric";

export default pattern<{ enabled: boolean }>(({ enabled }) => ({
  child: enabled
    ? pattern<{ left: string }>(({ left }) => ({ value: left }))
    : pattern<{ right: string }>(({ right }) => ({ value: right })),
}));
`,
    { types: COMMONFABRIC_TYPES },
  );
  const root = parseModule(output);
  const expected = basePatternCalls(root).map(callContract);
  assertEquals(expected.length, 2, output);
  const child = resultProperties(rootPatternCall(root)).child as {
    anyOf: Array<{ asFactory: PatternContract }>;
  };
  const actual = child.anyOf.map((entry) => entry.asFactory);

  for (const contract of expected) {
    const required = requiredFields(contract.argumentSchema);
    assert(
      actual.some((candidate) =>
        requiredFields(candidate.argumentSchema)[0] === required[0] &&
        JSON.stringify(candidate.resultSchema) ===
          JSON.stringify(contract.resultSchema)
      ),
      output,
    );
  }
});

Deno.test("same-input conditional alternatives retain distinct output contracts", async () => {
  const output = await transformSource(
    `
import { pattern } from "commonfabric";

export default pattern<{ enabled: boolean }>(({ enabled }) => ({
  child: enabled
    ? pattern<{ value: string }>(({ value }) => ({ text: value }))
    : pattern<{ value: string }>(({ value }) => ({ size: value.length })),
}));
`,
    { types: COMMONFABRIC_TYPES },
  );
  const root = parseModule(output);
  const expected = basePatternCalls(root).map(callContract);
  assertEquals(expected.length, 2, output);
  const actual = collectPropertyContracts(
    resultProperties(rootPatternCall(root)).child,
  );

  assertEquals(actual.length, 2, output);
  for (const contract of expected) {
    assert(
      actual.some((candidate) =>
        JSON.stringify(candidate) === JSON.stringify(contract)
      ),
      output,
    );
  }
});

Deno.test("nested factory metadata keeps text-identical outer contracts distinct", async () => {
  const output = await transformSource(
    `
import { pattern } from "commonfabric";

export default pattern<{ enabled: boolean }>(({ enabled }) => ({
  child: enabled
    ? pattern<{ x: string }>(({ x }) => ({
      inner: pattern<{ value: string }>(({ value }) => ({ text: x + value })),
    }))
    : pattern<{ x: string }>(({ x }) => ({
      inner: pattern<{ value: string }>(({ value }) => ({ size: (x + value).length })),
    })),
}));
`,
    { types: COMMONFABRIC_TYPES },
  );
  const root = parseModule(output);
  const outerBases = basePatternCalls(root).filter((call) =>
    requiredFields(callContract(call).argumentSchema).includes("x")
  );
  assertEquals(outerBases.length, 2, output);
  const child = resultProperties(rootPatternCall(root)).child as {
    anyOf?: Array<{ asFactory: PatternContract }>;
  };
  const actual = child.anyOf?.map((entry) => entry.asFactory) ?? [];

  assertEquals(actual.length, 2, output);
  for (const base of outerBases) {
    assert(
      actual.some((candidate) =>
        JSON.stringify(candidate) === JSON.stringify(callContract(base))
      ),
      output,
    );
  }
});

Deno.test("mixed inline and module factories retain every exact contract", async () => {
  const output = await transformSource(
    `
import { pattern } from "commonfabric";

const Existing = pattern<{ value: string }>(({ value }) => ({ size: value.length }));

export default pattern<{ enabled: boolean }>(({ enabled }) => ({
  child: enabled
    ? pattern<{ value: string }>(({ value }) => ({ text: value }))
    : Existing,
}));
`,
    { types: COMMONFABRIC_TYPES },
  );
  const root = parseModule(output);
  const existing = patternCalls(root).find((call) =>
    ts.isIdentifier(call.expression) &&
    call.expression.text === "pattern" &&
    requiredFields(callContract(call).argumentSchema).includes("value")
  );
  const outer = patternCalls(root).find((call) =>
    ts.isIdentifier(call.expression) &&
    call.expression.text === "pattern" &&
    requiredFields(callContract(call).argumentSchema).includes("enabled")
  );
  const inline = basePatternCalls(root).find((call) =>
    requiredFields(callContract(call).argumentSchema).includes("value")
  );
  assert(existing && outer && inline, output);
  const child = resultProperties(outer).child as {
    anyOf?: Array<{ asFactory: PatternContract }>;
  };
  const actual = child.anyOf?.map((entry) => entry.asFactory) ?? [];

  assertEquals(actual.length, 2, output);
  for (const call of [inline, existing]) {
    assert(
      actual.some((candidate) =>
        JSON.stringify(candidate) === JSON.stringify(callContract(call))
      ),
      output,
    );
  }
});

Deno.test("array and tuple containers retain every exact factory contract", async () => {
  const output = await transformSource(
    `
import { pattern } from "commonfabric";

export default pattern(() => ({
  tuple: [
    pattern<{ left: string }>(({ left }) => ({ value: left })),
    pattern<{ right: number }>(({ right }) => ({ value: String(right) })),
  ] as const,
  array: [
    pattern<{ alpha: string }>(({ alpha }) => ({ value: alpha })),
    pattern<{ beta: number }>(({ beta }) => ({ value: String(beta) })),
  ],
}));
`,
    { types: COMMONFABRIC_TYPES },
  );
  const root = parseModule(output);
  const expected = basePatternCalls(root).map(callContract);
  assertEquals(expected.length, 4, output);
  const properties = resultProperties(rootPatternCall(root));
  const actual = [
    ...collectPropertyContracts(properties.tuple),
    ...collectPropertyContracts(properties.array),
  ];
  assertEquals(actual.length, 4, output);
  for (const contract of expected) {
    assert(
      actual.some((candidate) =>
        JSON.stringify(candidate) === JSON.stringify(contract)
      ),
      output,
    );
  }
});

Deno.test("homogeneous arrays retain every distinct factory output contract", async () => {
  const output = await transformSource(
    `
import { pattern } from "commonfabric";

export default pattern(() => ({
  children: [
    pattern<{ value: string }>(({ value }) => ({ text: value })),
    pattern<{ value: string }>(({ value }) => ({ size: value.length })),
  ],
}));
`,
    { types: COMMONFABRIC_TYPES },
  );
  const root = parseModule(output);
  const expected = basePatternCalls(root).map(callContract);
  assertEquals(expected.length, 2, output);
  const actual = collectPropertyContracts(
    resultProperties(rootPatternCall(root)).children,
  );

  assertEquals(actual.length, 2, output);
  for (const contract of expected) {
    assert(
      actual.some((candidate) =>
        JSON.stringify(candidate) === JSON.stringify(contract)
      ),
      output,
    );
  }
});

Deno.test("explicit result types and typed schema arguments retain canonical contracts", async () => {
  const output = await transformSource(
    `
import { pattern } from "commonfabric";

export default pattern(() => ({
  explicit: pattern<{ value: string }, { size: number }>(
    ({ value }) => ({ size: value.length }),
  ),
  schemas: pattern<{ value: string }>(
    ({ value }) => ({ size: value.length }),
    {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
    },
    {
      type: "object",
      properties: { size: { type: "number" } },
      required: ["size"],
    },
  ),
}));
`,
    { types: COMMONFABRIC_TYPES },
  );
  const root = parseModule(output);
  const bases = basePatternCalls(root);
  assertEquals(bases.length, 2, output);
  const properties = resultProperties(rootPatternCall(root));

  assertEquals(propertyContract(properties.explicit), callContract(bases[0]!));
  assertEquals(propertyContract(properties.schemas), callContract(bases[1]!));
});

Deno.test("typed schema arguments retain authored metadata as the canonical contract", async () => {
  const output = await transformSource(
    `
import { pattern } from "commonfabric";

const Existing = pattern<{ value: string }>(
  ({ value }) => ({ size: value.length }),
  {
    type: "object",
    description: "typed authored input",
    properties: { value: { type: "string", minLength: 2 } },
    required: ["value"],
  } as const,
  {
    type: "object",
    description: "typed authored output",
    properties: { size: { type: "number", minimum: 0 } },
    required: ["size"],
  } as const,
);

export default pattern(() => ({ child: Existing }));
`,
    { types: COMMONFABRIC_TYPES },
  );
  const root = parseModule(output);
  const calls = patternCalls(root).filter((call) =>
    ts.isIdentifier(call.expression) && call.expression.text === "pattern"
  );
  const existing = calls[0];
  const outer = calls.at(-1);
  assert(existing && outer, output);
  const expected: PatternContract = {
    kind: "pattern",
    argumentSchema: {
      type: "object",
      description: "typed authored input",
      properties: { value: { type: "string", minLength: 2 } },
      required: ["value"],
    },
    resultSchema: {
      type: "object",
      description: "typed authored output",
      properties: { size: { type: "number", minimum: 0 } },
      required: ["size"],
    },
  };

  assertEquals(callContract(existing), expected);
  assertEquals(propertyContract(resultProperties(outer).child), expected);
});

Deno.test("module factories retain exact authored schema metadata", async () => {
  const output = await transformSource(
    `
import { lift, pattern } from "commonfabric";

const inputSchema = {
  type: "object",
  description: "module input",
  properties: { value: { type: "string", minLength: 2 } },
  required: ["value"],
} as const;
const outputSchema = {
  type: "object",
  description: "module output",
  properties: { size: { type: "number", minimum: 0 } },
  required: ["size"],
} as const;
const operation = lift(
  (input: { value: string }) => ({ size: input.value.length }),
  inputSchema,
  outputSchema,
);

export default pattern(() => ({ operation }));
`,
    { types: COMMONFABRIC_TYPES },
  );
  const contract = (resultProperties(rootPatternCall(parseModule(output)))
    .operation as { asFactory: Record<string, unknown> }).asFactory;

  assertEquals(contract, {
    kind: "module",
    argumentSchema: {
      type: "object",
      description: "module input",
      properties: { value: { type: "string", minLength: 2 } },
      required: ["value"],
    },
    resultSchema: {
      type: "object",
      description: "module output",
      properties: { size: { type: "number", minimum: 0 } },
      required: ["size"],
    },
  });
});

Deno.test("handler factories retain exact authored schema metadata", async () => {
  const output = await transformSource(
    `
import { handler, pattern } from "commonfabric";

const eventSchema = {
  type: "object",
  description: "handler event",
  properties: { id: { type: "string", minLength: 1 } },
  required: ["id"],
} as const;
const contextSchema = {
  type: "object",
  description: "handler context",
  properties: { count: { type: "number", minimum: 0 } },
  required: ["count"],
} as const;
const action = handler(
  eventSchema,
  contextSchema,
  (_event: { id: string }, _context: { count: number }) => undefined,
);

export default pattern(() => ({ action }));
`,
    { types: COMMONFABRIC_TYPES },
  );
  const contract = (resultProperties(rootPatternCall(parseModule(output)))
    .action as { asFactory: Record<string, unknown> }).asFactory;

  assertEquals(contract, {
    kind: "handler",
    contextSchema: {
      type: "object",
      description: "handler context",
      properties: { count: { type: "number", minimum: 0 } },
      required: ["count"],
    },
    eventSchema: {
      type: "object",
      description: "handler event",
      properties: { id: { type: "string", minLength: 1 } },
      required: ["id"],
    },
  });
});

Deno.test("inferred module and handler contracts match injected schemas", async () => {
  const output = await transformSource(
    `
import { Cell, handler, lift, pattern } from "commonfabric";

const operation = lift((input: { value: string }) => ({
  size: input.value.length,
}));
const action = handler<
  { detail: { id: string; ignored?: number } },
  { count: Cell<number>; untouched: Cell<string> }
>((event, context) => {
  context.count.set(event.detail.id.length);
});

export default pattern(() => ({ operation, action }));
`,
    { types: COMMONFABRIC_TYPES },
  );
  const root = parseModule(output);
  const liftCall = callsNamed(root, "lift")[0];
  const handlerCall = callsNamed(root, "handler")[0];
  assert(liftCall && handlerCall, output);
  const properties = resultProperties(rootPatternCall(root));

  assertEquals(
    (properties.operation as { asFactory: unknown }).asFactory,
    {
      kind: "module",
      argumentSchema: literalToValue(liftCall.arguments[1]!),
      resultSchema: literalToValue(liftCall.arguments[2]!),
    },
  );
  assertEquals(
    (properties.action as { asFactory: unknown }).asFactory,
    {
      kind: "handler",
      contextSchema: literalToValue(handlerCall.arguments[1]!),
      eventSchema: literalToValue(handlerCall.arguments[0]!),
    },
  );
});

Deno.test("toSchema-backed factories retain compiler-generated schema options", async () => {
  const output = await transformSource(
    `
import { pattern, toSchema } from "commonfabric";

interface Input { value: string }
const inputSchema = toSchema<Input>({
  description: "generated input",
  default: { value: "seed" },
});

export default pattern(() => ({
  child: pattern<Input>(({ value }) => ({ value }), inputSchema),
}));
`,
    { types: COMMONFABRIC_TYPES },
  );
  const contract = propertyContract(
    resultProperties(rootPatternCall(parseModule(output))).child,
  );

  assertEquals(contract.argumentSchema, {
    type: "object",
    properties: { value: { type: "string" } },
    required: ["value"],
    description: "generated input",
    default: { value: "seed" },
  });
});

Deno.test("schema-only nested overload retains the authored public contract", async () => {
  const output = await transformSource(
    `
import { pattern } from "commonfabric";

export default pattern(() => ({
  child: pattern(
    ({ value }) => ({ size: value.length }),
    {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
    } as const,
    {
      type: "object",
      properties: { size: { type: "number" } },
      required: ["size"],
    } as const,
  ),
}));
`,
    { types: COMMONFABRIC_TYPES },
  );
  const root = parseModule(output);
  const [base] = basePatternCalls(root);
  assert(base, output);
  assertEquals(
    propertyContract(resultProperties(rootPatternCall(root)).child),
    callContract(base),
  );
});

Deno.test("single-schema nested overload retains its inferred result contract", async () => {
  const output = await transformSource(
    `
import { pattern } from "commonfabric";

export default pattern(() => ({
  child: pattern(
    ({ value }) => ({ size: value.length }),
    {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
    } as const,
  ),
}));
`,
    { types: COMMONFABRIC_TYPES },
  );
  const root = parseModule(output);
  const [base] = basePatternCalls(root);
  assert(base, output);
  assertEquals(
    propertyContract(resultProperties(rootPatternCall(root)).child),
    callContract(base),
  );
});

Deno.test("single-schema module factory retains nested factory metadata", async () => {
  const output = await transformSource(
    `
import { pattern } from "commonfabric";

const Existing = pattern(
  ({ prefix }) => ({
    inner: pattern<{ value: string }>(({ value }) => ({ text: prefix + value })),
  }),
  {
    type: "object",
    properties: { prefix: { type: "string" } },
    required: ["prefix"],
  } as const,
);

export default pattern(() => ({ child: Existing }));
`,
    { types: COMMONFABRIC_TYPES },
  );
  const root = parseModule(output);
  const existing = patternCalls(root).find((call) =>
    ts.isIdentifier(call.expression) &&
    call.expression.text === "pattern" &&
    requiredFields(callContract(call).argumentSchema).includes("prefix")
  );
  const outer = patternCalls(root).filter((call) =>
    ts.isIdentifier(call.expression) && call.expression.text === "pattern"
  ).at(-1);
  assert(existing && outer, output);
  assertEquals(
    propertyContract(resultProperties(outer).child),
    callContract(existing),
  );
});

Deno.test("two-schema module factory retains non-type-level schema metadata", async () => {
  const output = await transformSource(
    `
import { pattern } from "commonfabric";

const Existing = pattern(
  ({ value }) => ({ size: value.length }),
  {
    type: "object",
    description: "authored input contract",
    properties: { value: { type: "string", minLength: 1 } },
    required: ["value"],
  } as const,
  {
    type: "object",
    description: "authored output contract",
    properties: { size: { type: "number", minimum: 0 } },
    required: ["size"],
  } as const,
);

export default pattern(() => ({ child: Existing }));
`,
    { types: COMMONFABRIC_TYPES },
  );
  const root = parseModule(output);
  const existing = patternCalls(root).find((call) =>
    ts.isIdentifier(call.expression) &&
    call.expression.text === "pattern" &&
    requiredFields(callContract(call).argumentSchema).includes("value")
  );
  const outer = patternCalls(root).find((call) =>
    ts.isIdentifier(call.expression) &&
    call.expression.text === "pattern" &&
    callContract(call).argumentSchema === false
  );
  assert(existing && outer, output);
  assertEquals(
    propertyContract(resultProperties(outer).child),
    callContract(existing),
  );
});

Deno.test("factory contracts resolve const schema bindings and static spreads", async () => {
  const output = await transformSource(
    `
import { pattern } from "commonfabric";

const objectSchema = { type: "object" } as const;
const inputSchema = {
  ...objectSchema,
  description: "spread input",
  properties: { value: { type: "string" } },
  required: ["value"],
} as const;
const outputSchema = {
  ...objectSchema,
  description: "spread output",
  properties: { size: { type: "number" } },
  required: ["size"],
} as const;
const Existing = pattern(
  ({ value }) => ({ size: value.length }),
  inputSchema,
  outputSchema,
);

export default pattern(() => ({ child: Existing }));
`,
    { types: COMMONFABRIC_TYPES },
  );
  const root = parseModule(output);
  const outer = patternCalls(root).filter((call) =>
    ts.isIdentifier(call.expression) && call.expression.text === "pattern"
  ).at(-1);
  assert(outer, output);
  assertEquals(propertyContract(resultProperties(outer).child), {
    kind: "pattern",
    argumentSchema: {
      type: "object",
      description: "spread input",
      properties: { value: { type: "string" } },
      required: ["value"],
    },
    resultSchema: {
      type: "object",
      description: "spread output",
      properties: { size: { type: "number" } },
      required: ["size"],
    },
  });
});

Deno.test("factory contracts unwrap exported schema() literals", async () => {
  const { output, diagnostics } = await validateSource(
    `
import { pattern, schema } from "commonfabric";

export const model = schema({
  type: "object",
  properties: { value: { type: "number" } },
  required: ["value"],
});
const Existing = pattern(({ value }) => ({ value }), model, model);
export default pattern(() => ({ child: Existing }));
`,
    { types: COMMONFABRIC_TYPES },
  );

  assertEquals(
    diagnostics.filter((diagnostic) =>
      diagnostic.type === "pattern-factory:non-static-public-schema"
    ).length,
    0,
  );
  const root = parseModule(output);
  const outer = patternCalls(root).filter((call) =>
    ts.isIdentifier(call.expression) && call.expression.text === "pattern"
  ).at(-1);
  assert(outer, output);
  assertEquals(propertyContract(resultProperties(outer).child), {
    kind: "pattern",
    argumentSchema: {
      type: "object",
      properties: { value: { type: "number" } },
      required: ["value"],
    },
    resultSchema: {
      type: "object",
      properties: { value: { type: "number" } },
      required: ["value"],
    },
  });
});

Deno.test("nested schema-bearing factories reject executable schema discovery", async () => {
  const { diagnostics } = await validateSource(
    `
import { pattern, type JSONSchema } from "commonfabric";

declare function schemaAtRuntime(): JSONSchema;

export default pattern(() => ({
  child: pattern(
    () => ({ ready: true }),
    schemaAtRuntime(),
    schemaAtRuntime(),
  ),
}));
`,
    { types: COMMONFABRIC_TYPES },
  );
  const contractDiagnostics = diagnostics.filter((diagnostic) =>
    diagnostic.type === "pattern-factory:non-static-public-schema"
  );

  assertEquals(contractDiagnostics.length, 1);
  assertStringIncludes(
    contractDiagnostics[0]!.message,
    "never executed to discover a schema",
  );
});

Deno.test("nested lift and handler factories reject executable schema discovery", async () => {
  const { diagnostics } = await validateSource(
    `
import { handler, lift, pattern, type JSONSchema } from "commonfabric";

declare function schemaAtRuntime(): JSONSchema;

export default pattern(() => ({
  mapped: lift(
    ({ value }: { value: string }) => ({ value }),
    schemaAtRuntime(),
    schemaAtRuntime(),
  ),
  handled: handler(
    schemaAtRuntime(),
    schemaAtRuntime(),
    (_event: { value: string }, _context: { ready: boolean }) => undefined,
  ),
}));
`,
    { types: COMMONFABRIC_TYPES },
  );
  const contractDiagnostics = diagnostics.filter((diagnostic) =>
    diagnostic.type === "pattern-factory:non-static-public-schema"
  );

  assertEquals(contractDiagnostics.length, 2);
  for (const diagnostic of contractDiagnostics) {
    assertStringIncludes(
      diagnostic.message,
      "never executed to discover a schema",
    );
  }
});

Deno.test("top-level schema-bearing factories defer executable schemas to construction", async () => {
  const { diagnostics } = await validateSource(
    `
import {
  handler,
  lift,
  pattern,
  toSchema,
  type JSONSchema,
} from "commonfabric";

const refine = (generated: JSONSchema): JSONSchema => generated;
declare function schemaAtRuntime(): JSONSchema;
const Existing = pattern<{ value: string }, { value: string }>(
  ({ value }) => ({ value }),
  toSchema<{ value: string }>(),
  refine(toSchema<{ value: string }>()),
);
const Lift = lift(
  ({ value }: { value: string }) => ({ value }),
  schemaAtRuntime(),
  schemaAtRuntime(),
);
const Handler = handler(
  schemaAtRuntime(),
  schemaAtRuntime(),
  (_event: { value: string }, _context: { ready: boolean }) => undefined,
);
void Lift;
void Handler;
export default Existing;
`,
    { types: COMMONFABRIC_TYPES },
  );

  assertEquals(
    diagnostics.filter((diagnostic) =>
      diagnostic.type === "pattern-factory:non-static-public-schema"
    ),
    [],
  );
});

Deno.test("factory contracts retain static overlays on compiler-generated schemas", async () => {
  const { output, diagnostics } = await validateSource(
    `
import {
  __cf_data,
  pattern,
  toSchema,
  type JSONSchema,
} from "commonfabric";

type Output = { value: string; untouched: number };
const generated = toSchema<Output>();
const generatedObject = generated as Exclude<JSONSchema, boolean>;
const outputSchema = __cf_data({
  ...generatedObject,
  properties: {
    ...generatedObject.properties,
    value: { type: "string", description: "exact overlay" },
  },
});

const Child = pattern<{ input: string }, Output>(
  ({ input }) => ({ value: input, untouched: 1 }),
  toSchema<{ input: string }>(),
  outputSchema,
);

export default pattern(() => ({ child: Child }));
`,
    { types: COMMONFABRIC_TYPES },
  );

  assertEquals(diagnostics, []);
  const root = parseModule(output);
  const contract = emittedSchemas(root).flatMap(collectPropertyContracts)[0]!;
  assertEquals(contract.resultSchema, {
    type: "object",
    properties: {
      value: { type: "string", description: "exact overlay" },
      untouched: { type: "number" },
    },
    required: ["value", "untouched"],
  });
});

Deno.test("factory contracts reject mutated const schema bindings", async () => {
  const { diagnostics } = await validateSource(
    `
import { pattern } from "commonfabric";

const inputSchema = {
  type: "object",
  description: "before",
  properties: { value: { type: "string" } },
  required: ["value"],
} as const;
const outputSchema = {
  type: "object",
  properties: { size: { type: "number" } },
  required: ["size"],
} as const;

(inputSchema as any).description = "after";
const Existing = pattern(
  ({ value }) => ({ size: value.length }),
  inputSchema,
  outputSchema,
);
export default pattern(() => ({ child: Existing }));
`,
    { types: COMMONFABRIC_TYPES },
  );
  const contractDiagnostics = diagnostics.filter((diagnostic) =>
    diagnostic.type === "pattern-factory:non-static-public-schema"
  );

  assertEquals(contractDiagnostics.length, 1);
  assertStringIncludes(
    contractDiagnostics[0]!.message,
    "statically resolvable public schemas",
  );
});

Deno.test("factory contracts reject mutation through a const alias", async () => {
  const { diagnostics } = await validateSource(
    `
import { pattern } from "commonfabric";

const inputSchema = {
  type: "object",
  description: "before",
  properties: { value: { type: "string" } },
  required: ["value"],
} as const;
const alias = inputSchema;
(alias as any).description = "after";

const Existing = pattern(
  ({ value }) => ({ size: value.length }),
  inputSchema,
  {
    type: "object",
    properties: { size: { type: "number" } },
    required: ["size"],
  } as const,
);
export default pattern(() => ({ child: Existing }));
`,
    { types: COMMONFABRIC_TYPES },
  );
  const contractDiagnostics = diagnostics.filter((diagnostic) =>
    diagnostic.type === "pattern-factory:non-static-public-schema"
  );

  assertEquals(contractDiagnostics.length, 1);
});

Deno.test("type-only Schema references do not count as runtime schema escapes", async () => {
  const { diagnostics } = await validateSource(
    `
import { pattern } from "commonfabric";
import type { Schema } from "commonfabric/schema";

const inputSchema = {
  type: "object",
  properties: { value: { type: "string" } },
  required: ["value"],
} as const;
const outputSchema = {
  type: "object",
  properties: { size: { type: "number" } },
  required: ["size"],
} as const;
type Input = Schema<typeof inputSchema>;

const Existing = pattern(
  ({ value }: Input) => ({ size: value.length }),
  inputSchema,
  outputSchema,
);
export default pattern(() => ({ child: Existing }));
`,
    { types: COMMONFABRIC_TYPES },
  );

  assertEquals(
    diagnostics.filter((diagnostic) =>
      diagnostic.type === "pattern-factory:non-static-public-schema"
    ),
    [],
  );
});
