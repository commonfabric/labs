/**
 * A wall-clock bound over a subprocess, for the narrow case where a command
 * can block in the kernel instead of answering slowly: `docker info` against a
 * socket that is not there, or a `getxattr` walk over a mount that has gone
 * away. A bound is the wrong tool for anything that would eventually finish,
 * and this one is not offered for that.
 */

/**
 * How a bounded run ended. `completed` carries the child's own exit status.
 * `timed-out` means the bound expired and the child took a `SIGKILL`;
 * `killError` describes a kill or a reap that did not work, so a caller that
 * cares can say what was left behind.
 */
export type BoundedCommandStatus =
  | { kind: "completed"; status: Deno.CommandStatus }
  | { kind: "timed-out"; killError?: string };

/**
 * Spawns `command` and waits at most `timeoutMs` for it to exit, killing it
 * and reporting `timed-out` if it does not. A child that outlives its own
 * `SIGKILL` is unreferenced so it cannot hold the process open.
 */
export const commandStatusWithTimeout = async (
  command: Deno.Command,
  timeoutMs: number,
): Promise<BoundedCommandStatus> => {
  const child = command.spawn();
  const statusPromise = child.status;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<"timed-out">((resolve) => {
    timeoutId = setTimeout(() => resolve("timed-out"), timeoutMs);
  });
  const result = await Promise.race([statusPromise, timeoutPromise]);
  if (timeoutId !== undefined) clearTimeout(timeoutId);
  if (result !== "timed-out") return { kind: "completed", status: result };

  const describeError = (error: unknown): string =>
    error instanceof Error ? error.message : String(error);
  const appendError = (
    existing: string | undefined,
    label: string,
    error: unknown,
  ): string => {
    const message = `${label}: ${describeError(error)}`;
    return existing === undefined ? message : `${existing}; ${message}`;
  };

  let killError: string | undefined;
  try {
    child.kill("SIGKILL");
  } catch (error) {
    killError = appendError(killError, "SIGKILL failed", error);
  }

  let cleanupTimeoutId: ReturnType<typeof setTimeout> | undefined;
  const cleanupTimeoutPromise = new Promise<"cleanup-timed-out">((resolve) => {
    cleanupTimeoutId = setTimeout(() => resolve("cleanup-timed-out"), 1_000);
  });
  const cleanupResult = await Promise.race([
    statusPromise.then(() => "closed" as const).catch((error) => ({
      kind: "status-error" as const,
      message: describeError(error),
    })),
    cleanupTimeoutPromise,
  ]);
  if (cleanupTimeoutId !== undefined) clearTimeout(cleanupTimeoutId);

  if (cleanupResult !== "closed") {
    // The reap did not land, whether it ran out of time or failed outright, so
    // the child does not get to hold the process open on its own.
    child.unref();
    if (cleanupResult !== "cleanup-timed-out") {
      killError = appendError(
        killError,
        "child status failed after timeout",
        cleanupResult.message,
      );
    }
  }

  return killError === undefined
    ? { kind: "timed-out" }
    : { kind: "timed-out", killError };
};
