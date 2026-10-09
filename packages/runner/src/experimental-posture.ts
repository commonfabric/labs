/**
 * Resolves experimental flags for runtime hosts, including browser pages.
 * Environment mappings and deployment adoption share one registry without
 * loading the runtime execution graph into the importing host.
 */

import { debugStr } from "@commonfabric/data-model";

import type { ExperimentalOptions } from "./runtime.ts";

/**
 * The canonical parse: exactly `"true"` / `"false"`, anything else ignored
 * with a warning. The warning starts with `[logPrefix]`; a caller that warns
 * about other values in the same call passes its own prefix, so that all of
 * that call's warnings share one.
 */
export function parseFlagValue(
  raw: string,
  source: string,
  logPrefix = "runtime-presets",
): boolean | undefined {
  if (raw === "true" || raw === "false") return raw === "true";
  console.warn(
    `[${logPrefix}] Ignoring ${source}="${raw}" — ` +
      `expected "true" or "false" (unset = default).`,
  );
  return undefined;
}

/** Reads one environment variable; pass `Deno.env.get` in Deno contexts. */
export type EnvReader = (name: string) => string | undefined;

/**
 * The one env mapping for {@link ExperimentalOptions}. `null` declares a flag
 * as deliberately programmatic-only, so "not env-wired" is a decision on
 * record rather than an omission in one of several parallel wirings.
 *
 * Every experimental flag is catalogued in
 * `docs/development/EXPERIMENTAL_OPTIONS.md`; update that registry when adding
 * or removing an entry here.
 */
export const EXPERIMENTAL_ENV_VARS = {
  modernCellRep: "EXPERIMENTAL_MODERN_CELL_REP",
  agentBuiltin: "EXPERIMENTAL_AGENT_BUILTIN",
  // Content-addressed schemas (Phases 1 and 2) are default-on; env-reachable
  // so a process can opt out with an explicit "false" while the flag exists.
  contentAddressedSchemas: "EXPERIMENTAL_CONTENT_ADDRESSED_SCHEMAS",
  // Scheduler-v2 lineage (#4090) is default-on. Keep a programmatic rollback
  // override while the flag exists; no environment exposure is needed.
  commitPreconditions: null,
  // Verb-contract WS-C: default-on since the invocation-protocol integration
  // proof (#5244); env-reachable so a process can opt out with an explicit
  // "false" while the flag exists.
  plainResultReceipts: "EXPERIMENTAL_PLAIN_RESULT_RECEIPTS",
  computedCellIds: "EXPERIMENTAL_COMPUTED_CELL_IDS",
  lazyMaterialization: "EXPERIMENTAL_LAZY_MATERIALIZATION",
  // Reader precedence at link crossings is default-on; env-reachable so a
  // process can opt out with an explicit "false" while the flag exists.
  readerSchemaPrecedence: "EXPERIMENTAL_READER_SCHEMA_PRECEDENCE",
  // Server-execution v2 (docs/specs/server-side-execution/): the
  // deployed-topology presets in `runtime-presets.ts` resolve an unset flag to
  // `SERVER_EXECUTION_DEFAULT_ENABLED`, so such a process always runs a
  // declared arm. Env-reachable so every server-side process can be flipped
  // either way, and an explicit value always wins over the constant.
  serverExecution: "EXPERIMENTAL_SERVER_EXECUTION",
  // Remote-echo breaker (docs/plans/scheduler-remote-echo-breaker.md):
  // default-off; env-reachable so a deployment can enable it for dogfooding.
  remoteEchoBreaker: "EXPERIMENTAL_REMOTE_ECHO_BREAKER",
  viewScopedReplication: "EXPERIMENTAL_VIEW_SCOPED_REPLICATION",
  webViewScopedReplication: "EXPERIMENTAL_WEB_VIEW_SCOPED_REPLICATION",
  sharedMemoryConnection: "EXPERIMENTAL_SHARED_MEMORY_CONNECTION",
} as const satisfies Record<keyof ExperimentalOptions, string | null>;

/**
 * Read `ExperimentalOptions` from the environment via the canonical mapping.
 * Accepted values are exactly `"true"` and `"false"`; unset means "use the
 * default". Anything else is ignored with a warning, under `logPrefix` when
 * one is given ({@link parseFlagValue}).
 */
export function experimentalOptionsFromEnv(
  env: EnvReader,
  logPrefix?: string,
): ExperimentalOptions {
  const opts: ExperimentalOptions = {};
  for (
    const [key, envVar] of Object.entries(EXPERIMENTAL_ENV_VARS) as [
      keyof ExperimentalOptions,
      string | null,
    ][]
  ) {
    if (envVar === null) continue;
    const raw = env(envVar);
    if (raw === undefined) continue;
    const parsed = parseFlagValue(raw, envVar, logPrefix);
    if (parsed !== undefined) opts[key] = parsed;
  }
  return opts;
}

//
// Gate 3: which flags a deployed client takes from the server it talks to.
//

/**
 * Where a client resolves one flag when it is not built alongside the server
 * it talks to.
 *
 * - `"server"` — the deployment decides. The client adopts the value the
 *   server publishes (see `settingsForDeployedClient` in
 *   `deployment-meta.ts`). Use this for a flag whose value is visible on the
 *   wire, in what gets stored, or in which side runs what: peers that disagree
 *   either refuse each other or, worse, quietly write data shaped for two
 *   different postures.
 * - `"client"` — the flag governs in-process behavior with no wire, storage,
 *   or division-of-labor consequence, so a client is free to run its own
 *   value. Justify the reasoning in a comment beside the entry: over-adopting
 *   costs nothing but a client that diverges where it should not is a silent
 *   corruption.
 */
export type ExperimentalFlagAuthority = "server" | "client";

/**
 * The authority for every flag in {@link ExperimentalOptions}, type-gated the
 * same way as {@link EXPERIMENTAL_ENV_VARS}: a new flag does not compile
 * until it is classified here, so "does a `cf` binary follow the deployment
 * on this?" is a decision on record rather than whatever the default happened
 * to be.
 *
 * Every flag is server-authoritative today. That is the safe direction rather
 * than a coincidence — each one is visible in what gets written (the link and
 * entity-id encodings, receipt contents, schema references), in what the
 * server admits (commit preconditions, per-class admission), in which side
 * runs the compute at all, or in which documents a subscription ships.
 * `"client"` is here for the flag that gates a purely local experiment;
 * nothing qualifies yet.
 */
export const EXPERIMENTAL_FLAG_AUTHORITY = {
  // Link serialization: the two encodings are a hard mismatch, which the
  // memory handshake already refuses to connect across.
  modernCellRep: "server",
  agentBuiltin: "server",
  // An emission gate whose rollout is fleet-wide and one-way: a deployment
  // turns it on only once every client of it reads references, and an
  // explicit `false` is how it rolls back. A client still emitting after that
  // writes the form the deployment decided to stop producing.
  contentAddressedSchemas: "server",
  // The server enforces the preconditions this flag makes a commit carry.
  commitPreconditions: "server",
  // Decides what a verb's receipt holds. Under server execution the SERVER
  // runs the handler, so a client on the other value reads back a receipt
  // shaped by a rule it does not share.
  plainResultReceipts: "server",
  // Entity-id minting: a peer predating the `computed:` scheme throws on such
  // ids arriving via sync, so the scheme has to be fleet-wide.
  computedCellIds: "server",
  // Changes which paths a lift's argument read, and the consumed-read set is
  // what a commit declares and the server admits against.
  lazyMaterialization: "server",
  // The whole point of the flag is which side computes what is stored.
  serverExecution: "server",
  // Under server execution the server runs the derivations, so a client and
  // server that disagreed on whether to rate-limit a shared document's re-runs
  // would write it at different cadences; the deployment decides.
  remoteEchoBreaker: "server",
  // Defaults are published fleet-wide; each session negotiates the mode.
  viewScopedReplication: "server",
  webViewScopedReplication: "server",
  // The server's traversal decides what a subscription loads, tracks, and
  // ships; a client resolving hops under the other combine rule expects
  // documents the server did not send (or ignores ones it did). The arms
  // read the same stored data, so adoption is safe either way — but both
  // sides must run the same one.
  readerSchemaPrecedence: "server",
  // The deployment decides whether a connection may carry several spaces:
  // one that routes a connection by the space its address names cannot
  // serve a client that shares connections.
  sharedMemoryConnection: "server",
} as const satisfies Record<
  keyof ExperimentalOptions,
  ExperimentalFlagAuthority
>;

/**
 * The deployment's meta document, where a server publishes the experimental
 * posture its own Runtime resolved and the memory URL its clients open Memory
 * on (`deployment-meta.ts` reads both). Same document as the deployment's DID
 * and commit, so a client that already asks who it is talking to learns both
 * from one request.
 */
export const SERVER_EXPERIMENTAL_PATH = "/api/meta";

/**
 * Set to `"false"` to keep a client on its own posture and ignore whatever
 * the server publishes. The escape hatch for a deployment publishing
 * something a client cannot run — per-flag `EXPERIMENTAL_*` overrides handle
 * the case where you know WHICH flag, this one the case where you do not.
 */
export const ADOPT_SERVER_FLAGS_ENV = "CF_ADOPT_SERVER_FLAGS";

/**
 * Read a server's published posture into `ExperimentalOptions`.
 *
 * Deliberately incurious about anything it does not recognize. A key this
 * build has no flag for is a NEWER server and entirely normal; a non-boolean
 * value is a malformed declaration and is dropped with a warning rather than
 * coerced. Neither is grounds for refusing to run — a client that cannot read
 * the posture keeps its built-in defaults, which is what it did before the
 * server published anything at all.
 *
 * An older server's silence on `readerSchemaPrecedence` or `agentBuiltin`
 * reads as the legacy declared `false`. An explicit `experimental: null`
 * means the server has no Runtime yet and does not declare either posture.
 */
export function parseServerExperimentalOptions(
  declared: unknown,
): ExperimentalOptions {
  // Field presence decides the legacy arm. A posture record silent on
  // readerSchemaPrecedence or agentBuiltin uses the corresponding old
  // default, `false`. A meta document with no experimental field at all —
  // handed in as `undefined` — takes those legacy arms too.
  // An explicit `experimental: null` is different: toolshed publishes
  // null until a Runtime exists, so the server is not pre-flag, it just
  // has no posture yet — that adopts nothing, as does a malformed
  // declaration. A client that could not reach the server never calls
  // this at all and keeps its built-in defaults.
  if (declared === null || Array.isArray(declared)) return {};
  if (typeof declared !== "object") {
    return declared === undefined
      ? { readerSchemaPrecedence: false, agentBuiltin: false }
      : {};
  }
  const opts: ExperimentalOptions = {
    readerSchemaPrecedence: false,
    agentBuiltin: false,
  };
  for (const key of Object.keys(EXPERIMENTAL_FLAG_AUTHORITY)) {
    const value = (declared as Record<string, unknown>)[key];
    if (value === undefined) continue;
    if (typeof value !== "boolean") {
      console.warn(
        `[deployment-meta] Ignoring server-published ${key}=` +
          debugStr`$quote${value} — expected a boolean.`,
      );
      continue;
    }
    opts[key as keyof ExperimentalOptions] = value;
  }
  return opts;
}

/**
 * Resolve one client's posture from what the server published and what its
 * own environment says, in that order of increasing authority:
 *
 * 1. an explicit `EXPERIMENTAL_*` wins outright — it is the documented
 *    rollback lever and CI's way to pin a lane, and a server able to overrule
 *    it would leave neither mechanism working;
 * 2. otherwise a `"server"` flag takes the published value;
 * 3. otherwise the flag stays unset and the built-in default governs, which
 *    is exactly what an unreachable server or a `"client"` flag leaves
 *    behind. An older server is not that case for `readerSchemaPrecedence`
 *    or `agentBuiltin`: {@link parseServerExperimentalOptions} reads its
 *    silence on either as the legacy declared `false`.
 */
export function adoptServerExperimentalOptions(
  server: ExperimentalOptions,
  env: ExperimentalOptions,
  /**
   * The classification to resolve against. Defaults to the registry, and is
   * a parameter so the `"client"` arm stays exercised while no first-party
   * flag carries it.
   */
  authorities: Record<
    keyof ExperimentalOptions,
    ExperimentalFlagAuthority
  > = EXPERIMENTAL_FLAG_AUTHORITY,
): ExperimentalOptions {
  const opts: ExperimentalOptions = { ...env };
  for (
    const [key, authority] of Object.entries(authorities) as [
      keyof ExperimentalOptions,
      ExperimentalFlagAuthority,
    ][]
  ) {
    if (authority !== "server") continue;
    if (opts[key] !== undefined) continue;
    const published = server[key];
    if (published !== undefined) opts[key] = published;
  }
  return opts;
}
