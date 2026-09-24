import { resolve } from "@std/path";
import * as defaultSdk from "@anthropic-ai/claude-agent-sdk";
import type {
  AgentDriver,
  AgentSourceConfig,
  CommandExecutionOptions,
  CommandExecutionResult,
  NativeSessionSnapshot,
  PromptInput,
  SessionPage,
  SessionSummary,
  SourceDescriptor,
  StartInput,
} from "../types.ts";
import { AsyncSerialQueue } from "../serial-queue.ts";
import { normalizeSourceId } from "../session-contract.ts";

interface ClaudeSessionInfo {
  sessionId: string;
  summary: string;
  lastModified: number;
  fileSize?: number;
  customTitle?: string;
  firstPrompt?: string;
  gitBranch?: string;
  cwd?: string;
  tag?: string;
  createdAt?: number;
}

interface ClaudeSessionMessage {
  type: string;
  uuid: string;
  session_id: string;
  message: unknown;
  parent_tool_use_id: string | null;
  parent_agent_id: string | null;
}

interface ClaudeQuery extends AsyncGenerator<unknown, void> {
  interrupt(): Promise<unknown>;
  setPermissionMode(
    mode:
      | "default"
      | "acceptEdits"
      | "bypassPermissions"
      | "plan"
      | "dontAsk"
      | "auto",
  ): Promise<void>;
  setModel(model?: string): Promise<void>;
  close(): void;
}

interface PendingClaudePrompt {
  cancellation: "cancelled" | "stopped" | null;
}

/** A start sent to the desktop app, waiting for the session the app makes
 * once the person sends the prompt. */
interface DesktopStart {
  text: string;
  cwd: string;
  title: string | null;
  sentAt: number;
  /** All sessions in a fresh inventory taken before opening the app. */
  knownSessionIds: ReadonlySet<string>;
}

/** What a desktop start needs from the machine; injectable for tests. */
export interface ClaudeDesktopDeps {
  /** Whether the Claude Code desktop app is installed here. */
  installed(): Promise<boolean>;
  /** Opens a `claude://` link in the app; false when the open failed. */
  openUrl(url: string): Promise<boolean>;
  /** Whether `path` is a directory here: the app opens a session only in
   * one. */
  isDirectory(path: string): Promise<boolean>;
  /** The platform, as `Deno.build.os` spells it. */
  os: string;
  now(): number;
}

const DESKTOP_APP_PATH = "/Applications/Claude.app";

/** Whether the desktop app is installed at the path macOS keeps it. */
export const desktopAppInstalled = async (
  path = DESKTOP_APP_PATH,
): Promise<boolean> => {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
};

/** Opens a link through the platform's opener (`open` on macOS); false when
 * the opener is missing or refuses the link. */
export const openWithCommand = async (
  command: string,
  url: string,
): Promise<boolean> => {
  try {
    const { code } = await new Deno.Command(command, {
      args: [url],
      stdout: "null",
      stderr: "null",
    }).output();
    return code === 0;
  } catch {
    return false;
  }
};

/** Whether `path` names a directory; false when it is missing or a file. */
export const directoryExists = async (path: string): Promise<boolean> => {
  try {
    return (await Deno.stat(path)).isDirectory;
  } catch {
    return false;
  }
};

const defaultDesktopDeps: ClaudeDesktopDeps = {
  installed: () => desktopAppInstalled(),
  openUrl: (url) => openWithCommand("open", url),
  isDirectory: directoryExists,
  os: Deno.build.os,
  now: Date.now,
};

// The app reads at most this much of a `claude://code/new` prompt.
const DESKTOP_PROMPT_LIMIT = 14336;
// A desktop start the person never sends is forgotten after this long.
const DESKTOP_START_WINDOW_MS = 24 * 60 * 60 * 1000;

/** The shape a prompt is compared in: whitespace collapsed, bounded. */
const promptKey = (text: string): string =>
  text.replace(/\s+/g, " ").trim().slice(0, 200);

/** The listed first prompt as a comparable prefix: the SDK lists at most
 * 200 characters of it and marks a cut with a trailing ellipsis, which is
 * not part of the prompt. */
const listedPromptKey = (text: string): string =>
  promptKey(text.replace(/\s*…$/, ""));

/** Whether a listed session could be the one a desktop start produced: not
 * in its pre-launch inventory, in the start's directory, created at or after
 * the launch boundary, and opening with the start's text
 * (the SDK may list a prefix of the first prompt). */
const desktopStartMatches = (
  start: DesktopStart,
  info: ClaudeSessionInfo,
): boolean => {
  if (start.knownSessionIds.has(info.sessionId)) return false;
  if (!info.cwd || resolve(info.cwd) !== resolve(start.cwd)) return false;
  if (
    info.createdAt === undefined || !Number.isFinite(info.createdAt) ||
    info.createdAt < start.sentAt
  ) {
    return false;
  }
  const first = listedPromptKey(info.firstPrompt ?? "");
  return first.length > 0 && promptKey(start.text).startsWith(first);
};

export interface ClaudeSdkAdapter {
  listSessions(
    options?: { limit?: number; offset?: number; dir?: string },
  ): Promise<ClaudeSessionInfo[]>;
  getSessionInfo(sessionId: string): Promise<ClaudeSessionInfo | undefined>;
  getSessionMessages(
    sessionId: string,
    options?: { includeSystemMessages?: boolean },
  ): Promise<ClaudeSessionMessage[]>;
  renameSession(sessionId: string, title: string): Promise<void>;
  query(params: {
    prompt: string;
    options?: Record<string, unknown>;
  }): ClaudeQuery;
}

const PAGE_SIZE = 100;
const PREVIEW_LIMIT = 500;
const claudeSourceEnvironment = new AsyncSerialQueue();

// The SDK accepts a caller-chosen id for a new session only in this form.
const CLAUDE_SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isoFromMillis(value: unknown): string | null {
  return typeof value === "number" && Number.isFinite(value)
    ? new Date(value).toISOString()
    : null;
}

function asRaw(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? { ...value as Record<string, unknown> }
    : { value };
}

function textFrom(value: unknown): string | null {
  if (typeof value === "string") return value.slice(0, PREVIEW_LIMIT);
  if (Array.isArray(value)) {
    const joined = value.map(textFrom).filter((item): item is string =>
      Boolean(item)
    ).join("\n");
    return joined ? joined.slice(0, PREVIEW_LIMIT) : null;
  }
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.text === "string") {
    return record.text.slice(0, PREVIEW_LIMIT);
  }
  if ("content" in record) return textFrom(record.content);
  return null;
}

function summaryFrom(
  info: ClaudeSessionInfo,
  connectorQueryActive: boolean,
): SessionSummary {
  return {
    nativeSessionId: info.sessionId,
    title: info.customTitle || info.summary || info.firstPrompt || null,
    cwd: info.cwd || null,
    createdAt: isoFromMillis(info.createdAt),
    updatedAt: isoFromMillis(info.lastModified),
    // TODO(@ianh): Populate archive and provider-wide activity state when
    // Claude's session inventory provides it. Query tracking identifies only
    // prompts started by this process.
    archived: null,
    active: connectorQueryActive ? true : null,
    raw: asRaw(info),
  };
}

function unsupported(message: string): CommandExecutionResult {
  return {
    status: "unsupported",
    error: { code: "unsupported", message, retryable: false },
  };
}

function sessionLookupFailure(error: unknown): CommandExecutionResult {
  return {
    status: "failed",
    error: {
      code: "claude-session-lookup-failed",
      message: String(error),
      retryable: true,
    },
  };
}

function pendingPromptCancellation(
  cancellation: NonNullable<PendingClaudePrompt["cancellation"]>,
): CommandExecutionResult {
  return {
    status: "failed",
    error: {
      code: cancellation === "cancelled"
        ? "cancelled"
        : "claude-driver-stopped",
      message: cancellation === "cancelled"
        ? "Claude prompt was cancelled before starting"
        : "Claude driver stopped before the prompt started",
      retryable: cancellation === "stopped",
    },
  };
}

export function claudeTerminalResult(
  value: unknown,
): CommandExecutionResult {
  const result = value && typeof value === "object"
    ? value as Record<string, unknown>
    : {};
  if (result.type !== "result") {
    return {
      status: "unknown",
      error: {
        code: "claude-query-outcome-unknown",
        message: "Claude query ended without a terminal result",
        retryable: false,
      },
    };
  }
  if (result.subtype === "success" && result.is_error !== true) {
    return { status: "succeeded", result: { completed: true } };
  }
  const errors = Array.isArray(result.errors)
    ? result.errors.filter((item): item is string => typeof item === "string")
    : [];
  const subtype = typeof result.subtype === "string"
    ? result.subtype
    : "error_during_execution";
  return {
    status: "failed",
    error: {
      code: `claude-${subtype}`,
      message: errors.join("; ") ||
        (typeof result.terminal_reason === "string"
          ? result.terminal_reason
          : `Claude query ended with ${subtype}`),
      retryable: false,
    },
  };
}

export class ClaudeAgentSdkDriver implements AgentDriver {
  readonly source: SourceDescriptor;
  readonly #config: AgentSourceConfig;
  readonly #sdk: ClaudeSdkAdapter;
  readonly #queryBaseEnvironment: Record<string, string>;
  readonly #activeQueries = new Map<string, ClaudeQuery>();
  readonly #pendingPrompts = new Map<string, PendingClaudePrompt>();
  readonly #sessionCwds = new Map<string, string | null>();
  readonly #sessionModes = new Map<string, string>();
  readonly #sessionModels = new Map<string, string>();
  readonly #desktop: ClaudeDesktopDeps;
  /** Desktop starts sent and not yet paired with a session, by the id the
   * start named. */
  readonly #desktopStarts = new Map<string, DesktopStart>();
  /** Sessions the app made for a desktop start, by their own id. */
  readonly #reconciled = new Map<
    string,
    { startedAs: string; title: string | null }
  >();
  #stopped = false;

  constructor(
    config: AgentSourceConfig,
    sdk: ClaudeSdkAdapter = defaultSdk as unknown as ClaudeSdkAdapter,
    desktop: ClaudeDesktopDeps = defaultDesktopDeps,
  ) {
    this.#config = config;
    this.#sdk = sdk;
    this.#desktop = desktop;
    // Short SDK calls temporarily mutate Deno.env under a global lock. Keep a
    // stable baseline so a concurrent prompt cannot snapshot another source's
    // temporary values into its explicit per-query environment.
    this.#queryBaseEnvironment = Deno.env.toObject();
    this.source = {
      id: normalizeSourceId(config.id),
      driver: config.driver,
      capabilities: {
        inventory: true,
        read: true,
        prompt: true,
        startSession: true,
        cancel: true,
        rename: true,
        setMode: true,
        setConfigOption: true,
        modes: [
          "default",
          "acceptEdits",
          "plan",
          "dontAsk",
          "auto",
          ...(config.allowDangerFullAccess ? ["bypassPermissions"] : []),
        ],
        // The desktop app's link is a macOS entry point.
        surfaces: ["headless", ...(desktop.os === "darwin" ? ["desktop"] : [])],
        configOptions: { model: { type: "string" } },
      },
    };
  }

  start(signal?: AbortSignal): Promise<void> {
    try {
      signal?.throwIfAborted();
      this.#stopped = false;
      return Promise.resolve();
    } catch (error) {
      return Promise.reject(error);
    }
  }

  stop(): Promise<void> {
    this.#stopped = true;
    for (const pending of this.#pendingPrompts.values()) {
      pending.cancellation ??= "stopped";
    }
    this.#pendingPrompts.clear();
    for (const query of this.#activeQueries.values()) query.close();
    this.#activeQueries.clear();
    return Promise.resolve();
  }

  async listSessions(cursor?: string): Promise<SessionPage> {
    const offset = cursor ? Number(cursor) : 0;
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new Error("invalid Claude cursor");
    }
    const activeSessionIds = new Set(this.#activeQueries.keys());
    // A source with a directory lists that project directory's sessions and,
    // when it is inside a Git repository, its worktrees' — never its
    // subdirectories', which the SDK keys as projects of their own. Without
    // one it lists every project on the machine.
    const sessions = await this.#withSourceEnvironment(() =>
      this.#sdk.listSessions({
        limit: PAGE_SIZE,
        offset,
        ...(this.#config.cwd ? { dir: this.#config.cwd } : {}),
      })
    );
    for (const info of sessions) this.#rememberSessionCwd(info);
    this.#reconcileDesktopStarts(sessions);
    return {
      sessions: sessions.map((info) =>
        this.#summaryOf(info, activeSessionIds.has(info.sessionId))
      ),
      nextCursor: sessions.length === PAGE_SIZE
        ? String(offset + PAGE_SIZE)
        : undefined,
    };
  }

  async readSession(nativeSessionId: string): Promise<NativeSessionSnapshot> {
    const connectorQueryActive = this.#activeQueries.has(nativeSessionId);
    const [info, messages] = await this.#withSourceEnvironment(() =>
      Promise.all([
        this.#sdk.getSessionInfo(nativeSessionId),
        this.#sdk.getSessionMessages(nativeSessionId, {
          includeSystemMessages: true,
        }),
      ])
    );
    if (!info) throw new Error(`Claude session not found: ${nativeSessionId}`);
    this.#rememberSessionCwd(info);
    this.#reconcileDesktopStarts([info]);
    return {
      summary: this.#summaryOf(info, connectorQueryActive),
      events: messages.map((message) => asRaw(message)),
      normalizedMessages: messages.map((message, rawIndex) => ({
        id: message.uuid,
        role: message.type === "user" || message.type === "assistant" ||
            message.type === "system"
          ? message.type
          : "unknown",
        kind: message.type,
        createdAt: null,
        textPreview: textFrom(message.message),
        rawIndex,
      })),
      complete: true,
      revision: String(info.lastModified),
    };
  }

  async renameSession(
    nativeSessionId: string,
    title: string,
  ): Promise<CommandExecutionResult> {
    await this.#withSourceEnvironment(() =>
      this.#sdk.renameSession(nativeSessionId, title)
    );
    return { status: "succeeded", result: { title } };
  }

  async prompt(
    nativeSessionId: string,
    input: PromptInput,
    options: CommandExecutionOptions = {},
  ): Promise<CommandExecutionResult> {
    const refusal = this.#refuseQuery(nativeSessionId);
    if (refusal) return refusal;
    const pending: PendingClaudePrompt = { cancellation: null };
    this.#pendingPrompts.set(nativeSessionId, pending);
    try {
      options.onCancellationReady?.();
      let sessionCwd: string | null | undefined;
      try {
        sessionCwd = this.#sessionCwds.has(nativeSessionId)
          ? this.#sessionCwds.get(nativeSessionId)
          : await this.#lookupSessionCwd(nativeSessionId);
      } catch (error) {
        if (pending.cancellation) {
          return pendingPromptCancellation(pending.cancellation);
        }
        return sessionLookupFailure(error);
      }
      if (pending.cancellation) {
        return pendingPromptCancellation(pending.cancellation);
      }
      if (sessionCwd === undefined) {
        return {
          status: "failed",
          error: {
            code: "claude-session-not-found",
            message: `Claude session not found: ${nativeSessionId}`,
            retryable: false,
          },
        };
      }
      const promptCwd = sessionCwd || this.#config.cwd;
      return await this.#runQuery(nativeSessionId, pending, input.text, {
        resume: nativeSessionId,
        ...(promptCwd ? { cwd: promptCwd } : {}),
      }, options);
    } finally {
      if (this.#pendingPrompts.get(nativeSessionId) === pending) {
        this.#pendingPrompts.delete(nativeSessionId);
      }
    }
  }

  async startSession(
    nativeSessionId: string,
    input: StartInput,
    options: CommandExecutionOptions = {},
  ): Promise<CommandExecutionResult> {
    const refusal = this.#refuseQuery(nativeSessionId);
    if (refusal) return refusal;
    if (!CLAUDE_SESSION_ID_PATTERN.test(nativeSessionId)) {
      return {
        status: "failed",
        error: {
          code: "claude-session-id-invalid",
          message: "a new Claude session id must be a UUID",
          retryable: false,
        },
      };
    }
    const modes: string[] = this.source.capabilities.modes ?? [];
    if (input.mode !== undefined && !modes.includes(input.mode)) {
      return unsupported(`unsupported Claude mode: ${input.mode}`);
    }
    // A start runs where its source lists: in the source's own directory when
    // it has one (the SDK lists that project directory, not its
    // subdirectories), otherwise in the directory the start names.
    const sourceCwd = this.#config.cwd;
    const requested = input.cwd === undefined ? undefined : resolve(input.cwd);
    const cwd = sourceCwd ?? requested;
    if (cwd === undefined) {
      return {
        status: "failed",
        error: {
          code: "claude-start-cwd-required",
          message:
            "a new Claude session needs a working directory, and the source configures none",
          retryable: false,
        },
      };
    }
    if (
      sourceCwd !== undefined && requested !== undefined &&
      requested !== resolve(sourceCwd)
    ) {
      return {
        status: "failed",
        error: {
          code: "claude-start-cwd-not-source",
          message:
            `${input.cwd} is not the source directory ${sourceCwd}, which is where a start runs`,
          retryable: false,
        },
      };
    }
    if (input.surface !== undefined && input.surface !== "headless") {
      if (input.surface !== "desktop") {
        return unsupported(`unsupported start surface: ${input.surface}`);
      }
      // Nothing runs in this process for a desktop start, so there is
      // nothing a cancel could reach; readiness is not signalled early.
      return await this.#startOnDesktop(nativeSessionId, input, cwd);
    }
    const pending: PendingClaudePrompt = { cancellation: null };
    this.#pendingPrompts.set(nativeSessionId, pending);
    try {
      options.onCancellationReady?.();
      let existing: ClaudeSessionInfo | undefined;
      try {
        existing = await this.#withSourceEnvironment(() =>
          this.#sdk.getSessionInfo(nativeSessionId)
        );
      } catch (error) {
        if (pending.cancellation) {
          return pendingPromptCancellation(pending.cancellation);
        }
        return sessionLookupFailure(error);
      }
      if (pending.cancellation) {
        return pendingPromptCancellation(pending.cancellation);
      }
      if (existing) {
        return {
          status: "failed",
          error: {
            code: "claude-session-exists",
            message: `Claude session already exists: ${nativeSessionId}`,
            retryable: false,
          },
        };
      }
      const priorMode = this.#sessionModes.get(nativeSessionId);
      if (input.mode !== undefined) {
        this.#sessionModes.set(nativeSessionId, input.mode);
      }
      const outcome = await this.#runQuery(
        nativeSessionId,
        pending,
        input.text,
        {
          sessionId: nativeSessionId,
          cwd,
          // The SDK titles a new session from its first message.
          ...(input.title !== undefined ? { title: input.title } : {}),
        },
        options,
        // The session is on disk once the SDK has emitted a message for it;
        // a refresh before that finds nothing to read.
        { activateAfterFirstMessage: true },
      );
      if (outcome.status !== "succeeded") {
        // A start that did not happen leaves no mode behind for a retry.
        if (input.mode !== undefined) {
          if (priorMode === undefined) {
            this.#sessionModes.delete(nativeSessionId);
          } else {
            this.#sessionModes.set(nativeSessionId, priorMode);
          }
        }
        return outcome;
      }
      this.#sessionCwds.set(nativeSessionId, cwd);
      return {
        status: "succeeded",
        result: { nativeSessionId, cwd, title: input.title ?? null },
      };
    } finally {
      if (this.#pendingPrompts.get(nativeSessionId) === pending) {
        this.#pendingPrompts.delete(nativeSessionId);
      }
    }
  }

  /**
   * A start on the desktop surface: the Claude Code desktop app opens on
   * this Mac with the prompt ready to send in the start's directory, and no
   * turn runs here. The app mints the session's id when the person sends,
   * so the session the start named never exists; the start is remembered
   * and paired with the session the app makes (`#reconcileDesktopStarts`),
   * which then carries `startedAs` and the start's title.
   */
  async #startOnDesktop(
    nativeSessionId: string,
    input: StartInput,
    cwd: string,
  ): Promise<CommandExecutionResult> {
    if (!this.source.capabilities.surfaces?.includes("desktop")) {
      return unsupported("the desktop surface needs macOS");
    }
    if (input.mode !== undefined) {
      return {
        status: "failed",
        error: {
          code: "claude-desktop-mode-unsupported",
          message:
            "a desktop start runs under the app's own permission mode; send no mode",
          retryable: false,
        },
      };
    }
    if (input.text.length > DESKTOP_PROMPT_LIMIT) {
      return {
        status: "failed",
        error: {
          code: "claude-desktop-prompt-too-long",
          message:
            `the app reads at most ${DESKTOP_PROMPT_LIMIT} characters of a prompt; this one has ${input.text.length}`,
          retryable: false,
        },
      };
    }
    if (!await this.#desktop.isDirectory(cwd)) {
      return {
        status: "failed",
        error: {
          code: "claude-desktop-cwd-not-directory",
          message: `${cwd} is not a directory the app can open a session in`,
          retryable: false,
        },
      };
    }
    if (!await this.#desktop.installed()) {
      return {
        status: "failed",
        error: {
          code: "claude-desktop-not-installed",
          message: `Claude Desktop is not installed at ${DESKTOP_APP_PATH}`,
          retryable: true,
        },
      };
    }
    let knownSessionIds: ReadonlySet<string>;
    try {
      knownSessionIds = await this.#withSourceEnvironment(async () => {
        // No limit: the exclusion set covers the entire source inventory.
        const sessions = await this.#sdk.listSessions({
          ...(this.#config.cwd ? { dir: this.#config.cwd } : {}),
        });
        return new Set(sessions.map((info) => info.sessionId));
      });
    } catch (error) {
      return { ...sessionLookupFailure(error), affectedSession: null };
    }
    const refusal = this.#refuseQuery(nativeSessionId);
    if (refusal) return { ...refusal, affectedSession: null };
    // Inventory may run while the opener is pending. Neither the exclusion
    // set nor the creation boundary may move past the session it discovers.
    const start: DesktopStart = {
      text: input.text,
      cwd,
      title: input.title ?? null,
      sentAt: this.#desktop.now(),
      knownSessionIds,
    };
    const url = new URL("claude://code/new");
    url.searchParams.set("folder", cwd);
    url.searchParams.set("q", input.text);
    if (!await this.#desktop.openUrl(url.toString())) {
      return {
        status: "failed",
        error: {
          code: "claude-desktop-open-failed",
          message: "the Claude Desktop app did not open the link",
          retryable: true,
        },
      };
    }
    this.#desktopStarts.set(nativeSessionId, start);
    return {
      status: "succeeded",
      result: {
        nativeSessionId,
        cwd,
        title: input.title ?? null,
        surface: "desktop",
      },
      affectedSession: null,
    };
  }

  /**
   * Pairs a session the app made with the desktop start it was made for:
   * the session is in the start's directory, was not listed before the
   * start was sent, was created after it, and opens with the start's text.
   * When several pending starts fit one session, the newest claims it if
   * they all sent the same text (the person sent the same start again after
   * closing the app's New session UI, or declining its folder, and the
   * workbench may have withdrawn the earlier record); starts that sent
   * different texts sharing the prefix the SDK lists leave the session
   * unpaired rather than guess. A pairing made here reaches the published
   * row, which keeps it afterwards; only a start the person has not sent
   * yet is forgotten when the host restarts.
   */
  #reconcileDesktopStarts(sessions: ClaudeSessionInfo[]): void {
    if (this.#desktopStarts.size === 0) return;
    const now = this.#desktop.now();
    for (const [startedAs, start] of this.#desktopStarts) {
      if (now - start.sentAt > DESKTOP_START_WINDOW_MS) {
        this.#desktopStarts.delete(startedAs);
      }
    }
    for (const info of sessions) {
      if (this.#reconciled.has(info.sessionId)) continue;
      const fitting = [...this.#desktopStarts].filter(([, start]) =>
        desktopStartMatches(start, info)
      );
      if (fitting.length === 0) continue;
      const [, first] = fitting[0];
      if (fitting.some(([, start]) => start.text !== first.text)) continue;
      const [startedAs, start] = fitting.reduce((newest, candidate) =>
        candidate[1].sentAt > newest[1].sentAt ? candidate : newest
      );
      this.#reconciled.set(info.sessionId, {
        startedAs,
        title: start.title,
      });
      this.#desktopStarts.delete(startedAs);
    }
  }

  /** The summary of a listed session, carrying the start it was made for
   * and that start's title unless the person has titled it since. */
  #summaryOf(info: ClaudeSessionInfo, active: boolean): SessionSummary {
    const summary = summaryFrom(info, active);
    const paired = this.#reconciled.get(info.sessionId);
    if (!paired) return summary;
    return {
      ...summary,
      startedAs: paired.startedAs,
      ...(paired.title !== null && !info.customTitle
        ? { title: paired.title }
        : {}),
    };
  }

  #refuseQuery(nativeSessionId: string): CommandExecutionResult | undefined {
    if (this.#stopped) {
      return {
        status: "failed",
        error: {
          code: "claude-driver-stopped",
          message: "Claude driver is stopped",
          retryable: true,
        },
      };
    }
    if (
      this.#activeQueries.has(nativeSessionId) ||
      this.#pendingPrompts.has(nativeSessionId)
    ) {
      return {
        status: "needs-confirmation",
        error: {
          code: "already-active",
          message: "session already has a pending or active connector query",
          retryable: true,
        },
      };
    }
    return undefined;
  }

  /**
   * Runs one SDK query for `nativeSessionId`, tracking it so `cancel()` can
   * interrupt it, and returns its terminal outcome. `sessionOptions` says
   * whether the query resumes a session or starts one.
   */
  async #runQuery(
    nativeSessionId: string,
    pending: PendingClaudePrompt,
    prompt: string,
    sessionOptions: Record<string, unknown>,
    options: CommandExecutionOptions,
    { activateAfterFirstMessage = false } = {},
  ): Promise<CommandExecutionResult> {
    // query() accepts an explicit environment. Do not use
    // #withSourceEnvironment here: its module-global queue is only for short
    // SDK methods that lack an env option, and holding it across a full turn
    // would block every Claude source behind one in-flight prompt.
    //
    // The query is constructed inside the failure path: an SDK that throws
    // while constructing one has failed the query as surely as one that
    // throws while running it, and the caller sees one outcome for both.
    let query: ReturnType<ClaudeSdkAdapter["query"]> | undefined;
    let lastMessage: unknown;
    let activated = false;
    try {
      query = this.#sdk.query({
        prompt,
        options: {
          ...sessionOptions,
          ...(this.#sessionModes.has(nativeSessionId)
            ? { permissionMode: this.#sessionModes.get(nativeSessionId) }
            : {}),
          ...(this.#sessionModels.has(nativeSessionId)
            ? { model: this.#sessionModels.get(nativeSessionId) }
            : {}),
          ...(this.#sessionModes.get(nativeSessionId) === "bypassPermissions"
            ? { allowDangerouslySkipPermissions: true }
            : {}),
          env: {
            ...this.#queryBaseEnvironment,
            ...this.#config.env,
            ...(this.#config.configDir
              ? { CLAUDE_CONFIG_DIR: this.#config.configDir }
              : {}),
          },
        },
      });
      this.#activeQueries.set(nativeSessionId, query);
      if (this.#pendingPrompts.get(nativeSessionId) === pending) {
        this.#pendingPrompts.delete(nativeSessionId);
      }
      if (!activateAfterFirstMessage) {
        activated = true;
        await options.onSessionActive?.();
      }
      for await (const message of query) {
        lastMessage = message;
        if (!activated) {
          activated = true;
          await options.onSessionActive?.();
        }
      }
      return claudeTerminalResult(lastMessage);
    } catch (error) {
      return {
        status: "failed",
        error: {
          code: "claude-query-failed",
          message: String(error),
          retryable: false,
        },
      };
    } finally {
      if (query !== undefined) {
        if (this.#activeQueries.get(nativeSessionId) === query) {
          this.#activeQueries.delete(nativeSessionId);
        }
        query.close();
      }
      if (this.#pendingPrompts.get(nativeSessionId) === pending) {
        this.#pendingPrompts.delete(nativeSessionId);
      }
    }
  }

  #withSourceEnvironment<T>(operation: () => Promise<T>): Promise<T> {
    return claudeSourceEnvironment.run(async () => {
      const sourceEnv = {
        ...this.#config.env,
        ...(this.#config.configDir
          ? { CLAUDE_CONFIG_DIR: this.#config.configDir }
          : {}),
      };
      const previous = new Map<string, string | undefined>();
      for (const [key, value] of Object.entries(sourceEnv)) {
        previous.set(key, Deno.env.get(key));
        Deno.env.set(key, value);
      }
      try {
        return await operation();
      } finally {
        for (const [key, value] of previous) {
          if (value === undefined) Deno.env.delete(key);
          else Deno.env.set(key, value);
        }
      }
    });
  }

  async #lookupSessionCwd(
    nativeSessionId: string,
  ): Promise<string | null | undefined> {
    const info = await this.#withSourceEnvironment(() =>
      this.#sdk.getSessionInfo(nativeSessionId)
    );
    if (!info) return undefined;
    this.#rememberSessionCwd(info);
    return this.#sessionCwds.get(nativeSessionId);
  }

  #rememberSessionCwd(info: ClaudeSessionInfo): void {
    this.#sessionCwds.set(info.sessionId, info.cwd || null);
  }

  async cancel(nativeSessionId: string): Promise<CommandExecutionResult> {
    const pending = this.#pendingPrompts.get(nativeSessionId);
    if (pending) {
      pending.cancellation = "cancelled";
      return { status: "succeeded" };
    }
    const query = this.#activeQueries.get(nativeSessionId);
    if (!query) {
      return unsupported(
        "Claude cancel is available only for a connector-owned query",
      );
    }
    await query.interrupt();
    return { status: "succeeded" };
  }

  async setMode(
    nativeSessionId: string,
    mode: string,
  ): Promise<CommandExecutionResult> {
    const modes: string[] = this.source.capabilities.modes ?? [];
    if (!modes.includes(mode)) {
      return unsupported(`unsupported Claude mode: ${mode}`);
    }
    this.#sessionModes.set(nativeSessionId, mode);
    const query = this.#activeQueries.get(nativeSessionId);
    if (query) {
      await query.setPermissionMode(
        mode as Parameters<ClaudeQuery["setPermissionMode"]>[0],
      );
    }
    return {
      status: "succeeded",
      result: { mode, appliesTo: "connector-prompts" },
    };
  }

  async setConfigOption(
    nativeSessionId: string,
    key: string,
    value: unknown,
  ): Promise<CommandExecutionResult> {
    if (key !== "model" || typeof value !== "string") {
      return unsupported(`unsupported Claude config option: ${key}`);
    }
    this.#sessionModels.set(nativeSessionId, value);
    const query = this.#activeQueries.get(nativeSessionId);
    if (query) await query.setModel(value);
    return {
      status: "succeeded",
      result: { key, value, appliesTo: "connector-prompts" },
    };
  }
}
