/**
 * CHARACTERIZATION of the blind-set / CAS-push trade-off accepted in #4245:
 * an array read-modify-write through `set` (the ArrayCellController
 * removeItem/updateItem shape — read the array, filter/replace, `set` the
 * whole new array) is last-write-wins. If it races a concurrent `push`, the
 * pushed element is SILENTLY clobbered: the set lands ok, no ConflictError,
 * no retry, nothing observable at the write site.
 *
 * Timeline demonstrated:
 *   shared items = [a, b, c]                      (settled everywhere)
 *   bob:   push(d)          → CAS, lands → [a, b, c, d]
 *   alice: removeItem(b) as the UI does it — she read [a, b, c] BEFORE bob's
 *          push, filters b, then blind-sets [a, c]  → lands ok (structural
 *          parent read only) → final list [a, c]:  d is gone.
 *
 * Contrast (also asserted): if alice's stale RMW goes through `push`-style
 * CAS instead, the server rejects it with a ConflictError — the loss is
 * specific to the blind path, not to racing per se.
 *
 * Every `push` here is the multi-runtime harness's own: a read-modify-write
 * append that keeps compare-and-set. A UI's `CellHandle.push()` does not take
 * that path; the runtime appends through `Cell.push()`'s mergeable operation,
 * which these tests do not reach, so a change in how the UI's push is routed
 * does not fail them. The removeItem/updateItem story against the UI's
 * mergeable append is not pinned here (mergeable remove-by-value / a CAS
 * CellSet variant — see the #4245 discussion thread).
 */

import { assert, assertEquals } from "@std/assert";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { join } from "@std/path";
import { debugStr } from "@commonfabric/data-model";
import {
  MultiRuntimeHarness,
  type MultiRuntimeSession,
} from "./multi-runtime-harness.ts";

const PROGRAM_PATH = join(
  import.meta.dirname!,
  "fixtures",
  "lww-list",
  "main.tsx",
);
const ROOT_PATH = join(import.meta.dirname!, "..");
const ITEMS: (string | number)[] = ["items"];

type Item = { body: string };
const item = (body: string): Item => ({ body });
const bodies = (list: Item[] | undefined): string[] =>
  (list ?? []).map((i) => i.body);

const isConflict = (error?: { name?: string; message?: string }): boolean =>
  error?.name === "ConflictError" ||
  (error?.message?.includes("stale confirmed read") ?? false);

describe("cellset LWW lost-update (remove-vs-push race)", () => {
  let harness: MultiRuntimeHarness;
  let alice: MultiRuntimeSession;
  let bob: MultiRuntimeSession;

  beforeAll(async () => {
    harness = await MultiRuntimeHarness.create({
      programPath: PROGRAM_PATH,
      rootPath: ROOT_PATH,
      sessions: ["lww-alice", "lww-bob"],
    });
    [alice, bob] = harness.sessions;
    await harness.settle();
  });

  afterAll(async () => {
    await harness?.dispose();
  });

  it("a blind removeItem-style set silently clobbers a concurrent push", async () => {
    // Seed [a, b, c], settled everywhere.
    const seed = await alice.set(ITEMS, [item("a"), item("b"), item("c")]);
    assert(seed.ok, `seed failed: ${seed.error?.message}`);
    await harness.settle();
    assertEquals(bodies(await bob.read(ITEMS) as Item[]), ["a", "b", "c"]);

    // Alice's UI reads the array NOW — before bob's push — and computes the
    // removeItem(b) result the way ArrayCellController does.
    const aliceStaleView = await alice.read(ITEMS) as Item[];
    const aliceRmw = aliceStaleView.filter((i) => i.body !== "b");
    assertEquals(bodies(aliceRmw), ["a", "c"]);

    // Bob's push lands first (CAS, settled): server now has [a, b, c, d].
    const push = await bob.push(ITEMS, item("d"));
    assert(push.ok, `push failed: ${push.error?.message}`);
    await harness.settle();

    // Alice's blind set of her stale RMW result lands WITHOUT any conflict…
    const set = await alice.set(ITEMS, aliceRmw);
    assert(
      set.ok && !isConflict(set.error),
      `expected the blind set to land clean (LWW); ` +
        debugStr`got $quote,long${set.error}`,
    );
    await harness.settle();

    // …and bob's d is silently gone, for everyone.
    assertEquals(
      bodies(await alice.read(ITEMS) as Item[]),
      ["a", "c"],
      "alice's view after her removeItem",
    );
    assertEquals(
      bodies(await bob.read(ITEMS) as Item[]),
      ["a", "c"],
      "bob's push was clobbered with no conflict surfaced anywhere",
    );
  });

  it("the same stale RMW through CAS push semantics conflicts instead", async () => {
    // Re-seed.
    const seed = await alice.set(ITEMS, [item("a"), item("b"), item("c")]);
    assert(seed.ok, `re-seed failed: ${seed.error?.message}`);
    await harness.settle();

    // Bob pushes d and it lands.
    const push = await bob.push(ITEMS, item("d"));
    assert(push.ok, `push failed: ${push.error?.message}`);
    await harness.settle(3);

    // Alice pushes from a view that raced bob's: the CAS path surfaces the
    // race as a ConflictError instead of losing data. (push reads its base
    // from the local replica at call time — after settle it has [a,b,c,d],
    // so force staleness by NOT settling alice between two of her own
    // pipelined pushes racing bob's next one.)
    const [p1, p2] = await Promise.all([
      alice.push(ITEMS, item("e"), { idle: false }),
      bob.push(ITEMS, item("f"), { idle: false }),
    ]);
    const conflicts = [p1, p2].filter((r) => !r.ok && isConflict(r.error));
    assert(
      conflicts.length >= 1,
      `expected at least one CAS conflict from racing pushes; ` +
        debugStr`got $quote,long${[p1, p2]}`,
    );
  });
});
