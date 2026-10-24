/** Disposable Linux acceptance against a compiled Rust router and real SQLite toolsheds. */
import {
  deepFreeze,
  fabricFromConvertibleJsValue,
  taggedHashStringOf,
} from "@commonfabric/data-model";
import { setModernCellRepConfig } from "@commonfabric/data-model/cell-rep";
import { Identity } from "@commonfabric/identity";
import { isPlainObject } from "@commonfabric/utils/types";
import { assert, assertEquals } from "@std/assert";
import { expect } from "@std/expect";
import { fromFileUrl, toFileUrl } from "@std/path";
// @ts-types="@types/ws"
import WebSocket from "ws";
import { Client as MemoryClient, type SessionPrincipal } from "../v2/client.ts";
import {
  createSignedConnectionAuth,
  createStorageAddressResolver,
  RemoteSessionFactory,
  ROUTED_FRAME_SLOTS,
  WebSocketTransport,
} from "../../runner/src/storage/v2-remote-session.ts";
import { aclDocId } from "../acl.ts";
import type { MemorySpace } from "../interface.ts";
import {
  type ClientCommit,
  type ClientMessage,
  encodeMemoryBoundary,
  getMemoryProtocolFlags,
  type SessionReport,
  toDocumentPath,
  type WatchSpec,
} from "../v2.ts";
import { compressClientMessageLabels } from "../v2/commit-label-table.ts";
import { BASE58_ALPHABET } from "../v2/routed-directory.ts";
import { decodeRoutedFrame } from "../v2/routed-parser.ts";
import {
  readRoutedHex,
  routedBase64,
  routedStatementPayload,
} from "../v2/routed-wire.ts";
import {
  decodeRouterHeader,
  decodeRouterRecord,
  RouterAssembler,
  routerRecords,
  routerRoute,
} from "../v2/router-protocol.ts";
import { resolveSpaceStoreUrl } from "../v2/storage-path.ts";
import { countValues } from "./support/routed-slots.ts";

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
    max_watches_per_session: 1024,
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
  // The event names the source only by a keyed hash: 96 bits as hex. The
  // address itself appears nowhere in what the router logs.
  const found = async () => {
    const log = await listenerLog();
    if (log.includes(source.replace(/\/\d+$/, ""))) {
      throw new Error(`the router logged the address ${source}`);
    }
    return log.split("\n").some((line) => {
      try {
        const e = JSON.parse(line);
        return e.event === "memory-router-connection" &&
          e.verdict === verdict && e.reason === reason &&
          e.source === undefined && /^[0-9a-f]{24}$/.test(e.source_hash);
      } catch {
        return false;
      }
    });
  };
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
  #changed = Promise.withResolvers<void>();
  #failure?: Error;
  #output?: Promise<void>;
  constructor(readonly index: number) {}
  /** Starts a fixture with the requested wire mode, capabilities and slot cap. */
  async start(
    modern = modernCellRep,
    omitSyncLabelTableV1 = false,
    frameSlots?: number | null,
  ) {
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
        omitSyncLabelTableV1,
        omitCommitLabelTableV1: omitSyncLabelTableV1,
        ...(frameSlots === undefined ? {} : { frameSlots }),
      }),
    );
    this.child = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--frozen",
        `--config=${
          fromFileUrl(new URL("../../../deno.jsonc", import.meta.url))
        }`,
        "-A",
        fromFileUrl(new URL("./support/routed-toolshed.ts", import.meta.url)),
        config,
      ],
      stdin: "piped",
      stdout: "piped",
      stderr: "inherit",
    }).spawn();
    this.#writer = this.child.stdin.getWriter();
    this.#lines = [];
    this.#failure = undefined;
    this.#output = (async () => {
      try {
        let held = "";
        for await (
          const chunk of this.child!.stdout.pipeThrough(new TextDecoderStream())
        ) {
          held += chunk;
          let newline: number;
          while ((newline = held.indexOf("\n")) >= 0) {
            this.#lines.push(held.slice(0, newline));
            held = held.slice(newline + 1);
            this.#notify();
          }
        }
        this.#failure = new Error(`toolshed ${i} output closed`);
      } catch (error) {
        this.#failure = error instanceof Error
          ? error
          : new Error(String(error));
      } finally {
        this.#notify();
      }
    })();
    await this.#line((line) => line.includes('"ready":true'));
  }
  #notify() {
    const changed = this.#changed;
    this.#changed = Promise.withResolvers<void>();
    changed.resolve();
  }
  async #line(match: (line: string) => boolean) {
    for (;;) {
      const i = this.#lines.findIndex(match);
      if (i >= 0) return this.#lines.splice(0, i + 1).pop()!;
      if (this.#failure !== undefined) throw this.#failure;
      await this.#changed.promise;
    }
  }
  async command(command: Record<string, unknown>) {
    await this.#writer!.write(
      new TextEncoder().encode(`${JSON.stringify(command)}\n`),
    );
    return JSON.parse(
      await this.#line((line) => line.includes('"acknowledged":true')),
    );
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
    await this.#output;
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

/** Compares canonical values without constructing an unbounded text diff. */
function expectCanonicalEqual(
  actual: unknown,
  expected: unknown,
  label: string,
  actualEvidence = actual,
  expectedEvidence = expected,
) {
  const actualValue = fabricFromConvertibleJsValue(actual);
  const expectedValue = fabricFromConvertibleJsValue(expected);
  const actualText = encodeMemoryBoundary(actualValue);
  const expectedText = encodeMemoryBoundary(expectedValue);
  const actualHash = taggedHashStringOf(actualValue);
  const expectedHash = taggedHashStringOf(expectedValue);
  if (actualHash === expectedHash && actualText === expectedText) return;

  /** Returns a bounded description of one decoded JSON value. */
  const summary = (value: unknown): unknown => {
    if (Array.isArray(value)) return { type: "array", length: value.length };
    if (isPlainObject(value)) {
      const keys = Object.keys(value);
      return { type: "object", keyCount: keys.length, keys: keys.slice(0, 12) };
    }
    return typeof value === "string" && value.length > 160
      ? { type: "string", length: value.length, prefix: value.slice(0, 160) }
      : value;
  };

  /** Locates the first unequal JSON field while retaining array order. */
  const firstDifference = (
    actual: unknown,
    expected: unknown,
    path: string[] = [],
  ): unknown => {
    if (Object.is(actual, expected)) return undefined;
    if (Array.isArray(actual) && Array.isArray(expected)) {
      if (actual.length === expected.length) {
        for (let i = 0; i < actual.length; i++) {
          const difference = firstDifference(actual[i], expected[i], [
            ...path,
            String(i),
          ]);
          if (difference !== undefined) return difference;
        }
        return undefined;
      }
    } else if (isPlainObject(actual) && isPlainObject(expected)) {
      for (
        const key of new Set([...Object.keys(actual), ...Object.keys(expected)])
      ) {
        const actualPresent = Object.hasOwn(actual, key);
        const expectedPresent = Object.hasOwn(expected, key);
        if (actualPresent !== expectedPresent) {
          return {
            path: [...path, key],
            actualPresent,
            expectedPresent,
            actual: summary(actual[key]),
            expected: summary(expected[key]),
          };
        }
        const difference = firstDifference(actual[key], expected[key], [
          ...path,
          key,
        ]);
        if (difference !== undefined) return difference;
      }
      return undefined;
    }
    return { path, actual: summary(actual), expected: summary(expected) };
  };

  // This separate directory survives the exercise's fixture cleanup.
  const evidence = Deno.makeTempDirSync({
    prefix: "routed-router-difference-",
  });
  Deno.writeTextFileSync(
    `${evidence}/actual.fvj1`,
    encodeMemoryBoundary(fabricFromConvertibleJsValue(actualEvidence)),
  );
  Deno.writeTextFileSync(
    `${evidence}/expected.fvj1`,
    encodeMemoryBoundary(fabricFromConvertibleJsValue(expectedEvidence)),
  );
  const diagnostics = {
    label,
    evidence,
    actualHash,
    expectedHash,
    actualCodeUnits: actualText.length,
    expectedCodeUnits: expectedText.length,
    firstDifference: firstDifference(
      JSON.parse(actualText.slice(5)),
      JSON.parse(expectedText.slice(5)),
    ),
  };
  Deno.writeTextFileSync(
    `${evidence}/summary.json`,
    JSON.stringify(diagnostics, null, 2),
  );
  throw new Error(JSON.stringify(diagnostics));
}

/**
 * Waits for a router role to create `path`. A role that never does, as the
 * link agent does not while it can open no toolshed link, fails the exercise
 * after `ms` instead of holding it open. The longest wait a working router
 * needs is in the cell-representation gate, 43 to 44 seconds: the router is
 * restarted with no toolshed it can link to, twelve seconds pass, and the
 * toolshed then started has thirty seconds to come up. The bound is twice
 * that.
 */
async function waitFile(path: string, ms = 90_000) {
  const watcher = Deno.watchFs(path.slice(0, path.lastIndexOf("/")));
  let expired = false;
  // Closing the watcher ends the loop below.
  const timer = setTimeout(() => {
    expired = true;
    watcher.close();
  }, ms);
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
    clearTimeout(timer);
    if (!expired) watcher.close();
  }
  // The file may have appeared as the timer fired, after the last event the
  // loop saw.
  if (exists()) return;
  throw new Error(
    expired
      ? `not ready after ${ms} ms: ${path}`
      : `readiness watcher closed: ${path}`,
  );
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
            ROUTED_FRAME_SLOTS,
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
    flags: Partial<ReturnType<typeof getMemoryProtocolFlags>> = {
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

    // No client has connected yet. Waiting on process exit and the journal
    // keeps the public listener idle throughout automatic recovery.
    assertEquals(clients.length, 0);
    assertEquals(workerStats().length, 0);
    const idleRecovery = await command([
      "python3",
      "-c",
      String.raw`
import json, os, pathlib, select, signal, subprocess, sys

unit = "memory-router-listener.service"

def state():
    output = subprocess.check_output([
        "systemctl", "show", unit,
        "--property=MainPID,InvocationID,NRestarts,Type,ActiveState,SubState",
    ], text=True)
    return dict(line.split("=", 1) for line in output.splitlines())

def processes(state):
    listener = int(state["MainPID"])
    assert listener > 0, state
    # Type=notify follows the fork, but the child's command line can still
    # name the listener until exec. The kernel's parent-child relation already
    # identifies the supervised process, including that pre-exec interval.
    children = pathlib.Path(
        f"/proc/{listener}/task/{listener}/children"
    ).read_text().split()
    assert len(children) == 1, (state, children)
    return listener, int(children[0])

before = state()
assert before["Type"] == "notify", before
assert before["ActiveState"] == "active", before
assert before["SubState"] == "running", before
assert before["InvocationID"], before
listener, spawner = processes(before)

# A cursor replays every event after this point even if the restart happens
# before journalctl attaches. Sync includes the completed initial start.
subprocess.run(["journalctl", "--sync"], check=True)
last = subprocess.check_output([
    "journalctl", "--unit", unit, "--lines=1", "--output=json", "--no-pager",
], text=True)
cursor = json.loads(last)["__CURSOR"]
journal = subprocess.Popen([
    "journalctl", "--unit", unit, "--follow", "--lines=all", "--output=json",
    "--after-cursor", cursor, "--no-pager",
], stdout=subprocess.PIPE, text=True)
events = []
exit_event = restart_event = None
after = None
try:
    listener_fd = os.pidfd_open(listener)
    try:
        spawner_fd = os.pidfd_open(spawner)
        try:
            signal.pidfd_send_signal(spawner_fd, signal.SIGKILL)
        finally:
            os.close(spawner_fd)
        select.select([listener_fd], [], [])
    finally:
        os.close(listener_fd)

    for line in journal.stdout:
        event = json.loads(line)
        events.append(event)
        if event.get("_PID") != "1" or event.get("UNIT") != unit:
            continue
        message_id = event.get("MESSAGE_ID")
        if (message_id == "98e322203f7a4ed290d09fe03c09fe15"
                and event.get("COMMAND") == "ExecStart"):
            assert exit_event is None, events
            assert event.get("INVOCATION_ID") == before["InvocationID"], event
            assert event.get("EXIT_CODE") == "exited", event
            assert int(event["EXIT_STATUS"]) != 0, event
            exit_event = event
        elif message_id == "5eb03494b6584870a536b337290809b3":
            # Requires=/PartOf= can propagate the automatic restart through the
            # target and fully stop this service, resetting NRestarts. This
            # event records automatic recovery across that state transition.
            assert exit_event is not None and restart_event is None, events
            assert event.get("INVOCATION_ID") == before["InvocationID"], event
            # This event also covers a manual start that accelerates a pending
            # restart; systemd identifies that shortcut in its message.
            assert "immediately on client request" not in event["MESSAGE"], event
            restart_event = event
        # systemd emits UNIT_STARTED only after the Type=notify readiness.
        elif message_id == "39f53479d3a045ac8e11786248231fbf":
            assert exit_event is not None and restart_event is not None, events
            assert event.get("INVOCATION_ID"), event
            assert event["INVOCATION_ID"] != before["InvocationID"], event
            break
    else:
        raise AssertionError("journal ended before the listener restarted")

    after = state()
    assert after["ActiveState"] == "active", after
    assert after["SubState"] == "running", after
    assert int(after["MainPID"]) > 0, after
    assert after["MainPID"] != before["MainPID"], (before, after)
    assert after["InvocationID"] == event["INVOCATION_ID"], (event, after)
    next_listener, next_spawner = processes(after)
    assert next_listener != listener and next_spawner != spawner
    print(json.dumps({"idleSpawnerRecovery": {
        "before": {"listener": listener, "spawner": spawner},
        "after": {"listener": next_listener, "spawner": next_spawner},
        "exit": exit_event, "restart": restart_event, "ready": event,
    }}))
except BaseException:
    print(json.dumps({"before": before, "after": after, "events": events}),
          file=sys.stderr)
    raise
finally:
    journal.terminate()
    journal.wait()
    journal.stdout.close()
`,
    ]);
    console.log(idleRecovery.trim());
    assertEquals(workerStats().length, 0);
    pass(
      "an idle spawner exit automatically restarts the listener without client traffic",
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
    expect(sdk.serverFlags?.sessionReportV1).toBe(true);
    for (
      const [i, session, signer] of [[0, sa, alice], [1, sb, bob]] as const
    ) {
      const trip: SessionReport = {
        kind: "echo-breaker",
        event: "trip",
        document: { id: "of:fixture-data", scopeKey: "space" },
        action: `cf:router-report-${i}`,
      };
      const clear: SessionReport = {
        ...trip,
        event: "clear",
        reason: "convergence",
        renewals: 2,
        trippedMs: 1500,
      };
      await session.sendReport(trip);
      await session.sendReport(clear);
      // `sendReport()` swallows refusals, so completion alone proves nothing.
      const { sessionReports } = await toolsheds[i].command({
        sessionReports: true,
      });
      expect(sessionReports).toEqual({
        echoBreaker: {
          trips: 1,
          clears: { convergence: 1, quiet: 0, retired: 0, evicted: 0 },
        },
        recent: [trip, clear].map((report) => ({
          ...report,
          at: expect.any(Number),
          space: spaces[i],
          session: session.sessionId,
          principal: signer.did(),
        })),
      });
    }
    pass(
      "session.report round trips through the router to each owning toolshed with session and principal attribution",
    );
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
            connectionAuth: false,
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
    routedCompressionV1: true,
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
  await compressing.take((message) =>
    message.type === "session/effect" &&
    message.sessionId === compressedSession
  );
  // The toolshed compressed its large bodies; the router forwarded the
  // envelopes opaquely and the client expanded them.
  assert(compressing.binaryFrames > 0);
  assertEquals(
    (await compressing.request({ type: "memory.compression", enabled: true }))
      .enabled,
    true,
  );
  // A client that predates `routedCompressionV1` gets the same effect as text.
  const older = new Client("127.0.0.54");
  clients.push(older);
  await older.start({
    ...getMemoryProtocolFlags(),
    connectionAuth: true,
    routedAuthV1: true,
    messageCompressionV1: true,
  });
  await older.authenticate(alice, 120, true);
  const olderSession = ((await older.request({
    type: "session.open",
    space: spaces[0],
    principal: alice.did(),
    session: {},
  })).ok as { sessionId: string }).sessionId;
  // The watch result carries the large document. (The compressing client's
  // later effect follows from its own commit; this client made none.)
  const olderWatch = await older.request({
    type: "session.watch.set",
    space: spaces[0],
    sessionId: olderSession,
    watches: [{
      id: "large",
      kind: "graph",
      query: {
        roots: [{ id: "of:compressed", selector: { path: [], schema: false } }],
      },
    }],
  });
  assert(JSON.stringify(olderWatch).includes("routed compression entry 399"));
  assertEquals(older.binaryFrames, 0);
  older.close();
  await older.closed.promise;
  pass(
    "a client that negotiated routedCompressionV1 receives large bodies as the toolshed's compression envelope, forwarded opaquely, with a truthful acknowledgement; one that predates it receives text",
  );
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
  // A kinded genesis. The SDK creates a space whose signed open declares a
  // kind and whose genesis commit carries the same kind, as
  // StorageManager.createSpace does with `genesis.spaceKind`; the toolshed
  // seals the kind with the ACL. A session opened before the space has
  // history is told no kind; a member's later open is told the sealed one.
  // A space kind is a genesis declaration, admitted only on a space-key ACL
  // genesis, so a WRITE member's ordinary commit carrying one is refused.
  {
    const key = await Identity.generate();
    const kinded = key.did() as MemorySpace;
    const factory = new RemoteSessionFactory(
      createStorageAddressResolver(new URL("https://localhost:8443")),
      key,
      (address) => socketFactory(address, "127.0.0.46"),
    );
    try {
      const { client: connection, session } = await factory.create(
        kinded,
        key,
        { sessionId: crypto.randomUUID(), spaceKind: "exercise-kind" },
      );
      try {
        assertEquals(session.declaredSpaceKind, undefined);
        await session.transact({
          spaceKind: "exercise-kind",
          localSeq: 1,
          reads: {
            confirmed: [{
              id: aclDocId(kinded),
              path: toDocumentPath([]),
              seq: 0,
            }],
            pending: [],
          },
          operations: [{
            op: "set",
            id: aclDocId(kinded),
            value: {
              value: { [alice.did()]: "OWNER", [bob.did()]: "WRITE" },
            },
          }],
        });
      } finally {
        await connection.close();
      }
    } finally {
      await factory.close();
    }
    assert(stored(kinded));
    const owner = await members.request({
      type: "session.open",
      space: kinded,
      principal: alice.did(),
      session: {},
    });
    assertEquals(
      (owner.ok as { spaceKind?: string } | undefined)?.spaceKind,
      "exercise-kind",
      JSON.stringify(owner),
    );
    const writer = await members.request({
      type: "session.open",
      space: kinded,
      principal: bob.did(),
      session: {},
    });
    assert(writer.ok !== undefined, JSON.stringify(writer));
    const refused = await members.request({
      type: "transact",
      space: kinded,
      sessionId: (writer.ok as { sessionId: string }).sessionId,
      commit: {
        spaceKind: "exercise-kind",
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{ op: "set", id: "of:kinded", value: { value: 1 } }],
      },
    });
    assertEquals(
      (refused.error as { message?: string } | undefined)?.message,
      "A space kind requires space-key ACL genesis",
      JSON.stringify(refused),
    );
  }
  pass(
    "a kinded genesis through the router seals the kind, which a later open reports and no member's commit may carry",
  );
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

  {
    const legacy = await new Client("127.0.0.47").start();
    clients.push(legacy);
    try {
      expect(legacy.hello.routerTransport).toBe(1);
      expect(legacy.hello.routerUploadWindow).toBe(262_144);
      expect(legacy.hello.routerFrameSlots).toBe(ROUTED_FRAME_SLOTS);
      legacy.ws.send('fvj1:{"type":"router.transport","version":1}');
      await legacy.authenticate(alice, 300, true);
      const opened = await legacy.request({
        type: "session.open",
        space: spaces[0],
        principal: alice.did(),
        session: {},
      });
      expect(opened).toHaveProperty("ok.sessionId");
      const request = {
        type: "graph.query",
        requestId: "uncredited-records",
        space: spaces[0],
        sessionId: (opened.ok as { sessionId: string }).sessionId,
        query: { roots: [] },
      };
      for (
        const record of routerRecords(
          routerRoute(request),
          `fvj1:${JSON.stringify(request)}`,
        )
      ) legacy.ws.send(record);
      expect(await legacy.take((m) => m.requestId === request.requestId))
        .toHaveProperty("ok");
      // This connection-level barrier follows acceptance of the end record,
      // including any credit that acceptance would have queued.
      expect(await legacy.request({ type: "connection.challenge" }))
        .toHaveProperty("ok");
      expect(legacy.binaryFrames).toBe(0);
      expect(legacy.ws.readyState).toBe(WebSocket.OPEN);
    } finally {
      legacy.close();
      await legacy.closed.promise;
    }
    pass("router upload credits require explicit selection opt-in");

    const window = 262_144;
    const threeMiB = 3 * 1024 * 1024;
    const fourMiB = 4 * 1024 * 1024;
    // Repetition across small documents exercises both metadata tables
    // without repeating paths within a stored label map.
    const labelRoots = Array.from({ length: 8 }, (_, index) => ({
      id: `of:routed-label-${index}`,
      selector: { path: [], schema: false as const },
    }));
    const schemaHash = taggedHashStringOf(true);
    const labelWatch: WatchSpec = {
      id: "routed-labels",
      kind: "graph",
      query: { roots: labelRoots },
    };

    /** Builds stored metadata and application lookalikes for exact readback. */
    const labeledDocument = (marker: number, version: number) => ({
      value: {
        marker,
        version,
        labelTable: [7],
        labelPathTable: [["ordinary-data"]],
        cfc: { labelMap: { entries: [{ path: 0, label: 0 }] } },
      },
      cfc: {
        version: 1,
        schemaHash,
        labelMap: {
          version: 1,
          entries: [{
            path: ["marker"],
            label: {
              confidentiality: ["routed-label-secret"],
              integrity: [],
            },
          }, {
            path: ["version"],
            label: {
              confidentiality: [],
              integrity: ["routed-label-origin"],
            },
          }],
        },
      },
    });

    /** Checks wire refs independently, or exact SDK/legacy inline metadata. */
    const checkLabels = (
      sync: unknown,
      compact: boolean,
      version: number,
    ) => {
      assert(isPlainObject(sync) && Array.isArray(sync.upserts));
      if (compact) {
        expect(sync.labelTable).toHaveLength(2);
        expect(sync.labelPathTable).toHaveLength(2);
      } else {
        expect(Object.hasOwn(sync, "labelTable")).toBe(false);
        expect(Object.hasOwn(sync, "labelPathTable")).toBe(false);
      }
      for (const [index, root] of labelRoots.entries()) {
        const upsert = sync.upserts.find((entry: unknown) =>
          isPlainObject(entry) && entry.id === root.id
        );
        assert(isPlainObject(upsert) && isPlainObject(upsert.doc));
        const expected = labeledDocument(index, version);
        if (!compact) {
          expect(upsert.doc).toEqual(expected);
          continue;
        }
        const cfc = upsert.doc.cfc;
        assert(isPlainObject(cfc) && isPlainObject(cfc.labelMap));
        const entries = cfc.labelMap.entries;
        assert(Array.isArray(entries));
        expect(entries).toHaveLength(expected.cfc.labelMap.entries.length);
        const { labelTable, labelPathTable } = sync;
        assert(Array.isArray(labelTable));
        assert(Array.isArray(labelPathTable));
        const expandedEntries = entries.map((entry: unknown) => {
          assert(isPlainObject(entry));
          assert(typeof entry.label === "number");
          assert(typeof entry.path === "number");
          return {
            ...entry,
            label: labelTable[entry.label],
            path: labelPathTable[entry.path],
          };
        });
        expect({
          ...upsert.doc,
          cfc: {
            ...cfc,
            labelMap: { ...cfc.labelMap, entries: expandedEntries },
          },
        }).toEqual(expected);
      }
    };

    /**
     * Expands one public frame a client receives: text, or a toolshed body in
     * the routed compression envelope. A binary frame that is not the envelope
     * is a router credit, and gives `undefined`.
     */
    const publicFrame = (
      bytes: unknown,
      binary: boolean,
      frameSlots: number | null = ROUTED_FRAME_SLOTS,
    ) => {
      if (!binary) {
        return decodeRoutedFrame(String(bytes), false, frameSlots);
      }
      assert(bytes instanceof ArrayBuffer);
      const frame = new Uint8Array(bytes);
      if (new TextDecoder().decode(frame.subarray(0, 5)) !== "mcmp\x02") {
        return undefined;
      }
      return decodeRoutedFrame(frame, true, frameSlots);
    };

    /** Observes complete public requests using the transport's record assembler. */
    const observeRequests = (
      connection: ReturnType<typeof socketFactory>,
      observe: (message: Record<string, unknown>, bytes: number) => void,
      frameSlots: number | null = ROUTED_FRAME_SLOTS,
    ) => {
      const assembler = new RouterAssembler();
      return {
        socket: connection.socket,
        send(frame: string | Uint8Array): void {
          const payload = typeof frame === "string"
            ? frame
            : assembler.receive(frame)?.payload;
          if (payload !== undefined) {
            // A compressed upload is measured by its expanded payload, the
            // size the request bounds and the label tables are about.
            const decoded = decodeRoutedFrame(payload, true, frameSlots);
            observe(
              decoded.body,
              new TextEncoder().encode(decoded.payload).length,
            );
          }
          connection.send(frame);
        },
      };
    };

    const traces: {
      socket: WebSocket;
      selected: boolean;
      sentBytes: number;
      creditedBytes: number;
      grants: number;
      completed: number;
      transactionReplies: number;
      headers: ReturnType<typeof decodeRouterHeader>[];
      syncMessages: Record<string, unknown>[];
    }[] = [];

    /** Observes actual public writes without giving `send()` a drain promise. */
    const creditSocket = (address: URL) => {
      const connection = socketFactory(address, "127.0.0.48");
      const headers: ReturnType<typeof decodeRouterHeader>[] = [];
      const syncMessages: Record<string, unknown>[] = [];
      const trace = {
        socket: connection.socket,
        selected: false,
        sentBytes: 0,
        creditedBytes: 0,
        grants: 0,
        completed: 0,
        transactionReplies: 0,
        headers,
        syncMessages,
      };
      traces.push(trace);
      connection.socket.on("message", (bytes, binary) => {
        const envelope = binary && bytes instanceof ArrayBuffer &&
          bytes.byteLength >= 5 &&
          new TextDecoder().decode(new Uint8Array(bytes, 0, 5)) === "mcmp\x02";
        if (binary && !envelope) {
          // Besides toolshed bodies in the compression envelope, a credited
          // connection's binary frames are router-owned grants.
          expect(trace.selected).toBe(true);
          assert(bytes instanceof ArrayBuffer);
          expect(bytes.byteLength).toBe(8);
          expect(new Uint8Array(bytes, 0, 4)).toEqual(
            new Uint8Array([0x6d, 0x72, 0x63, 0x01]),
          );
          const grant = new DataView(bytes).getUint32(4, false);
          expect(grant).toBeGreaterThan(0);
          expect(grant).toBeLessThanOrEqual(
            trace.sentBytes - trace.creditedBytes,
          );
          trace.creditedBytes += grant;
          trace.grants++;
          return;
        }
        const message = decodeRoutedFrame(
          envelope ? new Uint8Array(bytes as ArrayBuffer) : bytes.toString(),
          true,
          ROUTED_FRAME_SLOTS,
        ).body;
        expect(message.type).not.toBe("router.credit");
        if (
          message.type === "session/effect" ||
          (message.type === "response" && isPlainObject(message.ok) &&
            isPlainObject(message.ok.sync))
        ) syncMessages.push(message);
        if (message.type === "hello.ok") {
          expect(message.routerTransport).toBe(1);
          expect(message.routerUploadWindow).toBe(window);
          expect(message.flags).toHaveProperty("syncLabelTableV1", true);
        } else if (
          message.type === "response" &&
          trace.headers.some((header) =>
            header.route.type === "transact" &&
            header.route.requestId === message.requestId
          )
        ) {
          expect(message).toHaveProperty("ok");
          trace.transactionReplies++;
        }
      });
      return {
        socket: connection.socket,
        send: (frame: string | Uint8Array): void => {
          if (typeof frame === "string") {
            expect(trace.selected).toBe(false);
            const message = decodeRoutedFrame(frame, false, ROUTED_FRAME_SLOTS)
              .body;
            if (message.type === "router.transport") {
              expect(message).toEqual({
                type: "router.transport",
                version: 1,
                uploadCredits: true,
              });
              trace.selected = true;
            } else {
              expect(message.type).toBe("hello");
              expect(message.flags).toHaveProperty("syncLabelTableV1", true);
            }
          } else {
            expect(trace.selected).toBe(true);
            const record = decodeRouterRecord(frame);
            if (record.kind === 0) {
              trace.headers.push(decodeRouterHeader(frame));
            } else if (record.kind === 2) {
              trace.completed++;
            }
            trace.sentBytes += frame.byteLength;
            const outstanding = trace.sentBytes - trace.creditedBytes;
            expect(outstanding).toBeLessThanOrEqual(window);
          }
          connection.send(frame);
        },
      };
    };

    const uploading = await MemoryClient.connect({
      transport: new WebSocketTransport(
        new URL("wss://localhost:8443/api/storage/memory"),
        true,
        () => {},
        creditSocket,
      ),
    });
    try {
      const session = await uploading.mount(spaces[0], {}, {
        did: alice.did(),
        authorizeConnection: (context) =>
          createSignedConnectionAuth(alice, context),
        authorizeSessionOpen: () => {
          throw new Error("Expected routed connection authorization");
        },
      });
      const trace = traces[0];
      const roots = Array.from({ length: 16 }, (_, i) => ({
        id: `of:upload-credit-watch-${i}-${"x".repeat(224)}`,
        selector: { path: [], schema: false as const },
      }));
      const payloads = Array.from({ length: 12 }, (_, i) => ({
        id: `of:credit-upload-${i}`,
        value: `${i}:${"u".repeat(384 * 1024)}`,
      }));
      const beforeUpload = {
        bytes: trace.creditedBytes,
        grants: trace.grants,
      };
      // Submit the whole burst without waiting between commits. Each body
      // fits both peers' hard queues; native `send()` still needs credits
      // to bound accumulated output across the queued logical messages.
      await Promise.all(
        payloads.map(({ id, value }, i) =>
          session.transact({
            localSeq: i + 1,
            reads: { confirmed: [], pending: [] },
            operations: [
              { op: "set", id, value: { value } },
              ...(i === 0
                ? roots.map(({ id }, marker) => ({
                  op: "set" as const,
                  id,
                  value: { value: { marker } },
                }))
                : []),
            ],
          })
        ),
      );
      const uploads = trace.headers.filter((header) =>
        header.route.type === "transact"
      );
      expect(uploads).toHaveLength(payloads.length);
      expect(trace.transactionReplies).toBe(payloads.length);
      expect(uploads.reduce((sum, header) => sum + header.bytes, 0))
        .toBeGreaterThan(fourMiB);
      for (const upload of uploads) {
        expect(upload.bytes).toBeLessThan(512 * 1024);
      }
      expect(trace.creditedBytes - beforeUpload.bytes)
        .toBeGreaterThan(fourMiB);
      expect(trace.grants - beforeUpload.grants).toBeGreaterThan(1);
      // Sequential reads keep response output below the hard queue limit.
      for (const { id, value } of payloads) {
        const result = await session.queryGraph({
          roots: [{
            id,
            selector: { path: [], schema: false },
          }],
        });
        expect(result.entities).toHaveLength(1);
        expect(result.entities[0].document?.value).toBe(value);
      }
      expect(traces).toHaveLength(1);
      expect(trace.socket.readyState).toBe(WebSocket.OPEN);
      pass(
        "native-like SDK send completes and reads back over 4 MiB of queued uploads in sub-512 KiB bodies with all quotas enabled",
      );

      // Independent watch IDs share sixteen real documents. Their complete
      // set spans more than twelve credit windows while staying below the
      // hard 4 MiB assembly queue, with a small deduplicated response.
      const watches: WatchSpec[] = Array.from({ length: 768 }, (_, i) => ({
        id: `credit-watch-${i}`,
        kind: "graph",
        query: { roots },
      }));
      const beforeWatch = {
        bytes: trace.creditedBytes,
        grants: trace.grants,
      };
      const view = await session.watchSet(watches);
      const control = trace.headers.find((header) =>
        header.route.type === "session.watch.set"
      );
      expect(control?.bytes).toBeGreaterThan(threeMiB);
      expect(control?.bytes).toBeLessThan(fourMiB);
      expect(trace.creditedBytes - beforeWatch.bytes)
        .toBeGreaterThan(threeMiB);
      expect(trace.grants - beforeWatch.grants).toBeGreaterThan(12);
      expect(view.entities.map((entity) => entity.id).toSorted())
        .toEqual(roots.map(({ id }) => id).toSorted());
      for (const [marker, root] of roots.entries()) {
        expect(
          view.entities.find((entity) => entity.id === root.id)
            ?.document?.value,
        ).toEqual({ marker });
      }
      await session.queryGraph({ roots: [] });
      expect(traces).toHaveLength(1);
      expect(trace.socket.readyState).toBe(WebSocket.OPEN);
      expect(trace.completed).toBe(trace.headers.length);
      pass(
        "native-like SDK send completes a 3-to-4 MiB watch control across more than twelve credit windows within all quotas",
      );

      const disconnected = new Promise<void>((resolve) =>
        trace.socket.once("close", () => resolve())
      );
      trace.socket.terminate();
      await disconnected;
      await session.queryGraph({ roots: [] });
      expect(traces).toHaveLength(2);
      const restored = traces[1];
      const restoredControl = restored.headers.find((header) =>
        header.route.type === "session.watch.set"
      );
      expect(restoredControl?.bytes).toBeGreaterThan(threeMiB);
      expect(restoredControl?.bytes).toBeLessThan(fourMiB);
      expect(restored.creditedBytes).toBeGreaterThan(threeMiB);
      expect(restored.grants).toBeGreaterThan(12);
      expect(restored.socket.readyState).toBe(WebSocket.OPEN);
      // A separate session's `set` reaches the restored watch; the server
      // suppresses a writer's own `set` echo.
      const wireCommits: { message: Record<string, unknown>; bytes: number }[] =
        [];
      const wireAcknowledgements: {
        message: Record<string, unknown>;
        bytes: number;
      }[] = [];
      const writerSockets: WebSocket[] = [];
      const writing = await MemoryClient.connect({
        transport: new WebSocketTransport(
          new URL("wss://localhost:8443/api/storage/memory"),
          true,
          () => {},
          (address) => {
            const connection = socketFactory(address, "127.0.0.49");
            writerSockets.push(connection.socket);
            connection.socket.on("message", (bytes, binary) => {
              const frame = publicFrame(bytes, binary);
              if (frame === undefined) return;
              const { payload } = frame;
              const message = frame.body;
              if (
                message.type === "response" && isPlainObject(message.ok) &&
                Array.isArray(message.ok.revisions)
              ) {
                wireAcknowledgements.push({
                  message,
                  bytes: new TextEncoder().encode(payload).length,
                });
              }
            });
            return observeRequests(
              connection,
              (message, bytes) => {
                if (message.type === "transact") {
                  wireCommits.push({ message, bytes });
                }
              },
            );
          },
        ),
      });
      try {
        const writer = await writing.mount(spaces[0], {}, {
          did: alice.did(),
          authorizeConnection: (context) =>
            createSignedConnectionAuth(alice, context),
          authorizeSessionOpen: () => {
            throw new Error("Expected routed connection authorization");
          },
        });
        expect(writer.sessionId).not.toBe(session.sessionId);
        const expectedSeq = writer.serverSeq + 1;
        const updates = view.subscribe();
        try {
          const applied = await writer.transact({
            localSeq: 1,
            reads: { confirmed: [], pending: [] },
            operations: [{
              op: "set",
              id: roots[15].id,
              value: { value: { marker: "restored" } },
            }],
          });
          expect(applied.seq).toBe(expectedSeq);
          expect(applied.replayed).toBeUndefined();
          for (;;) {
            const update = await updates.next();
            assert(!update.done, "Restored watch ended before the later write");
            if (update.value.serverSeq < applied.seq) continue;
            const entity = update.value.entities.find((entity) =>
              entity.id === roots[15].id
            );
            expect(entity?.seq).toBe(applied.seq);
            expect(entity?.document).toEqual({ value: { marker: "restored" } });
            break;
          }
        } finally {
          await updates.return?.();
        }

        await writer.transact({
          localSeq: 2,
          reads: { confirmed: [], pending: [] },
          operations: [
            { op: "set", id: `cid:${schemaHash}`, value: { value: true } },
            ...labelRoots.map(({ id }, index) => ({
              op: "set" as const,
              id,
              value: labeledDocument(index, 1),
            })),
          ],
        });
        expect(uploading.serverFlags?.syncLabelTableV1).toBe(true);
        const labeled = await session.watchAddSync([labelWatch]);
        expect(labeled.view).toBe(view);
        const labelRequest = restored.headers.findLast((header) =>
          header.route.type === "session.watch.add"
        );
        assert(labelRequest);
        const response = restored.syncMessages.find((message) =>
          message.type === "response" &&
          message.requestId === labelRequest.route.requestId
        );
        assert(response && isPlainObject(response.ok));
        checkLabels(response.ok.sync, true, 1);
        checkLabels(labeled.sync, false, 1);
        for (const [index, root] of labelRoots.entries()) {
          expect(
            labeled.view.entities.find((entry) => entry.id === root.id)
              ?.document,
          ).toEqual(labeledDocument(index, 1));
        }
        const labelUpdates = labeled.view.subscribeSync();
        try {
          const applied = await writer.transact({
            localSeq: 3,
            reads: { confirmed: [], pending: [] },
            operations: labelRoots.map(({ id }, index) => ({
              op: "set",
              id,
              value: labeledDocument(index, 2),
            })),
          });
          for (;;) {
            const update = await labelUpdates.next();
            assert(!update.done, "Labeled watch ended before the later write");
            if (update.value.toSeq < applied.seq) continue;
            checkLabels(update.value, false, 2);
            break;
          }
          const pushed = restored.syncMessages.find((message) =>
            message.type === "session/effect" &&
            isPlainObject(message.effect) &&
            message.effect.toSeq === applied.seq
          );
          assert(pushed);
          checkLabels(pushed.effect, true, 2);
          for (const [index, root] of labelRoots.entries()) {
            expect(
              labeled.view.entities.find((entry) => entry.id === root.id)
                ?.document,
            ).toEqual(labeledDocument(index, 2));
          }
        } finally {
          await labelUpdates.return?.();
        }

        const documents = Array.from({ length: 30 }, (_, marker) => ({
          id: `of:routed-commit-label-${marker}`,
          document: {
            value: {
              ...labeledDocument(marker, 1).value,
              items: Array.from({ length: 410 }, (_, index) => index),
            },
            cfc: {
              version: 1,
              schemaHash,
              labelMap: {
                version: 1,
                entries: Array.from({ length: 410 }, (_, index) => ({
                  path: ["items", String(index)],
                  label: {
                    confidentiality: [
                      "routed-commit-project",
                      "routed-commit-region",
                      "routed-commit-secret",
                      "routed-commit-team",
                    ],
                    integrity: ["routed-commit-provenance"],
                  },
                })),
              },
            },
          },
        }));
        const commit: ClientCommit = deepFreeze({
          localSeq: 4,
          reads: { confirmed: [], pending: [] },
          operations: documents.map(({ id, document }) => ({
            op: "set",
            id,
            value: document,
          })),
        });
        const originalCommit = encodeMemoryBoundary(commit);
        const inline: ClientMessage = {
          type: "transact",
          space: spaces[0],
          sessionId: writer.sessionId,
          requestId: crypto.randomUUID(),
          commit,
        };
        const inlinePayload = encodeMemoryBoundary(inline);
        const inlineSlots = countValues(inline);
        expect(inlineSlots).toBeGreaterThan(150_000);
        expect(new TextEncoder().encode(inlinePayload).length)
          .toBeLessThan(fourMiB);
        expect(() => decodeRoutedFrame(inlinePayload, false, 150_000))
          .toThrow();
        const compact = compressClientMessageLabels(inline);
        const compactPayload = encodeMemoryBoundary(compact);
        expect(countValues(compact)).toBeLessThan(150_000);
        expect(new TextEncoder().encode(compactPayload).length)
          .toBeLessThan(fourMiB);
        expect(decodeRoutedFrame(compactPayload, false, 150_000).body)
          .toEqual(compact);
        expect(writing.serverFlags).toHaveProperty("commitLabelTableV1", true);
        const applied = await writer.transact(commit);
        expect(applied.replayed).toBeUndefined();
        expect(encodeMemoryBoundary(commit)).toBe(originalCommit);
        expect(Object.isFrozen(documents[0].document.cfc.labelMap.entries))
          .toBe(true);
        const sent = wireCommits.at(-1);
        assert(sent && isPlainObject(sent.message.commit));
        expect(sent.message.commit.localSeq).toBe(commit.localSeq);
        expect(sent.bytes).toBeLessThan(fourMiB);
        const compactSlots = countValues(sent.message);
        expect(compactSlots).toBeLessThan(150_000);
        expect(sent.message.commit.labelTable).toHaveLength(1);
        expect(sent.message.commit.labelPathTable).toHaveLength(410);
        expect({ ...sent.message, requestId: inline.requestId }).toEqual(
          compact,
        );
        const operations = sent.message.commit.operations;
        assert(Array.isArray(operations));
        expect(operations).toHaveLength(documents.length);
        for (const operation of operations) {
          assert(isPlainObject(operation));
          expect(operation.op).toBe("set");
          assert(isPlainObject(operation.value));
          const metadata = operation.value.cfc;
          assert(isPlainObject(metadata) && isPlainObject(metadata.labelMap));
          assert(Array.isArray(metadata.labelMap.entries));
          expect(metadata.labelMap.entries).toHaveLength(410);
          for (const entry of metadata.labelMap.entries) {
            assert(isPlainObject(entry));
            expect(typeof entry.label).toBe("number");
            expect(typeof entry.path).toBe("number");
          }
        }

        /** Checks raw acknowledgement refs against the SDK's complete result. */
        const checkAcknowledgement = (
          result: typeof applied,
          requestId: unknown,
        ) => {
          const replies = wireAcknowledgements.filter(({ message }) =>
            message.requestId === requestId
          );
          expect(replies).toHaveLength(1);
          const reply = replies[0];
          const { ok } = reply.message;
          assert(isPlainObject(ok));
          expect(ok.labelTable).toHaveLength(1);
          expect(ok.labelPathTable).toHaveLength(410);
          const { labelTable, labelPathTable } = ok;
          assert(Array.isArray(labelTable));
          assert(Array.isArray(labelPathTable));
          assert(Array.isArray(ok.revisions));
          expect(ok.revisions).toHaveLength(documents.length);
          expect(result.revisions).toHaveLength(documents.length);
          expect(Object.hasOwn(result, "labelTable")).toBe(false);
          expect(Object.hasOwn(result, "labelPathTable")).toBe(false);
          for (const { id, document } of documents) {
            expectCanonicalEqual(
              result.revisions.find((revision) => revision.id === id)
                ?.document,
              document,
              "expanded acknowledgement document",
            );
          }
          const expandedRevisions = ok.revisions.map((revision: unknown) => {
            assert(isPlainObject(revision) && isPlainObject(revision.document));
            const { cfc } = revision.document;
            assert(isPlainObject(cfc) && isPlainObject(cfc.labelMap));
            assert(Array.isArray(cfc.labelMap.entries));
            const entries = cfc.labelMap.entries.map((entry: unknown) => {
              assert(isPlainObject(entry));
              assert(typeof entry.label === "number");
              assert(typeof entry.path === "number");
              return {
                ...entry,
                label: labelTable[entry.label],
                path: labelPathTable[entry.path],
              };
            });
            return {
              ...revision,
              document: {
                ...revision.document,
                cfc: { ...cfc, labelMap: { ...cfc.labelMap, entries } },
              },
            };
          });
          expectCanonicalEqual(
            expandedRevisions,
            result.revisions,
            "raw acknowledgement expansion matches SDK revisions",
          );
          expect(ok.seq).toBe(result.seq);
          expect(ok.replayed).toBe(result.replayed);
          const inlineReply = { ...reply.message, ok: result };
          const inlinePayload = encodeMemoryBoundary(inlineReply);
          const inlineSlots = countValues(inlineReply);
          const compactSlots = countValues(reply.message);
          expect(inlineSlots).toBeGreaterThan(150_000);
          expect(() => decodeRoutedFrame(inlinePayload, false, 150_000))
            .toThrow();
          expect(compactSlots).toBeLessThan(150_000);
          expect(reply.bytes).toBeLessThan(fourMiB);
          return {
            inlineSlots,
            compactSlots,
            inlineBytes: new TextEncoder().encode(inlinePayload).length,
            compactBytes: reply.bytes,
            replayed: result.replayed === true,
          };
        };
        const acknowledgement = checkAcknowledgement(
          applied,
          sent.message.requestId,
        );
        expect(writerSockets).toHaveLength(1);
        const writerDisconnected = new Promise<void>((resolve) =>
          writerSockets[0].once("close", () => resolve())
        );
        writerSockets[0].terminate();
        await writerDisconnected;
        await writer.queryGraph({ roots: [] });
        expect(writerSockets).toHaveLength(2);
        expect(writing.serverFlags?.commitLabelTableV1).toBe(true);
        const beforeReplay = wireCommits.length;
        const replayed = await writer.transact(commit);
        expect(replayed.replayed).toBe(true);
        expect(replayed.seq).toBe(applied.seq);
        expect(replayed.revisions).toHaveLength(applied.revisions.length);
        // The protocol defaults an omitted scope to `space` (v2.ts's
        // resolveScopeKey). Initial and stored replay revisions may differ
        // only in whether that default is written explicitly.
        const withExplicitScope = (revisions: typeof applied.revisions) =>
          revisions.map((revision) => ({
            ...revision,
            scope: revision.scope === undefined ? "space" : revision.scope,
          }));
        expectCanonicalEqual(
          withExplicitScope(replayed.revisions),
          withExplicitScope(applied.revisions),
          "replay preserves every revision field with explicit default scope",
          replayed,
          applied,
        );
        expect(wireCommits).toHaveLength(beforeReplay + 1);
        const replayRequest = wireCommits[beforeReplay];
        expect(replayRequest.message.requestId).not.toBe(
          sent.message.requestId,
        );
        const replayAcknowledgement = checkAcknowledgement(
          replayed,
          replayRequest.message.requestId,
        );
        expect(writerSockets).toHaveLength(2);
        expect(writerSockets[1].readyState).toBe(WebSocket.OPEN);
        expect(encodeMemoryBoundary(commit)).toBe(originalCommit);
        // Each read fits the response budget even with inline stored metadata.
        for (const { id, document } of documents) {
          const result = await session.queryGraph({
            roots: [{ id, selector: { path: [], schema: false } }],
          });
          const stored = result.entities.find((entity) => entity.id === id);
          expect(stored?.seq).toBe(applied.seq);
          expectCanonicalEqual(
            stored?.document,
            document,
            "stored commit document",
          );
        }
        console.log(JSON.stringify({
          publicCommitLabelTables: {
            inlineSlots,
            compactSlots,
            inlineBytes: new TextEncoder().encode(inlinePayload).length,
            compactBytes: sent.bytes,
            documents: documents.length,
            acknowledgement,
            replayAcknowledgement,
          },
        }));
        pass(
          "negotiated commit tables carry thirty frozen sets exceeding 150000 inline values below the unchanged request bounds and preserve every stored document",
        );

        const {
          syncLabelTableV1: _labelCapability,
          commitLabelTableV1: _commitCapability,
          ...oldFlags
        } = getMemoryProtocolFlags();
        for (const enabled of [undefined, false]) {
          const oldPeer = new Client("127.0.0.50");
          clients.push(oldPeer);
          try {
            await oldPeer.start({
              ...oldFlags,
              connectionAuth: true,
              routedAuthV1: true,
              ...(enabled === undefined ? {} : {
                syncLabelTableV1: enabled,
                commitLabelTableV1: enabled,
              }),
            });
            expect(oldPeer.hello.flags).toHaveProperty(
              "syncLabelTableV1",
              true,
            );
            expect(oldPeer.hello.flags).toHaveProperty(
              "commitLabelTableV1",
              true,
            );
            await oldPeer.authenticate(alice, 300, true);
            const opened = await oldPeer.request({
              type: "session.open",
              space: spaces[0],
              principal: alice.did(),
              session: {},
            });
            assert(isPlainObject(opened.ok));
            const legacyId = `of:routed-inline-commit-${String(enabled)}`;
            const legacyDocument = labeledDocument(0, 2);
            expect(
              await oldPeer.request({
                type: "transact",
                space: spaces[0],
                sessionId: opened.ok.sessionId,
                commit: {
                  localSeq: 1,
                  reads: { confirmed: [], pending: [] },
                  operations: [{
                    op: "set",
                    id: legacyId,
                    value: legacyDocument,
                  }],
                },
              }),
            ).toHaveProperty("ok.seq");
            const legacyRead = await oldPeer.request({
              type: "graph.query",
              space: spaces[0],
              sessionId: opened.ok.sessionId,
              query: {
                roots: [{
                  id: legacyId,
                  selector: { path: [], schema: false },
                }],
              },
            });
            assert(isPlainObject(legacyRead.ok));
            assert(Array.isArray(legacyRead.ok.entities));
            const legacyStored = legacyRead.ok.entities.find((
              entity: unknown,
            ) => isPlainObject(entity) && entity.id === legacyId);
            assert(isPlainObject(legacyStored));
            expect(legacyStored.document).toEqual(legacyDocument);
            const result = await oldPeer.request({
              type: "session.watch.set",
              space: spaces[0],
              sessionId: opened.ok.sessionId,
              watches: [labelWatch],
            });
            assert(isPlainObject(result.ok));
            checkLabels(result.ok.sync, false, 2);
          } finally {
            oldPeer.close();
            await oldPeer.closed.promise;
          }
        }
        pass(
          "routed label and path tables compact watch replies and effects, expand exactly in the SDK, and stay inline for omitted or false capability",
        );
      } finally {
        await writing.close();
      }
      expect(traces).toHaveLength(2);
      expect(restored.socket.readyState).toBe(WebSocket.OPEN);
      await session.close();
      console.log(JSON.stringify({
        publicUploadCredits: {
          windowBytes: window,
          transactionBodyBytes: uploads.map((header) => header.bytes),
          transactionReplies: trace.transactionReplies,
          watchBodyBytes: control?.bytes,
          restoredWatchBodyBytes: restoredControl?.bytes,
          connections: traces.map(({ sentBytes, creditedBytes, grants }) => ({
            sentBytes,
            creditedBytes,
            grants,
          })),
        },
      }));
      pass(
        "SDK reconnect selects fresh upload credits, restores a 3-to-4 MiB watch control within all quotas and receives a later watched write",
      );
    } finally {
      await uploading.close();
    }

    // The router charges full logical bodies until their responses complete.
    // Its in-flight budget must exceed the endpoint's input budget for a
    // blocked backend to receive a capacity-waiting private header. Only this
    // disposable scenario changes that quota; the endpoint stays at 4 MiB.
    const activeConfigPath = systemd
      ? "/etc/memory-router/config.json"
      : configPath;
    const priorConfigText = Deno.readTextFileSync(activeConfigPath);
    const priorConfig = JSON.parse(priorConfigText);
    assert(isPlainObject(priorConfig));
    expect(priorConfig.max_in_flight_bytes_per_connection ?? fourMiB)
      .toBe(fourMiB);
    const pressureConfig = {
      ...priorConfig,
      max_in_flight_bytes_per_connection: 2 * fourMiB,
    };
    try {
      Deno.writeTextFileSync(activeConfigPath, JSON.stringify(pressureConfig));
      await restartRouter();
      const activeConfig = JSON.parse(Deno.readTextFileSync(activeConfigPath));
      assert(isPlainObject(activeConfig));
      assert(
        typeof activeConfig.max_in_flight_bytes_per_connection === "number",
      );
      expect(activeConfig).toEqual(pressureConfig);
      expect(activeConfig.max_in_flight_bytes_per_connection).toBe(
        8 * 1024 * 1024,
      );
      const firstTrace = traces.length;
      const pressureClient = await MemoryClient.connect({
        transport: new WebSocketTransport(
          new URL("wss://localhost:8443/api/storage/memory"),
          true,
          () => {},
          creditSocket,
        ),
      });
      try {
        const session = await pressureClient.mount(spaces[0], {}, {
          did: alice.did(),
          authorizeConnection: (context) =>
            createSignedConnectionAuth(alice, context),
          authorizeSessionOpen: () => {
            throw new Error("Expected routed connection authorization");
          },
        });
        const trace = traces[firstTrace];
        const payloads = Array.from({ length: 12 }, (_, i) => ({
          id: `of:admission-upload-${i}`,
          value: `${i}:${"u".repeat(384 * 1024)}`,
        }));
        await toolsheds[0].command({ holdRequests: session.sessionId });
        try {
          const pendingUploads = Promise.all(
            payloads.map(({ id, value }, i) =>
              session.transact({
                localSeq: i + 1,
                reads: { confirmed: [], pending: [] },
                operations: [{ op: "set", id, value: { value } }],
              })
            ),
          );
          // The fixture notification is independent of request completion.
          // Observe early failures while retaining the promise awaited below.
          void pendingUploads.catch(() => {});
          const { requestAdmission: held } = await toolsheds[0].command({
            waitRequestAdmission: true,
          });
          console.log(JSON.stringify({
            privateRequestAdmissionHeld: {
              routerInFlightLimitBytes:
                activeConfig.max_in_flight_bytes_per_connection,
              endpointInputLimitBytes: held.inputLimitBytes,
              snapshot: held,
            },
          }));
          expect(held.inputLimitBytes).toBe(fourMiB);
          expect(held.blocked).toBe(true);
          expect(held.released).toBe(false);
          expect(held.closed).toBe(false);
          // The router sent headers and bodies back to back while the
          // toolshed's credit covered them; every assembled body is handed to
          // the connection, which orders the held session's turns itself. The
          // rest wait at the router, with the client's input, for credit the
          // held turns have not returned.
          expect(held.headers).toBe(held.completed);
          expect(held.backendRequests).toBe(held.completed);
          expect(held.backendRequests).toBeGreaterThan(1);
          expect(held.headers).toBeLessThan(payloads.length);
          expect(held.declaredBytes).toBeLessThanOrEqual(fourMiB);
          expect(held.maxPendingBytes).toBeLessThanOrEqual(fourMiB);
          expect(held.pendingBytesAtWait).toBe(held.declaredBytes);
          expect(held.assemblingBytesAtWait).toBe(0);
          expect(held.creditAtWait).toBe(fourMiB - held.declaredBytes);
          expect(held.creditAtWait).toBeLessThan(held.lastRequestBytes);
          expect(
            trace.headers.filter((header) => header.route.type === "transact")
              .length,
          ).toBeGreaterThan(held.headers);
          expect(trace.transactionReplies).toBe(0);
          expect(traces).toHaveLength(firstTrace + 1);
          expect(trace.socket.readyState).toBe(WebSocket.OPEN);
          await toolsheds[0].command({ releaseRequests: true });
          await pendingUploads;
          const { requestAdmission: admitted } = await toolsheds[0].command({
            requestAdmission: true,
          });
          expect(admitted.inputLimitBytes).toBe(fourMiB);
          expect(admitted.released).toBe(true);
          expect(admitted.closed).toBe(false);
          expect(admitted.headers).toBe(payloads.length);
          expect(admitted.completed).toBe(payloads.length);
          expect(admitted.backendRequests).toBe(payloads.length);
          expect(admitted.maxPendingBytes).toBeLessThanOrEqual(fourMiB);
          expect(trace.transactionReplies).toBe(payloads.length);
          const uploads = trace.headers.filter((header) =>
            header.route.type === "transact"
          );
          expect(uploads).toHaveLength(payloads.length);
          for (const upload of uploads) {
            expect(upload.bytes).toBeLessThan(512 * 1024);
          }
          expect(admitted.declaredBytes).toBe(
            uploads.reduce((total, header) => total + header.bytes, 0),
          );
          expect(admitted.declaredBytes).toBeLessThan(
            activeConfig.max_in_flight_bytes_per_connection,
          );
          for (const { id, value } of payloads) {
            const result = await session.queryGraph({
              roots: [{ id, selector: { path: [], schema: false } }],
            });
            expect(result.entities).toHaveLength(1);
            expect(result.entities[0].document?.value).toBe(value);
          }
          expect(traces).toHaveLength(firstTrace + 1);
          expect(trace.socket.readyState).toBe(WebSocket.OPEN);
          console.log(JSON.stringify({
            privateRequestAdmission: {
              routerInFlightLimitBytes:
                activeConfig.max_in_flight_bytes_per_connection,
              endpointInputLimitBytes: admitted.inputLimitBytes,
              completed: admitted,
            },
          }));
        } finally {
          await toolsheds[0].command({ releaseRequests: true });
          await toolsheds[0].command({ clearRequestAdmission: true });
        }
      } finally {
        await pressureClient.close();
      }
    } finally {
      Deno.writeTextFileSync(activeConfigPath, priorConfigText);
      await restartRouter();
      expect(Deno.readTextFileSync(activeConfigPath)).toBe(priorConfigText);
    }
    pass(
      "private request credit with an 8 MiB router in-flight quota holds the burst at the router once the endpoint's 4 MiB input budget is spent, then commits and reads back the queued burst on the same socket and restores the router configuration",
    );

    /** Opens an SDK peer while retaining public requests and raw responses. */
    const observedPeer = async (
      source: string,
      frameSlots: number | null = ROUTED_FRAME_SLOTS,
    ) => {
      const messages: Record<string, unknown>[] = [];
      const hellos: Record<string, unknown>[] = [];
      const requests: Record<string, unknown>[] = [];
      const sockets: WebSocket[] = [];
      const client = await MemoryClient.connect({
        transport: new WebSocketTransport(
          new URL("wss://localhost:8443/api/storage/memory"),
          true,
          () => {},
          (address) => {
            const connection = socketFactory(address, source);
            sockets.push(connection.socket);
            connection.socket.on("message", (bytes, binary) => {
              const frame = publicFrame(bytes, binary, frameSlots);
              if (frame !== undefined) messages.push(frame.body);
            });
            return observeRequests(connection, (message) => {
              requests.push(message);
              if (message.type === "hello") {
                for (const flag of ["syncLabelTableV1", "commitLabelTableV1"]) {
                  expect(message.flags).toHaveProperty(flag, true);
                }
                hellos.push(message);
              }
            }, frameSlots);
          },
        ),
      });
      return { client, messages, hellos, sockets, requests };
    };

    /** Checks a fresh session's wire encoding and the SDK's expanded watch. */
    const readLabels = async (
      reader: Awaited<ReturnType<typeof observedPeer>>,
      index: number,
      compact: boolean,
      seed = false,
    ) => {
      const signer = signerFor(index);
      const session = await reader.client.mount(spaces[index], {}, {
        did: signer.did(),
        authorizeConnection: (context) =>
          createSignedConnectionAuth(signer, context),
        authorizeSessionOpen: () => {
          throw new Error("Expected routed connection authorization");
        },
      });
      try {
        expect(reader.client.serverFlags?.commitLabelTableV1).toBe(compact);
        const commit: ClientCommit = {
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [
            ...(seed
              ? [{
                op: "set" as const,
                id: `cid:${schemaHash}`,
                value: { value: true },
              }]
              : []),
            ...labelRoots.map(({ id }, marker) => ({
              op: "set" as const,
              id,
              value: labeledDocument(marker, 2),
            })),
          ],
        };
        const beforeCommit = reader.requests.length;
        await session.transact(commit);
        const sent = reader.requests.slice(beforeCommit).filter((message) =>
          message.type === "transact"
        );
        expect(sent).toHaveLength(1);
        const message = sent[0];
        assert(isPlainObject(message.commit));
        if (compact) {
          expect(message.commit.labelTable).toHaveLength(2);
          expect(message.commit.labelPathTable).toHaveLength(2);
          expect(message).toEqual(
            compressClientMessageLabels({ ...message, commit }),
          );
        } else {
          expect(Object.hasOwn(message.commit, "labelTable")).toBe(false);
          expect(Object.hasOwn(message.commit, "labelPathTable")).toBe(false);
          expect(message.commit).toEqual(commit);
        }
        const before = reader.messages.length;
        const { view, sync } = await session.watchSetSync([labelWatch]);
        const replies = reader.messages.slice(before).filter((message) =>
          message.type === "response" && isPlainObject(message.ok) &&
          isPlainObject(message.ok.sync)
        );
        expect(replies).toHaveLength(1);
        assert(isPlainObject(replies[0].ok));
        checkLabels(replies[0].ok.sync, compact, 2);
        checkLabels(sync, false, 2);
        for (const [marker, root] of labelRoots.entries()) {
          expect(
            view.entities.find((entity) => entity.id === root.id)?.document,
          )
            .toEqual(labeledDocument(marker, 2));
        }
      } finally {
        await session.close();
      }
    };

    // Each phase configures both endpoints and the real router. The SDK must
    // learn its cap from the public hello; the observer only records the wire.
    try {
      for (const [index, frameSlots] of [175_000, null].entries()) {
        Deno.writeTextFileSync(
          activeConfigPath,
          JSON.stringify({
            ...priorConfig,
            max_frame_slots: frameSlots,
          }),
        );
        for (const shed of toolsheds) {
          await shed.stop();
          await shed.start(modernCellRep, false, frameSlots);
        }
        await restartRouter();
        await Promise.all(
          toolsheds.map((shed) => shed.command({ linked: true })),
        );
        const peer = await observedPeer(`127.0.0.${60 + index}`, frameSlots);
        try {
          expect(peer.messages.find((message) => message.type === "hello.ok"))
            .toHaveProperty("routerFrameSlots", frameSlots);
          const session = await peer.client.mount(spaces[0], {}, {
            did: alice.did(),
            authorizeConnection: (context) =>
              createSignedConnectionAuth(alice, context),
            authorizeSessionOpen: () => {
              throw new Error("Expected routed connection authorization");
            },
          });
          const id = `of:frame-slots-${index}`;
          const document = {
            value: Array.from({ length: 160_000 }, (_, value) => value),
          };
          const applied = await session.transact({
            localSeq: 1,
            reads: { confirmed: [], pending: [] },
            operations: [{ op: "set", id, value: document }],
          });
          expect(applied.revisions).toHaveLength(1);
          expect(applied.revisions[0].id).toBe(id);
          expectCanonicalEqual(
            applied.revisions[0].document,
            document,
            "slot-cap commit acknowledgement",
          );
          const request = peer.requests.find((message) =>
            message.type === "transact"
          );
          assert(request);
          const acknowledgement = peer.messages.find((message) =>
            message.type === "response" &&
            message.requestId === request.requestId
          );
          assert(acknowledgement);
          expect(acknowledgement.error).toBeUndefined();
          expect(countValues(request)).toBeGreaterThan(ROUTED_FRAME_SLOTS);
          expect(countValues(acknowledgement)).toBeGreaterThan(
            ROUTED_FRAME_SLOTS,
          );

          const { view, sync } = await session.watchSetSync([{
            id: "large-slot-watch",
            kind: "graph",
            query: { roots: [{ id, selector: { path: [], schema: false } }] },
          }]);
          expect(view.entities).toHaveLength(1);
          expect(view.entities[0].id).toBe(id);
          expectCanonicalEqual(
            view.entities[0].document,
            document,
            "slot-cap watched document",
          );
          expect(sync.upserts).toHaveLength(1);
          expectCanonicalEqual(
            sync.upserts[0].doc,
            document,
            "slot-cap sync document",
          );
          const response = peer.messages.find((message) =>
            message.type === "response" && isPlainObject(message.ok) &&
            isPlainObject(message.ok.sync)
          );
          assert(response);
          expect(countValues(response)).toBeGreaterThan(ROUTED_FRAME_SLOTS);
          expect(peer.sockets).toHaveLength(1);
          expect(peer.sockets[0].readyState).toBe(WebSocket.OPEN);
          console.log(JSON.stringify({
            routerFrameSlots: frameSlots,
            requestSlots: countValues(request),
            acknowledgementSlots: countValues(acknowledgement),
            syncSlots: countValues(response),
          }));
          await session.close();
          pass(
            `the router advertises a ${frameSlots} slot cap and the SDK commits, acknowledges and syncs 160,000 values with exact content on one socket`,
          );
        } finally {
          await peer.client.close();
        }
      }
    } finally {
      Deno.writeTextFileSync(activeConfigPath, priorConfigText);
      for (const shed of toolsheds) {
        await shed.stop();
        await shed.start();
      }
      await restartRouter();
    }
    const defaultSlots = await new Client("127.0.0.62").start();
    try {
      expect(defaultSlots.hello.routerFrameSlots).toBe(ROUTED_FRAME_SLOTS);
      expect(Deno.readTextFileSync(activeConfigPath)).toBe(priorConfigText);
    } finally {
      defaultSlots.close();
      await defaultSlots.closed.promise;
    }
    pass(
      "omitting the router slot cap restores its advertised 150,000 default",
    );

    await toolsheds[1].stop();
    await toolsheds[1].start(modernCellRep, true);
    await restartRouter();
    await toolsheds[1].command({ linked: true });
    const mixed = await observedPeer("127.0.0.51");
    try {
      expect(mixed.client.serverFlags?.syncLabelTableV1).toBe(false);
      await readLabels(mixed, 0, false);
      pass(
        "a mixed-endpoint public snapshot disables label tables even on a supporting toolshed while retaining the client's original offer",
      );

      // The public connection never binds the omitted-capability endpoint
      // before its upgrade, so that endpoint's restart cannot close it.
      const socket = mixed.sockets[0];
      await toolsheds[1].stop();
      await toolsheds[1].start();
      await toolsheds[1].command({ linked: true });
      await readLabels(mixed, 0, false);
      await readLabels(mixed, 1, false, true);
      expect(mixed.client.serverFlags?.syncLabelTableV1).toBe(false);
      expect(mixed.hellos).toHaveLength(1);
      expect(mixed.messages.filter((message) => message.type === "hello.ok"))
        .toHaveLength(1);
      expect(mixed.sockets).toEqual([socket]);
      expect(socket.readyState).toBe(WebSocket.OPEN);

      const fresh = await observedPeer("127.0.0.52");
      try {
        expect(fresh.client.serverFlags?.syncLabelTableV1).toBe(false);
        await readLabels(fresh, 1, false);
        expect(fresh.hellos).toHaveLength(1);
        expect(fresh.sockets).toHaveLength(1);
      } finally {
        await fresh.client.close();
      }
    } finally {
      await mixed.client.close();
    }

    // The router's startup snapshot governs new public connections too.
    // Both readers are closed before a restart takes the upgraded snapshot.
    await restartRouter();
    const upgraded = await observedPeer("127.0.0.53");
    try {
      expect(upgraded.client.serverFlags?.syncLabelTableV1).toBe(true);
      await readLabels(upgraded, 1, true);
      expect(upgraded.hellos).toHaveLength(1);
      expect(upgraded.sockets).toHaveLength(1);
    } finally {
      await upgraded.client.close();
    }
    pass(
      "an endpoint upgrade keeps existing and new public connections inline until a router restart negotiates compact label and path tables",
    );
  }

  // Mode A runs at the deployment's cell representation. The router answers
  // every hello with the deployment's flags, which the SDK refuses
  // permanently. A client that ignores them and opens a space anyway has that
  // open answered with a final denial, before any directory or agent work,
  // and the router then closes its socket (`incompatible-flags`).
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
  // The denial is answered when the router gets to it before the close;
  // either way no session opens.
  assert(
    otherOpen instanceof Error ||
      (JSON.parse(otherOpen) as { error?: unknown }).error !== undefined,
    String(otherOpen),
  );
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
        `--config=${
          fromFileUrl(new URL("../../../deno.jsonc", import.meta.url))
        }`,
        "-A",
        fromFileUrl(new URL("./support/routed-profile.ts", import.meta.url)),
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
  await representation.authenticate(alice, 60);
  const healthy = await representation.request({
    type: "session.open",
    space: spaces[0],
    principal: alice.did(),
    session: {},
  });
  expect(healthy).toHaveProperty("ok.sessionId");
  const misconfigured = await representation.request({
    type: "session.open",
    space: spaces[1],
    principal: bob.did(),
    session: {},
  });
  expect(misconfigured).toHaveProperty("error");
  expect(representation.ws.readyState).toBe(WebSocket.OPEN);
  expect(
    await representation.request({
      type: "session.watch.set",
      space: spaces[0],
      sessionId: (healthy.ok as { sessionId: string }).sessionId,
      watches: [],
    }),
  ).toHaveProperty("ok");
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
