import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import type { FabricValue } from "@commonfabric/data-model";
import {
  createFactoryShell,
  factoryStateOf,
  type FactoryStateV1,
  isAdmittedFabricFactory,
  sealFactoryState,
} from "@commonfabric/data-model/fabric-factory";
import { Identity } from "@commonfabric/identity";

import {
  setDurableArtifactEntryRef,
  setFrameworkProvidedPaths,
} from "../src/builder/pattern-metadata.ts";
import type { JSONSchema } from "../src/builder/types.ts";
import {
  FactoryArtifactUnavailableError,
  type FactoryContract,
} from "../src/factory-materialization.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import type { MemorySpace } from "../src/storage/interface.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";

const signer = await Identity.fromPassphrase("factory cell roundtrip test");
const space = signer.did();
const destinationSpace = (await Identity.fromPassphrase(
  "factory cell roundtrip destination",
)).did();

const VALUE_SCHEMA = {
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

const REFS = {
  pattern: {
    identity: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    symbol: "cellPattern",
  },
  module: {
    identity: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBA",
    symbol: "cellModule",
  },
  handler: {
    identity: "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCA",
    symbol: "cellHandler",
  },
} as const;

const CONTRACTS = {
  pattern: {
    kind: "pattern",
    argumentSchema: VALUE_SCHEMA,
    resultSchema: RESULT_SCHEMA,
  },
  module: {
    kind: "module",
    argumentSchema: VALUE_SCHEMA,
    resultSchema: RESULT_SCHEMA,
  },
  handler: {
    kind: "handler",
    contextSchema: VALUE_SCHEMA,
    eventSchema: VALUE_SCHEMA,
  },
} as const satisfies Record<keyof typeof REFS, FactoryContract>;

const FACTORY_KINDS = ["pattern", "module", "handler"] as const;
type FactoryKind = (typeof FACTORY_KINDS)[number];
type LiveFactory = ((input: unknown) => unknown) & Record<PropertyKey, unknown>;
type FactoryFixture = {
  live: LiveFactory;
  shell: FabricValue;
  state: FactoryStateV1;
};

type StoredFactories = {
  direct: FabricValue;
  nested: {
    array: FabricValue[];
    object: { factory: FabricValue };
  };
};

function storageSchema(contract: FactoryContract): JSONSchema {
  const factorySchema = { asFactory: contract } as const;
  return {
    type: "object",
    properties: {
      direct: factorySchema,
      nested: {
        type: "object",
        properties: {
          array: {
            type: "array",
            items: factorySchema,
          },
          object: {
            type: "object",
            properties: { factory: factorySchema },
            required: ["factory"],
            additionalProperties: false,
          },
        },
        required: ["array", "object"],
        additionalProperties: false,
      },
    },
    required: ["direct", "nested"],
    additionalProperties: false,
  } as JSONSchema;
}

function leaves(value: StoredFactories): FabricValue[] {
  return [
    value.direct,
    value.nested.array[0],
    value.nested.object.factory,
  ];
}

const leafReaders = [
  (value: StoredFactories) => value.direct,
  (value: StoredFactories) => value.nested.array[0],
  (value: StoredFactories) => value.nested.object.factory,
] as const;

function expectInertFactory(
  value: FabricValue,
  expectedState: FactoryStateV1,
): void {
  expect(typeof value).toBe("function");
  expect(isAdmittedFabricFactory(value)).toBe(true);
  expect(factoryStateOf(value)).toEqual(expectedState);
  expect(Object.isFrozen(value)).toBe(true);
  expect(() => (value as unknown as () => unknown)()).toThrow(
    "factory requires runner materialization",
  );
}

function expectLiveFactories(
  value: StoredFactories,
  fixture: FactoryFixture,
): void {
  for (const [index, factory] of leaves(value).entries()) {
    expect(isAdmittedFabricFactory(factory)).toBe(true);
    expect(factoryStateOf(factory)).toEqual(fixture.state);
    if (!Object.is(factory, fixture.live)) {
      throw new Error(`Factory leaf ${index} remained an inert shell`);
    }
    (factory as unknown as (input: { value: number }) => unknown)({ value: 7 });
  }
}

function expectColdSynchronousReadFails(read: () => unknown): void {
  let returned: unknown;
  try {
    returned = read();
  } catch (error) {
    expect(error).toBeInstanceOf(FactoryArtifactUnavailableError);
    return;
  }
  if (isAdmittedFabricFactory(returned)) {
    throw new Error(
      "Cold synchronous factory exposure leaked a Factory@1 callable shell",
    );
  }
  throw new Error(
    "Cold synchronous factory exposure returned without failing closed",
  );
}

describe("typed Factory@1 Cell round trips", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let fixtures: Record<FactoryKind, FactoryFixture>;
  let warmArtifacts: Map<string, LiveFactory>;
  let availableClosures: Set<string>;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    const commonfabric = createTrustedBuilder(runtime).commonfabric;
    const liveFactories = {
      pattern: commonfabric.pattern(
        ({ value }: { value: number }) => ({ result: value }),
        VALUE_SCHEMA,
        RESULT_SCHEMA,
      ),
      module: commonfabric.lift(
        ({ value }: { value: number }) => ({ result: value + 1 }),
        VALUE_SCHEMA,
        RESULT_SCHEMA,
      ),
      handler: commonfabric.handler(
        VALUE_SCHEMA,
        VALUE_SCHEMA,
        (_event: { value: number }, _context: { value: number }) => undefined,
      ),
    };

    warmArtifacts = new Map();
    availableClosures = new Set();
    const makeFixture = (kind: FactoryKind): FactoryFixture => {
      const live = liveFactories[kind] as unknown as LiveFactory;
      const ref = REFS[kind];
      setFrameworkProvidedPaths(live, [["value"]]);
      setDurableArtifactEntryRef(live, ref);
      const state = sealFactoryState(live);
      warmArtifacts.set(`${ref.identity}#${ref.symbol}`, live);
      availableClosures.add(`${space}|${ref.identity}`);
      return {
        live,
        shell: createFactoryShell(state),
        state,
      };
    };
    fixtures = {
      pattern: makeFixture("pattern"),
      module: makeFixture("module"),
      handler: makeFixture("handler"),
    };

    runtime.patternManager.artifactFromIdentitySync = (identity, symbol) =>
      warmArtifacts.get(`${identity}#${symbol}`);
    runtime.patternManager.isArtifactAvailableInSpace = (
      identity,
      artifactSpace,
    ) => availableClosures.has(`${artifactSpace}|${identity}`);
  });

  afterEach(async () => {
    await runtime.dispose();
    await storageManager.close();
  });

  async function store(
    kind: FactoryKind,
    caseName: string,
  ): Promise<ReturnType<Runtime["getCell"]>> {
    const fixture = fixtures[kind];
    const cellId = `typed-${kind}-factory-${caseName}`;
    const schema = storageSchema(CONTRACTS[kind]);
    const tx = runtime.edit();
    const cell = runtime.getCell<StoredFactories>(space, cellId, schema, tx);
    cell.set({
      direct: fixture.shell,
      nested: {
        array: [fixture.shell],
        object: { factory: fixture.shell },
      },
    });
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit().settled).error).toBeUndefined();
    return runtime.getCell<StoredFactories>(space, cellId, schema);
  }

  function makeCold(kind: FactoryKind): void {
    const { identity, symbol } = REFS[kind];
    warmArtifacts.delete(`${identity}#${symbol}`);
    availableClosures.delete(`${space}|${identity}`);
  }

  for (const kind of FACTORY_KINDS) {
    it(`keeps typed ${kind} factories inert in raw reads`, async () => {
      const fixture = fixtures[kind];
      const stored = await store(kind, "raw");
      const raw = stored.getRaw() as StoredFactories;
      for (const value of leaves(raw)) {
        expectInertFactory(value, fixture.state);
      }
    });

    it(`materializes typed ${kind} factories in warm schema-driven Cell.get reads`, async () => {
      const fixture = fixtures[kind];
      const stored = await store(kind, "warm-cell-get");
      expectLiveFactories(stored.get() as StoredFactories, fixture);
    });

    it(`materializes typed ${kind} factories in warm executable query-result reads`, async () => {
      const fixture = fixtures[kind];
      const stored = await store(kind, "warm-query-result");
      // getAsQueryResult() is currently the only query-result API. This call is
      // intentionally an executable exposure, not dependency-only traversal.
      expectLiveFactories(
        stored.getAsQueryResult() as StoredFactories,
        fixture,
      );
    });

    it(`fails closed for cold typed ${kind} factories in synchronous Cell.get reads`, async () => {
      const stored = await store(kind, "cold-cell-get");
      makeCold(kind);
      for (const readLeaf of leafReaders) {
        expectColdSynchronousReadFails(
          () => readLeaf(stored.get() as StoredFactories),
        );
      }
    });

    it(`fails closed for cold typed ${kind} factories in synchronous executable query-result reads`, async () => {
      const stored = await store(kind, "cold-query-result");
      makeCold(kind);
      for (const readLeaf of leafReaders) {
        expectColdSynchronousReadFails(
          () => readLeaf(stored.getAsQueryResult() as StoredFactories),
        );
      }
    });
  }

  it("keeps cold factory atoms inert in non-materializing Cell.pull reads", async () => {
    const fixture = fixtures.pattern;
    const stored = await store("pattern", "cold-non-materializing-pull");
    makeCold("pattern");

    const pulled = await stored.pull({
      materializeFactories: false,
    }) as StoredFactories;
    for (const value of leaves(pulled)) {
      expectInertFactory(value, fixture.state);
    }
  });

  it("keeps nested cold factory atoms inert in non-materializing synchronous reads", async () => {
    const fixture = fixtures.pattern;
    const stored = await store("pattern", "cold-non-materializing-get");
    makeCold("pattern");

    const readTx = runtime.edit();
    readTx.markLazyMaterialize(true);
    const value = stored.withTx(readTx)
      .getWithoutFactoryMaterialization() as StoredFactories;
    for (const factory of leaves(value)) {
      expectInertFactory(factory, fixture.state);
    }
  });

  it("keeps linked cold factory atoms inert in lazy non-materializing reads", async () => {
    const fixture = fixtures.pattern;
    const write = runtime.edit();
    const factory = runtime.getCell<FabricValue>(
      space,
      "cold-linked-factory-target",
      undefined,
      write,
    );
    factory.set(fixture.shell);
    runtime.getCell<{ nested: { factory: unknown } }>(
      space,
      "cold-linked-factory-holder",
      undefined,
      write,
    ).set({ nested: { factory } });
    runtime.prepareTxForCommit(write);
    expect((await write.commit().settled).error).toBeUndefined();
    makeCold("pattern");

    const readTx = runtime.edit();
    readTx.markLazyMaterialize(true);
    const holder = runtime.getCell<{
      nested: { factory: FabricValue };
    }>(
      space,
      "cold-linked-factory-holder",
      {
        type: "object",
        properties: {
          nested: {
            type: "object",
            properties: {
              factory: {
                asFactory: CONTRACTS.pattern,
                allOf: [true],
              },
            },
            required: ["factory"],
            additionalProperties: false,
          },
        },
        required: ["nested"],
        additionalProperties: false,
      },
      readTx,
    );
    const value = holder.getWithoutFactoryMaterialization();
    expectInertFactory(value.nested.factory, fixture.state);
  });

  it("rejects a Cell write when its factory artifact is unavailable in the destination space", () => {
    const tx = runtime.edit();
    const destination = runtime.getCell<{ nested: { factory: FabricValue } }>(
      destinationSpace,
      "cross-space-factory-write",
      undefined,
      tx,
    );

    expect(() =>
      destination.set({
        nested: { factory: fixtures.pattern.shell },
      })
    ).toThrow(
      `Factory artifact ${REFS.pattern.identity} is not available in space ${destinationSpace}`,
    );
  });

  it("records the resolved target space as factory provenance after a cross-space raw read", async () => {
    const sourceTx = runtime.edit();
    const source = runtime.getCell<FabricValue>(
      space,
      "cross-space-factory-provenance-source",
      undefined,
      sourceTx,
    );
    source.set(fixtures.pattern.shell);
    runtime.prepareTxForCommit(sourceTx);
    expect((await sourceTx.commit().settled).error).toBeUndefined();

    const linkTx = runtime.edit();
    const linked = runtime.getCell<FabricValue>(
      destinationSpace,
      "cross-space-factory-provenance-link",
      undefined,
      linkTx,
    );
    linked.setRaw(source.getAsLink() as FabricValue);
    runtime.prepareTxForCommit(linkTx);
    expect((await linkTx.commit().settled).error).toBeUndefined();

    const observed: MemorySpace[] = [];
    const note = runtime.noteFactoryArtifactSource.bind(runtime);
    runtime.noteFactoryArtifactSource = (value, sourceSpace) => {
      observed.push(sourceSpace);
      note(value, sourceSpace);
    };

    linked.withTx().getRaw({ lastNode: "value" });
    expect(observed.at(-1)).toBe(space);
  });

  for (const method of ["push", "addUnique"] as const) {
    it(`rejects Cell.${method} when its factory artifact is unavailable in the destination space`, () => {
      const tx = runtime.edit();
      const destination = runtime.getCell<LiveFactory[]>(
        destinationSpace,
        `cross-space-factory-${method}`,
        {
          type: "array",
          items: { asFactory: CONTRACTS.pattern },
        },
        tx,
      );

      expect(() => destination[method](fixtures.pattern.shell as LiveFactory))
        .toThrow(
          `Factory artifact ${REFS.pattern.identity} is not available in space ${destinationSpace}`,
        );
    });
  }

  it("rejects a stream event when its factory artifact is unavailable in the destination space", () => {
    const stream = runtime.getCell<LiveFactory>(
      destinationSpace,
      "cross-space-factory-event",
      { asCell: ["stream"] },
    );

    expect(() => stream.send(fixtures.pattern.shell as LiveFactory)).toThrow(
      `Factory artifact ${REFS.pattern.identity} is not available in space ${destinationSpace}`,
    );
  });
});
