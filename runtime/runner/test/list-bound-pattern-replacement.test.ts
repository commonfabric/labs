import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import {
  createFactoryShell,
  sealFactoryState,
} from "@commonfabric/data-model/fabric-factory";
import { Identity } from "@commonfabric/identity";

import { createNodeFactory } from "../src/builder/module.ts";
import { setDurableArtifactEntryRef } from "../src/builder/pattern-metadata.ts";
import { withPatternParamsSchema } from "../src/builder/pattern.ts";
import type {
  BuilderFunctionsAndConstants,
  JSONSchema,
  PatternFactory,
} from "../src/builder/types.ts";
import type { FactoryContract } from "../src/factory-materialization.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";

const signer = await Identity.fromPassphrase(
  "bound list pattern replacement test",
);
const space = signer.did();

const LIST_ARGUMENT_SCHEMA = {
  type: "object",
  properties: {
    element: { type: "number" },
    index: { type: "number" },
    array: { type: "array", items: { type: "number" } },
  },
  required: ["element", "index", "array"],
  additionalProperties: false,
} as const satisfies JSONSchema;
const NUMBER_SCHEMA = { type: "number" } as const satisfies JSONSchema;
const BOOLEAN_SCHEMA = { type: "boolean" } as const satisfies JSONSchema;
const PARAMS_SCHEMA = {
  type: "object",
  properties: {
    tag: { type: "string" },
    adjustment: { type: "number" },
    source: { type: "number" },
  },
  required: ["tag", "adjustment", "source"],
  additionalProperties: false,
} as const satisfies JSONSchema;
const COMPUTE_SCHEMA = {
  type: "object",
  properties: {
    element: { type: "number" },
    tag: { type: "string" },
    adjustment: { type: "number" },
    source: { type: "number" },
  },
  required: ["element", "tag", "adjustment", "source"],
  additionalProperties: false,
} as const satisfies JSONSchema;

const MAP_CONTRACT = {
  kind: "pattern",
  argumentSchema: LIST_ARGUMENT_SCHEMA,
  resultSchema: NUMBER_SCHEMA,
} as const satisfies FactoryContract;
const FILTER_CONTRACT = {
  kind: "pattern",
  argumentSchema: LIST_ARGUMENT_SCHEMA,
  resultSchema: BOOLEAN_SCHEMA,
} as const satisfies FactoryContract;
const OUTER_SCHEMA = {
  type: "object",
  properties: {
    values: { type: "array", items: { type: "number" } },
    mapOp: { asFactory: MAP_CONTRACT },
    filterOp: { asFactory: FILTER_CONTRACT },
  },
  required: ["values", "mapOp", "filterOp"],
  additionalProperties: false,
} as const satisfies JSONSchema;

const REFS = {
  mapA: {
    identity: "LMAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    symbol: "mapA",
  },
  mapB: {
    identity: "LMBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBA",
    symbol: "mapB",
  },
  filterA: {
    identity: "LFAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    symbol: "filterA",
  },
  filterB: {
    identity: "LFBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBA",
    symbol: "filterB",
  },
} as const;

type ListArgument = {
  element: number;
  index: number;
  array: number[];
};
type Params = {
  tag: string;
  adjustment: number;
  source: number;
};
type ComputeInput = {
  element: number;
  tag: string;
  adjustment: number;
  source: number;
};
type CurryView<T, R> = PatternFactory<T, R> & {
  curry(params: unknown): PatternFactory<T, R>;
};

function curry<T, R>(
  factory: PatternFactory<T, R>,
  params: unknown,
): PatternFactory<T, R> {
  return (factory as CurryView<T, R>).curry(params);
}

function refKey(identity: string, symbol: string): string {
  return `${identity}#${symbol}`;
}

async function within<T>(
  promise: Promise<T>,
  label: string,
  timeoutMs = 4_000,
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

describe("bound list pattern replacement", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;
  let commonfabric: BuilderFunctionsAndConstants;
  let artifacts: Map<string, PatternFactory<any, any>>;
  let releasePending: Array<() => void>;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    tx = runtime.edit();
    commonfabric = createTrustedBuilder(runtime).commonfabric;
    artifacts = new Map();
    releasePending = [];
    runtime.patternManager.artifactFromIdentitySync = (identity, symbol) =>
      artifacts.get(refKey(identity, symbol));
    runtime.patternManager.isArtifactAvailableInSpace = (
      identity,
      artifactSpace,
    ) =>
      artifactSpace === space &&
      [...artifacts.keys()].some((key) => key.startsWith(`${identity}#`));
  });

  afterEach(async () => {
    for (const release of releasePending) release();
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

  function install<T, R>(
    factory: PatternFactory<T, R>,
    ref: { identity: string; symbol: string },
  ): PatternFactory<T, R> {
    setDurableArtifactEntryRef(factory, ref);
    artifacts.set(refKey(ref.identity, ref.symbol), factory);
    return factory;
  }

  function bound<T, R>(
    factory: PatternFactory<T, R>,
    params: Params,
  ): unknown {
    return createFactoryShell(sealFactoryState(curry(factory, params)));
  }

  it("fences A(params1) -> B(params2) -> A(params3) for an unchanged list", async () => {
    const staleAEntered = Promise.withResolvers<void>();
    const releaseStaleA = Promise.withResolvers<void>();
    releasePending.push(releaseStaleA.resolve);

    const mapARuns: string[] = [];
    const mapBRuns: string[] = [];
    const filterARuns: string[] = [];
    const filterBRuns: string[] = [];

    const mapACompute = commonfabric.lift(
      (async (
        { element, tag, adjustment, source }: ComputeInput,
      ): Promise<number> => {
        mapARuns.push(`${tag}:${source}`);
        if (tag === "A1" && source === 11) {
          staleAEntered.resolve();
          await releaseStaleA.promise;
        }
        return element + adjustment + source;
      }) as unknown as (input: ComputeInput) => number,
      COMPUTE_SCHEMA,
      NUMBER_SCHEMA,
    );
    const mapBCompute = commonfabric.lift(
      ({ element, tag, adjustment, source }: ComputeInput): number => {
        mapBRuns.push(`${tag}:${source}`);
        return element + adjustment + source;
      },
      COMPUTE_SCHEMA,
      NUMBER_SCHEMA,
    );
    const filterACompute = commonfabric.lift(
      ({ element, tag, adjustment, source }: ComputeInput): boolean => {
        filterARuns.push(`${tag}:${source}`);
        return element + source > adjustment;
      },
      COMPUTE_SCHEMA,
      BOOLEAN_SCHEMA,
    );
    const filterBCompute = commonfabric.lift(
      ({ element, tag, adjustment, source }: ComputeInput): boolean => {
        filterBRuns.push(`${tag}:${source}`);
        return element + source > adjustment;
      },
      COMPUTE_SCHEMA,
      BOOLEAN_SCHEMA,
    );

    const mapA = install(
      commonfabric.pattern<ListArgument, number>(
        withPatternParamsSchema(
          ((argument: ListArgument, params: Params) =>
            mapACompute({
              element: argument.element,
              tag: params.tag,
              adjustment: params.adjustment,
              source: params.source,
            })) as never,
          PARAMS_SCHEMA,
        ) as never,
        LIST_ARGUMENT_SCHEMA,
        NUMBER_SCHEMA,
      ),
      REFS.mapA,
    );
    const mapB = install(
      commonfabric.pattern<ListArgument, number>(
        withPatternParamsSchema(
          ((argument: ListArgument, params: Params) =>
            mapBCompute({
              element: argument.element,
              tag: params.tag,
              adjustment: params.adjustment,
              source: params.source,
            })) as never,
          PARAMS_SCHEMA,
        ) as never,
        LIST_ARGUMENT_SCHEMA,
        NUMBER_SCHEMA,
      ),
      REFS.mapB,
    );
    const filterA = install(
      commonfabric.pattern<ListArgument, boolean>(
        withPatternParamsSchema(
          ((argument: ListArgument, params: Params) =>
            filterACompute({
              element: argument.element,
              tag: params.tag,
              adjustment: params.adjustment,
              source: params.source,
            })) as never,
          PARAMS_SCHEMA,
        ) as never,
        LIST_ARGUMENT_SCHEMA,
        BOOLEAN_SCHEMA,
      ),
      REFS.filterA,
    );
    const filterB = install(
      commonfabric.pattern<ListArgument, boolean>(
        withPatternParamsSchema(
          ((argument: ListArgument, params: Params) =>
            filterBCompute({
              element: argument.element,
              tag: params.tag,
              adjustment: params.adjustment,
              source: params.source,
            })) as never,
          PARAMS_SCHEMA,
        ) as never,
        LIST_ARGUMENT_SCHEMA,
        BOOLEAN_SCHEMA,
      ),
      REFS.filterB,
    );

    const sourceA = runtime.getCell<number>(
      space,
      "list-source-a",
      NUMBER_SCHEMA,
      tx,
    );
    const sourceB = runtime.getCell<number>(
      space,
      "list-source-b",
      NUMBER_SCHEMA,
      tx,
    );
    const element = runtime.getCell<number>(
      space,
      "list-element",
      NUMBER_SCHEMA,
      tx,
    );
    const mapSelector = runtime.getCell<unknown>(
      space,
      "list-map-selector",
      undefined,
      tx,
    );
    const filterSelector = runtime.getCell<unknown>(
      space,
      "list-filter-selector",
      undefined,
      tx,
    );
    const mapReplacementSelector = runtime.getCell<unknown>(
      space,
      "list-map-replacement-selector",
      undefined,
      tx,
    );
    const filterReplacementSelector = runtime.getCell<unknown>(
      space,
      "list-filter-replacement-selector",
      undefined,
      tx,
    );
    const mapIntermediate = runtime.getCell<unknown>(
      space,
      "list-map-selector-intermediate",
      undefined,
      tx,
    );
    const filterIntermediate = runtime.getCell<unknown>(
      space,
      "list-filter-selector-intermediate",
      undefined,
      tx,
    );
    const mapAlias = runtime.getCell<unknown>(
      space,
      "list-map-selector-alias",
      undefined,
      tx,
    );
    const filterAlias = runtime.getCell<unknown>(
      space,
      "list-filter-selector-alias",
      undefined,
      tx,
    );
    sourceA.set(1);
    sourceB.set(5);
    element.set(2);
    const sourceALink = sourceA.getAsLink({
      includeSchema: true,
    }) as unknown as number;
    const sourceBLink = sourceB.getAsLink({
      includeSchema: true,
    }) as unknown as number;
    mapSelector.set(bound(mapA, {
      tag: "A1",
      adjustment: 10,
      source: sourceALink,
    }));
    filterSelector.set(bound(filterA, {
      tag: "A1",
      adjustment: 0,
      source: sourceALink,
    }));
    mapReplacementSelector.set(bound(mapB, {
      tag: "B2",
      adjustment: 100,
      source: sourceBLink,
    }));
    filterReplacementSelector.set(bound(filterB, {
      tag: "B2",
      adjustment: 10,
      source: sourceBLink,
    }));
    mapIntermediate.setRaw(mapSelector.getAsWriteRedirectLink());
    filterIntermediate.setRaw(filterSelector.getAsWriteRedirectLink());
    mapAlias.setRaw(mapIntermediate.getAsWriteRedirectLink());
    filterAlias.setRaw(filterIntermediate.getAsWriteRedirectLink());

    const mapNode = createNodeFactory({ type: "ref", implementation: "map" });
    const filterNode = createNodeFactory({
      type: "ref",
      implementation: "filter",
    });
    const flatMapNode = createNodeFactory({
      type: "ref",
      implementation: "flatMap",
    });
    const outer = commonfabric.pattern(
      (({ values, mapOp, filterOp }: any) => ({
        values,
        mapped: mapNode({ list: values, op: mapOp }),
        filtered: filterNode({ list: values, op: filterOp }),
        flattened: flatMapNode({ list: values, op: mapOp }),
      })) as any,
      OUTER_SCHEMA,
    );
    const resultCell = runtime.getCell<Record<string, unknown>>(
      space,
      "bound-list-replacement-result",
      outer.resultSchema,
      tx,
    );
    const result = runtime.run(
      tx,
      outer,
      { values: [element], mapOp: mapAlias, filterOp: filterAlias },
      resultCell,
    );
    await commitAndRenew();

    expect(await within(result.key("mapped").pull(), "initial A1 map"))
      .toEqual([13]);
    expect(await within(result.key("filtered").pull(), "initial A1 filter"))
      .toEqual([2]);
    expect(await within(result.key("flattened").pull(), "initial A1 flatMap"))
      .toEqual([13]);
    await within(runtime.idle(), "initial A1 idle");

    const mapAggregateIdentity = result.key("mapped").resolveAsCell()
      .getAsNormalizedFullLink();
    const mapRowIdentity = result.key("mapped").key(0).resolveAsCell()
      .getAsNormalizedFullLink();
    const filterAggregateIdentity = result.key("filtered").resolveAsCell()
      .getAsNormalizedFullLink();
    const filterRowIdentity = result.key("filtered").key(0).resolveAsCell()
      .getAsNormalizedFullLink();
    const flatMapAggregateIdentity = result.key("flattened").resolveAsCell()
      .getAsNormalizedFullLink();
    const flatMapRowIdentity = result.key("flattened").key(0).resolveAsCell()
      .getAsNormalizedFullLink();
    const observedMapValues: number[] = [];
    const cancelObservation = result.key("mapped").sink((value) => {
      if (Array.isArray(value) && typeof value[0] === "number") {
        observedMapValues.push(value[0]);
      }
    });
    releasePending.push(cancelObservation);
    await within(runtime.idle(), "map observation startup");
    observedMapValues.length = 0;

    sourceA.withTx(tx).set(11);
    await commitAndRenew();
    await within(staleAEntered.promise, "stale A1 map execution");

    mapIntermediate.withTx(tx).setRaw(
      mapReplacementSelector.withTx(tx).getAsWriteRedirectLink(),
    );
    filterIntermediate.withTx(tx).setRaw(
      filterReplacementSelector.withTx(tx).getAsWriteRedirectLink(),
    );
    await commitAndRenew();
    releaseStaleA.resolve();
    await within(runtime.idle(), "B2 replacement after stale A1 completion");

    expect(await within(result.key("mapped").pull(), "B2 map")).toEqual([107]);
    expect(await within(result.key("filtered").pull(), "B2 filter")).toEqual(
      [],
    );
    expect(await within(result.key("flattened").pull(), "B2 flatMap"))
      .toEqual([107]);
    expect(observedMapValues).not.toContain(23);
    expect(result.key("mapped").resolveAsCell().getAsNormalizedFullLink())
      .toEqual(mapAggregateIdentity);
    expect(
      result.key("mapped").key(0).resolveAsCell().getAsNormalizedFullLink(),
    )
      .toEqual(mapRowIdentity);
    expect(result.key("filtered").resolveAsCell().getAsNormalizedFullLink())
      .toEqual(filterAggregateIdentity);
    expect(result.key("flattened").resolveAsCell().getAsNormalizedFullLink())
      .toEqual(flatMapAggregateIdentity);
    expect(
      result.key("flattened").key(0).resolveAsCell()
        .getAsNormalizedFullLink(),
    ).toEqual(flatMapRowIdentity);

    const runsBeforeEqualReplay = {
      map: mapBRuns.length,
      filter: filterBRuns.length,
    };
    mapReplacementSelector.withTx(tx).set(bound(mapB, {
      tag: "B2",
      adjustment: 100,
      source: sourceBLink,
    }));
    filterReplacementSelector.withTx(tx).set(bound(filterB, {
      tag: "B2",
      adjustment: 10,
      source: sourceBLink,
    }));
    await commitAndRenew();
    await within(runtime.idle(), "equal B2 replay");
    expect(mapBRuns).toHaveLength(runsBeforeEqualReplay.map);
    expect(filterBRuns).toHaveLength(runsBeforeEqualReplay.filter);

    const aRunsAfterB = {
      map: mapARuns.length,
      filter: filterARuns.length,
    };
    sourceA.withTx(tx).set(12);
    await commitAndRenew();
    await within(runtime.idle(), "old A subscriptions after B2");
    expect(mapARuns).toHaveLength(aRunsAfterB.map);
    expect(filterARuns).toHaveLength(aRunsAfterB.filter);
    expect(await within(result.key("mapped").pull(), "B2 map after source A"))
      .toEqual([107]);

    mapReplacementSelector.withTx(tx).set(bound(mapA, {
      tag: "A3",
      adjustment: 1_000,
      source: sourceALink,
    }));
    filterReplacementSelector.withTx(tx).set(bound(filterA, {
      tag: "A3",
      adjustment: 1,
      source: sourceALink,
    }));
    await commitAndRenew();
    await within(runtime.idle(), "A3 replacement");

    expect(await within(result.key("mapped").pull(), "A3 map"))
      .toEqual([1_014]);
    expect(await within(result.key("filtered").pull(), "A3 filter"))
      .toEqual([2]);
    expect(await within(result.key("flattened").pull(), "A3 flatMap"))
      .toEqual([1_014]);
    expect(result.key("mapped").resolveAsCell().getAsNormalizedFullLink())
      .toEqual(mapAggregateIdentity);
    expect(
      result.key("mapped").key(0).resolveAsCell().getAsNormalizedFullLink(),
    )
      .toEqual(mapRowIdentity);
    expect(result.key("filtered").resolveAsCell().getAsNormalizedFullLink())
      .toEqual(filterAggregateIdentity);
    expect(
      result.key("filtered").key(0).resolveAsCell().getAsNormalizedFullLink(),
    )
      .toEqual(filterRowIdentity);
    expect(result.key("flattened").resolveAsCell().getAsNormalizedFullLink())
      .toEqual(flatMapAggregateIdentity);
    expect(
      result.key("flattened").key(0).resolveAsCell()
        .getAsNormalizedFullLink(),
    ).toEqual(flatMapRowIdentity);

    const bRunsAfterA3 = {
      map: mapBRuns.length,
      filter: filterBRuns.length,
    };
    sourceB.withTx(tx).set(6);
    await commitAndRenew();
    await within(runtime.idle(), "old B subscriptions after A3");
    expect(mapBRuns).toHaveLength(bRunsAfterA3.map);
    expect(filterBRuns).toHaveLength(bRunsAfterA3.filter);
    expect(await within(result.key("mapped").pull(), "A3 map after source B"))
      .toEqual([1_014]);

    result.withTx(tx).key("values").set([]);
    await commitAndRenew();
    await within(runtime.idle(), "remove cached row");
    expect(await within(result.key("mapped").pull(), "removed map row"))
      .toEqual([]);
    expect(await within(result.key("filtered").pull(), "removed filter row"))
      .toEqual([]);
    expect(await within(result.key("flattened").pull(), "removed flatMap row"))
      .toEqual([]);

    mapReplacementSelector.withTx(tx).set(bound(mapB, {
      tag: "B4",
      adjustment: 200,
      source: sourceBLink,
    }));
    filterReplacementSelector.withTx(tx).set(bound(filterB, {
      tag: "B4",
      adjustment: 6,
      source: sourceBLink,
    }));
    await commitAndRenew();
    await within(runtime.idle(), "replace while row is absent");
    result.withTx(tx).key("values").set([element]);
    await commitAndRenew();
    await within(runtime.idle(), "reappeared B4 row execution");
    expect(await within(result.key("mapped").pull(), "reappeared B4 map"))
      .toEqual([208]);
    expect(await within(result.key("filtered").pull(), "reappeared B4 filter"))
      .toEqual([2]);
    expect(
      await within(result.key("flattened").pull(), "reappeared B4 flatMap"),
    ).toEqual([208]);
    expect(mapBRuns.at(-1)).toBe("B4:6");
    expect(filterBRuns.at(-1)).toBe("B4:6");
    expect(result.key("mapped").resolveAsCell().getAsNormalizedFullLink())
      .toEqual(mapAggregateIdentity);
    expect(
      result.key("mapped").key(0).resolveAsCell().getAsNormalizedFullLink(),
    ).toEqual(mapRowIdentity);
    expect(result.key("filtered").resolveAsCell().getAsNormalizedFullLink())
      .toEqual(filterAggregateIdentity);
    expect(result.key("flattened").resolveAsCell().getAsNormalizedFullLink())
      .toEqual(flatMapAggregateIdentity);
  });
});
