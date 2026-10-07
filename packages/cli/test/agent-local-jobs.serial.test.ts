/**
 * `cf agent runner`'s local job flags: how they resolve, the refusals a bad
 * combination gets, and how the local lane starts beside — and without —
 * the Fabric lane. The lane itself is covered under `test/local-jobs/`.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { ValidationError } from "@cliffy/command";

import { selectHarnessJobSandboxRuntime } from "@commonfabric/agent-runner/harness-job";
import type { LocalJobsConfig } from "@commonfabric/agent-runner/local-jobs/service";
import {
  type AgentRunnerCommandConfig,
  type AgentRunnerCommandDeps,
  createAgentCommand,
  resolveLocalJobsConfig,
} from "../commands/agent.ts";

const DID = "did:key:z6MkTestRequester";

/** Deps that record both lanes' starts and stops and stop at once. */
const stubDeps = (
  options: {
    env?: Record<string, string>;
    fabricFails?: boolean;
    localFailure?: Error | string;
  } = {},
) => {
  const events: string[] = [];
  const local: LocalJobsConfig[] = [];
  const fabric: AgentRunnerCommandConfig[] = [];
  const deps: AgentRunnerCommandDeps = {
    env: (name) => options.env?.[name],
    loadIdentity: () => Promise.resolve({ did: () => DID }),
    selectSandboxRuntime: () => Promise.resolve(),
    start: (config) => {
      fabric.push(config);
      if (options.fabricFails) {
        return Promise.reject(new Error("The home space holds no agent queue"));
      }
      events.push("fabric:start");
      return Promise.resolve({
        stop: () => {
          events.push("fabric:stop");
          return Promise.resolve();
        },
      });
    },
    startLocal: (config) => {
      local.push(config);
      if (options.localFailure !== undefined) throw options.localFailure;
      events.push("local:start");
      return Promise.resolve({
        setFabricLane: (running: boolean) =>
          events.push(`local:fabric=${running}`),
        stop: () => {
          events.push("local:stop");
          return Promise.resolve();
        },
      });
    },
    untilStopped: () => {
      events.push("wait");
      return Promise.resolve();
    },
    report: (message) => events.push(`report:${message}`),
  };
  return { deps, events, local, fabric };
};

/** Parses `argv` through the command tree, throwing rather than exiting. */
const run = (deps: AgentRunnerCommandDeps, argv: string[]) =>
  createAgentCommand(deps).throwErrors().noExit().parse(argv);

/** The local flags with a socket and profiles. */
const LOCAL = [
  "--local-jobs-socket",
  "/run/agent-runner/jobs.sock",
  "--local-job-profiles",
  "/run/agent-runner/profiles.json",
];

describe("cf agent runner local jobs", () => {
  describe("resolveLocalJobsConfig()", () => {
    it("returns `undefined` when no local flag is given", () => {
      expect(resolveLocalJobsConfig({
        maxConcurrent: 1,
        leaseSeconds: 300,
      }, { env: () => undefined })).toBeUndefined();
    });

    it("refuses local concurrency without a local socket", () => {
      expect(() =>
        resolveLocalJobsConfig({
          maxConcurrent: 1,
          leaseSeconds: 300,
          maxConcurrentLocal: 2,
        }, { env: () => undefined })
      ).toThrow(`"--max-concurrent-local" needs "--local-jobs-socket".`);
    });

    it("resolves the socket, profiles, store, concurrency and work root", () => {
      expect(resolveLocalJobsConfig({
        maxConcurrent: 1,
        leaseSeconds: 300,
        localJobsSocket: "/run/jobs.sock",
        localJobProfiles: "/run/profiles.json",
        localJobsStore: "/run/jobs.sqlite",
        maxConcurrentLocal: 3,
        workRoot: "/var/agent-runs",
        loomRetrievalConfig: "/run/retrieval.json",
        model: "scripted",
      }, { env: () => undefined })).toEqual({
        socketPath: "/run/jobs.sock",
        profilesPath: "/run/profiles.json",
        storePath: "/run/jobs.sqlite",
        maxConcurrent: 3,
        workRoot: "/var/agent-runs/local",
        loomRetrievalConfigPath: "/run/retrieval.json",
        model: "scripted",
      });
    });

    it("defaults to two at once under the harness home's work root", () => {
      expect(resolveLocalJobsConfig({
        maxConcurrent: 1,
        leaseSeconds: 300,
        localJobsSocket: "/run/jobs.sock",
        localJobProfiles: "/run/profiles.json",
      }, { env: (name) => name === "HOME" ? "/home/me" : undefined }))
        .toEqual({
          socketPath: "/run/jobs.sock",
          profilesPath: "/run/profiles.json",
          maxConcurrent: 2,
          workRoot: "/home/me/.cf-harness/agent-runs/local",
        });
    });

    it("throws a validation error for a local flag without a socket, a socket without profiles, or a concurrency below one", () => {
      const base = { maxConcurrent: 1, leaseSeconds: 300 };
      const env = { env: () => undefined };
      expect(() => resolveLocalJobsConfig({ ...base, localOnly: true }, env))
        .toThrow(`"--local-only" needs "--local-jobs-socket".`);
      expect(() =>
        resolveLocalJobsConfig({ ...base, localJobProfiles: "/p.json" }, env)
      ).toThrow(ValidationError);
      expect(() =>
        resolveLocalJobsConfig({ ...base, localJobsSocket: "/s.sock" }, env)
      ).toThrow(`"--local-jobs-socket" needs "--local-job-profiles".`);
      expect(() =>
        resolveLocalJobsConfig({
          ...base,
          localJobsSocket: "/s.sock",
          localJobProfiles: "/p.json",
          maxConcurrentLocal: 0,
        }, env)
      ).toThrow(`"--max-concurrent-local"`);
    });
  });

  describe("the runner", () => {
    for (
      const failure of [
        new TypeError("path must be shorter than SUN_LEN"),
        "invalid profiles file",
      ]
    ) {
      it(`starts and stops the Fabric lane when local startup fails with ${String(failure)}`, async () => {
        const { deps, events, local, fabric } = stubDeps({
          localFailure: failure,
        });

        await run(deps, [
          "runner",
          ...LOCAL,
          "--identity",
          "/keys/me.key",
          "--api-url",
          "http://localhost:8100",
        ]);

        expect(local).toHaveLength(1);
        expect(fabric).toHaveLength(1);
        expect(events).toContain(
          `report:agent runner: the local lane did not start, continuing with the Fabric lane: ${
            failure instanceof Error ? failure.message : failure
          }`,
        );
        expect(events.filter((event) => !event.startsWith("report:"))).toEqual([
          "fabric:start",
          "wait",
          "fabric:stop",
        ]);
      });
    }

    it("throws the local startup error with `--local-only` and starts no Fabric lane", async () => {
      const failure = new Error("invalid profiles file");
      const { deps, events, fabric } = stubDeps({ localFailure: failure });

      await expect(run(deps, ["runner", ...LOCAL, "--local-only"]))
        .rejects.toBe(failure);

      expect(fabric).toEqual([]);
      expect(events).toEqual([]);
    });

    it("throws the Fabric startup error when neither lane can start", async () => {
      const failure = new Error("toolshed is down");
      const { deps, events } = stubDeps({
        localFailure: new Error("invalid profiles file"),
      });
      deps.start = () => Promise.reject(failure);

      await expect(run(deps, [
        "runner",
        ...LOCAL,
        "--identity",
        "/keys/me.key",
        "--api-url",
        "http://localhost:8100",
      ])).rejects.toBe(failure);

      expect(events).not.toContain("wait");
    });

    it("serves local jobs alone with `--local-only`, needing no identity or API URL", async () => {
      const { deps, events, local, fabric } = stubDeps();

      await run(deps, ["runner", ...LOCAL, "--local-only"]);

      expect(local).toHaveLength(1);
      expect(fabric).toEqual([]);
      expect(events).toEqual([
        "local:start",
        "report:agent runner: serving local jobs only (--local-only)",
        "wait",
        "report:agent runner: stopping",
        "local:stop",
      ]);
    });

    it("starts local jobs before the Fabric lane, records it running, and stops both", async () => {
      const { deps, events } = stubDeps();

      await run(deps, [
        "runner",
        ...LOCAL,
        "--identity",
        "/keys/me.key",
        "--api-url",
        "http://localhost:8100",
      ]);

      expect(events.filter((event) => !event.startsWith("report:"))).toEqual([
        "local:start",
        "fabric:start",
        "local:fabric=true",
        "wait",
        "fabric:stop",
        "local:stop",
      ]);
      expect(events).toContain(
        `report:agent runner: following ${DID} on http://localhost:8100, offering describe_handle, web_fetch`,
      );
    });

    it("keeps serving local jobs when the Fabric lane does not start", async () => {
      const { deps, events } = stubDeps({ fabricFails: true });

      await run(deps, [
        "runner",
        ...LOCAL,
        "--identity",
        "/keys/me.key",
        "--api-url",
        "http://localhost:8100",
      ]);

      expect(events).toContain(
        "report:agent runner: the Fabric lane did not start, so this runner serves local jobs only: The home space holds no agent queue",
      );
      expect(events.filter((event) => !event.startsWith("report:"))).toEqual([
        "local:start",
        "wait",
        "local:stop",
      ]);
    });

    it("stops local jobs and throws when the Fabric lane's flags are wrong", async () => {
      const { deps, events } = stubDeps();

      await expect(run(deps, ["runner", ...LOCAL])).rejects.toThrow(
        ValidationError,
      );
      expect(events).toEqual(["local:start", "local:stop"]);
    });

    describe("with a sandbox runtime the harness would refuse every job for", () => {
      /**
       * Makes `deps` select as a Mac with no native runtime set up and no
       * runtime named does, and returns the home it selects under.
       */
      const onMacWithNoStore = async (
        deps: AgentRunnerCommandDeps,
      ): Promise<string> => {
        // By the path the file system has for it: a home reached through a
        // link is refused for that before its store is looked at.
        const home = await Deno.realPath(await Deno.makeTempDir());
        deps.selectSandboxRuntime = () =>
          selectHarnessJobSandboxRuntime({
            platform: "darwin",
            arch: "aarch64",
            env: { HOME: home },
          });
        return home;
      };

      for (
        const [lanes, argv] of [
          ["local jobs alone", [...LOCAL, "--local-only"]],
          ["local jobs and the Fabric lane", [
            ...LOCAL,
            "--identity",
            "/keys/me.key",
            "--api-url",
            "http://localhost:8100",
          ]],
        ] as const
      ) {
        it(`refuses to start, and starts neither lane, for ${lanes}`, async () => {
          const { deps, events } = stubDeps();
          const home = await onMacWithNoStore(deps);

          try {
            const refusal = await run(deps, ["runner", ...argv]).then(
              () => undefined,
              (error: unknown) => error,
            );

            expect(refusal).toBeInstanceOf(ValidationError);
            expect(refusal).toMatchObject({
              exitCode: 1,
              message: expect.stringMatching(
                /^No sandbox runtime is named, so the default applies, which on macOS is the native `runsc` runtime, and it is not set up at `.*`: .*\. Set it up there, or select Docker with `CF_HARNESS_SANDBOX_RUNTIME=docker`\.$/,
              ),
            });
            expect(events).toEqual([]);
          } finally {
            await Deno.remove(home, { recursive: true });
          }
        });
      }
    });

    it("reports a Fabric start failure that is not an `Error` by its text", async () => {
      const { deps, events } = stubDeps();
      deps.start = () => Promise.reject("estuary is down");

      await run(deps, [
        "runner",
        ...LOCAL,
        "--identity",
        "/keys/me.key",
        "--api-url",
        "http://localhost:8100",
      ]);

      expect(events).toContain(
        "report:agent runner: the Fabric lane did not start, so this runner serves local jobs only: estuary is down",
      );
    });
  });
});
