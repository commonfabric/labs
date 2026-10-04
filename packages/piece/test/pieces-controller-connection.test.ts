import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { stub } from "@std/testing/mock";

import { Identity, legacySpaceDid } from "@commonfabric/identity";
import { Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache";
import { StorageManager as EmulatedStorage } from "@commonfabric/runner/storage/cache.deno";

import { PiecesController } from "../src/ops/pieces-controller.ts";

const identity = await Identity.fromPassphrase(
  "pieces controller connection tests",
);

describe("pieces-controller", () => {
  describe("PiecesController", () => {
    describe("static members", () => {
      describe("initialize()", () => {
        const apiUrl = new URL("http://toolshed.test/");
        let requested: string[];
        let realFetch: typeof globalThis.fetch;

        beforeEach(() => {
          requested = [];
          realFetch = globalThis.fetch;
          globalThis.fetch = (input: string | URL | Request) => {
            requested.push(
              input instanceof Request ? input.url : input.toString(),
            );
            return Promise.resolve(new Response(null, { status: 503 }));
          };
        });

        afterEach(() => {
          globalThis.fetch = realFetch;
        });

        it("throws naming the API when the server is not healthy", async () => {
          await expect(PiecesController.initialize({
            apiUrl,
            identity,
            space: "unhealthy-space",
          })).rejects.toThrow('Could not connect to "http://toolshed.test/".');
        });

        it("asks the API for its posture and health before reading the space", async () => {
          await expect(PiecesController.initialize({
            apiUrl,
            identity,
            space: "unhealthy-space",
          })).rejects.toThrow();
          // The deployment's experimental posture first, because it decides
          // how the runtime is constructed; then the health probe that
          // decides whether to go on at all. The stub answers 503 to both,
          // and a non-OK posture response is read as an absent posture,
          // which is why the controller goes on to the health probe.
          expect(requested).toEqual([
            "http://toolshed.test/api/meta",
            "http://toolshed.test/_health",
          ]);
        });

        it("takes an apiUrl written as a string", async () => {
          await expect(PiecesController.initialize({
            apiUrl: "http://toolshed.test",
            identity,
            space: "unhealthy-space",
          })).rejects.toThrow('Could not connect to "http://toolshed.test/".');
        });

        it("does not install a navigation callback", async () => {
          const originalHealthCheck = Runtime.prototype.healthCheck;
          let created: Runtime | undefined;
          Runtime.prototype.healthCheck = function () {
            created = this;
            return Promise.resolve(false);
          };
          try {
            await expect(PiecesController.initialize({
              apiUrl,
              identity,
              space: "navigation-without-registration",
            })).rejects.toThrow(
              'Could not connect to "http://toolshed.test/".',
            );
            expect(created?.navigateCallback).toBeUndefined();
          } finally {
            Runtime.prototype.healthCheck = originalHealthCheck;
          }
        });

        it("builds the runtime under the posture it is given rather than the one the deployment declares", async () => {
          const originalHealthCheck = Runtime.prototype.healthCheck;
          let created: Runtime | undefined;
          Runtime.prototype.healthCheck = function () {
            created = this;
            return Promise.resolve(false);
          };
          try {
            await expect(PiecesController.initialize({
              apiUrl,
              identity,
              space: "posture-given",
              experimental: { serverExecution: false },
            })).rejects.toThrow(
              'Could not connect to "http://toolshed.test/".',
            );
            expect(created?.experimental.serverExecution).toBe(false);
            // The posture was the caller's, so the deployment was not asked
            // for one; with the health probe stubbed, nothing was requested.
            expect(requested).toEqual([]);
          } finally {
            Runtime.prototype.healthCheck = originalHealthCheck;
          }
        });

        describe("the read ceiling", () => {
          // Stated per arm: on the OFF arm the controller's own runtime
          // issues the session's queries under the ceiling, and on the ON
          // arm the runtime hands it to its sessions for the space server's
          // runtime to serve under. Either way the runtime the controller
          // builds holds it.

          for (const serverExecution of [false, true]) {
            it(`hands the read ceiling and its mode to the runtime it builds with serverExecution ${serverExecution}`, async () => {
              const originalHealthCheck = Runtime.prototype.healthCheck;
              let created: Runtime | undefined;
              Runtime.prototype.healthCheck = function () {
                created = this;
                return Promise.resolve(false);
              };
              try {
                await expect(PiecesController.initialize({
                  apiUrl,
                  identity,
                  space: "read-ceiling-forwarded",
                  experimental: { serverExecution },
                  cfcReadMaxConfidentiality: [identity.did()],
                  cfcReadOnExceed: "skip",
                })).rejects.toThrow(
                  'Could not connect to "http://toolshed.test/".',
                );
                expect(created?.experimental.serverExecution).toBe(
                  serverExecution,
                );
                expect(created?.cfcReadMaxConfidentiality).toEqual([
                  identity.did(),
                ]);
                expect(created?.cfcReadOnExceed).toBe("skip");
              } finally {
                Runtime.prototype.healthCheck = originalHealthCheck;
              }
            });
          }
        });

        it("opens the DID a legacy space name resolves to, and creates no space there", async () => {
          // The memory host is replaced by an emulated one and the health
          // probe passes, so the controller opens the space for real.

          const storageManager = EmulatedStorage.emulate({ as: identity });
          using _open = stub(StorageManager, "open", () => storageManager);
          using _healthy = stub(
            Runtime.prototype,
            "healthCheck",
            () => Promise.resolve(true),
          );

          const pieces = await PiecesController.initialize({
            apiUrl,
            identity,
            space: "team-lunch",
            experimental: {},
          });
          try {
            expect(pieces.getSpace()).toBe(await legacySpaceDid("team-lunch"));
            expect(pieces.getSpaceName()).toBe("team-lunch");
            expect(await pieces.runtime.spaceExists(pieces.getSpace())).toBe(
              false,
            );
          } finally {
            await pieces.runtime.dispose();
          }
        });

        it("throws the space's authorization denial once its session has opened", async () => {
          // A denial reaches no caller through `synced()`, so the controller
          // asks the storage manager for it by name after the session opens.

          const storageManager = EmulatedStorage.emulate({ as: identity });
          using _open = stub(StorageManager, "open", () => storageManager);
          using _healthy = stub(
            Runtime.prototype,
            "healthCheck",
            () => Promise.resolve(true),
          );
          const space = (await Identity.fromPassphrase("a denied space")).did();
          const denial = new Error("denied by the space's access control list");
          const asked: string[] = [];
          using _denied = stub(
            storageManager,
            "authorizationError",
            (of) => {
              asked.push(of);
              return denial;
            },
          );

          const opening = PiecesController.initialize({
            apiUrl,
            identity,
            space,
            experimental: {},
          });
          await expect(opening).rejects.toBe(denial);
          expect(asked).toEqual([space]);
        });

        it("throws the connection error for a space given as a `did:key:` DID", async () => {
          const spaceDid = (await Identity.fromPassphrase("a space of its own"))
            .did();
          await expect(PiecesController.initialize({
            apiUrl,
            identity,
            space: spaceDid,
          })).rejects.toThrow('Could not connect to "http://toolshed.test/".');
        });
      });
    });
  });
});
