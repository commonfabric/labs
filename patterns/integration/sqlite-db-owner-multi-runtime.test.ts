/**
 * Multi-runtime regression test: the sqlite db handle's `owner` is minted
 * once — by the runtime that created the handle — and must survive other
 * runtimes opening the same piece.
 *
 * The sqliteDatabase builtin re-runs its initialization in EVERY runtime that
 * opens the piece (the action's `initialized` guard is per-runtime-instance).
 * Before the fix it unconditionally rewrote the shared handle with the
 * CURRENT runtime's acting principal as `owner`, so the last opener silently
 * became the db owner. Security-relevant: `dbOwner()` row-rule terms
 * (runtime/memory/v2/sqlite/row-label.ts) and `{__ctDbOwner: true}` ceiling
 * placeholders (runtime/runner/src/builtins/sqlite/row-label-read.ts)
 * resolve against this field, so a rotated owner changes who may read rows.
 *
 * The piece (and thus the handle) is created by the harness's bootstrap
 * runtime acting as alice (sessions[0]); bob's runtime opens it afterwards.
 * The committed handle must keep alice as owner in BOTH runtimes' view.
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

const PROGRAM_PATH = join(
  import.meta.dirname!,
  "fixtures",
  "sqlite-db-owner",
  "main.tsx",
);
const ROOT_PATH = join(import.meta.dirname!, "..");

describe("sqlite db handle owner across runtimes", () => {
  let harness: MultiRuntimeHarness;
  let alice: MultiRuntimeSession;
  let bob: MultiRuntimeSession;

  beforeAll(async () => {
    // Session order matters: the harness bootstraps the piece with alice's
    // identity (sessions[0]) and then opens it in every session IN ORDER, so
    // bob's runtime is the LAST to re-run the sqliteDatabase builtin.
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

  it("keeps the creator as owner after a second user opens the piece", async () => {
    const aliceDid = alice.identity.did();

    // Both runtimes have opened the piece (bob last); let their re-init
    // writes and sync traffic drain before reading the committed handle.
    await harness.settle();

    // `owner` is not part of the declared result schema — read raw.
    const fromBob = await bob.readRaw(["db"]) as { owner?: string };
    const fromAlice = await alice.readRaw(["db"]) as { owner?: string };
    assertEquals(
      fromBob.owner,
      aliceDid,
      "bob's runtime must not re-mint itself as the db owner",
    );
    assertEquals(
      fromAlice.owner,
      aliceDid,
      "alice's view of the handle must keep her as owner",
    );
  });
});
