// Server-execution v2 Phase 3 (D-v2-1): event-append admission at the
// engine (docs/specs/server-side-execution/events.md §1/§4,
// protocol.md §2's event-append rows). These tests pin:
//
// - the authored event-append row: append authority + the dedupe-horizon
//   CAS + server-stamped `firedAt` from the authenticated envelope; a
//   disagreeing client-supplied `firedAt` is REJECTED, never corrected;
//   `clientSeq` stays client-minted and rides through.
// - the sidecar write guard (events.md §1/§4/§5): authored traffic may
//   reach a stream sidecar doc ONLY as declared tail appends — deeper
//   patches, watermark writes, whole-doc rewrites of an existing log,
//   and deletes are refused; processing fields and entry `seq`s must
//   arrive ABSENT (a pre-supplied one forges processing state).
// - LT1 derived carriage: a wave-carried same-space entry needs the
//   inherited `firedAt` already written (one trust environment — no
//   validation, but it must EXIST) and never a `clientSeq` (LT7); the
//   engine stamps the entry's stream `seq`. Derived commits stay exempt
//   from the authored SHAPE guard (the SpaceServer writes consequences
//   and the watermark) but their appends must still be DECLARED.
// - delegated stamping: `firedAt` from the validated CARRIED actor —
//   and the OW15 floor carve-out (SHAPE RULED 2026-08-05, protocol.md
//   §2): a userless batch admits IFF declared sessionless-space-scope,
//   stamping `firedAt = { session: "server" }` with NO user key; grant
//   presence stays mandatory; the floor negatives hold BOTH ways and a
//   declaration alongside a present actor is a refused contradiction.
// - the dedupe horizon (events.md §4): uniqueness among entries above
//   the stream's `eventWatermark` only — an at-or-below duplicate
//   ADMITS as a new entry (processing skips it); the stage-G seq-less
//   arm dedupes only while un-consequenced.
// - replay: a replayed (sessionId, localSeq) append returns its stored
//   result without re-running the CAS against its own entry.
// - `selectPendingStreamEventDocs`: the activation/boot discovery input
//   (serving-loop.md §1, §6 step 4) — entries above the watermark and
//   un-consequenced only, sidecar docs only.

import { assert, assertEquals, assertThrows } from "@std/assert";
import { toFileUrl } from "@std/path";
import { Database } from "@db/sqlite";
import {
  applyCommit,
  applyWaveCommit,
  type Engine,
  open,
  ProtocolError,
  read,
  selectPendingStreamEventDocs,
} from "../v2/engine.ts";
import {
  acquireExecutionLease,
  executionLeaseHolder,
} from "../v2/execution-lease.ts";
import {
  aliasForDbId,
  attachDatabase,
  detachDatabase,
  ensureTables,
  runQuery,
} from "../v2/sqlite/exec.ts";
import { table as sqliteTable } from "../v2/sqlite/schema.ts";
import {
  type ClientCommit,
  EventAppendDuplicateError,
  resetServerExecutionConfig,
  SERVER_EXECUTION_ATTENTION_DOC_ID,
  setServerExecutionConfig,
  STREAM_ENTRIES_DOC_PREFIX,
  streamEntriesDocId,
  type StreamEventEntry,
  type StreamEventsDocValue,
  toValuePath,
} from "../v2.ts";

const SPACE = "did:key:z6Mk-event-append-test-space";
const SERVICE = `service:${SPACE}`;
const ALICE = "user:alice";
const SESSION = "sess-1";

// One deterministic sidecar id per test stream (events.md §1's stream
// document, concretely — the id every party derives from the stream
// link with no coordination).
const STREAM = { id: "of:poll-result", path: ["votes"] };
const SIDECAR = streamEntriesDocId(STREAM);

const createEngine = async (): Promise<{ engine: Engine; path: string }> => {
  const path = await Deno.makeTempFile({ suffix: ".sqlite" });
  const engine = await open({ url: toFileUrl(path) });
  return { engine, path };
};

const entryOf = (
  eventId: string,
  overrides: Partial<StreamEventEntry> = {},
): StreamEventEntry => ({
  eventId,
  stream: STREAM,
  payload: { vote: "green" },
  ...overrides,
});

/** An authored client commit appending `entries` to the sidecar via the
 * tail-relative patch op (the canonical fire shape), declaring each. */
const appendCommit = (
  localSeq: number,
  entries: StreamEventEntry[],
  options: { declare?: Array<{ eventId: string }> } = {},
): ClientCommit => ({
  localSeq,
  reads: { confirmed: [], pending: [] },
  operations: [{
    op: "patch",
    id: SIDECAR,
    patches: [{
      op: "append",
      path: "/value/entries",
      values: entries as never[],
    }],
  }],
  eventAppends: (options.declare ?? entries).map((entry) => ({
    id: SIDECAR,
    eventId: entry.eventId,
  })),
});

const sidecarValue = (engine: Engine): StreamEventsDocValue =>
  (read(engine, { id: SIDECAR })?.value ?? {}) as StreamEventsDocValue;

const withLiveLease = (engine: Engine): string => {
  const holder = executionLeaseHolder(SERVICE);
  assert(acquireExecutionLease(engine, { space: SPACE, holder }));
  return holder;
};

/** A derived-class wave commit whose single op SETS the sidecar doc —
 * the SpaceServer's consequence/watermark write shape (exempt from the
 * authored shape guard; appended NEW entries must still be declared). */
const waveSetSidecar = (
  engine: Engine,
  holder: string,
  localSeq: number,
  value: StreamEventsDocValue,
  options: {
    declare?: Array<{ eventId: string }>;
    basisSeq?: number;
  } = {},
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
        id: SIDECAR as never,
        value: { value } as never,
      }],
      ...(options.declare !== undefined
        ? {
          eventAppends: options.declare.map((d) => ({
            id: SIDECAR,
            eventId: d.eventId,
          })),
        }
        : {}),
    },
    waveBasis: {
      basisSeq: options.basisSeq ?? headSeqOf(engine),
      rebasedHeads: [],
    },
  });

const headSeqOf = (engine: Engine): number =>
  (engine.statements.selectServerSeq.get() as { seq: number }).seq;

const commitActingColumns = (
  path: string,
  seq: number,
): { acting_principal: string | null; acting_session: string | null } => {
  const db = new Database(path, { readonly: true });
  try {
    return db.prepare(
      `SELECT acting_principal, acting_session FROM "commit"
       WHERE seq = :seq`,
    ).get({ seq }) as {
      acting_principal: string | null;
      acting_session: string | null;
    };
  } finally {
    db.close();
  }
};

Deno.test("event-append admission: the authored row, end to end", async (t) => {
  const { engine, path } = await createEngine();
  setServerExecutionConfig(true);
  try {
    await t.step(
      "an authored append is admitted, seq- and firedAt-stamped from the envelope; clientSeq rides through",
      () => {
        const applied = applyCommit(engine, {
          sessionId: SESSION,
          space: SPACE,
          principal: ALICE,
          commit: appendCommit(1, [
            entryOf("evt-1", { firedAt: { clientSeq: 4 } as never }),
          ]),
        });
        const value = sidecarValue(engine);
        assertEquals(value.entries?.length, 1);
        const entry = value.entries![0];
        assertEquals(entry.eventId, "evt-1");
        assertEquals(entry.seq, applied.seq);
        assertEquals(entry.firedAt, {
          user: ALICE,
          session: SESSION,
          clientSeq: 4,
        });
        // The stamp lands in the STORED doc; the commit's `original`
        // (replay comparison) keeps the as-received payload.
      },
    );

    await t.step(
      "a client-supplied firedAt that disagrees is REJECTED, never corrected",
      () => {
        assertThrows(
          () =>
            applyCommit(engine, {
              sessionId: SESSION,
              space: SPACE,
              principal: ALICE,
              commit: appendCommit(2, [
                entryOf("evt-2", {
                  firedAt: { user: "user:mallory", session: SESSION },
                }),
              ]),
            }),
          ProtocolError,
          "disagrees with the authenticated envelope",
        );
        // An agreeing firedAt is fine (idempotent restatement).
        applyCommit(engine, {
          sessionId: SESSION,
          space: SPACE,
          principal: ALICE,
          commit: appendCommit(3, [
            entryOf("evt-2", {
              firedAt: { user: ALICE, session: SESSION },
            }),
          ]),
        });
        assertEquals(sidecarValue(engine).entries?.length, 2);
      },
    );

    await t.step(
      "an append without an authenticated principal is refused (nothing to stamp from)",
      () => {
        assertThrows(
          () =>
            applyCommit(engine, {
              sessionId: SESSION,
              space: SPACE,
              commit: appendCommit(4, [entryOf("evt-3")]),
            }),
          ProtocolError,
          "requires an authenticated principal",
        );
      },
    );

    await t.step(
      "the dedupe-horizon CAS refuses an above-horizon duplicate",
      () => {
        assertThrows(
          () =>
            applyCommit(engine, {
              sessionId: SESSION,
              space: SPACE,
              principal: ALICE,
              commit: appendCommit(5, [entryOf("evt-1")]),
            }),
          EventAppendDuplicateError,
          "duplicates a stream entry above the dedupe horizon",
        );
      },
    );

    await t.step(
      "replay of the SAME (sessionId, localSeq) append returns the stored result — never its own duplicate",
      () => {
        // localSeq 1 was evt-1's admitting commit. Replaying it must
        // short-circuit BEFORE the CAS (events.md §5's ambiguous-network
        // retry: the client resubmits the identical commit).
        const replayed = applyCommit(engine, {
          sessionId: SESSION,
          space: SPACE,
          principal: ALICE,
          commit: appendCommit(1, [
            entryOf("evt-1", { firedAt: { clientSeq: 4 } as never }),
          ]),
        });
        assertEquals(sidecarValue(engine).entries?.length, 2, "no new entry");
        assert(replayed.seq > 0);
      },
    );

    await t.step(
      "an at-or-below-horizon duplicate ADMITS as a new entry (processing skips it — admission must not bless a stronger dedupe)",
      () => {
        const holder = withLiveLease(engine);
        // The SpaceServer consequences both entries and advances the
        // per-stream watermark past them (derived-class, shape-exempt).
        const value = sidecarValue(engine);
        const topSeq = Math.max(
          ...value.entries!.map((entry) => entry.seq ?? 0),
        );
        waveSetSidecar(engine, holder, 100, {
          entries: value.entries!.map((entry) => ({
            ...entry,
            consequenced: true,
          })),
          eventWatermark: topSeq,
        });
        const applied = applyCommit(engine, {
          sessionId: SESSION,
          space: SPACE,
          principal: ALICE,
          commit: appendCommit(6, [entryOf("evt-1")]),
        });
        const after = sidecarValue(engine);
        assertEquals(after.entries?.length, 3);
        assertEquals(after.entries![2].eventId, "evt-1");
        assertEquals(after.entries![2].seq, applied.seq);
      },
    );
  } finally {
    resetServerExecutionConfig();
    await Deno.remove(path).catch(() => {});
  }
});

Deno.test("event-append admission: declarations and the sidecar write guard", async (t) => {
  const { engine, path } = await createEngine();
  setServerExecutionConfig(true);
  const authored = (localSeq: number, commit: Partial<ClientCommit>) =>
    applyCommit(engine, {
      sessionId: SESSION,
      space: SPACE,
      principal: ALICE,
      commit: {
        localSeq,
        reads: { confirmed: [], pending: [] },
        operations: [],
        ...commit,
      },
    });
  try {
    await t.step("an UNDECLARED appended entry is refused", () => {
      assertThrows(
        () =>
          authored(1, {
            operations: appendCommit(1, [entryOf("evt-a")]).operations,
            eventAppends: [],
          }),
        ProtocolError,
        "undeclared event append",
      );
    });

    await t.step(
      "a declaration with no matching appended entry is refused",
      () => {
        assertThrows(
          () =>
            authored(2, {
              operations: [{
                op: "set",
                id: "of:plain" as never,
                value: { value: { n: 1 } } as never,
              }],
              eventAppends: [{ id: SIDECAR, eventId: "evt-ghost" }],
            }),
          ProtocolError,
          "without a matching appended entry",
        );
      },
    );

    await t.step("duplicate declarations in one commit are refused", () => {
      assertThrows(
        () =>
          authored(3, {
            ...appendCommit(3, [entryOf("evt-b")]),
            eventAppends: [
              { id: SIDECAR, eventId: "evt-b" },
              { id: SIDECAR, eventId: "evt-b" },
            ],
          }),
        ProtocolError,
        "duplicate event-append declaration",
      );
    });

    await t.step(
      "a declaration targeting a non-sidecar doc is refused",
      () => {
        assertThrows(
          () =>
            authored(4, {
              operations: [{
                op: "set",
                id: "of:plain" as never,
                value: { value: { n: 2 } } as never,
              }],
              eventAppends: [{ id: "of:plain-doc", eventId: "evt-c" }],
            }),
          ProtocolError,
          "non-stream doc",
        );
      },
    );

    await t.step(
      "a pre-supplied entry seq is refused (forged ordering)",
      () => {
        assertThrows(
          () => authored(5, appendCommit(5, [entryOf("evt-d", { seq: 999 })])),
          ProtocolError,
          "pre-supplies the stream seq",
        );
      },
    );

    await t.step(
      "pre-supplied processing fields are refused (forged consequences)",
      () => {
        for (
          const overrides of [
            { consequenced: true },
            { error: "boo" },
            { status: "dropped" as const, reason: "x" },
          ]
        ) {
          assertThrows(
            () => authored(6, appendCommit(6, [entryOf("evt-e", overrides)])),
            ProtocolError,
            "pre-supplies processing fields",
          );
        }
      },
    );

    await t.step("an entry without a stream link is refused", () => {
      assertThrows(
        () =>
          authored(
            7,
            appendCommit(7, [
              entryOf("evt-f", { stream: undefined as never }),
            ]),
          ),
        ProtocolError,
        "carries no stream link",
      );
    });

    await t.step(
      "an entry with malformed runtimeInjectedEventKeys is refused — the persisted carriage would throw in every drain pass, churning the serving loop forever (verdict blocker, 2026-08-12)",
      () => {
        for (
          const [seq, malformed] of [
            [31, 42],
            [32, "not-an-array"],
            [33, [1, 2]],
            [34, { keys: [] }],
          ] as const
        ) {
          assertThrows(
            () =>
              authored(
                seq,
                appendCommit(seq, [
                  entryOf(`evt-malformed-keys-${seq}`, {
                    runtimeInjectedEventKeys: malformed as never,
                  }),
                ]),
              ),
            ProtocolError,
            "runtimeInjectedEventKeys",
          );
        }
        // The well-formed positive still admits — on its OWN stream, so
        // the shared sidecar's log state stays untouched for the later
        // creation-shape steps.
        const keysStream = { id: "of:wellformed-keys", path: [] as string[] };
        const keysSidecar = streamEntriesDocId(keysStream);
        authored(35, {
          operations: [{
            op: "patch",
            id: keysSidecar,
            patches: [{
              op: "append",
              path: "/value/entries",
              values: [{
                eventId: "evt-wellformed-keys",
                stream: keysStream,
                payload: { vote: "green" },
                runtimeInjectedEventKeys: ["detail"],
              }] as never[],
            }],
          }],
          eventAppends: [{
            id: keysSidecar,
            eventId: "evt-wellformed-keys",
          }],
        });
      },
    );

    await t.step(
      "an entry with a malformed rendererTrusted attestation is refused — a present value must be exactly true (fan-out stage B, the sister of the injected-keys check); the well-formed positive admits",
      () => {
        for (
          const [seq, malformed] of [
            [36, "yes"],
            [37, 1],
            [38, false],
            [39, { trusted: true }],
          ] as const
        ) {
          assertThrows(
            () =>
              authored(
                seq,
                appendCommit(seq, [
                  entryOf(`evt-malformed-trust-${seq}`, {
                    rendererTrusted: malformed as never,
                  }),
                ]),
              ),
            ProtocolError,
            "rendererTrusted",
          );
        }
        const trustStream = { id: "of:wellformed-trust", path: [] as string[] };
        const trustSidecar = streamEntriesDocId(trustStream);
        authored(40, {
          operations: [{
            op: "patch",
            id: trustSidecar,
            patches: [{
              op: "append",
              path: "/value/entries",
              values: [{
                eventId: "evt-wellformed-trust",
                stream: trustStream,
                payload: { vote: "green" },
                rendererTrusted: true,
              }] as never[],
            }],
          }],
          eventAppends: [{
            id: trustSidecar,
            eventId: "evt-wellformed-trust",
          }],
        });
      },
    );

    await t.step(
      "requires an opaque string for Runtime reference carriage",
      () => {
        for (const [index, malformed] of [1, false, {}, []].entries()) {
          assertThrows(
            () =>
              authored(
                9000 + index,
                appendCommit(9000 + index, [
                  entryOf(`evt-malformed-reference-${index}`, {
                    runtimeReferenceContext: malformed as never,
                  }),
                ]),
              ),
            ProtocolError,
            "runtimeReferenceContext",
          );
        }
        const referenceStream = {
          id: "of:reference-carriage",
          path: [] as string[],
        };
        const referenceSidecar = streamEntriesDocId(referenceStream);
        authored(9010, {
          operations: [{
            op: "patch",
            id: referenceSidecar,
            patches: [{
              op: "append",
              path: "/value/entries",
              values: [{
                eventId: "evt-reference-carriage",
                stream: referenceStream,
                payload: { value: 1 },
                runtimeReferenceContext: "opaque-runtime-context",
              }] as never[],
            }],
          }],
          eventAppends: [{
            id: referenceSidecar,
            eventId: "evt-reference-carriage",
          }],
        });
        assertEquals(
          (read(engine, { id: referenceSidecar })
            ?.value as StreamEventsDocValue)
            .entries?.[0].runtimeReferenceContext,
          "opaque-runtime-context",
        );
      },
    );

    await t.step(
      "an entry whose stream link does not derive the sidecar being written is refused — a fresh sidecar id cannot smuggle another stream's handler dispatch past that stream's event-id horizon (verdict blocker, 2026-08-12)",
      () => {
        // The attack: append into a FRESH sidecar doc (empty horizon)
        // while the entry's self-describing `stream` names the REAL
        // stream — the drain would execute the named stream's handler,
        // and the duplicate eventId never met the real sidecar's
        // dedupe horizon.
        const freshSidecar = streamEntriesDocId({
          id: "of:unrelated",
          path: ["elsewhere"],
        });
        assertThrows(
          () =>
            authored(30, {
              operations: [{
                op: "patch",
                id: freshSidecar,
                patches: [{
                  op: "append",
                  path: "/value/entries",
                  values: [entryOf("evt-horizon-bypass")] as never[],
                }],
              }],
              eventAppends: [{
                id: freshSidecar,
                eventId: "evt-horizon-bypass",
              }],
            }),
          ProtocolError,
          "does not derive the sidecar",
        );
      },
    );

    await t.step("an entry without an eventId is refused", () => {
      assertThrows(
        () =>
          authored(
            8,
            appendCommit(8, [
              entryOf("", {}),
            ]),
          ),
        ProtocolError,
        "without an eventId",
      );
    });

    await t.step(
      "authored writes into a sidecar anywhere but the entries tail are refused",
      () => {
        // Deeper path (the per-stream watermark is SERVER-written).
        assertThrows(
          () =>
            authored(9, {
              operations: [{
                op: "patch",
                id: SIDECAR,
                patches: [{
                  op: "replace",
                  path: "/value/eventWatermark",
                  value: 0 as never,
                }],
              }],
            }),
          ProtocolError,
          "server-written",
        );
        // Deletion (compaction is the serving side's).
        assertThrows(
          () =>
            authored(10, {
              operations: [{ op: "delete", id: SIDECAR }],
            }),
          ProtocolError,
          "authored deletion of stream doc",
        );
      },
    );

    await t.step("authored writes cannot mutate the attention index", () => {
      for (
        const operation of [{
          op: "set" as const,
          id: SERVER_EXECUTION_ATTENTION_DOC_ID,
          value: { value: { entries: {} } },
        }, {
          op: "patch" as const,
          id: SERVER_EXECUTION_ATTENTION_DOC_ID,
          patches: [{ op: "remove" as const, path: "/value/entries" }],
        }, {
          op: "delete" as const,
          id: SERVER_EXECUTION_ATTENTION_DOC_ID,
        }]
      ) {
        assertThrows(
          () => authored(41, { operations: [operation] }),
          ProtocolError,
          "server-owned",
        );
      }
      resetServerExecutionConfig();
      try {
        assertThrows(
          () =>
            authored(41, {
              operations: [{
                op: "set",
                id: SERVER_EXECUTION_ATTENTION_DOC_ID,
                value: { value: { entries: {} } },
              }],
            }),
          ProtocolError,
          "server-owned",
        );
      } finally {
        setServerExecutionConfig(true);
      }
    });

    await t.step(
      "authored creation may seed the log; a whole-doc rewrite of an EXISTING log is refused",
      () => {
        // Creation via whole-doc set: no current doc, entries only.
        applyCommit(engine, {
          sessionId: SESSION,
          space: SPACE,
          principal: ALICE,
          commit: {
            localSeq: 11,
            reads: { confirmed: [], pending: [] },
            operations: [{
              op: "set",
              id: SIDECAR as never,
              value: { value: { entries: [entryOf("evt-g")] } } as never,
            }],
            eventAppends: [{ id: SIDECAR, eventId: "evt-g" }],
          },
        });
        assertEquals(sidecarValue(engine).entries?.length, 1);
        // A second whole-doc set now targets an EXISTING log: refused.
        assertThrows(
          () =>
            applyCommit(engine, {
              sessionId: SESSION,
              space: SPACE,
              principal: ALICE,
              commit: {
                localSeq: 12,
                reads: { confirmed: [], pending: [] },
                operations: [{
                  op: "set",
                  id: SIDECAR as never,
                  value: { value: { entries: [entryOf("evt-h")] } } as never,
                }],
                eventAppends: [{ id: SIDECAR, eventId: "evt-h" }],
              },
            }),
          ProtocolError,
          "authored whole-doc set of existing stream doc",
        );
        // Replacing the entries array through a patch is the other
        // whole-array vocabulary and must obey the same existing-log guard.
        assertThrows(
          () =>
            applyCommit(engine, {
              sessionId: SESSION,
              space: SPACE,
              principal: ALICE,
              commit: {
                localSeq: 13,
                reads: { confirmed: [], pending: [] },
                operations: [{
                  op: "patch",
                  id: SIDECAR,
                  patches: [{
                    op: "replace",
                    path: "/value/entries",
                    value: [entryOf("evt-h-patch")],
                  }],
                }],
                eventAppends: [{ id: SIDECAR, eventId: "evt-h-patch" }],
              },
            }),
          ProtocolError,
          "authored whole-array write",
        );
        // Creation carrying non-entry fields (a smuggled watermark) is
        // refused even on a fresh doc.
        const other = streamEntriesDocId({ id: "of:other", path: [] });
        assertThrows(
          () =>
            applyCommit(engine, {
              sessionId: SESSION,
              space: SPACE,
              principal: ALICE,
              commit: {
                localSeq: 14,
                reads: { confirmed: [], pending: [] },
                operations: [{
                  op: "set",
                  id: other as never,
                  value: {
                    value: {
                      entries: [{ ...entryOf("evt-i"), stream: STREAM }],
                      eventWatermark: 7,
                    },
                  } as never,
                }],
                eventAppends: [{ id: other, eventId: "evt-i" }],
              },
            }),
          ProtocolError,
          "non-entry fields",
        );
      },
    );

    await t.step("declared appends under the OFF arm are refused", () => {
      resetServerExecutionConfig();
      try {
        assertThrows(
          () => authored(14, appendCommit(14, [entryOf("evt-off")])),
          ProtocolError,
          "EXPERIMENTAL_SERVER_EXECUTION",
        );
      } finally {
        setServerExecutionConfig(true);
      }
    });
  } finally {
    resetServerExecutionConfig();
    await Deno.remove(path).catch(() => {});
  }
});

Deno.test("event-append admission: LT1 derived carriage and delegated stamping", async (t) => {
  const { engine, path } = await createEngine();
  setServerExecutionConfig(true);
  try {
    const holder = withLiveLease(engine);

    await t.step(
      "a derived-carried entry with the inherited firedAt is admitted and seq-stamped (LT1)",
      () => {
        const applied = waveSetSidecar(engine, holder, 1, {
          entries: [
            entryOf("evt-w1", {
              firedAt: { user: ALICE, session: SESSION },
            }),
          ],
        }, { declare: [{ eventId: "evt-w1" }] });
        const value = sidecarValue(engine);
        assertEquals(value.entries?.[0].seq, applied.seq);
        assertEquals(value.entries?.[0].firedAt, {
          user: ALICE,
          session: SESSION,
        });
      },
    );

    await t.step(
      "a derived-carried entry with NO inherited firedAt is refused (the stamp must exist)",
      () => {
        const stored = sidecarValue(engine).entries!;
        assertThrows(
          () =>
            waveSetSidecar(engine, holder, 2, {
              entries: [...stored, entryOf("evt-w2")],
            }, { declare: [{ eventId: "evt-w2" }] }),
          ProtocolError,
          "carries no inherited firedAt",
        );
      },
    );

    await t.step(
      "a derived-carried entry with a clientSeq is refused (LT7 — client-minted only)",
      () => {
        const stored = sidecarValue(engine).entries!;
        assertThrows(
          () =>
            waveSetSidecar(engine, holder, 3, {
              entries: [
                ...stored,
                entryOf("evt-w3", {
                  firedAt: {
                    user: ALICE,
                    session: SESSION,
                    clientSeq: 9,
                  } as never,
                }),
              ],
            }, { declare: [{ eventId: "evt-w3" }] }),
          ProtocolError,
          "clientSeq",
        );
      },
    );

    await t.step(
      "an UNDECLARED derived append is refused too (seq stamping cannot be skipped by a plumbing bug)",
      () => {
        const stored = sidecarValue(engine).entries!;
        assertThrows(
          () =>
            waveSetSidecar(engine, holder, 4, {
              entries: [
                ...stored,
                entryOf("evt-w4", {
                  firedAt: { session: "server" },
                }),
              ],
            }),
          ProtocolError,
          "undeclared event append",
        );
      },
    );

    await t.step(
      "a derived REWRITE of stamped entries passes untouched; a seq-bearing entry matching nothing stored is a refused forgery",
      () => {
        const stored = sidecarValue(engine).entries!;
        // Rewrite: consequence-mark the stored entry + advance the
        // per-stream watermark — the SpaceServer's §4 write shape.
        waveSetSidecar(engine, holder, 5, {
          entries: stored.map((entry) => ({ ...entry, consequenced: true })),
          eventWatermark: Math.max(...stored.map((e) => e.seq ?? 0)),
        });
        assertEquals(
          sidecarValue(engine).entries!.every((e) => e.consequenced === true),
          true,
        );
        // Forgery: a seq no stored entry holds.
        assertThrows(
          () =>
            waveSetSidecar(engine, holder, 6, {
              entries: [
                ...sidecarValue(engine).entries!,
                entryOf("evt-forged", {
                  seq: 9999,
                  firedAt: { session: "server" },
                }),
              ],
            }),
          ProtocolError,
          "no stored entry holds",
        );
      },
    );

    await t.step(
      "a derived NEW append may arrive already consequenced (same-wave processing commits entry + consequences together)",
      () => {
        const stored = sidecarValue(engine).entries!;
        const applied = waveSetSidecar(engine, holder, 7, {
          entries: [
            ...stored,
            entryOf("evt-w5", {
              firedAt: { user: ALICE, session: SESSION },
              consequenced: true,
            }),
          ],
        }, { declare: [{ eventId: "evt-w5" }] });
        const entry = sidecarValue(engine).entries!.find(
          (e) => e.eventId === "evt-w5",
        )!;
        assertEquals(entry.seq, applied.seq);
        assertEquals(entry.consequenced, true);
      },
    );

    await t.step(
      "the delegated row stamps firedAt from the CARRIED actor",
      () => {
        const applied = applyCommit(engine, {
          sessionId: `service:remote`,
          space: SPACE,
          commit: appendCommit(10, [entryOf("evt-d1")]),
          delegated: {
            actingPrincipal: ALICE,
            actingSession: SESSION,
            capabilityRef: "cap-1",
          },
        });
        const entries = sidecarValue(engine).entries!;
        const entry = entries.find((e) => e.eventId === "evt-d1")!;
        assertEquals(entry.firedAt, { user: ALICE, session: SESSION });
        assertEquals(entry.seq, applied.seq);
      },
    );

    await t.step(
      "a delegated entry supplying a clientSeq — or a disagreeing firedAt — is refused",
      () => {
        assertThrows(
          () =>
            applyCommit(engine, {
              sessionId: `service:remote`,
              space: SPACE,
              commit: appendCommit(11, [
                entryOf("evt-d2", {
                  firedAt: { clientSeq: 3 } as never,
                }),
              ]),
              delegated: {
                actingPrincipal: ALICE,
                actingSession: SESSION,
                capabilityRef: "cap-1",
              },
            }),
          ProtocolError,
          "clientSeq",
        );
        assertThrows(
          () =>
            applyCommit(engine, {
              sessionId: `service:remote`,
              space: SPACE,
              commit: appendCommit(12, [
                entryOf("evt-d3", {
                  firedAt: { user: "user:mallory", session: SESSION },
                }),
              ]),
              delegated: {
                actingPrincipal: ALICE,
                actingSession: SESSION,
                capabilityRef: "cap-1",
              },
            }),
          ProtocolError,
          "disagrees with the validated carried actor",
        );
      },
    );
  } finally {
    resetServerExecutionConfig();
    await Deno.remove(path).catch(() => {});
  }
});

Deno.test("OW15: the sessionless space-scope floor carve-out, both negatives and the positive", async (t) => {
  const { engine, path } = await createEngine();
  setServerExecutionConfig(true);
  const delegatedAppend = (
    localSeq: number,
    eventId: string,
    delegated: {
      actingPrincipal: string;
      actingSession?: string;
      capabilityRef: string;
      sessionlessSpaceScope?: boolean;
    },
    entry: Partial<StreamEventEntry> = {},
  ) =>
    applyCommit(engine, {
      sessionId: `service:remote`,
      space: SPACE,
      commit: appendCommit(localSeq, [entryOf(eventId, entry)]),
      delegated,
    });
  try {
    await t.step(
      "a userless batch WITH the declaration admits: firedAt = { session: 'server' }, NO user key, NULL acting principal",
      () => {
        const applied = delegatedAppend(1, "evt-s1", {
          actingPrincipal: "",
          capabilityRef: "cap-1",
          sessionlessSpaceScope: true,
        });
        const entry = sidecarValue(engine).entries!.find(
          (e) => e.eventId === "evt-s1",
        )!;
        assertEquals(entry.firedAt, { session: "server" });
        assertEquals("user" in entry.firedAt!, false);
        const row = commitActingColumns(path, applied.seq);
        assertEquals(row.acting_principal, null, "'no actor', never ''");
        assertEquals(row.acting_session, null);
      },
    );

    await t.step(
      "a userless batch WITHOUT the declaration stays refused (the floor negative)",
      () => {
        assertThrows(
          () =>
            delegatedAppend(2, "evt-s2", {
              actingPrincipal: "",
              capabilityRef: "cap-1",
            }),
          ProtocolError,
          "sessionless-space-scope carve-out",
        );
      },
    );

    await t.step(
      "the declaration alongside a present actor is a refused contradiction (both fields)",
      () => {
        assertThrows(
          () =>
            delegatedAppend(3, "evt-s3", {
              actingPrincipal: ALICE,
              capabilityRef: "cap-1",
              sessionlessSpaceScope: true,
            }),
          ProtocolError,
          "alongside an acting principal",
        );
        assertThrows(
          () =>
            delegatedAppend(4, "evt-s4", {
              actingPrincipal: "",
              actingSession: SESSION,
              capabilityRef: "cap-1",
              sessionlessSpaceScope: true,
            }),
          ProtocolError,
          "alongside an acting session",
        );
      },
    );

    await t.step("grant presence stays mandatory — declared or not", () => {
      assertThrows(
        () =>
          delegatedAppend(5, "evt-s5", {
            actingPrincipal: "",
            capabilityRef: "",
            sessionlessSpaceScope: true,
          }),
        ProtocolError,
        "capability grant",
      );
      assertThrows(
        () =>
          delegatedAppend(6, "evt-s6", {
            actingPrincipal: ALICE,
            capabilityRef: "",
          }),
        ProtocolError,
        "capability grant",
      );
    });

    await t.step(
      "a userless batch carrying a user-scoped write is refused (the chimera twin, user edition)",
      () => {
        assertThrows(
          () =>
            applyCommit(engine, {
              sessionId: `service:remote`,
              space: SPACE,
              commit: {
                localSeq: 7,
                reads: { confirmed: [], pending: [] },
                operations: [{
                  op: "set",
                  id: "of:user-doc" as never,
                  scope: "user",
                  value: { value: { n: 1 } } as never,
                }],
              },
              delegated: {
                actingPrincipal: "",
                capabilityRef: "cap-1",
                sessionlessSpaceScope: true,
              },
            }),
          ProtocolError,
          "has no user instance",
        );
      },
    );
  } finally {
    resetServerExecutionConfig();
    await Deno.remove(path).catch(() => {});
  }
});

Deno.test("event-append admission: the non-array /value/entries shape guard — both admission arms, both flag postures (M1+m4, review 2026-08-11)", async (t) => {
  const { engine, path } = await createEngine();
  setServerExecutionConfig(true);
  const authoredOps = (
    localSeq: number,
    operations: ClientCommit["operations"],
  ) =>
    applyCommit(engine, {
      sessionId: SESSION,
      space: SPACE,
      principal: ALICE,
      commit: {
        localSeq,
        reads: { confirmed: [], pending: [] },
        operations,
      },
    });
  try {
    await t.step(
      "flag ON: an authored `add` patch writing a NON-ARRAY at /value/entries is refused (the reviewer's repro: pre-fix it ADMITTED with zero located entries, then the pending scan TypeErrored)",
      () => {
        assertThrows(
          () =>
            authoredOps(1, [{
              op: "patch",
              id: SIDECAR,
              patches: [{
                op: "add",
                path: "/value/entries",
                value: "garbage-not-an-array" as never,
              }],
            }]),
          ProtocolError,
          "non-array",
        );
        // The scan stays callable — nothing admitted, nothing wedges
        // (pre-fix this line threw TypeError: .filter is not a function).
        assertEquals(selectPendingStreamEventDocs(engine).length, 0);
      },
    );

    await t.step(
      "flag ON: an authored `replace` patch writing a NON-ARRAY at /value/entries is refused",
      () => {
        assertThrows(
          () =>
            authoredOps(2, [{
              op: "patch",
              id: SIDECAR,
              patches: [{
                op: "replace",
                path: "/value/entries",
                value: { eventId: "evt-not-in-an-array" } as never,
              }],
            }]),
          ProtocolError,
          "non-array",
        );
      },
    );

    await t.step(
      "flag ON: an authored `append` patch with a NON-ARRAY values field is refused",
      () => {
        assertThrows(
          () =>
            authoredOps(3, [{
              op: "patch",
              id: SIDECAR,
              patches: [{
                op: "append",
                path: "/value/entries",
                values: "garbage-not-an-array" as never,
              }],
            }]),
          ProtocolError,
          "non-array",
        );
      },
    );

    await t.step(
      "flag ON: an authored whole-doc `set` whose entries field is a NON-ARRAY is refused (the set arm coerced it to [] pre-fix)",
      () => {
        assertThrows(
          () =>
            authoredOps(4, [{
              op: "set",
              id: SIDECAR as never,
              value: { value: { entries: "garbage-string" } } as never,
            }]),
          ProtocolError,
          "non-array",
        );
        assertEquals(selectPendingStreamEventDocs(engine).length, 0);
      },
    );

    await t.step(
      "the honest declared append is unaffected by the guard",
      () => {
        applyCommit(engine, {
          sessionId: SESSION,
          space: SPACE,
          principal: ALICE,
          commit: appendCommit(5, [entryOf("evt-honest")]),
        });
        const pending = selectPendingStreamEventDocs(engine);
        assertEquals(pending.length, 1);
        assertEquals(pending[0].entries[0].eventId, "evt-honest");
      },
    );

    await t.step(
      "m4, the OFF-arm refusal pin: an authored write into a sidecar-prefixed doc is refused with the flag OFF — OFF-written garbage (a non-array log, a forged firedAt actor) would otherwise poison the first ON activation",
      () => {
        resetServerExecutionConfig();
        try {
          const offSidecar = streamEntriesDocId({
            id: "of:off-arm-stream",
            path: [],
          });
          // The reviewer's m4 shapes, all refused prefix-keyed: the
          // non-array garbage AND the well-formed entry carrying a
          // forged firedAt (which no OFF-arm admission would validate).
          assertThrows(
            () =>
              authoredOps(6, [{
                op: "patch",
                id: offSidecar,
                patches: [{
                  op: "add",
                  path: "/value/entries",
                  value: "garbage" as never,
                }],
              }]),
            ProtocolError,
            "EXPERIMENTAL_SERVER_EXECUTION",
          );
          assertThrows(
            () =>
              authoredOps(7, [{
                op: "patch",
                id: offSidecar,
                patches: [{
                  op: "append",
                  path: "/value/entries",
                  values: [
                    entryOf("evt-forged", {
                      firedAt: { user: "user:mallory", session: "forged" },
                    }),
                  ] as never[],
                }],
              }]),
            ProtocolError,
            "EXPERIMENTAL_SERVER_EXECUTION",
          );
        } finally {
          setServerExecutionConfig(true);
        }
      },
    );

    await t.step(
      "the defensive scans: DERIVED-written garbage (trusted class, exempt from the authored shape guard) commits without wedging the recompute, and the pending scan skips it",
      () => {
        const holder = withLiveLease(engine);
        const garbageSidecar = streamEntriesDocId({
          id: "of:derived-garbage-stream",
          path: [],
        });
        // Pre-fix this THREW TypeError inside the apply transaction:
        // maintainStreamEventWatermarks ran `.filter` on the non-array.
        applyWaveCommit(engine, {
          sessionId: holder,
          space: SPACE,
          commitClass: "derived",
          holder,
          commit: {
            localSeq: 8,
            reads: { confirmed: [], pending: [] },
            operations: [{
              op: "set",
              id: garbageSidecar as never,
              value: { value: { entries: "derived-garbage" } } as never,
            }],
          },
          waveBasis: { basisSeq: headSeqOf(engine), rebasedHeads: [] },
        });
        // And the pending scan skips the malformed doc instead of
        // TypeErroring over it (the activate/park/drain/wave-close wedge).
        const pending = selectPendingStreamEventDocs(engine);
        assertEquals(pending.length, 1);
        assertEquals(pending[0].entries[0].eventId, "evt-honest");
      },
    );
  } finally {
    resetServerExecutionConfig();
    await Deno.remove(path).catch(() => {});
  }
});

Deno.test("maintainStreamEventWatermarks: the frontier holds below a pending entry and advances only over fully-consequenced seqs (C1 pin, review 2026-08-11)", async (t) => {
  const { engine, path } = await createEngine();
  setServerExecutionConfig(true);
  try {
    const holder = withLiveLease(engine);

    await t.step(
      "distinct seqs: an unconsequenced earlier entry holds the frontier at its floor — a later consequenced entry never advances past it",
      () => {
        // Two authored appends in separate commits: distinct stream seqs.
        applyCommit(engine, {
          sessionId: SESSION,
          space: SPACE,
          principal: ALICE,
          commit: appendCommit(1, [entryOf("evt-1")]),
        });
        applyCommit(engine, {
          sessionId: SESSION,
          space: SPACE,
          principal: ALICE,
          commit: appendCommit(2, [entryOf("evt-2")]),
        });
        const [e1, e2] = sidecarValue(engine).entries!;
        assert(typeof e1.seq === "number" && typeof e2.seq === "number");
        assert(e1.seq! < e2.seq!);

        // The derived rewrite marks ONLY the LATER entry consequenced.
        waveSetSidecar(engine, holder, 3, {
          entries: [e1, { ...e2, consequenced: true }],
        });
        // The hold: evt-1 (earlier seq, pending) blocks the frontier —
        // the watermark must NOT jump to evt-2's seq. (The reviewer's
        // probe — deleting the every(consequenced) hold — advances it
        // and turns this red.)
        const afterPartial = sidecarValue(engine);
        assert(
          (afterPartial.eventWatermark ?? 0) < e1.seq!,
          `frontier must hold below the pending entry, got ${afterPartial.eventWatermark}`,
        );

        // Mark evt-1 too: the frontier advances THROUGH it, and holds at
        // the contiguous consequenced top (evt-2's seq).
        waveSetSidecar(engine, holder, 4, {
          entries: [
            { ...e1, consequenced: true },
            { ...e2, consequenced: true },
          ],
        });
        assertEquals(sidecarValue(engine).eventWatermark, e2.seq);
      },
    );

    await t.step(
      "one commit seq, two entries: the seq's group advances only together (the every() clause verbatim)",
      () => {
        const groupStream = { id: "of:group-stream", path: [] as string[] };
        const groupSidecar = streamEntriesDocId(groupStream);
        const groupEntry = (eventId: string): StreamEventEntry => ({
          eventId,
          stream: groupStream,
          payload: { vote: "green" },
        });
        // ONE commit appends BOTH entries: they share the commit seq.
        applyCommit(engine, {
          sessionId: SESSION,
          space: SPACE,
          principal: ALICE,
          commit: {
            localSeq: 5,
            reads: { confirmed: [], pending: [] },
            operations: [{
              op: "patch",
              id: groupSidecar,
              patches: [{
                op: "append",
                path: "/value/entries",
                values: [groupEntry("evt-a"), groupEntry("evt-b")] as never[],
              }],
            }],
            eventAppends: [
              { id: groupSidecar, eventId: "evt-a" },
              { id: groupSidecar, eventId: "evt-b" },
            ],
          },
        });
        const readGroup = (): StreamEventsDocValue =>
          (read(engine, { id: groupSidecar })?.value ??
            {}) as StreamEventsDocValue;
        const [a, b] = readGroup().entries!;
        assertEquals(a.seq, b.seq);

        const groupRewrite = (
          localSeq: number,
          entries: StreamEventEntry[],
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
                id: groupSidecar as never,
                value: { value: { entries } } as never,
              }],
            },
            waveBasis: { basisSeq: headSeqOf(engine), rebasedHeads: [] },
          });

        // Half the group consequenced: the seq must NOT advance.
        groupRewrite(6, [{ ...a, consequenced: true }, b]);
        assert(
          (readGroup().eventWatermark ?? 0) < a.seq!,
          "a half-consequenced seq group must not advance the frontier",
        );

        // The whole group: the frontier takes the seq.
        groupRewrite(7, [
          { ...a, consequenced: true },
          { ...b, consequenced: true },
        ]);
        assertEquals(readGroup().eventWatermark, a.seq);
      },
    );
  } finally {
    resetServerExecutionConfig();
    await Deno.remove(path).catch(() => {});
  }
});

Deno.test("maintainStreamEventWatermarks: a folded sqlite op before the sidecar consequence must not collide the synthetic watermark opIndex (verdict blocker, 2026-08-12)", async () => {
  // sqlite ops consume OPERATION slots but push no revision, so a
  // synthetic index derived from `revisions.length` re-uses the sidecar
  // revision's own opIndex for `[sqlite, sidecar]` — a (seq, op_index)
  // primary-key collision that rolled back the whole handler wave.
  const { engine, path } = await createEngine();
  setServerExecutionConfig(true);
  const dbId = "of:watermark-db";
  const tables = {
    notes: sqliteTable({ id: "integer primary key", body: "text" }),
  };
  const alias = aliasForDbId(dbId);
  const dbPath = await Deno.makeTempFile({ suffix: ".sqlite" });
  attachDatabase(engine.database, alias, dbPath);
  ensureTables(engine.database, tables, alias);
  try {
    const holder = withLiveLease(engine);
    applyCommit(engine, {
      sessionId: SESSION,
      space: SPACE,
      principal: ALICE,
      commit: appendCommit(1, [entryOf("evt-sqlite-1")]),
    });
    const [entry] = sidecarValue(engine).entries!;
    assert(typeof entry.seq === "number");

    // The wave: sqlite FIRST (operation index 0, no revision), then the
    // consequenced sidecar rewrite (operation index 1) — the watermark
    // recompute appends its synthetic revision after both.
    applyWaveCommit(engine, {
      sessionId: holder,
      space: SPACE,
      commitClass: "derived",
      holder,
      sqliteAttachments: new Map([[dbId, alias]]),
      commit: {
        localSeq: 2,
        reads: { confirmed: [], pending: [] },
        operations: [
          {
            op: "sqlite",
            db: { id: dbId, tables },
            sql: "INSERT INTO notes (body) VALUES (?)",
            params: ["consequence"],
          },
          {
            op: "set",
            id: SIDECAR as never,
            value: {
              value: { entries: [{ ...entry, consequenced: true }] },
            } as never,
          },
        ],
      },
      waveBasis: { basisSeq: headSeqOf(engine), rebasedHeads: [] },
    });
    // Both halves landed atomically: the watermark advanced AND the
    // sqlite write is present (no rollback).
    assertEquals(sidecarValue(engine).eventWatermark, entry.seq);
    assertEquals(
      runQuery(engine.database, "SELECT body FROM notes"),
      [{ body: "consequence" }],
    );
  } finally {
    detachDatabase(engine.database, alias);
    resetServerExecutionConfig();
    await Deno.remove(path).catch(() => {});
    await Deno.remove(dbPath).catch(() => {});
  }
});

Deno.test("event attention retention: unresolved terminal covers survive every server rewrite until resolution", async () => {
  const { engine, path } = await createEngine();
  setServerExecutionConfig(true);
  try {
    const holder = withLiveLease(engine);
    applyCommit(engine, {
      sessionId: SESSION,
      space: SPACE,
      principal: ALICE,
      commit: appendCommit(1, [entryOf("evt-attention")]),
    });
    const [stored] = sidecarValue(engine).entries!;
    const attention = {
      phase: "dispatch-load" as const,
      failureClass: "session-revoked" as const,
      code: "permanent-delivery-failure" as const,
      firstFailureAt: 10,
      lastFailureAt: 10,
      accumulatedFailureMs: 0,
      failureCount: 1,
      recovery: "explicit-retry" as const,
    };
    waveSetSidecar(engine, holder, 1, {
      entries: [{
        ...stored,
        consequenced: true,
        status: "needs-attention",
        reason: "Event delivery needs attention",
        attention,
      }],
    });
    const terminal = sidecarValue(engine).entries![0];

    assertThrows(
      () => waveSetSidecar(engine, holder, 2, { entries: [] }),
      ProtocolError,
      "cannot alter or compact unresolved",
    );
    assertThrows(
      () =>
        waveSetSidecar(engine, holder, 3, {
          entries: [{ ...terminal, status: undefined, attention: undefined }],
        }),
      ProtocolError,
      "cannot alter or compact unresolved",
    );
    assertThrows(
      () =>
        waveSetSidecar(engine, holder, 4, {
          entries: [{ ...terminal, payload: { altered: true } }],
        }),
      ProtocolError,
      "cannot alter or compact unresolved",
    );
    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId: "server-attention-delete",
          space: SPACE,
          principal: ALICE,
          commitClass: "system",
          commit: {
            localSeq: 1,
            reads: { confirmed: [], pending: [] },
            operations: [{ op: "delete", id: SIDECAR }],
          },
        }),
      ProtocolError,
      "cannot remove unresolved needs-attention entries",
    );
    assertThrows(
      () =>
        applyCommit(engine, {
          sessionId: "server-attention-operation",
          space: SPACE,
          principal: ALICE,
          commitClass: "system",
          commit: {
            localSeq: 1,
            reads: { confirmed: [], pending: [] },
            operations: [{
              op: "apply-op",
              id: SIDECAR,
              path: toValuePath(["entries", "0", "payload"]),
              codec: "unknown-test-codec",
              submissionId: "attention:1",
              base: null,
              payload: {},
            }],
          },
        }),
      ProtocolError,
      "cannot apply or release operation fields",
    );

    applyCommit(engine, {
      sessionId: "server-attention-resolution",
      space: SPACE,
      principal: ALICE,
      commitClass: "system",
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "patch",
          id: SIDECAR,
          patches: [{
            op: "replace",
            path: "/value/entries/0/resolution",
            value: { kind: "dismissed" },
          }],
        }],
      },
    });
    waveSetSidecar(engine, holder, 5, { entries: [] });
    assertEquals(sidecarValue(engine).entries, []);
  } finally {
    resetServerExecutionConfig();
    await Deno.remove(path).catch(() => {});
  }
});

Deno.test("system Retry actor carriage rejects incomplete and forged metadata", async () => {
  const { engine, path } = await createEngine();
  setServerExecutionConfig(true);
  try {
    const systemActor = { principal: ALICE, sessionId: SESSION };
    const expectProtocolError = (
      sessionId: string,
      options: Parameters<typeof applyCommit>[1],
      message: string,
    ) =>
      assertThrows(
        () => applyCommit(engine, { ...options, sessionId }),
        ProtocolError,
        message,
      );

    expectProtocolError("bad-actor-class", {
      sessionId: "unused",
      space: SPACE,
      principal: ALICE,
      commitClass: "authored",
      systemEventActor: systemActor,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [],
      },
    }, "system-commit admission only");
    expectProtocolError("bad-actor-identity", {
      sessionId: "unused",
      space: SPACE,
      principal: ALICE,
      commitClass: "system",
      systemEventActor: { principal: "", sessionId: "" },
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [],
      },
    }, "requires the authenticated principal");
    expectProtocolError("bad-actor-no-append", {
      sessionId: "unused",
      space: SPACE,
      principal: ALICE,
      commitClass: "system",
      systemEventActor: systemActor,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [],
      },
    }, "requires a declared Retry append");
    expectProtocolError("bad-retry-provenance", {
      sessionId: "unused",
      space: SPACE,
      principal: ALICE,
      commitClass: "system",
      systemEventActor: systemActor,
      commit: appendCommit(1, [entryOf("evt-no-retry-of")]),
    }, "carries no retryOf provenance");
    expectProtocolError("bad-retry-client-seq", {
      sessionId: "unused",
      space: SPACE,
      principal: ALICE,
      commitClass: "system",
      systemEventActor: systemActor,
      commit: appendCommit(1, [entryOf("evt-client-seq", {
        retryOf: "evt-original",
        firedAt: { user: ALICE, session: SESSION, clientSeq: 1 },
      })]),
    }, "client-minted only");
    expectProtocolError("bad-retry-actor", {
      sessionId: "unused",
      space: SPACE,
      principal: ALICE,
      commitClass: "system",
      systemEventActor: systemActor,
      commit: appendCommit(1, [entryOf("evt-wrong-actor", {
        retryOf: "evt-original",
        firedAt: { user: "user:mallory", session: SESSION },
      })]),
    }, "disagrees with the authenticated Retry actor");
  } finally {
    resetServerExecutionConfig();
    await Deno.remove(path).catch(() => {});
  }
});

Deno.test("selectPendingStreamEventDocs: the undelivered-events discovery input (serving-loop §1, §6 step 4)", async () => {
  const { engine, path } = await createEngine();
  setServerExecutionConfig(true);
  try {
    const holder = withLiveLease(engine);
    // Three entries: one consequenced below the watermark (done), one
    // consequenced above it (an exhausted wave processed it — excluded
    // by the consequenced mark), one pending.
    waveSetSidecar(engine, holder, 1, {
      entries: [
        entryOf("evt-done", {
          firedAt: { user: ALICE, session: SESSION },
        }),
      ],
    }, { declare: [{ eventId: "evt-done" }] });
    const doneSeq = sidecarValue(engine).entries![0].seq!;
    waveSetSidecar(engine, holder, 2, {
      entries: [
        { ...sidecarValue(engine).entries![0], consequenced: true },
      ],
      eventWatermark: doneSeq,
    });
    applyCommit(engine, {
      sessionId: SESSION,
      space: SPACE,
      principal: ALICE,
      commit: appendCommit(3, [entryOf("evt-pending")]),
    });
    // A non-sidecar doc that merely LOOKS event-ish is ignored (prefix
    // keys the scan).
    applyCommit(engine, {
      sessionId: SESSION,
      space: SPACE,
      principal: ALICE,
      commit: {
        localSeq: 4,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "of:not-a-sidecar" as never,
          value: { value: { entries: [{ eventId: "evt-x" }] } } as never,
        }],
      },
    });

    const pending = selectPendingStreamEventDocs(engine);
    assertEquals(pending.length, 1);
    assertEquals(pending[0].id, SIDECAR);
    assert(pending[0].id.startsWith(STREAM_ENTRIES_DOC_PREFIX));
    assertEquals(pending[0].eventWatermark, doneSeq);
    assertEquals(pending[0].entries.length, 1);
    assertEquals(pending[0].entries[0].eventId, "evt-pending");
  } finally {
    resetServerExecutionConfig();
    await Deno.remove(path).catch(() => {});
  }
});
