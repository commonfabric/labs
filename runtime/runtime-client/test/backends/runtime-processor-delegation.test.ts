/**
 * The requests a `RuntimeProcessor` handles by handing them on to a
 * collaborator -- its runtime, or the pieces controller of the space a request
 * names -- dispatched through `handleRequest()` as the client registry
 * dispatches them.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { stub } from "@std/testing/mock";
import type { RealmEncodedValue } from "@commonfabric/data-model/codec-realm";
import { fabricFromRealmValue } from "@commonfabric/data-model/codecs";
import { FabricBytes } from "@commonfabric/data-model/fabric-primitives";
import { getLogger, getLoggerCountsByKey } from "@commonfabric/logger";
import { RuntimeTelemetry } from "@commonfabric/runner";

import { type CellRef, NotificationType, RequestType } from "@/protocol/mod.ts";
import type { ProcessorRequest } from "@/backends/runtime-processor.ts";
import { buildProcessor } from "./build-processor.ts";

const space = "did:key:z6Mk-runtime-processor-delegation";
const otherSpace = "did:key:z6Mk-runtime-processor-delegation-other";

/**
 * A runtime stand-in whose every member records its name and arguments in
 * `calls`, and returns what `returns` holds for that name.
 */
function recordingRuntime(returns: Record<string, unknown> = {}) {
  const calls: unknown[][] = [];
  const member = (name: string) => (...args: unknown[]) => {
    calls.push([name, ...args]);
    return returns[name];
  };
  const runtime = {
    scheduler: {
      setEventPreflightTelemetryEnabled: member(
        "scheduler.setEventPreflightTelemetryEnabled",
      ),
      getGraphSnapshot: member("scheduler.getGraphSnapshot"),
      setBreakpoints: member("scheduler.setBreakpoints"),
      setReadStatsEnabled: member("scheduler.setReadStatsEnabled"),
    },
    patternManager: {
      flushCompileCacheWrites: member("patternManager.flushCompileCacheWrites"),
    },
    getCell: member("getCell"),
    getHomeSpaceCell: member("getHomeSpaceCell"),
    resolveSpaceHost: member("resolveSpaceHost"),
  };
  return { runtime, calls };
}

/**
 * Requests the processor handles by calling one runtime member, each with the
 * member's name, the arguments it is called with, what it returns, and what
 * the processor responds with.
 */
const passthroughs: Array<{
  request: ProcessorRequest;
  member: string;
  args: unknown[];
  returns?: unknown;
  response: unknown;
}> = [
  {
    request: { type: RequestType.GetGraphSnapshot },
    member: "scheduler.getGraphSnapshot",
    args: [],
    returns: { nodes: [], edges: [], timestamp: 3 },
    response: { snapshot: { nodes: [], edges: [], timestamp: 3 } },
  },
  {
    request: { type: RequestType.SetReadStatsEnabled, enabled: true },
    member: "scheduler.setReadStatsEnabled",
    args: [true],
    response: undefined,
  },
  {
    request: { type: RequestType.SetBreakpoints, actionIds: ["a", "b"] },
    member: "scheduler.setBreakpoints",
    args: [["a", "b"]],
    response: undefined,
  },
  {
    request: { type: RequestType.FlushCompileCacheWrites },
    member: "patternManager.flushCompileCacheWrites",
    args: [],
    returns: Promise.resolve(),
    response: undefined,
  },
  {
    request: {
      type: RequestType.RegisterSpaceHost,
      space,
      host: "https://a.test",
    },
    member: "resolveSpaceHost",
    args: [space, "https://a.test"],
    returns: Promise.resolve({ accepted: false, reason: "known" }),
    response: { value: false },
  },
  {
    request: {
      type: RequestType.RegisterSpaceHostDetailed,
      space,
      host: "https://a.test",
    },
    member: "resolveSpaceHost",
    args: [space, "https://a.test"],
    returns: Promise.resolve({ accepted: false, reason: "known" }),
    response: { registration: { accepted: false, reason: "known" } },
  },
];

/**
 * Replaces the worker's `postMessage` for the life of the returned object,
 * collecting each message as the client's transport would decode it.
 */
function capturingPosts() {
  const posted: unknown[] = [];
  const had = Reflect.has(globalThis, "postMessage");
  const original: unknown = Reflect.get(globalThis, "postMessage");
  Reflect.set(globalThis, "postMessage", (message: RealmEncodedValue) => {
    posted.push(fabricFromRealmValue(structuredClone(message)));
  });
  return {
    posted,
    [Symbol.dispose]: () => {
      if (had) Reflect.set(globalThis, "postMessage", original);
      else Reflect.deleteProperty(globalThis, "postMessage");
    },
  };
}

describe("runtime-processor-delegation", () => {
  describe("requests handed on to the runtime", () => {
    for (const { request, member, args, returns, response } of passthroughs) {
      it(`calls ${member}() for ${request.type}, and responds with what it returns`, async () => {
        const { runtime, calls } = recordingRuntime({ [member]: returns });
        const processor = buildProcessor({ runtime });
        await expect(processor.handleRequest(request)).resolves.toEqual(
          response,
        );
        expect(calls).toEqual([[member, ...args]]);
      });
    }
  });

  describe("RequestType.SetTelemetryEnabled", () => {
    it("forwards telemetry markers to the client only while enabled", async () => {
      const telemetry = new RuntimeTelemetry();
      const { runtime, calls } = recordingRuntime();
      const processor = buildProcessor({ runtime, telemetry });
      using posts = capturingPosts();

      telemetry.submit({ type: "scheduler.run", actionId: "before" });
      await processor.handleRequest({
        type: RequestType.SetTelemetryEnabled,
        enabled: true,
      });
      telemetry.submit({ type: "scheduler.run", actionId: "during" });
      await processor.handleRequest({
        type: RequestType.SetTelemetryEnabled,
        enabled: false,
      });
      telemetry.submit({ type: "scheduler.run", actionId: "after" });

      expect(posts.posted).toEqual([{
        type: NotificationType.Telemetry,
        marker: {
          type: "scheduler.run",
          actionId: "during",
          timeStamp: expect.any(Number),
        },
      }]);
      expect(calls).toEqual([
        ["scheduler.setEventPreflightTelemetryEnabled", true],
        ["scheduler.setEventPreflightTelemetryEnabled", false],
      ]);
    });
  });

  describe("logger settings", () => {
    it("sets the level and enablement of the named logger only", async () => {
      const named = getLogger("runtime-processor-delegation-named");
      const other = getLogger("runtime-processor-delegation-other");
      const before = { level: other.level, disabled: other.disabled };
      const processor = buildProcessor();
      await processor.handleRequest({
        type: RequestType.SetLoggerLevel,
        level: "error",
        loggerName: "runtime-processor-delegation-named",
      });
      await processor.handleRequest({
        type: RequestType.SetLoggerEnabled,
        enabled: false,
        loggerName: "runtime-processor-delegation-named",
      });
      expect(named.level).toBe("error");
      expect(named.disabled).toBe(true);
      expect({ level: other.level, disabled: other.disabled }).toEqual(before);
    });

    it("changes nothing for a logger name nothing registered", async () => {
      const other = getLogger("runtime-processor-delegation-bystander");
      const before = { level: other.level, disabled: other.disabled };
      const processor = buildProcessor();
      await processor.handleRequest({
        type: RequestType.SetLoggerLevel,
        level: "error",
        loggerName: "runtime-processor-delegation-no-such-logger",
      });
      expect({ level: other.level, disabled: other.disabled }).toEqual(before);
    });

    it("sets every logger when no logger is named", async () => {
      const first = getLogger("runtime-processor-delegation-every-1");
      const second = getLogger("runtime-processor-delegation-every-2");
      const loggers = Object.keys(getLoggerCountsByKey()).map((name) =>
        getLogger(name)
      );
      const saved = loggers.map((logger) => logger.disabled);
      const processor = buildProcessor();
      try {
        await processor.handleRequest({
          type: RequestType.SetLoggerEnabled,
          enabled: false,
        });
        expect([first.disabled, second.disabled]).toEqual([true, true]);
        await processor.handleRequest({
          type: RequestType.SetLoggerEnabled,
          enabled: true,
        });
        expect([first.disabled, second.disabled]).toEqual([false, false]);
      } finally {
        loggers.forEach((logger, index) => {
          logger.disabled = saved[index];
        });
      }
    });

    it("measures counts afresh from a reset of the baselines", async () => {
      const logger = getLogger("runtime-processor-delegation-baseline", {
        enabled: false,
      });
      logger.info("counted");
      expect(logger.counts.total).toBeGreaterThan(0);
      await buildProcessor().handleRequest({
        type: RequestType.ResetLoggerBaselines,
      });
      expect(logger.getCountDeltas().total).toBe(0);
    });
  });

  describe("requests for a piece", () => {
    /**
     * A processor whose home space is `space`, over a pieces controller whose
     * every member records its name and arguments in `calls`.
     */
    function processorOverPieces() {
      const calls: unknown[][] = [];
      const member = (name: string) => (...args: unknown[]) => {
        calls.push([name, ...args]);
        return Promise.resolve();
      };
      const processor = buildProcessor({
        space,
        cc: {
          getSpace: () => space,
          startPiece: member("startPiece"),
          stopPiece: member("stopPiece"),
          synced: member("synced"),
        },
      });
      return { processor, calls };
    }

    it("starts the piece in the scope the request names, and responds with `true`", async () => {
      const { processor, calls } = processorOverPieces();
      await expect(
        processor.handleRequest({
          type: RequestType.PieceStart,
          space,
          pieceId: "fid1-piece",
          scope: "user",
        }),
      ).resolves.toEqual({ value: true });
      expect(calls).toEqual([["startPiece", "fid1-piece", "user"]]);
    });

    it("stops the piece in the scope the request names, and responds with `true`", async () => {
      const { processor, calls } = processorOverPieces();
      await expect(
        processor.handleRequest({
          type: RequestType.PieceStop,
          space,
          pieceId: "fid1-piece",
        }),
      ).resolves.toEqual({ value: true });
      expect(calls).toEqual([["stopPiece", "fid1-piece", undefined]]);
    });

    it("waits for the space's pieces controller to sync", async () => {
      const { processor, calls } = processorOverPieces();
      await expect(
        processor.handleRequest({ type: RequestType.PieceSynced, space }),
      ).resolves.toBeUndefined();
      expect(calls).toEqual([["synced"]]);
    });
  });

  describe("requests answered with a cell a collaborator holds", () => {
    const ref: CellRef = {
      id: "of:looked-up",
      space,
      scope: "space",
      path: [],
    };

    /**
     * A cell stand-in that serializes as a link to `ref` and carries no CFC
     * label, which is all a response's cell ref is built from.
     */
    const cellAt = (ref: CellRef) => ({
      getAsLink: () => ({ "/": { "link@1": ref } }),
      getAsNormalizedFullLink: () => ref,
      runtime: { readTx: () => ({ readOrThrow: () => undefined }) },
    });

    it("responds to `GetCell` with the cell the runtime derives, under the schema asked for", async () => {
      const { runtime, calls } = recordingRuntime({ getCell: cellAt(ref) });
      const processor = buildProcessor({ runtime });

      await expect(processor.handleRequest({
        type: RequestType.GetCell,
        space,
        cause: "lookup",
        schema: { type: "string" },
      })).resolves.toEqual({ cell: { ...ref, schema: { type: "string" } } });
      expect(calls).toEqual([["getCell", space, "lookup", { type: "string" }]]);
    });

    it("responds to `GetHomeSpaceCell` with the runtime's home space cell", async () => {
      const { runtime, calls } = recordingRuntime({
        getHomeSpaceCell: cellAt(ref),
      });
      const processor = buildProcessor({ runtime });

      await expect(
        processor.handleRequest({ type: RequestType.GetHomeSpaceCell }),
      ).resolves.toEqual({ cell: ref });
      expect(calls).toEqual([["getHomeSpaceCell"]]);
    });

    it("responds to `PieceGetAll` with the space's piece registry", async () => {
      const processor = buildProcessor({
        space,
        cc: { getPieceRegistry: () => Promise.resolve(cellAt(ref)) },
      });

      await expect(
        processor.handleRequest({ type: RequestType.PieceGetAll, space }),
      ).resolves.toEqual({ cell: ref });
    });
  });

  describe("RequestType.RuntimeSynced", () => {
    it("waits for every space the processor has opened", async () => {
      const home = Promise.withResolvers<void>();
      const other = Promise.withResolvers<void>();
      const synced: string[] = [];
      const pieces = (name: string, syncing: Promise<void>) => ({
        synced: () =>
          syncing.then(() => {
            synced.push(name);
          }),
      });
      const processor = buildProcessor({
        space,
        cc: pieces("home", home.promise),
        spaces: new Map([[otherSpace, pieces("other", other.promise)]]),
      });

      const request = processor.handleRequest({
        type: RequestType.RuntimeSynced,
      });
      let settled = false;
      void request.then(() => {
        settled = true;
      });
      home.resolve();
      // A task runs only once the microtasks queued ahead of it have, so by
      // then the request has had every chance to settle on one space alone.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(synced).toEqual(["home"]);
      expect(settled).toBe(false);

      other.resolve();
      await request;
      expect(synced).toEqual(["home", "other"]);
    });
  });

  describe("blob requests", () => {
    const host = new URL("http://toolshed.test/");
    const processorForBlobs = () =>
      buildProcessor({ runtime: { hostForSpace: () => host } });
    const upload = {
      type: RequestType.UploadBlob,
      space,
      contentType: "image/png",
      body: new FabricBytes(new Uint8Array([1])),
    } as const;

    it("refuses an upload naming no space, or carrying no bytes, without fetching", async () => {
      using fetchStub = stub(globalThis, "fetch");
      const processor = processorForBlobs();
      await expect(
        processor.handleRequest({ ...upload, space: "not-a-did" as never }),
      ).rejects.toThrow("uploadBlob requires a space DID");
      await expect(
        processor.handleRequest({ ...upload, body: [1] as never }),
      ).rejects.toThrow("uploadBlob requires bytes as its body");
      expect(fetchStub.calls).toEqual([]);
    });

    it("rejects with the host's status and text when the upload fails", async () => {
      using _fetch = stub(
        globalThis,
        "fetch",
        () => Promise.resolve(new Response("store full", { status: 507 })),
      );
      await expect(processorForBlobs().handleRequest(upload)).rejects.toThrow(
        "Blob upload failed: 507 store full",
      );
    });

    it("rejects when the host responds without an id and URL", async () => {
      using _fetch = stub(
        globalThis,
        "fetch",
        () => Promise.resolve(Response.json({ id: "fid1:abc" })),
      );
      await expect(processorForBlobs().handleRequest(upload)).rejects.toThrow(
        "Blob upload returned an invalid response",
      );
    });
  });
});
