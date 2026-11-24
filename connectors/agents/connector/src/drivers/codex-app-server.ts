import type {
  AgentDriver,
  AgentSourceConfig,
  CommandExecutionOptions,
  CommandExecutionResult,
  NativeSessionSnapshot,
  NormalizedMessage,
  PromptInput,
  SessionPage,
  SessionSummary,
} from "../types.ts";
import { CodexJsonlClient } from "./codex-jsonl-client.ts";
import { normalizeSourceId } from "../session-contract.ts";

export interface CodexAppServerLaunch {
  command: string[];
  bootstrapCommand?: string[];
}

export function codexTurnExecutionPolicy(
  config: AgentSourceConfig,
): Record<string, unknown> {
  return config.allowDangerFullAccess
    ? {
      approvalPolicy: "never",
      sandboxPolicy: { type: "dangerFullAccess" },
    }
    : {};
}

export function codexServerRequestPolicy(
  method: string,
): Record<string, unknown> {
  switch (method) {
    case "item/commandExecution/requestApproval":
    case "item/fileChange/requestApproval":
      // The connector has no interactive user surface. Safe-policy turns fail
      // closed instead of hanging forever or silently granting host access.
      return { decision: "decline" };
    default:
      throw new Error(`Unsupported Codex server request: ${method}`);
  }
}

export function resolveCodexAppServerLaunch(
  config: AgentSourceConfig,
  env: Record<string, string | undefined> = Deno.env.toObject(),
): CodexAppServerLaunch {
  if (config.command?.length) return { command: [...config.command] };
  const codex = config.codexBin || env.CODEX_BIN || "codex";
  switch (config.codexTransport ?? "stdio") {
    case "stdio":
      return {
        command: [codex, "app-server", "--listen", "stdio://"],
      };
    case "managed":
      return {
        bootstrapCommand: [codex, "app-server", "daemon", "start"],
        command: [codex, "app-server", "proxy"],
      };
    case "proxy":
      return {
        command: [
          codex,
          "app-server",
          "proxy",
          ...(config.codexSocket ? ["--sock", config.codexSocket] : []),
        ],
      };
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? value as Record<string, unknown>
    : {};
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function timestamp(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const millis = value < 10_000_000_000 ? value * 1000 : value;
  return new Date(millis).toISOString();
}

function threadActive(value: unknown): boolean | null {
  switch (record(value).type) {
    case "active":
      return true;
    case "idle":
    case "notLoaded":
    case "systemError":
      return false;
    default:
      return null;
  }
}

function threadSummary(
  value: unknown,
  archivedFallback: boolean | null = null,
): SessionSummary {
  const thread = record(value);
  return {
    nativeSessionId: String(thread.id ?? ""),
    title: typeof thread.name === "string"
      ? thread.name
      : typeof thread.title === "string"
      ? thread.title
      : null,
    cwd: typeof thread.cwd === "string" ? thread.cwd : null,
    createdAt: timestamp(thread.createdAt ?? thread.created_at),
    updatedAt: timestamp(thread.updatedAt ?? thread.updated_at),
    archived: typeof thread.archived === "boolean"
      ? thread.archived
      : archivedFallback,
    active: threadActive(thread.status),
    raw: { ...thread },
  };
}

function textFrom(value: unknown): string | null {
  if (typeof value === "string") return value.slice(0, 500);
  if (Array.isArray(value)) {
    const joined = value.map(textFrom).filter((item): item is string =>
      Boolean(item)
    ).join("\n");
    return joined ? joined.slice(0, 500) : null;
  }
  const item = record(value);
  if (typeof item.text === "string") return item.text.slice(0, 500);
  return "content" in item ? textFrom(item.content) : null;
}

function normalizedItems(turns: unknown[]): NormalizedMessage[] {
  const out: NormalizedMessage[] = [];
  for (const [rawIndex, turn] of turns.entries()) {
    for (const itemValue of array(record(turn).items)) {
      const item = record(itemValue);
      const type = String(item.type ?? "unknown");
      const role = type === "userMessage"
        ? "user"
        : type === "agentMessage"
        ? "assistant"
        : type.toLowerCase().includes("tool") || type === "commandExecution"
        ? "tool"
        : "unknown";
      out.push({
        id: String(item.id ?? `item-${out.length}`),
        role,
        kind: type,
        createdAt: timestamp(item.createdAt ?? item.created_at),
        textPreview: textFrom(item.content ?? item.text ?? item),
        rawIndex,
      });
    }
  }
  return out;
}

function unsupported(message: string): CommandExecutionResult {
  return {
    status: "unsupported",
    error: { code: "unsupported", message, retryable: false },
  };
}

function cursorState(cursor?: string): { archived: boolean; cursor?: string } {
  if (!cursor) return { archived: false };
  if (cursor === "archived:") return { archived: true };
  if (cursor.startsWith("active:")) {
    return { archived: false, cursor: cursor.slice(7) };
  }
  if (cursor.startsWith("archived:")) {
    return { archived: true, cursor: cursor.slice(9) || undefined };
  }
  throw new Error("invalid Codex cursor");
}

export class CodexAppServerDriver implements AgentDriver {
  readonly source;
  readonly #config: AgentSourceConfig;
  readonly #client: CodexJsonlClient;
  readonly #bootstrapCommand?: string[];
  readonly #env: Record<string, string>;
  readonly #activeTurns = new Map<string, string>();
  readonly #pendingTurns = new Set<string>();

  constructor(config: AgentSourceConfig) {
    this.#config = config;
    const launch = resolveCodexAppServerLaunch(config);
    this.#bootstrapCommand = launch.bootstrapCommand;
    this.#env = {
      ...config.env,
      ...(config.codexHome ? { CODEX_HOME: config.codexHome } : {}),
    };
    this.#client = new CodexJsonlClient(launch.command, config.cwd, {
      env: this.#env,
      handleServerRequest: (method) => codexServerRequestPolicy(method),
    });
    this.source = {
      id: normalizeSourceId(config.id),
      driver: config.driver,
      capabilities: {
        inventory: true,
        read: true,
        prompt: true,
        cancel: true,
        rename: true,
        setMode: false,
        setConfigOption: false,
      },
    } as const;
  }

  async start(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (this.#bootstrapCommand) {
      const output = await new Deno.Command(this.#bootstrapCommand[0], {
        args: this.#bootstrapCommand.slice(1),
        cwd: this.#config.cwd,
        env: this.#env,
        stdout: "piped",
        stderr: "piped",
        signal,
      }).output();
      signal?.throwIfAborted();
      if (!output.success) {
        const stderr = new TextDecoder().decode(output.stderr).trim();
        throw new Error(
          `Codex managed app-server failed to start` +
            (stderr ? `: ${stderr}` : ` (exit ${output.code})`),
        );
      }
    }
    await this.#client.start(signal);
  }

  stop(): Promise<void> {
    return this.#client.stop();
  }

  async listSessions(cursor?: string): Promise<SessionPage> {
    const state = cursorState(cursor);
    const result = record(
      await this.#client.call("thread/list", {
        archived: state.archived,
        limit: 100,
        ...(state.cursor ? { cursor: state.cursor } : {}),
      }),
    );
    const threads = array(result.data ?? result.threads);
    const next = typeof result.nextCursor === "string" && result.nextCursor
      ? `${state.archived ? "archived" : "active"}:${result.nextCursor}`
      : state.archived
      ? undefined
      : "archived:";
    return {
      sessions: threads.map((thread) => threadSummary(thread, state.archived)),
      nextCursor: next,
    };
  }

  async readSession(nativeSessionId: string): Promise<NativeSessionSnapshot> {
    const result = record(
      await this.#client.call("thread/read", {
        threadId: nativeSessionId,
        includeTurns: true,
      }),
    );
    const thread = record(result.thread ?? result);
    if (!thread.id) {
      throw new Error(`Codex thread not found: ${nativeSessionId}`);
    }
    const turns = array(thread.turns);
    return {
      summary: threadSummary(thread),
      events: turns,
      normalizedMessages: normalizedItems(turns),
      complete: true,
      revision: String(thread.updatedAt ?? thread.updated_at ?? ""),
    };
  }

  async renameSession(
    nativeSessionId: string,
    title: string,
  ): Promise<CommandExecutionResult> {
    await this.#client.call("thread/name/set", {
      threadId: nativeSessionId,
      name: title,
    });
    return { status: "succeeded", result: { title } };
  }

  async prompt(
    nativeSessionId: string,
    input: PromptInput,
    options: CommandExecutionOptions = {},
  ): Promise<CommandExecutionResult> {
    if (
      this.#pendingTurns.has(nativeSessionId) ||
      this.#activeTurns.has(nativeSessionId)
    ) {
      return {
        status: "needs-confirmation",
        error: {
          code: "already-active",
          message: "thread already has an active connector turn",
          retryable: true,
        },
      };
    }
    this.#pendingTurns.add(nativeSessionId);
    try {
      await this.#client.call("thread/resume", { threadId: nativeSessionId });
      const executionPolicy = codexTurnExecutionPolicy(this.#config);
      const started = record(
        await this.#client.call("turn/start", {
          threadId: nativeSessionId,
          input: [{ type: "text", text: input.text, text_elements: [] }],
          ...executionPolicy,
        }),
      );
      const turn = record(started.turn ?? started);
      const turnId = String(turn.id ?? "");
      if (!turnId) {
        return {
          status: "unknown",
          error: {
            code: "missing-turn-id",
            message: "Codex turn/start returned no turn id",
            retryable: false,
          },
        };
      }
      this.#pendingTurns.delete(nativeSessionId);
      this.#activeTurns.set(nativeSessionId, turnId);
      try {
        options.onCancellationReady?.();
        await options.onSessionActive?.();
        const completed = await this.#client.waitForNotification((message) => {
          if (message.method !== "turn/completed") return false;
          const params = record(message.params);
          return params.threadId === nativeSessionId &&
            record(params.turn).id === turnId;
        });
        const status = String(
          record(record(completed).params).turn
            ? record(record(record(completed).params).turn).status ??
              "completed"
            : "completed",
        );
        return status === "completed"
          ? { status: "succeeded", providerOperationId: turnId }
          : {
            status: "failed",
            providerOperationId: turnId,
            error: {
              code: "turn-failed",
              message: `Codex turn ended with ${status}`,
              retryable: false,
            },
          };
      } catch (error) {
        return {
          status: "unknown",
          providerOperationId: turnId,
          error: {
            code: "turn-outcome-unknown",
            message: String(error),
            retryable: false,
          },
        };
      } finally {
        this.#activeTurns.delete(nativeSessionId);
      }
    } finally {
      this.#pendingTurns.delete(nativeSessionId);
    }
  }

  async cancel(nativeSessionId: string): Promise<CommandExecutionResult> {
    const turnId = this.#activeTurns.get(nativeSessionId);
    if (!turnId) {
      return unsupported(
        "Codex cancel is available only for a connector-owned turn",
      );
    }
    await this.#client.call("turn/interrupt", {
      threadId: nativeSessionId,
      turnId,
    });
    return { status: "succeeded", providerOperationId: turnId };
  }

  setMode(
    _nativeSessionId: string,
    _mode: string,
  ): Promise<CommandExecutionResult> {
    return Promise.resolve(
      unsupported(
        "Codex App Server does not expose a persistent generic set-mode operation",
      ),
    );
  }

  setConfigOption(
    _nativeSessionId: string,
    key: string,
    _value: unknown,
  ): Promise<CommandExecutionResult> {
    return Promise.resolve(
      unsupported(`unsupported Codex config option: ${key}`),
    );
  }

  startSession(): Promise<CommandExecutionResult> {
    return Promise.resolve(
      unsupported("Codex sessions are started by the Codex app, not here"),
    );
  }
}
