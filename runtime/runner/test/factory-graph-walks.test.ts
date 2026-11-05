import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import {
  createFactoryShell,
  factoryStateOf,
  isAdmittedFabricFactory,
  type LivePatternFactoryState,
} from "@commonfabric/data-model/fabric-factory";
import {
  FabricMap,
  FabricSet,
} from "@commonfabric/data-model/fabric-instances";
import {
  ProblematicValue,
  UnknownValue,
} from "@commonfabric/data-model/codec-common";
import { FabricBytes } from "@commonfabric/data-model/fabric-primitives";

import {
  convertCellsToLinks,
  exportCell,
  prepareFactoryStatesForWrite,
} from "../src/cell.ts";
import { applyInputIfcToOutput } from "../src/builder/node-utils.ts";
import { withAliasBindings } from "../src/builder/to-encodable-form.ts";
import { traverseValue } from "../src/builder/traverse-utils.ts";
import {
  deriveFactoryStateCopy,
  getArtifactEntryRef,
  setDurableArtifactEntryRef,
} from "../src/builder/pattern-metadata.ts";
import { pattern, popFrame, pushFrame } from "../src/builder/pattern.ts";
import { reactive } from "../src/builder/reactive.ts";
import type { Frame, PatternFactory } from "../src/builder/types.ts";
import {
  ExecutableRegistry,
  verifiedWalkChildValues,
} from "../src/harness/executable-registry.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import type { NormalizedLink } from "../src/link-types.ts";
import {
  normalizeSandboxResult,
  validateAndCheckReactives,
} from "../src/sandbox/result-normalization.ts";
import { getCellOrThrow } from "../src/query-result-proxy.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";

const signer = await Identity.fromPassphrase("factory-graph-walks");
const space = signer.did();
const REF = {
  identity: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  symbol: "factory",
} as const;

describe("factory-aware graph and static walks", () => {
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
      cause: { test: "factory graph walks" },
      generatedIdCounter: 0,
      reactives: new Set(),
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

  it("visits hidden state when validating action results", () => {
    const source = runtime.getCell<string>(
      space,
      "action-result-hidden-reactive",
      undefined,
      tx,
    );
    const sourceReactive = source.getAsReactiveProxy();
    const factory = bindPattern({ source: sourceReactive });
    const shell = createFactoryShell({
      kind: "pattern",
      ref: REF,
      argumentSchema: true,
      resultSchema: true,
      paramsSchema: true,
      params: { bytes: new FabricBytes(new Uint8Array([1, 2, 3])) },
    });

    expect(validateAndCheckReactives(factory)).toBe(true);
    expect(validateAndCheckReactives(shell)).toBe(false);
    const normalized = normalizeSandboxResult({ factory });
    const normalizedFactory = (normalized.value as { factory: unknown })
      .factory;
    expect(normalized.hasReactive).toBe(true);
    expect(isAdmittedFabricFactory(normalizedFactory)).toBe(true);
    expect(
      ((factoryStateOf(normalizedFactory) as LivePatternFactoryState)
        .params as { source: unknown }).source,
    ).toBe(sourceReactive);
    expect(() => validateAndCheckReactives(() => undefined)).toThrow(
      "Action returned a function",
    );
  });

  it("maps hidden cells to links while preserving callable and special values", () => {
    const source = runtime.getCell<string>(
      space,
      "factory-hidden-cell-link",
      undefined,
      tx,
    );
    const bytes = new FabricBytes(new Uint8Array([4, 5, 6]));
    const factory = bindPattern({ source, bytes }, source);

    const mapped = convertCellsToLinks({ first: factory, second: factory }) as {
      first: typeof factory;
      second: typeof factory;
    };
    const state = factoryStateOf(mapped.first) as LivePatternFactoryState;
    const params = state.params as { source: unknown; bytes: unknown };

    expect(mapped.first).toBe(mapped.second);
    expect(mapped.first).not.toBe(factory);
    expect(params.source).toEqual(source.getAsLink());
    expect(params.bytes).toBe(bytes);
    expect(state.spaceSelector).toEqual(source.getAsLink());
  });

  it("prepares live factory state nested in codec-backed values", () => {
    const source = runtime.getCell<string>(
      space,
      "codec-backed-factory-hidden-cell",
      undefined,
      tx,
    );
    const factory = bindPattern({ source });
    setDurableArtifactEntryRef(factory, REF);
    const values = [
      new UnknownValue("FutureValue@1", { factory }),
      new ProblematicValue("BrokenValue@1", { factory }, "broken"),
    ];

    for (const value of values) {
      const prepared = prepareFactoryStatesForWrite(value) as
        | UnknownValue
        | ProblematicValue;
      expect(prepared).not.toBe(value);
      expect(prepared.constructor).toBe(value.constructor);
      if (prepared instanceof ProblematicValue) {
        expect(prepared.error).toBe("broken");
      }
      const nested = prepared.state as { factory: unknown };
      const state = factoryStateOf(
        nested.factory,
      ) as LivePatternFactoryState;
      expect(state.params).toEqual({ source: source.getAsLink() });
    }
  });

  it("keeps unimplemented codec instances atomic during write preparation", () => {
    const values = [
      new FabricMap(new Map([["key", "value"]])),
      new FabricSet(new Set(["value"])),
    ];

    for (const value of values) {
      expect(prepareFactoryStatesForWrite(value)).toBe(value);
    }
  });

  it("records scoped internal cells for durable factory capture binding", () => {
    const { pattern, Writable } = createTrustedBuilder(runtime).commonfabric;
    const containingPattern = pattern(() => {
      const selected = Writable.perSession.of("");
      return { selected };
    });

    expect(containingPattern.derivedInternalCells).toEqual([
      expect.objectContaining({ scope: "session" }),
    ]);
  });

  it("keeps an explicit space scope when the containing factory is user-scoped", () => {
    const { pattern, Writable } = createTrustedBuilder(runtime).commonfabric;
    const containingPattern = pattern(() => {
      const shared = Writable.perSpace.of("");
      return { shared };
    });
    const userScoped = containingPattern.asScope("user");

    expect(userScoped.derivedInternalCells).toEqual([
      expect.objectContaining({ scope: "space" }),
    ]);
  });

  it("omits an implicit space scope so the internal cell inherits its piece", () => {
    const { pattern, Writable } = createTrustedBuilder(runtime).commonfabric;
    const containingPattern = pattern(() => {
      const inherited = Writable.of("");
      return { inherited };
    });

    expect(containingPattern.derivedInternalCells).toEqual([
      expect.not.objectContaining({ scope: expect.anything() }),
    ]);
  });

  it("keeps special values atomic in graph and serialization walks", () => {
    const bytes = new FabricBytes(new Uint8Array([10, 11, 12]));
    const factory = bindPattern({ bytes });

    const traversed = traverseValue(factory, () => undefined);
    const serialized = withAliasBindings({ factory }) as unknown as {
      factory: typeof factory;
    };

    expect(
      ((factoryStateOf(traversed) as LivePatternFactoryState).params as {
        bytes: unknown;
      }).bytes,
    ).toBe(bytes);
    expect(
      ((factoryStateOf(serialized.factory) as LivePatternFactoryState)
        .params as { bytes: unknown }).bytes,
    ).toBe(bytes);
  });

  it("rejects Cells hidden inside a factory passed to Cell.of", () => {
    const source = runtime.getCell<string>(
      space,
      "factory-hidden-static-cell",
      undefined,
      tx,
    );
    const factory = bindPattern({ nested: { source } });
    const Cell = createTrustedBuilder(runtime).commonfabric.Cell;

    expect(() => Cell.of(factory)).toThrow(
      /Cell\.of\(\) only accepts static data.*path 'params\.nested\.source'/,
    );
    expect(() => Cell.of(() => undefined)).toThrow(
      /Cell\.of\(\) only accepts static data.*function/,
    );
  });

  it("carries input CFC labels to Cells in hidden output state", () => {
    const input = getCellOrThrow(reactive<string>(
      undefined,
      {
        type: "string",
        ifc: { confidentiality: ["factory-secret"] },
      },
    ));
    const output = getCellOrThrow(reactive<string>());

    applyInputIfcToOutput(
      bindPattern({ input }),
      bindPattern({ output }),
    );

    const outputSchema = exportCell(output).schema as {
      ifc?: { confidentiality?: unknown[] };
    };
    expect(outputSchema.ifc?.confidentiality).toContain("factory-secret");
  });

  it("walks semantic factory children without exposing protocol accessors", () => {
    const nested = createFactoryShell({
      kind: "module",
      ref: { ...REF, symbol: "nested" },
    });
    const outer = createFactoryShell({
      kind: "pattern",
      ref: REF,
      argumentSchema: true,
      resultSchema: true,
      paramsSchema: true,
      params: { nested },
      spaceSelector: "destination",
    });
    const state = factoryStateOf(outer) as {
      params: unknown;
      spaceSelector: unknown;
    };
    const protocolFunctions = Reflect.ownKeys(outer)
      .map((key) => Object.getOwnPropertyDescriptor(outer, key)?.value)
      .filter((value): value is (...args: never[]) => unknown =>
        typeof value === "function"
      );
    const children = [...verifiedWalkChildValues(outer)];

    expect(children).toContain(state.params);
    expect(children).toContain(state.spaceSelector);
    expect(children.some((value) => protocolFunctions.includes(value as never)))
      .toBe(false);

    const registry = new ExecutableRegistry();
    registry.trustHostValue(outer, { reason: "factory graph walk test" });
    expect(getArtifactEntryRef(outer)).toBeUndefined();
  });

  it("collects links from factory params and space selectors", async () => {
    const paramsLink = {
      "/": {
        "link@1": {
          id: "of:factory-params-link",
          path: [],
          space,
        },
      },
    };
    const selectorLink = {
      "/": {
        "link@1": {
          id: "of:factory-selector-link",
          path: [],
          space,
        },
      },
    };
    const factory = createFactoryShell({
      kind: "pattern",
      ref: REF,
      argumentSchema: true,
      resultSchema: true,
      paramsSchema: true,
      params: { linked: paramsLink },
      spaceSelector: selectorLink,
    });
    const base: NormalizedLink = {
      space,
      id: "of:factory-data-uri" as never,
      path: [],
    };
    const synced: string[] = [];
    const originalOpen = storageManager.open.bind(storageManager);
    storageManager.open = ((openSpace) => {
      const provider = originalOpen(openSpace);
      return new Proxy(provider, {
        get(target, property, receiver) {
          if (property === "sync") {
            return (id: string) => {
              synced.push(id);
              return Promise.resolve({ ok: {} });
            };
          }
          const value = Reflect.get(target, property, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    }) as typeof storageManager.open;
    const promises: Promise<unknown>[] = [];

    storageManager.accessForTestingOnly.collectLinkedCellSyncs(
      factory,
      base,
      undefined,
      promises,
      new Set(),
    );
    await Promise.all(promises);
    expect(synced.sort()).toEqual([
      "of:factory-params-link",
      "of:factory-selector-link",
    ]);
  });
});
