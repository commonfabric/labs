import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { PiecesController } from "@commonfabric/piece/ops";
import { type Cell, Runtime } from "@commonfabric/runner";
import { loadPieces } from "../lib/piece.ts";
import { withEnv } from "./utils.ts";

describe("CLI runtime creation", () => {
  it("applies deployed-client options to the piece-manager runtime", async () => {
    const identity = await Identity.fromPassphrase(
      "piece runtime creation test",
      { implementation: "noble" },
    );
    const keyPath = await Deno.makeTempFile();
    await Deno.writeFile(keyPath, identity.toPkcs8());
    const originalHealthCheck = Runtime.prototype.healthCheck;
    let created: Runtime | undefined;
    Runtime.prototype.healthCheck = function () {
      created = this;
      return Promise.resolve(false);
    };

    await withEnv(
      "EXPERIMENTAL_CONTENT_ADDRESSED_SCHEMAS",
      "false",
      async () => {
        try {
          await expect(loadPieces({
            apiUrl: "https://toolshed.test",
            identity: keyPath,
            space: "piece-runtime-creation",
          })).rejects.toThrow("Could not connect");
          expect(created?.apiUrl.href).toBe("https://toolshed.test/");
          expect(created?.experimental.contentAddressedSchemas).toBe(false);

          const output: unknown[][] = [];
          const originalLog = console.log;
          console.log = (...args: unknown[]) => output.push(args);
          try {
            created!.navigateCallback!({
              entityId: { "/": "fid1:cli-navigation-target" },
            } as unknown as Cell<unknown>);
          } finally {
            console.log = originalLog;
          }
          expect(output).toEqual([
            ["navigateTo new piece id fid1:cli-navigation-target"],
          ]);
        } finally {
          Runtime.prototype.healthCheck = originalHealthCheck;
          await Deno.remove(keyPath);
        }
      },
    );
  });

  it("does not register navigation targets", async () => {
    const identity = await Identity.fromPassphrase(
      "piece navigation registration test",
      { implementation: "noble" },
    );
    const keyPath = await Deno.makeTempFile();
    await Deno.writeFile(keyPath, identity.toPkcs8());
    const originalHealthCheck = Runtime.prototype.healthCheck;
    const originalGetSpaceCell = Runtime.prototype.getSpaceCell;
    const originalEnsureSpaceSession =
      PiecesController.prototype.ensureSpaceSession;
    const originalSynced = PiecesController.prototype.synced;
    let manager: PiecesController | undefined;
    Runtime.prototype.healthCheck = () => Promise.resolve(true);
    Runtime.prototype.getSpaceCell = function () {
      return { sync: () => Promise.resolve() } as any;
    };
    PiecesController.prototype.ensureSpaceSession = () => Promise.resolve();
    PiecesController.prototype.synced = () => Promise.resolve();

    try {
      manager = await loadPieces({
        apiUrl: "https://toolshed.test",
        identity: keyPath,
        space: "piece-navigation-registration",
      });
      let navigationTask = Promise.resolve<unknown>(undefined);
      let registryReads = 0;
      let registryWrites = 0;
      Reflect.set(manager.runtime.storageManager, "synced", () => ({
        then: (onFulfilled: () => unknown) => {
          navigationTask = Promise.resolve(onFulfilled());
          return navigationTask;
        },
      }));
      manager.getPieceRegistry = (() => {
        registryReads++;
        return Promise.resolve({ get: () => [] });
      }) as unknown as typeof manager.getPieceRegistry;
      manager.add = (() => {
        registryWrites++;
        return Promise.resolve();
      }) as typeof manager.add;

      const originalLog = console.log;
      console.log = () => {};
      try {
        manager.runtime.navigateCallback!({
          entityId: { "/": "fid1:cli-navigation-target" },
        } as unknown as Cell<unknown>);
        await navigationTask;
      } finally {
        console.log = originalLog;
      }
      expect(registryReads).toBe(0);
      expect(registryWrites).toBe(0);
    } finally {
      Runtime.prototype.healthCheck = originalHealthCheck;
      Runtime.prototype.getSpaceCell = originalGetSpaceCell;
      PiecesController.prototype.ensureSpaceSession =
        originalEnsureSpaceSession;
      PiecesController.prototype.synced = originalSynced;
      if (manager) {
        await (manager.runtime.storageManager as unknown as {
          closeNow(): Promise<void>;
        }).closeNow();
        await manager.runtime.dispose();
      }
      await Deno.remove(keyPath);
    }
  });

  it("defers the space cell by default and admits an eager override", async () => {
    const identity = await Identity.fromPassphrase(
      "piece manager deferred sync test",
      { implementation: "noble" },
    );
    const keyPath = await Deno.makeTempFile();
    await Deno.writeFile(keyPath, identity.toPkcs8());

    const originalHealthCheck = Runtime.prototype.healthCheck;
    const originalGetSpaceCell = Runtime.prototype.getSpaceCell;
    const originalEnsureSpaceSession =
      PiecesController.prototype.ensureSpaceSession;
    const originalManagerSynced = PiecesController.prototype.synced;
    const managers: PiecesController[] = [];
    let spaceCellSyncCalls = 0;
    let spaceSessionCalls = 0;
    let managerSyncCalls = 0;

    Runtime.prototype.healthCheck = () => Promise.resolve(true);
    Runtime.prototype.getSpaceCell = function () {
      return {
        sync: () => {
          spaceCellSyncCalls++;
          return Promise.resolve();
        },
      } as any;
    };
    PiecesController.prototype.synced = () => {
      managerSyncCalls++;
      return Promise.resolve();
    };
    PiecesController.prototype.ensureSpaceSession = () => {
      spaceSessionCalls++;
      return Promise.resolve();
    };

    try {
      managers.push(
        await loadPieces({
          apiUrl: "https://toolshed.test",
          identity: keyPath,
          space: "piece-manager-deferred-sync",
        }),
      );
      expect(spaceCellSyncCalls).toBe(0);
      expect(spaceSessionCalls).toBe(1);
      expect(managerSyncCalls).toBe(0);

      managers.push(
        await loadPieces({
          apiUrl: "https://toolshed.test",
          identity: keyPath,
          space: "piece-manager-eager-sync",
          deferSpaceCellSync: false,
        }),
      );
      expect(spaceCellSyncCalls).toBe(1);
      expect(spaceSessionCalls).toBe(1);
      expect(managerSyncCalls).toBe(1);
    } finally {
      Runtime.prototype.healthCheck = originalHealthCheck;
      Runtime.prototype.getSpaceCell = originalGetSpaceCell;
      PiecesController.prototype.ensureSpaceSession =
        originalEnsureSpaceSession;
      PiecesController.prototype.synced = originalManagerSynced;
      for (const manager of managers) {
        await (manager.runtime.storageManager as unknown as {
          closeNow(): Promise<void>;
        }).closeNow();
        await manager.runtime.dispose();
      }
      await Deno.remove(keyPath);
    }
  });
});
