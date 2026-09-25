import * as Path from "@std/path";

import { z } from "zod";

// Parse CLI args for --port (needed because deno --watch doesn't pass env vars)
function parseCliArgs(): Record<string, string> {
  const overrides: Record<string, string> = {};
  for (const arg of Deno.args) {
    if (arg.startsWith("--port=")) {
      overrides.PORT = arg.split("=")[1];
    }
  }
  return overrides;
}

/**
 * Results in `true` (on), `false` (off), or `undefined` (default).
 */
function flagValue() {
  return z.string().default("default").transform((v) => {
    switch (v) {
      case "default":
        return undefined;
      case "false":
        return false;
      default:
        return true;
    }
  });
}

/**
 * Strict boolean env flag: only "true"/"1" enable; "false", unset, or anything
 * else disable. Avoids z.coerce.boolean()'s footgun where `Boolean("false")` is
 * `true`, which would turn a flag ON when the operator set it to "false".
 */
function boolFlag() {
  return z.string().default("false").transform((v) =>
    v === "true" || v === "1"
  );
}

// NOTE: This is where we define the environment variable types and defaults.
// Exported so the parsing rules (e.g. OTEL_ENABLED) can be unit-tested without
// going through the module-level singleton below.
export const EnvSchema = z.object({
  ENV: z.string().default("development"),
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().default(8000),
  LOG_LEVEL: z.enum([
    "fatal",
    "error",
    "warn",
    "info",
    "debug",
    "trace",
    "silent",
  ]).default("info"),
  // Strict parse (see boolFlag): DISABLE_LOG_REQ_RES=false now means "log req/res",
  // matching operator intent. Previously z.coerce.boolean() turned "false" into true.
  DISABLE_LOG_REQ_RES: boolFlag(),
  CACHE_DIR: z.string().default("./cache"),

  //
  // OpenTelemetry Configuration
  //

  // Strict parse (see boolFlag): only "true"/"1" enable telemetry; "false"/unset
  // disable it. z.coerce.boolean() would wrongly enable on the string "false".
  OTEL_ENABLED: boolFlag(),
  OTEL_SERVICE_NAME: z.string().default("toolshed"),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().default("http://localhost:4318"),
  // Wired into the provider in lib/otel.ts via samplerFromEnv(). The OTel JS SDK
  // does not auto-read these from the environment under Deno, so we build the
  // Sampler explicitly. Supported values: always_on (default), always_off,
  // traceidratio, parentbased_always_on, parentbased_always_off,
  // parentbased_traceidratio. OTEL_TRACES_SAMPLER_ARG is the ratio for the
  // *ratio variants. Defaults (always_on / 1.0) keep 100% sampling.
  // Trace-based distinct counts depend on full sampling: the active identity
  // count reads the user.did attribute on the memory spans, and a ratio sampler
  // drops identities from that count instead of thinning it proportionally.
  // See docs/features/active-user-counting.md.
  OTEL_TRACES_SAMPLER: z.string().default("always_on"),
  OTEL_TRACES_SAMPLER_ARG: z.string().default("1.0"),

  //
  // (/routes/ai/llm) Environment variables for LLM Providers
  //

  CFTS_AI_LLM_ANTHROPIC_API_KEY: z.string().default(""),
  CFTS_AI_LLM_GROQ_API_KEY: z.string().default(""),
  CFTS_AI_LLM_OPENAI_API_KEY: z.string().default(""),
  CFTS_AI_LLM_GOOGLE_APPLICATION_CREDENTIALS: z.string().default(""),
  CFTS_AI_LLM_GOOGLE_VERTEX_PROJECT: z.string().default(""),
  CFTS_AI_LLM_GOOGLE_VERTEX_LOCATION: z.string().default(""),
  // The gateway is reachable only on Tailscale; toolshed falls back cleanly
  // when the URL is unreachable (see `loadGatewayModels` in routes/ai/llm/models.ts).
  CFTS_AI_GATEWAY_URL: z.string().default("https://llm.stage.commontools.dev"),

  /**
   * FAL AI API Key
   *   * /routes/ai/img
   *   * /routes/ai/voice
   */
  FAL_API_KEY: z.string().default(""),

  /**
   * Jina API Key
   *   * /routes/agent-tools/web-read
   *   * /routes/link-preview
   */
  JINA_API_KEY: z.string().default(""),

  //
  // Memory Store
  //
  //  - MEMORY_DIR is used by toolshed to access sqlite files for common-memory
  //    (directory mode - default, backwards compatible)
  //  - DB_PATH is an optional absolute path to a single SQLite database file
  //    holding every space (single-file mode - takes precedence over MEMORY_DIR)
  //  - MEMORY_URL is used by toolshed to connect to memory endpoint
  //

  MEMORY_DIR: z.string().default(
    new URL(`./cache/memory/`, Path.toFileUrl(`${Deno.cwd()}/`)).href,
  ),
  DB_PATH: z.string().refine(
    (path) => !path || Path.isAbsolute(path),
    { message: "DB_PATH must be an absolute path" },
  ).optional(),
  MEMORY_URL: z.string().default("http://localhost:8000"),

  GOOGLE_CLIENT_ID: z.string().default(""),
  GOOGLE_CLIENT_SECRET: z.string().default(""),

  //
  // Airtable Integration
  //
  //   * /routes/integrations/airtable-oauth
  //

  AIRTABLE_CLIENT_ID: z.string().default(""),
  AIRTABLE_CLIENT_SECRET: z.string().default(""),

  //
  // GitHub Integration
  //
  //   * /routes/integrations/github-oauth
  //

  GITHUB_CLIENT_ID: z.string().default(""),
  GITHUB_CLIENT_SECRET: z.string().default(""),

  //
  // Notion Integration
  //
  //   * /routes/integrations/notion-oauth
  //

  NOTION_CLIENT_ID: z.string().default(""),
  NOTION_CLIENT_SECRET: z.string().default(""),

  //
  // Linear Integration
  //
  //   * /routes/integrations/linear-oauth
  //

  LINEAR_CLIENT_ID: z.string().default(""),
  LINEAR_CLIENT_SECRET: z.string().default(""),

  //
  // Spotify Integration
  //
  //   * /routes/integrations/spotify-oauth
  //

  SPOTIFY_CLIENT_ID: z.string().default(""),
  SPOTIFY_CLIENT_SECRET: z.string().default(""),

  //
  // Discord OAuth Integration
  //
  //   * /routes/integrations/discord-oauth
  //

  DISCORD_CLIENT_ID: z.string().default(""),
  DISCORD_CLIENT_SECRET: z.string().default(""),

  //
  // Strava Integration
  //
  //   * /routes/integrations/strava-oauth
  //

  STRAVA_CLIENT_ID: z.string().default(""),
  STRAVA_CLIENT_SECRET: z.string().default(""),

  //
  // Plaid Integration
  //
  //   * /routes/integrations/plaid-oauth
  //

  PLAID_CLIENT_ID: z.string().default(""),
  PLAID_SECRET: z.string().default(""),
  PLAID_ENV: z.enum(["sandbox", "development", "production"]).default(
    "sandbox",
  ),
  PLAID_PRODUCTS: z.string().default("transactions"),
  PLAID_COUNTRY_CODES: z.string().default("US"),
  PLAID_REDIRECT_URI: z.string().optional(),
  // Strict parse (see boolFlag); previously z.coerce.boolean() turned "false" into true.
  PLAID_SYNC_ALL_TRANSACTIONS: boolFlag(),

  // URL of the toolshed API, for self-referring requests
  API_URL: z.string().default("http://localhost:8000"),

  // DEPRECATED: Identity signer passphrase for storage authentication
  IDENTITY_PASSPHRASE: z.string().default("implicit trust"),

  // Path to an identity key.
  IDENTITY: z.string().default(""),

  // Space ACL enforcement on the memory v2 server: off | observe | enforce.
  // `observe` evaluates ordinary access and counts/logs would-denies; invalid
  // ACL state and fresh-space genesis violations still block. `enforce` also
  // denies access shortfalls. See packages/memory/v2/server.ts.
  MEMORY_ACL_MODE: z.enum(["off", "observe", "enforce"]).default("enforce"),

  // Bounds for each space's decoded-document cache on the memory v2 server
  // (packages/memory/v2/engine.ts, DEFAULT_DOCUMENT_CACHE_BUDGET_BYTES): a
  // byte budget in encoded bytes and an entry cap. Unset means the engine's
  // defaults. Raise the budget when /api/health/stats `documentCaches` shows
  // `evictions` climbing for a space that is being read repeatedly. (`int()`
  // is a safe-integer check in zod 4, so a value past 2^53 fails here rather
  // than in the memory server.)
  MEMORY_DOCUMENT_CACHE_BUDGET_BYTES: z.coerce.number().int().positive()
    .optional(),
  MEMORY_DOCUMENT_CACHE_MAX_ENTRIES: z.coerce.number().int().positive()
    .optional(),
  // Bound across every space's document cache on the memory server this
  // process hosts (default DOCUMENT_CACHE_TOTAL_BUDGET_BYTES in
  // packages/memory/v2/server.ts; one memory server per toolshed process, so
  // in deployment this is the process's bound).
  MEMORY_DOCUMENT_CACHE_TOTAL_BUDGET_BYTES: z.coerce.number().int()
    .positive().optional(),

  // Set ONLY when a trusted reverse proxy sits in front of this process and
  // overwrites X-Forwarded-For. Rate limiting keys on the real TCP peer by
  // default; behind a proxy every caller would otherwise collapse onto the
  // proxy's address and one client could starve everyone. Enabling it without a
  // proxy is worse than leaving it off: the header becomes client-controlled,
  // so a fresh value per request yields a fresh bucket and the limit vanishes.
  RATE_LIMIT_TRUST_FORWARDED_FOR: boolFlag(),

  // Mounts the self-serve ingest-channel control plane
  // (POST /api/ingest-channels/*). OFF by default and deliberately so.
  //
  // Minting issues a durable, operator-backed append capability into a user's
  // space, and it is only as trustworthy as the claim "this DID owns that
  // space". Where named-space keys derive from a public passphrase, anyone who
  // knows a space NAME can reconstruct its key, grant themselves OWNER, and
  // mint legitimately — and repairing the derivation later does NOT retract
  // what was issued. Enabling this before that repair converts a temporary
  // takeover into persistence beyond remediation.
  //
  // Turn it on only where space keys are not derivable from public inputs. The
  // tripwire in packages/toolshed/routes/ingest-channels/ and
  // `deno task check-tripwires` fire when that repair lands.
  INGEST_SELF_SERVE_ENABLED: boolFlag(),

  // Comma-separated DIDs with implicit OWNER on every space (e.g. the
  // background service operator identity).
  MEMORY_SERVICE_DIDS: z.string().default(""),

  //
  // State-inspector remote dump endpoint (`cf inspect --remote`).
  //
  // Exposes raw, read-only space SQLite snapshots over HTTP for offline
  // autopsy. This is a STAGING-ONLY debugging tool: it hard-refuses to mount
  // under ENV=production with no override (a productionized form is a separate,
  // access-controlled mechanism — not this endpoint). A space dump is the
  // entire contents of a space, so access is gated by CF1 first-party signature
  // auth + a DID allowlist, and every dump is audit-logged. See
  // routes/storage/memory/memory-dump.index.ts.
  //

  // Master switch. Unset/"false" => the endpoint 404s as if it did not exist.
  // Mounting ALSO requires ENV to be a recognized non-production value
  // (development | test | staging) — unknown/alias envs fail closed. See
  // routes/storage/memory/memory-dump-policy.ts.
  MEMORY_DUMP_ENABLED: flagValue(),
  // Comma-separated DIDs allowed to download dumps, in ADDITION to
  // MEMORY_SERVICE_DIDS. Empty => only MEMORY_SERVICE_DIDS may dump.
  MEMORY_DUMP_DIDS: z.string().default(""),

  // In development, you can optionally proxy the upstream SHELL
  SHELL_URL: z.string().optional(),

  // EXPERIMENTAL_* feature flags are no longer declared here: the runtime
  // construction site reads them through the canonical mapping
  // (`experimentalOptionsFromEnv` / EXPERIMENTAL_ENV_VARS in
  // @commonfabric/runner runtime-presets), shared with the CLI so the wirings
  // cannot drift (CT-1814).

  // Git SHA of the deployed commit. Set at deploy time; takes priority over
  // the build-baked SHA (see lib/build-info.ts).
  TOOLSHED_GIT_SHA: z.string().optional(),
  // Source-run build metadata fallback for /api/meta, mirroring the gitSha a
  // compiled binary reads from its baked COMPILED file.
  COMMIT_SHA: z.string().optional(),

  //
  // Sandbox Service
  //
  //   * /routes/sandbox/exec
  //

  SANDBOX_SERVICE_URL: z.string().default(
    "https://sandbox.stage.commontools.dev",
  ),

  // URL that sandboxes should use to reach the toolshed API (injected as
  // CF_API_URL into every sandbox exec). Defaults to API_URL if not set.
  SANDBOX_TOOLSHED_URL: z.string().optional(),
});

export type env = z.infer<typeof EnvSchema>;

// CLI args override env vars (needed for --watch compatibility)
const cliOverrides = parseCliArgs();
const { data: env, error } = EnvSchema.safeParse({
  ...Deno.env.toObject(),
  ...cliOverrides,
});

if (error) {
  console.error("❌ Invalid env:");
  console.error(JSON.stringify(error.flatten().fieldErrors, null, 2));
  Deno.exit(1);
}

export default env!;
