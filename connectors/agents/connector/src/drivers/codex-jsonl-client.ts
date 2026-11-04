import { terminateChildProcess } from "../child-process.ts";

interface JsonRpcError {
  code?: number;
  message?: string;
  data?: unknown;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

interface NotificationWaiter {
  predicate: (message: Record<string, unknown>) => boolean;
  resolve: (message: Record<string, unknown>) => void;
  reject: (reason: unknown) => void;
}

export type CodexServerRequestHandler = (
  method: string,
  params: unknown,
) => unknown | Promise<unknown>;

export interface CodexJsonlClientOptions {
  env?: Record<string, string>;
  handleServerRequest?: CodexServerRequestHandler;
}

async function* lines(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      while (true) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) yield line;
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) yield buffer.trim();
  } finally {
    reader.releaseLock();
  }
}

export class CodexJsonlClient {
  readonly #command: string[];
  readonly #cwd?: string;
  readonly #env?: Record<string, string>;
  readonly #handleServerRequest?: CodexServerRequestHandler;
  #child?: Deno.ChildProcess;
  #writer?: WritableStreamDefaultWriter<Uint8Array>;
  #nextId = 1;
  #pending = new Map<number, PendingRequest>();
  #waiters = new Set<NotificationWaiter>();
  #notifications: Record<string, unknown>[] = [];
  #readTask?: Promise<void>;
  #stderrTask?: Promise<void>;
  #running = false;
  #stopSignal?: AbortSignal;
  #stopListener?: () => void;
  #stopTask?: Promise<void>;
  #cleanupTask?: Promise<void>;

  constructor(
    command: string[],
    cwd?: string,
    options: CodexJsonlClientOptions = {},
  ) {
    if (command.length === 0) {
      throw new Error("Codex command must not be empty");
    }
    this.#command = command;
    this.#cwd = cwd;
    this.#env = options.env ? { ...options.env } : undefined;
    this.#handleServerRequest = options.handleServerRequest;
  }

  async start(signal?: AbortSignal): Promise<Record<string, unknown>> {
    if (this.#child) throw new Error("Codex App Server already started");
    await this.#cleanupTask;
    if (this.#child) throw new Error("Codex App Server already started");
    signal?.throwIfAborted();
    this.#notifications = [];
    const child = new Deno.Command(this.#command[0], {
      args: this.#command.slice(1),
      cwd: this.#cwd,
      env: this.#env,
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    this.#child = child;
    this.#writer = child.stdin.getWriter();
    this.#running = true;
    this.#readTask = this.#readLoop(child.stdout);
    const stderrTask = this.#drainStderr(child.stderr);
    this.#stderrTask = stderrTask;
    void stderrTask.catch((error) => this.#terminate(error));
    if (signal) {
      this.#stopSignal = signal;
      this.#stopListener = () => {
        void this.stop();
      };
      signal.addEventListener("abort", this.#stopListener, { once: true });
      if (signal.aborted) {
        await this.stop();
        signal.throwIfAborted();
      }
    }
    try {
      const initialized = await this.call("initialize", {
        clientInfo: {
          name: "commonfabric-agents-connector",
          version: "0.1.0",
        },
        capabilities: null,
      });
      await this.notify("initialized");
      return initialized as Record<string, unknown>;
    } catch (error) {
      const readTask = this.#readTask;
      await this.#terminate(error);
      await readTask;
      throw error;
    }
  }

  stop(): Promise<void> {
    if (this.#stopTask) return this.#stopTask;
    const task = this.#stop();
    this.#stopTask = task;
    return task.finally(() => {
      if (this.#stopTask === task) this.#stopTask = undefined;
    });
  }

  async #stop(): Promise<void> {
    const readTask = this.#readTask;
    await this.#terminate(new Error("Codex App Server stopped"));
    await readTask;
  }

  #terminate(reason: unknown): Promise<void> {
    if (this.#stopSignal && this.#stopListener) {
      this.#stopSignal.removeEventListener("abort", this.#stopListener);
    }
    this.#stopSignal = undefined;
    this.#stopListener = undefined;
    const child = this.#child;
    if (!child) return this.#cleanupTask ?? Promise.resolve();
    this.#child = undefined;
    this.#running = false;
    this.#rejectAll(reason);
    const writer = this.#writer;
    this.#writer = undefined;
    const stderrTask = this.#stderrTask;
    this.#stderrTask = undefined;
    const closeTask = writer?.close().catch(() => undefined);
    terminateChildProcess(child);
    const cleanup = Promise.allSettled([
      child.status,
      closeTask,
      stderrTask,
    ]).then(() => undefined);
    this.#cleanupTask = cleanup;
    return cleanup.finally(() => {
      if (this.#cleanupTask === cleanup) this.#cleanupTask = undefined;
    });
  }

  call(
    method: string,
    params: unknown = {},
  ): Promise<unknown> {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#send({ jsonrpc: "2.0", id, method, params }).catch((error) => {
        this.#pending.delete(id);
        reject(error);
      });
    });
  }

  notify(method: string, params?: unknown): Promise<void> {
    return this.#send({
      jsonrpc: "2.0",
      method,
      ...(params === undefined ? {} : { params }),
    });
  }

  waitForNotification(
    predicate: (message: Record<string, unknown>) => boolean,
  ): Promise<Record<string, unknown>> {
    const buffered = this.#notifications.find(predicate);
    if (buffered) return Promise.resolve(buffered);
    if (!this.#running) {
      return Promise.reject(new Error("Codex App Server is not running"));
    }
    return new Promise((resolve, reject) => {
      this.#waiters.add({ predicate, resolve, reject });
    });
  }

  async #send(message: Record<string, unknown>): Promise<void> {
    if (!this.#running || !this.#writer) {
      throw new Error("Codex App Server is not running");
    }
    await this.#writer.write(
      new TextEncoder().encode(`${JSON.stringify(message)}\n`),
    );
  }

  async #readLoop(stdout: ReadableStream<Uint8Array>): Promise<void> {
    let exitReason: unknown = new Error("Codex App Server exited");
    try {
      for await (const line of lines(stdout)) {
        let message: Record<string, unknown>;
        try {
          const parsed: unknown = JSON.parse(line);
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            throw new Error("top-level value must be an object");
          }
          message = parsed as Record<string, unknown>;
        } catch (error) {
          throw new Error("Codex App Server emitted invalid JSON", {
            cause: error,
          });
        }
        if (
          typeof message.method === "string" &&
          (typeof message.id === "number" || typeof message.id === "string")
        ) {
          await this.#answerServerRequest(message);
          continue;
        }
        if (typeof message.id === "number") {
          const hasResult = Object.hasOwn(message, "result");
          const hasError = Object.hasOwn(message, "error");
          if (hasResult === hasError) {
            throw new Error(
              "Codex App Server emitted an invalid JSON-RPC response",
            );
          }
          if (
            hasError &&
            (!message.error || typeof message.error !== "object" ||
              Array.isArray(message.error))
          ) {
            throw new Error(
              "Codex App Server emitted an invalid JSON-RPC error",
            );
          }
          const pending = this.#pending.get(message.id);
          if (!pending) continue;
          this.#pending.delete(message.id);
          if (hasError) {
            const error = message.error as JsonRpcError;
            pending.reject(new Error(error.message || JSON.stringify(error)));
          } else {
            pending.resolve(message.result);
          }
          continue;
        }
        if (
          typeof message.method === "string" &&
          !Object.hasOwn(message, "id")
        ) {
          this.#publishNotification(message);
          continue;
        }
        throw new Error("Codex App Server emitted an invalid JSON-RPC message");
      }
    } catch (error) {
      exitReason = error;
    }
    await this.#terminate(exitReason);
  }

  async #answerServerRequest(message: Record<string, unknown>): Promise<void> {
    const id = message.id as number | string;
    const method = String(message.method);
    if (!this.#handleServerRequest) {
      await this.#send({
        jsonrpc: "2.0",
        id,
        error: {
          code: -32601,
          message: `Unsupported server request: ${method}`,
        },
      });
      return;
    }
    try {
      const result = await this.#handleServerRequest(method, message.params);
      await this.#send({ jsonrpc: "2.0", id, result });
    } catch (error) {
      await this.#send({
        jsonrpc: "2.0",
        id,
        error: { code: -32603, message: String(error) },
      });
    }
  }

  async #drainStderr(stderr: ReadableStream<Uint8Array>): Promise<void> {
    for await (const _line of lines(stderr)) {
      // Transcript data is drained without being copied to process output.
    }
  }

  #publishNotification(message: Record<string, unknown>): void {
    this.#notifications.push(message);
    if (this.#notifications.length > 500) this.#notifications.shift();
    for (const waiter of this.#waiters) {
      if (!waiter.predicate(message)) continue;
      this.#waiters.delete(waiter);
      waiter.resolve(message);
    }
  }

  #rejectAll(reason: unknown): void {
    for (const pending of this.#pending.values()) {
      pending.reject(reason);
    }
    this.#pending.clear();
    for (const waiter of this.#waiters) {
      waiter.reject(reason);
    }
    this.#waiters.clear();
  }
}
