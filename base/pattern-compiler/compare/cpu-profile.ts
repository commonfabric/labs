/**
 * The sampling profiler of the process, for a harness that profiles one of
 * its steps. The profile is in the format of the V8 inspector.
 */
// deno-lint-ignore no-external-import -- The sampling profiler is reached through this Node builtin alone.
import inspector from "node:inspector";

/**
 * Starts the sampling profiler at an interval of 200 microseconds and
 * returns what stops it and writes the profile to `file`.
 */
export const startCpuProfile = async (
  file: string,
): Promise<() => Promise<void>> => {
  const session = new inspector.Session();
  session.connect();
  const post = (method: string, params?: object) =>
    new Promise<unknown>((resolve, reject) =>
      session.post(
        method,
        params,
        (error: Error | null, result?: unknown) =>
          error === null ? resolve(result) : reject(error),
      )
    );
  await post("Profiler.enable");
  await post("Profiler.setSamplingInterval", { interval: 200 });
  await post("Profiler.start");
  return async () => {
    const { profile } = await post("Profiler.stop") as { profile: unknown };
    await Deno.writeTextFile(file, JSON.stringify(profile));
    session.disconnect();
  };
};
