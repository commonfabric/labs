/**
 * A round of heap snapshots: the main thread's file, then what the serving
 * workers wrote, and a manifest beside them naming each file and its spaces.
 */

import { assert, assertEquals } from "@std/assert";
import type { WorkerHeapSnapshot } from "@commonfabric/runner/executor/serving-worker-host";
import { writeHeapSnapshots } from "./heap-snapshots.ts";

/** The permission bits of `path`. */
async function modeOf(path: string): Promise<number | null> {
  const { mode } = await Deno.stat(path);
  return mode === null ? null : mode & 0o777;
}

Deno.test("writes the main thread's snapshot and a manifest naming it and each worker's, in a directory it creates, each readable by its user alone", async () => {
  const root = await Deno.makeTempDir({ prefix: "heap-snapshots-" });
  try {
    const directory = `${root}/snapshots`;
    const asked: string[] = [];
    const workerFile = `${directory}/heap-worker-1`;
    const workers: WorkerHeapSnapshot[] = [
      { outcome: { path: workerFile }, spaces: ["did:a"] },
      { outcome: { error: "the worker closed" }, spaces: [] },
    ];
    const { path, manifest } = await writeHeapSnapshots(
      directory,
      async (where) => {
        asked.push(where);
        // As a worker's thread writes it, under the process's umask.
        await Deno.writeTextFile(workerFile, "{}", { mode: 0o644 });
        await Deno.chmod(workerFile, 0o644);
        return workers;
      },
    );
    assertEquals(asked, [directory]);
    assert(manifest.main.startsWith(`${directory}/heap-${Deno.pid}-main-`));
    const head = (await Deno.readTextFile(manifest.main)).slice(0, 12);
    assertEquals(head, '{"snapshot":');
    assertEquals(manifest.workers, workers);
    assertEquals(JSON.parse(await Deno.readTextFile(path)), manifest);
    assertEquals(await modeOf(directory), 0o700);
    for (const file of [manifest.main, workerFile, path]) {
      assertEquals(await modeOf(file), 0o600, file);
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("leaves the workers out of the manifest where the serving loop has none", async () => {
  const directory = await Deno.makeTempDir({ prefix: "heap-snapshots-" });
  try {
    const { manifest } = await writeHeapSnapshots(
      directory,
      () => Promise.resolve(undefined),
    );
    assertEquals("workers" in manifest, false);
    assert((await Deno.stat(manifest.main)).size > 0);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});
