/**
 * Regression test: a UI `set` is a blind last-write-wins leaf write, whatever
 * the value's shape; the blind-vs-CAS choice is made by METHOD (the request
 * type the client sends).
 *
 * `handleCellSet` marks its transaction as a blind-leaf-write, so the set's reads
 * carry no value-equality precondition (only a structural existence read at the
 * entity root survives, to catch a concurrent whole-doc delete/replace). Under
 * concurrent same-user edits a `set` therefore no longer hits the
 * "stale confirmed read" conflict that rolled the write back and silently dropped
 * a profile/draft edit — the cfc-group-chat-demo "Name not set" flake.
 * (Supersedes the #4126 cellset-silent-rollback queue work.)
 *
 * The push step exercises the harness's own `push`, a read-modify-write append
 * that keeps compare-and-set. A UI's `CellHandle.push()` is not that: the
 * runtime appends through `Cell.push()`'s mergeable operation, so the step pins
 * the harness's append rather than the UI's.
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
        { label: "alice", identity: aliceId, inboundHold: true },
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
    // The harness's `push` is read-modify-write and NOT blind, so the read of
    // the current array stays a commit precondition, and concurrent same-user
    // pushes against the shared draft conflict (compare-and-set). A UI's
    // `CellHandle.push()` takes the runtime's mergeable `Cell.push()` instead,
    // which this step does not reach.
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
      // The "Name not set" flake, end to end: alice types a profile name (a
      // scalar `$value` write to the PerUser draft), then saves, and the
      // fixture's save handler reads the draft. Each round forces two
      // conditions on the typed write, then requires that it commits and that
      // the save after it reads it.
      //
      // A stale baseline: tab2 writes the shared draft while alice's inbound
      // frames are held, so alice's typed write commits from a replica that
      // has not received tab2's. A blind `set`, carrying no value
      // precondition, commits from there; a compare-and-set one is refused,
      // as stale or, on the ON arm, for reading the echo below.
      //
      // A standing echo, on the server-execution ON arm: the save alice sends
      // just before the hold has run here speculatively, writing the saved
      // name into the draft's document, and its consequence is among the
      // held frames, so that speculative layer still stands when she types.
      // The blind write's structural read has to base on the document's
      // non-speculative stack; naming the process-local layer gets the whole
      // write refused (`speculative-basis-refused`), dropping the input
      // (verification-coverage.md OW47; speculation-overlay.test.ts carries
      // the unit pin). Each round saves a name the profile does not hold yet,
      // so that the echo writes something. The warm-up save keeps any round
      // from holding alice's first event, whose consequence can arrive back
      // before the hold starts, and the round's first assertion catches one
      // whose consequence did.
      await alice.set([...DRAFT], "alice-warmup");
      await alice.send("saveProfile");
      for (let i = 0; i < 5; i++) {
        await harness.settle();
        await alice.set([...DRAFT], `alice-saved-${i}`);
        await harness.settle();
        await alice.send("saveProfile", {}, undefined, {
          thenHoldInbound: true,
        });
        const outstanding = await alice.outstandingEventCount();
        assert(
          outstanding === null || outstanding > 0,
          `alice's save must still await its consequence (iter ${i})`,
        );
        const other = await aliceTab2.set([...DRAFT], `tab2-${i}`);
        assert(
          other.ok,
          debugStr`tab2's set must commit: $quote,long${other.error}`,
        );
        // The typed write's commit is built as the worker receives this call,
        // and the release is delivered after it.
        const typed = `alice-typed-${i}`;
        const typing = alice.set([...DRAFT], typed);
        await alice.releaseInbound();
        const typedCommit = await typing;
        assert(
          typedCommit.ok,
          `the name alice typed must commit (iter ${i}): ` +
            debugStr`$quote,long${typedCommit.error}`,
        );
        await harness.settle();
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
