/**
 * The v2 `Server` attributing a session's activity to the person the session
 * stands for: the `enduser.id` attribute on the `memory.session.open`,
 * `memory.transact`, and `memory.subscriber.sync` spans, beside the `user.did`
 * of the principal that signed the open.
 */

import { expect } from "@std/expect";
import { afterAll, beforeEach, describe, it } from "@std/testing/bdd";
import { context, trace } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";

import type { FabricValue } from "@commonfabric/api";
import { FabricBytes } from "@commonfabric/data-model/fabric-primitives";
import {
  type Delegation,
  type DIDKey,
  issueDelegation,
} from "@commonfabric/identity";

import { Server } from "../v2/server.ts";
import type { SessionDescriptor, SessionOpenResult } from "../v2.ts";
import { alice, bob, mallory, space } from "./principal.ts";
import { connectPeer, request, type WirePeer } from "./support/wire-peer.ts";

const exporter = new InMemorySpanExporter();
const provider = new BasicTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(exporter)],
});
trace.setGlobalTracerProvider(provider);

/** A server whose session principal is taken, test-only, from
 *  `invocation.iss`, as the access-list suites' servers do. */
const createServer = (
  store: string,
  acl: {
    mode: "off" | "enforce";
    serviceDids?: readonly string[];
    delegatingDids?: readonly string[];
  },
) =>
  new Server({
    store: new URL(store),
    subscriptionRefreshDelayMs: 0,
    authorizeSessionOpen: (message) => {
      const iss = message.invocation?.iss;
      return typeof iss === "string" ? iss : undefined;
    },
    sessionOpenAuth: { audience: "did:key:z6Mk-person-test-audience" },
    acl,
  });

/** Opens `space` as `principal`, presenting `chain` when one is given, and
 *  returns the result. Throws when the server refuses the open. */
const open = async (
  peer: WirePeer,
  principal: string,
  { chain = [], session = {} }: {
    chain?: Delegation[];
    session?: SessionDescriptor;
  } = {},
): Promise<SessionOpenResult> => {
  const opened = await request<SessionOpenResult>(peer, {
    type: "session.open",
    space: space.did(),
    session,
    invocation: {
      iss: principal,
      aud: peer.auth.audience,
      challenge: peer.auth.challenge.value,
      ...(chain.length === 0 ? {} : { prf: chain.map((d) => d.cid) }),
    },
    ...(chain.length === 0 ? {} : {
      authorization: { proofs: chain.map((d) => new FabricBytes(d.bytes)) },
    }),
  });
  if (opened.ok === undefined) {
    throw new Error(`session open failed: ${opened.error?.message}`);
  }
  peer.auth = opened.ok.sessionOpen;
  return opened.ok;
};

/** Sets document `id` to `value` in `sessionId`'s space. Throws when the
 *  server refuses the commit. */
const set = async (
  peer: WirePeer,
  sessionId: string,
  id: string,
  value: FabricValue,
  localSeq: number,
): Promise<void> => {
  const written = await request<{ seq: number }>(peer, {
    type: "transact",
    space: space.did(),
    sessionId,
    commit: {
      localSeq,
      reads: { confirmed: [], pending: [] },
      operations: [{ op: "set", id, value: { value } }],
    },
  });
  if (written.ok === undefined) {
    throw new Error(`commit failed: ${written.error?.message}`);
  }
};

/** The `user.did` and `enduser.id` of each finished span named `name`, in
 *  the order they finished. */
const attribution = (name: string) =>
  exporter.getFinishedSpans()
    .filter((span: ReadableSpan) => span.name === name)
    .map(({ attributes }) => ({
      user: attributes["user.did"],
      person: attributes["enduser.id"],
    }));

const spaceTo = (audience: DIDKey) =>
  issueDelegation(space, {
    aud: audience,
    sub: space.did(),
    cmd: "/memory",
    pol: [],
  });

describe("v2-server-session-person", () => {
  beforeEach(() => {
    exporter.reset();
  });

  afterAll(async () => {
    trace.disable();
    context.disable();
    await provider.shutdown();
  });

  it("attributes a session's open, commits, and resumed sync to its principal", async () => {
    const server = createServer("memory://person-principal", { mode: "off" });
    try {
      const peer = await connectPeer(server);
      const opened = await open(peer, alice.did());
      await set(peer, opened.sessionId, "of:doc:1", { hello: "world" }, 1);
      await open(await connectPeer(server), alice.did(), {
        session: {
          sessionId: opened.sessionId,
          sessionToken: opened.sessionToken,
        },
      });

      const alices = { user: alice.did(), person: alice.did() };
      expect(attribution("memory.session.open")).toEqual([alices, alices]);
      expect(attribution("memory.transact")).toEqual([alices]);
      const syncs = attribution("memory.subscriber.sync");
      expect(syncs.length).toBeGreaterThan(0);
      expect(syncs).toEqual(syncs.map(() => alices));
    } finally {
      await server.close();
    }
  });

  it("attributes a delegated key's session to the first person on its chain", async () => {
    const server = createServer("memory://person-chain", { mode: "off" });
    try {
      // The space is no one's home, as a profile is not, and hands its
      // authority to alice, who hands it on to bob.
      const aliceToBob = await issueDelegation(alice, {
        aud: bob.did(),
        sub: space.did(),
        cmd: "/memory",
        pol: [],
      });
      await open(await connectPeer(server), alice.did(), {
        chain: [await spaceTo(alice.did())],
      });
      await open(await connectPeer(server), bob.did(), {
        chain: [await spaceTo(alice.did()), aliceToBob],
      });

      expect(attribution("memory.session.open")).toEqual([
        { user: alice.did(), person: alice.did() },
        { user: bob.did(), person: alice.did() },
      ]);
    } finally {
      await server.close();
    }
  });

  it("attributes a chain from a Home space's own key to that key", async () => {
    const server = createServer("memory://person-home-chain", { mode: "off" });
    try {
      const peer = await connectPeer(server);
      const opened = await open(peer, space.did());
      await set(peer, opened.sessionId, `of:${space.did()}`, {
        [space.did()]: "OWNER",
      }, 1);
      exporter.reset();
      await open(await connectPeer(server), bob.did(), {
        chain: [await spaceTo(bob.did())],
      });

      expect(attribution("memory.session.open")).toEqual([
        { user: bob.did(), person: space.did() },
      ]);
    } finally {
      await server.close();
    }
  });

  it("attributes a chain whose root is a service principal to the person after it", async () => {
    const server = createServer("memory://person-service-root", {
      mode: "off",
      serviceDids: [mallory.did()],
    });
    try {
      const malloryToAlice = await issueDelegation(mallory, {
        aud: alice.did(),
        sub: space.did(),
        cmd: "/memory",
        pol: [],
      });
      await open(await connectPeer(server), alice.did(), {
        chain: [malloryToAlice],
      });

      expect(attribution("memory.session.open")).toEqual([
        { user: alice.did(), person: alice.did() },
      ]);
    } finally {
      await server.close();
    }
  });

  it("sets no `enduser.id` for service, delegating, serving, and `*` sessions", async () => {
    const server = createServer("memory://person-automation", {
      mode: "off",
      serviceDids: [mallory.did()],
      delegatingDids: [bob.did()],
    });
    try {
      await open(await connectPeer(server), mallory.did());
      await open(await connectPeer(server), bob.did());
      await open(await connectPeer(server), alice.did(), {
        session: { demand: false },
      });
      await open(await connectPeer(server), "*");

      expect(attribution("memory.session.open")).toEqual([
        { user: mallory.did(), person: undefined },
        { user: bob.did(), person: undefined },
        { user: alice.did(), person: undefined },
        { user: undefined, person: undefined },
      ]);
    } finally {
      await server.close();
    }
  });

  it("sets `enduser.id` for a space's own key from the commit that makes the space its home", async () => {
    const server = createServer("memory://person-home", { mode: "enforce" });
    try {
      const peer = await connectPeer(server);
      const opened = await open(peer, space.did());
      await set(peer, opened.sessionId, `of:${space.did()}`, {
        [space.did()]: "OWNER",
      }, 1);
      await set(peer, opened.sessionId, "of:doc:2", { hello: "home" }, 2);
      await open(await connectPeer(server), space.did(), {
        session: {
          sessionId: opened.sessionId,
          sessionToken: opened.sessionToken,
        },
      });

      const fresh = { user: space.did(), person: undefined };
      const home = { user: space.did(), person: space.did() };
      expect(attribution("memory.session.open")).toEqual([fresh, home]);
      expect(attribution("memory.transact")).toEqual([home, home]);
    } finally {
      await server.close();
    }
  });

  it("decides again for every session on a space when another session's commit makes it a Home space", async () => {
    const server = createServer("memory://person-home-other", { mode: "off" });
    try {
      const watcher = await connectPeer(server);
      const watching = await open(watcher, space.did());
      const writer = await connectPeer(server);
      const writing = await open(writer, space.did());
      await set(writer, writing.sessionId, `of:${space.did()}`, {
        [space.did()]: "OWNER",
      }, 1);
      exporter.reset();
      await set(watcher, watching.sessionId, "of:doc:4", { hello: "too" }, 1);

      expect(attribution("memory.transact")).toEqual([
        { user: space.did(), person: space.did() },
      ]);
    } finally {
      await server.close();
    }
  });

  it("sets no `enduser.id` for a space's own key on a space someone else owns", async () => {
    const server = createServer("memory://person-owned", { mode: "off" });
    try {
      const peer = await connectPeer(server);
      const opened = await open(peer, space.did());
      await set(peer, opened.sessionId, `of:${space.did()}`, {
        [alice.did()]: "OWNER",
      }, 1);
      await open(await connectPeer(server), space.did(), {
        session: {
          sessionId: opened.sessionId,
          sessionToken: opened.sessionToken,
        },
      });

      expect(attribution("memory.session.open").map(({ person }) => person))
        .toEqual([undefined, undefined]);
    } finally {
      await server.close();
    }
  });

  it("sets `enduser.id` for a space's own key on a space with history and no access list", async () => {
    const server = createServer("memory://person-legacy", { mode: "off" });
    try {
      const peer = await connectPeer(server);
      const opened = await open(peer, alice.did());
      await set(peer, opened.sessionId, "of:doc:3", { hello: "legacy" }, 1);
      exporter.reset();
      await open(await connectPeer(server), space.did());

      expect(attribution("memory.session.open")).toEqual([
        { user: space.did(), person: space.did() },
      ]);
    } finally {
      await server.close();
    }
  });
});
