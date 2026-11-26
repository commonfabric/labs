/**
 * Sampling heap profiles of a toolshed's isolates on SIGUSR2, for finding
 * which code allocated what holds its memory. Each serving worker samples its
 * heap from the start (`@commonfabric/runner/heap-profile`), and so does the
 * main thread where `HEAP_PROFILE_MAIN_THREAD` asks for it, so a signal reads
 * profiles that cover everything allocated and still alive. Reading one takes
 * little memory and does not stop a thread for long, unlike a heap snapshot.
 *
 * The main thread samples only on request because the sampler holds an
 * inspector session open on it, and Deno holds every worker started from a
 * thread with an open session for a debugger: 500 ms before the worker loads
 * its module, and 500 ms more at its first message. The main thread starts
 * the serving and compile workers, so its sampling makes each start about a
 * second slower, and a space placed on a worker still starting waits for it.
 *
 * The files go to `HEAP_PROFILE_DIR`, or `toolshed-heap-profiles` in the
 * system's temporary directory, beside a manifest naming each file and the
 * spaces placed on its worker. A profile names the code that allocated, not
 * what it holds, but the directory is created readable by this process's
 * user alone, and each file is made so. A signal that arrives while profiles
 * are being written is ignored.
 */

import {
  startHeapSampling,
  writeThreadHeapProfile,
} from "@commonfabric/runner/heap-profile";
import type { WorkerHeapProfile } from "@commonfabric/runner/executor/serving-worker-host";

/** What one round of profiles wrote, as its manifest records it. */
export type HeapProfileManifest = {
  pid: number;
  startedAt: string;
  finishedAt: string;

  /** The main thread's profile; absent where the main thread does not sample. */
  main?: string;

  /**
   * Each serving worker's profile with the spaces placed on it; absent where
   * the serving loop runs on the main thread or is off.
   */
  workers?: WorkerHeapProfile[];
};

/**
 * Writes each serving worker's profile into `directory`, which it creates if
 * need be, with the main thread's where `sampleMainThread` says it samples,
 * and a manifest beside them, each readable by this process's user alone.
 * Returns the manifest's path and contents. A main thread said to sample must
 * have started sampling.
 */
export async function writeHeapProfiles(
  directory: string,
  workerHeapProfiles: (
    directory: string,
  ) => Promise<WorkerHeapProfile[] | undefined>,
  { sampleMainThread }: { sampleMainThread: boolean },
): Promise<{ path: string; manifest: HeapProfileManifest }> {
  await Deno.mkdir(directory, { recursive: true, mode: 0o700 });
  const startedAt = new Date().toISOString();
  const [main, workers] = await Promise.all([
    sampleMainThread
      ? writeThreadHeapProfile(directory, "main")
      : Promise.resolve(undefined),
    workerHeapProfiles(directory),
  ]);
  const manifest: HeapProfileManifest = {
    pid: Deno.pid,
    startedAt,
    finishedAt: new Date().toISOString(),
    ...(main === undefined ? {} : { main }),
    ...(workers === undefined ? {} : { workers }),
  };
  const path = `${directory}/heap-${Deno.pid}-${
    startedAt.replaceAll(":", "-")
  }.json`;
  await Deno.writeTextFile(path, JSON.stringify(manifest, null, 2) + "\n", {
    mode: 0o600,
  });
  return { path, manifest };
}

/**
 * Writes heap profiles each time this process receives SIGUSR2, as the
 * module's header describes, logging where they went, and starts sampling the
 * main thread's heap where `sampleMainThread` asks for it. The signal is
 * handled from the call on; one that arrives before sampling has started
 * waits for it.
 */
export async function listenForHeapProfileSignal(options: {
  directory: string;
  sampleMainThread: boolean;
  workerHeapProfiles: (
    directory: string,
  ) => Promise<WorkerHeapProfile[] | undefined>;
  log: (...data: unknown[]) => void;
  error: (...data: unknown[]) => void;
}): Promise<void> {
  const { sampleMainThread } = options;
  const sampling = sampleMainThread ? startHeapSampling() : undefined;
  let writing = false;
  Deno.addSignalListener("SIGUSR2", () => {
    if (writing) {
      options.log("heap-profile: SIGUSR2 ignored; profiles are being written");
      return;
    }
    writing = true;
    options.log(
      `heap-profile: writing the heap profile of every sampling isolate to ${options.directory}`,
    );
    writeHeapProfiles(options.directory, options.workerHeapProfiles, {
      sampleMainThread,
    })
      .then(({ path, manifest }) => {
        const failed = (manifest.workers ?? []).filter((worker) =>
          "error" in worker.outcome
        ).length;
        options.log(
          `heap-profile: wrote ${
            manifest.main === undefined
              ? "no main-thread profile (HEAP_PROFILE_MAIN_THREAD=true " +
                "samples the main thread) and"
              : "the main thread's and"
          } ${(manifest.workers?.length ?? 0) - failed} worker profile(s)${
            failed > 0 ? `, ${failed} worker(s) failed` : ""
          }; manifest ${path}`,
        );
      })
      .catch((cause) => options.error("heap-profile: failed", cause))
      .finally(() => {
        writing = false;
      });
  });
  await sampling;
}
