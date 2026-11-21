import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";

import {
  encodeMemoryBoundary,
  getMemoryProtocolFlags,
  MEMORY_PROTOCOL,
  type ResponseMessage,
  type ServerMessage,
  type SessionOpenResult,
} from "../v2.ts";
import { Server } from "../v2/server.ts";

const principal = (await Identity.fromRaw(new Uint8Array(32).fill(41))).did();
const space = (await Identity.fromRaw(new Uint8Array(32).fill(42))).did();
const audience = (await Identity.fromRaw(new Uint8Array(32).fill(43))).did();

const HELLO = encodeMemoryBoundary({
  type: "hello",
  protocol: MEMORY_PROTOCOL,
  flags: getMemoryProtocolFlags(),
});

/** Takes the response to `requestId` out of `messages`. */
const take = <Result>(
  messages: ServerMessage[],
  requestId: string,
): ResponseMessage<Result> => {
  const index = messages.findIndex((message) =>
    message.type === "response" && message.requestId === requestId
  );
  expect(index).toBeGreaterThanOrEqual(0);
  return messages.splice(index, 1)[0] as ResponseMessage<Result>;
};

describe("Server", () => {
  describe("syncSessionForConnection()", () => {
    it("returns `null` for a routed session while its connection does not own the space, and its owed frame once it does again", async () => {
      let owns = true;
      const server = new Server({
        store: new URL(`memory://routed-sync-${crypto.randomUUID()}`),
        subscriptionRefreshDelayMs: "manual",
        authorizeSessionOpen: (message) =>
          typeof message.invocation?.iss === "string"
            ? message.invocation.iss
            : undefined,
        sessionOpenAuth: { audience },
        ownsSpace: (candidate) => candidate === space,
        acl: { mode: "enforce" },
      });
      try {
        // The space identity grants the principal the space.
        const seedMessages: ServerMessage[] = [];
        const seed = server.connect((message) => seedMessages.push(message));
        await seed.receive(HELLO);
        const hello = seedMessages.shift();
        if (hello?.type !== "hello.ok" || hello.sessionOpen === undefined) {
          throw new Error("expected `hello.ok` carrying a challenge");
        }
        await seed.receive(encodeMemoryBoundary({
          type: "session.open",
          requestId: "seed-open",
          space,
          session: {},
          invocation: {
            iss: space,
            aud: audience,
            challenge: hello.sessionOpen.challenge.value,
          },
        }));
        const seeded = take<SessionOpenResult>(seedMessages, "seed-open");
        await seed.receive(encodeMemoryBoundary({
          type: "transact",
          requestId: "seed-acl",
          space,
          sessionId: seeded.ok!.sessionId,
          commit: {
            localSeq: 1,
            reads: { confirmed: [], pending: [] },
            operations: [{
              op: "set",
              id: `of:${space}`,
              value: { value: { [principal]: "OWNER" } },
            }],
          },
        }));
        expect(take(seedMessages, "seed-acl").error).toBeUndefined();

        const messages: ServerMessage[] = [];
        const routed = server.connectRouted(
          (message) => messages.push(message),
          (candidate) => owns && candidate === space,
        );
        await routed.receive(HELLO);
        routed.admitRoutedPrincipal(
          principal,
          Math.floor(Date.now() / 1000) + 600,
        );
        await routed.receive(encodeMemoryBoundary({
          type: "session.open",
          requestId: "routed-open",
          space,
          principal,
          session: {},
        }));
        const { sessionId } = take<SessionOpenResult>(messages, "routed-open")
          .ok!;
        // A write stages the catch-up marker the session's next frame owes.
        await routed.receive(encodeMemoryBoundary({
          type: "transact",
          requestId: "routed-write",
          space,
          sessionId,
          commit: {
            localSeq: 1,
            reads: { confirmed: [], pending: [] },
            operations: [{ op: "set", id: "of:routed", value: { value: 1 } }],
          },
        }));
        expect(take(messages, "routed-write").error).toBeUndefined();

        owns = false;
        expect(await server.syncSessionForConnection(space, sessionId))
          .toBeNull();

        owns = true;
        const owed = await server.syncSessionForConnection(space, sessionId);
        expect(owed?.effect.caughtUpLocalSeq).toBe(1);
      } finally {
        await server.close();
      }
    });
  });
});
