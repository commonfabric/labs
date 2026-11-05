import { factoryStateOf } from "@commonfabric/data-model/fabric-factory";
import { Identity } from "@commonfabric/identity";
import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { createBuilder } from "../src/builder/factory.ts";
import {
  pattern,
  patternFromFrame,
  popFrame,
  pushFrame,
  withPatternParamsSchema,
} from "../src/builder/pattern.ts";
import type { Frame, JSONSchema } from "../src/builder/types.ts";
import { Runtime } from "../src/runtime.ts";
import { resolveSchema } from "../src/schema.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";

const signer = await Identity.fromPassphrase("pattern params schema test");
const space = signer.did();

const ARGUMENT_SCHEMA = {
  type: "object",
  properties: { value: { type: "number" } },
  required: ["value"],
  additionalProperties: false,
} as const satisfies JSONSchema;

const PARAMS_SCHEMA = {
  type: "object",
  properties: { value: { type: "string" } },
  required: ["value"],
  additionalProperties: false,
} as const satisfies JSONSchema;

describe("compiler-only pattern params schema", () => {
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

  it("keeps the carrier internal and returns the original callback", () => {
    const callback = (_argument: unknown, _params: unknown) => ({});
    const { commonfabric } = createBuilder();
    const runtimeExports = commonfabric as unknown as Record<string, unknown>;
    const internalHelpers = runtimeExports.__cfHelpers as Record<
      string,
      unknown
    >;

    expect(runtimeExports.withPatternParamsSchema).toBeUndefined();
    expect(internalHelpers.withPatternParamsSchema).toBe(
      withPatternParamsSchema,
    );
    expect(withPatternParamsSchema(callback, PARAMS_SCHEMA)).toBe(callback);
  });

  it("creates distinct public-input and closure-param roots", () => {
    const callback = (argument: any, params: any) => ({
      publicValue: argument.value,
      capturedValue: params.value,
    });
    const factory = pattern(
      withPatternParamsSchema(callback, PARAMS_SCHEMA) as any,
      ARGUMENT_SCHEMA,
    );
    const state = factoryStateOf(factory);

    expect(state.kind).toBe("pattern");
    if (state.kind !== "pattern") throw new Error("expected pattern state");
    expect(state.argumentSchema).toEqual(ARGUMENT_SCHEMA);
    expect(state.paramsSchema).toEqual(PARAMS_SCHEMA);
    const result = factory.result as Record<
      string,
      { $alias: { cell: string; path: string[]; schema: JSONSchema } }
    >;
    expect(result.publicValue.$alias.cell).toBe("argument");
    expect(result.publicValue.$alias.path).toEqual(["value"]);
    expect(resolveSchema(result.publicValue.$alias.schema)).toEqual({
      type: "number",
    });
    expect(result.capturedValue.$alias.cell).toBe("params");
    expect(result.capturedValue.$alias.path).toEqual(["value"]);
    expect(resolveSchema(result.capturedValue.$alias.schema)).toEqual({
      type: "string",
    });
  });

  it("preserves the same root split when the caller owns the frame", () => {
    const callback = (argument: any, params: any) => ({
      publicValue: argument.value,
      capturedValue: params.value,
    });
    const factory = patternFromFrame(
      withPatternParamsSchema(callback, PARAMS_SCHEMA) as any,
      ARGUMENT_SCHEMA,
    );

    expect(factory.result).toMatchObject({
      publicValue: { $alias: { cell: "argument", path: ["value"] } },
      capturedValue: { $alias: { cell: "params", path: ["value"] } },
    });
  });

  it("rejects an authored second callback parameter without metadata", () => {
    expect(() =>
      pattern(
        ((argument: unknown, params: unknown) => ({
          argument,
          params,
        })) as any,
      )
    ).toThrow("second callback parameter requires compiler metadata");
  });
});
