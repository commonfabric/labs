import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import {
  createFactoryShell,
  sealFactoryState,
} from "@commonfabric/data-model/fabric-factory";
import { Identity } from "@commonfabric/identity";

import { pattern, withPatternParamsSchema } from "../src/builder/pattern.ts";
import { setDurableArtifactEntryRef } from "../src/builder/pattern-metadata.ts";
import type {
  BuilderFunctionsAndConstants,
  FabricValue,
  JSONSchema,
  PatternFactory,
  Reactive,
} from "../src/builder/types.ts";
import type { FactoryContract } from "../src/factory-materialization.ts";
import { cfcLabelViewForCell } from "../src/cfc/label-view.ts";
import { getMetaLink, parseLink } from "../src/link-utils.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import type {
  IExtendedStorageTransaction,
  MemorySpace,
} from "../src/storage/interface.ts";
import {
  SEED_ENVELOPE_SCHEMA_HASH,
  writeSeedEnvelopeDoc,
} from "./cfc-seed-envelope.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";

const signer = await Identity.fromPassphrase(
  "pattern closure factory param provenance test",
);
const parentSpace = signer.did();
const sourceSpace = (await Identity.fromPassphrase(
  "pattern closure factory param artifact source",
)).did();
const executionSpace = (await Identity.fromPassphrase(
  "pattern closure factory param execution target",
)).did();

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
const PATTERN_CONTRACT = {
  kind: "pattern",
  argumentSchema: ARGUMENT_SCHEMA,
  resultSchema: RESULT_SCHEMA,
} as const satisfies FactoryContract;
const PARAMS_SCHEMA = {
  type: "object",
  properties: {
    nested: {
      type: "object",
      properties: { factory: { asFactory: PATTERN_CONTRACT } },
      required: ["factory"],
      additionalProperties: false,
    },
  },
  required: ["nested"],
  additionalProperties: false,
} as unknown as JSONSchema;
const FACTORY_REF = {
  identity: "PAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  symbol: "selectedPattern",
} as const;

type CurryView<T, R> = PatternFactory<T, R> & {
  curry(params: unknown): PatternFactory<T, R>;
};
type InvokeFactory = <T, R>(
  factory: unknown,
  input: T,
  expected: FactoryContract,
) => Reactive<R>;
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

describe("factory-valued pattern closure params provenance", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;
  let commonfabric: BuilderFunctionsAndConstants;
  let invokeFactory: InvokeFactory;

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
    invokeFactory = (commonfabric as unknown as {
      __cfHelpers: { invokeFactory: InvokeFactory };
    }).__cfHelpers.invokeFactory;
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

  function selectedPattern(executions: number[]) {
    const multiply = commonfabric.lift(
      ({ value }: { value: number }) => {
        executions.push(value);
        return { result: value * 2 };
      },
      ARGUMENT_SCHEMA,
      RESULT_SCHEMA,
    );
    const selected = commonfabric.pattern(
      (argument: { value: number }) => multiply(argument),
      ARGUMENT_SCHEMA,
      RESULT_SCHEMA,
    );
    setDurableArtifactEntryRef(selected, FACTORY_REF);
    return selected;
  }

  function dynamicConsumerBase() {
    return pattern(
      withPatternParamsSchema(
        ((argument: any, params: any) =>
          invokeFactory<{ value: number }, { result: number }>(
            params.nested.factory,
            { value: argument.value },
            PATTERN_CONTRACT,
          )) as any,
        PARAMS_SCHEMA,
      ) as any,
      ARGUMENT_SCHEMA,
      RESULT_SCHEMA,
    );
  }

  function inertConsumerBase() {
    return pattern(
      withPatternParamsSchema(
        ((_argument: any, _params: any) => ({ result: 1 })) as any,
        PARAMS_SCHEMA,
      ) as any,
      ARGUMENT_SCHEMA,
      RESULT_SCHEMA,
    );
  }

  async function seedLabeledSelector(shell: FabricValue, cause: string) {
    const selector = runtime.getCell<unknown>(
      sourceSpace,
      cause,
      { asFactory: PATTERN_CONTRACT } as unknown as JSONSchema,
      tx,
    );
    const link = selector.getAsNormalizedFullLink();
    // Model Factory@1 bytes that another runtime already published durably.
    // A Runtime-issued transaction must retain its production publication
    // guard and reject this synthetic ref because this test runtime has no
    // artifact proof yet. Seed through the underlying storage transaction so
    // the consumer paths below can exercise cold/warm loading and provenance.
    writeSeedEnvelopeDoc(tx, link.space);
    const seeded = tx.tx.write({
      space: link.space,
      scope: link.scope,
      id: link.id,
      type: "application/json",
      path: [],
    }, {
      value: shell,
      cfc: {
        version: 1,
        schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
        labelMap: {
          version: 1,
          entries: [{
            path: [],
            label: { confidentiality: ["captured-code-secret"] },
          }],
        },
      },
    });
    expect(seeded.error).toBeUndefined();
    expect((await tx.tx.commit().settled).error).toBeUndefined();
    tx = runtime.edit();
    return runtime.getCellFromLink(link);
  }

  it("cold-loads a nested factory param from its link source, never its inSpace target", async () => {
    const executions: number[] = [];
    const selected = selectedPattern(executions);
    const selectedState = sealFactoryState(selected.inSpace(executionSpace));
    expect(selectedState.kind).toBe("pattern");
    if (selectedState.kind !== "pattern") throw new Error("unreachable");
    expect(selectedState.spaceSelector).toBe(executionSpace);
    const selector = await seedLabeledSelector(
      createFactoryShell(selectedState),
      "cold nested factory param selector",
    );

    runtime.patternManager.artifactFromIdentitySync = () => undefined;
    runtime.patternManager.isArtifactAvailableInSpace = () => false;
    const loadEntered = Promise.withResolvers<MemorySpace>();
    const releaseLoad = Promise.withResolvers<void>();
    const loadReturned = Promise.withResolvers<void>();
    runtime.patternManager.loadArtifactByIdentity = async (
      identity,
      symbol,
      artifactSpace,
    ) => {
      expect({ identity, symbol }).toEqual(FACTORY_REF);
      loadEntered.resolve(artifactSpace);
      await releaseLoad.promise;
      loadReturned.resolve();
      return selected;
    };

    const resultCell = runtime.getCell<{ result: number }>(
      parentSpace,
      "cold nested factory param result",
      RESULT_SCHEMA,
      tx,
    );
    runtime.run(
      tx,
      curry(dynamicConsumerBase(), { nested: { factory: selector } }),
      { value: 7 },
      resultCell,
    );
    await commitAndRenew();

    const artifactSpace = await within(
      loadEntered.promise,
      "nested factory param cold load",
    );
    expect(artifactSpace).toBe(sourceSpace);
    expect(artifactSpace).not.toBe(executionSpace);

    runtime.runner.stop(resultCell);
    releaseLoad.resolve();
    await within(loadReturned.promise, "stopped nested factory load return");
    await runtime.idle();
    expect(executions).toEqual([]);
  });

  it("invokes a warm nested factory param in its selected execution space", async () => {
    const executions: number[] = [];
    const selected = selectedPattern(executions);
    const selectedState = sealFactoryState(selected.inSpace(executionSpace));
    const selector = await seedLabeledSelector(
      createFactoryShell(selectedState),
      "warm nested factory param selector",
    );
    runtime.patternManager.artifactFromIdentitySync = (identity, symbol) =>
      identity === FACTORY_REF.identity && symbol === FACTORY_REF.symbol
        ? selected
        : undefined;
    runtime.patternManager.isArtifactAvailableInSpace = (
      identity,
      artifactSpace,
    ) => identity === FACTORY_REF.identity && artifactSpace === sourceSpace;

    const resultCell = runtime.getCell<{ result: number }>(
      parentSpace,
      "warm nested factory param result",
      RESULT_SCHEMA,
      tx,
    );
    const result = runtime.run(
      tx,
      curry(dynamicConsumerBase(), { nested: { factory: selector } }),
      { value: 7 },
      resultCell,
    );
    await commitAndRenew();

    expect(await within(result.pull(), "warm nested factory param result"))
      .toEqual({ result: 14 });
    expect(executions).toEqual([7]);
    expect(result.resolveAsCell().getAsNormalizedFullLink().space).toBe(
      executionSpace,
    );
  });

  it("exposes a nested factory selector's CFC label through the params cell", async () => {
    const selected = selectedPattern([]);
    const selectedState = sealFactoryState(selected.inSpace(executionSpace));
    const selector = await seedLabeledSelector(
      createFactoryShell(selectedState),
      "labeled nested factory param selector",
    );
    const resultCell = runtime.getCell<{ result: number }>(
      parentSpace,
      "labeled nested factory param result",
      RESULT_SCHEMA,
      tx,
    );
    runtime.run(
      tx,
      curry(inertConsumerBase(), { nested: { factory: selector } }),
      { value: 0 },
      resultCell,
    );
    await commitAndRenew();

    const paramsLink = getMetaLink(resultCell, "params");
    expect(paramsLink).toBeDefined();
    const paramsCell = runtime.getCellFromLink(paramsLink!);
    const raw = paramsCell.getRaw() as { nested: { factory: unknown } };
    expect(parseLink(raw.nested.factory, paramsCell)?.space).toBe(sourceSpace);
    expect(cfcLabelViewForCell(paramsCell.key("nested").key("factory")))
      .toMatchObject({
        entries: [{
          path: [],
          label: {
            confidentiality: expect.arrayContaining([
              "captured-code-secret",
            ]),
          },
        }],
      });
  });
});
