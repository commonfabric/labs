import {
  factoryStateOf,
  isAdmittedFabricFactory,
} from "@commonfabric/data-model/fabric-factory";
import { Identity } from "@commonfabric/identity";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";
import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import type { Cell } from "../src/builder/types.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import {
  areNormalizedLinksSame,
  getMetaLink,
  parseLink,
} from "../src/link-utils.ts";
import { Runtime } from "../src/runtime.ts";
import {
  collectExternalSchemaRefHashes,
  parseExternalSchemaRef,
} from "@commonfabric/data-model-schema/schema-refs";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import type { Options } from "../src/storage/v2.ts";
import { TEST_MEMORY_SERVER_AUTH } from "./memory-v2-test-utils.ts";

const signer = await Identity.fromPassphrase(
  "pattern closure params cold resume",
);
const space = signer.did();

const PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "import { lift, pattern } from 'commonfabric';",
      "const observe = lift(({ value, offset }: { value: number; offset?: number }) => {",
      "  return {",
      "    value,",
      "    activeOffset: offset ?? -1,",
      "    sum: value + (offset ?? 0),",
      "  };",
      "});",
      "export default pattern<{ value: number; offset: number }>(({ value, offset }) => ({",
      "  child: pattern<{ value: number }>(({ value }) => observe({ value, offset }))({ value }),",
      "}));",
    ].join("\n"),
  }],
};

class SharedServerStorageManager extends EmulatedStorageManager {
  afterCellSync?: (cell: Cell<unknown>) => Promise<void> | void;

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

  override async syncCell<T>(
    cell: Cell<T>,
    options?: Parameters<EmulatedStorageManager["syncCell"]>[1],
  ): Promise<Cell<T>> {
    const synced = await super.syncCell(cell, options);
    await this.afterCellSync?.(cell);
    return synced;
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

function owningResultCell(runtime: Runtime, projected: Cell<unknown>) {
  const ownerLink = getMetaLink(projected, "result");
  if (ownerLink === undefined) return projected;
  const { overwrite: _, ...ownerTarget } = ownerLink;
  return runtime.getCellFromLink(ownerTarget);
}

describe("invocation-owned pattern params cold resume", () => {
  it("pre-syncs the persisted params cell before resuming the base pattern", async () => {
    const server = createSharedServer();
    let storage: SharedServerStorageManager | undefined;
    let runtime: Runtime | undefined;

    try {
      storage = SharedServerStorageManager.connectTo(server, { as: signer });
      runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: storage,
      });

      const compiled = await runtime.patternManager.compilePattern(PROGRAM, {
        space,
      });
      const canonicalNode = compiled.nodes.find((node) =>
        isAdmittedFabricFactory(node.module)
      );
      expect(canonicalNode).toBeDefined();
      const state = factoryStateOf(canonicalNode!.module);
      expect(state.kind).toBe("pattern");
      if (state.kind !== "pattern") throw new Error("expected pattern state");
      const baseRef = state.ref;
      expect(baseRef).toBeDefined();
      if (baseRef === undefined) throw new Error("expected durable base ref");
      expect(state.params).toMatchObject({
        offset: { $alias: { cell: "argument", path: ["offset"] } },
      });

      const tx = runtime.edit();
      const root = runtime.getCell(
        space,
        "pattern closure params cold resume result",
        compiled.resultSchema,
        tx,
      );
      const result = runtime.run(
        tx,
        compiled,
        { value: 3, offset: 7 },
        root,
      );
      runtime.prepareTxForCommit(tx);
      expect((await tx.commit().settled).error).toBeUndefined();
      expect(await result.key("child").pull()).toEqual({
        value: 3,
        activeOffset: 7,
        sum: 10,
      });
      await runtime.idle();

      const rootArgumentLink = getMetaLink(result, "argument")!;
      const rootLink = result.getAsNormalizedFullLink();
      const child = owningResultCell(
        runtime,
        result.key("child").resolveAsCell() as Cell<unknown>,
      );
      const childLink = child.getAsNormalizedFullLink();
      const paramsLink = getMetaLink(child, "params")!;
      expect(child.getMetaRaw("patternIdentity")).toEqual(baseRef);

      const paramsCell = runtime.getCellFromLink(paramsLink);
      const capturedLink = parseLink(
        (paramsCell.getRaw() as { offset: unknown }).offset,
        paramsCell,
      );
      expect(capturedLink).toMatchObject({
        space: rootArgumentLink.space,
        id: rootArgumentLink.id,
        path: ["offset"],
        scope: rootArgumentLink.scope,
      });

      await runtime.patternManager.flushCompileCacheWrites();
      await storage.synced();
      const rootArgumentSchemaRef = (rootArgumentLink.schema as {
        $ref?: string;
      } | undefined)?.$ref;
      expect(rootArgumentSchemaRef).toBeDefined();
      const rootArgumentSchemaHash = parseExternalSchemaRef(
        rootArgumentSchemaRef!,
      )?.taggedHash;
      expect(rootArgumentSchemaHash).toBeDefined();
      expect(
        storage.isContentAddressedDocPersisted(
          space,
          rootArgumentSchemaHash!,
        ),
      )
        .toBe(true);
      const paramsSchemaRef = (paramsLink.schema as {
        $ref?: string;
      } | undefined)?.$ref;
      expect(paramsSchemaRef).toBeDefined();
      const paramsSchemaHash = parseExternalSchemaRef(paramsSchemaRef!)
        ?.taggedHash;
      expect(paramsSchemaHash).toBeDefined();
      expect(
        storage.isContentAddressedDocPersisted(space, paramsSchemaHash!),
      ).toBe(true);
      const linkSchemaHashes = new Set([
        ...collectExternalSchemaRefHashes(rootArgumentLink.schema!),
        ...collectExternalSchemaRefHashes(paramsLink.schema!),
      ]);
      expect(
        [...linkSchemaHashes].filter((hash) =>
          !storage!.isContentAddressedDocPersisted(space, hash)
        ),
      ).toEqual([]);
      runtime.runner.stop(root);
      await runtime.dispose();
      runtime = undefined;
      await storage.close();
      storage = undefined;

      // Mutate only the link target while no runner is alive. The persisted
      // params document still contains the symbolic link written by curry.
      storage = SharedServerStorageManager.connectTo(server, { as: signer });
      runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: storage,
      });
      const argument = runtime.getCellFromLink(rootArgumentLink);
      await argument.sync();
      const updateTx = runtime.edit();
      runtime.getCellFromLink(rootArgumentLink, undefined, updateTx).set({
        value: 3,
        offset: 11,
      });
      runtime.prepareTxForCommit(updateTx);
      expect((await updateTx.commit().settled).error).toBeUndefined();
      await storage.synced();
      await runtime.dispose();
      runtime = undefined;
      await storage.close();
      storage = undefined;

      // A third storage client has neither the writer's replica nor its warm
      // artifact index. Resume the containing pattern: its canonical bound
      // factory node must discover and pre-sync the child's params cell before
      // subscribing any child node.
      storage = SharedServerStorageManager.connectTo(server, { as: signer });
      runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: storage,
      });
      expect(
        runtime.patternManager.artifactFromIdentitySync(
          baseRef.identity,
          baseRef.symbol,
        ),
      ).toBeUndefined();

      const resumedRoot = runtime.getCellFromLink(rootLink);
      await resumedRoot.sync();

      const paramsSyncObserved = Promise.withResolvers<void>();
      const releaseParamsSync = Promise.withResolvers<void>();
      let paramsSyncReleased = false;
      let nodeSubscribedBeforeParamsSyncReleased = false;
      let startReturnedBeforeParamsSyncReleased = false;
      const originalSubscribe = runtime.scheduler.subscribe.bind(
        runtime.scheduler,
      );
      runtime.scheduler.subscribe = ((...args: unknown[]) => {
        if (!paramsSyncReleased) {
          nodeSubscribedBeforeParamsSyncReleased = true;
        }
        return (originalSubscribe as (...args: unknown[]) => () => void)(
          ...args,
        );
      }) as typeof runtime.scheduler.subscribe;
      storage.afterCellSync = async (cell) => {
        if (
          !areNormalizedLinksSame(cell.getAsNormalizedFullLink(), paramsLink)
        ) {
          return;
        }
        paramsSyncObserved.resolve();
        if (!paramsSyncReleased) await releaseParamsSync.promise;
      };

      try {
        const start = runtime.start(resumedRoot);
        void start.then(() => {
          if (!paramsSyncReleased) {
            startReturnedBeforeParamsSyncReleased = true;
          }
        });
        await paramsSyncObserved.promise;
        await Promise.resolve();
        expect(nodeSubscribedBeforeParamsSyncReleased).toBe(false);
        expect(startReturnedBeforeParamsSyncReleased).toBe(false);
        paramsSyncReleased = true;
        releaseParamsSync.resolve();
        expect(await start).toBe(true);
      } finally {
        paramsSyncReleased = true;
        releaseParamsSync.resolve();
        storage.afterCellSync = undefined;
        runtime.scheduler.subscribe = originalSubscribe;
      }

      expect(await resumedRoot.key("child").pull()).toEqual({
        value: 3,
        activeOffset: 11,
        sum: 14,
      });
      await runtime.idle();

      const resumedChild = owningResultCell(
        runtime,
        resumedRoot.key("child").resolveAsCell() as Cell<unknown>,
      );
      expect(areNormalizedLinksSame(
        resumedChild.getAsNormalizedFullLink(),
        childLink,
      )).toBe(true);
      expect(resumedChild.getMetaRaw("patternIdentity")).toEqual(baseRef);
      const resumedParamsLink = getMetaLink(resumedChild, "params")!;
      expect(areNormalizedLinksSame(resumedParamsLink, paramsLink)).toBe(true);
      const resumedParams = runtime.getCellFromLink(resumedParamsLink);
      const resumedCapture = parseLink(
        (resumedParams.getRaw() as { offset: unknown }).offset,
        resumedParams,
      );
      expect(resumedCapture).toMatchObject({
        space: rootArgumentLink.space,
        id: rootArgumentLink.id,
        path: ["offset"],
        scope: rootArgumentLink.scope,
      });
    } finally {
      await runtime?.dispose();
      await storage?.close();
      await server.close();
    }
  });
});
