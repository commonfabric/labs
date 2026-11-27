/**
 * Two toolshed processes over one memory store, behind a proxy that routes
 * each space's memory socket to the toolshed owning it the way the
 * deployment's proxy does: a served run on one process sends an event into
 * a space owned by the other, and the event is served on its owner alone
 * (serving-loop.md §2). Each toolshed starts
 * from source in a process of its own, with `MEMORY_URL` naming the proxy.
 */

import { expect } from "@std/expect";
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
import {
  afterAll,
  beforeAll,
  describe,
  it,
} from "@commonfabric/test-support/test";

/** The passphrase a toolshed derives its service identity from. */
type PassphraseOf = (name: ToolshedName) => string;

/** One service identity for the deployment: both toolsheds derive the same. */
const SHARED_IDENTITY: PassphraseOf = () => "owner routing integration service";

/** An identity per toolshed, as a deployment behind the memory router runs. */
const IDENTITY_PER_TOOLSHED: PassphraseOf = (name) =>
  `owner routing integration service ${name}`;

/** The certificate and key a toolshed's private router endpoint listens with. */
const ROUTED_TLS = new URL(
  "../../memory/test/fixtures/routed-tls/",
  import.meta.url,
);

/** The characters an Ed25519 `did:key` can end with (base58btc). */
const BASE58_ALPHABET =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

const TOOLSHED_ENTRY = fromFileUrl(
  new URL("../../toolshed/index.ts", import.meta.url),
);

/** The two toolsheds, named for the spaces they own. */
type ToolshedName = "A" | "B";

/** The owner of a space, decided from its DID alone as the proxy's rule is. */
const ownerOf = (space: string): ToolshedName =>
  space.charCodeAt(space.length - 1) % 2 === 0 ? "A" : "B";

/** A toolshed process and the address it listens on. */
type Toolshed = {
  process: Deno.ChildProcess;
  url: URL;
  /** Resolves with the process's exit once it has been told to stop. */
  exited: Promise<Deno.CommandStatus>;
};

/**
 * Starts one toolshed from source on a system-assigned port, serving under server
 * execution with owner routing on, over `memoryDir`, reaching other spaces
 * through `memoryUrl`. Resolves once the process reports its listener,
 * which is the readiness event `scripts/start-local-dev.sh` waits for too.
 */
async function startToolshed(
  name: ToolshedName,
  memoryDir: URL,
  memoryUrl: URL,
  passphrase: string,
  environment: Record<string, string> = {},
): Promise<Toolshed> {
  // Both toolsheds use the proxy's bound public origin as their authority.
  // Their own listeners receive ports when they bind.
  const process = new Deno.Command(Deno.execPath(), {
    args: ["run", "--unstable-otel", "-A", TOOLSHED_ENTRY, "--port=0"],
    cwd: fromFileUrl(new URL("../../toolshed/", import.meta.url)),
    env: {
      HOST: "127.0.0.1",
      PORT: "0",
      API_URL: memoryUrl.href,
      MEMORY_DIR: memoryDir.href,
      MEMORY_URL: memoryUrl.href,
      IDENTITY_PASSPHRASE: passphrase,
      EXPERIMENTAL_SERVER_EXECUTION: "true",
      SERVER_EXECUTION_OWNER_ROUTING: "true",
      SERVER_EXECUTION_ENSURE_SPACE_ROOTS: "false",
      LOG_LEVEL: "warn",
      ...environment,
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

/**
 * A piece whose result is the `name` its `source` holds, or `"absent"` while
 * `source` holds none: the one on the home space, whose `source` is a
 * document in a space the other toolshed owns.
 */
const MIRROR_PATTERN = [
  "import { lift, pattern } from 'commonfabric';",
  "",
  "const nameOf = lift(",
  "  (input: { absent: string; source?: { name?: string } }) =>",
  "    input.source?.name ?? input.absent,",
  ");",
  "",
  "export default pattern<{ absent: string; source?: { name?: string } }>(",
  "  ({ absent, source }) => ({ name: nameOf({ absent, source }) }),",
  ");",
].join("\n");

const PROFILE_SCHEMA = {
  type: "object",
  properties: { name: { type: "string" } },
} as const satisfies JSONSchema;

const MIRROR_SCHEMA = { type: "string" } as const satisfies JSONSchema;

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

/**
 * A toolshed's health stats: the spaces its memory server has recorded a
 * commit in, and the crossings its serving loop sent through the route. A
 * toolshed reporting no serving loop is a failure, not a loop that sent
 * nothing.
 */
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
  if (stats.servingLoop === undefined) {
    throw new Error(`${toolshed.href} reports no serving loop`);
  }
  return {
    committedSpaces: (stats.commitRates?.spaces ?? []).map((entry) =>
      entry.space
    ),
    routed: stats.servingLoop.routed,
  };
}

/** Two toolsheds over one memory store, and the proxy routing between them. */
type Deployment = {
  /** The directory holding the store and the router's configuration. */
  root: string;
  proxy: ReturnType<typeof startProxy>;
  toolsheds: Record<ToolshedName, Toolshed>;
};

/**
 * Write the memory router's configuration for both toolsheds under `root`:
 * one directory that lists each toolshed's identity and places a space by
 * its DID's last character as `ownerOf` does, and a configuration file per
 * toolshed naming a private endpoint of its own. Returns the environment
 * each toolshed starts with. No router runs: the proxy stands in for the
 * public route, and what the toolsheds take from the configuration is the
 * directory.
 */
async function writeRouterConfiguration(
  root: string,
  passphraseOf: PassphraseOf,
): Promise<Record<ToolshedName, Record<string, string>>> {
  const names: ToolshedName[] = ["A", "B"];
  const deployment = "owner-routing";
  const router = await Identity.fromPassphrase(
    `owner-routing-router-${crypto.randomUUID()}`,
  );
  const directory = `${root}/directory.json`;
  await Deno.writeTextFile(
    directory,
    JSON.stringify({
      version: 1,
      deployment,
      toolsheds: await Promise.all(names.map(async (name) => ({
        did: (await Identity.fromPassphrase(passphraseOf(name))).did(),
      }))),
      spaces: {},
      unlisted: {
        epoch: 1,
        last_character: Object.fromEntries(
          [...BASE58_ALPHABET].map((
            character,
          ) => [character, names.indexOf(ownerOf(character))]),
        ),
      },
    }),
  );
  const environment = {} as Record<ToolshedName, Record<string, string>>;
  for (const name of names) {
    const path = `${root}/router-${name}.json`;
    await Deno.writeTextFile(
      path,
      JSON.stringify({
        version: 1,
        deployment,
        hostname: "127.0.0.1",
        port: 0,
        certificate: fromFileUrl(new URL("localhost.crt", ROUTED_TLS)),
        key: fromFileUrl(new URL("localhost.key", ROUTED_TLS)),
        directory,
        epochLedger: `${root}/epochs-${name}`,
        routers: { [router.did()]: ["127.0.0.1"] },
      }),
    );
    environment[name] = {
      MEMORY_ROUTER_CONFIG_FILE: path,
      MEMORY_ACL_MODE: "enforce",
    };
  }
  return environment;
}

/**
 * Start both toolsheds behind a proxy, each under the identity
 * `passphraseOf` gives it. With `routed`, each also takes the memory
 * router's configuration, whose directory lists both identities.
 */
async function startDeployment(
  passphraseOf: PassphraseOf,
  options: { routed?: boolean } = {},
): Promise<Deployment> {
  const root = await Deno.makeTempDir({ prefix: "owner-routing-" });
  const memoryDir = `${root}/memory`;
  await Deno.mkdir(memoryDir);
  const store = toFileUrl(`${memoryDir}/`);
  const environment = options.routed === true
    ? await writeRouterConfiguration(root, passphraseOf)
    : undefined;
  // The proxy's address is what each toolshed routes through, and the
  // proxy learns the toolsheds' addresses as they start: it consults
  // them per request, so neither has to come first.
  const addresses = {} as Record<ToolshedName, URL>;
  const proxy = startProxy(addresses);
  const [a, b] = await Promise.all([
    startToolshed("A", store, proxy.url, passphraseOf("A"), environment?.A),
    startToolshed("B", store, proxy.url, passphraseOf("B"), environment?.B),
  ]);
  addresses.A = a.url;
  addresses.B = b.url;
  return { root, proxy, toolsheds: { A: a, B: b } };
}

/** Stop both toolsheds and the proxy, and remove the store. */
async function stopDeployment(deployment: Deployment): Promise<void> {
  for (const toolshed of Object.values(deployment.toolsheds)) {
    toolshed.process.kill("SIGTERM");
  }
  await Promise.all(
    Object.values(deployment.toolsheds).map((toolshed) => toolshed.exited),
  );
  await deployment.proxy.close();
  await Deno.remove(deployment.root, { recursive: true });
}

/**
 * Creates and starts a piece on `space`'s owner, over the space's memory
 * session, as `cf piece new` creates one, and returns its id and result.
 */
async function instantiate(
  manager: StorageManager,
  runtime: Runtime,
  space: MemorySpace,
  contents: string,
  argument: Record<string, unknown>,
) {
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
}

/**
 * Sends an event to a forwarder on a space toolshed A owns, whose handler
 * sends it on into a counter on a space toolshed B owns, and expects the
 * counter's write to land and the crossing to have gone through the route.
 */
async function expectForwardedEventServedOnOwner(
  deployment: Deployment,
): Promise<void> {
  const alice = await Identity.fromPassphrase(
    `owner-routing-alice-${crypto.randomUUID()}`,
  );
  const manager = StorageManager.open({
    as: alice,
    memoryHost: deployment.proxy.url,
  });
  const runtime = new Runtime({
    apiUrl: deployment.proxy.url,
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
    memoryHost: deployment.proxy.url,
  });
  const reader = new Runtime({
    apiUrl: deployment.proxy.url,
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

    // The counter on B first, so the forwarder on A can name its stream.
    const counter = await instantiate(
      manager,
      runtime,
      target,
      COUNTER_PATTERN,
      {
        value: { n: 0 },
      },
    );
    const forwarder = await instantiate(
      manager,
      runtime,
      home,
      FORWARDER_PATTERN,
      {
        target: counter.piece.key("write").getAsLink(),
      },
    );
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
      healthStats(deployment.toolsheds.A.url),
      healthStats(deployment.toolsheds.B.url),
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
}

/**
 * Starts a piece on a space toolshed A owns whose computation reads a
 * document in a user's home space, which toolshed B owns and nobody has
 * created yet. Then the user's own client creates the space and writes the
 * document, and the computation's result is expected to follow: A's serving
 * loop read the space through B while it did not exist, so only B can tell
 * it what the user later wrote there.
 */
async function expectReadOfSpaceCreatedLater(
  deployment: Deployment,
): Promise<void> {
  const alice = await Identity.fromPassphrase(
    `owner-routing-alice-${crypto.randomUUID()}`,
  );
  // A user whose home space toolshed B owns: a DID decides its owner, so
  // identities are made until one lands there.
  let voter = await Identity.fromPassphrase(
    `owner-routing-voter-${crypto.randomUUID()}`,
  );
  while (ownerOf(voter.did()) !== "B") {
    voter = await Identity.fromPassphrase(
      `owner-routing-voter-${crypto.randomUUID()}`,
    );
  }
  const voterHome = voter.did() as MemorySpace;
  const experimental = (serverExecution: boolean) => ({
    ...withServerExecutionDefault(experimentalOptionsFromEnv(Deno.env.get)),
    serverExecution,
  });
  const manager = StorageManager.open({
    as: alice,
    memoryHost: deployment.proxy.url,
  });
  const runtime = new Runtime({
    apiUrl: deployment.proxy.url,
    experimental: experimental(true),
    storageManager: manager,
  });
  const readerManager = StorageManager.open({
    as: alice,
    memoryHost: deployment.proxy.url,
  });
  const reader = new Runtime({
    apiUrl: deployment.proxy.url,
    experimental: experimental(false),
    storageManager: readerManager,
  });
  const voterManager = StorageManager.open({
    as: voter,
    memoryHost: deployment.proxy.url,
  });
  const voterRuntime = new Runtime({
    apiUrl: deployment.proxy.url,
    experimental: experimental(false),
    storageManager: voterManager,
  });
  try {
    let home = await manager.createSpace({ [alice.did()]: "OWNER" });
    while (ownerOf(home) !== "A") {
      home = await manager.createSpace({ [alice.did()]: "OWNER" });
    }
    const profile = "owner-routing-profile";
    const mirror = await instantiate(manager, runtime, home, MIRROR_PATTERN, {
      absent: "absent",
      source: runtime.getCell(voterHome, profile, PROFILE_SCHEMA).getAsLink(),
    });
    const mirrored = reader.getCellFromEntityId(
      home,
      mirror.id,
      ["name"],
      MIRROR_SCHEMA,
    );

    // The computation ran on A over the space nobody has created.
    await waitForCellValue(
      reader,
      mirrored,
      (value: string | undefined) => value === "absent",
      { stuckLabel: "the computation's first read of the uncreated space" },
    );

    // The user's client creates the home space on B, writing its genesis
    // access list on opening it, then writes the document.
    await voterRuntime.editWithRetry((tx) =>
      voterRuntime.getCell(voterHome, profile, PROFILE_SCHEMA).withTx(tx).set(
        { name: "voter" },
      )
    );

    await waitForCellValue(
      reader,
      mirrored,
      (value: string | undefined) => value === "voter",
      { stuckLabel: "the computation to read the space its user created" },
    );
  } finally {
    await voterRuntime.dispose();
    await voterManager.close();
    await reader.dispose();
    await readerManager.close();
    await runtime.dispose();
    await manager.close();
  }
}

describe("owner-routing", () => {
  let deployment: Deployment;

  beforeAll(async () => {
    deployment = await startDeployment(SHARED_IDENTITY);
  });

  afterAll(async () => {
    await stopDeployment(deployment);
  });

  it("serves a run's event into a space owned by the other toolshed on that toolshed alone, routed through the proxy", async () => {
    await expectForwardedEventServedOnOwner(deployment);
  });

  it("serves a computation over a space the other toolshed owns that its user creates after the computation first reads it", async () => {
    await expectReadOfSpaceCreatedLater(deployment);
  });

  describe("with an identity per toolshed", () => {
    let deployment: Deployment;

    beforeAll(async () => {
      deployment = await startDeployment(IDENTITY_PER_TOOLSHED, {
        routed: true,
      });
    });

    afterAll(async () => {
      await stopDeployment(deployment);
    });

    it("serves a run's event into a space owned by the other toolshed on that toolshed alone", async () => {
      await expectForwardedEventServedOnOwner(deployment);
    });

    it("serves a computation over a space the other toolshed owns that its user creates after the computation first reads it", async () => {
      await expectReadOfSpaceCreatedLater(deployment);
    });
  });
});
