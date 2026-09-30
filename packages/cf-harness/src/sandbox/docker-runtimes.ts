/** Shared acquisition of the running daemon's runtime registration table. */

import { errorMessage } from "../error-message.ts";
import {
  DenoProcessRunner,
  type ProcessRunner,
  type ProcessRunResult,
} from "./process-runner.ts";

/**
 * The runtime table `docker info` reports, or the reason it could not be read.
 * The running daemon's table rather than `daemon.json`: a configuration file
 * the daemon has not reloaded names directories nothing writes.
 */
export const readDockerRuntimes = async (
  dockerBinary: string,
  runner: ProcessRunner = new DenoProcessRunner(),
): Promise<{ runtimes?: unknown; unreadable?: string }> => {
  let output: ProcessRunResult;
  try {
    output = await runner.run({
      command: dockerBinary,
      args: ["info", "--format", "{{json .Runtimes}}"],
    });
  } catch (error) {
    return {
      unreadable: `\`${dockerBinary} info\` could not be run: ${
        errorMessage(error)
      }`,
    };
  }
  if (output.exitCode !== 0) {
    return {
      unreadable:
        `\`${dockerBinary} info\` exited ${output.exitCode}: ${output.stderr.trim()}`,
    };
  }
  try {
    return { runtimes: JSON.parse(output.stdout) };
  } catch (error) {
    return {
      unreadable: `\`${dockerBinary} info\` reported a runtime table that ` +
        `does not parse: ${errorMessage(error)}`,
    };
  }
};
