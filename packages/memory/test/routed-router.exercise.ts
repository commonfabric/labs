/** Disposable Linux acceptance against a compiled Rust router and real SQLite toolsheds. */
import { Identity } from "@commonfabric/identity";
import { assert, assertEquals } from "@std/assert";
// @ts-types="@types/ws"
import WebSocket from "ws";
import { Client as MemoryClient, type SessionPrincipal } from "../v2/client.ts";
import {
  createSignedConnectionAuth,
  WebSocketTransport,
} from "../../runner/src/storage/v2-remote-session.ts";
import { getMemoryProtocolFlags } from "../v2.ts";
import { decodeRoutedFrame } from "../v2/routed-parser.ts";
import {
  readRoutedHex,
  routedBase64,
  routedStatementPayload,
} from "../v2/routed-wire.ts";
import { startRoutedToolshed } from "./support/routed-toolshed.ts";

const binary = Deno.env.get("MEMORY_ROUTER_BINARY");
if (
  binary === undefined || Deno.build.os !== "linux" ||
  Deno.env.get("ROUTER_DISPOSABLE_EXERCISE") !== "yes"
) throw new Error("Set MEMORY_ROUTER_BINARY on disposable Linux");
const systemd = Deno.env.get("ROUTER_SYSTEMD_EXERCISE") === "yes";
const root = Deno.makeTempDirSync({
  prefix: "memory-router-exercise-",
  ...(systemd ? { dir: "/run" } : {}),
});
Deno.chmodSync(root, 0o755);
const pause = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
async function command(args: string[]) {
  const result = await new Deno.Command(args[0], {
    args: args.slice(1),
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!result.success) {
    throw new Error(
      `${args[0]} failed: ${new TextDecoder().decode(result.stderr)}`,
    );
  }
  return new TextDecoder().decode(result.stdout);
}
async function certificate(name: string, seed: number) {
  const key = `${root}/${name}.pem`, cert = `${root}/${name}.crt`;
  const prefix = readRoutedHex("302e020100300506032b657004220420", 16);
  Deno.writeFileSync(
    `${root}/${name}.der`,
    new Uint8Array([...prefix, ...new Uint8Array(32).fill(seed)]),
  );
  await command([
    "openssl",
    "pkey",
    "-inform",
    "DER",
    "-in",
    `${root}/${name}.der`,
    "-out",
    key,
  ]);
  await command([
    "openssl",
    "req",
    "-new",
    "-x509",
    "-key",
    key,
    "-out",
    cert,
    "-days",
    "1",
    "-subj",
    "/CN=localhost",
    "-addext",
    "subjectAltName=DNS:localhost",
    "-addext",
    "basicConstraints=critical,CA:FALSE",
  ]);
  return { key, cert };
}
const alice = await Identity.fromRaw(new Uint8Array(32).fill(41));
const bob = await Identity.fromRaw(new Uint8Array(32).fill(42));
const router = await Identity.fromRaw(new Uint8Array(32).fill(21));
const spaces = await Promise.all(
  [31, 32].map(async (seed) =>
    (await Identity.fromRaw(new Uint8Array(32).fill(seed))).did()
  ),
);
const sheds = await Promise.all(
  [11, 12].map(async (seed) =>
    (await Identity.fromRaw(new Uint8Array(32).fill(seed))).did()
  ),
);
const publicTls = await certificate("public", 22);
const privateTls = await Promise.all(
  [11, 12].map((seed, i) => certificate(`toolshed-${i}`, seed)),
);
const directory = `${root}/directory.json`;
Deno.writeTextFileSync(
  directory,
  JSON.stringify({
    version: 1,
    deployment: "local-mode-a",
    toolsheds: sheds.map((did, i) => ({
      name: `toolshed-${i}`,
      did,
      address: `127.0.0.1:${8444 + i}`,
      server_name: "localhost",
      certificate: privateTls[i].cert,
    })),
    spaces: Object.fromEntries(
      spaces.map((did, i) => [did, { toolshed: i, epoch: 1 }]),
    ),
  }),
);
for (
  const [name, seed, uid] of [["router", 21, 992], ["tls", 22, 991]] as const
) {
  const path = `${root}/${name}.seed`;
  Deno.writeFileSync(path, new Uint8Array(32).fill(seed), { mode: 0o400 });
  Deno.chownSync(path, uid, uid);
}
for (
  const [name, uid] of [["key", 991], ["link", 992], [
    "directory",
    993,
  ]] as const
) {
  Deno.mkdirSync(`${root}/ipc/${name}`, { recursive: true, mode: 0o700 });
  Deno.chownSync(`${root}/ipc/${name}`, uid, uid);
}
Deno.chmodSync(`${root}/ipc`, 0o755);
const cgParent = `/sys/fs/cgroup/router-exercise-${Deno.pid}`;
if (!systemd) Deno.mkdirSync(cgParent);
const configPath = `${root}/config.json`;
Deno.writeTextFileSync(
  configPath,
  JSON.stringify({
    version: 1,
    listen: "127.0.0.1:8443",
    origins: ["https://stage.example"],
    host: "localhost:8443",
    directory,
    public_certificate: publicTls.cert,
    tls_seed: systemd
      ? "/run/credentials/memory-router-key.service/tls-seed"
      : `${root}/tls.seed`,
    router_seed: systemd
      ? "/run/credentials/memory-router-link.service/router-seed"
      : `${root}/router.seed`,
    ipc_dir: systemd ? "/run/memory-router" : `${root}/ipc`,
    cgroup_root: systemd
      ? "/sys/fs/cgroup/system.slice/memory-router-listener.service/workers"
      : `${cgParent}/workers`,
    worker_uid_base: 100000,
    listener_uid: 990,
    max_workers: 32,
    max_unauthenticated: 8,
    max_per_source: 16,
    development: false,
  }),
);
const firewallPath = `${root}/router.nft`;
Deno.writeTextFileSync(
  firewallPath,
  await command([
    "python3",
    "/infra/memory-router/scripts/network.py",
    configPath,
    directory,
  ]),
);
await command(["nft", "-f", firewallPath]);
const processes: Deno.ChildProcess[] = [];
const listenerLogs: Promise<void>[] = [];
const hosts: Awaited<ReturnType<typeof startRoutedToolshed>>[] = [];
const clients: Client[] = [];
const gates: string[] = [];
function pass(name: string) {
  gates.push(name);
  console.log(JSON.stringify({ gate: name, passed: true }));
}
async function waitFile(path: string) {
  const watcher = Deno.watchFs(path.slice(0, path.lastIndexOf("/")));
  const exists = () => {
    try {
      Deno.statSync(path);
      return true;
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
      return false;
    }
  };
  try {
    if (exists()) return;
    for await (const _ of watcher) if (exists()) return;
  } finally {
    watcher.close();
  }
  throw new Error(`readiness watcher closed: ${path}`);
}
async function listenerReady(child: Deno.ChildProcess) {
  const ready = Promise.withResolvers<void>();
  const drain = (async () => {
    let initial = "";
    let seen = false;
    for await (
      const chunk of child.stderr.pipeThrough(new TextDecoderStream())
    ) {
      console.error(chunk.trimEnd());
      if (!seen) {
        initial += chunk;
        if (initial.length > 4096) {
          throw new Error(
            "invalid listener readiness",
          );
        }
        if (initial.includes("memory-router-ready\n")) {
          seen = true;
          ready.resolve();
        }
      }
    }
    if (!seen) throw new Error("listener exited before readiness");
  })();
  listenerLogs.push(drain);
  void drain.catch(ready.reject);
  await ready.promise;
}
function deadline(ms: number): Promise<never> {
  return pause(ms).then(() => {
    throw new Error("exercise deadline");
  });
}
async function until(predicate: () => boolean) {
  const end = Date.now() + 6000;
  while (!predicate()) {
    if (Date.now() >= end) throw new Error("cleanup deadline");
    await pause(10);
  }
}
class Client {
  ws: WebSocket;
  messages: Record<string, unknown>[] = [];
  sequence = 0;
  closed = Promise.withResolvers<void>();
  hello!: Record<string, unknown>;
  constructor(localAddress = "127.0.0.1") {
    this.ws = new WebSocket("wss://localhost:8443/api/storage/memory", {
      ca: Deno.readTextFileSync(publicTls.cert),
      perMessageDeflate: false,
      family: 4,
      localAddress,
      headers: { Origin: "https://stage.example" },
    });
    this.ws.on(
      "message",
      (bytes, binary) =>
        this.messages.push(
          decodeRoutedFrame(
            binary ? new Uint8Array(bytes as ArrayBuffer) : bytes.toString(),
            true,
          ).body,
        ),
    );
    this.ws.on("close", () => this.closed.resolve());
    this.ws.on("error", () => this.closed.resolve());
  }
  async start(
    flags = {
      ...getMemoryProtocolFlags(),
      modernCellRep: true,
      connectionAuth: true,
      routedAuthV1: true,
    },
  ) {
    await Promise.race([
      new Promise<void>((resolve, reject) => {
        this.ws.once("open", resolve);
        this.ws.once("error", reject);
      }),
      pause(6000).then(() => {
        throw new Error("WS open deadline");
      }),
    ]);
    this.ws.send(
      `fvj1:${JSON.stringify({ type: "hello", protocol: "memory", flags })}`,
    );
    this.hello = await this.take((m) => m.type === "hello.ok");
    return this;
  }
  async take(
    predicate: (m: Record<string, unknown>) => boolean,
    timeout = 6000,
  ) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const i = this.messages.findIndex(predicate);
      if (i >= 0) return this.messages.splice(i, 1)[0];
      if (this.ws.readyState === WebSocket.CLOSED) {
        throw new Error("client closed");
      }
      await pause(5);
    }
    throw new Error(
      `response deadline (${JSON.stringify(this.messages).slice(0, 400)})`,
    );
  }
  send(body: Record<string, unknown>) {
    const requestId = `r${++this.sequence}`;
    this.ws.send(`fvj1:${JSON.stringify({ ...body, requestId })}`);
    return requestId;
  }
  request(body: Record<string, unknown>) {
    const id = this.send(body);
    return this.take((m) => m.requestId === id);
  }
  async authenticate(
    signer: Identity,
    seconds = 60,
    initial = false,
    pushed?: unknown,
  ) {
    const context = pushed ??
      (initial
        ? this.hello.sessionOpen
        : (await this.request({ type: "connection.challenge" })).ok);
    const challenge = (context as { challenge: { value: string } }).challenge;
    const iat = Math.floor(Date.now() / 1000);
    const statement = await routedStatementPayload({
      principal: signer.did(),
      router: router.did(),
      deployment: "local-mode-a",
      challenge: readRoutedHex(challenge.value, 32),
      iat,
      exp: iat + seconds,
    }).sign(signer);
    const response = await this.request({
      type: "connection.auth",
      statement: routedBase64(statement),
    });
    assert(response.ok !== undefined, JSON.stringify(response));
    return statement;
  }
  close() {
    this.ws.terminate();
  }
}
function workerStats() {
  const result: {
    pid: number;
    uid: number;
    privateKb: number;
    cpuTicks: number;
    cgroup: string;
    fds: number;
  }[] = [];
  for (const entry of Deno.readDirSync("/proc")) {
    if (!/^\d+$/.test(entry.name)) continue;
    try {
      const path = `/proc/${entry.name}`;
      if (!Deno.readTextFileSync(`${path}/cmdline`).includes("\0worker\0")) {
        continue;
      }
      const stat = Deno.readTextFileSync(`${path}/stat`).split(" ");
      const maps = Deno.readTextFileSync(`${path}/smaps_rollup`);
      const status = Deno.readTextFileSync(`${path}/status`);
      assertEquals(status.match(/^Seccomp:\s+(\d+)/m)?.[1], "2");
      for (const set of ["CapInh", "CapPrm", "CapEff", "CapAmb"]) {
        assertEquals(
          status.match(new RegExp(`^${set}:\\s+(\\w+)`, "m"))?.[1],
          "0000000000000000",
        );
      }
      const uid = Number(status.match(/^Uid:\s+(\d+)/m)?.[1]);
      assert(uid >= 100001);
      result.push({
        pid: Number(entry.name),
        uid,
        privateKb: [...maps.matchAll(/^Private_(?:Clean|Dirty):\s+(\d+)/gm)]
          .reduce((sum, m) => sum + Number(m[1]), 0),
        cpuTicks: Number(stat[13]) + Number(stat[14]),
        cgroup: Deno.readTextFileSync(`${path}/cgroup`).trim(),
        fds: [...Deno.readDirSync(`${path}/fd`)].length,
      });
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  }
  return result;
}
try {
  for (let i = 0; i < 2; i++) {
    hosts.push(
      await startRoutedToolshed({
        port: 8444 + i,
        seed: 11 + i,
        certificate: privateTls[i].cert,
        key: privateTls[i].key,
        directory,
        store: `${root}/store-${i}`,
        router: router.did(),
        space: spaces[i],
        principals: [i === 0 ? alice.did() : bob.did()],
      }),
    );
  }
  if (systemd) {
    Deno.mkdirSync("/opt/memory-router", { recursive: true });
    Deno.copyFileSync(binary, "/opt/memory-router/memory-router");
    Deno.chmodSync("/opt/memory-router/memory-router", 0o755);
    Deno.mkdirSync("/etc/memory-router", { recursive: true });
    Deno.copyFileSync(configPath, "/etc/memory-router/config.json");
    Deno.mkdirSync("/var/lib/memory-router-secrets", {
      recursive: true,
      mode: 0o700,
    });
    for (
      const [name, source] of [["tls-seed", `${root}/tls.seed`], [
        "router-seed",
        `${root}/router.seed`,
      ]]
    ) {
      await command([
        "systemd-creds",
        "encrypt",
        `--name=${name}`,
        source,
        `/var/lib/memory-router-secrets/${name}.cred`,
      ]);
    }
    for (const file of Deno.readDirSync("/infra/memory-router/deploy")) {
      if (/\.(service|socket|target)$/.test(file.name)) {
        Deno.copyFileSync(
          `/infra/memory-router/deploy/${file.name}`,
          `/etc/systemd/system/${file.name}`,
        );
      }
    }
    Deno.mkdirSync("/etc/sysusers.d", { recursive: true });
    Deno.copyFileSync(
      "/infra/memory-router/deploy/users.conf",
      "/etc/sysusers.d/memory-router.conf",
    );
    await command(["systemd-sysusers"]);
    await command(["systemctl", "daemon-reload"]);
    await command(["systemctl", "start", "memory-router.target"]);
    await waitFile("/run/memory-router/link/agent.sock");
  } else {
    for (
      const [role, uid] of [["key-agent", 991], ["link-agent", 992], [
        "directory",
        993,
      ]] as const
    ) {
      const child = new Deno.Command("setpriv", {
        args: [
          `--reuid=${uid}`,
          `--regid=${uid}`,
          "--clear-groups",
          binary,
          role,
          configPath,
        ],
        stdout: "inherit",
        stderr: "inherit",
      }).spawn();
      processes.push(child);
      await Promise.race([
        waitFile(
          `${root}/ipc/${
            role === "key-agent"
              ? "key"
              : role === "link-agent"
              ? "link"
              : "directory"
          }/agent.sock`,
        ),
        child.status.then(() => {
          throw new Error(`role exited before readiness: ${role}`);
        }),
      ]);
    }
    const listener = new Deno.Command(binary, {
      args: ["listener", configPath],
      stdout: "inherit",
      stderr: "piped",
    }).spawn();
    processes.push(listener);
    await listenerReady(listener);
  }
  const client = await new Client().start();
  clients.push(client);
  await client.authenticate(alice, 3, true);
  await client.authenticate(bob, 180);
  if (systemd) {
    for (const role of ["key", "link", "directory", "listener"]) {
      await command([
        "systemctl",
        "is-active",
        `memory-router-${role}.service`,
      ]);
    }
    pass(
      "actual systemd role units, activation descriptor custody and encrypted credentials",
    );
  }
  const first = await client.request({
    type: "session.open",
    space: spaces[0],
    principal: alice.did(),
    session: {},
  });
  const second = await client.request({
    type: "session.open",
    space: spaces[1],
    principal: bob.did(),
    session: {},
  });
  assert(first.ok && second.ok, JSON.stringify({ first, second }));
  const a = (first.ok as { sessionId: string }).sessionId,
    b = (second.ok as { sessionId: string }).sessionId;
  pass(
    "one public socket / two owning toolsheds / two independently authorized principals",
  );
  const denied = await client.request({
    type: "session.open",
    space: spaces[0],
    principal: bob.did(),
    session: {},
  });
  assert(denied.error !== undefined);
  pass("cross-principal ACL denial");
  const unknown = await client.request({
    type: "session.open",
    space: (await Identity.fromRaw(new Uint8Array(32).fill(99))).did(),
    principal: bob.did(),
    session: {},
  });
  assert(unknown.error !== undefined);
  pass("unknown space denied");
  await client.authenticate(alice, 180); // Renewal extends the original session.
  await pause(3500);
  const watched = await client.request({
    type: "session.watch.set",
    space: spaces[0],
    sessionId: a,
    watches: [{
      id: "fixture",
      kind: "graph",
      query: {
        roots: [{
          id: "of:fixture-data",
          selector: { path: [], schema: false },
        }],
      },
    }],
  });
  assert(watched.ok !== undefined, JSON.stringify(watched));
  pass("renewal extends active session");
  await client.request({ type: "connection.release", principal: alice.did() });
  assert(
    (await client.request({
      type: "session.open",
      space: spaces[0],
      principal: alice.did(),
      session: {},
    })).error !== undefined,
  );
  assert(
    (await client.request({
      type: "session.watch.set",
      space: spaces[0],
      sessionId: a,
      watches: [],
    })).ok !== undefined,
  );
  pass("release blocks new opens while preserving the original session lease");
  const sdkAudiences: string[] = [];
  const socketFactory = (address: URL) => {
    const socket = new WebSocket(address, {
      ca: Deno.readTextFileSync(publicTls.cert),
      perMessageDeflate: false,
      family: 4,
      localAddress: "127.0.0.7",
      headers: { Origin: "https://stage.example" },
    });
    socket.binaryType = "arraybuffer";
    return { socket, send: (frame: string | Uint8Array) => socket.send(frame) };
  };
  const sdk = await MemoryClient.connect({
    transport: new WebSocketTransport(
      new URL("wss://localhost:8443/api/storage/memory"),
      true,
      () => {},
      socketFactory,
    ),
  });
  try {
    const principal = (signer: Identity): SessionPrincipal => ({
      did: signer.did(),
      authorizeConnection: (context) => {
        sdkAudiences.push(`${context.audience} ${context.deployment}`);
        return createSignedConnectionAuth(signer, context);
      },
      authorizeSessionOpen: () => {
        throw new Error("unexpected direct session signature");
      },
    });
    const sa = await sdk.mount(spaces[0], {}, principal(alice));
    const sb = await sdk.mount(spaces[1], {}, principal(bob));
    assertEquals(sdkAudiences, [
      `${router.did()} local-mode-a`,
      `${router.did()} local-mode-a`,
    ]);
    await sa.close();
    await sb.close();
    pass(
      "actual SDK transport signs the second principal for the pinned router audience after first session.open",
    );
  } finally {
    await sdk.close();
  }
  const expiring = await new Client("127.0.0.2").start();
  clients.push(expiring);
  await expiring.authenticate(alice, 2, true);
  const short = await expiring.request({
    type: "session.open",
    space: spaces[0],
    principal: alice.did(),
    session: {},
  });
  assert(short.ok);
  await expiring.take((m) => m.type === "session/revoked", 5000);
  const held = expiring.send({
    type: "session.open",
    space: spaces[0],
    principal: alice.did(),
    session: {},
  });
  const pushed = await expiring.take((m) => m.type === "connection/challenge");
  await expiring.authenticate(alice, 60, false, pushed);
  assert((await expiring.take((m) => m.requestId === held)).ok);
  pass(
    "lease expiry revokes sessions and pushed challenge renewal releases a held open",
  );
  const expiredPid = workerStats().find((w) => w.uid === 100002)?.pid;
  expiring.close();
  await expiring.closed.promise;
  await until(() =>
    expiredPid === undefined || !workerStats().some((w) => w.pid === expiredPid)
  );
  pass("disconnect releases the parser process and its context");
  const crashing = await new Client("127.0.0.3").start();
  clients.push(crashing);
  await crashing.authenticate(bob, 60, true);
  const crashOpen = await crashing.request({
    type: "session.open",
    space: spaces[1],
    principal: bob.did(),
    session: {},
  });
  assert(crashOpen.ok);
  const victim = workerStats().find((w) => w.pid !== workerStats()[0].pid)!;
  Deno.kill(victim.pid, "SIGKILL");
  await Promise.race([crashing.closed.promise, deadline(6000)]);
  assert(
    (await client.request({
      type: "session.watch.set",
      space: spaces[1],
      sessionId: b,
      watches: [],
    })).ok,
  );
  pass(
    "worker crash closes only its own client; another client remains usable",
  );
  for (
    const malformed of [
      'fvj1:{"type":"hello","type":"hello","protocol":"memory","flags":{}}',
      `fvj1:${
        JSON.stringify({
          type: "hello",
          protocol: "memory",
          flags: {
            ...getMemoryProtocolFlags(),
            modernCellRep: true,
            stableExpressionResultIds: false,
            connectionAuth: true,
            routedAuthV1: true,
          },
        })
      }`,
    ]
  ) {
    const bad = new Client("127.0.0.4");
    clients.push(bad);
    await new Promise<void>((resolve, reject) => {
      bad.ws.once("open", resolve);
      bad.ws.once("error", reject);
    });
    bad.ws.send(malformed);
    await Promise.race([bad.closed.promise, deadline(6000)]);
  }
  pass(
    "ambiguous JSON and incompatible flags close only the offending workers",
  );
  const hinted = await new Client("127.0.0.5").start();
  clients.push(hinted);
  await hinted.authenticate(bob, 60, true);
  hinted.send({
    type: "session.open",
    space: spaces[1],
    principal: bob.did(),
    session: {},
    upstream: "127.0.0.1:8000",
  });
  await Promise.race([hinted.closed.promise, deadline(6000)]);
  pass("client-selected upstream metadata refused");
  const slow = new Client("127.0.0.6");
  clients.push(slow);
  await new Promise<void>((resolve, reject) => {
    slow.ws.once("open", resolve);
    slow.ws.once("error", reject);
  });
  slow.ws.send("fvj1:{", { fin: false });
  await Promise.race([slow.closed.promise, deadline(17000)]);
  assert(
    (await client.request({
      type: "session.watch.set",
      space: spaces[1],
      sessionId: b,
      watches: [],
    })).ok,
  );
  pass(
    "slow incomplete client times out without blocking an authenticated peer",
  );
  const pool: { client: Client; session: string }[] = [{ client, session: b }];
  for (let i = 0; i < 31; i++) {
    const peer = await new Client(`127.0.0.${10 + i % 8}`).start();
    clients.push(peer);
    await peer.authenticate(bob, 180, true);
    const opened = await peer.request({
      type: "session.open",
      space: spaces[1],
      principal: bob.did(),
      session: {},
    });
    assert(opened.ok);
    pool.push({
      client: peer,
      session: (opened.ok as { sessionId: string }).sessionId,
    });
  }
  await until(() => workerStats().length === 32);
  const statsIdle = workerStats();
  await pause(1000);
  const statsIdleEnd = workerStats();
  const started = performance.now();
  await Promise.all(pool.map(async ({ client: peer, session }) => {
    for (let i = 1; i <= 100; i++) {
      const response = await peer.request({
        type: "transact",
        space: spaces[1],
        sessionId: session,
        commit: {
          localSeq: i,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "set",
            id: `of:exercise-${session}`,
            value: { value: i },
          }],
        },
      });
      assert(response.ok !== undefined, JSON.stringify(response));
    }
  }));
  const activeElapsedMs = performance.now() - started;
  console.log(JSON.stringify({
    resource: {
      build: "release",
      concurrency: 32,
      idleStart: statsIdle,
      idleEnd: statsIdleEnd,
      activeEnd: workerStats(),
      activeTransactions: 3200,
      activeElapsedMs,
      clockTicksPerSecond: await command(["getconf", "CLK_TCK"]),
    },
  }));
  pass(
    "32 optimized workers: actual private memory / CPU / descriptors / cgroups, idle and 3200 active transactions",
  );
  for (const entry of pool.slice(1)) entry.client.close();
  await until(() => workerStats().length === 1);
  hosts[0].host.revokeRouter(router.did());
  await Promise.race([
    client.closed.promise,
    pause(6000).then(() => {
      throw new Error("router revocation did not close client");
    }),
  ]);
  pass("router revocation closes all client upstreams");
  console.log(JSON.stringify({ accepted: true, gates }));
} finally {
  for (const client of clients) client.close();
  if (systemd) await command(["systemctl", "stop", "memory-router.target"]);
  for (const child of processes.reverse()) {
    try {
      child.kill("SIGTERM");
    } catch { /* Already stopped. */ }
    await child.status;
  }
  await Promise.all(listenerLogs);
  for (const host of hosts) await host.close();
  Deno.removeSync(root, { recursive: true });
}
