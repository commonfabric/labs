import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { resolveScopeKey } from "@commonfabric/memory/v2";
import type { Cell } from "../../src/cell.ts";
import type { ServerRunInfo } from "../../src/runtime.ts";
import { txToReactivityLog } from "../../src/scheduler.ts";
import type { EventHandler } from "../../src/scheduler/types.ts";
import {
  createSchedulerTestRuntime,
  disposeSchedulerTestRuntime,
  type SchedulerTestRuntime,
  space,
} from "../scheduler-test-utils.ts";

const alice = "did:key:guarded-alice";
const bob = "did:key:guarded-bob";

describe("guarded-event-handlers", () => {
  let env: SchedulerTestRuntime;
  let selection: Cell<Record<string, string>>;
  let stream: Cell<number>;
  let calls: string[];
  let probes: string[];
  let presyncs: string[];
  let stamps: ServerRunInfo[];

  beforeEach(async () => {
    env = createSchedulerTestRuntime(import.meta.url, {
      experimental: { serverExecution: true },
    });
    calls = [];
    probes = [];
    presyncs = [];
    stamps = [];
    env.runtime.installSealDestination({
      seal: () => Promise.resolve({ ok: {} }),
    }, {
      runStamper: (tx, info) => {
        if (info.scopeKeyIdentity !== undefined) {
          tx.tx.scopeKeyIdentity = info.scopeKeyIdentity;
        }
        stamps.push(info);
      },
    });
    selection = env.runtime.getCell(space, "guarded-program-selection");
    stream = env.runtime.getCell(space, "guarded-events");
    selection.withTx(env.tx).set({ [alice]: "a", [bob]: "b" });
    stream.withTx(env.tx).set(0);
    await env.tx.commit().settled;
    env.tx = env.runtime.edit();
  });

  afterEach(async () => {
    await disposeSchedulerTestRuntime(env);
  });

  function implementation(key: string, name = key): EventHandler {
    const handler: EventHandler = (tx, event) => {
      const actor = tx.tx.scopeKeyIdentity?.principal;
      calls.push(`${name}:${actor}:${event}`);
      const reads = txToReactivityLog(tx).reads;
      expect(
        reads.some((read) =>
          read.id === selection.getAsNormalizedFullLink().id
        ),
      ).toBe(true);
    };
    Object.defineProperty(handler, "name", { value: name });
    handler.implementationSelection = {
      key,
      matches(tx) {
        const programs = selection.withTx(tx).get();
        const actor = tx.tx.scopeKeyIdentity?.principal;
        return actor !== undefined && programs[actor] === key;
      },
    };
    handler.populateDependencies = (tx) => {
      probes.push(`${name}:${tx.tx.scopeKeyIdentity?.principal}`);
    };
    handler.presyncInputs = (_event, identity) => {
      presyncs.push(`${name}:${identity?.principal}`);
      return Promise.resolve();
    };
    return handler;
  }

  function register(handler: EventHandler) {
    return env.runtime.scheduler.addEventHandler(
      handler,
      stream.getAsNormalizedFullLink(),
    );
  }

  function queue(actor: string, event: number) {
    env.runtime.scheduler.queueEvent(
      stream.getAsNormalizedFullLink(),
      event,
      false,
      undefined,
      false,
      {
        eventId: `${actor}:${event}`,
        served: { firedAt: { user: actor, session: "session" } },
      },
    );
  }

  it("selects each actor's implementation in dependency preflight, presync, and dispatch", async () => {
    register(implementation("a"));
    register(implementation("b"));
    queue(alice, 1);
    queue(bob, 2);
    await env.runtime.idle();
    expect(calls).toEqual([`a:${alice}:1`, `b:${bob}:2`]);
    expect(new Set(probes)).toEqual(new Set([`a:${alice}`, `b:${bob}`]));
    expect(presyncs).toEqual([`a:${alice}`, `b:${bob}`]);
    expect(
      stamps.filter((stamp) => stamp.kind === "event-handler").map(
        ({ actionId, eventId }) => ({ actionId, eventId }),
      ),
    ).toEqual([
      { actionId: "a", eventId: `${alice}:1` },
      { actionId: "b", eventId: `${bob}:2` },
    ]);
  });

  it("parks a pending selected implementation without spinning", async () => {
    const ready = env.runtime.getCell(space, "guarded-input-ready");
    ready.withTx(env.tx).set(false);
    await env.tx.commit().settled;
    env.tx = env.runtime.edit();

    const handler = implementation("a");
    let readinessChecks = 0;
    handler.inputReadiness = (tx) => {
      readinessChecks++;
      return ready.withTx(tx).get()
        ? { ready: true }
        : { ready: false, reason: "pending" };
    };
    handler.populateDependencies = (tx) => {
      ready.withTx(tx).get();
    };
    register(handler);
    queue(alice, 1);

    await env.runtime.idle();
    expect(calls).toEqual([]);
    expect(readinessChecks).toBeGreaterThan(0);
    const checksWhileParked = readinessChecks;
    await env.runtime.idle();
    expect(readinessChecks).toBe(checksWhileParked);
    expect(
      env.runtime.scheduler.accessForTestingOnly.eventQueueState.eventQueue,
    ).toHaveLength(1);
  });

  it("supplies transient demand to every live candidate root at a shared stream", async () => {
    register(implementation("unannotated"));
    register(Object.assign(implementation("a"), {
      schedulerObservationIdentity: {
        pieceId: "piece-a",
        pieceRootId: "of:piece-a",
        demandRootIds: ["of:piece-a", "of:parent-a"],
      },
    }));
    register(Object.assign(implementation("b"), {
      schedulerObservationIdentity: {
        pieceId: "piece-b",
        pieceRootId: "of:piece-b",
      },
    }));
    queue(alice, 1);
    queue(bob, 2);
    const actors = [
      { principal: alice, sessionId: "session" },
      { principal: bob, sessionId: "session" },
    ];
    expect(env.runtime.scheduler.transientEventDemandersFor(["of:piece-b"]))
      .toEqual(actors);
    expect(env.runtime.scheduler.transientEventDemandersFor(["of:piece-a"]))
      .toEqual(actors);
    expect(env.runtime.scheduler.transientEventDemandersFor(["of:parent-a"]))
      .toEqual(actors);
    await env.runtime.idle();
    expect(calls).toEqual([`a:${alice}:1`, `b:${bob}:2`]);
  });

  it("keeps candidate roots demanded before program selection is materialized", async () => {
    const arrivingActor = "did:key:guarded-arriving";
    let selectionProbes = 0;
    for (const key of ["a", "b"]) {
      const candidate = implementation(key);
      const matches = candidate.implementationSelection!.matches;
      candidate.implementationSelection!.matches = (tx) => {
        selectionProbes++;
        return matches(tx);
      };
      register(Object.assign(candidate, {
        schedulerObservationIdentity: {
          pieceId: `piece-${key}`,
          pieceRootId: `of:piece-${key}`,
        },
      }));
    }
    queue(arrivingActor, 1);
    for (const root of ["of:piece-a", "of:piece-b"]) {
      expect(env.runtime.scheduler.transientEventDemandersFor([root]))
        .toEqual([{ principal: arrivingActor, sessionId: "session" }]);
    }
    expect(selectionProbes).toBe(0);
    await env.runtime.idle();
    expect(calls).toEqual([]);
  });

  it("updates candidate roots when a queued implementation is replaced or cancelled", async () => {
    const withRoot = (key: string, root: string) =>
      Object.assign(implementation(key), {
        schedulerObservationIdentity: { pieceId: root, pieceRootId: root },
      });
    const cancelA = register(withRoot("a", "of:piece-a"));
    const cancelOldB = register(withRoot("b", "of:old-b"));
    queue(bob, 1);
    register(withRoot("b", "of:new-b"));
    cancelOldB();
    cancelA();
    expect(env.runtime.scheduler.transientEventDemandersFor([
      "of:piece-a",
      "of:old-b",
    ])).toEqual([]);
    expect(env.runtime.scheduler.transientEventDemandersFor(["of:new-b"]))
      .toEqual([{ principal: bob, sessionId: "session" }]);
    await env.runtime.idle();
    expect(calls).toEqual([`b:${bob}:1`]);
  });

  it("preserves a userless event's explicit identity through selection and presync", async () => {
    const userless = implementation("space");
    userless.implementationSelection!.matches = (tx) => {
      selection.withTx(tx).get();
      const identity = tx.tx.scopeKeyIdentity;
      return identity !== undefined && identity.principal === undefined;
    };
    userless.presyncInputs = (_event, identity) => {
      expect(identity).toEqual({ principal: undefined, sessionId: undefined });
      expect(resolveScopeKey("space", identity!)).toBe("space");
      expect(() => resolveScopeKey("user", identity!)).toThrow(
        "user scoped memory operations require a principal",
      );
      presyncs.push("space");
      return Promise.resolve();
    };
    register(userless);
    env.runtime.scheduler.queueEvent(
      stream.getAsNormalizedFullLink(),
      1,
      false,
      undefined,
      false,
      { eventId: "userless", served: { firedAt: { session: "server" } } },
    );
    await env.runtime.idle();
    expect(calls).toEqual(["space:undefined:1"]);
    expect(probes).toContain("space:undefined");
    expect(presyncs).toEqual(["space"]);
    expect(stamps.find((stamp) => stamp.kind === "event-handler"))
      .toMatchObject({
        scopeKeyIdentity: { principal: undefined, sessionId: undefined },
      });
  });

  it("uses the replacement for an event already queued at the same stream", async () => {
    const cancelOld = register(implementation("a", "old"));
    register(implementation("b"));
    queue(alice, 1);
    const queued = env.runtime.scheduler.accessForTestingOnly.eventQueueState
      .eventQueue[0];
    register(implementation("a", "new"));
    cancelOld();
    queue(bob, 2);
    expect(
      env.runtime.scheduler.accessForTestingOnly.eventQueueState.eventQueue[1]
        .handler,
    ).toBe(queued.handler);
    await env.runtime.idle();
    expect(calls).toEqual([`new:${alice}:1`, `b:${bob}:2`]);
    expect(new Set(probes)).toEqual(new Set([`new:${alice}`, `b:${bob}`]));
  });

  it("cancels one variant without removing another", async () => {
    const cancelA = register(implementation("a"));
    register(implementation("b"));
    cancelA();
    queue(bob, 2);
    await env.runtime.idle();
    expect(calls).toEqual([`b:${bob}:2`]);
  });

  it("finds the current registration after the last variant is cancelled and replaced", async () => {
    const cancel = register(implementation("a", "old"));
    queue(alice, 1);
    cancel();
    register(Object.assign(implementation("a", "new"), {
      schedulerObservationIdentity: {
        pieceId: "guarded-piece",
        pieceRootId: "of:guarded-piece-root",
      },
    }));
    expect(env.runtime.scheduler.transientEventDemandersFor([
      "of:guarded-piece-root",
    ])).toEqual([{ principal: alice, sessionId: "session" }]);
    await env.runtime.idle();
    expect(calls).toEqual([`new:${alice}:1`]);
  });

  it("does not let an earlier cancellation remove a repeated registration of the same function", async () => {
    const handler = implementation("a");
    const cancelOld = register(handler);
    register(handler);
    cancelOld();
    queue(alice, 1);
    await env.runtime.idle();
    expect(calls).toEqual([`a:${alice}:1`]);
  });

  it("does not execute either body when two implementation guards match", async () => {
    register(implementation("a"));
    const overlapping = implementation("b");
    overlapping.implementationSelection!.matches = () => true;
    register(overlapping);
    const failures: unknown[] = [];
    env.runtime.scheduler.queueEvent(
      stream.getAsNormalizedFullLink(),
      1,
      false,
      undefined,
      false,
      {
        eventId: "ambiguous",
        served: {
          firedAt: { user: alice, session: "session" },
          onFailure: (failure) => failures.push(failure),
        },
      },
    );
    await env.runtime.idle();
    expect(calls).toEqual([]);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ kind: "deferred" });
  });

  it("defers an event whose selected implementation is unavailable", async () => {
    register(implementation("b"));
    const failures: unknown[] = [];
    env.runtime.scheduler.queueEvent(
      stream.getAsNormalizedFullLink(),
      1,
      false,
      undefined,
      false,
      {
        eventId: "unavailable",
        served: {
          firedAt: { user: alice, session: "session" },
          onFailure: (failure) => failures.push(failure),
        },
      },
    );
    await env.runtime.idle();
    expect(calls).toEqual([]);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ kind: "deferred" });
  });

  it("defers a replacement that arrives while the prior body is presyncing", async () => {
    const started = Promise.withResolvers<void>();
    const released = Promise.withResolvers<void>();
    const old = implementation("a", "old");
    old.presyncInputs = () => {
      started.resolve();
      return released.promise;
    };
    register(old);
    const failures: unknown[] = [];
    env.runtime.scheduler.queueEvent(
      stream.getAsNormalizedFullLink(),
      1,
      false,
      undefined,
      false,
      {
        eventId: "replaced-during-presync",
        served: {
          firedAt: { user: alice, session: "session" },
          onFailure: (failure) => failures.push(failure),
        },
      },
    );
    try {
      await started.promise;
      register(implementation("a", "new"));
    } finally {
      released.resolve();
    }
    await env.runtime.idle();
    expect(calls).toEqual([]);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ kind: "deferred" });
    queue(alice, 2);
    await env.runtime.idle();
    expect(calls).toEqual([`new:${alice}:2`]);
  });
});
