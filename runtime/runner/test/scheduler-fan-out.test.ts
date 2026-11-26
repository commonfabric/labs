// Server-execution v2 fan-out stage B — the scheduler's per-node fan-out
// record (scheduler/fan-out.ts), pinned as pure functions: the instance-set
// function over (ratchet × demanders), the RAGGED known-scope ratchet (a
// structural top hop, per-principal session depth — scopes.md §2 as
// amended 2026-08-16), the run-outcome bookkeeping, and B7's precise
// per-instance dirtiness. The production loop that drives these
// (`runSchedulerAction`) is pinned end to end in `executor-fan-out.test.ts`
// and `executor-run-supply.test.ts`; these pins make each mutation of the
// pure core red on its own.

import { expect } from "@std/expect";
import { resolveScopeKey } from "@commonfabric/memory/v2";
import { describe, it } from "@commonfabric/test-support/test";
import {
  dirtyFanOutAll,
  dirtyFanOutForCause,
  dirtyFanOutKey,
  fanOutHoldsSlot,
  fanOutInstances,
  fanOutInstancesToRun,
  fanOutRunAborted,
  fanOutRunApplied,
  fanOutRunEnded,
  fanOutRunFinished,
  fanOutRunOpened,
  fanOutRunStarted,
  fanOutSlotChanged,
  fanOutUnionLog,
  keyAtRatchet,
  newFanOutNodeState,
  oweFanOutRuns,
  pruneFanOutInstances,
  ratchetDepthFor,
  ratchetDiscovered,
  restoreFanOutTriggers,
  takeFanOutTriggers,
} from "../src/scheduler/fan-out.ts";
import { invalidCauseKey } from "../src/scheduler/keys.ts";
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

  it("B7: a keyed cause dirties exactly the instances whose identity covers it — Bob's user doc dirties Bob's user AND session instances, never Alice's; an unkeyed (space) cause dirties the instances that read its document", () => {
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
        log: { ...emptyLog(), reads: [readOf("of:y")] },
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
        log: { ...emptyLog(), reads: [readOf("of:y")] },
      });
    }
    dirtyFanOutForCause(state, readOf("of:x", "session", sessionKey(bobS1)));
    expect(new Set(state.clean)).toEqual(
      new Set([userKey(aliceS1), sessionKey(bobS2)]),
    );
    // Alice's user doc: Alice only.
    dirtyFanOutForCause(state, readOf("of:x", "user", userKey(aliceS1)));
    expect([...state.clean]).toEqual([sessionKey(bobS2)]);
    // A space doc (no key) that every instance read: everyone.
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

  describe("a cause that names no instance", () => {
    const alice = { identity: aliceS1, key: userKey(aliceS1) };
    const bob = { identity: bobS1, key: userKey(bobS1) };

    /** Runs `instance` to a finished run that read the documents `ids`. */
    const finish = (
      state: ReturnType<typeof newFanOutNodeState>,
      instance: typeof alice,
      ids: readonly string[],
    ) => {
      const startGen = fanOutRunStarted(state, instance);
      fanOutRunFinished(state, instance, {
        discovered: "user",
        startGen,
        log: { ...emptyLog(), reads: ids.map((id) => readOf(id)) },
      });
    };
    const narrowed = () => {
      const state = newFanOutNodeState();
      state.narrowed = true;
      return state;
    };

    it("leaves current an instance whose latest run did not read the cause's document", () => {
      const state = narrowed();
      finish(state, alice, ["of:alice-only", "of:shared"]);
      finish(state, bob, ["of:bob-only", "of:shared"]);

      dirtyFanOutForCause(state, readOf("of:alice-only"));

      expect([...state.clean]).toEqual([bob.key]);
    });

    it("leaves current an instance that read the document of the same id in another space or at another scope", () => {
      const state = narrowed();
      finish(state, alice, ["of:doc"]);
      const startGen = fanOutRunStarted(state, bob);
      fanOutRunFinished(state, bob, {
        discovered: "user",
        startGen,
        log: {
          ...emptyLog(),
          reads: [
            { ...readOf("of:doc"), space: "did:key:elsewhere" as MemorySpace },
            readOf("of:doc", "user", bob.key),
          ],
        },
      });

      dirtyFanOutForCause(state, readOf("of:doc"));

      expect([...state.clean]).toEqual([bob.key]);
    });

    it("dirties an instance that read the cause's document only shallowly", () => {
      const state = narrowed();
      const startGen = fanOutRunStarted(state, alice);
      fanOutRunFinished(state, alice, {
        discovered: "user",
        startGen,
        log: { ...emptyLog(), shallowReads: [readOf("of:listed")] },
      });

      dirtyFanOutForCause(state, readOf("of:listed"));

      expect(state.clean.size).toBe(0);
    });

    it("dirties an instance that read a parent path of the cause's", () => {
      const state = narrowed();
      const startGen = fanOutRunStarted(state, alice);
      fanOutRunFinished(state, alice, {
        discovered: "user",
        startGen,
        log: {
          ...emptyLog(),
          reads: [{ ...readOf("of:doc"), path: ["value"] }],
        },
      });

      dirtyFanOutForCause(state, {
        ...readOf("of:doc"),
        path: ["value", "a", "b"],
      });

      expect(state.clean.size).toBe(0);
    });

    it("dirties an instance that read a child path of the cause's", () => {
      const state = narrowed();
      const startGen = fanOutRunStarted(state, alice);
      fanOutRunFinished(state, alice, {
        discovered: "user",
        startGen,
        log: {
          ...emptyLog(),
          reads: [{ ...readOf("of:doc"), path: ["value", "a", "b"] }],
        },
      });

      dirtyFanOutForCause(state, { ...readOf("of:doc"), path: ["value"] });

      expect(state.clean.size).toBe(0);
    });

    it("dirties an instance that read the cause's document at another path", () => {
      // A cause carries one read path of the node's whose value changed, not
      // the path that changed: a write of the whole document reaches this
      // instance's path as well, under a cause that names another's.

      const state = narrowed();
      const startGen = fanOutRunStarted(state, alice);
      fanOutRunFinished(state, alice, {
        discovered: "user",
        startGen,
        log: {
          ...emptyLog(),
          reads: [{ ...readOf("of:doc"), path: ["value", "a"] }],
        },
      });

      dirtyFanOutForCause(state, {
        ...readOf("of:doc"),
        path: ["value", "b"],
      });

      expect(state.clean.size).toBe(0);
    });

    it("leaves current an instance whose run was under way when the cause arrived and did not read its document", () => {
      const state = narrowed();
      finish(state, alice, ["of:alice-only"]);
      const startGen = fanOutRunStarted(state, bob);
      dirtyFanOutForCause(state, readOf("of:alice-only"));
      fanOutRunFinished(state, bob, {
        discovered: "user",
        startGen,
        log: { ...emptyLog(), reads: [readOf("of:bob-only")] },
      });

      expect(state.clean.has(bob.key)).toBe(true);
      expect(takeFanOutTriggers(state, bob.key)).toBeUndefined();
    });

    it("re-runs an instance whose run was under way when the cause arrived and read its document for the first time, and hands that run the cause", () => {
      // The reads of a run are recorded when it finishes, so the cause
      // cannot be told to concern the run until then.

      const state = narrowed();
      finish(state, alice, ["of:alice-only"]);
      finish(state, bob, ["of:bob-only"]);
      const aliceOnly = readOf("of:alice-only");
      dirtyFanOutForCause(state, readOf("of:bob-only"));
      takeFanOutTriggers(state, bob.key);
      const startGen = fanOutRunStarted(state, bob);
      dirtyFanOutForCause(state, aliceOnly);
      fanOutRunFinished(state, bob, {
        discovered: "user",
        startGen,
        log: { ...emptyLog(), reads: [readOf("of:bob-only"), aliceOnly] },
      });

      expect(state.clean.has(bob.key)).toBe(false);
      expect(takeFanOutTriggers(state, bob.key)).toEqual(
        new Set([invalidCauseKey(aliceOnly)]),
      );
    });

    it("leaves current an instance whose run started after the cause arrived, though the run read its document for the first time", () => {
      // The run read the document as the change left it.

      const state = narrowed();
      finish(state, alice, ["of:alice-only"]);
      finish(state, bob, ["of:bob-only"]);
      dirtyFanOutForCause(state, readOf("of:bob-only"));
      dirtyFanOutForCause(state, readOf("of:alice-only"));
      takeFanOutTriggers(state, bob.key);
      const startGen = fanOutRunStarted(state, bob);
      fanOutRunFinished(state, bob, {
        discovered: "user",
        startGen,
        log: {
          ...emptyLog(),
          reads: [readOf("of:bob-only"), readOf("of:alice-only")],
        },
      });

      expect(state.clean.has(bob.key)).toBe(true);
      expect(takeFanOutTriggers(state, bob.key)).toBeUndefined();
    });

    it("re-runs an instance whose first run was under way when the cause arrived and read its document", () => {
      const state = narrowed();
      finish(state, alice, ["of:alice-only"]);
      const startGen = fanOutRunStarted(state, bob);
      dirtyFanOutForCause(state, readOf("of:alice-only"));
      fanOutRunFinished(state, bob, {
        discovered: "user",
        startGen,
        log: { ...emptyLog(), reads: [readOf("of:alice-only")] },
      });

      expect(state.clean.has(bob.key)).toBe(false);
    });

    it("leaves an instance that never ran to run, and records no cause for it", () => {
      const state = narrowed();
      finish(state, alice, ["of:alice-only"]);

      dirtyFanOutForCause(state, readOf("of:alice-only"));

      const toRun = fanOutInstancesToRun(
        state,
        fanOutInstances(state, [aliceS1, bobS1]),
      );
      expect(toRun.map((instance) => instance.key)).toEqual([
        alice.key,
        bob.key,
      ]);
      fanOutRunStarted(state, bob);
      expect(takeFanOutTriggers(state, bob.key)).toBeUndefined();
    });

    it("dirties no instance once the only one that read the document has left", () => {
      const state = narrowed();
      finish(state, alice, ["of:alice-only"]);
      finish(state, bob, ["of:bob-only"]);
      pruneFanOutInstances(state, fanOutInstances(state, [bobS1]));

      dirtyFanOutForCause(state, readOf("of:alice-only"));

      expect([...state.clean]).toEqual([bob.key]);
    });

    it("goes by the reads of an instance's latest run, not of the one before", () => {
      const state = narrowed();
      finish(state, alice, ["of:alice-only"]);
      finish(state, bob, ["of:alice-only"]);
      finish(state, bob, ["of:bob-only"]);

      dirtyFanOutForCause(state, readOf("of:alice-only"));

      expect([...state.clean]).toEqual([bob.key]);
    });

    it("goes by the reads a run recorded under the key the ratchet moved its instance to", () => {
      const state = narrowed();
      const startGen = fanOutRunStarted(state, bob);
      fanOutRunFinished(state, bob, {
        discovered: "session",
        startGen,
        log: { ...emptyLog(), reads: [readOf("of:bob-only")] },
      });
      finish(state, alice, ["of:alice-only"]);

      dirtyFanOutForCause(state, readOf("of:bob-only"));

      expect([...state.clean]).toEqual([alice.key]);
    });

    it("hands the cause to the next run of each instance that read its document, once", () => {
      const state = narrowed();
      finish(state, alice, ["of:alice-only", "of:shared"]);
      finish(state, bob, ["of:shared"]);
      const aliceOnly = readOf("of:alice-only");
      const shared = readOf("of:shared");

      dirtyFanOutForCause(state, aliceOnly);
      dirtyFanOutForCause(state, shared);

      expect(takeFanOutTriggers(state, alice.key)).toEqual(
        new Set([invalidCauseKey(aliceOnly), invalidCauseKey(shared)]),
      );
      expect(takeFanOutTriggers(state, bob.key)).toEqual(
        new Set([invalidCauseKey(shared)]),
      );
      expect(takeFanOutTriggers(state, alice.key)).toBeUndefined();
    });

    it("hands a running instance the cause only where its earlier run read the document", () => {
      const state = narrowed();
      finish(state, alice, ["of:alice-only"]);
      finish(state, bob, ["of:bob-only"]);
      fanOutRunStarted(state, bob);

      dirtyFanOutForCause(state, readOf("of:alice-only"));
      dirtyFanOutForCause(state, readOf("of:bob-only"));

      expect(takeFanOutTriggers(state, bob.key)).toEqual(
        new Set([invalidCauseKey(readOf("of:bob-only"))]),
      );
    });

    it("keeps a cause that arrived during the run that moved its instance to another key for the instance's next run", () => {
      const state = narrowed();
      finish(state, bob, ["of:bob-only"]);
      const bobOnly = readOf("of:bob-only");
      const startGen = fanOutRunStarted(state, bob);
      dirtyFanOutForCause(state, bobOnly);
      fanOutRunFinished(state, bob, {
        discovered: "session",
        startGen,
        log: { ...emptyLog(), reads: [bobOnly] },
      });

      expect(state.instances.has(bob.key)).toBe(false);
      expect(takeFanOutTriggers(state, sessionKey(bobS1))).toEqual(
        new Set([invalidCauseKey(bobOnly)]),
      );
    });

    it("returns `false` for a cause whose document no instance read, and `true` once it dirtied one", () => {
      const state = narrowed();
      finish(state, alice, ["of:alice-only"]);

      expect(dirtyFanOutForCause(state, readOf("of:other"))).toBe(false);
      expect(dirtyFanOutForCause(state, readOf("of:alice-only"))).toBe(true);
    });

    it("returns `true` for any cause while the node holds no instance", () => {
      expect(dirtyFanOutForCause(narrowed(), readOf("of:any"))).toBe(true);
    });

    it("returns `true` for a cause kept for a run under way", () => {
      const state = narrowed();
      fanOutRunStarted(state, alice);

      expect(dirtyFanOutForCause(state, readOf("of:any"))).toBe(true);
    });

    describe("for an instance whose run was given up", () => {
      /** A node where Bob's latest run read `ids` and ended with no retry. */
      const givenUp = (ids: readonly string[]) => {
        const state = narrowed();
        finish(state, alice, ["of:alice-only"]);
        finish(state, bob, ["of:bob-only"]);
        dirtyFanOutForCause(state, readOf("of:bob-only"));
        takeFanOutTriggers(state, bob.key);
        fanOutRunStarted(state, bob);
        fanOutRunAborted(state, bob, {
          ...emptyLog(),
          reads: ids.map((id) => readOf(id)),
        });
        return state;
      };
      const toRun = (state: ReturnType<typeof newFanOutNodeState>) =>
        fanOutInstancesToRun(state, fanOutInstances(state, [aliceS1, bobS1]))
          .map((instance) => instance.key);

      it("leaves it out of the instances to run, though it is not current", () => {
        const state = givenUp([]);

        expect(state.clean.has(bob.key)).toBe(false);
        expect(toRun(state)).toEqual([]);
      });

      it("leaves it out when a document only another instance read changes, and keeps nothing for it", () => {
        const state = givenUp([]);

        dirtyFanOutForCause(state, readOf("of:alice-only"));

        expect(toRun(state)).toEqual([alice.key]);
        expect(state.instances.get(bob.key)?.arrived).toBeUndefined();
        expect(takeFanOutTriggers(state, bob.key)).toBeUndefined();
      });

      it("runs it, with the cause, when a document its latest finished run read changes", () => {
        const state = givenUp([]);
        const bobOnly = readOf("of:bob-only");

        dirtyFanOutForCause(state, bobOnly);

        expect(toRun(state)).toEqual([bob.key]);
        expect(takeFanOutTriggers(state, bob.key)).toEqual(
          new Set([invalidCauseKey(bobOnly)]),
        );
      });

      it("runs it, with the cause, when a document only its given-up run read changes", () => {
        const state = givenUp(["of:tried"]);
        const tried = readOf("of:tried");

        dirtyFanOutForCause(state, tried);

        expect(toRun(state)).toEqual([bob.key]);
        expect(takeFanOutTriggers(state, bob.key)).toEqual(
          new Set([invalidCauseKey(tried)]),
        );
      });

      it("stops going by the given-up run's reads once a later run finished", () => {
        const state = givenUp(["of:tried"]);
        dirtyFanOutKey(state, bob.key);
        finish(state, bob, ["of:bob-only"]);

        dirtyFanOutForCause(state, readOf("of:tried"));

        expect(state.clean.has(bob.key)).toBe(true);
      });

      it("runs it for an invalidation of every instance, and for demand", () => {
        const all = givenUp([]);
        dirtyFanOutAll(all);
        expect(toRun(all)).toEqual([alice.key, bob.key]);

        const demanded = givenUp([]);
        oweFanOutRuns(demanded, [bob.key]);
        expect(toRun(demanded)).toEqual([bob.key]);

        const everyDemand = givenUp([]);
        oweFanOutRuns(everyDemand);
        expect(toRun(everyDemand)).toEqual([bob.key]);
      });

      it("runs it for a cause that arrived during the given-up run for a document that run read", () => {
        const state = narrowed();
        finish(state, alice, ["of:alice-only"]);
        finish(state, bob, ["of:bob-only"]);
        dirtyFanOutForCause(state, readOf("of:bob-only"));
        fanOutRunStarted(state, bob);
        const tried = readOf("of:tried");
        dirtyFanOutForCause(state, tried);
        dirtyFanOutForCause(state, readOf("of:other"));
        fanOutRunAborted(state, bob, { ...emptyLog(), reads: [tried] });

        expect(toRun(state)).toEqual([bob.key]);
        expect(takeFanOutTriggers(state, bob.key)).toEqual(
          new Set([invalidCauseKey(tried)]),
        );
      });
    });

    it("does not make a current instance run for demand", () => {
      const state = narrowed();
      finish(state, alice, ["of:alice-only"]);

      oweFanOutRuns(state);

      expect(
        fanOutInstancesToRun(state, fanOutInstances(state, [aliceS1])),
      ).toEqual([]);
    });

    it("keeps nothing for an instance once its run has returned without finishing", () => {
      const state = narrowed();
      fanOutRunStarted(state, alice);
      dirtyFanOutForCause(state, readOf("of:any"));

      fanOutRunEnded(state, alice);

      expect(state.instances.get(alice.key)?.arrived).toBeUndefined();
      expect(dirtyFanOutForCause(state, readOf("of:any"))).toBe(false);
    });

    it("gives a retried run back the causes its failed attempt took, and its siblings none of them", () => {
      const state = narrowed();
      finish(state, alice, ["of:alice-only"]);
      finish(state, bob, ["of:bob-only"]);
      const aliceOnly = readOf("of:alice-only");
      const keyed = readOf("of:x", "user", alice.key);
      dirtyFanOutForCause(state, aliceOnly);
      takeFanOutTriggers(state, alice.key);

      restoreFanOutTriggers(state, alice.key, [aliceOnly, keyed]);

      expect(takeFanOutTriggers(state, alice.key)).toEqual(
        new Set([invalidCauseKey(aliceOnly)]),
      );
      expect(takeFanOutTriggers(state, bob.key)).toBeUndefined();
    });
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

describe("fan-out: which run an instance holds the write of", () => {
  // Two viewers' runs of one node each write, besides the instance at their
  // own key, the instance of `of:shared` at the space's key. The helpers
  // below drive one run through the points the scheduler does: the run
  // opens its transaction, hands its writes over, and the replica then
  // reports each instance those writes changed, with that transaction as
  // the source.

  const shared = "of:shared";
  const narrowed = () => {
    const state = newFanOutNodeState();
    state.narrowed = true;
    return state;
  };
  const alice = { identity: aliceS1, key: userKey(aliceS1) };
  const bob = { identity: bobS1, key: userKey(bobS1) };

  /** Runs `instance` once, changing the instances at `changed`. */
  const run = (
    state: ReturnType<typeof newFanOutNodeState>,
    instance: typeof alice,
    changed: readonly string[],
  ) => {
    const transaction = {};
    const startGen = fanOutRunStarted(state, instance);
    fanOutRunOpened(state, instance, transaction);
    fanOutRunFinished(state, instance, {
      discovered: "user",
      startGen,
      log: emptyLog(),
      transaction,
    });
    for (const scopeKey of changed) {
      fanOutSlotChanged(state, scopeKey, shared, transaction);
    }
    if (changed.length > 0) fanOutRunApplied(state, transaction);
  };

  it("returns `true` for an instance nothing has changed since the node was first run", () => {
    const state = narrowed();
    run(state, alice, []);

    expect(fanOutHoldsSlot(state, alice.key, "space", shared)).toBe(true);
  });

  it("returns `true` for the run that changed the instance last and `false` for the one before it", () => {
    const state = narrowed();
    run(state, alice, ["space"]);
    run(state, bob, ["space"]);

    expect(fanOutHoldsSlot(state, bob.key, "space", shared)).toBe(true);
    expect(fanOutHoldsSlot(state, alice.key, "space", shared)).toBe(false);
  });

  it("returns `true` for both runs where the later one changed nothing of the instance", () => {
    // Bob's run writes what Alice's left, so the replica reports no change
    // of the shared instance, only of Bob's own.

    const state = narrowed();
    run(state, alice, ["space"]);
    run(state, bob, [bob.key]);

    expect(fanOutHoldsSlot(state, alice.key, "space", shared)).toBe(true);
    expect(fanOutHoldsSlot(state, bob.key, "space", shared)).toBe(true);
  });

  it("returns `true` for a later run whose writes the replica applied after the instance changed, though it handed them over before", () => {
    // Bob's run hands its writes over before the replica reports Alice's
    // change, and the replica then applies Bob's with no change of the
    // shared instance: it holds what Bob wrote as well.

    const state = narrowed();
    const aliceTransaction = {};
    const bobTransaction = {};
    for (
      const [instance, transaction] of [
        [alice, aliceTransaction],
        [bob, bobTransaction],
      ] as const
    ) {
      const startGen = fanOutRunStarted(state, instance);
      fanOutRunOpened(state, instance, transaction);
      fanOutRunFinished(state, instance, {
        discovered: "user",
        startGen,
        log: emptyLog(),
        transaction,
      });
    }
    fanOutSlotChanged(state, "space", shared, aliceTransaction);
    fanOutRunApplied(state, aliceTransaction);
    expect(fanOutHoldsSlot(state, bob.key, "space", shared)).toBe(false);

    fanOutSlotChanged(state, bob.key, shared, bobTransaction);
    fanOutRunApplied(state, bobTransaction);

    expect(fanOutHoldsSlot(state, bob.key, "space", shared)).toBe(true);
    expect(fanOutHoldsSlot(state, alice.key, "space", shared)).toBe(true);
  });

  it("returns `false` for every run once something that is no run of the node changed the instance", () => {
    const state = narrowed();
    run(state, alice, ["space"]);
    run(state, bob, [bob.key]);
    fanOutSlotChanged(state, "space", shared, undefined);

    expect(fanOutHoldsSlot(state, alice.key, "space", shared)).toBe(false);
    expect(fanOutHoldsSlot(state, bob.key, "space", shared)).toBe(false);
  });

  it("returns `true` again for a run made after the change", () => {
    const state = narrowed();
    run(state, alice, ["space"]);
    run(state, bob, ["space"]);
    run(state, alice, []);

    expect(fanOutHoldsSlot(state, alice.key, "space", shared)).toBe(true);
    expect(fanOutHoldsSlot(state, bob.key, "space", shared)).toBe(true);
  });

  it("returns `false` where a change names no one instance of the document", () => {
    const state = narrowed();
    run(state, alice, ["space"]);
    fanOutSlotChanged(state, "*", shared, undefined);

    expect(fanOutHoldsSlot(state, alice.key, "space", shared)).toBe(false);
  });

  it("names the run under the key it was recorded under once it narrowed", () => {
    // The probe runs at the space's key and discovers the user's scope, so
    // the instance it leaves is Alice's, and the change its writes make is
    // that instance's.

    const state = newFanOutNodeState();
    const probe = { identity: aliceS1, key: "space" as const };
    const transaction = {};
    const startGen = fanOutRunStarted(state, probe);
    fanOutRunOpened(state, probe, transaction);
    fanOutRunFinished(state, probe, {
      discovered: "user",
      startGen,
      log: emptyLog(),
      transaction,
    });
    run(state, bob, [bob.key]);
    fanOutSlotChanged(state, "space", shared, transaction);

    expect(fanOutHoldsSlot(state, alice.key, "space", shared)).toBe(true);
    expect(fanOutHoldsSlot(state, bob.key, "space", shared)).toBe(false);
  });

  it("keeps a change for the key its run was recorded under, whatever the ratchet gives the run's identity later", () => {
    // Alice's run at her user's key hands its writes over, and before the
    // replica applies them another run narrows her to her session. The
    // change is the user instance's run's, and no instance of hers at the
    // session's depth made it.

    const state = narrowed();
    const transaction = {};
    const startGen = fanOutRunStarted(state, alice);
    fanOutRunOpened(state, alice, transaction);
    fanOutRunFinished(state, alice, {
      discovered: "user",
      startGen,
      log: emptyLog(),
      transaction,
    });
    const deeper = { identity: aliceS1, key: sessionKey(aliceS1) };
    const deeperGen = fanOutRunStarted(state, deeper);
    fanOutRunFinished(state, deeper, {
      discovered: "session",
      startGen: deeperGen,
      log: emptyLog(),
    });
    fanOutSlotChanged(state, "space", shared, transaction);

    expect(fanOutHoldsSlot(state, deeper.key, "space", shared)).toBe(false);
  });

  it("counts a change whose transaction no run of the node handed over as no run's", () => {
    const state = narrowed();
    run(state, alice, []);
    const transaction = {};
    fanOutRunOpened(state, alice, transaction);
    fanOutSlotChanged(state, "space", shared, transaction);

    expect(fanOutHoldsSlot(state, alice.key, "space", shared)).toBe(false);
  });

  it("forgets the changes to the instances of a viewer who left and keeps those the remaining runs reach", () => {
    const state = narrowed();
    run(state, alice, ["space", alice.key]);
    run(state, bob, ["space", bob.key]);
    pruneFanOutInstances(state, fanOutInstances(state, [aliceS1]));

    expect([...state.slotChanges.keys()].sort()).toEqual(
      [`${alice.key}\0${shared}`, `space\0${shared}`].sort(),
    );
    expect(fanOutHoldsSlot(state, alice.key, "space", shared)).toBe(false);
  });
});
