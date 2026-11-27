/**
 * What a `RuntimeProcessor` does with a request it cannot serve and with
 * background work that fails: which requests it refuses and how, and which
 * failures it reports, drops, or recovers from. Each case drives one handler
 * or one piece of the worker's wiring, over stand-ins where a stand-in says
 * what the case turns on and over a real runtime where the outcome is the
 * runtime's.
 */

import { expect } from "@std/expect";
import { stub } from "@std/testing/mock";

import { cfcAtom } from "@commonfabric/api/cfc";
import { Identity } from "@commonfabric/identity";
import { getLogger } from "@commonfabric/logger";
import type { MemorySpace, URI } from "@commonfabric/memory/interface";
import type { CommitSummary } from "@commonfabric/memory/v2";
import { PiecesController } from "@commonfabric/piece/ops";
import { Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { describe, it } from "@commonfabric/test-support/test";

import {
  renderSpaceAccessProviderFor,
  RuntimeProcessor,
} from "@/backends/runtime-processor.ts";
import { SpaceAccessRetries } from "@/backends/space-access-retries.ts";
import { createCellRef } from "@/backends/utils.ts";
import { type CellRef, RequestType } from "@/protocol/mod.ts";
import { ownerClient } from "@/backends/worker-client.ts";
import { seedStoredEnvelope } from "../../../runner/test/cfc-seed-envelope.ts";
import { buildProcessor } from "./build-processor.ts";
import { stubWorkerBoot } from "./stub-worker-boot.ts";

const signer = await Identity.fromPassphrase("runtime-processor-failures");
const space = signer.did();
const otherSpace = "did:key:z6Mk-runtime-processor-failures-other" as const;

const streamRef: CellRef = {
  id: "of:runtime-processor-failures-stream" as CellRef["id"],
  space,
  scope: "space",
  path: [],
};

/**
 * Runs `body` with `console[method]` recording its calls, and returns them
 * once `body` has finished and, where `until` is given, once the calls
 * recorded satisfy it.
 */
async function recording(
  method: "warn" | "error" | "debug",
  body: () => unknown,
  until: (calls: unknown[][]) => boolean = () => true,
): Promise<unknown[][]> {
  const calls: unknown[][] = [];
  const satisfied = Promise.withResolvers<void>();
  const recorder = stub(console, method, (...args: unknown[]) => {
    calls.push(args);
    if (until(calls)) satisfied.resolve();
  });
  try {
    await body();
    if (until(calls)) satisfied.resolve();
    await satisfied.promise;
  } finally {
    recorder.restore();
  }
  return calls;
}

/** Whether `calls` holds `count` calls. */
const callCount = (count: number) => (calls: unknown[][]) =>
  calls.length === count;

/** A runtime over emulated storage, disposed with the returned handle. */
function emulatedRuntime() {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    storageManager,
    apiUrl: new URL("http://runtime-processor-failures.test/"),
  });
  return {
    runtime,
    async [Symbol.asyncDispose]() {
      await runtime.dispose();
      await storageManager.close();
    },
  };
}

/** A commit of the kind `historySteps()` reads. */
function commit(seq: number, kind: "derived" | "authored"): CommitSummary {
  return {
    seq,
    branch: "",
    class: kind,
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, seq)).toISOString(),
    events: 0,
    writes: 1,
  };
}

describe("runtime-processor", () => {
  describe("refusals", () => {
    it("refuses a reviewed send that names no surface or no action", async () => {
      const processor = buildProcessor();
      const refusal = "A reviewed action requires a surface and an action.";
      await expect(processor.handleCellSendReviewed({
        type: RequestType.CellSendReviewed,
        cell: streamRef,
        event: {},
        action: "approve",
      } as never)).rejects.toThrow(refusal);
      await expect(processor.handleCellSendReviewed({
        type: RequestType.CellSendReviewed,
        cell: streamRef,
        event: {},
        surface: "review-panel",
      } as never)).rejects.toThrow(refusal);
      // A request naming both gets past the check, to the stream, which the
      // stand-in runtime here cannot reach.
      const passed = await processor.handleCellSendReviewed({
        type: RequestType.CellSendReviewed,
        cell: streamRef,
        event: {},
        surface: "review-panel",
        action: "approve",
      }).then(() => undefined, (error: Error) => error.message);
      expect(passed).toBeDefined();
      expect(passed).not.toBe(refusal);
    });

    it("refuses a piece source that is neither a program nor an HTTP URL", async () => {
      const processor = buildProcessor({ cc: {}, space });
      const create = (source: unknown) =>
        processor.handlePieceCreate({
          type: RequestType.PieceCreate,
          space,
          source: source as never,
        });
      await expect(create({})).rejects.toThrow("Invalid source.");
      await expect(create({ url: "" })).rejects.toThrow("Invalid source.");
      await expect(create({ url: "file:///main.tsx" })).rejects.toThrow(
        "Piece source URL must use HTTP or HTTPS.",
      );
    });

    describe("space history", () => {
      /** A runtime stand-in whose storage serves history through `provider`. */
      const historyRuntime = (provider: Record<string, unknown>) => ({
        experimental: {},
        storageManager: { open: () => provider },
      });

      it("refuses a space that is no DID", async () => {
        const processor = buildProcessor({ runtime: historyRuntime({}) });
        await expect(processor.handleSpaceHistoryList({
          type: RequestType.SpaceHistoryList,
          space: "not-a-did" as never,
        })).rejects.toThrow("space history requires a space DID");
      });

      it("refuses a space whose storage serves no history", async () => {
        const listHistory = () => Promise.resolve([]);
        const processor = buildProcessor({
          runtime: historyRuntime({ listHistory }),
        });
        await expect(processor.handleSpaceHistoryList({
          type: RequestType.SpaceHistoryList,
          space,
        })).rejects.toThrow("the space's storage serves no history");
      });

      it("reads on past a full page that holds the first commit of no step", async () => {
        // Five hundred commits of the serving loop, newest first, and below
        // them the client commit that began the step they belong to.
        const loopPage = Array.from(
          { length: 500 },
          (_, index) => commit(1000 - index, "derived"),
        );
        const requests: unknown[] = [];
        const processor = buildProcessor({
          runtime: historyRuntime({
            listHistory: (request: { before?: number }) => {
              requests.push(request);
              return Promise.resolve(
                request.before === undefined
                  ? loopPage
                  : [commit(10, "authored")],
              );
            },
            createBranch: () => {},
            deleteBranch: () => {},
            restoreBranch: () => {},
          }),
        });

        const listed = await processor.handleSpaceHistoryList({
          type: RequestType.SpaceHistoryList,
          space,
        });

        expect(requests).toEqual([{ limit: 500 }, { limit: 500, before: 501 }]);
        expect(listed).toEqual({
          steps: [{
            seq: 1000,
            startSeq: 10,
            at: commit(10, "authored").createdAt,
            kind: "write",
            events: 0,
            writes: 501,
            settled: true,
          }],
        });
      });
    });

    describe("view mounts", () => {
      /** A processor holding one mount, `1`, of `ownerClient`'s. */
      function mounted() {
        const log: string[] = [];
        const processor = buildProcessor({
          runtime: { releaseUnreadDocuments: () => Promise.resolve() },
        });
        processor.accessForTestingOnly.vdomMounts = new Map([["0 1", {
          cancel: () => log.push("cancel"),
          reconciler: {
            unmount: () => log.push("unmount"),
            acknowledgeBatchApplied: (batch: number) =>
              log.push(`ack ${batch}`),
          },
        }]]) as never;
        return { processor, log };
      }

      it("warns of an unmount for a mount it does not hold, and leaves the one it does", async () => {
        const { processor, log } = mounted();
        const warnings = await recording(
          "warn",
          () =>
            processor.handleVDomUnmount({
              type: RequestType.VDomUnmount,
              mountId: 2,
            }),
        );
        expect(warnings).toEqual([[
          "[RuntimeProcessor] Mount 2 not found for unmount",
        ]]);
        expect(log).toEqual([]);
        expect(processor.accessForTestingOnly.vdomMounts.size).toBe(1);

        processor.handleVDomUnmount({
          type: RequestType.VDomUnmount,
          mountId: 1,
        });
        expect(log).toEqual(["cancel", "unmount"]);
        expect(processor.accessForTestingOnly.vdomMounts.size).toBe(0);
      });

      it("drops a batch acknowledgement for a mount it does not hold", () => {
        const { processor, log } = mounted();
        processor.handleVDomBatchApplied({
          type: "vdom:batch-applied",
          mountId: 2,
          batchId: 7,
        } as never);
        processor.handleVDomBatchApplied({
          type: "vdom:batch-applied",
          mountId: 1,
          batchId: 8,
        } as never);
        expect(log).toEqual(["ack 8"]);
      });
    });
  });

  describe("failure reports", () => {
    describe("a space context whose space cell fails to sync", () => {
      it("is reported and dropped, so that the next request builds another", async () => {
        const failure = new Error("host unreachable");
        const processor = buildProcessor({
          runtime: {
            harness: {},
            userIdentityDID: space,
            getSpaceCell: () => ({ sync: () => Promise.reject(failure) }),
          },
        });
        const access = processor.accessForTestingOnly;
        let first: PiecesController | undefined;
        const errors = await recording("error", async () => {
          first = access.getSpaceCtx(otherSpace);
          expect(access.spaces.get(otherSpace)).toBe(first);
          await first.ready.catch(() => {});
        });
        expect(errors).toEqual([[
          `[RuntimeProcessor] Space context for ${otherSpace} failed to sync:`,
          "host unreachable",
        ]]);
        expect(access.spaces.has(otherSpace)).toBe(false);

        const second = access.getSpaceCtx(otherSpace);
        expect(second).not.toBe(first);
        expect(access.spaces.get(otherSpace)).toBe(second);
        await recording("error", () => second.ready.catch(() => {}));
      });

      it("leaves a context that has since replaced the failed one", async () => {
        const failure = Promise.withResolvers<void>();
        const processor = buildProcessor({
          runtime: {
            harness: {},
            userIdentityDID: space,
            getSpaceCell: () => ({ sync: () => failure.promise }),
          },
        });
        const access = processor.accessForTestingOnly;
        const failed = access.getSpaceCtx(otherSpace);
        const replacement = { replaces: failed } as unknown as PiecesController;
        access.spaces.set(otherSpace, replacement);
        const errors = await recording("error", async () => {
          failure.reject(new Error("host unreachable"));
          await failed.ready.catch(() => {});
        });
        expect(errors).toHaveLength(1);
        expect(access.spaces.get(otherSpace)).toBe(replacement);
      });
    });

    describe("dispose()", () => {
      /** A runtime stand-in whose own disposal does what `dispose` does. */
      const disposableRuntime = (dispose: () => Promise<void>) => ({
        storageManager: { synced: () => Promise.resolve() },
        dispose,
      });

      it("stops every view mount and marks the processor disposed at once", async () => {
        const log: string[] = [];
        const processor = buildProcessor({
          runtime: disposableRuntime(() => {
            log.push("runtime disposed");
            return Promise.resolve();
          }),
        });
        processor.accessForTestingOnly.vdomMounts = new Map(
          ["0 1", "0 2"].map((key) => [key, {
            cancel: () => log.push(`cancel ${key}`),
            reconciler: { unmount: () => log.push(`unmount ${key}`) },
          }]),
        ) as never;

        const disposing = processor.dispose();
        expect(processor.accessForTestingOnly.isDisposed).toBe(true);
        await disposing;

        expect(log).toEqual([
          "cancel 0 1",
          "unmount 0 1",
          "cancel 0 2",
          "unmount 0 2",
          "runtime disposed",
        ]);
        expect(processor.accessForTestingOnly.vdomMounts.size).toBe(0);
      });

      it("reports a failure of the runtime's disposal rather than rejecting", async () => {
        const processor = buildProcessor({
          runtime: disposableRuntime(() =>
            Promise.reject(new Error("storage already closed"))
          ),
        });
        const errors = await recording("error", () => processor.dispose());
        expect(errors).toEqual([[
          "Failure during WorkerRuntime disposal: Error: storage already closed",
        ]]);
      });
    });

    describe("watchSiteTable()", () => {
      /**
       * A runtime stand-in whose site table syncs when `synced` settles and
       * hands its subscriber to the test, and whose host registration answers
       * with `resolve`. The processor waits on `synced` itself, so a case that
       * waits on it after starting the watch resumes after the processor has
       * acted on it.
       */
      function siteTableRuntime(options: {
        getCell?: () => unknown;
        synced?: Promise<void>;
        resolve?: (did: string, host: string) => Promise<unknown>;
      } = {}) {
        const sinks: Array<(entries: unknown) => void> = [];
        const synced = options.synced ?? Promise.resolve();
        const runtime = {
          userIdentityDID: space,
          apiUrl: new URL("https://site-table.test/"),
          getCell: options.getCell ?? (() => ({
            sync: () => synced,
            sink: (subscriber: (entries: unknown) => void) => {
              sinks.push(subscriber);
              return () => {};
            },
          })),
          resolveSpaceHost: options.resolve ??
            (() => Promise.resolve({ accepted: true })),
          hostForSpace: () => new URL("https://fixed-route.test/"),
          storageManager: { synced: () => Promise.resolve() },
          dispose: () => Promise.resolve(),
        };
        return { runtime, sinks, synced };
      }

      it("reports a table that fails to start watching, and carries on", async () => {
        const { runtime } = siteTableRuntime({
          getCell: () => {
            throw new Error("no home space");
          },
        });
        const processor = buildProcessor({ runtime });
        const warnings = await recording(
          "warn",
          () => processor.watchSiteTable(),
        );
        expect(warnings).toEqual([[
          "[RuntimeProcessor] Site table watch failed to start:",
          "no home space",
        ]]);
      });

      it("reports a table that fails to sync, and subscribes to nothing", async () => {
        const refused = Promise.withResolvers<void>();
        const { runtime, sinks } = siteTableRuntime({
          synced: refused.promise,
        });
        const processor = buildProcessor({ runtime });
        const warnings = await recording("warn", () => {
          processor.watchSiteTable();
          refused.reject(new Error("sync refused"));
        }, callCount(1));
        expect(warnings).toEqual([[
          "[RuntimeProcessor] Site table unavailable (continuing without hints):",
          "sync refused",
        ]]);
        expect(sinks).toHaveLength(0);
      });

      it("subscribes to nothing when disposed while the table syncs", async () => {
        const synced = Promise.withResolvers<void>();
        const { runtime, sinks } = siteTableRuntime({ synced: synced.promise });
        const processor = buildProcessor({ runtime });
        processor.watchSiteTable();
        await processor.dispose();
        synced.resolve();
        await synced.promise;
        expect(sinks).toHaveLength(0);

        // A processor that is not disposed subscribes once the sync settles.
        const live = siteTableRuntime();
        buildProcessor({ runtime: live.runtime }).watchSiteTable();
        await live.synced;
        expect(live.sinks).toHaveLength(1);
      });

      it("reports a row the runtime fails to register", async () => {
        const { runtime, sinks, synced } = siteTableRuntime({
          resolve: () => Promise.reject(new Error("meta read failed")),
        });
        const processor = buildProcessor({ runtime });
        processor.watchSiteTable();
        await synced;
        const did = "did:key:z6Mk-site-table-failing-row";
        const warnings = await recording("warn", () => {
          sinks[0]([{ did, host: "https://row-host.test/" }]);
        }, callCount(1));
        expect(warnings).toEqual([[
          `[RuntimeProcessor] Ignoring invalid site-table entry for ${did}:`,
          "meta read failed",
        ]]);
      });

      it("warns why a row's host is not an origin, and registers only the rows whose host is", async () => {
        const resolved: Array<[string, string]> = [];
        const { runtime, sinks, synced } = siteTableRuntime({
          resolve: (did, host) => {
            resolved.push([did, host]);
            return Promise.resolve({ accepted: true });
          },
        });
        const processor = buildProcessor({ runtime });
        processor.watchSiteTable();
        await synced;
        const refused = "did:key:z6Mk-site-table-ftp-row";
        const kept = "did:key:z6Mk-site-table-https-row";
        const warnings = await recording("warn", () => {
          sinks[0]([
            { did: refused, host: "ftp://row-host.test/" },
            { did: kept, host: "https://row-host.test" },
          ]);
        });
        expect(warnings).toEqual([[
          `[RuntimeProcessor] Ignoring invalid site-table entry for ${refused}:`,
          "Unsupported space host protocol",
        ]]);
        expect(resolved).toEqual([[kept, "https://row-host.test/"]]);
      });

      it("warns once for a row refused for a route already fixed, however often the table offers it", async () => {
        // The processor waits on the registration `resolve` returns, so
        // waiting on it after offering a row resumes once the processor has
        // decided whether to warn.
        const refusal = Promise.resolve({
          accepted: false,
          reason: "known-different-host",
        });
        const resolved: string[] = [];
        const { runtime, sinks, synced } = siteTableRuntime({
          resolve: (did) => {
            resolved.push(did);
            return refusal;
          },
        });
        const processor = buildProcessor({ runtime });
        processor.watchSiteTable();
        await synced;
        const did = "did:key:z6Mk-site-table-fixed-row";
        const rows = [{ did, host: "https://row-host.test/" }];
        const warnings = await recording("warn", async () => {
          sinks[0](rows);
          await refusal;
          sinks[0](rows);
          await refusal;
        });
        expect(resolved).toEqual([did, did]);
        expect(warnings).toEqual([[
          `[RuntimeProcessor] Site-table hint for ${did} not in effect ` +
          "(explicit space route already fixed); using https://fixed-route.test/",
        ]]);
      });
    });

    it("reports a retry of a refused space that fails, which a render boundary has nowhere to report", async () => {
      const retries = new SpaceAccessRetries(() =>
        Promise.reject(new Error("server gone"))
      );
      const provider = renderSpaceAccessProviderFor(
        { storageManager: StorageManager.emulate({ as: signer }) },
        retries,
      );
      const warnings = await recording(
        "warn",
        () => provider.retries!.retry(otherSpace),
        callCount(1),
      );
      expect(warnings).toHaveLength(1);
      expect(warnings[0][0]).toBe(
        `Retrying access to space ${otherSpace} failed:`,
      );
      expect(warnings[0][1]).toMatchObject({ message: "server gone" });
    });

    it("reports a logger whose level was cleared at the level it then logs at", () => {
      const processor = buildProcessor({
        runtime: {
          getCfcStats: () => ({}),
          patternManager: { getCompileCacheStats: () => ({}) },
          getSizes: () => ({}),
        },
      });
      const name = "runtime-processor-failures-cleared-level";
      const logger = getLogger(name, { level: "warn" });
      const metadataOf = () =>
        processor.getLoggerCounts({ type: RequestType.GetLoggerCounts })
          .metadata[name];
      try {
        expect(metadataOf()).toEqual({ enabled: true, level: "warn" });
        logger.level = undefined;
        expect(metadataOf()).toEqual({ enabled: true, level: "info" });
      } finally {
        logger.level = "warn";
      }
    });
  });

  describe("metadata link reads", () => {
    /**
     * Writes a document holding `value` and, beside it, the `argument` link
     * `argument` names, and returns the ref a host reads it by.
     */
    async function documentOf(
      runtime: Runtime,
      id: string,
      value: unknown,
      argument?: CellRef,
    ): Promise<CellRef> {
      const tx = runtime.edit();
      const cell = runtime.getCell(space, id, undefined, tx);
      seedStoredEnvelope(tx, {
        space,
        scope: "space",
        id: cell.getAsNormalizedFullLink().id as URI,
        path: [],
      }, {
        value,
        ...(argument === undefined ? {} : {
          argument: runtime.getCellFromLink(argument).getAsLink(),
        }),
      } as never);
      expect((await tx.commit().settled).ok).toBeDefined();
      return createCellRef(runtime.getCell(space, id));
    }

    it("reads the cell an `argument` link names, and nothing for a document holding none", async () => {
      await using held = emulatedRuntime();
      const { runtime } = held;
      const input = await documentOf(runtime, "metadata-input", {
        title: "input value",
      });
      const piece = await documentOf(runtime, "metadata-piece", {}, input);
      const bare = await documentOf(runtime, "metadata-bare", {});
      const processor = buildProcessor({ runtime });

      expect(
        await processor.handleCellGet({
          type: RequestType.CellGet,
          cell: piece,
          meta: "argument",
        }),
      ).toEqual({ value: { title: "input value" } });
      expect(
        await processor.handleCellGet({
          type: RequestType.CellGet,
          cell: { ...piece, path: ["title"] },
          meta: "argument",
        }),
      ).toEqual({ value: "input value" });
      expect(
        await processor.handleCellGet({
          type: RequestType.CellGet,
          cell: bare,
          meta: "argument",
        }),
      ).toEqual({ value: undefined });
    });

    it("follows no `argument` link out of a document the ceiling does not admit", async () => {
      await using held = emulatedRuntime();
      const { runtime } = held;
      const input = await documentOf(runtime, "sealed-input", "input value");
      const piece = await documentOf(runtime, "sealed-piece", {}, input);
      const sealed = {
        ...piece,
        schema: {
          type: "object",
          ifc: { confidentiality: [cfcAtom.resource("CredentialSecret")] },
        },
      } as unknown as CellRef;
      const processor = buildProcessor({ runtime });
      const read = () =>
        processor.handleCellGet({
          type: RequestType.CellGet,
          cell: sealed,
          meta: "argument",
        });

      expect(await read()).toEqual({ value: "input value" });
      processor.accessForTestingOnly.renderConfidentialityCeiling = {
        atoms: [],
      } as never;
      expect(await read()).toEqual({
        refused: { refusedBy: "display-ceiling", labelSource: "schema" },
      });
    });
  });

  describe("created pieces", () => {
    /**
     * Stands a processor up over emulated storage, hands it and its runtime to
     * `body`, and disposes it afterwards.
     */
    async function withInitialized(
      body: (processor: RuntimeProcessor, runtime: Runtime) => Promise<void>,
    ): Promise<void> {
      const restore = stubWorkerBoot(({ as }) =>
        StorageManager.emulate({ as })
      );
      // What the worker posts to its host has nowhere to go here.
      using _post = stub(ownerClient, "post", () => true);
      let processor: RuntimeProcessor;
      try {
        processor = await RuntimeProcessor.initialize({
          apiUrl: "http://created-pieces.test/",
          identity: signer.keyPair,
          spaceDid: space,
        });
      } finally {
        restore();
      }
      try {
        await body(processor, processor.accessForTestingOnly.runtime);
      } finally {
        await processor.dispose();
      }
    }

    it("adds a created piece to the list of its space's controller, or else of Home's", async () => {
      await withInitialized(async (processor, runtime) => {
        const added: Array<{ to: MemorySpace; pieces: unknown[] }> = [];
        const add = stub(
          PiecesController.prototype,
          "add",
          function (this: PiecesController, pieces: unknown[]) {
            added.push({ to: this.getSpace(), pieces });
            return Promise.resolve();
          },
        );
        try {
          const opened = processor.accessForTestingOnly.getSpaceCtx(otherSpace);
          await opened.ready.catch(() => {});
          const inOpened = runtime.getCell(otherSpace, "created-in-opened");
          const elsewhere = runtime.getCell(
            "did:key:z6Mk-runtime-processor-failures-unopened",
            "created-elsewhere",
          );
          runtime.pieceCreatedCallback!(inOpened);
          runtime.pieceCreatedCallback!(elsewhere);
          await processor.handleIdle();
          expect(added).toEqual([
            { to: otherSpace, pieces: [inOpened] },
            { to: space, pieces: [elsewhere] },
          ]);
        } finally {
          add.restore();
        }
      });
    });

    it("reports a created piece it fails to add, by the failure's message or else the failure itself", async () => {
      await withInitialized(async (_processor, runtime) => {
        const failures: unknown[] = [
          new Error("no default pattern"),
          "refused",
        ];
        const add = stub(
          PiecesController.prototype,
          "add",
          () => Promise.reject(failures.shift()),
        );
        try {
          // The worker also reports here what it fails to post to a host this
          // test does not stand up.
          const reports = (calls: unknown[][]) =>
            calls.filter(([message]) =>
              String(message).startsWith("[RuntimeProcessor]")
            );
          const errors = await recording(
            "error",
            () => {
              runtime.pieceCreatedCallback!(runtime.getCell(space, "created"));
              runtime.pieceCreatedCallback!(
                runtime.getCell(space, "created-2"),
              );
            },
            (calls) => reports(calls).length === 2,
          );
          expect(reports(errors)).toEqual([
            [
              "[RuntimeProcessor] Failed to add created piece:",
              { error: "no default pattern" },
            ],
            [
              "[RuntimeProcessor] Failed to add created piece:",
              { error: "refused" },
            ],
          ]);
        } finally {
          add.restore();
        }
      });
    });
  });
});
