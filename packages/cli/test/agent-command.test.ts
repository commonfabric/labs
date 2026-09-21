/**
 * `cf agent runner`'s wiring: flags and environment to a configuration, the
 * refusals a bad one gets, and the start-then-stop lifecycle. The runner the
 * configuration starts is covered by `agent-runner.test.ts`.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { ValidationError } from "@cliffy/command";

import { Identity } from "@commonfabric/identity";
import { waitForCellValue } from "@commonfabric/integration/wait-for-cell-value";
import { type Cell, Runtime } from "@commonfabric/runner";
import {
  agentQueueIndexCell,
  type AgentRunRecord,
  AgentRunRecordSchema,
} from "@commonfabric/runner/agent-run";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import {
  type AgentRunnerCommandConfig,
  type AgentRunnerCommandDeps,
  createAgentCommand,
  defaultAgentRunnerCommandDeps,
  resolveRunnerTools,
  startAgentRunner,
} from "../commands/agent.ts";
import { withEnv } from "./utils.ts";

const DID = "did:key:z6MkTestRequester";

/** Deps that record what was started and stop at once. */
const stubDeps = (env: Record<string, string> = {}) => {
  const started: AgentRunnerCommandConfig[] = [];
  const events: string[] = [];
  const deps: AgentRunnerCommandDeps = {
    env: (name) => env[name],
    loadIdentity: (path) => {
      events.push(`identity:${path}`);
      return Promise.resolve({ did: () => DID });
    },
    start: (config) => {
      started.push(config);
      events.push("start");
      return Promise.resolve({
        stop: () => {
          events.push("stop");
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
  return { deps, started, events };
};

/** Parses `argv` through the command tree, throwing rather than exiting. */
const run = (deps: AgentRunnerCommandDeps, argv: string[]) =>
  createAgentCommand(deps).throwErrors().noExit().parse(argv);

describe("cf agent runner", () => {
  it("reports runner diagnostics on stderr", () => {
    const messages: unknown[][] = [];
    using _stderr = stub(console, "error", (...args: unknown[]) => {
      messages.push(args);
    });

    defaultAgentRunnerCommandDeps.report("agent runner: stopping");

    expect(messages).toEqual([["agent runner: stopping"]]);
  });

  it("resolves flags to a configuration, starts, waits, and stops", async () => {
    const { deps, started, events } = stubDeps({
      CF_HARNESS_HOME: "/harness-home",
    });

    await run(deps, [
      "runner",
      "--identity",
      "/keys/me.key",
      "--api-url",
      "https://cloud.example/some/path",
      "--local-api-url",
      "http://localhost:8100",
      "--loom-retrieval-config",
      "/etc/loom/retrieval.json",
      "--max-concurrent",
      "3",
      "--lease-seconds",
      "60",
      "--model",
      "scripted",
    ]);

    expect(started).toEqual([{
      identityPath: "/keys/me.key",
      home: DID,
      homeHost: "https://cloud.example",
      runnerHost: "http://localhost:8100",
      tools: resolveRunnerTools({ loomRetrievalConfig: "x" }),
      maxConcurrent: 3,
      leaseMs: 60_000,
      workRoot: "/harness-home/agent-runs",
      loomRetrievalConfigPath: "/etc/loom/retrieval.json",
      model: "scripted",
    }]);
    expect(events.filter((event) => !event.startsWith("report:"))).toEqual([
      "identity:/keys/me.key",
      "start",
      "wait",
      "stop",
    ]);
  });

  it("defaults the runner's host to the home host, one run at a time, and the base tools", async () => {
    const { deps, started } = stubDeps({ HOME: "/home/me" });

    await run(deps, [
      "runner",
      "-i",
      "/keys/me.key",
      "-a",
      "http://localhost:8100",
    ]);

    expect(started[0]).toMatchObject({
      homeHost: "http://localhost:8100",
      runnerHost: "http://localhost:8100",
      maxConcurrent: 1,
      leaseMs: 300_000,
      workRoot: "/home/me/.cf-harness/agent-runs",
      tools: ["describe_handle", "web_fetch"],
    });
    expect(started[0].loomRetrievalConfigPath).toBeUndefined();
    expect(started[0].model).toBeUndefined();
  });

  it("reads the identity and API URL from `CF_IDENTITY` and `CF_API_URL`", async () => {
    const { deps, started } = stubDeps();

    await withEnv(
      "CF_IDENTITY",
      "/keys/env.key",
      () =>
        withEnv("CF_API_URL", "http://localhost:8200", async () => {
          await run(deps, ["runner"]);
        }),
    );

    expect(started[0]).toMatchObject({
      identityPath: "/keys/env.key",
      homeHost: "http://localhost:8200",
    });
  });

  it("reads the Loom retrieval configuration from its harness environment variable", async () => {
    const { deps, started } = stubDeps();

    await withEnv(
      "CF_HARNESS_LOOM_RETRIEVAL_CONFIG",
      "/etc/loom/retrieval.json",
      async () => {
        await run(deps, [
          "runner",
          "-i",
          "/keys/me.key",
          "-a",
          "http://localhost:8100",
        ]);
      },
    );

    expect(started[0].loomRetrievalConfigPath).toBe(
      "/etc/loom/retrieval.json",
    );
    expect(started[0].tools).toContain("loom_search");
  });

  it("takes `--tools` as the whole list and `--work-root` over the default", async () => {
    const { deps, started } = stubDeps();

    await run(deps, [
      "runner",
      "-i",
      "/keys/me.key",
      "-a",
      "http://localhost:8100",
      "--tools",
      "loom_search, describe_handle,",
      "--loom-retrieval-config",
      "/etc/loom/retrieval.json",
      "--work-root",
      "/var/agent-runs",
    ]);

    expect(started[0].tools).toEqual(["loom_search", "describe_handle"]);
    expect(started[0].workRoot).toBe("/var/agent-runs");
  });

  it("throws a validation error for an explicit Loom tool without its backing", async () => {
    const { deps, started } = stubDeps();

    await expect(
      run(deps, [
        "runner",
        "-i",
        "/keys/me.key",
        "-a",
        "http://localhost:8100",
        "--tools",
        "loom_search",
      ]),
    ).rejects.toThrow(/--loom-retrieval-config/);
    expect(started).toEqual([]);
  });

  it("throws a validation error, and starts nothing, for a missing identity or API URL", async () => {
    const { deps, started } = stubDeps();

    await expect(run(deps, ["runner", "-a", "http://localhost:8100"]))
      .rejects.toThrow(ValidationError);
    await expect(run(deps, ["runner", "-i", "/keys/me.key"]))
      .rejects.toThrow(/--api-url/);
    expect(started).toEqual([]);
  });

  it("throws a validation error for a concurrency or lease below one", async () => {
    const { deps, started } = stubDeps();
    const base = ["runner", "-i", "/k", "-a", "http://localhost:8100"];

    await expect(run(deps, [...base, "--max-concurrent", "0"]))
      .rejects.toThrow(/--max-concurrent/);
    await expect(run(deps, [...base, "--lease-seconds", "0"]))
      .rejects.toThrow(/--lease-seconds/);
    expect(started).toEqual([]);
  });

  it("throws a validation error for an API URL no connection can be opened over", async () => {
    const { deps } = stubDeps();

    await expect(
      run(deps, ["runner", "-i", "/k", "-a", "not a url"]),
    ).rejects.toThrow(/--api-url/);
    await expect(
      run(deps, ["runner", "-i", "/k", "-a", "file:///tmp/toolshed"]),
    ).rejects.toThrow(/http.*https/);
  });

  it("stops the runner when waiting throws", async () => {
    const { deps, events } = stubDeps();
    deps.untilStopped = () => Promise.reject(new Error("signal setup failed"));

    await expect(
      run(deps, ["runner", "-i", "/k", "-a", "http://localhost:8100"]),
    ).rejects.toThrow("signal setup failed");
    expect(events.at(-1)).toBe("stop");
  });

  it("removes both stop signal listeners after receiving `SIGTERM`", async () => {
    const listeners = new Map<Deno.Signal, () => void>();
    using add = stub(Deno, "addSignalListener", (signal, listener) => {
      listeners.set(signal, listener);
    });
    using remove = stub(Deno, "removeSignalListener", (signal, listener) => {
      expect(listeners.get(signal)).toBe(listener);
      listeners.delete(signal);
    });

    const stopped = defaultAgentRunnerCommandDeps.untilStopped();
    expect([...listeners.keys()]).toEqual(["SIGINT", "SIGTERM"]);
    listeners.get("SIGTERM")!();
    await stopped;

    expect(listeners.size).toBe(0);
    expect(add.calls.length).toBe(2);
    expect(remove.calls.length).toBe(2);
  });

  describe("startAgentRunner()", () => {
    /** A home runtime whose home pattern is seeded data with a live stream. */
    const openHome = async (
      options: { queue: boolean; registrationError?: boolean },
    ) => {
      const signer = await Identity.fromPassphrase(
        `agent command ${crypto.randomUUID()}`,
      );
      const home = signer.did();
      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = new Runtime({
        apiUrl: new URL("https://cloud.example"),
        storageManager,
      });
      const homePattern = runtime.getCell(home, "home-pattern");
      await runtime.editWithRetry((tx) => {
        homePattern.withTx(tx).setRaw(
          options.queue
            ? { agentQueue: { entries: [], setAgentRunner: { $stream: true } } }
            : {},
        );
        // deno-lint-ignore no-explicit-any
        (runtime.getHomeSpaceCell(tx) as any).key("defaultPattern").set(
          homePattern,
        );
      });
      // Stands in for the queue piece's `setAgentRunner` handler.
      const cancel = runtime.scheduler.addEventHandler(
        (tx, event: {
          runner?: { registrationId?: string };
          expectedRegistrationId?: string;
        }) => {
          if (options.registrationError) {
            throw new Error("registration rejected for the test");
          }
          const runner = homePattern.withTx(tx).key("agentQueue")
            .key("agentRunner");
          if (
            event.runner === undefined &&
            event.expectedRegistrationId !== undefined &&
            runner.get()?.registrationId !== event.expectedRegistrationId
          ) return;
          runner.set(event.runner);
        },
        homePattern.key("agentQueue").key("setAgentRunner")
          .getAsNormalizedFullLink(),
      );
      const config: AgentRunnerCommandConfig = {
        identityPath: "/keys/me.key",
        home,
        homeHost: "https://cloud.example",
        runnerHost: "http://localhost:8100",
        tools: ["describe_handle"],
        maxConcurrent: 1,
        leaseMs: 60_000,
        workRoot: "/unused",
      };
      return {
        config,
        runtime,
        homePattern,
        close: async () => {
          cancel();
          await storageManager.close();
        },
      };
    };

    it("registers the runner through the queue's `setAgentRunner` stream, and disposes its runtimes on stop", async () => {
      const opened = await openHome({ queue: true });
      const running = await startAgentRunner(
        opened.config,
        () => {},
        {
          openHome: () =>
            Promise.resolve({
              runtime: opened.runtime,
              homePattern: opened.homePattern,
            }),
          openHost: () => Promise.reject(new Error("no second toolshed here")),
        },
        () => Promise.resolve({ outcome: "refused" }),
      );

      const registered = await waitForCellValue<{ host: string }>(
        opened.runtime,
        agentQueueIndexCell(opened.runtime, opened.config.home as never)
          .key("agentRunner"),
        (value) => value !== undefined,
      );
      expect(registered).toMatchObject({
        host: "http://localhost:8100",
        tools: ["describe_handle"],
      });

      await running.stop();
      expect(
        agentQueueIndexCell(opened.runtime, opened.config.home as never)
          .key("agentRunner").get(),
      ).toBeUndefined();
      await opened.close();
    });

    it("opens a second toolshed for an entry that names one, with the harness executor by default", async () => {
      const opened = await openHome({ queue: true });
      await opened.runtime.editWithRetry((tx) => {
        agentQueueIndexCell(opened.runtime, opened.config.home as never, tx)
          .key("entries").push({
            run: opened.runtime.getCell(opened.config.home as never, "a run"),
            host: "https://other.example/",
          });
      });
      const asked = Promise.withResolvers<string>();
      const running = await startAgentRunner(opened.config, () => {}, {
        openHome: () =>
          Promise.resolve({
            runtime: opened.runtime,
            homePattern: opened.homePattern,
          }),
        openHost: (_config, origin) => {
          asked.resolve(origin);
          return Promise.reject(new Error("no toolshed there"));
        },
      });

      expect(await asked.promise).toBe("https://other.example");

      await running.stop();
      await opened.close();
    });

    it("reuses one connection for two entries on the same toolshed", async () => {
      const opened = await openHome({ queue: true });
      const remote = await openHome({ queue: false });
      const records = ["first", "second"].map((id) =>
        remote.runtime.getCell(
          remote.config.home as never,
          id,
          AgentRunRecordSchema,
        ) as unknown as Cell<AgentRunRecord>
      );
      await remote.runtime.editWithRetry((tx) => {
        for (const [index, record] of records.entries()) {
          const request = remote.runtime.getCell(
            remote.config.home as never,
            `request-${index}`,
            undefined,
            tx,
          );
          record.withTx(tx).set({
            requestHash: `request-${index}`,
            request,
            piece: request,
            space: request,
            task: `request ${index}`,
            inputs: {},
            resultSchema: {},
            state: "queued",
            stateSince: "2026-09-20T12:00:00.000Z",
            submittedAt: "2026-09-20T12:00:00.000Z",
          });
        }
      });
      await opened.runtime.editWithRetry((tx) => {
        const entries = agentQueueIndexCell(
          opened.runtime,
          opened.config.home as never,
          tx,
        ).key("entries");
        for (const record of records) {
          entries.push({
            run: record,
            host: "https://other.example/",
          });
        }
      });
      const hosts: string[] = [];
      const bothExecuted = Promise.withResolvers<void>();
      let executions = 0;
      const running = await startAgentRunner(
        opened.config,
        () => {},
        {
          openHome: () =>
            Promise.resolve({
              runtime: opened.runtime,
              homePattern: opened.homePattern,
            }),
          openHost: (_config, origin) => {
            hosts.push(origin);
            return Promise.resolve(remote.runtime);
          },
        },
        () => {
          executions += 1;
          if (executions === 2) bothExecuted.resolve();
          return Promise.resolve({ outcome: "refused" });
        },
      );
      await bothExecuted.promise;
      await running.stop();

      expect(hosts).toEqual(["https://other.example"]);
      expect(executions).toBe(2);
      await opened.close();
      await remote.close();
    });

    it("throws, and disposes the home runtime, when the home space holds no agent queue", async () => {
      const opened = await openHome({ queue: false });

      await expect(
        startAgentRunner(opened.config, () => {}, {
          openHome: () =>
            Promise.resolve({
              runtime: opened.runtime,
              homePattern: opened.homePattern,
            }),
          openHost: () => Promise.reject(new Error("unused")),
        }),
      ).rejects.toThrow("holds no agent queue");
      await opened.close();
    });

    it("rejects when the registration handling transaction fails", async () => {
      const opened = await openHome({
        queue: true,
        registrationError: true,
      });

      await expect(
        startAgentRunner(
          opened.config,
          () => {},
          {
            openHome: () =>
              Promise.resolve({
                runtime: opened.runtime,
                homePattern: opened.homePattern,
              }),
            openHost: () => Promise.reject(new Error("unused")),
          },
          () => Promise.resolve({ outcome: "refused" }),
        ),
      ).rejects.toThrow();
      await opened.close();
    });
  });
});
