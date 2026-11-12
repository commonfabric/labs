/**
 * Makes a request again after its memory connection lost it. The memory
 * client keeps nothing for a later connection: a request its connection lost
 * fails with a `ConnectionError` that says whether it was sent
 * (`connectionDeliveryOf()`) and carries a `readyToRetry()` that resolves once
 * the request can be made again. A caller that wants its requests to outlast
 * a connection makes them through what is here.
 */

import type { ClientCommit } from "../v2.ts";
import { connectionDeliveryOf, type SpaceSession } from "./client.ts";
import type { AppliedCommit } from "./engine.ts";

/**
 * How many times a request is made again after its own payload failed the
 * write (a `ConnectionError` marked `ownWriteFailed`) before it fails with
 * that error: a payload that fails every time would otherwise take each new
 * connection down with it.
 */
export const MAX_OWN_WRITE_FAILURES = 5;

/**
 * Calls `attempt`, a request to the memory client, until it is sent, and
 * returns what it settles with. A request the connection lost before it was
 * sent is made again once its `readyToRetry()` resolves. One that was sent
 * and not answered fails with its `ConnectionError`, since it may have
 * landed: this is for a request that must not apply twice, such as a mount
 * that redeems an invitation.
 *
 * Requests made this way are each made again on their own, in no order
 * among them. A session's requests go through a `ResendingSession`, which
 * keeps the order of those that have one.
 *
 * @throws What `attempt` rejects with, when that is not a lost connection
 *   that never sent the request, and what `readyToRetry()` rejects with, as
 *   it does once the client has closed.
 */
export async function untilSent<T>(attempt: () => Promise<T>): Promise<T> {
  for (;;) {
    try {
      return await attempt();
    } catch (error) {
      if (connectionDeliveryOf(error) === "unacknowledged") throw error;
      await readyAfter(error);
    }
  }
}

/**
 * Returns the wait after which the request that failed with `error` can be
 * made again, counting a failure of its own write in `failures`, the count
 * its caller keeps for that request.
 *
 * @throws `error`, when it is no lost connection or says nothing of when to
 *   try again, and the write's own error once `failures` reaches
 *   `MAX_OWN_WRITE_FAILURES`.
 */
function readyAfter(
  error: unknown,
  failures: { ownWrite: number } = { ownWrite: 0 },
): Promise<void> {
  if (connectionDeliveryOf(error) === undefined) throw error;
  if (
    error instanceof Error && "ownWriteFailed" in error &&
    error.ownWriteFailed === true &&
    ++failures.ownWrite >= MAX_OWN_WRITE_FAILURES
  ) throw ownWriteErrorOf(error);
  if (
    !(error instanceof Error) || !("readyToRetry" in error) ||
    typeof error.readyToRetry !== "function"
  ) throw error;
  return error.readyToRetry();
}

/**
 * The error a request whose own write failed `MAX_OWN_WRITE_FAILURES` times
 * fails with: the write's own error, found under the `ConnectionError`s that
 * carried it, rather than a `ConnectionError`, which a caller would retry.
 */
const ownWriteErrorOf = (error: Error): Error => {
  let cause: unknown = error.cause;
  while (cause instanceof Error && cause.name === "ConnectionError") {
    cause = cause.cause;
  }
  return cause instanceof Error
    ? cause
    : new Error(error.message, { cause: error.cause });
};

/** A request made through a `ResendQueue` that has no answer yet. */
type Unanswered = {
  /** Makes the request of the session once. */
  attempt: () => Promise<unknown>;
  answer: PromiseWithResolvers<unknown>;
  /** Where the request sorts among the queue's: lower is sent first. */
  order: number;
  /** Whether the request is with the session, sent and not yet settled. */
  sent: boolean;
  /**
   * Set once the connection has lost the request: resolves when the session
   * can take it again.
   */
  ready: Promise<void> | undefined;
  failures: { ownWrite: number };
};

/**
 * Requests that reach a session in a set order, those made again after a
 * lost connection included: none is sent while an earlier one waits to be
 * made again. A request the connection lost, before it was sent or after,
 * is made again once its `readyToRetry()` resolves, so this is for a request
 * that is harmless to make twice. A request settles with the session's
 * answer to it, with an error that is no lost connection, with what
 * `readyToRetry()` rejects with, or with the write's own error once its own
 * payload has failed the write `MAX_OWN_WRITE_FAILURES` times.
 */
class ResendQueue {
  /** The requests not yet answered, in increasing `order`. */
  readonly #unanswered: Unanswered[] = [];

  /**
   * Set while a request the connection lost waits to be made again. Requests
   * made meanwhile wait behind it.
   */
  #resending: Promise<void> | undefined;

  /**
   * Makes the request `attempt` makes, in its place by `order` among the
   * requests not yet answered, and returns the session's answer to it.
   */
  make<T>(order: number, attempt: () => Promise<T>): Promise<T> {
    const unanswered: Unanswered = {
      attempt,
      answer: Promise.withResolvers<unknown>(),
      order,
      sent: false,
      ready: undefined,
      failures: { ownWrite: 0 },
    };
    const later = this.#unanswered.findIndex((other) => other.order > order);
    this.#unanswered.splice(
      later === -1 ? this.#unanswered.length : later,
      0,
      unanswered,
    );
    if (this.#resending === undefined) this.#send(unanswered);
    return unanswered.answer.promise as Promise<T>;
  }

  /**
   * Helper for `make()`, which hands `unanswered` to the session and settles
   * it with the answer, or keeps it to be made again when the connection
   * lost it.
   */
  #send(unanswered: Unanswered): void {
    unanswered.sent = true;
    unanswered.attempt().then(
      (answer) => {
        this.#forget(unanswered);
        unanswered.answer.resolve(answer);
      },
      (error) => {
        unanswered.sent = false;
        try {
          unanswered.ready = readyAfter(error, unanswered.failures);
        } catch (final) {
          this.#forget(unanswered);
          unanswered.answer.reject(final);
          return;
        }
        // `#resendLost()` reads how the wait ends.
        unanswered.ready.catch(() => {});
        this.#resending ??= this.#resendLost();
      },
    );
  }

  /**
   * Helper for `#send()`, which waits until the session can take the
   * requests the connection lost and then sends every request that is not
   * with the session, in order: those it lost, and those made while they
   * waited. A drop fails every request it carried before the session is
   * ready again, so a request lost while another waits joins that wait.
   */
  async #resendLost(): Promise<void> {
    for (;;) {
      const lost = this.#unanswered.filter((unanswered) =>
        unanswered.ready !== undefined
      );
      if (lost.length === 0) break;
      await Promise.all(lost.map(async (unanswered) => {
        try {
          await unanswered.ready;
        } catch (error) {
          this.#forget(unanswered);
          unanswered.answer.reject(error);
        }
        unanswered.ready = undefined;
      }));
    }
    this.#resending = undefined;
    for (const unanswered of [...this.#unanswered]) {
      if (!unanswered.sent) this.#send(unanswered);
    }
  }

  /** Removes `unanswered` from the requests still to be answered. */
  #forget(unanswered: Unanswered): void {
    const index = this.#unanswered.indexOf(unanswered);
    if (index !== -1) this.#unanswered.splice(index, 1);
  }
}

/**
 * A session whose requests are made again after a lost connection, so that a
 * caller makes each once and waits for the server's answer to it:
 *
 * - A request that was never sent is made again once the session can take
 *   it: one made while the client is connecting, or while the session's
 *   reopening is refused for now, waits for that to pass.
 * - A commit or a watch change that was sent and not answered is made again
 *   too. The server answers a commit sent again under its own `localSeq`
 *   from its record, and a watch change sets what a repeat sets again.
 * - Any other request that was sent and not answered fails with its
 *   `ConnectionError`, since it may have landed.
 *
 * Commits reach the session in increasing `localSeq` order, and watch
 * changes in the order they were made, those made again included: none is
 * sent while an earlier one waits to be made again. A watch change replaces
 * or builds on the ones before it, so one made again late would undo a newer
 * one.
 *
 * Everything else a session offers passes straight through to `session`.
 */
export class ResendingSession {
  readonly #session: SpaceSession;

  /** The session's commits, in increasing `localSeq` order. */
  readonly #commits = new ResendQueue();

  /** The answer awaited for each commit not yet answered, by `localSeq`. */
  readonly #committing = new Map<number, Promise<AppliedCommit>>();

  /** The session's watch changes, in the order they were made. */
  readonly #watchChanges = new ResendQueue();

  /** How many watch changes have been made. */
  #watchChangesMade = 0;

  /** Constructs an instance which makes its requests of `session`. */
  constructor(session: SpaceSession) {
    this.#session = session;
  }

  get sessionId(): SpaceSession["sessionId"] {
    return this.#session.sessionId;
  }

  get sessionToken(): SpaceSession["sessionToken"] {
    return this.#session.sessionToken;
  }

  get principal(): SpaceSession["principal"] {
    return this.#session.principal;
  }

  get serverSeq(): SpaceSession["serverSeq"] {
    return this.#session.serverSeq;
  }

  get declaredSpaceKind(): SpaceSession["declaredSpaceKind"] {
    return this.#session.declaredSpaceKind;
  }

  get closeError(): SpaceSession["closeError"] {
    return this.#session.closeError;
  }

  get held(): SpaceSession["held"] {
    return this.#session.held;
  }

  get onSessionReplaced(): SpaceSession["onSessionReplaced"] {
    return this.#session.onSessionReplaced;
  }

  set onSessionReplaced(observer: SpaceSession["onSessionReplaced"]) {
    this.#session.onSessionReplaced = observer;
  }

  get holdingsProvider(): SpaceSession["holdingsProvider"] {
    return this.#session.holdingsProvider;
  }

  set holdingsProvider(provider: SpaceSession["holdingsProvider"]) {
    this.#session.holdingsProvider = provider;
  }

  //
  // Commits
  //

  /**
   * Like `SpaceSession.transact()`, except that it settles only with the
   * server's verdict on `commit`, or with an error that ends it: the
   * session's close, a server session opened in place of the one a sent
   * commit was sent on (`SessionReplacedError`), or the write's own error
   * once its payload has failed the write `MAX_OWN_WRITE_FAILURES` times. A
   * commit the connection lost is sent again unchanged. `beforeIssue` runs
   * each time the commit is about to be sent.
   */
  transact(
    commit: ClientCommit,
    beforeIssue?: () => void,
  ): Promise<AppliedCommit> {
    const { localSeq } = commit;
    const existing = this.#committing.get(localSeq);
    if (existing !== undefined) return existing;
    const answer = this.#commits.make(
      localSeq,
      () => this.#session.transact(commit, beforeIssue),
    );
    this.#committing.set(localSeq, answer);
    const settled = () => {
      if (this.#committing.get(localSeq) === answer) {
        this.#committing.delete(localSeq);
      }
    };
    answer.then(settled, settled);
    return answer;
  }

  //
  // Watch changes
  //

  watchSet(
    ...request: Parameters<SpaceSession["watchSet"]>
  ): ReturnType<SpaceSession["watchSet"]> {
    return this.#changeWatches(() => this.#session.watchSet(...request));
  }

  watchSetSync(
    ...request: Parameters<SpaceSession["watchSetSync"]>
  ): ReturnType<SpaceSession["watchSetSync"]> {
    return this.#changeWatches(() => this.#session.watchSetSync(...request));
  }

  watchAdd(
    ...request: Parameters<SpaceSession["watchAdd"]>
  ): ReturnType<SpaceSession["watchAdd"]> {
    return this.#changeWatches(() => this.#session.watchAdd(...request));
  }

  watchAddSync(
    ...request: Parameters<SpaceSession["watchAddSync"]>
  ): ReturnType<SpaceSession["watchAddSync"]> {
    return this.#changeWatches(() => this.#session.watchAddSync(...request));
  }

  watchRemoveSync(
    ...request: Parameters<SpaceSession["watchRemoveSync"]>
  ): ReturnType<SpaceSession["watchRemoveSync"]> {
    return this.#changeWatches(() => this.#session.watchRemoveSync(...request));
  }

  viewSetSync(
    ...request: Parameters<SpaceSession["viewSetSync"]>
  ): ReturnType<SpaceSession["viewSetSync"]> {
    return this.#changeWatches(() => this.#session.viewSetSync(...request));
  }

  //
  // Other requests
  //

  queryGraph(
    ...request: Parameters<SpaceSession["queryGraph"]>
  ): ReturnType<SpaceSession["queryGraph"]> {
    return untilSent(() => this.#session.queryGraph(...request));
  }

  queryOperationField(
    ...request: Parameters<SpaceSession["queryOperationField"]>
  ): ReturnType<SpaceSession["queryOperationField"]> {
    return untilSent(() => this.#session.queryOperationField(...request));
  }

  listEntityIds(
    ...request: Parameters<SpaceSession["listEntityIds"]>
  ): ReturnType<SpaceSession["listEntityIds"]> {
    return untilSent(() => this.#session.listEntityIds(...request));
  }

  entityIdExists(
    ...request: Parameters<SpaceSession["entityIdExists"]>
  ): ReturnType<SpaceSession["entityIdExists"]> {
    return untilSent(() => this.#session.entityIdExists(...request));
  }

  sqliteQuery(
    ...request: Parameters<SpaceSession["sqliteQuery"]>
  ): ReturnType<SpaceSession["sqliteQuery"]> {
    return untilSent(() => this.#session.sqliteQuery(...request));
  }

  registerSqliteDiskSource(
    ...request: Parameters<SpaceSession["registerSqliteDiskSource"]>
  ): ReturnType<SpaceSession["registerSqliteDiskSource"]> {
    return untilSent(() => this.#session.registerSqliteDiskSource(...request));
  }

  joinPresenceRoom(
    ...request: Parameters<SpaceSession["joinPresenceRoom"]>
  ): ReturnType<SpaceSession["joinPresenceRoom"]> {
    return untilSent(() => this.#session.joinPresenceRoom(...request));
  }

  resolveEventAttention(
    ...request: Parameters<SpaceSession["resolveEventAttention"]>
  ): ReturnType<SpaceSession["resolveEventAttention"]> {
    return untilSent(() => this.#session.resolveEventAttention(...request));
  }

  runPatternLifecycle(
    ...request: Parameters<SpaceSession["runPatternLifecycle"]>
  ): ReturnType<SpaceSession["runPatternLifecycle"]> {
    return untilSent(() => this.#session.runPatternLifecycle(...request));
  }

  runServed(
    ...request: Parameters<SpaceSession["runServed"]>
  ): ReturnType<SpaceSession["runServed"]> {
    return untilSent(() => this.#session.runServed(...request));
  }

  administerInvites(
    ...request: Parameters<SpaceSession["administerInvites"]>
  ): ReturnType<SpaceSession["administerInvites"]> {
    return untilSent(() => this.#session.administerInvites(...request));
  }

  //
  // What passes straight through
  //

  sendReport(
    ...request: Parameters<SpaceSession["sendReport"]>
  ): ReturnType<SpaceSession["sendReport"]> {
    return this.#session.sendReport(...request);
  }

  subscribeTermination(
    ...request: Parameters<SpaceSession["subscribeTermination"]>
  ): ReturnType<SpaceSession["subscribeTermination"]> {
    return this.#session.subscribeTermination(...request);
  }

  subscribeViewCapabilityLost(
    ...request: Parameters<SpaceSession["subscribeViewCapabilityLost"]>
  ): ReturnType<SpaceSession["subscribeViewCapabilityLost"]> {
    return this.#session.subscribeViewCapabilityLost(...request);
  }

  setConcurrentWatchRefresh(
    ...request: Parameters<SpaceSession["setConcurrentWatchRefresh"]>
  ): ReturnType<SpaceSession["setConcurrentWatchRefresh"]> {
    return this.#session.setConcurrentWatchRefresh(...request);
  }

  whenRestored(): ReturnType<SpaceSession["whenRestored"]> {
    return this.#session.whenRestored();
  }

  restore(): ReturnType<SpaceSession["restore"]> {
    return this.#session.restore();
  }

  close(): ReturnType<SpaceSession["close"]> {
    return this.#session.close();
  }

  //
  // Private members
  //

  /**
   * Helper for the watch changes, which makes `change` in its turn among
   * them.
   */
  #changeWatches<T>(change: () => Promise<T>): Promise<T> {
    return this.#watchChanges.make(this.#watchChangesMade++, change);
  }
}
