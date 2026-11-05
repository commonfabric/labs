import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { FactoryCodec } from "@/codec-common/FactoryCodec.ts";
import { NULL_LIVE_ENVIRONMENT } from "@/codec-interface/NullLiveEnvironment.ts";
import {
  factoryStateOf,
  type FactoryStateV1,
  registerFabricFactory,
  sealFactoryState,
} from "@/fabric-factory.ts";
import { FabricLink } from "@/fabric-instances/FabricLink.ts";
import type { FabricFactory, FabricPlainObject } from "@/interface.ts";
import { UnknownValue } from "@/codec-common/UnknownValue.ts";
import { isDeepFrozen } from "@/deep-freeze.ts";

const REF = {
  identity: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  symbol: "__cfPattern_1",
} as const;

describe("FactoryCodec", () => {
  it("round-trips an admitted factory as a frozen inert callable", () => {
    const state: FactoryStateV1 = {
      kind: "pattern",
      ref: REF,
      argumentSchema: { type: "object" },
      resultSchema: { type: "object" },
    };
    const live = registerFabricFactory(
      (input: unknown) => input,
      "pattern",
      state,
    );
    const codec = new FactoryCodec();

    expect(codec.encode(live)).toEqual(state);

    const decoded = codec.decode(
      "Factory@1",
      state,
      NULL_LIVE_ENVIRONMENT,
    ) as FabricFactory<[]>;
    expect(typeof decoded).toBe("function");
    expect(Object.isFrozen(decoded)).toBe(true);
    expect(factoryStateOf(decoded)).toEqual(state);
    expect(codec.encode(decoded)).toEqual(state);
    expect(() => decoded()).toThrow(
      "factory requires runner materialization",
    );
  });

  it("uses one callable-only tag and rejects arbitrary or copy-branded functions", () => {
    const codec = new FactoryCodec();
    expect(codec.recognizedTypeTag).toBe("Factory@1");
    expect(codec.uniqueHandledClass).toBeUndefined();
    expect(codec.canEncode((() => undefined) as never)).toBe(false);

    const admitted = registerFabricFactory(() => undefined, "module", {
      kind: "module",
      ref: REF,
    });
    const copied = () => undefined;
    for (const key of Reflect.ownKeys(admitted)) {
      if (typeof key !== "symbol") continue;
      Object.defineProperty(
        copied,
        key,
        Object.getOwnPropertyDescriptor(admitted, key)!,
      );
    }
    expect(codec.canEncode(copied as never)).toBe(false);
  });

  it("validates and round-trips every factory kind", () => {
    const states: FactoryStateV1[] = [
      {
        kind: "pattern",
        ref: REF,
        argumentSchema: true,
        resultSchema: false,
        paramsSchema: { type: "object" },
        params: { prefix: "hello" },
        defaultScope: "space",
        spaceSelector: "did:key:example",
        spaceRequest: {
          grants: { "*": "WRITE" },
          root: true,
          spaceKind: "profile",
          selfOwned: true,
        },
      },
      {
        kind: "module",
        ref: REF,
        argumentSchema: true,
        resultSchema: false,
        defaultScope: "user",
      },
      {
        kind: "handler",
        ref: REF,
        contextSchema: true,
        eventSchema: false,
      },
    ];
    const codec = new FactoryCodec();

    for (const state of states) {
      const decoded = codec.decode(
        "Factory@1",
        state,
        NULL_LIVE_ENVIRONMENT,
      ) as FabricFactory<[]>;
      expect(Object.isFrozen(decoded)).toBe(true);
      expect(Object.isFrozen(factoryStateOf(decoded))).toBe(true);
      expect(codec.encode(decoded)).toEqual(state);
      expect(() => decoded()).toThrow(
        "factory requires runner materialization",
      );
    }
  });

  it("memoizes validated canonical state and ignores later accessor drift", () => {
    let state: FactoryStateV1 = { kind: "module", ref: REF };
    const factory = registerFabricFactory(
      () => undefined,
      "module",
      () => state,
    );
    const sealed = sealFactoryState(factory);
    state = { kind: "handler", ref: REF };

    expect(sealFactoryState(factory)).toBe(sealed);
    expect(factoryStateOf(factory)).toBe(sealed);
  });

  it("rejects a live builder state whose kind disagrees with its admission", () => {
    const factory = registerFabricFactory(
      () => undefined,
      "module",
      { kind: "handler", ref: REF } as unknown as Extract<
        FactoryStateV1,
        { kind: "module" }
      >,
    );

    expect(() => factoryStateOf(factory)).toThrow(
      'trusted builder kind "module" does not match state kind "handler"',
    );
    expect(() => sealFactoryState(factory)).toThrow(
      'trusted builder kind "module" does not match state kind "handler"',
    );
  });

  it("hardens and preserves a mutable unknown instance nested in params", () => {
    const unknown = new UnknownValue("FutureParam@2", {
      nested: [1, 2, 3],
    });
    const factory = registerFabricFactory(() => undefined, "pattern", {
      kind: "pattern",
      rootToken: {},
      ref: REF,
      argumentSchema: true,
      resultSchema: true,
      paramsSchema: true,
      params: { unknown },
    });

    const state = new FactoryCodec().encode(factory) as FactoryStateV1;
    const preserved = state.kind === "pattern" ? state.params?.unknown : null;
    expect(preserved).toBe(unknown);
    expect(isDeepFrozen(unknown)).toBe(true);
  });

  it("rejects accessor-backed params without invoking the accessor", () => {
    let reads = 0;
    const params = Object.defineProperty({}, "secret", {
      enumerable: true,
      get() {
        reads++;
        return "read";
      },
    });
    const factory = registerFabricFactory(() => undefined, "pattern", {
      kind: "pattern",
      rootToken: {},
      ref: REF,
      argumentSchema: true,
      resultSchema: true,
      paramsSchema: true,
      params,
    });

    expect(() => sealFactoryState(factory)).toThrow(
      "properties must be enumerable data fields",
    );
    expect(reads).toBe(0);
  });

  it("seals live state once its artifact ref exists and rejects it before then", () => {
    const factory = registerFabricFactory(() => undefined, "module", {
      kind: "module",
      rootToken: {},
      ref: REF,
    });
    const codec = new FactoryCodec();
    expect(codec.encode(factory)).toEqual({ kind: "module", ref: REF });
    expect(Object.hasOwn(factoryStateOf(factory), "rootToken")).toBe(false);

    const preRef = registerFabricFactory(() => undefined, "module", {
      kind: "module",
      rootToken: {},
    });
    expect(() => codec.encode(preRef)).toThrow(
      "artifact ref is not available",
    );
  });

  for (
    const [name, state, message] of [
      [
        "unknown kind",
        { kind: "other", ref: REF },
        "expected pattern, module, or handler",
      ],
      [
        "extra field",
        { kind: "module", ref: REF, params: {} },
        "unexpected field",
      ],
      [
        "pseudo ref",
        { kind: "module", ref: { identity: "host:1", symbol: "lift" } },
        "43-character base64url",
      ],
      [
        "noncanonical identity alias",
        {
          kind: "module",
          ref: {
            identity: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB",
            symbol: "lift",
          },
        },
        "canonical 32-byte base64url",
      ],
      [
        "empty symbol",
        { kind: "module", ref: { identity: REF.identity, symbol: "" } },
        "non-empty string",
      ],
      [
        "missing pattern schema",
        { kind: "pattern", ref: REF, resultSchema: true },
        'missing required field "argumentSchema"',
      ],
      [
        "invalid scope",
        { kind: "module", ref: REF, defaultScope: "global" },
        "expected space, user, or session",
      ],
      [
        "params without schema",
        {
          kind: "pattern",
          ref: REF,
          argumentSchema: true,
          resultSchema: true,
          params: {},
        },
        "params requires a pattern paramsSchema",
      ],
      [
        "invalid inSpace request",
        {
          kind: "pattern",
          ref: REF,
          argumentSchema: true,
          resultSchema: true,
          spaceRequest: { root: false },
        },
        "expected true",
      ],
      [
        "explicit undefined",
        { kind: "module", ref: REF, argumentSchema: undefined },
        "optional fields must be omitted",
      ],
    ] as const
  ) {
    it(`rejects ${name}`, () => {
      expect(() =>
        new FactoryCodec().decode(
          "Factory@1",
          state as never,
          NULL_LIVE_ENVIRONMENT,
        )
      ).toThrow(message);
    });
  }

  it("rejects cyclic state while allowing shared acyclic values", () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(() =>
      new FactoryCodec().decode(
        "Factory@1",
        {
          kind: "pattern",
          ref: REF,
          argumentSchema: true,
          resultSchema: true,
          paramsSchema: true,
          params: cycle,
        } as never,
        NULL_LIVE_ENVIRONMENT,
      )
    ).toThrow("cyclic state is not allowed");

    const shared = { value: 1 };
    const decoded = new FactoryCodec().decode(
      "Factory@1",
      {
        kind: "pattern",
        ref: REF,
        argumentSchema: true,
        resultSchema: true,
        paramsSchema: true,
        params: { left: shared, right: shared },
      },
      NULL_LIVE_ENVIRONMENT,
    );
    expect(typeof decoded).toBe("function");
  });

  it("preserves __proto__ as data without prototype mutation", () => {
    const params = JSON.parse(
      '{"__proto__":{"polluted":true}}',
    ) as Record<string, unknown>;
    const decoded = new FactoryCodec().decode(
      "Factory@1",
      {
        kind: "pattern",
        ref: REF,
        argumentSchema: true,
        resultSchema: true,
        paramsSchema: true,
        params: params as unknown as FabricPlainObject,
      },
      NULL_LIVE_ENVIRONMENT,
    ) as FabricFactory<[]>;
    const state = factoryStateOf(decoded) as Extract<
      FactoryStateV1,
      { kind: "pattern" }
    >;

    expect(Object.hasOwn(state.params!, "__proto__")).toBe(true);
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it("recursively hardens shallow-frozen Fabric instances in canonical state", () => {
    const link = new FabricLink({ nested: { mutable: true } });
    Object.freeze(link);

    const decoded = new FactoryCodec().decode(
      "Factory@1",
      {
        kind: "pattern",
        ref: REF,
        argumentSchema: true,
        resultSchema: true,
        paramsSchema: true,
        params: { link },
      },
      NULL_LIVE_ENVIRONMENT,
    ) as FabricFactory<[]>;
    const state = factoryStateOf(decoded) as Extract<
      FactoryStateV1,
      { kind: "pattern" }
    >;
    const preserved = state.params?.link;
    expect(preserved).toBe(link);
    expect(isDeepFrozen(link)).toBe(true);
  });
});
