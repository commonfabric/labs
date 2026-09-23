export type DriverKind =
  | "claude-agent-sdk"
  | "codex-app-server"
  | "acp";

export type CodexAppServerTransport = "stdio" | "managed" | "proxy";

export interface AgentSourceConfig {
  id: string;
  driver: DriverKind;
  enabled: boolean;
  command?: string[];
  configDir?: string;
  codexBin?: string;
  codexHome?: string;
  codexTransport?: CodexAppServerTransport;
  codexSocket?: string;
  cwd?: string;
  env?: Record<string, string>;
  allowDangerFullAccess?: boolean;
}

export interface DriverCapabilities {
  inventory: boolean;
  read: boolean;
  prompt: boolean;
  /** Present and true for a driver that can start a new session; absent
   * otherwise. */
  startSession?: boolean;
  cancel: boolean;
  rename: boolean;
  setMode: boolean;
  setConfigOption: boolean;
  modes?: string[];
  /** Where a started session can run, for a driver that can start one:
   * `headless` runs the first prompt in this process; `desktop` opens the
   * Claude Code desktop app on this Mac with the prompt ready to send.
   * Absent means headless only. */
  surfaces?: string[];
  configOptions?: Record<string, unknown>;
}

export interface SourceDescriptor {
  /** Trimmed, lowercase source identity used by commands and by the records
   * stored in the fabric. */
  id: string;

  driver: DriverKind;
  version?: string;
  capabilities: DriverCapabilities;
}

export interface SessionSummary {
  nativeSessionId: string;
  title: string | null;
  cwd: string | null;
  gitRepo?: string | null;
  gitBranch?: string | null;
  gitWorktreeRoot?: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  archived: boolean | null;
  active: boolean | null;
  /** The id a `start` command named, for a session that start produced
   * under another id (a desktop start, whose session the app minted); the
   * workbench that sent the start confirms it through this. */
  startedAs?: string;
  raw: Record<string, unknown>;
}

export interface SessionPage {
  sessions: SessionSummary[];
  nextCursor?: string;
}

export interface NormalizedMessage {
  id: string;
  parentId?: string;
  role: "user" | "assistant" | "system" | "tool" | "unknown";
  kind: string;
  createdAt: string | null;
  textPreview: string | null;
  rawIndex: number;
}

export interface NativeSessionSnapshot {
  summary: SessionSummary;
  events: unknown[];
  normalizedMessages: NormalizedMessage[];
  complete: boolean;
  revision?: string;
}

export interface PromptInput {
  text: string;
}

export interface StartInput {
  /** The first prompt of the new session. */
  text: string;
  /**
   * Working directory the session runs in. When absent, the source's
   * configured `cwd` is used.
   */
  cwd?: string;
  /** Title given to the session once it exists. */
  title?: string;
  /** A mode the driver advertises, applied to the session's first turn. */
  mode?: string;
  /**
   * Where the session runs. `headless` (the default) runs the first prompt
   * in this process. `desktop` opens the Claude Code desktop app on this
   * Mac with the prompt ready to send, so the session exists only once the
   * person sends it, under an id the app mints; the driver pairs that
   * session with the start afterwards (`SessionSummary.startedAs`). A driver
   * advertises the surfaces it offers in `capabilities.surfaces`.
   */
  surface?: string;
}

export interface CommandExecutionOptions {
  force?: boolean;
  onCancellationReady?: () => void;
  onSessionActive?: () => Promise<void>;
}

export interface CommandExecutionResult {
  status:
    | "succeeded"
    | "failed"
    | "unsupported"
    | "needs-confirmation"
    | "unknown";
  providerOperationId?: string;
  result?: Record<string, unknown>;
  error?: { code: string; message: string; retryable: boolean };
  /**
   * The session the worker refreshes once the command is done: absent means
   * the command's own; `null` means none yet, as after a desktop start,
   * whose session the person has yet to create.
   */
  affectedSession?: string | null;
}

export interface AgentDriver {
  readonly source: SourceDescriptor;
  start(signal?: AbortSignal): Promise<void>;
  stop(): Promise<void>;
  listSessions(cursor?: string): Promise<SessionPage>;
  readSession(nativeSessionId: string): Promise<NativeSessionSnapshot>;
  prompt(
    nativeSessionId: string,
    input: PromptInput,
    options?: CommandExecutionOptions,
  ): Promise<CommandExecutionResult>;
  /**
   * Starts a new session whose provider identity is `nativeSessionId`, chosen
   * by the caller. A headless start (the default surface) runs `input.text`
   * as the session's first prompt here. A start on the `desktop` surface
   * opens the Claude Code desktop app with `input.text` ready to send and
   * runs nothing: the session exists once the person sends it, under an id
   * the app mints, and the driver pairs it with this start afterwards
   * (`SessionSummary.startedAs`), answering with `affectedSession: null`.
   */
  startSession(
    nativeSessionId: string,
    input: StartInput,
    options?: CommandExecutionOptions,
  ): Promise<CommandExecutionResult>;
  cancel(nativeSessionId: string): Promise<CommandExecutionResult>;
  renameSession(
    nativeSessionId: string,
    title: string,
  ): Promise<CommandExecutionResult>;
  setMode(
    nativeSessionId: string,
    mode: string,
  ): Promise<CommandExecutionResult>;
  setConfigOption(
    nativeSessionId: string,
    key: string,
    value: unknown,
  ): Promise<CommandExecutionResult>;
}
