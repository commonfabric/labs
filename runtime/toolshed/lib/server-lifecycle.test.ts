import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { stub } from "@std/testing/mock";
import { Identity } from "@commonfabric/identity";
import { Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import type {
  PatternLifecycleHandler,
  ServedRequestHandler,
} from "@commonfabric/memory/v2/server";
import env from "@/env.ts";
import { STARTUP_PROBE_HEADER } from "@/lib/internal-api-origin.ts";
import {
  createShutdown,
  type ServerStartDeps,
  type ServingHooks,
  startRuntimes,
  startServer,
} from "@/lib/server-lifecycle.ts";
import { Exited } from "@/test/support/exited.ts";

// An `exit` that records its status and, like `Deno.exit`, does not return.
const exitRecorder = () => {
  const codes: number[] = [];
  const exit = (code: number): never => {
    codes.push(code);
    throw new Exited(code);
  };
  return { codes, exit };
};

// The memory server's verb hooks, recording what each is set to.
const hooksRecorder = () => {
  const installed: { lifecycle: unknown[]; served: unknown[] } = {
    lifecycle: [],
    served: [],
  };
  const hooks: ServingHooks = {
    setPatternLifecycleHandler: (handler) => {
      installed.lifecycle.push(handler);
    },
    setServedRequestHandler: (handler) => {
      installed.served.push(handler);
    },
  };
  return { installed, hooks };
};

const lifecycleHandler: PatternLifecycleHandler = () =>
  Promise.reject(new Error("no verbs run here"));
const servedHandler: ServedRequestHandler = () =>
  Promise.reject(new Error("no crossings run here"));

describe("server-lifecycle", () => {
  describe("startRuntimes()", () => {
    let storageManager: ReturnType<typeof StorageManager.emulate>;
    let runtime: Runtime;

    beforeEach(async () => {
      storageManager = StorageManager.emulate({
        as: await Identity.fromPassphrase("server-lifecycle"),
      });
      runtime = new Runtime({
        apiUrl: new URL("https://server-lifecycle.invalid"),
        storageManager,
      });
    });

    afterEach(async () => {
      await runtime.dispose();
      await storageManager.close();
    });

    const deps = (overrides: Partial<Parameters<typeof startRuntimes>[0]>) => {
      const { installed, hooks } = hooksRecorder();
      const logged: unknown[][] = [];
      const errors: unknown[][] = [];
      return {
        installed,
        logged,
        errors,
        deps: {
          signerDid: "did:key:z6MkSigner",
          memoryUrl: "http://memory.test",
          createRuntime: () => runtime,
          startServingHost: () => false,
          memoryServer: hooks,
          lifecycleHandler,
          servedHandler,
          log: (...data: unknown[]) => logged.push(data),
          error: (...data: unknown[]) => errors.push(data),
          ...overrides,
        },
      };
    };

    it("returns the runtime it constructs, and leaves the verb hooks alone when no serving loop starts", () => {
      const { installed, logged, deps: d } = deps({});

      expect(startRuntimes(d)).toBe(runtime);

      expect(logged).toEqual([
        ["Initializing runtime with signer did:key:z6MkSigner..."],
        ["Runtime initialized successfully"],
        ["Configured to remote storage:", "http://memory.test"],
      ]);
      expect(installed).toEqual({ lifecycle: [], served: [] });
    });

    it("points the verb hooks at their handlers when a serving loop starts", () => {
      const { installed, deps: d } = deps({
        startServingHost: () => true,
      });

      expect(startRuntimes(d)).toBe(runtime);

      expect(installed).toEqual({
        lifecycle: [lifecycleHandler],
        served: [servedHandler],
      });
    });

    it("logs and rethrows a runtime that fails to construct, starting no serving host", () => {
      const failure = new Error("memory host unreachable");
      let hostStarted = false;
      const { errors, deps: d } = deps({
        createRuntime: () => {
          throw failure;
        },
        startServingHost: () => {
          hostStarted = true;
          return true;
        },
      });

      expect(() => startRuntimes(d)).toThrow(failure);

      expect(errors).toEqual([["Failed to initialize runtime:", failure]]);
      expect(hostStarted).toBe(false);
    });
  });

  describe("createShutdown()", () => {
    const shutdownWith = (
      overrides: Partial<Parameters<typeof createShutdown>[0]> = {},
    ) => {
      const steps: string[] = [];
      const logged: unknown[] = [];
      const exits: number[] = [];
      const { installed, hooks } = hooksRecorder();
      const shutdown = createShutdown({
        abort: () => steps.push("abort"),
        memoryServer: hooks,
        stopServingHost: () => {
          steps.push("stop serving host");
          return Promise.resolve();
        },
        closeMemory: () => {
          steps.push("close memory");
          return Promise.resolve();
        },
        flushTelemetry: () => {
          steps.push("flush telemetry");
          return Promise.resolve();
        },
        limitMs: 60_000,
        exit: (code) => exits.push(code),
        log: (text) => logged.push(text),
        ...overrides,
      });
      return { shutdown, steps, logged, exits, installed };
    };

    it("stops the listener, unhooks the verbs, closes memory and flushes telemetry, then exits 0", async () => {
      const { shutdown, steps, logged, exits, installed } = shutdownWith();

      expect(shutdown.inProgress()).toBe(false);
      await shutdown.handle();

      expect(shutdown.inProgress()).toBe(true);
      expect(steps).toEqual([
        "abort",
        "stop serving host",
        "close memory",
        "flush telemetry",
      ]);
      expect(installed).toEqual({
        lifecycle: [undefined],
        served: [undefined],
      });
      expect(logged.at(-1)).toBe("Shutdown complete");
      expect(exits).toEqual([0]);
    });

    it("logs a second signal during shutdown and runs nothing again", async () => {
      const closing = Promise.withResolvers<void>();
      const { shutdown, steps, logged, exits } = shutdownWith({
        closeMemory: () => closing.promise,
      });

      const first = shutdown.handle();
      await shutdown.handle();
      expect(logged).toContain("Shutdown already in progress...");
      expect(exits).toEqual([]);

      closing.resolve();
      await first;
      expect(steps.filter((step) => step === "abort")).toEqual(["abort"]);
      expect(exits).toEqual([0]);
    });

    it("exits 1 when a step fails, without running the steps after it", async () => {
      using _error = stub(console, "error");
      const { shutdown, steps, logged, exits } = shutdownWith({
        closeMemory: () => Promise.reject(new Error("store locked")),
      });

      await shutdown.handle();

      expect(steps).not.toContain("flush telemetry");
      expect(logged.at(-1)).toBe("Shutdown failed");
      expect(exits).toEqual([1]);
    });
  });

  describe("startServer()", () => {
    const quietEnv: ServerStartDeps["env"] = {
      ...env,
      HOST: "127.0.0.1",
      PORT: 0,
      EXPOSE_GC: false,
      API_INTERNAL_URL: undefined,
    };
    const info: Deno.ServeHandlerInfo<Deno.NetAddr> = {
      remoteAddr: { transport: "tcp", hostname: "127.0.0.1", port: 50000 },
      completed: Promise.resolve(),
    };

    // A `serve` that binds nothing, and records what it was handed.
    const fakeServe = () => {
      const served: {
        options?: Deno.ServeTcpOptions;
        handler?: Deno.ServeHandler<Deno.NetAddr>;
      } = {};
      const serve: ServerStartDeps["serve"] = (options, handler) => {
        served.options = options;
        served.handler = handler;
      };
      const request = (input: string | Request, init?: RequestInit) => {
        if (served.handler === undefined) throw new Error("Nothing served");
        return Promise.resolve(
          served.handler(new Request(input, init), info),
        );
      };
      const listen = () =>
        served.options?.onListen?.({
          transport: "tcp",
          hostname: "127.0.0.1",
          port: 8123,
        });
      return { served, serve, request, listen };
    };

    const startDeps = (
      overrides: Partial<ServerStartDeps> = {},
    ) => {
      const events: string[] = [];
      const logged: unknown[][] = [];
      const errors: unknown[][] = [];
      const exits = exitRecorder();
      const deps: ServerStartDeps = {
        env: quietEnv,
        handler: () => new Response("donuts"),
        serve: fakeServe().serve,
        startRuntimes: () => events.push("runtimes"),
        signal: new AbortController().signal,
        shuttingDown: () => false,
        exposeGarbageCollector: () => events.push("expose gc"),
        probeFetch: () => Promise.reject(new Error("No probe is expected")),
        onListening: () => events.push("listening"),
        exit: exits.exit,
        log: (...data) => logged.push(data),
        error: (...data) => errors.push(data),
        ...overrides,
      };
      return { deps, events, logged, errors, exits: exits.codes };
    };

    it("starts the runtimes, then serves on the configured host and port until aborted", async () => {
      const abort = new AbortController();
      const bound = Promise.withResolvers<Deno.HttpServer<Deno.NetAddr>>();
      const { deps, events, logged } = startDeps({
        signal: abort.signal,
        serve: (options, handler) =>
          bound.resolve(Deno.serve(options, handler)),
      });

      await startServer(deps);

      expect(events).toEqual(["runtimes", "listening"]);
      const server = await bound.promise;
      const port = server.addr.port;
      expect(logged).toContainEqual([
        `Server running on http://127.0.0.1:${port}`,
      ]);
      const response = await fetch(`http://127.0.0.1:${port}/`);
      expect(await response.text()).toBe("donuts");

      abort.abort();
      await server.finished;
    });

    it("answers 500 and logs the failure of a handler that throws", async () => {
      const abort = new AbortController();
      const bound = Promise.withResolvers<Deno.HttpServer<Deno.NetAddr>>();
      const failure = new Error("fryer on fire");
      const { deps, errors } = startDeps({
        signal: abort.signal,
        handler: () => {
          throw failure;
        },
        serve: (options, handler) =>
          bound.resolve(Deno.serve(options, handler)),
      });
      await startServer(deps);
      const server = await bound.promise;

      const response = await fetch(`http://127.0.0.1:${server.addr.port}/`);

      expect(response.status).toBe(500);
      expect(await response.text()).toBe("Internal Server Error");
      expect(errors).toEqual([["Server error:", failure]]);
      abort.abort();
      await server.finished;
    });

    it("exposes the garbage collector before serving only when EXPOSE_GC is set", () => {
      const exposed = startDeps({ env: { ...quietEnv, EXPOSE_GC: true } });
      void startServer(exposed.deps);
      expect(exposed.events).toEqual(["expose gc", "runtimes"]);

      const hidden = startDeps();
      void startServer(hidden.deps);
      expect(hidden.events).toEqual(["runtimes"]);
    });

    it("exits 3 when the port is already in use", () => {
      using taken = Deno.listen({ hostname: "127.0.0.1", port: 0 });
      const port = taken.addr.port;
      const { deps, errors, exits } = startDeps({
        env: { ...quietEnv, PORT: port },
        serve: Deno.serve,
      });

      expect(() => startServer(deps)).toThrow(new Exited(3));

      expect(exits).toEqual([3]);
      expect(errors).toEqual([[`Port ${port} is already in use`]]);
    });

    it("exits 1 when the listener fails to start for another reason", () => {
      const failure = new Deno.errors.PermissionDenied("net access denied");
      const { deps, errors, exits } = startDeps({
        serve: () => {
          throw failure;
        },
      });

      expect(() => startServer(deps)).toThrow(new Exited(1));

      expect(exits).toEqual([1]);
      expect(errors).toEqual([["Failed to start server:", failure]]);
    });

    describe("with an internal API origin", () => {
      const ORIGIN = "http://127.0.0.1:8123";
      const internalEnv = { ...quietEnv, API_INTERNAL_URL: ORIGIN };

      it("answers 503 until the origin is verified as this listener, then starts the runtimes and serves", async () => {
        const fake = fakeServe();
        const { deps, events, logged } = startDeps({
          env: internalEnv,
          serve: fake.serve,
          // The probe reaches this listener.
          probeFetch: (input, init) => fake.request(String(input), init),
        });

        const started = startServer(deps);
        expect(logged).toContainEqual([
          "Configured internal API origin:",
          ORIGIN,
        ]);
        expect(events).toEqual([]);
        expect((await fake.request("http://127.0.0.1:8123/")).status).toBe(
          503,
        );

        fake.listen();
        await started;

        expect(events).toEqual(["runtimes", "listening"]);
        expect(await (await fake.request("http://127.0.0.1:8123/")).text())
          .toBe("donuts");
      });

      it("exits 1 without starting the runtimes when another listener answers the probe", async () => {
        const fake = fakeServe();
        const { deps, events, errors, exits } = startDeps({
          env: internalEnv,
          serve: fake.serve,
          probeFetch: () => Promise.resolve(new Response("{}")),
        });

        const started = startServer(deps);
        fake.listen();

        await expect(started).rejects.toThrow(new Exited(1));
        expect(exits[0]).toBe(1);
        expect(String(errors[0][0])).toMatch(
          new RegExp(`^API_INTERNAL_URL ${ORIGIN} is not this server: `),
        );
        expect(events).toEqual([]);
        const probe = new Request("http://127.0.0.1:8123/api/meta", {
          headers: { [STARTUP_PROBE_HEADER]: "a guessed token" },
        });
        expect((await fake.request(probe)).status).toBe(503);
      });

      it("logs a failure to signal readiness and exits 1", async () => {
        const fake = fakeServe();
        const failure = new Deno.errors.BrokenPipe("stdout closed");
        const { deps, errors, exits } = startDeps({
          env: internalEnv,
          serve: fake.serve,
          probeFetch: (input, init) => fake.request(String(input), init),
          onListening: () => {
            throw failure;
          },
        });

        const started = startServer(deps);
        fake.listen();

        await expect(started).rejects.toThrow(new Exited(1));
        expect(exits).toEqual([1]);
        expect(errors).toEqual([[
          "Internal API origin check failed:",
          failure,
        ]]);
      });
    });
  });
});
