import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import type { FabricValue } from "@commonfabric/data-model";
import {
  fabricFromJsonValue,
  jsonFromFabricValue,
} from "@commonfabric/data-model/codecs";
import {
  factoryStateOf,
  type FactoryStateV1,
  isAdmittedFabricFactory,
  sealFactoryState,
} from "@commonfabric/data-model/fabric-factory";
import { hashOf } from "@commonfabric/data-model";
import { Identity } from "@commonfabric/identity";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";

import type {
  HandlerFactory,
  ModuleFactory,
  PatternFactory,
} from "../src/builder/types.ts";
import { popFrame, pushFrame } from "../src/builder/pattern.ts";
import { convertCellsToLinks } from "../src/cell.ts";
import {
  loadVerifiedSourceClosure,
  setCompileCacheRuntimeVersionForTesting,
  writeSourceDocs,
} from "../src/compilation-cache/cell-cache.ts";
import {
  type MaterializedFactory,
  materializeFactory,
  prepareFactory,
} from "../src/factory-materialization.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import type { MemorySpace } from "../src/storage/interface.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import type { Options } from "../src/storage/v2.ts";
import { TEST_MEMORY_SERVER_AUTH } from "./memory-v2-test-utils.ts";

const signer = await Identity.fromPassphrase("factory roundtrip integration");
const sourceSpace = signer.did();
const destinationSpace = (await Identity.fromPassphrase(
  "factory roundtrip integration destination",
)).did();
const onwardDestinationSpace = (await Identity.fromPassphrase(
  "factory roundtrip integration onward destination",
)).did();

const PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "import { handler, lift, pattern } from 'commonfabric';",
      "export const patternFactory = pattern<{ value: number }>(({ value }) => ({ result: value }));",
      "export const moduleFactory = lift((value: number) => value + 1);",
      "export const handlerFactory = handler((_event: number, _context: { prefix: string }) => undefined);",
      "export default pattern<{ value: number }>(({ value }) => ({ result: value }));",
    ].join("\n"),
  }],
};

const SYMBOLS = [
  "patternFactory",
  "moduleFactory",
  "handlerFactory",
] as const;

type FactoryTuple = readonly [
  PatternFactory<unknown, unknown>,
  ModuleFactory<unknown, unknown>,
  HandlerFactory<unknown, unknown>,
];

type PersistedFactoryValues = {
  pattern: FactoryTuple[0];
  module: FactoryTuple[1];
  handler: FactoryTuple[2];
};

// Each instance owns a separate cold client replica while all instances talk
// to one in-process server. This catches false "fresh runtime" tests that keep
// using a writer's warm StorageManager cache.
class SharedServerStorageManager extends EmulatedStorageManager {
  static override connectTo(
    server: MemoryV2Server.Server,
    options: Omit<Options, "memoryHost" | "spaceHostMap">,
  ): SharedServerStorageManager {
    const manager = new SharedServerStorageManager(
      { ...options, memoryHost: new URL("memory://") },
      () => server,
    );
    manager.sharedServer = server;
    return manager;
  }

  private sharedServer!: MemoryV2Server.Server;

  protected override server(): MemoryV2Server.Server {
    return this.sharedServer;
  }
}

function createSharedServer(): MemoryV2Server.Server {
  return new MemoryV2Server.Server({
    authorizeSessionOpen(message) {
      const principal = (message.authorization as { principal?: unknown })
        ?.principal;
      return typeof principal === "string" ? principal : undefined;
    },
    sessionOpenAuth: TEST_MEMORY_SERVER_AUTH.sessionOpenAuth,
  });
}

interface StoredFactories {
  readonly identity: string;
  readonly factories: FactoryTuple;
  readonly states: readonly [FactoryStateV1, FactoryStateV1, FactoryStateV1];
  readonly encoded: string;
  readonly shells: FactoryTuple;
}

describe("Factory@1 runner round trips", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let writer: Runtime;
  const extraRuntimes: Runtime[] = [];

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    writer = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
  });

  afterEach(async () => {
    while (extraRuntimes.length > 0) {
      await extraRuntimes.pop()!.dispose();
    }
    await writer.dispose();
    await storageManager.close();
  });

  async function storeFactories(): Promise<StoredFactories> {
    let identity: string | undefined;
    await writer.patternManager.compilePattern(PROGRAM, {
      space: sourceSpace,
      onEntryIdentity(value) {
        identity = value;
      },
    });
    expect(identity).toBeDefined();
    await storageManager.synced();

    const baseFactories = SYMBOLS.map((symbol) =>
      writer.patternManager.artifactFromIdentitySync(identity!, symbol)
    ) as unknown as FactoryTuple;
    const factories = [
      baseFactories[0].asScope("user").inSpace("execution-target"),
      baseFactories[1].asScope("session"),
      baseFactories[2],
    ] as const satisfies FactoryTuple;
    for (const factory of factories) {
      expect(isAdmittedFabricFactory(factory)).toBe(true);
    }
    const states = factories.map((factory) =>
      sealFactoryState(factory)
    ) as unknown as StoredFactories["states"];
    const encoded = jsonFromFabricValue({
      nested: { factories: [...factories] },
    } as FabricValue);
    const decoded = fabricFromJsonValue(encoded) as {
      nested: { factories: FactoryTuple };
    };
    return {
      identity: identity!,
      factories,
      states,
      encoded,
      shells: decoded.nested.factories,
    };
  }

  function invokeAll(
    runtime: Runtime,
    factories: readonly MaterializedFactory[],
  ): void {
    const frame = pushFrame({
      space: sourceSpace,
      generatedIdCounter: 0,
      reactives: new Set(),
      runtime,
    });
    try {
      expect(() => factories[0]!({ value: 1 } as never)).not.toThrow();
      expect(() => factories[1]!(1 as never)).not.toThrow();
      expect(() => factories[2]!({ prefix: "x" } as never)).not.toThrow();
    } finally {
      popFrame(frame);
    }
  }

  it("context-free decodes all kinds inertly and warm-materializes nested values", async () => {
    const { encoded, factories, shells, states } = await storeFactories();

    expect(
      jsonFromFabricValue(
        { nested: { factories: [...shells] } } as FabricValue,
      ),
    )
      .toBe(encoded);
    for (let index = 0; index < shells.length; index++) {
      expect(typeof shells[index]).toBe("function");
      expect(factoryStateOf(shells[index])).toEqual(states[index]);
      expect(() => shells[index]!(undefined as never)).toThrow(
        "factory requires runner materialization",
      );
    }

    const materialized = shells.map((shell) =>
      materializeFactory(shell, {
        runtime: writer,
        artifactSpace: sourceSpace,
      })
    );
    for (let index = 0; index < materialized.length; index++) {
      expect(sealFactoryState(materialized[index])).toEqual(states[index]);
      expect(materialized[index]).not.toBe(shells[index]);
      expect(typeof factories[index]).toBe("function");
    }
    invokeAll(writer, materialized);
  });

  it("genuinely cold-loads and invokes each kind in an independent fresh runtime", async () => {
    const { identity, shells, states } = await storeFactories();
    const independentlyLoaded: MaterializedFactory[] = [];

    for (let index = 0; index < SYMBOLS.length; index++) {
      const runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager,
      });
      extraRuntimes.push(runtime);
      expect(
        runtime.patternManager.artifactFromIdentitySync(
          identity,
          SYMBOLS[index],
        ),
      ).toBeUndefined();
      const materialized = await prepareFactory(shells[index], {
        runtime,
        artifactSpace: sourceSpace,
      });
      expect(sealFactoryState(materialized)).toEqual(states[index]);
      expect(
        runtime.patternManager.artifactFromIdentitySync(
          identity,
          SYMBOLS[index],
        ),
      ).toBeDefined();
      invokeOne(runtime, index, materialized, sourceSpace);
      independentlyLoaded.push(materialized);
    }

    const secondPatternRuntime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    extraRuntimes.push(secondPatternRuntime);
    const secondPattern = await prepareFactory(shells[0], {
      runtime: secondPatternRuntime,
      artifactSpace: sourceSpace,
    });
    expect(hashOf(secondPattern).toString()).toBe(
      hashOf(independentlyLoaded[0]).toString(),
    );
  });

  it("publishes synchronously after a storage-backed compiled artifact load", async () => {
    const { identity, shells } = await storeFactories();
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    extraRuntimes.push(runtime);

    await prepareFactory(shells[0], {
      runtime,
      artifactSpace: sourceSpace,
    });
    const publication = runtime.patternManager.prepareArtifactPublication(
      identity,
      sourceSpace,
      destinationSpace,
    );

    expect(Array.isArray(publication)).toBe(true);
    expect((publication as readonly unknown[]).length).toBeGreaterThan(0);
  });

  it("publishes synchronously after source recovery for a new runtime version", async () => {
    const restoreVersionA = setCompileCacheRuntimeVersionForTesting(
      "factory-publication-version-a",
    );
    try {
      const { identity, shells } = await storeFactories();
      const restoreVersionB = setCompileCacheRuntimeVersionForTesting(
        "factory-publication-version-b",
      );
      try {
        const runtime = new Runtime({
          apiUrl: new URL(import.meta.url),
          storageManager,
        });
        extraRuntimes.push(runtime);

        await prepareFactory(shells[0], {
          runtime,
          artifactSpace: sourceSpace,
        });
        expect(runtime.patternManager.getCompileCacheStats().byIdentityHits)
          .toBe(0);
        const publication = runtime.patternManager.prepareArtifactPublication(
          identity,
          sourceSpace,
          destinationSpace,
        );

        expect(Array.isArray(publication)).toBe(true);
        expect((publication as readonly unknown[]).length).toBeGreaterThan(0);
        await runtime.patternManager.flushCompileCacheWrites();
      } finally {
        restoreVersionB();
      }
    } finally {
      restoreVersionA();
    }
  });

  it("publishes a verified non-entry factory synchronously", async () => {
    const program: RuntimeProgram = {
      main: "/main.tsx",
      files: [{
        name: "/main.tsx",
        contents: [
          "import { pattern } from 'commonfabric';",
          "import { dependencyFactory } from './dependency.tsx';",
          "export default pattern<{ value: number }>(({ value }) => ({ child: dependencyFactory({ value }) }));",
        ].join("\n"),
      }, {
        name: "/dependency.tsx",
        contents: [
          "import { pattern } from 'commonfabric';",
          "export const dependencyFactory = pattern<{ value: number }>(({ value }) => ({ result: value }));",
        ].join("\n"),
      }],
    };
    const compiled = await writer.harness.compileToRecordGraph(program);
    const dependencyIdentity =
      compiled.modules.find((module) => module.filename === "/dependency.tsx")!
        .identity;
    const extraRootIdentity =
      compiled.modules.find((module) => module.filename === "cfc.ts")!
        .identity;
    let entryIdentity: string | undefined;
    await writer.patternManager.compilePattern(program, {
      space: sourceSpace,
      onEntryIdentity(identity) {
        entryIdentity = identity;
      },
    });
    expect(entryIdentity).toBeDefined();
    await storageManager.synced();

    const dependencyFactory = writer.patternManager.artifactFromIdentitySync(
      dependencyIdentity,
      "dependencyFactory",
    );
    expect(dependencyFactory).toBeDefined();
    expect(sealFactoryState(dependencyFactory).ref.identity).toBe(
      dependencyIdentity,
    );
    expect(dependencyIdentity).not.toBe(entryIdentity);
    expect(
      writer.patternManager.isArtifactAvailableInSpace(
        dependencyIdentity,
        sourceSpace,
      ),
    ).toBe(true);

    const publication = writer.patternManager.prepareArtifactPublication(
      dependencyIdentity,
      sourceSpace,
      destinationSpace,
    );
    expect(Array.isArray(publication)).toBe(true);
    expect((publication as readonly unknown[]).length).toBeGreaterThan(0);
    const publishedModuleIdentities = (publication as readonly {
      value: { value?: { identity?: string } };
    }[]).flatMap((operation) =>
      operation.value.value?.identity === undefined
        ? []
        : [operation.value.value.identity]
    );
    expect(publishedModuleIdentities).toContain(dependencyIdentity);
    expect(publishedModuleIdentities).not.toContain(entryIdentity);
    expect(publishedModuleIdentities).not.toContain(extraRootIdentity);

    const entryPublication = writer.patternManager.prepareArtifactPublication(
      entryIdentity!,
      sourceSpace,
      destinationSpace,
    );
    expect(Array.isArray(entryPublication)).toBe(true);
    const entryPublishedModuleIdentities = (entryPublication as readonly {
      value: { value?: { identity?: string } };
    }[]).flatMap((operation) =>
      operation.value.value?.identity === undefined
        ? []
        : [operation.value.value.identity]
    );
    expect(entryPublishedModuleIdentities).toContain(entryIdentity);
    expect(entryPublishedModuleIdentities).toContain(dependencyIdentity);
    expect(entryPublishedModuleIdentities).toContain(extraRootIdentity);
  });

  it("warm-materializes a decoded root PatternFactory before synchronous run", async () => {
    const { identity } = await storeFactories();
    const live = writer.patternManager.artifactFromIdentitySync(
      identity,
      "patternFactory",
    ) as PatternFactory<unknown, unknown>;
    const shell = fabricFromJsonValue(
      jsonFromFabricValue(live as unknown as FabricValue),
    ) as PatternFactory<unknown, unknown>;
    const tx = writer.edit();
    const result = writer.getCell<{ result: number }>(
      sourceSpace,
      "warm-decoded-root-factory",
      undefined,
      tx,
    );

    writer.run(tx, shell as never, { value: 9 } as never, result);
    writer.prepareTxForCommit(tx);
    expect((await tx.commit().settled).error).toBeUndefined();

    expect(await result.pull()).toEqual({ result: 9 });
    expect(result.getMetaRaw("patternIdentity")).toEqual({
      identity,
      symbol: "patternFactory",
    });
  });

  it("cold-materializes a decoded root PatternFactory before non-transactional setup", async () => {
    const { identity } = await storeFactories();
    const live = writer.patternManager.artifactFromIdentitySync(
      identity,
      "patternFactory",
    ) as PatternFactory<unknown, unknown>;
    const shell = fabricFromJsonValue(
      jsonFromFabricValue(live as unknown as FabricValue),
    ) as PatternFactory<unknown, unknown>;
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    extraRuntimes.push(runtime);
    expect(
      runtime.patternManager.artifactFromIdentitySync(
        identity,
        "patternFactory",
      ),
    ).toBeUndefined();
    const result = runtime.getCell<{ result: number }>(
      sourceSpace,
      "cold-decoded-root-factory",
    );

    await runtime.setup(undefined, shell as never, { value: 11 }, result);

    expect(
      runtime.patternManager.artifactFromIdentitySync(
        identity,
        "patternFactory",
      ),
    ).toBeDefined();
    expect(result.getMetaRaw("patternIdentity")).toEqual({
      identity,
      symbol: "patternFactory",
    });
  });

  it("rejects live and decoded HandlerFactory values at root setup before writing piece state", async () => {
    const { factories, shells } = await storeFactories();
    for (
      const [label, handlerFactory] of [
        ["live", factories[2]],
        ["decoded", shells[2]],
      ] as const
    ) {
      const result = writer.getCell(
        sourceSpace,
        `rejected-${label}-handler-root-factory`,
      );

      await expect(
        writer.setup(undefined, handlerFactory as never, {}, result),
      ).rejects.toThrow(
        "Root setup requires a pattern or module factory, got handler",
      );

      expect(result.getRaw()).toBeUndefined();
    }
  });

  it("rejects live and decoded HandlerFactory values in transaction-bound root setup", async () => {
    const { factories, shells } = await storeFactories();
    for (
      const [label, handlerFactory] of [
        ["live", factories[2]],
        ["decoded", shells[2]],
      ] as const
    ) {
      const tx = writer.edit();
      const result = writer.getCell(
        sourceSpace,
        `rejected-${label}-transaction-handler-root-factory`,
        undefined,
        tx,
      );

      expect(() => writer.setup(tx, handlerFactory as never, {}, result))
        .toThrow(
          "Root setup requires a pattern or module factory, got handler",
        );
      expect(result.getRaw()).toBeUndefined();
      if (tx.status().status === "ready") {
        tx.abort(new Error("expected handler rejection"));
      }
    }
  });

  it("rejects live and decoded HandlerFactory values in root run before writing piece state", async () => {
    const { factories, shells } = await storeFactories();
    for (
      const [label, handlerFactory] of [
        ["live", factories[2]],
        ["decoded", shells[2]],
      ] as const
    ) {
      const tx = writer.edit();
      const result = writer.getCell(
        sourceSpace,
        `rejected-${label}-run-handler-root-factory`,
        undefined,
        tx,
      );

      expect(() => writer.run(tx, handlerFactory as never, {}, result)).toThrow(
        "Root setup requires a pattern or module factory, got handler",
      );
      expect(result.getRaw()).toBeUndefined();
      if (tx.status().status === "ready") {
        tx.abort(new Error("expected handler rejection"));
      }
    }
  });

  it("preserves root setup compatibility for raw non-factory handler descriptors", async () => {
    const { factories } = await storeFactories();
    const rawHandlerDescriptor = { ...factories[2] };
    expect(isAdmittedFabricFactory(rawHandlerDescriptor)).toBe(false);
    const result = writer.getCell(
      sourceSpace,
      "raw-handler-root-descriptor",
    );

    await expect(
      writer.setup(undefined, rawHandlerDescriptor as never, {}, result),
    ).resolves.toBe(result);
    // The descriptor remains accepted by the legacy setup boundary, but its
    // keyless identity is session-only and therefore never written as durable
    // piece metadata.
    expect(result.getMetaRaw("patternIdentity")).toBeUndefined();
  });

  it("preserves modifier state, including anonymous and link-mapped selectors", async () => {
    const { factories } = await storeFactories();
    const patternFactory = factories[0];
    const anonymous = patternFactory.inSpace();
    const selectorCell = writer.getCell(sourceSpace, "factory selector");
    const cellSelected = convertCellsToLinks(
      patternFactory.inSpace(selectorCell as never),
    ) as PatternFactory<unknown, unknown>;

    for (const carried of [anonymous, cellSelected]) {
      const encoded = jsonFromFabricValue(carried as FabricValue);
      const shell = fabricFromJsonValue(encoded) as PatternFactory<
        unknown,
        unknown
      >;
      expect(jsonFromFabricValue(shell as FabricValue)).toBe(encoded);
      const materialized = materializeFactory(shell, {
        runtime: writer,
        artifactSpace: sourceSpace,
      });
      expect(sealFactoryState(materialized)).toEqual(sealFactoryState(carried));
    }

    const anonymousState = sealFactoryState(anonymous);
    const cellState = sealFactoryState(cellSelected);
    expect(anonymousState.kind).toBe("pattern");
    expect(cellState.kind).toBe("pattern");
    if (anonymousState.kind === "pattern" && cellState.kind === "pattern") {
      expect(anonymousState.defaultScope).toBe("user");
      expect(anonymousState.spaceSelector).toBe("");
      expect(cellState.defaultScope).toBe("user");
      expect(cellState.spaceSelector).toEqual(selectorCell.getAsLink());
    }
  });

  it("publishes an inline factory through its containing write while retaining its execution selector", async () => {
    const { identity, factories, shells, states } = await storeFactories();
    const inline = writer.getImmutableCell(destinationSpace, factories[0]);
    expect(
      writer.patternManager.isArtifactAvailableInSpace(
        identity,
        destinationSpace,
      ),
    ).toBe(false);

    const tx = writer.edit();
    writer.getCell(
      destinationSpace,
      "inline-factory-containing-write",
      undefined,
      tx,
    ).set(inline.getRaw());
    expect((await tx.commit().settled).error).toBeUndefined();
    expect(
      writer.patternManager.isArtifactAvailableInSpace(
        identity,
        destinationSpace,
      ),
    ).toBe(true);

    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    extraRuntimes.push(runtime);
    const materialized = await prepareFactory(shells[0], {
      runtime,
      artifactSpace: destinationSpace,
    });
    expect(sealFactoryState(materialized)).toEqual(states[0]);
    const state = sealFactoryState(materialized);
    if (state.kind !== "pattern") throw new Error("expected pattern state");
    expect(state.spaceSelector).toBe("execution-target");
    expect(destinationSpace).not.toBe(state.spaceSelector);
  });

  it("atomically publishes every by-value factory kind through direct transaction commit", async () => {
    const { identity, factories, shells, states } = await storeFactories();
    const tx = writer.edit();
    const destination = writer.getCell<{ factories: FactoryTuple }>(
      destinationSpace,
      "auto-published-factory-kinds",
      undefined,
      tx,
    );
    destination.set({ factories });

    expect(destination.getRaw()).toEqual({ factories });
    expect((await tx.commit().settled).error).toBeUndefined();
    expect(
      writer.patternManager.isArtifactAvailableInSpace(
        identity,
        destinationSpace,
      ),
    ).toBe(true);

    const cold = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    extraRuntimes.push(cold);
    for (let index = 0; index < shells.length; index += 1) {
      const materialized = await prepareFactory(shells[index], {
        runtime: cold,
        artifactSpace: destinationSpace,
      });
      expect(sealFactoryState(materialized)).toEqual(states[index]);
    }
  });

  it("drops an eager factory publication when the final transaction value no longer contains it", async () => {
    const { factories } = await storeFactories();
    const tx = writer.edit();
    const destination = writer.getCell<{
      value: PatternFactory<unknown, unknown> | string;
    }>(
      destinationSpace,
      "overwritten-eager-factory-publication",
      undefined,
      tx,
    );
    destination.set({ value: factories[0] });
    writer.prepareTxForCommit(tx);
    destination.set({ value: "ordinary-final-value" });

    let preparationCalls = 0;
    const prepareArtifactPublication = writer.patternManager
      .prepareArtifactPublication.bind(writer.patternManager);
    writer.patternManager.prepareArtifactPublication = (() => {
      preparationCalls += 1;
      throw new Error("stale factory publication ran");
    }) as typeof writer.patternManager.prepareArtifactPublication;

    try {
      const result = await tx.commit().settled;
      expect(result.error).toBeUndefined();
    } finally {
      writer.patternManager.prepareArtifactPublication =
        prepareArtifactPublication;
    }

    expect(preparationCalls).toBe(0);
    expect(destination.getRaw()).toEqual({ value: "ordinary-final-value" });
  });

  it("prefers a verified source over a speculative Cell-read candidate", async () => {
    const { identity, factories } = await storeFactories();
    writer.noteFactoryArtifactSource(factories[0], destinationSpace);

    let publication: {
      identity: string;
      fromSpace: MemorySpace;
      toSpace: MemorySpace;
    } | undefined;
    const prepareArtifactPublication = writer.patternManager
      .prepareArtifactPublication.bind(writer.patternManager);
    writer.patternManager.prepareArtifactPublication = ((
      selectedIdentity,
      fromSpace,
      toSpace,
    ) => {
      publication = {
        identity: selectedIdentity,
        fromSpace,
        toSpace,
      };
      return [];
    }) as typeof writer.patternManager.prepareArtifactPublication;

    try {
      const tx = writer.edit();
      const destination = writer.getCell<{
        factory: PatternFactory<unknown, unknown>;
      }>(
        onwardDestinationSpace,
        "verified-source-precedence",
        undefined,
        tx,
      );
      destination.set({ factory: factories[0] });
      writer.prepareTxForCommit(tx);
      expect((await tx.commit().settled).error).toBeUndefined();
    } finally {
      writer.patternManager.prepareArtifactPublication =
        prepareArtifactPublication;
    }

    expect(publication).toEqual({
      identity,
      fromSpace: sourceSpace,
      toSpace: onwardDestinationSpace,
    });
  });

  it("cold-loads private source provenance while keeping the destination write optimistic", async () => {
    const { factories } = await storeFactories();
    const sourceTx = writer.edit();
    const source = writer.getCell<{ factories: FactoryTuple }>(
      sourceSpace,
      "cold-publication-source",
      undefined,
      sourceTx,
    );
    source.set({ factories });
    writer.prepareTxForCommit(sourceTx);
    expect((await sourceTx.commit().settled).error).toBeUndefined();

    const mover = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    extraRuntimes.push(mover);
    const carried = mover.getCell<{ factories: FactoryTuple }>(
      sourceSpace,
      "cold-publication-source",
    ).getRaw()! as unknown as { factories: FactoryTuple };
    const destinationTx = mover.edit();
    const destination = mover.getCell<{ factories: FactoryTuple }>(
      destinationSpace,
      "cold-publication-destination",
      undefined,
      destinationTx,
    );
    destination.set(carried);

    // Source verification is async in this fresh PatternManager, but local
    // speculative visibility is not.
    expect(destination.getRaw()).toEqual(carried);
    expect((await destinationTx.commit().settled).error).toBeUndefined();
    expect(
      mover.patternManager.isArtifactAvailableInSpace(
        sealFactoryState(carried.factories[0]).ref.identity,
        destinationSpace,
      ),
    ).toBe(true);
  });

  it("cold-verifies a Cell-read factory before rewriting it within the same space", async () => {
    const { factories } = await storeFactories();
    const sourceTx = writer.edit();
    const source = writer.getCell<{ factories: FactoryTuple }>(
      sourceSpace,
      "same-space-cold-publication-source",
      undefined,
      sourceTx,
    );
    source.set({ factories });
    writer.prepareTxForCommit(sourceTx);
    expect((await sourceTx.commit().settled).error).toBeUndefined();

    const mover = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    extraRuntimes.push(mover);
    const carried = mover.getCell<{ factories: FactoryTuple }>(
      sourceSpace,
      "same-space-cold-publication-source",
    ).getRaw()! as unknown as { factories: FactoryTuple };
    const destinationTx = mover.edit();
    const destination = mover.getCell<{ factories: FactoryTuple }>(
      sourceSpace,
      "same-space-cold-publication-destination",
      undefined,
      destinationTx,
    );

    expect(() => destination.set(carried)).not.toThrow();
    expect(destination.getRaw()).toEqual(carried);
    expect((await destinationTx.commit().settled).error).toBeUndefined();
    expect(
      mover.patternManager.isArtifactAvailableInSpace(
        sealFactoryState(carried.factories[0]).ref.identity,
        sourceSpace,
      ),
    ).toBe(true);
  });

  it("does not let an unrelated pending rewrite block a durable source copy", async () => {
    const { factories } = await storeFactories();
    const durableTx = writer.edit();
    writer.getCell<{ factories: FactoryTuple }>(
      destinationSpace,
      "durable-source-before-unrelated-rewrite",
      undefined,
      durableTx,
    ).set({ factories });
    expect((await durableTx.commit().settled).error).toBeUndefined();

    const blocker = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    const follower = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    extraRuntimes.push(blocker, follower);

    const blockerValue = blocker.getCell<{ factories: FactoryTuple }>(
      destinationSpace,
      "durable-source-before-unrelated-rewrite",
    ).getRaw()! as unknown as { factories: FactoryTuple };
    const releaseBlocker = Promise.withResolvers<void>();
    const prepareArtifactPublication = blocker.patternManager
      .prepareArtifactPublication.bind(blocker.patternManager);
    blocker.patternManager.prepareArtifactPublication = (async (
      _identity,
      _fromSpace,
      toSpace,
    ) => {
      if (toSpace !== destinationSpace) {
        return prepareArtifactPublication(
          _identity,
          _fromSpace,
          toSpace,
        );
      }
      await releaseBlocker.promise;
      throw new Error("unrelated pending rewrite rejected");
    }) as typeof blocker.patternManager.prepareArtifactPublication;

    const blockerTx = blocker.edit();
    blocker.getCell<{ factories: FactoryTuple }>(
      destinationSpace,
      "unrelated-pending-factory-rewrite",
      undefined,
      blockerTx,
    ).set(blockerValue);
    const blockerCommit = blockerTx.commit().settled;

    const durableValue = follower.getCell<{ factories: FactoryTuple }>(
      destinationSpace,
      "durable-source-before-unrelated-rewrite",
    ).getRaw()! as unknown as { factories: FactoryTuple };
    const followerTx = follower.edit();
    const copied = follower.getCell<{ factories: FactoryTuple }>(
      onwardDestinationSpace,
      "durable-copy-during-unrelated-rewrite",
      undefined,
      followerTx,
    );
    copied.set(durableValue);
    const followerCommit = followerTx.commit().settled;
    // This await is intentionally before releasing the unrelated blocker. If
    // the commits are incorrectly coupled, the in-process test fails fast when
    // the event loop drains rather than relying on a wall-clock timeout.
    const followerResult = await followerCommit;

    releaseBlocker.resolve();
    const blockerResult = await blockerCommit;
    blocker.patternManager.prepareArtifactPublication =
      prepareArtifactPublication;

    expect(blockerResult.error?.message).toContain(
      "unrelated pending rewrite rejected",
    );
    expect(followerResult.error).toBeUndefined();
    expect(copied.getRaw()).toEqual(durableValue);
  });

  it("waits for a speculative source publication before cold-verifying an onward copy", async () => {
    const { factories } = await storeFactories();
    const sourceTx = writer.edit();
    const source = writer.getCell<{ factories: FactoryTuple }>(
      sourceSpace,
      "causal-cold-publication-source",
      undefined,
      sourceTx,
    );
    source.set({ factories });
    writer.prepareTxForCommit(sourceTx);
    expect((await sourceTx.commit().settled).error).toBeUndefined();

    const publisher = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    const follower = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    extraRuntimes.push(publisher, follower);

    const carried = publisher.getCell<{ factories: FactoryTuple }>(
      sourceSpace,
      "causal-cold-publication-source",
    ).getRaw()! as unknown as { factories: FactoryTuple };
    const releaseFirstPreparation = Promise.withResolvers<void>();
    const prepareArtifactPublication = publisher.patternManager
      .prepareArtifactPublication.bind(publisher.patternManager);
    publisher.patternManager.prepareArtifactPublication = ((
      identity,
      fromSpace,
      toSpace,
      sourcePublication,
      onPrepared,
    ) => {
      if (toSpace !== destinationSpace) {
        return prepareArtifactPublication(
          identity,
          fromSpace,
          toSpace,
          sourcePublication,
          onPrepared,
        );
      }
      return releaseFirstPreparation.promise.then(() =>
        prepareArtifactPublication(
          identity,
          fromSpace,
          toSpace,
          sourcePublication,
          onPrepared,
        )
      );
    }) as typeof publisher.patternManager.prepareArtifactPublication;

    const firstTx = publisher.edit();
    const intermediate = publisher.getCell<{ factories: FactoryTuple }>(
      destinationSpace,
      "causal-cold-publication-intermediate",
      undefined,
      firstTx,
    );
    intermediate.set(carried);
    const firstCommit = firstTx.commit().settled;
    expect(intermediate.getRaw()).toEqual(carried);

    const onward = follower.getCell<{ factories: FactoryTuple }>(
      destinationSpace,
      "causal-cold-publication-intermediate",
    ).getRaw()! as unknown as { factories: FactoryTuple };
    const preparationStarted = Promise.withResolvers<void>();
    const followerPrepareArtifactPublication = follower.patternManager
      .prepareArtifactPublication.bind(follower.patternManager);
    follower.patternManager.prepareArtifactPublication = ((
      identity,
      fromSpace,
      toSpace,
      sourcePublication,
      onPrepared,
    ) => {
      if (fromSpace === destinationSpace) preparationStarted.resolve();
      return followerPrepareArtifactPublication(
        identity,
        fromSpace,
        toSpace,
        sourcePublication,
        onPrepared,
      );
    }) as typeof follower.patternManager.prepareArtifactPublication;

    const secondTx = follower.edit();
    const destination = follower.getCell<{ factories: FactoryTuple }>(
      destinationSpace,
      "causal-cold-publication-onward",
      undefined,
      secondTx,
    );
    destination.set(onward);
    const secondCommit = secondTx.commit().settled;
    let secondSettled = false;
    const observedSecondCommit = secondCommit.then((result) => {
      secondSettled = true;
      return result;
    });
    await preparationStarted.promise;
    await Promise.resolve();
    const secondSettledBeforeRelease = secondSettled;

    releaseFirstPreparation.resolve();
    const firstResult = await firstCommit;
    const secondResult = await observedSecondCommit;
    publisher.patternManager.prepareArtifactPublication =
      prepareArtifactPublication;
    follower.patternManager.prepareArtifactPublication =
      followerPrepareArtifactPublication;

    expect(secondSettledBeforeRelease).toBe(false);
    expect(firstResult.error).toBeUndefined();
    expect(secondResult.error).toBeUndefined();
    expect(destination.getRaw()).toEqual(onward);
  });

  it("rejects an onward copy when its speculative source publication fails", async () => {
    const { factories } = await storeFactories();
    const sourceTx = writer.edit();
    const source = writer.getCell<{ factories: FactoryTuple }>(
      sourceSpace,
      "rejected-causal-publication-source",
      undefined,
      sourceTx,
    );
    source.set({ factories });
    writer.prepareTxForCommit(sourceTx);
    expect((await sourceTx.commit().settled).error).toBeUndefined();

    const publisher = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    const follower = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    extraRuntimes.push(publisher, follower);
    const carried = publisher.getCell<{ factories: FactoryTuple }>(
      sourceSpace,
      "rejected-causal-publication-source",
    ).getRaw()! as unknown as { factories: FactoryTuple };

    const releaseRejectedPreparation = Promise.withResolvers<void>();
    const prepareArtifactPublication = publisher.patternManager
      .prepareArtifactPublication.bind(publisher.patternManager);
    publisher.patternManager.prepareArtifactPublication = ((
      identity,
      fromSpace,
      toSpace,
    ) => {
      if (toSpace !== destinationSpace) {
        return prepareArtifactPublication(identity, fromSpace, toSpace);
      }
      return releaseRejectedPreparation.promise.then(() => {
        throw new Error("forced source publication rejection");
      });
    }) as typeof publisher.patternManager.prepareArtifactPublication;

    const firstTx = publisher.edit();
    publisher.getCell<{ factories: FactoryTuple }>(
      destinationSpace,
      "rejected-causal-publication-intermediate",
      undefined,
      firstTx,
    ).set(carried);
    const firstCommit = firstTx.commit().settled;

    const onward = follower.getCell<{ factories: FactoryTuple }>(
      destinationSpace,
      "rejected-causal-publication-intermediate",
    ).getRaw()! as unknown as { factories: FactoryTuple };
    const preparationStarted = Promise.withResolvers<void>();
    const followerPrepareArtifactPublication = follower.patternManager
      .prepareArtifactPublication.bind(follower.patternManager);
    follower.patternManager.prepareArtifactPublication = ((
      identity,
      fromSpace,
      toSpace,
      sourcePublication,
      onPrepared,
    ) => {
      if (fromSpace === destinationSpace) preparationStarted.resolve();
      return followerPrepareArtifactPublication(
        identity,
        fromSpace,
        toSpace,
        sourcePublication,
        onPrepared,
      );
    }) as typeof follower.patternManager.prepareArtifactPublication;

    const secondTx = follower.edit();
    follower.getCell<{ factories: FactoryTuple }>(
      destinationSpace,
      "rejected-causal-publication-onward",
      undefined,
      secondTx,
    ).set(onward);
    const secondCommit = secondTx.commit().settled;
    await preparationStarted.promise;

    releaseRejectedPreparation.resolve();
    const [firstResult, secondResult] = await Promise.all([
      firstCommit,
      secondCommit,
    ]);
    publisher.patternManager.prepareArtifactPublication =
      prepareArtifactPublication;
    follower.patternManager.prepareArtifactPublication =
      followerPrepareArtifactPublication;

    expect(firstResult.error?.message).toContain(
      "forced source publication rejection",
    );
    expect(secondResult.error?.message).toContain(
      "forced source publication rejection",
    );
  });
});

describe("Factory@1 fresh-runtime value round trip", () => {
  it("atomically unions source roots from concurrent direct factory publications", async () => {
    const server = createSharedServer();
    let seedStorage: SharedServerStorageManager | undefined =
      SharedServerStorageManager.connectTo(server, { as: signer });
    let seedRuntime: Runtime | undefined = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: seedStorage,
    });
    let publisherAStorage: SharedServerStorageManager | undefined;
    let publisherBStorage: SharedServerStorageManager | undefined;
    let publisherA: Runtime | undefined;
    let publisherB: Runtime | undefined;
    let readerStorage: SharedServerStorageManager | undefined;
    let reader: Runtime | undefined;

    const factoryProgram: RuntimeProgram = {
      main: "/factory.tsx",
      files: [{
        name: "/factory.tsx",
        contents: [
          "import { pattern } from 'commonfabric';",
          "export default pattern<{ value: number }>(({ value }) => ({ result: value }));",
        ].join("\n"),
      }],
    };
    const rootProgram = (name: string): RuntimeProgram => ({
      main: `/${name}.ts`,
      files: [{
        name: `/${name}.ts`,
        contents: `export const generation = ${JSON.stringify(name)};`,
      }],
    });

    try {
      let entryIdentity: string | undefined;
      const live = await seedRuntime.patternManager.compilePattern(
        factoryProgram,
        {
          space: sourceSpace,
          onEntryIdentity(identity) {
            entryIdentity = identity;
          },
        },
      );
      expect(entryIdentity).toBeDefined();
      const shell = fabricFromJsonValue(
        jsonFromFabricValue(live as unknown as FabricValue),
      ) as PatternFactory<unknown, unknown>;
      const compiledFactory = await seedRuntime.harness.compileToRecordGraph(
        factoryProgram,
      );
      const factoryModule = compiledFactory.modules.find((module) =>
        module.identity === entryIdentity
      )!;
      const rootA = (await seedRuntime.harness.compileToRecordGraph(
        rootProgram("publication-root-a"),
      )).modules[0]!;
      const rootB = (await seedRuntime.harness.compileToRecordGraph(
        rootProgram("publication-root-b"),
      )).modules[0]!;
      expect(rootA.identity).not.toBe(rootB.identity);

      for (
        const [space, root] of [
          [sourceSpace, rootA],
          [destinationSpace, rootB],
        ] as const
      ) {
        const tx = seedRuntime.edit();
        writeSourceDocs(
          seedRuntime,
          space,
          [factoryModule, root],
          entryIdentity!,
          tx,
        );
        expect((await tx.commit().settled).error).toBeUndefined();
      }
      await seedStorage.synced();
      await seedRuntime.dispose();
      seedRuntime = undefined;
      await seedStorage.close();
      seedStorage = undefined;

      publisherAStorage = SharedServerStorageManager.connectTo(server, {
        as: signer,
      });
      publisherBStorage = SharedServerStorageManager.connectTo(server, {
        as: signer,
      });
      publisherA = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: publisherAStorage,
      });
      publisherB = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: publisherBStorage,
      });
      const [factoryA, factoryB] = await Promise.all([
        prepareFactory(shell, {
          runtime: publisherA,
          artifactSpace: sourceSpace,
        }),
        prepareFactory(shell, {
          runtime: publisherB,
          artifactSpace: destinationSpace,
        }),
      ]);

      const txA = publisherA.edit();
      publisherA.getCell(
        onwardDestinationSpace,
        "atomic-publication-topology-a",
        undefined,
        txA,
      ).set({ factory: factoryA });
      const txB = publisherB.edit();
      publisherB.getCell(
        onwardDestinationSpace,
        "atomic-publication-topology-b",
        undefined,
        txB,
      ).set({ factory: factoryB });
      const [commitA, commitB] = await Promise.all([
        txA.commit().settled,
        txB.commit().settled,
      ]);
      expect(commitA.error).toBeUndefined();
      expect(commitB.error).toBeUndefined();
      await Promise.all([
        publisherA.patternManager.flushCompileCacheWrites(),
        publisherB.patternManager.flushCompileCacheWrites(),
      ]);

      await publisherA.dispose();
      publisherA = undefined;
      await publisherAStorage.close();
      publisherAStorage = undefined;
      await publisherB.dispose();
      publisherB = undefined;
      await publisherBStorage.close();
      publisherBStorage = undefined;

      readerStorage = SharedServerStorageManager.connectTo(server, {
        as: signer,
      });
      reader = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: readerStorage,
      });
      const readTx = reader.edit();
      const closure = await loadVerifiedSourceClosure(
        reader,
        onwardDestinationSpace,
        entryIdentity!,
        readTx,
      );
      readTx.abort?.("atomic publication verification complete");
      expect(closure?.has(rootA.identity)).toBe(true);
      expect(closure?.has(rootB.identity)).toBe(true);
      const entryRoots = closure?.get(entryIdentity!)?.roots?.map((root) =>
        root.identity
      );
      expect(entryRoots).toContain(rootA.identity);
      expect(entryRoots).toContain(rootB.identity);

      const materialized = await prepareFactory(shell, {
        runtime: reader,
        artifactSpace: onwardDestinationSpace,
      });
      invokeOne(reader, 0, materialized, onwardDestinationSpace);
      await reader.patternManager.flushCompileCacheWrites();
    } finally {
      await reader?.dispose();
      await readerStorage?.close();
      await publisherA?.dispose();
      await publisherAStorage?.close();
      await publisherB?.dispose();
      await publisherBStorage?.close();
      await seedRuntime?.dispose();
      await seedStorage?.close();
      await server.close();
    }
  });

  it("persists, cold-decodes, materializes, and invokes every factory kind", async () => {
    const server = createSharedServer();
    let writerStorage: SharedServerStorageManager | undefined =
      SharedServerStorageManager.connectTo(server, { as: signer });
    let coldWriter: Runtime | undefined = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: writerStorage,
    });
    let readerStorage: SharedServerStorageManager | undefined;
    let reader: Runtime | undefined;

    try {
      let identity: string | undefined;
      await coldWriter.patternManager.compilePattern(PROGRAM, {
        space: sourceSpace,
        onEntryIdentity(value) {
          identity = value;
        },
      });
      expect(identity).toBeDefined();

      const factories = SYMBOLS.map((symbol) =>
        coldWriter!.patternManager.artifactFromIdentitySync(identity!, symbol)
      ) as unknown as FactoryTuple;
      const values: PersistedFactoryValues = {
        pattern: factories[0],
        module: factories[1],
        handler: factories[2],
      };
      const states = factories.map((factory) => sealFactoryState(factory));
      for (const state of states) {
        expect(state.ref.identity).toBe(identity);
        expect("$implRef" in state).toBe(false);
      }

      const tx = coldWriter.edit();
      const cell = coldWriter.getCell<PersistedFactoryValues>(
        sourceSpace,
        "fresh-runtime persisted factory values",
        undefined,
        tx,
      );
      cell.set(values);
      coldWriter.prepareTxForCommit(tx);
      expect((await tx.commit().settled).error).toBeUndefined();
      await coldWriter.patternManager.flushCompileCacheWrites();
      await writerStorage.synced();

      // End the writer session completely before constructing the reader. The
      // only remaining bridge is the shared server's persisted memory.
      await coldWriter.dispose();
      coldWriter = undefined;
      await writerStorage.close();
      writerStorage = undefined;

      readerStorage = SharedServerStorageManager.connectTo(server, {
        as: signer,
      });
      reader = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: readerStorage,
      });
      for (let index = 0; index < SYMBOLS.length; index++) {
        expect(
          reader.patternManager.artifactFromIdentitySync(
            identity!,
            SYMBOLS[index],
          ),
        ).toBeUndefined();
      }

      const stored = reader.getCell<PersistedFactoryValues>(
        sourceSpace,
        "fresh-runtime persisted factory values",
      );
      await stored.sync();
      const decoded = stored.getRaw() as unknown as PersistedFactoryValues;
      const shells = [
        decoded.pattern,
        decoded.module,
        decoded.handler,
      ] as const satisfies FactoryTuple;
      for (let index = 0; index < shells.length; index++) {
        expect(isAdmittedFabricFactory(shells[index])).toBe(true);
        expect(factoryStateOf(shells[index])).toEqual(states[index]);
        expect(() => shells[index](undefined as never)).toThrow(
          "factory requires runner materialization",
        );
      }

      // Trusted provenance comes from the containing cell, never Factory@1
      // state. This is the exact space the cold artifact loader must query.
      const artifactSpace = stored.getAsNormalizedFullLink().space;
      expect(artifactSpace).toBe(sourceSpace);
      const loads: Array<{
        identity: string;
        symbol: string;
        sourceSpace: MemorySpace;
      }> = [];
      const loadArtifact = reader.patternManager.loadArtifactByIdentity.bind(
        reader.patternManager,
      );
      reader.patternManager.loadArtifactByIdentity = (
        loadedIdentity,
        symbol,
        loadedSourceSpace,
      ) => {
        loads.push({
          identity: loadedIdentity,
          symbol,
          sourceSpace: loadedSourceSpace,
        });
        return loadArtifact(loadedIdentity, symbol, loadedSourceSpace);
      };

      const materialized: MaterializedFactory[] = [];
      for (let index = 0; index < shells.length; index++) {
        const factory = await prepareFactory(shells[index], {
          runtime: reader,
          artifactSpace,
        });
        expect(sealFactoryState(factory)).toEqual(states[index]);
        invokeOne(reader, index, factory, sourceSpace);
        materialized.push(factory);
      }
      expect(loads.length).toBeGreaterThan(0);
      expect(loads.every((load) => load.sourceSpace === sourceSpace)).toBe(
        true,
      );
      expect(loads.every((load) => load.identity === identity)).toBe(true);
      expect(materialized).toHaveLength(3);
    } finally {
      await reader?.dispose();
      await readerStorage?.close();
      await coldWriter?.dispose();
      await writerStorage?.close();
      await server.close();
    }
  });
});

function invokeOne(
  runtime: Runtime,
  index: number,
  factory: MaterializedFactory,
  space: MemorySpace,
): void {
  const frame = pushFrame({
    space,
    generatedIdCounter: 0,
    reactives: new Set(),
    runtime,
  });
  try {
    const inputs = [{ value: 1 }, 1, { prefix: "x" }] as const;
    expect(() => factory(inputs[index] as never)).not.toThrow();
  } finally {
    popFrame(frame);
  }
}
