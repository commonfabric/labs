/**
 * A round of heap profiles: the main thread's file where it samples, then
 * what the serving workers wrote, and a manifest beside them naming each file
 * and its spaces; and the signal handler that writes a round and logs it.
 */

import { assert, assertEquals, assertMatch } from "@std/assert";
import { startHeapSampling } from "@commonfabric/runner/heap-profile";
import type { WorkerHeapProfile } from "@commonfabric/runner/executor/serving-worker-host";
import { test } from "@commonfabric/test-support/test";
import {
  createHeapProfileSignal,
  type HeapProfileManifest,
  writeHeapProfiles,
} from "./heap-profiles.ts";

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

/** What a signal handler logged and reported as errors. */
function recorder() {
  const logged: string[] = [];
  const errors: unknown[][] = [];
  return {
    logged,
    errors,
    log: (...data: unknown[]) => logged.push(data.join(" ")),
    error: (...data: unknown[]) => errors.push(data),
  };
}

/** The manifest path the last line of `logged` names. */
async function loggedManifest(
  logged: string[],
): Promise<HeapProfileManifest> {
  const path = logged.at(-1)?.match(/; manifest (.*)$/)?.[1];
  assert(path !== undefined, logged.at(-1));
  return JSON.parse(await Deno.readTextFile(path));
}

test("a signal writes a round and logs the main thread's profile and how many workers wrote theirs", async () => {
  const directory = await Deno.makeTempDir({ prefix: "heap-profiles-" });
  try {
    const record = recorder();
    const signal = createHeapProfileSignal({
      directory,
      sampleMainThread: true,
      workerHeapProfiles: () =>
        Promise.resolve([
          { outcome: { path: `${directory}/heap-worker-1` }, spaces: ["a"] },
          { outcome: { path: `${directory}/heap-worker-2` }, spaces: [] },
        ]),
      log: record.log,
      error: record.error,
    });
    await signal.sampling;
    await signal.handle();
    assertEquals(record.errors, []);
    assertEquals(record.logged.length, 2);
    assertEquals(
      record.logged[0],
      `heap-profile: writing the heap profile of every sampling isolate to ${directory}`,
    );
    assertMatch(
      record.logged[1],
      /^heap-profile: wrote the main thread's and 2 worker profile\(s\); manifest /,
    );
    const manifest = await loggedManifest(record.logged);
    assert(manifest.main !== undefined);
    assertEquals(manifest.workers?.length, 2);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

test("a signal's log says where the main thread does not sample and counts the workers that failed apart", async () => {
  const directory = await Deno.makeTempDir({ prefix: "heap-profiles-" });
  try {
    const record = recorder();
    const signal = createHeapProfileSignal({
      directory,
      sampleMainThread: false,
      workerHeapProfiles: () =>
        Promise.resolve([
          { outcome: { path: `${directory}/heap-worker-1` }, spaces: ["a"] },
          { outcome: { error: "the worker closed" }, spaces: [] },
          { outcome: { error: "the worker closed" }, spaces: ["b"] },
        ]),
      log: record.log,
      error: record.error,
    });
    await signal.sampling;
    await signal.handle();
    assertEquals(record.errors, []);
    assertMatch(
      record.logged[1],
      /^heap-profile: wrote no main-thread profile \(HEAP_PROFILE_MAIN_THREAD=true samples the main thread\) and 1 worker profile\(s\), 2 worker\(s\) failed; manifest /,
    );
    const manifest = await loggedManifest(record.logged);
    assertEquals("main" in manifest, false);
    assertEquals(manifest.workers?.length, 3);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

test("a signal's log counts no workers where the serving loop has none", async () => {
  const directory = await Deno.makeTempDir({ prefix: "heap-profiles-" });
  try {
    const record = recorder();
    const signal = createHeapProfileSignal({
      directory,
      sampleMainThread: false,
      workerHeapProfiles: () => Promise.resolve(undefined),
      log: record.log,
      error: record.error,
    });
    await signal.handle();
    assertEquals(record.errors, []);
    assertMatch(
      record.logged[1],
      / and 0 worker profile\(s\); manifest /,
    );
    assertEquals("workers" in await loggedManifest(record.logged), false);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

test("a signal while a round is being written is ignored, and one after it writes another round", async () => {
  const directory = await Deno.makeTempDir({ prefix: "heap-profiles-" });
  try {
    const record = recorder();
    const asked = Promise.withResolvers<void>();
    const answer = Promise.withResolvers<WorkerHeapProfile[]>();
    let rounds = 0;
    const signal = createHeapProfileSignal({
      directory,
      sampleMainThread: false,
      workerHeapProfiles: () => {
        rounds++;
        asked.resolve();
        return rounds === 1 ? answer.promise : Promise.resolve([]);
      },
      log: record.log,
      error: record.error,
    });
    const first = signal.handle();
    await asked.promise;
    await signal.handle();
    assertEquals(rounds, 1);
    assertEquals(
      record.logged.at(-1),
      "heap-profile: SIGUSR2 ignored; profiles are being written",
    );
    answer.resolve([]);
    await first;
    assertMatch(record.logged.at(-1) ?? "", /^heap-profile: wrote /);
    await signal.handle();
    assertEquals(rounds, 2);
    assertEquals(
      record.logged.filter((line) => line.startsWith("heap-profile: wrote "))
        .length,
      2,
    );
    assertEquals(record.errors, []);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

test("a round that fails is reported as an error, and a later signal writes another round", async () => {
  const directory = await Deno.makeTempDir({ prefix: "heap-profiles-" });
  try {
    const record = recorder();
    const cause = new Error("the pool is gone");
    let rounds = 0;
    const signal = createHeapProfileSignal({
      directory,
      sampleMainThread: false,
      workerHeapProfiles: () =>
        ++rounds === 1 ? Promise.reject(cause) : Promise.resolve([]),
      log: record.log,
      error: record.error,
    });
    await signal.handle();
    assertEquals(record.errors, [["heap-profile: failed", cause]]);
    assertEquals(
      record.logged.some((line) => line.startsWith("heap-profile: wrote ")),
      false,
    );
    await signal.handle();
    assertEquals(rounds, 2);
    assertEquals(record.errors.length, 1);
    assertMatch(record.logged.at(-1) ?? "", /^heap-profile: wrote /);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});
