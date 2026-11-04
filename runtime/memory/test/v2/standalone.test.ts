import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";

import type { FabricValue } from "@commonfabric/api";
import { hashOf } from "@commonfabric/data-model";
import { FabricBytes } from "@commonfabric/data-model/fabric-primitives";
import { defer } from "@commonfabric/async/defer";

import {
  decodeMemoryBoundary,
  encodeMemoryBoundary,
  getMemoryProtocolFlags,
  type HelloOkMessage,
  MEMORY_PROTOCOL,
} from "../../v2.ts";
import { StandaloneMemoryServer } from "../../v2/standalone.ts";
import { alice, space } from "../principal.ts";
import { principalOf } from "../support/connection-auth.ts";
import type {
  StalledPeerReport,
  StalledPeerRequest,
} from "../support/stalling-socket-worker.ts";

describe("StandaloneMemoryServer", () => {
  it("hands a frame for one space over while a frame for another is being handled", async () => {
    // What the socket delivers is handed to the connection frame by frame
    // without waiting for the handling, so the connection's per-space turns
    // reach a client on a real socket.

    const standalone = StandaloneMemoryServer.start({ connectionAuth: true });
    const slowSpace = "did:key:z6Mk-standalone-turns-slow";
    const fastSpace = "did:key:z6Mk-standalone-turns-fast";
    const gate = defer<void>();
    const address = new URL(standalone.url);
    address.protocol = "ws:";
    const socket = new WebSocket(address);
    const frames = frameReader(socket);
    try {
      await new Promise((resolve) =>
        socket.addEventListener("open", resolve, { once: true })
      );
      socket.send(encodeMemoryBoundary({
        type: "hello",
        protocol: MEMORY_PROTOCOL,
        flags: { ...getMemoryProtocolFlags(), messageCompressionV1: false },
      }));
      const hello = decodeMemoryBoundary<HelloOkMessage>(await frames.next());
      const context = hello.sessionOpen!;
      socket.send(encodeMemoryBoundary({
        type: "connection.auth",
        requestId: "auth",
        ...await principalOf(alice).authorizeConnection(context),
      }));
      const authenticated = decodeMemoryBoundary<{ error?: FabricValue }>(
        await frames.next(),
      );
      expect(authenticated.error).toBeUndefined();
      const sessions = new Map<string, string>();
      for (const space of [slowSpace, fastSpace]) {
        socket.send(encodeMemoryBoundary({
          type: "session.open",
          requestId: `open-${space}`,
          space,
          principal: alice.did(),
          session: {},
        }));
        const opened = decodeMemoryBoundary<{ ok?: { sessionId: string } }>(
          await frames.next(),
        );
        sessions.set(space, opened.ok!.sessionId);
      }
      standalone.server.accessForTestingOnly.engineOpener = (opening, open) =>
        opening === slowSpace
          ? gate.promise.then(() => open(opening))
          : open(opening);
      for (const space of [slowSpace, fastSpace]) {
        socket.send(encodeMemoryBoundary({
          type: "graph.query",
          requestId: `query-${space}`,
          space,
          sessionId: sessions.get(space),
          query: { roots: [] },
        }));
      }
      const first = decodeMemoryBoundary<{ requestId: string }>(
        await frames.next(),
      );
      expect(first.requestId).toBe(`query-${fastSpace}`);
      gate.resolve();
      const second = decodeMemoryBoundary<{ requestId: string }>(
        await frames.next(),
      );
      expect(second.requestId).toBe(`query-${slowSpace}`);
    } finally {
      gate.resolve();
      const closed = new Promise((resolve) =>
        socket.addEventListener("close", resolve, { once: true })
      );
      socket.close();
      await closed;
      await standalone.close();
    }
  });

  describe("a peer that stalls", () => {
    // Each deadline Deno applies runs in real time, and its default is 30
    // seconds. So `compressIdleDeadlines()` has each socket run at a thirtieth
    // of whatever its upgrade asked for, and the stall is long enough to cross
    // the default as compressed. The closing is still Deno's own, on a real
    // socket whose peer's thread is really blocked.

    it("answers a request sent on waking from a stall past Deno's default idle timeout", async () => {
      using _upgrade = compressIdleDeadlines();
      const standalone = StandaloneMemoryServer.start();
      try {
        const report = await stallPeerOf(
          standalone.url,
          encodeMemoryBoundary({
            type: "hello",
            protocol: MEMORY_PROTOCOL,
            flags: { ...getMemoryProtocolFlags(), messageCompressionV1: false },
          }),
        );

        expect(report.closeReason).toBe("");
        expect(report.reply).toBeDefined();
        expect(decodeMemoryBoundary<HelloOkMessage>(report.reply!).type)
          .toBe("hello.ok");
      } finally {
        await standalone.close();
      }
    });

    it("reads a close from a socket upgraded with Deno's default, across the same stall", async () => {
      // The control for the case above: it is the stall crossing that
      // deadline which closes a socket, so a stall that stopped doing so would
      // leave that case passing while showing nothing. This server echoes, so
      // a socket that stayed open ends with a reply rather than with a wait.

      using _upgrade = compressIdleDeadlines();
      const server = Deno.serve(
        { hostname: "127.0.0.1", port: 0, onListen: () => {} },
        (request) => {
          const { socket, response } = Deno.upgradeWebSocket(request);
          socket.addEventListener(
            "message",
            (event) => socket.send(event.data),
          );
          return response;
        },
      );
      try {
        const report = await stallPeerOf(
          new URL(`http://127.0.0.1:${server.addr.port}/`),
          "echoed if the socket stayed open",
        );

        expect(report).toEqual({ closeReason: "No response from ping frame." });
      } finally {
        await server.shutdown();
      }
    });
  });

  describe("instance members", () => {
    describe("server", () => {
      it("is the server a session opened over the websocket reaches", async () => {
        // An observer installed through `server` hears a session opened over
        // the socket, which is what a serving loop attached there relies on.

        const standalone = StandaloneMemoryServer.start();
        // The server notifies before it replies, so every open has been
        // heard by the time the reply arrives.
        const opened: string[] = [];
        standalone.server.setServerExecutionObserver({
          sessionOpened: (openedSpace) => opened.push(openedSpace),
        });
        const address = new URL(standalone.url);
        address.protocol = "ws:";
        const socket = new WebSocket(address);
        const frames = frameReader(socket);
        try {
          await new Promise((resolve) =>
            socket.addEventListener("open", resolve, { once: true })
          );
          socket.send(encodeMemoryBoundary({
            type: "hello",
            protocol: MEMORY_PROTOCOL,
            flags: { ...getMemoryProtocolFlags(), messageCompressionV1: false },
          }));
          const hello = decodeMemoryBoundary<HelloOkMessage>(
            await frames.next(),
          );
          const sessionOpen = hello.sessionOpen!;
          const iat = Math.floor(Date.now() / 1000);
          const invocation: Record<string, FabricValue> = {
            iss: alice.did(),
            cmd: "session.open",
            sub: space.did(),
            aud: sessionOpen.audience,
            args: { protocol: MEMORY_PROTOCOL, session: {} },
            challenge: sessionOpen.challenge.value,
            iat,
            exp: iat + 300,
          };
          const signature = await alice.sign(hashOf(invocation).bytes);
          if (signature.error) throw signature.error;
          socket.send(encodeMemoryBoundary({
            type: "session.open",
            requestId: "standalone-server-open",
            space: space.did(),
            session: {},
            invocation,
            authorization: { signature: new FabricBytes(signature.ok) },
          }));
          const response = decodeMemoryBoundary<{ error?: FabricValue }>(
            await frames.next(),
          );

          expect(response.error).toBeUndefined();
          expect(opened).toEqual([space.did()]);
        } finally {
          const closed = new Promise((resolve) =>
            socket.addEventListener("close", resolve, { once: true })
          );
          socket.close();
          await closed;
          await standalone.close();
        }
      });
    });
  });
});

/** Deno's idle timeout for an upgrade that names none, in seconds. */
const DENO_DEFAULT_IDLE_TIMEOUT_SECONDS = 30;

/** How many times faster than asked `compressIdleDeadlines()` runs a socket. */
const IDLE_DEADLINE_COMPRESSION = 30;

/** How long a stalled peer stays blocked: past the default, as compressed. */
const STALL_MS = 2_000;

/**
 * Has every upgrade until the returned stub is disposed run its idle timeout at
 * {@link IDLE_DEADLINE_COMPRESSION} times the speed it asked for. An upgrade
 * that turns the timeout off has it off here too.
 */
function compressIdleDeadlines(): Disposable {
  const upgrade = Deno.upgradeWebSocket;
  return stub(Deno, "upgradeWebSocket", (request, options) =>
    upgrade(request, {
      ...options,
      idleTimeout: (options?.idleTimeout ?? DENO_DEFAULT_IDLE_TIMEOUT_SECONDS) /
        IDLE_DEADLINE_COMPRESSION,
    }));
}

/**
 * Connects a stalling peer to `url`, which sends `frame` once its stall ends,
 * and returns its report of how its socket ended.
 */
async function stallPeerOf(
  url: URL,
  frame: string,
): Promise<StalledPeerReport> {
  const address = new URL(url);
  address.protocol = "ws:";
  const report = defer<StalledPeerReport>();
  const worker = new Worker(
    new URL("../support/stalling-socket-worker.ts", import.meta.url).href,
    { type: "module" },
  );
  worker.addEventListener(
    "message",
    (event: MessageEvent<StalledPeerReport>) => report.resolve(event.data),
  );
  worker.addEventListener(
    "error",
    (event) => report.reject(new Error(event.message)),
  );
  try {
    const request: StalledPeerRequest = {
      address: address.href,
      stallMs: STALL_MS,
      frame,
    };
    worker.postMessage(request);
    return await report.promise;
  } finally {
    worker.terminate();
  }
}

/** Hands back the socket's text frames in order, one per `next()`. */
function frameReader(socket: WebSocket): { next(): Promise<string> } {
  const arrived: string[] = [];
  const waiting: Array<(frame: string) => void> = [];
  socket.addEventListener("message", (event) => {
    const frame = String(event.data);
    const waiter = waiting.shift();
    if (waiter) waiter(frame);
    else arrived.push(frame);
  });
  return {
    next: () =>
      arrived.length > 0
        ? Promise.resolve(arrived.shift()!)
        : new Promise((resolve) => waiting.push(resolve)),
  };
}
