/**
 * Builds CI's matching baked toolshed and runs a Deno workload in a fresh store.
 * Saves exact commands, posture, load samples, raw output, and server statistics.
 * Usage: `deno run -A tools/server-execution-topics/run-arm.ts default DIR
 * correctness test -A packages/patterns/integration/EXAMPLE.test.ts`.
 * `latency` mode refuses a loaded machine and invalidates a run that gets busy.
 */

import { dirname, join, resolve } from "@std/path";

import {
  type CapabilityId,
  type Exec,
  openCapabilities,
} from "../../tasks/ci-capabilities.ts";
import {
  assertServerExecutionCiPosture,
  serverExecutionCiLane,
} from "../../tasks/server-execution-ci.ts";

const [role, directory, mode, ...args] = Deno.args;
if (
  (role !== "default" && role !== "opposite") || !directory ||
  (mode !== "correctness" && mode !== "latency" && mode !== "profile") ||
  args.length === 0
) {
  throw new Error(
    "Expected role, new artifact directory, mode, and Deno args.",
  );
}
const root = resolve(import.meta.dirname!, "../..");
const runDir = resolve(directory);
await Deno.mkdir(runDir);
const store = join(runDir, "store");
await Deno.mkdir(store);
const lane = serverExecutionCiLane(role);
const capability: CapabilityId = role === "default"
  ? "toolshed-baked"
  : "toolshed-baked-opposite";
/** Builds a complete child environment with the lane's exact flag posture. */
function executionEnvironment(
  overrides: Record<string, string> = {},
): Record<string, string> {
  const env = { ...Deno.env.toObject(), ...overrides };
  if (lane.experimentalValue === undefined) {
    delete env.EXPERIMENTAL_SERVER_EXECUTION;
  } else env.EXPERIMENTAL_SERVER_EXECUTION = lane.experimentalValue;
  return env;
}

/** Reads an endpoint only when its HTTP response succeeded. */
async function readJson(url: string): Promise<Record<string, unknown>> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Fetching ${url} failed with status ${response.status}.`);
  }
  return await response.json();
}

const commands: { command: string; args: readonly string[]; cwd: string }[] =
  [];

/** Executes and records a setup command, placing this run's server in its store. */
const exec: Exec = async (command, commandArgs, options = {}) => {
  const cwd = command.endsWith(`toolshed-baked-${role}`)
    ? store
    : options.cwd ?? root;
  const index = commands.length;
  commands.push({ command, args: commandArgs, cwd });
  const result = await new Deno.Command(command, {
    args: [...commandArgs],
    cwd,
    env: executionEnvironment(options.env),
    clearEnv: true,
    stdout: "piped",
    stderr: "piped",
  }).output();
  await Deno.writeFile(join(runDir, `setup-${index}.stdout`), result.stdout);
  await Deno.writeFile(join(runDir, `setup-${index}.stderr`), result.stderr);
  if (!result.success) {
    throw new Error(`Setup command ${index} failed with exit ${result.code}.`);
  }
  return new TextDecoder().decode(result.stdout);
};

const samples: { at: string; load: number[] }[] = [];
const sampleLoad = () =>
  samples.push({
    at: new Date().toISOString(),
    load: Deno.loadavg(),
  });
sampleLoad();
const head = (await exec("git", ["rev-parse", "HEAD"])).trim();
const sourceStatus = await exec("git", [
  "status",
  "--porcelain=v1",
  "--untracked-files=all",
  "--ignore-submodules=none",
]);
const patch = await exec("git", ["diff", "HEAD", "--binary"]);
await Deno.writeTextFile(join(runDir, "worktree.patch"), patch);
const sourcePaths = [
  "tools/server-execution-topics/run-arm.ts",
  "tools/server-execution-topics/seed-check.ts",
  "packages/patterns/integration/topic-board-fixture.ts",
];
for (const path of sourcePaths) {
  const destination = join(runDir, "sources", path);
  await Deno.mkdir(dirname(destination), { recursive: true });
  await Deno.copyFile(join(root, path), destination);
}
const flags = Object.fromEntries(
  Object.entries(Deno.env.toObject()).filter(([key]) =>
    key.startsWith("EXPERIMENTAL_") ||
    key.startsWith("CF_TOPIC") ||
    ["CF_TIMING_MEASURES", "CF_MEMORY_FRAME_LOG", "CF_PROF_CPU"].includes(key)
  ),
);
if (lane.experimentalValue === undefined) {
  delete flags.EXPERIMENTAL_SERVER_EXECUTION;
} else flags.EXPERIMENTAL_SERVER_EXECUTION = lane.experimentalValue;
const cpuModel = Deno.build.os === "darwin"
  ? (await exec("/usr/sbin/sysctl", ["-n", "machdep.cpu.brand_string"])).trim()
  : Deno.build.os === "linux"
  ? (await Deno.readTextFile("/proc/cpuinfo"))
    .match(/^model name\s*:\s*(.+)$/m)?.[1]
  : undefined;
const provenance: Record<string, unknown> = {
  checkout: root,
  captureDirectory: runDir,
  commands,
};
const manifest: Record<string, unknown> = {
  version: 2,
  mode,
  role,
  expectedPosture: lane,
  workloadHead: head,
  sourceStatus,
  sourcePaths,
  artifactRoot: ".",
  store: "store",
  provenance,
  cache: "fresh store and server; existing Deno dependency cache",
  machine: {
    cpu: cpuModel,
    arch: Deno.build.arch,
    os: Deno.build.os,
    logicalCpus: navigator.hardwareConcurrency,
    totalmem: Deno.systemMemoryInfo().total,
  },
  runtime: Deno.version,
  flags,
  samples,
  status: "preparing",
};
const save = () =>
  Deno.writeTextFile(
    join(runDir, "manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );
await save();
if (sourceStatus.trim() !== "") {
  manifest.status = "blocked-source";
  await save();
  await Deno.writeTextFile(join(runDir, "source-status.txt"), sourceStatus);
  throw new Error(
    "Campaign runs require a clean tracked checkout with no untracked inputs. " +
      "Commit the workload and implementation in an isolated branch first.",
  );
}
if (
  mode === "latency" &&
  ["CF_TIMING_MEASURES", "CF_MEMORY_FRAME_LOG", "CF_PROF_CPU"].some((key) =>
    flags[key] !== undefined && !["", "0", "false"].includes(flags[key])
  )
) {
  manifest.status = "blocked-instrumentation";
  await save();
  throw new Error(
    "Latency runs must be separate from timing/frame/CPU profiling.",
  );
}
if (mode === "latency" && samples[0].load[0] > 5) {
  manifest.status = "blocked-load";
  await save();
  throw new Error("Latency run requires one-minute load at or below 5.");
}

let opened: Awaited<ReturnType<typeof openCapabilities>> | undefined;
let sampling: ReturnType<typeof setInterval> | undefined;
try {
  // Build before starting the server: a cached binary's embedded commit alone
  // cannot prove it was compiled from the checkout's current source.
  await exec(Deno.execPath(), ["task", "build-binaries", "toolshed"], {
    env: { COMMIT_SHA: head },
  });
  const afterBuildHead = (await exec("git", ["rev-parse", "HEAD"])).trim();
  const afterBuildStatus = await exec("git", [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
    "--ignore-submodules=none",
  ]);
  if (afterBuildHead !== head || afterBuildStatus.trim() !== "") {
    throw new Error("The source checkout changed during the toolshed build.");
  }
  const binaryDirectory = join(root, ".ci-cache/binaries");
  await Deno.mkdir(binaryDirectory, { recursive: true });
  const temporaryBinary = join(
    binaryDirectory,
    `campaign-${crypto.randomUUID()}`,
  );
  try {
    await Deno.copyFile(join(root, "dist/toolshed"), temporaryBinary);
    await Deno.rename(
      temporaryBinary,
      join(binaryDirectory, `toolshed-baked-${role}`),
    );
  } finally {
    await Deno.remove(temporaryBinary).catch((error) => {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    });
  }
  manifest.build = "fresh build from the clean workload head before this run";
  opened = await openCapabilities([capability], {
    root,
    dryRun: false,
    workDir: runDir,
    exec,
  });
  const endpoint = opened.envFor([capability]);
  const meta = await readJson(`${endpoint.API_URL}/api/meta`);
  const before = await readJson(`${endpoint.API_URL}/api/health/stats`);
  assertServerExecutionCiPosture(role, meta, before);
  if (meta.gitSha !== head) {
    throw new Error(
      `Server build ${meta.gitSha} does not match workload head ${head}. ` +
        "Rebuild both binaries with COMMIT_SHA set to the workload head.",
    );
  }
  manifest.meta = meta;
  manifest.serverBuildHead = meta.gitSha;
  await Deno.writeTextFile(
    join(runDir, "stats-before.json"),
    JSON.stringify(before),
  );
  const binary = join(root, ".ci-cache/binaries", `toolshed-baked-${role}`);
  manifest.binarySha256 = (await exec("shasum", ["-a", "256", binary]))
    .split(" ")[0];
  const env = {
    ...endpoint,
    ...flags,
    FRONTEND_URL: endpoint.API_URL,
    HEADLESS: "1",
    CF_LOG_LEVEL: "silent",
    CF_CAMPAIGN_RUN_DIR: runDir,
  };
  provenance.workloadEnvironment = env;
  commands.push({ command: Deno.execPath(), args, cwd: root });
  sampleLoad();
  if (mode === "latency" && samples.at(-1)!.load[0] > 5) {
    manifest.status = "blocked-load-after-build";
    await save();
    throw new Error(
      "Machine load exceeds the latency threshold after building.",
    );
  }
  // Periodic samples observe contention during the workload; they do not
  // delay it or determine when its completion conditions have been reached.
  sampling = setInterval(sampleLoad, 1000);
  manifest.status = "running";
  await save();
  const result = await new Deno.Command(Deno.execPath(), {
    args,
    cwd: root,
    env: executionEnvironment(env),
    clearEnv: true,
    stdout: "piped",
    stderr: "piped",
  }).output();
  clearInterval(sampling);
  sampling = undefined;
  sampleLoad();
  await Deno.writeFile(join(runDir, "workload.stdout"), result.stdout);
  await Deno.writeFile(join(runDir, "workload.stderr"), result.stderr);
  const after = await readJson(`${endpoint.API_URL}/api/health/stats`);
  await Deno.writeTextFile(
    join(runDir, "stats-after.json"),
    JSON.stringify(after),
  );
  manifest.exitCode = result.code;
  manifest.latencyEligible = mode === "latency" &&
    samples.every(({ load }) => load[0] <= 5);
  manifest.status = !result.success
    ? "failed-workload"
    : mode === "latency" && manifest.latencyEligible !== true
    ? "invalid-load"
    : "passed";
  await save();
  if (!result.success) {
    throw new Error(`Workload failed with exit ${result.code}.`);
  }
  if (manifest.status === "invalid-load") {
    throw new Error(
      "Machine load exceeded the latency threshold during this run.",
    );
  }
} catch (error) {
  manifest.error = error instanceof Error ? error.message : String(error);
  if (manifest.status === "preparing" || manifest.status === "running") {
    manifest.status = "failed";
  }
  await save();
  throw error;
} finally {
  if (sampling !== undefined) clearInterval(sampling);
  await opened?.close();
}
