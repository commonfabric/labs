import {
  type EnvReader,
  type ExperimentalOptions,
  experimentalOptionsFromEnv,
  withServerExecutionDefault,
} from "@commonfabric/runner";

/**
 * Resolves the experimental flags of a runtime `cf test` builds from `env`,
 * deciding its server-execution posture as a deployed entry point does: the
 * explicit `EXPERIMENTAL_SERVER_EXECUTION`, else the first-party default.
 * `serverExecution` is `true` in the result exactly when that posture is ON;
 * otherwise the result holds what `env` sets and nothing more, so a run on
 * the OFF arm names no flag its environment did not.
 *
 * The posture decides the topology as well as the runtime's flags. A runtime
 * on the server-execution arm commits the event a handler is fired with and
 * leaves the handler to a serving loop, so a run on that arm hosts one beside
 * its memory server, and a run on the other arm hosts none.
 */
export function patternTestExperimentalOptions(
  env: EnvReader,
): ExperimentalOptions {
  const experimental = experimentalOptionsFromEnv(env);
  return withServerExecutionDefault(experimental).serverExecution
    ? { ...experimental, serverExecution: true }
    : experimental;
}
