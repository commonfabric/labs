/**
 * Starts a test run's processes below interactive work on a developer Mac.
 *
 * Why: several agents running workspace test suites at once kept a 14-core
 * Mac at a load average above 100, and the services a person was waiting on
 * (a local server answering a UI) ran at the same scheduler priority as every
 * test process, so they starved. macOS has a class for batch work:
 * `taskpolicy -c utility` runs a program, and everything it spawns, below
 * interactive work (measured: priority 20 against 31), and unlike the
 * background class it always makes progress.
 *
 * The clamp applies only on macOS, never under CI, and not with
 * CF_TEST_QOS=0, so a run can ask for full priority when it has the machine
 * to itself.
 */

export const TASKPOLICY = "/usr/sbin/taskpolicy";

export interface BatchQosContext {
  os: string;
  env: (name: string) => string | undefined;
}

const HOST: BatchQosContext = {
  os: Deno.build.os,
  env: (name) => Deno.env.get(name),
};

/** `argv`, prefixed to run at utility QoS where the clamp applies. */
export function batchQosArgv(
  argv: readonly string[],
  context: BatchQosContext = HOST,
): string[] {
  if (argv.length === 0) throw new Error("batchQosArgv: empty argv");
  if (
    context.os !== "darwin" || context.env("CI") ||
    context.env("CF_TEST_QOS") === "0"
  ) {
    return [...argv];
  }
  return [TASKPOLICY, "-c", "utility", ...argv];
}
