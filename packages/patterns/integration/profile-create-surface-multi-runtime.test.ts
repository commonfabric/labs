/**
 * Multi-runtime regression test: a `#profile` wish in a space with no profile
 * opens the real profile-create surface.
 *
 * The surface is a system pattern the runtime fetches from the host serving
 * the space, under `system:system/profile-create.tsx`. A harness that hosts
 * storage in-process and leaves that route unanswered has no way to open it,
 * so a pattern whose identity is a profile cell could only ever be driven
 * through the seams its own tests supply. Serving the patterns tree beside the
 * storage server is what closes that gap, and this is the test that says so:
 * it walks from the wish's `[UI]` node into the surface's own piece and reads
 * the name that only the compiled system pattern produces.
 *
 * No toolshed or browser required (Deno workers + in-process storage server).
 */

import { expect } from "@std/expect";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { join } from "@std/path";
import {
  MultiRuntimeHarness,
  type MultiRuntimeSession,
} from "./multi-runtime-harness.ts";

const PROGRAM_PATH = join(
  import.meta.dirname!,
  "fixtures",
  "profile-create-surface.tsx",
);
const ROOT_PATH = join(import.meta.dirname!, "..");

// The wish renders `<cf-render $cell={…}>`, whose `$cell` prop is the piece
// the surface runs in. Reading through it reaches that piece's own output.
const SURFACE_PIECE = ["profile", "$UI", "props", "$cell"];

describe("profile-create surface across runtimes", () => {
  let harness: MultiRuntimeHarness;
  let alice: MultiRuntimeSession;
  let bob: MultiRuntimeSession;

  beforeAll(async () => {
    harness = await MultiRuntimeHarness.create({
      programPath: PROGRAM_PATH,
      rootPath: ROOT_PATH,
      sessions: ["alice", "bob"],
    });
    alice = harness.session("alice");
    bob = harness.session("bob");
  });

  afterAll(async () => {
    await harness?.dispose();
  });

  it("runs the compiled system pattern for the session that opened it", async () => {
    await harness.settleUntil(async () =>
      await alice.readRaw([...SURFACE_PIECE, "$NAME"]) !== undefined
    );
    expect(await alice.readRaw([...SURFACE_PIECE, "$NAME"])).toBe(
      "Create Profile",
    );
  });

  it("runs it for a session that only ever saw the stored piece", async () => {
    await harness.settleUntil(async () =>
      await bob.readRaw([...SURFACE_PIECE, "$NAME"]) !== undefined
    );
    expect(await bob.readRaw([...SURFACE_PIECE, "$NAME"])).toBe(
      "Create Profile",
    );
  });
});
