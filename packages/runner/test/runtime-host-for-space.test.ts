import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import type { MemorySpace } from "@commonfabric/memory/interface";
import {
  FOREIGN_HOST_LIMIT,
  Runtime,
  type SpaceHostRegistration,
  SpaceHostValidationError,
} from "@commonfabric/runner";
import { StorageManager } from "../src/storage/cache.deno.ts";

const signer = await Identity.fromPassphrase("runtime-host-for-space");
const spaceA = signer.did();
const spaceB = "did:key:z6Mk-host-for-space-b" as MemorySpace;

function makeRuntime(spaceHostMap?: Record<string, string>) {
  const storageManager = StorageManager.emulate({ as: signer });
  return new Runtime({
    apiUrl: new URL("http://host-a.test/"),
    spaceHostMap,
    storageManager,
  });
}

function captureError(run: () => unknown): Error {
  try {
    run();
  } catch (error) {
    if (error instanceof Error) return error;
    throw error;
  }
  throw new Error("Expected call to throw");
}

function expectSafeValidationCause(
  error: Error,
  secret: string,
  message: string,
): void {
  expect(error.message).not.toContain(secret);
  expect(error.cause).toBeInstanceOf(SpaceHostValidationError);
  expect((error.cause as Error).message).toBe(message);
  expect((error.cause as Error).message).not.toContain(secret);
}

describe("Runtime.registerSpaceHost", () => {
  it("follows storage's verdict and routes compute on acceptance", async () => {
    const storageVerdicts: Array<[string, string]> = [];
    const storageManager = Object.assign(
      StorageManager.emulate({ as: signer }),
      {
        registerSpaceHost(space: string, host: string) {
          storageVerdicts.push([space, host]);
          return host !== "http://refused.test/";
        },
      },
    );
    const runtime = new Runtime({
      apiUrl: new URL("http://host-a.test/"),
      storageManager,
    });
    try {
      expect(runtime.registerSpaceHost(spaceB, "http://host-b.test/"))
        .toBe(true);
      expect(runtime.mappedHostFor(spaceB)).toBe("http://host-b.test/");
      expect(runtime.hostForSpace(spaceB).toString()).toBe(
        "http://host-b.test/",
      );
      // Storage refusal ⇒ compute routing must NOT diverge.
      const spaceC = "did:key:z6Mk-host-for-space-c" as MemorySpace;
      expect(runtime.registerSpaceHost(spaceC, "http://refused.test/"))
        .toBe(false);
      expect(runtime.mappedHostFor(spaceC)).toBeUndefined();
      expect(storageVerdicts.length).toBe(2);
    } finally {
      await runtime.dispose();
    }
  });

  it("returns false when the manager has no remote resolution", async () => {
    const runtime = makeRuntime();
    try {
      expect(runtime.registerSpaceHost(spaceB, "http://host-b.test/"))
        .toBe(false);
      expect(runtime.mappedHostFor(spaceB)).toBeUndefined();
    } finally {
      await runtime.dispose();
    }
  });

  describe("registerSpaceHostDetailed()", () => {
    it("returns storage's refusal and routes compute only on acceptance", async () => {
      const storageManager = Object.assign(
        StorageManager.emulate({ as: signer }),
        {
          registerSpaceHostDetailed(_space: string, host: string) {
            if (host === "http://pinned.test/") {
              return {
                accepted: false,
                reason: "default-route-in-use",
              } as const;
            }
            if (host === "http://other.test/") {
              return {
                accepted: false,
                reason: "known-different-host",
                existingHost: "http://host-b.test/",
              } as const;
            }
            return { accepted: true } as const;
          },
        },
      );
      const runtime = new Runtime({
        apiUrl: new URL("http://host-a.test/"),
        storageManager,
      });
      try {
        const spaceC = "did:key:z6Mk-host-for-space-c" as MemorySpace;
        expect(runtime.registerSpaceHostDetailed(spaceC, "http://pinned.test"))
          .toEqual({ accepted: false, reason: "default-route-in-use" });
        expect(runtime.mappedHostFor(spaceC)).toBeUndefined();

        expect(runtime.registerSpaceHostDetailed(spaceB, "http://host-b.test"))
          .toEqual({ accepted: true });
        expect(runtime.mappedHostFor(spaceB)).toBe("http://host-b.test/");

        expect(runtime.registerSpaceHostDetailed(spaceB, "http://other.test"))
          .toEqual({
            accepted: false,
            reason: "known-different-host",
            existingHost: "http://host-b.test/",
          });
        expect(runtime.mappedHostFor(spaceB)).toBe("http://host-b.test/");
      } finally {
        await runtime.dispose();
      }
    });

    describe("under a memory URL", () => {
      /**
       * A runtime whose storage takes every hint and records what it saw,
       * with `fetch` answering the meta documents of other deployments.
       */
      function routedRuntime(
        options: {
          apiUrl?: URL;
          memoryUrl?: URL;
          spaceHostMap?: Record<string, string>;
          fetch?: typeof globalThis.fetch;
          storage?: (space: string, host: string) => SpaceHostRegistration;
        },
      ) {
        const seen: string[] = [];
        const { storage, ...runtimeOptions } = options;
        const storageManager = Object.assign(
          StorageManager.emulate({ as: signer }),
          {
            registerSpaceHostDetailed(space: string, host: string) {
              seen.push(host);
              return storage?.(space, host) ?? { accepted: true } as const;
            },
          },
        );
        const runtime = new Runtime({
          apiUrl: new URL("http://host-a.test/"),
          storageManager,
          fetch: (input) => {
            throw new Error(`unexpected fetch of ${new URL(input as string)}`);
          },
          ...runtimeOptions,
        });
        return { runtime, seen };
      }

      /** The meta document `url` serves, or a status with no document. */
      type MetaAnswer = Record<string, unknown> | number | Error;

      /**
       * A `fetch` answering `/api/meta` on each origin of `answers`, counting
       * the requests by origin. A missing origin fails the connection.
       */
      function metaFetch(answers: Record<string, MetaAnswer>) {
        const requests = new Map<string, number>();
        const fetch: typeof globalThis.fetch = (input) => {
          const url = new URL(input as string);
          expect(url.pathname).toBe("/api/meta");
          requests.set(url.origin, (requests.get(url.origin) ?? 0) + 1);
          const answer = answers[url.origin];
          if (answer === undefined) {
            return Promise.reject(new TypeError("connection refused"));
          }
          if (answer instanceof Error) return Promise.reject(answer);
          if (typeof answer === "number") {
            return Promise.resolve(new Response(null, { status: answer }));
          }
          return Promise.resolve(
            new Response(JSON.stringify(answer), {
              headers: { "content-type": "application/json" },
            }),
          );
        };
        return { fetch, requests };
      }

      /** Runs `body` with `console.warn` captured. */
      async function warningsDuring(
        body: () => Promise<void>,
      ): Promise<string[]> {
        const warnings: string[] = [];
        const original = console.warn;
        console.warn = (...args: unknown[]) => warnings.push(String(args[0]));
        try {
          await body();
        } finally {
          console.warn = original;
        }
        return warnings;
      }

      const foreign = "http://host-b.test";
      const spaceC = "did:key:z6Mk-host-for-space-c" as MemorySpace;

      it("accepts the API host as the default route without recording it", async () => {
        const { runtime, seen } = routedRuntime({
          memoryUrl: new URL("http://router.test/"),
        });
        try {
          expect(runtime.memoryUrl?.href).toBe("http://router.test/");
          expect(
            runtime.registerSpaceHostDetailed(spaceB, "http://host-a.test"),
          )
            .toEqual({ accepted: true });
          expect(runtime.registerSpaceHost(spaceB, "http://host-a.test/"))
            .toBe(true);
          expect(runtime.mappedHostFor(spaceB)).toBeUndefined();
          expect(seen).toEqual([]);
        } finally {
          await runtime.dispose();
        }
      });

      it("accepts the memory URL's own origin as the default route without recording it", async () => {
        // The memory URL is where Memory already opens: a hint naming it can
        // neither move Memory nor route the space's HTTP work there.
        const { runtime, seen } = routedRuntime({
          memoryUrl: new URL("http://router.test/"),
        });
        try {
          for (const host of ["http://router.test/", "http://Router.test"]) {
            expect(runtime.registerSpaceHostDetailed(spaceB, host))
              .toEqual({ accepted: true });
            expect(runtime.registerSpaceHost(spaceB, host)).toBe(true);
            expect(await runtime.resolveSpaceHost(spaceB, host))
              .toEqual({ accepted: true });
          }
          expect(runtime.mappedHostFor(spaceB)).toBeUndefined();
          expect(runtime.hostForSpace(spaceB).href).toBe("http://host-a.test/");
          expect(seen).toEqual([]);
        } finally {
          await runtime.dispose();
        }
      });

      it("opens a foreign origin's Memory on the memory URL it publishes", async () => {
        const { fetch, requests } = metaFetch({
          [foreign]: { memoryUrl: "http://router-b.test" },
        });
        const { runtime, seen } = routedRuntime({
          memoryUrl: new URL("http://router.test/"),
          fetch,
        });
        try {
          expect(await runtime.resolveSpaceHost(spaceB, foreign))
            .toEqual({ accepted: true });
          // Storage opens the space's Memory where host-b says it serves it;
          // the space's HTTP work goes to host-b itself.
          expect(seen).toEqual(["http://router-b.test/"]);
          expect(runtime.mappedHostFor(spaceB)).toBe("http://host-b.test/");
          expect(runtime.hostForSpace(spaceB).href).toBe("http://host-b.test/");
          // A second space on the same origin is decided from the cached
          // read, synchronously.
          expect(runtime.registerSpaceHostDetailed(spaceC, `${foreign}/`))
            .toEqual({ accepted: true });
          expect(seen).toEqual([
            "http://router-b.test/",
            "http://router-b.test/",
          ]);
          expect(runtime.mappedHostFor(spaceC)).toBe("http://host-b.test/");
          expect(requests.get(foreign)).toBe(1);
        } finally {
          await runtime.dispose();
        }
      });

      it("opens a foreign origin's Memory on the origin when it publishes none", async () => {
        for (
          const answer of [
            404,
            405,
            410,
            {},
            { memoryUrl: null },
            { memoryUrl: "http://host-b.test/" },
          ] as MetaAnswer[]
        ) {
          const { fetch } = metaFetch({ [foreign]: answer });
          const { runtime, seen } = routedRuntime({
            memoryUrl: new URL("http://router.test/"),
            fetch,
          });
          try {
            expect(await runtime.resolveSpaceHost(spaceB, foreign))
              .toEqual({ accepted: true });
            expect(seen).toEqual(["http://host-b.test/"]);
            expect(runtime.mappedHostFor(spaceB)).toBe("http://host-b.test/");
          } finally {
            await runtime.dispose();
          }
        }
      });

      it("refuses a foreign origin whose meta document could not be read, warning once", async () => {
        for (
          const answer of [
            500,
            401,
            new TypeError("connection refused"),
            { memoryUrl: "ws://router-b.test/" },
            { memoryUrl: 7 },
          ] as MetaAnswer[]
        ) {
          const { fetch, requests } = metaFetch({ [foreign]: answer });
          const { runtime, seen } = routedRuntime({
            memoryUrl: new URL("http://router.test/"),
            fetch,
          });
          try {
            const warnings = await warningsDuring(async () => {
              expect(await runtime.resolveSpaceHost(spaceB, foreign))
                .toEqual({ accepted: false, reason: "foreign-host-unread" });
              expect(await runtime.resolveSpaceHost(spaceC, `${foreign}/`))
                .toEqual({ accepted: false, reason: "foreign-host-unread" });
              expect(runtime.registerSpaceHostDetailed(spaceB, foreign))
                .toEqual({ accepted: false, reason: "foreign-host-unread" });
              expect(runtime.registerSpaceHost(spaceB, foreign)).toBe(false);
            });
            // Neither storage nor the runtime routes the space anywhere: its
            // Memory is not sent to host-b, nor explicitly to this runtime's
            // own router.
            expect(seen).toEqual([]);
            expect(runtime.mappedHostFor(spaceB)).toBeUndefined();
            expect(runtime.mappedHostFor(spaceC)).toBeUndefined();
            expect(warnings.length).toBe(1);
            expect(warnings[0]).toContain(
              "Where http://host-b.test serves Memory could not be learned",
            );
            expect(warnings[0]).toContain("http://router.test/");
            // One read for the runtime's lifetime, retries included.
            expect(requests.get(foreign)).toBeGreaterThanOrEqual(1);
            const reads = requests.get(foreign);
            await runtime.resolveSpaceHost(spaceB, foreign);
            expect(requests.get(foreign)).toBe(reads);
          } finally {
            await runtime.dispose();
          }
        }
      });

      it("refuses a foreign origin whose meta document redirected off its deployment", async () => {
        const fetch: typeof globalThis.fetch = () =>
          Promise.resolve(
            Object.defineProperties(
              new Response(JSON.stringify({ memoryUrl: "http://evil.test" }), {
                headers: { "content-type": "application/json" },
              }),
              {
                redirected: { value: true },
                url: { value: "http://login.test/api/meta" },
              },
            ),
          );
        const { runtime, seen } = routedRuntime({
          memoryUrl: new URL("http://router.test/"),
          fetch,
        });
        try {
          const warnings = await warningsDuring(async () => {
            expect(await runtime.resolveSpaceHost(spaceB, foreign))
              .toEqual({ accepted: false, reason: "foreign-host-unread" });
          });
          expect(seen).toEqual([]);
          expect(warnings.length).toBe(1);
          expect(warnings[0]).toContain("redirected to http://login.test");
        } finally {
          await runtime.dispose();
        }
      });

      it("routes a sibling toolshed's space to it for compute while its Memory takes the default route", async () => {
        // host-b publishes this runtime's own memory URL: a sibling toolshed
        // behind the same router. Memory is already where it would open, so
        // storage is told nothing; the space's HTTP work goes to host-b.
        const { fetch, requests } = metaFetch({
          [foreign]: { memoryUrl: "http://router.test" },
        });
        const { runtime, seen } = routedRuntime({
          memoryUrl: new URL("http://router.test/"),
          fetch,
        });
        try {
          expect(await runtime.resolveSpaceHost(spaceB, foreign))
            .toEqual({ accepted: true });
          expect(runtime.registerSpaceHostDetailed(spaceC, `${foreign}/`))
            .toEqual({ accepted: true });
          expect(seen).toEqual([]);
          expect(runtime.mappedHostFor(spaceB)).toBe("http://host-b.test/");
          expect(runtime.mappedHostFor(spaceC)).toBe("http://host-b.test/");
          expect(runtime.hostForSpace(spaceB).href).toBe("http://host-b.test/");
          expect(requests.get(foreign)).toBe(1);
        } finally {
          await runtime.dispose();
        }
      });

      it("keeps the first route a space was given, whichever kind came first", async () => {
        // A sibling toolshed's route is recorded by the runtime alone, and a
        // foreign deployment's by storage; either fixes the space's route, so
        // the other kind of hint for the same space is refused as a different
        // host, as storage refuses one it was told about, and a repeated hint
        // confirms it.
        const sibling = "http://host-b.test";
        const other = "http://host-c.test";
        const { fetch } = metaFetch({
          [sibling]: { memoryUrl: "http://router.test" },
          [other]: { memoryUrl: "http://router-c.test" },
        });
        const { runtime, seen } = routedRuntime({
          memoryUrl: new URL("http://router.test/"),
          fetch,
        });
        try {
          // Sibling first: storage is never offered the other deployment.
          expect(await runtime.resolveSpaceHost(spaceB, sibling))
            .toEqual({ accepted: true });
          expect(await runtime.resolveSpaceHost(spaceB, other)).toEqual({
            accepted: false,
            reason: "known-different-host",
            existingHost: "http://host-b.test/",
          });
          expect(await runtime.resolveSpaceHost(spaceB, `${sibling}/`))
            .toEqual({ accepted: true });
          expect(seen).toEqual([]);
          expect(runtime.hostForSpace(spaceB).href).toBe("http://host-b.test/");
          // Other deployment first: the sibling cannot take over compute.
          expect(await runtime.resolveSpaceHost(spaceC, other))
            .toEqual({ accepted: true });
          expect(seen).toEqual(["http://router-c.test/"]);
          expect(runtime.registerSpaceHostDetailed(spaceC, sibling)).toEqual({
            accepted: false,
            reason: "known-different-host",
            existingHost: "http://host-c.test/",
          });
          expect(runtime.registerSpaceHost(spaceC, sibling)).toBe(false);
          expect(runtime.hostForSpace(spaceC).href).toBe("http://host-c.test/");
        } finally {
          await runtime.dispose();
        }
      });

      it("never reads this deployment's own origins", async () => {
        // The API origin and the memory URL are the default route by rule, not
        // by what their meta documents say: a meta document that named
        // another host for either could not move a space.
        const { fetch, requests } = metaFetch({
          "http://host-a.test": { memoryUrl: "http://elsewhere.test" },
          "http://router.test": { memoryUrl: "http://elsewhere.test" },
        });
        const { runtime, seen } = routedRuntime({
          memoryUrl: new URL("http://router.test/"),
          fetch,
        });
        try {
          for (const host of ["http://host-a.test/", "http://router.test/"]) {
            expect(await runtime.resolveSpaceHost(spaceB, host))
              .toEqual({ accepted: true });
          }
          expect(requests.size).toBe(0);
          expect(seen).toEqual([]);
          expect(runtime.mappedHostFor(spaceB)).toBeUndefined();
        } finally {
          await runtime.dispose();
        }
      });

      it("reports a foreign origin as `foreign-host-unresolved` until it is read, and shares one read", async () => {
        const gate = Promise.withResolvers<Response>();
        let reads = 0;
        const { runtime, seen } = routedRuntime({
          memoryUrl: new URL("http://router.test/"),
          fetch: () => {
            reads++;
            return gate.promise;
          },
        });
        try {
          // The synchronous forms start no read.
          expect(runtime.registerSpaceHostDetailed(spaceB, foreign))
            .toEqual({ accepted: false, reason: "foreign-host-unresolved" });
          expect(runtime.registerSpaceHost(spaceB, foreign)).toBe(false);
          expect(reads).toBe(0);
          const first = runtime.resolveSpaceHost(spaceB, foreign);
          const second = runtime.resolveSpaceHost(spaceC, `${foreign}/`);
          expect(reads).toBe(1);
          expect(runtime.registerSpaceHostDetailed(spaceB, foreign))
            .toEqual({ accepted: false, reason: "foreign-host-unresolved" });
          expect(seen).toEqual([]);
          gate.resolve(
            new Response(
              JSON.stringify({ memoryUrl: "http://router-b.test" }),
              {
                headers: { "content-type": "application/json" },
              },
            ),
          );
          expect(await first).toEqual({ accepted: true });
          expect(await second).toEqual({ accepted: true });
          expect(reads).toBe(1);
          expect(seen).toEqual([
            "http://router-b.test/",
            "http://router-b.test/",
          ]);
        } finally {
          await runtime.dispose();
        }
      });

      it("passes storage's refusal of the resolved memory host through", async () => {
        const { fetch } = metaFetch({
          [foreign]: { memoryUrl: "http://router-b.test" },
        });
        const { runtime, seen } = routedRuntime({
          memoryUrl: new URL("http://router.test/"),
          fetch,
          storage: () => ({ accepted: false, reason: "default-route-in-use" }),
        });
        try {
          expect(await runtime.resolveSpaceHost(spaceB, foreign))
            .toEqual({ accepted: false, reason: "default-route-in-use" });
          expect(seen).toEqual(["http://router-b.test/"]);
          expect(runtime.mappedHostFor(spaceB)).toBeUndefined();
        } finally {
          await runtime.dispose();
        }
      });

      it(`keeps ${FOREIGN_HOST_LIMIT} origins and refuses one more as \`foreign-host-limit\``, async () => {
        const answers: Record<string, MetaAnswer> = {};
        const origins = Array.from(
          { length: FOREIGN_HOST_LIMIT + 1 },
          (_, i) => `http://host-${i}.foreign.test`,
        );
        for (const origin of origins) answers[origin] = {};
        const { fetch, requests } = metaFetch(answers);
        const { runtime, seen } = routedRuntime({
          memoryUrl: new URL("http://router.test/"),
          fetch,
        });
        try {
          const kept = origins.slice(0, FOREIGN_HOST_LIMIT);
          const results = await Promise.all(
            kept.map((origin, i) =>
              runtime.resolveSpaceHost(
                `did:key:z6Mk-foreign-${i}` as MemorySpace,
                origin,
              )
            ),
          );
          expect(results.every((r) => r.accepted)).toBe(true);
          expect(seen.length).toBe(FOREIGN_HOST_LIMIT);
          const extra = origins[FOREIGN_HOST_LIMIT];
          expect(await runtime.resolveSpaceHost(spaceB, extra))
            .toEqual({ accepted: false, reason: "foreign-host-limit" });
          expect(runtime.registerSpaceHostDetailed(spaceB, extra))
            .toEqual({ accepted: false, reason: "foreign-host-limit" });
          expect(requests.has(extra)).toBe(false);
          // A kept origin is still served.
          expect(await runtime.resolveSpaceHost(spaceB, kept[0]))
            .toEqual({ accepted: true });
        } finally {
          await runtime.dispose();
        }
      });

      it("leaves a seeded space to storage", async () => {
        const { runtime, seen } = routedRuntime({
          memoryUrl: new URL("http://router.test/"),
          spaceHostMap: { [spaceC]: "http://seed.test/" },
        });
        try {
          expect(runtime.registerSpaceHostDetailed(spaceC, "http://seed.test/"))
            .toEqual({ accepted: true });
          expect(seen).toEqual(["http://seed.test/"]);
        } finally {
          await runtime.dispose();
        }
      });

      it("has none when it names the API host's own origin", async () => {
        const { runtime, seen } = routedRuntime({
          memoryUrl: new URL("http://host-a.test"),
        });
        try {
          expect(runtime.memoryUrl).toBeUndefined();
          expect(
            runtime.registerSpaceHostDetailed(spaceB, "http://host-b.test/"),
          )
            .toEqual({ accepted: true });
          expect(seen).toEqual(["http://host-b.test/"]);
        } finally {
          await runtime.dispose();
        }
      });

      it("accepts the API host's origin as the default route when the API URL has a path", async () => {
        const { runtime, seen } = routedRuntime({
          apiUrl: new URL("http://host-a.test/fabric/"),
          memoryUrl: new URL("http://router.test/"),
        });
        try {
          expect(
            runtime.registerSpaceHostDetailed(spaceB, "http://host-a.test"),
          )
            .toEqual({ accepted: true });
          expect(runtime.mappedHostFor(spaceB)).toBeUndefined();
          expect(seen).toEqual([]);
        } finally {
          await runtime.dispose();
        }
      });

      it("has none when it is the API URL itself, path and all", async () => {
        // A deployed client whose deployment publishes no memory URL hands
        // the runtime the host its storage opened on, which is the API URL.
        const apiUrl = new URL("http://host-a.test/fabric/");
        const { runtime, seen } = routedRuntime({ apiUrl, memoryUrl: apiUrl });
        try {
          expect(runtime.memoryUrl).toBeUndefined();
          expect(
            runtime.registerSpaceHostDetailed(spaceB, "http://host-b.test/"),
          )
            .toEqual({ accepted: true });
          expect(seen).toEqual(["http://host-b.test/"]);
        } finally {
          await runtime.dispose();
        }
      });

      it("refuses construction when it is not an HTTP or HTTPS origin", () => {
        expect(() =>
          routedRuntime({ memoryUrl: new URL("http://router.test/api") })
        ).toThrow(SpaceHostValidationError);
      });
    });

    it("returns `no-remote-resolution` from an emulated manager", async () => {
      const runtime = makeRuntime();
      try {
        expect(
          runtime.storageManager.registerSpaceHostDetailed?.(
            spaceB,
            "http://host-b.test/",
          ),
        ).toEqual({ accepted: false, reason: "no-remote-resolution" });
        expect(runtime.registerSpaceHostDetailed(spaceB, "http://host-b.test/"))
          .toEqual({ accepted: false, reason: "no-remote-resolution" });
        expect(runtime.mappedHostFor(spaceB)).toBeUndefined();
      } finally {
        await runtime.dispose();
      }
    });

    it("returns `unspecified` for a refusal by a manager that gives only a verdict", async () => {
      const storageManager = Object.assign(
        StorageManager.emulate({ as: signer }),
        {
          registerSpaceHostDetailed: undefined,
          registerSpaceHost(_space: string, host: string) {
            return host !== "http://refused.test/";
          },
        },
      );
      const runtime = new Runtime({
        apiUrl: new URL("http://host-a.test/"),
        storageManager,
      });
      try {
        expect(
          runtime.registerSpaceHostDetailed(spaceB, "http://refused.test/"),
        ).toEqual({ accepted: false, reason: "unspecified" });
        expect(runtime.mappedHostFor(spaceB)).toBeUndefined();
        expect(runtime.registerSpaceHostDetailed(spaceB, "http://host-b.test/"))
          .toEqual({ accepted: true });
        expect(runtime.mappedHostFor(spaceB)).toBe("http://host-b.test/");
      } finally {
        await runtime.dispose();
      }
    });

    it("returns `no-remote-resolution` when the manager takes no hints", async () => {
      const runtime = new Runtime({
        apiUrl: new URL("http://host-a.test/"),
        storageManager: Object.assign(StorageManager.emulate({ as: signer }), {
          registerSpaceHostDetailed: undefined,
          registerSpaceHost: undefined,
        }),
      });
      try {
        expect(runtime.registerSpaceHostDetailed(spaceB, "http://host-b.test/"))
          .toEqual({ accepted: false, reason: "no-remote-resolution" });
        expect(runtime.registerSpaceHost(spaceB, "http://host-b.test/"))
          .toBe(false);
        expect(runtime.mappedHostFor(spaceB)).toBeUndefined();
      } finally {
        await runtime.dispose();
      }
    });

    it("throws on a host that is not an origin, naming the space", async () => {
      const runtime = makeRuntime();
      try {
        expect(() =>
          runtime.registerSpaceHostDetailed(spaceB, "https://host-b.test/api")
        ).toThrow(`Invalid host for space ${spaceB}`);
      } finally {
        await runtime.dispose();
      }
    });
  });

  it("takes the verdict of a manager that gives only a registration", async () => {
    const storageManager = Object.assign(
      StorageManager.emulate({ as: signer }),
      {
        registerSpaceHost: undefined,
        registerSpaceHostDetailed(_space: string, host: string) {
          return host === "http://refused.test/"
            ? { accepted: false, reason: "default-route-in-use" } as const
            : { accepted: true } as const;
        },
      },
    );
    const runtime = new Runtime({
      apiUrl: new URL("http://host-a.test/"),
      storageManager,
    });
    try {
      expect(runtime.registerSpaceHost(spaceB, "http://refused.test/"))
        .toBe(false);
      expect(runtime.mappedHostFor(spaceB)).toBeUndefined();
      expect(runtime.registerSpaceHost(spaceB, "http://host-b.test/"))
        .toBe(true);
      expect(runtime.mappedHostFor(spaceB)).toBe("http://host-b.test/");
    } finally {
      await runtime.dispose();
    }
  });

  it("rejects non-origin hints before forwarding them to storage", async () => {
    const storageVerdicts: Array<[string, string]> = [];
    const storageManager = Object.assign(
      StorageManager.emulate({ as: signer }),
      {
        registerSpaceHost(space: string, host: string) {
          storageVerdicts.push([space, host]);
          return true;
        },
      },
    );
    const runtime = new Runtime({
      apiUrl: new URL("http://host-a.test/"),
      storageManager,
    });
    try {
      for (
        const host of [
          "ws://host-b.test",
          "wss://host-b.test",
          "ftp://host-b.test",
          "https://user@host-b.test/",
          "https://host-b.test/api",
          "https://host-b.test/api/..",
          "https://host-b.test/?region=west",
          "https://host-b.test/#primary",
        ]
      ) {
        expect(() => runtime.registerSpaceHost(spaceB, host))
          .toThrow(`Invalid host for space ${spaceB}`);
      }
      expect(storageVerdicts).toEqual([]);

      expect(runtime.registerSpaceHost(spaceB, "https://host-b.test"))
        .toBe(true);
      expect(storageVerdicts).toEqual([
        [spaceB, "https://host-b.test/"],
      ]);
      expect(runtime.mappedHostFor(spaceB)).toBe("https://host-b.test/");
    } finally {
      await runtime.dispose();
    }
  });

  it("preserves safe validation causes without repeating route secrets", async () => {
    const hosts = [
      [
        "https://user:route-password-sentinel@host-b.test/",
        "route-password-sentinel",
        "Space host must not include credentials",
      ],
      [
        "https://host-b.test/?token=route-query-sentinel",
        "route-query-sentinel",
        "Space host must not include a query",
      ],
      [
        "https://user:route-parse-password-sentinel@[/",
        "route-parse-password-sentinel",
        "Invalid space host URL",
      ],
    ] as const;
    const runtime = makeRuntime();
    try {
      for (const [host, secret, message] of hosts) {
        const error = captureError(() =>
          runtime.registerSpaceHost(spaceB, host)
        );
        expectSafeValidationCause(error, secret, message);
      }
    } finally {
      await runtime.dispose();
    }

    for (const [host, secret, message] of hosts) {
      const error = captureError(() => makeRuntime({ [spaceB]: host }));
      expectSafeValidationCause(error, secret, message);
    }
  });
});

describe("Runtime.hostForSpace", () => {
  it("rejects seeded hosts that cannot serve HTTP requests", () => {
    for (
      const host of [
        "ws://host-b.test",
        "wss://host-b.test",
        "ftp://host-b.test",
        "https://user@host-b.test/",
        "https://host-b.test/api",
        "https://host-b.test/%2e%2e/",
        "https://host-b.test/?region=west",
        "https://host-b.test/#primary",
      ]
    ) {
      expect(() => makeRuntime({ [spaceB]: host }))
        .toThrow(`Invalid spaceHostMap entry for ${spaceB}`);
    }
  });

  it("resolves mapped spaces to their host and others to apiUrl", async () => {
    const runtime = makeRuntime({ [spaceB]: "http://host-b.test" });
    try {
      expect(runtime.hostForSpace(spaceA).toString()).toBe(
        "http://host-a.test/",
      );
      expect(runtime.hostForSpace(spaceB).toString()).toBe(
        "http://host-b.test/",
      );
    } finally {
      await runtime.dispose();
    }
  });

  it("healthCheck fans out over the default and every mapped host", async () => {
    const dialed: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = ((input: RequestInfo | URL) => {
      dialed.push(String(input));
      return Promise.resolve(new Response("ok", { status: 200 }));
    }) as typeof fetch;
    const runtime = makeRuntime({
      [spaceB]: "http://host-b.test",
      "did:key:z6Mk-host-for-space-c": "http://host-b.test", // dupe host
    });
    try {
      expect(await runtime.healthCheck()).toBe(true);
      expect(dialed.sort()).toEqual([
        "http://host-a.test/_health",
        "http://host-b.test/_health",
      ]);
    } finally {
      globalThis.fetch = realFetch;
      await runtime.dispose();
    }
  });

  it("healthCheck captures the default host's gitSha header; other hosts don't overwrite it", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = ((input: RequestInfo | URL) => {
      const sha = String(input).startsWith("http://host-a.test")
        ? "  abc123  "
        : "not-the-default-host";
      return Promise.resolve(
        new Response("ok", {
          status: 200,
          headers: { "x-cf-git-sha": sha },
        }),
      );
    }) as typeof fetch;
    const runtime = makeRuntime({ [spaceB]: "http://host-b.test" });
    try {
      expect(runtime.serverGitSha).toBe(null);
      expect(await runtime.healthCheck()).toBe(true);
      expect(runtime.serverGitSha).toBe("abc123");
    } finally {
      globalThis.fetch = realFetch;
      await runtime.dispose();
    }
  });

  it("healthCheck reports null gitSha without the header, and resets a stale capture", async () => {
    const realFetch = globalThis.fetch;
    let headers: Record<string, string> = { "x-cf-git-sha": "abc123" };
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response("ok", { status: 200, headers }),
      )) as typeof fetch;
    const runtime = makeRuntime();
    try {
      expect(await runtime.healthCheck()).toBe(true);
      expect(runtime.serverGitSha).toBe("abc123");
      // An older server without the header must reset the capture.
      headers = {};
      expect(await runtime.healthCheck()).toBe(true);
      expect(runtime.serverGitSha).toBe(null);
    } finally {
      globalThis.fetch = realFetch;
      await runtime.dispose();
    }
  });

  it("healthCheck completes at headers-arrival: an open body stream cannot gate it", async () => {
    const realFetch = globalThis.fetch;
    // A 200 whose body stream never closes. The capture reads only headers,
    // so health must resolve; awaiting the body would hang forever.
    const openBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"status":"OK"'));
        // never closed
      },
    });
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(openBody, {
          status: 200,
          headers: { "x-cf-git-sha": "abc123" },
        }),
      )) as typeof fetch;
    const runtime = makeRuntime();
    try {
      expect(await runtime.healthCheck()).toBe(true);
      expect(runtime.serverGitSha).toBe("abc123");
    } finally {
      globalThis.fetch = realFetch;
      await openBody.cancel();
      await runtime.dispose();
    }
  });

  it("an overdue earlier healthCheck cannot overwrite a newer call's capture", async () => {
    const realFetch = globalThis.fetch;
    const gate: Array<(res: Response) => void> = [];
    const responseWith = (sha: string) =>
      new Response("ok", { status: 200, headers: { "x-cf-git-sha": sha } });
    let call = 0;
    globalThis.fetch = (() => {
      call++;
      if (call === 1) {
        // First call's response is withheld until released below.
        return new Promise<Response>((resolve) => {
          gate.push(resolve);
        });
      }
      return Promise.resolve(responseWith("second"));
    }) as typeof fetch;
    const runtime = makeRuntime();
    try {
      const first = runtime.healthCheck();
      expect(await runtime.healthCheck()).toBe(true);
      expect(runtime.serverGitSha).toBe("second");
      gate[0]!(responseWith("first"));
      expect(await first).toBe(true);
      // The stale response arrived last but belongs to a superseded call.
      expect(runtime.serverGitSha).toBe("second");
    } finally {
      globalThis.fetch = realFetch;
      await runtime.dispose();
    }
  });

  it("healthCheck is false when any host is unreachable", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = ((input: RequestInfo | URL) =>
      Promise.resolve(
        new Response("", {
          status: String(input).includes("host-b") ? 500 : 200,
        }),
      )) as typeof fetch;
    const runtime = makeRuntime({ [spaceB]: "http://host-b.test" });
    try {
      expect(await runtime.healthCheck()).toBe(false);
    } finally {
      globalThis.fetch = realFetch;
      await runtime.dispose();
    }
  });

  it("healthCheck forwards cancellation to its requests", async () => {
    const realFetch = globalThis.fetch;
    const controller = new AbortController();
    const reason = new Error("health check canceled");
    const receivedSignals: Array<AbortSignal | null> = [];
    let requestCount = 0;
    let requestEntered!: () => void;
    const requestsStarted = new Promise<void>((resolve) => {
      requestEntered = () => {
        requestCount++;
        if (requestCount === 2) resolve();
      };
    });
    const rejectRequests: Array<(reason?: unknown) => void> = [];
    let runtime: ReturnType<typeof makeRuntime> | undefined;
    let check: Promise<boolean> | undefined;
    try {
      globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
        const signal = init?.signal ?? null;
        receivedSignals.push(signal);
        requestEntered();
        return new Promise<Response>((_resolve, reject) => {
          rejectRequests.push(reject);
          signal?.addEventListener(
            "abort",
            () => reject(signal.reason),
            { once: true },
          );
        });
      }) as typeof fetch;
      runtime = makeRuntime({ [spaceB]: "http://host-b.test" });
      check = runtime.healthCheck(controller.signal);
      const requestState = await Promise.race([
        requestsStarted.then(() => "started" as const),
        check.then(
          () => "completed" as const,
          () => "completed" as const,
        ),
      ]);
      expect(requestState).toBe("started");
      expect(receivedSignals).toEqual([
        controller.signal,
        controller.signal,
      ]);
      controller.abort(reason);
      await expect(check).rejects.toBe(reason);
    } finally {
      controller.abort(reason);
      for (const rejectRequest of rejectRequests) rejectRequest(reason);
      await check?.catch(() => {});
      globalThis.fetch = realFetch;
      await runtime?.dispose();
    }
  });
});
