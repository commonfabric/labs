import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import * as Engine from "../v2/engine.ts";
import { Server } from "../v2/server.ts";
import { SessionRegistry } from "../v2/session-registry.ts";
import {
  encodeMemoryBoundary,
  eventAttentionEntryKey,
  eventAttentionIndexKey,
  type EventAttentionIndexValue,
  type EventAttentionResolveRequest,
  getMemoryProtocolFlags,
  type HelloOkMessage,
  MEMORY_PROTOCOL,
  resetServerExecutionConfig,
  type ResponseMessage,
  SERVER_EXECUTION_ATTENTION_DOC_ID,
  setServerExecutionConfig,
  streamEntriesDocId,
  type StreamEventsDocValue,
  type StreamLinkRef,
} from "../v2.ts";

const AUDIENCE = "did:key:z6Mk-event-attention-audience";
const SPACE = "did:key:z6Mk-event-attention-space";
const ALICE = "did:key:z6Mk-event-attention-alice";
const BOB = "did:key:z6Mk-event-attention-bob";
const STREAM = { id: "of:event-attention-result", path: ["submit"] };
const SIDECAR = streamEntriesDocId(STREAM);
const SECOND_STREAM = { id: "of:event-attention-result", path: ["approve"] };
const SECOND_SIDECAR = streamEntriesDocId(SECOND_STREAM);

type Connection = ReturnType<Server["connect"]>;

class InvalidatingSessionRegistry extends SessionRegistry {
  invalidateAfterNextGet = false;

  override get(space: string, sessionId: string) {
    const session = super.get(space, sessionId);
    if (this.invalidateAfterNextGet) {
      this.invalidateAfterNextGet = false;
      this.remove(space, sessionId);
    }
    return session;
  }
}

describe("event attention resolution", () => {
  let server: Server;
  let sessions: InvalidatingSessionRegistry;
  const connections: Connection[] = [];
  let nextSeedLocalSeq = 100;
  const seededAttentionSeqs = new Map<string, number>();

  beforeEach(() => {
    setServerExecutionConfig(true);
    seededAttentionSeqs.clear();
    sessions = new InvalidatingSessionRegistry();
    server = new Server({
      store: new URL(`memory://event-attention-${crypto.randomUUID()}`),
      subscriptionRefreshDelayMs: 0,
      authorizeSessionOpen(message) {
        const issuer = message.invocation?.iss;
        return typeof issuer === "string" ? issuer : undefined;
      },
      sessionOpenAuth: { audience: AUDIENCE },
      sessions,
    });
  });

  afterEach(async () => {
    for (const connection of connections.splice(0)) connection.close();
    await server.close();
    resetServerExecutionConfig();
  });

  const openSession = async (principal: string): Promise<string> => {
    const messages: unknown[] = [];
    const connection = server.connect((message) => messages.push(message));
    connections.push(connection);
    await connection.receive(encodeMemoryBoundary({
      type: "hello",
      protocol: MEMORY_PROTOCOL,
      flags: getMemoryProtocolFlags(),
    }));
    const hello = messages.shift() as HelloOkMessage;
    expect(hello.type).toBe("hello.ok");
    await connection.receive(encodeMemoryBoundary({
      type: "session.open",
      requestId: crypto.randomUUID(),
      space: SPACE,
      session: {},
      invocation: {
        iss: principal,
        aud: hello.sessionOpen!.audience,
        challenge: hello.sessionOpen!.challenge.value,
      },
    }));
    const response = messages.shift() as ResponseMessage<{
      sessionId: string;
    }>;
    expect(response.error).toBeUndefined();
    return response.ok!.sessionId;
  };

  const seedAttention = async (
    sessionId: string,
    principal: string,
    eventId: string,
    stream: StreamLinkRef = STREAM,
    legacySeqless = false,
    userless = false,
  ): Promise<number> => {
    const engine = await server.engineForSpace(SPACE);
    const sidecarId = streamEntriesDocId(stream);
    Engine.applyCommit(engine, {
      space: SPACE,
      sessionId,
      principal,
      commitClass: "authored",
      commit: {
        localSeq: nextSeedLocalSeq++,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "patch",
          id: sidecarId,
          patches: [{
            op: "append",
            path: "/value/entries",
            values: [{
              eventId,
              stream,
              payload: { answer: "captured", nested: [1, 2] },
              runtimeInjectedEventKeys: ["detail"],
              rendererTrusted: true,
            }],
          }],
        }],
        eventAppends: [{ id: sidecarId, eventId }],
      },
    });
    const value = Engine.read(engine, { id: sidecarId })!
      .value as StreamEventsDocValue;
    const entry = value.entries!.at(-1)!;
    const stampedSeq = entry.seq!;
    if (userless) {
      Engine.applyCommit(engine, {
        space: SPACE,
        sessionId,
        principal,
        commitClass: "system",
        commit: {
          localSeq: nextSeedLocalSeq++,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "patch",
            id: sidecarId,
            patches: [{
              op: "remove",
              path: `/value/entries/${
                value.entries!.indexOf(entry)
              }/firedAt/user`,
            }, {
              op: "replace",
              path: `/value/entries/${
                value.entries!.indexOf(entry)
              }/firedAt/session`,
              value: "server",
            }],
          }],
        },
      });
    }
    if (legacySeqless) {
      Engine.applyCommit(engine, {
        space: SPACE,
        sessionId,
        principal,
        commitClass: "system",
        commit: {
          localSeq: nextSeedLocalSeq++,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "patch",
            id: sidecarId,
            patches: [{
              op: "remove",
              path: `/value/entries/${value.entries!.indexOf(entry)}/seq`,
            }],
          }],
        },
      });
    }
    const seq = legacySeqless ? 0 : stampedSeq;
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
    const currentIndex = Engine.read(engine, {
      id: SERVER_EXECUTION_ATTENTION_DOC_ID,
    })?.value as EventAttentionIndexValue | undefined;
    const sidecarKey = eventAttentionIndexKey(sidecarId);
    const entryKey = eventAttentionEntryKey(eventId, seq);
    Engine.applyCommit(engine, {
      space: SPACE,
      sessionId,
      principal,
      commitClass: "system",
      commit: {
        localSeq: nextSeedLocalSeq++,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "patch",
          id: sidecarId,
          patches: [
            {
              op: "add",
              path: `/value/entries/${
                value.entries!.indexOf(entry)
              }/consequenced`,
              value: true,
            },
            {
              op: "add",
              path: `/value/entries/${value.entries!.indexOf(entry)}/status`,
              value: "needs-attention",
            },
            {
              op: "add",
              path: `/value/entries/${value.entries!.indexOf(entry)}/reason`,
              value: "This event could not be delivered.",
            },
            {
              op: "add",
              path: `/value/entries/${value.entries!.indexOf(entry)}/attention`,
              value: attention,
            },
            {
              op: "add",
              path: "/value/eventWatermark",
              value: seq,
            },
          ],
        }, {
          op: "set",
          id: SERVER_EXECUTION_ATTENTION_DOC_ID,
          value: {
            value: {
              entries: {
                ...(currentIndex?.entries ?? {}),
                [sidecarKey]: {
                  ...(currentIndex?.entries?.[sidecarKey] ?? {}),
                  [entryKey]: {
                    eventId,
                    seq,
                    sidecarId,
                    phase: attention.phase,
                    failureClass: attention.failureClass,
                    code: attention.code,
                    firstFailureAt: attention.firstFailureAt,
                  },
                },
              },
            },
          },
        }],
      },
    });
    seededAttentionSeqs.set(JSON.stringify([sidecarId, eventId]), seq);
    return seq;
  };

  const resolveAttention = (
    request: Omit<EventAttentionResolveRequest, "seq"> & { seq?: number },
  ) => {
    const seq = request.seq ?? seededAttentionSeqs.get(
      JSON.stringify([request.sidecarId, request.eventId]),
    );
    if (seq === undefined) throw new Error("missing seeded attention seq");
    return server.resolveEventAttention({ ...request, seq });
  };

  const seedConsumedEvent = async (
    sessionId: string,
    principal: string,
    eventId: string,
  ): Promise<number> => {
    const engine = await server.engineForSpace(SPACE);
    Engine.applyCommit(engine, {
      space: SPACE,
      sessionId,
      principal,
      commitClass: "authored",
      commit: {
        localSeq: nextSeedLocalSeq++,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "patch",
          id: SIDECAR,
          patches: [{
            op: "append",
            path: "/value/entries",
            values: [{ eventId, stream: STREAM }],
          }],
        }],
        eventAppends: [{ id: SIDECAR, eventId }],
      },
    });
    const value = Engine.read(engine, { id: SIDECAR })!
      .value as StreamEventsDocValue;
    const entryIndex = value.entries!.length - 1;
    const seq = value.entries![entryIndex].seq!;
    Engine.applyCommit(engine, {
      space: SPACE,
      sessionId: "server-test-consumer",
      principal,
      commitClass: "system",
      commit: {
        localSeq: nextSeedLocalSeq++,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "patch",
          id: SIDECAR,
          patches: [{
            op: "add",
            path: `/value/entries/${entryIndex}/consequenced`,
            value: true,
          }, {
            op: "add",
            path: "/value/eventWatermark",
            value: seq,
          }],
        }],
      },
    });
    return seq;
  };

  const compactAttentionEntry = async (
    principal: string,
    eventId: string,
    seq: number,
    sidecarId = SIDECAR,
  ): Promise<void> => {
    const engine = await server.engineForSpace(SPACE);
    const current = Engine.read(engine, { id: sidecarId })!
      .value as StreamEventsDocValue;
    const entryIndex =
      current.entries?.findIndex((entry) =>
        entry.eventId === eventId && entry.seq === seq
      ) ?? -1;
    if (entryIndex < 0) throw new Error("missing compacted attention entry");
    Engine.applyCommit(engine, {
      space: SPACE,
      sessionId: "server-test-compactor",
      principal,
      commitClass: "system",
      commit: {
        localSeq: nextSeedLocalSeq++,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "patch",
          id: sidecarId,
          patches: [{ op: "remove", path: `/value/entries/${entryIndex}` }],
        }],
      },
    });
  };

  it("Retry atomically resolves the original and appends one exact-provenance successor", async () => {
    const sessionId = await openSession(ALICE);
    await seedAttention(sessionId, ALICE, "evt-original");

    const first = await resolveAttention({
      type: "event.attention.resolve",
      requestId: "retry-1",
      space: SPACE,
      sessionId,
      eventId: "evt-original",
      sidecarId: SIDECAR,
      action: "retry",
    });
    expect(first.error).toBeUndefined();
    expect(first.ok!.resolution.kind).toBe("retried");
    const retryId = (first.ok!.resolution as {
      kind: "retried";
      eventId: string;
    }).eventId;

    const engine = await server.engineForSpace(SPACE);
    const entries = (Engine.read(engine, { id: SIDECAR })!
      .value as StreamEventsDocValue).entries!;
    expect(entries).toHaveLength(2);
    const original = entries.find((entry) => entry.eventId === "evt-original")!;
    const retry = entries.find((entry) => entry.eventId === retryId)!;
    expect(original.resolution).toEqual({ kind: "retried", eventId: retryId });
    expect(retry.payload).toEqual(original.payload);
    expect(retry.runtimeInjectedEventKeys).toEqual(
      original.runtimeInjectedEventKeys,
    );
    expect(retry.rendererTrusted).toBe(true);
    expect(retry.retryOf).toBe(original.eventId);
    expect(retry.firedAt).toEqual({ user: ALICE, session: sessionId });
    expect(retry.seq).toBeGreaterThan(original.seq!);
    const indexAfterRetry = Engine.read(engine, {
      id: SERVER_EXECUTION_ATTENTION_DOC_ID,
    })?.value as EventAttentionIndexValue;
    expect(indexAfterRetry.entries).toEqual({});
    expect(
      indexAfterRetry.resolutions?.[eventAttentionIndexKey(SIDECAR)]?.[
        eventAttentionEntryKey(original.eventId, original.seq!)
      ]?.resolution,
    ).toEqual(original.resolution);

    const replay = await resolveAttention({
      type: "event.attention.resolve",
      requestId: "retry-lost-response",
      space: SPACE,
      sessionId,
      eventId: "evt-original",
      sidecarId: SIDECAR,
      action: "retry",
    });
    expect(replay.ok!.resolution).toEqual(first.ok!.resolution);
    expect(
      (Engine.read(engine, { id: SIDECAR })!.value as StreamEventsDocValue)
        .entries,
    ).toHaveLength(2);

    await compactAttentionEntry(ALICE, original.eventId, original.seq!);
    const replayAfterCompaction = await resolveAttention({
      type: "event.attention.resolve",
      requestId: "retry-after-compaction",
      space: SPACE,
      sessionId,
      eventId: original.eventId,
      seq: original.seq,
      sidecarId: SIDECAR,
      action: "dismiss",
    });
    expect(replayAfterCompaction.ok!.resolution).toEqual(first.ok!.resolution);
    expect(
      (Engine.read(engine, { id: SIDECAR })!.value as StreamEventsDocValue)
        .entries,
    ).toHaveLength(1);

    const bobSession = await openSession(BOB);
    const crossUserReplay = await resolveAttention({
      type: "event.attention.resolve",
      requestId: "retry-cross-user-replay",
      space: SPACE,
      sessionId: bobSession,
      eventId: "evt-original",
      sidecarId: SIDECAR,
      action: "retry",
    });
    expect(crossUserReplay.error?.name).toBe("AuthorizationError");
  });

  it("Dismiss records resolution without an append", async () => {
    const sessionId = await openSession(ALICE);
    const seq = await seedAttention(sessionId, ALICE, "evt-dismiss");
    const response = await resolveAttention({
      type: "event.attention.resolve",
      requestId: "dismiss",
      space: SPACE,
      sessionId,
      eventId: "evt-dismiss",
      sidecarId: SIDECAR,
      action: "dismiss",
    });
    expect(response.ok!.resolution).toEqual({ kind: "dismissed" });
    const engine = await server.engineForSpace(SPACE);
    const entries = (Engine.read(engine, { id: SIDECAR })!
      .value as StreamEventsDocValue).entries!;
    expect(entries).toHaveLength(1);
    expect(entries[0].resolution).toEqual({ kind: "dismissed" });

    await compactAttentionEntry(ALICE, "evt-dismiss", seq);
    const replay = await resolveAttention({
      type: "event.attention.resolve",
      requestId: "dismiss-after-compaction",
      space: SPACE,
      sessionId,
      eventId: "evt-dismiss",
      seq,
      sidecarId: SIDECAR,
      action: "retry",
    });
    expect(replay.ok!.resolution).toEqual({ kind: "dismissed" });
    expect(
      (Engine.read(engine, { id: SIDECAR })!.value as StreamEventsDocValue)
        .entries,
    ).toEqual([]);
  });

  it("allows a writer to dismiss a userless event but never retry it", async () => {
    const sessionId = await openSession(ALICE);
    await seedAttention(
      sessionId,
      ALICE,
      "evt-userless",
      STREAM,
      false,
      true,
    );

    const retry = await resolveAttention({
      type: "event.attention.resolve",
      requestId: "retry-userless",
      space: SPACE,
      sessionId,
      eventId: "evt-userless",
      sidecarId: SIDECAR,
      action: "retry",
    });
    expect(retry.error?.name).toBe("AuthorizationError");

    const dismiss = await resolveAttention({
      type: "event.attention.resolve",
      requestId: "dismiss-userless",
      space: SPACE,
      sessionId,
      eventId: "evt-userless",
      sidecarId: SIDECAR,
      action: "dismiss",
    });
    expect(dismiss.error).toBeUndefined();
    expect(dismiss.ok?.resolution).toEqual({ kind: "dismissed" });
  });

  it("resolves a legacy seq-less entry through its sequence-zero identity", async () => {
    const sessionId = await openSession(ALICE);
    const eventId = "evt-legacy-seqless";
    await seedAttention(sessionId, ALICE, eventId, STREAM, true);
    const engine = await server.engineForSpace(SPACE);

    const response = await resolveAttention({
      type: "event.attention.resolve",
      requestId: "dismiss-legacy-seqless",
      space: SPACE,
      sessionId,
      eventId,
      seq: 0,
      sidecarId: SIDECAR,
      action: "dismiss",
    });

    expect(response.error).toBeUndefined();
    expect(response.ok!.resolution).toEqual({ kind: "dismissed" });
    const entry = (Engine.read(engine, { id: SIDECAR })!
      .value as StreamEventsDocValue).entries![0];
    expect(entry.seq).toBeUndefined();
    expect(entry.resolution).toEqual({ kind: "dismissed" });
  });

  it("routes attention resolution through the session protocol", async () => {
    const messages: unknown[] = [];
    const connection = server.connect((message) => messages.push(message));
    connections.push(connection);
    await connection.receive(encodeMemoryBoundary({
      type: "hello",
      protocol: MEMORY_PROTOCOL,
      flags: getMemoryProtocolFlags(),
    }));
    const hello = messages.shift() as HelloOkMessage;
    await connection.receive(encodeMemoryBoundary({
      type: "session.open",
      requestId: "protocol-session",
      space: SPACE,
      session: {},
      invocation: {
        iss: ALICE,
        aud: hello.sessionOpen!.audience,
        challenge: hello.sessionOpen!.challenge.value,
      },
    }));
    const opened = messages.shift() as ResponseMessage<{ sessionId: string }>;
    const sessionId = opened.ok!.sessionId;
    const seq = await seedAttention(
      sessionId,
      ALICE,
      "evt-protocol-dismiss",
    );

    await connection.receive(encodeMemoryBoundary({
      type: "event.attention.resolve",
      requestId: "protocol-dismiss",
      space: SPACE,
      sessionId,
      eventId: "evt-protocol-dismiss",
      seq,
      sidecarId: SIDECAR,
      action: "dismiss",
    }));

    const response = messages.shift() as ResponseMessage<{
      resolution: { kind: "dismissed" };
    }>;
    expect(response.ok?.resolution).toEqual({ kind: "dismissed" });

    sessions.remove(SPACE, sessionId);
    await connection.receive(encodeMemoryBoundary({
      type: "event.attention.resolve",
      requestId: "protocol-missing-session",
      space: SPACE,
      sessionId,
      eventId: "evt-protocol-dismiss",
      seq,
      sidecarId: SIDECAR,
      action: "dismiss",
    }));
    const missing = messages.shift() as ResponseMessage<never>;
    expect(missing.error?.name).toBe("SessionError");
  });

  it("overlapping Retry and Dismiss requests return one recorded resolution", async () => {
    const sessionId = await openSession(ALICE);
    await seedAttention(sessionId, ALICE, "evt-retry-race");
    const retryRequest = {
      type: "event.attention.resolve" as const,
      space: SPACE,
      sessionId,
      eventId: "evt-retry-race",
      sidecarId: SIDECAR,
      action: "retry" as const,
    };
    const [retryA, retryB] = await Promise.all([
      resolveAttention({
        ...retryRequest,
        requestId: "retry-race-a",
      }),
      resolveAttention({
        ...retryRequest,
        requestId: "retry-race-b",
      }),
    ]);
    expect(retryA.error).toBeUndefined();
    expect(retryB.error).toBeUndefined();
    expect(retryA.ok!.resolution).toEqual(retryB.ok!.resolution);
    const raceEngine = await server.engineForSpace(SPACE);
    const retryRaceEntries = (Engine.read(raceEngine, { id: SIDECAR })!
      .value as StreamEventsDocValue).entries!;
    expect(
      retryRaceEntries.filter((entry) => entry.retryOf === "evt-retry-race"),
    ).toHaveLength(1);

    await seedAttention(sessionId, ALICE, "evt-race");
    const request = {
      type: "event.attention.resolve" as const,
      space: SPACE,
      sessionId,
      eventId: "evt-race",
      sidecarId: SIDECAR,
    };
    const [retry, dismiss] = await Promise.all([
      resolveAttention({
        ...request,
        requestId: "race-retry",
        action: "retry",
      }),
      resolveAttention({
        ...request,
        requestId: "race-dismiss",
        action: "dismiss",
      }),
    ]);

    expect(retry.error).toBeUndefined();
    expect(dismiss.error).toBeUndefined();
    expect(retry.ok!.resolution).toEqual(dismiss.ok!.resolution);

    const engine = await server.engineForSpace(SPACE);
    const entries = (Engine.read(engine, { id: SIDECAR })!
      .value as StreamEventsDocValue).entries!;
    const original = entries.find((entry) => entry.eventId === "evt-race")!;
    expect(original.resolution).toEqual(retry.ok!.resolution);
    const retryEntries = entries.filter((entry) =>
      entry.retryOf === original.eventId
    );
    expect(retryEntries.length).toBe(
      original.resolution?.kind === "retried" ? 1 : 0,
    );
    const indexAfterRace = Engine.read(engine, {
      id: SERVER_EXECUTION_ATTENTION_DOC_ID,
    })?.value as EventAttentionIndexValue;
    expect(indexAfterRace.entries).toEqual({});
  });

  it("keeps equal event IDs from different streams independently resolvable", async () => {
    const sessionId = await openSession(ALICE);
    const firstSeq = await seedAttention(sessionId, ALICE, "evt-shared");
    const secondSeq = await seedAttention(
      sessionId,
      ALICE,
      "evt-shared",
      SECOND_STREAM,
    );

    const engine = await server.engineForSpace(SPACE);
    const before = Engine.read(engine, {
      id: SERVER_EXECUTION_ATTENTION_DOC_ID,
    })?.value as EventAttentionIndexValue;
    const firstEntryKey = eventAttentionEntryKey("evt-shared", firstSeq);
    const secondEntryKey = eventAttentionEntryKey("evt-shared", secondSeq);
    expect(
      before.entries?.[eventAttentionIndexKey(SIDECAR)]?.[firstEntryKey]
        ?.sidecarId,
    ).toBe(SIDECAR);
    expect(
      before.entries?.[eventAttentionIndexKey(SECOND_SIDECAR)]?.[secondEntryKey]
        ?.sidecarId,
    ).toBe(SECOND_SIDECAR);

    const first = await resolveAttention({
      type: "event.attention.resolve",
      requestId: "same-id-first",
      space: SPACE,
      sessionId,
      eventId: "evt-shared",
      seq: firstSeq,
      sidecarId: SIDECAR,
      action: "dismiss",
    });
    expect(first.error).toBeUndefined();
    const afterFirst = Engine.read(engine, {
      id: SERVER_EXECUTION_ATTENTION_DOC_ID,
    })?.value as EventAttentionIndexValue;
    expect(
      afterFirst.entries?.[eventAttentionIndexKey(SIDECAR)],
    ).toBeUndefined();
    expect(
      afterFirst.entries?.[eventAttentionIndexKey(SECOND_SIDECAR)]?.[
        secondEntryKey
      ]?.sidecarId,
    ).toBe(SECOND_SIDECAR);

    const second = await resolveAttention({
      type: "event.attention.resolve",
      requestId: "same-id-second",
      space: SPACE,
      sessionId,
      eventId: "evt-shared",
      seq: secondSeq,
      sidecarId: SECOND_SIDECAR,
      action: "dismiss",
    });
    expect(second.error).toBeUndefined();
    const indexAfterBoth = Engine.read(engine, {
      id: SERVER_EXECUTION_ATTENTION_DOC_ID,
    })?.value as EventAttentionIndexValue;
    expect(indexAfterBoth.entries).toEqual({});
  });

  it("resolves a newer attention entry past an older consumed equal-ID entry", async () => {
    const sessionId = await openSession(ALICE);
    const consumedSeq = await seedConsumedEvent(
      sessionId,
      ALICE,
      "evt-repeated-consumed",
    );
    const attentionSeq = await seedAttention(
      sessionId,
      ALICE,
      "evt-repeated-consumed",
    );
    expect(attentionSeq).toBeGreaterThan(consumedSeq);

    const response = await resolveAttention({
      type: "event.attention.resolve",
      requestId: "repeated-after-consumed",
      space: SPACE,
      sessionId,
      eventId: "evt-repeated-consumed",
      seq: attentionSeq,
      sidecarId: SIDECAR,
      action: "dismiss",
    });

    expect(response.error).toBeUndefined();
    const engine = await server.engineForSpace(SPACE);
    const entries = (Engine.read(engine, { id: SIDECAR })!
      .value as StreamEventsDocValue).entries!;
    expect(entries.find((entry) => entry.seq === consumedSeq)).toMatchObject({
      eventId: "evt-repeated-consumed",
      consequenced: true,
    });
    expect(
      entries.find((entry) => entry.seq === attentionSeq)?.resolution,
    ).toEqual({ kind: "dismissed" });
  });

  it("keeps repeated event IDs in one stream independently resolvable by seq", async () => {
    const sessionId = await openSession(ALICE);
    const firstSeq = await seedAttention(sessionId, ALICE, "evt-repeated");
    const secondSeq = await seedAttention(sessionId, ALICE, "evt-repeated");
    expect(secondSeq).toBeGreaterThan(firstSeq);

    const first = await resolveAttention({
      type: "event.attention.resolve",
      requestId: "repeated-first",
      space: SPACE,
      sessionId,
      eventId: "evt-repeated",
      seq: firstSeq,
      sidecarId: SIDECAR,
      action: "dismiss",
    });
    expect(first.error).toBeUndefined();

    const engine = await server.engineForSpace(SPACE);
    const afterFirst = Engine.read(engine, {
      id: SERVER_EXECUTION_ATTENTION_DOC_ID,
    })?.value as EventAttentionIndexValue;
    const sidecarEntries = afterFirst.entries?.[
      eventAttentionIndexKey(SIDECAR)
    ];
    expect(
      sidecarEntries?.[eventAttentionEntryKey("evt-repeated", firstSeq)],
    ).toBeUndefined();
    expect(
      sidecarEntries?.[eventAttentionEntryKey("evt-repeated", secondSeq)]?.seq,
    ).toBe(secondSeq);

    const second = await resolveAttention({
      type: "event.attention.resolve",
      requestId: "repeated-second",
      space: SPACE,
      sessionId,
      eventId: "evt-repeated",
      seq: secondSeq,
      sidecarId: SIDECAR,
      action: "dismiss",
    });
    expect(second.error).toBeUndefined();
    const afterSecondEntries = (Engine.read(engine, { id: SIDECAR })!
      .value as StreamEventsDocValue).entries!;
    expect(
      afterSecondEntries.find((entry) => entry.seq === firstSeq)?.resolution,
    ).toEqual({ kind: "dismissed" });
    expect(
      afterSecondEntries.find((entry) => entry.seq === secondSeq)?.resolution,
    ).toEqual({ kind: "dismissed" });
    const afterSecondIndex = Engine.read(engine, {
      id: SERVER_EXECUTION_ATTENTION_DOC_ID,
    })?.value as EventAttentionIndexValue;
    expect(afterSecondIndex.entries).toEqual({});
  });

  it("removes one event summary without hiding another event in its stream", async () => {
    const sessionId = await openSession(ALICE);
    const firstSeq = await seedAttention(sessionId, ALICE, "evt-first");
    const secondSeq = await seedAttention(sessionId, ALICE, "evt-second");

    const first = await resolveAttention({
      type: "event.attention.resolve",
      requestId: "same-stream-first",
      space: SPACE,
      sessionId,
      eventId: "evt-first",
      seq: firstSeq,
      sidecarId: SIDECAR,
      action: "dismiss",
    });
    expect(first.error).toBeUndefined();
    const engine = await server.engineForSpace(SPACE);
    const afterFirst = Engine.read(engine, {
      id: SERVER_EXECUTION_ATTENTION_DOC_ID,
    })?.value as EventAttentionIndexValue;
    const summaries = afterFirst.entries?.[eventAttentionIndexKey(SIDECAR)];
    expect(
      summaries?.[eventAttentionEntryKey("evt-first", firstSeq)],
    ).toBeUndefined();
    expect(
      summaries?.[eventAttentionEntryKey("evt-second", secondSeq)]?.eventId,
    ).toBe(
      "evt-second",
    );

    const second = await resolveAttention({
      type: "event.attention.resolve",
      requestId: "same-stream-second",
      space: SPACE,
      sessionId,
      eventId: "evt-second",
      seq: secondSeq,
      sidecarId: SIDECAR,
      action: "dismiss",
    });
    expect(second.error).toBeUndefined();
  });

  it("resolves an event whose identifier names an object prototype key", async () => {
    const sessionId = await openSession(ALICE);
    await seedAttention(sessionId, ALICE, "__proto__");

    const response = await resolveAttention({
      type: "event.attention.resolve",
      requestId: "prototype-key",
      space: SPACE,
      sessionId,
      eventId: "__proto__",
      sidecarId: SIDECAR,
      action: "dismiss",
    });

    expect(response.error).toBeUndefined();
    const engine = await server.engineForSpace(SPACE);
    const indexAfterPrototype = Engine.read(engine, {
      id: SERVER_EXECUTION_ATTENTION_DOC_ID,
    })?.value as EventAttentionIndexValue;
    expect(indexAfterPrototype.entries).toEqual({});
  });

  it("resolution is restricted to the original acting user and a live session", async () => {
    const aliceSession = await openSession(ALICE);
    const bobSession = await openSession(BOB);
    await seedAttention(aliceSession, ALICE, "evt-owned");

    const crossUser = await resolveAttention({
      type: "event.attention.resolve",
      requestId: "cross-user",
      space: SPACE,
      sessionId: bobSession,
      eventId: "evt-owned",
      sidecarId: SIDECAR,
      action: "retry",
    });
    expect(crossUser.error?.name).toBe("AuthorizationError");

    const engine = await server.engineForSpace(SPACE);
    Engine.applyCommit(engine, {
      space: SPACE,
      sessionId: "server-test-acl",
      principal: ALICE,
      commitClass: "system",
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: `of:${SPACE}`,
          value: { value: { [ALICE]: "OWNER", [BOB]: "READ" } },
        }],
      },
    });
    server.options.acl = { mode: "enforce" };
    const aclDenied = await resolveAttention({
      type: "event.attention.resolve",
      requestId: "acl-denied",
      space: SPACE,
      sessionId: bobSession,
      eventId: "evt-owned",
      sidecarId: SIDECAR,
      action: "dismiss",
    });
    expect(aclDenied.error).toMatchObject({
      name: "AuthorizationError",
      permanentEvidence: true,
    });

    const sessionless = await resolveAttention({
      type: "event.attention.resolve",
      requestId: "sessionless",
      space: SPACE,
      sessionId: "missing-session",
      eventId: "evt-owned",
      sidecarId: SIDECAR,
      action: "retry",
    });
    expect(sessionless.error?.name).toBe("SessionError");
    const entries = (Engine.read(engine, { id: SIDECAR })!
      .value as StreamEventsDocValue).entries!;
    expect(entries).toHaveLength(1);
    expect(entries[0].resolution).toBeUndefined();
  });

  it("fails closed when the session is replaced while the engine opens", async () => {
    const sessionId = await openSession(ALICE);
    await seedAttention(sessionId, ALICE, "evt-replaced-session");
    sessions.invalidateAfterNextGet = true;

    const response = await resolveAttention({
      type: "event.attention.resolve",
      requestId: "replaced-session",
      space: SPACE,
      sessionId,
      eventId: "evt-replaced-session",
      sidecarId: SIDECAR,
      action: "dismiss",
    });

    expect(response.error?.name).toBe("SessionError");
    expect(response.error?.message).toContain("replaced");
  });

  it("returns protocol errors for missing authoritative and discovery state", async () => {
    const sessionId = await openSession(ALICE);
    const missingCover = await resolveAttention({
      type: "event.attention.resolve",
      requestId: "missing-cover",
      space: SPACE,
      sessionId,
      eventId: "evt-missing",
      seq: 1,
      sidecarId: SIDECAR,
      action: "dismiss",
    });
    expect(missingCover.error?.name).toBe("ProtocolError");
    expect(missingCover.error?.message).toContain(
      "no authoritative attention cover",
    );

    await seedAttention(sessionId, ALICE, "evt-missing-index");
    const engine = await server.engineForSpace(SPACE);
    Engine.applyCommit(engine, {
      space: SPACE,
      sessionId: "server-test-remove-index",
      principal: ALICE,
      commitClass: "system",
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: SERVER_EXECUTION_ATTENTION_DOC_ID,
          value: { value: { entries: {} } },
        }],
      },
    });
    const missingIndex = await resolveAttention({
      type: "event.attention.resolve",
      requestId: "missing-index",
      space: SPACE,
      sessionId,
      eventId: "evt-missing-index",
      sidecarId: SIDECAR,
      action: "dismiss",
    });
    expect(missingIndex.error?.name).toBe("ProtocolError");
    expect(missingIndex.error?.message).toContain(
      "no unresolved attention notice",
    );
  });
});
