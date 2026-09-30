// The executor-facing space-owner read (OW45 arm-B server-ensure stage 1;
// design PR #6209 §4 option (b)): the SpaceServer's space-root ensure
// resolves the space's ACL OWNER for its per-run CFC trust snapshot and its
// home-space predicate (self-owned = home). `resolveSpaceOwner` is the thin
// public API over the server's own `#resolveSpaceOwnerBinding` — the one
// ruled service-identity ACL read (OW31, RULED 2026-08-19) — so the ensure
// binds to the SAME resolution the delegated-read binding uses:
//
// - self-owned space (every home space): the space DID itself;
// - several concrete OWNERs: the lexicographically first (deterministic);
// - no valid concrete-owner ACL (missing, invalid, retracted, or only
//   ANYONE): undefined — the ensure's fail-closed skip arm (OW53's shape).

import { assertEquals, assertExists } from "@std/assert";
import { Server } from "../v2/server.ts";
import {
  encodeMemoryBoundary,
  getMemoryProtocolFlags,
  type HelloOkMessage,
  MEMORY_PROTOCOL,
  type Operation,
  type ResponseMessage,
  type ServerMessage,
  type SessionEffectMessage,
  type SessionOpenAuthMetadata,
  type SessionOpenResult,
  type SessionSync,
} from "../v2.ts";

const HELLO = {
  type: "hello",
  protocol: MEMORY_PROTOCOL,
  flags: getMemoryProtocolFlags(),
} as const;

const ALICE = "did:key:z6Mk-owner-alice";
const BOB = "did:key:z6Mk-owner-bob";
const TEST_AUDIENCE = "did:key:z6Mk-owner-test-audience";

const createServer = (store: string) =>
  new Server({
    store: new URL(store),
    subscriptionRefreshDelayMs: 0,
    authorizeSessionOpen: (message) => {
      const iss = message.invocation?.iss;
      return typeof iss === "string" ? iss : undefined;
    },
    sessionOpenAuth: { audience: TEST_AUDIENCE },
    acl: { mode: "enforce" },
  });

type Harness = {
  messages: ServerMessage[];
  connection: ReturnType<Server["connect"]>;
  sessionOpen: SessionOpenAuthMetadata;
};

const shiftMessage = (messages: ServerMessage[]): ServerMessage => {
  const message = messages.shift();
  assertExists(message, "expected a server message");
  return message;
};

const nextResponse = <Result>(
  messages: ServerMessage[],
): ResponseMessage<Result> => {
  while (true) {
    const message = shiftMessage(messages);
    if (message.type !== "session/effect") {
      assertEquals(message.type, "response");
      return message as ResponseMessage<Result>;
    }
    const effect = (message as SessionEffectMessage)
      .effect as unknown as SessionSync;
    if (
      effect.upserts.length > 0 || effect.removes.length > 0 ||
      effect.caughtUpLocalSeq === undefined
    ) {
      throw new Error(
        "nextResponse skipped a non-marker-only sync frame; consume it explicitly",
      );
    }
  }
};

const connect = async (server: Server): Promise<Harness> => {
  const messages: ServerMessage[] = [];
  const connection = server.connect((message) => messages.push(message));
  await connection.receive(encodeMemoryBoundary(HELLO));
  const hello = shiftMessage(messages) as HelloOkMessage;
  assertEquals(hello.type, "hello.ok");
  assertExists(hello.sessionOpen);
  return { messages, connection, sessionOpen: hello.sessionOpen };
};

let requestCounter = 0;

/** Seed a space's genesis ACL through the space identity, as creating a
 * space does (same recipe as v2-server-acl.test.ts). */
const initializeSpaceAcl = async (
  server: Server,
  space: string,
  acl: Record<string, "READ" | "WRITE" | "OWNER">,
): Promise<void> => {
  const harness = await connect(server);
  await harness.connection.receive(encodeMemoryBoundary({
    type: "session.open",
    requestId: `open-${++requestCounter}`,
    space,
    session: {},
    invocation: {
      iss: space,
      aud: harness.sessionOpen.audience,
      challenge: harness.sessionOpen.challenge.value,
    },
  }));
  const opened = nextResponse<SessionOpenResult>(harness.messages);
  assertExists(opened.ok, "space identity should open its own space");
  await harness.connection.receive(encodeMemoryBoundary({
    type: "transact",
    requestId: `tx-${++requestCounter}`,
    space,
    sessionId: opened.ok.sessionId,
    commit: {
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [
        {
          op: "set",
          id: `of:${space}`,
          value: { value: acl },
        } as unknown as Operation,
      ],
    },
  }));
  const written = nextResponse<{ seq: number }>(harness.messages);
  assertExists(written.ok, "space identity should initialize the ACL");
};

Deno.test("resolveSpaceOwner: a self-owned space resolves to the space DID (the home-space predicate)", async () => {
  const server = createServer("memory://space-owner-self");
  const space = "did:key:z6Mk-owner-space-self";
  try {
    await initializeSpaceAcl(server, space, { [space]: "OWNER" });
    const engine = await server.engineForSpace(space);
    assertEquals(server.resolveSpaceOwner(engine, space), space);
  } finally {
    await server.close();
  }
});

Deno.test("resolveSpaceOwner: several concrete OWNERs resolve deterministically to the lexicographically first", async () => {
  const server = createServer("memory://space-owner-multi");
  const space = "did:key:z6Mk-owner-space-multi";
  try {
    // BOB granted before ALICE, so insertion order cannot be what wins.
    await initializeSpaceAcl(server, space, {
      [BOB]: "OWNER",
      [ALICE]: "OWNER",
    });
    const engine = await server.engineForSpace(space);
    assertEquals(server.resolveSpaceOwner(engine, space), ALICE);
  } finally {
    await server.close();
  }
});

Deno.test("resolveSpaceOwner: no ACL resolves to undefined (the ensure's fail-closed arm)", async () => {
  const server = createServer("memory://space-owner-missing");
  const space = "did:key:z6Mk-owner-space-missing";
  try {
    const engine = await server.engineForSpace(space);
    assertEquals(server.resolveSpaceOwner(engine, space), undefined);
  } finally {
    await server.close();
  }
});

Deno.test("resolveSpaceOwner: an owner-granted non-self space names that owner, never the service", async () => {
  const server = createServer("memory://space-owner-granted");
  const space = "did:key:z6Mk-owner-space-granted";
  try {
    await initializeSpaceAcl(server, space, {
      [ALICE]: "OWNER",
      [BOB]: "WRITE",
    });
    const engine = await server.engineForSpace(space);
    assertEquals(server.resolveSpaceOwner(engine, space), ALICE);
  } finally {
    await server.close();
  }
});
