/**
 * Heap snapshots of every isolate of a toolshed on SIGUSR2, for finding what
 * holds its memory: the main thread's, then each serving worker's, one after
 * another, so that only one isolate at a time holds the memory V8 writes a
 * snapshot with. Each snapshot stops its thread until it is written, and a
 * worker's watchdog does not count that time.
 *
 * The files go to `HEAP_SNAPSHOT_DIR`, or the system's temporary directory,
 * beside a manifest naming each file and the spaces placed on its worker. A
 * signal that arrives while snapshots are being written is ignored.
 */

import { writeThreadHeapSnapshot } from "@commonfabric/runner/heap-snapshot";
import type { WorkerHeapSnapshot } from "@commonfabric/runner/executor/serving-worker-host";

/** What one round of snapshots wrote, as its manifest records it. */
export type HeapSnapshotManifest = {
  pid: number;
  startedAt: string;
  finishedAt: string;

  /** The main thread's snapshot. */
  main: string;

  /**
   * Each serving worker's snapshot with the spaces placed on it; absent where
   * the serving loop runs on the main thread or is off.
   */
  workers?: WorkerHeapSnapshot[];
};

/**
 * Writes the main thread's snapshot and then each serving worker's into
 * `directory`, which it creates if need be, and a manifest beside them.
 * Returns the manifest's path and contents.
 */
export async function writeHeapSnapshots(
  directory: string,
  workerHeapSnapshots: (
    directory: string,
  ) => Promise<WorkerHeapSnapshot[] | undefined>,
): Promise<{ path: string; manifest: HeapSnapshotManifest }> {
  await Deno.mkdir(directory, { recursive: true });
  const startedAt = new Date().toISOString();
  const main = writeThreadHeapSnapshot(directory, "main");
  const workers = await workerHeapSnapshots(directory);
  const manifest: HeapSnapshotManifest = {
    pid: Deno.pid,
    startedAt,
    finishedAt: new Date().toISOString(),
    main,
    ...(workers === undefined ? {} : { workers }),
  };
  const path = `${directory}/heap-${Deno.pid}-${
    startedAt.replaceAll(":", "-")
  }.json`;
  await Deno.writeTextFile(path, JSON.stringify(manifest, null, 2) + "\n");
  return { path, manifest };
}

/**
 * Writes heap snapshots each time this process receives SIGUSR2, as the
 * module's header describes, logging where they went.
 */
export function listenForHeapSnapshotSignal(options: {
  directory: string;
  workerHeapSnapshots: (
    directory: string,
  ) => Promise<WorkerHeapSnapshot[] | undefined>;
  log: (...data: unknown[]) => void;
  error: (...data: unknown[]) => void;
}): void {
  let writing = false;
  Deno.addSignalListener("SIGUSR2", () => {
    if (writing) {
      options.log(
        "heap-snapshot: SIGUSR2 ignored; snapshots are being written",
      );
      return;
    }
    writing = true;
    options.log(
      `heap-snapshot: writing every isolate's to ${options.directory}`,
    );
    writeHeapSnapshots(options.directory, options.workerHeapSnapshots)
      .then(({ path, manifest }) => {
        const failed = (manifest.workers ?? []).filter((worker) =>
          "error" in worker.outcome
        ).length;
        options.log(
          `heap-snapshot: wrote the main thread's and ${
            (manifest.workers?.length ?? 0) - failed
          } worker snapshot(s)${
            failed > 0 ? `, ${failed} worker(s) failed` : ""
          }; manifest ${path}`,
        );
      })
      .catch((cause) => options.error("heap-snapshot: failed", cause))
      .finally(() => {
        writing = false;
      });
  });
}
