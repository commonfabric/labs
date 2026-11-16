/**
 * V8's sampling heap profiler on the calling thread's isolate, for finding
 * which code allocated what a thread's heap holds. Once started, V8 records
 * the stack of about one allocation in every
 * {@link HEAP_SAMPLING_INTERVAL_BYTES} and keeps each record while its
 * object lives, so a profile read at any time attributes the live heap to
 * the functions that allocated it. At this interval the sampling costs
 * nothing measurable and a profile takes little memory to read, where a heap
 * snapshot needs about twelve times the heap it describes.
 */

import { Session } from "@node/inspector";

/**
 * About how many bytes V8 allocates between two samples. V8's own default,
 * 32 KiB, slowed an allocation-heavy loop by a quarter; at 512 KiB the
 * difference was within noise.
 */
export const HEAP_SAMPLING_INTERVAL_BYTES = 512 * 1024;

/**
 * This thread's sampler once started, or why it could not start: an isolate
 * without sys access to "inspector" serves without one.
 */
let sampling: Promise<Session | Error> | undefined;

/** Posts `method` to `session` and resolves with its result. */
function post<T>(
  session: Session,
  method: string,
  params?: Record<string, unknown>,
): Promise<T> {
  return new Promise((resolve, reject) =>
    session.post(
      method,
      params ?? null,
      (error: Error | null, result: T) =>
        error ? reject(error) : resolve(result),
    )
  );
}

/**
 * Starts sampling this thread's heap, once per isolate; a later call does
 * nothing. Never rejects: sampling is a diagnostic, and a thread where it
 * cannot start, as one without sys access to "inspector", goes on without it,
 * its profile request answering why.
 */
export function startHeapSampling(): Promise<void> {
  sampling ??= (async () => {
    try {
      const session = new Session();
      session.connect();
      await post(session, "HeapProfiler.enable");
      await post(session, "HeapProfiler.startSampling", {
        samplingInterval: HEAP_SAMPLING_INTERVAL_BYTES,
      });
      return session;
    } catch (error) {
      return error instanceof Error ? error : new Error(String(error));
    }
  })();
  return sampling.then(() => undefined);
}

/**
 * Writes this thread's sampling heap profile (`.heapprofile`, which Chrome
 * DevTools' Memory panel loads) into `directory`, named for the process,
 * `thread` and the time, readable by this process's user alone, and returns
 * the file's path. Sampling goes on. Throws where this thread never started
 * sampling, or it could not start, since its profile would be empty.
 */
export async function writeThreadHeapProfile(
  directory: string,
  thread: string,
): Promise<string> {
  if (sampling === undefined) {
    throw new Error(
      `heap sampling was never started on thread ${thread}, so it has no profile`,
    );
  }
  const session = await sampling;
  if (session instanceof Error) {
    throw new Error(
      `heap sampling could not start on thread ${thread}: ${session.message}`,
    );
  }
  const { profile } = await post<{ profile: unknown }>(
    session,
    "HeapProfiler.getSamplingProfile",
  );
  const time = new Date().toISOString().replaceAll(":", "-");
  const path = `${directory}/heap-${Deno.pid}-${thread}-${time}.heapprofile`;
  await Deno.writeTextFile(path, JSON.stringify(profile), { mode: 0o600 });
  return path;
}
