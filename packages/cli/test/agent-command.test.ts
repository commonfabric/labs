/**
 * `cf agent runner`'s wiring: flags and environment to a configuration, the
 * refusals a bad one gets, and the start-then-stop lifecycle. The runner the
 * configuration starts is covered by `agent-runner.test.ts`.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { ValidationError } from "@cliffy/command";

import {
  type AgentRunnerCommandConfig,
  type AgentRunnerCommandDeps,
  createAgentCommand,
  resolveRunnerTools,
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
      harnessArgs: ["--model", "scripted"],
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
      tools: ["describe_handle", "web_fetch", "research"],
    });
    expect(started[0].loomRetrievalConfigPath).toBeUndefined();
    expect(started[0].harnessArgs).toBeUndefined();
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
      "--work-root",
      "/var/agent-runs",
    ]);

    expect(started[0].tools).toEqual(["loom_search", "describe_handle"]);
    expect(started[0].workRoot).toBe("/var/agent-runs");
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
  });

  it("stops the runner when waiting throws", async () => {
    const { deps, events } = stubDeps();
    deps.untilStopped = () => Promise.reject(new Error("signal setup failed"));

    await expect(
      run(deps, ["runner", "-i", "/k", "-a", "http://localhost:8100"]),
    ).rejects.toThrow("signal setup failed");
    expect(events.at(-1)).toBe("stop");
  });
});
