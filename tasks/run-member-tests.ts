#!/usr/bin/env -S deno run --allow-env --allow-read --allow-run

/**
 * The one command a workspace member's `test` task runs.
 *
 * A member's tests are often several commands: a Deno half and a browser
 * half, a compile of a harness after the tests, a second pass under a
 * different import map. Written as a chain or as a list of tasks for
 * Deno to depend on, whatever reads the task cannot see past the join — a chain's appended
 * flags reach only its last command, and a dependency list has no
 * command for one to be appended to at all. What that costs is records:
 * the run has nowhere to write a report, so nothing downstream learns
 * what any of those tests are worth.
 *
 * So the join moves here. A member names the tasks it wants run, in the
 * order it wants them, one of them being `deno-test`: the task holding
 * whatever a run of this member's tests mostly is, and the one an
 * appended flag is meant for. That is a `deno test` for all but a few
 * members, and for those few it is the test runner they have of their
 * own.
 *
 *     "test": "deno run <perms> ../../tasks/run-member-tests.ts deno-test browser-test"
 *     "deno-test": "deno test --allow-read"
 *     "browser-test": "deno run -A ../deno-web-test/cli.ts **\/*.test.ts"
 *
 * `deno-test` takes whatever flags were appended to the `test` task,
 * which is how a report path and the record preload reach the one
 * command that can use them. A failure stops the rest, as `&&` would.
 *
 * The line says the whole of what runs and in what order, so a member
 * keeps whatever order it had, and both the readers of a member read one
 * shape rather than one each.
 */

import { parse as parseJsonc } from "@std/jsonc";

/** The task a member's tests live in, and the one appended flags reach. */
export const DENO_TEST_TASK = "deno-test";

/** What one invocation runs: the tasks named, and the flags to forward. */
export interface Invocation {
  /** Every task to run, in the order named. */
  tasks: string[];

  /** Flags appended to the `test` task, which `deno-test` is given. */
  forwarded: string[];
}

/**
 * The arguments apart, given what a member's `test` task was invoked
 * with.
 *
 * A task's own names and the arguments a caller appended arrive as one
 * list. The first word opening with a dash is where the names end,
 * because a task name never opens with one and a caller appends flags;
 * everything from there on is forwarded as it stands. That includes a
 * word carrying no dash, since a flag may take its value as the next
 * argument — `--filter "a name"` is two words, and reading the second as
 * a task name would refuse the ordinary way of running one test.
 */
export function readInvocation(args: readonly string[]): Invocation {
  const first = args.findIndex((arg) => arg.startsWith("-"));
  return first === -1
    ? { tasks: [...args], forwarded: [] }
    : { tasks: args.slice(0, first), forwarded: args.slice(first) };
}

/** The tasks a member's manifest defines, or none where it defines no file. */
export async function memberTasks(
  memberDir: string = Deno.cwd(),
): Promise<Set<string>> {
  for (const manifest of ["deno.json", "deno.jsonc"]) {
    let text: string;
    try {
      text = await Deno.readTextFile(`${memberDir}/${manifest}`);
    } catch {
      continue;
    }
    const config = parseJsonc(text) as { tasks?: Record<string, unknown> };
    return new Set(Object.keys(config?.tasks ?? {}));
  }
  return new Set();
}

/**
 * The tasks this invocation runs, in order, checked against the ones the
 * member defines.
 *
 * Two things are refused rather than run past. A line naming no
 * `deno-test` leaves the appended flags nowhere to go, so the member
 * would run and report a pass with no record of having done so. And a
 * name the member defines no task for is work nobody is told went
 * missing.
 */
export function plan(
  invocation: Invocation,
  defined: ReadonlySet<string>,
): string[] {
  const missing = invocation.tasks.filter((task) => !defined.has(task));
  if (missing.length > 0) {
    throw new Error(
      `run-member-tests: this member defines no ${missing.join(", ")} ` +
        `task(s), and a name that runs nothing is work nobody is told ` +
        `went missing.`,
    );
  }
  if (!invocation.tasks.includes(DENO_TEST_TASK)) {
    throw new Error(
      `run-member-tests: no \`${DENO_TEST_TASK}\` among the tasks named, ` +
        `so there is nothing for an appended report path to reach. Name ` +
        `the task holding this member's tests \`${DENO_TEST_TASK}\` and ` +
        `put it on the line.`,
    );
  }
  return [...invocation.tasks];
}

/**
 * Runs one of the member's tasks, handing it the flags where it is the
 * one that takes them. Returns its exit code.
 */
async function runTask(
  task: string,
  forwarded: readonly string[],
): Promise<number> {
  const { code } = await new Deno.Command(Deno.execPath(), {
    args: ["task", task, ...forwarded],
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  }).spawn().status;
  return code;
}

async function main(): Promise<void> {
  const invocation = readInvocation(Deno.args);
  for (const task of plan(invocation, await memberTasks())) {
    // Only `deno-test` is given the appended flags. Every other task is
    // a command of its own, and a report path handed to one that writes
    // no report would end the run rather than be ignored.
    const code = await runTask(
      task,
      task === DENO_TEST_TASK ? invocation.forwarded : [],
    );
    // A failure stops the rest, as `&&` would.
    if (code !== 0) Deno.exit(code);
  }
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    // A misconfigured member is an authoring mistake, and the message
    // says what to write. A stack through this file says nothing a
    // reader of that message needs.
    console.error(error instanceof Error ? error.message : `${error}`);
    Deno.exit(2);
  }
}
