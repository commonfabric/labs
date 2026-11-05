import type {
  SessionSortColumn,
  SessionSortDirection,
} from "./presentation.ts";

// deno-lint-ignore no-control-regex
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;

export type AgentCommandType =
  | "prompt"
  | "start"
  | "cancel"
  | "rename"
  | "set-mode"
  | "set-config-option";

export interface CommandDraftFields {
  sourceId: string;
  nativeSessionId: string;
  type: AgentCommandType;
  promptText: string;
  argument: string;
  configKey: string;
  configValue: string;
  configValueType: "string" | "true" | "false";
}

export function commandDraftError(fields: CommandDraftFields): string {
  const sourceId = fields.sourceId.trim();
  const nativeSessionId = fields.nativeSessionId.trim();
  if (!sourceId) return "Choose a source.";
  if (sourceId.length > 256) return "Source IDs are limited to 256 characters.";
  if (CONTROL_CHARACTER.test(sourceId)) {
    return "Source IDs cannot contain control characters.";
  }
  if (!nativeSessionId) return "Choose or enter a session ID.";
  if (nativeSessionId.length > 1_024) {
    return "Session IDs are limited to 1,024 characters.";
  }
  if (CONTROL_CHARACTER.test(nativeSessionId)) {
    return "Session IDs cannot contain control characters.";
  }
  if (fields.type === "prompt" || fields.type === "start") {
    if (!fields.promptText.trim()) return "Enter a prompt.";
    if (fields.promptText.length > 128 * 1_024) {
      return "Prompts are limited to 128 KiB.";
    }
  }
  if (fields.type === "rename") {
    if (!fields.argument.trim()) return "Enter a new title.";
    if (fields.argument.length > 512) {
      return "Titles are limited to 512 characters.";
    }
  }
  if (fields.type === "set-mode") {
    if (!fields.argument.trim()) return "Enter a mode ID.";
    if (fields.argument.length > 128) {
      return "Mode IDs are limited to 128 characters.";
    }
  }
  if (fields.type === "set-config-option") {
    if (!fields.configKey.trim()) return "Enter a configuration option key.";
    if (fields.configKey.length > 256) {
      return "Configuration option keys are limited to 256 characters.";
    }
  }
  return "";
}

export function commandPayload(
  fields: CommandDraftFields,
): Record<string, unknown> {
  switch (fields.type) {
    case "prompt":
    case "start":
      return { text: fields.promptText.trim() };
    case "cancel":
      return {};
    case "rename":
      return { title: fields.argument.trim() };
    case "set-mode":
      return { mode: fields.argument.trim() };
    case "set-config-option":
      return {
        key: fields.configKey.trim(),
        value: fields.configValueType === "string"
          ? fields.configValue
          : fields.configValueType === "true",
      };
  }
}

export function providerSessionRetrieval(
  driver: string | null,
  sourceId: string,
  nativeSessionId: string,
): string {
  const identity = JSON.stringify(nativeSessionId);
  if (driver === null) {
    return "This page reads the producing driver from the session manifest " +
      "as part of the raw-data load. After that load completes, this section " +
      "shows the exact provider operation.";
  }
  const prefix =
    `The session manifest records connector source ${
      JSON.stringify(sourceId)
    } and producing driver ${JSON.stringify(driver)}. Use the same provider ` +
    "account, environment, executable, and working-directory settings as that " +
    "source. ";
  switch (driver) {
    case "codex-app-server":
      return prefix +
        "Connect to the configured Codex app server. Send the JSON-RPC method " +
        `"thread/read" with params {"threadId":${identity},` +
        '"includeTurns":true}. The returned thread object supplies the ' +
        "provider metadata. Its turns array supplies the native events.";
    case "claude-agent-sdk":
      return prefix +
        `Call getSessionInfo(${identity}) and ` +
        `getSessionMessages(${identity}, {"includeSystemMessages":true}) ` +
        "through the Claude Agent SDK. The session info supplies the provider " +
        "metadata. The messages supply the native events.";
    case "acp":
      return prefix +
        "Call session/list until the matching session ID is found. Keep its " +
        "cwd and additionalDirectories. Call session/load with that sessionId, " +
        "cwd, additionalDirectories, and an empty mcpServers array. Capture the " +
        "session/update notifications emitted while the load is active.";
    default:
      return prefix +
        "Invoke that driver's listSessions and readSession APIs with this " +
        `native session ID: ${identity}.`;
  }
}

export function statusColor(
  value: string | undefined,
): "neutral" | "primary" | "accent" | "danger" {
  switch (value) {
    case "ready":
    case "complete":
    case "succeeded":
    case "active":
      return "accent";
    case "starting":
    case "syncing":
    case "collecting":
    case "running":
    case "in-flight":
      return "primary";
    case "degraded":
    case "partial":
    case "stale":
    case "unknown":
      return "neutral";
    case "failed":
    case "deleted":
      return "danger";
    default:
      return "neutral";
  }
}

export function sessionSortLabel(
  label: string,
  column: SessionSortColumn,
  currentColumn: SessionSortColumn | null,
  direction: SessionSortDirection,
): string {
  if (column !== currentColumn) return `${label} ↕`;
  return `${label} ${direction === "ascending" ? "↑" : "↓"}`;
}

interface ReadableCellValue {
  get(): unknown;
  getAsNormalizedFullLink?(): {
    id: string;
    space: string;
    path: Array<string | number>;
    scope?: string;
  };
}

function isReadableCell(value: unknown): value is ReadableCellValue {
  return typeof value === "object" && value !== null && "get" in value &&
    typeof value.get === "function";
}

export function linkedCellJson(value: unknown): unknown {
  if (isReadableCell(value)) {
    const link = value.getAsNormalizedFullLink?.();
    return link === undefined ? { $cell: "unresolved" } : {
      $cell: {
        id: link.id,
        space: link.space,
        path: link.path,
        ...(link.scope === undefined ? {} : { scope: link.scope }),
      },
    };
  }
  if (Array.isArray(value)) return value.map(linkedCellJson);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, linkedCellJson(child)]),
  );
}

export function materializeRootCell(value: unknown): unknown {
  const root = isReadableCell(value) ? value.get() : value;
  return linkedCellJson(root);
}
