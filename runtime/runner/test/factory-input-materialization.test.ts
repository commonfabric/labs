import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  createFactoryShell,
  sealFactoryState,
} from "@commonfabric/data-model/fabric-factory";
import { Identity } from "@commonfabric/identity";
import { getLoggerCountsBreakdown } from "@commonfabric/logger";

import {
  setDurableArtifactEntryRef,
  setFrameworkProvidedPaths,
} from "../src/builder/pattern-metadata.ts";
import type { FabricValue, JSONSchema } from "../src/builder/types.ts";
import type { FactoryContract } from "../src/factory-materialization.ts";
import { materializeScheduledFactoryInputs } from "../src/factory-input-preparation.ts";
import { Runtime } from "../src/runtime.ts";
import { RetryWhenReady } from "../src/scheduler/retry-when-ready.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import type {
  IExtendedStorageTransaction,
  MemorySpace,
} from "../src/storage/interface.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";

const signer = await Identity.fromPassphrase(
  "scheduled factory input materialization test",
);
const space = signer.did();
const linkedArtifactSpace = (await Identity.fromPassphrase(
  "scheduled factory input linked artifact space",
)).did();
const eventArtifactSpace = (await Identity.fromPassphrase(
  "scheduled factory input event artifact space",
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

const SELECTED_HANDLER_EVENT_SCHEMA = {
  type: "object",
  properties: { amount: { type: "number" } },
  required: ["amount"],
  additionalProperties: false,
} as const satisfies JSONSchema;

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

const OBSERVATION_SCHEMA = {
  type: "object",
  properties: { observed: { type: "string" } },
  required: ["observed"],
  additionalProperties: false,
} as const satisfies JSONSchema;

const CONTRACTS = {
  pattern: {
    kind: "pattern",
    argumentSchema: ARGUMENT_SCHEMA,
    resultSchema: RESULT_SCHEMA,
  },
  module: {
    kind: "module",
    argumentSchema: ARGUMENT_SCHEMA,
    resultSchema: RESULT_SCHEMA,
  },
  handler: {
    kind: "handler",
    contextSchema: ARGUMENT_SCHEMA,
    eventSchema: SELECTED_HANDLER_EVENT_SCHEMA,
  },
} as const satisfies Record<FactoryKind, FactoryContract>;

const REFS = {
  pattern: {
    identity: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    symbol: "scheduledPattern",
  },
  module: {
    identity: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBA",
    symbol: "scheduledModule",
  },
  handler: {
    identity: "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCA",
    symbol: "scheduledHandler",
  },
} as const;

const FACTORY_KINDS = ["pattern", "module", "handler"] as const;
type FactoryKind = (typeof FACTORY_KINDS)[number];
type LiveFactory = ((input: unknown) => unknown) & Record<PropertyKey, any>;

type SelectedFactory = {
  kind: FactoryKind;
  contract: FactoryContract;
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

describe("scheduled Factory@1 input materialization", () => {
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

  function factoryContainerSchema(contract: FactoryContract): JSONSchema {
    return {
      type: "object",
      properties: { factory: { asFactory: contract } },
      required: ["factory"],
      additionalProperties: false,
    } as JSONSchema;
  }

  function selectFactory(
    kind: FactoryKind,
    sourceSpace: MemorySpace,
    warm: boolean,
  ): SelectedFactory {
    let live: LiveFactory;
    if (kind === "pattern") {
      live = commonfabric.pattern(
        ({ value }: { value: number }) => ({ result: value }),
        ARGUMENT_SCHEMA,
        RESULT_SCHEMA,
      );
    } else if (kind === "module") {
      live = commonfabric.lift(
        ({ value }: { value: number }) => ({ result: value + 1 }),
        ARGUMENT_SCHEMA,
        RESULT_SCHEMA,
      );
    } else {
      live = commonfabric.handler(
        SELECTED_HANDLER_EVENT_SCHEMA,
        ARGUMENT_SCHEMA,
        (_event: { amount: number }, _context: { value: number }) => undefined,
      );
    }
    const ref = REFS[kind];
    // FrameworkProvided obligations are trusted artifact metadata, not part of
    // Factory@1 or the authored asFactory schema. Every lifecycle case below
    // therefore also guards that schema-driven materialization preserves the
    // trusted base factory's obligations without treating authored omission as
    // an exact empty authority contract.
    setFrameworkProvidedPaths(live, [["value"]]);
    setDurableArtifactEntryRef(live, ref);
    availableClosures.add(spaceKey(ref.identity, sourceSpace));
    if (warm) warmArtifacts.set(key(ref.identity, ref.symbol), live);
    return {
      kind,
      contract: CONTRACTS[kind],
      live,
      shell: createFactoryShell(sealFactoryState(live)),
      ref,
    };
  }

  function invokeSelected(factory: unknown): unknown {
    if (typeof factory !== "function") {
      throw new TypeError("scheduled factory input is not callable");
    }
    return factory({ value: 7 });
  }

  function observeCallbackOutcome() {
    const succeeded = deferred<void>();
    const failed = deferred<Error>();
    runtime.scheduler.onError((error) => failed.resolve(error));
    return {
      succeeded,
      failed,
      wait: () =>
        within(
          Promise.race([
            succeeded.promise.then(() => "success" as const),
            failed.promise.then((error) => `error: ${error.message}`),
          ]),
          "scheduled callback outcome",
        ),
    };
  }

  function liftConsumer(
    selected: SelectedFactory,
    onEntered: () => void,
    onSucceeded: () => void,
  ): any {
    const schema = factoryContainerSchema(selected.contract);
    const consumer = commonfabric.lift(
      ({ factory }: { factory: unknown }) => {
        onEntered();
        invokeSelected(factory);
        onSucceeded();
        return { observed: selected.kind };
      },
      schema,
      OBSERVATION_SCHEMA,
    );
    return commonfabric.pattern(
      ({ factory }: { factory: unknown }) => consumer({ factory }),
      schema,
      OBSERVATION_SCHEMA,
    );
  }

  function handlerContextConsumer(
    selected: SelectedFactory,
    onEntered: () => void,
    onSucceeded: () => void,
  ): any {
    const contextSchema = factoryContainerSchema(selected.contract);
    const consumer = commonfabric.handler(
      TRIGGER_SCHEMA,
      contextSchema,
      (
        _event: { fire: boolean },
        { factory }: { factory: unknown },
      ) => {
        onEntered();
        invokeSelected(factory);
        onSucceeded();
      },
    );
    return commonfabric.pattern(
      ({ factory }: { factory: unknown }) => ({
        events: consumer({ factory }),
      }),
      contextSchema,
    );
  }

  function handlerEventConsumer(
    selected: SelectedFactory,
    onEntered: () => void,
    onSucceeded: () => void,
  ): any {
    const eventSchema = factoryContainerSchema(selected.contract);
    const consumer = commonfabric.handler(
      eventSchema,
      EMPTY_SCHEMA,
      ({ factory }: { factory: unknown }) => {
        onEntered();
        invokeSelected(factory);
        onSucceeded();
      },
    );
    return commonfabric.pattern(
      () => ({ events: consumer({}) }),
      EMPTY_SCHEMA,
    );
  }

  it("leaves an opaque ordinary anyOf branch untouched", () => {
    let getterReads = 0;
    const ordinary = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(ordinary, "opaque", {
      enumerable: true,
      get() {
        getterReads++;
        throw new Error("opaque getter must not be read");
      },
    });
    const unionSchema = {
      anyOf: [
        { type: "object" },
        { asFactory: CONTRACTS.module },
      ],
    } as JSONSchema;
    const tx = runtime.edit();
    try {
      const inputsCell = runtime.getCell<unknown>(
        space,
        "opaque-factory-union-input",
        unionSchema,
        tx,
      );
      expect(
        materializeScheduledFactoryInputs(ordinary, unionSchema, {
          runtime,
          tx,
          inputsCell,
        }),
      ).toBe(ordinary);
      expect(getterReads).toBe(0);
    } finally {
      tx.abort(new Error("test cleanup"));
    }
  });

  it("selects exactly one matching factory contract from a union", () => {
    const selected = selectFactory("pattern", space, true);
    const schema = {
      anyOf: [
        { asFactory: CONTRACTS.pattern },
        { asFactory: CONTRACTS.handler },
      ],
    } as const satisfies JSONSchema;
    const tx = runtime.edit();
    try {
      const inputsCell = runtime.getCell<unknown>(
        space,
        "factory-contract-union-input",
        schema,
        tx,
      );
      expect(
        materializeScheduledFactoryInputs(selected.shell, schema, {
          runtime,
          tx,
          inputsCell,
        }),
      ).toBe(selected.live);
    } finally {
      tx.abort(new Error("test cleanup"));
    }
  });

  it("quietly skips unrelated embedded schemas while scanning for factories", () => {
    const ordinary = { manager: { fullUI: { type: "vnode" } } };
    const schema = {
      type: "object",
      properties: {
        manager: {
          type: "object",
          properties: {
            fullUI: {
              $ref: "https://commonfabric.org/schemas/vnode.json",
            },
          },
        },
      },
    } as const satisfies JSONSchema;
    const warningCount = () => getLoggerCountsBreakdown().cfc?.cfc?.warn ?? 0;
    const before = warningCount();
    const tx = runtime.edit();
    try {
      const inputsCell = runtime.getCell<unknown>(
        space,
        "unrelated-embedded-schema-input",
        schema,
        tx,
      );

      expect(
        materializeScheduledFactoryInputs(ordinary, schema, {
          runtime,
          tx,
          inputsCell,
        }),
      ).toBe(ordinary);
      expect(warningCount()).toBe(before);
    } finally {
      tx.abort(new Error("test cleanup"));
    }
  });

  it("terminates factory discovery through recursive root definitions", () => {
    const ordinary = { value: "root", next: { value: "child" } };
    const schema = {
      $ref: "#/$defs/Node",
      $defs: {
        Node: {
          type: "object",
          properties: {
            value: { type: "string" },
            next: { $ref: "#/$defs/Node" },
          },
          required: ["value"],
        },
      },
    } as const satisfies JSONSchema;
    const tx = runtime.edit();
    try {
      const inputsCell = runtime.getCell<unknown>(
        space,
        "recursive-factory-discovery-input",
        schema,
        tx,
      );

      expect(
        materializeScheduledFactoryInputs(ordinary, schema, {
          runtime,
          tx,
          inputsCell,
        }),
      ).toBe(ordinary);
    } finally {
      tx.abort(new Error("test cleanup"));
    }
  });

  it("does not cache a false factory result through mutual recursion", () => {
    const selected = selectFactory("module", space, true);
    const refA = { $ref: "#/$defs/A" } as const;
    const refB = { $ref: "#/$defs/B" } as const;
    const schema = {
      type: "object",
      properties: {
        // Discovering A first traverses A -> B -> A before reaching A.factory.
        // B must not retain the provisional false result from that cycle.
        seed: refA,
        payload: refB,
      },
      required: ["payload"],
      $defs: {
        A: {
          type: "object",
          properties: {
            b: refB,
            factory: { asFactory: CONTRACTS.module },
          },
        },
        B: {
          type: "object",
          properties: { a: refA },
        },
      },
    } as const satisfies JSONSchema;
    const tx = runtime.edit();
    try {
      const inputsCell = runtime.getCell<unknown>(
        space,
        "mutually-recursive-factory-input",
        schema,
        tx,
      );
      const prepared = materializeScheduledFactoryInputs(
        { payload: { a: { factory: selected.shell } } },
        schema,
        { runtime, tx, inputsCell },
      ) as { payload: { a: { factory: unknown } } };
      expect(prepared.payload.a.factory).toBe(selected.live);
    } finally {
      tx.abort(new Error("test cleanup"));
    }
  });

  it("discovers factories through arbitrary local JSON Pointer refs", () => {
    const selected = selectFactory("module", space, true);
    const schema = {
      type: "object",
      properties: {
        payload: { $ref: "#/properties/factoryContainer" },
        factoryContainer: {
          type: "object",
          properties: { factory: { asFactory: CONTRACTS.module } },
        },
      },
    } as const satisfies JSONSchema;
    const tx = runtime.edit();
    try {
      const inputsCell = runtime.getCell<unknown>(
        space,
        "non-definition-factory-ref-input",
        schema,
        tx,
      );

      expect(
        materializeScheduledFactoryInputs(
          { payload: { factory: selected.shell } },
          schema,
          {
            runtime,
            tx,
            inputsCell,
          },
        ),
      ).toEqual({ payload: { factory: selected.live } });
    } finally {
      tx.abort(new Error("test cleanup"));
    }
  });

  it("discovers chained definitions refs with escaped pointer segments", () => {
    const selected = selectFactory("pattern", space, true);
    const schema = {
      type: "object",
      properties: {
        payload: { $ref: "#/definitions/factory~1alias" },
      },
      definitions: {
        "factory/alias": { $ref: "#/definitions/nested/properties/value" },
        nested: {
          properties: {
            value: {
              type: "object",
              properties: { factory: { asFactory: CONTRACTS.pattern } },
              required: ["factory"],
            },
          },
        },
      },
    } as const satisfies JSONSchema;
    const tx = runtime.edit();
    try {
      const inputsCell = runtime.getCell<unknown>(
        space,
        "definitions-factory-ref-input",
        schema,
        tx,
      );

      expect(
        materializeScheduledFactoryInputs(
          { payload: { factory: selected.shell } },
          schema,
          { runtime, tx, inputsCell },
        ),
      ).toEqual({ payload: { factory: selected.live } });
    } finally {
      tx.abort(new Error("test cleanup"));
    }
  });

  it("materializes tuple factory leaves through prefixItems", () => {
    const selected = selectFactory("module", space, true);
    const tupleSchema = {
      type: "array",
      prefixItems: [{ asFactory: selected.contract }],
      items: false,
    } as JSONSchema;
    const tx = runtime.edit();
    try {
      const inputsCell = runtime.getCell<unknown>(
        space,
        "tuple-factory-input",
        tupleSchema,
        tx,
      );
      const prepared = materializeScheduledFactoryInputs(
        [selected.shell],
        tupleSchema,
        { runtime, tx, inputsCell },
      ) as unknown[];

      expect(prepared[0]).toBe(selected.live);
    } finally {
      tx.abort(new Error("test cleanup"));
    }
  });

  it("skips a non-selected object union branch with a factory property", () => {
    const selected = selectFactory("module", space, true);
    const unionSchema = {
      anyOf: [
        {
          type: "object",
          properties: {
            kind: { const: "plain" },
            value: { type: "string" },
          },
          required: ["kind", "value"],
        },
        {
          type: "object",
          properties: {
            kind: { const: "factory" },
            factory: { asFactory: selected.contract },
          },
          required: ["kind", "factory"],
        },
      ],
    } as JSONSchema;
    const ordinary = { kind: "plain", value: "untouched" };
    const tx = runtime.edit();
    try {
      const inputsCell = runtime.getCell<unknown>(
        space,
        "object-union-factory-input",
        unionSchema,
        tx,
      );

      expect(
        materializeScheduledFactoryInputs(ordinary, unionSchema, {
          runtime,
          tx,
          inputsCell,
        }),
      ).toBe(ordinary);
    } finally {
      tx.abort(new Error("test cleanup"));
    }
  });

  it("selects a discriminated factory branch before enforcing its contract", () => {
    const selected = selectFactory("pattern", space, true);
    const unionSchema = {
      type: "object",
      properties: {
        selection: {
          oneOf: [
            {
              type: "object",
              properties: {
                kind: { const: "pattern" },
                factory: { asFactory: CONTRACTS.pattern },
              },
              required: ["kind", "factory"],
            },
            {
              type: "object",
              properties: {
                kind: { const: "module" },
                factory: { asFactory: CONTRACTS.module },
              },
              required: ["kind", "factory"],
            },
          ],
        },
      },
      required: ["selection"],
    } as JSONSchema;
    const input = {
      selection: { kind: "pattern", factory: selected.shell },
    };
    const tx = runtime.edit();
    try {
      const inputsCell = runtime.getCell<unknown>(
        space,
        "discriminated-factory-union-input",
        unionSchema,
        tx,
      );
      const prepared = materializeScheduledFactoryInputs(
        input,
        unionSchema,
        { runtime, tx, inputsCell },
      ) as typeof input;

      expect(prepared.selection.factory).toBe(selected.live);
    } finally {
      tx.abort(new Error("test cleanup"));
    }
  });

  it("resolves union property refs against the enclosing schema", () => {
    const selected = selectFactory("module", space, true);
    const unionSchema = {
      type: "object",
      properties: {
        selection: {
          oneOf: [
            {
              type: "object",
              properties: {
                kind: { const: "plain" },
                value: { type: "string" },
              },
              required: ["kind", "value"],
            },
            { $ref: "#/$defs/FactorySelection" },
          ],
        },
      },
      required: ["selection"],
      $defs: {
        FactoryKind: { const: "factory" },
        FactorySelection: {
          type: "object",
          properties: {
            kind: { $ref: "#/$defs/FactoryKind" },
            factory: { asFactory: CONTRACTS.module },
          },
          required: ["kind", "factory"],
        },
      },
    } as const satisfies JSONSchema;
    const input = {
      selection: { kind: "factory", factory: selected.shell },
    };
    const warningCount = () => getLoggerCountsBreakdown().cfc?.cfc?.warn ?? 0;
    const before = warningCount();
    const tx = runtime.edit();
    try {
      const inputsCell = runtime.getCell<unknown>(
        space,
        "referenced-discriminator-factory-union-input",
        unionSchema,
        tx,
      );
      const prepared = materializeScheduledFactoryInputs(
        input,
        unionSchema,
        { runtime, tx, inputsCell },
      ) as typeof input;

      expect(prepared.selection.factory).toBe(selected.live);
      expect(warningCount()).toBe(before);
    } finally {
      tx.abort(new Error("test cleanup"));
    }
  });

  for (const kind of FACTORY_KINDS) {
    it(`materializes a warm ${kind} factory in lift input`, async () => {
      const selected = selectFactory(kind, space, true);
      const outcome = observeCallbackOutcome();
      let authoredCalls = 0;
      const outer = liftConsumer(
        selected,
        () => authoredCalls++,
        () => outcome.succeeded.resolve(),
      );
      const tx = runtime.edit();
      const resultCell = runtime.getCell<{ observed: string }>(
        space,
        `warm-${kind}-factory-lift-result`,
        OBSERVATION_SCHEMA,
        tx,
      );
      const result = runtime.run(
        tx,
        outer,
        { factory: selected.shell },
        resultCell,
      );
      await commit(tx);

      const pulled = result.pull();
      expect(await outcome.wait()).toBe("success");
      expect(authoredCalls).toBe(1);
      expect(await within(pulled, `${kind} lift result`)).toEqual({
        observed: kind,
      });
    });

    it(`materializes a warm ${kind} factory in handler context`, async () => {
      const selected = selectFactory(kind, space, true);
      const outcome = observeCallbackOutcome();
      let authoredCalls = 0;
      const outer = handlerContextConsumer(
        selected,
        () => authoredCalls++,
        () => outcome.succeeded.resolve(),
      );
      const tx = runtime.edit();
      const resultCell = runtime.getCell<{ events: unknown }>(
        space,
        `warm-${kind}-factory-handler-context-result`,
        undefined,
        tx,
      );
      const result = runtime.run(
        tx,
        outer,
        { factory: selected.shell },
        resultCell,
      );
      await commit(tx);
      await result.pull();

      result.key("events").send({ fire: true });
      expect(await outcome.wait()).toBe("success");
      expect(authoredCalls).toBe(1);
    });

    it(`materializes a warm ${kind} factory in handler event data`, async () => {
      const selected = selectFactory(kind, space, true);
      const outcome = observeCallbackOutcome();
      let authoredCalls = 0;
      const outer = handlerEventConsumer(
        selected,
        () => authoredCalls++,
        () => outcome.succeeded.resolve(),
      );
      const tx = runtime.edit();
      const resultCell = runtime.getCell<{ events: unknown }>(
        space,
        `warm-${kind}-factory-handler-event-result`,
        undefined,
        tx,
      );
      const result = runtime.run(tx, outer, {}, resultCell);
      await commit(tx);
      await result.pull();

      result.key("events").send({ factory: selected.shell });
      expect(await outcome.wait()).toBe("success");
      expect(authoredCalls).toBe(1);
    });
  }

  for (const kind of FACTORY_KINDS) {
    for (
      const position of [
        "lift input",
        "handler context",
        "handler event data",
      ] as const
    ) {
      it(`holds a cold ${kind} factory in ${position} until readiness`, async () => {
        const artifactSpace = position === "handler event data"
          ? eventArtifactSpace
          : linkedArtifactSpace;
        const selected = selectFactory(kind, artifactSpace, false);
        const authoredEntered = deferred<void>();
        const outcome = observeCallbackOutcome();
        let authoredCalls = 0;
        const onEntered = () => {
          authoredCalls++;
          authoredEntered.resolve();
        };
        const outer = position === "lift input"
          ? liftConsumer(
            selected,
            onEntered,
            () => outcome.succeeded.resolve(),
          )
          : position === "handler context"
          ? handlerContextConsumer(
            selected,
            onEntered,
            () => outcome.succeeded.resolve(),
          )
          : handlerEventConsumer(
            selected,
            onEntered,
            () => outcome.succeeded.resolve(),
          );

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
          warmArtifacts.set(key(identity, symbol), selected.live);
          return selected.live;
        };

        let pulled: Promise<unknown> | undefined;
        if (position === "handler event data") {
          const tx = runtime.edit();
          const resultCell = runtime.getCell<{ events: unknown }>(
            eventArtifactSpace,
            `cold-${kind}-factory-handler-event-result`,
            undefined,
            tx,
          );
          const result = runtime.run(tx, outer, {}, resultCell);
          await commit(tx);
          await result.pull();
          result.key("events").send({ factory: selected.shell });
        } else {
          const seed = runtime.edit();
          const selectorCause = `cold-${kind}-${position}-linked-factory`;
          const seededSelector = runtime.getCell<FabricValue>(
            linkedArtifactSpace,
            selectorCause,
            undefined,
            seed,
          );
          seededSelector.set(selected.shell);
          await commit(seed);

          const selector = runtime.getCell<FabricValue>(
            linkedArtifactSpace,
            selectorCause,
          );
          const tx = runtime.edit();
          const resultCell = runtime.getCell<
            { observed: string } | { events: unknown }
          >(
            space,
            `cold-${kind}-${position}-result`,
            undefined,
            tx,
          );
          const result = runtime.run(
            tx,
            outer,
            { factory: selector },
            resultCell,
          );
          await commit(tx);
          pulled = result.pull();
          if (position === "handler context") {
            await pulled;
            result.key("events").send({ fire: true });
          }
        }

        try {
          const first = await within(
            Promise.race([
              loadEntered.promise.then(() => "load" as const),
              authoredEntered.promise.then(() => "authored" as const),
              outcome.failed.promise.then((error) => `error: ${error.message}`),
            ]),
            `cold ${kind} ${position} readiness boundary`,
          );
          expect(first).toBe("load");
          expect(authoredCalls).toBe(0);
          expect(loads).toEqual([{
            ...selected.ref,
            sourceSpace: artifactSpace,
          }]);
        } finally {
          releaseLoad.resolve();
        }

        expect(await outcome.wait()).toBe("success");
        expect(authoredCalls).toBe(1);
        if (position === "lift input") {
          expect(await within(pulled!, `cold ${kind} lift result`)).toEqual({
            observed: kind,
          });
        }
        await runtime.idle();
      });
    }
  }

  it("waits for every nested cold factory leaf before invoking authored code", async () => {
    const selectedModule = selectFactory("module", space, false);
    const selectedPattern = selectFactory("pattern", space, false);
    const schema = {
      type: "object",
      properties: {
        nested: {
          type: "object",
          properties: {
            array: {
              type: "array",
              items: { asFactory: selectedModule.contract },
            },
            object: {
              type: "object",
              properties: {
                factory: { asFactory: selectedPattern.contract },
              },
              required: ["factory"],
              additionalProperties: false,
            },
          },
          required: ["array", "object"],
          additionalProperties: false,
        },
      },
      required: ["nested"],
      additionalProperties: false,
    } as JSONSchema;
    const values = {
      nested: {
        array: [selectedModule.shell],
        object: { factory: selectedPattern.shell },
      },
    };
    let authoredCalls = 0;

    const releases = new Map([
      [selectedModule.ref.identity, deferred<void>()],
      [selectedPattern.ref.identity, deferred<void>()],
    ]);
    const selectedByIdentity = new Map([
      [selectedModule.ref.identity, selectedModule],
      [selectedPattern.ref.identity, selectedPattern],
    ]);
    const allLoadsEntered = deferred<void>();
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
      if (loads.length === 2) allLoadsEntered.resolve();
      await releases.get(identity)!.promise;
      const selected = selectedByIdentity.get(identity)!;
      warmArtifacts.set(key(identity, symbol), selected.live);
      return selected.live;
    };

    const tx = runtime.edit();
    try {
      const inputsCell = runtime.getImmutableCell(
        space,
        values,
        undefined,
        tx,
      );
      const invokeAuthored = () => {
        const prepared = materializeScheduledFactoryInputs(
          values,
          schema,
          { runtime, tx, inputsCell },
        ) as typeof values;
        authoredCalls++;
        invokeSelected(prepared.nested.array[0]);
        invokeSelected(prepared.nested.object.factory);
        return { observed: "both" };
      };

      let readiness: Promise<unknown> | undefined;
      try {
        invokeAuthored();
        throw new Error("expected cold nested preparation to suspend");
      } catch (error) {
        expect(error).toBeInstanceOf(RetryWhenReady);
        readiness = (error as RetryWhenReady).readiness;
      }

      await within(allLoadsEntered.promise, "all nested cold loads to enter");
      expect(authoredCalls).toBe(0);
      let readinessSettled = false;
      readiness!.then(() => readinessSettled = true);
      releases.get(selectedModule.ref.identity)!.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(readinessSettled).toBe(false);
      expect(authoredCalls).toBe(0);

      releases.get(selectedPattern.ref.identity)!.resolve();
      await within(readiness!, "all nested cold loads to become ready");
      expect(authoredCalls).toBe(0);
      expect(invokeAuthored()).toEqual({ observed: "both" });
      expect(authoredCalls).toBe(1);
      expect(loads).toEqual([
        { ...selectedModule.ref, sourceSpace: space },
        { ...selectedPattern.ref, sourceSpace: space },
      ]);
      // Preparation clones only the selected containers; the decoded source
      // remains an inert value suitable for re-reading on a later attempt.
      expect(() => (values.nested.array[0] as unknown as () => unknown)())
        .toThrow("factory requires runner materialization");
    } finally {
      tx.abort(new Error("test cleanup"));
    }
  });

  it("does not start an earlier cold leaf when a later leaf is terminal", () => {
    const cold = selectFactory("module", space, false);
    const wrongKind = selectFactory("pattern", space, true);
    const schema = {
      type: "object",
      properties: {
        cold: { asFactory: CONTRACTS.module },
        terminal: { asFactory: CONTRACTS.module },
      },
      required: ["cold", "terminal"],
      additionalProperties: false,
    } as JSONSchema;
    let loadCalls = 0;
    runtime.patternManager.loadArtifactByIdentity = (
      identity,
      symbol,
    ) => {
      loadCalls++;
      warmArtifacts.set(key(identity, symbol), cold.live);
      return Promise.resolve(cold.live);
    };
    const tx = runtime.edit();
    try {
      const inputsCell = runtime.getImmutableCell(
        space,
        { cold: cold.shell, terminal: wrongKind.shell },
        undefined,
        tx,
      );
      expect(() =>
        materializeScheduledFactoryInputs(
          { cold: cold.shell, terminal: wrongKind.shell },
          schema,
          { runtime, tx, inputsCell },
        )
      ).toThrow("Factory materialization kind mismatch");
      expect(loadCalls).toBe(0);
    } finally {
      tx.abort(new Error("test cleanup"));
    }
  });

  it("surfaces one source-load failure without synthetic sleep retries", async () => {
    const selected = selectFactory("module", space, false);
    let loadAttempts = 0;
    runtime.patternManager.loadArtifactByIdentity = (
      identity,
      symbol,
      sourceSpace,
    ) => {
      loadAttempts++;
      expect({ identity, symbol, sourceSpace }).toEqual({
        ...selected.ref,
        sourceSpace: space,
      });
      return Promise.reject(new Error("factory source load failed"));
    };

    const schema = factoryContainerSchema(selected.contract);
    const tx = runtime.edit();
    try {
      const inputsCell = runtime.getImmutableCell(
        space,
        { factory: selected.shell },
        undefined,
        tx,
      );
      let retry!: RetryWhenReady;
      try {
        materializeScheduledFactoryInputs(
          { factory: selected.shell },
          schema,
          { runtime, tx, inputsCell },
        );
      } catch (error) {
        expect(error).toBeInstanceOf(RetryWhenReady);
        retry = error as RetryWhenReady;
      }

      await expect(retry.readiness).rejects.toThrow(
        "factory source load failed",
      );
      expect(loadAttempts).toBe(1);
    } finally {
      tx.abort(new Error("test cleanup"));
    }
  });
});
