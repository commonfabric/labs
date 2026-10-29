import { basename, fromFileUrl } from "@std/path";

// Self-daemonization for the toolshed.
//
// `toolshed --background` starts the server without the caller having to
// background it with `&` and then wait for it to come up. The foreground
// process spawns a second copy of itself that is the real server, waits until
// that copy reports it has bound its port, and then exits. The command returns
// exactly when the server is ready, so a caller can run its next step against a
// server that is already accepting connections.
//
// Readiness travels over a pipe rather than a poll. The child writes a single
// marker line to its stdout the moment Deno.serve's onListen fires, and the
// parent reads that pipe until the marker arrives. Everything else the child
// says goes to a log file, not the pipe: console output through
// redirectConsoleToFile, and the request logger through the destination
// pino-logger.ts reads from the same environment variable. So stdout carries
// only the marker, and once the parent has read it and detached, the child
// never writes the pipe again and a later log cannot land on a closed reader.

export const BACKGROUND_FLAG = "--background";
export const LOG_FILE_FLAG = "--log-file";

// The parent passes the child its log path through this environment variable.
// The variable does double duty: its presence is what tells a process it is the
// server half of a background launch, and it is readable at import time, before
// the request logger is built, which a command-line flag parsed in the entry
// module's main block would not be.
export const BACKGROUND_LOG_ENV = "TOOLSHED_BACKGROUND_LOG_FILE";

// The line the child writes to stdout once the listener is bound. The parent
// scans its child's stdout for it as a substring.
export const READY_MARKER = "toolshed-listening";

/** The log path a background child was given, or undefined in a normal launch.
 * Its presence marks this process as the server half of a background launch. */
export function backgroundLogFile(): string | undefined {
  return Deno.env.get(BACKGROUND_LOG_ENV) ?? undefined;
}

export interface LaunchMode {
  /** This process should spawn the server as a child and wait for it. */
  background: boolean;

  /** Where the child should write its logs, when the caller named a path. */
  logFile: string | undefined;

  /** The arguments the server itself consumes (the port, and so on). */
  serverArgs: string[];
}

/** Split a launch's arguments into the background-control flags and the
 * arguments the server proper still needs. */
export function classifyLaunch(args: readonly string[]): LaunchMode {
  let background = false;
  let logFile: string | undefined;
  const serverArgs: string[] = [];
  for (const arg of args) {
    if (arg === BACKGROUND_FLAG) {
      background = true;
    } else if (arg.startsWith(`${LOG_FILE_FLAG}=`)) {
      logFile = arg.slice(LOG_FILE_FLAG.length + 1);
    } else {
      serverArgs.push(arg);
    }
  }
  return { background, logFile, serverArgs };
}

/** Build the command that runs the server half of a background launch. The
 * child re-runs this same program: the compiled binary re-runs itself, and a
 * `deno run` launch re-runs deno against the entry module. The child is marked
 * as the server through the environment (see BACKGROUND_LOG_ENV), so it carries
 * only the server's own arguments. */
export function buildBackgroundChildCommand(opts: {
  execPath: string;
  mainModule: string;
  serverArgs: readonly string[];
}): { command: string; args: string[] } {
  const base = basename(opts.execPath);
  const runningUnderDeno = base === "deno" || base === "deno.exe";
  if (!runningUnderDeno) {
    // The executable is the compiled toolshed binary, so re-running it starts
    // the server again.
    return { command: opts.execPath, args: [...opts.serverArgs] };
  }
  // Under `deno run`, re-run deno against the entry module. The child inherits
  // this process's environment, so the values a --env-file loaded travel with
  // it and no --env-file is needed here.
  return {
    command: opts.execPath,
    args: [
      "run",
      "--unstable-otel",
      "-A",
      fromFileUrl(opts.mainModule),
      ...opts.serverArgs,
    ],
  };
}

/** A spawned child process, narrowed to what the readiness handshake needs.
 * Deno.Command's ChildProcess satisfies it; a test supplies a fake. */
export interface SpawnedChild {
  readonly pid: number;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly status: Promise<Deno.CommandStatus>;
  unref(): void;
}

export interface BackgroundParentDeps {
  spawn?: (
    command: string,
    args: string[],
    env: Record<string, string>,
  ) => SpawnedChild;
  exit?: (code: number) => void;
  writeOut?: (line: string) => void;
  writeErr?: (line: string) => void;
  readLog?: (path: string) => Promise<string>;
  makeTempLog?: () => string;
}

function defaultSpawn(
  command: string,
  args: string[],
  env: Record<string, string>,
): SpawnedChild {
  const child = new Deno.Command(command, {
    args,
    env,
    stdin: "null",
    // stdout carries the readiness marker back to this process. The child sends
    // its own logs to its log file, so once the parent has read the marker and
    // exited, the child holds no inherited descriptor: its stdout was this
    // parent's pipe, and stderr is discarded. That keeps a caller that spawned
    // this process -- a CI step, say -- from waiting on the detached server's
    // output after it has moved on.
    stdout: "piped",
    stderr: "null",
  }).spawn();
  return {
    pid: child.pid,
    stdout: child.stdout,
    status: child.status,
    unref: () => child.unref(),
  };
}

// Read the child's stdout until the readiness marker arrives or the stream ends.
// Returns true when the marker was seen, false when the child's stdout closed
// first -- which means the child exited before it bound its port.
async function awaitReadyMarker(
  stdout: ReadableStream<Uint8Array>,
): Promise<boolean> {
  const reader = stdout.getReader();
  const decoder = new TextDecoder();
  let seen = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) return false;
      if (value) seen += decoder.decode(value, { stream: true });
      if (seen.includes(READY_MARKER)) return true;
      // Keep only enough of the tail to catch a marker split across two reads.
      if (seen.length >= READY_MARKER.length) {
        seen = seen.slice(-(READY_MARKER.length - 1));
      }
    }
  } finally {
    reader.releaseLock();
    // Not awaited: cancelling a live child's stdout waits for the child to close
    // it, which a listening server never does. The parent detaches and exits
    // right after this returns, which closes the read end anyway.
    void stdout.cancel().catch(() => {});
  }
}

/** Spawn the server as a background child and wait until it reports it is
 * listening. On success the child is detached and this process exits 0; if the
 * child exits before signaling readiness, its log is surfaced and this process
 * exits with the child's code. Never returns in production; it exits. */
export async function runBackgroundParent(
  opts: {
    execPath: string;
    mainModule: string;
    serverArgs: readonly string[];
    logFile: string | undefined;
  },
  deps: BackgroundParentDeps = {},
): Promise<void> {
  const spawn = deps.spawn ?? defaultSpawn;
  const exit = deps.exit ?? Deno.exit;
  const writeOut = deps.writeOut ?? ((line: string) => console.log(line));
  const writeErr = deps.writeErr ?? ((line: string) => console.error(line));
  const readLog = deps.readLog ?? ((path: string) => Deno.readTextFile(path));
  const makeTempLog = deps.makeTempLog ??
    (() => Deno.makeTempFileSync({ prefix: "toolshed-", suffix: ".log" }));

  const logFile = opts.logFile ?? makeTempLog();
  const childCommand = buildBackgroundChildCommand({
    execPath: opts.execPath,
    mainModule: opts.mainModule,
    serverArgs: opts.serverArgs,
  });

  const child = spawn(childCommand.command, childCommand.args, {
    [BACKGROUND_LOG_ENV]: logFile,
  });
  const ready = await awaitReadyMarker(child.stdout);
  if (!ready) {
    const status = await child.status;
    writeErr(
      `toolshed failed to start (the server exited with code ${status.code}).`,
    );
    let log = "";
    try {
      log = await readLog(logFile);
    } catch {
      // The child may have exited before it opened its log file.
    }
    if (log) writeErr(log);
    exit(status.code === 0 ? 1 : status.code);
    return;
  }

  child.unref();
  writeOut(
    `Toolshed is listening; the server is running in the background ` +
      `(pid ${child.pid}). Logs: ${logFile}`,
  );
  exit(0);
}

/** Open the background log for appending and return a stream with the `write`
 * method both the console redirect and the request logger send lines to. */
export function backgroundLogStream(
  path: string,
): { write(chunk: string): void } {
  const file = Deno.openSync(path, { write: true, create: true, append: true });
  const encoder = new TextEncoder();
  return {
    write(chunk: string): void {
      const bytes = encoder.encode(chunk);
      let written = 0;
      try {
        // writeSync issues one write and may report a short count, so loop
        // until the whole line has landed rather than dropping its tail.
        while (written < bytes.length) {
          written += file.writeSync(bytes.subarray(written));
        }
      } catch {
        // A failed log write must not take the server down.
      }
    },
  };
}

/** In the server half of a background launch, route console output to the log
 * file so stdout stays reserved for the single readiness marker. */
export function redirectConsoleToFile(path: string): void {
  const stream = backgroundLogStream(path);
  const format = (parts: readonly unknown[]): string =>
    parts
      .map((part) => (typeof part === "string" ? part : Deno.inspect(part)))
      .join(" ") + "\n";
  for (const method of ["log", "info", "debug", "warn", "error"] as const) {
    console[method] = (...parts: unknown[]) => stream.write(format(parts));
  }
}

/** Route uncaught errors through console.error so the background log records a
 * failure the runtime would otherwise print to a discarded stderr. */
export function logUncaughtErrors(): void {
  globalThis.addEventListener("error", (event) => {
    console.error("Uncaught error:", event.error ?? event.message);
  });
  globalThis.addEventListener("unhandledrejection", (event) => {
    console.error("Unhandled promise rejection:", event.reason);
  });
}

/** Announce, on stdout, that the server has bound its port. The parent of a
 * background launch is reading for exactly this line. */
export function writeListeningMarker(): void {
  Deno.stdout.writeSync(new TextEncoder().encode(`${READY_MARKER}\n`));
}
