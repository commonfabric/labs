export interface ProcessRunRequest {
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  clearEnv?: boolean;
  stdinText?: string;
  timeoutMs?: number;
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
      stdin: "null",
      stdout: "null",
      stderr: "null",
    }).spawn();
    let done = false;
    const exited = child.status.then((status) => {
      done = true;
      return { exitCode: status.code };
    });
    return {
      pid: child.pid,
      exited,
      kill: (signal = "SIGTERM") => {
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
    const controller = new AbortController();
    let timeoutTriggered = false;
    const timeoutId = request.timeoutMs !== undefined
      ? setTimeout(() => {
        timeoutTriggered = true;
        controller.abort();
      }, request.timeoutMs)
      : undefined;
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

      const [status, stdout, stderr] = await Promise.all([
        child.status,
        readStreamText(child.stdout),
        readStreamText(child.stderr),
        writeInput(),
      ]);

      if (timeoutTriggered && status.code !== 0) {
        throw new ProcessTimeoutError(
          [request.command, ...request.args].join(" "),
          request.timeoutMs ?? 0,
        );
      }

      return {
        stdout,
        stderr,
        exitCode: status.code,
      };
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        throw new ProcessTimeoutError(
          [request.command, ...request.args].join(" "),
          request.timeoutMs ?? 0,
        );
      }
      throw error;
    } finally {
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
      }
    }
  }
}
