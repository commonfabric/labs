import { CAPTURE_TARGET_FINISHED_MESSAGE } from "./capture-deno-inspector-profile-lib.ts";

export type ProfileOptions = {
  outputPath?: string;
  outputDir?: string;
  summaryPattern?: string;
  profileStartPattern?: string;
  profileStopPattern?: string;
  inspectPort?: number;
};

export type ParsedProfileArgs = {
  options: ProfileOptions;
  cliArgs: string[];
};

type CommandStatus = Deno.CommandStatus;

export type CaptureResult = {
  status: CommandStatus;
  targetFinished: boolean;
};

export type KillableProcess = {
  kill(signal: Deno.Signal): void;
};

type InspectPortListener = {
  addr: Deno.Addr;
  close(): void;
};

type ListenForInspectPort = (
  options: { hostname: string; port: number },
) => InspectPortListener;

export const DEFAULT_SUMMARY_PATTERN = String.raw`\d+ passed, \d+ failed`;
export const DISABLED_SUMMARY_PATTERN = String.raw`(?!)`;

const encoder = new TextEncoder();

/**
 * The flag that keeps the profiled program from running until a debugger
 * connects. The program then runs at once, possibly before the capture
 * subscribes to its console, and the inspector replays the console messages
 * written before the capture's `Runtime.enable`. `--inspect-brk` would hold the
 * program until `Runtime.runIfWaitingForDebugger`, but Deno drops that command
 * when it arrives while the program's modules are still loading, and the
 * program then never runs.
 */
export function inspectWaitFlag(host: string, port: number): string {
  return `--inspect-wait=${host}:${port}`;
}

export function profilingChildEnv(
  source: Record<string, string> = Deno.env.toObject(),
): Record<string, string> {
  const env = { ...source };
  delete env.DENO_COVERAGE_DIR;
  return env;
}

export function findInspectorWebSocketUrl(text: string): string | undefined {
  return text.match(/Debugger listening on (ws:\/\/\S+)/)?.[1];
}

export function parseProfileArgs(args: string[]): ParsedProfileArgs {
  const options: ProfileOptions = {};
  const cliArgs: string[] = [];

  for (const arg of args) {
    if (arg.startsWith("--profile-output=")) {
      options.outputPath = arg.slice("--profile-output=".length);
    } else if (arg.startsWith("--profile-dir=")) {
      options.outputDir = arg.slice("--profile-dir=".length);
    } else if (arg.startsWith("--profile-summary-pattern=")) {
      options.summaryPattern = arg.slice("--profile-summary-pattern=".length);
    } else if (arg.startsWith("--profile-start-pattern=")) {
      options.profileStartPattern = arg.slice(
        "--profile-start-pattern=".length,
      );
    } else if (arg.startsWith("--profile-stop-pattern=")) {
      options.profileStopPattern = arg.slice("--profile-stop-pattern=".length);
    } else if (arg.startsWith("--profile-target-url-pattern=")) {
      throw new Error(
        "cf-profile uses the inspector URL emitted by its child process",
      );
    } else if (arg.startsWith("--profile-inspect-port=")) {
      options.inspectPort = Number(arg.slice("--profile-inspect-port=".length));
    } else if (
      arg.startsWith("--profile-timeout-ms=") ||
      arg.startsWith("--profile-connect-timeout-ms=")
    ) {
      throw new Error("cf-profile does not support timeout-based options");
    } else {
      cliArgs.push(arg);
    }
  }

  if (
    options.outputPath !== undefined && options.outputDir !== undefined
  ) {
    throw new Error("Pass either --profile-output or --profile-dir, not both");
  }
  if (
    options.inspectPort !== undefined &&
    (!Number.isFinite(options.inspectPort) || options.inspectPort <= 0)
  ) {
    throw new Error("--profile-inspect-port must be a positive number");
  }

  return { options, cliArgs };
}

export function slugifyProfileName(parts: string[]): string {
  const joined = parts.join("-").replaceAll(/[^\w.-]+/g, "-");
  const collapsed = joined.replaceAll(/-+/g, "-").replace(/^-|-$/g, "");
  return collapsed.length > 0 ? collapsed.slice(0, 80) : "cf";
}

export function profileTimestamp(): string {
  return new Date().toISOString().replaceAll(/[:.]/g, "-");
}

export function escapeRegex(source: string): string {
  return source.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function pickInspectPort(
  requested?: number,
  listen: ListenForInspectPort = Deno.listen,
): number {
  if (requested !== undefined) {
    return requested;
  }
  const listener = listen({ hostname: "127.0.0.1", port: 0 });
  try {
    const address = listener.addr;
    if (address.transport !== "tcp") {
      throw new Error("Expected a TCP listener while allocating inspect port");
    }
    return address.port;
  } finally {
    listener.close();
  }
}

/**
 * Returns a handler for successive chunks of a text stream that calls
 * `onFound` once, with the first value `find` returns from the recent output.
 */
export function watchOutput<T>(
  find: (recentOutput: string) => T | undefined,
  onFound: (found: T) => void,
): (text: string) => void {
  let recentOutput = "";
  let found = false;
  return (text) => {
    if (found) return;
    recentOutput = (recentOutput + text).slice(-8192);
    const value = find(recentOutput);
    if (value === undefined) return;
    found = true;
    onFound(value);
  };
}

/**
 * Mirrors the capture's output to `sink` and reports, once the output ends,
 * whether the capture saw the profiled program finish.
 */
export async function mirrorCaptureOutput(
  stream: ReadableStream<Uint8Array> | null,
  sink: { write(data: Uint8Array): Promise<number> | number },
): Promise<{ targetFinished: boolean }> {
  let targetFinished = false;
  await mirrorOutput(
    stream,
    sink,
    watchOutput(
      (text) => text.includes(CAPTURE_TARGET_FINISHED_MESSAGE) || undefined,
      () => {
        targetFinished = true;
      },
    ),
  );
  return { targetFinished };
}

/**
 * Returns the CLI's status, first stopping the CLI if the capture fails before
 * the CLI's program finishes, since the CLI may otherwise wait for a debugger
 * forever and its profile is lost anyway. A CLI whose program has finished
 * exits when the capture disconnects, so it is left to exit.
 */
export async function waitForCliStatusOrStopOnCaptureFailure(
  cliStatusPromise: Promise<CommandStatus>,
  captureResultPromise: Promise<CaptureResult>,
  cliProcess: KillableProcess,
): Promise<CommandStatus> {
  const first = await Promise.race([
    cliStatusPromise.then((status) => ({ kind: "cli" as const, status })),
    captureResultPromise.then((capture) => ({
      kind: "capture" as const,
      capture,
    })),
  ]);

  if (first.kind === "cli") return first.status;
  if (!first.capture.status.success && !first.capture.targetFinished) {
    try {
      cliProcess.kill("SIGTERM");
    } catch {
      // Already exited.
    }
  }
  return await cliStatusPromise;
}

export async function mirrorOutput(
  stream: ReadableStream<Uint8Array> | null,
  sink: { write(data: Uint8Array): Promise<number> | number },
  onText?: (text: string) => void,
): Promise<void> {
  if (stream === null) return;
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.length === 0) continue;
      const text = decoder.decode(value, { stream: true });
      if (text.length === 0) continue;
      onText?.(text);
      await sink.write(encoder.encode(text));
    }
    const tail = decoder.decode();
    if (tail.length > 0) {
      onText?.(tail);
      await sink.write(encoder.encode(tail));
    }
  } finally {
    reader.releaseLock();
  }
}
