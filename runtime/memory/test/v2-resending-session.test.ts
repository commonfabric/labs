/**
 * Covers what makes a request again after its memory connection lost it:
 * `untilSent()`, and the session that makes every request again as that
 * request allows, `ResendingSession`. The cases on a real server show a
 * caller's requests outlasting a host that goes down; the cases on a
 * scripted session pin the order commits and watch changes are sent again
 * in, which a real connection settles too quickly to hold open.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import type { ClientCommit } from "../v2.ts";
import {
  connect,
  isUnacknowledgedError,
  notSentError,
  type SpaceSession,
  unacknowledgedError,
  writeFailedError,
} from "../v2/client.ts";
import type { AppliedCommit } from "../v2/engine.ts";
import {
  MAX_OWN_WRITE_FAILURES,
  ResendingSession,
  untilSent,
} from "../v2/resending-session.ts";
import { Server } from "../v2/server.ts";
import { hostTransport } from "./support/host-transport.ts";
import {
  testSessionOpenAuthFactory,
  testSessionOpenServerOptions,
} from "./v2-auth-test-helpers.ts";

/** A commit that sets `of:doc-<localSeq>`, under `localSeq`. */
const commit = (localSeq: number): ClientCommit => ({
  localSeq,
  reads: { confirmed: [], pending: [] },
  operations: [{
    op: "set",
    id: `of:doc-${localSeq}`,
    value: { value: localSeq },
  }],
});

/** A watch of the whole document `id`, under that id. */
const watch = (id: string) => ({
  id,
  kind: "graph" as const,
  query: { roots: [{ id, selector: { path: [], schema: false } }] },
});

/** A failure of a request that was never sent, ready again as `ready` says. */
const neverSent = (ready: () => Promise<void> = () => Promise.resolve()) =>
  Object.assign(notSentError("test request not sent"), {
    readyToRetry: ready,
  });

/**
 * A failure of a request that was sent and not answered, ready again as
 * `ready` says, whose connection `cause` lost.
 */
const unanswered = (
  ready: () => Promise<void> = () => Promise.resolve(),
  cause?: Error,
) =>
  Object.assign(unacknowledgedError("test request not answered", cause), {
    readyToRetry: ready,
  });

/**
 * A client of a real server whose host can go down, with one session and a
 * `ResendingSession` around it.
 */
async function connected(name: string) {
  const server = new Server({
    ...testSessionOpenServerOptions,
    store: new URL(`memory://resending-session-${name}`),
  });
  const host = hostTransport(server);
  const client = await connect({ transport: host.transport });
  const session = await client.mount(
    `did:key:z6Mk-resending-session-${name}`,
    {},
    testSessionOpenAuthFactory,
  );
  const close = async () => {
    await client.close();
    await server.close();
  };
  return {
    server,
    host,
    client,
    session,
    resending: new ResendingSession(session),
    close,
  };
}

/**
 * A stand-in for a `SpaceSession` that takes commits and leaves each for the
 * test to settle, with a `ResendingSession` around it.
 */
function scripted() {
  const sent: {
    localSeq: number;
    answer: PromiseWithResolvers<AppliedCommit>;
  }[] = [];
  const counts = new Map<number, PromiseWithResolvers<void>>();
  const changes: { change: string; answer: PromiseWithResolvers<unknown> }[] =
    [];
  const changeCounts = new Map<number, PromiseWithResolvers<void>>();
  const changing = (kind: string) => (watches: { id: string }[]) => {
    const answer = Promise.withResolvers<unknown>();
    changes.push({
      change: `${kind} ${watches.map(({ id }) => id).join(",")}`,
      answer,
    });
    changeCounts.get(changes.length)?.resolve();
    return answer.promise;
  };
  const session = {
    transact(commit: ClientCommit, beforeIssue?: () => void) {
      beforeIssue?.();
      const answer = Promise.withResolvers<AppliedCommit>();
      sent.push({ localSeq: commit.localSeq, answer });
      counts.get(sent.length)?.resolve();
      return answer.promise;
    },
    watchSetSync: changing("set"),
    watchAddSync: changing("add"),
  };
  return {
    resending: new ResendingSession(session as unknown as SpaceSession),
    /** Each watch change handed to the session so far, in order. */
    changes,
    /** What each watch change handed to the session so far asked for. */
    changed: () => changes.map(({ change }) => change),
    /** Resolves once the session has been handed `count` watch changes. */
    whenChanged(count: number) {
      if (changes.length >= count) return Promise.resolve();
      const reached = Promise.withResolvers<void>();
      changeCounts.set(count, reached);
      return reached.promise;
    },
    /** Each commit handed to the session so far, in order. */
    sent,
    /** The `localSeq` of each commit handed to the session so far. */
    order: () => sent.map(({ localSeq }) => localSeq),
    /** Resolves once the session has been handed `count` commits. */
    whenSent(count: number) {
      if (sent.length >= count) return Promise.resolve();
      const reached = Promise.withResolvers<void>();
      counts.set(count, reached);
      return reached.promise;
    },
  };
}

/**
 * A wait a test ends, for a failure's `readyToRetry()`: `asked` resolves
 * once the wait has been asked for.
 */
function readiness() {
  const asked = Promise.withResolvers<void>();
  const ready = Promise.withResolvers<void>();
  ready.promise.catch(() => {});
  return {
    asked: asked.promise,
    wait: () => {
      asked.resolve();
      return ready.promise;
    },
    resolve: () => ready.resolve(),
    reject: (error: Error) => ready.reject(error),
  };
}

/** The session's answer to a commit, as far as these cases read it. */
const applied = (seq: number) => ({ seq }) as unknown as AppliedCommit;

/** The requests a `ResendingSession` makes again even when they were sent. */
const WATCH_CHANGES = [
  "watchSet",
  "watchSetSync",
  "watchAdd",
  "watchAddSync",
  "watchRemoveSync",
  "viewSetSync",
] as const;

/** The requests a `ResendingSession` makes again only when never sent. */
const OTHER_REQUESTS = [
  "queryGraph",
  "queryOperationField",
  "listEntityIds",
  "entityIdExists",
  "sqliteQuery",
  "registerSqliteDiskSource",
  "joinPresenceRoom",
  "resolveEventAttention",
  "runPatternLifecycle",
  "runServed",
  "administerInvites",
] as const;

/**
 * What a `ResendingSession` passes to its session and makes once, each with
 * the arguments these cases call it with.
 */
const PASSED_THROUGH: Record<string, unknown[]> = {
  sendReport: ["a"],
  subscribeTermination: ["a"],
  subscribeViewCapabilityLost: ["a"],
  setConcurrentWatchRefresh: ["a"],
  whenRestored: [],
  restore: [],
  close: [],
};

/** The getters a `ResendingSession` reads from its session. */
const READ_THROUGH = [
  "sessionId",
  "sessionToken",
  "principal",
  "serverSeq",
  "declaredSpaceKind",
  "closeError",
  "held",
  "onSessionReplaced",
  "holdingsProvider",
] as const;

type Callable = Record<string, (...args: unknown[]) => unknown>;

/**
 * A `ResendingSession` around a stand-in whose method `name` settles as each
 * of `outcomes` in turn says, an `Error` being a rejection, and the calls
 * the stand-in's method has had.
 */
function answering(name: string, outcomes: unknown[]) {
  const calls: unknown[][] = [];
  const session = {
    [name](...args: unknown[]) {
      calls.push(args);
      const outcome = outcomes[calls.length - 1];
      return outcome instanceof Error
        ? Promise.reject(outcome)
        : Promise.resolve(outcome);
    },
  };
  return {
    resending: new ResendingSession(
      session as unknown as SpaceSession,
    ) as unknown as Callable,
    calls,
  };
}

describe("resending-session", () => {
  describe("untilSent()", () => {
    it("returns what a request that was never sent settles with once it has been made again", async () => {
      let attempts = 0;
      const result = await untilSent(() =>
        ++attempts === 1 ? Promise.reject(neverSent()) : Promise.resolve("ok")
      );

      expect(result).toBe("ok");
      expect(attempts).toBe(2);
    });

    it("makes the request again only once its failure's `readyToRetry()` has resolved", async () => {
      const ready = readiness();
      let attempts = 0;
      const result = untilSent(() =>
        ++attempts === 1
          ? Promise.reject(neverSent(ready.wait))
          : Promise.resolve("ok")
      );
      await ready.asked;

      expect(attempts).toBe(1);

      ready.resolve();
      expect(await result).toBe("ok");
    });

    it("rejects with the `ConnectionError` of a request that was sent and not answered, after one attempt", async () => {
      let attempts = 0;
      const lost = unanswered();

      await expect(untilSent(() => {
        attempts++;
        return Promise.reject(lost);
      })).rejects.toBe(lost);
      expect(attempts).toBe(1);
    });

    it("rejects with an error that is no lost connection, after one attempt", async () => {
      let attempts = 0;
      const refusal = new Error("test refusal");

      await expect(untilSent(() => {
        attempts++;
        return Promise.reject(refusal);
      })).rejects.toBe(refusal);
      expect(attempts).toBe(1);
    });

    it("rejects with a lost connection's error that carries no `readyToRetry()`", async () => {
      const lost = notSentError("test request not sent");

      await expect(untilSent(() => Promise.reject(lost))).rejects.toBe(lost);
    });

    it("rejects with what the failure's `readyToRetry()` rejects with", async () => {
      const ended = new Error("test client closed");

      await expect(
        untilSent(() => Promise.reject(neverSent(() => Promise.reject(ended)))),
      ).rejects.toBe(ended);
    });
  });

  describe("ResendingSession", () => {
    //
    // On a real server
    //

    it("sends commits made while the host was down in `localSeq` order, ahead of a commit made as the session restores", async () => {
      // The newer commit is made the moment the session is restored, which
      // is before the two that failed have been told the session is ready.

      const t = await connected("order");
      try {
        t.host.hostDown();
        const first = t.resending.transact(commit(1));
        const second = t.resending.transact(commit(2));
        const third = t.session.whenRestored().then(() =>
          t.resending.transact(commit(3))
        );
        t.host.hostUp();
        await Promise.all([first, second, third]);

        expect(t.host.transactsSent()).toEqual([1, 2, 3]);
      } finally {
        await t.close();
      }
    });

    it("sends a commit its dropped connection never answered once more, and resolves it with the server's record of it", async () => {
      const t = await connected("unanswered");
      try {
        t.host.loseAnswers();
        const handled = t.host.whenHandled("transact");
        const committing = t.resending.transact(commit(1));
        await handled;
        t.host.drop();
        const answer = await committing;

        expect(answer.seq).toBe(1);
        expect(t.host.transactsOf(1)).toBe(2);
        expect(
          (await t.server.readDocument(
            "did:key:z6Mk-resending-session-unanswered",
            "of:doc-1",
          ))?.value,
        ).toBe(1);
      } finally {
        await t.close();
      }
    });

    it("answers a read made while the host is down once the host is back", async () => {
      const t = await connected("read");
      try {
        t.host.hostDown();
        const reading = t.resending.queryGraph({ roots: [] });
        t.host.hostUp();

        expect((await reading).serverSeq).toBe(0);
      } finally {
        await t.close();
      }
    });

    it("rejects a read its connection dropped before answering with an unacknowledged `ConnectionError`", async () => {
      const t = await connected("read-lost");
      try {
        t.host.failNextSendOf("graph.query");
        const error = await t.resending.queryGraph({ roots: [] }).catch((e) =>
          e
        );

        expect(isUnacknowledgedError(error)).toBe(true);
        expect(t.host.sentOfType("graph.query")).toBe(1);
      } finally {
        await t.close();
      }
    });

    it("makes a watch change its connection dropped before answering once more, and resolves it with the watch added", async () => {
      const t = await connected("watch");
      try {
        t.host.failNextSendOf("session.watch.add");
        await t.resending.watchAddSync([watch("of:doc-1")]);

        expect(t.host.sentOfType("session.watch.add")).toBe(2);
      } finally {
        await t.close();
      }
    });

    it("sends a watch set made while the host was down ahead of the one made as the session restores, which the server is left watching", async () => {
      // A set replaces what the server watches, so the older one sent late
      // would leave the server watching what its caller had since replaced.

      const t = await connected("watch-order");
      try {
        t.host.hostDown();
        const older = t.resending.watchSetSync([watch("of:old")]);
        const newer = t.session.whenRestored().then(() =>
          t.resending.watchSetSync([watch("of:new")])
        );
        t.host.hostUp();
        await Promise.all([older, newer]);

        expect(t.host.watchSetsSent()).toEqual([["of:old"], ["of:new"]]);
      } finally {
        await t.close();
      }
    });

    it("rejects a commit waiting for the host to come back with the session's close error once the session closes", async () => {
      const t = await connected("closed");
      try {
        t.host.hostDown();
        const committing = t.resending.transact(commit(1));
        committing.catch(() => {});
        await t.resending.close();

        await expect(committing).rejects.toThrow("memory session closed");
        expect(t.host.transactsSent()).toEqual([]);
      } finally {
        await t.close();
      }
    });

    //
    // On a scripted session
    //

    it("holds a commit made while an earlier one waits to be sent again, and sends both in `localSeq` order", async () => {
      const t = scripted();
      const ready = readiness();
      const first = t.resending.transact(commit(1));
      t.sent[0].answer.reject(neverSent(ready.wait));
      await ready.asked;
      const second = t.resending.transact(commit(2));

      expect(t.order()).toEqual([1]);

      ready.resolve();
      await t.whenSent(3);
      t.sent[1].answer.resolve(applied(1));
      t.sent[2].answer.resolve(applied(2));

      expect([(await first).seq, (await second).seq]).toEqual([1, 2]);
      expect(t.order()).toEqual([1, 1, 2]);
    });

    it("sends commits made out of `localSeq` order while another waits in that order", async () => {
      const t = scripted();
      const ready = readiness();
      void t.resending.transact(commit(1)).catch(() => {});
      t.sent[0].answer.reject(neverSent(ready.wait));
      await ready.asked;
      void t.resending.transact(commit(3)).catch(() => {});
      void t.resending.transact(commit(2)).catch(() => {});
      ready.resolve();
      await t.whenSent(4);

      expect(t.order()).toEqual([1, 1, 2, 3]);
    });

    it("sends two commits one drop lost again in `localSeq` order, whichever is ready first", async () => {
      const t = scripted();
      const ready = [readiness(), readiness()];
      void t.resending.transact(commit(1)).catch(() => {});
      void t.resending.transact(commit(2)).catch(() => {});
      t.sent[0].answer.reject(unanswered(ready[0].wait));
      t.sent[1].answer.reject(unanswered(ready[1].wait));
      await ready[1].asked;
      ready[1].resolve();
      ready[0].resolve();
      await t.whenSent(4);

      expect(t.order()).toEqual([1, 2, 1, 2]);
    });

    it("rejects a commit whose `readyToRetry()` rejects with that error, and sends the commit behind it", async () => {
      const t = scripted();
      const ready = readiness();
      const replaced = new Error("test session replaced");
      const first = t.resending.transact(commit(1));
      first.catch(() => {});
      t.sent[0].answer.reject(unanswered(ready.wait));
      await ready.asked;
      const second = t.resending.transact(commit(2));
      ready.reject(replaced);
      await t.whenSent(2);
      t.sent[1].answer.resolve(applied(1));

      await expect(first).rejects.toBe(replaced);
      expect((await second).seq).toBe(1);
      expect(t.order()).toEqual([1, 2]);
    });

    it("rejects a commit with the session's refusal of it, after sending it once", async () => {
      const t = scripted();
      const refusal = new Error("test conflict");
      const committing = t.resending.transact(commit(1));
      t.sent[0].answer.reject(refusal);

      await expect(committing).rejects.toBe(refusal);
      expect(t.order()).toEqual([1]);
    });

    it("rejects a commit with the write's own error once its own write has failed `MAX_OWN_WRITE_FAILURES` times", async () => {
      const t = scripted();
      const own = new TypeError("test payload cannot be written");
      const committing = t.resending.transact(commit(1));
      committing.catch(() => {});
      for (let attempt = 1; attempt <= MAX_OWN_WRITE_FAILURES; attempt++) {
        await t.whenSent(attempt);
        t.sent[attempt - 1].answer.reject(
          unanswered(undefined, writeFailedError("test write failed", own)),
        );
      }

      await expect(committing).rejects.toBe(own);
      expect(t.order()).toEqual(
        Array.from({ length: MAX_OWN_WRITE_FAILURES }, () => 1),
      );
    });

    it("returns one answer for a commit made twice under one `localSeq`, and sends it once", async () => {
      const t = scripted();
      const first = t.resending.transact(commit(1));
      const second = t.resending.transact(commit(1));
      t.sent[0].answer.resolve(applied(1));

      expect(second).toBe(first);
      expect((await first).seq).toBe(1);
      expect(t.order()).toEqual([1]);
    });

    it("runs `beforeIssue` each time the commit is sent", async () => {
      const t = scripted();
      let issues = 0;
      const committing = t.resending.transact(commit(1), () => issues++);
      t.sent[0].answer.reject(neverSent());
      await t.whenSent(2);
      t.sent[1].answer.resolve(applied(1));
      await committing;

      expect(issues).toBe(2);
    });

    it("rejects a commit with a plain error carrying the failure's message when the transport named no cause for its failed write", async () => {
      const t = scripted();
      const committing = t.resending.transact(commit(1));
      committing.catch(() => {});
      for (let attempt = 1; attempt <= MAX_OWN_WRITE_FAILURES; attempt++) {
        await t.whenSent(attempt);
        t.sent[attempt - 1].answer.reject(
          unanswered(undefined, writeFailedError("test write failed")),
        );
      }
      const error = await committing.catch((e) => e);

      expect(error.name).toBe("Error");
      expect(error.message).toBe("test request not answered");
    });

    it("holds a watch change made while an earlier one of another kind waits to be made again, and makes both in the order they were first made", async () => {
      const t = scripted();
      const ready = readiness();
      const setting = t.resending.watchSetSync([watch("of:old")]);
      t.changes[0].answer.reject(unanswered(ready.wait));
      await ready.asked;
      const adding = t.resending.watchAddSync([watch("of:new")]);

      expect(t.changed()).toEqual(["set of:old"]);

      ready.resolve();
      await t.whenChanged(3);
      t.changes[1].answer.resolve("set");
      t.changes[2].answer.resolve("added");

      expect([await setting, await adding]).toEqual(["set", "added"]);
      expect(t.changed()).toEqual(["set of:old", "set of:old", "add of:new"]);
    });

    it("sends a commit while a watch change waits to be made again", async () => {
      // Commits and watch changes each keep their own order, and neither
      // waits for the other.

      const t = scripted();
      const ready = readiness();
      void t.resending.watchSetSync([watch("of:old")]).catch(() => {});
      t.changes[0].answer.reject(neverSent(ready.wait));
      await ready.asked;
      const committing = t.resending.transact(commit(1));
      t.sent[0].answer.resolve(applied(1));

      expect((await committing).seq).toBe(1);
      expect(t.changed()).toEqual(["set of:old"]);
      ready.resolve();
      await t.whenChanged(2);
    });

    for (const name of WATCH_CHANGES) {
      it(`makes \`${name}()\` again after a connection that dropped before answering it, with the same arguments`, async () => {
        const { resending, calls } = answering(name, [unanswered(), "ok"]);

        expect(await resending[name]("a", "b")).toBe("ok");
        expect(calls).toEqual([["a", "b"], ["a", "b"]]);
      });
    }

    for (const name of OTHER_REQUESTS) {
      it(`makes \`${name}()\` again when it was never sent, with the same arguments`, async () => {
        const { resending, calls } = answering(name, [neverSent(), "ok"]);

        expect(await resending[name]("a", "b")).toBe("ok");
        expect(calls).toEqual([["a", "b"], ["a", "b"]]);
      });

      it(`rejects \`${name}()\` with its \`ConnectionError\` when it was sent and not answered, after one call`, async () => {
        const lost = unanswered();
        const { resending, calls } = answering(name, [lost, "ok"]);

        await expect(resending[name]("a")).rejects.toBe(lost);
        expect(calls).toEqual([["a"]]);
      });
    }

    for (const [name, args] of Object.entries(PASSED_THROUGH)) {
      it(`passes \`${name}()\` to the session once, a lost connection included, and returns the session's answer`, async () => {
        const lost = neverSent();
        const failing = answering(name, [lost]);
        const { resending, calls } = answering(name, ["ok"]);

        await expect(failing.resending[name](...args)).rejects.toBe(lost);
        expect(failing.calls).toHaveLength(1);
        expect(await resending[name](...args)).toBe("ok");
        expect(calls).toEqual([args]);
      });
    }

    for (const name of READ_THROUGH) {
      it(`reads \`${name}\` from the session`, () => {
        const value = () => undefined;
        const resending = new ResendingSession(
          { [name]: value } as unknown as SpaceSession,
        ) as unknown as Record<string, unknown>;

        expect(resending[name]).toBe(value);
      });
    }

    it("sets `onSessionReplaced` and `holdingsProvider` on the session", () => {
      const session: {
        onSessionReplaced?: unknown;
        holdingsProvider?: unknown;
      } = {};
      const resending = new ResendingSession(
        session as unknown as SpaceSession,
      );
      const observer = () => {};
      const provider = () => undefined;
      resending.onSessionReplaced = observer;
      resending.holdingsProvider = provider;

      expect(session).toEqual({
        onSessionReplaced: observer,
        holdingsProvider: provider,
      });
    });
  });
});
