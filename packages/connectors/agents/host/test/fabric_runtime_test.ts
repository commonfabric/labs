/**
 * Tests the agent host's storage lifecycle against shared loopback storage
 * and injected health-check and disposal failures.
 */

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { spy, stub } from "@std/testing/mock";

import type { CollectedSource } from "@commonfabric/agents-connector/reconcile";
import { Identity } from "@commonfabric/identity";
import { Runtime } from "@commonfabric/runner";
import {
  EmulatedStorageManager,
  newLoopbackServer,
  StorageManager,
} from "@commonfabric/runner/storage/cache.deno";

import { openAgentFabricRuntime } from "../src/fabric-runtime.ts";

describe("fabric-runtime", () => {
  describe("openAgentFabricRuntime()", () => {
    let identityPath: string;
    let ownerDid: string;
    let realFetch: typeof globalThis.fetch;

    beforeEach(async () => {
      identityPath = await Deno.makeTempFile({ suffix: ".key" });
      const identityBytes = await Identity.generatePkcs8();
      await Deno.writeFile(identityPath, identityBytes);
      ownerDid = (await Identity.fromPkcs8(identityBytes)).did();
      realFetch = globalThis.fetch;
    });

    afterEach(async () => {
      globalThis.fetch = realFetch;
      await Deno.remove(identityPath);
    });

    it("hands the deployment-posture request its startup signal", async () => {
      // Cancelling while the deployment is silent has to surface as a
      // rejection. Without the signal on that request the host would sit here
      // for as long as the deployment stayed quiet, past the point where its
      // own shutdown asked it to stop, and with nothing yet allocated able to
      // notice.
      const controller = new AbortController();
      let sawSignal = false;
      globalThis.fetch = (_input, init) => {
        sawSignal = init?.signal === controller.signal;
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(init.signal!.reason),
          );
          // The cancellation arrives with the request in flight.
          controller.abort(new Error("shutting down"));
        });
      };

      await expect(openAgentFabricRuntime({
        apiUrl: "https://deployment.example",
        identityPath,
        ownerDid,
        space: "a-space-of-its-own",
        signal: controller.signal,
      })).rejects.toThrow("shutting down");
      expect(sawSignal).toBe(true);
    });

    it("refuses an identity file it cannot read, before any request", async () => {
      let requested = false;
      globalThis.fetch = () => {
        requested = true;
        return Promise.resolve(new Response(null, { status: 503 }));
      };

      await expect(openAgentFabricRuntime({
        apiUrl: "https://deployment.example",
        identityPath: `${identityPath}.absent`,
        ownerDid,
        space: "a-space-of-its-own",
      })).rejects.toThrow(Deno.errors.NotFound);
      expect(requested).toBe(false);
    });

    it("disposes the runtime when its health check fails", async () => {
      globalThis.fetch = () =>
        Promise.resolve(new Response(null, { status: 503 }));

      await expect(openAgentFabricRuntime({
        apiUrl: "https://deployment.example",
        identityPath,
        ownerDid,
        space: "a-space-of-its-own",
      })).rejects.toThrow("could not connect to https://deployment.example");
    });

    for (const deferStorageClaim of [false, true]) {
      it(`publishes through released graph storage with deferred claim ${deferStorageClaim}`, async () => {
        const server = newLoopbackServer();
        try {
          using openStorage = stub(
            StorageManager,
            "open",
            (options) => EmulatedStorageManager.connectTo(server, options),
          );
          globalThis.fetch = (input) =>
            Promise.resolve(
              new Response(null, {
                status: new URL(String(input)).pathname === "/_health"
                  ? 200
                  : 503,
              }),
            );
          const fabric = await openAgentFabricRuntime({
            apiUrl: "https://deployment.example",
            identityPath,
            ownerDid,
            space: "a-space-of-its-own",
            deferStorageClaim,
          });
          await using runtime = fabric.runtime;
          await using graphRuntime = fabric.graphRuntime;
          using closeGraph = spy(graphRuntime.storageManager, "close");
          using writeGraph = spy(graphRuntime, "edit");
          expect(openStorage.calls.length).toBe(2);
          expect(graphRuntime.storageManager).not.toBe(runtime.storageManager);
          expect(graphRuntime.trustSnapshotProvider())
            .toEqual(runtime.trustSnapshotProvider());
          if (deferStorageClaim) await fabric.target.claimStorage();
          const collected: CollectedSource = {
            source: {
              id: "sample",
              driver: "acp",
              capabilities: {
                inventory: true,
                read: true,
                prompt: false,
                cancel: false,
                rename: false,
                setMode: false,
                setConfigOption: false,
              },
            },
            sessions: ["one", "two"].map((nativeSessionId) => ({
              summary: {
                nativeSessionId,
                title: nativeSessionId,
                cwd: null,
                createdAt: null,
                updatedAt: null,
                archived: false,
                active: false,
                raw: {},
              },
              events: [{ type: "message", text: nativeSessionId }],
              normalizedMessages: [],
              complete: true,
            })),
            errors: [],
            complete: true,
          };

          expect(await fabric.target.publish([collected])).toBe(2);
          expect(writeGraph.calls.length).toBeGreaterThan(0);
          expect(closeGraph.calls.length).toBe(2);
          expect(
            [...await fabric.target.publishedSessions()].map(([key]) => key),
          )
            .toEqual(["sample/one", "sample/two"]);
          expect(await fabric.target.publish([collected])).toBe(2);
          expect(closeGraph.calls.length).toBe(4);
          await graphRuntime.dispose();
          expect(closeGraph.calls.length).toBe(5);
          expect((await fabric.target.publishedSessions()).size).toBe(2);
        } finally {
          await server.close();
        }
      });
    }

    for (const cancel of [false, true]) {
      for (const cleanupFails of [false, true]) {
        it(`disposes both runtimes after ${cancel ? "cancellation" : "failure"} when cleanup fails ${cleanupFails}`, async () => {
          globalThis.fetch = () =>
            Promise.resolve(new Response(null, { status: 503 }));
          const controller = new AbortController();
          const reason = new Error("health check interrupted");
          using healthCheck = stub(Runtime.prototype, "healthCheck", () => {
            if (cancel) controller.abort(reason);
            return Promise.reject(reason);
          });
          const disposed: Runtime[] = [];
          const dispose = Runtime.prototype.dispose;
          const cleanupError = new Error("graph cleanup failed");
          using disposeRuntime = stub(
            Runtime.prototype,
            "dispose",
            async function () {
              disposed.push(this);
              await dispose.call(this);
              if (cleanupFails && disposed[0] === this) throw cleanupError;
            },
          );
          const opening = openAgentFabricRuntime({
            apiUrl: "https://deployment.example",
            identityPath,
            ownerDid,
            space: "a-space-of-its-own",
            signal: controller.signal,
          });

          if (cleanupFails) {
            const failure = await opening.then(() => {
              throw new Error("startup unexpectedly succeeded");
            }, (error: unknown) => error);
            expect(failure).toBeInstanceOf(AggregateError);
            if (!(failure instanceof AggregateError)) throw failure;
            expect(failure.message)
              .toBe("Fabric runtime startup and cleanup failed");
            const [startup, cleanup] = failure.errors;
            expect(failure.errors.length).toBe(2);
            expect(cleanup).toBeInstanceOf(AggregateError);
            expect(cleanup.message).toBe("Fabric runtime cleanup failed");
            expect(cleanup.errors.length).toBe(1);
            expect(cleanup.errors[0]).toBe(cleanupError);
            if (cancel) {
              expect(startup).toBeInstanceOf(AggregateError);
              expect(startup.message)
                .toBe("Fabric runtime startup cancellation and cleanup failed");
              expect(startup.errors.length).toBe(2);
              expect(startup.errors[0]).toBe(reason);
              expect(startup.errors[1]).toBe(cleanup);
            } else {
              expect(startup).toBe(reason);
            }
          } else {
            await expect(opening).rejects.toBe(reason);
          }
          expect(healthCheck.calls.length).toBe(1);
          expect(disposeRuntime.calls.length).toBe(2);
          expect(new Set(disposed).size).toBe(2);
          expect(disposed[1]).toBe(healthCheck.calls[0].self);
        });
      }
    }
  });
});
