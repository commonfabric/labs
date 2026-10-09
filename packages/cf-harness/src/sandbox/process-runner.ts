export interface ProcessRunRequest {
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  clearEnv?: boolean;
  stdinText?: string;
  timeoutMs?: number;
  /**
   * Stops the process with SIGTERM when it aborts, as a timeout does; the
   * run then throws the signal's reason once the process has ended, and not
   * a timeout, whatever status the process ends with. A run whose signal has
   * already aborted throws its reason, starting nothing.
   */
  signal?: AbortSignal;
}

export interface ProcessRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface ProcessRunner {
  run(request: ProcessRunRequest): Promise<ProcessRunResult>;
  /**
   * Start a process and hand back its handle instead of waiting for it. A
   * sandbox session is a long-lived child the runtime keeps alive between
   * tool calls; this is how it is started and, when the run ends, stopped.
   */
  spawn?(request: ProcessSpawnRequest): ProcessHandle;
}

export interface ProcessSpawnRequest {
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  /**
   * `"held"` gives the child a stdin pipe this process keeps open and never
   * writes to. The pipe closes when this process exits, however it exits, so
   * a child that reads its stdin learns that its parent is gone; a kill
   * through the handle closes it too. Default `"null"`.
   */
  stdin?: "null" | "held";
}

export interface ProcessHandle {
  readonly pid: number;
  /** Resolves when the process exits. */
  readonly exited: Promise<{ exitCode: number }>;
  kill(signal?: "SIGTERM" | "SIGKILL"): void;
}

export class ProcessTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(command: string, timeoutMs: number) {
    super(`process timed out after ${timeoutMs}ms: ${command}`);
    this.name = "ProcessTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();

const readStreamText = async (
  stream: ReadableStream<Uint8Array> | null,
): Promise<string> => {
  if (!stream) {
    return "";
  }
  const buffer = await new Response(stream).arrayBuffer();
  return textDecoder.decode(buffer);
};

export class DenoProcessRunner implements ProcessRunner {
  spawn(request: ProcessSpawnRequest): ProcessHandle {
    const child = new Deno.Command(request.command, {
      args: request.args,
      cwd: request.cwd,
      env: request.env,
      stdin: request.stdin === "held" ? "piped" : "null",
      stdout: "null",
      stderr: "null",
    }).spawn();
    const held = request.stdin === "held" ? child.stdin : undefined;
    const release = () => {
      held?.abort().catch(() => undefined);
    };
    let done = false;
    const exited = child.status.then((status) => {
      done = true;
      release();
      return { exitCode: status.code };
    });
    return {
      pid: child.pid,
      exited,
      kill: (signal = "SIGTERM") => {
        release();
        if (done) return;
        try {
          child.kill(signal);
        } catch {
          // Already gone.
        }
      },
    };
  }

  async run(request: ProcessRunRequest): Promise<ProcessRunResult> {
    // Deno starts a process whose signal has already aborted, and runs it to
    // its end, so a run that is stopped before it starts starts nothing.
    request.signal?.throwIfAborted();
    const controller = new AbortController();
    let timeoutTriggered = false;
    const timeoutId = request.timeoutMs !== undefined
      ? setTimeout(() => {
        timeoutTriggered = true;
        controller.abort();
      }, request.timeoutMs)
      : undefined;
    // Whichever stops the process first is why it stopped: a signal that
    // aborts disarms the timeout, so one that comes due while the process
    // ends does not take its place.
    const stop = () => {
      if (timeoutTriggered) return;
      clearTimeout(timeoutId);
      controller.abort();
    };
    request.signal?.addEventListener("abort", stop, { once: true });
    try {
      const child = new Deno.Command(request.command, {
        args: request.args,
        cwd: request.cwd,
        env: request.env,
        clearEnv: request.clearEnv,
        stdin: request.stdinText !== undefined ? "piped" : "null",
        stdout: "piped",
        stderr: "piped",
        signal: controller.signal,
      }).spawn();

      const writeInput = async () => {
        if (request.stdinText === undefined || child.stdin === null) {
          return;
        }
        const writer = child.stdin.getWriter();
        try {
          await writer.write(textEncoder.encode(request.stdinText));
        } finally {
          await writer.close();
        }
      };

      // A write the process stopped short of failing is told only once the
      // process has ended, and only where nothing stopped it: a stopped
      // process closes its stdin under a write in flight.
      let inputFailure: { error: unknown } | undefined;
      const [status, stdout, stderr] = await Promise.all([
        child.status,
        readStreamText(child.stdout),
        readStreamText(child.stderr),
        writeInput().catch((error: unknown) => {
          inputFailure = { error };
        }),
      ]);

      // Whatever status the process ends with: one that answers SIGTERM by
      // exiting 0 (pasta does, once the kernel has killed what it ran) was
      // still stopped.
      if (timeoutTriggered) {
        throw new ProcessTimeoutError(
          [request.command, ...request.args].join(" "),
          request.timeoutMs ?? 0,
        );
      }
      request.signal?.throwIfAborted();
      if (inputFailure !== undefined) throw inputFailure.error;

      return {
        stdout,
        stderr,
        exitCode: status.code,
      };
    } catch (error) {
      if (
        timeoutTriggered && error instanceof DOMException &&
        error.name === "AbortError"
      ) {
        throw new ProcessTimeoutError(
          [request.command, ...request.args].join(" "),
          request.timeoutMs ?? 0,
        );
      }
      throw error;
    } finally {
      request.signal?.removeEventListener("abort", stop);
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
      }
    }
  }
}
