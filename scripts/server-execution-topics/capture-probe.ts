/**
 * Captures a mechanism probe with exact source, command, runtime, and output
 * provenance. Usage: `deno run -A capture-probe.ts NAME NEW_DIRECTORY [ARGS]`.
 */

import { encodeHex } from "@std/encoding/hex";
import { join, resolve } from "@std/path";

import { sha256 } from "@commonfabric/content-hash";

const [name, directory, ...args] = Deno.args;
if (
  !["event-visibility", "serving", "sidecar", "watch"].includes(name) ||
  !directory
) {
  throw new Error("Expected probe name and new artifact directory.");
}
const root = resolve(import.meta.dirname!, "../..");
const out = resolve(directory);
await Deno.mkdir(out);
const sources = join(out, "sources");
await Deno.mkdir(sources);
const sourceHashes: Record<string, string> = {};
for await (const entry of Deno.readDir(import.meta.dirname!)) {
  if (!entry.isFile || !entry.name.endsWith(".ts")) continue;
  const contents = await Deno.readFile(join(import.meta.dirname!, entry.name));
  await Deno.writeFile(join(sources, entry.name), contents);
  sourceHashes[entry.name] = encodeHex(sha256(contents));
}

/** Reads Git metadata without changing the checkout. */
async function git(args: string[]): Promise<string> {
  const result = await new Deno.Command("git", {
    args,
    cwd: root,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!result.success) {
    throw new Error(new TextDecoder().decode(result.stderr));
  }
  return new TextDecoder().decode(result.stdout);
}

const head = (await git(["rev-parse", "HEAD"])).trim();
await Deno.writeTextFile(
  join(out, "worktree.patch"),
  await git([
    "diff",
    "HEAD",
    "--binary",
  ]),
);
const flags = Object.fromEntries(
  Object.entries(Deno.env.toObject()).filter(([key]) =>
    key.startsWith("EXPERIMENTAL_")
  ),
);
const command = [
  Deno.execPath(),
  "run",
  "-A",
  `scripts/server-execution-topics/${name}-probe.ts`,
  ...args,
];
const manifest: Record<string, unknown> = {
  kind: "mechanism-probe",
  head,
  sourceHashes,
  runtime: Deno.version,
  machine: {
    ...Deno.build,
    logicalCpus: navigator.hardwareConcurrency,
    memory: Deno.systemMemoryInfo().total,
  },
  command,
  cwd: root,
  flags: { ...flags, CF_LOG_LEVEL: "silent" },
  cache: "fresh in-memory stores; existing Deno dependency cache",
  started: new Date().toISOString(),
  loadAtStart: Deno.loadavg(),
  status: "running",
};
const save = () =>
  Deno.writeTextFile(
    join(out, "manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );
await save();
try {
  const result = await new Deno.Command(command[0], {
    args: command.slice(1),
    cwd: root,
    env: { CF_LOG_LEVEL: "silent" },
    stdout: "piped",
    stderr: "piped",
  }).output();
  await Deno.writeFile(join(out, "results.jsonl"), result.stdout);
  await Deno.writeFile(join(out, "stderr.log"), result.stderr);
  manifest.resultSha256 = encodeHex(sha256(result.stdout));
  manifest.stderrSha256 = encodeHex(sha256(result.stderr));
  manifest.exitCode = result.code;
  manifest.status = result.success ? "passed" : "failed";
  if (!result.success) throw new Error(`Probe exited with ${result.code}.`);
} catch (error) {
  manifest.status = "failed";
  manifest.error = error instanceof Error ? error.message : String(error);
  throw error;
} finally {
  manifest.finished = new Date().toISOString();
  manifest.loadAtEnd = Deno.loadavg();
  await save();
}
