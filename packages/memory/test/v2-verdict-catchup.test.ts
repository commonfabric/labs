// CT-1927: transact verdicts return before the independently batched fan-out,
// so N commits can apply against one watch-union recompute. Every verdict
// (accepts as well as conflict rejections) stages a `caughtUpLocalSeq`
// obligation, and the batched fan-out stamps the marker on the next frame to
// the committing session — an otherwise-empty frame if nothing it watches is
// dirty. The CLIENT parks each accept's promotion until the marker covers it
// (04-protocol.md §4.11.2); these tests pin the server half: verdict ordering,
// frame coverage, and eventual marker delivery.
//
// Automatic fan-out is held — a long refresh delay or the manual gate —
// so each test drives delivery explicitly with flushSessions().

import { assertEquals, assertExists } from "@std/assert";
import {
  encodeMemoryBoundary,
  getMemoryProtocolFlags,
  type HelloOkMessage,
  MEMORY_PROTOCOL,
  resetOwnWriteEchoConfig,
  type ResponseMessage,
  type ServerMessage,
  type SessionEffectMessage,
  type SessionOpenAuthMetadata,
  type SessionSync,
  setOwnWriteEchoConfig,
} from "../v2.ts";
import { Server } from "../v2/server.ts";
import { internSchemaAsTaggedHashString } from "@commonfabric/data-model-schema";
import { testSessionOpenServerOptions } from "./v2-auth-test-helpers.ts";

// Content-addressed ids of the schema documents the tests below install.
const ELIDE_FANOUT_ID = `cid:${
  internSchemaAsTaggedHashString({ type: "string", title: "fanout" })
}`;
const ALL_ELIDED_ID = `cid:${
  internSchemaAsTaggedHashString({ type: "string", title: "all-elided" })
}`;
const DIRECT_ELIDE_ID = `cid:${
  internSchemaAsTaggedHashString({ type: "string", title: "direct-elide" })
}`;

const HELLO = {
  type: "hello",
  protocol: MEMORY_PROTOCOL,
  flags: getMemoryProtocolFlags(),
} as const;

const shiftMessage = (messages: ServerMessage[]): ServerMessage => {
  const message = messages.shift();
  assertExists(message);
  return message;
};

const assertResponse = <Result>(
  message: ServerMessage,
): ResponseMessage<Result> => {
  assertEquals(message.type, "response");
  return message as ResponseMessage<Result>;
};

const assertEffect = (message: ServerMessage): SessionEffectMessage => {
  assertEquals(message.type, "session/effect");
  return message as SessionEffectMessage;
};

const expectHelloOk = (messages: ServerMessage[]): SessionOpenAuthMetadata => {
  const hello = shiftMessage(messages) as HelloOkMessage;
  assertEquals(hello.type, "hello.ok");
  assertExists(hello.sessionOpen);
  return hello.sessionOpen;
};

const authInvocation = (sessionOpen: SessionOpenAuthMetadata) => ({
  aud: sessionOpen.audience,
  challenge: sessionOpen.challenge.value,
});

const watchBoth = (space: string, sessionId: string) => ({
  type: "session.watch.set",
  requestId: "watch-both",
  space,
  sessionId,
  watches: [{
    id: "root",
    kind: "graph",
    query: {
      roots: [
        { id: "of:doc:a", selector: { path: [], schema: false } },
        { id: "of:doc:b", selector: { path: [], schema: false } },
      ],
    },
  }],
});

const setup = async (options: {
  subscriptionRefreshDelayMs: number | "manual";
  store: string;
}) => {
  const server = new Server({
    ...testSessionOpenServerOptions,
    store: new URL(options.store),
    subscriptionRefreshDelayMs: options.subscriptionRefreshDelayMs,
  });
  const committerMessages: ServerMessage[] = [];
  const committer = server.connect((message) =>
    committerMessages.push(message)
  );
  const space = "did:key:z6Mk-verdict-catchup";

  await committer.receive(encodeMemoryBoundary(HELLO));
  const committerSessionOpen = expectHelloOk(committerMessages);

  await committer.receive(encodeMemoryBoundary({
    type: "session.open",
    requestId: "committer-open",
    space,
    session: {},
    invocation: authInvocation(committerSessionOpen),
  }));
  const committerSessionId =
    assertResponse<{ sessionId: string }>(shiftMessage(committerMessages))
      .ok!.sessionId;

  await committer.receive(
    encodeMemoryBoundary(watchBoth(space, committerSessionId)),
  );
  assertResponse(shiftMessage(committerMessages));

  // Foreign novelty the committer has NOT received: the out-of-band direct
  // write path (the blob-upload path) marks the space dirty — held until
  // the test's explicit flush — WITHOUT a transact verdict. seq 1 = doc:b.
  await server.writeDocument(space, "of:doc:b", { from: "writer" });

  return {
    server,
    space,
    committer,
    committerMessages,
    committerSessionId,
  };
};

Deno.test("memory v2 server: an accept returns inline and its marker rides the batched frame with the parked novelty", async () => {
  const context = await setup({
    subscriptionRefreshDelayMs: 60_000,
    store: "memory://verdict-catchup-accept",
  });
  const { server, space, committer, committerMessages, committerSessionId } =
    context;

  await committer.receive(encodeMemoryBoundary({
    type: "transact",
    requestId: "committer-a",
    space,
    sessionId: committerSessionId,
    commit: {
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: "of:doc:a",
        value: { value: { from: "committer" } },
      }],
    },
  }));

  // The verdict is INLINE — no flush precedes it; the fan-out stays batched
  // so a burst of commits shares one watch-union recompute.
  const verdict = assertResponse<{ seq: number }>(
    shiftMessage(committerMessages),
  );
  assertEquals(verdict.ok?.seq, 2);
  assertEquals(committerMessages.length, 0);

  // The batched pass then delivers the parked foreign write STAMPED with the
  // accept's marker: the frame reflects every decided outcome ≤ 1 for the
  // docs it covers, and the client applies the parked promotion on it. The
  // committer's own accepted doc:a is echo-suppressed — the parked verdict
  // carries its truth.
  await server.flushSessions([space]);
  const effect = assertEffect(shiftMessage(committerMessages));
  const sync = effect.effect as SessionSync;
  assertEquals(sync.caughtUpLocalSeq, 1);
  assertEquals(
    sync.upserts
      .map((upsert) => ({ id: upsert.id, seq: upsert.seq, doc: upsert.doc })),
    [
      { id: "of:doc:b", seq: 1, doc: { value: { from: "writer" } } },
    ],
  );
  assertEquals(committerMessages.length, 0);
});

Deno.test("memory v2 server: an accept with no watched novelty still gets its marker on an otherwise-empty frame", async () => {
  const context = await setup({
    subscriptionRefreshDelayMs: 60_000,
    store: "memory://verdict-catchup-empty-frame",
  });
  const { server, space, committer, committerMessages, committerSessionId } =
    context;

  // Drain the fixture's parked doc:b first so nothing watched is dirty.
  await server.flushSessions([space]);
  assertEffect(shiftMessage(committerMessages));

  await committer.receive(encodeMemoryBoundary({
    type: "transact",
    requestId: "committer-a",
    space,
    sessionId: committerSessionId,
    commit: {
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: "of:doc:a",
        value: { value: { from: "committer" } },
      }],
    },
  }));
  const verdict = assertResponse<{ seq: number }>(
    shiftMessage(committerMessages),
  );
  assertEquals(verdict.ok?.seq, 2);

  // The client's parked promotion is keyed on this marker, so it MUST
  // arrive even when the session's own write is the only novelty (and is
  // echo-suppressed): the obligation forces an otherwise-empty frame.
  await server.flushSessions([space]);
  const effect = assertEffect(shiftMessage(committerMessages));
  const sync = effect.effect as SessionSync;
  assertEquals(sync.caughtUpLocalSeq, 1);
  assertEquals(sync.upserts, []);
  assertEquals(sync.removes, []);
});

Deno.test("memory v2 server: an accept on a doc OUTSIDE the watch set still gets its marker on an otherwise-empty frame", async () => {
  const context = await setup({
    subscriptionRefreshDelayMs: "manual",
    store: "memory://verdict-catchup-unwatched-doc",
  });
  const { server, space, committer, committerMessages, committerSessionId } =
    context;

  // Drain the fixture's parked doc:b first so nothing watched is dirty.
  await server.flushSessions([space]);
  assertEffect(shiftMessage(committerMessages));

  // The committer watches doc:a and doc:b; this set targets doc:z, which no
  // watch covers. Its dirty mark cannot touch the session's tracked graph,
  // so the marker cannot ride any document delivery — the catch-up
  // obligation alone must force the frame, or the client's parked promotion
  // (and its coverage-resolving commit promise) would wait forever.
  await committer.receive(encodeMemoryBoundary({
    type: "transact",
    requestId: "committer-z",
    space,
    sessionId: committerSessionId,
    commit: {
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: "of:doc:z",
        value: { value: { from: "committer" } },
      }],
    },
  }));
  const verdict = assertResponse<{ seq: number }>(
    shiftMessage(committerMessages),
  );
  assertEquals(verdict.ok?.seq, 2);

  await server.flushSessions([space]);
  const effect = assertEffect(shiftMessage(committerMessages));
  const sync = effect.effect as SessionSync;
  assertEquals(sync.caughtUpLocalSeq, 1);
  assertEquals(sync.upserts, []);
  assertEquals(sync.removes, []);
});

Deno.test("memory v2 server: a rejection's read repair rides the batched frame with the rejection's marker", async () => {
  const context = await setup({
    subscriptionRefreshDelayMs: 60_000,
    store: "memory://verdict-catchup-reject",
  });
  const { server, space, committer, committerMessages, committerSessionId } =
    context;

  // Stale confirmed read: doc:b moved at seq 1; the committer claims seq 0.
  await committer.receive(encodeMemoryBoundary({
    type: "transact",
    requestId: "committer-stale",
    space,
    sessionId: committerSessionId,
    commit: {
      localSeq: 1,
      reads: {
        confirmed: [{ id: "of:doc:b", path: [], seq: 0 }],
        pending: [],
      },
      operations: [{
        op: "set",
        id: "of:doc:a",
        value: { value: { derived: true } },
      }],
    },
  }));

  // Rejection inline; the client's read-repair gate holds the drop.
  const verdict = assertResponse(shiftMessage(committerMessages));
  assertExists(verdict.error);
  assertEquals(committerMessages.length, 0);

  // The staged repair (the winning doc:b) arrives with the rejected
  // commit's marker — the gate releases against repaired state.
  await server.flushSessions([space]);
  const effect = assertEffect(shiftMessage(committerMessages));
  const sync = effect.effect as SessionSync;
  assertEquals(sync.caughtUpLocalSeq, 1);
  assertEquals(
    sync.upserts.map((upsert) => ({ id: upsert.id, seq: upsert.seq })),
    [{ id: "of:doc:b", seq: 1 }],
  );
});

Deno.test("memory v2 server: a failed fan-out requeues the batch and the scheduled refresh recovers", async () => {
  const context = await setup({
    subscriptionRefreshDelayMs: 60_000,
    store: "memory://verdict-catchup-requeue",
  });
  const { server, space, committer, committerMessages, committerSessionId } =
    context;

  await committer.receive(encodeMemoryBoundary({
    type: "transact",
    requestId: "committer-a",
    space,
    sessionId: committerSessionId,
    commit: {
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: "of:doc:a",
        value: { value: { from: "committer" } },
      }],
    },
  }));
  const verdict = assertResponse<{ seq: number }>(
    shiftMessage(committerMessages),
  );
  assertEquals(verdict.ok?.seq, 2);

  // Fail INSIDE the fan-out — after refreshLoop has consumed the dirty
  // state — at the CONNECTION delivery layer, below the evaluation
  // boundary (an evaluation failure is logged and its frame skipped
  // rather than requeued; this pin is about transport-class failures).
  const original = committer.refreshDirty.bind(committer);
  let calls = 0;
  (committer as unknown as {
    refreshDirty: typeof original;
  }).refreshDirty = (...args) => {
    calls += 1;
    if (calls === 1) {
      return Promise.reject(new Error("synthetic fan-out failure"));
    }
    return original(...args);
  };
  let threw = false;
  try {
    await server.flushSessions([space]);
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
  assertEquals(committerMessages.length, 0);

  // Recovery: the consumed batch was REQUEUED, so the next pass delivers
  // the parked foreign novelty and the outcome marker the client's parked
  // promotion is waiting for — "batched refresh recovers" is a kept
  // promise, not a hope.
  await server.flushSessions([space]);
  const effect = assertEffect(shiftMessage(committerMessages));
  const sync = effect.effect as SessionSync;
  assertEquals(sync.caughtUpLocalSeq, 1);
  assertEquals(
    sync.upserts.map((upsert) => upsert.id),
    ["of:doc:b"],
  );
});

Deno.test("memory v2 server: same-doc foreign novelty is not echo-suppressed by the writer's own commit", async () => {
  // Pin the mixed-provenance machinery itself: with the own-write echo on,
  // every own patch head is delivered regardless of provenance, so this
  // test would pass vacuously. Suppression mode is where the clearing rule
  // is load-bearing.
  setOwnWriteEchoConfig(false);
  try {
    const context = await setup({
      subscriptionRefreshDelayMs: 60_000,
      store: "memory://verdict-catchup-mixed-origin",
    });
    const { server, space, committer, committerMessages, committerSessionId } =
      context;

    // The committer patches doc:b ITSELF — the doc already carrying parked
    // foreign novelty. Mixed provenance must clear the echo-suppression
    // origin: suppressing would hide the foreign write from the writer while
    // its sync cursor advances past it (unrecoverable staleness for a client
    // without CT-1926 values).
    await committer.receive(encodeMemoryBoundary({
      type: "transact",
      requestId: "committer-b",
      space,
      sessionId: committerSessionId,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "patch",
          id: "of:doc:b",
          patches: [{ op: "add", path: "/value/mine", value: true }],
        }],
      },
    }));
    const verdict = assertResponse<{ seq: number }>(
      shiftMessage(committerMessages),
    );
    assertEquals(verdict.ok?.seq, 2);

    await server.flushSessions([space]);
    const effect = assertEffect(shiftMessage(committerMessages));
    const sync = effect.effect as SessionSync;
    assertEquals(sync.caughtUpLocalSeq, 1);
    assertEquals(
      sync.upserts.map((upsert) => ({
        id: upsert.id,
        seq: upsert.seq,
        doc: upsert.doc,
      })),
      [{
        id: "of:doc:b",
        seq: 2,
        doc: { value: { from: "writer", mine: true } },
      }],
    );
  } finally {
    resetOwnWriteEchoConfig();
  }
});

Deno.test("memory v2 server: a failed send rolls back delivery state; the next flush recomputes and delivers", async () => {
  const context = await setup({
    subscriptionRefreshDelayMs: 60_000,
    store: "memory://verdict-catchup-send-rollback",
  });
  const { server, space, committer, committerMessages, committerSessionId } =
    context;

  await committer.receive(encodeMemoryBoundary({
    type: "transact",
    requestId: "committer-a",
    space,
    sessionId: committerSessionId,
    commit: {
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: "of:doc:a",
        value: { value: { from: "committer" } },
      }],
    },
  }));
  assertEquals(
    assertResponse<{ seq: number }>(shiftMessage(committerMessages)).ok?.seq,
    2,
  );

  // Evaluation advances the session cache and consumes the marker BEFORE
  // the effect reaches the wire. A throwing send must ROLL that state back
  // — forget the frame's docs from the cache, re-stage the marker,
  // re-dirty the ids — so the next pass recomputes the same delivery from
  // durable state. (No server-side buffering: a dying real socket loses
  // "successfully sent" frames without throwing at all; reconnect
  // hardening owns that case.)
  const originalPush = committerMessages.push.bind(committerMessages);
  let failNextEffect = true;
  committerMessages.push = ((message: ServerMessage) => {
    if (failNextEffect && message.type === "session/effect") {
      failNextEffect = false;
      throw new Error("synthetic send failure");
    }
    return originalPush(message);
  }) as typeof committerMessages.push;
  await server.flushSessions([space]);
  assertEquals(committerMessages.length, 0);

  // Recomputation delivers the parked foreign write and the accept's
  // marker — nothing the advanced cache would have elided as
  // already-snapshotted.
  await server.flushSessions([space]);
  const effect = assertEffect(shiftMessage(committerMessages));
  const sync = effect.effect as SessionSync;
  assertEquals(sync.caughtUpLocalSeq, 1);
  assertEquals(
    sync.upserts.map((upsert) => ({ id: upsert.id, seq: upsert.seq })),
    [{ id: "of:doc:b", seq: 1 }],
  );
  assertEquals(committerMessages.length, 0);

  // Rolling back for a vanished session is a no-op (its cache died with
  // it).
  server.rollbackUndeliveredSync(space, "session:gone", {
    type: "session/effect",
    space,
    sessionId: "session:gone",
    effect: { type: "sync", fromSeq: 0, toSeq: 1, upserts: [], removes: [] },
  });

  // A lost frame's REMOVES must reach the client too: rollback re-inserts
  // a tombstone cache entry and forces the next sync through a FULL
  // evaluation — the incremental path never emits removes — so the re-diff
  // (tombstone present, entity absent) regenerates the removal.
  server.rollbackUndeliveredSync(space, committerSessionId, {
    type: "session/effect",
    space,
    sessionId: committerSessionId,
    effect: {
      type: "sync",
      fromSeq: 1,
      toSeq: 2,
      upserts: [],
      removes: [{ branch: "", id: "of:doc:zz", scope: "space" }],
    },
  });
  await server.flushSessions([space]);
  const removeEffect = assertEffect(shiftMessage(committerMessages));
  assertEquals(
    (removeEffect.effect as SessionSync).removes.map((remove) => remove.id),
    ["of:doc:zz"],
  );
  assertEquals(committerMessages.length, 0);
});

Deno.test("memory v2 server: transact against a registry-unknown session fails closed", async () => {
  const context = await setup({
    subscriptionRefreshDelayMs: 60_000,
    store: "memory://verdict-catchup-unknown-session",
  });
  const { server, space } = context;

  // The registry-miss guard inside transact itself. A connection can hold
  // a local handle for a session the registry has dropped (ACL
  // self-removal — whose deferred revocation now also cleans up the local
  // handle, which is why this guard needs its own pin).
  const response = await server.transact({
    type: "transact",
    requestId: "unknown-session-tx",
    space,
    sessionId: "session:not-in-registry",
    commit: {
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: "of:doc:a",
        value: { value: { from: "nobody" } },
      }],
    },
  });
  assertEquals(response.error?.name, "SessionError");
  assertEquals(response.error?.message, "Unknown session for space");
});

Deno.test("memory v2 server: a failing timer-driven flush warns and leaves recovery to the requeue", async () => {
  const context = await setup({
    subscriptionRefreshDelayMs: 60_000,
    store: "memory://verdict-catchup-scheduled-flush-failure",
  });
  const { server, space, committerMessages } = context;

  // The timer-driven wrapper has no caller to surface a failure to: it
  // must swallow (warn) rather than leak an unhandled rejection, and rely
  // on refreshLoop's requeue for recovery.
  const originalFlush = server.flushSessions.bind(server);
  let failed = false;
  server.flushSessions = () => {
    if (!failed) {
      failed = true;
      return Promise.reject(new Error("synthetic scheduled-flush failure"));
    }
    return originalFlush();
  };
  await server.accessForTestingOnly.flushScheduledSessions();
  assertEquals(committerMessages.length, 0);

  // The batch was never consumed (the stub rejected before the pass); a
  // real flush delivers the parked novelty.
  await originalFlush([space]);
  const effect = assertEffect(shiftMessage(committerMessages));
  assertEquals(
    (effect.effect as SessionSync).upserts.map((upsert) => upsert.id),
    ["of:doc:b"],
  );
});

Deno.test("memory v2 server: requeue after failure does not resurrect echo suppression for re-dirtied docs", async () => {
  const context = await setup({
    subscriptionRefreshDelayMs: 60_000,
    store: "memory://verdict-catchup-requeue-origin",
  });
  const { server, space, committer, committerMessages, committerSessionId } =
    context;

  // First fan-out consumes the batch (doc:b unattributed) and, BEFORE
  // failing, doc:b is re-dirtied WITH an origin — as a concurrent own
  // write would. The failure is at the CONNECTION delivery layer (below
  // the evaluation boundary), so the requeue merge runs, and it must not
  // let the newer origin win: provenance survives only when both batches
  // agree.
  const original = committer.refreshDirty.bind(committer);
  let failed = false;
  (committer as unknown as {
    refreshDirty: typeof original;
  }).refreshDirty = (...args) => {
    if (!failed) {
      failed = true;
      server.markSpaceDirty(space, ["space\x00of:doc:b"], {
        sessionId: committerSessionId,
        // doc:b's ACTUAL seq: echo suppression fires only when the origin's
        // seq matches the delivered upsert's seq, so a fabricated seq would
        // never suppress and the pin would pass even without the provenance
        // rule it exists to guard. The op must be an ELIDABLE kind
        // ("set"): a "patch" origin is delivered under CT-1965 regardless,
        // which would also let the pin pass vacuously.
        seq: 1,
        ops: new Map([["space\x00of:doc:b", { op: "set" as const }]]),
      });
      return Promise.reject(new Error("synthetic fan-out failure"));
    }
    return original(...args);
  };

  let threw = false;
  try {
    await server.flushSessions([space]);
  } catch {
    threw = true;
  }
  assertEquals(threw, true);

  // Recovery: doc:b must fan out to the committer AUTHORITATIVELY — the
  // consumed batch's unattributed novelty forbids suppressing it as the
  // committer's own echo.
  await server.flushSessions([space]);
  const effect = assertEffect(shiftMessage(committerMessages));
  assertEquals(
    (effect.effect as SessionSync).upserts.map((upsert) => upsert.id),
    ["of:doc:b"],
  );
});

Deno.test("memory v2 server: the verdict leaves within the transact's publication turn; fan-out cannot enter it", async () => {
  const context = await setup({
    subscriptionRefreshDelayMs: 60_000,
    store: "memory://verdict-catchup-publication-turn",
  });
  const { server, space, committerMessages, committerSessionId } = context;

  // Train-side re-pin of #5529's verdict-precedes-fan-out. The test takes
  // publication turns of its own on the space's lock: turn A holds the lock
  // while the transact queues behind it; turn B queues behind the transact,
  // and fan-out behind B. The lock is first-come, so releasing A runs the
  // transact's turn, whose verdict must reach the committing session while B
  // is what stands between it and fan-out; releasing B lets fan-out in.
  const lock = server.accessForTestingOnly.withSpacePublicationLock;
  const turnA = Promise.withResolvers<void>();
  const turnB = Promise.withResolvers<void>();
  const heldA = lock(space, () => turnA.promise);
  // Sent to the server directly rather than through the connection, whose
  // receive path awaits before it reaches the lock; the direct call queues
  // its turn synchronously, which is what fixes the order.
  const commit = server.transact({
    type: "transact",
    requestId: "committer-turn",
    space,
    sessionId: committerSessionId,
    commit: {
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: "of:doc:a",
        value: { value: { from: "committer" } },
      }],
    },
  }, (verdict) => committerMessages.push(verdict));
  // B's body runs as soon as the transact's turn ends: a verdict published
  // inside that turn is at the committer by then, one published after any
  // later await is not.
  let verdictsAtB = -1;
  const heldB = lock(space, () => {
    verdictsAtB = committerMessages.length;
    return turnB.promise;
  });
  const fanout = server.flushSessions([space]);

  turnA.resolve();
  await heldA;
  await commit;
  // The verdict is at the committing session as soon as its transact's turn
  // is over, and nothing else has reached it.
  const verdict = assertResponse<{ seq: number }>(
    shiftMessage(committerMessages),
  );
  assertEquals(verdict.ok?.seq, 2);
  assertEquals(verdictsAtB, 1);
  // Fan-out serializes behind turn B: while B is held, no frame reaches the
  // committer.
  assertEquals(committerMessages.length, 0);
  turnB.resolve();
  await Promise.all([heldB, fanout]);

  // With the turns released, fan-out delivers the parked novelty; the
  // committer's own accepted doc:a stays echo-suppressed.
  const effect = assertEffect(shiftMessage(committerMessages));
  const sync = effect.effect as SessionSync;
  assertEquals(sync.caughtUpLocalSeq, 1);
  assertEquals(
    sync.upserts
      .map((upsert) => ({ id: upsert.id, seq: upsert.seq, doc: upsert.doc })),
    [
      { id: "of:doc:b", seq: 1, doc: { value: { from: "writer" } } },
    ],
  );
  assertEquals(committerMessages.length, 0);
});

Deno.test("memory v2 server: an evaluation failure skips only that session's frame; later spaces deliver in the same pass", async () => {
  const context = await setup({
    subscriptionRefreshDelayMs: 60_000,
    store: "memory://verdict-catchup-multi-space",
  });
  const { server, space, committerMessages } = context;

  // A SECOND space with its own observing session, so stranding is
  // observable: without an observer, a stranded space holds dirty docs no
  // assertion can see, and the pin passes even against the pre-fix code.
  const spaceB = "did:key:z6Mk-verdict-catchup-second-space";
  const observerMessages: ServerMessage[] = [];
  const observer = server.connect((message) => observerMessages.push(message));
  await observer.receive(encodeMemoryBoundary(HELLO));
  const observerSessionOpen = expectHelloOk(observerMessages);
  await observer.receive(encodeMemoryBoundary({
    type: "session.open",
    requestId: "observer-open",
    space: spaceB,
    session: {},
    invocation: authInvocation(observerSessionOpen),
  }));
  const observerSessionId =
    assertResponse<{ sessionId: string }>(shiftMessage(observerMessages))
      .ok!.sessionId;
  await observer.receive(encodeMemoryBoundary({
    type: "session.watch.set",
    requestId: "watch-z",
    space: spaceB,
    sessionId: observerSessionId,
    watches: [{
      id: "root",
      kind: "graph",
      query: {
        roots: [{ id: "of:doc:z", selector: { path: [], schema: false } }],
      },
    }],
  }));
  assertResponse(shiftMessage(observerMessages));
  // Parked novelty in spaceB, mirroring setup's doc:b in the first space.
  await server.writeDocument(spaceB, "of:doc:z", { parked: true });

  const original = server.syncSessionForConnection.bind(server);
  let failed = false;
  (server as unknown as {
    syncSessionForConnection: typeof original;
  }).syncSessionForConnection = (...args) => {
    if (!failed) {
      failed = true;
      return Promise.reject(new Error("synthetic first-space failure"));
    }
    return original(...args);
  };

  // The evaluation failure skips ONLY the failed session's frame; the
  // same pass still reaches the other space's observer — nothing is
  // stranded and nothing throws.
  await server.flushSessions([space, spaceB]);
  assertEquals(committerMessages.length, 0);
  const observerSync = assertEffect(shiftMessage(observerMessages))
    .effect as SessionSync;
  assertEquals(
    observerSync.upserts.map((upsert) => upsert.id),
    ["of:doc:z"],
  );
});

Deno.test("memory v2 server: an identical cid re-set fans out no novelty to watchers", async () => {
  const context = await setup({
    subscriptionRefreshDelayMs: 60_000,
    store: "memory://verdict-catchup-cid-elide",
  });
  const { server, space, committer, committerMessages, committerSessionId } =
    context;
  await server.flushSessions([space]);
  assertEffect(shiftMessage(committerMessages));

  // A second session observes the schema document and a control doc.
  const observerMessages: ServerMessage[] = [];
  const observer = server.connect((message) => observerMessages.push(message));
  await observer.receive(encodeMemoryBoundary(HELLO));
  const observerSessionOpen = expectHelloOk(observerMessages);
  await observer.receive(encodeMemoryBoundary({
    type: "session.open",
    requestId: "observer-open",
    space,
    session: {},
    invocation: authInvocation(observerSessionOpen),
  }));
  const observerSessionId =
    assertResponse<{ sessionId: string }>(shiftMessage(observerMessages))
      .ok!.sessionId;
  await observer.receive(encodeMemoryBoundary({
    type: "session.watch.set",
    requestId: "observer-watch",
    space,
    sessionId: observerSessionId,
    watches: [{
      id: "elide-watch",
      kind: "graph",
      query: {
        roots: [
          {
            id: ELIDE_FANOUT_ID,
            selector: { path: [], schema: false },
          },
          { id: "of:elide-control", selector: { path: [], schema: false } },
        ],
      },
    }],
  }));
  assertResponse(shiftMessage(observerMessages));

  // Install both; the observer's frame carries both.
  await committer.receive(encodeMemoryBoundary({
    type: "transact",
    requestId: "committer-install",
    space,
    sessionId: committerSessionId,
    commit: {
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [
        {
          op: "set",
          id: ELIDE_FANOUT_ID,
          value: { value: { type: "string", title: "fanout" } },
        },
        { op: "set", id: "of:elide-control", value: { value: { round: 1 } } },
      ],
    },
  }));
  assertResponse(shiftMessage(committerMessages));
  await server.flushSessions([space]);
  // The committer's own accept rides home as an (echo-suppressed) marker
  // frame; drain it so the next shift sees the second verdict.
  assertEffect(shiftMessage(committerMessages));
  const first = assertEffect(shiftMessage(observerMessages))
    .effect as SessionSync;
  assertEquals(
    first.upserts.map((upsert) => upsert.id).toSorted(),
    [ELIDE_FANOUT_ID, "of:elide-control"],
  );

  // The identical re-set applies as a no-op, so the observer's next frame
  // carries ONLY the control change — before elision, the re-set advanced
  // the schema document's head and re-delivered the unchanged content here.
  await committer.receive(encodeMemoryBoundary({
    type: "transact",
    requestId: "committer-reset",
    space,
    sessionId: committerSessionId,
    commit: {
      localSeq: 2,
      reads: { confirmed: [], pending: [] },
      operations: [
        {
          op: "set",
          id: ELIDE_FANOUT_ID,
          value: { value: { type: "string", title: "fanout" } },
        },
        { op: "set", id: "of:elide-control", value: { value: { round: 2 } } },
      ],
    },
  }));
  assertResponse(shiftMessage(committerMessages));
  await server.flushSessions([space]);
  const second = assertEffect(shiftMessage(observerMessages))
    .effect as SessionSync;
  assertEquals(
    second.upserts.map((upsert) => ({ id: upsert.id, doc: upsert.doc })),
    [{ id: "of:elide-control", doc: { value: { round: 2 } } }],
  );
  observer.close();
});

Deno.test("memory v2 server: an all-elided accept still delivers its marker on an empty frame", async () => {
  const context = await setup({
    subscriptionRefreshDelayMs: 60_000,
    store: "memory://verdict-catchup-all-elided",
  });
  const { server, space, committer, committerMessages, committerSessionId } =
    context;
  await server.flushSessions([space]);
  assertEffect(shiftMessage(committerMessages));

  await committer.receive(encodeMemoryBoundary({
    type: "transact",
    requestId: "committer-install",
    space,
    sessionId: committerSessionId,
    commit: {
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: ALL_ELIDED_ID,
        value: { value: { type: "string", title: "all-elided" } },
      }],
    },
  }));
  assertResponse(shiftMessage(committerMessages));
  await server.flushSessions([space]);
  assertEffect(shiftMessage(committerMessages));

  // The whole commit elides: nothing is written and no document turns
  // dirty, yet the writer parks its promotion on the catch-up marker — the
  // flush must still run and carry it on an otherwise-empty frame.
  await committer.receive(encodeMemoryBoundary({
    type: "transact",
    requestId: "committer-elided",
    space,
    sessionId: committerSessionId,
    commit: {
      localSeq: 2,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: ALL_ELIDED_ID,
        value: { value: { type: "string", title: "all-elided" } },
      }],
    },
  }));
  const verdict = assertResponse<{ elidedOpIndexes?: number[] }>(
    shiftMessage(committerMessages),
  );
  assertEquals(verdict.ok?.elidedOpIndexes, [0]);
  await server.flushSessions([space]);
  const frame = assertEffect(shiftMessage(committerMessages))
    .effect as SessionSync;
  assertEquals(frame.upserts, []);
  assertEquals(frame.caughtUpLocalSeq, 2);
});

Deno.test("memory v2 server: an identical direct re-write fans out nothing", async () => {
  const context = await setup({
    subscriptionRefreshDelayMs: 60_000,
    store: "memory://verdict-catchup-direct-elide",
  });
  const { server, space, committer, committerMessages, committerSessionId } =
    context;
  await server.flushSessions([space]);
  assertEffect(shiftMessage(committerMessages));

  // Watch the content-addressed document itself, so a spurious dirty mark
  // from the direct-write path would be OBSERVED as a re-delivery.
  await committer.receive(encodeMemoryBoundary({
    type: "session.watch.add",
    requestId: "watch-direct-cid",
    space,
    sessionId: committerSessionId,
    watches: [{
      id: "direct-cid",
      kind: "graph",
      query: {
        roots: [{
          id: DIRECT_ELIDE_ID,
          selector: { path: [], schema: false },
        }],
      },
    }],
  }));
  assertResponse(shiftMessage(committerMessages));

  // The install — the blob-upload path — delivers its novelty...
  const installed = await server.writeDocument(space, DIRECT_ELIDE_ID, {
    type: "string",
    title: "direct-elide",
  });
  assertEquals(installed.revisions.length, 1);
  await server.flushSessions([space]);
  const first = assertEffect(shiftMessage(committerMessages))
    .effect as SessionSync;
  assertEquals(first.upserts.map((upsert) => upsert.id), [DIRECT_ELIDE_ID]);

  // ...and the identical re-write is a proven no-op: it marks nothing
  // dirty and schedules nothing, so the watcher hears nothing.
  const reWritten = await server.writeDocument(space, DIRECT_ELIDE_ID, {
    type: "string",
    title: "direct-elide",
  });
  assertEquals(reWritten.elidedOpIndexes, [0]);
  assertEquals(reWritten.revisions, []);
  await server.flushSessions([space]);
  assertEquals(committerMessages.length, 0);
});
