import {
  ClientSideConnection,
  type InitializeResponse,
  type ListSessionsRequest,
  type ListSessionsResponse,
  type LoadSessionRequest,
  type LoadSessionResponse,
  ndJsonStream,
  type PromptRequest,
  type PromptResponse,
  PROTOCOL_VERSION,
  type ResumeSessionRequest,
  type ResumeSessionResponse,
  type SessionNotification,
  type SetSessionConfigOptionRequest,
  type SetSessionConfigOptionResponse,
  type SetSessionModeRequest,
  type SetSessionModeResponse,
} from "@agentclientprotocol/sdk";
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
  SourceDescriptor,
} from "../types.ts";
import { normalizeSourceId } from "../session-contract.ts";
import { terminateChildProcess } from "../child-process.ts";

export interface AcpTransport {
  setSessionUpdateSink(sink: (notification: SessionNotification) => void): void;
  initialize(signal?: AbortSignal): Promise<InitializeResponse>;
  listSessions(params: ListSessionsRequest): Promise<ListSessionsResponse>;
  loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse>;
  resumeSession(params: ResumeSessionRequest): Promise<ResumeSessionResponse>;
  prompt(params: PromptRequest): Promise<PromptResponse>;
  cancel(params: { sessionId: string }): Promise<void>;
  setSessionMode(
    params: SetSessionModeRequest,
  ): Promise<SetSessionModeResponse>;
  setSessionConfigOption(
    params: SetSessionConfigOptionRequest,
  ): Promise<SetSessionConfigOptionResponse>;
  stop(): Promise<void>;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? value as Record<string, unknown>
    : {};
}

function arrayConfigValues(value: unknown): Set<string> {
  const values = new Set<string>();
  if (!Array.isArray(value)) return values;
  for (const itemValue of value) {
    const item = record(itemValue);
    if (typeof item.value === "string") values.add(item.value);
    if (Array.isArray(item.options)) {
      for (const optionValue of item.options) {
        const option = record(optionValue);
        if (typeof option.value === "string") values.add(option.value);
      }
    }
  }
  return values;
}

function textFrom(value: unknown): string | null {
  if (typeof value === "string") return value.slice(0, 500);
  if (Array.isArray(value)) {
    const result = value.map(textFrom).filter((item): item is string =>
      Boolean(item)
    ).join("\n");
    return result ? result.slice(0, 500) : null;
  }
  const item = record(value);
  if (typeof item.text === "string") return item.text.slice(0, 500);
  return "content" in item ? textFrom(item.content) : null;
}

function roleForUpdate(
  update: Record<string, unknown>,
): NormalizedMessage["role"] {
  const kind = String(update.sessionUpdate ?? "unknown");
  if (kind === "user_message_chunk") return "user";
  if (kind === "agent_message_chunk" || kind === "agent_thought_chunk") {
    return "assistant";
  }
  if (kind.includes("tool_call")) return "tool";
  return "unknown";
}

function normalizeUpdates(updates: unknown[]): NormalizedMessage[] {
  return updates.map((value, index) => {
    const update = record(value);
    return {
      id: String(update.id ?? `update-${index}`),
      role: roleForUpdate(update),
      kind: String(update.sessionUpdate ?? "unknown"),
      createdAt: null,
      textPreview: textFrom(update.content ?? update),
      rawIndex: index,
    };
  });
}

function unsupported(message: string): CommandExecutionResult {
  return {
    status: "unsupported",
    error: { code: "unsupported", message, retryable: false },
  };
}

class ProcessAcpTransport implements AcpTransport {
  readonly #config: AgentSourceConfig;
  #child?: Deno.ChildProcess;
  #connection?: ClientSideConnection;
  #sink: (notification: SessionNotification) => void = () => {};

  constructor(config: AgentSourceConfig) {
    this.#config = config;
  }

  setSessionUpdateSink(
    sink: (notification: SessionNotification) => void,
  ): void {
    this.#sink = sink;
  }

  async initialize(signal?: AbortSignal): Promise<InitializeResponse> {
    if (this.#connection) throw new Error("ACP transport already initialized");
    signal?.throwIfAborted();
    const [command, ...args] = this.#config.command ?? [];
    if (!command) {
      throw new Error(`ACP source ${this.#config.id} requires a command`);
    }
    this.#child = new Deno.Command(command, {
      args,
      cwd: this.#config.cwd,
      env: this.#config.env,
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
      signal,
    }).spawn();
    const child = this.#child;
    child.stderr.pipeTo(
      new WritableStream({
        write(chunk: Uint8Array) {
          console.error(
            `[agents-connector][acp] ${
              new TextDecoder().decode(chunk).trimEnd()
            }`,
          );
        },
      }),
    ).catch(() => {});
    this.#connection = new ClientSideConnection(
      () => ({
        requestPermission: () =>
          Promise.resolve({ outcome: { outcome: "cancelled" as const } }),
        sessionUpdate: (params) => this.#sink(params),
      }),
      ndJsonStream(child.stdin, child.stdout),
    );
    const initialized = await this.#connection.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {},
      clientInfo: { name: "commonfabric-agents-connector", version: "0.1.0" },
    });
    signal?.throwIfAborted();
    return initialized;
  }

  #connected(): ClientSideConnection {
    if (!this.#connection) throw new Error("ACP transport is not initialized");
    return this.#connection;
  }

  listSessions(params: ListSessionsRequest): Promise<ListSessionsResponse> {
    return this.#connected().listSessions(params);
  }

  loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
    return this.#connected().loadSession(params);
  }

  resumeSession(params: ResumeSessionRequest): Promise<ResumeSessionResponse> {
    return this.#connected().resumeSession(params);
  }

  prompt(params: PromptRequest): Promise<PromptResponse> {
    return this.#connected().prompt(params);
  }

  cancel(params: { sessionId: string }): Promise<void> {
    return this.#connected().cancel(params);
  }

  setSessionMode(
    params: SetSessionModeRequest,
  ): Promise<SetSessionModeResponse> {
    return this.#connected().setSessionMode(params);
  }

  setSessionConfigOption(
    params: SetSessionConfigOptionRequest,
  ): Promise<SetSessionConfigOptionResponse> {
    return this.#connected().setSessionConfigOption(params);
  }

  async stop(): Promise<void> {
    const child = this.#child;
    this.#connection = undefined;
    this.#child = undefined;
    if (!child) return;
    terminateChildProcess(child);
    await child.status.catch(() => undefined);
  }
}

export class AcpDriver implements AgentDriver {
  readonly source: SourceDescriptor;
  readonly #config: AgentSourceConfig;
  readonly #transport: AcpTransport;
  readonly #summaries = new Map<string, SessionSummary>();
  readonly #updates = new Map<string, unknown[]>();
  readonly #loadQueues = new Map<string, Promise<void>>();
  readonly #activePrompts = new Set<string>();
  readonly #pendingPrompts = new Set<string>();
  readonly #inventorySessionIds = new Set<string>();
  readonly #sessionModes = new Map<string, Set<string>>();
  readonly #sessionConfigOptions = new Map<
    string,
    Map<string, Record<string, unknown>>
  >();
  #initialized?: InitializeResponse;

  constructor(
    config: AgentSourceConfig,
    transport: AcpTransport = new ProcessAcpTransport(config),
  ) {
    this.#config = config;
    this.#transport = transport;
    this.source = {
      id: normalizeSourceId(config.id),
      driver: "acp",
      capabilities: {
        inventory: false,
        read: false,
        prompt: true,
        cancel: true,
        rename: false,
        setMode: false,
        setConfigOption: false,
      },
    };
    transport.setSessionUpdateSink((notification) => {
      const updates = this.#updates.get(notification.sessionId);
      if (updates) updates.push(notification.update);
    });
  }

  async start(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    let abortListener: (() => void) | undefined;
    const aborted = signal
      ? new Promise<never>((_resolve, reject) => {
        abortListener = () => reject(signal.reason);
        if (signal.aborted) abortListener();
        else signal.addEventListener("abort", abortListener, { once: true });
      })
      : undefined;
    try {
      const initialization = this.#transport.initialize(signal);
      this.#initialized = aborted
        ? await Promise.race([initialization, aborted])
        : await initialization;
      signal?.throwIfAborted();
      const caps = this.#initialized.agentCapabilities;
      const inventory = caps?.sessionCapabilities?.list != null;
      const read = caps?.loadSession === true;
      this.source.version = this.#initialized.agentInfo?.version ?? undefined;
      this.source.capabilities.inventory = inventory;
      this.source.capabilities.read = read;
      if (!inventory || !read) {
        throw new Error(
          `ACP source ${this.#config.id} must advertise session/list and session/load to sync persisted sessions`,
        );
      }
    } catch (error) {
      await this.#transport.stop();
      throw error;
    } finally {
      if (signal && abortListener) {
        signal.removeEventListener("abort", abortListener);
      }
    }
  }

  stop(): Promise<void> {
    return this.#transport.stop();
  }

  async listSessions(cursor?: string): Promise<SessionPage> {
    if (!cursor) this.#inventorySessionIds.clear();
    const result = await this.#transport.listSessions({
      ...(cursor ? { cursor } : {}),
    });
    const sessions = result.sessions.map((item): SessionSummary => ({
      nativeSessionId: item.sessionId,
      title: item.title ?? null,
      cwd: item.cwd,
      createdAt: null,
      updatedAt: item.updatedAt ?? null,
      archived: null,
      active: null,
      raw: { ...item },
    }));
    for (const summary of sessions) {
      this.#summaries.set(summary.nativeSessionId, summary);
      this.#inventorySessionIds.add(summary.nativeSessionId);
    }
    if (!result.nextCursor) {
      for (const sessionId of this.#summaries.keys()) {
        if (this.#inventorySessionIds.has(sessionId)) continue;
        this.#summaries.delete(sessionId);
        this.#sessionModes.delete(sessionId);
        this.#sessionConfigOptions.delete(sessionId);
      }
      this.#publishSessionControls();
    }
    return { sessions, nextCursor: result.nextCursor ?? undefined };
  }

  readSession(nativeSessionId: string): Promise<NativeSessionSnapshot> {
    return this.#withSessionLoad(
      nativeSessionId,
      () => this.#readSession(nativeSessionId),
    );
  }

  #withSessionLoad<T>(
    nativeSessionId: string,
    load: () => Promise<T>,
  ): Promise<T> {
    const preceding = this.#loadQueues.get(nativeSessionId) ??
      Promise.resolve();
    const result = preceding.then(load);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.#loadQueues.set(nativeSessionId, tail);
    return result.finally(() => {
      if (this.#loadQueues.get(nativeSessionId) === tail) {
        this.#loadQueues.delete(nativeSessionId);
      }
    });
  }

  async #readSession(
    nativeSessionId: string,
  ): Promise<NativeSessionSnapshot> {
    const summary = this.#summaries.get(nativeSessionId);
    if (!summary?.cwd) {
      throw new Error(
        `ACP session not listed or missing cwd: ${nativeSessionId}`,
      );
    }
    const events: unknown[] = [];
    this.#updates.set(nativeSessionId, events);
    try {
      const response = await this.#transport.loadSession({
        sessionId: nativeSessionId,
        cwd: summary.cwd,
        additionalDirectories: Array.isArray(summary.raw.additionalDirectories)
          ? summary.raw.additionalDirectories as string[]
          : undefined,
        mcpServers: [],
      });
      this.#rememberSessionControls(nativeSessionId, response);
      return {
        summary,
        events,
        normalizedMessages: normalizeUpdates(events),
        complete: true,
        revision: summary.updatedAt ?? undefined,
      };
    } finally {
      this.#updates.delete(nativeSessionId);
    }
  }

  async prompt(
    nativeSessionId: string,
    input: PromptInput,
    options: CommandExecutionOptions = {},
  ): Promise<CommandExecutionResult> {
    if (
      this.#pendingPrompts.has(nativeSessionId) ||
      this.#activePrompts.has(nativeSessionId)
    ) {
      return {
        status: "needs-confirmation",
        error: {
          code: "already-active",
          message: "ACP session already has a connector-owned prompt",
          retryable: true,
        },
      };
    }
    const summary = this.#summaries.get(nativeSessionId);
    if (!summary?.cwd) {
      return unsupported(`ACP session was not listed: ${nativeSessionId}`);
    }
    this.#pendingPrompts.add(nativeSessionId);
    try {
      const cwd = summary.cwd;
      if (
        this.#initialized?.agentCapabilities?.sessionCapabilities?.resume !=
          null
      ) {
        const response = await this.#transport.resumeSession({
          sessionId: nativeSessionId,
          cwd,
          mcpServers: [],
        });
        this.#rememberSessionControls(nativeSessionId, response);
      } else {
        await this.#withSessionLoad(
          nativeSessionId,
          async () => {
            const response = await this.#transport.loadSession({
              sessionId: nativeSessionId,
              cwd,
              mcpServers: [],
            });
            this.#rememberSessionControls(nativeSessionId, response);
          },
        );
      }
      this.#pendingPrompts.delete(nativeSessionId);
      this.#activePrompts.add(nativeSessionId);
      try {
        const pending = this.#transport.prompt({
          sessionId: nativeSessionId,
          prompt: [{ type: "text", text: input.text }],
        });
        options.onCancellationReady?.();
        await options.onSessionActive?.();
        const result = await pending;
        return result.stopReason === "cancelled"
          ? {
            status: "failed",
            result: { stopReason: result.stopReason },
            error: {
              code: "cancelled",
              message: "ACP prompt was cancelled",
              retryable: false,
            },
          }
          : { status: "succeeded", result: { stopReason: result.stopReason } };
      } catch (error) {
        return {
          status: "unknown",
          error: {
            code: "prompt-outcome-unknown",
            message: String(error),
            retryable: false,
          },
        };
      } finally {
        this.#activePrompts.delete(nativeSessionId);
      }
    } finally {
      this.#pendingPrompts.delete(nativeSessionId);
    }
  }

  startSession(): Promise<CommandExecutionResult> {
    return Promise.resolve(
      unsupported("ACP has no portable operation that starts a session"),
    );
  }

  async cancel(nativeSessionId: string): Promise<CommandExecutionResult> {
    if (!this.#activePrompts.has(nativeSessionId)) {
      return unsupported(
        "ACP cancel is available only for a connector-owned prompt",
      );
    }
    await this.#transport.cancel({ sessionId: nativeSessionId });
    return { status: "succeeded" };
  }

  renameSession(
    _nativeSessionId: string,
    _title: string,
  ): Promise<CommandExecutionResult> {
    return Promise.resolve(
      unsupported("ACP does not define a portable session rename method"),
    );
  }

  async setMode(
    nativeSessionId: string,
    mode: string,
  ): Promise<CommandExecutionResult> {
    if (!this.#sessionModes.get(nativeSessionId)?.has(mode)) {
      return unsupported(
        `ACP adapter did not advertise mode for this session: ${mode}`,
      );
    }
    await this.#transport.setSessionMode({
      sessionId: nativeSessionId,
      modeId: mode,
    });
    return { status: "succeeded", result: { mode } };
  }

  async setConfigOption(
    nativeSessionId: string,
    key: string,
    value: unknown,
  ): Promise<CommandExecutionResult> {
    const option = this.#sessionConfigOptions.get(nativeSessionId)?.get(key);
    if (!option) {
      return unsupported(
        `ACP adapter did not advertise config option for this session: ${key}`,
      );
    }
    if (option.type !== "boolean" && option.type !== "select") {
      return unsupported(`ACP config option has an unknown type: ${key}`);
    }
    if (option.type === "boolean" && typeof value !== "boolean") {
      return unsupported(
        `ACP config value has the wrong type: ${key}`,
      );
    }
    if (option.type === "select") {
      if (typeof value !== "string") {
        return unsupported(`ACP config value has the wrong type: ${key}`);
      }
      if (!arrayConfigValues(option.options).has(value)) {
        return unsupported(`ACP config value was not advertised: ${key}`);
      }
    }
    const response = await this.#transport.setSessionConfigOption({
      sessionId: nativeSessionId,
      configId: key,
      ...(typeof value === "boolean"
        ? { type: "boolean" as const, value }
        : { value: value as string }),
    });
    this.#rememberSessionControls(nativeSessionId, {
      configOptions: response.configOptions,
    }, true);
    return { status: "succeeded", result: { key, value } };
  }

  #rememberSessionControls(
    nativeSessionId: string,
    response: Pick<LoadSessionResponse, "modes" | "configOptions">,
    partial = false,
  ): void {
    if (!partial || "modes" in response) {
      const modes = new Set(
        response.modes?.availableModes.map((mode) => mode.id) ?? [],
      );
      this.#sessionModes.set(nativeSessionId, modes);
    }
    if (!partial || "configOptions" in response) {
      const options = new Map<string, Record<string, unknown>>();
      for (const option of response.configOptions ?? []) {
        options.set(option.id, { ...option });
      }
      this.#sessionConfigOptions.set(nativeSessionId, options);
    }
    this.#publishSessionControls();
  }

  #publishSessionControls(): void {
    const modes = new Set<string>();
    for (const sessionModes of this.#sessionModes.values()) {
      for (const mode of sessionModes) modes.add(mode);
    }
    const configOptions = new Map<string, Record<string, unknown>>();
    const sessions = [...this.#sessionConfigOptions].sort(([left], [right]) =>
      left.localeCompare(right)
    );
    for (const [, sessionOptions] of sessions) {
      for (const [id, option] of sessionOptions) {
        configOptions.set(id, option);
      }
    }
    this.source.capabilities.setMode = modes.size > 0;
    this.source.capabilities.modes = [...modes].sort();
    this.source.capabilities.setConfigOption = configOptions.size > 0;
    this.source.capabilities.configOptions = Object.fromEntries(
      [...configOptions].sort(([left], [right]) => left.localeCompare(right)),
    );
  }
}
