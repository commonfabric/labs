import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  createFactoryShell,
  factoryStateOf,
  sealFactoryState,
} from "@commonfabric/data-model/fabric-factory";
import { Identity } from "@commonfabric/identity";

import { setDurableArtifactEntryRef } from "../src/builder/pattern-metadata.ts";
import type { FabricValue, JSONSchema } from "../src/builder/types.ts";
import { isCell, sendEvent } from "../src/cell.ts";
import type { FactoryContract } from "../src/factory-materialization.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import type {
  IExtendedStorageTransaction,
  MemorySpace,
} from "../src/storage/interface.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";

const signer = await Identity.fromPassphrase(
  "scheduled factory handler lifecycle test",
);
const space = signer.did();
const linkedArtifactSpace = (await Identity.fromPassphrase(
  "scheduled factory handler lifecycle linked source",
)).did();
const eventArtifactSpace = (await Identity.fromPassphrase(
  "scheduled factory handler lifecycle event source",
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

const MODULE_CONTRACT = {
  kind: "module",
  argumentSchema: ARGUMENT_SCHEMA,
  resultSchema: RESULT_SCHEMA,
} as const satisfies FactoryContract;

const TRIGGER_SCHEMA = {
  type: "object",
  properties: { fire: { type: "boolean" } },
  required: ["fire"],
  additionalProperties: false,
} as const satisfies JSONSchema;

const EMPTY_SCHEMA = {
  type: "object",
  properties: {},
  additionalProperties: false,
} as const satisfies JSONSchema;

const REFS = {
  a: {
    identity: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    symbol: "handlerLifecycleA",
  },
  b: {
    identity: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBA",
    symbol: "handlerLifecycleB",
  },
} as const;

type FactoryLabel = keyof typeof REFS;
type LiveFactory = ((input: unknown) => unknown) & Record<PropertyKey, any>;
type SelectedFactory = {
  label: FactoryLabel;
  live: LiveFactory;
  shell: FabricValue;
  ref: { identity: string; symbol: string };
};

function key(identity: string, symbol: string): string {
  return `${identity}#${symbol}`;
}

function spaceKey(identity: string, sourceSpace: MemorySpace): string {
  return `${sourceSpace}|${identity}`;
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => resolve = res);
  return { promise, resolve };
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

describe("scheduled Factory@1 handler lifecycle", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let commonfabric: any;
  let warmArtifacts: Map<string, unknown>;
  let availableClosures: Set<string>;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    commonfabric = createTrustedBuilder(runtime).commonfabric;
    warmArtifacts = new Map();
    availableClosures = new Set();
    runtime.patternManager.artifactFromIdentitySync = (identity, symbol) =>
      warmArtifacts.get(key(identity, symbol));
    runtime.patternManager.isArtifactAvailableInSpace = (
      identity,
      sourceSpace,
    ) => availableClosures.has(spaceKey(identity, sourceSpace));
  });

  afterEach(async () => {
    await runtime.dispose();
    await storageManager.close();
  });

  async function commit(tx: IExtendedStorageTransaction): Promise<void> {
    runtime.prepareTxForCommit(tx);
    const { error } = await tx.commit().settled;
    expect(error).toBeUndefined();
  }

  function selectFactory(
    label: FactoryLabel,
    sourceSpace: MemorySpace,
    warm: boolean,
  ): SelectedFactory {
    const live = commonfabric.lift(
      ({ value }: { value: number }) => ({ result: value }),
      ARGUMENT_SCHEMA,
      RESULT_SCHEMA,
    ) as LiveFactory;
    const ref = REFS[label];
    setDurableArtifactEntryRef(live, ref);
    availableClosures.add(spaceKey(ref.identity, sourceSpace));
    if (warm) warmArtifacts.set(key(ref.identity, ref.symbol), live);
    return {
      label,
      live,
      shell: createFactoryShell(sealFactoryState(live)),
      ref,
    };
  }

  function contextConsumer(
    onBody: (factory: unknown) => void,
  ): any {
    const contextSchema = {
      type: "object",
      properties: { factory: { asFactory: MODULE_CONTRACT } },
      required: ["factory"],
      additionalProperties: false,
    } as JSONSchema;
    const consumer = commonfabric.handler(
      TRIGGER_SCHEMA,
      contextSchema,
      (_event: { fire: boolean }, { factory }: { factory: unknown }) =>
        onBody(factory),
    );
    return commonfabric.pattern(
      ({ factory }: { factory: unknown }) => ({
        events: consumer({ factory }),
      }),
      contextSchema,
    );
  }

  function eventConsumer(
    eventSchema: JSONSchema,
    onBody: (event: Record<string, unknown>) => void,
  ): any {
    const consumer = commonfabric.handler(
      eventSchema,
      EMPTY_SCHEMA,
      (event: Record<string, unknown>) => onBody(event),
    );
    return commonfabric.pattern(
      () => ({ events: consumer({}) }),
      EMPTY_SCHEMA,
    );
  }

  async function start(
    pattern: any,
    inputs: Record<string, unknown>,
    resultSpace: MemorySpace,
    cause: string,
  ): Promise<any> {
    const tx = runtime.edit();
    const resultCell = runtime.getCell<{ events: unknown }>(
      resultSpace,
      cause,
      undefined,
      tx,
    );
    const result = runtime.run(tx, pattern, inputs, resultCell);
    await commit(tx);
    await result.pull();
    return result;
  }

  it("does not run on a context change and rereads the new factory for the next event", async () => {
    const selectedA = selectFactory("a", linkedArtifactSpace, true);
    const selectedB = selectFactory("b", linkedArtifactSpace, false);
    const bodies: FactoryLabel[] = [];
    const firstBody = deferred<void>();
    const secondBody = deferred<void>();
    const errors = deferred<Error>();
    runtime.scheduler.onError((error) => errors.resolve(error));
    const outer = contextConsumer((factory) => {
      const label = factory === selectedA.live
        ? "a"
        : factory === selectedB.live
        ? "b"
        : undefined;
      if (label === undefined) {
        throw new Error("handler received unknown factory");
      }
      bodies.push(label);
      if (bodies.length === 1) firstBody.resolve();
      if (bodies.length === 2) secondBody.resolve();
    });

    const seed = runtime.edit();
    const selector = runtime.getCell<FabricValue>(
      linkedArtifactSpace,
      "handler-context-factory-selector",
      undefined,
      seed,
    );
    selector.set(selectedA.shell);
    await commit(seed);

    const result = await start(
      outer,
      { factory: selector },
      space,
      "handler-context-lifecycle-result",
    );
    const stream = result.key("events");
    stream.send({ fire: true });
    expect(
      await within(
        Promise.race([
          firstBody.promise.then(() => "body" as const),
          errors.promise.then((error) => `error: ${error.message}`),
        ]),
        "first context event",
      ),
    ).toBe("body");
    expect(bodies).toEqual(["a"]);

    const loadEntered = deferred<void>();
    const releaseLoad = deferred<void>();
    const loads: Array<{
      identity: string;
      symbol: string;
      sourceSpace: MemorySpace;
    }> = [];
    runtime.patternManager.loadArtifactByIdentity = async (
      identity,
      symbol,
      sourceSpace,
    ) => {
      loads.push({ identity, symbol, sourceSpace });
      loadEntered.resolve();
      await releaseLoad.promise;
      warmArtifacts.set(key(identity, symbol), selectedB.live);
      return selectedB.live;
    };

    const update = runtime.edit();
    selector.withTx(update).set(selectedB.shell);
    await commit(update);
    await runtime.idle();
    expect(bodies).toEqual(["a"]);

    let commitCalls = 0;
    const committed = deferred<string>();
    sendEvent(stream, { fire: true }, (eventTx) => {
      commitCalls++;
      committed.resolve(eventTx.status().status);
    });
    try {
      expect(
        await within(
          Promise.race([
            loadEntered.promise.then(() => "load" as const),
            secondBody.promise.then(() => "body" as const),
            errors.promise.then((error) => `error: ${error.message}`),
          ]),
          "second context event readiness",
        ),
      ).toBe("load");
      expect(bodies).toEqual(["a"]);
      expect(commitCalls).toBe(0);
      expect(loads).toEqual([{
        ...selectedB.ref,
        sourceSpace: linkedArtifactSpace,
      }]);
    } finally {
      releaseLoad.resolve();
    }

    await within(secondBody.promise, "second context body");
    expect(await within(committed.promise, "second context commit")).toBe(
      "done",
    );
    expect(bodies).toEqual(["a", "b"]);
    expect(commitCalls).toBe(1);
  });

  it("keeps a by-value event factory snapshot across a cold wait", async () => {
    const selectedA = selectFactory("a", eventArtifactSpace, false);
    const selectedB = selectFactory("b", eventArtifactSpace, true);
    const body = deferred<FactoryLabel>();
    const errors = deferred<Error>();
    runtime.scheduler.onError((error) => errors.resolve(error));
    const eventSchema = {
      type: "object",
      properties: { factory: { asFactory: MODULE_CONTRACT } },
      required: ["factory"],
      additionalProperties: false,
    } as JSONSchema;
    const outer = eventConsumer(eventSchema, ({ factory }) => {
      body.resolve(factory === selectedA.live ? "a" : "b");
    });

    const seed = runtime.edit();
    const source = runtime.getCell<FabricValue>(
      eventArtifactSpace,
      "by-value-event-factory-source",
      undefined,
      seed,
    );
    source.set(selectedA.shell);
    await commit(seed);
    const result = await start(
      outer,
      {},
      eventArtifactSpace,
      "by-value-event-factory-result",
    );

    const loadEntered = deferred<void>();
    const releaseLoad = deferred<void>();
    runtime.patternManager.loadArtifactByIdentity = async (
      identity,
      symbol,
      sourceSpace,
    ) => {
      expect({ identity, symbol, sourceSpace }).toEqual({
        ...selectedA.ref,
        sourceSpace: eventArtifactSpace,
      });
      loadEntered.resolve();
      await releaseLoad.promise;
      warmArtifacts.set(key(identity, symbol), selectedA.live);
      return selectedA.live;
    };

    let commitCalls = 0;
    const committed = deferred<string>();
    sendEvent(
      result.key("events"),
      { factory: source.get() },
      (eventTx) => {
        commitCalls++;
        committed.resolve(eventTx.status().status);
      },
    );
    try {
      expect(
        await within(
          Promise.race([
            loadEntered.promise.then(() => "load" as const),
            body.promise.then(() => "body" as const),
            errors.promise.then((error) => `error: ${error.message}`),
          ]),
          "by-value event readiness",
        ),
      ).toBe("load");
      expect(commitCalls).toBe(0);

      const update = runtime.edit();
      source.withTx(update).set(selectedB.shell);
      await commit(update);
      expect(factoryStateOf(source.get())).toEqual(
        factoryStateOf(selectedB.shell),
      );
    } finally {
      releaseLoad.resolve();
    }

    expect(await within(body.promise, "by-value event body")).toBe("a");
    expect(await within(committed.promise, "by-value event commit")).toBe(
      "done",
    );
    expect(commitCalls).toBe(1);
  });

  it("keeps an explicit Cell<Factory> as a live Cell", async () => {
    const selectedA = selectFactory("a", linkedArtifactSpace, true);
    const selectedB = selectFactory("b", linkedArtifactSpace, true);
    const observed: FactoryLabel[] = [];
    const firstBody = deferred<void>();
    const secondBody = deferred<void>();
    const errors = deferred<Error>();
    runtime.scheduler.onError((error) => errors.resolve(error));
    const eventSchema = {
      type: "object",
      properties: {
        factory: {
          asFactory: MODULE_CONTRACT,
          asCell: ["cell"],
        },
      },
      required: ["factory"],
      additionalProperties: false,
    } as JSONSchema;
    const outer = eventConsumer(eventSchema, ({ factory }) => {
      if (!isCell(factory)) {
        throw new Error("explicit Cell<Factory> was not delivered as a Cell");
      }
      const state = factoryStateOf(factory.get());
      if (!("ref" in state) || state.ref === undefined) {
        throw new Error("explicit factory Cell value lost its artifact ref");
      }
      observed.push(state.ref.symbol === selectedA.ref.symbol ? "a" : "b");
      if (observed.length === 1) firstBody.resolve();
      if (observed.length === 2) secondBody.resolve();
    });

    const seed = runtime.edit();
    const selector = runtime.getCell<FabricValue>(
      linkedArtifactSpace,
      "explicit-factory-cell-selector",
      undefined,
      seed,
    );
    selector.set(selectedA.shell);
    await commit(seed);
    const result = await start(
      outer,
      {},
      space,
      "explicit-factory-cell-handler-result",
    );
    const stream = result.key("events");

    stream.send({ factory: selector });
    expect(
      await within(
        Promise.race([
          firstBody.promise.then(() => "body" as const),
          errors.promise.then((error) => `error: ${error.message}`),
        ]),
        "first explicit Cell event",
      ),
    ).toBe("body");
    expect(observed).toEqual(["a"]);

    const update = runtime.edit();
    selector.withTx(update).set(selectedB.shell);
    await commit(update);
    await runtime.idle();
    expect(observed).toEqual(["a"]);

    stream.send({ factory: selector });
    expect(
      await within(
        Promise.race([
          secondBody.promise.then(() => "body" as const),
          errors.promise.then((error) => `error: ${error.message}`),
        ]),
        "second explicit Cell event",
      ),
    ).toBe("body");
    expect(observed).toEqual(["a", "b"]);
  });
});
