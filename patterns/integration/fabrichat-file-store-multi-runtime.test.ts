/**
 * A FabriChat room's file store, created by the room's `ensureFileStore`
 * handler and reached only through the link the room's record holds: a
 * session that reads the store's entries through the room gets them, and so
 * does a session that opens the room after the store exists. With server
 * execution on, the store's entries are a value only the serving loop
 * computes, and it computes them only for a piece it has started, so this is
 * the case of a piece reached only through a data link
 * (`docs/specs/server-side-execution/verification-coverage.md`, flag 4).
 */

import { expect } from "@std/expect";
import { join } from "@std/path";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";

import {
  MultiRuntimeHarness,
  type MultiRuntimeSession,
} from "./multi-runtime-harness.ts";

const PROGRAM_PATH = join(
  import.meta.dirname!,
  "fixtures",
  "fabrichat-file-store",
  "main.tsx",
);
const ROOT_PATH = join(import.meta.dirname!, "..");

describe("fabrichat file store across runtimes", () => {
  let harness: MultiRuntimeHarness;
  let ada: MultiRuntimeSession;

  beforeAll(async () => {
    harness = await MultiRuntimeHarness.create({
      programPath: PROGRAM_PATH,
      rootPath: ROOT_PATH,
      sessions: ["fabrichat-file-store-ada"],
    });
    [ada] = harness.sessions;
  });

  afterAll(async () => {
    await harness?.dispose();
  });

  it("lists the entries of a store the room reaches only through a link", async () => {
    await ada.send("ensureFileStore", {});
    await harness.settleUntil(async () =>
      (await ada.read(["fileStore", "entries"])) !== undefined
    );
    expect(await ada.read(["fileStore", "entries"])).toEqual([]);

    // A session opening the room after the store exists reads it as well.
    const later = await harness.addSession("fabrichat-file-store-ada-later");
    await harness.settleUntil(async () =>
      (await later.read(["fileStore", "entries"])) !== undefined
    );
    expect(await later.read(["fileStore", "entries"])).toEqual([]);
  });
});
