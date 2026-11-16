/**
 * Sampling heap profiles of every isolate of a toolshed on SIGUSR2, for
 * finding which code allocated what holds its memory. Each isolate samples
 * its heap from the start (`@commonfabric/runner/heap-profile`), so a signal
 * reads profiles that cover everything allocated and still alive: the main
 * thread's, and each serving worker's. Reading one takes little memory and
 * does not stop a thread for long, unlike a heap snapshot.
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

  /** The main thread's profile. */
  main: string;

  /**
   * Each serving worker's profile with the spaces placed on it; absent where
   * the serving loop runs on the main thread or is off.
   */
  workers?: WorkerHeapProfile[];
};

/**
 * Writes the main thread's profile and each serving worker's into
 * `directory`, which it creates if need be, and a manifest beside them, each
 * readable by this process's user alone. Returns the manifest's path and
 * contents. The main thread must have started sampling.
 */
export async function writeHeapProfiles(
  directory: string,
  workerHeapProfiles: (
    directory: string,
  ) => Promise<WorkerHeapProfile[] | undefined>,
): Promise<{ path: string; manifest: HeapProfileManifest }> {
  await Deno.mkdir(directory, { recursive: true, mode: 0o700 });
  const startedAt = new Date().toISOString();
  const [main, workers] = await Promise.all([
    writeThreadHeapProfile(directory, "main"),
    workerHeapProfiles(directory),
  ]);
  const manifest: HeapProfileManifest = {
    pid: Deno.pid,
    startedAt,
    finishedAt: new Date().toISOString(),
    main,
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
 * Starts sampling the main thread's heap and writes heap profiles each time
 * this process receives SIGUSR2, as the module's header describes, logging
 * where they went. The signal is handled from the call on; one that arrives
 * before sampling has started waits for it.
 */
export async function listenForHeapProfileSignal(options: {
  directory: string;
  workerHeapProfiles: (
    directory: string,
  ) => Promise<WorkerHeapProfile[] | undefined>;
  log: (...data: unknown[]) => void;
  error: (...data: unknown[]) => void;
}): Promise<void> {
  const sampling = startHeapSampling();
  let writing = false;
  Deno.addSignalListener("SIGUSR2", () => {
    if (writing) {
      options.log("heap-profile: SIGUSR2 ignored; profiles are being written");
      return;
    }
    writing = true;
    options.log(
      `heap-profile: writing the heap profile of every isolate to ${options.directory}`,
    );
    writeHeapProfiles(options.directory, options.workerHeapProfiles)
      .then(({ path, manifest }) => {
        const failed = (manifest.workers ?? []).filter((worker) =>
          "error" in worker.outcome
        ).length;
        options.log(
          `heap-profile: wrote the main thread's and ${
            (manifest.workers?.length ?? 0) - failed
          } worker profile(s)${
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
