/**
 * What a finished local job's run record says it did, read from the runner's
 * run directories under `~/.cf-harness/agent-runs/local`: the root run, the
 * tools it and its subagents called, its report, and its run state. The want
 * eval and the shape eval both measure a job by these.
 */

import { basename, join } from "@std/path";

/**
 * Where a runner keeps its local jobs' runs: under `CF_HARNESS_HOME` when it
 * is set, as the harness keeps its home, else `~/.cf-harness`.
 */
export const defaultRunsRoot = (): string =>
  join(
    Deno.env.get("CF_HARNESS_HOME") ??
      join(Deno.env.get("HOME") ?? "", ".cf-harness"),
    "agent-runs/local",
  );

/**
 * The newest run directory of a job under `runsRoot`: the root run, not a
 * subagent's.
 */
export const rootRunOf = async (
  job: string,
  runsRoot: string = defaultRunsRoot(),
): Promise<string> => {
  const root = join(runsRoot, job.startsWith("job-") ? job : `job-${job}`);
  const runs: { path: string; mtime: number }[] = [];
  for await (const entry of Deno.readDir(join(root, "artifacts"))) {
    if (!entry.isDirectory || entry.name.includes(".subagent.")) continue;
    const path = join(root, "artifacts", entry.name);
    runs.push({ path, mtime: (await Deno.stat(path)).mtime?.getTime() ?? 0 });
  }
  runs.sort((a, b) => b.mtime - a.mtime);
  if (runs.length === 0) throw new Error(`no run recorded for ${job}`);
  return runs[0].path;
};

/** Tool names the transcript at `path` called, in order. */
export const callsIn = async (path: string): Promise<string[]> => {
  const transcript = JSON.parse(
    await Deno.readTextFile(join(path, "transcript.json")),
  ) as { toolCalls?: { function: { name: string } }[] }[];
  return transcript.flatMap((message) =>
    (message.toolCalls ?? []).map((call) => call.function.name)
  );
};

/** How many subagents a root run spawned, and the tool calls they made. */
export const subagentsOf = async (
  run: string,
): Promise<{ subagents: number; childCalls: number }> => {
  let subagents = 0;
  let childCalls = 0;
  for await (const entry of Deno.readDir(join(run, ".."))) {
    if (!entry.name.startsWith(`${basename(run)}.subagent.`)) continue;
    subagents += 1;
    childCalls += (await callsIn(join(run, "..", entry.name))).length;
  }
  return { subagents, childCalls };
};

/** A run's JSON record named `file`: `run-report.json` or `run-state.json`. */
export const recordOf = async (
  run: string,
  file: "run-report.json" | "run-state.json",
): Promise<Record<string, unknown>> =>
  JSON.parse(await Deno.readTextFile(join(run, file)));
