import { SERVER_EXECUTION_DEFAULT_ENABLED } from "@commonfabric/memory/v2/server-execution-default";
import type { ExperimentalOptions } from "@commonfabric/runner";
import {
  adoptServerExperimentalOptions,
  parseFlagValue,
} from "@commonfabric/runner/experimental-posture";
import {
  holdDeployment,
  resolveDeployment,
  type ShellDeployment,
} from "./deployment.ts";

declare global {
  var $ENVIRONMENT: string | undefined;
  var $API_URL: string | undefined;
  var $COMMIT_SHA: string | undefined;
  var $EXPERIMENTAL_MODERN_CELL_REP: string | undefined;
  var $EXPERIMENTAL_AGENT_BUILTIN: string | undefined;
  var $EXPERIMENTAL_COMPUTED_CELL_IDS: string | undefined;
  var $EXPERIMENTAL_SERVER_EXECUTION: string | undefined;
  var $EXPERIMENTAL_VIEW_SCOPED_REPLICATION: string | undefined;
  var $EXPERIMENTAL_WEB_VIEW_SCOPED_REPLICATION: string | undefined;
  var $EXPERIMENTAL_CONTENT_ADDRESSED_SCHEMAS: string | undefined;
  var $EXPERIMENTAL_READER_SCHEMA_PRECEDENCE: string | undefined;
  var $EXPERIMENTAL_SHARED_MEMORY_CONNECTION: string | undefined;
}

const ENVIRONMENT_DEFINE = typeof $ENVIRONMENT === "string"
  ? $ENVIRONMENT
  : undefined;
const API_URL_DEFINE = typeof $API_URL === "string" ? $API_URL : undefined;
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

/**
 * What this page's worker takes from its deployment: the memory URL it opens
 * Memory on and the flags the deployment decides ({@link resolveDeployment}).
 * The shell's entry calls `prefetch` as early as it can, so that a page which
 * has to read the API URL's meta document does so alongside the rest of
 * startup, and the root view awaits `get` before creating each runtime. The
 * first runtime takes that read's result, unless it is a transient failure
 * more than ten seconds old. A result that is not a transient failure is kept
 * for the page's lifetime; a transient failure is not
 * ({@link holdDeployment}), so the next runtime the page creates reads again.
 */
export const shellDeployment: ShellDeployment = holdDeployment(
  () =>
    resolveDeployment(
      globalThis.document,
      API_URL,
      globalThis.location?.origin,
    ),
);

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
  // Decided by the deployment (SHELL_FLAG_SOURCES): a runtime takes the
  // value the deployment publishes unless this define pins it
  // ({@link experimentalForDeployment}). The define is the rollback and CI
  // lever, as for the other flags; it is unset in a release build.
  sharedMemoryConnection: flagValue(
    typeof $EXPERIMENTAL_SHARED_MEMORY_CONNECTION === "string"
      ? $EXPERIMENTAL_SHARED_MEMORY_CONNECTION
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

/**
 * The flags a runtime runs: the build defines, with the flags the deployment
 * decides for the shell adopted from `declared` where no define pins them.
 * `declared` is what the page or the meta document declared of
 * `SHELL_DEPLOYMENT_FLAGS` (`shellDeployment.get().experimental`), so the
 * adoption is `adoptServerExperimentalOptions` as `cf` runs it: an explicit
 * define wins, otherwise the deployment's value, otherwise the built-in
 * default. One shell build thereby runs a flag on against a deployment that
 * turned it on and off against one that did not.
 */
export function experimentalForDeployment(
  declared: ExperimentalOptions,
): ExperimentalOptions {
  return adoptServerExperimentalOptions(declared, EXPERIMENTAL);
}
