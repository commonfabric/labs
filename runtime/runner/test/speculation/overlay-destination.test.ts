import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { StreamEventEntry } from "@commonfabric/memory/v2";
import type { ServerRunInfo } from "../../src/runtime.ts";
import {
  type EventIntentOutcome,
  SpeculationOverlayDestination,
  stampSpeculationRunContext,
} from "../../src/speculation/overlay-destination.ts";
import type {
  IExtendedStorageTransaction,
  IStorageNotification,
  ITransactionSealSink,
  MemorySpace,
  SealedCommitVerdict,
  URI,
} from "../../src/storage/interface.ts";
import { captureLogs } from "../support/captured-logs.ts";
import { flushMicrotasks } from "../speculation-intent-test-utils.ts";

const SPACE: MemorySpace = "did:key:z6MkOverlayDestinationSpace";
const OTHER_SPACE: MemorySpace = "did:key:z6MkOverlayDestinationOther";
const SIDECAR = "of:stream-events:overlay";
const OTHER_SIDECAR = "of:stream-events:overlay-other";

/** The confirmed read seq every seal reports: each entry's floor. */
const FLOOR = 40;

const WRITER = { name: "writer" };

const derivation: ServerRunInfo = { actionId: "writer", kind: "derivation" };

const echo = (eventId: string, parentEventId?: string): ServerRunInfo => ({
  actionId: "handler",
  kind: "event-handler",
  eventId,
  ...(parentEventId !== undefined ? { parentEventId } : {}),
});

const streamEntry = (
  eventId: string,
  fields: Partial<StreamEventEntry> = {},
): StreamEventEntry => ({
  eventId,
  stream: { id: "of:stream", path: [] },
  ...fields,
});

const refused = { kind: "refused" as const, reason: "refused at admission" };

/**
 * A `SpeculationOverlayDestination` over a stand-in runtime: one replica for
 * every space, which seals each commit at the next local seq with `FLOOR` as
 * its confirmed read basis, reports the confirmed seqs the test sets, and
 * reads the sidecar docs the test delivers; and a relay `deliver()` and
 * `reset()` drive. `faults` makes one seam fail.
 */
const overlayHarness = (options: { sealNative?: boolean } = {}) => {
  const subscribers = new Set<IStorageNotification>();
  const docs = new Map<string, { entries: StreamEventEntry[] }>();
  const confirmedSeqs = new Map<string, number>();
  const verdicts = new Map<number, Promise<SealedCommitVerdict>>();
  const watermarkSinks: Array<(value: { seq: number }) => void> = [];
  const faults: {
    subscribe?: Error;
    syncThrow?: Error;
    syncReject?: Error;
    read?: Error;
    view?: (id: string) => Error | undefined;
    cell?: Error;
    sinkCancel?: Error;

    /** How many more `open()` calls succeed before every later one
     * throws; unlimited when absent. */
    opensLeft?: number;
  } = {};
  let nextLocalSeq = 1;
  const replica = {
    ...(options.sealNative === false ? {} : {
      sealNative: (
        native: { operations: unknown[] },
        _source: unknown,
        verdict: Promise<SealedCommitVerdict>,
      ) => {
        const localSeq = nextLocalSeq++;
        verdicts.set(localSeq, verdict);
        return {
          localSeq,
          commit: {
            reads: { confirmed: [{ id: "of:basis", seq: FLOOR }], pending: [] },
            operations: native.operations,
          },
          settled: verdict.then(() => undefined),
        };
      },
    }),
    speculationRetirementView: (id: string) => {
      const fault = faults.view?.(id);
      if (fault !== undefined) throw fault;
      return {
        confirmedSeq: confirmedSeqs.get(id) ?? 0,
        pendingLocalSeqs: [],
        coverClass: "derived",
      };
    },
    ackedSeqOf: () => undefined,
    speculationAckObserver: undefined as (() => void) | undefined,
    speculationArrivalObserver: undefined as
      | ((arrived: Array<{ id: string; scope?: string }>) => void)
      | undefined,
    getDocument: (id: string) => {
      if (faults.read !== undefined) throw faults.read;
      const value = docs.get(id);
      return value === undefined ? undefined : { value };
    },
  };
  const runtime = {
    storageManager: {
      subscribe: (subscription: IStorageNotification) => {
        if (faults.subscribe !== undefined) throw faults.subscribe;
        subscribers.add(subscription);
      },
      unsubscribe: (subscription: IStorageNotification) => {
        subscribers.delete(subscription);
      },
      open: () => {
        if (faults.opensLeft !== undefined) {
          if (faults.opensLeft === 0) throw new Error("storage closed");
          faults.opensLeft -= 1;
        }
        return {
          replica,
          sync: () => {
            if (faults.syncThrow !== undefined) throw faults.syncThrow;
            return faults.syncReject !== undefined
              ? Promise.reject(faults.syncReject)
              : Promise.resolve({ ok: {} });
          },
        };
      },
    },
    getCellFromLink: () => {
      if (faults.cell !== undefined) throw faults.cell;
      return {
        sink: (callback: (value: { seq: number }) => void) => {
          watermarkSinks.push(callback);
          return () => {
            if (faults.sinkCancel !== undefined) throw faults.sinkCancel;
          };
        },
      };
    },
  };
  const destination = new SpeculationOverlayDestination(runtime as never);

  /** A transaction stamped with `context` whose seal writes `writes` into
   * `SPACE` — a whole-doc `set` unless the write says `patch`. */
  const speculativeTx = (
    context: ServerRunInfo,
    writes: Array<{ id: string; op?: "set" | "patch" }> = [],
  ) => {
    let sealed = false;
    const tx = {
      tx: {
        markWholeDocumentWrites: () => {},
        sealInto: async (collector: ITransactionSealSink) => {
          sealed = true;
          if (writes.length === 0) return { ok: {} };
          return await collector.sealSpaceCommit(
            SPACE,
            {
              operations: writes.map(({ id, op = "set" }) => ({
                op,
                id,
                scope: "space",
                value: {},
              })),
            } as never,
            { sourceAction: WRITER } as never,
          );
        },
      },
    } as unknown as IExtendedStorageTransaction;
    stampSpeculationRunContext(tx, context);
    return { tx, sealed: () => sealed };
  };

  /** Seal a run and return its verdict. */
  const seal = async (
    context: ServerRunInfo,
    writes: Array<{ id: string; op?: "set" | "patch" }>,
  ) => await destination.seal(speculativeTx(context, writes).tx).verdict;

  /** Replace a sidecar's entries and notify a change at `path`. */
  const deliver = (
    sidecar: URI,
    entries: StreamEventEntry[],
    path: string[] = ["value", "entries"],
  ) => {
    docs.set(sidecar, { entries });
    for (const subscriber of [...subscribers]) {
      subscriber.next({
        type: "integrate",
        space: SPACE,
        changes: [{
          address: { id: sidecar, scope: "space", path },
          before: null,
          after: null,
        }],
      });
    }
  };
  const reset = (space: MemorySpace) => {
    for (const subscriber of [...subscribers]) {
      subscriber.next({ type: "reset", space });
    }
  };
  return {
    destination,
    replica,
    faults,
    confirmedSeqs,
    watermarkSinks,
    speculativeTx,
    seal,
    deliver,
    reset,
    verdictOf: (localSeq: number) => verdicts.get(localSeq),
  };
};

describe("SpeculationOverlayDestination", () => {
  describe("instance members", () => {
    describe("seal()", () => {
      it("reports success for a speculative run on a closed overlay without sealing its writes", async () => {
        const h = overlayHarness();
        h.destination.close();
        const { tx, sealed } = h.speculativeTx(derivation, [{ id: "of:out" }]);
        expect(await h.destination.seal(tx).verdict).toEqual({ ok: {} });
        expect(sealed()).toBe(false);
        expect(h.destination.entryCount(SPACE)).toBe(0);
      });

      it("returns an error when the space's replica cannot seal", async () => {
        const h = overlayHarness({ sealNative: false });
        const result = await h.seal(derivation, [{ id: "of:out" }]);
        expect(result.error?.message).toBe(
          `space replica for ${SPACE} does not support sealing; ` +
            "speculative derivations cannot commit (speculation.md §6)",
        );
        expect(h.destination.entryCount(SPACE)).toBe(0);
      });

      it("keeps an older entry of the same writer under a newer one that also patches the doc, and withdraws both under one that only sets it", async () => {
        const h = overlayHarness();
        await h.seal(derivation, [{ id: "of:out" }]);
        await h.seal(derivation, [{ id: "of:out" }, {
          id: "of:out",
          op: "patch",
        }]);
        expect(h.destination.entryCount(SPACE)).toBe(2);

        await h.seal(derivation, [{ id: "of:out" }]);
        expect(h.destination.entryCount(SPACE)).toBe(1);
        expect(await h.verdictOf(1)).toEqual({
          withdrawn: {
            message: "speculation superseded by a newer speculation of the " +
              "same writer over the same instances (speculation.md §4's " +
              "supersede-by-newer rider)",
            superseded: true,
          },
        });
      });

      it("drops a late echo of an answered intent at seal, and logs `late-echo-dropped` at `debug`", async () => {
        const h = overlayHarness();
        h.destination.resolveIntent(SPACE, SIDECAR, "e1", refused);
        using logs = captureLogs("speculation-overlay");
        const { tx, sealed } = h.speculativeTx(echo("e1"), [{ id: "of:out" }]);
        expect(await h.destination.seal(tx).verdict).toEqual({ ok: {} });
        expect(sealed()).toBe(false);
        expect(h.destination.lateEchoDropCount).toBe(1);
        expect(logs.textsOf("late-echo-dropped")).toEqual([
          "late event echo e1 dropped at seal: its intent (or its cascade " +
          "parent's) already reached a terminal consequence " +
          "(speculation.md §4 step 2)",
        ]);
      });

      it("logs `ack-observer-failed` and `arrival-observer-failed`, and keeps the entry, when the replica cannot be opened again after the seal", async () => {
        const h = overlayHarness();
        h.faults.opensLeft = 1;
        using logs = captureLogs("speculation-overlay");
        expect(await h.seal(derivation, [{ id: "of:out" }])).toEqual({
          ok: {},
        });
        expect(logs.textsOf("ack-observer-failed")).toEqual([
          `origin-accept observer for ${SPACE} failed; retirement of ` +
          "verdict-raced entries will rely on later watermark events " +
          "storage closed",
        ]);
        expect(logs.textsOf("arrival-observer-failed")).toEqual([
          `arrival observer for ${SPACE} failed; retirement of entries ` +
          "whose served value arrives decoupled from W will rely on later " +
          "watermark events storage closed",
        ]);
        expect(h.destination.entryCount(SPACE)).toBe(1);
      });

      it("logs `watermark-sink-failed`, and keeps the entry, when the watermark cell cannot be built", async () => {
        const h = overlayHarness();
        h.faults.cell = new Error("no cell");
        using logs = captureLogs("speculation-overlay");
        await h.seal(derivation, [{ id: "of:out" }]);
        expect(logs.textsOf("watermark-sink-failed")).toEqual([
          `watermark sink for ${SPACE} failed; overlay retirement for the ` +
          "space will rely on entry re-runs no cell",
        ]);
        expect(h.destination.entryCount(SPACE)).toBe(1);
      });
    });

    describe("deferSealedEffects()", () => {
      it("logs `speculative-enact-failed` when a navigation without a nonce fails to flush, and flushes no other kind", async () => {
        const h = overlayHarness();
        const { tx } = h.speculativeTx(derivation);
        let otherFlushed = false;
        using logs = captureLogs("speculation-overlay");
        expect(h.destination.deferSealedEffects(tx, [{
          id: "navigate",
          kind: "navigateTo",
          flush: () => {
            throw new Error("no route");
          },
        }, {
          id: "egress",
          kind: "fetch",
          flush: () => {
            otherFlushed = true;
          },
        }])).toBe(true);
        await flushMicrotasks();
        const failures = logs.logs.filter((log) =>
          log.key === "speculative-enact-failed"
        );
        expect(failures.length).toBe(1);
        expect(failures[0].level).toBe("error");
        expect(failures[0].text).toContain("navigateTo");
        expect(failures[0].text).toContain("no route");
        expect(otherFlushed).toBe(false);
      });
    });

    describe("trackIntent()", () => {
      it("logs `intent-listener-failed` when the listener cannot subscribe, and keeps the intent outstanding", () => {
        const h = overlayHarness();
        h.faults.subscribe = new Error("relay closed");
        using logs = captureLogs("speculation-overlay");
        h.destination.trackIntent(SPACE, SIDECAR, "e1");
        expect(logs.textsOf("intent-listener-failed")).toEqual([
          "intent listener could not subscribe to storage notifications; " +
          "echo retirement for outstanding intents rides the watermark " +
          "backstop only relay closed",
        ]);
        expect(h.destination.intentListenerInstalled).toBe(false);
        expect(h.destination.pendingIntentCount).toBe(1);
      });

      for (
        const [how, fault] of [
          ["rejects", "syncReject"],
          ["throws", "syncThrow"],
        ] as const
      ) {
        it(`logs \`intent-watch-failed\` when the sidecar watch ${how}, and keeps the intent outstanding`, async () => {
          const h = overlayHarness();
          h.faults[fault] = new Error("pull failed");
          using logs = captureLogs("speculation-overlay");
          h.destination.trackIntent(SPACE, SIDECAR, "e1");
          await flushMicrotasks();
          expect(logs.textsOf("intent-watch-failed")).toEqual([
            `intent sidecar watch for ${SPACE} failed; echo retirement for ` +
            "its events rides the watermark backstop only pull failed",
          ]);
          expect(h.destination.pendingIntentCount).toBe(1);
        });
      }

      it("logs `intent-check-read-failed` when the sidecar cannot be read, and keeps the intent outstanding", () => {
        const h = overlayHarness();
        h.faults.read = new Error("replica closed");
        using logs = captureLogs("speculation-overlay");
        h.destination.trackIntent(SPACE, SIDECAR, "e1");
        expect(logs.textsOf("intent-check-read-failed")).toEqual([
          `intent check could not read the sidecar ${SIDECAR} in ${SPACE} ` +
          "replica closed",
        ]);
        expect(h.destination.intentCheckCount).toBe(0);
        expect(h.destination.pendingIntentCount).toBe(1);
      });

      it("logs the listener's install, each check, and its release at `debug`", async () => {
        const h = overlayHarness();
        using logs = captureLogs("speculation-overlay");
        h.destination.trackIntent(SPACE, SIDECAR, "e1");
        h.deliver(SIDECAR, [streamEntry("e1", { consequenced: true })]);
        await flushMicrotasks();
        expect(
          logs.logs.filter((log) => log.key.startsWith("intent-")).map((
            log,
          ) => [log.key, log.text]),
        ).toEqual([
          ["intent-check", `intent check on ${SIDECAR} (1 outstanding)`],
          [
            "intent-listener-installed",
            "intent listener subscribed to storage notifications",
          ],
          ["intent-check", `intent check on ${SIDECAR} (1 outstanding)`],
          [
            "intent-retired-by-consequence-of",
            "intent e1 resolved by its tracked entry (consequenced)",
          ],
          [
            "intent-listener-released",
            "intent listener released: no intents outstanding",
          ],
        ]);
      });
    });

    describe("storage notifications", () => {
      it("checks no sidecar for a reset of a space with no intent outstanding, and every sidecar for a reset of one with", async () => {
        const h = overlayHarness();
        h.destination.trackIntent(SPACE, SIDECAR, "e1");
        h.destination.trackIntent(SPACE, OTHER_SIDECAR, "e2");
        expect(h.destination.intentCheckCount).toBe(2);
        h.reset(OTHER_SPACE);
        await flushMicrotasks();
        expect(h.destination.intentCheckCount).toBe(2);
        h.reset(SPACE);
        await flushMicrotasks();
        expect(h.destination.intentCheckCount).toBe(4);
      });

      it("skips the check of a sidecar whose intents were all resolved after the change and before the check", async () => {
        const h = overlayHarness();
        h.destination.trackIntent(SPACE, SIDECAR, "e1");
        h.destination.trackIntent(SPACE, OTHER_SIDECAR, "e2");
        h.deliver(SIDECAR, [streamEntry("e1", { consequenced: true })]);
        h.destination.resolveIntent(SPACE, SIDECAR, "e1", refused);
        await flushMicrotasks();
        expect(h.destination.intentCheckCount).toBe(2);
        expect(await h.destination.waitForIntentConsequence(SPACE, "e1"))
          .toEqual({ kind: "refused", reason: refused.reason });

        h.deliver(OTHER_SIDECAR, [streamEntry("e2", { consequenced: true })]);
        await flushMicrotasks();
        expect(h.destination.intentCheckCount).toBe(3);
        expect(await h.destination.waitForIntentConsequence(SPACE, "e2"))
          .toEqual({ kind: "consequenced" });
      });

      it("reports a dropped entry without a reason as dropped for `dropped`, and logs the notice at `debug`", async () => {
        const h = overlayHarness();
        const outcomes: EventIntentOutcome[] = [];
        h.destination.subscribeIntentOutcomes((outcome) => {
          outcomes.push(outcome);
        });
        h.destination.trackIntent(SPACE, SIDECAR, "e1");
        h.destination.trackIntent(SPACE, SIDECAR, "e2");
        using logs = captureLogs("speculation-overlay");
        h.deliver(SIDECAR, [
          streamEntry("e1", { status: "dropped" }),
          streamEntry("e2", { status: "dropped", reason: "conflict" }),
        ]);
        await flushMicrotasks();
        expect(outcomes.map(({ eventId, kind, reason }) => ({
          eventId,
          kind,
          reason,
        }))).toEqual([
          { eventId: "e2", kind: "dropped", reason: "conflict" },
          { eventId: "e1", kind: "dropped", reason: "dropped" },
        ]);
        expect(await h.destination.waitForIntentConsequence(SPACE, "e1"))
          .toEqual({ kind: "dropped", reason: "dropped" });
        expect(logs.textsOf("intent-drop-notice")).toEqual([
          "dropped-event notice for e2",
          "dropped-event notice for e1",
        ]);
        expect(logs.textsOf("intent-retired-by-consequence-of")).toEqual([
          "intent e2 resolved by its tracked entry (dropped)",
          "intent e1 resolved by its tracked entry (dropped)",
        ]);
      });

      it("logs an errored consequence at `debug`", async () => {
        const h = overlayHarness();
        h.destination.trackIntent(SPACE, SIDECAR, "e1");
        using logs = captureLogs("speculation-overlay");
        h.deliver(SIDECAR, [
          streamEntry("e1", { consequenced: true, error: "boom" }),
        ]);
        await flushMicrotasks();
        expect(logs.textsOf("intent-error-notice")).toEqual([
          "error consequence for e1",
        ]);
        expect(logs.textsOf("intent-retired-by-consequence-of")).toEqual([
          "intent e1 resolved by its tracked entry (errored)",
        ]);
      });
    });

    describe("resolveIntent()", () => {
      it("settles the intent as refused, and logs `intent-refused` at `debug`", async () => {
        const h = overlayHarness();
        h.destination.trackIntent(SPACE, SIDECAR, "e1");
        using logs = captureLogs("speculation-overlay");
        h.destination.resolveIntent(SPACE, SIDECAR, "e1", refused);
        expect(await h.destination.waitForIntentConsequence(SPACE, "e1"))
          .toEqual({ kind: "refused", reason: refused.reason });
        expect(logs.textsOf("intent-refused")).toEqual([
          `intent e1 refused at discharge: ${refused.reason}`,
        ]);
        expect(h.destination.pendingIntentCount).toBe(0);
      });

      it("settles nothing once the overlay is closed", async () => {
        const h = overlayHarness();
        h.destination.trackIntent(SPACE, SIDECAR, "e1");
        h.destination.close();
        h.destination.resolveIntent(SPACE, SIDECAR, "e1", refused);
        expect(await h.destination.waitForIntentConsequence(SPACE, "e1"))
          .toEqual({ kind: "unsettled" });
      });

      it("logs `intent-outcome-subscriber-failed` for a subscriber that throws, and still notifies the others", () => {
        const h = overlayHarness();
        const outcomes: string[] = [];
        h.destination.subscribeIntentOutcomes(() => {
          throw new Error("subscriber broke");
        });
        h.destination.subscribeIntentOutcomes((outcome) => {
          outcomes.push(`${outcome.kind}:${outcome.eventId}`);
        });
        using logs = captureLogs("speculation-overlay");
        h.destination.resolveIntent(SPACE, SIDECAR, "e1", refused);
        expect(logs.textsOf("intent-outcome-subscriber-failed")).toEqual([
          "event intent outcome subscriber threw subscriber broke",
        ]);
        expect(outcomes).toEqual(["refused:e1"]);
      });
    });

    describe("discards()", () => {
      it("forgets the oldest answered intent once 4096 later ones are answered", () => {
        const h = overlayHarness();
        for (let i = 0; i <= 4096; i += 1) {
          h.destination.resolveIntent(SPACE, SIDECAR, `e${i}`, refused);
        }
        expect(h.destination.discards(h.speculativeTx(echo("e0")).tx))
          .toBe(false);
        expect(h.destination.discards(h.speculativeTx(echo("e1")).tx))
          .toBe(true);
      });

      it("forgets the oldest cascade link once 4096 later ones are threaded, counts the eviction, and logs `cascade-thread-evicted` at `debug`", () => {
        const h = overlayHarness();
        using logs = captureLogs("speculation-overlay");
        for (let i = 0; i <= 4096; i += 1) {
          h.destination.threadCascadeChild(`c${i}`, "root");
        }
        h.destination.resolveIntent(SPACE, SIDECAR, "root", refused);
        expect(h.destination.cascadeThreadEvictionCount).toBe(1);
        expect(logs.textsOf("cascade-thread-evicted")).toEqual([
          "cascade thread link c0 evicted at the 4096 bound — a live chain " +
          "through it now reads as having no ancestor (walks stop there; " +
          "descendants of a terminal root beyond it can strand silently)",
        ]);
        expect(h.destination.discards(h.speculativeTx(echo("x", "c0")).tx))
          .toBe(false);
        expect(h.destination.discards(h.speculativeTx(echo("y", "c1")).tx))
          .toBe(true);
      });

      it("stops an ancestry walk at 64 hops, counts it, and logs `cascade-walk-depth-capped` at `debug`", () => {
        const h = overlayHarness();
        for (let i = 1; i <= 64; i += 1) {
          h.destination.threadCascadeChild(`d${i}`, `d${i - 1}`);
        }
        h.destination.resolveIntent(SPACE, SIDECAR, "d0", refused);
        expect(h.destination.discards(h.speculativeTx(echo("x", "d63")).tx))
          .toBe(true);
        expect(h.destination.cascadeWalkDepthCapCount).toBe(0);
        using logs = captureLogs("speculation-overlay");
        expect(h.destination.discards(h.speculativeTx(echo("y", "d64")).tx))
          .toBe(false);
        expect(h.destination.cascadeWalkDepthCapCount).toBe(1);
        expect(logs.textsOf("cascade-walk-depth-capped")).toEqual([
          "a cascade ancestry walk stopped at the 64-hop cap with chain " +
          "remaining — deeper ancestry is invisible (descendants of a " +
          "terminal root beyond the cap can strand silently)",
        ]);
      });
    });

    describe("retireIntent()", () => {
      // Each case seals the echo of `child`, a cascade child of `P`
      // writing `of:list`, and retires `P` with the witness armed on the
      // mark's sidecar.

      const withCascadeEcho = async () => {
        const h = overlayHarness();
        await h.seal(echo("child", "P"), [{ id: "of:list" }]);
        expect(h.destination.entryCount(SPACE)).toBe(1);
        return h;
      };
      const retireP = (h: ReturnType<typeof overlayHarness>) =>
        h.destination.retireIntent(SPACE, "P", { markSidecarId: SIDECAR });

      it("counts a cascade echo retired before any doc it wrote landed at the mark's seq as unarrived, and logs both at `debug`", async () => {
        const h = await withCascadeEcho();
        h.confirmedSeqs.set(SIDECAR, 42);
        h.confirmedSeqs.set("of:list", 41);
        using logs = captureLogs("speculation-overlay");
        retireP(h);
        expect(h.destination.entryCount(SPACE)).toBe(0);
        expect(h.destination.cascadeEchoRetirementCount).toBe(1);
        expect(h.destination.cascadeEchoRetirementUnarrivedCount).toBe(1);
        expect(logs.textsOf("cascade-echo-retired")).toEqual([
          "cascade echo child retired with its ancestor intent P: cascade " +
          "echo retired: its ancestor intent's authoritative consequences " +
          "(or notice) arrived (speculation.md §4 step 2)",
        ]);
        expect(logs.textsOf("cascade-echo-retired-unarrived")).toEqual([
          "cascade echo child retired before any doc it wrote landed at the " +
          "mark's frame — the server's cascade child has not landed here " +
          "yet (the W2.1 flicker)",
        ]);
        expect(await h.verdictOf(1)).toEqual({
          withdrawn: {
            message: "cascade echo retired: its ancestor intent's " +
              "authoritative consequences (or notice) arrived " +
              "(speculation.md §4 step 2)",
            superseded: true,
          },
        });
      });

      it("retires the echo without counting it unarrived when the replica cannot be opened", async () => {
        const h = await withCascadeEcho();
        h.faults.opensLeft = 0;
        retireP(h);
        expect(h.destination.entryCount(SPACE)).toBe(0);
        expect(h.destination.cascadeEchoRetirementCount).toBe(1);
        expect(h.destination.cascadeEchoRetirementUnarrivedCount).toBe(0);
      });

      it("retires the echo without counting it unarrived when the mark's sidecar cannot be viewed", async () => {
        const h = await withCascadeEcho();
        h.confirmedSeqs.set(SIDECAR, 42);
        h.faults.view = (id) =>
          id === SIDECAR ? new Error("sidecar gone") : undefined;
        retireP(h);
        expect(h.destination.entryCount(SPACE)).toBe(0);
        expect(h.destination.cascadeEchoRetirementUnarrivedCount).toBe(0);
      });

      it("retires the echo and counts it unarrived when no doc it wrote can be viewed", async () => {
        const h = await withCascadeEcho();
        h.confirmedSeqs.set(SIDECAR, 42);
        h.faults.view = (id) =>
          id === "of:list" ? new Error("doc gone") : undefined;
        retireP(h);
        expect(h.destination.entryCount(SPACE)).toBe(0);
        expect(h.destination.cascadeEchoRetirementUnarrivedCount).toBe(1);
      });
    });

    describe("retirement by sweep", () => {
      it("retires an intent's echo once the watermark covers its floor and its doc has arrived, and logs `intent-echo-retired-by-backstop` at `debug`", async () => {
        const h = overlayHarness();
        await h.seal(echo("e1"), [{ id: "of:out" }]);
        h.confirmedSeqs.set("of:out", FLOOR + 1);
        h.watermarkSinks[0]({ seq: FLOOR - 1 });
        expect(h.destination.entryCount(SPACE)).toBe(1);
        using logs = captureLogs("speculation-overlay");
        h.watermarkSinks[0]({ seq: FLOOR + 5 });
        expect(h.destination.entryCount(SPACE)).toBe(0);
        expect(logs.textsOf("intent-echo-retired-by-backstop")).toEqual([
          "intent echo e1 retired by watermark coverage",
        ]);
      });

      it("sweeps when a doc an entry wrote arrives, not when another doc does, and logs `arrival-sweep` at `debug`", async () => {
        const h = overlayHarness();
        await h.seal(derivation, [{ id: "of:out" }]);
        h.watermarkSinks[0]({ seq: FLOOR + 5 });
        expect(h.destination.entryCount(SPACE)).toBe(1);
        h.confirmedSeqs.set("of:out", FLOOR + 1);
        using logs = captureLogs("speculation-overlay");
        h.replica.speculationArrivalObserver?.([
          { id: "of:unrelated", scope: "space" },
        ]);
        expect(h.destination.arrivalSweepCount).toBe(0);
        expect(h.destination.entryCount(SPACE)).toBe(1);
        h.replica.speculationArrivalObserver?.([
          { id: "of:out", scope: "space" },
        ]);
        expect(h.destination.arrivalSweepCount).toBe(1);
        expect(h.destination.entryCount(SPACE)).toBe(0);
        expect(logs.textsOf("arrival-sweep")).toEqual([
          `authoritative value arrived for a speculated doc in ${SPACE}; ` +
          "re-sweeping the overlay (stage C tuning T2)",
        ]);
      });
    });

    describe("close()", () => {
      it("withdraws every entry and releases the listener and the replica's observers even when cancelling a watermark sink throws", async () => {
        const h = overlayHarness();
        await h.seal(derivation, [{ id: "of:out" }]);
        h.destination.trackIntent(SPACE, SIDECAR, "e1");
        h.faults.sinkCancel = new Error("sink already gone");
        h.destination.close();
        h.destination.close();
        expect(h.destination.entryCount(SPACE)).toBe(0);
        expect(h.destination.intentListenerInstalled).toBe(false);
        expect(h.replica.speculationAckObserver).toBeUndefined();
        expect(h.replica.speculationArrivalObserver).toBeUndefined();
        expect(await h.verdictOf(1)).toEqual({
          withdrawn: {
            message: "speculation overlay closed (runtime dispose)",
            superseded: true,
          },
        });
      });
    });
  });
});
