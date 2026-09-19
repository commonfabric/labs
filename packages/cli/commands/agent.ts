import { Command, ValidationError } from "@cliffy/command";
import { join } from "@std/path";

import {
  type Cell,
  experimentalOptionsForDeployedClient,
  Runtime,
  runtimePresets,
} from "@commonfabric/runner";
import { agentQueueIndexCell } from "@commonfabric/runner/agent-run";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import { createHarnessAgentRunExecutor } from "../lib/agent-run-harness.ts";
import {
  AgentRunner,
  type AgentRunnerEntry,
  type AgentRunnerOptions,
} from "../lib/agent-runner.ts";
import { normalizeApiUrl } from "../lib/api-url.ts";
import { cliText } from "../lib/cli-name.ts";
import { loadIdentity } from "../lib/identity.ts";
import { loadPieces } from "../lib/piece.ts";
import { absPath } from "../lib/utils.ts";

// `cf agent runner` — the per-user process that runs agent requests.
//
// A pattern's `agent()` request becomes an `AgentRun` record, listed in the
// requester's home-space agent queue. This process holds the requester's
// identity, sits beside their Loom instance, and pulls: it follows the queue
// on the toolshed serving the home space, follows each entry to its record on
// whichever toolshed serves the requesting space, runs `cf-harness` locally,
// and writes the result and the record's terminal fields back. Nothing on
// either toolshed connects to this process.

/** The Loom retrieval tools a runner offers when it has a Loom configuration. */
const LOOM_TOOLS = [
  "loom_search",
  "loom_page_discover",
  "loom_page_inspect",
  "loom_page_read",
  "loom_people",
  "loom_calendar_list",
  "loom_context",
  "loom_profile",
];

/** The harness tools every runner offers. */
const BASE_TOOLS = ["describe_handle", "web_fetch", "research"];

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
}

/** The tool names a runner offers: `--tools`, or what its configuration backs. */
export function resolveRunnerTools(
  options: Pick<AgentRunnerCommandOptions, "tools" | "loomRetrievalConfig">,
): string[] {
  if (options.tools !== undefined) {
    return options.tools.split(",").map((tool) => tool.trim()).filter((tool) =>
      tool !== ""
    );
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
  harnessArgs?: string[];
}

/** What the command reaches outside itself through. */
export interface AgentRunnerCommandDeps {
  env: (name: string) => string | undefined;
  loadIdentity: (path: string) => Promise<{ did(): string }>;

  /** Connects, registers, and starts following the queue. */
  start: (
    config: AgentRunnerCommandConfig,
    report: (message: string) => void,
  ) => Promise<{ stop(): Promise<void> }>;

  /** Resolves when the process is asked to stop. */
  untilStopped: () => Promise<void>;

  report: (message: string) => void;
}

/** Helper for the config, which reads an API URL option as an origin. */
function originOf(flag: string, value: string): string {
  if (!URL.canParse(value)) {
    throw new ValidationError(`"${flag}" is not a URL: ${value}`, {
      exitCode: 1,
    });
  }
  return new URL(normalizeApiUrl(value)).origin;
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
          deps.env("CF_HARNESS_HOME") ??
            join(deps.env("HOME") ?? ".", ".cf-harness"),
          "agent-runs",
        ),
    ),
    ...(options.loomRetrievalConfig !== undefined
      ? { loomRetrievalConfigPath: absPath(options.loomRetrievalConfig) }
      : {}),
    ...(options.model !== undefined
      ? { harnessArgs: ["--model", options.model] }
      : {}),
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
  async openHost(config, origin) {
    return new Runtime(runtimePresets.remoteClient({
      apiUrl: new URL(origin),
      storageManager: StorageManager.open({
        as: await loadIdentity(config.identityPath),
        memoryHost: new URL(origin),
      }),
      experimental: await experimentalOptionsForDeployedClient({
        apiUrl: new URL(origin),
        env: Deno.env.get,
      }),
    }));
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

  const queue = agentQueueIndexCell(homeRuntime, homeSpace);
  await queue.sync();
  if (queue.get() === undefined) {
    await disposeAll();
    throw new Error(
      "The home space holds no agent queue: its home pattern predates the " +
        "`agentQueue` field. Open the home space in the shell once so the " +
        "pattern updates, then start the runner again.",
    );
  }
  // The send settles when the handling's commit does.
  const registerRunner = (entry: AgentRunnerEntry): Promise<void> =>
    new Promise<void>((resolve) =>
      homePattern.key("agentQueue").key("setAgentRunner")
        .send({ runner: entry }, () => resolve())
    );

  const runner = new AgentRunner({
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
      ...(config.loomRetrievalConfigPath !== undefined
        ? { loomRetrievalConfigPath: config.loomRetrievalConfigPath }
        : {}),
      ...(config.harnessArgs !== undefined
        ? { harnessArgs: config.harnessArgs }
        : {}),
      report,
    }),
    report,
  });
  await runner.start();
  return {
    stop: async () => {
      await runner.stop();
      await disposeAll();
    },
  };
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
  start: startAgentRunner,
  untilStopped: untilSignalled,
  report: (message) => console.error(message),
};

/** Runs a runner until the process is asked to stop. */
export async function agentRunnerAction(
  options: AgentRunnerCommandOptions,
  deps: AgentRunnerCommandDeps = defaultAgentRunnerCommandDeps,
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
  `Run agent requests for one user, beside their Loom instance.

A pattern's agent() request becomes an AgentRun record listed in the
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

/** The `cf agent` command tree over `deps`. */
export const createAgentCommand = (
  deps: AgentRunnerCommandDeps = defaultAgentRunnerCommandDeps,
) => {
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
    .action((options) => agentRunnerAction(options, deps));

  return new Command()
    .name("agent")
    .description("Run and inspect agent requests.")
    .default("help")
    .command("runner", runnerCommand);
};

export const agent = createAgentCommand();
