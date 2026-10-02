/**
 * The typed mid-session command contract between a console session and the
 * person's Weaver: what the model asks the Weaver to run, how the Weaver
 * settles that request, and what the command answered. It rides the session's
 * chat event log — a `client_action_requested` event carrying one of the typed
 * actions below, answered on the client-action settlement route — beside the
 * final-action vocabulary in `client-action.ts`, which `finish_task` keeps.
 *
 * Two facts stay separate. A settlement says what became of the request
 * (executed, declined, failed to deliver, interrupted); a command outcome says
 * what the command answered when it executed. A refusal, a partial write, or a
 * version conflict is an executed command whose outcome says so, never a
 * broken channel.
 *
 * Attribution is carried, not inferred. A command the Weaver runs without the
 * person (a reviewed read) runs as the agent; a command the person approves
 * with a tap runs as the user, because the tap is the person's own act. The
 * invocation names the approval the console asks for and the settlement names
 * the approval and actor the Weaver applied, so the executor and the service
 * behind it receive the distinction rather than guess it.
 *
 * The shapes are pinned against the JSON files under
 * `test/fixtures/client-command-wire/`, which the Weaver's Swift readers
 * decode too.
 */

import type { JSONObject, JSONValue } from "@commonfabric/api";
import { isObjectNotArray } from "@commonfabric/utils/types";
import {
  HANDLE_TOKEN_ALPHABET,
  MIN_HANDLE_TOKEN_SUFFIX_LENGTH,
  REFERENT_HANDLE_TOKEN_PREFIX,
} from "./handle-table.ts";

/**
 * Version of the client protocol a host declares on `POST /api/task` and on
 * the stdio `start_session`/`start_turn` params. A declaration naming another
 * version is refused before any session or turn starts.
 */
export const HARNESS_CLIENT_PROTOCOL_VERSION = 1 as const;

/**
 * Features a host may require. `client_actions` is the final-action
 * vocabulary offered mid-turn through `weaver_action`; `typed_commands` is the
 * typed invocation, catalog, and settlement defined in this file.
 */
export const HARNESS_CLIENT_FEATURES = [
  "client_actions",
  "typed_commands",
] as const;

/** One feature a host may require. */
export type HarnessClientFeature = typeof HARNESS_CLIENT_FEATURES[number];

/**
 * The features this console serves. A host requiring any other is refused
 * before work starts.
 */
export const HARNESS_SUPPORTED_CLIENT_FEATURES:
  readonly HarnessClientFeature[] = ["client_actions"];

/**
 * The features a console that answers without a protocol echo is taken to
 * serve. A host that requires anything beyond these, and starts a task on a
 * console whose answer carries no `protocol`, treats the console as unable to
 * serve it.
 */
export const HARNESS_CLIENT_BASELINE_FEATURES: readonly HarnessClientFeature[] =
  ["client_actions"];

/** Most features one declaration may list. */
export const HARNESS_CLIENT_PROTOCOL_REQUIRES_LIMIT = 16;

/** Longest feature name a declaration may list. */
export const HARNESS_CLIENT_FEATURE_MAX_LENGTH = 64;

/** What a host declares: the protocol it speaks and what it needs served. */
export interface HarnessClientProtocolDeclaration {
  protocolVersion: number;
  requires: string[];
}

/** What the console echoes on an accepted task, and publishes on status. */
export interface HarnessClientProtocolEcho {
  protocolVersion: typeof HARNESS_CLIENT_PROTOCOL_VERSION;
  features: HarnessClientFeature[];
}

/**
 * The refusal a mismatched declaration earns. Over HTTP it is the 409 body,
 * with `error` carrying `message`; over stdio it is the error's `details`.
 */
export interface HarnessClientProtocolMismatch {
  code: "protocol_mismatch";
  message: string;
  protocol: HarnessClientProtocolEcho;
  requestedVersion: number;
  missing: string[];
}

/** The console's own protocol echo. */
export const harnessClientProtocolEcho = (): HarnessClientProtocolEcho => ({
  protocolVersion: HARNESS_CLIENT_PROTOCOL_VERSION,
  features: [...HARNESS_SUPPORTED_CLIENT_FEATURES],
});

/**
 * Reads a protocol declaration, or undefined when it is not an object holding
 * exactly an integer `protocolVersion` and a bounded list of feature names.
 * An unknown feature name is well-formed here and missing at the check.
 */
export const readHarnessClientProtocolDeclaration = (
  value: unknown,
): HarnessClientProtocolDeclaration | undefined => {
  if (!isObjectNotArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (!hasExactlyKeys(record, ["protocolVersion", "requires"])) {
    return undefined;
  }
  const { protocolVersion, requires } = record;
  if (!Number.isSafeInteger(protocolVersion)) return undefined;
  if (
    !Array.isArray(requires) ||
    requires.length > HARNESS_CLIENT_PROTOCOL_REQUIRES_LIMIT ||
    !requires.every((name) =>
      typeof name === "string" && name.length > 0 &&
      name.length <= HARNESS_CLIENT_FEATURE_MAX_LENGTH
    )
  ) {
    return undefined;
  }
  return {
    protocolVersion: protocolVersion as number,
    requires: [...requires as string[]],
  };
};

/**
 * Checks a declaration against what this console serves: the version must be
 * this one and every required feature served. Missing features are listed in
 * the order the host named them.
 */
export const checkHarnessClientProtocol = (
  declaration: HarnessClientProtocolDeclaration,
  supported: readonly string[] = HARNESS_SUPPORTED_CLIENT_FEATURES,
):
  | { ok: true; protocol: HarnessClientProtocolEcho }
  | { ok: false; mismatch: HarnessClientProtocolMismatch } => {
  const protocol: HarnessClientProtocolEcho = {
    protocolVersion: HARNESS_CLIENT_PROTOCOL_VERSION,
    features: HARNESS_CLIENT_FEATURES.filter((name) =>
      supported.includes(name)
    ),
  };
  const missing = declaration.requires.filter((name) =>
    !supported.includes(name)
  );
  if (
    declaration.protocolVersion === HARNESS_CLIENT_PROTOCOL_VERSION &&
    missing.length === 0
  ) {
    return { ok: true, protocol };
  }
  const message =
    declaration.protocolVersion !== HARNESS_CLIENT_PROTOCOL_VERSION
      ? `this console speaks client protocol ${HARNESS_CLIENT_PROTOCOL_VERSION}, not ${declaration.protocolVersion}`
      : `this console does not serve ${missing.join(", ")}`;
  return {
    ok: false,
    mismatch: {
      code: "protocol_mismatch",
      message,
      protocol,
      requestedVersion: declaration.protocolVersion,
      missing,
    },
  };
};

/** Longest command id an invocation or catalog entry may carry. */
export const HARNESS_COMMAND_ID_MAX_LENGTH = 128;

/**
 * A command id as the Weaver's catalog names it: dot-separated lowercase
 * words, digits and inner hyphens (`loom.inspect`, `page.write`).
 */
export const HARNESS_COMMAND_ID_PATTERN =
  /^[a-z][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)*$/;

/**
 * Largest invocation `args`, as UTF-8 bytes of their JSON text. A larger
 * request is refused before it is delivered, so nothing executes.
 */
export const HARNESS_COMMAND_ARGS_MAX_BYTES = 16 * 1024;

/**
 * Largest command response body an outcome retains, as UTF-8 bytes of the
 * JSON text the executor answered. A larger body is omitted and its size
 * kept; the outcome's summary fields still say whether the command happened.
 */
export const HARNESS_COMMAND_BODY_MAX_BYTES = 256 * 1024;

/** Longest human receipt a settlement may carry. */
export const HARNESS_COMMAND_RECEIPT_MAX_LENGTH = 2000;

/**
 * Longest text an outcome summary field (`error`, `echo`, `partialEcho`) or a
 * settlement reason may carry.
 */
export const HARNESS_COMMAND_TEXT_MAX_LENGTH = 2000;

/** Most entries an outcome summary list (`completed`, `displaced`) may hold. */
export const HARNESS_COMMAND_LIST_LIMIT = 256;

/** Largest `outputs` summary, as UTF-8 bytes of its JSON text. */
export const HARNESS_COMMAND_OUTPUTS_MAX_BYTES = 8 * 1024;

/** Most entries one catalog may hold. */
export const HARNESS_COMMAND_CATALOG_LIMIT = 256;

/** Most command ids one catalog request may ask full descriptions for. */
export const HARNESS_COMMAND_CATALOG_DETAIL_LIMIT = 16;

/** Longest one-line summary a catalog entry may carry. */
export const HARNESS_COMMAND_SUMMARY_MAX_LENGTH = 500;

/** Longest full description a catalog entry may carry. */
export const HARNESS_COMMAND_DESCRIPTION_MAX_LENGTH = 8000;

/** Largest input schema a catalog entry may carry, as UTF-8 JSON bytes. */
export const HARNESS_COMMAND_SCHEMA_MAX_BYTES = 16 * 1024;

/**
 * Who must approve a command before it runs. `automatic` runs without the
 * person, and only for a command on the Weaver's reviewed read-only list;
 * `person` waits for the person's tap.
 */
export type HarnessCommandApproval = "automatic" | "person";

/**
 * Who a command runs as. `agent` for an automatic read; `user` for a command
 * the person approved.
 */
export type HarnessCommandActor = "agent" | "user";

/** The actor each approval runs as. */
export const harnessCommandActorFor = (
  approval: HarnessCommandApproval,
): HarnessCommandActor => approval === "automatic" ? "agent" : "user";

/**
 * The approval a command actually gets: `automatic` only when the invocation
 * asked for it and the Weaver's reviewed list admits the command. Either side
 * asking for the person's tap gets it.
 */
export const effectiveHarnessCommandApproval = (
  requested: HarnessCommandApproval,
  admittedAutomatic: boolean,
): HarnessCommandApproval =>
  requested === "automatic" && admittedAutomatic ? "automatic" : "person";

/**
 * The loom a command acts on, named explicitly. `expectedVersion` is the
 * version precondition the executor passes on; a stale one is answered as a
 * version conflict, never retried as a fresh write.
 */
export interface HarnessCommandTarget {
  loomId: string;
  expectedVersion?: number;
}

/** One command the model asks the Weaver to run. */
export interface HarnessCommandInvocation {
  /** The Weaver catalog's command id. */
  command: string;

  /** The command's arguments, as its catalog input schema describes them. */
  args: JSONObject;

  /** The loom it acts on; absent for a command that acts on none. */
  target?: HarnessCommandTarget;

  /**
   * The approval the console asks for, copied from the command's catalog
   * entry. The Weaver may only make it stricter.
   */
  approval: HarnessCommandApproval;
}

/** What a catalog request asks for. */
export interface HarnessCommandCatalogRequest {
  /** Command ids whose full description the answer should carry. */
  detail?: string[];
}

/**
 * A typed mid-session action, carried on `client_action_requested` beside
 * the final-action kinds. A Weaver that does not read these answers them
 * `failed` as unreadable rather than half-obeying them.
 */
export type HarnessTypedClientAction =
  | { kind: "invoke_command"; invocation: HarnessCommandInvocation }
  | { kind: "list_commands"; request: HarnessCommandCatalogRequest };

/**
 * Where a command executes: in the Weaver itself (listing or opening looms
 * from what the Weaver holds), or forwarded to the service's command executor.
 */
export type HarnessCommandExecutor = "weaver" | "loom";

/** Whether a command only reads, or changes something. */
export type HarnessCommandEffect = "read" | "mutation";

/** One command the Weaver can execute, as its catalog describes it. */
export interface HarnessCommandCatalogEntry {
  command: string;

  /** One line saying what it does. */
  summary: string;

  /** `loom` when it acts on a target loom, `global` when on none. */
  scope: "loom" | "global";

  /** Where it executes. */
  executes: HarnessCommandExecutor;

  /** What it does to the person's world. */
  effect: HarnessCommandEffect;

  /**
   * The approval it runs under: `automatic` only for a read on the Weaver's
   * reviewed list, `person` for everything else.
   */
  approval: HarnessCommandApproval;

  /** JSON schema of its `args`. */
  inputSchema: JSONObject;

  /** The full description, present when the request asked for it. */
  description?: string;
}

/** The Weaver's answer to a catalog request. */
export interface HarnessCommandCatalog {
  entries: HarnessCommandCatalogEntry[];
}

/**
 * What the command answered, as the executor's structured response. The
 * summary fields are lifted out of `body` so they survive a body too large to
 * retain: `ok`, `code`, `completed` and `mayHaveLanded` say whether the
 * command happened even when `bodyOmitted` is set. Everything else the
 * executor answered (`result`, `receipt`, `missing`, `candidates`, and fields
 * this contract does not name) is read from `body`.
 */
export interface HarnessCommandOutcome {
  /** Which executor answered. */
  executor: HarnessCommandExecutor;

  /**
   * HTTP status the service's executor answered with. Present exactly when
   * `executor` is `loom`; a command the Weaver ran itself has no transport.
   */
  transportStatus?: number;

  ok: boolean;

  /** The executor's canonical id for the command it ran. */
  id?: string;

  /** The refusal or failure code, when `ok` is false. */
  code?: string;

  /** The refusal or failure text: the executor's `error`, `reason` or `message`. */
  error?: string;

  /** The canonical one-line echo of what ran. */
  echo?: string;

  /** The command declares itself quiet: it reads and changes nothing. */
  quiet?: boolean;

  /** The command's declared outputs (`loom_id`, `version`, …). */
  outputs?: JSONObject;

  /** Operation ids that landed before a failure: a partial write. */
  completed?: string[];

  /** Components a write pushed off the stage. */
  displaced?: JSONValue[];

  /** The echo of what partially landed. */
  partialEcho?: string;

  /** The executor cannot rule out that the command took effect. */
  mayHaveLanded?: boolean;

  /** UTF-8 bytes of the JSON body the executor answered. */
  bodyBytes: number;

  /** The complete JSON body, absent when it exceeded the body limit. */
  body?: JSONObject;

  /** Set when `body` was omitted for its size. */
  bodyOmitted?: true;
}

/**
 * Who ran a command and where, as the Weaver applied it. `loomActor` is the
 * actor string the executor received: `user` for the person's approval, or
 * `agent:<slug>` for an automatic read.
 */
export interface HarnessCommandAttribution {
  approval: HarnessCommandApproval;
  actor: HarnessCommandActor;
  loomActor: string;

  /** Base URL of the service the run was pinned to. */
  service: string;

  /** The loom the session was asked from, when there was one. */
  originLoomId?: string;
}

/** Why the console settled a request without the Weaver's answer. */
export type HarnessCommandInterruption = "canceled" | "timeout" | "restart";

/**
 * How a typed request settled. `executed` carries the command's outcome or
 * the catalog; `declined` is the person's refusal; `failed_to_deliver` says
 * the command never produced an answer, and whether it may still have landed;
 * `interrupted` is the console's own settlement of a request nobody answered.
 */
export type HarnessCommandSettlement =
  | {
    status: "executed";
    attribution: HarnessCommandAttribution;
    outcome: HarnessCommandOutcome;

    /** The human receipt derived from the outcome. */
    receipt?: string;
  }
  | { status: "executed"; catalog: HarnessCommandCatalog }
  | {
    status: "declined";
    attribution: HarnessCommandAttribution;
    reason?: string;
  }
  | {
    status: "failed_to_deliver";
    reason: string;

    /** `no` when nothing was sent; `unknown` when the answer was lost. */
    landed: "no" | "unknown";

    /** Present whenever the command was sent. */
    attribution?: HarnessCommandAttribution;
  }
  | { status: "interrupted"; reason: HarnessCommandInterruption };

/** The statuses a host may post; `interrupted` is the console's alone. */
export type HarnessCommandHostSettlement = Exclude<
  HarnessCommandSettlement,
  { status: "interrupted" }
>;

/**
 * The body of `POST /api/client-actions` (and the stdio
 * `resolve_client_action` params) settling a typed request.
 */
export interface HarnessCommandResolveBody {
  sessionId: string;
  actionId: string;
  settlement: HarnessCommandHostSettlement;
}

/**
 * What a `client_action_resolved` event records of a typed settlement: its
 * status, attribution and outcome metadata, and the handle the result is held
 * under, never the result data itself.
 */
export type HarnessCommandSettlementRecord =
  | {
    status: "executed";
    attribution: HarnessCommandAttribution;
    outcome: HarnessCommandOutcomeRecord;
    receipt?: string;

    /** The `cfh:v:` token the outcome is held under in the session. */
    handle?: string;
  }
  | { status: "executed"; catalogEntries: number }
  | Extract<
    HarnessCommandSettlement,
    { status: "declined" | "failed_to_deliver" | "interrupted" }
  >;

/** An outcome's metadata, without the data it answered. */
export type HarnessCommandOutcomeRecord = Pick<
  HarnessCommandOutcome,
  | "executor"
  | "transportStatus"
  | "ok"
  | "id"
  | "code"
  | "error"
  | "mayHaveLanded"
  | "bodyBytes"
  | "bodyOmitted"
>;

/**
 * Provenance of a command result held as a `document` referent with label
 * source `command`: which command produced it, as whom, and against which
 * loom and version.
 */
export interface HarnessCommandResultProvenance {
  command: string;
  actor: HarnessCommandActor;

  /** The loom the command acted on, when it named one. */
  loomId?: string;

  /** The loom version the command answered with, when it reported one. */
  version?: number;

  /** The loom the session was asked from, when there was one. */
  originLoomId?: string;
}

/** Own key read, ignoring anything inherited. */
const own = (record: Record<string, unknown>, key: string): unknown =>
  Object.hasOwn(record, key) ? record[key] : undefined;

/** Whether a record holds exactly the named own keys. */
const hasExactlyKeys = (
  record: Record<string, unknown>,
  keys: readonly string[],
): boolean => {
  const owned = Object.keys(record);
  return owned.length === keys.length &&
    keys.every((key) => Object.hasOwn(record, key));
};

/** Whether every own key of a record is one of `allowed`. */
const hasOnlyKeys = (
  record: Record<string, unknown>,
  allowed: readonly string[],
): boolean => Object.keys(record).every((key) => allowed.includes(key));

/** Whether every key in `required` is an own key of `record`. */
const hasKeys = (
  record: Record<string, unknown>,
  required: readonly string[],
): boolean => required.every((key) => Object.hasOwn(record, key));

const textEncoder = new TextEncoder();

/** UTF-8 bytes of a value's JSON text. */
export const harnessCommandJsonBytes = (value: unknown): number =>
  textEncoder.encode(JSON.stringify(value)).length;

/** Whether a value is JSON data: no undefined, functions, or non-finite numbers. */
const isJsonValue = (value: unknown, depth = 0): value is JSONValue => {
  if (depth > 64) return false;
  if (
    value === null || typeof value === "string" || typeof value === "boolean"
  ) {
    return true;
  }
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) {
    return value.every((entry) => isJsonValue(entry, depth + 1));
  }
  if (isObjectNotArray(value)) {
    return Object.values(value as Record<string, unknown>).every((entry) =>
      isJsonValue(entry, depth + 1)
    );
  }
  return false;
};

const isJsonObject = (value: unknown): value is JSONObject =>
  isObjectNotArray(value) && isJsonValue(value);

const isBoundedText = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.length <= max;

const isNonEmptyBoundedText = (value: unknown, max: number): value is string =>
  isBoundedText(value, max) && value.length > 0;

const isCommandId = (value: unknown): value is string =>
  isBoundedText(value, HARNESS_COMMAND_ID_MAX_LENGTH) &&
  HARNESS_COMMAND_ID_PATTERN.test(value);

/** One whole referent-handle token. */
const REFERENT_TOKEN = new RegExp(
  `^${REFERENT_HANDLE_TOKEN_PREFIX}[${HANDLE_TOKEN_ALPHABET}]{${MIN_HANDLE_TOKEN_SUFFIX_LENGTH},}$`,
);

/** A loom identifier as the service mints it. */
const LOOM_ID = /^loom-[a-f0-9]{16}$/;

const isLoomId = (value: unknown): value is string =>
  typeof value === "string" && LOOM_ID.test(value);

/** The executor's actor vocabulary: `user` or `agent:<slug>`. */
const LOOM_ACTOR = /^(?:user|agent:[a-z0-9][a-z0-9-]{0,63})$/;

const isApproval = (value: unknown): value is HarnessCommandApproval =>
  value === "automatic" || value === "person";

const isExecutor = (value: unknown): value is HarnessCommandExecutor =>
  value === "weaver" || value === "loom";

const isActor = (value: unknown): value is HarnessCommandActor =>
  value === "agent" || value === "user";

const isNonNegativeInteger = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;

/** Reads a target, or undefined when malformed. */
const readTarget = (value: unknown): HarnessCommandTarget | undefined => {
  if (!isObjectNotArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (
    !hasOnlyKeys(record, ["loomId", "expectedVersion"]) ||
    !isLoomId(own(record, "loomId"))
  ) {
    return undefined;
  }
  const expectedVersion = own(record, "expectedVersion");
  if (expectedVersion !== undefined && !isNonNegativeInteger(expectedVersion)) {
    return undefined;
  }
  return {
    loomId: record.loomId as string,
    ...(expectedVersion !== undefined ? { expectedVersion } : {}),
  };
};

/**
 * Reads an invocation, or undefined when any field is missing, extra, or
 * malformed, or when its `args` exceed {@link HARNESS_COMMAND_ARGS_MAX_BYTES}.
 */
export const readHarnessCommandInvocation = (
  value: unknown,
): HarnessCommandInvocation | undefined => {
  if (!isObjectNotArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (
    !hasOnlyKeys(record, ["command", "args", "target", "approval"]) ||
    !hasKeys(record, ["command", "args", "approval"])
  ) {
    return undefined;
  }
  const { command, args, approval } = record;
  if (!isCommandId(command) || !isApproval(approval) || !isJsonObject(args)) {
    return undefined;
  }
  if (harnessCommandJsonBytes(args) > HARNESS_COMMAND_ARGS_MAX_BYTES) {
    return undefined;
  }
  const rawTarget = own(record, "target");
  const target = rawTarget === undefined ? undefined : readTarget(rawTarget);
  if (rawTarget !== undefined && target === undefined) return undefined;
  return {
    command,
    args,
    ...(target !== undefined ? { target } : {}),
    approval,
  };
};

/** Reads a catalog request, or undefined when malformed. */
export const readHarnessCommandCatalogRequest = (
  value: unknown,
): HarnessCommandCatalogRequest | undefined => {
  if (!isObjectNotArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (!hasOnlyKeys(record, ["detail"])) return undefined;
  const detail = own(record, "detail");
  if (detail === undefined) return {};
  if (
    !Array.isArray(detail) ||
    detail.length > HARNESS_COMMAND_CATALOG_DETAIL_LIMIT ||
    !detail.every(isCommandId)
  ) {
    return undefined;
  }
  return { detail: [...detail] };
};

/** Reads a typed action, or undefined when its kind is unknown or malformed. */
export const readHarnessTypedClientAction = (
  value: unknown,
): HarnessTypedClientAction | undefined => {
  if (!isObjectNotArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  switch (own(record, "kind")) {
    case "invoke_command": {
      if (!hasExactlyKeys(record, ["kind", "invocation"])) return undefined;
      const invocation = readHarnessCommandInvocation(record.invocation);
      return invocation === undefined
        ? undefined
        : { kind: "invoke_command", invocation };
    }
    case "list_commands": {
      if (!hasExactlyKeys(record, ["kind", "request"])) return undefined;
      const request = readHarnessCommandCatalogRequest(record.request);
      return request === undefined
        ? undefined
        : { kind: "list_commands", request };
    }
    default:
      return undefined;
  }
};

/** Reads one catalog entry, or undefined when malformed or over a bound. */
const readCatalogEntry = (
  value: unknown,
): HarnessCommandCatalogEntry | undefined => {
  if (!isObjectNotArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const keys = [
    "command",
    "summary",
    "scope",
    "executes",
    "effect",
    "approval",
    "inputSchema",
    "description",
  ];
  if (
    !hasOnlyKeys(record, keys) ||
    !hasKeys(record, keys.slice(0, 7))
  ) {
    return undefined;
  }
  const { command, summary, scope, executes, effect, approval, inputSchema } =
    record;
  const description = own(record, "description");
  if (
    !isCommandId(command) ||
    !isBoundedText(summary, HARNESS_COMMAND_SUMMARY_MAX_LENGTH) ||
    (scope !== "loom" && scope !== "global") ||
    !isExecutor(executes) ||
    (effect !== "read" && effect !== "mutation") ||
    !isApproval(approval) ||
    // Only a read may run without the person.
    (approval === "automatic" && effect !== "read") ||
    !isJsonObject(inputSchema) ||
    harnessCommandJsonBytes(inputSchema) > HARNESS_COMMAND_SCHEMA_MAX_BYTES ||
    (description !== undefined &&
      !isBoundedText(description, HARNESS_COMMAND_DESCRIPTION_MAX_LENGTH))
  ) {
    return undefined;
  }
  return {
    command,
    summary,
    scope,
    executes,
    effect,
    approval,
    inputSchema,
    ...(description !== undefined ? { description } : {}),
  };
};

/** Reads a catalog, or undefined when malformed or over a bound. */
export const readHarnessCommandCatalog = (
  value: unknown,
): HarnessCommandCatalog | undefined => {
  if (!isObjectNotArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (!hasExactlyKeys(record, ["entries"])) return undefined;
  const { entries } = record;
  if (
    !Array.isArray(entries) || entries.length > HARNESS_COMMAND_CATALOG_LIMIT
  ) {
    return undefined;
  }
  const read: HarnessCommandCatalogEntry[] = [];
  for (const entry of entries) {
    const one = readCatalogEntry(entry);
    if (one === undefined) return undefined;
    read.push(one);
  }
  return { entries: read };
};

const OUTCOME_KEYS = [
  "executor",
  "transportStatus",
  "ok",
  "id",
  "code",
  "error",
  "echo",
  "quiet",
  "outputs",
  "completed",
  "displaced",
  "partialEcho",
  "mayHaveLanded",
  "bodyBytes",
  "body",
  "bodyOmitted",
] as const;

/**
 * Reads an outcome, or undefined when malformed or over a bound. A retained
 * body must fit {@link HARNESS_COMMAND_BODY_MAX_BYTES}; an omitted one must be
 * marked and its size must exceed it.
 */
export const readHarnessCommandOutcome = (
  value: unknown,
): HarnessCommandOutcome | undefined => {
  if (!isObjectNotArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (
    !hasOnlyKeys(record, OUTCOME_KEYS) ||
    !hasKeys(record, ["executor", "ok", "bodyBytes"])
  ) {
    return undefined;
  }
  const field = (key: typeof OUTCOME_KEYS[number]) => own(record, key);
  const executor = field("executor");
  const transportStatus = field("transportStatus");
  const ok = field("ok");
  const bodyBytes = field("bodyBytes");
  if (
    !isExecutor(executor) ||
    typeof ok !== "boolean" || !isNonNegativeInteger(bodyBytes)
  ) {
    return undefined;
  }
  if (
    executor === "loom"
      ? !(Number.isSafeInteger(transportStatus) &&
        (transportStatus as number) >= 100 &&
        (transportStatus as number) <= 599)
      : transportStatus !== undefined
  ) {
    return undefined;
  }
  const optionalText = (
    key: "id" | "code" | "error" | "echo" | "partialEcho",
  ) =>
    field(key) === undefined ||
    isBoundedText(field(key), HARNESS_COMMAND_TEXT_MAX_LENGTH);
  if (
    !optionalText("id") || !optionalText("code") || !optionalText("error") ||
    !optionalText("echo") || !optionalText("partialEcho")
  ) {
    return undefined;
  }
  const quiet = field("quiet");
  const mayHaveLanded = field("mayHaveLanded");
  if (
    (quiet !== undefined && typeof quiet !== "boolean") ||
    (mayHaveLanded !== undefined && typeof mayHaveLanded !== "boolean")
  ) {
    return undefined;
  }
  const outputs = field("outputs");
  if (
    outputs !== undefined &&
    (!isJsonObject(outputs) ||
      harnessCommandJsonBytes(outputs) > HARNESS_COMMAND_OUTPUTS_MAX_BYTES)
  ) {
    return undefined;
  }
  const completed = field("completed");
  if (
    completed !== undefined &&
    (!Array.isArray(completed) ||
      completed.length > HARNESS_COMMAND_LIST_LIMIT ||
      !completed.every((entry) =>
        isBoundedText(entry, HARNESS_COMMAND_TEXT_MAX_LENGTH)
      ))
  ) {
    return undefined;
  }
  const displaced = field("displaced");
  if (
    displaced !== undefined &&
    (!Array.isArray(displaced) ||
      displaced.length > HARNESS_COMMAND_LIST_LIMIT || !isJsonValue(displaced))
  ) {
    return undefined;
  }
  const body = field("body");
  const bodyOmitted = field("bodyOmitted");
  if (body !== undefined) {
    if (
      bodyOmitted !== undefined || !isJsonObject(body) ||
      (bodyBytes as number) > HARNESS_COMMAND_BODY_MAX_BYTES
    ) {
      return undefined;
    }
  } else if (
    bodyOmitted !== true ||
    (bodyBytes as number) <= HARNESS_COMMAND_BODY_MAX_BYTES
  ) {
    return undefined;
  }
  const text = (key: "id" | "code" | "error" | "echo" | "partialEcho") =>
    field(key) === undefined ? {} : { [key]: field(key) as string };
  return {
    executor,
    ...(transportStatus !== undefined
      ? { transportStatus: transportStatus as number }
      : {}),
    ok,
    ...text("id"),
    ...text("code"),
    ...text("error"),
    ...text("echo"),
    ...(quiet !== undefined ? { quiet } : {}),
    ...(outputs !== undefined ? { outputs } : {}),
    ...(completed !== undefined ? { completed: [...completed] } : {}),
    ...(displaced !== undefined ? { displaced: [...displaced] } : {}),
    ...text("partialEcho"),
    ...(mayHaveLanded !== undefined ? { mayHaveLanded } : {}),
    bodyBytes: bodyBytes as number,
    ...(body !== undefined ? { body } : { bodyOmitted: true as const }),
  };
};

/**
 * Reads an attribution, or undefined when malformed or when its approval,
 * actor, and executor actor disagree.
 */
export const readHarnessCommandAttribution = (
  value: unknown,
): HarnessCommandAttribution | undefined => {
  if (!isObjectNotArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const keys = ["approval", "actor", "loomActor", "service", "originLoomId"];
  if (!hasOnlyKeys(record, keys) || !hasKeys(record, keys.slice(0, 4))) {
    return undefined;
  }
  const { approval, actor, loomActor, service } = record;
  const originLoomId = own(record, "originLoomId");
  if (
    !isApproval(approval) || !isActor(actor) ||
    typeof loomActor !== "string" || !LOOM_ACTOR.test(loomActor) ||
    !isNonEmptyBoundedText(service, 2048) ||
    (originLoomId !== undefined && !isLoomId(originLoomId))
  ) {
    return undefined;
  }
  if (
    harnessCommandActorFor(approval) !== actor ||
    (actor === "user") !== (loomActor === "user")
  ) {
    return undefined;
  }
  return {
    approval,
    actor,
    loomActor,
    service,
    ...(originLoomId !== undefined ? { originLoomId } : {}),
  };
};

/** Reads an optional bounded reason, refusing a malformed one. */
const optionalReason = (
  record: Record<string, unknown>,
): { ok: true; reason?: string } | { ok: false } => {
  const reason = own(record, "reason");
  if (reason === undefined) return { ok: true };
  return isBoundedText(reason, HARNESS_COMMAND_TEXT_MAX_LENGTH)
    ? { ok: true, reason }
    : { ok: false };
};

/**
 * Reads a settlement, or undefined when malformed. A declined command was the
 * person's to decline, so its attribution must be the person's.
 */
export const readHarnessCommandSettlement = (
  value: unknown,
): HarnessCommandSettlement | undefined => {
  if (!isObjectNotArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  switch (own(record, "status")) {
    case "executed": {
      if (Object.hasOwn(record, "catalog")) {
        if (!hasExactlyKeys(record, ["status", "catalog"])) return undefined;
        const catalog = readHarnessCommandCatalog(record.catalog);
        return catalog === undefined
          ? undefined
          : { status: "executed", catalog };
      }
      if (
        !hasOnlyKeys(record, ["status", "attribution", "outcome", "receipt"]) ||
        !hasKeys(record, ["attribution", "outcome"])
      ) {
        return undefined;
      }
      const attribution = readHarnessCommandAttribution(record.attribution);
      const outcome = readHarnessCommandOutcome(record.outcome);
      const receipt = own(record, "receipt");
      if (
        attribution === undefined || outcome === undefined ||
        (receipt !== undefined &&
          !isBoundedText(receipt, HARNESS_COMMAND_RECEIPT_MAX_LENGTH))
      ) {
        return undefined;
      }
      return {
        status: "executed",
        attribution,
        outcome,
        ...(receipt !== undefined ? { receipt } : {}),
      };
    }
    case "declined": {
      if (!hasOnlyKeys(record, ["status", "attribution", "reason"])) {
        return undefined;
      }
      const attribution = readHarnessCommandAttribution(
        own(record, "attribution"),
      );
      const reason = optionalReason(record);
      if (
        attribution === undefined || attribution.approval !== "person" ||
        !reason.ok
      ) {
        return undefined;
      }
      return {
        status: "declined",
        attribution,
        ...(reason.reason !== undefined ? { reason: reason.reason } : {}),
      };
    }
    case "failed_to_deliver": {
      if (
        !hasOnlyKeys(record, ["status", "reason", "landed", "attribution"]) ||
        !isBoundedText(own(record, "reason"), HARNESS_COMMAND_TEXT_MAX_LENGTH)
      ) {
        return undefined;
      }
      const landed = own(record, "landed");
      if (landed !== "no" && landed !== "unknown") return undefined;
      const rawAttribution = own(record, "attribution");
      const attribution = rawAttribution === undefined
        ? undefined
        : readHarnessCommandAttribution(rawAttribution);
      if (rawAttribution !== undefined && attribution === undefined) {
        return undefined;
      }
      // A command whose answer was lost was sent, as somebody.
      if (landed === "unknown" && attribution === undefined) return undefined;
      return {
        status: "failed_to_deliver",
        reason: record.reason as string,
        landed,
        ...(attribution !== undefined ? { attribution } : {}),
      };
    }
    case "interrupted": {
      const reason = own(record, "reason");
      return hasExactlyKeys(record, ["status", "reason"]) &&
          (reason === "canceled" || reason === "timeout" ||
            reason === "restart")
        ? { status: "interrupted", reason }
        : undefined;
    }
    default:
      return undefined;
  }
};

/**
 * Reads a host's settlement post, or undefined when malformed. A host never
 * posts `interrupted`; that settlement is the console's.
 */
export const readHarnessCommandResolveBody = (
  value: unknown,
): HarnessCommandResolveBody | undefined => {
  if (!isObjectNotArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (!hasExactlyKeys(record, ["sessionId", "actionId", "settlement"])) {
    return undefined;
  }
  const { sessionId, actionId } = record;
  if (
    !isNonEmptyBoundedText(sessionId, 256) ||
    !isNonEmptyBoundedText(actionId, 256)
  ) {
    return undefined;
  }
  const settlement = readHarnessCommandSettlement(record.settlement);
  if (settlement === undefined || settlement.status === "interrupted") {
    return undefined;
  }
  return { sessionId, actionId, settlement };
};

/** Reads a resolved event's settlement record, or undefined when malformed. */
export const readHarnessCommandSettlementRecord = (
  value: unknown,
): HarnessCommandSettlementRecord | undefined => {
  if (!isObjectNotArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (own(record, "status") !== "executed") {
    return readHarnessCommandSettlement(value) as
      | HarnessCommandSettlementRecord
      | undefined;
  }
  if (Object.hasOwn(record, "catalogEntries")) {
    const count = record.catalogEntries;
    return hasExactlyKeys(record, ["status", "catalogEntries"]) &&
        isNonNegativeInteger(count) && count <= HARNESS_COMMAND_CATALOG_LIMIT
      ? { status: "executed", catalogEntries: count }
      : undefined;
  }
  if (
    !hasOnlyKeys(record, [
      "status",
      "attribution",
      "outcome",
      "receipt",
      "handle",
    ]) || !hasKeys(record, ["attribution", "outcome"])
  ) {
    return undefined;
  }
  const attribution = readHarnessCommandAttribution(record.attribution);
  const outcome = readOutcomeRecord(record.outcome);
  const receipt = own(record, "receipt");
  const handle = own(record, "handle");
  if (
    attribution === undefined || outcome === undefined ||
    (receipt !== undefined &&
      !isBoundedText(receipt, HARNESS_COMMAND_RECEIPT_MAX_LENGTH)) ||
    (handle !== undefined &&
      !(typeof handle === "string" && REFERENT_TOKEN.test(handle)))
  ) {
    return undefined;
  }
  return {
    status: "executed",
    attribution,
    outcome,
    ...(receipt !== undefined ? { receipt } : {}),
    ...(handle !== undefined ? { handle } : {}),
  };
};

/** Reads an outcome record: an outcome's metadata fields and nothing else. */
const readOutcomeRecord = (
  value: unknown,
): HarnessCommandOutcomeRecord | undefined => {
  if (!isObjectNotArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (
    !hasOnlyKeys(record, [
      "executor",
      "transportStatus",
      "ok",
      "id",
      "code",
      "error",
      "mayHaveLanded",
      "bodyBytes",
      "bodyOmitted",
    ])
  ) {
    return undefined;
  }
  // The record is an outcome with its data removed, so it reads as one with
  // a stand-in body of the size it reported.
  const outcome = readHarnessCommandOutcome({
    ...record,
    ...(record.bodyOmitted === true ? {} : { body: {} }),
  });
  return outcome === undefined
    ? undefined
    : harnessCommandOutcomeRecord(outcome);
};

/** An outcome's metadata, for a resolved event. */
export const harnessCommandOutcomeRecord = (
  outcome: HarnessCommandOutcome,
): HarnessCommandOutcomeRecord => ({
  executor: outcome.executor,
  ...(outcome.transportStatus !== undefined
    ? { transportStatus: outcome.transportStatus }
    : {}),
  ok: outcome.ok,
  ...(outcome.id !== undefined ? { id: outcome.id } : {}),
  ...(outcome.code !== undefined ? { code: outcome.code } : {}),
  ...(outcome.error !== undefined ? { error: outcome.error } : {}),
  ...(outcome.mayHaveLanded !== undefined
    ? { mayHaveLanded: outcome.mayHaveLanded }
    : {}),
  bodyBytes: outcome.bodyBytes,
  ...(outcome.bodyOmitted === true ? { bodyOmitted: true as const } : {}),
});

/**
 * The final-action outcome word a typed settlement shows a reader of the
 * `client_action_resolved` event that knows only `done`, `declined` and
 * `failed`. An executed command is `done` whatever it answered: the answer
 * is the outcome's to say.
 */
export const legacyOutcomeOfHarnessCommandSettlement = (
  settlement: Pick<HarnessCommandSettlement, "status">,
): "done" | "declined" | "failed" => {
  switch (settlement.status) {
    case "executed":
      return "done";
    case "declined":
      return "declined";
    case "failed_to_deliver":
    case "interrupted":
      return "failed";
  }
};

/** Reads command-result provenance, or undefined when malformed. */
export const readHarnessCommandResultProvenance = (
  value: unknown,
): HarnessCommandResultProvenance | undefined => {
  if (!isObjectNotArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const keys = ["command", "actor", "loomId", "version", "originLoomId"];
  if (!hasOnlyKeys(record, keys) || !hasKeys(record, ["command", "actor"])) {
    return undefined;
  }
  const { command, actor } = record;
  const loomId = own(record, "loomId");
  const version = own(record, "version");
  const originLoomId = own(record, "originLoomId");
  if (
    !isCommandId(command) || !isActor(actor) ||
    (loomId !== undefined && !isLoomId(loomId)) ||
    (version !== undefined && !isNonNegativeInteger(version)) ||
    (originLoomId !== undefined && !isLoomId(originLoomId))
  ) {
    return undefined;
  }
  return {
    command,
    actor,
    ...(loomId !== undefined ? { loomId } : {}),
    ...(version !== undefined ? { version } : {}),
    ...(originLoomId !== undefined ? { originLoomId } : {}),
  };
};
