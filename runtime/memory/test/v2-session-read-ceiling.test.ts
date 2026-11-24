/**
 * A session's declared read ceiling (`SessionDescriptor.readCeiling`): what
 * the server records at open, what a resume has to re-declare, and what the
 * wire parser refuses. Driven through the server's wire boundary — raw
 * connections, raw messages — the way the holdings pins are.
 */

import { assert } from "@std/assert";
import { expect } from "@std/expect";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import type { FabricPlainObject } from "@commonfabric/api";
import { Server } from "../v2/server.ts";
import {
  encodeMemoryBoundary,
  getMemoryProtocolFlags,
  type HelloOkMessage,
  MEMORY_PROTOCOL,
  parseMemoryProtocolFlags,
  parseSessionReadCeiling,
  readCeilingShapeError,
  type ResponseMessage,
  type ServerMessage,
  type SessionOpenAuthMetadata,
  type SessionOpenResult,
  type SessionReadCeiling,
  wireMemoryProtocolFlags,
} from "../v2.ts";

const TEST_AUDIENCE = "did:key:z6Mk-read-ceiling-audience";
const SPACE = "did:key:z6Mk-read-ceiling-space";
const READER = "did:key:z6Mk-read-ceiling-reader";

const HELLO = {
  type: "hello",
  protocol: MEMORY_PROTOCOL,
  flags: getMemoryProtocolFlags(),
} as const;

type Harness = {
  messages: ServerMessage[];
  connection: ReturnType<Server["connect"]>;
  sessionOpen: SessionOpenAuthMetadata;
};

const shiftMessage = (messages: ServerMessage[]): ServerMessage => {
  const message = messages.shift();
  assert(message !== undefined, "expected a server message");
  return message;
};

const connect = async (server: Server): Promise<Harness> => {
  const messages: ServerMessage[] = [];
  const connection = server.connect((message) => messages.push(message));
  await connection.receive(encodeMemoryBoundary(HELLO));
  const hello = shiftMessage(messages) as HelloOkMessage;
  expect(hello.type).toBe("hello.ok");
  assert(hello.sessionOpen !== undefined, "expected session-open metadata");
  return { messages, connection, sessionOpen: hello.sessionOpen };
};

let requestCounter = 0;
const nextRequestId = (): string => `open-${++requestCounter}`;

/** Sends a `session.open` whose descriptor is `session`, verbatim. */
const sendOpen = async (
  harness: Harness,
  session: FabricPlainObject,
): Promise<ResponseMessage<SessionOpenResult>> => {
  await harness.connection.receive(encodeMemoryBoundary({
    type: "session.open",
    requestId: nextRequestId(),
    space: SPACE,
    session,
    invocation: {
      iss: READER,
      aud: harness.sessionOpen.audience,
      challenge: harness.sessionOpen.challenge.value,
    },
  }));
  const response = shiftMessage(harness.messages) as ResponseMessage<
    SessionOpenResult
  >;
  if (response.ok !== undefined) harness.sessionOpen = response.ok.sessionOpen;
  return response;
};

const open = async (
  harness: Harness,
  session: FabricPlainObject,
): Promise<SessionOpenResult> => {
  const response = await sendOpen(harness, session);
  assert(response.ok !== undefined, JSON.stringify(response.error));
  return response.ok;
};

const ceiling: SessionReadCeiling = {
  maxConfidentiality: ["did:key:z6Mk-owner", { anyOf: ["a", "b"] }],
  onExceed: "skip",
};

describe("session read ceiling", () => {
  let server: Server;

  beforeAll(() => {
    server = new Server({
      store: new URL("memory://session-read-ceiling"),
      subscriptionRefreshDelayMs: 0,
      authorizeSessionOpen: (message) => {
        const iss = message.invocation?.iss;
        return typeof iss === "string" ? iss : undefined;
      },
      sessionOpenAuth: { audience: TEST_AUDIENCE },
    });
  });

  afterAll(async () => {
    await server.close();
  });

  describe("Server", () => {
    describe("sessionReadCeiling()", () => {
      it("returns the ceiling the session declared at open", async () => {
        const harness = await connect(server);
        const { sessionId } = await open(harness, { readCeiling: ceiling });
        expect(server.sessionReadCeiling(SPACE, sessionId)).toEqual(ceiling);
      });

      it("returns `undefined` for a session that declared none", async () => {
        const harness = await connect(server);
        const { sessionId } = await open(harness, {});
        expect(server.sessionReadCeiling(SPACE, sessionId)).toBeUndefined();
      });

      it("returns `undefined` for a session that is not live", () => {
        expect(server.sessionReadCeiling(SPACE, "never-opened"))
          .toBeUndefined();
      });

      it("takes the ceiling of the LAST open, so a resume declaring none reads unbounded", async () => {
        const harness = await connect(server);
        const first = await open(harness, { readCeiling: ceiling });
        const resumed = await open(harness, {
          sessionId: first.sessionId,
          sessionToken: first.sessionToken,
        });
        expect(resumed.sessionId).toBe(first.sessionId);
        expect(server.sessionReadCeiling(SPACE, first.sessionId))
          .toBeUndefined();
      });

      it("takes a resume's re-declared ceiling over the first open's", async () => {
        const harness = await connect(server);
        const first = await open(harness, { readCeiling: ceiling });
        const narrower: SessionReadCeiling = {
          maxConfidentiality: ["did:key:z6Mk-owner"],
        };
        await open(harness, {
          sessionId: first.sessionId,
          sessionToken: first.sessionToken,
          readCeiling: narrower,
        });
        expect(server.sessionReadCeiling(SPACE, first.sessionId)).toEqual(
          narrower,
        );
      });
    });

    describe("session.open", () => {
      it("refuses a descriptor whose ceiling is malformed as an unparseable message", async () => {
        const harness = await connect(server);
        const response = await sendOpen(harness, {
          readCeiling: { maxConfidentiality: [] },
        });
        expect(response.ok).toBeUndefined();
        expect(response.error?.name).toBe("InvalidMessageError");
      });

      it("refuses a descriptor whose ceiling carries a key it does not name", async () => {
        const harness = await connect(server);
        const response = await sendOpen(harness, {
          readCeiling: { maxConfidentiality: ["x"], mode: "skip" },
        });
        expect(response.error?.name).toBe("InvalidMessageError");
      });
    });
  });

  describe("protocol flags", () => {
    it("advertises `sessionReadCeiling` as build-inherent", () => {
      expect(getMemoryProtocolFlags().sessionReadCeiling).toBe(true);
      expect(
        wireMemoryProtocolFlags(getMemoryProtocolFlags()).sessionReadCeiling,
      )
        .toBe(true);
    });

    it("parses an absent `sessionReadCeiling` as `false`", () => {
      const { sessionReadCeiling: _, ...older } = wireMemoryProtocolFlags(
        getMemoryProtocolFlags(),
      );
      expect(parseMemoryProtocolFlags(older)?.sessionReadCeiling).toBe(false);
    });

    it("refuses a `sessionReadCeiling` that is not a boolean", () => {
      const wire = wireMemoryProtocolFlags(getMemoryProtocolFlags());
      expect(parseMemoryProtocolFlags({ ...wire, sessionReadCeiling: "yes" }))
        .toBeNull();
    });
  });

  describe("parseSessionReadCeiling()", () => {
    it("returns `undefined` for an absent field", () => {
      expect(parseSessionReadCeiling(undefined)).toBeUndefined();
    });

    it("returns the ceiling, with its mode, for a well-formed field", () => {
      expect(parseSessionReadCeiling(ceiling)).toEqual(ceiling);
      expect(parseSessionReadCeiling({ maxConfidentiality: ["x"] })).toEqual({
        maxConfidentiality: ["x"],
      });
    });

    it("returns `null` for a field that is not a record, names no ceiling, or fails the shape check", () => {
      expect(parseSessionReadCeiling("x")).toBeNull();
      expect(parseSessionReadCeiling(["x"])).toBeNull();
      expect(parseSessionReadCeiling({ onExceed: "skip" })).toBeNull();
      expect(parseSessionReadCeiling({ maxConfidentiality: [{ anyOf: [] }] }))
        .toBeNull();
      expect(
        parseSessionReadCeiling({
          maxConfidentiality: ["x"],
          onExceed: "drop",
        }),
      ).toBeNull();
    });
  });

  describe("readCeilingShapeError()", () => {
    const labels = { ceiling: "cfg.ceiling", onExceed: "cfg.onExceed" };

    it("returns `undefined` for a well-formed pair, and for both absent", () => {
      expect(readCeilingShapeError(["x", { anyOf: ["a"] }], "fail", labels))
        .toBeUndefined();
      expect(readCeilingShapeError(undefined, undefined, labels))
        .toBeUndefined();
    });

    it("names the field of each refusal under the caller's labels", () => {
      expect(readCeilingShapeError([], undefined, labels)).toMatch(
        /^cfg\.ceiling: an empty ceiling/,
      );
      expect(readCeilingShapeError("x", undefined, labels)).toMatch(
        /^cfg\.ceiling: expected an array/,
      );
      expect(readCeilingShapeError(["a", 42], undefined, labels)).toMatch(
        /^cfg\.ceiling\[1\]: expected an atom/,
      );
      expect(readCeilingShapeError([{ anyOf: [""] }], undefined, labels))
        .toMatch(/^cfg\.ceiling\[0\]\.anyOf\[0\]: expected an atom/);
      expect(readCeilingShapeError(["a"], "drop", labels)).toMatch(
        /^cfg\.onExceed: expected "fail" or "skip"/,
      );
      expect(readCeilingShapeError(undefined, "skip", labels)).toMatch(
        /^cfg\.onExceed: qualifies `cfg\.ceiling`/,
      );
    });

    it("refuses a hole in a sparse ceiling as an entry that is not a clause", () => {
      const holed: unknown[] = [];
      holed[1] = "x";
      expect(readCeilingShapeError(holed, undefined, labels)).toMatch(
        /^cfg\.ceiling\[0\]/,
      );
    });
  });
});
