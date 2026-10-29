// Server-execution v2 Phase 4: the effects doc at the engine
// (docs/specs/server-side-execution/protocol.md §5). These tests pin:
//
// - `issuedIn` STAMPING (the stream-entry `seq` precedent): a
//   derived-class write of the well-known effects doc gets its intent
//   entries' `null` sentinels stamped with the issuing commit's seq —
//   append patches and whole-value sets both; an AUTHORED write
//   carrying the sentinel (a client authoring into its own instance —
//   protocol.md §1's accepted intrusion class) is stored as-is.
// - APPEND NONCE DEDUPE: a derived append whose nonce already exists in
//   the STORED instance is dropped from the append — the deterministic
//   nonce (one per event × navigateTo instance) makes producer re-runs
//   idempotent at the store, whatever the serving replica's collapsed
//   local view said. Whole-value SETs are exempt (the retirement write
//   rewrites SURVIVING entries — deduping those against themselves
//   would empty every retirement).
// - PER-INSTANCE ADDRESSING: two sessions' intents land in two
//   `session:` instances of the ONE doc id, keyed by the write
//   annotations (T2.Q1 — the SpaceServer names the key), and neither
//   bleeds into the other.
// - `selectRetirableEffectsInstances` (the next-wave retirement scan):
//   acked entries retire with their marks, UNACKED entries persist
//   (LT8's reload journey re-reads them), stale marks prune, non-`session:`
//   instances and malformed values never wedge the scan.

import { assert, assertEquals } from "@std/assert";
import { toFileUrl } from "@std/path";
import {
  applyCommit,
  applyWaveCommit,
  type Engine,
  open,
  readState,
  selectRetirableEffectsInstances,
} from "../v2/engine.ts";
import {
  acquireExecutionLease,
  executionLeaseHolder,
} from "../v2/execution-lease.ts";
import {
  type ClientCommit,
  type EffectIntentEntry,
  effectIntentNonce,
  resetServerExecutionConfig,
  resolvePrincipalSessionKey,
  resolveScopeKey,
  SERVER_EXECUTION_EFFECTS_DOC_ID,
  type SessionEffectsDocValue,
  setServerExecutionConfig,
} from "../v2.ts";

const SPACE = "did:key:z6Mk-effects-doc-test-space";
const SERVICE = `service:${SPACE}`;
const ALICE = "user:alice";
const BOB = "user:bob";
const ALICE_SESSION = "sess-alice-1";
const BOB_SESSION = "sess-bob-1";
const ALICE_KEY = resolvePrincipalSessionKey(ALICE, ALICE_SESSION);
const BOB_KEY = resolvePrincipalSessionKey(BOB, BOB_SESSION);

const createEngine = async (): Promise<{ engine: Engine; path: string }> => {
  const path = await Deno.makeTempFile({ suffix: ".sqlite" });
  const engine = await open({ url: toFileUrl(path) });
  return { engine, path };
};

const headSeqOf = (engine: Engine): number =>
  (engine.statements.selectServerSeq.get() as { seq: number }).seq;

const withLiveLease = (engine: Engine): string => {
  const holder = executionLeaseHolder(SERVICE);
  assert(acquireExecutionLease(engine, { space: SPACE, holder }));
  return holder;
};

const intentOf = (
  nonce: string,
  target = "of:target-piece",
): EffectIntentEntry => ({
  nonce,
  kind: "navigate",
  args: { target: { id: target, path: [] } },
  issuedIn: null,
});

/** A derived wave commit appending `entries` to one session instance of
 * the effects doc — the served navigateTo's write shape (a tail-relative
 * mergeable append arrives at the engine as an append patch), addressed
 * by the annotation's scope key. */
const waveAppendIntents = (
  engine: Engine,
  holder: string,
  localSeq: number,
  scopeKey: string,
  entries: EffectIntentEntry[],
) =>
  applyWaveCommit(engine, {
    sessionId: holder,
    space: SPACE,
    commitClass: "derived",
    holder,
    commit: {
      localSeq,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "patch",
        id: SERVER_EXECUTION_EFFECTS_DOC_ID as never,
        scope: "session",
        patches: [{
          op: "append",
          path: "/value/entries",
          values: entries as never[],
        }],
      }],
    },
    annotations: [{ op: 0, scopeKey }],
    waveBasis: { basisSeq: headSeqOf(engine), rebasedHeads: [] },
  });

/** The retirement write's shape: a derived whole-value SET of one
 * instance's pruned value (bookkeeping-stamped in the runner; at the
 * engine it is an annotated derived write like any other). */
const waveSetInstance = (
  engine: Engine,
  holder: string,
  localSeq: number,
  scopeKey: string,
  value: SessionEffectsDocValue,
) =>
  applyWaveCommit(engine, {
    sessionId: holder,
    space: SPACE,
    commitClass: "derived",
    holder,
    commit: {
      localSeq,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: SERVER_EXECUTION_EFFECTS_DOC_ID as never,
        scope: "session",
        value: { value } as never,
      }],
    },
    annotations: [{ op: 0, scopeKey }],
    waveBasis: { basisSeq: headSeqOf(engine), rebasedHeads: [] },
  });

const instanceValue = (
  engine: Engine,
  scopeKey: string,
): SessionEffectsDocValue =>
  (readState(engine, { id: SERVER_EXECUTION_EFFECTS_DOC_ID, scopeKey })
    ?.document?.value ?? {}) as SessionEffectsDocValue;

/** An AUTHORED ack commit: the session's own `acks[nonce] = true` mark —
 * the client names NO key; admission resolves the instance from the
 * (principal, sessionId) envelope (T2.Q3). */
const ackCommit = (
  engine: Engine,
  principal: string,
  sessionId: string,
  localSeq: number,
  nonce: string,
) =>
  applyCommit(engine, {
    sessionId,
    principal,
    commit: {
      localSeq,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "patch",
        id: SERVER_EXECUTION_EFFECTS_DOC_ID as never,
        scope: "session",
        patches: [{
          op: "add",
          path: `/value/acks/${nonce}`,
          value: true as never,
        }],
      }],
    } as ClientCommit,
  });

Deno.test("effects doc: issuedIn stamping, nonce dedupe, per-instance addressing", async (t) => {
  const { engine, path } = await createEngine();
  setServerExecutionConfig(true);
  try {
    const holder = withLiveLease(engine);
    const nonceA = effectIntentNonce("evt-1", "of:nav-1");

    await t.step(
      "a derived append stamps issuedIn with the issuing commit's seq",
      () => {
        const outcome = waveAppendIntents(engine, holder, 1, ALICE_KEY, [
          intentOf(nonceA),
        ]);
        assert(outcome.seq !== undefined);
        const value = instanceValue(engine, ALICE_KEY);
        assertEquals(value.entries?.length, 1);
        assertEquals(value.entries?.[0].nonce, nonceA);
        assertEquals(value.entries?.[0].issuedIn, outcome.seq);
      },
    );

    await t.step(
      "a duplicate nonce append is dropped against the stored instance (producer re-runs are idempotent)",
      () => {
        waveAppendIntents(engine, holder, 2, ALICE_KEY, [
          intentOf(nonceA),
        ]);
        const value = instanceValue(engine, ALICE_KEY);
        assertEquals(value.entries?.length, 1);
      },
    );

    await t.step(
      "two sessions' intents land in two instances of the one doc id — neither bleeds (T2.Q1)",
      () => {
        const nonceB = effectIntentNonce("evt-2", "of:nav-2");
        waveAppendIntents(engine, holder, 3, BOB_KEY, [intentOf(nonceB)]);
        const alice = instanceValue(engine, ALICE_KEY);
        const bob = instanceValue(engine, BOB_KEY);
        assertEquals(alice.entries?.map((entry) => entry.nonce), [nonceA]);
        assertEquals(bob.entries?.map((entry) => entry.nonce), [nonceB]);
      },
    );

    await t.step(
      "a whole-value SET is exempt from dedupe (the retirement write survives)",
      () => {
        // Rewrite alice's instance keeping the SAME nonce — the
        // retirement shape. Dedupe must not empty it.
        const kept = instanceValue(engine, ALICE_KEY).entries![0];
        waveSetInstance(engine, holder, 4, ALICE_KEY, {
          entries: [kept],
          acks: {},
        });
        const value = instanceValue(engine, ALICE_KEY);
        assertEquals(value.entries?.length, 1);
        assertEquals(value.entries?.[0].nonce, nonceA);
        // The stored entry was already stamped; the set preserved it.
        assertEquals(typeof value.entries?.[0].issuedIn, "number");
      },
    );

    await t.step(
      "an AUTHORED write carrying the sentinel is stored as-is (no stamp for intrusions)",
      () => {
        const forged = intentOf("nav:forged");
        applyCommit(engine, {
          sessionId: ALICE_SESSION,
          principal: ALICE,
          commit: {
            localSeq: 10,
            reads: { confirmed: [], pending: [] },
            operations: [{
              op: "patch",
              id: SERVER_EXECUTION_EFFECTS_DOC_ID as never,
              scope: "session",
              patches: [{
                op: "append",
                path: "/value/entries",
                values: [forged] as never[],
              }],
            }],
          } as ClientCommit,
        });
        const value = instanceValue(engine, ALICE_KEY);
        const stored = value.entries?.find((entry) =>
          entry.nonce === "nav:forged"
        );
        assert(stored !== undefined);
        assertEquals(stored.issuedIn, null);
      },
    );
  } finally {
    resetServerExecutionConfig();
    engine.database.close();
    await Deno.remove(path).catch(() => {});
  }
});

Deno.test("effects doc: the retirement scan (protocol §5's next-wave retirement)", async (t) => {
  const { engine, path } = await createEngine();
  setServerExecutionConfig(true);
  try {
    const holder = withLiveLease(engine);
    const acked = effectIntentNonce("evt-a", "of:nav-a");
    const unacked = effectIntentNonce("evt-b", "of:nav-b");
    waveAppendIntents(engine, holder, 1, ALICE_KEY, [
      intentOf(acked),
      intentOf(unacked),
    ]);

    await t.step("no acks: nothing retirable", () => {
      assertEquals(selectRetirableEffectsInstances(engine).length, 0);
    });

    await t.step(
      "an authored ack (no key named — the session resolves its own instance, T2.Q3) makes the instance retirable",
      () => {
        ackCommit(engine, ALICE, ALICE_SESSION, 1, acked);
        const retirable = selectRetirableEffectsInstances(engine);
        assertEquals(retirable.length, 1);
        assertEquals(retirable[0].scopeKey, ALICE_KEY);
        assertEquals(retirable[0].retiredNonces, [acked]);
        // UNACKED intents persist (LT8's reload journey re-reads them).
        assertEquals(
          retirable[0].remainingEntries.map((entry) => entry.nonce),
          [unacked],
        );
        assertEquals(Object.keys(retirable[0].remainingAcks), []);
      },
    );

    await t.step(
      "the retirement write lands the pruned value; the next scan is clean",
      () => {
        const [instance] = selectRetirableEffectsInstances(engine);
        waveSetInstance(engine, holder, 5, ALICE_KEY, {
          entries: instance.remainingEntries,
          acks: instance.remainingAcks,
        });
        assertEquals(selectRetirableEffectsInstances(engine).length, 0);
        const value = instanceValue(engine, ALICE_KEY);
        assertEquals(value.entries?.map((entry) => entry.nonce), [unacked]);
        assertEquals(value.acks, {});
      },
    );

    await t.step(
      "a stale ack mark (naming no stored entry) is retirable hygiene",
      () => {
        ackCommit(engine, ALICE, ALICE_SESSION, 2, "nav:never-issued");
        const retirable = selectRetirableEffectsInstances(engine);
        assertEquals(retirable.length, 1);
        assertEquals(retirable[0].retiredNonces, []);
        assertEquals(
          retirable[0].remainingEntries.map((entry) => entry.nonce),
          [unacked],
        );
        assertEquals(Object.keys(retirable[0].remainingAcks), []);
        waveSetInstance(engine, holder, 6, ALICE_KEY, {
          entries: retirable[0].remainingEntries,
          acks: retirable[0].remainingAcks,
        });
        assertEquals(selectRetirableEffectsInstances(engine).length, 0);
      },
    );

    await t.step(
      "a NON-SESSION instance is skipped by the scan even when acked-shaped (T9: the effects doc is session-scoped by definition)",
      () => {
        // A user-scoped instance of the well-known doc id, holding
        // exactly the shape that WOULD retire in a session instance
        // (an entry plus its ack mark). The scan's session filter
        // must skip it — the retirement writer stamps a SESSION
        // identity parsed from the key, and a user-keyed write here
        // would land bookkeeping under an unparseable identity.
        const userKey = resolveScopeKey("user", { principal: ALICE });
        const ackedNonce = effectIntentNonce("evt-user", "of:nav-user");
        applyWaveCommit(engine, {
          sessionId: holder,
          space: SPACE,
          commitClass: "derived",
          holder,
          commit: {
            localSeq: 30,
            reads: { confirmed: [], pending: [] },
            operations: [{
              op: "set",
              id: SERVER_EXECUTION_EFFECTS_DOC_ID as never,
              scope: "user",
              value: {
                value: {
                  entries: [intentOf(ackedNonce)],
                  acks: { [ackedNonce]: true },
                },
              } as never,
            }],
          },
          annotations: [{ op: 0, scopeKey: userKey }],
          waveBasis: { basisSeq: headSeqOf(engine), rebasedHeads: [] },
        });
        // The acked-shaped user instance stored (non-vacuity)…
        const stored = readState(engine, {
          id: SERVER_EXECUTION_EFFECTS_DOC_ID,
          scopeKey: userKey,
        })?.document?.value as SessionEffectsDocValue | undefined;
        assertEquals(stored?.entries?.length, 1);
        // …and the scan returns NOTHING for it (discriminated below:
        // a session instance with the same shape IS returned).
        assertEquals(
          selectRetirableEffectsInstances(engine)
            .filter((instance) => instance.scopeKey === userKey),
          [],
        );
        ackCommit(engine, ALICE, ALICE_SESSION, 3, unacked);
        const retirable = selectRetirableEffectsInstances(engine);
        assertEquals(retirable.map((instance) => instance.scopeKey), [
          ALICE_KEY,
        ]);
        // Clean up: retire alice's instance so later steps start
        // clean.
        waveSetInstance(engine, holder, 31, ALICE_KEY, {
          entries: [],
          acks: {},
        });
        assertEquals(selectRetirableEffectsInstances(engine).length, 0);
      },
    );

    await t.step(
      "dedupe consults the OP'S OWN instance only: a space-addressed duplicate of a session nonce is not deduped, and stamping still applies",
      () => {
        // The dedupe-skip arm (transformEffectsDocOperation): with no
        // session key to resolve — a space-level derived write carries
        // no annotation — the dedupe basis is the op's own (space)
        // instance, NEVER another instance's. A nonce already stored
        // in alice's SESSION instance therefore does not suppress a
        // space-addressed append of the same nonce, and the `issuedIn`
        // stamping proceeds regardless of the skipped dedupe.
        const sessionNonce = effectIntentNonce("evt-space", "of:nav-space");
        waveAppendIntents(engine, holder, 40, ALICE_KEY, [
          intentOf(sessionNonce),
        ]);
        const outcome = applyWaveCommit(engine, {
          sessionId: holder,
          space: SPACE,
          commitClass: "derived",
          holder,
          commit: {
            localSeq: 41,
            reads: { confirmed: [], pending: [] },
            operations: [{
              op: "patch",
              id: SERVER_EXECUTION_EFFECTS_DOC_ID as never,
              patches: [{
                op: "append",
                path: "/value/entries",
                values: [intentOf(sessionNonce)] as never[],
              }],
            }],
          },
          waveBasis: { basisSeq: headSeqOf(engine), rebasedHeads: [] },
        });
        assert(outcome.seq !== undefined);
        const spaceValue = readState(engine, {
          id: SERVER_EXECUTION_EFFECTS_DOC_ID,
          scopeKey: "space",
        })?.document?.value as SessionEffectsDocValue | undefined;
        // Not deduped against the session instance…
        assertEquals(spaceValue?.entries?.length, 1);
        assertEquals(spaceValue?.entries?.[0].nonce, sessionNonce);
        // …and stamped (dedupe skipped ≠ stamping skipped).
        assertEquals(spaceValue?.entries?.[0].issuedIn, outcome.seq);
        // The session instance kept exactly its own copy.
        assertEquals(
          instanceValue(engine, ALICE_KEY).entries?.filter((entry) =>
            entry.nonce === sessionNonce
          ).length,
          1,
        );
      },
    );

    await t.step(
      "a malformed instance value never wedges the scan",
      () => {
        // A client can author garbage into its OWN instance
        // (protocol.md §1's threat model): the scan must skip, not
        // throw.
        applyCommit(engine, {
          sessionId: BOB_SESSION,
          principal: BOB,
          commit: {
            localSeq: 20,
            reads: { confirmed: [], pending: [] },
            operations: [{
              op: "set",
              id: SERVER_EXECUTION_EFFECTS_DOC_ID as never,
              scope: "session",
              value: { value: { entries: "garbage", acks: 7 } } as never,
            }],
          } as ClientCommit,
        });
        // The garbage actually STORED (else the defensive arms never
        // execute and this step is vacuous).
        const stored = readState(engine, {
          id: SERVER_EXECUTION_EFFECTS_DOC_ID,
          scopeKey: resolvePrincipalSessionKey(BOB, BOB_SESSION),
        })?.document?.value as Record<string, unknown> | undefined;
        assertEquals(stored?.entries, "garbage");
        assertEquals(selectRetirableEffectsInstances(engine).length, 0);
      },
    );
  } finally {
    resetServerExecutionConfig();
    engine.database.close();
    await Deno.remove(path).catch(() => {});
  }
});
