/**
 * Two toolshed processes over one memory store, behind a proxy that routes
 * each space's memory socket to the toolshed owning it the way the
 * deployment's proxy does: a served run on one process writes into a space
 * owned by the other, and the write lands on its owner alone
 * (docs/plans/serving-loop-owner-routing.md, stage R4). Each toolshed starts
 * from source in a process of its own, with `MEMORY_URL` naming the proxy.
 */

import { expect } from "@std/expect";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { fromFileUrl, toFileUrl } from "@std/path";
import { defer } from "@commonfabric/async/defer";
import { Identity } from "@commonfabric/identity";
import { waitForCellValue } from "@commonfabric/integration/wait-for-cell-value";
import {
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
  const read = async (stream: ReadableStream<Uint8Array>) => {
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

/** A piece whose handler writes the number it is sent into its `target` cell. */
const WRITER_PATTERN = [
  "import { handler, pattern } from 'commonfabric';",
  "",
  "const write = handler(",
  "  { type: 'object', properties: { n: { type: 'number' } }, required: ['n'] },",
  "  {",
  "    type: 'object',",
  "    properties: {",
  "      target: {",
  "        type: 'object',",
  "        properties: { n: { type: 'number' } },",
  "        asCell: ['cell'],",
  "      },",
  "    },",
  "    required: ['target'],",
  "  },",
  "  ({ n }, { target }) => {",
  "    target.set({ n });",
  "  },",
  ");",
  "",
  "export default pattern<",
  "  { target: { n: number } },",
  "  { write: { n: number } }",
  ">(({ target }) => ({ write: write({ target }) }));",
].join("\n");

const COUNTER_SCHEMA = {
  type: "object",
  properties: { n: { type: "number" } },
  required: ["n"],
} as const satisfies JSONSchema;

const RESULT_SCHEMA = {
  type: "object",
  properties: {
    write: {
      type: "object",
      properties: { n: { type: "number" } },
      asCell: ["stream"],
    },
  },
  required: ["write"],
} as const satisfies JSONSchema;

/** The spaces a toolshed's memory server has recorded a commit in. */
async function committedSpaces(toolshed: URL): Promise<string[]> {
  const response = await fetch(new URL("/api/health/stats", toolshed));
  const stats = await response.json() as {
    commitRates?: { spaces: { space: string }[] };
  };
  return (stats.commitRates?.spaces ?? []).map((entry) => entry.space);
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

  it("lands a served run's write into a space owned by the other toolshed on that toolshed alone, routed through the proxy", async () => {
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
      // client runs the served posture outright.
      experimental: {
        ...withServerExecutionDefault(experimentalOptionsFromEnv(Deno.env.get)),
        serverExecution: true,
      },
      storageManager: manager,
    });
    try {
      // One space owned by each toolshed: the home of the piece on A, and
      // the target of its handler's write on B. A fresh space's DID decides
      // its owner, so spaces are created until each toolshed owns one.
      const spaces: Partial<Record<ToolshedName, MemorySpace>> = {};
      while (spaces.A === undefined || spaces.B === undefined) {
        const space = await manager.createSpace({ [alice.did()]: "OWNER" });
        spaces[ownerOf(space)] ??= space;
      }
      const home = spaces.A;
      const target = spaces.B;

      // The target cell exists on its owner before the piece names it.
      const targetCell = runtime.getCell(
        target,
        "routed-target",
        COUNTER_SCHEMA,
      );
      await runtime.editWithRetry((tx) => targetCell.withTx(tx).set({ n: 0 }));
      await manager.synced();

      const compiled = await runtime.patternManager.compilePattern(
        WRITER_PATTERN,
        { space: home },
      );
      const resultCell = runtime.getCell(
        home,
        "routed-writer",
        compiled.resultSchema,
      );
      const result = await runtime.runSynced(resultCell, compiled, {
        target: targetCell,
      });
      const shaped = result.asSchema(RESULT_SCHEMA);
      await runtime.editWithRetry((tx) =>
        shaped.key("write").withTx(tx).send({ n: 7 })
      );

      // The handler ran on A, the home's owner, and its write into the
      // target reached B, the target's owner, which is where the client
      // reads it.
      await waitForCellValue(
        runtime,
        targetCell,
        (value: { n: number } | undefined) => value?.n === 7,
        { stuckLabel: "the routed write to reach the target's owner" },
      );

      // The target's commits were recorded on its owner and on no other
      // process: the sender's memory server admitted nothing in it.
      expect(await committedSpaces(toolsheds.B.url)).toContain(target);
      expect(await committedSpaces(toolsheds.A.url)).not.toContain(target);
      expect(await committedSpaces(toolsheds.A.url)).toContain(home);
    } finally {
      await runtime.dispose();
      await manager.close();
    }
  });
});
