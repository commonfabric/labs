// The durable half of the server-execution v2 outbox
// (docs/specs/server-side-execution/serving-loop.md §5, FP1 RULED
// 2026-08-03): cross-space event appends are engine-table rows written
// INSIDE the emitting wave's own store transaction — the basis-row
// carriage pattern, sanctioned in protocol.md §7 — and DELETED on
// delivery-ack: a queue that empties, never history, so the
// no-per-run-persistence lesson holds. A row carries the event (payload
// bounded by the event, never graph-scaled) plus the acting identity
// (`actingPrincipal` + `actingSession`) + `capabilityRef` that the
// target's admission validates and stamps `firedAt` from — actor
// inheritance crosses spaces through exactly this carriage (events.md
// §2, LT5: the delivery commit's ENVELOPE is the producing server's
// service identity; admissibility comes from the validated grant, never
// the envelope).
//
// Split of duties: the INSERT half is invoked by `applyWaveCommit`
// inside the wave's transaction (never its own commit); the SELECT and
// DELETE halves are the serving loop's outbox — re-send on activation
// (serving-loop.md §6 step 5) and retirement on delivery-ack are
// direct engine-table writes on the direct-engine plane (serving-loop.md
// §1 plane (c)). The EFFECT half of the outbox is process-local by
// design and never touches this table (serving-loop.md §4's FORBIDDEN
// "pending effects" table: on crash, missing effect results are
// re-missed from memo keys).
//
// The crash discipline the row order carries (the spec model's C2/FP1
// closure — no lost cross-space appends on any crash schedule): a row is
// deleted only AFTER the target's admission processed the entry. A crash
// between admit and delete re-sends the row; the duplicate dedupes at the
// target's `eventId` horizon (events.md §4 — uniqueness applies ONLY
// above the stream's `eventWatermark`; an at-or-below duplicate admits
// and is skipped at processing time).

import type { Engine } from "./engine.ts";
import type { StreamLinkRef } from "../v2.ts";

/** One durable outbound append row (serving-loop.md §5, FP1). */
export type OutboxAppendRow = {
  targetSpace: string;

  /** The target stream SIDECAR doc id (events.md §1: an event is an
   * authored append to a stream document — `streamEntriesDocId`). */
  targetStream: string;

  /** The stream link the sidecar stands for — carried into the delivered
   * entry's self-describing `stream` field so the target's drain can
   * reconstruct the scheduler event link (Phase 3; events.md §1).
   * Absent on stage-G-era rows, which fall back to a path-less stream at
   * the sidecar id. */
  targetStreamLink?: StreamLinkRef;

  /** The client-durable event id (events.md §1); the target's dedupe
   * horizon keys on it. */
  eventId: string;

  /** The event payload, JSON — bounded by the event, never
   * graph-scaled (protocol.md §7's metadata discipline applies to the
   * carried event too). */
  payload: unknown;
  runtimeReferenceContext?: string;

  /** The ORIGINATING chain actor (events.md §2): absent only for a
   * chain with no acting user (a space-scope derivation's emission). */
  actingPrincipal?: string;

  /** The session that actor was acting in. */
  actingSession?: string;

  /** The OW15 declaration (protocol.md §2's Phase-3 floor carve-out,
   * SHAPE RULED 2026-08-05): the chain has NO actor anywhere — a
   * space-scope derivation's emission, a timer — and the target stamps
   * `firedAt = { session: "server" }` with no user key. Grant presence
   * stays mandatory. Only a declared row may omit `actingPrincipal`;
   * userless without the declaration is refused at the SOURCE
   * (wave.ts's enqueueOutboundAppend) and at the target's floor alike. */
  sessionlessSpaceScope?: boolean;

  /** The capability grant the target's admission validates —
   * delegation, never session-identity impersonation (protocol.md §2's
   * server-produced authored row). */
  capabilityRef: string;

  /** The SOURCE event whose handler run emitted this append (OW14;
   * protocol.md §2b's LT4 ruling): a deterministic delivery refusal
   * writes its failure notice onto THIS entry before the row retires.
   * Absent for emissions with no source event (a derivation-emitted
   * append) — those fall back to the warn log. */
  sourceEvent?: { sidecarId: string; eventId: string };
};

/** A pending row as read back for delivery: the stored fields plus the
 * declared-primary-key handle that `deleteExecutionOutboxRow` retires.
 * The column is a DECLARED `INTEGER PRIMARY KEY` (not the implicit
 * rowid): maintenance (VACUUM) may renumber implicit rowids, and a
 * renumbering between select and delete would let a delivery ack
 * retire the WRONG row — a lost append. The declared alias is stable
 * for the row's lifetime. */
export type PendingOutboxRow = OutboxAppendRow & {
  rowId: number;

  /** The emitting wave's commit seq (FIFO per source wave → target
   * stream rides insertion-id order; the seq is recorded for
   * diagnostics). */
  createdSeq: number;
};

const INSERT_ROW = `
INSERT INTO execution_outbox (
  branch, target_space, target_stream, target_stream_link, event_id,
  payload, runtime_reference_context, acting_principal, acting_session, sessionless_space_scope,
  capability_ref, source_event, created_seq
)
VALUES (
  :branch, :target_space, :target_stream, :target_stream_link, :event_id,
  :payload, :runtime_reference_context, :acting_principal, :acting_session, :sessionless_space_scope,
  :capability_ref, :source_event, :created_seq
)
`;

/**
 * Insert one wave's outbound append rows. MUST be called inside the
 * wave's own store transaction (`applyWaveCommit` is the one production
 * caller) — the FP1 carriage rule: the rows land atomically with the
 * wave commit, so a crash either has both (rows re-sent, deduped at the
 * target) or neither (the wave never happened; the event replays and
 * re-emits).
 */
export const insertExecutionOutboxRows = (
  engine: Engine,
  options: {
    branch: string;
    createdSeq: number;
    rows: readonly OutboxAppendRow[];
  },
): void => {
  if (options.rows.length === 0) return;
  const insert = engine.database.prepare(INSERT_ROW);
  for (const row of options.rows) {
    insert.run({
      branch: options.branch,
      target_space: row.targetSpace,
      target_stream: row.targetStream,
      target_stream_link: row.targetStreamLink === undefined
        ? null
        : JSON.stringify(row.targetStreamLink),
      event_id: row.eventId,
      payload: JSON.stringify(row.payload ?? null),
      runtime_reference_context: row.runtimeReferenceContext ?? null,
      acting_principal: row.actingPrincipal ?? null,
      acting_session: row.actingSession ?? null,
      sessionless_space_scope: row.sessionlessSpaceScope === true ? 1 : null,
      capability_ref: row.capabilityRef,
      source_event: row.sourceEvent === undefined
        ? null
        : JSON.stringify(row.sourceEvent),
      created_seq: options.createdSeq,
    });
  }
};

/**
 * Every undelivered row, in insertion (declared-id) order — FIFO per
 * (source wave → target stream) as serving-loop.md §2b requires. The
 * serving loop reads this at activation (§6 step 5's re-send) and after
 * any wave that carried appends.
 */
export const selectPendingExecutionOutboxRows = (
  engine: Engine,
  options: { branch: string },
): PendingOutboxRow[] => {
  const rows = engine.database.prepare(`
SELECT id AS row_id, target_space, target_stream, target_stream_link,
       event_id, payload, runtime_reference_context, acting_principal, acting_session,
       sessionless_space_scope, capability_ref, source_event, created_seq
FROM execution_outbox
WHERE branch = :branch
ORDER BY id ASC
`).all({ branch: options.branch }) as Array<{
    row_id: number;
    target_space: string;
    target_stream: string;
    target_stream_link: string | null;
    event_id: string;
    payload: string;
    runtime_reference_context: string | null;
    acting_principal: string | null;
    acting_session: string | null;
    sessionless_space_scope: number | null;
    capability_ref: string;
    source_event: string | null;
    created_seq: number;
  }>;
  return rows.map((row) => ({
    rowId: row.row_id,
    targetSpace: row.target_space,
    targetStream: row.target_stream,
    ...(row.target_stream_link === null
      ? {}
      : { targetStreamLink: JSON.parse(row.target_stream_link) }),
    eventId: row.event_id,
    payload: JSON.parse(row.payload),
    ...(row.runtime_reference_context === null ? {} : {
      runtimeReferenceContext: row.runtime_reference_context,
    }),
    ...(row.acting_principal === null
      ? {}
      : { actingPrincipal: row.acting_principal }),
    ...(row.acting_session === null
      ? {}
      : { actingSession: row.acting_session }),
    ...(row.sessionless_space_scope === 1
      ? { sessionlessSpaceScope: true }
      : {}),
    capabilityRef: row.capability_ref,
    ...(row.source_event === null
      ? {}
      : { sourceEvent: JSON.parse(row.source_event) }),
    createdSeq: row.created_seq,
  }));
};

/**
 * Delivery-ack retirement (FP1): delete one delivered row. Called only
 * AFTER the target's admission processed the entry (accepted or deduped
 * at the eventId horizon) — never before, or a crash between delete and
 * admit would lose the append. A direct engine-table write on the
 * direct-engine plane (serving-loop.md §1 plane (c)).
 */
export const deleteExecutionOutboxRow = (
  engine: Engine,
  rowId: number,
): void => {
  engine.database.prepare(`DELETE FROM execution_outbox WHERE id = :id`)
    .run({ id: rowId });
};
