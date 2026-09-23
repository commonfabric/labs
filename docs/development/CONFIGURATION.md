# Configuration Reference

A categorized reference for environment variables, build flags, CLI args, and
developer tasks across the Common Fabric labs repo.

This doc is **not** the source of truth — it points to the schemas that are.
For exhaustive, always-current lists check the Zod schemas linked at the top
of each section.

| Component | Schema file |
|---|---|
| Toolshed (server) | [`packages/toolshed/env.ts`](../../packages/toolshed/env.ts) |
| Shell (browser, build-time) | [`packages/shell/felt.config.ts`](../../packages/shell/felt.config.ts), [`packages/shell/src/lib/env.ts`](../../packages/shell/src/lib/env.ts) |
| Background piece service | [`packages/background-piece-service/src/env.ts`](../../packages/background-piece-service/src/env.ts) |
| CLI | [`packages/cli/launcher.ts`](../../packages/cli/launcher.ts), [`packages/cli/mod.ts`](../../packages/cli/mod.ts) |
| cf-harness | [`packages/cf-harness/src/cli.ts`](../../packages/cf-harness/src/cli.ts), [`packages/cf-harness/src/provenance.ts`](../../packages/cf-harness/src/provenance.ts) |
| Integration tests | [`packages/integration/env.ts`](../../packages/integration/env.ts) |
| Experimental flags | [`docs/development/EXPERIMENTAL_OPTIONS.md`](./EXPERIMENTAL_OPTIONS.md) |

When defaults shown here disagree with the schema, the schema wins — please
update this doc.

---

## Server / core

Required only if you're running the toolshed.

| Var | Default | Notes |
|---|---|---|
| `ENV` | `development` | `development`, `production`, or `test`. `ENV=test` is required by the test runner, and marks a unit-suite run in cf-harness provenance. |
| `HOST` | `0.0.0.0` | Bind address. |
| `PORT` | `8000` | Server port. Also overridable via the `--port=N` CLI arg (used by `deno --watch`, which doesn't forward env vars). |
| `LOG_LEVEL` | `info` | One of `fatal`, `error`, `warn`, `info`, `debug`, `trace`, `silent`. |
| `DISABLE_LOG_REQ_RES` | `false` | Suppress per-request log lines. |
| `CACHE_DIR` | `./cache` | Local disk cache root. |
| `API_URL` | `http://localhost:8000` | Self-referential URL used for internal server-to-server requests, and the audience authority every first-party proof on the signed invitation and inbox routes is checked against. Set it to the public origin clients dial, or those routes refuse every correctly signed request; the server prints it at startup as its configured first-party authority. |
| `SHELL_URL` | _(unset)_ | When set, toolshed proxies non-API paths to this upstream — used by local dev to route to the Shell dev server on `:5173`. |

---

## LLM providers

A provider's models are **only registered when its env var is set**. See
[`packages/toolshed/routes/ai/llm/models.ts`](../../packages/toolshed/routes/ai/llm/models.ts)
for the registration logic — that file is the whole provider abstraction, and
[`docs/features/llm-provider-boundary.md`](../features/llm-provider-boundary.md)
explains why it lives in the toolshed rather than in `@commonfabric/llm`.

| Var | Provider |
|---|---|
| `CFTS_AI_LLM_ANTHROPIC_API_KEY` | Anthropic (Claude) |
| `CFTS_AI_LLM_OPENAI_API_KEY` | OpenAI |
| `CFTS_AI_LLM_GROQ_API_KEY` | Groq |
| `CFTS_AI_LLM_GOOGLE_APPLICATION_CREDENTIALS` + `CFTS_AI_LLM_GOOGLE_VERTEX_PROJECT` + `CFTS_AI_LLM_GOOGLE_VERTEX_LOCATION` | Google Vertex AI |

> Note: toolshed uses the `CFTS_AI_LLM_` prefix (not the conventional
> `ANTHROPIC_API_KEY`, etc.). The exact variable names are required.

### LLM gateway

| Var | Default | Notes |
|---|---|---|
| `CFTS_AI_GATEWAY_URL` | `https://llm.stage.commontools.dev` | OpenAI-compatible `/v1/models` endpoint. Toolshed probes it as it starts up, alongside binding its port rather than ahead of it; reachable models are registered and `gateway:claude-sonnet-5` becomes the default when present. **The default URL is Tailscale-only — external users will not be able to reach it.** That fallback path is supported: an unreachable gateway logs a warning and the direct-provider models continue to work. A request naming a direct-provider model such as `anthropic:claude-sonnet-4-6` is served while the probe is still out, because that model was registered as toolshed loaded. What waits for the probe is a request naming a model that is not registered yet — a `gateway:` one, the `default` alias, or a name that is no model at all — and `GET /models`, which answers for the whole list. Off Tailscale that wait is however long the connection takes to fail, so set to `""` to skip the probe entirely. |

**Default model resolution order** (defined in `models.ts` as
`DEFAULT_MODEL_CANDIDATES`):

1. `gateway:claude-sonnet-5`
2. `gateway:gpt-5.6-luna`
3. `gateway:gemini-3.5-flash`

The first available candidate becomes the `default` alias and the value used
for `TASK_MODELS.coding` / `TASK_MODELS.json`. Only these candidates can become
the default. If none is registered, the alias remains unavailable even when
other language models are registered. A request naming an unavailable `default`
or an unknown model is rejected.

---

## Other AI services

| Var | Purpose |
|---|---|
| `FAL_API_KEY` | `/routes/ai/img` (image gen), `/routes/ai/voice` (transcription). |
| `JINA_API_KEY` | `/routes/agent-tools/web-read` (page extraction), `/routes/link-preview` (link previews). |

---

## OAuth integrations

All blank by default. Each integration is gated on its `_CLIENT_ID` /
`_CLIENT_SECRET` pair; routes return 404 / fail predictably if not set.

| Service | Vars |
|---|---|
| Google | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` |
| GitHub | `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` |
| Notion | `NOTION_CLIENT_ID`, `NOTION_CLIENT_SECRET` |
| Linear | `LINEAR_CLIENT_ID`, `LINEAR_CLIENT_SECRET` |
| Spotify | `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET` |
| Discord | `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET` |
| Strava | `STRAVA_CLIENT_ID`, `STRAVA_CLIENT_SECRET` |
| Airtable | `AIRTABLE_CLIENT_ID`, `AIRTABLE_CLIENT_SECRET` |

### Plaid

| Var | Default | Notes |
|---|---|---|
| `PLAID_CLIENT_ID` / `PLAID_SECRET` | _(unset)_ | |
| `PLAID_ENV` | `sandbox` | `sandbox` \| `development` \| `production`. |
| `PLAID_PRODUCTS` | `transactions` | Comma-separated. |
| `PLAID_COUNTRY_CODES` | `US` | |
| `PLAID_REDIRECT_URI` | _(unset)_ | Optional. |
| `PLAID_SYNC_ALL_TRANSACTIONS` | `false` | Sync full history vs. incremental. |

---

## Identity & auth

There are three interacting identity concepts. Pick one column based on which
process you're configuring.

| Process | Path-to-keyfile var | Passphrase var | Default fallback |
|---|---|---|---|
| Toolshed | `IDENTITY` | `IDENTITY_PASSPHRASE` _(deprecated)_ | `"implicit trust"` (dev only) |
| Background piece service | `IDENTITY` | `OPERATOR_PASS` | `"implicit trust"` (dev only) |
| CF CLI | `CF_IDENTITY` env or `--identity <path>` | _(none)_ | _(none — error if remote)_ |

For local dev, all three default to the implicit-trust passphrase so they
share an identity automatically. To match the CLI to the local server (only
needed for operator/admin tasks on your own localhost):

```bash
deno run -A packages/cli/mod.ts id derive "implicit trust" > claude.key
export CF_IDENTITY=./claude.key
```

`"implicit trust"` is a shared, publicly-derivable identity — never use it
against a shared or remote server (everyone who derives it becomes the same
principal). For a personal or unique identity, use `id new`. See
[`docs/features/shared-identity.md`](../features/shared-identity.md) for the
browser-import flow.

---

## Memory store

The toolshed-embedded memory service has two modes:

| Var | Default | Notes |
|---|---|---|
| `MEMORY_DIR` | `./cache/memory/` (as a `file://` URL) | **Directory mode** — one SQLite file per space. Default; backwards-compatible. |
| `DB_PATH` | _(unset)_ | **Single-file mode** — absolute path to one SQLite database holding every space, instead of a file per space. Takes precedence over `MEMORY_DIR`. Validated as an absolute path. |
| `MEMORY_URL` | `http://localhost:8000` | Where other components reach the memory service. |
| `MEMORY_ACL_MODE` | `enforce` | Space ACL policy: `off`, `observe`, or `enforce`. `observe` logs ordinary access shortfalls, while malformed ACLs and fresh-space genesis violations still fail closed. |
| `MEMORY_DOCUMENT_CACHE_BUDGET_BYTES` | _(engine default, 128 MiB)_ | Byte budget of each space's decoded-document cache on the memory server, in encoded UTF-8 bytes of the documents as stored (expect a few times that in heap per active space; a Topics-board page load retains ~18 MB across ~13,300 documents). Least-recently-read eviction under a budget smaller than a corpus's working set serves nothing, so lower it only with `/api/health/stats` → `documentCaches` in view: `evictions` climbing for a space being read repeatedly means it no longer fits, and `patchReplays` far above `misses` means a document under a run of patch commits is being lost between the commits that write it, each one rebuilding it from its base or snapshot rather than from the revision before it. A resident document still costs one row per commit, so the ratio is the signal rather than the count. |
| `MEMORY_DOCUMENT_CACHE_MAX_ENTRIES` | _(engine default, 65536)_ | Entry cap of the same cache — the cardinality backstop beside the byte budget, kept well above any real working set (a Topics-board page load is ~13,300 documents). |
| `MEMORY_DOCUMENT_CACHE_TOTAL_BUDGET_BYTES` | _(server default, 256 MiB)_ | Bound across every space's document cache on the memory server this process hosts, held as documents are cached, least-recently-used space first. The per-space budget decides what one corpus may keep; this decides what the server keeps in total (one memory server per toolshed process, so in deployment: the process). `documentCaches.totalBudgetEvictions` on `/api/health/stats` counts what holding it has cost. |
| `RATE_LIMIT_TRUST_FORWARDED_FOR` | `false` | Set to `true` ONLY when a trusted reverse proxy that overwrites `X-Forwarded-For` sits in front of toolshed. Control-plane rate limiting keys on the real TCP peer by default. Enabling it without such a proxy makes the header client-controlled and the limiter a no-op; leaving it off behind a proxy collapses every caller onto one bucket. |
| `MEMORY_SERVICE_DIDS` | _(empty)_ | Comma-separated DIDs with implicit OWNER on every space. These identities may initialize ACLs but still cannot make an ordinary first write before genesis. |
| `CF_MEMORY_FRAME_LOG` | _(unset)_ | Read by the memory **client** (`packages/memory/v2/client.ts`), in every Deno process that opens one — `cf` is the usual one — and never in a browser. Path of a file it appends one JSON line per wire frame to, in both directions: the frame's type and uncompressed UTF-8 size; for a watch mutation, its roots and their selectors, each distinct selector written once as a separate `dir: "selector"` line and named by its hash after; for a commit, its operations and the shape of its read set, including how many reads assert a document absent; for a response or pushed sync, every document delivered with its size and its first twelve top-level keys — a key past that limit is not recorded, so its absence from the record says nothing about the document. It answers what a request carried and what came back, which neither the timing statistics nor the server's slow-query buffer record. [`debugging/profiling.md`](./debugging/profiling.md#what-the-client-sent-and-what-came-back) says how to read the file. |
| `CF_SLOW_QUERY_THRESHOLD_MS` | `100` | Operations slower than this land in `slowQueries` on `/api/health/stats`, with the per-operation root, read and upsert counts described in [`debugging/profiling.md`](./debugging/profiling.md#read-apihealthstats). A local investigation on a fast machine sets it lower — `0` records every operation — since the default leaves a 90 ms watch that delivered ten thousand documents invisible. The buffer holds the last hundred either way. |

With ACL policy active, a fresh space is read-only until its space identity or a
configured service DID writes a valid ACL with a concrete OWNER. A populated
space that has never had an ACL remains authenticated-public READ/WRITE as a
temporary pre-launch compatibility rule; public access never includes OWNER.
Retracted, malformed, and ownerless ACLs fail closed.
Normal fresh named-space bootstrap writes the genesis document the caller
registered beside the space key (`registerSpaceIdentity(identity,
{ genesisAcl })`), else the fallback `{ [activeUser]: "OWNER", "*": "WRITE" }`,
so new non-home spaces that asked for nothing are public read/write until ACL
management has a UI. Home bootstrap remains owner-only. The wildcard is a
default, not a fixture: a caller can supply its own document at genesis, and
the space's owner can narrow it afterwards with `cf acl remove ANYONE` (see
[tutorial chapter 10](../tutorial/10-identity-and-security.md#reading-and-changing-a-spaces-acl)).
Whatever writes the ACL must send it as a single whole-document replacement —
the server's admission rules for ACL commits are INV-12 and INV-13 in
[`docs/specs/memory-v2/09-invariants.md`](../specs/memory-v2/09-invariants.md).

---

## Sandbox service

Used by `/routes/sandbox/exec` to execute untrusted pattern code.

| Var | Default | Notes |
|---|---|---|
| `SANDBOX_SERVICE_URL` | `https://sandbox.stage.commontools.dev` | External sandbox executor. |
| `SANDBOX_TOOLSHED_URL` | _(falls back to `API_URL`)_ | URL injected into sandboxes as `CF_API_URL` so they can call back to this toolshed. |

The executor itself is not in this repo; the toolshed only forwards to
`SANDBOX_SERVICE_URL`. The service is `commonfabric/common-cluster` (Go): its
`node-agent` serves `/v1/sandboxes` and runs each sandbox as a gVisor container
on a per-node ZFS dataset. The `runsc` runtime and `sandboxexec` library come
from `commonfabric/gvisor` (branch `cfc_v2`), and the cluster is provisioned by
`commonfabric/infra` (Terraform).

---

## OpenTelemetry

Off by default; flip `OTEL_ENABLED=true` to start exporting.

| Var | Default | Notes |
|---|---|---|
| `OTEL_ENABLED` | `false` | |
| `OTEL_SERVICE_NAME` | `toolshed` | Also read by cf-harness, independently of `OTEL_ENABLED`, to name the service that launched it. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://localhost:4318` | |
| `OTEL_TRACES_SAMPLER` | `always_on` | |
| `OTEL_TRACES_SAMPLER_ARG` | `1.0` | |

---

## Build info

| Var | Default | Notes |
|---|---|---|
| `TOOLSHED_GIT_SHA` | _(unset)_ | Explicit toolshed commit override, surfaced via `lib/build-info.ts`. Takes priority over the build-baked SHA for `/api/meta`. |
| `COMMIT_SHA` | _(unset)_ | Source-run build metadata fallback. It lets `/api/meta` present the same `gitSha` field that a compiled toolshed obtains from baked metadata. On a compiled toolshed, baked metadata takes priority. The system-pattern updater does not consult this value. |

Set `COMMIT_SHA` to the Labs revision that describes a source checkout when you
want source-run metadata to match compiled-binary metadata. A parent start
script can export it once so toolshed and shell diagnostics describe the same
checkout; `scripts/start-local-dev.sh` defaults it to the checkout's HEAD. It is descriptive metadata, not update authorization; only stamp a
revision that actually describes the launched sources. The explicit
toolshed-only `TOOLSHED_GIT_SHA` override remains highest priority.

The compilation cache for compiled patterns is the content-addressed cell
cache (always on under an enforcing CFC mode; see
`packages/runner/src/compilation-cache/cell-cache.ts`). The former
`COMPILATION_CACHE_*` env vars configured an earlier whole-bundle cache and no
longer exist.

---

## Runner diagnostics

Environment toggles read by `packages/runner` when it starts. None of them
change what a traversal computes; they decide what it records about itself.
All are off by default, and each is read once, so a process picks up a change
to the environment only on restart.

A test therefore cannot switch one on by setting the variable. For doc-visit
diagnostics, call `setTraverseDiagnostics(true)` from
`packages/runner/src/traverse.ts`, which overrides the variable for the process
and is read again at the start of every traversal; pass `undefined` to hand the
decision back to the environment. For captures, construct a
`TraverseCaptureRecorder` directly, as `traverse-replay.test.ts` does — the
variables only decide whether the module installs one of its own on startup.

| Var | Default | Notes |
|---|---|---|
| `CF_TRAVERSE_DIAGNOSTICS` | _(unset)_ | Set to exactly `1` to count, for each traversal, how many times it visited each doc and how many distinct doc-and-path pairs it reached. Only the slow-traverse warning reads those counts. Without this, that warning reports `uniqueDocs=0`, `uniquePaths=0`, and `topDocs=n/a`. It is off by default because the tracking builds a string and touches a `Map` and a `Set` on every schema visit, which is measurable on large traversals. |
| `CF_TRAVERSE_CAPTURE` | _(unset)_ | Path to write a traverse fixture to. Every `SchemaObjectTraverser.traverse()` call is recorded in order, along with the value of each doc it visited, and written to that path periodically and on unload. `packages/runner/test/traverse-replay/replay.ts` replays a fixture against a read-only transaction; `packages/runner/src/traverse-recorder.ts` documents the fidelity limits, of which the important one is that a doc written during the run replays with its earliest captured value. |
| `CF_TRAVERSE_CAPTURE_MAX` | `20000` | How many invocations one capture records before it stops. Anything that is not a finite number above zero falls back to the default. Read only when `CF_TRAVERSE_CAPTURE` is set. |

---

## Experimental flags

[`docs/development/EXPERIMENTAL_OPTIONS.md`](./EXPERIMENTAL_OPTIONS.md) is the
central registry of every experimental flag: what each gates, who added it, its
default, its planned end state, and its removal path, plus the propagation paths
(server / shell / bg-piece / CLI) and verification steps. Briefly:

- Server-side toggles take effect on restart.
- Server-authoritative flags propagate to clients not built alongside the
  server (cf among them) on their own: the server publishes its resolved
  posture on `/api/meta` and those clients adopt it at boot. An explicit
  `EXPERIMENTAL_*` still wins per flag, and `CF_ADOPT_SERVER_FLAGS=false`
  turns adoption off wholesale.
- Everywhere else — the shell included — the same env var must be set wherever
  the flag is read; shell-side that means a build-time define, so toggling
  requires a rebuild, and only the flags the shell defines can be toggled there
  at all; `packages/shell/felt.config.ts` and `packages/shell/src/lib/env.ts`
  say which.

The environment-backed flags (the only ones settable without editing code) are
declared once in `EXPERIMENTAL_ENV_VARS`
(`packages/runner/src/runtime-presets.ts`), which is the authority; today
that is:

| Flag | Env var |
|---|---|
| `modernCellRep` | `EXPERIMENTAL_MODERN_CELL_REP` |
| `contentAddressedSchemas` | `EXPERIMENTAL_CONTENT_ADDRESSED_SCHEMAS` |
| `plainResultReceipts` | `EXPERIMENTAL_PLAIN_RESULT_RECEIPTS` |
| `computedCellIds` | `EXPERIMENTAL_COMPUTED_CELL_IDS` |
| `lazyMaterialization` | `EXPERIMENTAL_LAZY_MATERIALIZATION` |
| `readerSchemaPrecedence` | `EXPERIMENTAL_READER_SCHEMA_PRECEDENCE` |
| `serverExecution` | `EXPERIMENTAL_SERVER_EXECUTION` |

The runtime-only flags (`commitPreconditions`, the CFC enforcement dials) and the
storage, memory-protocol, and shell flags are documented in the registry. See it
for the complete list.

---

## Shell (browser)

Most shell config is **build-time**: esbuild injects defines in
`packages/shell/felt.config.ts` and they become globals read by
`packages/shell/src/lib/env.ts`. Browser-side changes require a rebuild.

| Build-time var | Runtime global | Default | Notes |
|---|---|---|---|
| `PRODUCTION` | `$ENVIRONMENT` (`"production"` if set, else `"development"`) | _(unset = dev)_ | Triggers minified bundle and disables sourcemaps. |
| `API_URL` | `$API_URL` | falls back to `location.origin` | Backend the shell calls. |
| `PRESENCE_URL` | `$PRESENCE_URL` | _(unset)_ | WebSocket endpoint provided to collaborative editors for ephemeral co-presence. Must be a credential-free `ws:`/`wss:` URL; `packages/shell/src/lib/presence-url.ts` rejects anything else and fails the build. When unset, editor co-presence stays disabled unless a component supplies its own endpoint. Both deployed shells take it from a repository variable — see [Deploying a commit](./deploying.md). |
| `COMMIT_SHA` | `$COMMIT_SHA` | _(unset)_ | Surfaced for diagnostics and used by deployed shells to select the immutable `/builds/<sha>` worker asset graph. In development the explicit worker URL remains `/scripts/worker-runtime.js`. It does not authorize system-pattern updates. |
| `EXPERIMENTAL_*` (`MODERN_CELL_REP`, `COMPUTED_CELL_IDS`, `SERVER_EXECUTION`, `CONTENT_ADDRESSED_SCHEMAS`, `READER_SCHEMA_PRECEDENCE`) | `EXPERIMENTAL.<flag>` | _(unset)_ | Per-flag build-time values; changing one requires a rebuild. See experimental flags. |
| `SHELL_PORT` | _(server-only)_ | `5173` (from `ports.json`) | Dev server port. |

---

## CLI (`cf`)

The `cf` CLI is invoked via the launcher in
[`packages/cli/launcher.ts`](../../packages/cli/launcher.ts), which discovers
the labs checkout and dispatches to `packages/cli/mod.ts`.

### Env vars

| Var | Default | Notes |
|---|---|---|
| `CF_IDENTITY` | _(none)_ | Path to identity keyfile. Required for the server-touching commands — `cell`, `piece`, `space recreate-root`/`set-home`, `wish`, `acl`, `exec` — against a remote toolshed. |
| `CF_API_URL` | _(none)_ | Toolshed URL. Required for the same commands as above. |
| `CF_SPACE` | _(none)_ | The space a command acts on, when `--space` is absent. Read by `cell`, `piece`, `space recreate-root`, `wish`, `acl` and `deps`. `check`, `fuse` and `ingest` take a space and do not read it, and neither does `space set-home`, which acts on the identity's own home space and declares the option only through the shared target flags. `--space` overrides it, and a written `--space` beside `--url` is still refused where an ambient one yields to the space the URL carries. A command that writes names the space it wrote to on stderr, which is what makes an ambient default safe to leave set. |
| `CF_INVOCATION_SESSION` | _(none)_ | Invocation session `cf piece call` scopes an invocation id to. Mint one per agent run with `cf invocation-session new`. Carried here rather than as `--invocation-session <id>` because the session is what makes a call's outcome unguessable, and an argument is readable in a process listing. |
| `CF_LOG_LEVEL` | `error` | `debug` \| `info` \| `warn` \| `error` \| `silent`. Also settable per-invocation with `--log-level`. |
| `CF_CLI_NAME` | `cf` | Override the displayed CLI name (for branded builds). |
| `CF_CLI_TRACE_TIMINGS` | `0` | Set to `1` for detailed timing traces. |
| `CF_SKIP_VERSION_CHECK` | _(unset)_ | Set to any non-empty value to skip the cf ↔ server version check. By default, server-touching commands compare this cf's commit (baked build metadata, or the checkout's HEAD for source runs) with the server's self-reported commit — the `gitSha` riding the `/_health` response the health check already fetches (same value as `/api/meta`) — and warn on stderr when they differ. Source runs grade the warning by git ancestry: cf newer than the server is the normal local-dev case and stays silent unless the command fails, where its note prints as neutral version context. Commit distance alone does not establish incompatibility or explain a failure. `cf piece call` suppresses the held note for confirmed unknown verbs, rejected payloads, and argument validation failures before dispatch; cf **older** than the server gets the loud OUTDATED warning immediately; diverged or unorderable pairs (including all compiled binaries, which carry no history) get the undirected wording immediately. |
| `CF_ADOPT_SERVER_FLAGS` | `true` | Set to `false` to keep this process on its own `EXPERIMENTAL_*` posture instead of adopting the one the toolshed publishes on `/api/meta`. A cf binary is installed independently of the server it talks to, so by default it takes the deployment's experimental flags and lets an explicit `EXPERIMENTAL_*` override them per flag; this turns the mechanism off wholesale when a deployment publishes something this client cannot run. Read by every client that is not built alongside its server — cf, the pieces controller behind a FUSE mount, the agents host, `cast-admin`. See [the flag registry](./EXPERIMENTAL_OPTIONS.md#clients-that-are-not-built-alongside-their-server). |
| `CF_CLI_INTEGRATION_USE_LOCAL` | _(unset)_ | Used by integration tests to dispatch through local source rather than a built binary. |
| `CF_LABS_ROOT` | _(unset)_ | Read by `bin/cf` only. Selects which labs checkout answers, overriding the nearest one walking up from the cwd. Must be a checkout (a directory with `packages/cli/launcher.ts`) or `bin/cf` exits 2. Chooses the CLI, not the working directory. |

### Global args

| Arg | Notes |
|---|---|
| `--log-level <level>` | Equivalent to `CF_LOG_LEVEL`. |
| `--help`, `help` | Usage text. |

### Per-command args

`piece`, `acl`, `exec`, and `fuse` accept their own subcommand options
(`-i,--identity`, `-a,--api-url`, `-s,--space`, etc.). Use `cf <command> --help`
for the authoritative list — it's not duplicated here.

### Launcher args

Passed before the CLI args; rarely needed:

| Arg | Default | Notes |
|---|---|---|
| `--deno <path>` | system `deno` | Use a specific Deno binary. |
| `--labs-root <path>` | auto-detected from launcher location | Override the labs checkout root. |
| `--config <path>` | `<labs-root>/deno.jsonc` | Override the Deno config. |
| `--cli-entrypoint <path>` | `<labs-root>/packages/cli/mod.ts` | Override the CLI entry. |
| `--cwd <path>` | `INIT_CWD` env or `process.cwd()` | Override the working directory passed to the CLI. |

---

## cf-harness

Environment reading for the harness lives in
[`packages/cf-harness/src/cli.ts`](../../packages/cf-harness/src/cli.ts), which
resolves the gateway, model, sandbox, and credential settings, and in
[`packages/cf-harness/src/provenance.ts`](../../packages/cf-harness/src/provenance.ts),
which reads the variables below.
[`packages/cf-harness/README.md`](../../packages/cf-harness/README.md) is the
reference for the full set.

### Provenance

Every request the harness sends to the LLM gateway says what caused it, so
gateway traffic can be read by the workload behind it. These variables govern
what it reports;
[`docs/features/gateway-request-provenance.md`](../features/gateway-request-provenance.md)
states the invariants.

| Var | Default | Notes |
|---|---|---|
| `CF_HARNESS_PRINCIPAL` | _(generated)_ | Declares the label naming this machine. Generated on first use and kept in `$CF_HARNESS_HOME/principal` otherwise. |
| `CF_HARNESS_INTEGRATION` | _(unset)_ | Set to `1` to report the invoker as `integration-test`. Nothing else reads it. |

The invoker is read from the environment rather than declared: `ENV=test`
marks the unit suite, `GITHUB_ACTIONS` or `CI` a continuous-integration run,
`OTEL_SERVICE_NAME` a service, and a Loom run manifest a Loom dispatch.
`CF_HARNESS_INTEGRATION` is the exception, declared by hand. A test run keeps
no principal, so it never writes to the harness home.

The harness also reads variables it does not define: `OTEL_SERVICE_NAME` for
the service that launched it, `ENV=test` to recognize the unit suite,
`GITHUB_ACTIONS` and `CI` for a continuous-integration run, and `CLAUDECODE` and
`CODEX_SANDBOX` for the coding-agent session it is running inside.

---

## Background piece service

| Var | Default | Notes |
|---|---|---|
| `OPERATOR_PASS` | `"implicit trust"` | Passphrase for implicit identity. Must match toolshed's identity in dev. |
| `IDENTITY` | _(unset)_ | Path to keyfile; takes precedence over `OPERATOR_PASS`. |
| `API_URL` | `http://localhost:8000` | Toolshed URL the service calls. |
| `EXPERIMENTAL_MODERN_CELL_REP` | _(unset)_ | See experimental flags. |

---

## Integration tests

[`packages/integration/env.ts`](../../packages/integration/env.ts) reads these
when you run `deno task integration`:

| Var | Default | Notes |
|---|---|---|
| `API_URL` | `http://localhost:8000/` | Toolshed under test. |
| `FRONTEND_URL` | `API_URL` | Override when testing the shell dev server directly (`http://localhost:5173`). |
| `HEADLESS` | `false` | Browser tests headless when `true`. |
| `PIPE_CONSOLE` | `false` | Pipe browser console output into the test runner. |
| `SPACE_NAME` | random UUID | Stable name for cross-run debugging. |

Additionally, [`tasks/integration.ts`](../../tasks/integration.ts) sets
`INTEGRATION_TEST_FLAGS` (default: unset; populated with `--junit-path=…` when
`--junit-dir` is passed, or passed through from the environment otherwise).
Per-package `deno.jsonc` `integration` scripts pick it up via `$INTEGRATION_TEST_FLAGS`
shell expansion to forward extra `deno test` flags (e.g. `--filter`).

---

## Tasks

### Workspace root (`deno task <name>` from repo root)

| Task | What it does |
|---|---|
| `check` | Type-check all packages (`./tasks/check.sh`). |
| `test` | Run all package tests (`./tasks/test.ts`). |
| `integration` | Run integration tests (`./tasks/integration.ts`). |
| `build-binaries` | Build all standalone binaries, build only the named targets passed after the task (`toolshed`, `bg-piece-service`, or `cf`), or use the legacy `deno task build-binaries --cli-only` alias to build only `cf`. |
| `cf` | Run the CLI via the launcher. |
| `initialize-db` | Initialize the local development database. |
| `install-hooks` | Install git pre-commit hooks. |
| `profile` | Restart local dev with `--inspect-brk` for profiling. |
| `cf-profile`, `cf-inspect-brk`, `cf-profile-brk` | Profile / debug the CF CLI. |

### Toolshed (`packages/toolshed`)

| Task | What it does |
|---|---|
| `dev` | Hot-reload server reading `.env` (`--watch`). |
| `production` | Server without `--watch`. |
| `test` | `ENV=test` with `.env.test`. |
| `llm-exercise` | Smoke-test configured LLM providers. |

### Shell (`packages/shell`)

| Task | What it does |
|---|---|
| `dev` | Build against the cloud toolshed at `toolshed.saga-castor.ts.net`. Use this for shell-only work. |
| `dev-local` | Build against `http://localhost:$TOOLSHED_PORT`. **Use this for local dev** — `dev` points at the cloud backend. |
| `build` / `production` | Optimized build (`production` sets `PRODUCTION=1`). |
| `serve` | Serve pre-built `dist/` on `0.0.0.0:9099`. |
| `test`, `integration` | Test suites. |

### CLI (`packages/cli`)

| Task | What it does |
|---|---|
| `cli` | Run the CLI via the launcher (handles cwd / config discovery). |
| `cli-no-pwd-override` | Run `mod.ts` directly without the launcher. |
| `test` | Unit tests. |
| `integration`, `fuse-integration`, `acl-integration` | Integration suites against a local toolshed. |

### Background piece service (`packages/background-piece-service`)

| Task | What it does |
|---|---|
| `start` | Run from source. |
| `add-admin-piece` | One-time setup: cast the admin piece into the system space. |
| `test` | Run unit tests. |
| `check` | Type-check source files. |
| `lint` | Lint source files. |
| `fmt` | Format package files. |
| `help` | Service help. |

---

## Where defaults live

- **Numeric / boolean / string defaults**: in the Zod `.default(...)` clauses of
  the relevant `env.ts`.
- **URLs that vary per environment**:
  - `CFTS_AI_GATEWAY_URL` → `https://llm.stage.commontools.dev` (Tailscale-only).
  - `SANDBOX_SERVICE_URL` → `https://sandbox.stage.commontools.dev`.
  Both fall back gracefully when unreachable, but expect logs warning about
  the failed probes if you're off the corporate network.
- **`"implicit trust"`** appears as the identity-passphrase default in three
  places (toolshed `IDENTITY_PASSPHRASE`, bg-service `OPERATOR_PASS`, and the
  CLI dev recipe). They must match for those three processes to share an
  identity in local dev.

---

## Common scenarios (quick recipes)

**External contributor, local dev, no LLMs needed:**
```bash
# Just defaults work. The gateway probe will warn but is harmless.
./scripts/start-local-dev.sh
```

**Local dev with Anthropic models only:**
```bash
# In packages/toolshed/.env:
CFTS_AI_LLM_ANTHROPIC_API_KEY=sk-ant-...
CFTS_AI_GATEWAY_URL=""        # silence the off-Tailscale gateway probe
```

Name a registered Anthropic model explicitly in LLM requests. This setup has no
gateway candidate for the `default` alias.

**Local dev, on Tailscale, using the gateway:**
```bash
# Defaults are fine. CFTS_AI_GATEWAY_URL already points at stage.
# default prefers gateway:claude-sonnet-5 when it is registered.
```

**Production deploy:**
```bash
ENV=production
TOOLSHED_GIT_SHA=<deploy-sha>
# Provider keys, OAuth secrets, MEMORY_URL, etc. as appropriate.
```
