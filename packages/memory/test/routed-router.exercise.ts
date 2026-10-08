/** Disposable Linux acceptance against a compiled Rust router and real SQLite toolsheds. */
import { setModernCellRepConfig } from "@commonfabric/data-model/cell-rep";
import { Identity } from "@commonfabric/identity";
import { assert, assertEquals } from "@std/assert";
import { toFileUrl } from "@std/path";
// @ts-types="@types/ws"
import WebSocket from "ws";
import { Client as MemoryClient, type SessionPrincipal } from "../v2/client.ts";
import {
  createSignedConnectionAuth,
  createStorageAddressResolver,
  RemoteSessionFactory,
  WebSocketTransport,
} from "../../runner/src/storage/v2-remote-session.ts";
import { aclDocId } from "../acl.ts";
import type { MemorySpace } from "../interface.ts";
import { getMemoryProtocolFlags, toDocumentPath } from "../v2.ts";
import { BASE58_ALPHABET } from "../v2/routed-directory.ts";
import { decodeRoutedFrame } from "../v2/routed-parser.ts";
import {
  readRoutedHex,
  routedBase64,
  routedStatementPayload,
} from "../v2/routed-wire.ts";
import { resolveSpaceStoreUrl } from "../v2/storage-path.ts";

// Mode A runs at the deployment's cell representation, which the toolsheds
// and every client share. The exercise runs at the production setting, legacy,
// unless ROUTER_EXERCISE_MODERN_CELL_REP=true. The SDK's hello advertises this
// process's setting, and the toolshed children are told it.
const modernCellRep =
  Deno.env.get("ROUTER_EXERCISE_MODERN_CELL_REP") === "true";
setModernCellRepConfig(modernCellRep);
const binary = Deno.env.get("MEMORY_ROUTER_BINARY");
if (
  binary === undefined || Deno.build.os !== "linux" ||
  Deno.env.get("ROUTER_DISPOSABLE_EXERCISE") !== "yes"
) throw new Error("Set MEMORY_ROUTER_BINARY on disposable Linux");
const systemd = Deno.env.get("ROUTER_SYSTEMD_EXERCISE") === "yes";
// Under systemd the units have private /tmp, and the listener unit sees an
// empty /run, so the fixture files live where every unit can read them.
const root = Deno.makeTempDirSync({
  prefix: "memory-router-exercise-",
  ...(systemd ? { dir: "/var/lib" } : {}),
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
console.log(JSON.stringify({
  environment: {
    kernel: (await command(["uname", "-r"])).trim(),
    architecture: Deno.build.arch,
    deno: Deno.version.deno,
    tools: (await command([
      "dpkg-query",
      "-W",
      "-f=${Package}=${Version}\n",
      "nftables",
      "openssl",
      "python3",
      "procps",
      "strace",
      ...(systemd ? ["systemd"] : []),
    ])).trim().split("\n"),
  },
}));
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
// The public certificate uses ECDSA P-256: browsers never offer Ed25519 in TLS
// and public CAs do not issue Ed25519 server certificates.
async function ecdsaCertificate(name: string) {
  const key = `${root}/${name}.pem`, cert = `${root}/${name}.crt`;
  await command([
    "openssl",
    "genpkey",
    "-algorithm",
    "EC",
    "-pkeyopt",
    "ec_paramgen_curve:P-256",
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
const publicTls = await ecdsaCertificate("public");
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
  const [name, seed, uid] of [["router", 21, 992]] as const
) {
  const path = `${root}/${name}.seed`;
  Deno.writeFileSync(path, new Uint8Array(32).fill(seed), { mode: 0o400 });
  Deno.chownSync(path, uid, uid);
}
Deno.copyFileSync(publicTls.key, `${root}/tls.key`);
Deno.chmodSync(`${root}/tls.key`, 0o400);
Deno.chownSync(`${root}/tls.key`, 991, 991);
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
    tls_key: systemd
      ? "/run/credentials/memory-router-key.service/tls-key"
      : `${root}/tls.key`,
    router_seed: systemd
      ? "/run/credentials/memory-router-link.service/router-seed"
      : `${root}/router.seed`,
    ipc_dir: systemd ? "/run/memory-router" : `${root}/ipc`,
    cgroup_root: systemd
      ? "/sys/fs/cgroup/system.slice/memory-router-listener.service/workers"
      : `${cgParent}/workers`,
    worker_uid_base: 100000,
    listener_uid: 990,
    // Small limits, set explicitly, so the gates below reach them.
    max_workers: 32,
    max_unauthenticated: 8,
    max_per_source: 8,
    max_unauthenticated_per_source: 7,
    max_new_connections_per_second: 150,
    max_new_connections_per_source_per_second: 6,
    max_spaces_per_connection: 64,
    max_principals_per_connection: 8,
    max_principal_history: 64,
    max_principals_per_challenge: 64,
    max_watches_per_connection: 1024,
    max_holdings_per_connection: 8192,
    max_requests_per_connection: 256,
    modern_cell_rep: modernCellRep,
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
/** The direct exercise's listener and spawner output, as it arrives. */
const listenerOutput: string[] = [];
/**
 * Waits until the spawner logs a connection event with `verdict` (what
 * happened) and `reason` (why) for `source`.
 */
async function logged(verdict: string, reason: string, source: string) {
  const found = async () =>
    (await listenerLog()).split("\n").some((line) => {
      try {
        const e = JSON.parse(line);
        return e.event === "memory-router-connection" &&
          e.verdict === verdict && e.reason === reason && e.source === source;
      } catch {
        return false;
      }
    });
  for (const end = Date.now() + 10000; !(await found());) {
    if (Date.now() >= end) {
      throw new Error(`no ${verdict} ${reason} logged for ${source}`);
    }
    await pause(200);
  }
}
/** What the listener and spawner have logged so far. */
async function listenerLog(): Promise<string> {
  return systemd
    ? await command([
      "journalctl",
      "-u",
      "memory-router-listener.service",
      "-o",
      "cat",
      "--no-pager",
    ])
    : listenerOutput.join("");
}
/** A real toolshed in a child process, so gates can stall, stop and restart it. */
class Toolshed {
  child?: Deno.ChildProcess;
  #writer?: WritableStreamDefaultWriter<Uint8Array>;
  #lines: string[] = [];
  #wake?: () => void;
  constructor(readonly index: number) {}
  /** `modern` overrides the deployment's cell representation, to misconfigure it. */
  async start(modern = modernCellRep) {
    const i = this.index;
    const config = `${root}/toolshed-${i}.json`;
    Deno.writeTextFileSync(
      config,
      JSON.stringify({
        port: 8444 + i,
        seed: 11 + i,
        certificate: privateTls[i].cert,
        key: privateTls[i].key,
        directory,
        store: `${root}/store-${i}`,
        router: router.did(),
        space: spaces[i],
        principals: [i === 0 ? alice.did() : bob.did()],
        modernCellRep: modern,
      }),
    );
    this.child = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        `--config=${new URL("../../../deno.jsonc", import.meta.url).pathname}`,
        "-A",
        new URL("./support/routed-toolshed.ts", import.meta.url).pathname,
        config,
      ],
      stdin: "piped",
      stdout: "piped",
      stderr: "inherit",
    }).spawn();
    this.#writer = this.child.stdin.getWriter();
    this.#lines = [];
    void (async () => {
      let held = "";
      for await (
        const chunk of this.child!.stdout.pipeThrough(new TextDecoderStream())
      ) {
        held += chunk;
        let newline: number;
        while ((newline = held.indexOf("\n")) >= 0) {
          this.#lines.push(held.slice(0, newline));
          held = held.slice(newline + 1);
          this.#wake?.();
        }
      }
    })();
    await this.#line((line) => line.includes('"ready":true'));
  }
  async #line(match: (line: string) => boolean) {
    const end = Date.now() + 30000;
    while (Date.now() < end) {
      const i = this.#lines.findIndex(match);
      if (i >= 0) return this.#lines.splice(0, i + 1).pop()!;
      await new Promise<void>((resolve) => {
        this.#wake = resolve;
        setTimeout(resolve, 100);
      });
    }
    throw new Error(`toolshed ${this.index} did not answer`);
  }
  async command(command: Record<string, unknown>) {
    await this.#writer!.write(
      new TextEncoder().encode(`${JSON.stringify(command)}\n`),
    );
    await this.#line((line) => line.includes('"acknowledged":true'));
  }
  signal(signal: Deno.Signal) {
    this.child!.kill(signal);
  }
  async stop() {
    if (this.child === undefined) return;
    try {
      this.child.kill("SIGKILL");
    } catch { /* Already stopped. */ }
    await this.child.status;
    this.child = undefined;
  }
}
const toolsheds: Toolshed[] = [];
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
      // /proc/smaps_rollup can return ESRCH after a worker loses its address
      // space during exit, before its proc directory is removed (ENOENT).
      const exited = error instanceof Deno.errors.NotFound ||
        (error instanceof Error &&
          error.message.startsWith("No such process (os error 3):"));
      if (!exited) throw error;
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
      listenerOutput.push(chunk);
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
async function until(predicate: () => boolean, ms = 6000) {
  const end = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() >= end) throw new Error("cleanup deadline");
    await pause(10);
  }
}
/** Starts the router roles as separate processes (direct exercise only). */
async function startRouter() {
  for (const name of ["key", "link", "directory"]) {
    // A killed role leaves its non-activated socket path behind.
    try {
      Deno.removeSync(`${root}/ipc/${name}/agent.sock`);
    } catch { /* Not present. */ }
  }
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
        binary!,
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
  const listener = new Deno.Command(binary!, {
    args: ["listener", configPath],
    stdout: "inherit",
    stderr: "piped",
  }).spawn();
  processes.push(listener);
  await listenerReady(listener);
}
async function restartRouter() {
  if (systemd) {
    await command(["systemctl", "restart", "memory-router.target"]);
    return;
  }
  for (const child of processes.splice(0).reverse()) {
    try {
      child.kill("SIGTERM");
    } catch { /* Already stopped. */ }
    await child.status;
  }
  await startRouter();
}
class Client {
  #changed = Promise.withResolvers<void>();
  #failure?: Error;
  ws: WebSocket;
  messages: Record<string, unknown>[] = [];
  sequence = 0;
  closed = Promise.withResolvers<void>();
  binaryFrames = 0;
  hello!: Record<string, unknown>;
  /** `deflate` offers permessage-deflate, as every browser does. */
  constructor(localAddress = "127.0.0.1", deflate = false, space?: string) {
    const address = new URL("wss://localhost:8443/api/storage/memory");
    if (space !== undefined) address.searchParams.set("space", space);
    this.ws = new WebSocket(address, {
      ca: Deno.readTextFileSync(publicTls.cert),
      perMessageDeflate: deflate,
      family: 4,
      localAddress,
      headers: { Origin: "https://stage.example" },
    });
    this.ws.on(
      "message",
      (bytes, binary) => {
        if (binary) this.binaryFrames++;
        this.messages.push(
          decodeRoutedFrame(
            binary ? new Uint8Array(bytes as ArrayBuffer) : bytes.toString(),
            true,
          ).body,
        );
        this.#notify();
      },
    );
    this.ws.on("close", () => {
      this.#failure = new Error("client closed");
      this.closed.resolve();
      this.#notify();
    });
    this.ws.on("error", (error) => {
      this.#failure = error;
      this.closed.resolve();
      this.#notify();
    });
  }
  #notify() {
    const changed = this.#changed;
    this.#changed = Promise.withResolvers<void>();
    changed.resolve();
  }
  async start(
    flags = {
      ...getMemoryProtocolFlags(),
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
  async take(predicate: (m: Record<string, unknown>) => boolean) {
    while (true) {
      const i = this.messages.findIndex(predicate);
      if (i >= 0) return this.messages.splice(i, 1)[0];
      if (this.#failure !== undefined) throw this.#failure;
      await this.#changed.promise;
    }
  }
  send(body: Record<string, unknown>) {
    const requestId = `r${++this.sequence}`;
    this.ws.send(`fvj1:${JSON.stringify({ ...body, requestId })}`);
    return requestId;
  }
  requestWithId(requestId: string, body: Record<string, unknown>) {
    this.ws.send(`fvj1:${JSON.stringify({ ...body, requestId })}`);
    return this.take((m) => m.requestId === requestId);
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
      if (!exited(error)) throw error;
    }
  }
  return result;
}
/**
 * A process can exit between listing /proc and reading it; its files then
 * report ENOENT, or ESRCH once its address space is gone.
 */
function exited(error: unknown) {
  return error instanceof Deno.errors.NotFound ||
    (error instanceof Error &&
      error.message.startsWith("No such process (os error 3):"));
}
/** PID of the router process serving `role`. */
function rolePid(role: string) {
  for (const entry of Deno.readDirSync("/proc")) {
    if (!/^\d+$/.test(entry.name)) continue;
    try {
      const cmdline = Deno.readTextFileSync(`/proc/${entry.name}/cmdline`);
      if (cmdline.split("\0")[1] === role) return Number(entry.name);
    } catch (error) {
      if (!exited(error)) throw error;
    }
  }
  throw new Error(`no ${role} process`);
}
/** Resident KiB of the router process serving `role`. */
function roleRssKb(role: string) {
  return Number(
    Deno.readTextFileSync(`/proc/${rolePid(role)}/status`).match(
      /^VmRSS:\s+(\d+)/m,
    )?.[1],
  );
}
const agentRssKb = () => roleRssKb("link-agent") + roleRssKb("directory");
try {
  for (let i = 0; i < 2; i++) {
    toolsheds.push(new Toolshed(i));
    await toolsheds[i].start();
  }
  if (systemd) {
    Deno.mkdirSync("/opt/memory-router", { recursive: true });
    Deno.copyFileSync(binary, "/opt/memory-router/memory-router");
    Deno.chmodSync("/opt/memory-router/memory-router", 0o755);
    Deno.mkdirSync("/etc/memory-router", { recursive: true });
    Deno.copyFileSync(configPath, "/etc/memory-router/config.json");
    Deno.copyFileSync(firewallPath, "/etc/memory-router/firewall.nft");
    for (const folder of ["scripts", "deploy"]) {
      Deno.mkdirSync(`/opt/memory-router/${folder}`, { recursive: true });
    }
    for (const file of ["network-guard.py", "network.py", "directory.py"]) {
      Deno.copyFileSync(
        `/infra/memory-router/scripts/${file}`,
        `/opt/memory-router/scripts/${file}`,
      );
    }
    Deno.copyFileSync(
      "/infra/memory-router/deploy/users.conf",
      "/opt/memory-router/deploy/users.conf",
    );
    Deno.mkdirSync("/var/lib/memory-router-secrets", {
      recursive: true,
      mode: 0o700,
    });
    for (
      const [name, source] of [["tls-key", `${root}/tls.key`], [
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
    const start = () => command(["systemctl", "start", "memory-router.target"]);
    const stop = () =>
      command([
        "systemctl",
        "stop",
        "memory-router.target",
        "memory-router-network.service",
      ]);
    const table = () =>
      command([
        "nft",
        "-n",
        "-j",
        "list",
        "table",
        "inet",
        "memory_router",
      ]);
    const refusedStart = async (unit = "memory-router.target") => {
      const result = await new Deno.Command("systemctl", {
        args: ["start", unit],
        stdout: "null",
        stderr: "null",
      }).output();
      assert(!result.success, `${unit} started without its network gate`);
    };
    const noRoles = async () => {
      for (const role of ["key", "link", "directory", "listener"]) {
        const result = await new Deno.Command("systemctl", {
          args: ["is-active", "--quiet", `memory-router-${role}.service`],
          stdout: "null",
          stderr: "null",
        }).output();
        assert(
          !result.success,
          `${role} started after a rejected network gate`,
        );
      }
    };
    // A boot loses the kernel table. Restarting the actual target must reload
    // the persisted reviewed rules before any socket or role starts.
    await stop();
    await command(["nft", "delete", "table", "inet", "memory_router"]);
    await start();
    await command([
      "python3",
      "/opt/memory-router/scripts/network-guard.py",
      "verify",
    ]);
    // During the same boot, role starts must verify rather than repair a
    // missing or altered table while the loader remains active. Start the
    // loader alone so these are real starts of the four production roles.
    await stop();
    await command(["systemctl", "start", "memory-router-network.service"]);
    await command(["nft", "delete", "table", "inet", "memory_router"]);
    for (const role of ["key", "link", "directory", "listener"]) {
      await refusedStart(`memory-router-${role}.service`);
    }
    await noRoles();
    await stop();
    await command(["systemctl", "start", "memory-router-network.service"]);
    await command([
      "nft",
      "insert",
      "rule",
      "inet",
      "memory_router",
      "output",
      "meta",
      "skuid",
      "991",
      "accept",
    ]);
    for (const role of ["key", "link", "directory", "listener"]) {
      await refusedStart(`memory-router-${role}.service`);
    }
    await noRoles();
    await stop();
    await start();
    pass(
      "boot restores the exact firewall; missing or changed tables block role startup",
    );

    await stop();
    const persisted = "/etc/memory-router/firewall.nft";
    const reviewed = Deno.readTextFileSync(persisted);
    Deno.renameSync(persisted, `${persisted}.saved`);
    try {
      await refusedStart();
      await noRoles();
    } finally {
      Deno.renameSync(`${persisted}.saved`, persisted);
    }
    Deno.writeTextFileSync(persisted, reviewed + "# unreviewed edit\n");
    try {
      await refusedStart();
      await noRoles();
    } finally {
      Deno.writeTextFileSync(persisted, reviewed);
    }
    pass(
      "missing or changed persisted firewall inputs block every router role",
    );

    const before = await table();
    for (
      const [change, restore] of [
        [["usermod", "-u", "1992", "memory-router-link"], [
          "usermod",
          "-u",
          "992",
          "memory-router-link",
        ]],
        [["groupmod", "-g", "1993", "memory-router-directory"], [
          "groupmod",
          "-g",
          "993",
          "memory-router-directory",
        ]],
      ]
    ) {
      await command(change);
      try {
        await refusedStart();
        await noRoles();
        assertEquals(
          await table(),
          before,
          "identity refusal changed the firewall",
        );
      } finally {
        await command(restore);
      }
    }
    await start();
    pass(
      "mismatched existing role UIDs or GIDs refuse startup before firewall changes",
    );
  } else {
    await startRouter();
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
    // The spawner keeps UID 0, and systemd and D-Bus authorize a UID 0 caller
    // with no capabilities as root. From the spawner's mount namespace,
    // systemd-run must find no socket to ask; the namespace itself is entered,
    // since the agent sockets are visible there.
    const inSpawnerMounts = (...args: string[]) =>
      new Deno.Command("nsenter", {
        args: ["-t", String(rolePid("spawner")), "-m", ...args],
        stdout: "null",
        stderr: "null",
      }).output();
    assert((await inSpawnerMounts("test", "-d", "/run/memory-router")).success);
    assert(
      !(await inSpawnerMounts(
        "systemd-run",
        "--quiet",
        "--unit=memory-router-escalation-probe",
        "/bin/true",
      )).success,
      "the spawner's mount namespace can start systemd units",
    );
    pass("the listener unit cannot ask systemd or D-Bus to run anything");
    // The probe enters the spawner's namespaces with only its three
    // capabilities. It deliberately has no seccomp filter: even arbitrary
    // code with CAP_KILL must not signal processes outside the unit. Both
    // interfaces use signal 0, so no outside process receives a signal.
    await command([
      "python3",
      "-c",
      String.raw`
import errno, os, signal, subprocess, sys

inside = r"""
import errno, os, signal, subprocess, sys

outside_pid, outside_fd = map(int, sys.argv[1:])
denials = {}
for name, attempt in [
    ("kill", lambda: os.kill(outside_pid, 0)),
    ("pidfd_send_signal", lambda: signal.pidfd_send_signal(outside_fd, 0)),
]:
    try:
        attempt()
        denials[name] = 0
    except OSError as error:
        denials[name] = error.errno
assert denials == {"kill": errno.ESRCH, "pidfd_send_signal": errno.EINVAL}, denials

# Terminating a worker with a different UID must still work inside the unit.
child = subprocess.Popen([
    "setpriv", "--reuid=100050", "--regid=100050", "--clear-groups",
    "python3", "-c", "import os, signal; print(os.getuid(), flush=True); signal.pause()",
], stdout=subprocess.PIPE, text=True)
try:
    assert child.stdout.readline() == "100050\n"
    fd = os.pidfd_open(child.pid)
    try:
        os.kill(child.pid, 0)
        signal.pidfd_send_signal(fd, 0)
    finally:
        os.close(fd)
finally:
    child.terminate()
    child.wait()
"""

# Open the outside pidfd before entering the namespace. Refusing a PID lookup
# alone would not prove that a supplied host pidfd cannot bypass isolation.
spawner = int(sys.argv[1])
outside = subprocess.Popen(["/bin/sleep", "30"])
try:
    fd = os.pidfd_open(outside.pid)
    try:
        os.kill(outside.pid, 0)
        signal.pidfd_send_signal(fd, 0)
        subprocess.run([
            "nsenter", "-t", str(spawner), "-m", "-p", "setpriv",
            "--bounding-set=-all,+setuid,+setgid,+kill",
            "--inh-caps=-all,+setuid,+setgid,+kill",
            "--ambient-caps=-all,+setuid,+setgid,+kill",
            "python3", "-c", inside, str(outside.pid), str(fd),
        ], pass_fds=(fd,), check=True)
        assert os.stat(f"/proc/{spawner}/ns/pid").st_ino != os.stat("/proc/self/ns/pid").st_ino
    finally:
        os.close(fd)
finally:
    outside.terminate()
    outside.wait()
`,
      String(rolePid("spawner")),
    ]);
    pass("the spawner cannot signal host processes by PID or pidfd");
  }
  // A process with an agent's UID and GID, which a compromised spawner could
  // become without its filter, must not read that agent's memory or
  // environment. /proc/PID/environ needs only the same IDs and a dumpable
  // target, so this does not depend on Yama's ptrace_scope.
  for (const role of ["key-agent", "link-agent", "directory"]) {
    const pid = rolePid(role);
    const status = Deno.readTextFileSync(`/proc/${pid}/status`);
    const id = (field: string) =>
      Number(status.match(new RegExp(`^${field}:\\s+(\\d+)`, "m"))?.[1]);
    const readAs = (path: string) =>
      new Deno.Command("setpriv", {
        args: [
          `--reuid=${id("Uid")}`,
          `--regid=${id("Gid")}`,
          "--clear-groups",
          "head",
          "-c",
          "1",
          path,
        ],
        stdout: "null",
        stderr: "piped",
      }).output();
    // The same probe reads its own environment, so a refusal below comes
    // from the agent's protection, not a broken probe.
    assert((await readAs("/proc/self/environ")).success, `${role} probe`);
    const read = await readAs(`/proc/${pid}/environ`);
    assert(
      !read.success &&
        new TextDecoder().decode(read.stderr).includes("Permission denied"),
      `${role} is readable by UID ${id("Uid")}`,
    );
  }
  // The spawner is forked before the listener installs its own filter, so
  // their filter counts match only if the spawner installs one too. systemd
  // adds filters to both, so `Seccomp: 2` alone would not show it.
  const filters = (role: string) =>
    Deno.readTextFileSync(`/proc/${rolePid(role)}/status`).match(
      /^Seccomp_filters:\s+(\d+)/m,
    )?.[1];
  assertEquals(filters("spawner"), filters("listener"));
  pass("agents are non-dumpable and the spawner runs under a syscall filter");
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
  // Refuse only broker-created data sockets; the credentialed control link
  // stays up. A retry must still receive a descriptor and fresh admission.
  const retry = await new Client("127.0.0.33").start();
  clients.push(retry);
  await retry.authenticate(alice, 60, true);
  await command([
    "nft",
    "insert",
    "rule",
    "inet",
    "memory_router",
    "output",
    "meta",
    "skuid",
    "993",
    "ip",
    "daddr",
    "127.0.0.1",
    "tcp",
    "dport",
    "8444",
    "reject",
    "with",
    "tcp",
    "reset",
    "comment",
    '"memory-router-transient-dial"',
  ]);
  const firewall = JSON.parse(
    await command([
      "nft",
      "-j",
      "-n",
      "list",
      "chain",
      "inet",
      "memory_router",
      "output",
    ]),
  ) as { nftables: { rule?: { comment?: string; handle: number } }[] };
  const injected = firewall.nftables.flatMap(({ rule }) =>
    rule?.comment === "memory-router-transient-dial" ? [rule.handle] : []
  );
  assertEquals(injected.length, 1);
  try {
    const refused = await retry.request({
      type: "session.open",
      space: spaces[0],
      principal: alice.did(),
      session: {},
    });
    assert(refused.error !== undefined);
    assertEquals(retry.ws.readyState, WebSocket.OPEN);
  } finally {
    await command([
      "nft",
      "delete",
      "rule",
      "inet",
      "memory_router",
      "output",
      "handle",
      String(injected[0]),
    ]);
  }
  assert(
    (await retry.request({
      type: "session.open",
      space: spaces[0],
      principal: alice.did(),
      session: {},
    })).ok,
  );
  retry.close();
  pass(
    "a transient broker dial failure permits retry on the same client socket",
  );
  const quotaWatch = {
    id: "quota-old",
    kind: "graph",
    query: {
      roots: [{ id: "of:fixture-data", selector: { path: [], schema: false } }],
    },
  };
  assert(
    (await client.request({
      type: "session.watch.set",
      space: spaces[1],
      sessionId: b,
      watches: [quotaWatch],
    })).ok !== undefined,
  );
  const invalidWatches = Array.from(
    { length: 960 },
    (_, i) => ({
      ...quotaWatch,
      id: i === 0 ? quotaWatch.id : `invalid${i}`,
      query: {
        roots: [{
          id: "of:different-root",
          selector: { path: [], schema: false },
        }],
      },
    }),
  );
  assert(
    (await client.request({
      type: "session.watch.add",
      space: spaces[1],
      sessionId: b,
      watches: invalidWatches,
    })).error !== undefined,
  );
  const quotaSession = await client.request({
    type: "session.open",
    space: spaces[1],
    principal: bob.did(),
    session: {},
  });
  assert(quotaSession.ok !== undefined);
  const quotaId = (quotaSession.ok as { sessionId: string }).sessionId;
  const validWatches = Array.from(
    { length: 65 },
    (_, i) => ({
      id: `valid${i}`,
      kind: "graph",
      query: {
        roots: [{
          id: "of:fixture-data",
          selector: { path: [], schema: false },
        }],
      },
    }),
  );
  assert(
    (await client.request({
      type: "session.watch.set",
      space: spaces[1],
      sessionId: quotaId,
      watches: validWatches,
    })).ok !== undefined,
  );
  assert(
    (await client.request({
      type: "session.close",
      space: spaces[1],
      sessionId: quotaId,
    })).ok !== undefined,
  );
  pass(
    "rejected watch mutations reserve no persistent router or toolshed quota",
  );
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
  // One source at its connection limit is turned away, and the spawner logs
  // the drop with its reason and the source it was counted under. This runs
  // after the renewal gates, which need alice's 3 s lease renewed promptly.
  const crowded = "127.0.0.60";
  // A principal of its own, so these connections leave the other gates'
  // principals and their leases alone.
  const crowdSigner = await Identity.fromRaw(new Uint8Array(32).fill(61));
  const crowd: Client[] = [];
  for (let i = 0; i < 8; i++) {
    const c = await new Client(crowded).start();
    crowd.push(c);
    clients.push(c);
    await c.authenticate(crowdSigner, 60, true);
    // Stays under the per-source admission rate.
    await pause(300);
  }
  const turnedAway = new Client(crowded);
  clients.push(turnedAway);
  let dropped = false;
  try {
    await turnedAway.start();
  } catch {
    dropped = true;
  }
  assert(dropped, "a ninth connection from one source was admitted");
  await logged("connection-dropped", "source-limit", `${crowded}/32`);
  for (const c of crowd) c.close();
  pass("a source over its connection limit is dropped, and the drop is logged");
  // A connection at its principal limit is refused one authentication, and
  // stays usable; the refusal is logged with its reason.
  const crowdedPrincipals = new Client("127.0.0.61");
  clients.push(crowdedPrincipals);
  await crowdedPrincipals.start();
  for (let i = 0; i < 8; i++) {
    await crowdedPrincipals.authenticate(
      await Identity.fromRaw(new Uint8Array(32).fill(70 + i)),
      60,
      i === 0,
    );
  }
  const ninth = await Identity.fromRaw(new Uint8Array(32).fill(78));
  const offer =
    (await crowdedPrincipals.request({ type: "connection.challenge" }))
      .ok as { challenge: { value: string } };
  const iat = Math.floor(Date.now() / 1000);
  const refusedAuth = await crowdedPrincipals.request({
    type: "connection.auth",
    statement: routedBase64(
      await routedStatementPayload({
        principal: ninth.did(),
        router: router.did(),
        deployment: "local-mode-a",
        challenge: readRoutedHex(offer.challenge.value, 32),
        iat,
        exp: iat + 60,
      }).sign(ninth),
    ),
  });
  assert(refusedAuth.error !== undefined, "a ninth principal was admitted");
  assert(
    (await crowdedPrincipals.request({ type: "connection.challenge" })).ok !==
      undefined,
    "the connection closed with the refusal",
  );
  await logged("request-refused", "principal-limit", "127.0.0.61/32");
  pass(
    "a connection at its principal limit is refused one authentication and goes on",
  );
  // A connection at its session limit is refused one open, and goes on; the
  // refusal is retriable, so the SDK holds the session rather than ending it.
  const crowdedSessions = new Client("127.0.0.62");
  clients.push(crowdedSessions);
  await crowdedSessions.start();
  await crowdedSessions.authenticate(alice, 120, true);
  const openOne = () =>
    crowdedSessions.request({
      type: "session.open",
      space: spaces[0],
      principal: alice.did(),
      session: {},
    });
  for (let i = 0; i < 64; i++) {
    const opened = await openOne();
    assert(opened.ok !== undefined, JSON.stringify(opened));
  }
  const overLimit = await openOne();
  assert(
    (overLimit.error as { retriable?: boolean } | undefined)?.retriable ===
      true,
    `a sixty-fifth session was not refused retriably: ${
      JSON.stringify(overLimit)
    }`,
  );
  assert(
    (await crowdedSessions.request({ type: "connection.challenge" })).ok !==
      undefined,
    "the connection closed with the refusal",
  );
  await logged("request-refused", "session-limit", "127.0.0.62/32");
  crowdedPrincipals.close();
  crowdedSessions.close();
  pass("a connection at its session limit is refused one open and goes on");
  // Renewals keep a session alive across several leases, a lease may be
  // ten minutes, and a longer one is refused.
  const renewing = new Client("127.0.0.63");
  clients.push(renewing);
  await renewing.start();
  await renewing.authenticate(alice, 3, true);
  const renewed = await renewing.request({
    type: "session.open",
    space: spaces[0],
    principal: alice.did(),
    session: {},
  });
  assert(renewed.ok !== undefined, JSON.stringify(renewed));
  const renewedId = (renewed.ok as { sessionId: string }).sessionId;
  for (let i = 0; i < 5; i++) {
    await pause(2000);
    await renewing.authenticate(alice, 3);
  }
  // Ten seconds on, past three of its three-second leases.
  const stillOpen = await renewing.request({
    type: "session.watch.set",
    space: spaces[0],
    sessionId: renewedId,
    watches: [],
  });
  assert(stillOpen.ok !== undefined, JSON.stringify(stillOpen));
  await renewing.authenticate(alice, 600);
  const overLease = await renewing.authenticate(alice, 601).then(
    () => undefined,
    (error: Error) => error,
  );
  assert(overLease !== undefined, "a 601-second lease was admitted");
  renewing.close();
  pass(
    "renewals keep a session open across several leases; a lease may be ten minutes and no longer",
  );
  const sdkAudiences: string[] = [];
  const socketFactory = (address: URL, localAddress = "127.0.0.7") => {
    const socket = new WebSocket(address, {
      ca: Deno.readTextFileSync(publicTls.cert),
      perMessageDeflate: false,
      family: 4,
      localAddress,
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
  for (const shared of [false, true]) {
    const dialed: URL[] = [];
    const sockets: WebSocket[] = [];
    const factory = new RemoteSessionFactory(
      createStorageAddressResolver(new URL("https://localhost:8443")),
      alice,
      (address) => {
        dialed.push(new URL(address));
        const connected = socketFactory(
          address,
          shared ? "127.0.0.28" : "127.0.0.27",
        );
        sockets.push(connected.socket);
        return connected;
      },
    );
    factory.setSharedConnections(shared);
    const opened = await Promise.all(
      spaces.map((space, i) =>
        factory.create(space as MemorySpace, i === 0 ? alice : bob)
      ),
    );
    try {
      assertEquals(dialed.length, shared ? 1 : 2);
      assertEquals(
        dialed.map((address) => address.searchParams.get("space")).toSorted(),
        shared ? [null] : [...spaces].toSorted(),
      );
      for (const { session } of opened) {
        await session.queryGraph({ roots: [] });
      }
      if (!shared) {
        const lost = new Promise<void>((resolve) =>
          sockets[0].once("close", () => resolve())
        );
        sockets[0].terminate();
        await lost;
        await opened[0].session.queryGraph({ roots: [] });
        assertEquals(dialed.length, 3);
        assertEquals(dialed[2].searchParams.get("space"), spaces[0]);
        pass(
          "sharing-off SDK reconnects with the same DID URL and fresh routed authorization",
        );
      }
    } finally {
      await Promise.all(opened.map(({ client }) => client.close()));
      await factory.close();
    }
    pass(
      shared
        ? "sharing-on factory uses one space-free socket across two toolsheds and principals"
        : "sharing-off factory uses two DID URL sockets with routed authentication",
    );
  }
  const scoped = await new Client("127.0.0.25", false, spaces[0]).start();
  clients.push(scoped);
  await scoped.authenticate(bob, 180, true);
  assert(
    (await scoped.request({
      type: "session.open",
      space: spaces[1],
      principal: bob.did(),
      session: {},
    })).error !== undefined,
  );
  await scoped.authenticate(alice, 180);
  assert(
    (await scoped.request({
      type: "session.open",
      space: spaces[0],
      principal: alice.did(),
      session: {},
    })).ok !== undefined,
  );
  scoped.close();
  await scoped.closed.promise;
  pass(
    "DID URL cannot open a different admitted space even with its owner's signature",
  );
  const unknownUrl = await new Client("127.0.0.26", false, alice.did()).start();
  clients.push(unknownUrl);
  await unknownUrl.authenticate(alice, 180, true);
  assert(
    (await unknownUrl.request({
      type: "session.open",
      space: alice.did(),
      principal: alice.did(),
      session: {},
    })).error !== undefined,
  );
  unknownUrl.close();
  await unknownUrl.closed.promise;
  pass("unknown DID URL receives no space authority or upstream admission");
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
  await expiring.take((m) => m.type === "session/revoked");
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
  // Each worker's end is logged with a fixed reason, never its error's text.
  await logged("worker-stopped", "client-protocol", "127.0.0.4/32");
  await logged("worker-stopped", "incompatible-flags", "127.0.0.4/32");
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
  // Resident memory, including file-backed pages, unlike workers' privateKb.
  const agentsBeforeKb = agentRssKb();
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
  const statsActiveEnd = workerStats();
  const agentKbPerClient = (agentRssKb() - agentsBeforeKb) / 31;
  console.log(JSON.stringify({
    resource: {
      build: "release",
      concurrency: 32,
      idleStart: statsIdle,
      idleEnd: statsIdleEnd,
      activeEnd: statsActiveEnd,
      activeTransactions: 3200,
      activeElapsedMs,
      agentKbPerClient,
      clockTicksPerSecond: Number(
        (await command(["getconf", "CLK_TCK"])).trim(),
      ),
    },
  }));
  pass(
    "32 optimized workers: actual private memory / CPU / descriptors / cgroups, idle and 3200 active transactions",
  );
  // With a MAX_PACKET buffer on every IPC receive, this gate measured on
  // x86_64 811 KiB per client in these two agents and a 900 KiB median worker.
  // With buffers sized from the packet: 78 KiB and 376 KiB. glibc keeps arena
  // memory at its high-water mark, so threads from earlier gates' clients hide
  // part of the old growth; the 811 already includes that.
  assert(agentKbPerClient <= 256, `agents grew ${agentKbPerClient} KiB/client`);
  const workerKb = statsActiveEnd.map((w) => w.privateKb).sort((x, y) => x - y);
  const medianKb = workerKb[workerKb.length >> 1];
  assert(medianKb <= 640, `median worker private ${medianKb} KiB`);
  pass("IPC receive buffers keep agent and worker memory per client bounded");
  for (const entry of pool.slice(1)) entry.client.close();
  await until(() => workerStats().length === 1);

  const burstStart = performance.now();
  for (let offset = 0; offset < 2048; offset += 64) {
    const replies = await Promise.all(
      Array.from({ length: 64 }, (_, index) =>
        client.request({
          type: "transact",
          space: spaces[1],
          sessionId: b,
          commit: {
            localSeq: 101 + offset + index,
            reads: { confirmed: [], pending: [] },
            operations: [{
              op: "set",
              id: "of:burst-drain",
              value: { value: offset + index },
            }],
          },
        })),
    );
    for (const reply of replies) {
      assert(reply.ok !== undefined, JSON.stringify(reply));
    }
  }
  // Idempotent releases of an unauthenticated principal exercise the link
  // agent's shared control budget without consuming challenge capacity.
  for (let offset = 0; offset < 512; offset += 64) {
    const replies = await Promise.all(
      Array.from(
        { length: 64 },
        () =>
          client.request({ type: "connection.release", principal: spaces[0] }),
      ),
    );
    for (const reply of replies) {
      assert(reply.ok !== undefined, JSON.stringify(reply));
    }
  }
  // Proof renewal remains ordered after the admitted transaction/control burst.
  await client.authenticate(bob, 180);
  assert(
    (await client.request({
      type: "session.watch.set",
      space: spaces[1],
      sessionId: b,
      watches: [],
    })).ok !== undefined,
  );
  console.log(JSON.stringify({
    burst: {
      transactions: 2048,
      controls: 512,
      outstanding: 64,
      elapsedMs: performance.now() - burstStart,
    },
  }));
  pass("transaction and control bursts drain and renew on the same socket");

  // Each gate below covers a failure found by probing the router.
  const signerFor = (index: number) => index === 0 ? alice : bob;
  const newestWorker = () =>
    workerStats().reduce<ReturnType<typeof workerStats>[number] | undefined>(
      (newest, w) => newest === undefined || w.uid > newest.uid ? w : newest,
      undefined,
    );
  /** A new client with one session, retried while a toolshed link recovers. */
  const opened = async (source: string, index: number, ms = 20000) => {
    const end = Date.now() + ms;
    for (;;) {
      const c = new Client(source);
      clients.push(c);
      try {
        await c.start();
        await c.authenticate(signerFor(index), 300, true);
        const r = await c.request({
          type: "session.open",
          space: spaces[index],
          principal: signerFor(index).did(),
          session: {},
        });
        if (r.ok !== undefined) {
          return {
            client: c,
            session: (r.ok as { sessionId: string }).sessionId,
          };
        }
      } catch { /* Retried below. */ }
      c.close();
      if (Date.now() >= end) throw new Error(`toolshed ${index} unavailable`);
      // Stays under the per-source admission rate.
      await pause(500);
    }
  };

  await command([
    "python3",
    "-c",
    "import socket, struct\n" +
    "s = socket.socket()\n" +
    "s.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER, struct.pack('ii', 1, 0))\n" +
    "s.connect(('127.0.0.1', 8443))\n" +
    "s.close()",
  ]);
  await pause(1000);
  assert(client.ws.readyState === WebSocket.OPEN, "a reset stopped the router");
  await opened("127.0.0.20", 0);
  pass("a connection reset before handoff drops only that connection");

  const browserLike = new Client("127.0.0.21", true);
  clients.push(browserLike);
  await browserLike.start();
  await browserLike.authenticate(alice, 60, true);
  const chromeAlgorithms = [
    "ecdsa_secp256r1_sha256",
    "rsa_pss_rsae_sha256",
    "rsa_pkcs1_sha256",
    "ecdsa_secp384r1_sha384",
    "rsa_pss_rsae_sha384",
    "rsa_pkcs1_sha384",
    "rsa_pss_rsae_sha512",
    "rsa_pkcs1_sha512",
  ].join(":");
  const handshake = await command([
    "bash",
    "-c",
    `openssl s_client -connect 127.0.0.1:8443 -servername localhost -tls1_3 ` +
    `-sigalgs ${chromeAlgorithms} -CAfile ${publicTls.cert} ` +
    `-verify_return_error </dev/null 2>&1`,
  ]);
  assert(handshake.includes("Verify return code: 0 (ok)"), handshake);
  pass(
    "browser handshake: Chrome's signature algorithms and a permessage-deflate offer",
  );

  const compressing = new Client("127.0.0.22");
  clients.push(compressing);
  await compressing.start({
    ...getMemoryProtocolFlags(),
    connectionAuth: true,
    routedAuthV1: true,
    messageCompressionV1: true,
  });
  assertEquals(
    (compressing.hello.flags as Record<string, unknown>).messageCompressionV1,
    true,
  );
  await compressing.authenticate(alice, 120, true);
  const compressedOpen = await compressing.request({
    type: "session.open",
    space: spaces[0],
    principal: alice.did(),
    session: {},
  });
  const compressedSession =
    (compressedOpen.ok as { sessionId: string }).sessionId;
  const large = Array.from(
    { length: 400 },
    (_, i) => `routed compression entry ${i}`,
  ).join(" ");
  assert(
    (await compressing.request({
      type: "transact",
      space: spaces[0],
      sessionId: compressedSession,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "of:compressed",
          value: { value: large },
        }],
      },
    })).ok !== undefined,
  );
  await compressing.request({
    type: "session.watch.set",
    space: spaces[0],
    sessionId: compressedSession,
    watches: [{
      id: "large",
      kind: "graph",
      query: {
        roots: [{ id: "of:compressed", selector: { path: [], schema: false } }],
      },
    }],
  });
  await until(() => compressing.binaryFrames > 0);
  pass("a client that negotiated compression receives compressed frames");
  // The toolshed answers each of these, so the ID was in flight and retired.
  for (let i = 0; i < 2; i++) {
    const reply = await compressing.requestWithId("reused", {
      type: "session.watch.set",
      space: spaces[0],
      sessionId: compressedSession,
      watches: [],
    });
    assert(reply.ok !== undefined, JSON.stringify(reply));
  }
  pass("a request ID can be reused once the toolshed has answered it");

  const steady = new Client("127.0.0.23");
  clients.push(steady);
  await steady.start();
  await steady.authenticate(alice, 300, true);
  await steady.authenticate(bob, 300);
  const steadySessions: string[] = [];
  for (const index of [0, 1]) {
    // This client's first open on toolshed 1 takes a ticket over its link
    // moments before the stall, so the link's idle heartbeat (after 15 quiet
    // seconds) cannot fall inside it.
    const r = await steady.request({
      type: "session.open",
      space: spaces[index],
      principal: signerFor(index).did(),
      session: {},
    });
    steadySessions.push((r.ok as { sessionId: string }).sessionId);
  }
  toolsheds[1].signal("SIGSTOP");
  const stalledWatch = steady.send({
    type: "session.watch.set",
    space: spaces[1],
    sessionId: steadySessions[1],
    watches: [],
  });
  const renewal = steady.send({ type: "connection.challenge" });
  await pause(6500);
  toolsheds[1].signal("SIGCONT");
  assert(
    (await steady.take((m) => m.requestId === stalledWatch)).ok !==
      undefined,
  );
  assert(
    (await steady.take((m) => m.requestId === renewal)).ok !== undefined,
  );
  assert(
    (await steady.request({
      type: "session.watch.set",
      space: spaces[0],
      sessionId: steadySessions[0],
      watches: [],
    })).ok !== undefined,
  );
  pass("a renewal while a toolshed stalls waits instead of closing the socket");

  const silent = await opened("127.0.0.24", 1);
  const silentWorker = newestWorker()!;
  // Stop reading: the router's pings go unanswered, as for a closed laptop.
  (silent.client.ws as unknown as { _socket: { pause(): void } })._socket
    .pause();
  await until(
    () => !workerStats().some((w) => w.pid === silentWorker.pid),
    60000,
  );
  pass("a client that stops answering pings loses its worker within a minute");

  const otherShed = new Client("127.0.0.25");
  clients.push(otherShed);
  await otherShed.start();
  await otherShed.authenticate(alice, 300, true);
  await otherShed.authenticate(bob, 300);
  const otherSession = await otherShed.request({
    type: "session.open",
    space: spaces[0],
    principal: alice.did(),
    session: {},
  });
  const restartedUser = await opened("127.0.0.26", 1);
  await toolsheds[1].stop();
  // Opening on the stopped toolshed refuses that open only.
  const refusedOpen = await otherShed.request({
    type: "session.open",
    space: spaces[1],
    principal: bob.did(),
    session: {},
  });
  assert(refusedOpen.error !== undefined, JSON.stringify(refusedOpen));
  // The toolshed will come back, so the refusal is retriable.
  assertEquals(
    (refusedOpen.error as { retriable?: boolean }).retriable,
    true,
  );
  assert(
    (await otherShed.request({
      type: "session.watch.set",
      space: spaces[0],
      sessionId: (otherSession.ok as { sessionId: string }).sessionId,
      watches: [],
    })).ok !== undefined,
  );
  pass("an open on a stopped toolshed is refused without closing the client");
  await toolsheds[1].start();
  await Promise.race([restartedUser.client.closed.promise, deadline(10000)]);
  pass("a toolshed restart closes the clients with sessions there");
  await opened("127.0.0.27", 1);
  pass("a restarted toolshed serves new clients without a router restart");
  assert(
    (await otherShed.request({
      type: "session.watch.set",
      space: spaces[0],
      sessionId: (otherSession.ok as { sessionId: string }).sessionId,
      watches: [],
    })).ok !== undefined,
  );
  // Bob signed before toolshed 1 relinked, so he signs again before opening there.
  const heldOpen = otherShed.send({
    type: "session.open",
    space: spaces[1],
    principal: bob.did(),
    session: {},
  });
  const pushedChallenge = await otherShed.take(
    (m) => m.type === "connection/challenge",
  );
  await otherShed.authenticate(bob, 300, false, pushedChallenge);
  assert(
    (await otherShed.take((m) => m.requestId === heldOpen)).ok !==
      undefined,
  );
  pass(
    "other clients stay connected and sign again before opening on the relinked toolshed",
  );

  const staller = new Client("127.0.0.28");
  clients.push(staller);
  await staller.start();
  await staller.authenticate(bob, 120, true);
  toolsheds[1].signal("SIGSTOP");
  const stalledOpen = staller.send({
    type: "session.open",
    space: spaces[1],
    principal: bob.did(),
    session: {},
  });
  // While that open waits on toolshed 1's link, a client of toolshed 0 is
  // not delayed by it.
  await pause(500);
  const challenged = performance.now();
  const challengeId = otherShed.send({ type: "connection.challenge" });
  assert(
    (await otherShed.take((m) => m.requestId === challengeId)).ok !==
      undefined,
  );
  assert(
    performance.now() - challenged < 2000,
    "a stalled toolshed delayed an unrelated client",
  );
  pass("a stalled toolshed does not delay clients of other toolsheds");
  await Promise.race([
    staller.closed.promise,
    staller.take((m) => m.requestId === stalledOpen).catch(() => {}),
  ]);
  toolsheds[1].signal("SIGCONT");
  await opened("127.0.0.29", 1, 30000);
  pass("a link stalled past its request deadline is replaced and recovers");

  // An SDK session survives its toolshed restarting: the refusals it meets
  // while the toolshed is down are retriable, so it holds the session, retries
  // the open and replays its pending commit instead of ending the session and
  // dropping the commit.
  {
    const factory = new RemoteSessionFactory(
      createStorageAddressResolver(new URL("https://localhost:8443")),
      bob,
      (address) => socketFactory(address, "127.0.0.37"),
    );
    try {
      const { client: connection, session } = await factory.create(
        spaces[1] as MemorySpace,
        bob,
      );
      try {
        await toolsheds[1].stop();
        const write = session.transact({
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "set",
            id: "of:survives-restart",
            value: { value: 1 },
          }],
        });
        await pause(2000);
        await toolsheds[1].start();
        await Promise.race([write, deadline(60000)]);
      } finally {
        await connection.close();
      }
    } finally {
      await factory.close();
    }
  }
  pass("an SDK session commits across its toolshed's restart");

  // With sharing on, one toolshed down holds only its own space: the shared
  // connection's other space keeps committing, the client opens no further
  // sockets while the toolshed stays down, and the held space commits once
  // its toolshed is back.
  {
    let sockets = 0;
    const factory = new RemoteSessionFactory(
      createStorageAddressResolver(new URL("https://localhost:8443")),
      alice,
      (address) => {
        sockets++;
        return socketFactory(address, "127.0.0.38");
      },
    );
    factory.setSharedConnections(true);
    try {
      const [up, down] = await Promise.all([
        factory.create(spaces[0] as MemorySpace, alice),
        factory.create(spaces[1] as MemorySpace, bob),
      ]);
      const write = (session: typeof up.session, id: string) =>
        session.transact({
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [{ op: "set", id, value: { value: 1 } }],
        });
      try {
        await toolsheds[1].stop();
        const held = write(down.session, "of:held-while-down");
        await Promise.race([
          write(up.session, "of:shared-while-down"),
          deadline(30000),
        ]);
        // The held space retries on this connection rather than reopening
        // the connection, which would interrupt the other space each time.
        // The router closes the socket after the stop on its own schedule,
        // so the count is taken once the reconnect has held the space.
        await until(() => down.session.held, 30000);
        const opened = sockets;
        await pause(3000);
        assertEquals(sockets, opened);
        await toolsheds[1].start();
        await Promise.race([held, deadline(60000)]);
      } finally {
        await up.client.close();
        await down.client.close();
      }
    } finally {
      await factory.close();
    }
  }
  pass(
    "a shared connection keeps committing to other spaces while one toolshed is down",
  );

  // Creation. An `unlisted` rule places every DID the directory does not
  // list, here alternately across both toolsheds by last character, and a
  // space is created as StorageManager.createSpace creates it: a fresh key
  // opens the space through the SDK and commits its genesis ACL. A router
  // reads the rule once, so it restarts to take it up, and the rule stays for
  // the remaining gates, which open only listed spaces.
  Deno.writeTextFileSync(
    directory,
    JSON.stringify({
      ...JSON.parse(Deno.readTextFileSync(directory)),
      unlisted: {
        epoch: 1,
        last_character: Object.fromEntries(
          [...BASE58_ALPHABET].map((c, i) => [c, i % 2]),
        ),
      },
    }),
  );
  await restartRouter();
  const stored = (space: string) =>
    [0, 1].some((i) => {
      try {
        Deno.statSync(
          resolveSpaceStoreUrl(
            toFileUrl(`${root}/store-${i}/`),
            space as MemorySpace,
          ),
        );
        return true;
      } catch {
        return false;
      }
    });
  const created: string[] = [];
  for (
    const [shared, localAddress] of [
      [false, "127.0.0.34"],
      [true, "127.0.0.35"],
    ] as const
  ) {
    const key = await Identity.generate();
    const space = key.did() as MemorySpace;
    const factory = new RemoteSessionFactory(
      createStorageAddressResolver(new URL("https://localhost:8443")),
      key,
      (address) => socketFactory(address, localAddress),
    );
    factory.setSharedConnections(shared);
    try {
      const { client: connection, session } = await factory.create(
        space,
        key,
        { sessionId: crypto.randomUUID() },
      );
      try {
        await session.transact({
          localSeq: 1,
          reads: {
            confirmed: [{
              id: aclDocId(space),
              path: toDocumentPath([]),
              seq: 0,
            }],
            pending: [],
          },
          operations: [{
            op: "set",
            id: aclDocId(space),
            value: { value: { [alice.did()]: "OWNER" } },
          }],
        });
      } finally {
        await connection.close();
      }
    } finally {
      await factory.close();
    }
    assert(stored(space));
    created.push(space);
  }
  pass(
    "the SDK creates a space through the router with its own key, sharing off and on",
  );
  // Each creation authenticates its key on the shared connection and then
  // releases it, as StorageManager.createSpace does, so twelve creations fit
  // a connection limited to eight principals at once. A close can cross the
  // creating session's revocation notice; the toolshed then answers it rather
  // than closing the connection.
  {
    const user = await Identity.generate();
    const factory = new RemoteSessionFactory(
      createStorageAddressResolver(new URL("https://localhost:8443")),
      user,
      (address) => socketFactory(address, "127.0.0.39"),
    );
    factory.setSharedConnections(true);
    try {
      for (let i = 0; i < 12; i++) {
        const key = await Identity.generate();
        const space = key.did() as MemorySpace;
        const { client: connection, session } = await factory.create(
          space,
          key,
          { sessionId: crypto.randomUUID() },
        );
        try {
          await session.transact({
            localSeq: 1,
            reads: {
              confirmed: [{
                id: aclDocId(space),
                path: toDocumentPath([]),
                seq: 0,
              }],
              pending: [],
            },
            operations: [{
              op: "set",
              id: aclDocId(space),
              value: { value: { [alice.did()]: "OWNER" } },
            }],
          });
        } finally {
          try {
            await connection.close();
          } finally {
            await connection.releasePrincipal?.(space);
          }
        }
        assert(stored(space), `creation ${i} left no store`);
      }
    } finally {
      await factory.close();
    }
  }
  pass("one shared connection creates more spaces than its principal limit");
  const members = await new Client("127.0.0.36").start();
  clients.push(members);
  await members.authenticate(alice, 180, true);
  await members.authenticate(bob, 180);
  for (const space of created) {
    const owner = await members.request({
      type: "session.open",
      space,
      principal: alice.did(),
      session: {},
    });
    const other = await members.request({
      type: "session.open",
      space,
      principal: bob.did(),
      session: {},
    });
    assert(
      owner.ok !== undefined && other.error !== undefined,
      JSON.stringify({ owner, other }),
    );
  }
  pass("a created space's genesis ACL then governs who opens it");
  const unclaimed = (await Identity.generate()).did();
  assert(
    (await members.request({
      type: "session.open",
      space: unclaimed,
      principal: bob.did(),
      session: {},
    })).error !== undefined,
  );
  assert(!stored(unclaimed));
  // A Home space is born on its first open by its own key; until its genesis
  // ACL lands, nobody else is admitted.
  const home = await members.request({
    type: "session.open",
    space: alice.did(),
    principal: alice.did(),
    session: {},
  });
  assert(home.ok !== undefined, JSON.stringify(home));
  assert(stored(alice.did()));
  assert(
    (await members.request({
      type: "session.open",
      space: alice.did(),
      principal: bob.did(),
      session: {},
    })).error !== undefined,
  );
  members.close();
  await members.closed.promise;
  pass(
    "a DID with no store is opened or created only by its own key, and nobody else opens it before genesis",
  );

  // Mode A runs at the deployment's cell representation. The router answers
  // every hello with the deployment's flags, which the SDK refuses
  // permanently. A client that ignores them and opens a space anyway is
  // refused by the toolshed's handshake, and the router closes its socket.
  setModernCellRepConfig(!modernCellRep);
  try {
    const refused = await MemoryClient.connect({
      transport: new WebSocketTransport(
        new URL("wss://localhost:8443/api/storage/memory"),
        true,
        () => {},
        (address) => socketFactory(address, "127.0.0.43"),
      ),
    }).then(async (client) => {
      await client.close();
      return undefined;
    }, (error: Error) => error);
    assert(
      refused?.message.includes("memory flag mismatch"),
      String(refused),
    );
  } finally {
    setModernCellRepConfig(modernCellRep);
  }
  const otherRep = await new Client("127.0.0.40").start({
    ...getMemoryProtocolFlags(),
    modernCellRep: !modernCellRep,
    connectionAuth: true,
    routedAuthV1: true,
  });
  clients.push(otherRep);
  assertEquals(
    (otherRep.hello.flags as Record<string, unknown>).modernCellRep,
    modernCellRep,
  );
  await otherRep.authenticate(alice, 60, true);
  const otherOpen = await otherRep.request({
    type: "session.open",
    space: spaces[0],
    principal: alice.did(),
    session: {},
  }).then((reply) => JSON.stringify(reply), (error: Error) => error);
  assert(otherOpen instanceof Error, String(otherOpen));
  await Promise.race([
    otherRep.closed.promise,
    pause(6000).then(() => {
      throw new Error("the router kept a refused client's socket open");
    }),
  ]);
  pass("a client at the other cell representation opens no session");

  // A real pattern through the router, which no protocol gate exercises: the
  // shipped profile-create pattern creates a profile in a space of its own,
  // and a second runtime reads its name back (support/routed-profile.ts). It
  // runs in a child process because the runtime locks its realm down with SES
  // and resets this process's experimental flags when it is disposed.
  {
    const fixture = `${root}/profile.json`;
    Deno.writeTextFileSync(
      fixture,
      JSON.stringify({
        url: "https://localhost:8443",
        ca: publicTls.cert,
        origin: "https://stage.example",
        sources: ["127.0.0.41", "127.0.0.42"],
        modernCellRep,
      }),
    );
    const started = Date.now();
    const child = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        `--config=${new URL("../../../deno.jsonc", import.meta.url).pathname}`,
        "-A",
        new URL("./support/routed-profile.ts", import.meta.url).pathname,
        fixture,
      ],
      stdout: "piped",
      stderr: "inherit",
    }).output();
    const result = new TextDecoder().decode(child.stdout).split("\n")
      .filter((line) => line.startsWith("{"))
      .map((line) => JSON.parse(line))
      .find((line) => "profileSpace" in line) as
        | { home: string; profileSpace: string; name: string }
        | undefined;
    assert(child.success && result !== undefined, `exit ${child.code}`);
    assertEquals(result.name, "Ada");
    assert(result.profileSpace !== result.home);
    assert(stored(result.home) && stored(result.profileSpace));
    console.log(JSON.stringify({
      profileCreationMs: Date.now() - started,
      modernCellRep,
    }));
  }
  pass(
    "a real pattern creates a profile in a space of its own through the router, and a second runtime reads its name",
  );

  // The cell representation is a mode the router takes from its config, not
  // a capability its toolsheds vote on. A toolshed misconfigured at the other
  // one, even the only one that links within the startup grace, never decides
  // what the router advertises; its spaces are refused while it stays
  // misconfigured, and it is admitted once it runs the deployment's.
  await toolsheds[0].stop();
  await toolsheds[1].stop();
  await toolsheds[1].start(!modernCellRep);
  const restarted = restartRouter();
  await pause(12000);
  await toolsheds[0].start();
  await restarted;
  const representation = await new Client("127.0.0.44").start();
  clients.push(representation);
  assertEquals(
    (representation.hello.flags as Record<string, unknown>).modernCellRep,
    modernCellRep,
  );
  await representation.authenticate(bob, 60, true);
  const misconfigured = await representation.request({
    type: "session.open",
    space: spaces[1],
    principal: bob.did(),
    session: {},
  });
  assert(misconfigured.ok === undefined, JSON.stringify(misconfigured));
  representation.close();
  await toolsheds[1].stop();
  await toolsheds[1].start();
  await opened("127.0.0.45", 1, 45000);
  pass(
    "a toolshed at the other cell representation never sets the router's flags, and is admitted once it runs the deployment's",
  );

  await toolsheds[0].stop();
  await opened("127.0.0.30", 1);
  pass("authentication does not depend on toolshed 0");
  await restartRouter();
  await opened("127.0.0.31", 1, 30000);
  pass("the router starts while a toolshed is down");
  await toolsheds[0].start();
  const revokee = await opened("127.0.0.32", 0, 30000);
  pass("a toolshed down at router start joins once it is up");

  await toolsheds[0].command({ revoke: router.did() });
  await Promise.race([
    revokee.client.closed.promise,
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
  for (const shed of toolsheds) await shed.stop();
  Deno.removeSync(root, { recursive: true });
}
