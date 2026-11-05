/**
 * Multi-runtime regression test: a data file attached to a pattern reaches
 * every runtime that runs it, not just the one that compiled it.
 *
 * The harness compiles the pattern in a bootstrap worker process, so the
 * attachment cannot be made where the harness runs — the paths travel with the
 * `createPiece` request and the worker attaches them on the other side. Every
 * other session then opens the piece by id, which loads the pattern from
 * storage rather than from disk, in yet another process.
 *
 * That is two boundaries, and a data file lost at either one is invisible
 * until the read: the program compiles, type-checks, and runs, and the pattern
 * is told the file is not there. Alice reads through the runtime that created
 * the piece; bob reads through a runtime that only ever saw the stored source.
 *
 * No toolshed or browser required (Deno workers + in-process storage server).
 */

import { assertEquals } from "@std/assert";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { join } from "@std/path";
import {
  MultiRuntimeHarness,
  type MultiRuntimeSession,
} from "./multi-runtime-harness.ts";

const FIXTURE_DIR = join(
  import.meta.dirname!,
  "fixtures",
  "data-file-multi-runtime",
);
const PROGRAM_PATH = join(FIXTURE_DIR, "main.tsx");
const DATA_FILE_PATH = join(FIXTURE_DIR, "data", "cities.json");
const ROOT_PATH = join(import.meta.dirname!, "..");

describe("attached data files across runtimes", () => {
  let harness: MultiRuntimeHarness;
  let alice: MultiRuntimeSession;
  let bob: MultiRuntimeSession;

  beforeAll(async () => {
    // Session order matters: the harness bootstraps the piece with alice's
    // identity (sessions[0]) and opens it in every session in order, so bob's
    // runtime reaches the pattern only through what was stored.
    harness = await MultiRuntimeHarness.create({
      programPath: PROGRAM_PATH,
      rootPath: ROOT_PATH,
      dataFilePaths: [DATA_FILE_PATH],
      sessions: ["alice", "bob"],
    });
    alice = harness.session("alice");
    bob = harness.session("bob");
  });

  afterAll(async () => {
    await harness?.dispose();
  });

  it("reads the file in the runtime that compiled the pattern", async () => {
    await harness.settle();
    assertEquals(await alice.read(["cities"]), ["Oslo", "Lima"]);
    assertEquals(await alice.read(["count"]), 2);
  });

  it("reads the file in a runtime that only loaded the stored source", async () => {
    await harness.settle();
    assertEquals(await bob.read(["cities"]), ["Oslo", "Lima"]);
    assertEquals(await bob.read(["count"]), 2);
  });
});
