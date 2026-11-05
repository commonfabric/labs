import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  createFactoryShell,
  factoryStateOf,
  sealFactoryState,
} from "@commonfabric/data-model/fabric-factory";
import { Identity } from "@commonfabric/identity";

import { setDurableArtifactEntryRef } from "../src/builder/pattern-metadata.ts";
import { withPatternParamsSchema } from "../src/builder/pattern.ts";
import type {
  BuilderFunctionsAndConstants,
  FabricValue,
  JSONSchema,
  PatternFactory,
  Reactive,
} from "../src/builder/types.ts";
import type { FactoryContract } from "../src/factory-materialization.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "./cfc-seed-envelope.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";

const signer = await Identity.fromPassphrase(
  "dynamic pattern params replacement test",
);
const space = signer.did();

const PUBLIC_SCHEMA = {
  type: "object",
  properties: { value: { type: "number" } },
  required: ["value"],
  additionalProperties: false,
} as const satisfies JSONSchema;

const PARAMS_SCHEMA = {
  type: "object",
  properties: {
    tag: { type: "string" },
    offset: { type: "number" },
  },
  required: ["tag", "offset"],
  additionalProperties: false,
} as const satisfies JSONSchema;

const COMPUTE_SCHEMA = {
  type: "object",
  properties: {
    value: { type: "number" },
    tag: { type: "string" },
    offset: { type: "number" },
  },
  required: ["value", "tag", "offset"],
  additionalProperties: false,
} as const satisfies JSONSchema;

const RESULT_SCHEMA = {
  type: "object",
  properties: {
    factory: { type: "string" },
    tag: { type: "string" },
    captured: { type: "number" },
    value: { type: "number" },
    result: { type: "number" },
  },
  required: ["factory", "tag", "captured", "value", "result"],
  additionalProperties: false,
} as const satisfies JSONSchema;

const PATTERN_CONTRACT = {
  kind: "pattern",
  argumentSchema: PUBLIC_SCHEMA,
  resultSchema: RESULT_SCHEMA,
} as const satisfies FactoryContract;

const REFS = {
  a: {
    identity: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    symbol: "paramsPatternA",
  },
  b: {
    identity: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBA",
    symbol: "paramsPatternB",
  },
} as const;

type InvokeFactory = <T, R>(
  factory: unknown,
  input: T,
  expected: FactoryContract,
) => Reactive<R>;

type Result = {
  factory: string;
  tag: string;
  captured: number;
  value: number;
  result: number;
};

type Run = {
  factory: "A" | "B";
  tag: string;
  offset: number;
  value: number;
};

type CurryView<T, R> = PatternFactory<T, R> & {
  curry(params: unknown): PatternFactory<T, R>;
};

function curry<T, R>(
  factory: PatternFactory<T, R>,
  params: unknown,
): PatternFactory<T, R> {
  return (factory as CurryView<T, R>).curry(params);
}

function refKey(identity: string, symbol: string): string {
  return `${identity}#${symbol}`;
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

describe("dynamic pattern params replacement", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;
  let commonfabric: BuilderFunctionsAndConstants;
  let invokeFactory: InvokeFactory;
  let warmArtifacts: Map<string, unknown>;
  let releasePending: Array<() => void>;

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
    warmArtifacts = new Map();
    releasePending = [];
    runtime.patternManager.artifactFromIdentitySync = (identity, symbol) =>
      warmArtifacts.get(refKey(identity, symbol));
    // Destination durability and this runtime's warm artifact cache are
    // independent. Both refs are already published in the destination; later
    // deleting A from warmArtifacts exercises cold local loading only.
    runtime.patternManager.isArtifactAvailableInSpace = (identity) =>
      identity === REFS.a.identity || identity === REFS.b.identity;
  });

  afterEach(async () => {
    for (const release of releasePending) release();
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

  async function writeLabeledSelection(
    selector: ReturnType<typeof runtime.getCell>,
    value: FabricValue,
    confidentiality: string,
  ): Promise<void> {
    const link = selector.getAsNormalizedFullLink();
    writeSeedEnvelopeDoc(tx, link.space);
    seedStoredEnvelope(tx, {
      space: link.space,
      scope: link.scope,
      id: link.id,
      path: [],
    }, {
      value,
      cfc: {
        version: 1,
        schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
        labelMap: {
          version: 1,
          entries: [{
            path: [],
            label: { confidentiality: [confidentiality] },
          }],
        },
      },
    });
    await commitAndRenew();
  }

  function outputConfidentiality(result: ReturnType<typeof runtime.getCell>) {
    const link = result.resolveAsCell().getAsNormalizedFullLink();
    const replica = storageManager.open(link.space).replica as unknown as {
      getDocument(id: string): {
        cfc?: {
          labelMap?: {
            entries: Array<{
              origin?: string;
              label: { confidentiality?: string[] };
            }>;
          };
        };
      } | undefined;
    };
    return (replica.getDocument(link.id)?.cfc?.labelMap?.entries ?? [])
      .filter((entry) => entry.origin === "derived")
      .flatMap((entry) => entry.label.confidentiality ?? []);
  }

  function outerPattern() {
    return commonfabric.pattern<
      { factory: unknown; value: number },
      Result
    >(
      ({ factory, value }) =>
        invokeFactory<{ value: number }, Result>(
          factory,
          { value },
          PATTERN_CONTRACT,
        ),
      {
        type: "object",
        properties: {
          factory: { asFactory: PATTERN_CONTRACT },
          value: { type: "number" },
        },
        required: ["factory", "value"],
        additionalProperties: false,
      },
      RESULT_SCHEMA,
    );
  }

  it("fences A(params1) -> B(params2) -> A(params3) generations", async () => {
    const runs: Run[] = [];
    const staleAEntered = Promise.withResolvers<void>();
    const releaseStaleA = Promise.withResolvers<void>();
    releasePending.push(releaseStaleA.resolve);

    const computeA = commonfabric.lift(
      (async (
        { value, tag, offset }: {
          value: number;
          tag: string;
          offset: number;
        },
      ): Promise<Result> => {
        runs.push({ factory: "A", tag, offset, value });
        if (tag === "A1") {
          staleAEntered.resolve();
          await releaseStaleA.promise;
        }
        return {
          factory: "A",
          tag,
          captured: offset,
          value,
          result: value + offset,
        };
      }) as unknown as (input: {
        value: number;
        tag: string;
        offset: number;
      }) => Result,
      COMPUTE_SCHEMA,
      RESULT_SCHEMA,
    );
    const computeB = commonfabric.lift(
      ({ value, tag, offset }: {
        value: number;
        tag: string;
        offset: number;
      }): Result => {
        runs.push({ factory: "B", tag, offset, value });
        return {
          factory: "B",
          tag,
          captured: offset,
          value,
          result: value + offset,
        };
      },
      COMPUTE_SCHEMA,
      RESULT_SCHEMA,
    );

    const baseA = commonfabric.pattern<{ value: number }, Result>(
      withPatternParamsSchema(
        ((argument: { value: number }, params: {
          tag: string;
          offset: number;
        }) =>
          computeA({
            value: argument.value,
            tag: params.tag,
            offset: params.offset,
          })) as never,
        PARAMS_SCHEMA,
      ) as never,
      PUBLIC_SCHEMA,
      RESULT_SCHEMA,
    );
    const baseB = commonfabric.pattern<{ value: number }, Result>(
      withPatternParamsSchema(
        ((argument: { value: number }, params: {
          tag: string;
          offset: number;
        }) =>
          computeB({
            value: argument.value,
            tag: params.tag,
            offset: params.offset,
          })) as never,
        PARAMS_SCHEMA,
      ) as never,
      PUBLIC_SCHEMA,
      RESULT_SCHEMA,
    );
    setDurableArtifactEntryRef(baseA, REFS.a);
    setDurableArtifactEntryRef(baseB, REFS.b);
    warmArtifacts.set(refKey(REFS.a.identity, REFS.a.symbol), baseA);
    warmArtifacts.set(refKey(REFS.b.identity, REFS.b.symbol), baseB);

    const a1 = curry(baseA, { tag: "A1", offset: 10 });
    const b2 = curry(baseB, { tag: "B2", offset: 100 });
    const a3 = curry(baseA, { tag: "A3", offset: 1_000 });
    const selector = runtime.getCell<unknown>(
      space,
      SEED_ENVELOPE_SCHEMA_HASH,
      undefined,
      tx,
    );
    const value = runtime.getCell<number>(
      space,
      "dynamic-pattern-params-value",
      { type: "number" },
      tx,
    );
    value.set(1);
    await writeLabeledSelection(
      selector,
      createFactoryShell(sealFactoryState(a1)),
      "selected-A1",
    );
    const resultCell = runtime.getCell<Result>(
      space,
      "dynamic-pattern-params-result",
      RESULT_SCHEMA,
      tx,
    );
    const result = runtime.run(
      tx,
      outerPattern(),
      { factory: selector, value },
      resultCell,
    );
    const outputIdentity = result.key("result").getAsNormalizedFullLink();
    await commitAndRenew();
    await within(staleAEntered.promise, "A1 execution to enter");
    const observedTags: string[] = [];
    const cancelObservation = result.sink((value) => {
      if (value && typeof value === "object" && "tag" in value) {
        observedTags.push((value as Result).tag);
      }
    });
    releasePending.push(cancelObservation);

    await writeLabeledSelection(
      selector,
      createFactoryShell(sealFactoryState(b2)),
      "selected-B2",
    );
    const storedB2 = selector.withTx(runtime.readTx())
      .getWithoutFactoryMaterialization();
    expect(factoryStateOf(storedB2).ref).toEqual(REFS.b);
    // Scheduler actions are globally serialized: cancellation fences A1's
    // transaction immediately, but JavaScript cannot forcibly settle the
    // authored promise. Release it so the queued B2 generation can execute;
    // the important contract is that A1 cannot commit or remain subscribed.
    releaseStaleA.resolve();
    expect(await within(result.pull(), "B2 replacement result")).toEqual({
      factory: "B",
      tag: "B2",
      captured: 100,
      value: 1,
      result: 101,
    });
    expect(result.key("result").getAsNormalizedFullLink()).toEqual(
      outputIdentity,
    );

    await within(runtime.idle(), "idle after stale A1 completion");
    expect(observedTags).not.toContain("A1");
    // CFC confidentiality is monotone at a stable durable output identity:
    // prior-generation labels may remain conservatively joined, but the live
    // generation's selector label must be present on every changed result.
    expect(outputConfidentiality(result)).toContain("selected-B2");
    expect(await within(result.pull(), "result after stale A1 completion"))
      .toEqual({
        factory: "B",
        tag: "B2",
        captured: 100,
        value: 1,
        result: 101,
      });

    value.withTx(tx).set(2);
    await commitAndRenew();
    expect(await within(result.pull(), "B2 subscription rerun")).toEqual({
      factory: "B",
      tag: "B2",
      captured: 100,
      value: 2,
      result: 102,
    });
    expect(runs.filter((run) => run.factory === "A")).toHaveLength(1);

    warmArtifacts.delete(refKey(REFS.a.identity, REFS.a.symbol));
    const coldAEntered = Promise.withResolvers<void>();
    const releaseColdA = Promise.withResolvers<void>();
    releasePending.push(releaseColdA.resolve);
    runtime.patternManager.loadArtifactByIdentity = async (
      identity,
      symbol,
    ) => {
      expect({ identity, symbol }).toEqual(REFS.a);
      coldAEntered.resolve();
      await releaseColdA.promise;
      warmArtifacts.set(refKey(identity, symbol), baseA);
      return baseA;
    };

    await writeLabeledSelection(
      selector,
      createFactoryShell(sealFactoryState(a3)),
      "selected-A3",
    );
    await within(coldAEntered.promise, "cold A3 load to enter");
    expect(await within(result.pull(), "retained B2 result while A3 is cold"))
      .toEqual({
        factory: "B",
        tag: "B2",
        captured: 100,
        value: 2,
        result: 102,
      });

    releaseColdA.resolve();
    expect(await within(result.pull(), "active cold A3 resume")).toEqual({
      factory: "A",
      tag: "A3",
      captured: 1_000,
      value: 2,
      result: 1_002,
    });
    await within(runtime.idle(), "idle after cold A3 resume");
    expect(outputConfidentiality(result)).toContain("selected-A3");
    expect(result.key("result").getAsNormalizedFullLink()).toEqual(
      outputIdentity,
    );

    value.withTx(tx).set(3);
    await commitAndRenew();
    expect(await within(result.pull(), "A3 subscription rerun")).toEqual({
      factory: "A",
      tag: "A3",
      captured: 1_000,
      value: 3,
      result: 1_003,
    });
    expect(runs.filter((run) => run.factory === "B")).toHaveLength(2);
    expect(runs.at(-1)).toEqual({
      factory: "A",
      tag: "A3",
      offset: 1_000,
      value: 3,
    });
  });
});
