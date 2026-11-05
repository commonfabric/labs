import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { deepEqual } from "@commonfabric/js-values/deep-equal";
import { Identity } from "@commonfabric/identity";

import { createBuilder } from "../src/builder/factory.ts";
import { pattern, popFrame, pushFrame } from "../src/builder/pattern.ts";
import {
  type Frame,
  isReactive,
  type JSONSchema,
  type Pattern,
  type Reactive,
  type Stream,
} from "../src/builder/types.ts";
import type { FactoryContract } from "../src/factory-materialization.ts";
import { exportCell } from "../src/cell.ts";
import { getCellOrThrow } from "../src/query-result-proxy.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { externalRefTo } from "./schema-ref-helpers.ts";

type InvokeFactory = (
  factory: unknown,
  input: unknown,
  expected: FactoryContract,
) => Reactive<unknown> | Stream<unknown>;

const signer = await Identity.fromPassphrase("dynamic factory builder test");
const space = signer.did();

const VALUE_SCHEMA = {
  type: "object",
  properties: { value: { type: "number" } },
  required: ["value"],
  additionalProperties: false,
} as const satisfies JSONSchema;

const RESULT_SCHEMA = {
  type: "object",
  properties: { result: { type: "number" } },
  required: ["result"],
  additionalProperties: false,
} as const satisfies JSONSchema;

function helperFromBuilder(): InvokeFactory | undefined {
  const { commonfabric } = createBuilder();
  return (commonfabric as unknown as {
    __cfHelpers?: { invokeFactory?: InvokeFactory };
  }).__cfHelpers?.invokeFactory;
}

function factorySchema(contract: FactoryContract): JSONSchema {
  return { asFactory: contract } as unknown as JSONSchema;
}

function parentArgumentSchema(contract: FactoryContract): JSONSchema {
  return {
    type: "object",
    properties: {
      operation: factorySchema(contract),
      value: { type: "number" },
    },
    required: ["operation", "value"],
    additionalProperties: false,
  } as JSONSchema;
}

function argumentAlias(
  path: string,
  schema: JSONSchema,
): Record<string, unknown> {
  return {
    $alias: {
      cell: "argument",
      path: [path],
      schema,
    },
  };
}

function derivedAlias(
  partialCause: string,
  schema?: JSONSchema,
): Record<string, unknown> {
  return {
    $alias: {
      partialCause,
      path: [],
      scope: "space",
      ...(schema === undefined ? {} : { schema }),
    },
  };
}

function containsDeepValue(root: unknown, target: unknown): boolean {
  if (deepEqual(root, target)) return true;
  if (Array.isArray(root)) {
    return root.some((value) => containsDeepValue(value, target));
  }
  if (root === null || typeof root !== "object") return false;
  return Object.values(root).some((value) => containsDeepValue(value, target));
}

describe("dynamic factory builder node shape", () => {
  let runtime: Runtime;
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let frame: Frame;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    frame = pushFrame({
      space,
      generatedIdCounter: 0,
      reactives: new Set(),
      runtime,
    });
  });

  afterEach(async () => {
    popFrame(frame);
    await runtime.dispose();
    await storageManager.close();
  });

  it("exposes invokeFactory through the private runtime helpers", () => {
    expect(typeof helperFromBuilder()).toBe("function");
  });

  for (const kind of ["pattern", "module"] as const) {
    it(`records a symbolic ${kind} call with a stable Reactive output`, () => {
      const expected = {
        kind,
        argumentSchema: VALUE_SCHEMA,
        resultSchema: RESULT_SCHEMA,
      } as const satisfies FactoryContract;
      const invokeFactory = helperFromBuilder()!;
      let output: Reactive<unknown> | Stream<unknown> | undefined;

      const built = pattern<any>((input) => {
        output = invokeFactory(
          input.operation,
          { value: input.value },
          expected,
        );
        return { result: output };
      }, parentArgumentSchema(expected));

      expect(isReactive(output)).toBe(true);
      expect(exportCell(getCellOrThrow(output)).name).toBe("result");
      expect(exportCell(getCellOrThrow(output)).schema).toEqual(
        kind === "pattern" ? undefined : RESULT_SCHEMA,
      );
      expect(built.nodes).toHaveLength(1);

      const node = built.nodes[0] as Pattern["nodes"][number];
      expect(node.module).toEqual(
        argumentAlias("operation", externalRefTo(factorySchema(expected))),
      );
      expect(node.outputs).toEqual(
        derivedAlias(
          "result",
          kind === "pattern" ? undefined : externalRefTo(RESULT_SCHEMA),
        ),
      );

      // This must be an explicit call-site contract, not merely the authored
      // schema carried by the symbolic module link.
      expect(node.expectedFactory).toEqual(expected);
      expect(
        containsDeepValue(
          node.inputs,
          argumentAlias("value", externalRefTo({ type: "number" })),
        ),
      ).toBe(true);

      // The selected artifact never becomes part of the serialized node or
      // its output identity. Replacement keeps this partial cause intact.
      expect(JSON.stringify(node.module)).not.toContain("$patternRef");
      expect(JSON.stringify(node.module)).not.toContain("$implRef");
      expect(JSON.stringify(node.outputs)).not.toContain("operation");
      expect(JSON.stringify(node.outputs)).not.toContain("identity");
    });
  }

  it("records handler calls with the existing $ctx/$event stream wiring", () => {
    const expected = {
      kind: "handler",
      contextSchema: VALUE_SCHEMA,
      eventSchema: RESULT_SCHEMA,
    } as const satisfies FactoryContract;
    const invokeFactory = helperFromBuilder()!;
    let output: Reactive<unknown> | Stream<unknown> | undefined;

    const built = pattern<any>((input) => {
      output = invokeFactory(
        input.operation,
        { value: input.value },
        expected,
      );
      return { events: output };
    }, parentArgumentSchema(expected));

    expect(isReactive(output)).toBe(true);
    expect(exportCell(getCellOrThrow(output)).kind).toBe("stream");
    expect(built.nodes).toHaveLength(1);

    const node = built.nodes[0] as Pattern["nodes"][number];
    expect(node.module).toEqual(
      argumentAlias("operation", externalRefTo(factorySchema(expected))),
    );
    expect(node.outputs).toEqual({});
    expect(node.inputs).toMatchObject({
      $ctx: {
        value: argumentAlias("value", externalRefTo({ type: "number" })),
      },
      $event: derivedAlias("events"),
    });
    expect(node.expectedFactory).toEqual(expected);

    const inputs = node.inputs as Record<string, unknown>;
    expect(JSON.stringify(inputs.$event)).not.toContain("operation");
    expect(JSON.stringify(inputs.$event)).not.toContain("identity");
  });
});
