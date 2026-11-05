import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";

import { pattern, withPatternParamsSchema } from "../src/builder/pattern.ts";
import type {
  BuilderFunctionsAndConstants,
  JSONSchema,
  PatternFactory,
} from "../src/builder/types.ts";
import { getMetaLink, parseLink } from "../src/link-utils.ts";
import { Runtime } from "../src/runtime.ts";
import { cfcLabelViewForCell } from "../src/cfc/label-view.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "./cfc-seed-envelope.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";

const signer = await Identity.fromPassphrase(
  "pattern closure params cross space test",
);
const parentSpace = signer.did();
const captureSpace = (await Identity.fromPassphrase(
  "pattern closure params capture source",
)).did();

const VALUE_SCHEMA = { type: "number" } as const satisfies JSONSchema;
const ARGUMENT_SCHEMA = {
  type: "object",
  properties: { value: VALUE_SCHEMA },
  required: ["value"],
  additionalProperties: false,
} as const satisfies JSONSchema;
const RESULT_SCHEMA = {
  type: "object",
  properties: { result: VALUE_SCHEMA },
  required: ["result"],
  additionalProperties: false,
} as const satisfies JSONSchema;
const NESTED_PARAMS_SCHEMA = {
  type: "object",
  properties: {
    nested: {
      type: "object",
      properties: { value: VALUE_SCHEMA },
      required: ["value"],
      additionalProperties: false,
    },
  },
  required: ["nested"],
  additionalProperties: false,
} as const satisfies JSONSchema;
const SOURCE_SCHEMA = {
  type: "object",
  properties: {
    nested: {
      type: "object",
      properties: { value: VALUE_SCHEMA },
      required: ["value"],
      additionalProperties: false,
    },
  },
  required: ["nested"],
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

async function within<T>(
  promise: Promise<T>,
  label: string,
  timeoutMs = 2_000,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`Timed out waiting for ${label}`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

describe("cross-space pattern closure params", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;
  let commonfabric: BuilderFunctionsAndConstants;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      cfcEnforcementMode: "enforce-explicit",
      cfcFlowLabels: "persist",
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

  async function commitAndRenew(): Promise<void> {
    if (tx.status().status === "ready") {
      runtime.prepareTxForCommit(tx);
      const { error } = await tx.commit().settled;
      expect(error).toBeUndefined();
    }
    tx = runtime.edit();
  }

  function nestedValueBase() {
    const add = commonfabric.lift(
      ({ value, captured }: { value: number; captured: number }) => ({
        result: value + captured,
      }),
      {
        type: "object",
        properties: { value: VALUE_SCHEMA, captured: VALUE_SCHEMA },
        required: ["value", "captured"],
        additionalProperties: false,
      },
      RESULT_SCHEMA,
    );
    return pattern(
      withPatternParamsSchema(
        ((argument: any, params: any) =>
          add({
            value: argument.value,
            captured: params.nested.value,
          })) as any,
        NESTED_PARAMS_SCHEMA,
      ) as any,
      ARGUMENT_SCHEMA,
      RESULT_SCHEMA,
    );
  }

  function owningResultCell(projected: ReturnType<typeof runtime.getCell>) {
    const ownerLink = getMetaLink(projected, "result");
    if (ownerLink === undefined) return projected;
    const { overwrite: _, ...ownerTarget } = ownerLink;
    return runtime.getCellFromLink(ownerTarget);
  }

  it("keeps a nested cross-space capture linked and carries its CFC label", async () => {
    const source = runtime.getCell<{ nested: { value: number } }>(
      captureSpace,
      "labeled nested capture source",
      SOURCE_SCHEMA,
      tx,
    );
    const sourceLink = source.getAsNormalizedFullLink();
    writeSeedEnvelopeDoc(tx, sourceLink.space);
    seedStoredEnvelope(tx, {
      space: sourceLink.space,
      scope: sourceLink.scope,
      id: sourceLink.id,
      path: [],
    }, {
      value: { nested: { value: 8 } },
      cfc: {
        version: 1,
        schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
        labelMap: {
          version: 1,
          entries: [{
            path: ["nested", "value"],
            label: { confidentiality: ["captured-param-secret"] },
          }],
        },
      },
    });
    await commitAndRenew();

    const captured = source.key("nested").key("value");
    const outer = pattern(
      ((input: any) => ({
        child: curry(nestedValueBase(), {
          nested: { value: input.capture },
        })({ value: input.value }),
      })) as any,
      {
        type: "object",
        properties: {
          value: VALUE_SCHEMA,
          capture: VALUE_SCHEMA,
        },
        required: ["value", "capture"],
        additionalProperties: false,
      },
    );
    const resultCell = runtime.getCell<Record<string, unknown>>(
      parentSpace,
      "nested cross-space params result",
      outer.resultSchema,
      tx,
    );
    const result = runtime.run(
      tx,
      outer,
      { value: 5, capture: captured },
      resultCell,
    );
    await commitAndRenew();

    expect(
      await within(result.key("child").pull(), "nested cross-space result"),
    )
      .toEqual({
        result: 13,
      });
    const childResult = owningResultCell(result.key("child").resolveAsCell());
    const paramsLink = getMetaLink(childResult, "params");
    expect(paramsLink).toBeDefined();
    const paramsCell = runtime.getCellFromLink(paramsLink!);
    const raw = paramsCell.getRaw() as { nested: { value: unknown } };
    expect(JSON.stringify(raw)).not.toContain("cfcLabelView");
    const capturedLink = parseLink(raw.nested.value, paramsCell);
    const outerArgumentLink = getMetaLink(result, "argument")!;
    expect(capturedLink).toMatchObject({
      space: outerArgumentLink.space,
      id: outerArgumentLink.id,
      path: ["capture"],
      scope: outerArgumentLink.scope,
    });
    expect(raw.nested.value).not.toBe(8);

    const outerArgument = runtime.getCellFromLink(outerArgumentLink);
    const rawArgument = outerArgument.getRaw() as { capture: unknown };
    const crossSpaceLink = parseLink(rawArgument.capture, outerArgument);
    const expectedCrossSpaceLink = captured.getAsNormalizedFullLink();
    expect(crossSpaceLink).toMatchObject({
      space: captureSpace,
      id: expectedCrossSpaceLink.id,
      path: expectedCrossSpaceLink.path,
      scope: expectedCrossSpaceLink.scope,
    });

    expect(cfcLabelViewForCell(paramsCell.key("nested").key("value")))
      .toMatchObject({
        entries: [{
          path: [],
          label: {
            confidentiality: expect.arrayContaining([
              "captured-param-secret",
            ]),
          },
        }],
      });
  });
});
