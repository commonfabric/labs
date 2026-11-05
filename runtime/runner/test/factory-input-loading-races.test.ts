import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  createFactoryShell,
  sealFactoryState,
} from "@commonfabric/data-model/fabric-factory";
import { Identity } from "@commonfabric/identity";

import { setDurableArtifactEntryRef } from "../src/builder/pattern-metadata.ts";
import type { FabricValue, JSONSchema } from "../src/builder/types.ts";
import type { FactoryContract } from "../src/factory-materialization.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import type {
  IExtendedStorageTransaction,
  MemorySpace,
} from "../src/storage/interface.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";

const signer = await Identity.fromPassphrase(
  "scheduled factory input loading races",
);
const space = signer.did();

const FACTORY_ARGUMENT_SCHEMA = {
  type: "object",
  properties: { value: { type: "number" } },
  required: ["value"],
  additionalProperties: false,
} as const satisfies JSONSchema;

const FACTORY_RESULT_SCHEMA = {
  type: "object",
  properties: { result: { type: "number" } },
  required: ["result"],
  additionalProperties: false,
} as const satisfies JSONSchema;

const MODULE_CONTRACT = {
  kind: "module",
  argumentSchema: FACTORY_ARGUMENT_SCHEMA,
  resultSchema: FACTORY_RESULT_SCHEMA,
} as const satisfies FactoryContract;

const FACTORY_CONTAINER_SCHEMA = {
  type: "object",
  properties: { factory: { asFactory: MODULE_CONTRACT } },
  required: ["factory"],
  additionalProperties: false,
} as const satisfies JSONSchema;

const OBSERVATION_SCHEMA = {
  type: "object",
  properties: { observed: { type: "string" } },
  required: ["observed"],
  additionalProperties: false,
} as const satisfies JSONSchema;

const EMPTY_SCHEMA = {
  type: "object",
  properties: {},
  additionalProperties: false,
} as const satisfies JSONSchema;

const PRODUCER_RESULT_SCHEMA = {
  type: "object",
  properties: {
    factory: { asFactory: MODULE_CONTRACT },
    produced: { type: "boolean" },
  },
  required: ["factory", "produced"],
  additionalProperties: false,
} as const satisfies JSONSchema;

const PARENT_RESULT_SCHEMA = {
  type: "object",
  properties: {
    produced: { type: "boolean" },
    observed: { type: "string" },
  },
  required: ["produced", "observed"],
  additionalProperties: false,
} as const satisfies JSONSchema;

const UNUSED_FACTORY_SCHEMA = {
  type: "object",
  properties: { unused: { asFactory: MODULE_CONTRACT } },
  required: ["unused"],
  additionalProperties: false,
} as const satisfies JSONSchema;

const CHILD_CONSUMER_SCHEMA = {
  type: "object",
  properties: {
    factory: { asFactory: MODULE_CONTRACT },
    source: { type: "number", asCell: ["cell"] },
  },
  required: ["factory", "source"],
  additionalProperties: false,
} as const satisfies JSONSchema;

const REFS = {
  a: {
    identity: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    symbol: "scheduledFactoryA",
  },
  b: {
    identity: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBA",
    symbol: "scheduledFactoryB",
  },
} as const;

type Label = "A" | "B";
type LiveFactory = ((input: unknown) => unknown) & Record<PropertyKey, any>;

interface SelectedFactory {
  readonly label: Label;
  readonly live: LiveFactory;
  readonly shell: FabricValue;
  readonly ref: (typeof REFS)["a"] | (typeof REFS)["b"];
}

function refKey(identity: string, symbol: string): string {
  return `${identity}#${symbol}`;
}

function spaceKey(identity: string, sourceSpace: MemorySpace): string {
  return `${sourceSpace}|${identity}`;
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

describe("scheduled Factory@1 loading races", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;
  let commonfabric: any;
  let warmArtifacts: Map<string, unknown>;
  let availableClosures: Set<string>;
  let defaultLoadArtifactByIdentity: (
    identity: string,
    symbol: string,
    sourceSpace: MemorySpace,
  ) => Promise<object | undefined>;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    tx = runtime.edit();
    commonfabric = createTrustedBuilder(runtime).commonfabric;
    warmArtifacts = new Map();
    availableClosures = new Set();
    const defaultArtifactFromIdentitySync = runtime.patternManager
      .artifactFromIdentitySync.bind(runtime.patternManager);
    const defaultIsArtifactAvailableInSpace = runtime.patternManager
      .isArtifactAvailableInSpace.bind(runtime.patternManager);
    defaultLoadArtifactByIdentity = runtime.patternManager
      .loadArtifactByIdentity.bind(runtime.patternManager);
    runtime.patternManager.artifactFromIdentitySync = (identity, symbol) =>
      warmArtifacts.get(refKey(identity, symbol)) ??
        defaultArtifactFromIdentitySync(identity, symbol);
    runtime.patternManager.isArtifactAvailableInSpace = (
      identity,
      sourceSpace,
    ) =>
      availableClosures.has(spaceKey(identity, sourceSpace)) ||
      defaultIsArtifactAvailableInSpace(identity, sourceSpace);
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

  function makeFactory(
    label: Label,
    onRun?: (value: number) => void,
  ): SelectedFactory {
    const ref = label === "A" ? REFS.a : REFS.b;
    const multiplier = label === "A" ? 10 : 100;
    const live = commonfabric.lift(
      ({ value }: { value: number }) => {
        onRun?.(value);
        return { result: value * multiplier };
      },
      FACTORY_ARGUMENT_SCHEMA,
      FACTORY_RESULT_SCHEMA,
    ) as LiveFactory;
    setDurableArtifactEntryRef(live, ref);
    availableClosures.add(spaceKey(ref.identity, space));
    return {
      label,
      live,
      shell: createFactoryShell(sealFactoryState(live)) as FabricValue,
      ref,
    };
  }

  function markWarm(selected: SelectedFactory): void {
    warmArtifacts.set(
      refKey(selected.ref.identity, selected.ref.symbol),
      selected.live,
    );
  }

  function liftConsumer(
    selectedA: SelectedFactory,
    selectedB: SelectedFactory,
    calls: Label[],
    onCall?: (label: Label) => void,
  ): any {
    const consumer = commonfabric.lift(
      ({ factory }: { factory: unknown }) => {
        if (typeof factory !== "function") {
          throw new TypeError("scheduled factory input is not callable");
        }
        const label = factory === selectedA.live
          ? "A"
          : factory === selectedB.live
          ? "B"
          : undefined;
        if (label === undefined) {
          throw new Error("scheduled callback received an unexpected factory");
        }
        // Exercise the ordinary direct callable path after readiness. The
        // selected result is intentionally not the scalar under test here.
        factory({ value: 2 });
        calls.push(label);
        onCall?.(label);
        return { observed: label };
      },
      FACTORY_CONTAINER_SCHEMA,
      OBSERVATION_SCHEMA,
    );
    return commonfabric.pattern(
      ({ factory }: { factory: unknown }) => consumer({ factory }),
      FACTORY_CONTAINER_SCHEMA,
      OBSERVATION_SCHEMA,
    );
  }

  function startSelectedFactoryConsumer(
    cause: string,
    outer: any,
    initial: FabricValue,
  ) {
    const selector = runtime.getCell<FabricValue>(
      space,
      `${cause}-selector`,
      undefined,
      tx,
    );
    selector.set(initial);
    const resultCell = runtime.getCell<{ observed: string }>(
      space,
      `${cause}-result`,
      OBSERVATION_SCHEMA,
      tx,
    );
    const result = runtime.run(
      tx,
      outer,
      { factory: selector },
      resultCell,
    );
    const cancelDemand = result.sink(() => {});
    return { selector, result, resultCell, cancelDemand };
  }

  it("rereads warm B while cold A is still loading and never invokes A", async () => {
    const selectedA = makeFactory("A");
    const selectedB = makeFactory("B");
    markWarm(selectedB);
    const calls: Label[] = [];
    const calledB = Promise.withResolvers<void>();
    const outer = liftConsumer(selectedA, selectedB, calls, (label) => {
      if (label === "B") calledB.resolve();
    });

    const loadEntered = Promise.withResolvers<void>();
    const releaseLoad = Promise.withResolvers<void>();
    const loadReturned = Promise.withResolvers<void>();
    runtime.patternManager.loadArtifactByIdentity = async (
      identity,
      symbol,
      sourceSpace,
    ) => {
      if (
        identity !== selectedA.ref.identity ||
        symbol !== selectedA.ref.symbol
      ) {
        return defaultLoadArtifactByIdentity(identity, symbol, sourceSpace);
      }
      expect({ identity, symbol, sourceSpace }).toEqual({
        ...selectedA.ref,
        sourceSpace: space,
      });
      loadEntered.resolve();
      await releaseLoad.promise;
      markWarm(selectedA);
      loadReturned.resolve();
      return selectedA.live;
    };

    const running = startSelectedFactoryConsumer(
      "scheduled-cold-a-warm-b",
      outer,
      selectedA.shell,
    );
    await commitAndRenew();

    try {
      await within(loadEntered.promise, "cold A load to enter");
      running.selector.withTx(tx).set(selectedB.shell);
      await commitAndRenew();
      await within(calledB.promise, "warm B callback during cold A load");
      expect(calls).toEqual(["B"]);
      expect(running.result.key("observed").get()).toBe("B");
    } finally {
      releaseLoad.resolve();
      running.cancelDemand();
    }

    await within(loadReturned.promise, "stale cold A load to return");
    await runtime.idle();
    expect(calls).toEqual(["B"]);
  });

  it("retains warm A's committed scalar while cold B loads, then replaces it", async () => {
    const selectedA = makeFactory("A");
    const selectedB = makeFactory("B");
    markWarm(selectedA);
    const calls: Label[] = [];
    const calledA = Promise.withResolvers<void>();
    const calledB = Promise.withResolvers<void>();
    const outer = liftConsumer(selectedA, selectedB, calls, (label) => {
      if (label === "A") calledA.resolve();
      if (label === "B") calledB.resolve();
    });

    const loadEntered = Promise.withResolvers<void>();
    const releaseLoad = Promise.withResolvers<void>();
    runtime.patternManager.loadArtifactByIdentity = async (
      identity,
      symbol,
      sourceSpace,
    ) => {
      if (
        identity !== selectedB.ref.identity ||
        symbol !== selectedB.ref.symbol
      ) {
        return defaultLoadArtifactByIdentity(identity, symbol, sourceSpace);
      }
      expect({ identity, symbol, sourceSpace }).toEqual({
        ...selectedB.ref,
        sourceSpace: space,
      });
      loadEntered.resolve();
      await releaseLoad.promise;
      markWarm(selectedB);
      return selectedB.live;
    };

    const running = startSelectedFactoryConsumer(
      "scheduled-warm-a-cold-b",
      outer,
      selectedA.shell,
    );
    await commitAndRenew();

    try {
      await within(calledA.promise, "initial warm A callback");
      await runtime.idle();
      expect(running.result.key("observed").get()).toBe("A");

      running.selector.withTx(tx).set(selectedB.shell);
      await commitAndRenew();
      await within(loadEntered.promise, "cold B load to enter");
      await runtime.idle();
      expect(calls).toEqual(["A"]);
      expect(running.result.key("observed").get()).toBe("A");

      releaseLoad.resolve();
      await within(calledB.promise, "cold B callback after readiness");
      await runtime.idle();
      expect(calls).toEqual(["A", "B"]);
      expect(running.result.key("observed").get()).toBe("B");
    } finally {
      releaseLoad.resolve();
      running.cancelDemand();
    }
  });

  it("keeps A's result-owned child live while B loads, then cancels it", async () => {
    const runsA: number[] = [];
    const runsB: number[] = [];
    const selectedA = makeFactory("A", (value) => runsA.push(value));
    const selectedB = makeFactory("B", (value) => runsB.push(value));
    markWarm(selectedA);

    const consumer = commonfabric.lift(
      ({ factory, source }: { factory: LiveFactory; source: unknown }) =>
        factory({ value: source }),
      CHILD_CONSUMER_SCHEMA,
      FACTORY_RESULT_SCHEMA,
    );
    const outer = commonfabric.pattern(
      (input: { factory: unknown; source: unknown }) => consumer(input),
      CHILD_CONSUMER_SCHEMA,
      FACTORY_RESULT_SCHEMA,
    );

    const selector = runtime.getCell<FabricValue>(
      space,
      "scheduled-child-retention-selector",
      undefined,
      tx,
    );
    const source = runtime.getCell<number>(
      space,
      "scheduled-child-retention-source",
      { type: "number" },
      tx,
    );
    selector.set(selectedA.shell);
    source.set(1);
    const resultCell = runtime.getCell<{ result: number }>(
      space,
      "scheduled-child-retention-result",
      FACTORY_RESULT_SCHEMA,
      tx,
    );
    const result = runtime.run(
      tx,
      outer,
      { factory: selector, source },
      resultCell,
    );
    const cancelDemand = result.sink(() => {});
    await commitAndRenew();

    const loadEntered = Promise.withResolvers<void>();
    const releaseLoad = Promise.withResolvers<void>();
    const loadB = releaseLoad.promise.then(() => {
      markWarm(selectedB);
      return selectedB.live;
    });
    runtime.patternManager.loadArtifactByIdentity = (
      identity,
      symbol,
      sourceSpace,
    ) => {
      if (
        identity !== selectedB.ref.identity ||
        symbol !== selectedB.ref.symbol
      ) {
        return defaultLoadArtifactByIdentity(identity, symbol, sourceSpace);
      }
      loadEntered.resolve();
      return loadB;
    };

    try {
      expect(await within(result.pull(), "initial A child result")).toEqual({
        result: 10,
      });
      expect(runsA).toEqual([1]);

      selector.withTx(tx).set(selectedB.shell);
      await commitAndRenew();
      await within(loadEntered.promise, "cold B child load");

      source.withTx(tx).set(2);
      await commitAndRenew();
      expect(await within(result.pull(), "retained A child update")).toEqual({
        result: 20,
      });
      expect(runsA).toEqual([1, 2]);
      expect(runsB).toEqual([]);

      releaseLoad.resolve();
      expect(await within(result.pull(), "replacement B child result"))
        .toEqual({ result: 200 });
      expect(runsB).toEqual([2]);

      source.withTx(tx).set(3);
      await commitAndRenew();
      expect(await within(result.pull(), "live B child update")).toEqual({
        result: 300,
      });
      expect(runsA).toEqual([1, 2]);
      expect(runsB).toEqual([2, 3]);
    } finally {
      releaseLoad.resolve();
      cancelDemand();
    }
  });

  it("does not revive a scheduled lift after its owner stops during cold load", async () => {
    const selectedA = makeFactory("A");
    const selectedB = makeFactory("B");
    const calls: Label[] = [];
    const outer = liftConsumer(selectedA, selectedB, calls);

    const loadEntered = Promise.withResolvers<void>();
    const releaseLoad = Promise.withResolvers<void>();
    const loadReturned = Promise.withResolvers<void>();
    runtime.patternManager.loadArtifactByIdentity = async (
      identity,
      symbol,
      sourceSpace,
    ) => {
      if (
        identity !== selectedA.ref.identity ||
        symbol !== selectedA.ref.symbol
      ) {
        return defaultLoadArtifactByIdentity(identity, symbol, sourceSpace);
      }
      loadEntered.resolve();
      await releaseLoad.promise;
      markWarm(selectedA);
      loadReturned.resolve();
      return selectedA.live;
    };

    const running = startSelectedFactoryConsumer(
      "scheduled-owner-stop",
      outer,
      selectedA.shell,
    );
    await commitAndRenew();

    await within(loadEntered.promise, "owner-stop cold load to enter");
    runtime.runner.stop(running.resultCell);
    releaseLoad.resolve();
    await within(loadReturned.promise, "owner-stop cold load to return");
    await runtime.idle();

    running.cancelDemand();
    expect(calls).toEqual([]);
    expect(running.result.key("observed").get()).toBeUndefined();
  });

  it("recovers on a later valid selection after a terminal cold load", async () => {
    const selectedA = makeFactory("A");
    const selectedB = makeFactory("B");
    markWarm(selectedB);
    const calls: Label[] = [];
    const calledB = Promise.withResolvers<void>();
    const outer = liftConsumer(selectedA, selectedB, calls, (label) => {
      if (label === "B") calledB.resolve();
    });

    const loadEntered = Promise.withResolvers<void>();
    const finishMissingLoad = Promise.withResolvers<void>();
    runtime.patternManager.loadArtifactByIdentity = async (
      identity,
      symbol,
      sourceSpace,
    ) => {
      if (
        identity !== selectedA.ref.identity ||
        symbol !== selectedA.ref.symbol
      ) {
        return defaultLoadArtifactByIdentity(identity, symbol, sourceSpace);
      }
      loadEntered.resolve();
      await finishMissingLoad.promise;
      return undefined;
    };
    const diagnostic = Promise.withResolvers<Error>();
    runtime.scheduler.onError((error) => diagnostic.resolve(error));

    const running = startSelectedFactoryConsumer(
      "scheduled-terminal-cold-recovery",
      outer,
      selectedA.shell,
    );
    await commitAndRenew();

    try {
      await within(loadEntered.promise, "terminal cold load to enter");
      finishMissingLoad.resolve();
      expect(
        (await within(diagnostic.promise, "terminal cold diagnostic")).message,
      ).toContain("could not resolve");
      expect(calls).toEqual([]);
      expect(running.result.key("observed").get()).toBeUndefined();

      running.selector.withTx(tx).set(selectedB.shell);
      await commitAndRenew();
      await within(calledB.promise, "valid B recovery callback");
      await runtime.idle();
      expect(calls).toEqual(["B"]);
      expect(running.result.key("observed").get()).toBe("B");
    } finally {
      finishMissingLoad.resolve();
      running.cancelDemand();
    }
  });

  it("starts an upstream factory producer in the same parent and resumes only its consumer", async () => {
    const selectedA = makeFactory("A");
    const calls: Label[] = [];
    const calledA = Promise.withResolvers<void>();
    let producerCalls = 0;

    const producer = commonfabric.lift(
      () => {
        producerCalls++;
        return { factory: selectedA.shell, produced: true };
      },
      EMPTY_SCHEMA,
      PRODUCER_RESULT_SCHEMA,
    );
    const consumer = commonfabric.lift(
      ({ factory }: { factory: unknown }) => {
        if (typeof factory !== "function") {
          throw new TypeError("same-parent factory input is not callable");
        }
        factory({ value: 3 });
        const label = factory === selectedA.live ? "A" : "B";
        calls.push(label);
        if (label === "A") calledA.resolve();
        return { observed: label };
      },
      FACTORY_CONTAINER_SCHEMA,
      OBSERVATION_SCHEMA,
    );
    const outer = commonfabric.pattern(
      () => {
        const produced = producer({});
        const consumed = consumer({ factory: produced.factory });
        return {
          produced: produced.produced,
          observed: consumed.observed,
        };
      },
      EMPTY_SCHEMA,
      PARENT_RESULT_SCHEMA,
    );

    const loadEntered = Promise.withResolvers<void>();
    const releaseLoad = Promise.withResolvers<void>();
    runtime.patternManager.loadArtifactByIdentity = async (
      identity,
      symbol,
      sourceSpace,
    ) => {
      if (
        identity !== selectedA.ref.identity ||
        symbol !== selectedA.ref.symbol
      ) {
        return defaultLoadArtifactByIdentity(identity, symbol, sourceSpace);
      }
      loadEntered.resolve();
      await releaseLoad.promise;
      markWarm(selectedA);
      return selectedA.live;
    };

    const resultCell = runtime.getCell<{
      produced: boolean;
      observed: string;
    }>(
      space,
      "scheduled-same-parent-result",
      PARENT_RESULT_SCHEMA,
      tx,
    );
    const result = runtime.run(tx, outer, {}, resultCell);
    const cancelDemand = result.sink(() => {});
    await commitAndRenew();

    try {
      // The loader can only be reached after the upstream producer commits its
      // factory output. If startup prewarmed the whole parent, this deadlocks.
      await within(loadEntered.promise, "same-parent consumer cold load");
      expect(producerCalls).toBe(1);
      expect(calls).toEqual([]);

      releaseLoad.resolve();
      await within(calledA.promise, "same-parent consumer resume");
      await runtime.idle();
      expect(await within(result.pull(), "same-parent final result")).toEqual({
        produced: true,
        observed: "A",
      });
      expect(calls).toEqual(["A"]);
    } finally {
      releaseLoad.resolve();
      cancelDemand();
    }
  });

  it("does not load a cold factory that no scheduled callback consumes", async () => {
    const selectedA = makeFactory("A");
    let loads = 0;
    runtime.patternManager.loadArtifactByIdentity = (
      identity,
      symbol,
      sourceSpace,
    ) => {
      if (
        identity !== selectedA.ref.identity ||
        symbol !== selectedA.ref.symbol
      ) {
        return defaultLoadArtifactByIdentity(identity, symbol, sourceSpace);
      }
      loads++;
      return Promise.resolve(selectedA.live);
    };
    const outer = commonfabric.pattern(
      (_input: { unused: unknown }) => ({ observed: "ready" }),
      UNUSED_FACTORY_SCHEMA,
      OBSERVATION_SCHEMA,
    );
    const resultCell = runtime.getCell<{ observed: string }>(
      space,
      "scheduled-unused-cold-factory-result",
      OBSERVATION_SCHEMA,
      tx,
    );
    const result = runtime.run(
      tx,
      outer,
      { unused: selectedA.shell },
      resultCell,
    );
    await commitAndRenew();

    expect(await within(result.pull(), "unused cold factory result")).toEqual({
      observed: "ready",
    });
    await runtime.idle();
    expect(loads).toBe(0);
  });
});
