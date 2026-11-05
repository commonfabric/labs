import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import {
  createFactoryShell,
  factoryStateOf,
  isAdmittedFabricFactory,
  type LivePatternFactoryState,
} from "@commonfabric/data-model/fabric-factory";

import type { Frame, PatternFactory } from "../src/builder/types.ts";
import {
  deriveFactoryStateCopy,
  isTrustedBuilderArtifact,
  resolveOriginal,
} from "../src/builder/pattern-metadata.ts";
import { pattern, popFrame, pushFrame } from "../src/builder/pattern.ts";
import { reactive as createReactive } from "../src/builder/reactive.ts";
import { withAliasBindings } from "../src/builder/to-encodable-form.ts";
import { traverseValue } from "../src/builder/traverse-utils.ts";
import { getCellOrThrow } from "../src/query-result-proxy.ts";
import { Runtime } from "../src/runtime.ts";
import type { AliasBinding } from "../src/alias-binding.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("factory-state-traversal");
const space = signer.did();

describe("hidden factory-state traversal", () => {
  let runtime: Runtime;
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let tx: IExtendedStorageTransaction;
  let frame: Frame;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    tx = runtime.edit();
    frame = pushFrame({
      runtime,
      tx,
      space,
      cause: { test: "factory-state-traversal" },
    });
  });

  afterEach(async () => {
    popFrame(frame);
    await tx.commit().settled;
    await runtime.dispose();
    await storageManager.close();
  });

  const bindPattern = (
    params: unknown,
    spaceSelector?: unknown,
  ): PatternFactory<Record<string, never>, { value: number }> => {
    const base = pattern<Record<string, never>, { value: number }>(
      () => ({ value: 1 }),
      { type: "object" },
      { type: "object" },
    );
    const state = factoryStateOf(base);
    if (
      state.kind !== "pattern" || !("rootToken" in state) ||
      state.rootToken === null || typeof state.rootToken !== "object"
    ) {
      throw new Error("expected a live pattern factory");
    }
    const boundState: LivePatternFactoryState = {
      ...state,
      rootToken: state.rootToken,
      paramsSchema: { type: "object" },
      params,
      ...(spaceSelector === undefined ? {} : { spaceSelector }),
    };
    return deriveFactoryStateCopy(base, boundState) as typeof base;
  };

  const stateOfPattern = (value: unknown): LivePatternFactoryState => {
    const state = factoryStateOf(value);
    if (
      state.kind !== "pattern" || !("rootToken" in state) ||
      state.rootToken === null || typeof state.rootToken !== "object"
    ) {
      throw new Error("expected live pattern state");
    }
    return {
      ...state,
      rootToken: state.rootToken,
    };
  };

  it("maps nested Cells and Reactives without exposing hidden state", () => {
    const cell = runtime.getCell<string>(
      space,
      "factory-capture",
      undefined,
      tx,
    );
    const reactive = cell.getAsReactiveProxy();
    const factory = bindPattern(
      { nested: { cell, reactive } },
      reactive,
    );
    const originalState = stateOfPattern(factory);
    const aliases = {
      cell: { $alias: { cell: "argument", path: ["cell"] } },
      reactive: { $alias: { cell: "argument", path: ["reactive"] } },
    };

    const mapped = traverseValue(factory, (value) => {
      if (value === cell) return aliases.cell;
      if (value === reactive) return aliases.reactive;
      return undefined;
    }) as typeof factory;
    const mappedState = stateOfPattern(mapped);

    expect(mapped).not.toBe(factory);
    expect(mappedState.rootToken).toBe(originalState.rootToken);
    expect(mappedState.ref).toBeUndefined();
    expect(mappedState.argumentSchema).toBe(originalState.argumentSchema);
    expect(mappedState.resultSchema).toBe(originalState.resultSchema);
    expect(mappedState.params).toEqual({
      nested: { cell: aliases.cell, reactive: aliases.reactive },
    });
    expect(mappedState.spaceSelector).toEqual(aliases.reactive);
    expect(Object.keys(mapped)).not.toContain("params");
    expect(Object.keys(mapped)).not.toContain("spaceSelector");
    expect(isAdmittedFabricFactory(mapped)).toBe(true);
    expect(isTrustedBuilderArtifact(mapped)).toBe(true);
    expect(resolveOriginal(mapped)).toBe(resolveOriginal(factory));
    expect(typeof mapped.asScope).toBe("function");
    expect(typeof mapped.inSpace).toBe("function");
    expect(() => mapped({})).not.toThrow();
  });

  it("maps nested factories once and reuses the mapped callable", () => {
    const cell = runtime.getCell<string>(
      space,
      "nested-factory-capture",
      undefined,
      tx,
    );
    const inner = bindPattern({ cell });
    const outer = bindPattern({ inner });

    const mappedContainer = traverseValue(
      { first: outer, second: outer },
      (value) => value === cell ? { alias: "cell" } : undefined,
    ) as { first: typeof outer; second: typeof outer };

    expect(mappedContainer.first).toBe(mappedContainer.second);
    const outerState = stateOfPattern(mappedContainer.first);
    const mappedInner = (outerState.params as { inner: typeof inner }).inner;
    expect(mappedInner).not.toBe(inner);
    expect(stateOfPattern(mappedInner).params).toEqual({
      cell: { alias: "cell" },
    });
  });

  it("rejects a true cycle through params and an arbitrary captured function", () => {
    const cyclicParams: { self?: unknown } = {};
    const cyclic = bindPattern(cyclicParams);
    cyclicParams.self = cyclic;

    expect(() => traverseValue(cyclic, () => undefined)).toThrow(
      "Circular reference detected in factory state",
    );

    const withFunction = bindPattern({ invalid: () => undefined });
    expect(() => traverseValue(withFunction, () => undefined)).toThrow(
      "Arbitrary functions are not valid factory state values",
    );
  });

  it("serializes hidden aliases through the same state view", () => {
    const reactive = createReactive<string>();
    const cell = getCellOrThrow(reactive);
    const factory = bindPattern({ nested: { cell, reactive } }, reactive);
    const alias: AliasBinding = {
      $alias: { cell: "argument", path: ["capture"] },
    };

    const serialized = withAliasBindings(
      { factory },
      () => alias,
    ) as unknown as { factory: typeof factory };
    const serializedState = stateOfPattern(serialized.factory);

    expect(serializedState.params).toEqual({
      nested: { cell: alias, reactive: alias },
    });
    expect(serializedState.spaceSelector).toEqual(alias);
    expect(isAdmittedFabricFactory(serialized.factory)).toBe(true);
    expect(resolveOriginal(serialized.factory)).toBe(resolveOriginal(factory));
    expect(Object.keys(serialized.factory)).not.toContain("params");
  });

  it("rebuilds canonical decoded state as an inert shell", () => {
    const shell = createFactoryShell({
      kind: "pattern",
      ref: {
        identity: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        symbol: "factory",
      },
      argumentSchema: true,
      resultSchema: true,
      paramsSchema: true,
      params: { marker: "before" },
      spaceSelector: "before",
    });

    const mapped = traverseValue(
      shell,
      (value) => value === "before" ? "after" : undefined,
    );
    const state = factoryStateOf(mapped);

    expect(mapped).not.toBe(shell);
    expect(state).toMatchObject({
      kind: "pattern",
      params: { marker: "after" },
      spaceSelector: "after",
    });
    expect(isTrustedBuilderArtifact(mapped)).toBe(false);
    expect(() => mapped()).toThrow("factory requires runner materialization");
  });

  it("fails closed for a closure-bearing base before params are bound", () => {
    const base = pattern(() => ({ value: 1 }), true, true);
    const state = stateOfPattern(base);
    const closureBearing = deriveFactoryStateCopy(base, {
      ...state,
      paramsSchema: { type: "object" },
    });

    expect(() => closureBearing({})).toThrow(
      "Bound pattern params require callback binding",
    );
  });
});
