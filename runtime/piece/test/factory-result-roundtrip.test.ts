import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import type { FabricValue } from "@commonfabric/data-model";
import {
  factoryStateOf,
  type FactoryStateV1,
  isAdmittedFabricFactory,
  sealFactoryState,
} from "@commonfabric/data-model/fabric-factory";
import { createSession, Identity } from "@commonfabric/identity";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";
import {
  type MemorySpace,
  popFrame,
  pushFrame,
  Runtime,
  type RuntimeProgram,
} from "@commonfabric/runner";

import { EmulatedStorageManager } from "../../runner/src/storage/v2-emulate.ts";
import { newSharedServer } from "../../runner/test/memory-v2-test-utils.ts";
import { prepareFactory } from "../../runner/src/factory-materialization.ts";
import { PiecesController } from "../src/ops/pieces-controller.ts";
import { pieceId } from "../src/piece-id.ts";

const signer = await Identity.fromPassphrase(
  "piece factory result round trip",
);

const FACTORY_RESULT_PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "import { handler, lift, pattern, type HandlerFactory } from 'commonfabric';",
      "export const patternFactory = pattern<{ value: number }, { result: number }>(({ value }) => ({ result: value }));",
      "export const moduleFactory = lift((value: number): number => value + 1);",
      "export const handlerFactory: HandlerFactory<number, { prefix: string }> = handler(",
      "  { type: 'number' },",
      "  { type: 'object', properties: { prefix: { type: 'string' } }, required: ['prefix'] },",
      "  (_event: number, _context: { prefix: string }) => undefined,",
      ");",
      "export default pattern(() => ({",
      "  nested: {",
      "    pattern: patternFactory,",
      "    module: moduleFactory,",
      "    handler: handlerFactory,",
      "  },",
      "}));",
    ].join("\n"),
  }],
};

const FACTORY_SYMBOLS = [
  "patternFactory",
  "moduleFactory",
  "handlerFactory",
] as const;
const FACTORY_KINDS = ["pattern", "module", "handler"] as const;

type StoredFactoryResult = {
  nested: {
    pattern: FabricValue;
    module: FabricValue;
    handler: FabricValue;
  };
};

type FactoryResultSchema = {
  properties?: {
    nested?: {
      properties?: Record<
        string,
        { asFactory?: { kind?: unknown } }
      >;
    };
  };
};

function createSharedServer(): MemoryV2Server.Server {
  return newSharedServer();
}

function resultFactories(result: StoredFactoryResult): FabricValue[] {
  return [
    result.nested.pattern,
    result.nested.module,
    result.nested.handler,
  ];
}

function expectInertFactory(
  value: FabricValue,
  expectedState: FactoryStateV1,
): void {
  expect(isAdmittedFabricFactory(value)).toBe(true);
  expect(factoryStateOf(value)).toEqual(expectedState);
  expect(Object.isFrozen(value)).toBe(true);
  expect(() => (value as unknown as () => unknown)()).toThrow(
    "factory requires runner materialization",
  );
}

function invokeFactories(
  runtime: Runtime,
  space: MemorySpace,
  factories: unknown[],
): void {
  const frame = pushFrame({
    space,
    generatedIdCounter: 0,
    reactives: new Set(),
    runtime,
  });
  try {
    (factories[0] as unknown as (value: { value: number }) => unknown)({
      value: 1,
    });
    (factories[1] as unknown as (value: number) => unknown)(1);
    (factories[2] as unknown as (value: { prefix: string }) => unknown)({
      prefix: "piece-result",
    });
  } finally {
    popFrame(frame);
  }
}

describe("PiecesController Factory@1 result persistence", () => {
  it("round-trips nested factories through a fresh runner runtime", async () => {
    const server = createSharedServer();
    let writerStorage: EmulatedStorageManager | undefined =
      EmulatedStorageManager.connectTo(server, { as: signer });
    let writerRuntime: Runtime | undefined = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: writerStorage,
    });
    let readerStorage: EmulatedStorageManager | undefined;
    let readerRuntime: Runtime | undefined;

    try {
      const spaceName = `piece-factory-result-${crypto.randomUUID()}`;
      const writerSession = createSession({
        identity: signer,
        spaceDid: signer.did(),
      });
      const writerManager = new PiecesController(
        writerSession,
        writerRuntime,
        { spaceName },
      );
      await writerManager.synced();

      let identity: string | undefined;
      const pattern = await writerRuntime.patternManager.compilePattern(
        FACTORY_RESULT_PROGRAM,
        {
          space: writerManager.getSpace(),
          onEntryIdentity(value) {
            identity = value;
          },
        },
      );
      expect(identity).toBeDefined();

      const resultSchema = pattern.resultSchema as FactoryResultSchema;
      for (let index = 0; index < FACTORY_KINDS.length; index++) {
        const kind = FACTORY_KINDS[index];
        expect(
          resultSchema.properties?.nested?.properties?.[kind]?.asFactory?.kind,
        ).toBe(kind);
      }

      const expectedStates = FACTORY_SYMBOLS.map((symbol) => {
        const factory = writerRuntime!.patternManager
          .artifactFromIdentitySync(identity!, symbol);
        expect(factory).toBeDefined();
        return sealFactoryState(factory);
      });
      await writerRuntime.patternManager.flushCompileCacheWrites();
      for (const state of expectedStates) {
        expect(
          writerRuntime.patternManager.isArtifactAvailableInSpace(
            state.ref.identity,
            writerManager.getSpace(),
          ),
        ).toBe(true);
      }

      const piece = await writerManager.runPersistent<StoredFactoryResult>(
        pattern,
        {},
        "piece-factory-result-roundtrip",
        { start: false },
      );
      const id = pieceId(piece);
      expect(id).toBeDefined();
      await writerManager.synced();
      await writerStorage.synced();

      await writerRuntime.dispose();
      writerRuntime = undefined;
      await writerStorage.close();
      writerStorage = undefined;

      readerStorage = EmulatedStorageManager.connectTo(server, {
        as: signer,
      });
      readerRuntime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: readerStorage,
      });
      const readerSession = createSession({
        identity: signer,
        spaceDid: signer.did(),
      });
      const readerManager = new PiecesController(
        readerSession,
        readerRuntime,
        { spaceName },
      );
      await readerManager.synced();

      for (const symbol of FACTORY_SYMBOLS) {
        expect(
          readerRuntime.patternManager.artifactFromIdentitySync(
            identity!,
            symbol,
          ),
        ).toBeUndefined();
      }

      // Updating an input settles the whole result after the commit. That
      // runner-owned pull must preserve cold Factory@1 atoms: no authored
      // callback receives the result, and executable exposure remains the
      // explicit prepareFactory boundary below.
      const freshController = await readerManager.get(id!, false);
      await freshController.input.set({});
      for (const symbol of FACTORY_SYMBOLS) {
        expect(
          readerRuntime.patternManager.artifactFromIdentitySync(
            identity!,
            symbol,
          ),
        ).toBeUndefined();
      }

      // JSON and inspection callers need the current value, not executable
      // callbacks. Their explicit inert read must work from a cold runtime
      // without loading the factory artifact.
      await expect(freshController.result.get(["missing"], {
        materializeFactories: false,
      })).rejects.toThrow("Available keys: nested");
      const inspectedResult = await freshController.result.get(undefined, {
        materializeFactories: false,
      }) as StoredFactoryResult;
      for (let index = 0; index < FACTORY_SYMBOLS.length; index++) {
        expectInertFactory(
          resultFactories(inspectedResult)[index],
          expectedStates[index],
        );
      }
      for (const symbol of FACTORY_SYMBOLS) {
        expect(
          readerRuntime.patternManager.artifactFromIdentitySync(
            identity!,
            symbol,
          ),
        ).toBeUndefined();
      }

      const freshPiece = await readerManager.getPieceCell<StoredFactoryResult>(
        id!,
      );
      const rawResult = freshPiece.resolveAsCell().getRaw() as
        | StoredFactoryResult
        | undefined;
      expect(rawResult).toBeDefined();
      const rawFactories = resultFactories(rawResult!);
      for (let index = 0; index < rawFactories.length; index++) {
        expectInertFactory(rawFactories[index], expectedStates[index]);
      }

      const exposedFactories = await Promise.all(
        rawFactories.map((factory) =>
          prepareFactory(factory, {
            runtime: readerRuntime!,
            artifactSpace: readerManager.getSpace(),
          })
        ),
      );
      expect(
        readerRuntime.patternManager.isArtifactAvailableInSpace(
          identity!,
          readerManager.getSpace(),
        ),
      ).toBe(true);
      for (const symbol of FACTORY_SYMBOLS) {
        expect(
          readerRuntime.patternManager.artifactFromIdentitySync(
            identity!,
            symbol,
          ),
        ).toBeDefined();
      }
      for (let index = 0; index < exposedFactories.length; index++) {
        expect(isAdmittedFabricFactory(exposedFactories[index])).toBe(true);
        expect(sealFactoryState(exposedFactories[index])).toEqual(
          expectedStates[index],
        );
        expect(exposedFactories[index]).not.toBe(rawFactories[index]);
        expect(exposedFactories[index]).toBe(
          readerRuntime.patternManager.artifactFromIdentitySync(
            identity!,
            FACTORY_SYMBOLS[index],
          ),
        );
      }
      invokeFactories(
        readerRuntime,
        readerManager.getSpace(),
        exposedFactories,
      );
    } finally {
      await readerRuntime?.dispose();
      await readerStorage?.close();
      await writerRuntime?.dispose();
      await writerStorage?.close();
    }
  });
});
