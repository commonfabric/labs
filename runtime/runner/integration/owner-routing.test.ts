/**
 * Two toolshed processes over one memory store, behind a proxy that routes
 * each space's memory socket to the toolshed owning it the way the
 * deployment's proxy does: a served run on one process sends an event into
 * a space owned by the other, and the event is served on its owner alone
 * (docs/plans/serving-loop-owner-routing.md, stage R4). Each toolshed starts
 * from source in a process of its own, with `MEMORY_URL` naming the proxy.
 */

import { expect } from "@std/expect";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { fromFileUrl, toFileUrl } from "@std/path";
import { defer } from "@commonfabric/async/defer";
import type { FabricPlainObject } from "@commonfabric/data-model";
import { Identity } from "@commonfabric/identity";
import { waitForCellValue } from "@commonfabric/integration/wait-for-cell-value";
import {
  entityIdFrom,
  experimentalOptionsFromEnv,
  type JSONSchema,
  type MemorySpace,
  Runtime,
  withServerExecutionDefault,
} from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

/** The passphrase both toolsheds derive the deployment's one service identity from. */
const SERVICE_PASSPHRASE = "owner routing integration service";

const TOOLSHED_ENTRY = fromFileUrl(
  new URL("../../toolshed/index.ts", import.meta.url),
);

/** The two toolsheds, named for the spaces they own. */
type ToolshedName = "A" | "B";

/** The owner of a space, decided from its DID alone as the proxy's rule is. */
const ownerOf = (space: string): ToolshedName =>
  space.charCodeAt(space.length - 1) % 2 === 0 ? "A" : "B";

/** A port the system had free at the time of asking. */
function freePort(): number {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const { port } = listener.addr as Deno.NetAddr;
  listener.close();
  return port;
}

/** A toolshed process and the address it listens on. */
type Toolshed = {
  process: Deno.ChildProcess;
  url: URL;
  /** Resolves with the process's exit once it has been told to stop. */
  exited: Promise<Deno.CommandStatus>;
};

/**
 * Start one toolshed from source on a free port, serving under server
 * execution with owner routing on, over `memoryDir`, reaching other spaces
 * through `memoryUrl`. Resolves once the process reports its listener,
 * which is the readiness event `scripts/start-local-dev.sh` waits for too.
 */
async function startToolshed(
  name: ToolshedName,
  memoryDir: URL,
  memoryUrl: URL,
): Promise<Toolshed> {
  // The process's own address is in its environment before it starts, as
  // the first-party authority its signed routes check against, so its port
  // is chosen here: one the system had free a moment ago.
  const port = freePort();
  const process = new Deno.Command(Deno.execPath(), {
    args: ["run", "--unstable-otel", "-A", TOOLSHED_ENTRY, `--port=${port}`],
    cwd: fromFileUrl(new URL("../../toolshed/", import.meta.url)),
    env: {
      HOST: "127.0.0.1",
      PORT: String(port),
      API_URL: `http://127.0.0.1:${port}`,
      MEMORY_DIR: memoryDir.href,
      MEMORY_URL: memoryUrl.href,
      IDENTITY_PASSPHRASE: SERVICE_PASSPHRASE,
      EXPERIMENTAL_SERVER_EXECUTION: "true",
      SERVER_EXECUTION_OWNER_ROUTING: "true",
      SERVER_EXECUTION_ENSURE_SPACE_ROOTS: "false",
      LOG_LEVEL: "warn",
    },
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  // Everything the process says is kept, so a failure can show it, and the
  // listener line is the one the start waits for.
  const transcript: string[] = [];
  const listening = defer<URL>();
  const read = async (stream: ReadableStream<Uint8Array<ArrayBuffer>>) => {
    let pending = "";
    for await (const chunk of stream.pipeThrough(new TextDecoderStream())) {
      pending += chunk;
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        transcript.push(`[toolshed ${name}] ${line}`);
        const match = line.match(/Server running on (http:\/\/\S+)/);
        if (match !== null) listening.resolve(new URL(match[1]));
      }
    }
  };
  const output = Promise.all([read(process.stdout), read(process.stderr)]);
  const exited = process.status.then(async (status) => {
    await output;
    return status;
  });
  // A process that exits before it listens is a start failure, reported
  // with what it said.
  void exited.then((status) =>
    listening.reject(
      new Error(
        `toolshed ${name} exited with code ${status.code} before listening:\n` +
          transcript.join("\n"),
      ),
    )
  );
  const url = await listening.promise;
  return { process, url, exited };
}

/**
 * A proxy that sends each memory socket to the toolshed owning the space
 * its `space` query names, and every other request to toolshed A, as the
 * deployment's proxy sends each space's socket to its owner.
 */
function startProxy(toolsheds: Record<ToolshedName, URL>): {
  url: URL;
  close: () => Promise<void>;
} {
  const sockets = new Set<WebSocket>();
  const upstreamOf = (request: Request): URL => {
    const requested = new URL(request.url);
    const space = requested.searchParams.get("space");
    const upstream = new URL(
      toolsheds[space === null ? "A" : ownerOf(space)],
    );
    upstream.pathname = requested.pathname;
    upstream.search = requested.search;
    return upstream;
  };
  const server = Deno.serve({
    hostname: "127.0.0.1",
    port: 0,
    onListen: () => {},
  }, (request) => {
    const upstream = upstreamOf(request);
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return fetch(upstream, {
        method: request.method,
        headers: request.headers,
        body: request.body,
      });
    }
    const { socket, response } = Deno.upgradeWebSocket(request);
    upstream.protocol = "ws:";
    const remote = new WebSocket(upstream);
    socket.binaryType = "arraybuffer";
    remote.binaryType = "arraybuffer";
    sockets.add(socket);
    sockets.add(remote);
    // Frames the client sends before the upstream socket is open wait for it.
    const queued: (string | ArrayBuffer)[] = [];
    remote.onopen = () => {
      for (const frame of queued) remote.send(frame);
      queued.length = 0;
    };
    socket.onmessage = (event) => {
      if (remote.readyState === WebSocket.OPEN) remote.send(event.data);
      else queued.push(event.data);
    };
    remote.onmessage = (event) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(event.data);
    };
    const closeBoth = (code: number, reason: string) => {
      // A close code a socket may send on; the others are reported, not sent.
      const sendable = code === 1000 || (code >= 3000 && code <= 4999)
        ? code
        : 1000;
      for (const each of [socket, remote]) {
        if (
          each.readyState === WebSocket.OPEN ||
          each.readyState === WebSocket.CONNECTING
        ) each.close(sendable, reason);
        sockets.delete(each);
      }
    };
    socket.onclose = (event) => closeBoth(event.code, event.reason);
    remote.onclose = (event) => closeBoth(event.code, event.reason);
    socket.onerror = () => closeBoth(1000, "client socket failed");
    remote.onerror = () => closeBoth(1000, "upstream socket failed");
    return response;
  });
  return {
    url: new URL(`http://127.0.0.1:${server.addr.port}/`),
    close: async () => {
      for (const each of sockets) each.close();
      await server.shutdown();
    },
  };
}

/**
 * A piece whose handler writes the number it is sent into its own `value`:
 * the one on the target space, whose write stays in the space it is in.
 */
const COUNTER_PATTERN = [
  "import { handler, pattern } from 'commonfabric';",
  "",
  "const write = handler(",
  "  { type: 'object', properties: { n: { type: 'number' } }, required: ['n'] },",
  "  {",
  "    type: 'object',",
  "    properties: {",
  "      value: {",
  "        type: 'object',",
  "        properties: { n: { type: 'number' } },",
  "        asCell: ['cell'],",
  "      },",
  "    },",
  "    required: ['value'],",
  "  },",
  "  ({ n }, { value }) => {",
  "    value.set({ n });",
  "  },",
  ");",
  "",
  "export default pattern<",
  "  { value: { n: number } },",
  "  { value: { n: number }; write: { n: number } }",
  ">(({ value }) => ({ value, write: write({ value }) }));",
].join("\n");

/**
 * A piece whose handler sends the number it is sent on into the stream its
 * `target` names: the one on the home space, whose send into the counter's
 * stream on the other space is the crossing (protocol.md §2b, the only
 * mutation of another space a served run makes).
 */
const FORWARDER_PATTERN = [
  "import { handler, pattern } from 'commonfabric';",
  "",
  "const forward = handler(",
  "  { type: 'object', properties: { n: { type: 'number' } }, required: ['n'] },",
  "  {",
  "    type: 'object',",
  "    properties: {",
  "      target: {",
  "        type: 'object',",
  "        properties: { n: { type: 'number' } },",
  "        asCell: ['stream'],",
  "      },",
  "    },",
  "    required: ['target'],",
  "  },",
  "  ({ n }, { target }) => {",
  "    target.send({ n });",
  "  },",
  ");",
  "",
  "export default pattern<",
  "  { target: { n: number } },",
  "  { write: { n: number } }",
  ">(({ target }) => ({ write: forward({ target }) }));",
].join("\n");

const COUNTER_SCHEMA = {
  type: "object",
  properties: { n: { type: "number" } },
  required: ["n"],
} as const satisfies JSONSchema;

/** The shape of either piece's result: the stream its handler is sent on,
 * and, on the counter, the value it writes. */
const RESULT_SCHEMA = {
  type: "object",
  properties: {
    value: COUNTER_SCHEMA,
    write: {
      type: "object",
      properties: { n: { type: "number" } },
      asCell: ["stream"],
    },
  },
  required: ["write"],
} as const satisfies JSONSchema;

/** A toolshed's health stats: the spaces its memory server has recorded a
 * commit in, and the crossings its serving loop sent through the route. */
async function healthStats(toolshed: URL): Promise<{
  committedSpaces: string[];
  routed: { appends: number; batches: number; aclChanges: number };
}> {
  const response = await fetch(new URL("/api/health/stats", toolshed));
  const stats = await response.json() as {
    commitRates?: { spaces: { space: string }[] };
    servingLoop?: {
      routed: { appends: number; batches: number; aclChanges: number };
    };
  };
  return {
    committedSpaces: (stats.commitRates?.spaces ?? []).map((entry) =>
      entry.space
    ),
    routed: stats.servingLoop?.routed ??
      { appends: 0, batches: 0, aclChanges: 0 },
  };
}

describe("owner-routing", () => {
  let memoryDir: string;
  let proxy: ReturnType<typeof startProxy>;
  const toolsheds = {} as Record<ToolshedName, Toolshed>;

  beforeAll(async () => {
    memoryDir = await Deno.makeTempDir({ prefix: "owner-routing-memory-" });
    const store = toFileUrl(`${memoryDir}/`);
    // The proxy's address is what each toolshed routes through, and the
    // proxy learns the toolsheds' addresses as they start: it consults
    // them per request, so neither has to come first.
    const addresses = {} as Record<ToolshedName, URL>;
    proxy = startProxy(addresses);
    const [a, b] = await Promise.all([
      startToolshed("A", store, proxy.url),
      startToolshed("B", store, proxy.url),
    ]);
    toolsheds.A = a;
    toolsheds.B = b;
    addresses.A = a.url;
    addresses.B = b.url;
  });

  afterAll(async () => {
    for (const toolshed of Object.values(toolsheds)) {
      toolshed.process.kill("SIGTERM");
    }
    await Promise.all(
      Object.values(toolsheds).map((toolshed) => toolshed.exited),
    );
    await proxy.close();
    await Deno.remove(memoryDir, { recursive: true });
  });

  it("serves a run's event into a space owned by the other toolshed on that toolshed alone, routed through the proxy", async () => {
    const alice = await Identity.fromPassphrase(
      `owner-routing-alice-${crypto.randomUUID()}`,
    );
    const manager = StorageManager.open({
      as: alice,
      memoryHost: proxy.url,
    });
    const runtime = new Runtime({
      apiUrl: toolsheds.A.url,
      // The toolsheds serve whatever lane this process runs in, so the
      // client runs the served posture outright: its event goes to the
      // piece's owner rather than running here.
      experimental: {
        ...withServerExecutionDefault(experimentalOptionsFromEnv(Deno.env.get)),
        serverExecution: true,
      },
      storageManager: manager,
    });
    // The sending client answers its own event at once from its speculation
    // overlay, so what landed is read by a client that sent nothing.
    const readerManager = StorageManager.open({
      as: alice,
      memoryHost: proxy.url,
    });
    const reader = new Runtime({
      apiUrl: toolsheds.A.url,
      experimental: {
        ...withServerExecutionDefault(experimentalOptionsFromEnv(Deno.env.get)),
        serverExecution: false,
      },
      storageManager: readerManager,
    });
    try {
      // One space owned by each toolshed: the home of the forwarder on A,
      // and the target space of the counter on B. A fresh space's DID
      // decides its owner, so spaces are created until each toolshed owns
      // one.
      const spaces: Partial<Record<ToolshedName, MemorySpace>> = {};
      while (spaces.A === undefined || spaces.B === undefined) {
        const space = await manager.createSpace({ [alice.did()]: "OWNER" });
        spaces[ownerOf(space)] ??= space;
      }
      const home = spaces.A;
      const target = spaces.B;

      // Each piece is created and started on its space's owner, over the
      // space's memory session, as `cf piece new` creates one: the counter
      // on B first, so the forwarder on A can name its stream.
      const instantiate = async (
        space: MemorySpace,
        contents: string,
        argument: Record<string, unknown>,
      ) => {
        const receipt = await manager.runPatternLifecycle(
          space,
          "instantiate",
          {
            program: {
              main: "/main.tsx",
              files: [{ name: "/main.tsx", contents }],
            },
            argument,
          } as FabricPlainObject,
        ) as { pieceId: string };
        const id = entityIdFrom(receipt.pieceId);
        const piece = runtime.getCellFromEntityId(space, id, [], RESULT_SCHEMA);
        await piece.sync();
        return { id, piece };
      };
      const counter = await instantiate(target, COUNTER_PATTERN, {
        value: { n: 0 },
      });
      const forwarder = await instantiate(home, FORWARDER_PATTERN, {
        target: counter.piece.key("write").getAsLink(),
      });
      await runtime.editWithRetry((tx) =>
        forwarder.piece.key("write").withTx(tx).send({ n: 7 })
      );

      // The forwarder ran on A, the home's owner, and its send reached the
      // counter on B, the target's owner, whose handler wrote the number
      // where the reader reads it.
      await waitForCellValue(
        reader,
        reader.getCellFromEntityId(
          target,
          counter.id,
          ["value"],
          COUNTER_SCHEMA,
        ),
        (value: { n: number } | undefined) => value?.n === 7,
        {
          stuckLabel: "the forwarded event to be served on the target's owner",
        },
      );

      // The forwarder's send crossed as an append that A's loop sent to B
      // through the route, and B's loop sent nothing: the crossing went
      // one way. With routing off, A would have appended to the shared
      // store itself and counted nothing.
      const [statsA, statsB] = await Promise.all([
        healthStats(toolsheds.A.url),
        healthStats(toolsheds.B.url),
      ]);
      expect(statsA.routed.appends).toBeGreaterThanOrEqual(1);
      expect(statsB.routed).toEqual({ appends: 0, batches: 0, aclChanges: 0 });
      expect(statsA.committedSpaces).toContain(home);
      expect(statsB.committedSpaces).toContain(target);
    } finally {
      await reader.dispose();
      await readerManager.close();
      await runtime.dispose();
      await manager.close();
    }
  });
});
