import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  createFactoryShell,
  registerFabricFactory,
} from "@commonfabric/data-model/fabric-factory";
import { FabricBytes } from "@commonfabric/data-model/fabric-primitives";

import { createRef } from "../src/create-ref.ts";

const REF = {
  identity: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  symbol: "factory",
} as const;

const shell = (marker: string, spaceSelector: unknown = "destination") =>
  createFactoryShell({
    kind: "pattern",
    ref: REF,
    argumentSchema: true,
    resultSchema: true,
    paramsSchema: true,
    params: { marker },
    spaceSelector,
  });

describe("factory-aware createRef identity", () => {
  const id = (value: Record<string, unknown>) =>
    createRef(value, "cause").taggedHashString;

  it("hashes canonical factory state instead of callable source or protocol fields", () => {
    const first = shell("same");
    const independent = shell("same");
    const differentParams = shell("different");
    const differentSpace = shell("same", "other-space");

    expect(id({ factory: first })).toBe(
      id({ factory: independent }),
    );
    expect(id({ factory: first })).not.toBe(
      id({ factory: differentParams }),
    );
    expect(id({ factory: first })).not.toBe(
      id({ factory: differentSpace }),
    );
  });

  it("preserves repeated factory and Fabric-special sibling semantics", () => {
    const first = shell("same");
    const independent = shell("same");
    const bytes = new FabricBytes(new Uint8Array([1, 2, 3]));
    const independentBytes = new FabricBytes(new Uint8Array([1, 2, 3]));

    expect(id({ first, second: first })).toBe(
      id({ first, second: independent }),
    );
    expect(id({ first: bytes, second: bytes })).toBe(
      id({ first: bytes, second: independentBytes }),
    );
  });

  it("hashes a ref-less nested module through its legacy descriptor only", () => {
    const implementation = (value: unknown) => value;
    const module = registerFabricFactory(
      Object.assign(
        (_input: unknown) => undefined,
        {
          type: "javascript",
          implementation,
          toJSON: () => ({
            type: "javascript",
            implementation: implementation.toString(),
          }),
          asScope: () => undefined,
        },
      ),
      "module",
      {
        kind: "module",
        rootToken: {},
        argumentSchema: true,
        resultSchema: true,
      },
    );
    const keylessPattern = registerFabricFactory(
      Object.assign(
        (_input: unknown) => undefined,
        {
          argumentSchema: true,
          resultSchema: true,
          result: {},
          nodes: [{ module, inputs: {}, outputs: {} }],
          toJSON: () => ({}),
        },
      ),
      "pattern",
      {
        kind: "pattern",
        rootToken: {},
        argumentSchema: true,
        resultSchema: true,
      },
    );

    expect(() => id({ pattern: keylessPattern })).not.toThrow();
  });

  it("rejects arbitrary functions and a real cycle through hidden params", () => {
    expect(() => createRef({ invalid: () => undefined }, "cause")).toThrow(
      "Arbitrary functions are not valid createRef values",
    );

    const withFunction = registerFabricFactory(
      () => undefined,
      "pattern",
      {
        kind: "pattern",
        rootToken: {},
        ref: REF,
        argumentSchema: true,
        resultSchema: true,
        paramsSchema: true,
        params: { invalid: () => undefined },
      },
    );
    expect(() => createRef({ factory: withFunction }, "cause")).toThrow(
      "Arbitrary functions are not valid factory state values",
    );

    const cyclicParams: { self?: unknown } = {};
    const cyclic = registerFabricFactory(
      () => undefined,
      "pattern",
      {
        kind: "pattern",
        rootToken: {},
        ref: REF,
        argumentSchema: true,
        resultSchema: true,
        paramsSchema: true,
        params: cyclicParams,
      },
    );
    cyclicParams.self = cyclic;
    expect(() => createRef({ factory: cyclic }, "cause")).toThrow(
      "Circular reference detected in factory state",
    );

    const cyclicObject: { self?: unknown } = {};
    cyclicObject.self = cyclicObject;
    const withCyclicObject = registerFabricFactory(
      () => undefined,
      "pattern",
      {
        kind: "pattern",
        rootToken: {},
        ref: REF,
        argumentSchema: true,
        resultSchema: true,
        paramsSchema: true,
        params: cyclicObject,
      },
    );
    expect(() => createRef({ factory: withCyclicObject }, "cause")).toThrow(
      "Circular reference detected in factory state",
    );
  });
});
