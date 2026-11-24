#!/usr/bin/env -S deno run --allow-read --allow-write --allow-run --allow-env --allow-net

/**
 * Runs a command and spools one record from its exit code:
 *
 *   deno task run-recorded <kind> <scope> <name> -- <command...>
 *
 * This is the producer for command-level checks — format, lint, the
 * whole-tree type check, every repository gate — and the escape hatch for
 * anything future that has no native reporter. The command's exit code is
 * the wrapper's exit code; recording failures warn and change nothing.
 *
 * Inside an enclosing run (CF_TEST_RECORDS_DIR set, as CI jobs do) the
 * wrapper joins it as a producer. Otherwise, with a personal key present,
 * it owns a run of its own: it stamps a spool, ships it afterward, and
 * sweeps for orphans. With neither, it only runs the command.
 */

import {
  type Environment,
  FragmentWriter,
  readEnv,
} from "@commonfabric/test-support/records";
import {
  finishRunRecording,
  recordingChildEnv,
  startRunRecording,
} from "./test-records.ts";

const USAGE =
  "usage: deno task run-recorded <kind> <scope> <name> -- <command...>";

/** Starts a wrapped command and resolves to how it ended. */
export type Spawn = (
  command: string,
  args: string[],
  cwd: string,
  env: Record<string, string>,
) => Promise<Deno.CommandStatus>;

/**
 * Runs `command` in `cwd` with `env` added to the environment, sharing this
 * process's standard input, output and error.
 */
export async function spawnInherited(
  command: string,
  args: string[],
  cwd: string,
  env: Record<string, string>,
): Promise<Deno.CommandStatus> {
  return await new Deno.Command(command, {
    args,
    cwd,
    env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  }).spawn().status;
}

/**
 * Runs the wrapper for a command line and returns its exit status: the
 * command's own, 127 when the command cannot be started, and 2 for a
 * malformed command line.
 */
export async function runRecorded(
  argsIn: readonly string[],
  env: Environment = Deno.env.get,
  spawn: Spawn = spawnInherited,
): Promise<number> {
  const args = [...argsIn];
  const kind = args.shift();
  const scope = args.shift();
  const name = args.shift();
  // Empty identity components are rejected here, loudly: the record schema
  // requires non-empty parts, so a record built from one would be dropped
  // by every reader and the command would silently vanish from history.
  if (
    kind === undefined || kind.length === 0 ||
    scope === undefined || scope.length === 0 ||
    name === undefined || name.length === 0 ||
    args.shift() !== "--" || args.length === 0
  ) {
    console.error(USAGE);
    return 2;
  }

  const recording = await startRunRecording(env);
  const childEnv = recordingChildEnv(recording);

  // A root deno task runs with the workspace root as its working
  // directory and the invoker's directory in INIT_CWD. The wrapped
  // command belongs where the caller stood — a member-directory step
  // wrapping `deno task <member task>` must resolve that member's task.
  const initCwd = readEnv("INIT_CWD", env);
  const childCwd = initCwd !== undefined && initCwd.length > 0
    ? initCwd
    : Deno.cwd();

  const startedAt = performance.now();
  let code = 1;
  try {
    const status = await spawn(args[0]!, args.slice(1), childCwd, childEnv);
    code = status.code;
    if (status.signal !== null) {
      console.error(
        `run-recorded: \`${args[0]}\` terminated by \`${status.signal}\`.`,
      );
    }
  } catch (error) {
    console.error(`run-recorded: cannot run ${args[0]}: ${error}`);
    code = 127;
  }
  const durationMs = performance.now() - startedAt;

  const dir = recording.mode === "join"
    ? recording.dir
    : recording.mode === "own"
    ? recording.spool.dir
    : undefined;
  if (dir !== undefined) {
    const writer = FragmentWriter.open(dir);
    writer?.append({
      line: "record",
      test: { k: kind, s: scope, n: name },
      outcome: code === 0 ? "pass" : "fail",
      durationMs: Math.round(durationMs),
    });
    writer?.close();
  }
  await finishRunRecording(recording, env);
  return code;
}

if (import.meta.main) Deno.exit(await runRecorded(Deno.args));
