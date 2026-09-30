import type { MemorySpace } from "@commonfabric/memory/interface";

import type { EnsurePieceVerdict } from "../src/ensure-piece-running.ts";
import type { NormalizedFullLink } from "../src/link-utils.ts";
import type { Runtime } from "../src/runtime.ts";
import {
  deriveEventKey,
  mintEventId,
  scopeCallerEventId,
} from "../src/scheduler/event-identity.ts";
import {
  dropQueuedEvent,
  queueSchedulerEvent,
} from "../src/scheduler/events.ts";
import type { QueuedEvent } from "../src/scheduler/types.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import {
  createSchedulerTestRuntime,
  describe,
  disposeSchedulerTestRuntime,
  expect,
  it,
  space,
} from "./scheduler-test-utils.ts";

const eventLink: NormalizedFullLink = {
  id: "of:event-stream",
  space: "did:key:z6MkEventIdentity" as MemorySpace,
  scope: "space",
  path: [],
};

function eventKey(id: string): string {
  return id.split(":")[1];
}

// A piece-start outcome for the `loadPieceForEvent` seam, carrying only what
// these cases turn on: a started piece has its pattern graph installed.
function pieceLoadVerdict(started: boolean): EnsurePieceVerdict {
  return { started, graphIsInstalled: () => started, observedDocIds: [] };
}

describe("scheduler event identity", () => {
  it("mints sequential ids from the same origin transaction", () => {
    const originTx = {} as IExtendedStorageTransaction;

    const first = mintEventId(eventLink, originTx);
    const second = mintEventId(eventLink, originTx);

    expect(first).toMatch(/^evt:[^:]+:0:of:event-stream$/);
    expect(second).toMatch(/^evt:[^:]+:1:of:event-stream$/);
    expect(eventKey(first)).toBe(eventKey(second));
  });

  it("mints different keys for different origin transactions", () => {
    const first = mintEventId(eventLink, {} as IExtendedStorageTransaction);
    const second = mintEventId(eventLink, {} as IExtendedStorageTransaction);

    expect(eventKey(first)).not.toBe(eventKey(second));
  });

  it("mints distinct ids without an origin transaction", () => {
    const first = mintEventId(eventLink);
    const second = mintEventId(eventLink);

    expect(first).toMatch(/^evt:[^:]+:of:event-stream$/);
    expect(second).toMatch(/^evt:[^:]+:of:event-stream$/);
    expect(first).not.toBe(second);
  });

  it("scopes a caller id deterministically, so a retry re-derives it", () => {
    // A retry may come from a fresh CLI process; same inputs must give the
    // same durable id or the receipt collision never happens.
    expect(scopeCallerEventId("inv-1", "ses-a", eventLink)).toBe(
      scopeCallerEventId("inv-1", "ses-a", eventLink),
    );
    expect(scopeCallerEventId("inv-1", "ses-a", eventLink)).not.toBe(
      scopeCallerEventId("inv-2", "ses-a", eventLink),
    );
  });

  it("separates one caller id chosen in two different sessions", () => {
    // An invocation id is the caller's own word, and `add-comment-1` is the
    // word two agents both reach for. Sharing an address, the second would
    // read the first's receipt and be told its call had settled.
    expect(scopeCallerEventId("add-comment-1", "ses-a", eventLink)).not.toBe(
      scopeCallerEventId("add-comment-1", "ses-b", eventLink),
    );
  });

  it("separates one caller id sent to streams differing only by scope", () => {
    // A per-user, a per-session, and a per-space stream at one id and path
    // are three streams. Sharing an address, a retry against one would be
    // told it had settled by the outcome of a call made against another.
    const perSpace = scopeCallerEventId("inv-1", "ses-a", {
      ...eventLink,
      scope: "space",
    });
    const perUser = scopeCallerEventId("inv-1", "ses-a", {
      ...eventLink,
      scope: "user",
    });
    const perSession = scopeCallerEventId("inv-1", "ses-a", {
      ...eventLink,
      scope: "session",
    });
    expect(perSpace).not.toBe(perUser);
    expect(perSpace).not.toBe(perSession);
    expect(perUser).not.toBe(perSession);
  });

  it("separates one caller id sent to different streams", () => {
    // The defect the helper exists for: an invocation id reused across two
    // verbs of a piece must not make the second collide on the first's
    // receipt and report as an already-settled success.
    const other: NormalizedFullLink = { ...eventLink, id: "of:other-stream" };
    expect(scopeCallerEventId("inv-1", "ses-a", eventLink)).not.toBe(
      scopeCallerEventId("inv-1", "ses-a", other),
    );
  });

  it("distinguishes streams differing only by path or space", () => {
    // Stream links are whole documents at the empty path today; covering
    // path and space keeps the helper from depending on that quietly.
    const atA: NormalizedFullLink = { ...eventLink, path: ["a"] };
    const atB: NormalizedFullLink = { ...eventLink, path: ["b"] };
    expect(scopeCallerEventId("inv-1", "ses-a", atA)).not.toBe(
      scopeCallerEventId("inv-1", "ses-a", atB),
    );
    const elsewhere: NormalizedFullLink = {
      ...eventLink,
      space: "did:key:z6MkOtherEventIdentity" as MemorySpace,
    };
    expect(scopeCallerEventId("inv-1", "ses-a", eventLink)).not.toBe(
      scopeCallerEventId("inv-1", "ses-a", elsewhere),
    );
  });

  it("cannot be confused by a caller id that mimics a delimiter", () => {
    // The caller's halves are opaque and caller-chosen. Under delimited
    // concatenation these pairs render identically; hashing keeps them apart.
    // A link id is a URI, so it always carries a colon of its own — the
    // separator is not distinguishable from the payload by inspection.
    const ofYZ: NormalizedFullLink = { ...eventLink, id: "of:y:z" };
    const yZ: NormalizedFullLink = { ...eventLink, id: "y:z" };
    expect(scopeCallerEventId("x", "s", ofYZ)).not.toBe(
      scopeCallerEventId("x:of", "s", yZ),
    );
    // The same ambiguity across the id/session boundary: a caller chooses
    // both halves, and can choose where a delimiter would appear to sit.
    expect(scopeCallerEventId("inv", "1:ses", eventLink)).not.toBe(
      scopeCallerEventId("inv:1", "ses", eventLink),
    );
  });

  describe("deriveEventKey()", () => {
    const alice = "did:key:z6MkEventKeyAlice" as const;
    const bob = "did:key:z6MkEventKeyBob" as const;
    const service = "did:key:z6MkEventKeyService" as const;

    it("returns the same `evk:` key for the same event, actor and stream", () => {
      const key = deriveEventKey("evt:one", alice, eventLink);
      expect(key).toMatch(/^evk:./);
      expect(deriveEventKey("evt:one", alice, { ...eventLink })).toBe(key);
    });

    it("returns different keys for different event ids", () => {
      expect(deriveEventKey("evt:one", alice, eventLink)).not.toBe(
        deriveEventKey("evt:two", alice, eventLink),
      );
    });

    it("returns different keys for one event id under two actors", () => {
      expect(deriveEventKey("evt:one", alice, eventLink)).not.toBe(
        deriveEventKey("evt:one", bob, eventLink),
      );
    });

    it("returns a key for no actor that no DID shares, the service's included", () => {
      const none = deriveEventKey("evt:one", undefined, eventLink);
      expect(none).not.toBe(deriveEventKey("evt:one", service, eventLink));
      expect(none).not.toBe(deriveEventKey("evt:one", alice, eventLink));
    });

    it("returns different keys for one event id on streams differing by id, path, scope or space", () => {
      const key = deriveEventKey("evt:one", alice, eventLink);
      const others: NormalizedFullLink[] = [
        { ...eventLink, id: "of:other-stream" },
        { ...eventLink, path: ["a"] },
        { ...eventLink, scope: "user" },
        {
          ...eventLink,
          space: "did:key:z6MkOtherEventIdentity" as MemorySpace,
        },
      ];
      for (const other of others) {
        expect(deriveEventKey("evt:one", alice, other)).not.toBe(key);
      }
    });
  });

  it("threads explicit event ids into queued events", () => {
    const eventQueue: QueuedEvent[] = [];
    const originTx = {} as IExtendedStorageTransaction;
    const handler = () => {};

    queueSchedulerEvent({
      runtime: {} as Runtime,
      eventHandlers: [[eventLink, handler]],
      eventQueue,
      backgroundTasks: new Set(),
      queueExecution: () => {},
      recordLineageEvent: () => {},
      releaseLineageEvent: () => {},
    }, {
      eventLink,
      event: { value: 1 },
      retries: true,
      doNotLoadPieceIfNotRunning: false,
      eventId: "evt:provided:0:of:event-stream",
      originTx,
    });

    expect(eventQueue.length).toBe(1);
    expect(eventQueue[0].id).toBe("evt:provided:0:of:event-stream");
    expect(eventQueue[0].originTx).toBe(originTx);
  });

  it("reserves FIFO position while an earlier event loads its handler", async () => {
    const loadingLink: NormalizedFullLink = {
      ...eventLink,
      id: "of:loading-stream",
      space,
    };
    const readyLink: NormalizedFullLink = {
      ...eventLink,
      id: "of:ready-stream",
      space,
    };
    const env = createSchedulerTestRuntime(import.meta.url);
    const handled: string[] = [];
    let finishPieceLoad!: (verdict: EnsurePieceVerdict) => void;
    const pieceLoad = new Promise<EnsurePieceVerdict>((resolve) => {
      finishPieceLoad = resolve;
    });
    try {
      // Inject only the asynchronous piece-start seam; queueing, head parking,
      // dispatch, commits, and continuation all run through the real Scheduler.
      // The seam is a `readonly` optional on the state, so the write narrows
      // the state object rather than the scheduler.
      (env.runtime.scheduler.accessForTestingOnly.eventQueueState as {
        loadPieceForEvent?: () => Promise<EnsurePieceVerdict>;
      }).loadPieceForEvent = () => pieceLoad;

      env.runtime.scheduler.queueEvent(loadingLink, "first");
      env.runtime.scheduler.addEventHandler((_tx, value) => {
        handled.push(String(value));
      }, readyLink);
      env.runtime.scheduler.queueEvent(readyLink, "second");

      // Cross the scheduler's queued task. The ready second handler must not
      // overtake the still-loading FIFO head.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(handled).toEqual([]);

      env.runtime.scheduler.addEventHandler((_tx, value) => {
        handled.push(String(value));
      }, loadingLink);
      finishPieceLoad(pieceLoadVerdict(true));
      await env.runtime.idle();

      expect(handled).toEqual(["first", "second"]);
    } finally {
      finishPieceLoad(pieceLoadVerdict(true));
      await disposeSchedulerTestRuntime(env);
    }
  });

  it("settles a piece-start failure exactly once", async () => {
    const eventQueue: QueuedEvent[] = [];
    const backgroundTasks = new Set<Promise<unknown>>();
    let callbackCount = 0;
    let callbackStatus: string | undefined;
    const droppedTx = {
      abort: () => {},
      status: () => ({ status: "error" }),
    } as unknown as IExtendedStorageTransaction;

    queueSchedulerEvent({
      runtime: { edit: () => droppedTx } as unknown as Runtime,
      eventHandlers: [],
      eventQueue,
      backgroundTasks,
      loadPieceForEvent: () => Promise.reject(new Error("start failed")),
      queueExecution: () => {},
      recordLineageEvent: () => {},
      releaseLineageEvent: () => {},
    }, {
      eventLink,
      event: "payload",
      retries: true,
      doNotLoadPieceIfNotRunning: false,
      onCommit: (commitTx) => {
        callbackCount++;
        callbackStatus = commitTx.status().status;
      },
    });

    await Promise.all([...backgroundTasks]);
    expect(eventQueue).toEqual([]);
    expect(callbackCount).toBe(1);
    expect(callbackStatus).toBe("error");
  });

  it("does not resurrect an event dropped while its handler is loading", async () => {
    const eventQueue: QueuedEvent[] = [];
    const backgroundTasks = new Set<Promise<unknown>>();
    const pieceLoad = Promise.withResolvers<EnsurePieceVerdict>();
    let callbackCount = 0;
    const droppedTx = {
      abort: () => {},
      status: () => ({ status: "error" }),
    } as unknown as IExtendedStorageTransaction;
    const state = {
      runtime: { edit: () => droppedTx } as unknown as Runtime,
      eventHandlers: [],
      eventQueue,
      backgroundTasks,
      loadPieceForEvent: () => pieceLoad.promise,
      queueExecution: () => {},
      recordLineageEvent: () => {},
      releaseLineageEvent: () => {},
    };

    queueSchedulerEvent(state, {
      eventLink,
      event: "payload",
      retries: true,
      doNotLoadPieceIfNotRunning: false,
      onCommit: () => callbackCount++,
    });
    const queued = eventQueue[0];
    expect(queued.handlerLoadPending).toBe(true);

    dropQueuedEvent(state, queued, "lineage failed while loading");
    dropQueuedEvent(state, queued, "duplicate terminal notification");
    pieceLoad.resolve(pieceLoadVerdict(true));
    await Promise.all([...backgroundTasks]);

    expect(eventQueue).toEqual([]);
    expect(callbackCount).toBe(1);
    expect(queued.handlerLoadPending).toBe(true);
  });

  it("a served piece-start deferral carries the arrival-order barrier (events.md §2; review-6459 F1's sibling arm): later-arrived same-space durable served entries defer behind the failed head instead of staying queued to overtake it — cross-space entries and LT1 in-process copies stay queued", async () => {
    // Both piece-load failure modes take the same deferral disposition
    // (`started === false`, and the start THROWING); the barrier must
    // ride both.
    for (
      const loadFailure of [
        () => Promise.reject(new Error("start failed")),
        () => Promise.resolve(pieceLoadVerdict(false)),
      ]
    ) {
      const eventQueue: QueuedEvent[] = [];
      const backgroundTasks = new Set<Promise<unknown>>();
      const headOutcomes: unknown[] = [];
      const followerOutcomes: unknown[] = [];
      const crossSpaceOutcomes: unknown[] = [];
      const lt1Outcomes: unknown[] = [];
      const droppedTx = {
        abort: () => {},
        status: () => ({ status: "error" }),
      } as unknown as IExtendedStorageTransaction;
      const followerLink: NormalizedFullLink = {
        ...eventLink,
        id: "of:follower-stream",
      };
      const crossSpaceLink: NormalizedFullLink = {
        ...eventLink,
        id: "of:cross-space-stream",
        space: "did:key:z6MkOtherEventIdentity" as MemorySpace,
      };
      const lt1Link: NormalizedFullLink = { ...eventLink, id: "of:lt1-stream" };
      const handler = () => {};
      const state = {
        runtime: { edit: () => droppedTx } as unknown as Runtime,
        // No handler for the HEAD's link — it takes the piece-load path;
        // the three later arrivals are all ready-queued.
        eventHandlers: [
          [followerLink, handler],
          [crossSpaceLink, handler],
          [lt1Link, handler],
        ] as [NormalizedFullLink, typeof handler][],
        eventQueue,
        backgroundTasks,
        loadPieceForEvent: loadFailure,
        queueExecution: () => {},
        recordLineageEvent: () => {},
        releaseLineageEvent: () => {},
      };
      queueSchedulerEvent(state, {
        eventLink,
        event: "head",
        retries: true,
        doNotLoadPieceIfNotRunning: false,
        eventId: "evt:barrier-head",
        served: {
          streamEntry: { sidecarId: "of:stream-events:head", index: 0, seq: 1 },
          onFailure: (outcome) => headOutcomes.push(outcome),
        },
      });
      queueSchedulerEvent(state, {
        eventLink: followerLink,
        event: "follower",
        retries: true,
        doNotLoadPieceIfNotRunning: false,
        eventId: "evt:barrier-follower",
        served: {
          streamEntry: {
            sidecarId: "of:stream-events:follower",
            index: 0,
            seq: 2,
          },
          onFailure: (outcome) => followerOutcomes.push(outcome),
        },
      });
      queueSchedulerEvent(state, {
        eventLink: crossSpaceLink,
        event: "cross-space",
        retries: true,
        doNotLoadPieceIfNotRunning: false,
        eventId: "evt:barrier-cross-space",
        served: {
          streamEntry: {
            sidecarId: "of:stream-events:cross-space",
            index: 0,
            seq: 3,
          },
          onFailure: (outcome) => crossSpaceOutcomes.push(outcome),
        },
      });
      queueSchedulerEvent(state, {
        eventLink: lt1Link,
        event: "lt1-copy",
        retries: true,
        doNotLoadPieceIfNotRunning: false,
        eventId: "evt:barrier-lt1",
        // An LT1 in-process copy: served, but NO durable streamEntry —
        // a same-wave cascade child, not a later arrival; never swept.
        served: {
          onFailure: (outcome) => lt1Outcomes.push(outcome),
        },
      });

      await Promise.all([...backgroundTasks]);

      // The head deferred (no consequence; a later drain re-delivers)…
      expect(headOutcomes.length).toBe(1);
      expect((headOutcomes[0] as { kind: string }).kind).toBe("deferred");
      // THE PIN: …and the later-arrived same-space durable entry
      // deferred BEHIND it, instead of staying queued to dispatch — and
      // seal — ahead of the head's re-drain.
      expect(followerOutcomes).toEqual([{
        kind: "deferred",
        cause: "arrival-barrier",
        blockedBy: "evt:barrier-head",
      }]);
      // The exclusions hold: cross-space neighbours (§2's order is
      // per-space) and LT1 copies stay queued, untouched.
      expect(crossSpaceOutcomes).toEqual([]);
      expect(lt1Outcomes).toEqual([]);
      expect(eventQueue.map((queued) => queued.id)).toEqual([
        "evt:barrier-cross-space",
        "evt:barrier-lt1",
      ]);
    }
  });
});
