/**
 * Standalone in-process memory v2 server.
 *
 * Serves the same websocket protocol (and `session.open` signature
 * verification) as toolshed's `/api/storage/memory` route, on an ephemeral
 * localhost port with a non-persistent store. Several runtimes — including
 * ones in Deno Workers or subprocesses — can share one storage backend
 * without a toolshed process. Used by multi-runtime test harnesses
 * (`cf test` multi-user mode, packages/patterns integration tests).
 *
 * A runtime addresses far more than storage at the host it is given: the
 * health probe every client opens with, the patterns route, the
 * language-model route, the blob routes. The health probe is answered here,
 * because this server is what occupies the address and so is what can say it
 * is up. The rest reach `serve`, and whatever the caller does not answer
 * there is told the one thing that is true of this address: it speaks the
 * memory websocket protocol, so upgrade. That is what a runtime asking a bare
 * storage host for a route it does not have hears, and it carries a status
 * that stops the answer being read as the thing that was asked for.
 *
 * It serves storage and nothing else: no serving loop runs here, so a runtime
 * in the server-execution ON posture that connects to it sends events nothing
 * delivers. `listenServingMemoryServer()` in
 * `@commonfabric/runner/executor/serving-memory-server.deno` co-hosts one on
 * {@link StandaloneMemoryServer.server}; it lives in the runner because the
 * serving loop does.
 *
 * Deno-only (uses `Deno.serve`); keep this export path out of browser
 * bundles.
 */

import { Identity } from "@commonfabric/identity";

import { encodeMemoryBoundary, getMemoryProtocolFlags } from "../v2.ts";
import {
  encodeMemoryCompressionControlMessage,
  isMemoryMessageFrame,
  MemoryMessageCompressionChannel,
  parseMemoryCompressionControlMessage,
} from "./message-compression.ts";
import * as MemoryServer from "./server.ts";
import { verifySessionOpenAuthorization } from "./session-open-auth.ts";

const standaloneMemoryAudience = (await Identity.fromPassphrase(
  "common tools standalone memory audience",
)).did();

// Session.open verification is shared with toolshed's memory route. The
// standalone server advertises a stable audience DID and requires the
// connection challenge issued in `hello.ok`.
const authorizeSessionOpen = (
  message: Parameters<typeof verifySessionOpenAuthorization>[0],
  context: Parameters<typeof verifySessionOpenAuthorization>[1],
): Promise<string> => verifySessionOpenAuthorization(message, context);

/** Where a client asks whether the host serving its space is reachable. */
const HEALTH_ROUTE = "/_health";

/**
 * The words the `426` below carries, for a reader rather than a parser.
 *
 * The citation names the repository before the path. A reader holding this
 * response has just learned that a path on this host is answered with it, so
 * a bare path invites the request that produced what they are reading.
 */
const UPGRADE_REQUIRED_BODY =
  `This is a Common Fabric memory endpoint. It speaks the memory protocol
over a websocket, so connect with an \`Upgrade: websocket\` request.
Nothing here answers the request you just sent.

The protocol is specified in the source repository, at
docs/specs/memory-v2/04-protocol.md.
`;

/**
 * What a plain HTTP request nothing else answered is told.
 *
 * `426` is the status for a server that will not answer over the protocol it
 * was asked in but would answer over another, and its `Upgrade` header names
 * that other one. It fits this address exactly: the websocket handshake is
 * itself a `GET`, so the method was never the problem — the missing `Upgrade`
 * header was.
 *
 * The body says as much in words, for whoever is holding the response rather
 * than parsing it: a person who reached the address with `curl`, or one
 * reading a log that printed what a fetch came back with.
 */
function upgradeRequired(): Response {
  return new Response(UPGRADE_REQUIRED_BODY, {
    status: 426,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      upgrade: "websocket",
      connection: "Upgrade",
    },
  });
}

let nextConnectionTag = 0;

export class StandaloneMemoryServer {
  #memory: MemoryServer.Server;
  #http: Deno.HttpServer;
  #channels: Set<MemoryMessageCompressionChannel>;
  readonly url: URL;

  private constructor(
    memory: MemoryServer.Server,
    http: Deno.HttpServer,
    channels: Set<MemoryMessageCompressionChannel>,
  ) {
    this.#memory = memory;
    this.#http = http;
    this.#channels = channels;
    const address = http.addr as Deno.NetAddr;
    this.url = new URL(`http://127.0.0.1:${address.port}/`);
  }

  static start(
    options: {
      /** Space ACL config, passed through to the memory server. Default:
       *  off (the historical wide-open behavior in-process tests expect). */
      acl?: {
        mode: MemoryServer.MemoryAclMode;
        serviceDids?: readonly string[];
      };

      /** Answers the non-websocket requests this address receives. Anything
       *  it declines, by answering `undefined`, is told to upgrade. */
      serve?: (
        request: Request,
      ) => Response | undefined | Promise<Response | undefined>;
    } = {},
  ): StandaloneMemoryServer {
    const memory = new MemoryServer.Server({
      authorizeSessionOpen,
      sessionOpenAuth: {
        audience: standaloneMemoryAudience,
      },
      acl: options.acl,
    });
    const channels = new Set<MemoryMessageCompressionChannel>();
    const http = Deno.serve({
      hostname: "127.0.0.1",
      port: 0,
      onListen: () => {},
    }, (request) => {
      if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
        if (new URL(request.url).pathname === HEALTH_ROUTE) {
          return Response.json({
            status: "OK",
            timestamp: Date.now(),
            gitSha: null,
          });
        }
        return Promise.resolve(options.serve?.(request)).then((response) =>
          response ?? upgradeRequired()
        );
      }
      const { socket, response } = Deno.upgradeWebSocket(request);
      socket.binaryType = "arraybuffer";
      const connectionTag = nextConnectionTag++;
      let compressionNegotiated = false;
      let helloReceived = false;
      let sawFirstMessage = false;
      let closed = false;
      const failChannel = () => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.close(1011, "memory websocket message failure");
        }
        closeConnection();
      };

      const channel = new MemoryMessageCompressionChannel((frame) => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(frame);
        }
      }, failChannel);
      channels.add(channel);
      const connection = memory.connect((message) => {
        channel.send(encodeMemoryBoundary(message));
        if (compressionNegotiated && message.type === "hello.ok") {
          channel.enable();
        }
      });
      function closeConnection(): void {
        if (closed) return;
        closed = true;
        channel.close();
        channels.delete(channel);
        connection.close();
      }
      const debugWrites = Deno.env.get("CF_DEBUG_MEMORY_WRITES") === "1";
      socket.addEventListener("message", (event) => {
        const frame = event.data;
        if (!isMemoryMessageFrame(frame)) {
          socket.close(
            1003,
            "memory websocket expects text or binary frames",
          );
          closeConnection();
          return;
        }
        if (!sawFirstMessage) {
          if (typeof frame !== "string") {
            socket.close(
              1003,
              "memory websocket expects text before negotiation",
            );
            closeConnection();
            return;
          }
          sawFirstMessage = true;
          const first = MemoryServer.parseClientMessage(frame);
          if (first?.type === "hello") {
            helloReceived = true;
            compressionNegotiated = first.flags.messageCompressionV1 === true &&
              getMemoryProtocolFlags().messageCompressionV1;
          }
        } else if (!compressionNegotiated && typeof frame !== "string") {
          socket.close(
            1003,
            "memory websocket expects text without compression negotiation",
          );
          closeConnection();
          return;
        }
        if (closed) return;
        channel.receive(frame, async (payload) => {
          const control = parseMemoryCompressionControlMessage(payload);
          if (control && helloReceived) {
            const enabled = compressionNegotiated && control.enabled;
            channel.setSendCompressionEnabled(enabled);
            channel.send(encodeMemoryCompressionControlMessage({
              requestId: control.requestId,
              enabled,
            }));
            return;
          }
          await connection.receive(payload);
          if (debugWrites) {
            logCommitOperations(connectionTag, payload);
          }
        });
      });
      socket.addEventListener("close", closeConnection);
      socket.addEventListener("error", closeConnection);
      return response;
    });
    return new StandaloneMemoryServer(memory, http, channels);
  }

  /**
   * The memory server behind the websocket. A caller co-hosting a serving
   * loop attaches its `ExecutorHost` here, and a runtime in this process may
   * connect to it in-process rather than over the socket.
   */
  get server(): MemoryServer.Server {
    return this.#memory;
  }

  /**
   * Drains received compression work, the underlying memory server, and sent
   * compression work in that order. Multi-runtime test harnesses call this as
   * the deterministic "the server has published everything" barrier in place
   * of a fixed delay.
   */
  async idle(): Promise<void> {
    await Promise.all([...this.#channels].map((channel) => channel.idle()));
    await this.#memory.idle();
    await Promise.all([...this.#channels].map((channel) => channel.idle()));
  }

  async close(): Promise<void> {
    await this.#http.shutdown();
    await this.#memory.close();
  }
}

// Best-effort per-commit write tracing (CF_DEBUG_MEMORY_WRITES=1): one line
// per operation with id + scope, the fastest way to see which scope partition
// a client's writes actually land in.
function logCommitOperations(connectionTag: number, payload: string): void {
  try {
    const parsed = MemoryServer.parseClientMessage(payload) as unknown as {
      commit?: { operations?: Array<Record<string, any>> };
    };
    const operations = parsed?.commit?.operations;
    if (!Array.isArray(operations)) return;
    for (const op of operations) {
      const detail = op?.op === "patch"
        ? ` paths=${
          JSON.stringify(
            (op.patches ?? []).map((p: { path?: string }) => p?.path),
          )
        }`
        : op?.op === "set"
        ? ` keys=${JSON.stringify(Object.keys(op.value?.value ?? {}))}`
        : "";
      console.error(
        `[memwrite conn=${connectionTag}] op=${op?.op} id=${
          String(op?.id).slice(0, 24)
        } scope=${op?.scope ?? "(space)"}${detail}`,
      );
    }
  } catch {
    // Logging only.
  }
}
