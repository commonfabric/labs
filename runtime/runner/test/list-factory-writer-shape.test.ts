import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import {
  factoryStateOf,
  isAdmittedFabricFactory,
} from "@commonfabric/data-model/fabric-factory";
import type { OpaqueCell } from "@commonfabric/api";
import { withPatternParamsSchema } from "../src/builder/pattern.ts";
import type {
  InternalPatternFactory,
  JSONSchema,
  Pattern,
  PatternFactory,
} from "../src/builder/types.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";

type ListCallbackInput = {
  element: number;
  index: number;
  array: number[];
};

const LIST_CALLBACK_SCHEMA = {
  type: "object",
  properties: {
    element: { type: "number" },
    index: { type: "number" },
    array: { type: "array", items: { type: "number" } },
  },
  required: ["element", "index", "array"],
  additionalProperties: false,
} as const satisfies JSONSchema;

const PARAMS_SCHEMA = {
  type: "object",
  properties: { offset: { type: "number" } },
  required: ["offset"],
  additionalProperties: false,
} as const satisfies JSONSchema;

const signer = await Identity.fromPassphrase("list factory writer shape");
let storageManager: ReturnType<typeof StorageManager.emulate>;
let runtime: Runtime;
let pattern: ReturnType<typeof createTrustedBuilder>["commonfabric"]["pattern"];

function bind<R>(
  callback: (input: any, params: any) => R,
  resultSchema: JSONSchema,
  offset: number,
): PatternFactory<ListCallbackInput, R> {
  const base = pattern<ListCallbackInput, R>(
    withPatternParamsSchema(callback as any, PARAMS_SCHEMA) as any,
    LIST_CALLBACK_SCHEMA,
    resultSchema,
  );
  return (base as InternalPatternFactory<ListCallbackInput, R>).curry({
    offset,
  });
}

function nodeInputs(graph: Pattern, implementation: string) {
  const node = graph.nodes.find((candidate) =>
    typeof candidate.module === "object" &&
    candidate.module !== null &&
    "implementation" in candidate.module &&
    candidate.module.implementation === implementation
  );
  expect(node).toBeDefined();
  return node!.inputs as unknown as Record<string, unknown>;
}

describe("list factory writer shape", () => {
  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    pattern = createTrustedBuilder(runtime).commonfabric.pattern;
  });

  afterEach(async () => {
    await runtime.dispose();
    await storageManager.close();
  });

  it("writes bound factories canonically with no sibling params", () => {
    const mappedOp = bind(
      (_input, params) => params.offset,
      { type: "number" },
      10,
    );
    const filteredOp = bind(
      (_input, params) => params.offset,
      { type: "number" },
      1,
    );
    const flattenedOp = bind(
      (_input, params) => [params.offset],
      { type: "array", items: { type: "number" } },
      20,
    );

    const canonical = pattern<{ list: number[] }>(({ list }) => {
      const listCell = list as unknown as OpaqueCell<number[]>;
      return {
        mapped: listCell.mapWithPattern(mappedOp),
        filtered: listCell.filterWithPattern(filteredOp),
        flattened: listCell.flatMapWithPattern(flattenedOp),
      };
    });

    for (
      const [implementation, op] of [
        ["map", mappedOp],
        ["filter", filteredOp],
        ["flatMap", flattenedOp],
      ] as const
    ) {
      const inputs = nodeInputs(canonical, implementation);
      expect(Object.keys(inputs)).toEqual(["list", "op"]);
      expect(isAdmittedFabricFactory(inputs.op)).toBe(true);
      expect(factoryStateOf(inputs.op)).toEqual(factoryStateOf(op));
    }
  });
});
