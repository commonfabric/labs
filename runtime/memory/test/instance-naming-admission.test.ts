/**
 * The memory server's instance-naming boundary (INV-16,
 * `docs/specs/memory-v2/09-invariants.md`), exercised over the session
 * protocol: the `instanceNames` declaration a `session.open` carries, the mark
 * the first commit from a declaring session records in the space's store,
 * the opens and commits a marked space refuses, the posture that decides
 * whether an unmarked space admits a declaring session, and the revocation
 * of a space's positional sessions when a commit marks it.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import type { FabricValue } from "@commonfabric/api";

import * as Engine from "../v2/engine.ts";
import { Server } from "../v2/server.ts";
import {
  encodeMemoryBoundary,
  getMemoryProtocolFlags,
  type HelloOkMessage,
  MEMORY_PROTOCOL,
  parseMemoryProtocolFlags,
  type ResponseMessage,
  type ServerMessage,
  type SessionDescriptor,
  type SessionOpenAuthMetadata,
  type SessionOpenResult,
} from "../v2.ts";

const HELLO = {
  type: "hello",
  protocol: MEMORY_PROTOCOL,
  flags: getMemoryProtocolFlags(),
} as const;

const ALICE = "did:key:z6Mk-naming-alice";
const BOB = "did:key:z6Mk-naming-bob";
const TEST_AUDIENCE = "did:key:z6Mk-naming-test-audience";

const NAMING: SessionDescriptor = { instanceNames: true };

const markedMessage = (space: string): string =>
  `Space ${space} holds data written with instance names, which this ` +
  "runtime does not use";

const postureMessage = (space: string): string =>
  `The server of space ${space} does not name instances, and this runtime ` +
  "does";

type Harness = {
  messages: ServerMessage[];
  connection: ReturnType<Server["connect"]>;
  sessionOpen: SessionOpenAuthMetadata;
};

let requestCounter = 0;
const nextRequestId = (label: string): string => `${label}-${++requestCounter}`;

/**
 * A server whose session principal is taken (untested-crypto, test-only) from
 * `invocation.iss`, under the ACL `mode`, given `namesInstances` as its
 * posture when it is not `undefined`.
 */
const createServer = (
  label: string,
  mode: "off" | "enforce",
  namesInstances?: () => boolean,
): Server =>
  new Server({
    store: new URL(`memory://instance-naming-${label.replaceAll(" ", "-")}`),
    subscriptionRefreshDelayMs: "manual",
    authorizeSessionOpen: (message) => {
      const iss = message.invocation?.iss;
      return typeof iss === "string" ? iss : undefined;
    },
    sessionOpenAuth: { audience: TEST_AUDIENCE },
    acl: { mode },
    ...(namesInstances === undefined ? {} : { namesInstances }),
  });

/** A connection to `server` past its `hello`. */
const connect = async (server: Server): Promise<Harness> => {
  const messages: ServerMessage[] = [];
  const connection = server.connect((message) => messages.push(message));
  await connection.receive(encodeMemoryBoundary(HELLO));
  const hello = messages.shift() as HelloOkMessage;
  expect(hello.type).toBe("hello.ok");
  if (hello.sessionOpen === undefined) throw new Error("Expected sessionOpen");
  return { messages, connection, sessionOpen: hello.sessionOpen };
};

/**
 * The next response `harness` received, past the frames the manual fan-out
 * leaves out and any `session/revoked`, which a test reads from the list
 * itself.
 */
const nextResponse = <Result>(
  { messages }: Pick<Harness, "messages">,
): ResponseMessage<Result> => {
  const index = messages.findIndex((message) => message.type === "response");
  if (index < 0) throw new Error("Expected a response");
  return messages.splice(index, 1)[0] as ResponseMessage<Result>;
};

/**
 * Opens a session on `space` as `principal`, declaring `session`. An open
 * spends the connection's challenge, and an admitted one carries the next.
 */
const openSession = async (
  harness: Harness,
  space: string,
  principal: string,
  session: SessionDescriptor = {},
): Promise<ResponseMessage<SessionOpenResult>> => {
  await harness.connection.receive(encodeMemoryBoundary({
    type: "session.open",
    requestId: nextRequestId("open"),
    space,
    session,
    invocation: {
      iss: principal,
      aud: harness.sessionOpen.audience,
      challenge: harness.sessionOpen.challenge.value,
    },
  }));
  const response = nextResponse<SessionOpenResult>(harness);
  if (response.ok !== undefined) harness.sessionOpen = response.ok.sessionOpen;
  return response;
};

/** Opens a session on `space` as `principal`, and returns its id. */
const openedSession = async (
  harness: Harness,
  space: string,
  principal: string,
  session: SessionDescriptor = {},
): Promise<string> => {
  const opened = await openSession(harness, space, principal, session);
  if (opened.ok === undefined) {
    throw new Error(`Expected the open to succeed: ${opened.error?.message}`);
  }
  return opened.ok.sessionId;
};

/** Commits one `set` of `id` to `value` as the session `sessionId`. */
const transactSet = async (
  harness: Harness,
  space: string,
  sessionId: string,
  id: string,
  value: FabricValue,
  localSeq: number,
): Promise<ResponseMessage<{ seq: number }>> => {
  await harness.connection.receive(encodeMemoryBoundary({
    type: "transact",
    requestId: nextRequestId("tx"),
    space,
    sessionId,
    commit: {
      localSeq,
      reads: { confirmed: [], pending: [] },
      operations: [{ op: "set", id, value: { value } }],
    },
  }));
  return nextResponse<{ seq: number }>(harness);
};

/**
 * The seq of the commit the mark in `space`'s store names, or `undefined`
 * for an unmarked store.
 */
const markedAt = async (
  server: Server,
  space: string,
): Promise<number | undefined> =>
  (await server.engineForSpace(space)).database.prepare(
    "SELECT commit_seq FROM instance_name_mark",
  ).get<{ commit_seq: number }>()?.commit_seq;

/**
 * Records the mark in `space`'s store as set by its newest commit, without
 * the server, as a copied store or another writer to it leaves the mark: no
 * session this server holds is revoked for it.
 */
const markInStore = async (server: Server, space: string): Promise<void> => {
  const engine = await server.engineForSpace(space);
  engine.database.prepare(
    "INSERT INTO instance_name_mark (singleton, commit_seq) VALUES (1, ?)",
  ).run(Engine.serverSeq(engine));
};

/**
 * Creates `space` under `enforce` as its own key, declaring `session`, with a
 * genesis granting ALICE OWNER and BOB WRITE.
 */
const createSpace = async (
  server: Server,
  space: string,
  session: SessionDescriptor = {},
): Promise<ResponseMessage<{ seq: number }>> => {
  const authority = await connect(server);
  const sessionId = await openedSession(authority, space, space, session);
  return await transactSet(
    authority,
    space,
    sessionId,
    `of:${space}`,
    { [ALICE]: "OWNER", [BOB]: "WRITE" },
    1,
  );
};

describe("instance-naming-admission", () => {
  describe("the `instanceNameMark` capability", () => {
    it("is advertised in the server's `hello.ok`", async () => {
      const server = createServer("capability", "enforce");
      try {
        expect(server.memoryProtocolFlags().instanceNameMark).toBe(true);
        const messages: ServerMessage[] = [];
        const connection = server.connect((message) => messages.push(message));
        await connection.receive(encodeMemoryBoundary(HELLO));
        expect(messages[0]).toMatchObject({
          type: "hello.ok",
          flags: { instanceNameMark: true },
        });
      } finally {
        await server.close();
      }
    });

    it("parses to `false` when absent, and refuses a value that is not a boolean", () => {
      expect(parseMemoryProtocolFlags({})?.instanceNameMark).toBe(false);
      expect(
        parseMemoryProtocolFlags({ instanceNameMark: true })?.instanceNameMark,
      ).toBe(true);
      expect(parseMemoryProtocolFlags({ instanceNameMark: "true" }))
        .toBeNull();
    });
  });

  describe("the `instanceNames` declaration", () => {
    for (const declared of [false, "true", 1]) {
      it(
        `returns \`InvalidMessageError\` for an open declaring \`${
          JSON.stringify(declared)
        }\``,
        async () => {
          const server = createServer(
            `declared-${declared}`,
            "off",
            () => true,
          );
          const space = "did:key:z6Mk-naming-declared";
          try {
            const alice = await connect(server);
            const opened = await openSession(alice, space, ALICE, {
              instanceNames: declared as unknown as true,
            });
            expect(opened.error?.name).toBe("InvalidMessageError");
          } finally {
            await server.close();
          }
        },
      );
    }
  });

  describe("recording the mark", () => {
    it("records the mark with a naming genesis commit, naming that commit", async () => {
      const server = createServer("genesis", "enforce", () => true);
      const space = "did:key:z6Mk-naming-genesis";
      try {
        expect(await markedAt(server, space)).toBeUndefined();
        const genesis = await createSpace(server, space, NAMING);
        expect(genesis.ok?.seq).toBe(1);
        expect(await markedAt(server, space)).toBe(1);
      } finally {
        await server.close();
      }
    });

    it("records the mark with the first naming commit to a space positional sessions wrote, and keeps it through later ones", async () => {
      const server = createServer("first-commit", "enforce", () => true);
      const space = "did:key:z6Mk-naming-first-commit";
      try {
        await createSpace(server, space);
        const positional = await connect(server);
        const positionalId = await openedSession(positional, space, BOB);
        expect(
          (await transactSet(positional, space, positionalId, "of:a", 1, 1))
            .ok?.seq,
        ).toBe(2);
        expect(await markedAt(server, space)).toBeUndefined();

        const naming = await connect(server);
        const namingId = await openedSession(naming, space, ALICE, NAMING);
        expect(
          (await transactSet(naming, space, namingId, "of:b", 2, 1)).ok?.seq,
        ).toBe(3);
        expect(await markedAt(server, space)).toBe(3);
        expect(
          (await transactSet(naming, space, namingId, "of:b", 3, 2)).ok?.seq,
        ).toBe(4);
        expect(await markedAt(server, space)).toBe(3);
      } finally {
        await server.close();
      }
    });

    it("records no mark for a naming commit the engine refuses inside its transaction", async () => {
      const server = createServer("refused-commit", "enforce", () => true);
      const space = "did:key:z6Mk-naming-refused-commit";
      try {
        await createSpace(server, space);
        const harness = await connect(server);
        const opened = await openSession(harness, space, BOB);
        if (opened.ok === undefined) throw new Error("Expected an open");
        const { sessionId } = opened.ok;
        expect(
          (await transactSet(harness, space, sessionId, "of:a", 1, 1)).ok?.seq,
        ).toBe(2);
        const resumed = await openSession(harness, space, BOB, {
          sessionId,
          sessionToken: opened.ok.sessionToken,
          instanceNames: true,
        });
        expect(resumed.ok?.resumed).toBe(true);

        // The session's local seq again with other content: a replay
        // mismatch, which the engine refuses once the transaction is open.
        const mismatched = await transactSet(
          harness,
          space,
          sessionId,
          "of:a",
          "other",
          1,
        );
        expect(mismatched.error).toBeDefined();
        expect(await markedAt(server, space)).toBeUndefined();
        expect(
          (await transactSet(harness, space, sessionId, "of:a", 2, 2)).ok?.seq,
        ).toBe(3);
        expect(await markedAt(server, space)).toBe(3);
      } finally {
        await server.close();
      }
    });

    it("throws when the mark is recorded outside a commit's transaction", async () => {
      const engine = await Engine.open({
        url: new URL("memory:instance-naming-outside-transaction"),
      });
      try {
        expect(() => Engine.recordInstanceNameMark(engine, 1)).toThrow(
          "recorded only inside its commit's transaction",
        );
        expect(Engine.hasInstanceNameMark(engine)).toBe(false);
      } finally {
        Engine.close(engine);
      }
    });

    it("leaves a space a naming session opens and reads without committing unmarked", async () => {
      const server = createServer("read-only", "enforce", () => true);
      const space = "did:key:z6Mk-naming-read-only";
      try {
        await createSpace(server, space);
        const naming = await connect(server);
        await openedSession(naming, space, ALICE, NAMING);
        expect(await markedAt(server, space)).toBeUndefined();
        const positional = await connect(server);
        expect((await openSession(positional, space, BOB)).ok).toBeDefined();
      } finally {
        await server.close();
      }
    });
  });

  describe("a commit to a marked space", () => {
    it("returns `SessionRevokedError` with `clientUpdateRequired` for a positional session's commit, and writes nothing", async () => {
      const server = createServer("positional-commit", "enforce", () => true);
      const space = "did:key:z6Mk-naming-positional-commit";
      try {
        await createSpace(server, space);
        const positional = await connect(server);
        const sessionId = await openedSession(positional, space, BOB);
        await markInStore(server, space);
        const refused = await transactSet(
          positional,
          space,
          sessionId,
          "of:a",
          1,
          1,
        );
        expect(refused.error).toEqual({
          name: "SessionRevokedError",
          message: markedMessage(space),
          clientUpdateRequired: true,
        });
        expect(Engine.serverSeq(await server.engineForSpace(space))).toBe(1);
      } finally {
        await server.close();
      }
    });

    it("admits a naming session's commit", async () => {
      const server = createServer("naming-commit", "enforce", () => true);
      const space = "did:key:z6Mk-naming-naming-commit";
      try {
        await createSpace(server, space, NAMING);
        const naming = await connect(server);
        const sessionId = await openedSession(naming, space, BOB, NAMING);
        expect(
          (await transactSet(naming, space, sessionId, "of:a", 1, 1)).ok?.seq,
        ).toBe(2);
      } finally {
        await server.close();
      }
    });
  });

  describe("revocation", () => {
    it("revokes the space's positional sessions with `instance-names` when a commit marks it, and keeps its naming sessions", async () => {
      const server = createServer("revocation", "enforce", () => true);
      const space = "did:key:z6Mk-naming-revocation";
      const other = "did:key:z6Mk-naming-revocation-other";
      try {
        await createSpace(server, space);
        await createSpace(server, other);
        const positional = await connect(server);
        const positionalId = await openedSession(positional, space, BOB);
        const elsewhereId = await openedSession(positional, other, BOB);
        const reader = await connect(server);
        const readerId = await openedSession(reader, space, ALICE, NAMING);
        const writer = await connect(server);
        const writerId = await openedSession(writer, space, ALICE, NAMING);
        positional.messages.length = 0;
        reader.messages.length = 0;

        expect(
          (await transactSet(writer, space, writerId, "of:a", 1, 1)).ok,
        ).toBeDefined();
        expect(positional.messages).toEqual([{
          type: "session/revoked",
          space,
          sessionId: positionalId,
          reason: "instance-names",
        }]);
        expect(reader.messages).toEqual([]);
        expect(writer.messages).not.toContainEqual(
          expect.objectContaining({ type: "session/revoked" }),
        );
        // The revoked session is gone; the positional session of another
        // space, and the naming sessions, are not.
        expect(
          (await transactSet(positional, space, positionalId, "of:a", 2, 1))
            .error?.name,
        ).toBe("SessionError");
        expect(
          (await transactSet(positional, other, elsewhereId, "of:a", 2, 1)).ok,
        ).toBeDefined();
        expect(
          (await transactSet(reader, space, readerId, "of:a", 3, 1)).ok,
        ).toBeDefined();
      } finally {
        await server.close();
      }
    });
  });

  describe("an open of a marked space", () => {
    for (const posture of ["names instances", "names none", "is not given"]) {
      describe(`on a server whose posture ${posture}`, () => {
        const namesInstances = posture === "names instances"
          ? () => true
          : posture === "names none"
          ? () => false
          : undefined;

        it("returns `SessionRevokedError` with `clientUpdateRequired` for a positional open", async () => {
          const server = createServer(
            `marked-positional-${posture}`,
            "enforce",
            namesInstances,
          );
          const space = "did:key:z6Mk-naming-marked-positional";
          try {
            await createSpace(server, space);
            await markInStore(server, space);
            const opened = await openSession(await connect(server), space, BOB);
            expect(opened.error).toEqual({
              name: "SessionRevokedError",
              message: markedMessage(space),
              clientUpdateRequired: true,
            });
          } finally {
            await server.close();
          }
        });

        it("admits a naming open", async () => {
          const server = createServer(
            `marked-naming-${posture}`,
            "enforce",
            namesInstances,
          );
          const space = "did:key:z6Mk-naming-marked-naming";
          try {
            await createSpace(server, space);
            await markInStore(server, space);
            const opened = await openSession(
              await connect(server),
              space,
              BOB,
              NAMING,
            );
            expect(opened.ok).toBeDefined();
          } finally {
            await server.close();
          }
        });
      });
    }

    it("returns `SessionRevokedError` with `clientUpdateRequired` for a positional resume, and admits a naming one", async () => {
      const server = createServer("marked-resume", "enforce", () => true);
      const space = "did:key:z6Mk-naming-marked-resume";
      try {
        await createSpace(server, space);
        const first = await connect(server);
        const opened = await openSession(first, space, BOB);
        if (opened.ok === undefined) throw new Error("Expected an open");
        const { sessionId, sessionToken } = opened.ok;
        first.connection.close();
        await markInStore(server, space);

        const second = await connect(server);
        const positional = await openSession(second, space, BOB, {
          sessionId,
          sessionToken,
        });
        expect(positional.error).toEqual({
          name: "SessionRevokedError",
          message: markedMessage(space),
          clientUpdateRequired: true,
        });
        const naming = await openSession(await connect(server), space, BOB, {
          sessionId,
          sessionToken,
          instanceNames: true,
        });
        expect(naming.ok?.resumed).toBe(true);
      } finally {
        await server.close();
      }
    });

    it("refuses a principal the space refuses for that, not for its mark", async () => {
      const server = createServer("marked-unauthorized", "enforce", () => true);
      const space = "did:key:z6Mk-naming-marked-unauthorized";
      try {
        await createSpace(server, space, NAMING);
        const opened = await openSession(
          await connect(server),
          space,
          "did:key:z6Mk-naming-stranger",
        );
        expect(opened.error?.name).toBe("AuthorizationError");
      } finally {
        await server.close();
      }
    });
  });

  describe("an open of an unmarked space", () => {
    it("admits a positional and a naming open while the posture names instances", async () => {
      const server = createServer("unmarked-names", "enforce", () => true);
      const space = "did:key:z6Mk-naming-unmarked-names";
      try {
        await createSpace(server, space);
        expect((await openSession(await connect(server), space, BOB)).ok)
          .toBeDefined();
        expect(
          (await openSession(await connect(server), space, BOB, NAMING)).ok,
        ).toBeDefined();
      } finally {
        await server.close();
      }
    });

    for (const posture of ["names none", "is not given"]) {
      it(`returns \`SessionRevokedError\` with \`clientUpdateRequired\` for a naming open, and admits a positional one, while the posture ${posture}`, async () => {
        const server = createServer(
          `unmarked-${posture}`,
          "enforce",
          posture === "names none" ? () => false : undefined,
        );
        const space = "did:key:z6Mk-naming-unmarked-none";
        try {
          await createSpace(server, space);
          const naming = await openSession(
            await connect(server),
            space,
            BOB,
            NAMING,
          );
          expect(naming.error).toEqual({
            name: "SessionRevokedError",
            message: postureMessage(space),
            clientUpdateRequired: true,
          });
          expect((await openSession(await connect(server), space, BOB)).ok)
            .toBeDefined();
          expect(await markedAt(server, space)).toBeUndefined();
        } finally {
          await server.close();
        }
      });
    }
  });

  describe("under the `off` ACL mode", () => {
    it("records the mark and refuses positional opens and commits by it", async () => {
      const server = createServer("acl-off", "off", () => true);
      const space = "did:key:z6Mk-naming-acl-off";
      try {
        const positional = await connect(server);
        const positionalId = await openedSession(positional, space, BOB);
        const naming = await connect(server);
        const namingId = await openedSession(naming, space, ALICE, NAMING);
        expect(
          (await transactSet(naming, space, namingId, "of:a", 1, 1)).ok?.seq,
        ).toBe(1);
        expect(await markedAt(server, space)).toBe(1);
        expect(positional.messages).toContainEqual({
          type: "session/revoked",
          space,
          sessionId: positionalId,
          reason: "instance-names",
        });

        const refusedOpen = await openSession(
          await connect(server),
          space,
          BOB,
        );
        expect(refusedOpen.error).toEqual({
          name: "SessionRevokedError",
          message: markedMessage(space),
          clientUpdateRequired: true,
        });
      } finally {
        await server.close();
      }
    });

    it("refuses a positional commit to a marked space", async () => {
      const server = createServer("acl-off-commit", "off", () => true);
      const space = "did:key:z6Mk-naming-acl-off-commit";
      try {
        const positional = await connect(server);
        const sessionId = await openedSession(positional, space, BOB);
        expect(
          (await transactSet(positional, space, sessionId, "of:a", 1, 1)).ok,
        ).toBeDefined();
        await markInStore(server, space);
        expect(
          (await transactSet(positional, space, sessionId, "of:a", 2, 2))
            .error,
        ).toEqual({
          name: "SessionRevokedError",
          message: markedMessage(space),
          clientUpdateRequired: true,
        });
      } finally {
        await server.close();
      }
    });

    it("refuses a naming open of an unmarked space while the posture names none", async () => {
      const server = createServer("acl-off-posture", "off");
      const space = "did:key:z6Mk-naming-acl-off-posture";
      try {
        const opened = await openSession(
          await connect(server),
          space,
          BOB,
          NAMING,
        );
        expect(opened.error).toEqual({
          name: "SessionRevokedError",
          message: postureMessage(space),
          clientUpdateRequired: true,
        });
      } finally {
        await server.close();
      }
    });
  });
});
