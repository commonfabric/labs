import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  createFactoryShell,
  factoryStateOf,
  sealFactoryState,
} from "@commonfabric/data-model/fabric-factory";
import { Identity } from "@commonfabric/identity";

import {
  getFrameworkProvidedPaths,
  setDurableArtifactEntryRef,
  setFrameworkProvidedPaths,
} from "../src/builder/pattern-metadata.ts";
import type {
  BuilderFunctionsAndConstants,
  JSONSchema,
  Reactive,
} from "../src/builder/types.ts";
import {
  type FactoryContract,
  materializeFactory,
} from "../src/factory-materialization.ts";
import { factoryContractFromSchema } from "../src/factory-contract.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import type {
  IExtendedStorageTransaction,
  MemorySpace,
} from "../src/storage/interface.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";

const signer = await Identity.fromPassphrase(
  "dynamic factory framework authority test",
);
const space = signer.did();

const ARGUMENT_SCHEMA = {
  type: "object",
  properties: {
    value: { type: "number" },
    sandboxId: { type: "string" },
  },
  required: ["value", "sandboxId"],
  additionalProperties: false,
} as const satisfies JSONSchema;

const RESULT_SCHEMA = {
  type: "object",
  properties: { result: { type: "number" } },
  required: ["result"],
  additionalProperties: false,
} as const satisfies JSONSchema;

const FRAMEWORK_PATHS = [["sandboxId"]] as const;

type AuthorityContract =
  & FactoryContract
  & Readonly<{
    frameworkProvidedPaths: readonly (readonly string[])[];
  }>;

const PRIVILEGED_CONTRACT = {
  kind: "module",
  argumentSchema: ARGUMENT_SCHEMA,
  resultSchema: RESULT_SCHEMA,
  frameworkProvidedPaths: FRAMEWORK_PATHS,
} as const satisfies AuthorityContract;

const ORDINARY_CONTRACT = {
  kind: "module",
  argumentSchema: ARGUMENT_SCHEMA,
  resultSchema: RESULT_SCHEMA,
  frameworkProvidedPaths: [],
} as const satisfies AuthorityContract;

const REFS = {
  privileged: {
    identity: "A".repeat(43),
    symbol: "privilegedFactory",
  },
  ordinary: {
    identity: `${"B".repeat(42)}A`,
    symbol: "ordinaryFactory",
  },
} as const;

type InvokeFactory = <T, R>(
  factory: unknown,
  input: T,
  expected: FactoryContract,
) => Reactive<R>;

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

describe("dynamic Factory@1 framework authority", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;
  let commonfabric: BuilderFunctionsAndConstants;
  let invokeFactory: InvokeFactory;
  let warmArtifacts: Map<string, unknown>;
  let pendingReleases: Array<() => void>;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    tx = runtime.edit();
    commonfabric = createTrustedBuilder(runtime).commonfabric;
    invokeFactory = (commonfabric as unknown as {
      __cfHelpers: { invokeFactory: InvokeFactory };
    }).__cfHelpers.invokeFactory;
    warmArtifacts = new Map();
    pendingReleases = [];
    runtime.patternManager.artifactFromIdentitySync = (identity, symbol) =>
      warmArtifacts.get(refKey(identity, symbol));
    runtime.patternManager.isArtifactAvailableInSpace = (
      identity,
      artifactSpace,
    ) =>
      artifactSpace === space &&
      Object.values(REFS).some((ref) => ref.identity === identity);
  });

  afterEach(async () => {
    for (const release of pendingReleases) release();
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

  function makeFactories(executions: Array<"privileged" | "ordinary">) {
    const privileged = commonfabric.lift(
      ({ value }: { value: number; sandboxId: string }) => {
        executions.push("privileged");
        return { result: value * 10 };
      },
      ARGUMENT_SCHEMA,
      RESULT_SCHEMA,
    );
    const ordinary = commonfabric.lift(
      ({ value }: { value: number; sandboxId: string }) => {
        executions.push("ordinary");
        return { result: value * 100 };
      },
      ARGUMENT_SCHEMA,
      RESULT_SCHEMA,
    );
    setFrameworkProvidedPaths(privileged, FRAMEWORK_PATHS);
    setFrameworkProvidedPaths(ordinary, []);
    setDurableArtifactEntryRef(privileged, REFS.privileged);
    setDurableArtifactEntryRef(ordinary, REFS.ordinary);
    return { privileged, ordinary };
  }

  function outerPattern() {
    return commonfabric.pattern<
      { factory: unknown; value: number; sandboxId: string },
      { result: number }
    >(
      ({ factory, value, sandboxId }) =>
        invokeFactory<
          { value: number; sandboxId: string },
          { result: number }
        >(
          factory,
          { value, sandboxId },
          PRIVILEGED_CONTRACT,
        ),
      {
        type: "object",
        properties: {
          factory: { asFactory: PRIVILEGED_CONTRACT },
          value: { type: "number" },
          sandboxId: { type: "string" },
        },
        required: ["factory", "value", "sandboxId"],
        additionalProperties: false,
      },
      RESULT_SCHEMA,
    );
  }

  it("compares compiler-expected paths with trusted side metadata, never FactoryStateV1", () => {
    const { privileged, ordinary } = makeFactories([]);

    expect(getFrameworkProvidedPaths(privileged)).toEqual(FRAMEWORK_PATHS);
    expect(getFrameworkProvidedPaths(ordinary)).toEqual([]);

    for (const factory of [privileged, ordinary]) {
      expect(factoryStateOf(factory)).not.toHaveProperty(
        "frameworkProvidedPaths",
      );
      expect(sealFactoryState(factory)).not.toHaveProperty(
        "frameworkProvidedPaths",
      );
    }
    const authoredExpected = factoryContractFromSchema({
      asFactory: PRIVILEGED_CONTRACT,
    });
    expect(authoredExpected).not.toHaveProperty("frameworkProvidedPaths");

    expect(
      materializeFactory(privileged, {
        runtime,
        artifactSpace: space,
        expected: authoredExpected,
      }),
    ).toBe(privileged);

    expect(
      materializeFactory(privileged, {
        runtime,
        artifactSpace: space,
        expected: PRIVILEGED_CONTRACT,
      }),
    ).toBe(privileged);
    expect(
      materializeFactory(ordinary, {
        runtime,
        artifactSpace: space,
        expected: ORDINARY_CONTRACT,
      }),
    ).toBe(ordinary);

    expect(() =>
      materializeFactory(ordinary, {
        runtime,
        artifactSpace: space,
        expected: PRIVILEGED_CONTRACT,
      })
    ).toThrow(/framework.*provided.*mismatch/i);
    expect(() =>
      materializeFactory(privileged, {
        runtime,
        artifactSpace: space,
        expected: ORDINARY_CONTRACT,
      })
    ).toThrow(/framework.*provided.*mismatch/i);
  });

  it("rejects a warm authority mismatch before callback and recovers privileged -> ordinary -> cold privileged", async () => {
    const executions: Array<"privileged" | "ordinary"> = [];
    const { privileged, ordinary } = makeFactories(executions);
    warmArtifacts.set(
      refKey(REFS.privileged.identity, REFS.privileged.symbol),
      privileged,
    );
    warmArtifacts.set(
      refKey(REFS.ordinary.identity, REFS.ordinary.symbol),
      ordinary,
    );

    const privilegedState = sealFactoryState(privileged);
    const selector = runtime.getCell<unknown>(
      space,
      "dynamic-framework-authority-selector",
      undefined,
      tx,
    );
    const value = runtime.getCell<number>(
      space,
      "dynamic-framework-authority-value",
      { type: "number" },
      tx,
    );
    selector.set(createFactoryShell(privilegedState));
    value.set(1);
    const resultCell = runtime.getCell<{ result: number }>(
      space,
      "dynamic-framework-authority-result",
      RESULT_SCHEMA,
      tx,
    );
    const result = runtime.run(
      tx,
      outerPattern(),
      { factory: selector, value, sandboxId: "system-sandbox" },
      resultCell,
    );
    const outputIdentity = result.key("result").getAsNormalizedFullLink();
    await commitAndRenew();

    expect(await within(result.pull(), "initial privileged result")).toEqual({
      result: 10,
    });
    expect(executions).toEqual(["privileged"]);

    const mismatch = Promise.withResolvers<Error>();
    runtime.scheduler.onError((error) => mismatch.resolve(error));
    selector.withTx(tx).set(
      createFactoryShell(sealFactoryState(ordinary)),
    );
    await commitAndRenew();

    expect(
      (await within(mismatch.promise, "warm authority mismatch")).message,
    ).toMatch(/framework.*provided.*mismatch/i);
    expect(executions).toEqual(["privileged"]);
    expect(await within(result.pull(), "retained privileged result")).toEqual({
      result: 10,
    });

    value.withTx(tx).set(2);
    await commitAndRenew();
    await within(runtime.idle(), "idle after invalid ordinary selection");
    expect(executions).toEqual(["privileged"]);
    expect(await within(result.pull(), "retained result after input change"))
      .toEqual({ result: 10 });

    warmArtifacts.delete(
      refKey(REFS.privileged.identity, REFS.privileged.symbol),
    );
    const loadEntered = Promise.withResolvers<MemorySpace>();
    const releaseLoad = Promise.withResolvers<void>();
    pendingReleases.push(releaseLoad.resolve);
    runtime.patternManager.loadArtifactByIdentity = async (
      identity,
      symbol,
      artifactSpace,
    ) => {
      expect({ identity, symbol }).toEqual(REFS.privileged);
      loadEntered.resolve(artifactSpace);
      await releaseLoad.promise;
      warmArtifacts.set(refKey(identity, symbol), privileged);
      return privileged;
    };

    const recovered = Promise.withResolvers<{ result: number }>();
    const cancelResultSink = result.sink((current) => {
      if (current?.result === 20) recovered.resolve(current);
    });
    try {
      selector.withTx(tx).set(createFactoryShell(privilegedState));
      await commitAndRenew();

      expect(await within(loadEntered.promise, "cold privileged load"))
        .toBe(space);
      expect(await within(result.pull(), "result while recovery is cold"))
        .toEqual({ result: 10 });
      expect(executions).toEqual(["privileged"]);

      releaseLoad.resolve();
      expect(await within(recovered.promise, "cold privileged recovery"))
        .toEqual({ result: 20 });
    } finally {
      cancelResultSink();
      releaseLoad.resolve();
    }

    expect(executions).toEqual(["privileged", "privileged"]);
    expect(result.key("result").getAsNormalizedFullLink()).toEqual(
      outputIdentity,
    );
  });
});
