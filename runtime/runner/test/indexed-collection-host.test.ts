/**
 * Runs a pattern that declares an indexed collection in a client with server
 * execution off that maintains no collection, beside an
 * `IndexedCollectionHost` on the same memory server
 * (`indexed-collection-host-fixture.ts`): every row a re-read writes is
 * written by the host's runtime, and reaches the client's queries through the
 * database.
 */

import { expect } from "@std/expect";
import { fromFileUrl } from "@std/path";

import { describe, it } from "@commonfabric/test-support/test";

import { indexedCollectionHostFixture } from "./indexed-collection-host-fixture.ts";

/**
 * Runs `indexed-collection-host-release-helper.ts` for `scenario` in a
 * subprocess and returns its report. The helper needs `--expose-gc` and the
 * real clock, which this package's test task does not give it.
 */
async function runReleaseHelper(
  scenario: string,
): Promise<Record<string, unknown>> {
  const helper = new URL(
    "./indexed-collection-host-release-helper.ts",
    import.meta.url,
  );
  // Spawned by name so the launch matches the task's `--allow-run=deno`
  // grant, which resolves the name through PATH the same way.
  const output = await new Deno.Command("deno", {
    args: [
      "run",
      "-A",
      "--v8-flags=--expose-gc",
      fromFileUrl(helper),
      scenario,
    ],
    stdout: "piped",
    stderr: "piped",
  }).output();
  const stdout = new TextDecoder().decode(output.stdout);
  const stderr = new TextDecoder().decode(output.stderr);
  expect(output.success, `helper failed:\n${stderr}\n${stdout}`).toBe(true);
  // Loggers may write above the report; the report is the last line.
  const lines = stdout.trim().split("\n");
  return JSON.parse(lines[lines.length - 1]);
}

describe("indexed-collection-host", () => {
  it("fills the rows of members a client's handler creates and adds", async () => {
    // A member the handler creates is stored with its columns unset, and the
    // client maintains nothing, so a title in the listing was written by the
    // host's re-read.
    const f = await indexedCollectionHostFixture();
    try {
      const { result, titles } = await f.run();
      result.key("add").send({ title: "first" });
      result.key("add").send({ title: "second" });

      await titles(["first", "second"]);
      expect(f.host.runtime).toBeDefined();
      expect(f.errors).toEqual([]);
    } finally {
      await f.close();
    }
  });

  it("re-reads a member whose mirrored field a client writes later", async () => {
    const f = await indexedCollectionHostFixture();
    try {
      const { result, titles } = await f.run();
      result.key("add").send({ title: "first" });
      await titles(["first"]);
      result.key("rename").send({ from: "first", to: "renamed" });

      await titles(["renamed"]);
      expect(f.errors).toEqual([]);
    } finally {
      await f.close();
    }
  });

  it("re-reads a member written after a restart, in a space whose registry predates the host", async () => {
    // The new host hears of no write to the registry, so it learns that the
    // space lists a collection by reading the registry document.
    const f = await indexedCollectionHostFixture();
    try {
      const { result, titles } = await f.run();
      result.key("add").send({ title: "first" });
      await titles(["first"]);
      await f.restartHost();
      result.key("rename").send({ from: "first", to: "renamed" });

      await titles(["renamed"]);
      expect(f.host.runtime).toBeDefined();
      expect(f.errors).toEqual([]);
    } finally {
      await f.close();
    }
  });

  it("re-reads a member written while a registry read failed, once a later read succeeds", async () => {
    // The restarted host has to read the registry to learn of the
    // collection, and the read for the rename's commit fails. Only the ids
    // that read held can bring the member to the next read.
    const f = await indexedCollectionHostFixture();
    try {
      const { result, titles } = await f.run();
      result.key("add").send({ title: "first" });
      await titles(["first"]);
      await f.restartHost();
      f.failNextRegistryRead();
      result.key("rename").send({ from: "first", to: "renamed" });
      await f.runtime.idle();
      await f.runtime.storageManager.synced();
      await Promise.all(f.host.accessForTestingOnly.reads);
      // A write the member was not read from has the host read again.
      const plain = f.runtime.getCell<{ count: number }>(f.space, "plain");
      await plain.sync();
      const tx = f.runtime.edit();
      plain.withTx(tx).set({ count: 1 });
      expect((await tx.commit().settled).error).toBeUndefined();

      await titles(["renamed"]);
      expect(f.errors).toEqual([]);
    } finally {
      await f.close();
    }
  });

  it("fills the rows of a collection listed after the host read the space's registry", async () => {
    // The first board's collection has the host read the registry, which
    // lists only that one; a later commit lists the second board's.
    const f = await indexedCollectionHostFixture();
    try {
      const first = await f.run("first-board");
      first.result.key("add").send({ title: "first" });
      await first.titles(["first"]);
      const second = await f.run("second-board");
      second.result.key("add").send({ title: "other" });

      await second.titles(["other"]);
      expect(f.errors).toEqual([]);
    } finally {
      await f.close();
    }
  });

  it("fills a column that a declaration changed in place gains", async () => {
    // The host adopts the collection under its first declaration and goes
    // quiet, so the member is re-read only if the host checks the
    // declaration it holds: no write to the member follows.
    const f = await indexedCollectionHostFixture();
    try {
      const db = await f.declare({ columns: { title: "text" } });
      await f.addTopic("a");
      await f.stored(
        db,
        "SELECT value FROM collection_meta WHERE key = 'declaration'",
        (rows) => rows.length === 1,
      );
      await f.host.runtime!.settled();
      const redeclared = await f.declare({
        columns: { title: "text", again: { type: "text", path: ["title"] } },
      });

      expect(
        await f.stored(
          redeclared,
          "SELECT again FROM topics",
          (rows) => rows[0]?.again === "a",
        ),
      ).toEqual([{ again: "a" }]);
    } finally {
      await f.close();
    }
  });

  it("stops watching the members a drain re-read once the cells it read them through are collected", async () => {
    // The host's runtime runs no piece, so only a release pass it asks for
    // itself lets go of what it read. The helper adds three topics while a
    // cell of the host's runtime holds the first, collects the host's other
    // cells, and adds a fourth. The held topic stays watched, which is what
    // shows that the count sees a member's watch at all.

    expect(await runReleaseHelper("earlier-members")).toEqual({
      heldWatched: true,
      releasedWatched: 0,
    });
  });

  it("keeps a member's document loaded from its re-read to its projection through a release pass", async () => {
    // The helper holds the drain after it has synced the retitled topic and
    // before it queues the transaction that projects it, and collects the
    // host's cells and runs a release pass in that window. A document
    // dropped there reads as absent in the transaction, and the member
    // projects to empty rows.

    expect(await runReleaseHelper("release-before-projection")).toEqual({
      loadedThroughPass: true,
      titles: ["renamed"],
    });
  });

  it("builds no runtime for commits to a space that lists no collection", async () => {
    const f = await indexedCollectionHostFixture();
    try {
      const cell = f.runtime.getCell<{ count: number }>(f.space, "plain");
      await cell.sync();
      const tx = f.runtime.edit();
      cell.withTx(tx).set({ count: 1 });
      expect((await tx.commit().settled).error).toBeUndefined();
      await Promise.all(f.host.accessForTestingOnly.reads);

      expect(f.host.runtime).toBeUndefined();
    } finally {
      await f.close();
    }
  });
});
