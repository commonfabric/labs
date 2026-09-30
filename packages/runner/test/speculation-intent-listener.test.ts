// The speculation overlay's INTENT LISTENER (server-execution v2 stage C
// design (e), RULED 2026-08-18; speculation.md §4 step 2, §5; events.md
// §5): the client watches its fired intents' stream sidecar for the
// tracked entry's own `consequenced` / `status` / `error` mark — the
// SANCTIONED value-plane carrier of the pushed commit's `consequenceOf`
// — through ONE non-reactive storage-notification listener keyed on the
// OUTSTANDING intent set, not through a schema-less whole-sidecar
// `cell.sink` (a scheduler effect that re-read every entry, followed
// payload links, and paid the CFC probe on every sidecar change:
// O(entries²) per change, the attribution's dominant client term).
//
// Pins 1–11 (design §3.4), each with its killing mutation (3 and 4 are
// folded into pin 1's step; 11 is the OFF witness), plus the pins the
// independent review of W2 added (MAJ-1, MIN-1, MIN-4 — named by
// finding):
//  1. a consequenced / dropped / errored mark on a TRACKED id retires the
//     intent (mutation: listener never installed → the intent stays
//     outstanding; the echo would linger until the watermark backstop);
//  2. a mark on an UNTRACKED id is ignored (mutation: drop the
//     outstanding-set guard);
//  3. outcome subscribers hear dropped / errored, never consequenced;
//  4. waitForIntentConsequence resolves for each terminal kind, memo
//     consumed;
//  5. per-check cost O(outstanding): 1000 consequenced entries + 1
//     outstanding → the mark's check visits ≤ 2 entries and mints ZERO
//     transactions (mutation witness: a full scan visits 1001; a
//     tx-minting check calls runtime.edit);
//  6. no scheduler effect: no `sink:…/of:stream-events:` node in the
//     graph after a fire (mutation: keep the cell.sink) — e2e;
//  7. a duplicate fire whose consequence already landed resolves AT
//     trackIntent and leaks no listener (mutation: skip the immediate
//     check);
//  8. close() releases the listener; no check runs after close (mutation:
//     forget the release);
//  9. the check runs in a MICROTASK, never inside notification dispatch
//     (mutation: act inline);
// 10. the check has run by the time `storageManager.synced()` /
//     `runtime.idle()` armed at the mark's frame resolve, and by the
//     time the mark is VISIBLE on a macrotask poll — no extra turn (the
//     timing guard, e2e; mutation: defer the check to a macrotask);
// 11. OFF byte-identity: no overlay, no listener OFF (e2e);
// MAJ-1. a re-entrant trackIntent inside an outcome callback applies
//     each retired id exactly once (mutation: gate the check on its
//     pre-loop snapshot instead of the LIVE tracked set);
// MIN-1. one notification spanning two tracked sidecars checks both
//     (mutation: record only the first wanted change per notification);
// MIN-4. the sidecar watch is re-kicked on every fire, so a transient
//     first-sync failure heals (mutation: kick once per sidecar state).
// W2.1 (the cascade-echo stranding, W0 l3's "duplicate join" as W3
//     root-caused it): `retireIntent(P)` also retires P's CLIENT CASCADE
//     descendants — pins W2.1-1…4 (scripted, the mark path; see the
//     section header below) and the W2.1 e2e pin in the end-to-end
//     describe (the lunch join shape through the real path: RED on the
//     tip, the echo stands forever).

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";
import * as Engine from "@commonfabric/memory/v2/engine";
import {
  SERVER_EXECUTION_EFFECTS_DOC_ID,
  type StreamEventsDocValue,
} from "@commonfabric/memory/v2";
import { sendEvent } from "../src/cell.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { Runtime } from "../src/runtime.ts";
import type {
  IExtendedStorageTransaction,
  IStorageNotification,
  MemorySpace,
} from "../src/storage/interface.ts";
import { ExecutorHost } from "../src/executor/host.ts";
import {
  SpeculationOverlayDestination,
  stampSpeculationRunContext,
} from "../src/speculation/overlay-destination.ts";
import { getLoggerCountsBreakdown } from "@commonfabric/utils/logger";
import { newSharedServer } from "./memory-v2-test-utils.ts";
import {
  flushMicrotasks,
  scriptedIntentManager,
} from "./speculation-intent-test-utils.ts";

const SPACE = "did:key:z6MkIntentListenerSpace" as MemorySpace;
const SIDECAR = "of:stream-events:listener-a";

/** A destination over the scripted notification seam. `edit` throws and
 * counts: the intent path must never mint a transaction. */
const scriptedDestination = () => {
  const scripted = scriptedIntentManager();
  let edits = 0;
  const runtime = {
    storageManager: scripted.manager,
    edit: () => {
      edits += 1;
      throw new Error("the intent path must not mint transactions");
    },
    getCellFromLink: () => {
      throw new Error("the intent path must not build cells");
    },
  } as never;
  const destination = new SpeculationOverlayDestination(runtime);
  return { scripted, destination, edits: () => edits };
};

Deno.test("intent listener stops visiting hinted indices once the only pending intent is found", async () => {
  const { scripted, destination } = scriptedDestination();
  scripted.seed(SPACE, SIDECAR, {
    entries: [
      { eventId: "mine", stream: { id: "s", path: [] }, seq: 1 },
      { eventId: "other", stream: { id: "s", path: [] }, seq: 2 },
    ],
  });
  destination.trackIntent(SPACE, SIDECAR, "mine");
  const visitsBefore = destination.intentCheckVisits;

  scripted.deliver(SPACE, SIDECAR, (value) => {
    value.entries![0].consequenced = true;
  }, [
    ["value", "entries", "0", "consequenced"],
    ["value", "entries", "1", "consequenced"],
  ]);
  await flushMicrotasks();

  expect(destination.pendingIntentCount).toBe(0);
  expect(destination.intentCheckVisits - visitsBefore).toBe(1);
  destination.close();
});

describe("intent listener — scripted notification seam (design (e) pins 1–5, 7–9; review pins MAJ-1, MIN-1, MIN-4)", () => {
  it("pin 1 + 3 + 4: a consequenced mark retires SILENTLY; errored and dropped marks retire AND signal; waitForIntentConsequence resolves per terminal kind (memo consumed); the listener releases with the last tracked id", async () => {
    const { scripted, destination, edits } = scriptedDestination();
    const outcomes: string[] = [];
    const unsubscribe = destination.subscribeIntentOutcomes((outcome) => {
      outcomes.push(`${outcome.kind}:${outcome.eventId}`);
    });
    scripted.seed(SPACE, SIDECAR, { entries: [] });

    destination.trackIntent(SPACE, SIDECAR, "evt-1");
    destination.trackIntent(SPACE, SIDECAR, "evt-2");
    destination.trackIntent(SPACE, SIDECAR, "evt-3");
    expect(destination.pendingIntentCount).toBe(3);
    // The listener is installed ONCE, and the sidecar is kept watched
    // through the schema-less selector (contract points 2(i)/2(ii)) —
    // the watch is kicked on EVERY fire (a covered watch is a replica
    // no-op; a transiently failed one is retried — review MIN-4).
    expect(destination.intentListenerInstalled).toBe(true);
    expect(scripted.subscribers.size).toBe(1);
    expect(scripted.syncs).toEqual(
      Array(3).fill(`${SPACE}\0${SIDECAR}\0space`),
    );

    // The appends land (no marks yet): the intents stay outstanding.
    scripted.deliver(SPACE, SIDECAR, (value) => {
      value.entries = [
        { eventId: "evt-1", stream: { id: "s", path: [] }, seq: 1 },
        { eventId: "evt-2", stream: { id: "s", path: [] }, seq: 2 },
        { eventId: "evt-3", stream: { id: "s", path: [] }, seq: 3 },
      ];
    }, [["value", "entries"]]);
    await flushMicrotasks();
    expect(destination.pendingIntentCount).toBe(3);

    // consequenced: retires silently (no outcome signal); the waiter
    // resolves `consequenced`.
    const consequenced = destination.waitForIntentConsequence(SPACE, "evt-1");
    scripted.deliver(SPACE, SIDECAR, (value) => {
      value.entries![0].consequenced = true;
    }, [["value", "entries", "0", "consequenced"]]);
    await flushMicrotasks();
    expect((await consequenced).kind).toBe("consequenced");
    expect(destination.pendingIntentCount).toBe(2);
    expect(outcomes).toEqual([]);

    // errored: retires AND signals; the memo is consumed by a LATE waiter.
    scripted.deliver(SPACE, SIDECAR, (value) => {
      value.entries![1].consequenced = true;
      value.entries![1].error = "boom";
    }, [
      ["value", "entries", "1", "consequenced"],
      ["value", "entries", "1", "error"],
    ]);
    await flushMicrotasks();
    expect(outcomes).toEqual(["errored:evt-2"]);
    const errored = await destination.waitForIntentConsequence(SPACE, "evt-2");
    expect(errored).toEqual({ kind: "errored", reason: "boom" });
    // ...and consumed: a second waiter would hang (memo gone) — probe by
    // racing it against a resolved sentinel.
    const second = await Promise.race([
      destination.waitForIntentConsequence(SPACE, "evt-2"),
      Promise.resolve("still-waiting"),
    ]);
    expect(second).toBe("still-waiting");

    // dropped: retires AND signals; the LAST tracked id releases the
    // listener (contract point 5) — the subscription is gone.
    scripted.deliver(SPACE, SIDECAR, (value) => {
      value.entries![2].status = "dropped";
      value.entries![2].reason = "gone";
    }, [
      ["value", "entries", "2", "status"],
      ["value", "entries", "2", "reason"],
    ]);
    await flushMicrotasks();
    expect(outcomes).toEqual(["errored:evt-2", "dropped:evt-3"]);
    expect(
      (await destination.waitForIntentConsequence(SPACE, "evt-3")).kind,
    ).toBe("dropped");
    expect(destination.pendingIntentCount).toBe(0);
    expect(destination.intentListenerInstalled).toBe(false);
    expect(scripted.subscribers.size).toBe(0);
    // ZERO transactions on the whole path.
    expect(edits()).toBe(0);

    // The refusal path (a deterministic admission refusal at discharge):
    // retires + signals without any store state, and never re-installs a
    // listener for a set that empties at once.
    destination.trackIntent(SPACE, "of:stream-events:listener-b", "evt-r");
    expect(destination.intentListenerInstalled).toBe(true);
    destination.resolveIntent(SPACE, "of:stream-events:listener-b", "evt-r", {
      kind: "refused",
      reason: "undeclared",
    });
    expect(outcomes).toEqual([
      "errored:evt-2",
      "dropped:evt-3",
      "refused:evt-r",
    ]);
    expect(destination.intentListenerInstalled).toBe(false);
    unsubscribe();
    destination.close();
  });

  it("pin 2: a mark on an UNTRACKED id is ignored — no signal, no retirement, the tracked id stays outstanding (mutation: drop the outstanding-set guard → the untracked entry's drop notice signals)", async () => {
    const { scripted, destination } = scriptedDestination();
    const outcomes: string[] = [];
    destination.subscribeIntentOutcomes((outcome) => {
      outcomes.push(`${outcome.kind}:${outcome.eventId}`);
    });
    scripted.seed(SPACE, SIDECAR, {
      entries: [
        { eventId: "other-1", stream: { id: "s", path: [] }, seq: 1 },
        { eventId: "mine", stream: { id: "s", path: [] }, seq: 2 },
      ],
    });
    destination.trackIntent(SPACE, SIDECAR, "mine");
    // Another client's entry drops; mine is untouched.
    scripted.deliver(SPACE, SIDECAR, (value) => {
      value.entries![0].status = "dropped";
      value.entries![0].reason = "theirs";
    }, [["value", "entries", "0", "status"]]);
    await flushMicrotasks();
    expect(outcomes).toEqual([]);
    expect(destination.pendingIntentCount).toBe(1);
    expect(destination.intentListenerInstalled).toBe(true);
    // A mark on an untracked id in the SAME check as mine: only mine acts.
    scripted.deliver(SPACE, SIDECAR, (value) => {
      value.entries![0].consequenced = true;
      value.entries![1].consequenced = true;
      value.entries![1].error = "mine-failed";
    }, [
      ["value", "entries", "0", "consequenced"],
      ["value", "entries", "1", "consequenced"],
      ["value", "entries", "1", "error"],
    ]);
    await flushMicrotasks();
    expect(outcomes).toEqual(["errored:mine"]);
    expect(destination.pendingIntentCount).toBe(0);
    destination.close();
  });

  it("skips a stream entry that is not an object and retires the tracked intent from a later well-formed one (mutation: drop the shape guard \u2014 the check reads `eventId` off a primitive and the whole check throws, stranding the intent)", async () => {
    // The sidecar's entries are stored data, so their shape is not
    // guaranteed by the type the check reads them through. A malformed
    // entry is skipped rather than fatal: the entries after it are still
    // considered, and the intent still retires.

    const { scripted, destination } = scriptedDestination();
    const outcomes: string[] = [];
    destination.subscribeIntentOutcomes((outcome) => {
      outcomes.push(`${outcome.kind}:${outcome.eventId}`);
    });
    scripted.seed(SPACE, SIDECAR, {
      entries: [
        null,
        "not-an-entry",
        7,
        { eventId: "mine", stream: { id: "s", path: [] }, seq: 4 },
      ] as unknown as StreamEventsDocValue["entries"],
    });
    destination.trackIntent(SPACE, SIDECAR, "mine");
    expect(destination.pendingIntentCount).toBe(1);

    scripted.deliver(SPACE, SIDECAR, (value) => {
      value.entries![3].status = "dropped";
      value.entries![3].reason = "gone";
    }, [
      ["value", "entries", "3", "status"],
      ["value", "entries", "3", "reason"],
    ]);
    await flushMicrotasks();
    expect(outcomes).toEqual(["dropped:mine"]);
    expect(destination.pendingIntentCount).toBe(0);
    destination.close();
  });

  it("pin 5: per-check cost is O(outstanding), never O(history): a sidecar with 1000 consequenced entries and ONE outstanding intent — the mark's check visits ≤ 2 entries and mints zero transactions (mutation witness: a full scan visits 1001)", async () => {
    const { scripted, destination, edits } = scriptedDestination();
    const history = Array.from({ length: 1000 }, (_, index) => ({
      eventId: `old-${index}`,
      stream: { id: "s", path: [] },
      seq: index + 1,
      consequenced: true,
    }));
    scripted.seed(SPACE, SIDECAR, { entries: history });
    // A fresh fire: the immediate check finds no entry (the append has
    // not landed) — ONE raw array walk at trackIntent, no transaction.
    destination.trackIntent(SPACE, SIDECAR, "fresh");
    const visitsAfterTrack = destination.intentCheckVisits;
    expect(destination.intentCheckCount).toBe(1);
    expect(visitsAfterTrack).toBe(1000);
    // The append lands at the tail (no index in the change path): the
    // backward scan locates it in ONE visit and stops.
    scripted.deliver(SPACE, SIDECAR, (value) => {
      value.entries!.push({
        eventId: "fresh",
        stream: { id: "s", path: [] },
        seq: 1001,
      });
    }, [["value", "entries"]]);
    await flushMicrotasks();
    expect(destination.intentCheckCount).toBe(2);
    expect(destination.intentCheckVisits - visitsAfterTrack).toBe(1);
    expect(destination.pendingIntentCount).toBe(1);
    // The MARK arrives with its leaf path: the verified hint locates the
    // entry directly — one visit, the intent resolves, zero transactions.
    const before = destination.intentCheckVisits;
    scripted.deliver(SPACE, SIDECAR, (value) => {
      value.entries![1000].consequenced = true;
    }, [["value", "entries", "1000", "consequenced"]]);
    await flushMicrotasks();
    expect(destination.intentCheckCount).toBe(3);
    expect(destination.intentCheckVisits - before).toBeLessThanOrEqual(2);
    expect(destination.pendingIntentCount).toBe(0);
    expect(edits()).toBe(0);
    // A STALE hint (the index moved: a concurrent entry landed ahead of
    // ours) is verified by eventId and falls back to the tail scan —
    // still O(outstanding), never a wrong resolution.
    destination.trackIntent(SPACE, SIDECAR, "moved");
    scripted.deliver(SPACE, SIDECAR, (value) => {
      value.entries!.push(
        { eventId: "theirs", stream: { id: "s", path: [] }, seq: 1002 },
        { eventId: "moved", stream: { id: "s", path: [] }, seq: 1003 },
      );
    }, [["value", "entries"]]);
    await flushMicrotasks();
    const beforeStale = destination.intentCheckVisits;
    scripted.deliver(SPACE, SIDECAR, (value) => {
      // The mark lands on index 1002 ("moved"); the delivered hint names
      // 1001 ("theirs") — a moved index.
      value.entries![1002].consequenced = true;
    }, [["value", "entries", "1001", "consequenced"]]);
    await flushMicrotasks();
    expect(destination.pendingIntentCount).toBe(0);
    expect(destination.intentCheckVisits - beforeStale).toBeLessThanOrEqual(3);
    destination.close();
  });

  it("pin 7: a duplicate fire whose consequence ALREADY landed resolves at trackIntent (T25) — the waiter resolves at once, no listener is installed, nothing leaks (mutation: skip the immediate check → the listener installs and the intent stays outstanding)", async () => {
    const { scripted, destination } = scriptedDestination();
    scripted.seed(SPACE, SIDECAR, {
      entries: [
        {
          eventId: "old-1",
          stream: { id: "s", path: [] },
          seq: 1,
          consequenced: true,
        },
        {
          eventId: "dup",
          stream: { id: "s", path: [] },
          seq: 2,
          consequenced: true,
        },
      ],
    });
    destination.trackIntent(SPACE, SIDECAR, "dup");
    expect(destination.pendingIntentCount).toBe(0);
    expect(destination.intentListenerInstalled).toBe(false);
    expect(scripted.subscribers.size).toBe(0);
    expect(
      (await destination.waitForIntentConsequence(SPACE, "dup")).kind,
    ).toBe("consequenced");
    // The sidecar was still put on watch (the stream stays subscribed).
    expect(scripted.syncs.length).toBe(1);
    // A second live intent on the same sidecar installs the listener.
    destination.trackIntent(SPACE, SIDECAR, "live");
    expect(destination.intentListenerInstalled).toBe(true);
    expect(destination.intentListenerInstallCount).toBe(1);
    destination.close();
  });

  it("pin 8: close() releases the listener and no check runs after it (mutation: forget the release → the subscription survives and a later delivery still checks)", async () => {
    const { scripted, destination } = scriptedDestination();
    scripted.seed(SPACE, SIDECAR, { entries: [] });
    destination.trackIntent(SPACE, SIDECAR, "evt-1");
    expect(scripted.subscribers.size).toBe(1);
    const checksBefore = destination.intentCheckCount;
    // A delivery already dispatched (its microtask pending) when close()
    // runs must not check either.
    scripted.deliver(SPACE, SIDECAR, (value) => {
      value.entries = [{
        eventId: "evt-1",
        stream: { id: "s", path: [] },
        seq: 1,
        consequenced: true,
      }];
    }, [["value", "entries"]]);
    destination.close();
    await flushMicrotasks();
    expect(scripted.subscribers.size).toBe(0);
    expect(destination.intentCheckCount).toBe(checksBefore);
    // Nothing after close subscribes or checks.
    destination.trackIntent(SPACE, SIDECAR, "evt-2");
    scripted.deliver(SPACE, SIDECAR, () => {}, [["value", "entries"]]);
    await flushMicrotasks();
    expect(scripted.subscribers.size).toBe(0);
    expect(destination.intentCheckCount).toBe(checksBefore);
  });

  it("pin 9: the check runs in a MICROTASK, never inside the notification dispatch — a subscriber's outcome callback observes no dispatch on the stack; the intent is still outstanding when `next` returns (mutation: act inline → the callback runs mid-dispatch)", async () => {
    const { scripted, destination } = scriptedDestination();
    let sawDispatching: boolean | undefined;
    destination.subscribeIntentOutcomes(() => {
      sawDispatching = scripted.dispatching();
    });
    scripted.seed(SPACE, SIDECAR, {
      entries: [{ eventId: "evt-1", stream: { id: "s", path: [] }, seq: 1 }],
    });
    destination.trackIntent(SPACE, SIDECAR, "evt-1");
    scripted.deliver(SPACE, SIDECAR, (value) => {
      value.entries![0].status = "dropped";
      value.entries![0].reason = "late";
    }, [["value", "entries", "0", "status"]]);
    // Synchronously after dispatch: nothing acted yet.
    expect(destination.pendingIntentCount).toBe(1);
    expect(sawDispatching).toBeUndefined();
    await flushMicrotasks();
    expect(destination.pendingIntentCount).toBe(0);
    expect(sawDispatching).toBe(false);
    // A burst of notifications coalesces into ONE check per sidecar.
    destination.trackIntent(SPACE, SIDECAR, "evt-2");
    const checks = destination.intentCheckCount;
    scripted.deliver(SPACE, SIDECAR, () => {}, [["value", "entries"]]);
    scripted.deliver(SPACE, SIDECAR, () => {}, [["value", "entries"]]);
    scripted.deliver(SPACE, SIDECAR, () => {}, [["value", "eventWatermark"]]);
    await flushMicrotasks();
    expect(destination.intentCheckCount).toBe(checks + 1);
    // A storage RESET re-checks every tracked sidecar in the space (the
    // doc may have been re-populated), still off the dispatch stack.
    scripted.reset(SPACE);
    await flushMicrotasks();
    expect(destination.intentCheckCount).toBe(checks + 2);
    destination.close();
  });

  it("review MAJ-1: a RE-ENTRANT trackIntent inside an outcome callback (a retry-on-drop UI subscriber re-firing on the same sidecar) applies each retired id exactly ONCE — the outer check re-reads the LIVE tracked set per entry, never its pre-loop snapshot (mutation: gate `consider` on the snapshot only → `dropped:X` is delivered twice and a stale memo is left behind)", async () => {
    const { scripted, destination } = scriptedDestination();
    const outcomes: string[] = [];
    const consequences: Array<Promise<{ kind: string }>> = [];
    let refired = false;
    destination.subscribeIntentOutcomes((outcome) => {
      outcomes.push(`${outcome.kind}:${outcome.eventId}`);
      // The UI hook events.md §5 mandates, consuming the memo as it
      // hears the outcome (the send path's durable-ack coupling does
      // exactly this) ...
      consequences.push(
        destination.waitForIntentConsequence(outcome.space, outcome.eventId),
      );
      // ... and re-firing ONCE on the first drop: a fresh intent on the
      // SAME sidecar, whose `trackIntent` runs an INNER immediate check
      // while the OUTER check is still iterating its hinted indices.
      if (!refired) {
        refired = true;
        destination.trackIntent(SPACE, SIDECAR, "retry");
      }
    });
    scripted.seed(SPACE, SIDECAR, {
      entries: [
        { eventId: "X", stream: { id: "s", path: [] }, seq: 1 },
        { eventId: "Z", stream: { id: "s", path: [] }, seq: 2 },
      ],
    });
    destination.trackIntent(SPACE, SIDECAR, "X");
    destination.trackIntent(SPACE, SIDECAR, "Z");
    expect(destination.pendingIntentCount).toBe(2);
    // ONE notification marks both dropped; the hints name Z first, then
    // X — so the outer check retires Z, the subscriber re-fires, the
    // inner check retires X from the tail, and the outer check then
    // reaches its hint for X with X already retired.
    scripted.deliver(SPACE, SIDECAR, (value) => {
      value.entries![0].status = "dropped";
      value.entries![0].reason = "x-gone";
      value.entries![1].status = "dropped";
      value.entries![1].reason = "z-gone";
    }, [
      ["value", "entries", "1", "status"],
      ["value", "entries", "0", "status"],
    ]);
    await flushMicrotasks();
    // Exactly one outcome per retired id, in retirement order.
    expect(outcomes).toEqual(["dropped:Z", "dropped:X"]);
    // Only the retry is outstanding; the listener stays for it.
    expect(destination.pendingIntentCount).toBe(1);
    expect(destination.intentListenerInstalled).toBe(true);
    // Each consequence settled once, as the outcome said ...
    expect((await Promise.all(consequences)).map((c) => c.kind)).toEqual([
      "dropped",
      "dropped",
    ]);
    // ... and no ORPHANED memo was left by a second settle: a fresh
    // waiter for X hangs (memo consumed by the subscriber above).
    const again = await Promise.race([
      destination.waitForIntentConsequence(SPACE, "X"),
      Promise.resolve("still-waiting"),
    ]);
    expect(again).toBe("still-waiting");
    destination.close();
  });

  it("review MIN-1: ONE notification whose merged changes span TWO tracked sidecars (one frame carrying a wave commit that marks two streams this client fired) checks BOTH — each sidecar gets its own coalesced check, both intents retire (mutation: record only the first wanted change per notification → the second sidecar's intent stays outstanding until its next own change)", async () => {
    const { scripted, destination, edits } = scriptedDestination();
    const SIDECAR_B = "of:stream-events:listener-b";
    scripted.seed(SPACE, SIDECAR, {
      entries: [{ eventId: "a-1", stream: { id: "s", path: [] }, seq: 1 }],
    });
    scripted.seed(SPACE, SIDECAR_B, {
      entries: [{ eventId: "b-1", stream: { id: "t", path: [] }, seq: 1 }],
    });
    destination.trackIntent(SPACE, SIDECAR, "a-1");
    destination.trackIntent(SPACE, SIDECAR_B, "b-1");
    expect(destination.pendingIntentCount).toBe(2);
    expect(scripted.subscribers.size).toBe(1);
    const checks = destination.intentCheckCount;
    const waitA = destination.waitForIntentConsequence(SPACE, "a-1");
    const waitB = destination.waitForIntentConsequence(SPACE, "b-1");
    // One frame, one notification, changes on both docs — A's mark first
    // in the merged list, B's second.
    scripted.deliverMany(SPACE, [
      {
        id: SIDECAR,
        mutate: (value) => {
          value.entries![0].consequenced = true;
        },
        paths: [["value", "entries", "0", "consequenced"]],
      },
      {
        id: SIDECAR_B,
        mutate: (value) => {
          value.entries![0].consequenced = true;
        },
        paths: [["value", "entries", "0", "consequenced"]],
      },
    ]);
    // Nothing acts inline ...
    expect(destination.pendingIntentCount).toBe(2);
    await flushMicrotasks();
    // ... then ONE check per sidecar, and both intents are retired.
    expect(destination.intentCheckCount).toBe(checks + 2);
    expect(destination.pendingIntentCount).toBe(0);
    expect((await waitA).kind).toBe("consequenced");
    expect((await waitB).kind).toBe("consequenced");
    expect(destination.intentListenerInstalled).toBe(false);
    expect(edits()).toBe(0);
    destination.close();
  });

  it("review MIN-4: the sidecar WATCH is re-kicked on EVERY fire, not once per sidecar — a transient failure of the first `sync` (loud: `intent-watch-failed`) heals on the next trackIntent on that stream instead of leaving it unwatched until the set drains (mutation: kick only when the sidecar state is created → the second fire issues no sync)", async () => {
    const { scripted, destination } = scriptedDestination();
    const failures = () =>
      getLoggerCountsBreakdown()["speculation-overlay"]
        ?.["intent-watch-failed"]?.total ?? 0;
    const failuresBefore = failures();
    scripted.seed(SPACE, SIDECAR, { entries: [] });
    // The first fire's watch kick fails transiently (the pull errored:
    // the replica dropped its tracker entry, nothing is watching).
    scripted.failNextSync();
    destination.trackIntent(SPACE, SIDECAR, "evt-1");
    expect(scripted.syncs.length).toBe(1);
    await flushMicrotasks();
    expect(failures()).toBe(failuresBefore + 1);
    expect(destination.pendingIntentCount).toBe(1);
    // A second fire on the SAME sidecar while the first is outstanding
    // re-issues the watch (a covered watch is a replica no-op; a failed
    // one is retried here).
    destination.trackIntent(SPACE, SIDECAR, "evt-2");
    expect(scripted.syncs.length).toBe(2);
    expect(scripted.syncs[1]).toBe(`${SPACE}\0${SIDECAR}\0space`);
    await flushMicrotasks();
    expect(failures()).toBe(failuresBefore + 1);
    destination.close();
  });

  it("quiescence waiter: waitForIntentQuiescence resolves when the LAST outstanding intent retires — not on an earlier retire — immediately when nothing is outstanding, and on close", async () => {
    const { scripted, destination } = scriptedDestination();
    scripted.seed(SPACE, SIDECAR, { entries: [] });

    // Nothing outstanding: resolves immediately (probe by flag — a race
    // against a bare resolved sentinel loses by one microtask hop).
    let immediate = false;
    destination.waitForIntentQuiescence().then(() => {
      immediate = true;
    });
    await flushMicrotasks();
    expect(immediate).toBe(true);

    destination.trackIntent(SPACE, SIDECAR, "evt-1");
    destination.trackIntent(SPACE, SIDECAR, "evt-2");
    scripted.deliver(SPACE, SIDECAR, (value) => {
      value.entries = [
        { eventId: "evt-1", stream: { id: "s", path: [] }, seq: 1 },
        { eventId: "evt-2", stream: { id: "s", path: [] }, seq: 2 },
      ];
    }, [["value", "entries"]]);
    await flushMicrotasks();
    expect(destination.pendingIntentCount).toBe(2);

    let resolved = false;
    const quiesced = destination.waitForIntentQuiescence().then(() => {
      resolved = true;
    });

    // First retire: ONE intent still outstanding — the waiter must NOT
    // resolve (killing mutation: flushing on every untrack instead of on
    // the set emptying trips here).
    scripted.deliver(SPACE, SIDECAR, (value) => {
      value.entries![0].consequenced = true;
    }, [["value", "entries", "0", "consequenced"]]);
    await flushMicrotasks();
    expect(destination.pendingIntentCount).toBe(1);
    expect(resolved).toBe(false);

    // Last retire (a dropped mark is equally terminal): the set empties,
    // the waiter resolves.
    scripted.deliver(SPACE, SIDECAR, (value) => {
      value.entries![1].status = "dropped";
      value.entries![1].reason = "gone";
    }, [
      ["value", "entries", "1", "status"],
      ["value", "entries", "1", "reason"],
    ]);
    await flushMicrotasks();
    await quiesced;
    expect(resolved).toBe(true);

    // Close settles a parked waiter (nothing can retire afterwards).
    destination.trackIntent(SPACE, SIDECAR, "evt-3");
    const parked = destination.waitForIntentQuiescence();
    destination.close();
    await parked;
  });

  it("quiescence waiter, two sidecars: draining ONE sidecar's whole set while another sidecar still holds an intent does NOT resolve the waiter (killing mutation: flushing when a sidecar's set empties instead of when the whole tracked map does)", async () => {
    const { scripted, destination } = scriptedDestination();
    const SIDECAR_B = "of:stream-events:listener-b";
    scripted.seed(SPACE, SIDECAR, { entries: [] });
    scripted.seed(SPACE, SIDECAR_B, { entries: [] });

    destination.trackIntent(SPACE, SIDECAR, "evt-a");
    destination.trackIntent(SPACE, SIDECAR_B, "evt-b");
    scripted.deliver(SPACE, SIDECAR, (value) => {
      value.entries = [
        { eventId: "evt-a", stream: { id: "s", path: [] }, seq: 1 },
      ];
    }, [["value", "entries"]]);
    scripted.deliver(SPACE, SIDECAR_B, (value) => {
      value.entries = [
        { eventId: "evt-b", stream: { id: "s2", path: [] }, seq: 1 },
      ];
    }, [["value", "entries"]]);
    await flushMicrotasks();
    expect(destination.pendingIntentCount).toBe(2);

    let resolved = false;
    const quiesced = destination.waitForIntentQuiescence().then(() => {
      resolved = true;
    });

    // Retire evt-a: sidecar A's set drains ENTIRELY (its per-sidecar Set
    // empties and is deleted) while sidecar B still holds evt-b. The
    // one-sidecar pin above cannot see this arm — its first retire
    // leaves the shared sidecar's set non-empty — so this is the pin
    // for the sidecar-drain flush mutant.
    scripted.deliver(SPACE, SIDECAR, (value) => {
      value.entries![0].consequenced = true;
    }, [["value", "entries", "0", "consequenced"]]);
    await flushMicrotasks();
    expect(destination.pendingIntentCount).toBe(1);
    expect(resolved).toBe(false);

    // Retire evt-b: the whole tracked map empties; the waiter resolves.
    scripted.deliver(SPACE, SIDECAR_B, (value) => {
      value.entries![0].consequenced = true;
    }, [["value", "entries", "0", "consequenced"]]);
    await flushMicrotasks();
    await quiesced;
    expect(resolved).toBe(true);
    destination.close();
  });
});

//
// W2.1: the cascade-echo retirement (scripted; the MARK path)
//
// W0 l3's "duplicate join", root-caused by W3 as a CLIENT cascade-echo
// stranding (speculation.md §4 step 2's jobless-cascade consequence,
// applied on ARRIVAL): the click handler's speculative run sends to the
// join stream; that cascade child's echo seals under a client-minted id
// (`mintEventId(link, originTx)`) the server's own LT1 mint never
// equals, so no mark names it, and its frame-caused entity doc (`$event:
// tx.dispatchedEventId`) is an id the server never writes, so the
// sweep's arrival gate never passes — spec-Alice stood beside the
// confirmed Alice forever. `retireIntent(P)` now ALSO retires every live
// entry whose cascade thread (`parentEventId`, recorded at seal) reaches
// P. Pins, red-first (each with the mutation that kills it):
//  W2.1-1. a cascade child's echo is retired when P's consequence mark
//          arrives (mutation: the cascade arm removed — `#cascadeReaches`
//          always false → the child's entry stands);
//  W2.1-2. an entry with an UNRELATED parent, a root echo of another
//          intent, and a cascade of an untracked emitter are NOT retired
//          by P's mark (mutation: the walk accepts any parented entry);
//  W2.1-3. the late-echo rule still holds around it: a LATE child of P
//          and a LATE grandchild of the retired child drop at seal, and a
//          grandchild behind a SILENT child (one that wrote nothing — no
//          entry of its own) is reached through the thread (mutation:
//          the link is not recorded for a no-write child → the grandchild
//          stands); and — F1, combined review 2026-08-19 — a LATE
//          grandchild OF the silent child drops at seal through the
//          ancestry WALK (the silent child never joined the jobless set;
//          the one-level check let it register and strand);
//  W2.1-4. the FLICKER witness counts a cascade echo retired on its
//          parent's consequenced mark while no doc it wrote had landed at
//          or after the mark's frame — including when a concurrent writer
//          moved the doc past the echo's basis first — not one whose
//          written doc rode the mark's frame, and not a dropped parent's
//          cascade (mutations: key on the basis → the concurrent-writer
//          case reads arrived; arm on the drop arm → it counts);
//  W2.1-5. OFF arm unchanged — pin 11's shape stands: the overlay does
//          not exist OFF, and every W2.1 line lives inside it;
//  W2.1-6. the post-sealInto RE-CHECK walks the thread too (F1's second
//          seat): a mark landing while a silent child's grandchild is
//          mid-seal withdraws the collected entry at the re-check;
//  W2.1-7. F6 telemetry: depth-capped walks and thread evictions are
//          counted (`cascadeWalkDepthCapCount` /
//          `cascadeThreadEvictionCount`) — truncation is observable.
//

const W21_SIDECAR = "of:stream-events:w21-click";

/** A destination over the scripted seam WITH the seal seam: entries
 * register through `sealNative`, the replica's retirement view reports
 * per-doc confirmed seqs the test sets, and marks arrive as
 * notifications (the production carrier). */
const cascadeDestination = () => {
  let nextLocalSeq = 10;

  /** The confirmed read seq the NEXT seal reports (the entry's floor). */
  let nextFloor = 40;

  const confirmedSeqs = new Map<string, number>();
  const verdicts = new Map<number, Promise<unknown>>();
  const replica = {
    sealNative: (
      native: { operations: Array<Record<string, unknown>> },
      _source: unknown,
      verdict: Promise<unknown>,
    ) => {
      const localSeq = nextLocalSeq++;
      verdicts.set(localSeq, verdict);
      return {
        localSeq,
        commit: {
          localSeq,
          reads: {
            confirmed: [{ id: "of:w21-basis", seq: nextFloor }],
            pending: [],
          },
          operations: native.operations,
        },
        settled: verdict.then(() => undefined, () => undefined),
      };
    },
    speculationRetirementView: (id: string) => ({
      confirmedSeq: confirmedSeqs.get(id) ?? 0,
      pendingLocalSeqs: [] as number[],
    }),
    ackedSeqOf: () => undefined,
    speculationAckObserver: undefined as (() => void) | undefined,
    speculationArrivalObserver: undefined,
  };
  const scripted = scriptedIntentManager({ replica });
  const runtime = {
    storageManager: scripted.manager,
    edit: () => {
      throw new Error("the intent path must not mint transactions");
    },
    getCellFromLink: () => ({ sink: () => () => {} }),
  } as never;
  const destination = new SpeculationOverlayDestination(runtime);

  /** An event-handler echo's transaction: `writes` are whole-doc sets
   * (the lunch shape: the list doc + the new user's entity doc); an
   * empty list seals NOTHING (a child that only forwards). */
  const echoOf = (
    eventId: string,
    options: {
      parentEventId?: string;
      writes: string[];
      floor?: number;

      /** Hold `sealInto` open until this settles — the mid-seal window
       * (the post-await re-check's subject: a mark landing while the
       * seal is in flight). */
      holdSeal?: Promise<void>;
    },
  ) => {
    nextFloor = options.floor ?? 40;
    const tx = {
      tx: {
        sourceAction: { name: "handler" },
        // These doubles hand-build the ops they seal, so the mark has nothing
        // to shape; it is present because the seal refuses a transaction that
        // cannot take it.
        markWholeDocumentWrites: () => {},
        sealInto: async (collector: {
          sealSpaceCommit: (
            space: MemorySpace,
            native: unknown,
            source: unknown,
          ) => Promise<unknown>;
        }) => {
          if (options.holdSeal !== undefined) await options.holdSeal;
          return options.writes.length === 0
            ? { ok: {} }
            : collector.sealSpaceCommit(
              SPACE,
              {
                operations: options.writes.map((id) => ({
                  op: "set",
                  id,
                  scope: "space",
                  value: { v: eventId },
                })),
                preconditions: [],
              },
              { sourceAction: { name: "handler" } },
            ).then(() => ({ ok: {} }));
        },
      },
    } as unknown as IExtendedStorageTransaction;
    stampSpeculationRunContext(tx, {
      actionId: "handler",
      kind: "event-handler",
      eventId,
      ...(options.parentEventId !== undefined
        ? { parentEventId: options.parentEventId }
        : {}),
    });
    return tx;
  };

  /** Land P's append, then its consequenced mark, as two notifications;
   * `landed` sets the confirmed seqs the mark's frame carries (the
   * server's cascade child landing in the same wave, or not). */
  const seedAppend = (eventIds: string[]) => {
    scripted.seed(SPACE, W21_SIDECAR, {
      entries: eventIds.map((eventId, index) => ({
        eventId,
        stream: { id: "s", path: [] },
        seq: index + 1,
      })),
    });
  };

  /** The mark's frame: the sidecar itself lands at `markSeq` (the mark
   * is written in the consequence commit), and `landed` names the docs
   * that commit — or an earlier one — also moved, with their seqs. */
  const markConsequenced = (
    index: number,
    landed: Record<string, number>,
    markSeq = 42 + index,
  ) => {
    for (const [id, seq] of Object.entries(landed)) confirmedSeqs.set(id, seq);
    confirmedSeqs.set(W21_SIDECAR, markSeq);
    scripted.deliver(SPACE, W21_SIDECAR, (value) => {
      value.entries![index].consequenced = true;
    }, [["value", "entries", String(index), "consequenced"]]);
  };

  const markDropped = (index: number, markSeq = 42 + index) => {
    confirmedSeqs.set(W21_SIDECAR, markSeq);
    scripted.deliver(SPACE, W21_SIDECAR, (value) => {
      value.entries![index].status = "dropped";
      value.entries![index].reason = "gone";
    }, [["value", "entries", String(index), "status"]]);
  };
  const verdictOf = async (localSeq: number) => {
    const verdict = verdicts.get(localSeq);
    return verdict === undefined ? undefined : await verdict;
  };
  return {
    scripted,
    destination,
    echoOf,
    seedAppend,
    markConsequenced,
    markDropped,
    confirmedSeqs,
    verdictOf,
  };
};

describe("intent listener — W2.1 cascade-echo retirement (scripted; the jobless-cascade consequence on ARRIVAL)", () => {
  it("W2.1-1: a cascade child's echo (client-minted id, parentEventId = P) is retired when P's consequence MARK arrives — the same `retireIntent` the mark reaches; P's own tracked intent resolves as before; the child's verdict is a superseded withdrawal; counted (mutation: the cascade arm removed → the child's entry stands forever)", async () => {
    const {
      destination,
      echoOf,
      seedAppend,
      markConsequenced,
      verdictOf,
    } = cascadeDestination();
    seedAppend(["evt-click"]);
    destination.trackIntent(SPACE, W21_SIDECAR, "evt-click");
    // The click's own run writes nothing (it only sends): no entry. Its
    // cascade child — joinAs's echo — seals under a client-minted id with
    // the click as its parent, writing the list doc AND the new user's
    // entity doc (an id the server's run never writes).
    expect(
      (await destination.seal(echoOf("evt:client-key:0:of:join", {
        parentEventId: "evt-click",
        writes: ["of:users", "of:alice-client-entity"],
      }))).ok,
    ).toBeDefined();
    expect(destination.entryCount(SPACE)).toBe(1);
    expect(destination.pendingIntentCount).toBe(1);
    // The click's consequence lands: its mark arrives in the frame that
    // also carries the server's join (the list doc moved to seq 42 > the
    // echo's basis 40).
    markConsequenced(0, { "of:users": 42 });
    await flushMicrotasks();
    expect(destination.pendingIntentCount).toBe(0);
    // The cascade echo is GONE — retired by its ancestor's consequence,
    // not by any mark of its own (none exists) and not by arrival (the
    // entity doc never arrives).
    expect(destination.entryCount(SPACE)).toBe(0);
    expect(destination.cascadeEchoRetirementCount).toBe(1);
    expect(destination.cascadeEchoRetirementUnarrivedCount).toBe(0);
    const verdict = await verdictOf(10) as {
      withdrawn?: { superseded?: boolean };
    };
    expect(verdict?.withdrawn?.superseded).toBe(true);
    destination.close();
  });

  it("W2.1-2: P's mark retires ONLY P's cascade — an entry with an unrelated parent, another intent's root echo, and a cascade of an untracked emitter all stand; the other intent's own mark then retires its own cascade (mutation: the walk accepts any parented entry → the unrelated cascade goes with P)", async () => {
    const { destination, echoOf, seedAppend, markConsequenced } =
      cascadeDestination();
    seedAppend(["evt-p", "evt-q"]);
    destination.trackIntent(SPACE, W21_SIDECAR, "evt-p");
    destination.trackIntent(SPACE, W21_SIDECAR, "evt-q");
    // P's cascade child; Q's root echo (Q's run wrote something itself);
    // Q's cascade child; a cascade of an emitter nobody tracks (a
    // derivation-sent event's handler echo — W0's "cascade-minted" case).
    await destination.seal(echoOf("evt:c:0:p-child", {
      parentEventId: "evt-p",
      writes: ["of:p-list", "of:p-entity"],
    }));
    await destination.seal(echoOf("evt-q", { writes: ["of:q-own"] }));
    await destination.seal(echoOf("evt:c:0:q-child", {
      parentEventId: "evt-q",
      writes: ["of:q-list", "of:q-entity"],
    }));
    await destination.seal(echoOf("evt:c:0:orphan-child", {
      parentEventId: "evt:c:9:nobody",
      writes: ["of:o-list"],
    }));
    expect(destination.entryCount(SPACE)).toBe(4);
    markConsequenced(0, { "of:p-list": 42 });
    await flushMicrotasks();
    // Exactly P's cascade child went.
    expect(destination.entryCount(SPACE)).toBe(3);
    expect(destination.cascadeEchoRetirementCount).toBe(1);
    expect(destination.pendingIntentCount).toBe(1);
    // Q's mark: Q's own echo AND Q's cascade child go; the orphan stands.
    markConsequenced(1, { "of:q-own": 43, "of:q-list": 43 });
    await flushMicrotasks();
    expect(destination.entryCount(SPACE)).toBe(1);
    expect(destination.cascadeEchoRetirementCount).toBe(2);
    expect(destination.pendingIntentCount).toBe(0);
    destination.close();
  });

  it("W2.1-3: the late-echo rule holds around the arrival arm — a LATE child of P (sealing after P's mark) and a LATE grandchild of the retired child drop at seal; a grandchild behind a SILENT child (no writes → no entry) is reached through the thread recorded at the silent child's seal (mutation: the thread not recorded for a no-write child → the grandchild stands)", async () => {
    const { destination, echoOf, seedAppend, markConsequenced } =
      cascadeDestination();
    seedAppend(["evt-p"]);
    destination.trackIntent(SPACE, W21_SIDECAR, "evt-p");
    // A SILENT child: forwards only, writes nothing — no entry, but the
    // thread records child → P at its seal.
    expect(
      (await destination.seal(echoOf("evt:c:0:silent", {
        parentEventId: "evt-p",
        writes: [],
      }))).ok,
    ).toBeDefined();
    expect(destination.entryCount(SPACE)).toBe(0);
    // Its grandchild writes (the join), threaded to the silent child.
    await destination.seal(echoOf("evt:c:0:grandchild", {
      parentEventId: "evt:c:0:silent",
      writes: ["of:g-list", "of:g-entity"],
    }));
    // And a direct child of P that wrote.
    await destination.seal(echoOf("evt:c:1:child", {
      parentEventId: "evt-p",
      writes: ["of:c-list"],
    }));
    expect(destination.entryCount(SPACE)).toBe(2);
    markConsequenced(0, { "of:g-list": 42, "of:c-list": 42 });
    await flushMicrotasks();
    // Both went: the direct child by its parentEventId, the grandchild
    // through the silent link.
    expect(destination.entryCount(SPACE)).toBe(0);
    expect(destination.cascadeEchoRetirementCount).toBe(2);
    // LATE echoes now: a child of P sealing after P is terminal drops at
    // seal (the T2 rule), and so does a grandchild of the RETIRED child —
    // the retired child's id joined the jobless set.
    const dropsBefore = destination.lateEchoDropCount;
    await destination.seal(echoOf("evt:c:2:late-child", {
      parentEventId: "evt-p",
      writes: ["of:late-list"],
    }));
    await destination.seal(echoOf("evt:c:0:late-grandchild", {
      parentEventId: "evt:c:1:child",
      writes: ["of:late-g-list"],
    }));
    expect(destination.lateEchoDropCount).toBe(dropsBefore + 2);
    expect(destination.entryCount(SPACE)).toBe(0);
    // F1 (combined review 2026-08-19, MAJOR): a LATE grandchild of the
    // SILENT child. The silent forwarder has no entry, was never
    // retired, and never joined the jobless set — so the one-level
    // parent check let this seal REGISTER and strand forever (no mark
    // of its own ever comes; P's retirement already ran; its entity doc
    // never arrives, so the sweep's arrival gate never passes). The
    // seal-time jobless checks now walk the thread: silent → P, and P
    // is terminal. RED on the pre-fix code: entryCount 1, drops +2.
    await destination.seal(echoOf("evt:c:0:late-silent-grandchild", {
      parentEventId: "evt:c:0:silent",
      writes: ["of:lsg-list", "of:lsg-entity"],
    }));
    expect(destination.lateEchoDropCount).toBe(dropsBefore + 3);
    expect(destination.entryCount(SPACE)).toBe(0);
    // And a fresh intent's cascade still registers (nothing over-broad).
    seedAppend(["evt-p", "evt-r"]);
    destination.trackIntent(SPACE, W21_SIDECAR, "evt-r");
    await destination.seal(echoOf("evt:c:0:r-child", {
      parentEventId: "evt-r",
      writes: ["of:r-list"],
    }));
    expect(destination.entryCount(SPACE)).toBe(1);
    destination.close();
  });

  it("W2.1-4: the FLICKER witness — a cascade echo retired on its parent's consequenced mark while NO doc it wrote had landed at or after the mark's frame counts `unarrived` (the purged-LT1-leftover shape: the server's child lands a wave after its parent's consequence) — also when a CONCURRENT writer moved the doc past the echo's basis before the mark; one whose written doc landed in the mark's frame does not count; a DROPPED parent's cascade is retired but not counted (no child is coming) (mutations: the witness keyed on the echo's basis instead of the mark's frame → the concurrent-writer case reads arrived; armed on the drop arm → the dropped parent's cascade counts)", async () => {
    const {
      destination,
      echoOf,
      seedAppend,
      markConsequenced,
      markDropped,
      confirmedSeqs,
    } = cascadeDestination();
    seedAppend(["evt-p1", "evt-p2", "evt-p3", "evt-p4"]);
    for (const id of ["evt-p1", "evt-p2", "evt-p3", "evt-p4"]) {
      destination.trackIntent(SPACE, W21_SIDECAR, id);
    }
    // Every child read its list doc at seq 40 (the basis) and wrote it
    // plus an entity doc.
    for (const n of [1, 2, 3, 4]) confirmedSeqs.set(`of:list-${n}`, 40);
    for (const n of [1, 2, 3, 4]) {
      await destination.seal(echoOf(`evt:c:0:child-${n}`, {
        parentEventId: `evt-p${n}`,
        writes: [`of:list-${n}`, `of:entity-${n}`],
        floor: 40,
      }));
    }
    expect(destination.entryCount(SPACE)).toBe(4);
    // P1's mark lands at 45 while list-1 is STILL at 40: the server's
    // join has not landed here (its LT1 child was purged at the deadline
    // and will be drained next wave) — the echo goes anyway (the known
    // cost of the arrival-time retirement), and the witness counts it.
    markConsequenced(0, {}, 45);
    await flushMicrotasks();
    expect(destination.entryCount(SPACE)).toBe(3);
    expect(destination.cascadeEchoRetirementCount).toBe(1);
    expect(destination.cascadeEchoRetirementUnarrivedCount).toBe(1);
    // P2's mark lands at 46 WITH its child (list-2 moved to 46 in the
    // same commit): retired, not counted.
    markConsequenced(1, { "of:list-2": 46 }, 46);
    await flushMicrotasks();
    expect(destination.entryCount(SPACE)).toBe(2);
    expect(destination.cascadeEchoRetirementCount).toBe(2);
    expect(destination.cascadeEchoRetirementUnarrivedCount).toBe(1);
    // P3: a CONCURRENT writer (the other voter) moved list-3 to 44 —
    // past the echo's basis 40 — BEFORE P3's mark at 47, and P3's child
    // was purged (list-3 did not move at 47): the child has NOT landed,
    // and the witness says so (keyed on the mark's frame, not the
    // basis: 44 < 47).
    markConsequenced(2, { "of:list-3": 44 }, 47);
    await flushMicrotasks();
    expect(destination.entryCount(SPACE)).toBe(1);
    expect(destination.cascadeEchoRetirementCount).toBe(3);
    expect(destination.cascadeEchoRetirementUnarrivedCount).toBe(2);
    // P4 DROPS (the conflicting-discharge notice): its cascade echo is
    // retired — no cascade child is coming — and the witness is not
    // armed: the removal is final, not a flicker.
    markDropped(3, 48);
    await flushMicrotasks();
    expect(destination.entryCount(SPACE)).toBe(0);
    expect(destination.cascadeEchoRetirementCount).toBe(4);
    expect(destination.cascadeEchoRetirementUnarrivedCount).toBe(2);
    destination.close();
  });

  it("W2.1-6: the post-sealInto re-check walks the thread too (combined review 2026-08-19, F1) — P's mark landing while a SILENT child's grandchild is MID-SEAL withdraws the collected entry at the re-check instead of registering it (mutation: the re-check one level deep → the grandchild registers and strands)", async () => {
    const { destination, echoOf, seedAppend, markConsequenced } =
      cascadeDestination();
    seedAppend(["evt-p"]);
    destination.trackIntent(SPACE, W21_SIDECAR, "evt-p");
    // The silent forwarder threads itself to P at its seal.
    await destination.seal(echoOf("evt:c:0:silent", {
      parentEventId: "evt-p",
      writes: [],
    }));
    expect(destination.entryCount(SPACE)).toBe(0);
    // The grandchild's seal STARTS — the thread records grandchild →
    // silent and the PRE-seal check passes (P is not yet terminal) —
    // then parks mid-`sealInto` (a busy client's parked dispatch).
    const gate = Promise.withResolvers<void>();
    const sealing = destination.seal(echoOf("evt:c:0:mid-seal-grandchild", {
      parentEventId: "evt:c:0:silent",
      writes: ["of:msg-list", "of:msg-entity"],
      holdSeal: gate.promise,
    }));
    // P's mark arrives while the grandchild is in flight: retireIntent
    // runs (nothing to retire — the grandchild has no entry yet, the
    // silent child never had one), P joins the terminal set.
    markConsequenced(0, {});
    await flushMicrotasks();
    expect(destination.pendingIntentCount).toBe(0);
    const dropsBefore = destination.lateEchoDropCount;
    // The seal resumes: the post-await re-check must walk silent → P
    // and withdraw the collected entry. RED on the pre-fix code: the
    // one-level re-check misses the chain — the entry registers and
    // strands (entryCount 1, no drop).
    gate.resolve();
    expect((await sealing).ok).toBeDefined();
    expect(destination.entryCount(SPACE)).toBe(0);
    expect(destination.lateEchoDropCount).toBe(dropsBefore + 1);
    destination.close();
  });

  it("W2.1-7: F6 telemetry (combined review 2026-08-19) — a walk stopped at the 64-hop depth cap and a thread eviction at the 4096 bound are COUNTED, so a silently-stranding truncation is observable at all (pre-F6 both presented as the original stranding with zero telemetry)", async () => {
    const { destination, echoOf, seedAppend, markConsequenced } =
      cascadeDestination();
    seedAppend(["evt-p"]);
    destination.trackIntent(SPACE, W21_SIDECAR, "evt-p");
    // A chain DEEPER than the cap: 66 silent forwarders hop-0 … hop-65
    // (hop-0's parent is P), then a writing descendant under hop-65.
    let parent = "evt-p";
    for (let i = 0; i < 66; i++) {
      await destination.seal(echoOf(`evt:c:0:hop-${i}`, {
        parentEventId: parent,
        writes: [],
      }));
      parent = `evt:c:0:hop-${i}`;
    }
    await destination.seal(echoOf("evt:c:0:deep", {
      parentEventId: parent,
      writes: ["of:deep-list"],
    }));
    expect(destination.entryCount(SPACE)).toBe(1);
    // The deep seals' own jobless-ancestry walks already hit the cap
    // (their chains exceed 64) — the counter moves at seal time.
    const capsAfterSeals = destination.cascadeWalkDepthCapCount;
    expect(capsAfterSeals).toBeGreaterThanOrEqual(1);
    markConsequenced(0, {});
    await flushMicrotasks();
    // The deep entry STANDS (the cap bounds the retirement walk — the
    // pre-existing posture, stated in the W2.1 report), and the capped
    // walk is COUNTED rather than silent.
    expect(destination.entryCount(SPACE)).toBe(1);
    expect(destination.cascadeWalkDepthCapCount).toBeGreaterThan(
      capsAfterSeals,
    );
    // The eviction counter: flood the thread map past its 4096 bound
    // with unrelated one-hop links (fresh child, nonexistent parent —
    // the cheapest insert). The evicted links are the OLDEST; each
    // eviction is counted.
    expect(destination.cascadeThreadEvictionCount).toBe(0);
    for (let i = 0; i < 4100; i++) {
      await destination.seal(echoOf(`evt:c:1:filler-${i}`, {
        parentEventId: `evt:c:9:filler-parent-${i}`,
        writes: [],
      }));
    }
    expect(destination.cascadeThreadEvictionCount).toBeGreaterThanOrEqual(1);
    destination.close();
  });
});

//
// e2e: the real replica, the real relay, a real serving side
//

const spaceSigner = await Identity.fromPassphrase("intent listener space");
const space = spaceSigner.did() as MemorySpace;
const serviceSigner = await Identity.fromPassphrase("intent listener service");
const aliceSigner = await Identity.fromPassphrase("intent listener alice");

const BUMP_PATTERN = [
  "import { handler, pattern, Stream, Writable } from 'commonfabric';",
  "const bump = handler<unknown, { value: Writable<number> }>(",
  "  (_ev, { value }) => { value.set((value.get() ?? 0) + 1); },",
  ");",
  "export default pattern<",
  "  { value: Writable<number> },",
  "  { value: number; bump: Stream<unknown> }",
  ">(({ value }) => ({ value, bump: bump({ value }) }));",
].join("\n");

/** The lunch "join" shape (W0 l3; W3's root cause): a CLICK handler that
 * only forwards to a second stream, whose handler CELLIFIES a new object
 * into a list — the new entity doc's id derives from the handler frame's
 * cause (`$event: tx.dispatchedEventId`), so the client's speculative
 * cascade child (client-minted id) writes an entity doc the server's own
 * cascade child (its own LT1 id) never writes. */
const JOIN_CASCADE_PATTERN = [
  "import { handler, pattern, Stream, Writable } from 'commonfabric';",
  "type User = { name: string };",
  "const joinAs = handler<unknown, { users: Writable<User[]> }>(",
  "  (_ev, { users }) => {",
  "    users.set([...(users.get() ?? []), { name: 'Alice' }]);",
  "  },",
  ");",
  "const join = handler<unknown, { joinAs: Stream<unknown> }>(",
  "  (_ev, { joinAs }) => { joinAs.send({}); },",
  ");",
  "export default pattern<",
  "  { users: Writable<User[]> },",
  "  { users: User[]; join: Stream<unknown>; joinAs: Stream<unknown> }",
  ">(({ users }) => {",
  "  const joinAsStream = joinAs({ users });",
  "  return {",
  "    users,",
  "    join: join({ joinAs: joinAsStream }),",
  "    joinAs: joinAsStream,",
  "  };",
  "});",
].join("\n");

import {
  ArrivalLog,
  awaitAdmitted,
  awaitReplica,
} from "./support/serving-waits.ts";
import { waitForCellValue } from "@commonfabric/integration/wait-for-cell-value";

const sidecarIdsIn = (engine: Engine.Engine): string[] =>
  (engine.database.prepare(
    `SELECT id FROM head WHERE id LIKE 'of:stream-events:%' AND op != 'delete'`,
  ).all() as Array<{ id: string }>).map((row) => row.id);

describe("intent listener — end to end (design (e) pins 6, 10, 11)", () => {
  let server: MemoryV2Server.Server;
  let host: ExecutorHost | undefined;
  let clientManager: EmulatedStorageManager | undefined;
  let clientRuntime: Runtime | undefined;

  beforeEach(() => {
    server = newSharedServer({ subscriptionRefreshDelayMs: 0 });
  });

  afterEach(async () => {
    await host?.close();
    host = undefined;
    await clientRuntime?.dispose();
    await clientManager?.close();
    clientRuntime = undefined;
    clientManager = undefined;
    await server.close();
  });

  const openClient = (options: { serverExecution: boolean }) => {
    const manager = EmulatedStorageManager.connectTo(server, {
      as: aliceSigner,
    });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: manager,
      experimental: { serverExecution: options.serverExecution },
    });
    clientManager = manager;
    clientRuntime = runtime;
    return { manager, runtime };
  };

  const standUp = async (
    runtime: Runtime,
    prefix: string,
    options: { source?: string; seed?: Record<string, unknown> } = {},
  ) => {
    const compiled = await runtime.patternManager.compilePattern({
      main: "/main.tsx",
      files: [{
        name: "/main.tsx",
        contents: options.source ?? BUMP_PATTERN,
      }],
    }, { space });
    const argument = runtime.getCell<Record<string, unknown>>(
      space,
      `${prefix}-arg`,
      undefined,
    );
    const result = runtime.getCell<Record<string, unknown>>(
      space,
      `${prefix}-result`,
      compiled.resultSchema,
    );
    await argument.sync();
    await result.sync();
    {
      const seed = runtime.edit();
      argument.withTx(seed).set(options.seed ?? { value: 0 });
      expect((await seed.commit()).error).toBeUndefined();
    }
    {
      const tx = runtime.edit();
      runtime.run(tx, compiled, argument, result);
      expect((await tx.commit()).error).toBeUndefined();
    }
    return { argument, result };
  };

  const newServingHost = () =>
    new ExecutorHost({
      server,
      serviceIdentity: serviceSigner.did(),
      // deno-lint-ignore require-await
      createRuntime: async () => {
        const servingManager = EmulatedStorageManager.connectTo(server, {
          as: serviceSigner,
        });
        const servingRuntime = new Runtime({
          apiUrl: new URL(import.meta.url),
          storageManager: servingManager,
          servingPosture: true,
          experimental: {
            serverExecution: true,
          },
        });
        return {
          runtime: servingRuntime,
          dispose: async () => {
            await servingRuntime.dispose();
            await servingManager.close();
          },
        };
      },
      policy: { flushDeadlineMs: 5_000, idleParkMs: 600_000 },
    });

  const streamEventsSinkNodes = (runtime: Runtime) =>
    runtime.scheduler.getGraphSnapshot().nodes.filter((node) =>
      node.id.startsWith("sink:") && node.id.includes("/of:stream-events:")
    );

  it("pin 6: a fire installs the listener, keeps the sidecar watched, and registers NO scheduler effect for the watch — no `sink:…/of:stream-events:` node in the graph, before or after the append lands (mutation: keep the cell.sink → a sink node appears)", async () => {
    const { manager, runtime } = openClient({ serverExecution: true });
    const engine = await server.engineForSpace(space);
    const { result } = await standUp(runtime, "pin6");
    const cancelDemand = result.sink(() => {});
    await runtime.idle();
    await manager.synced();

    (result.key("bump") as unknown as { send(value: unknown): unknown })
      .send({});
    const overlay = runtime.speculationOverlay!;
    expect(overlay).toBeDefined();
    expect(overlay.pendingIntentCount).toBe(1);
    expect(overlay.intentListenerInstalled).toBe(true);
    expect(streamEventsSinkNodes(runtime).length).toBe(0);
    await runtime.idle();
    await manager.synced();
    // The append landed durably (no serving side: nothing marks it, so
    // the intent stays outstanding and the listener stays installed).
    await awaitAdmitted(server, () => sidecarIdsIn(engine).length === 1);
    const sidecarId = sidecarIdsIn(engine)[0];
    // The client keeps the stream subscribed while its intent is
    // outstanding: the sidecar doc arrives in ITS replica.
    await awaitReplica(
      manager,
      () =>
        ((manager.open(space).replica.getDocument(sidecarId as never, "space")
          ?.value as StreamEventsDocValue | undefined)?.entries?.length ??
          0) === 1,
    );
    await runtime.idle();
    expect(streamEventsSinkNodes(runtime).length).toBe(0);
    expect(overlay.pendingIntentCount).toBe(1);
    expect(overlay.intentListenerInstalled).toBe(true);
    // The arrival was checked (a notification-driven check), and the
    // check located the entry in O(1) from the tail.
    expect(overlay.intentCheckCount).toBeGreaterThanOrEqual(2);
    // (e)'s second step (design §5 item 13): the EFFECTS CHANNEL watches
    // its session doc through the same listener shape — no
    // `sink:…/<effects doc>` scheduler node either (mutation: keep the
    // effects-doc cell.sink → a sink node appears).
    const channel = runtime.effectsChannel!;
    expect(channel).toBeDefined();
    expect(channel.listenerInstalled).toBe(true);
    const effectsSinkNodes = runtime.scheduler.getGraphSnapshot().nodes
      .filter((node) =>
        node.id.startsWith("sink:") &&
        node.id.includes(`/${SERVER_EXECUTION_EFFECTS_DOC_ID}/`)
      );
    expect(effectsSinkNodes.length).toBe(0);
    cancelDemand();
  });

  it("pin 10 (+1 e2e): the served mark resolves the intent through the REAL notification path — the check has run by the time `synced()` / `idle()` armed at the mark's frame resolve, and by the time the mark is visible on a macrotask poll (no extra turn), with O(1) visits on that check; the echo retires and the durable ack settles (mutation: defer the check to a macrotask)", async () => {
    const { manager, runtime } = openClient({ serverExecution: true });
    const engine = await server.engineForSpace(space);
    const { argument, result } = await standUp(runtime, "pin10");
    const cancelDemand = result.sink(() => {});
    await runtime.idle();
    await manager.synced();

    host = newServingHost();

    let ackStatus: string | undefined;
    const ackArrivals = new ArrivalLog<void>();
    sendEvent(result.key("bump"), {}, (ackTx) => {
      ackStatus = ackTx.status().status;
      ackArrivals.record();
    });
    const overlay = runtime.speculationOverlay!;
    expect(overlay.pendingIntentCount).toBe(1);
    expect(overlay.intentListenerInstalled).toBe(true);

    await awaitAdmitted(server, () => sidecarIdsIn(engine).length === 1);
    const sidecarId = sidecarIdsIn(engine)[0];
    const clientEntry = () =>
      (manager.open(space).replica.getDocument(sidecarId as never, "space")
        ?.value as StreamEventsDocValue | undefined)?.entries?.[0];
    // Design pin 10's statement proper (the timing regression guard,
    // since the watch left the scheduler): the check HAS RUN by the time
    // `storageManager.synced()` / `runtime.idle()` resolve after the
    // frame that carries the mark. Observed from a subscriber registered
    // AFTER the listener (the relay runs subscribers in insertion order,
    // so the listener has already queued its microtask check when this
    // one sees the same notification), which arms both barriers AT that
    // frame — their continuations must find the intent resolved
    // (mutation: defer the check to a macrotask → both read 1).
    const afterMarkFrame = new Map<string, number>();
    const frameBarriers = new ArrivalLog<string>();
    const probe: IStorageNotification = {
      next: (notification) => {
        if (notification.type === "reset" || afterMarkFrame.size > 0) {
          return undefined;
        }
        let touchesSidecar = false;
        for (const change of notification.changes) {
          if (change.address.id === sidecarId) touchesSidecar = true;
        }
        if (!touchesSidecar || clientEntry()?.consequenced !== true) {
          return undefined;
        }
        afterMarkFrame.set("armed", overlay.pendingIntentCount);
        manager.synced().then(() => {
          afterMarkFrame.set("synced", overlay.pendingIntentCount);
          frameBarriers.record("synced");
        });
        runtime.idle().then(() => {
          afterMarkFrame.set("idle", overlay.pendingIntentCount);
          frameBarriers.record("idle");
        });
        return undefined;
      },
    };
    manager.subscribe(probe);
    // Both barriers armed at the mark's own frame have resolved: that is
    // the statement's own edge, and it is ordered after the frame the
    // mark arrived on.
    await frameBarriers.reached(2);
    manager.unsubscribe(probe);
    expect(clientEntry()?.consequenced).toBe(true);
    expect(overlay.pendingIntentCount).toBe(0);
    expect(overlay.intentListenerInstalled).toBe(false);
    // Still outstanding INSIDE the frame's dispatch (the check never acts
    // inline — contract point 3) ...
    expect(afterMarkFrame.get("armed")).toBe(1);
    // ... and resolved by the time either barrier armed there resolves.
    expect(afterMarkFrame.get("synced")).toBe(0);
    expect(afterMarkFrame.get("idle")).toBe(0);
    // Every notified check on a one-entry sidecar is O(1).
    expect(overlay.intentCheckMaxVisits).toBeLessThanOrEqual(2);
    // No scheduler effect ever existed for the watch.
    expect(streamEventsSinkNodes(runtime).length).toBe(0);
    // The echo retired and the authoritative value renders; the durable
    // ack settled from the consequence, non-error.
    await awaitReplica(manager, () => overlay.entryCount(space) === 0);
    await waitForCellValue(
      runtime,
      argument.key("value"),
      (value: number | undefined) => value === 1,
      { stuckLabel: "the handler's increment to render" },
    );
    await ackArrivals.reached(1);
    expect(ackStatus).not.toBe("error");
    cancelDemand();
  });

  it("W2.1 e2e (the lunch join shape, W0 l3): a click whose handler only forwards to a second stream whose handler cellifies a NEW object into a list — the client's cascade-child echo (client-minted id; an entity doc the server never writes) retires when the click's consequence mark arrives, the rendered list holds exactly the server's one entry, and the counter reads 1 (on the tip: the echo stands forever — spec-Alice beside the confirmed Alice)", async () => {
    const { manager, runtime } = openClient({ serverExecution: true });
    const engine = await server.engineForSpace(space);
    const { argument, result } = await standUp(runtime, "w21", {
      source: JOIN_CASCADE_PATTERN,
      seed: { users: [] },
    });
    const cancelDemand = result.sink(() => {});
    await runtime.idle();
    await manager.synced();
    host = newServingHost();

    (result.key("join") as unknown as { send(value: unknown): unknown })
      .send({});
    const overlay = runtime.speculationOverlay!;
    // The click is the ONE tracked intent; its speculative run forwards
    // to joinAs, whose echo seals as a CASCADE entry (client-minted id,
    // parentEventId = the click's id) writing the list + a new entity.
    expect(overlay.pendingIntentCount).toBe(1);
    await runtime.idle();
    await awaitReplica(manager, () => overlay.entryCount(space) >= 1);
    const echoUsers = argument.key("users").get() as
      | Array<{ name?: string }>
      | undefined;
    expect(echoUsers?.length).toBe(1);
    expect(echoUsers?.[0]?.name).toBe("Alice");

    // The serving side: TWO sidecars (the click's stream and joinAs's —
    // the served click emitted the join as an LT1 same-space cascade),
    // every entry consequenced.
    await awaitAdmitted(server, () => {
      const ids = sidecarIdsIn(engine);
      if (ids.length < 2) return false;
      return ids.every((id) => {
        const value = Engine.read(engine, { id })?.value as
          | StreamEventsDocValue
          | undefined;
        const entries = value?.entries ?? [];
        return entries.length > 0 &&
          entries.every((entry) => entry.consequenced === true);
      });
    });
    // The click's intent resolved by its mark.
    await awaitReplica(manager, () => overlay.pendingIntentCount === 0);
    // THE PIN: the cascade child's echo is GONE — no mark of its own
    // ever names its client-minted id and its entity doc never arrives,
    // so only the click's consequence can retire it (on the tip this
    // times out: the entry stands forever).
    await awaitReplica(manager, () => overlay.entryCount(space) === 0);
    expect(overlay.cascadeEchoRetirementCount).toBe(1);
    // The child landed in the click's own wave (flushDeadlineMs 5 s, no
    // purge): the witness does not count a flicker.
    expect(overlay.cascadeEchoRetirementUnarrivedCount).toBe(0);
    // The rendered list is the SERVER's one Alice — not spec-Alice beside
    // the confirmed one.
    await waitForCellValue(
      runtime,
      argument.key("users"),
      (users: Array<{ name?: string }> | undefined) =>
        users?.length === 1 && users[0]?.name === "Alice",
      { stuckLabel: "the added user to render" },
    );
    // And it STAYS one: a re-speculation would be this runtime's own
    // scheduler work over a fresh echo, and the drain runs it.
    await runtime.idle();
    await manager.synced();
    const users = argument.key("users").get() as Array<{ name?: string }>;
    expect(users.length).toBe(1);
    expect(overlay.entryCount(space)).toBe(0);
    cancelDemand();
  });

  it("pin 11: OFF byte-identity — a flag-OFF client has no overlay and installs no listener; a fire runs the handler locally as before", async () => {
    const { manager, runtime } = openClient({ serverExecution: false });
    let subscribes = 0;
    const original = manager.subscribe.bind(manager);
    manager.subscribe = (subscription) => {
      subscribes += 1;
      original(subscription);
    };
    const { argument, result } = await standUp(runtime, "pin11");
    const cancelDemand = result.sink(() => {});
    await runtime.idle();
    await manager.synced();
    (result.key("bump") as unknown as { send(value: unknown): unknown })
      .send({});
    await runtime.idle();
    await manager.synced();
    expect(runtime.speculationOverlay).toBeUndefined();
    expect(subscribes).toBe(0);
    expect(streamEventsSinkNodes(runtime).length).toBe(0);
    await waitForCellValue(
      runtime,
      argument.key("value"),
      (value: number | undefined) => value === 1,
      { stuckLabel: "the handler's increment to render" },
    );
    cancelDemand();
  });
});
