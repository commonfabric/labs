// Installs a `Deno` global under Node: `@deno/shim-deno` for most of the
// namespace, with this port's own `test` (over `node:test`), `Command` (over
// `node:child_process`), `serve` (over `node:http`), and `bench`.

import * as childProcess from "node:child_process";
import * as http from "node:http";
import { Readable, Writable } from "node:stream";
import * as nodeTest from "node:test";
import { Deno as shim } from "@deno/shim-deno";

// ---------------------------------------------------------------------------
// Deno.test

/** Normalizes the overloads of `Deno.test()` to one definition object. */
function testDefinition(args) {
  const [a, b, c] = args;
  if (typeof a === "string") {
    return typeof b === "function"
      ? { name: a, fn: b }
      : { name: a, ...b, fn: c ?? b.fn };
  }
  if (typeof a === "function") return { name: a.name, fn: a };
  if (typeof b === "function") return { name: a.name ?? b.name, ...a, fn: b };
  return { ...a };
}

/** Wraps a `node:test` context as a Deno `TestContext`. */
function denoContext(t, name, parent) {
  const ctx = {
    name,
    origin: "",
    parent,
    async step(...args) {
      const def = testDefinition(args);
      let passed = true;
      await t.test(def.name, { skip: def.ignore === true }, async (sub) => {
        try {
          await def.fn(denoContext(sub, def.name, ctx));
        } catch (e) {
          passed = false;
          throw e;
        }
      });
      return passed;
    },
  };
  return ctx;
}

function registerTest(def) {
  nodeTest.test(
    def.name,
    { skip: def.ignore === true, only: def.only === true },
    (t) => def.fn(denoContext(t, def.name, undefined)),
  );
}

const test = Object.assign((...args) => registerTest(testDefinition(args)), {
  ignore: (...args) => registerTest({ ...testDefinition(args), ignore: true }),
  only: (...args) => registerTest({ ...testDefinition(args), only: true }),
});

// ---------------------------------------------------------------------------
// Deno.bench: benchmarks do not run under Node. Registering one is a no-op,
// so that a module defining benchmarks still loads.

const bench = Object.assign(() => {}, { ignore: () => {}, only: () => {} });

// ---------------------------------------------------------------------------
// Deno.Command

function stdioFor(mode, fallback) {
  switch (mode ?? fallback) {
    case "piped":
      return "pipe";
    case "inherit":
      return "inherit";
    case "null":
      return "ignore";
    default:
      throw new TypeError(`Unknown stdio mode: ${mode}`);
  }
}

function statusFrom(code, signal) {
  return { success: code === 0, code: code ?? 1, signal: signal ?? null };
}

async function collect(stream) {
  if (!stream) return new Uint8Array();
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return new Uint8Array(Buffer.concat(chunks));
}

class ChildProcess {
  #proc;
  #status;

  constructor(proc) {
    this.#proc = proc;
    this.pid = proc.pid;
    this.stdin = proc.stdin ? Writable.toWeb(proc.stdin) : null;
    this.stdout = proc.stdout ? Readable.toWeb(proc.stdout) : null;
    this.stderr = proc.stderr ? Readable.toWeb(proc.stderr) : null;
    this.#status = new Promise((resolve, reject) => {
      proc.on("error", reject);
      proc.on("close", (code, signal) => resolve(statusFrom(code, signal)));
    });
  }

  get status() {
    return this.#status;
  }

  async output() {
    const [stdout, stderr, status] = await Promise.all([
      collect(this.#proc.stdout),
      collect(this.#proc.stderr),
      this.#status,
    ]);
    return { ...status, stdout, stderr };
  }

  kill(signal = "SIGTERM") {
    this.#proc.kill(signal);
  }

  ref() {
    this.#proc.ref();
  }

  unref() {
    this.#proc.unref();
  }

  async [Symbol.asyncDispose]() {
    this.kill();
    await this.#status.catch(() => {});
  }
}

class Command {
  #command;
  #options;

  constructor(command, options = {}) {
    this.#command = command instanceof URL ? command.pathname : String(command);
    this.#options = options;
  }

  #spawnOptions(defaults) {
    const o = this.#options;
    return {
      cwd: o.cwd instanceof URL ? o.cwd.pathname : o.cwd,
      env: o.clearEnv ? { ...o.env } : { ...process.env, ...o.env },
      stdio: [
        stdioFor(o.stdin, defaults.stdin),
        stdioFor(o.stdout, defaults.stdout),
        stdioFor(o.stderr, defaults.stderr),
      ],
      windowsRawArguments: o.windowsRawArguments,
      signal: o.signal,
    };
  }

  spawn() {
    const proc = childProcess.spawn(
      this.#command,
      (this.#options.args ?? []).map(String),
      this.#spawnOptions({
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      }),
    );
    return new ChildProcess(proc);
  }

  output() {
    const proc = childProcess.spawn(
      this.#command,
      (this.#options.args ?? []).map(String),
      this.#spawnOptions({ stdin: "null", stdout: "piped", stderr: "piped" }),
    );
    return new ChildProcess(proc).output();
  }

  outputSync() {
    const result = childProcess.spawnSync(
      this.#command,
      (this.#options.args ?? []).map(String),
      this.#spawnOptions({ stdin: "null", stdout: "piped", stderr: "piped" }),
    );
    if (result.error) throw result.error;
    return {
      ...statusFrom(result.status, result.signal),
      stdout: new Uint8Array(result.stdout ?? []),
      stderr: new Uint8Array(result.stderr ?? []),
    };
  }
}

// ---------------------------------------------------------------------------
// Deno.serve

function toRequest(req, abort) {
  const host = req.headers.host ?? "localhost";
  const url = new URL(req.url ?? "/", `http://${host}`);
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (Array.isArray(v)) { for (const x of v) headers.append(k, x); }
    else if (v !== undefined) headers.set(k, v);
  }
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  return new Request(url, {
    method: req.method,
    headers,
    body: hasBody ? Readable.toWeb(req) : undefined,
    duplex: hasBody ? "half" : undefined,
    signal: abort.signal,
  });
}

async function writeResponse(res, response) {
  const headers = {};
  for (const [k, v] of response.headers) {
    if (k === "set-cookie") continue;
    headers[k] = v;
  }
  const cookies = response.headers.getSetCookie?.() ?? [];
  if (cookies.length > 0) headers["set-cookie"] = cookies;
  res.writeHead(response.status, response.statusText, headers);
  if (response.body) {
    for await (const chunk of response.body) res.write(chunk);
  }
  res.end();
}

function serve(...args) {
  let options = {};
  let handler;
  if (typeof args[0] === "function") {
    handler = args[0];
    options = args[1] ?? {};
  } else {
    options = args[0] ?? {};
    handler = args[1] ?? options.handler;
  }
  const port = options.port ?? 8000;
  const hostname = options.hostname ?? "0.0.0.0";

  const server = http.createServer(async (req, res) => {
    const abort = new AbortController();
    res.on("close", () => abort.abort());
    const remoteAddr = {
      transport: "tcp",
      hostname: req.socket.remoteAddress,
      port: req.socket.remotePort,
    };
    try {
      const response = await handler(toRequest(req, abort), {
        remoteAddr,
        completed: new Promise((resolve) => res.on("close", resolve)),
      });
      await writeResponse(res, response);
    } catch (e) {
      const response = options.onError
        ? await options.onError(e)
        : new Response("Internal Server Error", { status: 500 });
      if (!res.headersSent) await writeResponse(res, response);
      else res.destroy(e);
    }
  });

  let resolveFinished;
  const finished = new Promise((resolve) => (resolveFinished = resolve));
  server.on("close", () => resolveFinished());

  const result = {
    finished,
    addr: { transport: "tcp", hostname, port },
    async shutdown() {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(() => resolve()));
    },
    ref() {
      server.ref();
    },
    unref() {
      server.unref();
    },
    async [Symbol.asyncDispose]() {
      await result.shutdown();
    },
  };

  server.listen(port, hostname, () => {
    const address = server.address();
    result.addr = { transport: "tcp", hostname, port: address.port };
    if (options.onListen) options.onListen(result.addr);
    else console.log(`Listening on http://${hostname}:${address.port}/`);
  });
  options.signal?.addEventListener("abort", () => result.shutdown());
  return result;
}

// ---------------------------------------------------------------------------

const Deno = Object.create(null);
for (const key of Object.keys(shim)) Deno[key] = shim[key];
Object.assign(Deno, {
  test,
  bench,
  Command,
  ChildProcess,
  serve,
  // Deno's `args` are the script's arguments only.
  args: process.argv.slice(2),
});

globalThis.Deno = Deno;
