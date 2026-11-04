// Server-execution v2 fan-out stage B — the scheduler's per-node fan-out
// record (scheduler/fan-out.ts), pinned as pure functions: the instance-set
// function over (ratchet × demanders), the RAGGED known-scope ratchet (a
// structural top hop, per-principal session depth — scopes.md §2 as
// amended 2026-08-16), the run-outcome bookkeeping, and B7's precise
// per-instance dirtiness. The production loop that drives these
// (`runSchedulerAction`) is pinned end to end in `executor-fan-out.test.ts`
// and `executor-run-supply.test.ts`; these pins make each mutation of the
// pure core red on its own.

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { resolveScopeKey } from "@commonfabric/memory/v2";
import {
  dirtyFanOutAll,
  dirtyFanOutForCause,
  fanOutInstances,
  fanOutInstancesToRun,
  fanOutRunFinished,
  fanOutRunStarted,
  fanOutUnionLog,
  keyAtRatchet,
  newFanOutNodeState,
  pruneFanOutInstances,
  ratchetDepthFor,
  ratchetDiscovered,
} from "../src/scheduler/fan-out.ts";
import type { MemorySpace } from "../src/storage/interface.ts";

const space = "did:key:fanout-unit" as MemorySpace;
const aliceS1 = { principal: "did:key:alice", sessionId: "a-s1" as never };
const aliceS2 = { principal: "did:key:alice", sessionId: "a-s2" as never };
const bobS1 = { principal: "did:key:bob", sessionId: "b-s1" as never };
const bobS2 = { principal: "did:key:bob", sessionId: "b-s2" as never };
const anonymous = { sessionId: "anon-s1" as never };
const userKey = (id: { principal?: string }) => resolveScopeKey("user", id);
const sessionKey = (id: { principal?: string; sessionId?: unknown }) =>
  resolveScopeKey("session", id as never);

const emptyLog = () => ({ reads: [], shallowReads: [], writes: [] });
const readOf = (id: string, scope?: "user" | "session", scopeKey?: string) => ({
  space,
  id: id as never,
  type: "application/json" as const,
  path: [],
  ...(scope !== undefined ? { scope } : {}),
  ...(scopeKey !== undefined ? { scopeKey: scopeKey as never } : {}),
});

describe("fan-out stage B: the instance-set function (design §B2)", () => {
  it("runs ONE probe — min(D), key `space` — while nothing scoped was discovered, whoever demands", () => {
    const state = newFanOutNodeState();
    // Deterministic: sorted by (principal, session); the probe is the
    // smallest pair — resolution scaffolding, never attribution.
    const instances = fanOutInstances(state, [bobS2, aliceS2, aliceS1, bobS1]);
    expect(instances).toEqual([{ identity: aliceS1, key: "space" }]);
    // Anonymous demanders own no instance.
    expect(fanOutInstances(state, [anonymous])).toEqual([]);
    expect(fanOutInstances(state, [])).toEqual([]);
  });

  it("runs ONE instance per demanding principal once narrowed — the representative (smallest) session resolves — and per SESSION for session-deep principals (ragged)", () => {
    const state = newFanOutNodeState();
    state.narrowed = true;
    const both = fanOutInstances(state, [bobS2, aliceS2, aliceS1, bobS1]);
    expect(both).toEqual([
      { identity: aliceS1, key: userKey(aliceS1) },
      { identity: bobS1, key: userKey(bobS1) },
    ]);
    // Bob narrowed to session: Bob runs per session, Alice still once.
    state.sessionPrincipals.add(bobS1.principal);
    const ragged = fanOutInstances(state, [bobS2, aliceS2, aliceS1, bobS1]);
    expect(ragged).toEqual([
      { identity: aliceS1, key: userKey(aliceS1) },
      { identity: bobS1, key: sessionKey(bobS1) },
      { identity: bobS2, key: sessionKey(bobS2) },
    ]);
    // A session-deep principal's SESSIONLESS pair owns no instance.
    expect(
      fanOutInstances(state, [{ principal: bobS1.principal }]),
    ).toEqual([]);
  });
});

describe("fan-out stage B: the ragged known-scope ratchet (design §B1/§B3, scopes.md §2 as amended)", () => {
  it("only narrows: the top hop for everyone, session depth per principal; a broader discovery never widens", () => {
    const state = newFanOutNodeState();
    expect(ratchetDepthFor(state, aliceS1)).toBe("space");
    expect(ratchetDiscovered(state, aliceS1, "space")).toBe(false);
    expect(state.narrowed).toBe(false);
    // Alice discovers user: everyone is at least user (structural hop).
    expect(ratchetDiscovered(state, aliceS1, "user")).toBe(true);
    expect(ratchetDepthFor(state, aliceS1)).toBe("user");
    expect(ratchetDepthFor(state, bobS1)).toBe("user");
    // Bob discovers session: Bob alone is session-deep (ragged).
    expect(ratchetDiscovered(state, bobS1, "session")).toBe(true);
    expect(ratchetDepthFor(state, bobS1)).toBe("session");
    expect(ratchetDepthFor(state, aliceS1)).toBe("user");
    // Widening is closed: Bob's later user-only run changes nothing;
    // a repeat discovery does not "move" the ratchet.
    expect(ratchetDiscovered(state, bobS1, "user")).toBe(false);
    expect(ratchetDiscovered(state, bobS2, "session")).toBe(false);
    expect(ratchetDepthFor(state, bobS2)).toBe("session");
    // Alice's session discovery jumps straight from user to session.
    expect(ratchetDiscovered(state, aliceS2, "session")).toBe(true);
    expect(ratchetDepthFor(state, aliceS1)).toBe("session");
  });

  it("keys an identity at its ratchet depth; a sessionless pair at session depth has no key", () => {
    const state = newFanOutNodeState();
    expect(keyAtRatchet(state, aliceS1)).toBe("space");
    state.narrowed = true;
    expect(keyAtRatchet(state, aliceS1)).toBe(userKey(aliceS1));
    state.sessionPrincipals.add(aliceS1.principal);
    expect(keyAtRatchet(state, aliceS1)).toBe(sessionKey(aliceS1));
    expect(keyAtRatchet(state, { principal: aliceS1.principal })).toBe(
      undefined,
    );
  });
});

describe("fan-out stage B: run outcomes and B7 precise dirtiness", () => {
  it("a finished run marks its key at the (moved) ratchet clean and re-keys itself when it narrowed: the probe that discovered user becomes the user instance, its `space` key leaves the set", () => {
    const state = newFanOutNodeState();
    const probe = { identity: aliceS1, key: "space" as const };
    const gen = fanOutRunStarted(state, probe);
    expect(state.instances.has("space")).toBe(true);
    const moved = fanOutRunFinished(state, probe, {
      discovered: "user",
      startGen: gen,
      log: emptyLog(),
    });
    expect(moved).toBe(true);
    expect(state.narrowed).toBe(true);
    expect(state.instances.has("space")).toBe(false);
    expect(state.instances.has(userKey(aliceS1))).toBe(true);
    expect([...state.clean]).toEqual([userKey(aliceS1)]);
    // The sibling appears in the set and is NOT clean — it runs.
    const instances = fanOutInstances(state, [aliceS1, bobS1]);
    expect(fanOutInstancesToRun(state, instances).map((i) => i.key)).toEqual([
      userKey(bobS1),
    ]);
  });

  it("a cause that lands MID-RUN is not absorbed by the run that predates it: the key stays dirty and re-runs (the dirtiness generation)", () => {
    const state = newFanOutNodeState();
    state.narrowed = true;
    const alice = { identity: aliceS1, key: userKey(aliceS1) };
    const gen = fanOutRunStarted(state, alice);
    // Bob's doc changes while Alice runs — irrelevant to Alice.
    dirtyFanOutForCause(state, readOf("of:x", "user", userKey(bobS1)));
    // Alice's OWN doc changes while she runs.
    dirtyFanOutForCause(state, readOf("of:x", "user", userKey(aliceS1)));
    fanOutRunFinished(state, alice, {
      discovered: "user",
      startGen: gen,
      log: emptyLog(),
    });
    expect(state.clean.has(userKey(aliceS1))).toBe(false);
    // Without the mid-run cause the run is current.
    const gen2 = fanOutRunStarted(state, alice);
    fanOutRunFinished(state, alice, {
      discovered: "user",
      startGen: gen2,
      log: emptyLog(),
    });
    expect(state.clean.has(userKey(aliceS1))).toBe(true);
  });

  it("B7: a keyed cause dirties exactly the instances whose identity covers it — Bob's user doc dirties Bob's user AND session instances, never Alice's; an unkeyed (space) cause dirties everyone", () => {
    const state = newFanOutNodeState();
    state.narrowed = true;
    state.sessionPrincipals.add(bobS1.principal);
    const alice = { identity: aliceS1, key: userKey(aliceS1) };
    const bob1 = { identity: bobS1, key: sessionKey(bobS1) };
    const bob2 = { identity: bobS2, key: sessionKey(bobS2) };
    for (const instance of [alice, bob1, bob2]) {
      const gen = fanOutRunStarted(state, instance);
      fanOutRunFinished(state, instance, {
        discovered: instance === alice ? "user" : "session",
        startGen: gen,
        log: emptyLog(),
      });
    }
    expect(state.clean.size).toBe(3);
    // Bob's USER doc: both of Bob's session instances read `user:bob`.
    dirtyFanOutForCause(state, readOf("of:x", "user", userKey(bobS1)));
    expect([...state.clean]).toEqual([userKey(aliceS1)]);
    // Re-clean, then Bob's SESSION s1 doc: only that instance.
    for (const instance of [bob1, bob2]) {
      const gen = fanOutRunStarted(state, instance);
      fanOutRunFinished(state, instance, {
        discovered: "session",
        startGen: gen,
        log: emptyLog(),
      });
    }
    dirtyFanOutForCause(state, readOf("of:x", "session", sessionKey(bobS1)));
    expect(new Set(state.clean)).toEqual(
      new Set([userKey(aliceS1), sessionKey(bobS2)]),
    );
    // Alice's user doc: Alice only.
    dirtyFanOutForCause(state, readOf("of:x", "user", userKey(aliceS1)));
    expect([...state.clean]).toEqual([sessionKey(bobS2)]);
    // A space doc (no key): everyone.
    dirtyFanOutForCause(state, readOf("of:y"));
    expect(state.clean.size).toBe(0);
    // dirtyFanOutAll likewise.
    const gen = fanOutRunStarted(state, alice);
    fanOutRunFinished(state, alice, {
      discovered: "user",
      startGen: gen,
      log: emptyLog(),
    });
    expect(state.clean.size).toBe(1);
    dirtyFanOutAll(state);
    expect(state.clean.size).toBe(0);
  });

  it("the union subscription keeps a SKIPPED instance's last log and drops a DEPARTED one's (prune)", () => {
    const state = newFanOutNodeState();
    state.narrowed = true;
    const alice = { identity: aliceS1, key: userKey(aliceS1) };
    const bob = { identity: bobS1, key: userKey(bobS1) };
    for (const [instance, id] of [[alice, "of:a"], [bob, "of:b"]] as const) {
      const gen = fanOutRunStarted(state, instance);
      fanOutRunFinished(state, instance, {
        discovered: "user",
        startGen: gen,
        log: {
          reads: [readOf(id, "user", instance.key)],
          shallowReads: [],
          writes: [],
        },
      });
    }
    const union = fanOutUnionLog(state);
    expect(union.reads.map((r) => r.id)).toEqual(["of:a", "of:b"]);
    // Bob departs: his instance leaves the set and the union.
    pruneFanOutInstances(state, fanOutInstances(state, [aliceS1]));
    expect(fanOutUnionLog(state).reads.map((r) => r.id)).toEqual(["of:a"]);
    expect(state.clean.has(userKey(bobS1))).toBe(false);
  });
});
