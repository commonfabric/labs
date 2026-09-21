import { SERVER_EXECUTION_DEFAULT_ENABLED } from "@commonfabric/memory/v2/server-execution-default";
import { parseFlagValue } from "@commonfabric/runner/experimental-posture";

import { optionalPresenceUrl } from "./presence-url.ts";

declare global {
  var $ENVIRONMENT: string | undefined;
  var $API_URL: string | undefined;
  var $PRESENCE_URL: string | undefined;
  var $COMMIT_SHA: string | undefined;
  var $EXPERIMENTAL_MODERN_CELL_REP: string | undefined;
  var $EXPERIMENTAL_AGENT_BUILTIN: string | undefined;
  var $EXPERIMENTAL_COMPUTED_CELL_IDS: string | undefined;
  var $EXPERIMENTAL_SERVER_EXECUTION: string | undefined;
  var $EXPERIMENTAL_VIEW_SCOPED_REPLICATION: string | undefined;
  var $EXPERIMENTAL_WEB_VIEW_SCOPED_REPLICATION: string | undefined;
  var $EXPERIMENTAL_CONTENT_ADDRESSED_SCHEMAS: string | undefined;
  var $EXPERIMENTAL_READER_SCHEMA_PRECEDENCE: string | undefined;
}

const ENVIRONMENT_DEFINE = typeof $ENVIRONMENT === "string"
  ? $ENVIRONMENT
  : undefined;
const API_URL_DEFINE = typeof $API_URL === "string" ? $API_URL : undefined;
const PRESENCE_URL_DEFINE = typeof $PRESENCE_URL === "string"
  ? $PRESENCE_URL
  : undefined;
const COMMIT_SHA_DEFINE = typeof $COMMIT_SHA === "string"
  ? $COMMIT_SHA
  : undefined;
const EXPERIMENTAL_MODERN_CELL_REP_DEFINE =
  typeof $EXPERIMENTAL_MODERN_CELL_REP === "string"
    ? $EXPERIMENTAL_MODERN_CELL_REP
    : undefined;
const EXPERIMENTAL_AGENT_BUILTIN_DEFINE =
  typeof $EXPERIMENTAL_AGENT_BUILTIN === "string"
    ? $EXPERIMENTAL_AGENT_BUILTIN
    : undefined;
const EXPERIMENTAL_COMPUTED_CELL_IDS_DEFINE =
  typeof $EXPERIMENTAL_COMPUTED_CELL_IDS === "string"
    ? $EXPERIMENTAL_COMPUTED_CELL_IDS
    : undefined;
const EXPERIMENTAL_SERVER_EXECUTION_DEFINE =
  typeof $EXPERIMENTAL_SERVER_EXECUTION === "string"
    ? $EXPERIMENTAL_SERVER_EXECUTION
    : undefined;

const EXPERIMENTAL_CONTENT_ADDRESSED_SCHEMAS_DEFINE =
  typeof $EXPERIMENTAL_CONTENT_ADDRESSED_SCHEMAS === "string"
    ? $EXPERIMENTAL_CONTENT_ADDRESSED_SCHEMAS
    : undefined;

const EXPERIMENTAL_READER_SCHEMA_PRECEDENCE_DEFINE =
  typeof $EXPERIMENTAL_READER_SCHEMA_PRECEDENCE === "string"
    ? $EXPERIMENTAL_READER_SCHEMA_PRECEDENCE
    : undefined;

export const ENVIRONMENT: "development" | "production" =
  ENVIRONMENT_DEFINE === "production" ? ENVIRONMENT_DEFINE : "development";

export const API_URL: URL = new URL(
  API_URL_DEFINE ||
    `${globalThis.location.protocol}//${globalThis.location.host}`,
);

/** Optional browser-visible endpoint for ephemeral editor co-presence. */
export const PRESENCE_URL = optionalPresenceUrl(PRESENCE_URL_DEFINE);

export const COMMIT_SHA: string | undefined = COMMIT_SHA_DEFINE;

/**
 * The one canonical flag parse, shared with the server side's env mapping:
 * exactly `"true"` / `"false"`; anything else — including a garbled define —
 * is ignored with a warning rather than coerced, leaving the flag's default
 * in force.
 */
function flagValue(flag: string | undefined): boolean | undefined {
  return typeof flag === "string"
    ? parseFlagValue(flag, "shell experimental define")
    : undefined;
}

/** Build-time experimental flags, injected via felt.config.ts defines. */
export const EXPERIMENTAL = {
  modernCellRep: flagValue(EXPERIMENTAL_MODERN_CELL_REP_DEFINE),
  agentBuiltin: flagValue(EXPERIMENTAL_AGENT_BUILTIN_DEFINE),
  computedCellIds: flagValue(EXPERIMENTAL_COMPUTED_CELL_IDS_DEFINE),
  viewScopedReplication: flagValue(
    typeof $EXPERIMENTAL_VIEW_SCOPED_REPLICATION === "string"
      ? $EXPERIMENTAL_VIEW_SCOPED_REPLICATION
      : undefined,
  ),
  webViewScopedReplication: flagValue(
    typeof $EXPERIMENTAL_WEB_VIEW_SCOPED_REPLICATION === "string"
      ? $EXPERIMENTAL_WEB_VIEW_SCOPED_REPLICATION
      : undefined,
  ),
  // Server-execution v2 (docs/specs/server-side-execution/): the
  // first-party default (the constant; the registry states its current
  // value), overridable by the build define either way (CI's `opposite`
  // lane bakes the inverse of the constant into its shell). The worker
  // refuses to
  // initialize if its resolved posture disagrees with this declaration
  // (runtime-client's posture agreement).
  serverExecution: flagValue(EXPERIMENTAL_SERVER_EXECUTION_DEFINE) ??
    SERVER_EXECUTION_DEFAULT_ENABLED,
  // Content-addressed schemas Phases 1 and 2: link writers and selectors
  // emit cid: references. On by default in the runner; the define is the
  // rollback override (`EXPERIMENTAL_CONTENT_ADDRESSED_SCHEMAS=false` bakes
  // a shell that emits inline schemas again).
  contentAddressedSchemas: flagValue(
    EXPERIMENTAL_CONTENT_ADDRESSED_SCHEMAS_DEFINE,
  ),
  // Reader precedence at link crossings. On by default in the runner; the
  // define is the rollback override
  // (`EXPERIMENTAL_READER_SCHEMA_PRECEDENCE=false` bakes a shell whose
  // worker runs the strict combine, matching a server deployed with the
  // same env — the flag is server-authoritative and both sides must
  // resolve hops under one rule).
  readerSchemaPrecedence: flagValue(
    EXPERIMENTAL_READER_SCHEMA_PRECEDENCE_DEFINE,
  ),
};
