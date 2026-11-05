import {
  assert,
  assertEquals,
  assertMatch,
  assertNotMatch,
  assertStringIncludes,
} from "@std/assert";
import ts from "typescript";

import { COMMONFABRIC_TYPES } from "./commonfabric-test-types.ts";
import {
  callsNamed,
  collect,
  literalToValue,
  parseModule,
} from "./transformed-ast.ts";
import { transformSource, validateSource } from "./utils.ts";

const options = { types: COMMONFABRIC_TYPES };

Deno.test("nested pattern closure conversion keeps public input and captures separate", async () => {
  const output = await transformSource(
    `
import { pattern } from "commonfabric";

export default pattern<{ prefix: string }>(({ prefix }) => ({
  child: pattern<{ suffix: string }>(({ suffix }) => ({ prefix, suffix })),
}));
`,
    options,
  );
  const normalized = output.replace(/\s+/g, " ");

  assertEquals(
    normalized.match(/withPatternParamsSchema/g)?.length,
    1,
    output,
  );
  assertMatch(
    normalized,
    /withPatternParamsSchema\(\s*\(__cf_pattern_input, \{ prefix \}\) =>/,
  );
  assertMatch(normalized, /\.curry\(\{ prefix: prefix \}\)/);
  assertMatch(normalized, /const __cfPattern_\d+ = __cfHelpers\.pattern/);
  assertMatch(normalized, /__cfReg\(\{[^}]*__cfPattern_\d+/);

  assertNotMatch(
    normalized,
    /withPatternParamsSchema\(\s*\(\{[^}]*prefix[^}]*suffix/,
  );
});

Deno.test("destructured reserved input name gets a collision-free public root", async () => {
  const output = await transformSource(
    `
import { pattern } from "commonfabric";

export default pattern<{ __cf_pattern_input: string }>(
  ({ __cf_pattern_input }) => ({
    child: pattern<{ value: number }>(({ value }) => ({
      value,
      reserved: __cf_pattern_input,
    })),
  }),
);
`,
    options,
  );
  const root = parseModule(output);
  const exported = root.statements.find(ts.isExportAssignment);
  assert(
    exported && ts.isCallExpression(exported.expression),
    `expected a default-exported pattern call:\n${output}`,
  );
  const rootCallback = exported.expression.arguments[0];
  assert(
    rootCallback && ts.isArrowFunction(rootCallback),
    `expected the root pattern callback:\n${output}`,
  );
  const publicRoot = rootCallback.parameters[0]?.name;
  assert(
    publicRoot && ts.isIdentifier(publicRoot),
    `expected a synthetic public-root identifier:\n${output}`,
  );
  assertEquals(publicRoot.text, "__cf_pattern_input_1", output);

  const reservedBinding = collect(
    rootCallback.body,
    ts.isVariableDeclaration,
  ).find((declaration) =>
    ts.isIdentifier(declaration.name) &&
    declaration.name.text === "__cf_pattern_input"
  );
  assert(reservedBinding?.initializer, output);
  assert(
    ts.isCallExpression(reservedBinding.initializer) &&
      ts.isPropertyAccessExpression(reservedBinding.initializer.expression) &&
      ts.isIdentifier(reservedBinding.initializer.expression.expression),
    output,
  );
  assertEquals(
    reservedBinding.initializer.expression.expression.text,
    publicRoot.text,
    output,
  );

  const nestedWrapper = callsNamed(root, "withPatternParamsSchema")[0];
  assert(nestedWrapper, output);
  const nestedCallback = nestedWrapper.arguments[0];
  assert(nestedCallback && ts.isArrowFunction(nestedCallback), output);
  assert(
    ts.isIdentifier(nestedCallback.parameters[0]?.name),
    "the nested public input must stay in callback argument 0",
  );
  assertEquals(
    nestedCallback.parameters[0].name.text,
    "__cf_pattern_input",
    output,
  );
  const captures = nestedCallback.parameters[1]?.name;
  assert(
    captures && ts.isObjectBindingPattern(captures),
    "the nested captures must stay in callback argument 1",
  );
  const reservedCapture = captures.elements.find((element) =>
    element.propertyName && ts.isIdentifier(element.propertyName) &&
    element.propertyName.text === "__cf_pattern_input"
  );
  assert(
    reservedCapture && ts.isIdentifier(reservedCapture.name),
    output,
  );
  assertEquals(reservedCapture.name.text, "__cf_pattern_input_1", output);
});

Deno.test("zero-input nested patterns keep captures in callback argument 1", async () => {
  const output = await transformSource(
    `
import { pattern } from "commonfabric";

export default pattern<{ label: string }>(({ label }) => ({
  child: pattern(() => ({ label })),
}));
`,
    options,
  );
  const root = parseModule(output);
  const wrapper = callsNamed(root, "withPatternParamsSchema")[0];
  assert(wrapper, output);
  const callback = wrapper.arguments[0];
  assert(callback && ts.isArrowFunction(callback), output);

  assertEquals(callback.parameters.length, 2, output);
  assert(
    ts.isIdentifier(callback.parameters[0]!.name),
    "argument 0 must remain the public-input slot",
  );
  assert(
    ts.isObjectBindingPattern(callback.parameters[1]!.name),
    "argument 1 must be the private capture record",
  );
  assertEquals(
    callback.parameters[1]!.name.getText(root),
    "{ label }",
  );
  assertEquals(
    callsNamed(callback, "key").filter((call) =>
      call.arguments[0]?.getText(root) === '"label"'
    ).length,
    0,
    "the capture must not be read from public input",
  );
  const basePattern = callsNamed(root, "pattern").find((call) =>
    call.arguments[0] === wrapper
  );
  assert(basePattern, output);
  assertEquals(
    literalToValue(basePattern.arguments[1]!),
    false,
    "synthesizing argument 0 must preserve the authored zero-input schema",
  );
});

Deno.test("capture-free nested patterns hoist without params or curry", async () => {
  const output = await transformSource(
    `
import { pattern } from "commonfabric";

export default pattern<{ label: string }>(({ label }) => ({
  label,
  child: pattern<{ suffix: string }>(({ suffix }) => ({ suffix })),
}));
`,
    options,
  );
  const normalized = output.replace(/\s+/g, " ");

  assertMatch(normalized, /const __cfPattern_\d+ = __cfHelpers\.pattern/);
  assertNotMatch(normalized, /withPatternParamsSchema/);
  assertNotMatch(normalized, /__cfPattern_\d+\.curry/);
});

Deno.test("nested pattern hoisting reserves authored module bindings", async () => {
  const output = await transformSource(
    `
import { pattern } from "commonfabric";

const __cfPattern_1 = "authored";

export default pattern(() => ({
  authored: __cfPattern_1,
  child: pattern<{ suffix: string }>(({ suffix }) => ({ suffix })),
}));
`,
    options,
  );
  const normalized = output.replace(/\s+/g, " ");

  assertMatch(normalized, /const __cfPattern_1 = "authored"/);
  assertMatch(normalized, /const __cfPattern_2 = __cfHelpers\.pattern/);
  assertMatch(normalized, /child: __cfPattern_2/);
  assertNotMatch(normalized, /const __cfPattern_1 = __cfHelpers\.pattern/);
});

Deno.test("nested patterns keep module-scoped helpers lexical", async () => {
  const output = await transformSource(
    `
import { pattern } from "commonfabric";

const format = (value: string) => value.toUpperCase();

export default pattern(() => ({
  child: pattern<{ suffix: string }>(({ suffix }) => ({
    suffix: format(suffix),
  })),
}));
`,
    options,
  );
  const normalized = output.replace(/\s+/g, " ");

  assertMatch(
    normalized,
    /const __cfLift_\d+ = __cfHelpers\.lift[\s\S]*?format\(suffix\)/,
  );
  assertMatch(normalized, /const __cfPattern_\d+ = __cfHelpers\.pattern/);
  assertNotMatch(normalized, /withPatternParamsSchema/);
  assertNotMatch(normalized, /\.curry\(/);
});

Deno.test("nested patterns preserve all factory kinds as symbolic curry captures", async () => {
  const output = await transformSource(
    `
import {
  pattern,
  type HandlerFactory,
  type ModuleFactory,
  type PatternFactory,
} from "commonfabric";

interface Input { value: number }
interface Output { result: number }

export default pattern<{
  patternOperation: PatternFactory<Input, Output>;
  moduleOperation: ModuleFactory<Input, Output>;
  handlerOperation: HandlerFactory<Output, Input>;
}>((input) => ({
  child: pattern<Input>((argument) => ({
    argument,
    patternOperation: input.patternOperation,
    moduleOperation: input.moduleOperation,
    handlerOperation: input.handlerOperation,
  })),
}));
`,
    { ...options, typeCheck: true },
  );
  const root = parseModule(output);
  const wrapper = callsNamed(root, "withPatternParamsSchema")[0];
  assert(wrapper, output);

  const paramsSchema = literalToValue(wrapper.arguments[1]!) as {
    properties: {
      input: {
        properties: Record<string, { asFactory: Record<string, unknown> }>;
      };
    };
  };
  const captured = paramsSchema.properties.input.properties;
  const inputSchema = {
    type: "object",
    properties: { value: { type: "number" } },
    required: ["value"],
  };
  const outputSchema = {
    type: "object",
    properties: { result: { type: "number" } },
    required: ["result"],
  };
  assertEquals(captured.patternOperation!.asFactory, {
    kind: "pattern",
    argumentSchema: inputSchema,
    resultSchema: outputSchema,
  });
  assertEquals(captured.moduleOperation!.asFactory, {
    kind: "module",
    argumentSchema: inputSchema,
    resultSchema: outputSchema,
  });
  assertEquals(captured.handlerOperation!.asFactory, {
    kind: "handler",
    contextSchema: inputSchema,
    eventSchema: outputSchema,
  });

  const curry = callsNamed(root, "curry")[0];
  assert(curry, output);
  assertEquals(
    callsNamed(curry.arguments[0]!, "key")
      .map((call) => call.arguments[0]?.getText(root))
      .sort(),
    ['"handlerOperation"', '"moduleOperation"', '"patternOperation"'],
    "curry must bind the three outer symbolic paths rather than snapshots",
  );
});

Deno.test("nested pattern params retain named schemas inside scoped cell captures", async () => {
  const output = await transformSource(
    `
import { pattern, UI, Writable } from "commonfabric";

export type CommuteMode = "drive" | "transit" | "bike";
export type Box<T> = { value: T };
interface ParkingSpot { spotNumber: string }

export default pattern<{
  people: Array<{ name: string; isEditing: boolean }>;
}>(({ people }) => {
  const spots = new Writable<ParkingSpot[]>([]);
  const editCommuteMode = new Writable.perSession<CommuteMode>("drive");
  const editBox = new Writable.perSession<Box<string>>({ value: "drive" });
  return {
    [UI]: (
      <div>
        {people.map((person) => (
          <span>
            {person.name} {spots} {editBox}
            {person.isEditing
              ? (
                <cf-select
                  items={[{ label: "Drive", value: "drive" }]}
                  $value={editCommuteMode}
                ></cf-select>
              )
              : null}
          </span>
        ))}
      </div>
    ),
  };
});
`,
    { ...options, typeCheck: true },
  );
  const root = parseModule(output);
  const wrapper = callsNamed(root, "withPatternParamsSchema")[0];
  assert(wrapper, output);

  const paramsSchema = literalToValue(wrapper.arguments[1]!) as {
    properties: Record<string, unknown>;
    $defs?: Record<string, unknown>;
  };
  assertEquals(paramsSchema.properties.editCommuteMode, {
    $ref: "#/$defs/CommuteMode",
    asCell: [{ kind: "cell", scope: "session" }],
  });
  assertEquals(paramsSchema.$defs?.CommuteMode, {
    enum: ["drive", "transit", "bike"],
  });
  assertEquals(paramsSchema.properties.spots, {
    type: "array",
    items: { $ref: "#/$defs/ParkingSpot" },
    asCell: ["cell"],
  });
  assertEquals(paramsSchema.$defs?.ParkingSpot, {
    type: "object",
    properties: { spotNumber: { type: "string" } },
    required: ["spotNumber"],
  });
  assertEquals(paramsSchema.properties.editBox, {
    type: "object",
    properties: { value: { type: "string" } },
    required: ["value"],
    asCell: [{ kind: "cell", scope: "session" }],
  });
});

Deno.test("read-write action captures retain named array element schemas", async () => {
  const output = await transformSource(
    `
import { action, Default, pattern, Writable } from "commonfabric";

interface Item {
  text: string;
  indented: boolean | Default<false>;
}
interface Input {
  items?: Writable<Item[] | Default<[]>>;
}

export default pattern<Input>(({ items }) => {
  const toggle = action(({ index }: { index: number }) => {
    const current = items.get() || [];
    if (index < current.length) items.set([...current]);
  });
  const remove = action(({ index }: { index: number }) => {
    const current = items.get() || [];
    if (index < current.length) items.set(current.toSpliced(index, 1));
  });
  return { toggle, remove };
});
`,
    { ...options, typeCheck: true },
  );
  const root = parseModule(output);
  const handlers = callsNamed(root, "handler");
  assertEquals(handlers.length, 2, output);

  for (const handler of handlers) {
    const captureSchema = literalToValue(handler.arguments[1]!) as {
      properties: Record<string, unknown>;
      $defs?: Record<string, unknown>;
    };
    assertEquals(captureSchema.properties.items, {
      type: "array",
      items: { $ref: "#/$defs/Item" },
      default: [],
      asCell: ["cell"],
    });
    assertEquals(captureSchema.$defs?.Item, {
      type: "object",
      properties: {
        text: { type: "string" },
        indented: { type: "boolean", default: false },
      },
      required: ["text", "indented"],
    });
  }
});

Deno.test("eager calls to captured factories stay inside the hoisted callback", async () => {
  const output = await transformSource(
    `
import {
  pattern,
  type HandlerFactory,
  type ModuleFactory,
  type PatternFactory,
} from "commonfabric";

interface Input { value: number }
interface Output { result: number }

export default pattern<{
  patternOperation: PatternFactory<Input, Output>;
  moduleOperation: ModuleFactory<Input, Output>;
  handlerOperation: HandlerFactory<Output, Input>;
}>((input) => ({
  child: pattern<Input>((argument) => ({
    patternResult: input.patternOperation(argument),
    moduleResult: input.moduleOperation(argument),
    events: input.handlerOperation(argument),
  })),
}));
`,
    { ...options, typeCheck: true },
  );
  const root = parseModule(output);
  const wrapper = callsNamed(root, "withPatternParamsSchema")[0];
  assert(wrapper, output);
  assertEquals(callsNamed(root, "curry").length, 1, output);

  const callback = wrapper.arguments[0];
  assert(callback, output);
  const invocations = callsNamed(callback, "invokeFactory");
  assertEquals(invocations.length, 3, output);
  assertEquals(
    invocations.map((call) => {
      const contract = literalToValue(call.arguments[2]!) as {
        kind: string;
      };
      return contract.kind;
    }).sort(),
    ["handler", "module", "pattern"],
  );
});

Deno.test("a local nested factory called through a deeper capture stays symbolic", async () => {
  const output = await transformSource(
    `
import { pattern } from "commonfabric";

interface Input { value: number }
interface Output { result: number }

export default pattern<{ factor: number }>(({ factor }) => {
  const local = pattern<Input, Output>(({ value }) => ({
    result: value * factor,
  }));
  return {
    child: pattern<Input, Output>((argument) => local(argument)),
  };
});
`,
    { ...options, typeCheck: true },
  );
  const root = parseModule(output);
  const invocations = callsNamed(root, "invokeFactory");

  assertEquals(invocations.length, 1, output);
  const contract = literalToValue(invocations[0]!.arguments[2]!) as {
    kind: string;
    resultSchema: unknown;
  };
  assertEquals(contract.kind, "pattern");
  assertEquals(contract.resultSchema, {
    type: "object",
    properties: { result: { type: "number" } },
    required: ["result"],
  });
});

Deno.test("nested patterns reject arbitrary local JavaScript function captures", async () => {
  const { diagnostics } = await validateSource(
    `
import { pattern } from "commonfabric";

export default pattern<{ value: number }>(({ value }) => {
  const adjust = (candidate: number) => candidate + 1;
  return {
    child: pattern<{ value: number }>(({ value: childValue }) => ({
      value: adjust(childValue) + value,
    })),
  };
});
`,
    { ...options, typeCheck: true },
  );
  const callableCapture = diagnostics.filter((diagnostic) =>
    diagnostic.type === "ses-callback:callable-capture"
  );
  assertEquals(callableCapture.length, 1);
  assertStringIncludes(callableCapture[0]!.message, "adjust");
  assertStringIncludes(callableCapture[0]!.message, "serializable data");
  assertEquals(callableCapture[0]!.line, 9);
});

Deno.test("nested patterns report unrepresentable capture schemas at the capture", async () => {
  const { diagnostics } = await validateSource(
    `
import { pattern } from "commonfabric";

export default pattern(() => {
  const token = Symbol("token");
  return {
    child: pattern(() => ({ matches: token === Symbol.for("other") })),
  };
});
`,
    { ...options, typeCheck: true },
  );

  const unrepresentable = diagnostics.filter((diagnostic) =>
    diagnostic.type === "pattern-capture:unrepresentable-schema"
  );
  assertEquals(unrepresentable.length, 1);
  assertEquals(unrepresentable[0]!.line, 8);
  assertStringIncludes(unrepresentable[0]!.message, "token");
  assertStringIncludes(unrepresentable[0]!.message, "symbol");
  assertStringIncludes(unrepresentable[0]!.message, "Fabric schema");
});

Deno.test("nested patterns format schema-generator capture rejections as diagnostics", async () => {
  const { diagnostics } = await validateSource(
    `
import { pattern } from "commonfabric";

export default pattern(() => {
  const lookup = new Map([["answer", 42]]);
  return {
    child: pattern(() => ({ answer: lookup.get("answer") })),
  };
});
`,
    { ...options, typeCheck: true },
  );

  const unrepresentable = diagnostics.filter((diagnostic) =>
    diagnostic.type === "pattern-capture:unrepresentable-schema"
  );
  assertEquals(unrepresentable.length, 1);
  assertEquals(unrepresentable[0]!.line, 8);
  assertStringIncludes(unrepresentable[0]!.message, "lookup");
  assertStringIncludes(unrepresentable[0]!.message, "Map");
  assertStringIncludes(unrepresentable[0]!.message, "Fabric schema");
});
