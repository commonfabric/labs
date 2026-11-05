import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  createFactoryShell,
  sealFactoryState,
} from "@commonfabric/data-model/fabric-factory";
import { FabricBytes } from "@commonfabric/data-model/fabric-primitives";
import { Identity } from "@commonfabric/identity";

import { setDurableArtifactEntryRef } from "../src/builder/pattern-metadata.ts";
import { withPatternParamsSchema } from "../src/builder/pattern.ts";
import type {
  BuilderFunctionsAndConstants,
  InternalPatternFactory,
  JSONSchema,
  Reactive,
} from "../src/builder/types.ts";
import type { FactoryContract } from "../src/factory-materialization.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import type {
  IExtendedStorageTransaction,
  MemorySpace,
} from "../src/storage/interface.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";

const signer = await Identity.fromPassphrase("dynamic factory node test");
const space = signer.did();
const linkedArtifactSpace = (await Identity.fromPassphrase(
  "dynamic factory node linked artifact source",
)).did();
const dynamicExecutionSpace = (await Identity.fromPassphrase(
  "dynamic factory node execution target",
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

const MODULE_CONTRACT = {
  kind: "module",
  argumentSchema: ARGUMENT_SCHEMA,
  resultSchema: RESULT_SCHEMA,
} as const satisfies FactoryContract;

type DynamicContract = typeof PATTERN_CONTRACT | typeof MODULE_CONTRACT;

const REFS = {
  pattern: {
    identity: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    symbol: "selectedPattern",
  },
  module: {
    identity: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBA",
    symbol: "selectedModule",
  },
  handler: {
    identity: "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCA",
    symbol: "selectedHandler",
  },
  byRef: {
    identity: "EAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    symbol: "selectedByRef",
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

async function whenDefined<T>(
  value: {
    sink(callback: (current: T | undefined) => void): () => void;
  },
  label: string,
): Promise<T> {
  let cancel = () => {};
  const pending = new Promise<T>((resolve) => {
    cancel = value.sink((current) => {
      if (current !== undefined) resolve(current);
    });
  });
  try {
    return await within(pending, label);
  } finally {
    cancel();
  }
}

describe("dynamic Factory@1 node", () => {
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

  function outerPattern(expected: DynamicContract) {
    const argumentSchema = {
      type: "object",
      properties: {
        factory: { asFactory: expected },
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
          expected,
        ),
      argumentSchema,
      RESULT_SCHEMA,
    );
  }

  function makeSelections() {
    const selectedPattern = commonfabric.pattern(
      ({ value }: { value: number }) => ({ result: value }),
      ARGUMENT_SCHEMA,
      RESULT_SCHEMA,
    );
    const selectedModule = commonfabric.lift(
      ({ value }: { value: number }) => ({ result: value + 1 }),
      ARGUMENT_SCHEMA,
      RESULT_SCHEMA,
    );
    setDurableArtifactEntryRef(selectedPattern, REFS.pattern);
    setDurableArtifactEntryRef(selectedModule, REFS.module);
    return { selectedPattern, selectedModule };
  }

  it("dispatches warm symbolic PatternFactory and ModuleFactory values through their existing runner paths", async () => {
    const { selectedPattern, selectedModule } = makeSelections();
    warmArtifacts.set(
      refKey(REFS.pattern.identity, REFS.pattern.symbol),
      selectedPattern,
    );
    warmArtifacts.set(
      refKey(REFS.module.identity, REFS.module.symbol),
      selectedModule,
    );

    const cases = [
      {
        label: "pattern",
        selected: selectedPattern,
        expected: PATTERN_CONTRACT,
        value: 7,
        result: 7,
      },
      {
        label: "module",
        selected: selectedModule,
        expected: MODULE_CONTRACT,
        value: 7,
        result: 8,
      },
    ] as const;

    const running = cases.map((testCase) => {
      const resultCell = runtime.getCell<{ result: number }>(
        space,
        `dynamic-factory-warm-${testCase.label}`,
        RESULT_SCHEMA,
        tx,
      );
      const result = runtime.run(
        tx,
        outerPattern(testCase.expected),
        {
          factory: createFactoryShell(sealFactoryState(testCase.selected)),
          value: testCase.value,
        },
        resultCell,
      );
      return { testCase, result };
    });
    await commitAndRenew();

    for (const { testCase, result } of running) {
      expect(await within(result.pull(), `${testCase.label} result`)).toEqual({
        result: testCase.result,
      });
    }
  });

  it("replaces a dynamic pattern when only bound FabricBytes params change", async () => {
    const paramsSchema = {
      type: "object",
      properties: { bytes: true },
      required: ["bytes"],
      additionalProperties: false,
    } as const satisfies JSONSchema;
    const calculate = commonfabric.lift(({
      value,
      bytes,
    }: {
      value: number;
      bytes: FabricBytes;
    }) => ({ result: value + (bytes.slice()[0] ?? 0) }));
    const base = commonfabric.pattern(
      withPatternParamsSchema(
        ((argument: any, params: { bytes: FabricBytes }) =>
          calculate({ value: argument.value, bytes: params.bytes })) as any,
        paramsSchema,
      ) as any,
      ARGUMENT_SCHEMA,
      RESULT_SCHEMA,
    );
    setDurableArtifactEntryRef(base, REFS.pattern);
    warmArtifacts.set(
      refKey(REFS.pattern.identity, REFS.pattern.symbol),
      base,
    );
    const bind = (byte: number) =>
      (base as InternalPatternFactory<unknown, unknown>).curry({
        bytes: new FabricBytes(new Uint8Array([byte])),
      });
    const selectedA = bind(1);
    const selectedB = bind(9);
    const selector = runtime.getCell<unknown>(
      space,
      "dynamic-factory-fabric-bytes-selector",
      undefined,
      tx,
    );
    selector.set(createFactoryShell(sealFactoryState(selectedA)));
    const resultCell = runtime.getCell<{ result: number }>(
      space,
      "dynamic-factory-fabric-bytes-result",
      RESULT_SCHEMA,
      tx,
    );
    const result = runtime.run(
      tx,
      outerPattern(PATTERN_CONTRACT),
      { factory: selector, value: 1 },
      resultCell,
    );
    await commitAndRenew();

    expect(await within(result.pull(), "first FabricBytes selection"))
      .toEqual({ result: 2 });
    const outputIdentity = result.key("result").getAsNormalizedFullLink();

    selector.withTx(tx).set(
      createFactoryShell(sealFactoryState(selectedB)),
    );
    await commitAndRenew();

    expect(await within(result.pull(), "replacement FabricBytes selection"))
      .toEqual({ result: 10 });
    expect(result.key("result").getAsNormalizedFullLink()).toEqual(
      outputIdentity,
    );
  });

  it("subscribes before the first selection so absence stays pending and later arrival instantiates", async () => {
    const { selectedModule } = makeSelections();
    warmArtifacts.set(
      refKey(REFS.module.identity, REFS.module.symbol),
      selectedModule,
    );
    const selectedShell = createFactoryShell(sealFactoryState(selectedModule));
    const selector = runtime.getCell<unknown>(
      space,
      "dynamic-factory-late-selector",
      undefined,
      tx,
    );
    const resultCell = runtime.getCell<{ result: number }>(
      space,
      "dynamic-factory-late-result",
      RESULT_SCHEMA,
      tx,
    );
    const result = runtime.run(
      tx,
      outerPattern(MODULE_CONTRACT),
      { factory: selector, value: 4 },
      resultCell,
    );
    await commitAndRenew();
    await runtime.idle();

    expect(result.key("result").get()).toBeUndefined();

    selector.withTx(tx).set(selectedShell);
    await commitAndRenew();

    expect(await within(result.pull(), "late factory result")).toEqual({
      result: 5,
    });
  });

  it("dispatches a warm symbolic HandlerFactory through the existing event path", async () => {
    const eventSchema = {
      type: "object",
      properties: { amount: { type: "number" } },
      required: ["amount"],
      additionalProperties: false,
    } as const satisfies JSONSchema;
    const expected = {
      kind: "handler",
      contextSchema: ARGUMENT_SCHEMA,
      eventSchema,
    } as const satisfies FactoryContract;
    const events: Array<{ amount: number; value: number }> = [];
    const selected = commonfabric.handler(
      eventSchema,
      ARGUMENT_SCHEMA,
      ({ amount }, { value }) => events.push({ amount, value }),
    );
    setDurableArtifactEntryRef(selected, REFS.handler);
    warmArtifacts.set(
      refKey(REFS.handler.identity, REFS.handler.symbol),
      selected,
    );

    const outer = commonfabric.pattern<
      { factory: unknown; value: number },
      { events: unknown }
    >(
      ({ factory, value }) => ({
        events: invokeFactory(factory, { value }, expected),
      }),
      {
        type: "object",
        properties: {
          factory: { asFactory: expected },
          value: { type: "number" },
        },
        required: ["factory", "value"],
        additionalProperties: false,
      },
    );
    const resultCell = runtime.getCell<any>(
      space,
      "dynamic-factory-handler-result",
      undefined,
      tx,
    );
    const result = runtime.run(tx, outer, {
      factory: createFactoryShell(sealFactoryState(selected)),
      value: 9,
    }, resultCell);
    await commitAndRenew();
    await result.pull();

    result.key("events").send({ amount: 3 });
    await runtime.idle();
    expect(events).toEqual([{ amount: 3, value: 9 }]);
  });

  it("resolves a schema-light byRef factory only through trusted ModuleRegistry metadata", async () => {
    const selected = commonfabric.byRef("dynamic-trusted-byref");
    const implementation = commonfabric.lift(
      ({ value }: { value: number }) => ({ result: value + 5 }),
      ARGUMENT_SCHEMA,
      RESULT_SCHEMA,
    );
    runtime.moduleRegistry.addModuleByRef(
      "dynamic-trusted-byref",
      implementation,
    );
    setDurableArtifactEntryRef(selected, REFS.byRef);
    warmArtifacts.set(
      refKey(REFS.byRef.identity, REFS.byRef.symbol),
      selected,
    );

    const resultCell = runtime.getCell<{ result: number }>(
      space,
      "dynamic-factory-byref-result",
      RESULT_SCHEMA,
      tx,
    );
    const result = runtime.run(
      tx,
      outerPattern(MODULE_CONTRACT),
      {
        factory: createFactoryShell(sealFactoryState(selected)),
        value: 6,
      },
      resultCell,
    );
    await commitAndRenew();

    expect(await within(result.pull(), "schema-light byRef result")).toEqual({
      result: 11,
    });
  });

  it("applies pattern scope and execution-space modifiers after base materialization", async () => {
    const base = commonfabric.pattern(
      ({ value }: { value: number }) => ({ result: value }),
      ARGUMENT_SCHEMA,
      RESULT_SCHEMA,
    );
    setDurableArtifactEntryRef(base, REFS.pattern);
    warmArtifacts.set(
      refKey(REFS.pattern.identity, REFS.pattern.symbol),
      base,
    );
    const selected = base.asScope("user").inSpace(dynamicExecutionSpace);

    const resultCell = runtime.getCell<{ result: number }>(
      space,
      "dynamic-factory-modifier-result",
      RESULT_SCHEMA,
      tx,
    );
    const result = runtime.run(
      tx,
      outerPattern(PATTERN_CONTRACT),
      {
        factory: createFactoryShell(sealFactoryState(selected)),
        value: 12,
      },
      resultCell,
    );
    await commitAndRenew();

    expect(await within(result.pull(), "modified pattern result")).toEqual({
      result: 12,
    });
    const selectedResult = result.resolveAsCell().getAsNormalizedFullLink();
    expect(selectedResult.space).toBe(dynamicExecutionSpace);
    expect(selectedResult.scope).toBe("user");
  });

  it("fails closed on a wrong-kind selection before authored code runs", async () => {
    let executions = 0;
    const selected = commonfabric.lift(
      ({ value }: { value: number }) => {
        executions++;
        return { result: value };
      },
      ARGUMENT_SCHEMA,
      RESULT_SCHEMA,
    );
    setDurableArtifactEntryRef(selected, REFS.module);
    warmArtifacts.set(
      refKey(REFS.module.identity, REFS.module.symbol),
      selected,
    );
    let observeError!: (error: Error) => void;
    const reportedError = new Promise<Error>((resolve) => {
      observeError = resolve;
    });
    runtime.scheduler.onError((error) => observeError(error));

    const resultCell = runtime.getCell<{ result: number }>(
      space,
      "dynamic-factory-wrong-kind-result",
      RESULT_SCHEMA,
      tx,
    );
    const result = runtime.run(
      tx,
      outerPattern(PATTERN_CONTRACT),
      {
        factory: createFactoryShell(sealFactoryState(selected)),
        value: 13,
      },
      resultCell,
    );
    await commitAndRenew();

    expect((await within(reportedError, "wrong-kind diagnostic")).message)
      .toContain("expected pattern, got module");
    expect(executions).toBe(0);
    expect(result.key("result").get()).toBeUndefined();
  });

  it("does not let call-site schemas authorize a schema-light byRef without registry metadata", async () => {
    const selected = commonfabric.byRef("dynamic-missing-byref");
    setDurableArtifactEntryRef(selected, REFS.byRef);
    warmArtifacts.set(
      refKey(REFS.byRef.identity, REFS.byRef.symbol),
      selected,
    );
    let observeError!: (error: Error) => void;
    const reportedError = new Promise<Error>((resolve) => {
      observeError = resolve;
    });
    runtime.scheduler.onError((error) => observeError(error));

    const resultCell = runtime.getCell<{ result: number }>(
      space,
      "dynamic-factory-missing-byref-result",
      RESULT_SCHEMA,
      tx,
    );
    const result = runtime.run(
      tx,
      outerPattern(MODULE_CONTRACT),
      {
        factory: createFactoryShell(sealFactoryState(selected)),
        value: 2,
      },
      resultCell,
    );
    await commitAndRenew();

    expect((await within(reportedError, "missing byRef diagnostic")).message)
      .toContain("no trusted ModuleRegistry metadata");
    expect(result.key("result").get()).toBeUndefined();
  });

  it("fails closed on a trusted schema mismatch before authored code runs", async () => {
    let executions = 0;
    const selected = commonfabric.lift(
      ({ value }: { value: number }) => {
        executions++;
        return { result: String(value) };
      },
      ARGUMENT_SCHEMA,
      {
        type: "object",
        properties: { result: { type: "string" } },
        required: ["result"],
        additionalProperties: false,
      },
    );
    setDurableArtifactEntryRef(selected, REFS.module);
    warmArtifacts.set(
      refKey(REFS.module.identity, REFS.module.symbol),
      selected,
    );
    let observeError!: (error: Error) => void;
    const reportedError = new Promise<Error>((resolve) => {
      observeError = resolve;
    });
    runtime.scheduler.onError((error) => observeError(error));

    const resultCell = runtime.getCell<{ result: number }>(
      space,
      "dynamic-factory-schema-mismatch-result",
      RESULT_SCHEMA,
      tx,
    );
    const result = runtime.run(
      tx,
      outerPattern(MODULE_CONTRACT),
      {
        factory: createFactoryShell(sealFactoryState(selected)),
        value: 3,
      },
      resultCell,
    );
    await commitAndRenew();

    expect((await within(reportedError, "schema mismatch diagnostic")).message)
      .toContain("schema mismatch");
    expect(executions).toBe(0);
    expect(result.key("result").get()).toBeUndefined();
  });

  it("resolves an anonymous execution selector at the dynamic call site", async () => {
    const base = commonfabric.pattern(
      ({ value }: { value: number }) => ({ result: value }),
      ARGUMENT_SCHEMA,
      RESULT_SCHEMA,
    );
    setDurableArtifactEntryRef(base, REFS.pattern);
    warmArtifacts.set(
      refKey(REFS.pattern.identity, REFS.pattern.symbol),
      base,
    );
    const selected = base.inSpace();
    const resolvedNames: string[] = [];
    runtime.resolveInSpaceNameSync = (_space, name) =>
      resolvedNames.includes(name) ? dynamicExecutionSpace : undefined;
    runtime.resolveInSpaceName = (_space, name) => {
      resolvedNames.push(name);
      return Promise.resolve(dynamicExecutionSpace);
    };

    const resultCell = runtime.getCell<{ result: number }>(
      space,
      "dynamic-factory-anonymous-selector-result",
      RESULT_SCHEMA,
      tx,
    );
    const result = runtime.run(
      tx,
      outerPattern(PATTERN_CONTRACT),
      {
        factory: createFactoryShell(sealFactoryState(selected)),
        value: 14,
      },
      resultCell,
    );
    await commitAndRenew();

    expect(await whenDefined(result, "anonymous selector result")).toEqual({
      result: 14,
    });
    expect(resolvedNames).toHaveLength(1);
    expect(resolvedNames[0]).not.toBe("");
    expect(result.resolveAsCell().getAsNormalizedFullLink().space).toBe(
      dynamicExecutionSpace,
    );
  });

  it("waits for an uncached named execution selector instead of running in the parent space", async () => {
    const base = commonfabric.pattern(
      ({ value }: { value: number }) => ({ result: value }),
      ARGUMENT_SCHEMA,
      RESULT_SCHEMA,
    );
    setDurableArtifactEntryRef(base, REFS.pattern);
    warmArtifacts.set(
      refKey(REFS.pattern.identity, REFS.pattern.symbol),
      base,
    );
    const selected = base.inSpace("dynamic-target-name", {
      grants: { "*": "READ" },
      spaceKind: "profile",
      selfOwned: true,
    });
    let resolved = false;
    const resolvedNames: string[] = [];
    const resolvedRequests: unknown[] = [];
    runtime.resolveInSpaceNameSync = () =>
      resolved ? dynamicExecutionSpace : undefined;
    runtime.resolveInSpaceName = (_space, name, request) => {
      resolvedNames.push(name);
      resolvedRequests.push(request);
      resolved = true;
      return Promise.resolve(dynamicExecutionSpace);
    };

    const resultCell = runtime.getCell<{ result: number }>(
      space,
      "dynamic-factory-named-selector-result",
      RESULT_SCHEMA,
      tx,
    );
    const result = runtime.run(
      tx,
      outerPattern(PATTERN_CONTRACT),
      {
        factory: createFactoryShell(sealFactoryState(selected)),
        value: 15,
      },
      resultCell,
    );
    await commitAndRenew();

    expect(await whenDefined(result, "named selector result")).toEqual({
      result: 15,
    });
    expect(resolvedNames).toEqual(["dynamic-target-name"]);
    expect(resolvedRequests[0]).toMatchObject({
      grants: { "*": "READ" },
      spaceKind: "profile",
      selfOwned: true,
    });
    expect(result.resolveAsCell().getAsNormalizedFullLink().space).toBe(
      dynamicExecutionSpace,
    );
  });

  it("retries the same named execution selector after transient resolution failure", async () => {
    const base = commonfabric.pattern(
      ({ value }: { value: number }) => ({ result: value }),
      ARGUMENT_SCHEMA,
      RESULT_SCHEMA,
    );
    setDurableArtifactEntryRef(base, REFS.pattern);
    warmArtifacts.set(
      refKey(REFS.pattern.identity, REFS.pattern.symbol),
      base,
    );
    const selected = base.inSpace("transient-dynamic-target");
    const state = sealFactoryState(selected);
    let resolutionAttempts = 0;
    let resolved = false;
    runtime.resolveInSpaceNameSync = () =>
      resolved ? dynamicExecutionSpace : undefined;
    runtime.resolveInSpaceName = (_space, name) => {
      expect(name).toBe("transient-dynamic-target");
      resolutionAttempts++;
      if (resolutionAttempts === 1) {
        return Promise.reject(
          new Error("transient execution-space lookup failure"),
        );
      }
      resolved = true;
      return Promise.resolve(dynamicExecutionSpace);
    };
    const diagnostic = Promise.withResolvers<Error>();
    runtime.scheduler.onError((error) => diagnostic.resolve(error));

    const sourceA = runtime.getCell<unknown>(
      space,
      "dynamic-factory-space-retry-source-a",
      undefined,
      tx,
    );
    const sourceB = runtime.getCell<unknown>(
      space,
      "dynamic-factory-space-retry-source-b",
      undefined,
      tx,
    );
    const selector = runtime.getCell<unknown>(
      space,
      "dynamic-factory-space-retry-selector",
      undefined,
      tx,
    );
    sourceA.set(createFactoryShell(state));
    sourceB.set(createFactoryShell({ ...state }));
    selector.setRaw(sourceA.getAsWriteRedirectLink());
    const resultCell = runtime.getCell<{ result: number }>(
      space,
      "dynamic-factory-space-retry-result",
      RESULT_SCHEMA,
      tx,
    );
    const result = runtime.run(
      tx,
      outerPattern(PATTERN_CONTRACT),
      { factory: selector, value: 16 },
      resultCell,
    );
    await commitAndRenew();

    expect(
      (await within(diagnostic.promise, "execution-space lookup diagnostic"))
        .message,
    ).toContain("transient execution-space lookup failure");
    expect(resolutionAttempts).toBe(1);

    // The selected Factory@1 state is unchanged; only its resolved source
    // changed. Failed name readiness must create a fresh generation instead of
    // taking the active-child same-state no-op.
    selector.withTx(tx).setRaw(sourceB.getAsWriteRedirectLink());
    await within(commitAndRenew(), "same-selector retarget commit");

    expect(await within(result.pull(), "retried named selector result"))
      .toEqual({
        result: 16,
      });
    expect(resolutionAttempts).toBe(2);
    expect(result.resolveAsCell().getAsNormalizedFullLink().space).toBe(
      dynamicExecutionSpace,
    );
  });

  it("preserves a cell-derived execution selector until dynamic instantiation", async () => {
    const anchor = runtime.getCell(
      dynamicExecutionSpace,
      "dynamic-factory-selector-anchor",
      undefined,
      tx,
    );
    const base = commonfabric.pattern(
      ({ value }: { value: number }) => ({ result: value }),
      ARGUMENT_SCHEMA,
      RESULT_SCHEMA,
    );
    setDurableArtifactEntryRef(base, REFS.pattern);
    warmArtifacts.set(
      refKey(REFS.pattern.identity, REFS.pattern.symbol),
      base,
    );
    const selected = base.inSpace(anchor);

    const resultCell = runtime.getCell<{ result: number }>(
      space,
      "dynamic-factory-cell-selector-result",
      RESULT_SCHEMA,
      tx,
    );
    const result = runtime.run(
      tx,
      outerPattern(PATTERN_CONTRACT),
      { factory: selected, value: 16 },
      resultCell,
    );
    await commitAndRenew();

    expect(await within(result.pull(), "cell selector result")).toEqual({
      result: 16,
    });
    expect(result.resolveAsCell().getAsNormalizedFullLink().space).toBe(
      dynamicExecutionSpace,
    );
  });

  it("uses a linked selection cell's space as trusted cold artifact provenance", async () => {
    const { selectedPattern } = makeSelections();
    const selectedShell = createFactoryShell(
      sealFactoryState(selectedPattern.inSpace(dynamicExecutionSpace)),
    );
    const loads: Array<{
      identity: string;
      symbol: string;
      sourceSpace: MemorySpace;
    }> = [];
    let observeLoad!: () => void;
    const loadObserved = new Promise<void>((resolve) => observeLoad = resolve);
    runtime.patternManager.loadArtifactByIdentity = (
      identity,
      symbol,
      sourceSpace,
    ) => {
      loads.push({ identity, symbol, sourceSpace });
      observeLoad();
      warmArtifacts.set(refKey(identity, symbol), selectedPattern);
      return Promise.resolve(selectedPattern);
    };

    const selector = runtime.getCell<unknown>(
      linkedArtifactSpace,
      "dynamic-factory-linked-selector",
      undefined,
      tx,
    );
    selector.set(selectedShell);
    await commitAndRenew();

    const resultCell = runtime.getCell<{ result: number }>(
      space,
      "dynamic-factory-cold-result",
      RESULT_SCHEMA,
      tx,
    );
    const result = runtime.run(
      tx,
      outerPattern(PATTERN_CONTRACT),
      { factory: selector, value: 11 },
      resultCell,
    );
    await commitAndRenew();

    await within(loadObserved, "cold artifact load to start");
    expect(loads).toEqual([{
      ...REFS.pattern,
      sourceSpace: linkedArtifactSpace,
    }]);
    expect(await within(result.pull(), "cold pattern result")).toEqual({
      result: 11,
    });
    expect(result.resolveAsCell().getAsNormalizedFullLink().space).toBe(
      dynamicExecutionSpace,
    );
  });
});
