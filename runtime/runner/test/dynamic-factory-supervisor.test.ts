import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  createFactoryShell,
  sealFactoryState,
} from "@commonfabric/data-model/fabric-factory";
import { Identity } from "@commonfabric/identity";
import { resolveScopeKey } from "@commonfabric/memory/v2";

import { setDurableArtifactEntryRef } from "../src/builder/pattern-metadata.ts";
import type {
  BuilderFunctionsAndConstants,
  JSONSchema,
  Reactive,
} from "../src/builder/types.ts";
import { stampWaveRunContext, waveRunContextOf } from "../src/executor/wave.ts";
import type { FactoryContract } from "../src/factory-materialization.ts";
import { Runtime, type ServerRunInfo } from "../src/runtime.ts";
import type { Action } from "../src/scheduler.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import type { SpaceReplica } from "../src/storage/v2.ts";
import type {
  IExtendedStorageTransaction,
  TransactionSealDestination,
} from "../src/storage/interface.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";

const signer = await Identity.fromPassphrase(
  "dynamic factory supervisor test",
);
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

const MODULE_CONTRACT = {
  kind: "module",
  argumentSchema: ARGUMENT_SCHEMA,
  resultSchema: RESULT_SCHEMA,
} as const satisfies FactoryContract;

const PATTERN_CONTRACT = {
  kind: "pattern",
  argumentSchema: ARGUMENT_SCHEMA,
  resultSchema: RESULT_SCHEMA,
} as const satisfies FactoryContract;

const REFS = {
  a: {
    identity: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    symbol: "factoryA",
  },
  b: {
    identity: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBA",
    symbol: "factoryB",
  },
  wrong: {
    identity: "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCA",
    symbol: "wrongKindFactory",
  },
} as const;

type InvokeFactory = <T, R>(
  factory: unknown,
  input: T,
  expected: FactoryContract,
) => Reactive<R>;

type Execution = {
  factory: "A" | "B";
  value: number;
};

function refKey(identity: string, symbol: string): string {
  return `${identity}#${symbol}`;
}

function createServingHarness(
  storageManager = StorageManager.emulate({ as: signer }),
) {
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
    servingPosture: true,
    experimental: { serverExecution: true },
  });
  const commonfabric = createTrustedBuilder(runtime).commonfabric;
  const invokeFactory = (commonfabric as unknown as {
    __cfHelpers: { invokeFactory: InvokeFactory };
  }).__cfHelpers.invokeFactory;
  const warmArtifacts = new Map<string, unknown>();
  runtime.patternManager.artifactFromIdentitySync = (identity, symbol) =>
    warmArtifacts.get(refKey(identity, symbol));
  runtime.patternManager.isArtifactAvailableInSpace = (identity) =>
    Object.values(REFS).some((ref) => ref.identity === identity);
  return {
    commonfabric,
    invokeFactory,
    runtime,
    storageManager,
    warmArtifacts,
  };
}

function stampServingRun(
  tx: IExtendedStorageTransaction,
  info: ServerRunInfo,
): void {
  stampWaveRunContext(tx, {
    actionId: info.actionId,
    kind: info.kind,
    ...(info.scopeKeyIdentity === undefined
      ? {}
      : { scopeKeyIdentity: info.scopeKeyIdentity }),
    ...(info.actionScopeKey === undefined
      ? {}
      : { actionScopeKey: info.actionScopeKey }),
  });
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

describe("dynamic Factory@1 supervisor", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;
  let commonfabric: BuilderFunctionsAndConstants;
  let invokeFactory: InvokeFactory;
  let warmArtifacts: Map<string, unknown>;

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
    runtime.patternManager.artifactFromIdentitySync = (identity, symbol) =>
      warmArtifacts.get(refKey(identity, symbol));
    runtime.patternManager.isArtifactAvailableInSpace = (identity) =>
      Object.values(REFS).some((ref) => ref.identity === identity);
  });

  async function commitAndRenew(): Promise<void> {
    if (tx.status().status === "ready") {
      runtime.prepareTxForCommit(tx);
      const { error } = await tx.commit().settled;
      expect(error).toBeUndefined();
    }
    tx = runtime.edit();
  }

  afterEach(async () => {
    if (tx.status().status === "ready") {
      tx.abort(new Error("test cleanup"));
    }
    await runtime.dispose();
    await storageManager.close();
  });

  function outerPattern() {
    const argumentSchema = {
      type: "object",
      properties: {
        factory: { asFactory: MODULE_CONTRACT },
        value: { type: "number" },
      },
      required: ["factory", "value"],
      additionalProperties: false,
    } as const satisfies JSONSchema;

    return commonfabric.pattern<
      { factory: unknown; value: number },
      { result: number }
    >(
      ({ factory, value }) =>
        invokeFactory<{ value: number }, { result: number }>(
          factory,
          { value },
          MODULE_CONTRACT,
        ),
      argumentSchema,
      RESULT_SCHEMA,
    );
  }

  function makeFactories(executions: Execution[]) {
    const factoryA = commonfabric.lift(
      ({ value }: { value: number }) => {
        executions.push({ factory: "A", value });
        return { result: value * 10 };
      },
      ARGUMENT_SCHEMA,
      RESULT_SCHEMA,
    );
    const factoryB = commonfabric.lift(
      ({ value }: { value: number }) => {
        executions.push({ factory: "B", value });
        return { result: value * 100 };
      },
      ARGUMENT_SCHEMA,
      RESULT_SCHEMA,
    );
    setDurableArtifactEntryRef(factoryA, REFS.a);
    setDurableArtifactEntryRef(factoryB, REFS.b);
    return { factoryA, factoryB };
  }

  it("treats a logically equal Factory@1 replay as a no-op", async () => {
    const executions: Execution[] = [];
    const { factoryA } = makeFactories(executions);
    warmArtifacts.set(refKey(REFS.a.identity, REFS.a.symbol), factoryA);
    const stateA = sealFactoryState(factoryA);
    const selector = runtime.getCell<unknown>(
      space,
      "dynamic-factory-equal-selector",
      undefined,
      tx,
    );
    selector.set(createFactoryShell(stateA));
    const resultCell = runtime.getCell<{ result: number }>(
      space,
      "dynamic-factory-equal-result",
      RESULT_SCHEMA,
      tx,
    );
    const result = runtime.run(
      tx,
      outerPattern(),
      { factory: selector, value: 2 },
      resultCell,
    );
    await commitAndRenew();

    expect(await within(result.pull(), "initial equal-state result")).toEqual({
      result: 20,
    });
    await runtime.idle();
    const executionsBeforeReplay = executions.length;

    selector.withTx(tx).set(createFactoryShell({ ...stateA }));
    await commitAndRenew();
    await runtime.idle();

    expect(executions).toHaveLength(executionsBeforeReplay);
    expect(await within(result.pull(), "equal-state replay result")).toEqual({
      result: 20,
    });
  });

  it("cancels a child whose setup commit is refused", async () => {
    const serving = createServingHarness();
    const executions: Execution[] = [];
    const diagnostic = Promise.withResolvers<Error>();
    serving.runtime.scheduler.onError((error) => diagnostic.resolve(error));
    let selectorTx: IExtendedStorageTransaction | undefined;
    let refuseNextSetup = true;
    let refused = false;

    try {
      const makeSelected = (factory: "A" | "B", factor: number) => {
        const compute = serving.commonfabric.lift(
          (value: number) => {
            executions.push({ factory, value });
            return value * factor;
          },
          { type: "number" },
          { type: "number" },
        );
        return serving.commonfabric.pattern(
          ({ value }: { value: number }) => ({ result: compute(value) }),
          ARGUMENT_SCHEMA,
          RESULT_SCHEMA,
        );
      };
      const factoryA = makeSelected("A", 10);
      const factoryB = makeSelected("B", 100);
      setDurableArtifactEntryRef(factoryA, REFS.a);
      setDurableArtifactEntryRef(factoryB, REFS.b);
      serving.warmArtifacts.set(
        refKey(REFS.a.identity, REFS.a.symbol),
        factoryA,
      );
      serving.warmArtifacts.set(
        refKey(REFS.b.identity, REFS.b.symbol),
        factoryB,
      );
      const outer = serving.commonfabric.pattern<
        { factory: unknown; value: number },
        { result: number }
      >(
        ({ factory, value }) =>
          serving.invokeFactory<{ value: number }, { result: number }>(
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
      const setupTx = serving.runtime.edit();
      const selector = serving.runtime.getCell<unknown>(
        space,
        "dynamic-factory-refused-setup-selector",
        undefined,
        setupTx,
      );
      const resultCell = serving.runtime.getCell<{ result: number }>(
        space,
        "dynamic-factory-refused-setup-result",
        RESULT_SCHEMA,
        setupTx,
      );
      const result = serving.runtime.run(
        setupTx,
        outer,
        { factory: selector, value: 6 },
        resultCell,
      );
      serving.runtime.prepareTxForCommit(setupTx);
      expect((await setupTx.commit().settled).error).toBeUndefined();
      await serving.runtime.idle();

      serving.runtime.installSealDestination({
        seal: (sealedTx) => {
          const isSelectedSetup = sealedTx !== selectorTx &&
            (sealedTx.getReactivityLog?.().writes.length ?? 0) > 0;
          if (refuseNextSetup && isSelectedSetup) {
            refuseNextSetup = false;
            refused = true;
            const refusal = {
              name: "StorageTransactionAborted" as const,
              message: "refused dynamic child setup",
              reason: new Error("test refusal"),
            };
            return Promise.resolve({ error: refusal });
          }
          return sealedTx.tx.commit().settled;
        },
      }, { runStamper: stampServingRun });

      selectorTx = serving.runtime.edit();
      serving.runtime.stampServerRun(selectorTx, {
        actionId: "test/dynamic-factory-refused-selector-a",
        kind: "bookkeeping",
      });
      selector.withTx(selectorTx).set(
        createFactoryShell(sealFactoryState(factoryA)),
      );
      expect((await selectorTx.commit().settled).error).toBeUndefined();

      expect(
        (await within(diagnostic.promise, "dynamic child setup refusal"))
          .message,
      ).toContain("refused dynamic child setup");
      await serving.runtime.scheduler.idleWithPendingCommits();
      expect(refused).toBe(true);
      expect(executions).toEqual([]);
      expect(result.key("result").get()).toBeUndefined();

      selectorTx = serving.runtime.edit();
      serving.runtime.stampServerRun(selectorTx, {
        actionId: "test/dynamic-factory-refused-selector-b",
        kind: "bookkeeping",
      });
      selector.withTx(selectorTx).set(
        createFactoryShell(sealFactoryState(factoryB)),
      );
      expect((await selectorTx.commit().settled).error).toBeUndefined();
      expect(await within(result.pull(), "replacement after setup refusal"))
        .toEqual({ result: 600 });
      expect(executions).toEqual([{ factory: "B", value: 6 }]);
    } finally {
      serving.runtime.clearSealDestination();
      await serving.runtime.dispose();
      await serving.storageManager.close();
    }
  });

  it("commits a stamped dynamic child setup through a strict serving seal destination", async () => {
    const serving = createServingHarness();
    let selectorTx: IExtendedStorageTransaction | undefined;
    const childSetupSeal = Promise.withResolvers<{
      context: ReturnType<typeof waveRunContextOf>;
      error?: unknown;
    }>();
    try {
      const selected = serving.commonfabric.pattern(
        ({ value }: { value: number }) => ({ result: value }),
        ARGUMENT_SCHEMA,
        RESULT_SCHEMA,
      );
      setDurableArtifactEntryRef(selected, REFS.a);
      serving.warmArtifacts.set(
        refKey(REFS.a.identity, REFS.a.symbol),
        selected,
      );
      const outer = serving.commonfabric.pattern<
        { factory: unknown; value: number },
        { result: number }
      >(
        ({ factory, value }) =>
          serving.invokeFactory<{ value: number }, { result: number }>(
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
      const setupTx = serving.runtime.edit();
      const selector = serving.runtime.getCell<unknown>(
        space,
        "dynamic-factory-serving-seal-selector",
        undefined,
        setupTx,
      );
      const resultCell = serving.runtime.getCell<{ result: number }>(
        space,
        "dynamic-factory-serving-seal-result",
        RESULT_SCHEMA,
        setupTx,
      );
      const result = serving.runtime.run(
        setupTx,
        outer,
        { factory: selector, value: 4 },
        resultCell,
      );
      serving.runtime.prepareTxForCommit(setupTx);
      expect((await setupTx.commit().settled).error).toBeUndefined();
      await serving.runtime.idle();

      const strictDestination: TransactionSealDestination = {
        seal: async (sealedTx) => {
          const context = waveRunContextOf(sealedTx);
          const carriesWrites =
            (sealedTx.getReactivityLog?.().writes.length ?? 0) > 0;
          const isChildSetup = carriesWrites && sealedTx !== selectorTx;
          if (context === undefined && carriesWrites) {
            const error = new Error(
              "unstamped transaction refused by strict test destination",
            );
            if (isChildSetup) childSetupSeal.resolve({ context, error });
            return Promise.reject(error);
          }
          const committed = await sealedTx.tx.commit().settled;
          if (isChildSetup) {
            childSetupSeal.resolve({
              context,
              ...(committed.error === undefined
                ? {}
                : { error: committed.error }),
            });
          }
          return committed;
        },
      };
      serving.runtime.installSealDestination(strictDestination, {
        runStamper: stampServingRun,
      });

      selectorTx = serving.runtime.edit();
      serving.runtime.stampServerRun(selectorTx, {
        actionId: "test/dynamic-factory-selector-write",
        kind: "bookkeeping",
      });
      selector.withTx(selectorTx).set(
        createFactoryShell(sealFactoryState(selected)),
      );
      expect((await selectorTx.commit().settled).error).toBeUndefined();

      const childSeal = await childSetupSeal.promise;
      expect(childSeal.context).toBeDefined();
      expect(childSeal.error).toBeUndefined();
      await serving.runtime.idle();
      expect(await result.pull()).toEqual({ result: 4 });
    } finally {
      serving.runtime.clearSealDestination();
      await serving.runtime.dispose();
      await serving.storageManager.close();
    }
  });

  it("keeps demanded per-user dynamic factory selections independent", async () => {
    const alice = {
      principal: "did:key:dynamic-factory-alice",
      sessionId: "dynamic-factory-alice-session" as never,
    };
    const bob = {
      principal: "did:key:dynamic-factory-bob",
      sessionId: "dynamic-factory-bob-session" as never,
    };
    const serving = createServingHarness();
    const executions: Execution[] = [];
    const scopedResultSchema = {
      type: "object",
      properties: { result: { type: "number", scope: "user" } },
      required: ["result"],
      additionalProperties: false,
    } as const satisfies JSONSchema;
    const scopedModuleContract = {
      kind: "module",
      argumentSchema: ARGUMENT_SCHEMA,
      resultSchema: scopedResultSchema,
    } as const satisfies FactoryContract;
    const outputValues = new Map<string, number>();
    const outputsSealed = Promise.withResolvers<void>();
    const baseA = serving.commonfabric.lift(
      ({ value }: { value: number }) => {
        executions.push({ factory: "A", value });
        return { result: value * 10 };
      },
      ARGUMENT_SCHEMA,
      scopedResultSchema,
    );
    const baseB = serving.commonfabric.lift(
      ({ value }: { value: number }) => {
        executions.push({ factory: "B", value });
        return { result: value * 100 };
      },
      ARGUMENT_SCHEMA,
      scopedResultSchema,
    );
    setDurableArtifactEntryRef(baseA, REFS.a);
    setDurableArtifactEntryRef(baseB, REFS.b);
    const factoryA = baseA.asScope("user");
    const factoryB = baseB.asScope("user");
    try {
      serving.warmArtifacts.set(refKey(REFS.a.identity, REFS.a.symbol), baseA);
      serving.warmArtifacts.set(refKey(REFS.b.identity, REFS.b.symbol), baseB);

      const setupTx = serving.runtime.edit();
      const selector = serving.runtime.getCell<unknown>(
        space,
        "dynamic-factory-demanded-selector",
        undefined,
        setupTx,
        "user",
      );
      const value = serving.runtime.getCell<number>(
        space,
        "dynamic-factory-demanded-value",
        { type: "number" },
        setupTx,
        "user",
      );
      const resultCell = serving.runtime.getCell<{ result: number }>(
        space,
        "dynamic-factory-demanded-result",
        scopedResultSchema,
        setupTx,
      );
      serving.runtime.run(
        setupTx,
        (() => {
          const outer = serving.commonfabric.pattern<
            { factory: unknown; value: number },
            { result: number }
          >(
            ({ factory, value }) =>
              serving.invokeFactory<{ value: number }, { result: number }>(
                factory,
                { value },
                scopedModuleContract,
              ),
            {
              type: "object",
              properties: {
                factory: { asFactory: scopedModuleContract },
                value: { type: "number" },
              },
              required: ["factory", "value"],
              additionalProperties: false,
            },
            scopedResultSchema,
          );
          return outer;
        })(),
        { factory: selector, value },
        resultCell,
      );
      serving.runtime.prepareTxForCommit(setupTx);
      expect((await setupTx.commit().settled).error).toBeUndefined();
      await serving.runtime.idle();

      const selectorEffect = [
        ...serving.runtime.scheduler.accessForTestingOnly.nodes.effects,
      ].find((action) =>
        action.name.startsWith("sink:") &&
        action.name.endsWith("/value/factory")
      );
      expect(selectorEffect).toBeDefined();
      const rootId = resultCell.getAsNormalizedFullLink().id;
      expect(
        (selectorEffect as Action & {
          schedulerObservationIdentity?: { pieceRootId?: string };
        }).schedulerObservationIdentity?.pieceRootId,
      ).toBe(rootId);
      const replica = serving.storageManager.open(space)
        .replica as SpaceReplica;
      replica.accessForTestingOnly.applySessionSync({
        type: "sync",
        fromSeq: 0,
        toSeq: 4,
        upserts: [
          {
            branch: "",
            id: selector.getAsNormalizedFullLink().id,
            scope: "user",
            scopeKey: resolveScopeKey("user", alice),
            seq: 1,
            doc: {
              value: createFactoryShell(sealFactoryState(factoryA)),
            } as never,
          },
          {
            branch: "",
            id: value.getAsNormalizedFullLink().id,
            scope: "user",
            scopeKey: resolveScopeKey("user", alice),
            seq: 2,
            doc: { value: 2 },
          },
          {
            branch: "",
            id: selector.getAsNormalizedFullLink().id,
            scope: "user",
            scopeKey: resolveScopeKey("user", bob),
            seq: 3,
            doc: {
              value: createFactoryShell(sealFactoryState(factoryB)),
            } as never,
          },
          {
            branch: "",
            id: value.getAsNormalizedFullLink().id,
            scope: "user",
            scopeKey: resolveScopeKey("user", bob),
            seq: 4,
            doc: { value: 3 },
          },
        ],
        removes: [],
      }, "integrate");

      serving.runtime.installSealDestination({
        seal: (sealedTx) => {
          const context = waveRunContextOf(sealedTx);
          const writes = [...sealedTx.getWriteDetails?.(space) ?? []];
          const principal = context?.scopeKeyIdentity?.principal;
          if (
            context?.kind === "derivation" && context.actionId === "action" &&
            typeof principal === "string" && writes.length > 0
          ) {
            const output = writes.find((write) =>
              write.address.scope === "user" &&
              write.address.path.at(-1) === "result" &&
              typeof write.value === "number"
            )?.value;
            if (typeof output === "number") {
              outputValues.set(principal, output);
              if (outputValues.size === 2) outputsSealed.resolve();
            }
          }
          return Promise.resolve({ ok: {} });
        },
      }, {
        runStamper: stampServingRun,
        runDemanderResolver: (pieceRootIds) =>
          pieceRootIds.includes(rootId) ? [alice, bob] : [],
      });
      serving.runtime.scheduler.invalidateAction(selectorEffect!);
      await serving.runtime.idle();
      await outputsSealed.promise;
      expect(outputValues.get(alice.principal)).toBe(20);
      expect(outputValues.get(bob.principal)).toBe(300);
      expect(executions).toContainEqual({ factory: "A", value: 2 });
      expect(executions).toContainEqual({ factory: "B", value: 3 });
    } finally {
      serving.runtime.clearSealDestination();
      await serving.runtime.dispose();
      await serving.storageManager.close();
    }
  });

  it("replaces warm A with B, cancels A, and retains the output identity", async () => {
    const executions: Execution[] = [];
    const { factoryA, factoryB } = makeFactories(executions);
    warmArtifacts.set(refKey(REFS.a.identity, REFS.a.symbol), factoryA);
    warmArtifacts.set(refKey(REFS.b.identity, REFS.b.symbol), factoryB);
    const selector = runtime.getCell<unknown>(
      space,
      "dynamic-factory-replacement-selector",
      undefined,
      tx,
    );
    const value = runtime.getCell<number>(
      space,
      "dynamic-factory-replacement-value",
      { type: "number" },
      tx,
    );
    selector.set(createFactoryShell(sealFactoryState(factoryA)));
    value.set(2);
    const resultCell = runtime.getCell<{ result: number }>(
      space,
      "dynamic-factory-replacement-result",
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

    expect(await within(result.pull(), "warm A result")).toEqual({
      result: 20,
    });
    await runtime.idle();

    selector.withTx(tx).set(
      createFactoryShell(sealFactoryState(factoryB)),
    );
    await commitAndRenew();
    expect(await within(result.pull(), "warm B replacement result")).toEqual({
      result: 200,
    });
    await runtime.idle();

    expect(result.key("result").getAsNormalizedFullLink()).toEqual(
      outputIdentity,
    );
    const aExecutionsAfterReplacement =
      executions.filter((entry) => entry.factory === "A").length;

    value.withTx(tx).set(3);
    await commitAndRenew();
    expect(await within(result.pull(), "B result after input change")).toEqual({
      result: 300,
    });
    await runtime.idle();

    expect(
      executions.filter((entry) => entry.factory === "A"),
    ).toHaveLength(aExecutionsAfterReplacement);
    expect(executions).toContainEqual({ factory: "B", value: 3 });
  });

  it("cancels stale async work when an intermediate selector redirect retargets", async () => {
    const staleAEntered = Promise.withResolvers<void>();
    const releaseStaleA = Promise.withResolvers<void>();
    const executions: Execution[] = [];
    const factoryA = commonfabric.lift(
      (async ({ value }: { value: number }) => {
        executions.push({ factory: "A", value });
        staleAEntered.resolve();
        await releaseStaleA.promise;
        return { result: value * 10 };
      }) as unknown as (input: { value: number }) => { result: number },
      ARGUMENT_SCHEMA,
      RESULT_SCHEMA,
    );
    const factoryB = commonfabric.lift(
      ({ value }: { value: number }) => {
        executions.push({ factory: "B", value });
        return { result: value * 100 };
      },
      ARGUMENT_SCHEMA,
      RESULT_SCHEMA,
    );
    setDurableArtifactEntryRef(factoryA, REFS.a);
    setDurableArtifactEntryRef(factoryB, REFS.b);
    warmArtifacts.set(refKey(REFS.a.identity, REFS.a.symbol), factoryA);
    warmArtifacts.set(refKey(REFS.b.identity, REFS.b.symbol), factoryB);

    const selectorA = runtime.getCell<unknown>(
      space,
      "dynamic-factory-redirect-selector-a",
      undefined,
      tx,
    );
    const selectorB = runtime.getCell<unknown>(
      space,
      "dynamic-factory-redirect-selector-b",
      undefined,
      tx,
    );
    const intermediate = runtime.getCell<unknown>(
      space,
      "dynamic-factory-redirect-intermediate",
      undefined,
      tx,
    );
    const alias = runtime.getCell<unknown>(
      space,
      "dynamic-factory-redirect-alias",
      undefined,
      tx,
    );
    selectorA.set(createFactoryShell(sealFactoryState(factoryA)));
    selectorB.set(createFactoryShell(sealFactoryState(factoryB)));
    intermediate.setRaw(selectorA.getAsWriteRedirectLink());
    alias.setRaw(intermediate.getAsWriteRedirectLink());

    const resultCell = runtime.getCell<{ result: number }>(
      space,
      "dynamic-factory-redirect-result",
      RESULT_SCHEMA,
      tx,
    );
    const result = runtime.run(
      tx,
      outerPattern(),
      { factory: alias, value: 2 },
      resultCell,
    );
    await commitAndRenew();
    await within(staleAEntered.promise, "redirected stale A execution");

    const observed: number[] = [];
    const cancelObservation = result.sink((current) => {
      if (typeof current?.result === "number") observed.push(current.result);
    });
    try {
      intermediate.withTx(tx).setRaw(
        selectorB.withTx(tx).getAsWriteRedirectLink(),
      );
      await commitAndRenew();
      releaseStaleA.resolve();
      await within(runtime.idle(), "redirected B replacement");

      expect(await within(result.pull(), "redirected B result")).toEqual({
        result: 200,
      });
      expect(observed).not.toContain(20);
      expect(executions).toContainEqual({ factory: "B", value: 2 });
    } finally {
      cancelObservation();
      releaseStaleA.resolve();
    }
  });

  it("never executes cold A when its load completes after warm B is selected", async () => {
    const executions: Execution[] = [];
    const { factoryA, factoryB } = makeFactories(executions);
    warmArtifacts.set(refKey(REFS.b.identity, REFS.b.symbol), factoryB);

    let observeLoadEntered!: () => void;
    const loadEntered = new Promise<void>((resolve) => {
      observeLoadEntered = resolve;
    });
    let releaseLoad!: () => void;
    const loadGate = new Promise<void>((resolve) => {
      releaseLoad = resolve;
    });
    let observeLoadReturned!: () => void;
    const loadReturned = new Promise<void>((resolve) => {
      observeLoadReturned = resolve;
    });
    runtime.patternManager.loadArtifactByIdentity = async (
      identity,
      symbol,
    ) => {
      expect({ identity, symbol }).toEqual(REFS.a);
      observeLoadEntered();
      await loadGate;
      warmArtifacts.set(refKey(identity, symbol), factoryA);
      observeLoadReturned();
      return factoryA;
    };

    const selector = runtime.getCell<unknown>(
      space,
      "dynamic-factory-stale-cold-selector",
      undefined,
      tx,
    );
    selector.set(createFactoryShell(sealFactoryState(factoryA)));
    const resultCell = runtime.getCell<{ result: number }>(
      space,
      "dynamic-factory-stale-cold-result",
      RESULT_SCHEMA,
      tx,
    );
    const result = runtime.run(
      tx,
      outerPattern(),
      { factory: selector, value: 4 },
      resultCell,
    );
    await commitAndRenew();

    let cancelResultSink: (() => void) | undefined;
    const warmBResult = new Promise<{ result: number }>((resolve) => {
      cancelResultSink = result.sink((value) => {
        if (value?.result === 400) resolve({ result: value.result });
      });
    });
    try {
      await within(loadEntered, "cold A load to enter");

      selector.withTx(tx).set(
        createFactoryShell(sealFactoryState(factoryB)),
      );
      await commitAndRenew();
      expect(await within(warmBResult, "warm B during cold A load")).toEqual({
        result: 400,
      });
    } finally {
      cancelResultSink?.();
      releaseLoad();
    }

    await within(loadReturned, "cold A load to return");
    await runtime.idle();

    expect(executions.filter((entry) => entry.factory === "A")).toEqual([]);
    expect(executions).toContainEqual({ factory: "B", value: 4 });
    expect(await within(result.pull(), "result after stale A load")).toEqual({
      result: 400,
    });
  });

  it("gives two dynamic call sites distinct output identities", async () => {
    const executions: Execution[] = [];
    const { factoryA } = makeFactories(executions);
    warmArtifacts.set(refKey(REFS.a.identity, REFS.a.symbol), factoryA);
    const selector = runtime.getCell<unknown>(
      space,
      "dynamic-factory-two-call-sites-selector",
      undefined,
      tx,
    );
    selector.set(createFactoryShell(sealFactoryState(factoryA)));
    const pairedResultSchema = {
      type: "object",
      properties: {
        first: RESULT_SCHEMA,
        second: RESULT_SCHEMA,
      },
      required: ["first", "second"],
      additionalProperties: false,
    } as const satisfies JSONSchema;
    const outer = commonfabric.pattern<
      { factory: unknown; value: number },
      {
        first: { result: number };
        second: { result: number };
      }
    >(
      ({ factory, value }) => ({
        first: invokeFactory(factory, { value }, MODULE_CONTRACT),
        second: invokeFactory(factory, { value }, MODULE_CONTRACT),
      }),
      {
        type: "object",
        properties: {
          factory: { asFactory: MODULE_CONTRACT },
          value: { type: "number" },
        },
        required: ["factory", "value"],
        additionalProperties: false,
      },
      pairedResultSchema,
    );
    const resultCell = runtime.getCell<{
      first: { result: number };
      second: { result: number };
    }>(
      space,
      "dynamic-factory-two-call-sites-result",
      pairedResultSchema,
      tx,
    );
    const result = runtime.run(
      tx,
      outer,
      { factory: selector, value: 5 },
      resultCell,
    );
    const firstIdentity = result.key("first").key("result")
      .getAsNormalizedFullLink();
    const secondIdentity = result.key("second").key("result")
      .getAsNormalizedFullLink();
    await commitAndRenew();

    expect(await within(result.pull(), "two call-site results")).toEqual({
      first: { result: 50 },
      second: { result: 50 },
    });
    expect(firstIdentity).not.toEqual(secondIdentity);
    expect(executions.filter((entry) => entry.factory === "A")).toHaveLength(
      2,
    );
  });

  it("retains prior output across a wrong-kind replacement and later recovers", async () => {
    const executions: Execution[] = [];
    const { factoryA, factoryB } = makeFactories(executions);
    const wrongKindFactory = commonfabric.pattern(
      ({ value }: { value: number }) => ({ result: value }),
      ARGUMENT_SCHEMA,
      RESULT_SCHEMA,
    );
    setDurableArtifactEntryRef(wrongKindFactory, REFS.wrong);
    warmArtifacts.set(refKey(REFS.a.identity, REFS.a.symbol), factoryA);
    warmArtifacts.set(refKey(REFS.b.identity, REFS.b.symbol), factoryB);
    warmArtifacts.set(
      refKey(REFS.wrong.identity, REFS.wrong.symbol),
      wrongKindFactory,
    );

    const selector = runtime.getCell<unknown>(
      space,
      "dynamic-factory-wrong-kind-recovery-selector",
      undefined,
      tx,
    );
    const value = runtime.getCell<number>(
      space,
      "dynamic-factory-wrong-kind-recovery-value",
      { type: "number" },
      tx,
    );
    selector.set(createFactoryShell(sealFactoryState(factoryA)));
    value.set(2);
    const resultCell = runtime.getCell<{ result: number }>(
      space,
      "dynamic-factory-wrong-kind-recovery-result",
      RESULT_SCHEMA,
      tx,
    );
    const result = runtime.run(
      tx,
      outerPattern(),
      { factory: selector, value },
      resultCell,
    );
    await commitAndRenew();
    expect(await within(result.pull(), "wrong-kind prior result")).toEqual({
      result: 20,
    });
    await runtime.idle();

    const diagnostic = Promise.withResolvers<Error>();
    runtime.scheduler.onError((error) => diagnostic.resolve(error));
    selector.withTx(tx).set(
      createFactoryShell(sealFactoryState(wrongKindFactory)),
    );
    await commitAndRenew();

    expect(
      (await within(diagnostic.promise, "wrong-kind replacement error"))
        .message,
    ).toContain("expected module, got pattern");
    expect(await within(result.pull(), "retained wrong-kind result")).toEqual({
      result: 20,
    });
    const aExecutions = executions.filter((entry) => entry.factory === "A")
      .length;

    value.withTx(tx).set(3);
    await commitAndRenew();
    await runtime.idle();
    expect(executions.filter((entry) => entry.factory === "A")).toHaveLength(
      aExecutions,
    );
    expect(await within(result.pull(), "retained result after input change"))
      .toEqual({ result: 20 });

    selector.withTx(tx).set(createFactoryShell(sealFactoryState(factoryB)));
    await commitAndRenew();
    expect(await within(result.pull(), "valid recovery after wrong kind"))
      .toEqual({ result: 300 });
  });

  it("reports a rejected cold load and recovers from a later valid selection", async () => {
    const executions: Execution[] = [];
    const { factoryA, factoryB } = makeFactories(executions);
    warmArtifacts.set(refKey(REFS.b.identity, REFS.b.symbol), factoryB);
    const loadEntered = Promise.withResolvers<void>();
    const rejectLoad = Promise.withResolvers<void>();
    runtime.patternManager.loadArtifactByIdentity = async (
      identity,
      symbol,
    ) => {
      expect({ identity, symbol }).toEqual(REFS.a);
      loadEntered.resolve();
      await rejectLoad.promise;
      throw new Error("rejected cold factory load");
    };
    const diagnostic = Promise.withResolvers<Error>();
    runtime.scheduler.onError((error) => diagnostic.resolve(error));

    const selector = runtime.getCell<unknown>(
      space,
      "dynamic-factory-rejected-cold-selector",
      undefined,
      tx,
    );
    selector.set(createFactoryShell(sealFactoryState(factoryA)));
    const resultCell = runtime.getCell<{ result: number }>(
      space,
      "dynamic-factory-rejected-cold-result",
      RESULT_SCHEMA,
      tx,
    );
    const result = runtime.run(
      tx,
      outerPattern(),
      { factory: selector, value: 6 },
      resultCell,
    );
    await commitAndRenew();

    await within(loadEntered.promise, "rejected cold load to enter");
    rejectLoad.resolve();
    expect(
      (await within(diagnostic.promise, "rejected cold diagnostic"))
        .message,
    ).toContain("rejected cold factory load");
    expect(executions).toEqual([]);
    expect(result.key("result").get()).toBeUndefined();

    selector.withTx(tx).set(createFactoryShell(sealFactoryState(factoryB)));
    await commitAndRenew();
    expect(await within(result.pull(), "valid recovery after cold rejection"))
      .toEqual({ result: 600 });
    expect(executions).toEqual([{ factory: "B", value: 6 }]);
  });

  it("retries the same cold factory after a failed load when its source retargets", async () => {
    const executions: Execution[] = [];
    const { factoryA } = makeFactories(executions);
    let loadAttempts = 0;
    runtime.patternManager.loadArtifactByIdentity = (
      identity,
      symbol,
    ) => {
      expect({ identity, symbol }).toEqual(REFS.a);
      loadAttempts++;
      if (loadAttempts === 1) {
        return Promise.reject(
          new Error("transient cold factory load failure"),
        );
      }
      warmArtifacts.set(refKey(identity, symbol), factoryA);
      return Promise.resolve(factoryA);
    };
    const diagnostic = Promise.withResolvers<Error>();
    runtime.scheduler.onError((error) => diagnostic.resolve(error));

    const stateA = sealFactoryState(factoryA);
    const sourceA = runtime.getCell<unknown>(
      space,
      "dynamic-factory-retry-source-a",
      undefined,
      tx,
    );
    const sourceB = runtime.getCell<unknown>(
      space,
      "dynamic-factory-retry-source-b",
      undefined,
      tx,
    );
    const selector = runtime.getCell<unknown>(
      space,
      "dynamic-factory-retry-selector",
      undefined,
      tx,
    );
    sourceA.set(createFactoryShell(stateA));
    sourceB.set(createFactoryShell({ ...stateA }));
    selector.setRaw(sourceA.getAsWriteRedirectLink());
    const resultCell = runtime.getCell<{ result: number }>(
      space,
      "dynamic-factory-retry-result",
      RESULT_SCHEMA,
      tx,
    );
    const result = runtime.run(
      tx,
      outerPattern(),
      { factory: selector, value: 7 },
      resultCell,
    );
    await commitAndRenew();

    expect(
      (await within(diagnostic.promise, "transient cold diagnostic")).message,
    ).toContain("transient cold factory load failure");
    expect(loadAttempts).toBe(1);
    expect(executions).toEqual([]);

    // The selected Factory@1 state is unchanged; only its resolved source
    // changed. A failed readiness generation must not turn that notification
    // into the ordinary active-child same-state no-op.
    selector.withTx(tx).setRaw(sourceB.getAsWriteRedirectLink());
    await commitAndRenew();

    expect(await within(result.pull(), "same-factory retry result")).toEqual({
      result: 70,
    });
    expect(loadAttempts).toBe(2);
    expect(executions).toEqual([{ factory: "A", value: 7 }]);
  });

  it("retries a same-state source retarget that lands before cold readiness fails", async () => {
    const executions: Execution[] = [];
    const { factoryA } = makeFactories(executions);
    const firstLoadEntered = Promise.withResolvers<void>();
    const secondLoadEntered = Promise.withResolvers<void>();
    const rejectFirstLoad = Promise.withResolvers<void>();
    let loadAttempts = 0;
    runtime.patternManager.loadArtifactByIdentity = async (
      identity,
      symbol,
    ) => {
      expect({ identity, symbol }).toEqual(REFS.a);
      loadAttempts++;
      if (loadAttempts === 1) {
        firstLoadEntered.resolve();
        await rejectFirstLoad.promise;
        throw new Error("superseded source load failed");
      }
      secondLoadEntered.resolve();
      warmArtifacts.set(refKey(identity, symbol), factoryA);
      return factoryA;
    };
    const diagnostics: Error[] = [];
    runtime.scheduler.onError((error) => diagnostics.push(error));

    const stateA = sealFactoryState(factoryA);
    const sourceA = runtime.getCell<unknown>(
      space,
      "dynamic-factory-pending-retry-source-a",
      undefined,
      tx,
    );
    const sourceB = runtime.getCell<unknown>(
      space,
      "dynamic-factory-pending-retry-source-b",
      undefined,
      tx,
    );
    const selector = runtime.getCell<unknown>(
      space,
      "dynamic-factory-pending-retry-selector",
      undefined,
      tx,
    );
    sourceA.set(createFactoryShell(stateA));
    sourceB.set(createFactoryShell({ ...stateA }));
    selector.setRaw(sourceA.getAsWriteRedirectLink());
    const resultCell = runtime.getCell<{ result: number }>(
      space,
      "dynamic-factory-pending-retry-result",
      RESULT_SCHEMA,
      tx,
    );
    const result = runtime.run(
      tx,
      outerPattern(),
      { factory: selector, value: 9 },
      resultCell,
    );
    await commitAndRenew();
    await within(firstLoadEntered.promise, "first source load to enter");

    // Retarget while A is still pending. The Factory@1 state is byte-equal,
    // but the source provenance changed and must immediately become the next
    // readiness generation instead of waiting for A to settle.
    selector.withTx(tx).setRaw(sourceB.withTx(tx).getAsWriteRedirectLink());
    await commitAndRenew();
    await within(secondLoadEntered.promise, "retargeted source load to enter");
    expect(loadAttempts).toBe(2);

    rejectFirstLoad.resolve();
    expect(await within(result.pull(), "pending source-retarget retry result"))
      .toEqual({ result: 90 });
    await runtime.scheduler.idle();
    expect(loadAttempts).toBe(2);
    expect(executions).toEqual([{ factory: "A", value: 9 }]);
    expect(
      diagnostics.some((error) =>
        error.message.includes("superseded source load failed")
      ),
    ).toBe(false);
  });

  it("does not revive a cold selection after its owning piece is stopped", async () => {
    const executions: Execution[] = [];
    const { factoryA } = makeFactories(executions);
    const loadEntered = Promise.withResolvers<void>();
    const releaseLoad = Promise.withResolvers<void>();
    const loadReturned = Promise.withResolvers<void>();
    runtime.patternManager.loadArtifactByIdentity = async (
      identity,
      symbol,
    ) => {
      expect({ identity, symbol }).toEqual(REFS.a);
      loadEntered.resolve();
      await releaseLoad.promise;
      warmArtifacts.set(refKey(identity, symbol), factoryA);
      loadReturned.resolve();
      return factoryA;
    };

    const selector = runtime.getCell<unknown>(
      space,
      "dynamic-factory-owner-stop-selector",
      undefined,
      tx,
    );
    selector.set(createFactoryShell(sealFactoryState(factoryA)));
    const resultCell = runtime.getCell<{ result: number }>(
      space,
      "dynamic-factory-owner-stop-result",
      RESULT_SCHEMA,
      tx,
    );
    const result = runtime.run(
      tx,
      outerPattern(),
      { factory: selector, value: 7 },
      resultCell,
    );
    await commitAndRenew();

    await within(loadEntered.promise, "owner-stop cold load to enter");
    runtime.runner.stop(resultCell);
    releaseLoad.resolve();
    await within(loadReturned.promise, "owner-stop cold load to return");
    await runtime.idle();

    expect(executions).toEqual([]);
    expect(result.key("result").get()).toBeUndefined();
  });

  it("unsubscribes handler A and routes later events only to handler B", async () => {
    const eventSchema = {
      type: "object",
      properties: { amount: { type: "number" } },
      required: ["amount"],
      additionalProperties: false,
    } as const satisfies JSONSchema;
    const handlerContract = {
      kind: "handler",
      contextSchema: ARGUMENT_SCHEMA,
      eventSchema,
    } as const satisfies FactoryContract;
    const events: Array<{
      factory: "A" | "B";
      amount: number;
      value: number;
    }> = [];
    const handlerA = commonfabric.handler(
      eventSchema,
      ARGUMENT_SCHEMA,
      ({ amount }, { value }) => {
        events.push({ factory: "A", amount, value });
      },
    );
    const handlerB = commonfabric.handler(
      eventSchema,
      ARGUMENT_SCHEMA,
      ({ amount }, { value }) => {
        events.push({ factory: "B", amount, value });
      },
    );
    setDurableArtifactEntryRef(handlerA, REFS.a);
    setDurableArtifactEntryRef(handlerB, REFS.b);
    warmArtifacts.set(refKey(REFS.a.identity, REFS.a.symbol), handlerA);
    warmArtifacts.set(refKey(REFS.b.identity, REFS.b.symbol), handlerB);

    const outer = commonfabric.pattern<
      { factory: unknown; value: number },
      { events: unknown }
    >(
      ({ factory, value }) => ({
        events: invokeFactory(factory, { value }, handlerContract),
      }),
      {
        type: "object",
        properties: {
          factory: { asFactory: handlerContract },
          value: { type: "number" },
        },
        required: ["factory", "value"],
        additionalProperties: false,
      },
    );
    const selector = runtime.getCell<unknown>(
      space,
      "dynamic-factory-handler-replacement-selector",
      undefined,
      tx,
    );
    selector.set(createFactoryShell(sealFactoryState(handlerA)));
    const resultCell = runtime.getCell<any>(
      space,
      "dynamic-factory-handler-replacement-result",
      undefined,
      tx,
    );
    const result = runtime.run(
      tx,
      outer,
      { factory: selector, value: 8 },
      resultCell,
    );
    await commitAndRenew();
    await result.pull();
    await runtime.idle();
    const streamIdentity = result.key("events").getAsNormalizedFullLink();

    result.key("events").send({ amount: 1 });
    await runtime.idle();
    expect(events).toEqual([{ factory: "A", amount: 1, value: 8 }]);

    selector.withTx(tx).set(createFactoryShell(sealFactoryState(handlerB)));
    await commitAndRenew();
    await runtime.idle();
    expect(result.key("events").getAsNormalizedFullLink()).toEqual(
      streamIdentity,
    );

    result.key("events").send({ amount: 2 });
    await runtime.idle();
    expect(events).toEqual([
      { factory: "A", amount: 1, value: 8 },
      { factory: "B", amount: 2, value: 8 },
    ]);
  });
});
