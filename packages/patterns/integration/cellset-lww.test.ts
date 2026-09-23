/**
 * Regression test: a UI `set` is a blind last-write-wins leaf write; a `push` is
 * read-modify-write and keeps compare-and-set. The blind-vs-CAS choice is made by
 * METHOD (the request type the client sends), not by the value's shape.
 *
 * `handleCellSet` marks its transaction as a blind-leaf-write, so the set's reads
 * carry no value-equality precondition (only a structural existence read at the
 * entity root survives, to catch a concurrent whole-doc delete/replace). Under
 * concurrent same-user edits a `set` therefore no longer hits the
 * "stale confirmed read" conflict that rolled the write back and silently dropped
 * a profile/draft edit — the cfc-group-chat-demo "Name not set" flake. A `push`
 * routes through `handleCellPush`, which is NOT blind, so concurrent list
 * mutations still cannot lose updates. (Supersedes the #4126 cellset-silent-
 * rollback queue work.)
 *
 * profileDraft is PerUser, so two sessions of the same identity share the doc
 * (≈ two browser tabs of one user): the own-write race.
 *
 * No toolshed or browser required (Deno workers + in-process storage server).
 */

import { assert, assertEquals } from "@std/assert";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { join } from "@std/path";
import { debugStr } from "@commonfabric/data-model";
import { Identity } from "@commonfabric/identity";
import {
  MultiRuntimeHarness,
  type MultiRuntimeSession,
} from "./multi-runtime-harness.ts";

const PROGRAM_PATH = join(
  import.meta.dirname!,
  "fixtures",
  "drafted-chat",
  "main.tsx",
);
const ROOT_PATH = join(import.meta.dirname!, "..");
const DRAFT: (string | number)[] = ["profileDraft"];

const isConflict = (error?: { name?: string; message?: string }): boolean =>
  error?.name === "ConflictError" ||
  (error?.message?.includes("stale confirmed read") ?? false);

describe("cellset last-write-wins for scalar $value (own-write race)", () => {
  let harness: MultiRuntimeHarness;
  let alice: MultiRuntimeSession;
  let aliceTab2: MultiRuntimeSession;

  beforeAll(async () => {
    const aliceId = await Identity.fromPassphrase("cellset-lww alice", {
      implementation: "noble",
    });
    harness = await MultiRuntimeHarness.create({
      programPath: PROGRAM_PATH,
      rootPath: ROOT_PATH,
      sessions: [
        { label: "alice", identity: aliceId },
        // Same user as alice, separate session ≈ second browser tab.
        { label: "alice-tab2", identity: aliceId },
      ],
    });
    alice = harness.session("alice");
    aliceTab2 = harness.session("alice-tab2");
  });

  afterAll(async () => {
    await harness?.dispose();
  });

  it("concurrent same-user scalar sets never conflict", async () => {
    for (let i = 0; i < 8; i++) {
      await harness.settle(); // converge both sessions to one baseline seq
      const [a, b] = await Promise.all([
        alice.set([...DRAFT], `alice-${i}`, { idle: false }),
        aliceTab2.set([...DRAFT], `tab2-${i}`, { idle: false }),
      ]);
      assert(
        a.ok,
        `alice scalar set ${i} should not conflict: ` +
          debugStr`$quote,long${a.error}`,
      );
      assert(
        b.ok,
        `tab2 scalar set ${i} should not conflict: ` +
          debugStr`$quote,long${b.error}`,
      );
    }
  });

  it("a structured (array) set is blind too — trigger is the method, not the value type", async () => {
    // Pre-redesign this compare-and-set: a value-type heuristic kept array/object
    // values on the CAS path. With the method-based trigger, ANY `set` is blind,
    // so concurrent same-user array-value sets no longer conflict either — only
    // `push` keeps compare-and-set (next test).
    for (let i = 0; i < 8; i++) {
      await harness.settle();
      const [a, b] = await Promise.all([
        alice.set([...DRAFT], [`alice-${i}`], { idle: false }),
        aliceTab2.set([...DRAFT], [`tab2-${i}`], { idle: false }),
      ]);
      assert(
        a.ok,
        `alice array set ${i} should be a blind write (no conflict): ` +
          debugStr`$quote,long${a.error}`,
      );
      assert(
        b.ok,
        `tab2 array set ${i} should be a blind write (no conflict): ` +
          debugStr`$quote,long${b.error}`,
      );
    }
  });

  it("concurrent pushes retain compare-and-set (push keeps its read precondition)", async () => {
    // A `push` is read-modify-write: it routes through CellPush/handleCellPush,
    // which is NOT blind, so the read of the current array stays a commit
    // precondition. Concurrent same-user pushes against the shared draft therefore
    // still conflict (compare-and-set), guarding against lost updates — the safety
    // the old value-type narrowing approximated, now keyed on the method.
    await alice.set([...DRAFT], [], {}); // array baseline (itself a blind set)
    let conflicts = 0;
    for (let i = 0; i < 8; i++) {
      await harness.settle();
      const [a, b] = await Promise.all([
        alice.push([...DRAFT], `alice-${i}`, { idle: false }),
        aliceTab2.push([...DRAFT], `tab2-${i}`, { idle: false }),
      ]);
      if (isConflict(a.error) || isConflict(b.error)) conflicts++;
    }
    assert(
      conflicts > 0,
      "concurrent pushes must still hit compare-and-set conflicts " +
        "(push must keep its read precondition, unlike a blind set)",
    );
  });

  it(
    "end-to-end: a typed name survives the own-write race through save",
    async () => {
      // The "Name not set" flake, end to end: a user
      // types a profile name (a scalar `$value` write to the PerUser draft), then
      // saves. The fixture's save handler reads the draft.
      // Pre-fix, the draft `$value` write loses the own-write race, is rejected and
      // rolled back to its prior (empty) value, so the save reads the wrong/empty
      // draft and the profile name is not the one the user typed. With the fix the
      // scalar write is precondition-free, lands, and the save reads it.
      //
      // Under the server-execution ON arm this step additionally pins the
      // OW47 client own-write durability seam (the step was ON-skipped at
      // the first ON CI gate, 2026-08-21, and lifted with the fix): the
      // typed name's blind write races the PREVIOUS iteration's saveProfile
      // handler ECHO — the save handler writes the trimmed name back into
      // the draft cell, so its speculative echo stands on the same doc
      // until the arrival gate retires it — and pre-fix the blind write's
      // structural parent read named that process-local layer, so the
      // whole write was refused terminally (`speculative-basis-refused`)
      // and the user's input was silently dropped (storage/v2.ts
      // buildReads; speculation-overlay.test.ts carries the unit pin).
      for (let i = 0; i < 5; i++) {
        await harness.settle();
        // Another concurrent write bumps the shared PerUser draft's seq…
        await aliceTab2.set([...DRAFT], `tab2-${i}`, { idle: false });
        // …so alice's later typed name commits against a stale baseline.
        const typed = `alice-typed-${i}`;
        await alice.set([...DRAFT], typed, { idle: false });
        // Save the profile (the handler reads the draft).
        await alice.send("saveProfile");
        await harness.settle();
        assertEquals(
          await alice.read(["currentProfileName"]),
          typed,
          `the name alice typed must be the saved profile name (iter ${i})`,
        );
      }
    },
  );
});
