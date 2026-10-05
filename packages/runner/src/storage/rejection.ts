/**
 * Permanent rejections are commit-time precondition failures (spec
 * scheduler-v2 §7.6): retrying can never succeed and MUST not happen —
 * for `receipt-exists` a retry would double-handle an event.
 */
export function isPermanentRejection(
  error: { name?: string } | undefined | null,
): boolean {
  return error?.name === "PreconditionFailedError";
}

/**
 * The names of terminal commit rejections: a commit-time evaluation that
 * DETERMINISTICALLY refused the committed data itself, so re-running the
 * identical handler recomputes the identical refused write and can NEVER
 * converge. One member per evaluation site:
 *
 * - `RowLabelCommitError` (server-side, wire): a CFC per-row label
 *   commit-rule violation (memory/v2/sqlite/commit-eval.ts, evaluated
 *   inside `applyCommitTransaction`, rolls back the whole commit). The
 *   memory server MUST serialize the class name unchanged
 *   (memory/v2/server.ts transact catch); the runner keeps it through
 *   normalization (storage/v2.ts `toRejectedError`). Keep the two in
 *   sync — the sqlite-cfc-commit-eval integration test exercises the
 *   real server→runner path and fails if the name is dropped or renamed.
 * - `SpeculativeBasisError` (client-side, server-execution v2 Phase 2 —
 *   speculation.md §6, RULED 2026-08-13): the replica's loud export
 *   refusal of a commit whose read basis names a SPECULATIVE overlay
 *   layer. The layer exists only in the client process, so as a wire
 *   pending-read dependency it can never resolve; a retry re-reads the
 *   same live echo and refuses identically. Never crosses the wire —
 *   minted in storage/v2.ts (`makeSpeculativeBasisRefusal`) before the
 *   push.
 * - `CfcCommitRefusalError` (client-side, CFC boundary): flow enforcement
 *   evaluated the transaction's own reads and writes and refused them
 *   before storage ever saw the commit (`rejectCommitBeforeStorage` in
 *   extended-storage-transaction.ts). Carries the prepare refusal reasons
 *   as a structured `reasons` array. Never crosses the wire either.
 *   The name is reserved for a refusal that recorded reasons and tagged
 *   every one of them a verdict (`cfc/verdict-reason.ts`). The retryable
 *   `StorageTransactionAborted` name goes to reasons that are not all
 *   verdicts, and to an enforcing transaction whose prepared digest
 *   changed under it. A crash inside commit preparation takes
 *   `CommitPreparationError`, checked before the reasons are read. The
 *   unreasoned refusal that name also covers — a relevant transaction
 *   reaching commit unprepared — is a fail-closed backstop rather than a
 *   shape the commit path produces, because `commit()` prepares a relevant
 *   transaction itself (`docs/specs/cfc-commit-preparation.md`).
 */
const TERMINAL_REJECTION_NAMES: ReadonlySet<string> = new Set([
  "RowLabelCommitError",
  "SpeculativeBasisError",
  "CfcCommitRefusalError",
]);

/**
 * A terminal rejection is a deterministic, data-caused commit refusal that
 * retrying can never resolve (see {@link TERMINAL_REJECTION_NAMES}). It is
 * terminal like a {@link isPermanentRejection}, but classified separately: a
 * permanent rejection is an idempotency/lineage precondition
 * (`origin-committed`/`receipt-exists`), whereas a terminal rejection refuses
 * the committed data on its own merits (server commit-rule evaluation, the
 * client-side speculative-basis export refusal, or the client's CFC boundary).
 * Both must stop the
 * handler immediately: a doomed handler that keeps re-running through its retry
 * budget produces speculative rev bumps on each attempt that starve concurrent
 * sibling commits sharing reactive state. Unlike a stale-read
 * {@link isConflictRejection} (retry against fresh state can converge), a
 * terminal rejection is NOT retryable.
 */
export function isTerminalRejection(
  error: { name?: string } | undefined | null,
): boolean {
  return error?.name !== undefined && TERMINAL_REJECTION_NAMES.has(error.name);
}

/**
 * A conflict rejection is a stale-read / pending-dependency commit failure
 * (normalized to `ConflictError`, see storage/v2.ts): the authoritative version
 * is ahead of this replica. A reactive compute or effect recovers from one by
 * re-arming its subscription, waiting for the conflict's `readyToRetry`
 * catch-up, and re-queuing — off the retry budget, since a conflict is a
 * wait-for-catch-up, not a failure, and past the node's debounce and
 * throttle (`MarkInvalidOptions.retry`), since the re-run is the
 * scheduler's own rather than an input change. (Reader-dirty propagation
 * re-triggers it too when the catch-up write lands as a fresh notification,
 * but that does not cover a conflict whose triggering write was already
 * delivered, so the re-queue is what guarantees re-evaluation.) The reactive
 * path recovers the local stale-basis guard
 * (`isStorageTransactionInconsistent`) the same way — it too
 * converges by re-running, so it re-queues off the budget rather than stranding
 * a compute as a zombie under a contention burst. Only a non-permanent error
 * that re-queueing cannot resolve — a transport or malformed-store error —
 * keeps the bounded retry. (Not to be read as "a transport error can never
 * converge": `editWithRetry` treats it as liveness and DOES retry it, for the
 * reason given under `isTransientCommitRejection` below. The two paths differ
 * because re-queueing a reactive compute is not the same act as re-running a
 * transaction — see the note on the two classifiers in
 * docs/specs/space-model/5-transactions.md.)
 *
 * The event-handler commit path treats the same rejection as the signal to
 * apply committed-write backpressure: re-running the handler against fresh
 * confirmed state and committing again can succeed, so a conflict is retried
 * with backoff rather than dropped. It windows the local stale-basis guard
 * (`isStorageTransactionInconsistent`) the same way. Every other non-permanent
 * rejection there — a handler-initiated abort, an authorization denial, a
 * transport or malformed-store error — is not a stale basis and cannot converge
 * by re-running, so it drops fast rather than entering the window (see
 * `classifyCommitDisposition` in scheduler/events.ts).
 */
export function isConflictRejection(
  error: { name?: string } | undefined | null,
): boolean {
  return error?.name === "ConflictError";
}

/**
 * The STALE-READ sub-family of {@link isConflictRejection}: the server
 * refused the commit because a document its read basis named had already
 * advanced past the basis, so a catch-up and a fresh read are what
 * converge. The engine (memory/v2/engine.ts) mints exactly TWO messages
 * with that meaning, and this predicate matches exactly those two:
 *
 * - `stale confirmed read: <id> at seq N conflicted with seq M`
 *   (validateConfirmedReads — a confirmed read's document advanced);
 * - `stale pending read: <id> via localSeq N conflicted with seq M`
 *   (resolvePendingReads — a read through the session's own accepted
 *   layers whose underlying document advanced; the sibling shape of the
 *   same race, reachable when the serving side's commit advances a
 *   pending-read target while the confirmed reads pass).
 *
 * The engine's OTHER `ConflictError` messages are deliberately NOT
 * matched, because neither describes a basis a fresh read repairs:
 *
 * - `pending dependency not resolved: <localSeq>` — this session's own
 *   earlier commit is unresolved; that commit's fate decides, not a read.
 * - `entity-value-hash precondition target changed: <id>` — a commit
 *   PRECONDITION (the create-only / value-hash class) failed on the
 *   committed data's own merits; re-running double-handles.
 *
 * Beyond the engine, `ConflictError`s are also CLIENT-FABRICATED
 * (storage/v2.ts `makeLocalRejection`) with verbatim caller messages —
 * wave withdrawals wrap inner errors ("seal failed: …", "wave abandoned:
 * …"), which can EMBED a staleness phrase without being one. The match is
 * therefore anchored to the MESSAGE HEAD: an embedded phrase never
 * classifies. One same-family client shape is knowingly NOT matched:
 * `commit preempted: read set stale until caughtUpLocalSeq>=N`, minted
 * only under the experimental `CF_CONFLICT_ADMISSION=preempt` mode
 * (default off) — extending to it is that mode's own decision, recorded
 * here rather than taken silently.
 *
 * Discriminated by MESSAGE, the way `toRejectedError` (storage/v2.ts)
 * already recovers the conflicted entity from one: `Error` fields do not
 * survive the wire, the message does, and its format is owned by the
 * `ConflictError` construction in memory/v2/engine.ts.
 *
 * A caller that only needs "can re-running converge at all" wants
 * {@link isRetryableCommitRejection}. This predicate is for a caller that
 * must separate a basis a fresh read fixes from every other refusal — the
 * commit-gated piece start, whose first-hydration commit races the serving
 * side materializing the very documents its basis read as absent
 * (server-execution v2; verification-coverage.md OW45 arm B). Introduced
 * by the closed #6208 as `isStaleConfirmedReadConflict`, matching the
 * confirmed shape alone; renamed when the pending sibling joined.
 */
export function isStaleReadConflict(
  error: { name?: string; message?: string } | undefined | null,
): boolean {
  return isConflictRejection(error) &&
    typeof error?.message === "string" &&
    (error.message.startsWith("stale confirmed read") ||
      error.message.startsWith("stale pending read"));
}

/**
 * A stale-basis inconsistency: a value the transaction read changed on this
 * replica between the read and the commit (see storage/v2-transaction.ts
 * `validate()`). Like a conflict it is resolved by re-running the transaction
 * against fresh state; unlike a conflict the invalidating change is local
 * rather than a rejection from upstream. A transport, authorization, or
 * malformed-store error is not a stale basis and re-running does not resolve it.
 */
export function isStorageTransactionInconsistent(
  error: { name?: string } | undefined | null,
): boolean {
  return error?.name === "StorageTransactionInconsistent";
}

/**
 * A liveness failure: the commit never reached a verdict because the link to
 * the memory server was down. The committed data was never evaluated, so
 * nothing about it is refused — a fresh attempt over a re-established
 * connection can land the identical write, and the memory client re-establishes
 * one WITHOUT being asked: a transport close schedules `reconnect()`, and a
 * `transact` issued while disconnected queues in `#outstandingCommits` and calls
 * `client.restoreConnection()` (memory/v2/client.ts). `ConnectionError` is the
 * runner's normalization of a transport failure (storage/v2.ts
 * `toConnectionError`).
 *
 * `InvalidMessageError` is the other liveness class, and the less obvious one.
 * The client raises it when a frame off the wire will not decode
 * (memory/v2/client.ts `onMessage`), and then calls `rejectPending(error)` —
 * which rejects EVERY in-flight request with it, not just the request whose
 * response was malformed. An in-flight `transact` is collateral: the server may
 * never have seen it, may have committed it, may have replied successfully in a
 * frame that was garbled after the fact. What is certain is that nothing about
 * the commit was evaluated and refused, so it is a liveness failure and not a
 * verdict. Unlike a `SessionError` the connection is typically still usable —
 * one frame failed to decode, the socket did not close — so the next attempt is
 * a fresh request that may well be answered. That is a reason to allow the
 * retry, not a guarantee it lands: if frames keep arriving undecodable the
 * budget is spent and the caller sees the real name.
 * (For it to be classified at all the name must survive normalization —
 * `toRejectedError` in storage/v2.ts preserves it explicitly for that reason.)
 *
 * This is deliberately narrow. An `AuthorizationError` is NOT a liveness
 * failure even though it also arrives from the network: the server evaluated
 * the request and denied it. The one exception the server marks itself —
 * `retriable: true` on a session-open anti-replay race
 * (memory/v2/session-open-auth.ts) — is handled by
 * {@link isRetryableCommitRejection} reading that marker, not by class.
 *
 * `SessionError` is NOT here, and the reason is the retry path rather than the
 * error: it is the same "never evaluated" shape as a `ConnectionError`, but the
 * re-established session its convergence argument needs never arrives. Nothing
 * between two `editWithRetry` attempts clears or remounts one:
 *  - `SpaceReplica.#memoizedSessionHandle()` (storage/v2.ts) memoizes the
 *    mount and drops it only in `close()`/`closeNow()` — and, since
 *    2026-08-26, when an admitted
 *    commit touches the space's ACL doc (`consumeOwedSessionRemount`, the READ
 *    path's fix for the profile-starvation fifth face). Nothing an `editWithRetry`
 *    ATTEMPT does clears it, so every attempt still reuses the very handle the
 *    server just refused: the remount is driven by the ACL changing, not by the
 *    retry, which is exactly why it does not make this class retryable;
 *  - `SpaceSession.#reopen()` (memory/v2/client.ts) runs only from `restore()`,
 *    which only the client's `reconnect()` calls — i.e. only after a TRANSPORT
 *    close;
 *  - `sendOutstandingCommit`'s catch (memory/v2/client.ts) keeps a commit
 *    outstanding for replay on `isConnectionError`/`isSessionRevokedError` only;
 *    a `SessionError` falls through and rejects the commit with `#sessionId`
 *    untouched.
 * Those three also say which case actually reaches here. A transport drop never
 * surfaces as a `SessionError` at all — the commit queues and replays after the
 * reconnect's `reopen()`, and the server re-creates even a TTL-expired session
 * from the id the client resends (memory/v2/session-registry.ts `open`). What
 * reaches `editWithRetry` is the other case: a LIVE connection whose session the
 * SERVER dropped — an ACL de-authorization sweep (`#revokeDeauthorizedSessions`,
 * memory/v2/server.ts, whose own comment is "its next message fails closed
 * (Unknown session)"), or a takeover, both of which also delete the entry
 * `Connection.#requireSession` checks. That is terminal for the session: the
 * client's remedy is the `session/revoked` frame, which CLOSES it
 * (`terminateSession`), not a reopen — and a reopen would be denied at
 * `session.open`.
 *
 * Retrying it is therefore all cost. With no backoff the whole budget burns
 * within milliseconds on identical doomed round-trips, each one emitting a
 * subscriber revert from `finalizeRejection`; and it DOWNGRADES the reported
 * error, because once the revocation frame lands `#assertOpen()` throws
 * `SessionRevokedError`, a name `toRejectedError` does not preserve — so the
 * caller is handed a generic `TransactionError` instead of the real cause it
 * would have seen on attempt 1. Move it back into the allow-list the day the
 * retry path clears `#sessionHandle`, or the client reopens on `SessionError`:
 * the convergence argument is sound, only the remount is missing.
 * (2026-08-26 — the READ path's half of that gap is now closed, and it is
 * worth being precise about which half. `consumeOwedSessionRemount` remounts
 * when the ACL CHANGES, which is the only event that can change this verdict;
 * a commit RETRY is not that event, so the sentence above still stands for
 * this predicate. What would move `SessionError` into the allow-list is a
 * retry path that waits for the remount rather than one that re-fires
 * immediately.)
 */
export function isTransientCommitRejection(
  error: { name?: string } | undefined | null,
): boolean {
  return error?.name === "ConnectionError" ||
    error?.name === "InvalidMessageError";
}

/**
 * The opening words of the message on every commit CFC enforcement refuses
 * before the transaction reaches storage (`rejectCommitBeforeStorage` in
 * extended-storage-transaction.ts). The refusal travels as a
 * `StorageTransactionAborted` whose message carries the detail, so the prefix
 * is what tells one apart from an ordinary `tx.abort()`. Minted and matched
 * from this one constant.
 */
export const CFC_ENFORCEMENT_REJECTION_PREFIX =
  "CFC enforcement rejected commit";

/**
 * CFC enforcement refused this commit before it reached storage: the
 * transaction was relevant to enforcement and did not come out of prepare in a
 * prepared state, or the prepared digest changed under it. The refusal names
 * the rule that produced it — a writer-fit confidentiality misfit, a
 * writeAuthorizedBy failure, an egress ceiling violation.
 *
 * A refusal does not say whether another attempt would fare better, and the
 * reasons behind one differ on exactly that. A rule's verdict on the data — a
 * shape its rules do not support — recurs on every attempt. A reason naming
 * metadata prepare could not read, a `cid:` schema document or a link source
 * this replica does not hold yet, is answered by the attempt that reads it.
 * So this classifies the refusal and not its prospects: it says CFC enforcement
 * refused the commit, which is what makes a dropped write worth reporting, and
 * the decision to stop attempting belongs to whoever owns the retries.
 *
 * The refusal travels as a `StorageTransactionAborted` whose message opens with
 * the prefix, and the prefix is what the test reads. A commit error normalized
 * on its way here can lose its class and keep its message, so testing the
 * message is what covers both shapes of the same refusal.
 */
export function isCfcEnforcementRejection<
  T extends { message?: string },
>(
  error: T | undefined | null,
): error is T & { message: string } {
  return typeof error?.message === "string" &&
    error.message.startsWith(CFC_ENFORCEMENT_REJECTION_PREFIX);
}

/**
 * The attempt was discarded before it ever reached storage, so there is no
 * server verdict to respect: the `editWithRetry` callback called `tx.abort()`
 * to throw this attempt away, asking for a fresh one. Re-running produces a
 * genuinely new attempt, and — unlike every other rejection class — a
 * discarded attempt costs no round-trip and no `finalizeRejection`, so
 * retrying one is local work rather than churn against the server. The CFC
 * boundary aborts before storage too, and a refusal it produces reaches this
 * predicate under the same name. That refusal takes the terminal
 * `CfcCommitRefusalError` name instead when prepare recorded reasons and
 * tagged every one of them a verdict (see {@link TERMINAL_REJECTION_NAMES}).
 *
 * NOTE the asymmetry with a callback that THROWS: `editWithRetry` aborts that
 * transaction and returns immediately without retrying, because a thrown
 * callback is a failure rather than a request for a fresh attempt. `abort()` is
 * the affordance for "discard this attempt and run me again".
 */
export function isDiscardedAttemptRejection(
  error: { name?: string } | undefined | null,
): boolean {
  return error?.name === "StorageTransactionAborted";
}

/**
 * The commit-retry ALLOW-LIST: the only rejection classes for which re-running
 * the same function against fresh state can produce a different outcome. Used
 * by `Runtime.editWithRetry` (runtime.ts), which before this predicate retried
 * on the mere TRUTHINESS of the commit error — so a deterministic refusal (an
 * ACL `ProtocolError`, an `AuthorizationError`, a `PreconditionFailedError`
 * whose own interface doc says the client MUST NOT retry) burned the whole
 * budget on identical doomed round-trips, each one emitting a subscriber revert
 * from `finalizeRejection`. Budgets are not small everywhere: pattern-manager
 * sizes one at `Math.max(16, 2 * importEdges + 8)`.
 *
 * It is an allow-list on purpose. A rejection class introduced tomorrow — a new
 * server-side commit rule, a new policy refusal — is non-retryable until
 * someone establishes that re-running can converge and adds it here, next to
 * the reason why. The reverse default silently enrolls every new refusal in the
 * doomed-retry loop, which is how this defect arose.
 *
 * The four admitted cases and their convergence argument:
 *  - stale basis from upstream ({@link isConflictRejection}) — the retry runs
 *    after the conflict's `readyToRetry` catch-up gate, against fresh state.
 *  - stale basis locally ({@link isStorageTransactionInconsistent}) — a value
 *    read during the transaction changed on this replica; re-reading resolves.
 *  - liveness ({@link isTransientCommitRejection}) — the commit was never
 *    evaluated, and the client re-establishes the connection on its own, so a
 *    retry lands it. `SessionError` is the near miss that is NOT admitted: same
 *    "never evaluated" shape, but no one remounts the session between attempts;
 *    see that predicate's doc for why, and for what would change the answer.
 *  - discarded attempt ({@link isDiscardedAttemptRejection}) — the attempt
 *    never reached storage and the caller asked for a fresh one.
 *
 * Plus one marker-driven case: an `AuthorizationError` the SERVER tagged
 * `retriable` (the session-open anti-replay race a fresh handshake heals — see
 * memory/v2/session-open-auth.ts, and `isNonRetriableAuthorizationError` in
 * memory/v2/client.ts, which reads the same marker). An unmarked
 * `AuthorizationError` is terminal, including the ACL bootstrap denial
 * ("Space … requires an ACL genesis commit before ordinary writes",
 * memory/v2/server.ts): that denial CAN clear if a concurrent genesis lands,
 * but retrying it here is not how it clears — `editWithRetry` re-runs with no
 * backoff, so all attempts complete within milliseconds of each other, and the
 * runner's own genesis runs at session open (storage/v2.ts) rather than
 * concurrently with a replica's writes. Failing fast surfaces the real problem
 * instead of hiding it behind six identical denials. If that race ever needs to
 * heal by retry, the server should mark the denial `retriable` — the marker,
 * not a blanket class exemption, is the mechanism.
 */
export function isRetryableCommitRejection(
  error: { name?: string; retriable?: boolean } | undefined | null,
): boolean {
  if (!error) return false;
  if (
    isConflictRejection(error) ||
    isStorageTransactionInconsistent(error) ||
    isTransientCommitRejection(error) ||
    isDiscardedAttemptRejection(error)
  ) {
    return true;
  }
  return error.name === "AuthorizationError" && error.retriable === true;
}
