import { Identity } from "@commonfabric/identity";
import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { pattern, withPatternParamsSchema } from "../src/builder/pattern.ts";
import type {
  BuilderFunctionsAndConstants,
  JSONSchema,
  PatternFactory,
} from "../src/builder/types.ts";
import { getMetaCell, getMetaLink, parseLink } from "../src/link-utils.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { resolvedSchema } from "./schema-ref-helpers.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";

const signer = await Identity.fromPassphrase("pattern closure params test");
const space = signer.did();

const PUBLIC_SCHEMA = {
  type: "object",
  properties: { value: { type: "number" } },
  required: ["value"],
  additionalProperties: false,
} as const satisfies JSONSchema;

const OFFSET_PARAMS_SCHEMA = {
  type: "object",
  properties: { offset: { type: "number" } },
  required: ["offset"],
  additionalProperties: false,
} as const satisfies JSONSchema;

const SAME_NAME_PARAMS_SCHEMA = {
  type: "object",
  properties: { value: { type: "number" } },
  required: ["value"],
  additionalProperties: false,
} as const satisfies JSONSchema;

const RESULT_SCHEMA = {
  type: "object",
  properties: {
    publicValue: { type: "number" },
    capturedValue: { type: "number" },
    sum: { type: "number" },
  },
  required: ["publicValue", "capturedValue", "sum"],
  additionalProperties: false,
} as const satisfies JSONSchema;

const COMBINE_INPUT_SCHEMA = {
  type: "object",
  properties: {
    publicValue: { type: "number" },
    capturedValue: { type: "number" },
  },
  required: ["publicValue", "capturedValue"],
  additionalProperties: false,
} as const satisfies JSONSchema;

type CurryView<T, R> = PatternFactory<T, R> & {
  curry(params: unknown): PatternFactory<T, R>;
};

function curry<T, R>(
  factory: PatternFactory<T, R>,
  params: unknown,
): PatternFactory<T, R> {
  return (factory as CurryView<T, R>).curry(params);
}

describe("invocation-owned pattern closure params", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;
  let commonfabric: BuilderFunctionsAndConstants;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    tx = runtime.edit();
    commonfabric = createTrustedBuilder(runtime).commonfabric;
  });

  afterEach(async () => {
    if (tx.status().status === "ready") {
      tx.abort(new Error("test cleanup"));
    }
    await runtime.dispose();
    await storageManager.close();
  });

  function combineFactory() {
    return commonfabric.lift(
      (
        { publicValue, capturedValue }: {
          publicValue: number;
          capturedValue: number;
        },
      ) => ({
        publicValue,
        capturedValue,
        sum: publicValue + capturedValue,
      }),
      COMBINE_INPUT_SCHEMA,
      RESULT_SCHEMA,
    );
  }

  async function commitAndPull<T>(cell: { pull(): Promise<T> }): Promise<T> {
    runtime.prepareTxForCommit(tx);
    const { error } = await tx.commit().settled;
    expect(error).toBeUndefined();
    const value = await cell.pull();
    await runtime.idle();
    return value;
  }

  function owningResultCell(projected: ReturnType<typeof runtime.getCell>) {
    const ownerLink = getMetaLink(projected, "result");
    if (ownerLink === undefined) return projected;
    const { overwrite: _, ...ownerTarget } = ownerLink;
    return runtime.getCellFromLink(ownerTarget);
  }

  it("binds a symbolic capture through a deterministic hidden params cell", async () => {
    const combine = combineFactory();
    const base = pattern(
      withPatternParamsSchema(
        ((argument: any, params: any) =>
          combine({
            publicValue: argument.value,
            capturedValue: params.offset,
          })) as any,
        OFFSET_PARAMS_SCHEMA,
      ) as any,
      PUBLIC_SCHEMA,
      RESULT_SCHEMA,
    );
    const outer = pattern(
      ((input: any) => ({
        child: curry(base, { offset: input.capture })({
          value: input.value,
        }),
      })) as any,
      {
        type: "object",
        properties: {
          value: { type: "number" },
          capture: { type: "number" },
        },
        required: ["value", "capture"],
        additionalProperties: false,
      },
    );
    const resultCell = runtime.getCell(
      space,
      "symbolic closure capture result",
      outer.resultSchema,
      tx,
    );

    const result = runtime.run(
      tx,
      outer,
      { value: 3, capture: 7 },
      resultCell,
    );
    expect(await commitAndPull(result.key("child"))).toEqual({
      publicValue: 3,
      capturedValue: 7,
      sum: 10,
    });

    const childResult = owningResultCell(result.key("child").resolveAsCell());
    const paramsLink = getMetaLink(childResult, "params");
    expect(paramsLink).toBeDefined();
    expect(resolvedSchema(paramsLink!.schema)).toEqual(OFFSET_PARAMS_SCHEMA);

    const inspectTx = runtime.edit();
    const deterministicLink = getMetaCell(
      childResult,
      "params",
      inspectTx,
      OFFSET_PARAMS_SCHEMA,
    ).getAsNormalizedFullLink();
    inspectTx.abort(new Error("read-only deterministic-link check"));
    expect(paramsLink).toMatchObject({
      space: deterministicLink.space,
      id: deterministicLink.id,
      path: deterministicLink.path,
      scope: deterministicLink.scope,
    });

    const paramsCell = runtime.getCellFromLink(paramsLink!);
    const backlink = getMetaLink(paramsCell, "result");
    const childResultLink = childResult.getAsNormalizedFullLink();
    expect(backlink).toMatchObject({
      space: childResultLink.space,
      id: childResultLink.id,
      path: childResultLink.path,
      scope: childResultLink.scope,
    });

    const rawParams = paramsCell.getRaw() as { offset: unknown };
    const capturedLink = parseLink(rawParams.offset, paramsCell);
    const parentArgumentLink = getMetaLink(result, "argument")!;
    expect(capturedLink).toMatchObject({
      space: parentArgumentLink.space,
      id: parentArgumentLink.id,
      path: ["capture"],
      scope: parentArgumentLink.scope,
    });
  });

  it("keeps same-named public input and closure params in separate roots", async () => {
    const combine = combineFactory();
    const base = pattern(
      withPatternParamsSchema(
        ((argument: any, params: any) =>
          combine({
            publicValue: argument.value,
            capturedValue: params.value,
          })) as any,
        SAME_NAME_PARAMS_SCHEMA,
      ) as any,
      PUBLIC_SCHEMA,
      RESULT_SCHEMA,
    );
    const outer = pattern(
      ((input: any) => ({
        child: curry(base, { value: input.closureValue })({
          value: input.publicValue,
        }),
      })) as any,
      {
        type: "object",
        properties: {
          publicValue: { type: "number" },
          closureValue: { type: "number" },
        },
        required: ["publicValue", "closureValue"],
        additionalProperties: false,
      },
    );
    const resultCell = runtime.getCell(
      space,
      "same-named closure roots result",
      outer.resultSchema,
      tx,
    );

    const result = runtime.run(
      tx,
      outer,
      { publicValue: 4, closureValue: 9 },
      resultCell,
    );
    expect(await commitAndPull(result.key("child"))).toEqual({
      publicValue: 4,
      capturedValue: 9,
      sum: 13,
    });

    const childResult = owningResultCell(result.key("child").resolveAsCell());
    const argumentCell = runtime.getCellFromLink(
      getMetaLink(childResult, "argument")!,
    );
    const paramsCell = runtime.getCellFromLink(
      getMetaLink(childResult, "params")!,
    );
    expect(argumentCell.get()).toEqual({ value: 4 });
    expect(paramsCell.get()).toEqual({ value: 9 });
  });

  it("rejects a fresh closure-bearing base before any nodes start", () => {
    let executions = 0;
    const observe = commonfabric.lift(
      ({ value, offset }: { value: number; offset: number }) => {
        executions++;
        return {
          publicValue: value,
          capturedValue: offset,
          sum: value + offset,
        };
      },
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
    const unbound = pattern(
      withPatternParamsSchema(
        ((argument: any, params: any) =>
          observe({ value: argument.value, offset: params.offset })) as any,
        OFFSET_PARAMS_SCHEMA,
      ) as any,
      PUBLIC_SCHEMA,
      RESULT_SCHEMA,
    );
    const resultCell = runtime.getCell(
      space,
      "unbound closure-bearing base result",
      RESULT_SCHEMA,
      tx,
    );

    expect(() =>
      runtime.run(
        tx,
        unbound,
        { value: 5 },
        resultCell,
      )
    ).toThrow(
      /(?:requires.*bound.*params|closure.*params.*bound|params.*not.*bound)/i,
    );
    expect(executions).toBe(0);
  });
});
