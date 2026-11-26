/**
 * A round of heap profiles: the main thread's file where it samples, then
 * what the serving workers wrote, and a manifest beside them naming each file
 * and its spaces.
 */

import { assert, assertEquals } from "@std/assert";
import { startHeapSampling } from "@commonfabric/runner/heap-profile";
import type { WorkerHeapProfile } from "@commonfabric/runner/executor/serving-worker-host";
import { test } from "@commonfabric/test-support/test";
import { writeHeapProfiles } from "./heap-profiles.ts";

/** The permission bits of `path`. */
async function modeOf(path: string): Promise<number | null> {
  const { mode } = await Deno.stat(path);
  return mode === null ? null : mode & 0o777;
}

test("writes the main thread's profile and a manifest naming it and each worker's, in a directory it creates, each readable by its user alone", async () => {
  await startHeapSampling();
  const root = await Deno.makeTempDir({ prefix: "heap-profiles-" });
  try {
    const directory = `${root}/profiles`;
    const asked: string[] = [];
    const workers: WorkerHeapProfile[] = [
      { outcome: { path: `${directory}/heap-worker-1` }, spaces: ["did:a"] },
      { outcome: { error: "the worker closed" }, spaces: [] },
    ];
    const { path, manifest } = await writeHeapProfiles(
      directory,
      (where) => {
        asked.push(where);
        return Promise.resolve(workers);
      },
      { sampleMainThread: true },
    );
    assertEquals(asked, [directory]);
    const main = manifest.main;
    assert(main !== undefined);
    assert(main.startsWith(`${directory}/heap-${Deno.pid}-main-`));
    const profile = JSON.parse(await Deno.readTextFile(main));
    assert(Array.isArray(profile.samples));
    assertEquals(manifest.workers, workers);
    assertEquals(JSON.parse(await Deno.readTextFile(path)), manifest);
    assertEquals(await modeOf(directory), 0o700);
    for (const file of [main, path]) {
      assertEquals(await modeOf(file), 0o600, file);
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

test("leaves the workers out of the manifest where the serving loop has none", async () => {
  await startHeapSampling();
  const directory = await Deno.makeTempDir({ prefix: "heap-profiles-" });
  try {
    const { manifest } = await writeHeapProfiles(
      directory,
      () => Promise.resolve(undefined),
      { sampleMainThread: true },
    );
    assertEquals("workers" in manifest, false);
    assert(manifest.main !== undefined);
    assert((await Deno.stat(manifest.main)).size > 0);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

test("leaves the main thread's profile out where the main thread does not sample, and writes the workers'", async () => {
  const directory = await Deno.makeTempDir({ prefix: "heap-profiles-" });
  try {
    const workers: WorkerHeapProfile[] = [
      { outcome: { path: `${directory}/heap-worker-1` }, spaces: ["did:a"] },
    ];
    const { path, manifest } = await writeHeapProfiles(
      directory,
      () => Promise.resolve(workers),
      { sampleMainThread: false },
    );
    assertEquals("main" in manifest, false);
    assertEquals(manifest.workers, workers);
    assertEquals(JSON.parse(await Deno.readTextFile(path)), manifest);
    const written = [];
    for await (const entry of Deno.readDir(directory)) {
      written.push(entry.name);
    }
    assertEquals(written, [path.slice(directory.length + 1)]);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});
