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
 * Calls `attempt`, a request to the memory client, until it settles with
 * something other than a lost connection, and returns what it settles with.
 * A request its connection lost, before it was sent or after, is made again
 * once its `readyToRetry()` resolves. A request that was sent may have
 * landed, so this is for one that is harmless to make twice: a read, or a
 * watch change, which sets what a repeat sets again.
 *
 * @throws What `attempt` rejects with, when that is no lost connection; what
 *   `readyToRetry()` rejects with, as it does once the session has closed;
 *   and the write's own error, once the request's own payload has failed the
 *   write `MAX_OWN_WRITE_FAILURES` times.
 */
export function untilAnswered<T>(attempt: () => Promise<T>): Promise<T> {
  return madeAgain(attempt, true);
}

/**
 * Like `untilAnswered()`, except that only a request that was never sent is
 * made again. One that was sent and not answered fails with its
 * `ConnectionError`, since it may have landed. This is for a request that
 * must not apply twice, such as a mount that redeems an invitation.
 */
export function untilSent<T>(attempt: () => Promise<T>): Promise<T> {
  return madeAgain(attempt, false);
}

/** Helper for `untilAnswered()` and `untilSent()`; see there. */
async function madeAgain<T>(
  attempt: () => Promise<T>,
  whenUnacknowledged: boolean,
): Promise<T> {
  const failures = { ownWrite: 0 };
  for (;;) {
    try {
      return await attempt();
    } catch (error) {
      if (
        !whenUnacknowledged && connectionDeliveryOf(error) === "unacknowledged"
      ) throw error;
      await readyAfter(error, failures);
    }
  }
}

/**
 * Returns the wait after which the request that failed with `error` can be
 * made again, counting a failure of its own write in `failures`.
 *
 * @throws `error`, when it is no lost connection or says nothing of when to
 *   try again, and the write's own error once `failures` reaches
 *   `MAX_OWN_WRITE_FAILURES`.
 */
function readyAfter(
  error: unknown,
  failures: { ownWrite: number },
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

/** A commit made through a `ResendingSession` that has no answer yet. */
type UnansweredCommit = {
  commit: ClientCommit;
  beforeIssue: (() => void) | undefined;
  answer: PromiseWithResolvers<AppliedCommit>;
  /** Whether the commit is with the session, sent and not yet settled. */
  sent: boolean;
  /**
   * Set once the connection has lost the commit: resolves when the session
   * can take it again.
   */
  ready: Promise<void> | undefined;
  failures: { ownWrite: number };
};

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
 * Commits reach the session in increasing `localSeq` order, those made again
 * included: none is sent while an earlier one waits to be made again.
 *
 * Everything else a session offers passes straight through to `session`.
 */
export class ResendingSession {
  readonly #session: SpaceSession;

  /** The commits not yet answered, in increasing `localSeq` order. */
  readonly #unanswered: UnansweredCommit[] = [];

  /**
   * Set while a commit the connection lost waits to be made again. Commits
   * made meanwhile wait behind it.
   */
  #resending: Promise<void> | undefined;

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
    const existing = this.#unanswered.find((unanswered) =>
      unanswered.commit.localSeq === localSeq
    );
    if (existing !== undefined) return existing.answer.promise;
    const unanswered: UnansweredCommit = {
      commit,
      beforeIssue,
      answer: Promise.withResolvers<AppliedCommit>(),
      sent: false,
      ready: undefined,
      failures: { ownWrite: 0 },
    };
    const later = this.#unanswered.findIndex((other) =>
      other.commit.localSeq > localSeq
    );
    this.#unanswered.splice(
      later === -1 ? this.#unanswered.length : later,
      0,
      unanswered,
    );
    if (this.#resending === undefined) this.#send(unanswered);
    return unanswered.answer.promise;
  }

  //
  // Watch changes
  //

  watchSet(
    ...request: Parameters<SpaceSession["watchSet"]>
  ): ReturnType<SpaceSession["watchSet"]> {
    return untilAnswered(() => this.#session.watchSet(...request));
  }

  watchSetSync(
    ...request: Parameters<SpaceSession["watchSetSync"]>
  ): ReturnType<SpaceSession["watchSetSync"]> {
    return untilAnswered(() => this.#session.watchSetSync(...request));
  }

  watchAdd(
    ...request: Parameters<SpaceSession["watchAdd"]>
  ): ReturnType<SpaceSession["watchAdd"]> {
    return untilAnswered(() => this.#session.watchAdd(...request));
  }

  watchAddSync(
    ...request: Parameters<SpaceSession["watchAddSync"]>
  ): ReturnType<SpaceSession["watchAddSync"]> {
    return untilAnswered(() => this.#session.watchAddSync(...request));
  }

  watchRemoveSync(
    ...request: Parameters<SpaceSession["watchRemoveSync"]>
  ): ReturnType<SpaceSession["watchRemoveSync"]> {
    return untilAnswered(() => this.#session.watchRemoveSync(...request));
  }

  viewSetSync(
    ...request: Parameters<SpaceSession["viewSetSync"]>
  ): ReturnType<SpaceSession["viewSetSync"]> {
    return untilAnswered(() => this.#session.viewSetSync(...request));
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
   * Helper for `transact()`, which hands `unanswered` to the session and
   * settles it with the answer, or keeps it to be made again when the
   * connection lost it.
   */
  #send(unanswered: UnansweredCommit): void {
    unanswered.sent = true;
    this.#session.transact(unanswered.commit, unanswered.beforeIssue).then(
      (applied) => {
        this.#forget(unanswered);
        unanswered.answer.resolve(applied);
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
   * Helper for `#send()`, which waits until the session can take the commits
   * the connection lost and then sends every commit that is not with the
   * session, in `localSeq` order: those it lost, and those made while they
   * waited. A drop fails every commit it carried before the session is ready
   * again, so a commit lost while another waits joins that wait.
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

  /** Removes `unanswered` from the commits still to be answered. */
  #forget(unanswered: UnansweredCommit): void {
    const index = this.#unanswered.indexOf(unanswered);
    if (index !== -1) this.#unanswered.splice(index, 1);
  }
}
