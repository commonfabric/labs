// The co-hosted reference implementation of the wave commit sink
// (server-execution v2 stage D, serving-loop.md §3d): commits wave batches
// directly against the space's engine, on the same process the memory
// server runs in. This is the store half of plane (a)'s loopback path —
// the wave's ONE derived commit, its basis rows, and its per-doc
// re-verification all inside one engine transaction (`applyWaveCommit`) —
// with stage B's derived-class lease admission enforced by the engine
// itself. Stage F's SpaceServer wires this sink under the serving loop;
// until then tests drive it.
//
// Stage D's three documented bounds are all discharged:
// - DISCHARGED (stage F): foreign provisioning batches now apply WITH
//   protocol.md §2's delegated-identity admission row — the batch's
//   `delegated` carriage (originating chain actor + capabilityRef) rides
//   the commit metadata, admission validates completeness, and scoped
//   foreign writes key from the CARRIED identity. A foreign batch with
//   scoped ops and NO delegated carriage is still refused (commitWave
//   below) — that path would silently key from the sink's own principal,
//   the empty-instance trap, cross-space edition.
// - DISCHARGED (stage F): the seal handoff carries read-only spaces'
//   read sets (ITransactionSealSink.sealSpaceReads), and the
//   accumulator's withdrawn-read closure folds them by doc identity.
// - DISCHARGED (stage G): sqlite ops in HOME wave batches attach their
//   cell-db file(s) through the `sqliteAttachmentsFor` hook (the memory
//   server's attachWaveCommitSqliteDbs — same validations and ≤1-db
//   rule as the transact path, keyed by the accumulator's per-RUN scope
//   keys), attached before and detached after the synchronous apply. A
//   sink constructed WITHOUT the hook still refuses such a batch
//   loudly. Sqlite ops in FOREIGN batches stay refused — Phase 5 KEPT
//   this refusal deliberately: no sanctioned producer folds sqlite into
//   provisioning, and the foreign attachment identity rides the
//   grant-scoped read design (protocol.md §2).
//
// Stage G also forwards the wave's durable outbound-append rows
// (serving-loop.md §5, FP1): `batch.outboxAppends` land INSIDE the same
// engine transaction as the wave commit, via applyWaveCommit.

import type { Engine } from "@commonfabric/memory/v2/engine";
import {
  applyCommit,
  applyWaveCommit,
  hasIntrusionSince,
  readState,
  RowLabelCommitError,
  selectDocHead,
  selectWritePathsSince,
  serverSeq,
  WaveCommitConflictError,
  WavePreconditionError,
} from "@commonfabric/memory/v2/engine";
import type { CellScope } from "@commonfabric/api";
import type { Operation } from "@commonfabric/memory/v2";
import type { MemorySpace, Result } from "../storage/interface.ts";
import type {
  WaveCommitRejection,
  WaveCommitSink,
  WaveSpaceCommit,
} from "./wave.ts";

export function waveCommitFailureResult(
  error: unknown,
): { error: WaveCommitRejection } {
  if (error instanceof WaveCommitConflictError) {
    return {
      error: {
        name: "WaveCommitRejected",
        message: error.message,
        conflictedDocs: error.conflictedDocs,
      },
    };
  }
  if (error instanceof WavePreconditionError) {
    return {
      error: {
        name: "WaveCommitRejected",
        message: error.message,
        failedPreconditions: error.failedPreconditions,
      },
    };
  }
  if (
    error instanceof RowLabelCommitError && error.operationIndex !== undefined
  ) {
    return {
      error: {
        name: "RowLabelCommitError",
        message: error.message,
        failedOperation: error.operationIndex,
      },
    };
  }
  return {
    error: {
      name: "WaveCommitRejected",
      message: error instanceof Error ? error.message : String(error),
    },
  };
}

export class EngineWaveCommitSink implements WaveCommitSink {
  readonly #engineFor: (space: MemorySpace) => Engine;
  readonly #sessionId: string;
  readonly #principal: string | undefined;
  readonly #localSeq: { value: number };
  readonly #sqliteAttachmentsFor:
    | ((
      space: MemorySpace,
      operations: readonly Operation[],
      scopeKeyByOpIndex: ReadonlyMap<number, string>,
    ) => { attachments: Map<string, string>; detach: () => void })
    | undefined;
  readonly #onHomeRefused: (() => void) | undefined;

  /**
   * Replay keying — the stage-F choice, made and enforced here: the
   * engine dedupes commits by UNIQUE (session_id, local_seq), returning
   * the STORED result for a byte-identical replay and throwing "commit
   * replay mismatch" for a different one. Every sink in the process
   * shares ONE long-lived counter — `localSeqRef`, owned by the
   * ExecutorHost, starting at 0 — and uses the DR1 HOLDER identity
   * as the `sessionId`, which is simultaneously what the
   * derived-envelope admission requires (protocol.md §2, RULED
   * 2026-08-05: the producing session must BE the holder's own service
   * session). The counter is process-global rather than per-space
   * because the session is: a home sink's FOREIGN provisioning batches
   * (protocol.md §2b) land in other spaces' engines under this same
   * session, so per-space counters re-mint pairs another writer already
   * consumed there and the engine kills the later wave as a replay
   * mismatch (the ExecutorHost's `#sinkLocalSeq` doc carries the
   * incident shape). Freshness is structural, not queried: the holder's
   * process-instance component makes a new process a NEW engine
   * session, so 0 never collides; a park/re-activate within one
   * process reuses the counter. (A holder scheme WITHOUT a process
   * component would need a stored-max floor instead; no such scheme
   * exists.) Tests that construct throwaway
   * sinks may omit `localSeqRef` and get a private counter from 0 —
   * sound for a fresh session id per test engine.
   */
  constructor(options: {
    /** The co-hosted engine per space (memory server's own engines). */
    engineFor: (space: MemorySpace) => Engine;

    /** The service session framing the wave's commits are recorded
     * under (replay detection keys on it — see the constructor doc).
     * The SpaceServer passes the DR1 holder identity. */
    sessionId: string;

    /** The identity that session acts as, where the caller names one. */
    principal?: string;

    /** The shared, process-lifetime localSeq counter (see the
     * constructor doc). Mutated in place. */
    localSeqRef?: { value: number };

    /** The sqlite attachment hook (stage G — the memory server's
     * `attachWaveCommitSqliteDbs`): attach the cell-db file(s) a home
     * batch's folded `sqlite` ops target, keyed by the accumulator's
     * per-run scope keys. The sink calls it synchronously around the
     * apply — attach, apply, detach, no await between — preserving the
     * ≤1-attached invariant. Without it, a batch carrying sqlite ops is
     * refused loudly (the pre-stage-G bound's behavior, now stated). */
    sqliteAttachmentsFor?: (
      space: MemorySpace,
      operations: readonly Operation[],
      scopeKeyByOpIndex: ReadonlyMap<number, string>,
    ) => { attachments: Map<string, string>; detach: () => void };

    /** Called when applying a home batch throws, before `commitWave`
     * returns the refusal, so that whatever the refusal changes is in
     * place by the time the caller reads it. */
    onHomeRefused?: () => void;
  }) {
    this.#engineFor = options.engineFor;
    this.#sessionId = options.sessionId;
    this.#principal = options.principal;
    this.#localSeq = options.localSeqRef ?? { value: 0 };
    this.#sqliteAttachmentsFor = options.sqliteAttachmentsFor;
    this.#onHomeRefused = options.onHomeRefused;
  }

  currentHeads(
    space: MemorySpace,
    docs: ReadonlyArray<{ id: string; scope?: CellScope; scopeKey: string }>,
  ): Promise<ReadonlyMap<string, number>> {
    const engine = this.#engineFor(space);
    const heads = new Map<string, number>();
    for (const doc of docs) {
      heads.set(
        `${doc.id} ${doc.scopeKey}`,
        selectDocHead(engine, { id: doc.id, scopeKey: doc.scopeKey }),
      );
    }
    return Promise.resolve(heads);
  }

  concurrentWritePaths(
    space: MemorySpace,
    doc: { id: string; scope?: CellScope; scopeKey: string },
    sinceSeq: number,
  ): Promise<ReadonlyArray<readonly string[]>> {
    return Promise.resolve(selectWritePathsSince(this.#engineFor(space), {
      id: doc.id,
      scopeKey: doc.scopeKey,
      sinceSeq,
    }));
  }

  intrusionSince(
    space: MemorySpace,
    doc: { id: string; scope?: CellScope; scopeKey: string },
    sinceSeq: number,
    holder: string | undefined,
  ): Promise<boolean> {
    return Promise.resolve(hasIntrusionSince(this.#engineFor(space), {
      id: doc.id,
      scopeKey: doc.scopeKey,
      sinceSeq,
      ...(holder === undefined ? {} : { holder }),
    }));
  }

  commitWave(
    batch: WaveSpaceCommit,
  ): Promise<Result<{ seq: number }, WaveCommitRejection>> {
    const engine = this.#engineFor(batch.space);
    const commit = {
      localSeq: ++this.#localSeq.value,
      reads: { confirmed: [...(batch.confirmedReads ?? [])], pending: [] },
      operations: [...batch.operations],
      ...(batch.preconditions.length > 0
        ? { preconditions: [...batch.preconditions] }
        : {}),
      // Same-space emitted event entries (LT1): declared so admission
      // stamps their stream seqs (events.md §2's wave carriage).
      ...(batch.eventAppends !== undefined && batch.eventAppends.length > 0
        ? { eventAppends: [...batch.eventAppends] }
        : {}),
    };
    const hasSqliteOps = batch.operations.some((op) => op.op === "sqlite");
    try {
      if (!batch.home) {
        if (hasSqliteOps) {
          // No Phase-1 producer folds sqlite into a foreign provisioning
          // batch, and the attachment identity for a foreign run is
          // Phase 5's cross-space design — refused, never silently
          // applied against a mis-keyed file.
          return Promise.resolve({
            error: {
              name: "WaveCommitRejected",
              message: "sqlite ops in a FOREIGN wave batch are refused: " +
                "no sanctioned producer folds sqlite into provisioning, " +
                "and the foreign attachment identity rides the " +
                "grant-scoped read design (protocol.md §2, §2b; the " +
                "stage-G discharge covers home batches only — Phase 5 " +
                "kept this refusal deliberately)",
            },
          });
        }
        // Foreign provisioning commit (protocol.md §2b): authored-class
        // under the DELEGATED admission row — the batch's carried acting
        // identity + capabilityRef ride the commit metadata, admission
        // validates completeness, and scoped writes key from the CARRIED
        // identity. Idempotent by deterministic destination ids — no
        // wave-basis re-verification and no basis rows.
        //
        // INV-13 mirrored on the engine-direct plane (OW31 B4, RULED
        // 2026-08-18; protocol.md §2's genesis clause): a foreign batch
        // never lands in a FRESH store ahead of its genesis ACL — the
        // space's commit #1 is the ACL, signed by the space's own keys
        // and naming the acting user OWNER. The session plane enforces
        // this in `#validateAclCommit`'s precedence clause; of the two
        // other engine-direct committers, this sink is the one that
        // writes provisioning DATA batches (the third,
        // `Server.commitDelegatedAppend`, appends outbox-carried events
        // to stream sidecars and never writes an `of:<space>` ACL doc —
        // no genesis-bypass vector; review F7 on #6156), and before
        // this refusal the sink silently
        // bypassed the invariant (a served `.inSpace()` create whose
        // data commit won the race with the provider mount's genesis
        // minted an ACL-less space). The wave commit step forces the
        // genesis for every creation-granted target before applying, so
        // hitting this refusal means the forcing failed or no bootstrap
        // authority exists — foreign failure ⇒ home withheld ⇒ replay
        // (§2b's existing failure semantics). Populated ACL-less legacy
        // spaces (serverSeq > 0) are not this refusal's subject — the
        // accept gate already fails closed on them.
        if (
          serverSeq(engine) === 0 &&
          readState(engine, { id: `of:${batch.space}` }) === null
        ) {
          return Promise.resolve({
            error: {
              name: "WaveCommitRejected",
              message: `foreign wave batch into fresh space ` +
                `${batch.space} refused: the space requires its genesis ` +
                "ACL commit — signed by the space identity, naming the " +
                "acting user OWNER — before any data commit (INV-13 " +
                "mirrored at the sink; OW31, protocol.md §2's genesis " +
                "clause, §2b)",
            },
          });
        }
        //
        // A scoped write with NO delegated carriage is still REFUSED,
        // not silently mis-keyed: the plain path would key it from the
        // sink's own principal — the empty-instance trap, cross-space
        // edition (protocol.md §1, §2).
        if (batch.delegated === undefined) {
          for (const op of batch.operations) {
            if (
              op.op === "sqlite" || op.scope === undefined ||
              op.scope === "space"
            ) {
              continue;
            }
            return Promise.resolve({
              error: {
                name: "WaveCommitRejected",
                message: "scoped write in a foreign wave batch refused " +
                  `(op ${op.id}, scope "${op.scope}"): without delegated ` +
                  "carriage the row would silently key from the sink's " +
                  "own principal; scoped foreign admission requires the " +
                  "acting-identity + capabilityRef delegated row " +
                  "(protocol.md §2, §2b)",
              },
            });
          }
        }
        const applied = applyCommit(engine, {
          sessionId: this.#sessionId,
          space: batch.space,
          principal: this.#principal,
          commit,
          ...(batch.delegated === undefined
            ? {}
            : { delegated: batch.delegated }),
        });
        return Promise.resolve({ ok: { seq: applied.seq } });
      }
      // The sqlite bound's discharge (stage G): attach the cell-db
      // file(s) the batch's folded sqlite ops target BEFORE the engine
      // transaction (ATTACH cannot run inside one), detach in finally
      // — synchronously around the apply, no await between, so the
      // ≤1-attached invariant on the shared per-space connection holds.
      let sqliteAttachments: ReadonlyMap<string, string> | undefined;
      let detachSqlite: (() => void) | undefined;
      if (hasSqliteOps) {
        if (this.#sqliteAttachmentsFor === undefined) {
          return Promise.resolve({
            error: {
              name: "WaveCommitRejected",
              message: "wave batch carries sqlite ops but this sink has " +
                "no attachment hook: construct the sink with " +
                "sqliteAttachmentsFor (the memory server's " +
                "attachWaveCommitSqliteDbs) — the engine cannot execute " +
                "a folded sqlite op without its cell-db attached",
            },
          });
        }
        const scopeKeyByOpIndex = new Map<number, string>(
          (batch.sqliteScopeKeys ?? []).map((
            entry,
          ) => [entry.op, entry.scopeKey]),
        );
        const attached = this.#sqliteAttachmentsFor(
          batch.space,
          batch.operations,
          scopeKeyByOpIndex,
        );
        sqliteAttachments = attached.attachments;
        detachSqlite = attached.detach;
      }
      let applied;
      try {
        applied = applyWaveCommit(engine, {
          sessionId: this.#sessionId,
          space: batch.space,
          principal: this.#principal,
          commit,
          ...(sqliteAttachments === undefined ? {} : { sqliteAttachments }),
          commitClass: "derived",
          holder: batch.holder,
          annotations: batch.annotations,
          consequenceOf: batch.consequenceOf,
          ...(batch.derivedThrough === undefined
            ? {}
            : { derivedThrough: batch.derivedThrough }),
          waveBasis: {
            basisSeq: batch.basisSeq,
            rebasedHeads: batch.rebasedHeads,
          },
          basisInstances: batch.basisInstances.map((instance) => ({
            action: instance.action,
            actionScopeKey: instance.actionScopeKey,
            rows: instance.rows.map((row) => ({
              entitySpace: row.entitySpace,
              entity: row.entity,
              entityScopeKey: row.entityScopeKey,
              seq: row.seq,
            })),
          })),
          ...(batch.outboxAppends === undefined
            ? {}
            : { outboxAppends: batch.outboxAppends }),
        });
      } finally {
        // Detach BEFORE any later await: applyWaveCommit is synchronous
        // and is the only step that needs the attachments (the same B1
        // discipline as the transact path).
        detachSqlite?.();
      }
      return Promise.resolve({ ok: { seq: applied.seq } });
    } catch (error) {
      if (batch.home) this.#onHomeRefused?.();
      return Promise.resolve(waveCommitFailureResult(error));
    }
  }
}
