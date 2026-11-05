import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import { FabricBytes } from "@commonfabric/data-model/fabric-primitives";
import { resolveScopeKey } from "@commonfabric/memory/v2";
import {
  createFactoryShell,
  sealFactoryState,
} from "@commonfabric/data-model/fabric-factory";

import { createNodeFactory } from "../src/builder/module.ts";
import { setDurableArtifactEntryRef } from "../src/builder/pattern-metadata.ts";
import { withPatternParamsSchema } from "../src/builder/pattern.ts";
import { createListPatternFactorySupervisor } from "../src/builtins/list-factory-materialization.ts";
import { useCancelGroup } from "../src/cancel.ts";
import type {
  BuilderFunctionsAndConstants,
  JSONSchema,
  PatternFactory,
} from "../src/builder/types.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import type {
  IExtendedStorageTransaction,
  IStorageSubscription,
} from "../src/storage/interface.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";
import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "./cfc-seed-envelope.ts";

const signer = await Identity.fromPassphrase("bound list pattern factory test");
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
const NUMBER_RESULT_SCHEMA = { type: "number" } as const satisfies JSONSchema;
const BOOLEAN_RESULT_SCHEMA = {
  type: "boolean",
} as const satisfies JSONSchema;
const NUMBER_ARRAY_RESULT_SCHEMA = {
  type: "array",
  items: { type: "number" },
} as const satisfies JSONSchema;
const FACTOR_PARAMS_SCHEMA = {
  type: "object",
  properties: { factor: { type: "number" } },
  required: ["factor"],
  additionalProperties: false,
} as const satisfies JSONSchema;
const THRESHOLD_PARAMS_SCHEMA = {
  type: "object",
  properties: { threshold: { type: "number" } },
  required: ["threshold"],
  additionalProperties: false,
} as const satisfies JSONSchema;
const BYTES_PARAMS_SCHEMA = {
  type: "object",
  properties: { bytes: true },
  required: ["bytes"],
  additionalProperties: false,
} as const satisfies JSONSchema;
const OUTER_ARGUMENT_SCHEMA = {
  type: "object",
  properties: {
    values: { type: "array", items: { type: "number" } },
  },
  required: ["values"],
  additionalProperties: false,
} as const satisfies JSONSchema;
const REFS = {
  map: {
    identity: "MAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    symbol: "mapOp",
  },
  filter: {
    identity: "FAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    symbol: "filterOp",
  },
  flatMap: {
    identity: "XAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    symbol: "flatMapOp",
  },
} as const;

type CurryView<T, R> = PatternFactory<T, R> & {
  curry(params: unknown): PatternFactory<T, R>;
};

function curry<T, R>(
  factory: PatternFactory<T, R>,
  params: unknown,
): PatternFactory<T, R> {
  return (factory as CurryView<T, R>).curry(params);
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

describe("bound PatternFactory list operations", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;
  let commonfabric: BuilderFunctionsAndConstants;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    tx = runtime.edit();
    commonfabric = createTrustedBuilder(runtime).commonfabric;
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

  function installArtifact(
    factory: PatternFactory<any, any>,
    ref: { identity: string; symbol: string },
  ): void {
    setDurableArtifactEntryRef(factory, ref);
    runtime.patternManager.artifactFromIdentitySync = (identity, symbol) => {
      const key = `${identity}#${symbol}`;
      return artifacts.get(key);
    };
    artifacts.set(`${ref.identity}#${ref.symbol}`, factory);
    runtime.patternManager.isArtifactAvailableInSpace = (
      identity,
      artifactSpace,
    ) =>
      artifactSpace === space &&
      [...artifacts.keys()].some((key) => key.startsWith(`${identity}#`));
  }

  let artifacts: Map<string, PatternFactory<any, any>>;

  beforeEach(() => {
    artifacts = new Map();
  });

  function boundMapOp(factor: unknown = 10) {
    const calculate = commonfabric.lift(
      (
        { element, index, array, factor }: {
          element: number;
          index: number;
          array: number[];
          factor: number;
        },
      ) => element * factor + index + array.length,
    );
    const base = commonfabric.pattern(
      withPatternParamsSchema(
        ((argument: any, params: any) =>
          calculate({
            element: argument.element,
            index: argument.index,
            array: argument.array,
            factor: params.factor,
          })) as any,
        FACTOR_PARAMS_SCHEMA,
      ) as any,
      LIST_ARGUMENT_SCHEMA,
      NUMBER_RESULT_SCHEMA,
    );
    installArtifact(base, REFS.map);
    return curry(base, { factor });
  }

  function byteBoundMapOps() {
    const calculate = commonfabric.lift(({
      element,
      bytes,
    }: {
      element: number;
      bytes: FabricBytes;
    }) => element + (bytes.slice()[0] ?? 0));
    const base = commonfabric.pattern(
      withPatternParamsSchema(
        ((argument: any, params: { bytes: FabricBytes }) =>
          calculate({
            element: argument.element,
            bytes: params.bytes,
          })) as any,
        BYTES_PARAMS_SCHEMA,
      ) as any,
      LIST_ARGUMENT_SCHEMA,
      NUMBER_RESULT_SCHEMA,
    );
    installArtifact(base, REFS.map);
    return [
      curry(base, { bytes: new FabricBytes(new Uint8Array([1])) }),
      curry(base, { bytes: new FabricBytes(new Uint8Array([9])) }),
    ] as const;
  }

  function boundFilterOp() {
    const predicate = commonfabric.lift(
      (
        { element, index, array, threshold }: {
          element: number;
          index: number;
          array: number[];
          threshold: number;
        },
      ) => element + index + array.length > threshold,
    );
    const base = commonfabric.pattern(
      withPatternParamsSchema(
        ((argument: any, params: any) =>
          predicate({
            element: argument.element,
            index: argument.index,
            array: argument.array,
            threshold: params.threshold,
          })) as any,
        THRESHOLD_PARAMS_SCHEMA,
      ) as any,
      LIST_ARGUMENT_SCHEMA,
      BOOLEAN_RESULT_SCHEMA,
    );
    installArtifact(base, REFS.filter);
    return curry(base, { threshold: 5 });
  }

  function boundFlatMapOp() {
    const expand = commonfabric.lift(
      (
        { element, index, array, factor }: {
          element: number;
          index: number;
          array: number[];
          factor: number;
        },
      ) => [element, element * factor + index + array.length],
    );
    const base = commonfabric.pattern(
      withPatternParamsSchema(
        ((argument: any, params: any) =>
          expand({
            element: argument.element,
            index: argument.index,
            array: argument.array,
            factor: params.factor,
          })) as any,
        FACTOR_PARAMS_SCHEMA,
      ) as any,
      LIST_ARGUMENT_SCHEMA,
      NUMBER_ARRAY_RESULT_SCHEMA,
    );
    installArtifact(base, REFS.flatMap);
    return curry(base, { factor: 10 });
  }

  it("runs canonical map/filter/flatMap nodes without sibling params", async () => {
    const mapNode = createNodeFactory({ type: "ref", implementation: "map" });
    const filterNode = createNodeFactory({
      type: "ref",
      implementation: "filter",
    });
    const flatMapNode = createNodeFactory({
      type: "ref",
      implementation: "flatMap",
    });
    const mapOp = boundMapOp();
    const filterOp = boundFilterOp();
    const flatMapOp = boundFlatMapOp();
    const outer = commonfabric.pattern(
      (({ values }: any) => ({
        values,
        mapped: mapNode({ list: values, op: mapOp }),
        filtered: filterNode({ list: values, op: filterOp }),
        flattened: flatMapNode({ list: values, op: flatMapOp }),
      })) as any,
      OUTER_ARGUMENT_SCHEMA,
    );

    for (const node of outer.nodes) {
      expect(Object.hasOwn(node.inputs as object, "params")).toBe(false);
    }

    const resultCell = runtime.getCell<Record<string, unknown>>(
      space,
      "canonical bound list operations",
      outer.resultSchema,
      tx,
    );
    const result = runtime.run(tx, outer, { values: [1, 2, 3] }, resultCell);
    await commitAndRenew();

    expect(await within(result.key("mapped").pull(), "canonical map"))
      .toEqual([13, 24, 35]);
    expect(await within(result.key("filtered").pull(), "canonical filter"))
      .toEqual([2, 3]);
    expect(await within(result.key("flattened").pull(), "canonical flatMap"))
      .toEqual([1, 13, 2, 24, 3, 35]);

    const outputIdentity = result.key("mapped").resolveAsCell()
      .getAsNormalizedFullLink();
    const rowIdentity = result.key("mapped").key(0).resolveAsCell()
      .getAsNormalizedFullLink();
    result.withTx(tx).key("values").set([4, 2, 3]);
    await commitAndRenew();

    expect(await within(result.key("mapped").pull(), "updated canonical map"))
      .toEqual([43, 24, 35]);
    expect(result.key("mapped").resolveAsCell().getAsNormalizedFullLink())
      .toMatchObject(outputIdentity);
    expect(
      result.key("mapped").key(0).resolveAsCell()
        .getAsNormalizedFullLink(),
    ).toMatchObject(rowIdentity);
  });

  it("replaces a bound list factory when only FabricBytes params change", async () => {
    const [selectedA, selectedB] = byteBoundMapOps();
    const selector = runtime.getCell<unknown>(
      space,
      "bound list FabricBytes selector",
      undefined,
      tx,
    );
    selector.set(createFactoryShell(sealFactoryState(selectedA)));
    const mapNode = createNodeFactory({ type: "ref", implementation: "map" });
    const outer = commonfabric.pattern(
      (({ values, op }: any) => ({
        mapped: mapNode({ list: values, op }),
      })) as any,
      {
        type: "object",
        properties: {
          values: { type: "array", items: { type: "number" } },
          op: {
            asFactory: {
              kind: "pattern",
              argumentSchema: LIST_ARGUMENT_SCHEMA,
              resultSchema: NUMBER_RESULT_SCHEMA,
            },
          },
        },
        required: ["values", "op"],
        additionalProperties: false,
      },
    );
    const resultCell = runtime.getCell<Record<string, unknown>>(
      space,
      "bound list FabricBytes result",
      outer.resultSchema,
      tx,
    );
    const result = runtime.run(
      tx,
      outer,
      { values: [1], op: selector },
      resultCell,
    );
    await commitAndRenew();

    expect(await within(result.key("mapped").pull(), "first bytes map"))
      .toEqual([2]);
    selector.withTx(tx).set(
      createFactoryShell(sealFactoryState(selectedB)),
    );
    await commitAndRenew();

    expect(await within(result.key("mapped").pull(), "replacement bytes map"))
      .toEqual([10]);
  });

  it("fast-preempts when an intermediate factory redirect retargets", async () => {
    const selectedA = boundMapOp(10);
    const selectedB = boundMapOp(20);
    const sourceA = runtime.getCell<unknown>(
      space,
      "bound list fast source A",
      undefined,
      tx,
    );
    const sourceB = runtime.getCell<unknown>(
      space,
      "bound list fast source B",
      undefined,
      tx,
    );
    const intermediate = runtime.getCell<unknown>(
      space,
      "bound list fast intermediate",
      undefined,
      tx,
    );
    const alias = runtime.getCell<unknown>(
      space,
      "bound list fast alias",
      undefined,
      tx,
    );
    sourceA.set(createFactoryShell(sealFactoryState(selectedA)));
    sourceB.set(createFactoryShell(sealFactoryState(selectedB)));
    intermediate.setRaw(sourceA.getAsWriteRedirectLink());
    alias.setRaw(intermediate.getAsWriteRedirectLink());

    let preemptions = 0;
    const [cancelAll, addCancel] = useCancelGroup();
    const supervisor = createListPatternFactorySupervisor(
      runtime,
      addCancel,
      () => preemptions++,
    );
    try {
      supervisor.materialize(tx, alias, "map");
      await commitAndRenew();

      intermediate.withTx(tx).setRaw(
        sourceB.withTx(tx).getAsWriteRedirectLink(),
      );
      await commitAndRenew();
      await Promise.resolve();
      await Promise.resolve();

      expect(preemptions).toBe(1);
    } finally {
      cancelAll();
    }
  });

  it("does not preempt rows when only the factory selection label changes", async () => {
    const selected = createFactoryShell(sealFactoryState(boundMapOp()));
    const selector = runtime.getCell<unknown>(
      space,
      "bound list label-only selector",
      undefined,
      tx,
    );
    const selectorLink = selector.getAsNormalizedFullLink();
    const writeSelection = (label: string): void => {
      writeSeedEnvelopeDoc(tx, selectorLink.space);
      seedStoredEnvelope(tx, {
        space: selectorLink.space,
        scope: selectorLink.scope,
        id: selectorLink.id,
        type: "application/json",
        path: [],
      }, {
        value: selected,
        cfc: {
          version: 1,
          schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
          labelMap: {
            version: 1,
            entries: [{
              path: [],
              label: { confidentiality: [label] },
            }],
          },
        },
      });
    };

    writeSelection("factory-label-a");
    await commitAndRenew();

    let preemptions = 0;
    const [cancelAll, addCancel] = useCancelGroup();
    const supervisor = createListPatternFactorySupervisor(
      runtime,
      addCancel,
      () => preemptions++,
    );
    try {
      supervisor.materialize(
        tx,
        runtime.getCellFromLink(selectorLink, undefined, tx),
        "map",
      );
      await commitAndRenew();

      writeSelection("factory-label-b");
      await commitAndRenew();
      await Promise.resolve();
      await Promise.resolve();

      expect(preemptions).toBe(0);
    } finally {
      cancelAll();
    }
  });

  it("does not preempt one user when another user's factory changes", async () => {
    const alice = {
      principal: "did:key:bound-list-alice",
      sessionId: "bound-list-alice-session" as never,
    };
    const bob = {
      principal: "did:key:bound-list-bob",
      sessionId: "bound-list-bob-session" as never,
    };
    const selectorId = "bound list per-user selector";

    const aliceWrite = runtime.edit();
    aliceWrite.tx.scopeKeyIdentity = alice;
    const aliceSelector = runtime.getCell<unknown>(
      space,
      selectorId,
      undefined,
      aliceWrite,
      "user",
    );
    aliceSelector.set(createFactoryShell(sealFactoryState(boundMapOp(10))));

    let preemptions = 0;
    let fastSubscription: IStorageSubscription | undefined;
    storageManager.subscribe = (subscription) => {
      fastSubscription = subscription;
    };
    const [cancelAll, addCancel] = useCancelGroup();
    const supervisor = createListPatternFactorySupervisor(
      runtime,
      addCancel,
      () => preemptions++,
      alice,
    );
    try {
      supervisor.materialize(
        aliceWrite,
        aliceSelector,
        "map",
      );
      expect(fastSubscription).toBeDefined();
      fastSubscription!.next({
        type: "commit",
        space,
        changes: [{
          address: {
            ...aliceSelector.getAsNormalizedFullLink(),
            scopeKey: resolveScopeKey("user", bob),
            path: [],
          },
          before: undefined,
          after: createFactoryShell(sealFactoryState(boundMapOp(20))),
        }],
      });
      await Promise.resolve();
      await Promise.resolve();

      expect(preemptions).toBe(0);
    } finally {
      cancelAll();
    }
  });

  it("rebinds a mapped element when an intermediate redirect retargets", async () => {
    const first = runtime.getCell<number>(
      space,
      "bound list redirect first",
      { type: "number" },
      tx,
    );
    first.set(1);
    const second = runtime.getCell<number>(
      space,
      "bound list redirect second",
      { type: "number" },
      tx,
    );
    second.set(5);
    const redirect = runtime.getCell<unknown>(
      space,
      "bound list redirect",
      { type: "number" },
      tx,
    );
    redirect.setRaw(first.getAsWriteRedirectLink());

    const mapNode = createNodeFactory({ type: "ref", implementation: "map" });
    const outer = commonfabric.pattern(
      (({ values }: any) => ({
        mapped: mapNode({ list: values, op: boundMapOp() }),
      })) as any,
      OUTER_ARGUMENT_SCHEMA,
    );
    const resultCell = runtime.getCell<Record<string, unknown>>(
      space,
      "bound list redirect result",
      outer.resultSchema,
      tx,
    );
    const result = runtime.run(tx, outer, { values: [redirect] }, resultCell);
    await commitAndRenew();

    expect(await within(result.key("mapped").pull(), "initial redirect map"))
      .toEqual([11]);

    redirect.withTx(tx).setRaw(second.withTx(tx).getAsWriteRedirectLink());
    await commitAndRenew();
    await runtime.idle();

    expect(await within(result.key("mapped").pull(), "retargeted redirect map"))
      .toEqual([51]);
  });

  it("does not rerun the list coordinator when captured values update", async () => {
    const factor = runtime.getCell<number>(
      space,
      "bound list coordinator capture",
      { type: "number" },
      tx,
    );
    factor.set(10);
    const element = runtime.getCell<number>(
      space,
      "bound list coordinator element",
      { type: "number" },
      tx,
    );
    element.set(1);
    const mapNode = createNodeFactory({ type: "ref", implementation: "map" });
    const outer = commonfabric.pattern(
      (({ values, factor }: any) => ({
        mapped: mapNode({ list: values, op: boundMapOp(factor) }),
      })) as any,
      {
        type: "object",
        properties: {
          values: { type: "array", items: { type: "number" } },
          factor: { type: "number" },
        },
        required: ["values", "factor"],
        additionalProperties: false,
      },
    );
    const resultCell = runtime.getCell<Record<string, unknown>>(
      space,
      "bound list coordinator dependencies",
      outer.resultSchema,
      tx,
    );
    const result = runtime.run(
      tx,
      outer,
      { values: [element], factor },
      resultCell,
    );
    await commitAndRenew();

    expect(await within(result.key("mapped").pull(), "captured value map"))
      .toEqual([11]);
    await runtime.idle();

    const coordinator = runtime.scheduler.getGraphSnapshot().nodes.find((
      node,
    ) => node.id.startsWith("raw:map:"));
    expect(coordinator).toBeDefined();
    const formatLink = (
      link: ReturnType<typeof element.getAsNormalizedFullLink>,
    ) =>
      `${link.space}/${link.id}/${link.scope ?? "space"}/${
        link.path.join("/")
      }`;
    const rowLink = result.key("mapped").key(0).resolveAsCell()
      .getAsNormalizedFullLink();
    expect(coordinator?.reads).not.toContain(formatLink(rowLink));
    expect(coordinator?.reads).not.toContain(
      formatLink(element.getAsNormalizedFullLink()),
    );

    const coordinatorRuns = coordinator?.stats?.runCount;
    factor.withTx(tx).set(20);
    await commitAndRenew();
    expect(await within(result.key("mapped").pull(), "updated captured value"))
      .toEqual([21]);
    await runtime.idle();
    const afterCaptureUpdate = runtime.scheduler.getGraphSnapshot().nodes.find(
      (node) => node.id === coordinator?.id,
    );
    expect(afterCaptureUpdate?.stats?.runCount).toBe(coordinatorRuns);

    element.withTx(tx).set(2);
    await commitAndRenew();
    expect(await within(result.key("mapped").pull(), "updated list element"))
      .toEqual([41]);
    await runtime.idle();
    const afterElementUpdate = runtime.scheduler.getGraphSnapshot().nodes.find(
      (node) => node.id === coordinator?.id,
    );
    expect(afterElementUpdate?.stats?.runCount).toBe(coordinatorRuns);
  });
});
