import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { encodeMemoryBoundary, ProtocolError } from "@commonfabric/memory/v2";
import * as Engine from "@commonfabric/memory/v2/engine";
import type {
  AdmittedCommitNotice,
  ServedAclChange,
  ServedRequestCall,
  ServedRequestOutcome,
} from "@commonfabric/memory/v2/server";
import {
  type ServedAppendEntry,
  servedRequestHandler,
  type ServedRequestServer,
} from "../../src/executor/served-requests.ts";

const space = "did:key:served-requests-target";
const otherSpace = "did:key:served-requests-other";
const alice = "did:key:served-requests-alice";
const bob = "did:key:served-requests-bob";
const sessionId = "served-requests-routed-session";

/** A call of `kind` on the routed session into `space`, carrying `body`. */
const callOf = (
  kind: ServedRequestCall["kind"],
  body: ServedRequestCall["body"],
): ServedRequestCall => ({
  kind,
  space,
  principal: "did:key:served-requests-service",
  sessionId,
  body,
});

/** The refusal `outcome` carries, or `undefined` where it carries none. */
const refusalOf = (outcome: ServedRequestOutcome): string | undefined =>
  "refusal" in outcome ? outcome.refusal.message : undefined;

/**
 * A memory server whose engine is `engine`, recording what reaches each verb.
 */
const recordingServer = (
  engine: Engine.Engine,
  verbs: Partial<ServedRequestServer> = {},
) => {
  const appends: Parameters<ServedRequestServer["commitDelegatedAppend"]>[0][] =
    [];
  const engines: string[] = [];
  const notices: AdmittedCommitNotice[] = [];
  const aclChanges: (ServedAclChange & {
    sessionId: string;
    localSeq: number;
  })[] = [];
  const server: ServedRequestServer = {
    commitDelegatedAppend: (entry) => {
      appends.push(entry);
      return Promise.resolve({ seq: 4, deduped: false });
    },
    engineForSpace: (requested) => {
      engines.push(requested);
      return Promise.resolve(engine);
    },
    noteExecutorCommit: (notice) => {
      notices.push(notice);
    },
    commitServedAclChange: (change) => {
      aclChanges.push(change);
      return Promise.resolve({ admitted: true, seq: 9 });
    },
    ...verbs,
  };
  return { server, appends, engines, notices, aclChanges };
};

describe("servedRequestHandler()", () => {
  let engine: Engine.Engine;

  beforeEach(async () => {
    engine = await Engine.open({ url: new URL("memory:served-requests") });
  });

  afterEach(() => {
    Engine.close(engine);
  });

  describe("an append", () => {
    /** An append body every field of which reads. */
    const appendBody = {
      targetStream: "of:served-requests-stream",
      targetStreamLink: { id: "of:served-requests-stream", path: ["events"] },
      eventId: "evt-append",
      payload: { clicked: true },
      actingPrincipal: alice,
      actingSession: "session-alice",
      sessionlessSpaceScope: false,
      capabilityRef: "event-consequence:evt-append",
      localSeq: 3,
    };

    it("commits the entry the body carries into the session's space under the routed session, answering the seq", async () => {
      const { server, appends } = recordingServer(engine);

      const outcome = await servedRequestHandler({ server })(
        callOf("append", appendBody),
      );

      expect(outcome).toEqual({ ok: { deduped: false, seq: 4 } });
      const entry: ServedAppendEntry = appendBody;
      expect(appends).toEqual([{ ...entry, targetSpace: space, sessionId }]);
    });

    it("answers a deduped append with no seq", async () => {
      const { server } = recordingServer(engine, {
        commitDelegatedAppend: () => Promise.resolve({ deduped: true }),
      });

      const outcome = await servedRequestHandler({ server })(
        callOf("append", appendBody),
      );

      expect(outcome).toEqual({ ok: { deduped: true } });
    });

    it("refuses a body with a field that does not read, naming it, and commits nothing", async () => {
      const { server, appends } = recordingServer(engine);
      const handler = servedRequestHandler({ server });
      const unreadable: [string, unknown][] = [
        ["targetStream", 1],
        ["eventId", undefined],
        ["capabilityRef", null],
        ["localSeq", -1],
        ["targetStreamLink", "of:served-requests-stream"],
        ["actingPrincipal", 7],
        ["actingSession", false],
        ["sessionlessSpaceScope", "yes"],
      ];

      for (const [field, value] of unreadable) {
        const outcome = await handler(
          callOf("append", { ...appendBody, [field]: value }),
        );
        expect(refusalOf(outcome)).toBe(
          `The append carries no readable \`${field}\`, so it is refused`,
        );
      }
      expect(appends).toEqual([]);
    });

    it("refuses an append the engine refuses, with the engine's message", async () => {
      const { server } = recordingServer(engine, {
        commitDelegatedAppend: () =>
          Promise.reject(new ProtocolError("the stream is not the target's")),
      });

      const outcome = await servedRequestHandler({ server })(
        callOf("append", appendBody),
      );

      expect(outcome).toEqual({
        refusal: { code: "refused", message: "the stream is not the target's" },
      });
    });

    it("rejects with a failure of the append other than the engine's refusal", async () => {
      const failure = new Error("the store is unreachable");
      const { server } = recordingServer(engine, {
        commitDelegatedAppend: () => Promise.reject(failure),
      });

      const outcome = servedRequestHandler({ server })(
        callOf("append", appendBody),
      );

      await expect(outcome).rejects.toBe(failure);
    });
  });

  describe("a commit", () => {
    /** A foreign batch into `into` that writes one document. */
    const batchInto = (into: string) => ({
      space: into,
      home: false,
      basisSeq: 0,
      rebasedHeads: [],
      operations: [{
        op: "set",
        id: "of:served-requests-doc",
        value: { value: { landed: true } },
      }],
      preconditions: [],
      annotations: [],
      consequenceOf: [],
      basisInstances: [],
    });

    /** The target's genesis access list, naming Alice `OWNER`. */
    const genesis = (): void => {
      Engine.applyCommit(engine, {
        sessionId: "served-requests-genesis",
        space,
        principal: space,
        commit: {
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "set",
            id: `of:${space}`,
            value: { value: { [alice]: "OWNER" } },
          }],
        },
      });
    };

    it("commits the batch into the session's space and reports it to the server as a warm authored commit", async () => {
      genesis();
      const { server, engines, notices } = recordingServer(engine);

      const outcome = await servedRequestHandler({ server })(
        callOf("commit", {
          batch: encodeMemoryBoundary(batchInto(space)),
          localSeq: 5,
        }),
      );

      expect(outcome).toEqual({ ok: { seq: 2 } });
      expect(engines).toEqual([space]);
      expect(Engine.read(engine, { id: "of:served-requests-doc" })?.value)
        .toEqual({ landed: true });
      expect(notices).toEqual([{
        space,
        seq: 2,
        class: "authored",
        sessionId,
        writes: [{ id: "of:served-requests-doc", scopeKey: "space" }],
        warm: true,
      }]);
    });

    it("answers a commit that landed with its seq when reporting it to the server fails", async () => {
      genesis();
      const { server } = recordingServer(engine, {
        noteExecutorCommit: () => {
          throw new Error("the report failed");
        },
      });

      const outcome = await servedRequestHandler({ server })(
        callOf("commit", {
          batch: encodeMemoryBoundary(batchInto(space)),
          localSeq: 5,
        }),
      );

      expect(outcome).toEqual({ ok: { seq: 2 } });
      expect(Engine.read(engine, { id: "of:served-requests-doc" })?.value)
        .toEqual({ landed: true });
    });

    it("refuses a batch the owner's admission refuses, with the admission's message, and reports nothing", async () => {
      const { server, notices } = recordingServer(engine);

      const outcome = await servedRequestHandler({ server })(
        callOf("commit", {
          batch: encodeMemoryBoundary(batchInto(space)),
          localSeq: 5,
        }),
      );

      expect(refusalOf(outcome)).toContain(
        `foreign wave batch into fresh space ${space} refused`,
      );
      expect(Engine.read(engine, { id: "of:served-requests-doc" })).toBeNull();
      expect(notices).toEqual([]);
    });

    it("refuses a body that carries no batch for the session's space, or a home one, before opening the space", async () => {
      const { server, engines } = recordingServer(engine);
      const handler = servedRequestHandler({ server });
      const refusals: [ServedRequestCall["body"], string][] = [
        [
          { batch: 1, localSeq: 5 },
          "The commit carries no readable `batch`, so it is refused",
        ],
        [
          { batch: encodeMemoryBoundary(batchInto(space)), localSeq: "5" },
          "The commit carries no readable `localSeq`, so it is refused",
        ],
        [
          { batch: encodeMemoryBoundary({ space, home: false }), localSeq: 5 },
          "The commit carries no readable `batch`, so it is refused",
        ],
        [
          { batch: encodeMemoryBoundary([batchInto(space)]), localSeq: 5 },
          "The commit carries no batch into the session's space",
        ],
        [
          { batch: encodeMemoryBoundary(batchInto(otherSpace)), localSeq: 5 },
          "The commit carries no batch into the session's space",
        ],
        [
          {
            batch: encodeMemoryBoundary({ ...batchInto(space), home: true }),
            localSeq: 5,
          },
          "The commit carries a home batch, which only the loop of the " +
          "batch's own space commits",
        ],
      ];

      for (const [body, message] of refusals) {
        expect(refusalOf(await handler(callOf("commit", body)))).toBe(message);
      }
      expect(engines).toEqual([]);
    });
  });

  describe("an access-list change", () => {
    /** Alice's change granting Bob `WRITE` in the session's space. */
    const change = {
      space,
      actingPrincipal: alice,
      actingSession: "session-alice",
      capabilityRef: "event-consequence:evt-acl",
      sourceEvent: { space, sidecarId: "of:sidecar", eventId: "evt-acl" },
      changes: [{ principal: bob, level: "WRITE", actor: alice }],
    };

    it("commits the change under the routed session, its function rebuilt from the list, answering the seq", async () => {
      const { server, aclChanges } = recordingServer(engine);

      const outcome = await servedRequestHandler({ server })(
        callOf("acl", { change, localSeq: 6 }),
      );

      expect(outcome).toEqual({ ok: { seq: 9 } });
      expect(aclChanges).toEqual([{
        ...change,
        change: expect.any(Function),
        sessionId,
        localSeq: 6,
      }]);
      expect(aclChanges[0].change({ [alice]: "OWNER" })).toEqual({
        [alice]: "OWNER",
        [bob]: "WRITE",
      });
    });

    it("answers a change that left the list as it was with no seq, and refuses one the server refuses, with its reason", async () => {
      const verdicts = [
        { admitted: true as const },
        { refused: "Bob may not change the list" },
      ];
      const { server } = recordingServer(engine, {
        commitServedAclChange: () => Promise.resolve(verdicts.shift()!),
      });
      const handler = servedRequestHandler({ server });

      expect(await handler(callOf("acl", { change, localSeq: 6 }))).toEqual({
        ok: {},
      });
      expect(await handler(callOf("acl", { change, localSeq: 7 }))).toEqual({
        refusal: { code: "refused", message: "Bob may not change the list" },
      });
    });

    it("refuses a change with a field that does not read, naming it, and commits nothing", async () => {
      const { server, aclChanges } = recordingServer(engine);
      const handler = servedRequestHandler({ server });
      expect(
        refusalOf(await handler(callOf("acl", { change, localSeq: 1.5 }))),
      ).toBe("The acl carries no readable `localSeq`, so it is refused");
      const unreadable: [string, ServedRequestCall["body"][string]][] = [
        ["change", "grant"],
        ["change.space", { ...change, space: 1 }],
        ["change.actingPrincipal", { ...change, actingPrincipal: undefined }],
        ["change.actingSession", { ...change, actingSession: 2 }],
        ["change.capabilityRef", { ...change, capabilityRef: null }],
        ["change.sourceEvent", {
          ...change,
          sourceEvent: { space, sidecarId: "of:sidecar" },
        }],
        ["change.changes", {
          ...change,
          changes: [{ principal: bob, level: "WRITE", actor: bob }],
        }],
      ];

      for (const [field, carried] of unreadable) {
        const outcome = await handler(
          callOf("acl", { change: carried, localSeq: 6 }),
        );
        expect(refusalOf(outcome)).toBe(
          `The acl carries no readable \`${field}\`, so it is refused`,
        );
      }
      expect(aclChanges).toEqual([]);
    });

    it("refuses a change to a space other than the session's, and commits nothing", async () => {
      const { server, aclChanges } = recordingServer(engine);

      const outcome = await servedRequestHandler({ server })(
        callOf("acl", {
          change: { ...change, space: otherSpace },
          localSeq: 6,
        }),
      );

      expect(refusalOf(outcome)).toBe(
        "The acl carries a change to a space other than the session's",
      );
      expect(aclChanges).toEqual([]);
    });
  });
});
