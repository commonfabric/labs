/**
 * A per-user agent runner with independent local and Fabric lanes.
 *
 * The Fabric lane holds the requester's identity, follows their home queue,
 * runs each request locally, and publishes its result to the requesting space.
 * The local lane serves direct requests on a host-owned Unix socket. A
 * local-only runner needs neither an identity nor a toolshed connection.
 */

import { Command, EnumType, ValidationError } from "@cliffy/command";
import { join } from "@std/path";

import {
  AgentRunner,
  type AgentRunnerEntry,
  type AgentRunnerOptions,
} from "@commonfabric/agent-runner";
import { createHarnessAgentRunExecutor } from "@commonfabric/agent-runner/agent-run-harness";
import type { LaneTransition } from "@commonfabric/agent-runner/local-jobs/readiness";
import { selectHarnessJobSandboxRuntime } from "@commonfabric/agent-runner/harness-job";
import {
  type LocalJobsConfig,
  type LocalJobsService,
  startLocalJobs,
} from "@commonfabric/agent-runner/local-jobs/service";
import { LOOM_RETRIEVAL_TOOL_IDS } from "@commonfabric/cf-harness/contracts/tool-descriptor";
import { HarnessControlError } from "@commonfabric/cf-harness/control-errors";
import { type Cell, type Runtime, sendEvent } from "@commonfabric/runner";
import {
  AGENT_RUN_STATES,
  agentQueueIndexCell,
} from "@commonfabric/runner/agent-run";
import { getAcl } from "../lib/acl.ts";
import { openAgentStorageHost } from "../lib/agent-connections.ts";

import {
  type AgentRunInspection,
  cancelAgentRun,
  readAgentRun,
  readAgentRuns,
} from "../lib/agent-inspection.ts";
import { render } from "../lib/render.ts";

import { createAgentStatusCommand } from "./agent-status.ts";
import { normalizeApiUrl } from "../lib/api-url.ts";
import { cliText } from "../lib/cli-name.ts";
import { resolveCliGitSha } from "../lib/build-info.ts";
import { loadIdentity } from "../lib/identity.ts";
import { loadPieces } from "../lib/piece.ts";
import { absPath } from "../lib/utils.ts";

/** The Loom retrieval tools a runner offers when it has a Loom configuration. */
const LOOM_TOOLS = [...LOOM_RETRIEVAL_TOOL_IDS];

/** The harness tools every runner offers. */
const BASE_TOOLS = ["describe_handle", "web_fetch"];

/** How long a claim's lease reaches past the run's last durable write. */
const DEFAULT_LEASE_SECONDS = 300;

/** Options the `cf agent runner` action receives (cliffy-parsed flags + env). */
export interface AgentRunnerCommandOptions {
  identity?: string;
  apiUrl?: string;
  localApiUrl?: string;
  loomRetrievalConfig?: string;
  maxConcurrent: number;
  tools?: string;
  workRoot?: string;
  leaseSeconds: number;
  model?: string;
  localJobsSocket?: string;
  localJobProfiles?: string;
  localJobsStore?: string;
  maxConcurrentLocal?: number;
  localOnly?: boolean;
}

/** The tool names a runner offers: `--tools`, or what its configuration backs. */
export function resolveRunnerTools(
  options: Pick<AgentRunnerCommandOptions, "tools" | "loomRetrievalConfig">,
): string[] {
  if (options.tools !== undefined) {
    const tools = options.tools.split(",").map((tool) => tool.trim()).filter((
      tool,
    ) => tool !== "");
    const unbacked = tools.find((tool) =>
      (LOOM_RETRIEVAL_TOOL_IDS as ReadonlySet<string>).has(tool)
    );
    if (unbacked !== undefined && options.loomRetrievalConfig === undefined) {
      throw new ValidationError(
        `Tool \`${unbacked}\` requires "--loom-retrieval-config" or ` +
          "CF_HARNESS_LOOM_RETRIEVAL_CONFIG.",
        { exitCode: 1 },
      );
    }
    return tools;
  }
  return options.loomRetrievalConfig !== undefined
    ? [...LOOM_TOOLS, ...BASE_TOOLS]
    : [...BASE_TOOLS];
}

/** What the flags and environment resolve to. */
export interface AgentRunnerCommandConfig {
  identityPath: string;

  /** The identity's DID, which is also its home space. */
  home: string;

  homeHost: string;
  runnerHost: string;
  tools: string[];
  maxConcurrent: number;
  leaseMs: number;
  workRoot: string;
  loomRetrievalConfigPath?: string;
  model?: string;
}

/** What the command reaches outside itself through. */
export interface AgentRunnerCommandDeps {
  env: (name: string) => string | undefined;
  loadIdentity: (path: string) => Promise<{ did(): string }>;

  /**
   * Derives the sandbox runtime the harness would give this runner's runs,
   * and rejects with a `HarnessControlError` where it would refuse them.
   */
  selectSandboxRuntime: () => Promise<unknown>;

  /** Connects, registers, and starts following the queue. */
  start: (
    config: AgentRunnerCommandConfig,
    report: (message: string) => void,
    readiness?: (next: LaneTransition) => void,
  ) => Promise<{ stop(): Promise<void> }>;

  /** Resolves when the process is asked to stop. */
  untilStopped: () => Promise<void>;

  report: (message: string) => void;

  /** Labs revision of this running CLI, captured once at startup. */
  labsCommit?: () => Promise<string | null>;

  /** Starts serving local jobs; `startLocalJobs` unless a test replaces it. */
  startLocal?: (
    config: LocalJobsConfig,
    report: (message: string) => void,
  ) => Promise<
    Pick<LocalJobsService, "setFabricLane" | "setFabricReadiness" | "stop">
  >;
}

/** Helper for the config, which reads an API URL option as an origin. */
function originOf(flag: string, value: string): string {
  if (!URL.canParse(value)) {
    throw new ValidationError(`"${flag}" is not a URL: ${value}`, {
      exitCode: 1,
    });
  }
  const url = new URL(normalizeApiUrl(value));
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ValidationError(
      `"${flag}" must use the \`http:\` or \`https:\` scheme: ${value}`,
      { exitCode: 1 },
    );
  }
  return url.origin;
}

/**
 * Resolves the command's options to a configuration.
 *
 * @throws ValidationError for a missing identity or API URL, a URL that does
 * not parse, or a concurrency or lease below one.
 */
export async function resolveAgentRunnerConfig(
  options: AgentRunnerCommandOptions,
  deps: Pick<AgentRunnerCommandDeps, "env" | "loadIdentity">,
): Promise<AgentRunnerCommandConfig> {
  if (!options.identity) {
    throw new ValidationError(
      `Missing required option: "--identity", or "CF_IDENTITY".`,
      { exitCode: 1 },
    );
  }
  if (!options.apiUrl) {
    throw new ValidationError(
      `Missing required option: "--api-url", or "CF_API_URL".`,
      { exitCode: 1 },
    );
  }
  for (
    const [flag, value] of [
      ["--max-concurrent", options.maxConcurrent],
      ["--lease-seconds", options.leaseSeconds],
    ] as const
  ) {
    if (!Number.isInteger(value) || value < 1) {
      throw new ValidationError(
        `"${flag}" takes a whole number of 1 or more.`,
        {
          exitCode: 1,
        },
      );
    }
  }
  const homeHost = originOf("--api-url", options.apiUrl);
  const runnerHost = options.localApiUrl !== undefined
    ? originOf("--local-api-url", options.localApiUrl)
    : homeHost;
  const identityPath = absPath(options.identity);
  const identity = await deps.loadIdentity(identityPath);
  return {
    identityPath,
    home: identity.did(),
    homeHost,
    runnerHost,
    tools: resolveRunnerTools(options),
    maxConcurrent: options.maxConcurrent,
    leaseMs: options.leaseSeconds * 1000,
    workRoot: absPath(
      options.workRoot ??
        join(
          deps.env("CF_HARNESS_HOME") ||
            join(deps.env("HOME") || ".", ".cf-harness"),
          "agent-runs",
        ),
    ),
    ...(options.loomRetrievalConfig !== undefined
      ? { loomRetrievalConfigPath: absPath(options.loomRetrievalConfig) }
      : {}),
    ...(options.model !== undefined ? { model: options.model } : {}),
  };
}

/** The connections a runner opens, which a test replaces. */
export interface AgentRunnerConnections {
  /**
   * Connects to the home toolshed as the identity and runs the home default
   * pattern there, creating it when the home space has none. Returns the
   * runtime and the pattern's result cell, unbound from any transaction.
   */
  openHome(
    config: AgentRunnerCommandConfig,
    // deno-lint-ignore no-explicit-any
  ): Promise<{ runtime: Runtime; homePattern: Cell<any> }>;

  /** A storage-only runtime on another toolshed, as the same identity. */
  openHost(config: AgentRunnerCommandConfig, origin: string): Promise<Runtime>;
}

/** The production connections: a deployed toolshed at each origin. */
const deployedConnections: AgentRunnerConnections = {
  // The home connection is a full one: the home default pattern runs here,
  // since the queue's `agentRunner` entry takes writes only through the
  // pattern's own handler.
  async openHome(config) {
    const pieces = await loadPieces({
      apiUrl: config.homeHost,
      space: config.home,
      identity: config.identityPath,
    });
    const homePattern = await pieces.ensureDefaultPattern();
    return {
      runtime: pieces.runtime,
      // The controller's cell is bound to the transaction it was read under;
      // an event is sent from an unbound one.
      homePattern: homePattern.getCell().withTx(),
    };
  },
  // Records are read and written there, and nothing of that deployment's is
  // run.
  openHost(config, origin) {
    return openAgentStorageHost(config.identityPath, origin);
  },
};

/**
 * Connects to the home toolshed, registers the runner, and starts it. The
 * production `start`.
 *
 * @throws Error when the home space holds no agent queue.
 */
export async function startAgentRunner(
  config: AgentRunnerCommandConfig,
  report: (message: string) => void,
  connections: AgentRunnerConnections = deployedConnections,
  execute?: AgentRunnerOptions["execute"],
  readiness?: (next: LaneTransition) => void,
): Promise<{ stop(): Promise<void> }> {
  const { home, homeHost, identityPath } = config;
  const homeSpace = home as `did:${string}:${string}`;
  const { runtime: homeRuntime, homePattern } = await connections.openHome(
    config,
  );
  const runtimes = new Map<string, Runtime>([[homeHost, homeRuntime]]);
  const disposeAll = async () => {
    for (const runtime of runtimes.values()) await runtime.dispose();
  };
  const runtimeForHost = async (host: string): Promise<Runtime> => {
    const origin = new URL(host).origin;
    let runtime = runtimes.get(origin);
    if (runtime === undefined) {
      runtime = await connections.openHost(config, origin);
      runtimes.set(origin, runtime);
    }
    return runtime;
  };

  // The send settles when the handling's commit does.
  const registerRunner = (
    entry: AgentRunnerEntry | undefined,
    expectedRegistrationId?: string,
  ): Promise<void> =>
    new Promise<void>((resolve, reject) =>
      sendEvent(
        homePattern.key("agentQueue").key("setAgentRunner"),
        entry === undefined ? { expectedRegistrationId } : { runner: entry },
        (tx) => {
          const status = tx.status();
          if (status.status === "error") {
            reject(new Error(status.error.message, { cause: status.error }));
          } else resolve();
        },
      )
    );
  let runner: AgentRunner | undefined;
  try {
    const queue = agentQueueIndexCell(homeRuntime, homeSpace);
    await queue.sync();
    if (queue.get() === undefined) {
      throw new Error(
        "The home space holds no agent queue: its home pattern predates the " +
          "`agentQueue` field. Open the home space in the shell once so the " +
          "pattern updates, then start the runner again.",
      );
    }

    runner = new AgentRunner({
      homeSpace,
      homeHost,
      runnerHost: config.runnerHost,
      runnerId: `${home}#${crypto.randomUUID()}`,
      tools: config.tools,
      maxConcurrent: config.maxConcurrent,
      leaseMs: config.leaseMs,
      runtimeForHost,
      registerRunner,
      execute: execute ?? createHarnessAgentRunExecutor({
        identityKeyPath: identityPath,
        requester: home,
        workRoot: config.workRoot,
        allowedTools: config.tools,
        readSpaceAcl: (host, space) =>
          getAcl({ apiUrl: host, space, identity: identityPath }),
        ...(config.loomRetrievalConfigPath !== undefined
          ? { loomRetrievalConfigPath: config.loomRetrievalConfigPath }
          : {}),
        ...(config.model !== undefined ? { model: config.model } : {}),
        report,
      }),
      report,
      readiness,
    });
    await runner.start();
    return {
      stop: async () => {
        try {
          await runner!.stop();
        } finally {
          await disposeAll();
        }
      },
    };
  } catch (error) {
    try {
      await runner?.stop();
    } catch (cleanupError) {
      report(
        `agent runner: startup cleanup failed: ${
          cleanupError instanceof Error
            ? cleanupError.message
            : String(cleanupError)
        }`,
      );
    } finally {
      await disposeAll();
    }
    throw error;
  }
}

/** Resolves on the process's first SIGINT or SIGTERM. */
async function untilSignalled(): Promise<void> {
  const stopped = Promise.withResolvers<void>();
  const onSignal = () => stopped.resolve();
  Deno.addSignalListener("SIGINT", onSignal);
  Deno.addSignalListener("SIGTERM", onSignal);
  try {
    await stopped.promise;
  } finally {
    Deno.removeSignalListener("SIGINT", onSignal);
    Deno.removeSignalListener("SIGTERM", onSignal);
  }
}

/** The command's production dependencies. */
export const defaultAgentRunnerCommandDeps: AgentRunnerCommandDeps = {
  env: (name) => Deno.env.get(name),
  loadIdentity,
  selectSandboxRuntime: () => selectHarnessJobSandboxRuntime(),
  start: (config, report, readiness) =>
    startAgentRunner(config, report, undefined, undefined, readiness),
  labsCommit: resolveCliGitSha,
  untilStopped: untilSignalled,
  report: (message) => console.error(message),
};

/**
 * Resolves the local job options to a configuration, or `undefined` when the
 * runner serves no local jobs.
 *
 * @throws ValidationError for a local option without `--local-jobs-socket`,
 * a socket without `--local-job-profiles`, or a concurrency below one.
 */
export function resolveLocalJobsConfig(
  options: AgentRunnerCommandOptions,
  deps: Pick<AgentRunnerCommandDeps, "env">,
): LocalJobsConfig | undefined {
  if (options.localJobsSocket === undefined) {
    const stray = [
      ["--local-job-profiles", options.localJobProfiles],
      ["--local-jobs-store", options.localJobsStore],
      ["--max-concurrent-local", options.maxConcurrentLocal],
      ["--local-only", options.localOnly],
    ].find(([, value]) => value !== undefined);
    if (stray !== undefined) {
      throw new ValidationError(
        `"${stray[0]}" needs "--local-jobs-socket".`,
        { exitCode: 1 },
      );
    }
    return undefined;
  }
  if (options.localJobProfiles === undefined) {
    throw new ValidationError(
      `"--local-jobs-socket" needs "--local-job-profiles".`,
      { exitCode: 1 },
    );
  }
  const maxConcurrent = options.maxConcurrentLocal ?? 2;
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) {
    throw new ValidationError(
      `"--max-concurrent-local" takes a whole number of 1 or more.`,
      { exitCode: 1 },
    );
  }
  return {
    socketPath: absPath(options.localJobsSocket),
    profilesPath: absPath(options.localJobProfiles),
    ...(options.localJobsStore !== undefined
      ? { storePath: absPath(options.localJobsStore) }
      : {}),
    maxConcurrent,
    workRoot: join(
      absPath(
        options.workRoot ??
          join(
            deps.env("CF_HARNESS_HOME") ||
              join(deps.env("HOME") || ".", ".cf-harness"),
            "agent-runs",
          ),
      ),
      "local",
    ),
    ...(options.loomRetrievalConfig !== undefined
      ? { loomRetrievalConfigPath: absPath(options.loomRetrievalConfig) }
      : {}),
    ...(options.model !== undefined ? { model: options.model } : {}),
  };
}

/**
 * Runs a runner until the process is asked to stop. With local jobs, they
 * are served first; a local startup failure falls back to the Fabric lane,
 * and a Fabric startup failure leaves the local jobs served.
 * With `--local-only`, a local startup failure is fatal.
 */
export async function agentRunnerAction(
  options: AgentRunnerCommandOptions,
  deps: AgentRunnerCommandDeps = defaultAgentRunnerCommandDeps,
): Promise<void> {
  const localConfig = resolveLocalJobsConfig(options, deps);
  // Every job of either lane goes to the harness's sandbox. A runtime
  // selection the harness would refuse each of them for refuses the runner
  // here, with the harness's own message, before either lane connects to
  // anything, listens or registers.
  await deps.selectSandboxRuntime().catch((error: unknown) => {
    throw error instanceof HarnessControlError
      ? new ValidationError(error.message, { exitCode: 1 })
      : error;
  });
  if (localConfig === undefined) return await runFabricLane(options, deps);
  let local: Pick<
    LocalJobsService,
    "setFabricLane" | "setFabricReadiness" | "stop"
  >;
  try {
    local = await (deps.startLocal ?? startLocalJobs)({
      ...localConfig,
      ...(deps.labsCommit ? { labsCommit: await deps.labsCommit() } : {}),
    }, deps.report);
  } catch (error) {
    if (options.localOnly) throw error;
    deps.report(
      `agent runner: the local lane did not start, continuing with the Fabric lane: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return await runFabricLane(options, deps);
  }
  let fabric: { stop(): Promise<void> } | undefined;
  try {
    if (options.localOnly) {
      local.setFabricReadiness({
        state: "down",
        reason: "Fabric lane disabled by --local-only",
      });
      deps.report("agent runner: serving local jobs only (--local-only)");
    } else {
      const config = await resolveAgentRunnerConfig(options, deps);
      try {
        let observed: LaneTransition | undefined;
        fabric = await deps.start(
          config,
          deps.report,
          (next) => {
            observed = next;
            local.setFabricReadiness(next);
          },
        );
        if (observed === undefined) local.setFabricLane(true);
        else local.setFabricReadiness(observed);
        deps.report(
          `agent runner: following ${config.home} on ${config.homeHost}, offering ${
            config.tools.join(", ")
          }`,
        );
      } catch (error) {
        local.setFabricReadiness({
          state: "refused",
          reason: error instanceof Error ? error.message : String(error),
        });
        deps.report(
          `agent runner: the Fabric lane did not start, so this runner serves local jobs only: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    await deps.untilStopped();
    deps.report("agent runner: stopping");
  } finally {
    try {
      await fabric?.stop();
    } finally {
      await local.stop();
    }
  }
}

/** Helper for `agentRunnerAction`, which runs the Fabric lane alone. */
async function runFabricLane(
  options: AgentRunnerCommandOptions,
  deps: AgentRunnerCommandDeps,
): Promise<void> {
  const config = await resolveAgentRunnerConfig(options, deps);
  const running = await deps.start(config, deps.report);
  deps.report(
    `agent runner: following ${config.home} on ${config.homeHost}, offering ${
      config.tools.join(", ")
    }`,
  );
  try {
    await deps.untilStopped();
    deps.report("agent runner: stopping");
  } finally {
    await running.stop();
  }
}

const runnerDescription = cliText(
  `Run agent requests for one user through independent local and Fabric lanes.

--local-jobs-socket enables the local lane with host-owned profiles. --local-only
serves that lane alone, needing neither an identity nor a toolshed connection.

On the Fabric lane, a pattern's agent() request becomes an AgentRun record listed in the
requester's home-space agent queue (wish '#agent_queue'). This process holds
the requester's identity and pulls: it registers itself as the queue's
agentRunner, claims the oldest queued record under --max-concurrent, runs
cf-harness locally, and writes the result and the record's terminal state
back. A record whose runner stopped writing is queued again once, then failed
as RUNNER_LOST. It runs until interrupted.

--api-url names the toolshed serving the home space. --local-api-url names the
toolshed this runner sits beside, when that is a different one; it is what the
agentRunner entry records as the runner's host. Records are read from whichever
toolshed their queue entry names.

The model provider is the one 'cf-harness' is configured with under
CF_HARNESS_HOME.`,
);

/** Effects used by the one-shot agent inspection commands. */
export interface AgentInspectionCommandDeps {
  read: typeof readAgentRuns;
  readOne: typeof readAgentRun;
  cancel: typeof cancelAgentRun;
  render: typeof render;
}

const defaultInspectionDeps: AgentInspectionCommandDeps = {
  read: readAgentRuns,
  readOne: readAgentRun,
  cancel: cancelAgentRun,
  render,
};

/** Renders costs with their provenance and keeps withheld estimates explicit. */
export function formatAgentRun(run: AgentRunInspection): string {
  const lines = [
    `${run.id}  ${run.state}`,
    `Request: ${run.requestHash}`,
    `Task: ${run.task}`,
    `Host: ${run.host}`,
    `Submitted: ${run.submittedAt}`,
    `State since: ${run.stateSince}`,
  ];
  for (
    const [name, value] of [
      ["Outcome", run.outcome],
      ["Error", run.errorCode],
      ["Cancellation requested", run.cancelRequestedAt],
      ["Started", run.startedAt],
      ["Finished", run.finishedAt],
      ["Model turns", run.modelTurns],
      ["Tool calls", run.toolCalls],
      ["Usage coverage", run.usageCoverage],
      ["Result", run.result],
    ]
  ) {
    if (value !== undefined) lines.push(`${name}: ${value}`);
  }
  if (run.usage) {
    lines.push("Usage:");
    for (const [name, value] of Object.entries(run.usage)) {
      const label = name === "costUsd"
        ? "Provider cost (USD)"
        : name === "estimatedCostUsd"
        ? "Estimated cost (USD)"
        : name === "estimateWithheldReason"
        ? "Estimate withheld"
        : name;
      lines.push(`  ${label}: ${String(value)}`);
    }
  }
  return lines.join("\n");
}

/** Runs one metadata read or durable cancellation request. */
export async function agentInspectionAction(
  kind: "ls" | "show" | "cancel",
  options: {
    identity?: string;
    apiUrl?: string;
    json?: boolean;
    state?: string;
  },
  identifier: string | undefined,
  deps: AgentInspectionCommandDeps = defaultInspectionDeps,
): Promise<void> {
  if (!options.identity || !options.apiUrl) {
    throw new ValidationError(
      "Agent inspection requires --identity (CF_IDENTITY) and --api-url (CF_API_URL).",
    );
  }
  const config = {
    identity: absPath(options.identity),
    apiUrl: originOf("--api-url", options.apiUrl),
  };
  if (kind === "ls") {
    const runs = (await deps.read(config)).filter((run) =>
      options.state === undefined || run.state === options.state
    );
    deps.render(
      options.json
        ? runs
        : runs.length === 0
        ? "No agent runs."
        : runs.map((run) =>
          `${run.id}  ${run.state}  ${run.task}  ${run.host}  ${run.address}`
        ).join("\n"),
      { json: options.json },
    );
    return;
  }
  if (!identifier) {
    throw new ValidationError("An agent run identifier is required.");
  }
  const run = kind === "cancel"
    ? await deps.cancel(config, identifier)
    : await deps.readOne(config, identifier);
  deps.render(options.json ? run : formatAgentRun(run), { json: options.json });
}

/** The `cf agent` command tree over `deps`. */
export const createAgentCommand = (
  deps: AgentRunnerCommandDeps = defaultAgentRunnerCommandDeps,
  inspectionDeps: AgentInspectionCommandDeps = defaultInspectionDeps,
) => {
  const inspectionCommand = () =>
    new Command()
      .env("CF_API_URL=<url:string>", "Toolshed serving the home space.", {
        prefix: "CF_",
      })
      .option("-a,--api-url <url:string>", "Toolshed serving the home space.")
      .env("CF_IDENTITY=<path:string>", "Path to an identity keyfile.", {
        prefix: "CF_",
      })
      .option("-i,--identity <path:string>", "Path to an identity keyfile.")
      .option(
        "--json",
        "Print structured metadata with result links as addresses.",
      );
  const listCommand = inspectionCommand()
    .description("List agent runs from the home queue across toolsheds.")
    .type("agent-state", new EnumType([...AGENT_RUN_STATES]))
    .option("--state <state:agent-state>", "List only runs in this state.")
    .action((options) =>
      agentInspectionAction("ls", options, undefined, inspectionDeps)
    );
  const showCommand = inspectionCommand()
    .description(
      "Show one run's metadata and usage without reading its result payload.",
    )
    .arguments("<run:string>")
    .action((options, run) =>
      agentInspectionAction("show", options, run, inspectionDeps)
    );
  const cancelCommand = inspectionCommand()
    .description("Request cancellation of a nonterminal agent run.")
    .arguments("<run:string>")
    .action((options, run) =>
      agentInspectionAction("cancel", options, run, inspectionDeps)
    );
  const runnerCommand = new Command()
    .name("runner")
    .description(runnerDescription)
    .env(
      "CF_API_URL=<url:string>",
      "URL of the toolshed serving the home space.",
      {
        prefix: "CF_",
      },
    )
    .option(
      "-a,--api-url <url:string>",
      "URL of the toolshed serving the home space.",
    )
    .env("CF_IDENTITY=<path:string>", "Path to an identity keyfile.", {
      prefix: "CF_",
    })
    .option("-i,--identity <path:string>", "Path to an identity keyfile.")
    .option(
      "--local-api-url <url:string>",
      "URL of the toolshed this runner sits beside. Defaults to --api-url.",
    )
    .env(
      "CF_HARNESS_LOOM_RETRIEVAL_CONFIG=<path:string>",
      "Host-owned JSON file backing the read-only Loom tools.",
      { prefix: "CF_HARNESS_" },
    )
    .option(
      "--loom-retrieval-config <path:string>",
      "Host-owned JSON file backing the read-only Loom tools.",
    )
    .option(
      "--max-concurrent <n:integer>",
      "How many runs this process holds at once.",
      { default: 1 },
    )
    .option(
      "--tools <names:string>",
      "Comma-separated tool names this runner offers. Defaults to what its " +
        "configuration backs.",
    )
    .option(
      "--work-root <path:string>",
      "Directory for run workspaces and artifacts. Defaults to " +
        "$CF_HARNESS_HOME/agent-runs.",
    )
    .option(
      "--lease-seconds <n:integer>",
      "How far a claim's lease reaches past the run's last durable write.",
      { default: DEFAULT_LEASE_SECONDS },
    )
    .option("--model <name:string>", "Model name passed to cf-harness.")
    .option(
      "--local-jobs-socket <path:string>",
      "Serve local jobs on this Unix socket, with a bearer token beside it " +
        "(<path>.token). Off unless named.",
    )
    .option(
      "--local-job-profiles <path:string>",
      "Host-owned JSON file naming the profiles local jobs run under.",
    )
    .option(
      "--local-jobs-store <path:string>",
      "The local job store. Defaults to jobs.sqlite beside the socket.",
    )
    .option(
      "--max-concurrent-local <n:integer>",
      "How many local jobs run at once. Defaults to 2.",
    )
    .option(
      "--local-only",
      "Serve local jobs and start no Fabric lane; needs no identity or API URL.",
    )
    .action((options) => agentRunnerAction(options, deps));

  return new Command()
    .name("agent")
    .description("Run and inspect agent requests.")
    .default("help")
    .command("runner", runnerCommand)
    .command("status", createAgentStatusCommand())
    .command("ls", listCommand)
    .command("show", showCommand)
    .command("cancel", cancelCommand).reset();
};

export const agent = createAgentCommand();
