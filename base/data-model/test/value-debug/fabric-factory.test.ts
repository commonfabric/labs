import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type {
  FabricFactory as ApiFabricFactory,
  ModuleFactory,
} from "@commonfabric/api";

import {
  factoryStateOf,
  type FactoryStateV1,
  type LiveFactoryState,
  mapFactoryStateValues,
  registerFabricFactory,
  tryFactoryState,
} from "@/fabric-factory.ts";
import type { FabricFactory, FabricValue } from "@/interface.ts";

// Compile-time contract: the dependency-free API mirror and data-model arm are
// mutually assignable, while specializing a public factory retains its exact
// one-argument call signature.
// deno-lint-ignore no-constant-condition
if (false) {
  const apiFactory = null as unknown as ApiFabricFactory<[string], number>;
  const dataModelFactory: FabricFactory<[string], number> = apiFactory;
  const roundTrippedApiFactory: ApiFabricFactory<[string], number> =
    dataModelFactory;
  void roundTrippedApiFactory;

  const moduleFactory = null as unknown as ModuleFactory<
    { value: string },
    string
  >;
  moduleFactory({ value: "valid" });
  // @ts-expect-error A factory cannot be called without its public input.
  moduleFactory();
  // @ts-expect-error A factory cannot accept the wrong public input shape.
  moduleFactory({ wrong: 1 });
  // @ts-expect-error A factory takes exactly one public input argument.
  moduleFactory({ value: "valid" }, "extra");
}

describe("FabricFactory protocol", () => {
  it("maps only hidden pattern values while preserving live and canonical metadata", () => {
    const rootToken = {};
    const params = { capture: "before" };
    const spaceSelector = { target: "before" };
    const liveState: LiveFactoryState = {
      kind: "pattern",
      rootToken,
      argumentSchema: { type: "object" },
      resultSchema: { type: "object" },
      paramsSchema: { type: "object" },
      params,
      defaultScope: "user",
      spaceSelector,
      spaceRequest: { root: true },
    };
    const replacements = new Map<unknown, unknown>([
      [params, { capture: "after" }],
      [spaceSelector, { target: "after" }],
    ]);
    const visited: string[] = [];

    const mappedLive = mapFactoryStateValues(
      liveState,
      (value, field) => {
        visited.push(field);
        return replacements.get(value) ?? value;
      },
    );

    expect(visited).toEqual(["params", "spaceSelector"]);
    expect(mappedLive).not.toBe(liveState);
    expect(mappedLive).toMatchObject({
      kind: "pattern",
      rootToken,
      argumentSchema: liveState.argumentSchema,
      resultSchema: liveState.resultSchema,
      paramsSchema: liveState.paramsSchema,
      params: { capture: "after" },
      defaultScope: "user",
      spaceSelector: { target: "after" },
      spaceRequest: { root: true },
    });
    expect(liveState.params).toBe(params);
    expect(liveState.spaceSelector).toBe(spaceSelector);

    const ref = {
      identity: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      symbol: "factory",
    };
    const canonical: FactoryStateV1 = {
      kind: "pattern",
      ref,
      argumentSchema: true,
      resultSchema: false,
      paramsSchema: true,
      params: { nested: "before" },
      spaceSelector: "before",
    };
    const mappedCanonical = mapFactoryStateValues(
      canonical,
      (value) => value === "before" ? "after" : value,
    );
    expect(mappedCanonical).toMatchObject({
      ...canonical,
      ref,
      params: { nested: "before" },
      spaceSelector: "after",
    });
    expect(mappedCanonical.ref).toBe(ref);

    const moduleState: FactoryStateV1 = {
      kind: "module",
      ref,
      argumentSchema: true,
      resultSchema: false,
    };
    expect(
      mapFactoryStateValues(moduleState, () => {
        throw new Error("module state has no traversable hidden values");
      }),
    ).toBe(moduleState);
  });

  it("admits only registered callables and keeps protocol properties hidden", () => {
    const rootToken = {};
    const state: LiveFactoryState = {
      kind: "pattern",
      rootToken,
      argumentSchema: true,
      resultSchema: false,
    };
    const original = (input: unknown) => input;
    const factory = registerFabricFactory(original, "pattern", () => state);

    const acceptsFabricValue = (_value: FabricValue) => undefined;
    acceptsFabricValue(factory);

    const acceptsFabricFactory = (_value: FabricFactory) => undefined;
    acceptsFabricFactory(factory);

    expect(tryFactoryState(factory)).toBe(state);
    expect(factoryStateOf(factory)).toBe(state);
    const observedState = factoryStateOf(factory);
    expect("rootToken" in observedState).toBe(true);
    if ("rootToken" in observedState) {
      expect(observedState.rootToken).toBe(rootToken);
    }
    expect(Object.keys(factory)).toEqual([]);
    const functionPrototypeKeys = Reflect.ownKeys(Function.prototype).map(
      String,
    );
    expect(functionPrototypeKeys).not.toContain(
      "Symbol(common.fabricFactory)",
    );
    expect(functionPrototypeKeys).not.toContain("Symbol(common.factoryState)");

    const plainFunction = () => undefined;
    expect(tryFactoryState(plainFunction)).toBeUndefined();
    expect(() => factoryStateOf(plainFunction)).toThrow(
      "Value is not an admitted FabricFactory",
    );

    // The hidden properties are descriptive, not the admission authority.
    for (const key of Reflect.ownKeys(factory)) {
      if (typeof key !== "symbol") continue;
      const descriptor = Object.getOwnPropertyDescriptor(factory, key);
      Object.defineProperty(plainFunction, key, descriptor!);
    }
    expect(tryFactoryState(plainFunction)).toBeUndefined();
  });

  it("supports live pending refs and canonical state for every factory kind", () => {
    const rootToken = {};
    // deno-lint-ignore prefer-const -- reassigned after the accessor's first read
    let ref: { identity: string; symbol: string } | undefined;
    const liveFactory = registerFabricFactory(
      () => undefined,
      "module",
      (): LiveFactoryState => ({
        kind: "module",
        rootToken,
        ...(ref === undefined ? {} : { ref }),
        argumentSchema: true,
        resultSchema: false,
        defaultScope: "session",
      }),
    );

    expect(factoryStateOf(liveFactory).ref).toBeUndefined();
    ref = { identity: "artifact", symbol: "lift" };
    expect(factoryStateOf(liveFactory).ref).toEqual(ref);
    const observedState = factoryStateOf(liveFactory);
    expect("rootToken" in observedState).toBe(true);
    if ("rootToken" in observedState) {
      expect(observedState.rootToken).toBe(rootToken);
    }

    const states: FactoryStateV1[] = [
      {
        kind: "pattern",
        ref,
        argumentSchema: true,
        resultSchema: false,
        paramsSchema: true,
        params: { prefix: "hello" },
        defaultScope: "space",
        spaceSelector: "did:key:example",
        spaceRequest: { root: true },
      },
      {
        kind: "module",
        ref,
        argumentSchema: true,
        resultSchema: false,
        defaultScope: "user",
      },
      {
        kind: "handler",
        ref,
        contextSchema: true,
        eventSchema: false,
      },
    ];

    for (const state of states) {
      const shell = registerFabricFactory(
        () => {
          throw new Error("factory requires runner materialization");
        },
        state.kind,
        state,
      );
      expect(factoryStateOf(shell)).toBe(state);
      expect(() => shell()).toThrow(
        "factory requires runner materialization",
      );
    }
  });
});
