import {
  factoryStateOf,
  sealFactoryState,
} from "@commonfabric/data-model/fabric-factory";
import { Identity } from "@commonfabric/identity";
import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { handler, lift } from "../src/builder/module.ts";
import { setDurableArtifactEntryRef } from "../src/builder/pattern-metadata.ts";
import {
  pattern,
  popFrame,
  pushFrame,
  withPatternParamsSchema,
} from "../src/builder/pattern.ts";
import type {
  Frame,
  JSONSchema,
  PatternFactory,
} from "../src/builder/types.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("factory curry test");
const space = signer.did();

const ARGUMENT_SCHEMA = {
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

const PARAMS_SCHEMA = {
  type: "object",
  properties: {
    offset: { type: "number" },
  },
  required: ["offset"],
  additionalProperties: false,
} as const satisfies JSONSchema;

type CurryView<T, R> = PatternFactory<T, R> & {
  curry(...params: unknown[]): PatternFactory<T, R> & CurryView<T, R>;
};

function curryView<T, R>(factory: PatternFactory<T, R>): CurryView<T, R> {
  return factory as CurryView<T, R>;
}

function stateOf(factory: unknown) {
  const state = factoryStateOf(factory);
  if (state.kind !== "pattern") throw new Error("expected pattern state");
  return state;
}

describe("transformer-only pattern curry", () => {
  let runtime: Runtime;
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let tx: IExtendedStorageTransaction;
  let frame: Frame;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    tx = runtime.edit();
    frame = pushFrame({
      space,
      tx,
      generatedIdCounter: 0,
      reactives: new Set(),
      runtime,
    });
  });

  afterEach(async () => {
    popFrame(frame);
    await tx.commit().settled;
    await runtime.dispose();
    await storageManager.close();
  });

  function closureBase(paramsSchema: JSONSchema = PARAMS_SCHEMA) {
    return pattern(
      withPatternParamsSchema(
        ((argument: any, _params: any) => ({ result: argument.value })) as any,
        paramsSchema,
      ) as any,
      ARGUMENT_SCHEMA,
      RESULT_SCHEMA,
    );
  }

  it("binds exactly once and only when the compiler declared a slot", () => {
    const base = curryView(closureBase());
    expect(() => base.curry()).toThrow("exactly one argument");
    expect(() => base.curry({ offset: 1 }, { offset: 2 })).toThrow(
      "exactly one argument",
    );

    const bound = curryView(base.curry({ offset: 1 }));
    expect(bound).not.toBe(base);
    expect(stateOf(bound).params).toEqual({ offset: 1 });
    expect(bound.argumentSchema).toBe(base.argumentSchema);
    expect(bound.resultSchema).toBe(base.resultSchema);
    expect(() => bound.curry({ offset: 1 })).toThrow("already bound");

    const captureFree = curryView(
      pattern(({ value }: { value: number }) => ({ result: value })),
    );
    expect(() => captureFree.curry({})).toThrow(
      "no compiler-declared params slot",
    );
  });

  it("validates the complete params record without reading symbolic cells", () => {
    const base = curryView(closureBase());
    expect(() => base.curry({})).toThrow("missing required property offset");
    expect(() => base.curry({ offset: 1, extra: true })).toThrow(
      "additional property extra",
    );
    expect(() => base.curry({ offset: "wrong" })).toThrow(
      "offset: value does not match type number",
    );
    expect(() => base.curry({ offset: () => 1 })).toThrow(
      "arbitrary functions",
    );

    const offset = runtime.getCell<number>(
      space,
      "offset",
      { type: "number" },
      tx,
    );
    const cellBound = base.curry({ offset });
    expect((stateOf(cellBound).params as any).offset).toBe(offset);

    const link = offset.getAsLink({ includeSchema: true });
    const linkBound = base.curry({ offset: link });
    expect((stateOf(linkBound).params as any).offset).toBe(link);
  });

  it("validates factory shapes while preserving direct and cell bindings", () => {
    const moduleArgument = { type: "number" } as const satisfies JSONSchema;
    const moduleResult = { type: "string" } as const satisfies JSONSchema;
    const contract = {
      kind: "module",
      argumentSchema: moduleArgument,
      resultSchema: moduleResult,
    } as const;
    const schema = {
      type: "object",
      properties: {
        operation: { asFactory: contract },
      },
      required: ["operation"],
      additionalProperties: false,
    } as unknown as JSONSchema;
    const base = curryView(closureBase(schema));
    const operation = lift(
      (value: number) => String(value),
      moduleArgument,
      moduleResult,
    );
    const directBound = base.curry({ operation });
    expect((stateOf(directBound).params as any).operation).toBe(operation);

    const operationCell = runtime.getCell(
      space,
      "operation",
      { asFactory: contract } as unknown as JSONSchema,
      tx,
    );
    const cellBound = base.curry({ operation: operationCell });
    expect((stateOf(cellBound).params as any).operation).toBe(operationCell);

    const wrongKind = handler(
      { type: "number" },
      { type: "object" },
      () => undefined,
    );
    expect(() => base.curry({ operation: wrongKind })).toThrow(
      "factory kind mismatch",
    );

    const outer = pattern(
      ((input: any) => ({
        bound: base.curry({ operation: input.operation }),
      })) as any,
      schema,
    );
    const serializedBound = (outer.result as any).bound;
    expect((stateOf(serializedBound).params as any).operation).toMatchObject({
      $alias: { cell: "argument", path: ["operation"] },
    });
  });

  it("keeps an invoked bound factory canonical with symbolic params", () => {
    const base = curryView(closureBase());
    const ref = {
      identity: "E".repeat(43),
      symbol: "boundFactory",
    };
    setDurableArtifactEntryRef(base, ref);

    const parent = pattern(
      ((input: any) => {
        const bound = base.curry({ offset: input.offset });
        return { result: bound({ value: input.value }) };
      }) as any,
      {
        type: "object",
        properties: {
          value: { type: "number" },
          offset: { type: "number" },
        },
        required: ["value", "offset"],
        additionalProperties: false,
      },
      RESULT_SCHEMA,
    );

    expect(parent.nodes).toHaveLength(1);
    const module = parent.nodes[0]!.module;
    expect(sealFactoryState(module)).toMatchObject({
      kind: "pattern",
      ref,
      params: {
        offset: {
          $alias: { cell: "argument", path: ["offset"] },
        },
      },
    });
    expect((module as unknown as { type?: unknown }).type).toBeUndefined();
    expect(
      (module as unknown as { implementation?: unknown }).implementation,
    ).toBeUndefined();
  });

  it("preserves canonical state regardless of modifier order", () => {
    const base = curryView(closureBase());
    setDurableArtifactEntryRef(base, {
      identity: "E".repeat(43),
      symbol: "closureFactory",
    });
    const params = { offset: 3 };
    const curryFirst = base.curry(params).asScope("user").inSpace("child");
    const modifiersFirst = curryView(
      base.asScope("user").inSpace("child"),
    ).curry(params);

    expect(sealFactoryState(curryFirst)).toEqual(
      sealFactoryState(modifiersFirst),
    );
  });
});
