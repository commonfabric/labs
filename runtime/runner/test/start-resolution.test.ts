import { stub } from "@std/testing/mock";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import {
  resetServerExecutionConfig,
  setServerExecutionConfig,
} from "@commonfabric/memory/v2";
import type * as MemoryV2Server from "@commonfabric/memory/v2/server";
import {
  afterEach,
  beforeEach,
  describe,
  it,
} from "@commonfabric/test-support/test";

import type { Pattern } from "../src/builder/types.ts";
import type { Cell } from "../src/cell.ts";
import { rawMetaWriteAuthorization } from "../src/meta-seam.ts";
import { getPatternIdentityRef } from "../src/runner.ts";
import { Runtime } from "../src/runtime.ts";
import { entityKey } from "../src/scheduler/keys.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";

const signer = await Identity.fromPassphrase("start resolution");
const space = signer.did();

describe("start()", () => {
  let server: MemoryV2Server.Server;
  const runtimes: { runtime: Runtime; storage: EmulatedStorageManager }[] = [];
  let runtime: Runtime;

  // Each runtime has a replica of its own, so a document one runtime wrote
  // has to be loaded by another before that one can read it.
  const newRuntime = (): Runtime => {
    const storage = EmulatedStorageManager.connectTo(server, { as: signer });
    const created = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage,
    });
    runtimes.push({ runtime: created, storage });
    return created;
  };

  beforeEach(() => {
    server = newSharedServer();
    runtime = newRuntime();
  });

  afterEach(async () => {
    for (const { runtime, storage } of runtimes.splice(0)) {
      await runtime.dispose();
      await storage.close();
    }
    await server.close();
  });

  const key = (cell: Cell<unknown>) =>
    entityKey(cell.getAsNormalizedFullLink(), runtime.scopeKeyIdentity);

  // Writes a link to `target` as the whole value of the document `name`.
  const storeLink = async (
    writer: Runtime,
    name: string,
    target: Cell<unknown>,
  ): Promise<void> => {
    const tx = writer.edit();
    writer.getCell(space, name, undefined, tx).setRaw(target.getAsLink());
    expect((await tx.commit().settled).error).toBeUndefined();
  };

  // A piece whose compiled pattern reports `marker`, which this runtime ran
  // and then stopped.
  const stoppedPiece = async (
    name: string,
    marker = "first",
  ): Promise<{ cell: Cell<{ marker: string }>; pattern: Pattern }> => {
    const pattern = await runtime.patternManager.compilePattern({
      main: "/main.tsx",
      files: [{
        name: "/main.tsx",
        contents: [
          "import { pattern } from 'commonfabric';",
          "export default pattern<Record<string, never>, { marker: string }>(",
          `  () => ({ marker: ${JSON.stringify(marker)} }),`,
          ");",
          "",
        ].join("\n"),
      }],
    }, { space });
    const cell = runtime.getCell<{ marker: string }>(space, name);
    await runtime.runSynced(cell, pattern, {});
    await runtime.idle();
    runtime.runner.stop(cell);
    return { cell, pattern };
  };

  describe("a document it has to load first", () => {
    it("resolves to `false` when the document is stopped while it loads", async () => {
      const empty = runtime.getCell(space, "stopped while loading");
      const started = runtime.runner.start(empty);
      runtime.runner.stop(empty);
      expect(await started).toBe(false);
    });

    it("rejects when the loaded document holds nothing and nothing stopped it", async () => {
      const empty = runtime.getCell(space, "loaded empty");
      await expect(runtime.runner.start(empty)).rejects.toThrow(
        "No data at cell",
      );
    });
  });

  describe("a field whose document cannot be looked up", () => {
    it("rejects with the lookup's error, and a later start makes an attempt of its own", async () => {
      const field = runtime.getCell<{ field: unknown }>(space, "lookup throws")
        .key("field");
      const lookupFailure = new Error("lookup failed");
      const getCellFromLink = stub(runtime, "getCellFromLink", () => {
        throw lookupFailure;
      });
      let started: Promise<boolean>;
      try {
        started = runtime.runner.start(field);
      } finally {
        getCellFromLink.restore();
      }
      await expect(started).rejects.toBe(lookupFailure);

      // The failed attempt is finished, so this start does not join it.
      await expect(runtime.runner.start(field)).rejects.toThrow(
        "No data at cell",
      );
    });
  });

  describe("a document holding a link", () => {
    it("rejects when the links lead back to a document already followed", async () => {
      const first = runtime.getCell(space, "circular first");
      const second = runtime.getCell(space, "circular second");
      await storeLink(runtime, "circular first", second);
      await storeLink(runtime, "circular second", first);
      await expect(runtime.runner.start(first)).rejects.toThrow(
        "Circular link detected",
      );
    });

    it("resolves to `false` when the link's target is stopped before the link loads", async () => {
      // The link is written by another runtime, so this one learns where it
      // leads only once its load lands, after the stop.

      const target = runtime.getCell(space, "stopped link target");
      await storeLink(newRuntime(), "link to a stopped target", target);
      const link = runtime.getCell(space, "link to a stopped target");
      const started = runtime.runner.start(link);
      runtime.runner.stop(target);
      expect(await started).toBe(false);
    });

    it("follows the loaded link to its target when another document was stopped", async () => {
      const target = runtime.getCell(space, "followed link target");
      await storeLink(newRuntime(), "link to a followed target", target);
      const link = runtime.getCell(space, "link to a followed target");
      const started = runtime.runner.start(link);
      runtime.runner.stop(runtime.getCell(space, "an unrelated document"));
      // The target holds nothing, which only a start that reached it reports.
      await expect(started).rejects.toThrow("No data at cell");
    });

    describe("to a piece in a space under view replication", () => {
      // A web client under server execution starts a piece in a space whose
      // view replication is active by reporting whether it already runs. The
      // link is written by another runtime, and the client's load of it is
      // held, so the target is in place before the start reaches it.

      const startThroughLink = async (
        beforeTheLinkLoads: (viewer: Runtime, target: Cell<unknown>) => unknown,
      ) => {
        setServerExecutionConfig(true);
        try {
          const storage = EmulatedStorageManager.connectTo(server, {
            as: signer,
          });
          const viewer = new Runtime({
            apiUrl: new URL(import.meta.url),
            storageManager: storage,
            clientClass: "web",
            experimental: {
              serverExecution: true,
              viewScopedReplication: true,
            },
          });
          runtimes.push({ runtime: viewer, storage });
          const viewSpace = (await Identity.fromPassphrase("view space"))
            .did();
          const pattern = await viewer.patternManager.compilePattern({
            main: "/main.tsx",
            files: [{
              name: "/main.tsx",
              contents: [
                "import { pattern } from 'commonfabric';",
                "export default pattern<Record<string, never>, { marker: string }>(",
                "  () => ({ marker: 'running' }),",
                ");",
                "",
              ].join("\n"),
            }],
          }, { space: viewSpace });
          const target = viewer.getCell(viewSpace, "view-replicated target");
          await viewer.runSynced(target, pattern, {});
          await viewer.idle();
          await storeLink(
            newRuntime(),
            "link to a view-replicated piece",
            target,
          );
          const link = viewer.getCell(space, "link to a view-replicated piece");

          const loading = Promise.withResolvers<void>();
          const load = Promise.withResolvers<void>();
          const syncCell = storage.syncCell.bind(storage);
          using _sync = stub(storage, "syncCell", async (cell, ...args) => {
            if (cell.equals(link)) {
              loading.resolve();
              await load.promise;
            }
            return await syncCell(cell, ...args);
          });
          const started = viewer.runner.start(link);
          await loading.promise;
          await beforeTheLinkLoads(viewer, target);
          expect(await viewer.viewReplication.enable(viewSpace)).toBe(true);
          load.resolve();
          return {
            started: await started,
            running: viewer.runner.isRunning(target),
          };
        } finally {
          resetServerExecutionConfig();
        }
      };

      it("resolves to `true` when the piece runs", async () => {
        expect(await startThroughLink(() => {})).toEqual({
          started: true,
          running: true,
        });
      });

      it("resolves to `false` when the piece is stopped and started again while the link loads", async () => {
        expect(
          await startThroughLink(async (viewer, target) => {
            viewer.runner.stop(target);
            expect(await viewer.runner.start(target)).toBe(true);
          }),
        ).toEqual({ started: false, running: true });
      });
    });
  });

  describe("a pattern it has to load first", () => {
    // The piece's pattern is withheld from the runtime's in-memory index for
    // one lookup, so the start loads it, and the load is held until the case
    // releases it.

    const holdPatternLoad = (pattern: Pattern) => {
      const manager = runtime.patternManager;
      const lookup = manager.artifactFromIdentitySyncInSpace.bind(manager);
      let withheld = false;
      const lookups = stub(
        manager,
        "artifactFromIdentitySyncInSpace",
        (identity, symbol, inSpace) => {
          if (withheld) return lookup(identity, symbol, inSpace);
          withheld = true;
          return undefined;
        },
      );
      const load = Promise.withResolvers<void>();
      const loads = stub(manager, "loadPatternByIdentity", async () => {
        await load.promise;
        return pattern;
      });
      return {
        release: () => load.resolve(),
        loads: () => loads.calls.length,
        [Symbol.dispose]: () => {
          lookups.restore();
          loads.restore();
        },
      };
    };

    it("resolves to `false` when the piece is stopped while its pattern loads", async () => {
      const { cell, pattern } = await stoppedPiece(
        "stopped while its pattern loads",
      );
      using held = holdPatternLoad(pattern);
      const started = runtime.runner.start(cell);
      runtime.runner.stop(cell);
      held.release();
      expect(await started).toBe(false);
      expect(held.loads()).toBe(1);
      expect(runtime.runner.isRunning(cell)).toBe(false);
    });

    it("runs the piece once its pattern has loaded", async () => {
      const { cell, pattern } = await stoppedPiece(
        "started once its pattern loads",
      );
      using held = holdPatternLoad(pattern);
      const started = runtime.runner.start(cell);
      held.release();
      expect(await started).toBe(true);
      expect(held.loads()).toBe(1);
      expect(runtime.runner.isRunning(cell)).toBe(true);
    });
  });

  describe("a piece whose pattern moves while its dependencies sync", () => {
    // Forgetting that this runtime stopped the piece sends the start through
    // the dependency pre-sync a fresh runtime's resume takes, which the case
    // observes, and moves the pattern in, through the runner's seam.

    it("starts the pattern the piece points at once the sync lands", async () => {
      const { cell, pattern: first } = await stoppedPiece(
        "moved while its dependencies sync",
      );
      const { cell: other, pattern: moved } = await stoppedPiece(
        "the pattern it moves to",
        "second",
      );
      const movedRef = getPatternIdentityRef(other)!;
      const harness = runtime.runner.accessForTestingOnly;
      harness.locallyStoppedResults.delete(key(cell));
      harness.locallyPreparedResults.delete(key(cell));
      const synced: Pattern[] = [];
      harness.dependencySyncer = async (resultCell, pattern, inputs, sync) => {
        synced.push(pattern);
        const result = await sync(resultCell, pattern, inputs);
        if (synced.length === 1) {
          const tx = runtime.edit();
          cell.withTx(tx).setMetaRaw(
            "patternIdentity",
            movedRef,
            rawMetaWriteAuthorization,
          );
          expect((await tx.commit().settled).error).toBeUndefined();
        }
        return result;
      };
      try {
        expect(await runtime.runner.start(cell)).toBe(true);
      } finally {
        harness.dependencySyncer = undefined;
      }
      expect(synced.map((pattern) => pattern.result)).toEqual([
        first.result,
        moved.result,
      ]);
      expect(moved.result).toEqual({ marker: "second" });
      expect(runtime.runner.isRunning(cell)).toBe(true);
    });
  });
});
