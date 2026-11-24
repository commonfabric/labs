import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { toFileUrl } from "@std/path";
import { getLoggerCountsBreakdown } from "@commonfabric/logger";
import * as MemoryClient from "@commonfabric/memory/v2/client";
import type { FabricValue } from "@commonfabric/data-model";
import * as Engine from "@commonfabric/memory/v2/engine";
import type {
  Server,
  SessionLifecycleEvent,
} from "@commonfabric/memory/v2/server";
import { namesInstancesByDefault } from "../../src/builder/instance-name.ts";
import {
  ServingPlane,
  servingPlaneEndpoint,
} from "../../src/executor/serving-port-plane.ts";
import { ServingPortBridge } from "../../src/executor/serving-port-bridge.ts";
import {
  isPlaceCompileFailure,
  markPlaceCompileFailure,
} from "../../src/harness/compile-failure.ts";
import type {
  ModuleCompiler,
  ModuleCompileRequest,
} from "../../src/harness/module-compile.ts";
import {
  type BridgeNotices,
  type BridgeRequests,
  type PlaneNotices,
  type PlaneRequests,
  PortEndpoint,
} from "../../src/executor/serving-port-protocol.ts";
import type { ListedServedAclChange } from "../../src/executor/wave.ts";
import type { MemorySpace } from "../../src/storage/interface.ts";
import {
  newSharedServer,
  testSessionOpenAuthFactory,
} from "../memory-v2-test-utils.ts";

const space = "did:key:z6MkServingPortBridgeSpace" as MemorySpace;
const alice = "did:key:z6MkServingPortBridgeAlice";
const bob = "did:key:z6MkServingPortBridgeBob";
const carol = "did:key:z6MkServingPortBridgeCarol";
const sidecarId = "of:serving-port-bridge-sidecar";

/** How many times `key` was logged at warn by the bridge's logger. */
const bridgeWarnings = (key: string): number =>
  getLoggerCountsBreakdown()["serving-port-bridge"]?.[key]?.warn ?? 0;

/** Writes `value` to document `id` of `engine`'s space as `principal`. */
const seed = (
  engine: Engine.Engine,
  id: string,
  value: FabricValue,
  principal: string,
  localSeq: number,
) =>
  Engine.applyCommit(engine, {
    sessionId: `seed-${localSeq}`,
    space,
    principal,
    commit: {
      localSeq,
      reads: { confirmed: [], pending: [] },
      operations: [{ op: "set", id, value: { value } }],
    },
  });

describe("ServingPortBridge", () => {
  let server: Server;
  let channel: MessageChannel;
  let bridge: ServingPortBridge;

  /**
   * Builds the bridge over a server whose store is at `store`, compiling for
   * its worker in `moduleCompiler` where one is given.
   */
  const start = (store?: URL, moduleCompiler?: ModuleCompiler) => {
    server = newSharedServer({
      subscriptionRefreshDelayMs: 0,
      ...(store === undefined ? {} : { store }),
    });
    bridge = new ServingPortBridge({
      server,
      port: channel.port2,
      ...(moduleCompiler === undefined ? {} : { moduleCompiler }),
    });
  };

  beforeEach(() => {
    channel = new MessageChannel();
  });

  afterEach(async () => {
    bridge.close();
    await server.close();
    channel.port1.close();
    channel.port2.close();
  });

  describe("with a plane on the worker's end", () => {
    let plane: ServingPlane;

    beforeEach(() => {
      plane = new ServingPlane(servingPlaneEndpoint(channel.port1));
    });

    afterEach(async () => {
      await plane.close();
    });

    it("names a file store for the worker to open itself, whose commits the worker reads", async () => {
      const directory = await Deno.makeTempDir();
      try {
        start(toFileUrl(`${directory}/`));
        seed(await server.engineForSpace(space), "of:doc", 1, alice, 1);
        const engine = await plane.engineForSpace(space);
        expect(engine).not.toBe(await server.engineForSpace(space));
        expect(Engine.read(engine, { id: "of:doc" })?.value).toBe(1);
        await plane.close();
      } finally {
        await Deno.remove(directory, { recursive: true });
      }
    });

    it("refuses to name a store another thread cannot open", async () => {
      start();
      await expect(plane.engineForSpace(space)).rejects.toThrow(
        "which another thread cannot open; a serving worker needs a file store",
      );
    });

    describe("compiler", () => {
      const request: ModuleCompileRequest = {
        program: {
          main: "/main.ts",
          files: [{ name: "/main.ts", contents: "export const x = 1;" }],
        },
        authoredSources: [],
        mounts: [],
        moduleIdentities: new Map<string, string>(),
        specifierAliases: new Map<string, string>(),
        storedSource: false,
        noCheck: true,
        diagnosticMessages: "typescript",
        instanceNames: false,
      };

      /** What a compile through the plane rejects with. */
      const failureOf = async (): Promise<unknown> => {
        try {
          await plane.compiler.compile(request);
        } catch (error) {
          return error;
        }
        throw new Error("the compile did not fail");
      };

      it("compiles in the server's thread's compiler, and returns its modules", async () => {
        const requests: ModuleCompileRequest[] = [];
        start(undefined, {
          compile: (asked) => {
            requests.push(asked);
            return Promise.resolve(
              new Map([["/main.ts", { js: "exports.x = 1;" }]]),
            );
          },
        });

        const modules = await plane.compiler.compile(request);

        expect([...modules]).toEqual([["/main.ts", { js: "exports.x = 1;" }]]);
        expect(requests.map((asked) => asked.program)).toEqual([
          request.program,
        ]);
      });

      it("rejects with the failure of a compile, which is not one of the place it ran", async () => {
        start(undefined, {
          compile: () => Promise.reject(new Error("the source does not parse")),
        });

        const failure = await failureOf();

        expect(failure).toBeInstanceOf(Error);
        expect(String(failure)).toContain("the source does not parse");
        expect(isPlaceCompileFailure(failure)).toBe(false);
      });

      it("keeps a failure of the place a compile ran marked as one", async () => {
        start(undefined, {
          compile: () =>
            Promise.reject(
              markPlaceCompileFailure(new Error("the compile worker died")),
            ),
        });

        const failure = await failureOf();

        expect(String(failure)).toContain("the compile worker died");
        expect(isPlaceCompileFailure(failure)).toBe(true);
      });

      it("fails a compile as one of the place where the process runs none", async () => {
        start();

        expect(isPlaceCompileFailure(await failureOf())).toBe(true);
      });

      it("fails the compiles it still awaits, as failures of the place, once it stops compiling", async () => {
        const asked = Promise.withResolvers<void>();
        start(undefined, {
          compile: () => {
            asked.resolve();
            return new Promise<never>(() => {});
          },
        });
        const failed = failureOf();
        await asked.promise;

        plane.stopCompiling();

        const failure = await failed;
        expect(String(failure)).toContain("stopped compiling");
        expect(isPlaceCompileFailure(failure)).toBe(true);
        expect(isPlaceCompileFailure(await failureOf())).toBe(true);
      });
    });

    it("carries the server's view changes to the worker's observer", async () => {
      start();
      const changes = Promise.withResolvers<string>();
      plane.observer = {
        viewsChanged: (space, sessionId) =>
          changes.resolve(`${space} ${sessionId}`),
      };
      bridge.observer.viewsChanged(space, "a");
      expect(await changes.promise).toBe(`${space} a`);
    });

    describe("access-list changes", () => {
      const change = {
        space,
        actingPrincipal: alice,
        capabilityRef: "event-consequence:evt-alice",
        sourceEvent: { space, sidecarId, eventId: "evt-alice" },
        change: () => ({}),
      };
      const sinkDeps = async () => ({
        space,
        engine: await server.engineForSpace(space),
        foreignEngineFor: () => {
          throw new Error("no foreign space");
        },
        sessionId: "tenure",
        localSeqRef: { value: 0 },
      });
      const acl = async () =>
        (await server.readDocument(space, `of:${space}`))?.value;

      beforeEach(async () => {
        start();
        const engine = await server.engineForSpace(space);
        seed(engine, `of:${space}`, { [alice]: "OWNER" }, space, 1);
        seed(
          engine,
          sidecarId,
          {
            entries: [
              { eventId: "evt-alice", firedAt: { user: alice } },
              { eventId: "evt-bob", firedAt: { user: bob } },
            ],
          },
          alice,
          2,
        );
      });

      it("checks and commits a change the worker sends against the server's admission, and returns the server's verdicts", async () => {
        const grantBob = {
          ...change,
          changes: [{ principal: bob, level: "READ" as const, actor: alice }],
        };
        expect(await plane.server.checkServedAclChange(grantBob)).toEqual({
          admitted: true,
        });
        expect(await acl()).toEqual({ [alice]: "OWNER" });

        const committed = await plane.server.commitServedAclChange({
          ...grantBob,
          sessionId: "tenure",
          localSeq: 1,
        });
        expect(committed).toMatchObject({ admitted: true });
        expect(await acl()).toEqual({ [alice]: "OWNER", [bob]: "READ" });

        // Bob holds READ, so a change he makes is refused, and nothing lands.
        const byBob = {
          ...change,
          actingPrincipal: bob,
          capabilityRef: "event-consequence:evt-bob",
          sourceEvent: { space, sidecarId, eventId: "evt-bob" },
          changes: [{ principal: bob, level: "OWNER" as const, actor: bob }],
        };
        expect(
          await plane.server.commitServedAclChange({
            ...byBob,
            sessionId: "tenure",
            localSeq: 2,
          }),
        ).toEqual({ refused: expect.stringContaining("requires `OWNER`") });
        expect(await acl()).toEqual({ [alice]: "OWNER", [bob]: "READ" });
      });

      it("commits a change through the worker's sink, and returns the server's refusal of one the actor may not make", async () => {
        const sink = plane.createWaveCommitSink(await sinkDeps());
        const grantCarol: ListedServedAclChange = {
          ...change,
          changes: [{ principal: carol, level: "WRITE", actor: alice }],
        };
        const granted = await sink.commitSpaceAccessChange?.(grantCarol);
        expect(granted?.ok?.seq).toEqual(expect.any(Number));
        expect(await acl()).toEqual({ [alice]: "OWNER", [carol]: "WRITE" });

        const misnamed: ListedServedAclChange = {
          ...change,
          capabilityRef: "event-consequence:evt-bob",
          changes: [{ principal: carol, level: undefined, actor: alice }],
        };
        const refused = await sink.commitSpaceAccessChange?.(misnamed);
        expect(refused?.error?.name).toBe("AclDocumentWriteRefused");
        expect(refused?.error?.message).toContain(
          "does not name the event evt-alice",
        );
        expect(await acl()).toEqual({ [alice]: "OWNER", [carol]: "WRITE" });
      });
    });
  });

  describe("with a raw endpoint on the worker's end", () => {
    let worker: PortEndpoint<
      PlaneRequests,
      PlaneNotices,
      BridgeRequests,
      BridgeNotices
    >;

    beforeEach(() => {
      worker = new PortEndpoint(channel.port1, () => {});
    });

    afterEach(() => {
      worker.close();
    });

    it("refuses a frame for a loopback connection the worker has not opened", async () => {
      start();
      await expect(
        worker.request("loopback.send", { transport: 7, payload: "frame" }),
      ).rejects.toThrow("loopback connection 7 is not open");
    });

    it("logs a notice it has no handler for as a port fault, and keeps serving", async () => {
      start();
      const before = bridgeWarnings("port-fault");
      channel.port1.postMessage({ t: "note", method: "unknown", params: null });
      await worker.request("server.idle", null);
      expect(bridgeWarnings("port-fault")).toBe(before + 1);
    });
  });

  describe("close()", () => {
    it("closes the loopback connections the worker holds, once", async () => {
      start();
      const events: SessionLifecycleEvent[] = [];
      server.setServerExecutionObserver({
        sessionChanged: (event) => events.push(event),
      });
      const plane = new ServingPlane(servingPlaneEndpoint(channel.port1));
      try {
        const client = await MemoryClient.connect({
          instanceNames: namesInstancesByDefault(),
          transport: plane.loopback.createTransport(),
        });
        const session = await client.mount(
          space,
          {},
          testSessionOpenAuthFactory,
        );
        expect(events.map(({ kind }) => kind)).toEqual(["opened"]);

        bridge.close();
        bridge.close();
        expect(events.map(({ kind }) => kind)).toEqual(["opened", "detached"]);
        expect(events[1]).toMatchObject({
          space,
          sessionId: session.sessionId,
        });
      } finally {
        await plane.close();
      }
    });
  });
});
