/**
 * A round of heap snapshots: the main thread's file, then what the serving
 * workers wrote, and a manifest beside them naming each file and its spaces.
 */

import { assert, assertEquals } from "@std/assert";
import type { WorkerHeapSnapshot } from "@commonfabric/runner/executor/serving-worker-host";
import { writeHeapSnapshots } from "./heap-snapshots.ts";

Deno.test("writes the main thread's snapshot and a manifest naming it and each worker's, in a directory it creates", async () => {
  const root = await Deno.makeTempDir({ prefix: "heap-snapshots-" });
  try {
    const directory = `${root}/snapshots`;
    const asked: string[] = [];
    const workers: WorkerHeapSnapshot[] = [
      { outcome: { path: `${directory}/heap-worker-1` }, spaces: ["did:a"] },
      { outcome: { error: "the worker closed" }, spaces: [] },
    ];
    const { path, manifest } = await writeHeapSnapshots(
      directory,
      (where) => {
        asked.push(where);
        return Promise.resolve(workers);
      },
    );
    assertEquals(asked, [directory]);
    assert(manifest.main.startsWith(`${directory}/heap-${Deno.pid}-main-`));
    const head = (await Deno.readTextFile(manifest.main)).slice(0, 12);
    assertEquals(head, '{"snapshot":');
    assertEquals(manifest.workers, workers);
    assertEquals(JSON.parse(await Deno.readTextFile(path)), manifest);
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
