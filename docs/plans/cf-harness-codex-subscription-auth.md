# cf-harness Codex Subscription Authentication — Implementation Plan

Status: Implemented in `cf-harness` and covered by automated tests. Remaining
shipping gates are live-account smoke tests, security review, and Loom host/UI
policy wiring.

Validation snapshot (2026-07-29): the repository pins Deno 2.9.4. The aggregate
root `deno task check` and `deno task test` pass, including the `cf-harness`
checks and tests.

This plan adds an opt-in way for a `cf-harness` user to use their ChatGPT/Codex
subscription instead of an OpenAI Platform API key, first through the local CLI
and then through Loom. It keeps `cf-harness` in charge of the bounded model/tool
loop, transcript, tool execution, CFC decisions, and artifacts in both hosts.

Loom support is a shipping goal. The security boundary is per-user credential
ownership: Loom must resolve the initiating user's explicitly connected
subscription and must never fund unrelated users or background work from a
service-wide or operator-ambient subscription.

## Status convention

- [ ] Not started
- [x] Complete and verified

Mark a parent complete only after its child checks and completion gate pass.
Keep this live plan accurate as implementation proceeds. When the final stage
lands or the plan is abandoned, archive it under `docs/history/plans/` as
described in `docs/README.md`.

## Research snapshot

The external comparison was refreshed on 2026-07-22. Links below are pinned to
the reviewed commits so later upstream changes do not silently change this
plan's evidence.

### OpenCode

OpenCode implements Codex subscription auth as a built-in OpenAI provider
plugin. Its relevant behavior is concentrated in
[codex.ts][opencode-codex]:

- browser OAuth uses authorization code + PKCE with a localhost callback;
- headless OAuth uses OpenAI's device-code endpoints;
- access, refresh, expiry, and ChatGPT account id are stored in OpenCode's
  type-tagged auth store with file mode `0600`;
- the provider refreshes expired access tokens and persists rotated tokens;
- a custom `fetch` removes the SDK's API-key header, adds the OAuth bearer token
  and `ChatGPT-Account-Id`, and rewrites Responses requests to the ChatGPT Codex
  endpoint;
- the ordinary `openai` model namespace remains in use, but OAuth changes model
  availability and cost display.

This is a compact integration, but it couples OAuth, request rewriting, model
filtering, WebSocket behavior, and provider hooks in one module. It also uses a
dummy API key to satisfy the surrounding SDK. Those are framework-specific
choices, not a structure to copy into `cf-harness`.

### pi

pi exposes `openai-codex` as a separate provider. It has the cleanest separation
to imitate:

- [openai-codex.ts][pi-oauth] owns OAuth login, refresh, account-id extraction,
  and conversion from stored OAuth credentials to request auth;
- [resolve.ts][pi-auth-resolution] keeps provider auth resolution separate from
  transport, refreshes under serialized credential-store mutation, and does not
  silently fall back to ambient credentials after refresh failure;
- [openai-codex-responses.ts][pi-responses] owns the ChatGPT Codex Responses
  wire format, including SSE/WebSocket streaming, `store: false`, encrypted
  reasoning continuation, prompt-cache affinity, account headers, usage-limit
  errors, and Responses item conversion;
- [auth-storage.ts][pi-auth-storage] persists one type-tagged credential per
  provider and serializes cross-process read/modify/write operations.

The separation of provider, auth, credential storage, and transport is the main
design to adopt. The first `cf-harness` slice should not copy pi's WebSocket
pool, transport retry loops, or large compatibility surface.

### OpenClaw and official Codex app-server

OpenClaw takes a different route: it can run the official Codex app-server,
bridge its own tools through experimental dynamic tools, and let Codex own
login, refresh, native threads, and model turns. See OpenClaw's
[OpenAI provider guide][openclaw-openai], [auth bridge][openclaw-auth-bridge],
and [Codex runtime contract][openclaw-runtime].

The official [Codex app-server README][codex-app-server] confirms that this is
the supported deep-integration surface. It provides managed browser/device
login and an experimental `dynamicTools` request/response bridge.

That is a viable future runtime, but it is not the first implementation for
`cf-harness`:

- app-server owns the internal model/tool loop, so `maxModelTurns` no longer has
  its current exact meaning;
- Codex owns the canonical native thread and compaction state rather than the
  harness transcript;
- Codex-native shell, file, web, MCP, and other tools need a separate fail-closed
  policy bridge or a proof that they are absent;
- the dynamic-tool surface is explicitly experimental and version-specific.

OpenClaw's substantial adapter and native-tool policy layer demonstrates that
app-server integration is a runtime redesign, not an authentication shortcut.
It should be planned separately only if the direct provider later proves
incompatible or too costly to maintain; it is not the selected path here.

## Current `cf-harness` facts

- `src/gateway/openai-client.ts` speaks only the non-streaming
  `/v1/chat/completions` shape and supports `bearer` or `none` auth.
- `src/prompt-loop.ts` builds OpenAI Chat Completions messages and tools
  directly, calls `OpenAICompatibleGatewayClient`, executes tool calls, and
  records gateway-specific attempts.
- The CLI reads `CF_HARNESS_API_KEY` or `OPENAI_API_KEY`, rejects missing keys in
  bearer mode, and exposes gateway URL/auth flags.
- Resume reconstructs the next model request from the harness transcript.
- Parent and child prompt loops share the same gateway client today.
- Interactive chat constructs the same prompt loop through injected base
  options, so provider selection can propagate to it later without a second
  model implementation.
- The package's value proposition includes a bounded prompt/tool loop and
  harness-owned CFC mediation. Provider work must preserve those boundaries.

## Fixed decisions

1. Add a separate `openai-codex` provider. Do not reinterpret
   `gatewayAuthMode: "bearer"` as subscription auth.
2. Keep the OpenAI-compatible gateway a first-class provider, selected the same
   explicit way `openai-codex` is. Neither provider is a default: a run that
   names none is refused rather than routed to a billing route it never chose.
   Existing CLI flags, library callers, and run artifacts keep their shapes.
3. Keep `cf-harness` in charge of every model turn and every harness tool call.
   Subscription auth changes provider transport and credentials, not CFC
   authority.
4. Deliver local, single-user operation first as the smallest end-to-end
   validation, then integrate the same provider with Loom. A Loom run may select
   subscription auth only for an authenticated initiating user who explicitly
   connected that account; no service-wide or ambient credential is allowed.
5. Do not read, copy, edit, or depend on `~/.codex/auth.json`. Codex may use an
   OS keychain, its file format is not a `cf-harness` contract, and sharing
   rotating refresh tokens between clients creates races.
6. Do not send a subscription token to a caller-supplied gateway URL. OAuth
   credentials may be sent only to the exact OpenAI auth issuer/token endpoints
   and exact HTTPS ChatGPT Codex API origin pinned in Stage 0.
7. Stored credentials are type-tagged. A failed or expired OAuth credential does
   not fall back to `OPENAI_API_KEY`, `CF_HARNESS_API_KEY`, or unauthenticated
   mode.
8. Browser callback login is the default. Device login is explicit and uses the
   provider-mandated polling interval. That bounded, cancelable protocol poll is
   the only new polling loop authorized by this plan.
9. The first transport is SSE. WebSocket pooling, cached WebSocket deltas, and
   automatic provider fallback are deferred. A transient transport or
   provider failure is issued again under the bounded backoff the package
   README describes under "Model attempts and transport retry"; that bounded
   retry is the only sleep the model clients hold.
10. Model ids come from the selected provider or explicit operator choice. Do
    not copy an upstream hard-coded allowlist and do not silently substitute a
    different model when a subscription lacks access.
11. Secrets never enter transcripts, run state, run reports, diagnostics,
    exceptions, command lines, or model context.
12. Red/green TDD is required for each behavioral work package. Start with the
    smallest failing test that names the missing invariant.

## Dependency map

| Stage | Delivers | Depends on |
| --- | --- | --- |
| 0 | Pinned OpenCode/pi-compatible OAuth and protocol contract | Reviewed upstream implementations |
| 1 | Provider-neutral model-turn seam | Stage 0 |
| 2 | Dedicated OAuth login, storage, and refresh | Stage 0 |
| 3 | ChatGPT Codex Responses transport | Stages 1–2 |
| 4 | Explicit local and Loom product integration | Stages 1–3 |
| 5 | Provider-stable subagents, resume, and model discovery | Stage 4 |
| 6 | Full verification, documentation, and guarded rollout | Stages 1–5 |

Stages 1 and 2 may proceed in parallel after Stage 0. Stage 3 must not invent a
second auth store or bypass the normalized model-client seam while waiting for
either one.

## Stage 0 — Pin the OpenCode/pi-compatible protocol

No OAuth or ChatGPT Codex transport code begins until this stage closes.

### WP0.1 — Pin the known-working integration contract

- [x] Adopt the direct subscription OAuth and ChatGPT Codex Responses approach
  used by OpenCode and pi rather than waiting for a separate OpenAI approval.
- [x] Cross-check both pinned upstream implementations and record the exact
  client identity, authorization/token/device endpoints, scopes, redirect
  rules, `originator` or client metadata, ChatGPT API origin, account header,
  refresh-token rotation, and logout behavior they agree on.
- [x] Where OpenCode and pi differ, compare against the current official Codex
  client and choose deliberately; record the compatibility rationale and a
  regression fixture instead of guessing dynamically at runtime.
- [x] Support browser PKCE and device-code login using that pinned contract.
- [x] Use the same protocol for local CLI and Loom. Loom adds per-user
  credential ownership and redirect/session binding; it does not introduce a
  different OAuth client or model transport unless the provider requires it.
- [ ] Record observed plan/workspace behavior and surface provider rejections as
  capability or policy errors; do not maintain a speculative hard-coded
  subscription-plan allowlist.

OpenAI's public [Codex authentication docs][codex-auth] establish ChatGPT
subscription login for Codex CLI, the desktop app, the IDE extension, and
app-server. They do not document every third-party direct-client detail. This
plan consciously follows the demonstrated OpenCode/pi compatibility contract
and treats upstream drift as an engineering compatibility issue, not as a
pre-implementation approval gate.

### WP0.2 — Freeze the contract and drift response

- [x] Write the pinned values, source commits, and compatibility assumptions
  into a small provider protocol reference consumed by Stages 2 and 3.
- [x] Add fixtures that fail loudly when OAuth or Responses shapes drift; never
  probe alternate endpoints, client identities, or headers with a user's token.
- [x] Define the maintenance response to upstream drift: refresh the comparison,
  update the pinned protocol and fixtures, and fail closed until verified.
- [x] Keep app-server as a separately planned fallback only if direct-provider
  compatibility later breaks. Any such design must prove native tools cannot
  bypass CFC mediation and redefine turn counting, transcript ownership,
  resume, and compaction explicitly.
- [x] Do not treat calling the Codex CLI as a subprocess for each prompt as an
  acceptable fallback; it would duplicate the harness and make tool/CFC
  provenance opaque.

### Stage 0 completion gate

- [x] The adopted client identity, protocol details, source commits, and local
  versus Loom credential-ownership boundaries are written down.
- [x] Every exact OAuth/API origin that may receive a secret is enumerated.
- [x] OpenCode/pi parity is captured by fixtures, with every deliberate
  divergence documented.

## Stage 1 — Provider-neutral model-turn seam

### WP1.1 — Define a normalized model client contract

- [x] Add a dependency-light `HarnessModelClient` contract under
  `packages/cf-harness/src/model/`.
- [x] Its input carries the selected model, harness transcript, allowed tool
  descriptors, native-model capabilities, stable run/session id, abort signal,
  and attempt observer.
- [x] Its result carries normalized assistant text, zero or more harness tool
  calls, provider continuation state, usage when available, and provider-neutral
  attempt metadata.
- [x] Make provider continuation state explicitly provider-tagged so encrypted
  reasoning or response ids can be replayed only to the provider that created
  them.
- [x] Keep the normalized result free of raw credentials, raw response headers,
  and unbounded response bodies.

Expected files:

- `packages/cf-harness/src/model/client.ts`
- `packages/cf-harness/src/model/types.ts`
- `packages/cf-harness/test/model-client.test.ts`

### WP1.2 — Adapt the current gateway without changing behavior

- [x] Wrap `OpenAICompatibleGatewayClient` in a
  `HarnessModelClient` adapter.
- [x] Move Chat Completions message/tool conversion out of
  `CfHarnessPromptLoop` and into that adapter.
- [x] Keep the existing gateway client export and request/response types for
  callers that use them directly.
- [x] Make `CfHarnessPromptLoop` depend only on the normalized model client.
- [x] Preserve ordered tool execution, model-turn counting, cancellation,
  transcript events, subagent inheritance, and final-answer behavior exactly.

Tests to extend first:

- `packages/cf-harness/test/prompt-loop.test.ts`
- `packages/cf-harness/test/openai-client.test.ts`
- `packages/cf-harness/test/interactive-chat-service.test.ts`

### WP1.3 — Generalize attempt provenance

- [x] Add provider-neutral model-attempt records to run reports with provider,
  operation, endpoint origin, timing, request summary, status, selected request
  id, and bounded error metadata.
- [x] Record each attempt exactly once, in the provider-neutral `modelAttempts`
  field. A gateway turn carries the same kind of record as any other turn, with
  `operation` naming the API that served it.
- [x] Never record authorization, cookies, account ids, refresh responses, or
  arbitrary response headers.

### Stage 1 completion gate

- [x] All current `cf-harness` tests pass against the gateway adapter.
- [x] No subscription-auth code is needed to exercise the new seam.
- [x] Existing run artifacts remain readable and semantically unchanged.

## Stage 2 — Dedicated OAuth credential subsystem

### WP2.1 — Add type-tagged, injected credential storage

- [x] Define an `openai-codex` OAuth credential containing access token,
  refresh token, expiry, and ChatGPT account id.
- [x] Add an injected credential-store interface keyed by provider and an
  opaque credential owner/tenant key. Unit tests never touch a real user home
  or OS credential store, and model/runtime code never accepts a bare global
  "current credential."
- [x] For the first filesystem implementation, use a dedicated
  `CF_HARNESS_HOME` location, create its directory with mode `0700`, write the
  credential file with mode `0600`, and replace it atomically. This adapter is
  for the local CLI, not the Loom credential backend.
- [x] Define a Loom credential-store adapter contract that keeps refresh tokens
  in Loom's approved encrypted secret store and indexes them by the authenticated
  Common Fabric principal plus provider. Do not place tokens in Cells, Spaces,
  run manifests, session databases, or run artifacts.
- [x] Serialize read/modify/write so concurrent prompt loops cannot refresh the
  same rotating token independently. Re-check expiry inside the serialized
  mutation before making a refresh request.
- [x] Preserve the last valid in-memory credential if a read observes malformed
  storage, but surface the storage failure; never overwrite malformed storage
  with an empty object silently.
- [x] Make logout a serialized delete of only the selected provider entry.
- [x] Keep OS keychain support as a follow-up unless a repo-approved,
  dependency-light implementation is available.

Expected files:

- `packages/cf-harness/src/auth/types.ts`
- `packages/cf-harness/src/auth/credential-store.ts`
- `packages/cf-harness/test/credential-store.test.ts`

### WP2.2 — Implement browser PKCE login

- [x] Generate a high-entropy verifier, SHA-256 challenge, and state value with
  Web Crypto.
- [x] Bind the callback server to loopback only and accept only the exact
  callback route.
- [x] Validate state before exchanging the authorization code.
- [x] Bind each login transaction to its initiating credential-owner key and
  permitted redirect origin so one Loom session cannot complete or claim
  another user's connection.
- [x] Support cancellation by closing the listener and rejecting the pending
  login from the real close/abort event; do not add a guessed success timeout.
- [x] Validate token-response shape before persistence and derive the account id
  only from the approved claim path.
- [x] Render a minimal success/failure page without reflecting unescaped server
  error text.

### WP2.3 — Implement explicit headless device login

- [x] Start device authorization and surface verification URL, user code,
  interval, and expiry to the operator.
- [x] Poll only at the interval required by the provider, honor `slow_down`, and
  stop immediately on abort, expiry, terminal denial, or success.
- [x] Inject clock/wait functions so tests advance deterministically without
  sleeps.
- [x] Exchange the returned authorization code with its provider-issued verifier
  and persist the same canonical credential shape as browser login.

### WP2.4 — Resolve and refresh credentials per request

- [x] Return a still-valid access token without taking the write lock.
- [x] Before expiry, enter serialized mutation, re-read the credential, and
  refresh only if another caller has not already refreshed it.
- [x] Persist the rotated refresh token before releasing the mutation.
- [x] Classify invalid-grant, revoked, malformed-token, storage, network, and
  canceled failures distinctly enough for CLI guidance.
- [x] Never retry refresh automatically and never fall back to another auth
  source.

### Stage 2 completion gate

- [x] Unit tests cover login success, CSRF mismatch, cancellation, malformed
  responses, refresh rotation, concurrent refresh, logout, and redaction.
- [x] No test reads or writes the operator's real auth state.
- [x] A token-shaped sentinel is absent from captured stdout, stderr,
  diagnostics, and thrown messages.

## Stage 3 — ChatGPT Codex Responses transport

### WP3.1 — Encode harness state as Responses input

- [x] Add an `OpenAICodexResponsesClient` implementing
  `HarnessModelClient`.
- [x] Send OAuth requests only to the pinned exact HTTPS origin from Stage 0.
- [x] Set the pinned bearer, account-id, originator/client, user-agent,
  content-type, accept, and session-affinity headers.
- [x] Encode the system prompt as Responses instructions and the remaining
  harness transcript as ordered Responses input items.
- [x] Convert harness function descriptors without widening their JSON schemas.
- [x] Preserve tool-call ids and emit matching function-call outputs after the
  harness executes tools.
- [x] Set `store: false`, stream through SSE, and request encrypted reasoning
  continuation if the pinned contract requires it.
- [x] Derive the prompt-cache/session key from the stable harness run id; do not
  use a new random key per model turn.
- [x] Map initial and tool-result images only through the existing bounded image
  attachment contract.
- [x] Reject unsupported native-model tool ids explicitly in the first slice.

Expected files:

- `packages/cf-harness/src/model/openai-codex-responses.ts`
- `packages/cf-harness/src/model/responses-conversion.ts`
- `packages/cf-harness/test/openai-codex-responses.test.ts`

### WP3.2 — Parse SSE into the normalized result

- [x] Parse chunks incrementally across arbitrary byte boundaries.
- [x] Normalize assistant text, function calls, response id, encrypted
  reasoning, usage, and terminal status from the provider's terminal response,
  falling back to the completed `response.output_item.done` items streamed
  earlier when the terminal event carries no assembled output — an empty array
  or `null`, as the ChatGPT Codex backend returns under `store: false`. A
  populated terminal output always wins (no double-counting); `failed` and
  `incomplete` statuses still fail. Raw SSE events are not exposed to the
  prompt loop.
- [x] Reject malformed JSON, conflicting duplicate call ids, incomplete
  arguments, and a stream that ends without a terminal response event.
- [x] Abort the fetch and reader immediately when the run signal aborts.
- [x] Translate subscription quota/reset metadata into a concise operator error
  and a bounded diagnostic record.
- [x] Do not retry an interrupted or failed stream in the first slice; replaying
  a partial model response is not known-safe.

### WP3.3 — Preserve provider continuation through artifacts and resume

- [x] Extend assistant transcript records with optional type-tagged provider
  continuation state.
- [x] Persist encrypted reasoning/response continuation only as opaque data and
  return it only to the same provider.
- [x] Define the compatibility behavior for old transcripts that lack provider
  state: resend ordinary visible history without inventing reasoning items.
- [x] Ensure cross-provider resume either strips incompatible provider state
  explicitly or rejects the switch; it must not serialize Codex-only fields
  into a gateway request.
- [x] Version continuation state, bind it to the source model, and reject
  cross-model Codex resume before resolving credentials or contacting the
  provider.
- [x] Enforce the recorded Codex model at the exported prompt-loop boundary,
  including transcript-only library resume, and persist a fresh run's first
  selected model before its first turn.

### Stage 3 completion gate

- [x] Recorded fixture tests cover text-only completion, one tool call, multiple
  ordered tool calls, tool failure, image input, reasoning continuation, quota
  exhaustion, malformed SSE, abrupt EOF, and cancellation.
- [x] The existing max-model-turn limit still bounds the loop.
- [x] Every tool call still passes through the existing CFC decision and
  artifact path before its output reaches the model.

## Stage 4 — Local and Loom product integration

### WP4.1 — Make provider configuration a discriminated union

- [x] Replace combinations that can represent invalid states with a provider
  union: current OpenAI-compatible gateway config or `openai-codex` config.
- [x] Keep the gateway provider's URL and auth defaults unchanged; selecting
  the provider itself is explicit.
- [x] Add `--model-provider openai-codex` and
  `CF_HARNESS_MODEL_PROVIDER=openai-codex` as explicit opt-ins.
- [x] Reject gateway URL/auth flags when `openai-codex` is selected instead of
  ignoring them.
- [x] Record provider id and non-secret auth source in run state, capability
  snapshots, and run reports.
- [x] On resume, default to the recorded provider and reject an accidental
  provider change unless an explicit, separately tested migration flag exists.

### WP4.2 — Add auth commands without exposing secrets

- [x] Extend the package entry point with:
  `auth login openai-codex`, `auth login openai-codex --device`,
  `auth status openai-codex`, and `auth logout openai-codex`.
- [x] `status` reports credential type, signed-in/not-signed-in, expiry health,
  and optionally non-sensitive plan/workspace metadata supplied by an approved
  endpoint. It never prints a token or full account id.
- [x] `logout` removes only `cf-harness` credentials and does not log the user
  out of Codex CLI, ChatGPT, or a browser session.
- [x] Expose the same login/status/logout operations as an injected auth service
  for Loom; do not make Loom shell out to the CLI or read its credential file.
- [x] Update `--help` and `--describe-capabilities` so callers can discover the
  provider and its credential-ownership requirements.

### WP4.3 — Integrate explicitly with Loom

- [x] Do not auto-select subscription auth merely because a credential exists.
- [x] Do not infer subscription auth from `OPENAI_API_KEY` absence.
- [x] Extend the Loom-to-harness invocation contract with an authenticated,
  opaque credential-owner reference and explicit `openai-codex` provider
  selection. Never put a token or provider account id in a run manifest.
- [ ] Resolve that owner reference inside the trusted Loom host, verify it
  matches the initiating principal and current workspace policy, and inject a
  request-scoped credential resolver into `cf-harness`.
- [ ] Make connect, status, disconnect, and provider selection available in the
  Loom user experience before enabling Loom runs with this provider.
- [ ] Apply the same trusted-principal binding in the Loom host to interactive
  chat and batch dispatch. The harness seam retains the selected owner for
  resume and subagents, and an interactive service instance is restricted to
  one explicitly injected owner; authenticating that owner remains host work.
- [x] Stdio and other shared processes must receive an explicit owner-bound
  resolver from their host; they must not inherit the local operator's
  filesystem credential implicitly.
- [x] Keep the Common Fabric gateway available as the fallback chosen by the
  user or workspace policy, never as an automatic fallback after subscription
  auth fails.

### Stage 4 completion gate

- [x] CLI parsing tests cover both providers and every conflicting flag pair.
- [x] Existing gateway invocations remain byte-for-byte equivalent at the
  configuration boundary.
- [x] Local subscription use always requires an explicit provider selection.
- [ ] Loom integration tests prove two concurrent users cannot observe, refresh,
  disconnect, or invoke with each other's credentials.
- [ ] A Loom run without an authenticated credential owner, explicit provider
  choice, or required workspace permission fails before the first model request.

## Stage 5 — Subagents, persistence, and model catalog

### WP5.1 — Share auth resolution, not token strings

- [x] Parent and child model clients share the credential resolver/store
  instance so refresh is serialized.
- [x] Subagent manifests record provider and model, never credentials; child
  run state retains exact non-secret owner/tenant provenance and typed
  root/parent lineage.
- [x] Persist a running child reference in the parent before the child starts,
  then replace it with the terminal summary; reject direct top-level resume of
  child artifacts with guidance to resume the root.
- [x] Apply the child-resume guard at the exported engine boundary; whole-tree
  restorers must supply typed trusted root/parent context matching the child's
  persisted lineage.
- [x] Profile model overrides must name a model available from the same provider
  or fail before starting the child.
- [x] Do not allow one child profile to switch from subscription auth to a
  gateway key implicitly.

### WP5.2 — Add provider-scoped model discovery

- [x] Add an operator command or library method that lists models from the
  pinned Codex model endpoint using the selected credential.
- [x] Preserve provider order and advertised capabilities; do not derive access
  from name patterns.
- [x] Keep the current default model until a separate product decision changes
  it. If that model is unavailable to the signed-in account, report the error
  and show the discovery command instead of silently downgrading.
- [x] Do not cache model metadata in the first implementation; every model-list
  operation is an explicit live refresh.

### WP5.3 — Make resume provider-stable

- [x] Persist enough provider continuation to resume after process restart.
- [x] Refresh credentials at request time; do not snapshot access tokens into
  run artifacts.
- [x] Verify that a resumed run preserves tool-call ids, prompt-cache affinity,
  model, and provider. The max-turn bound applies independently to each
  resumed prompt-loop invocation; it is not a cumulative run-wide budget.
- [x] Define a clear failure for a credential that was logged out or revoked
  between the original run and resume.

### Stage 5 completion gate

- [x] A parent + child fixture run uses one refresh and produces no secret-bearing
  artifacts.
- [x] A persisted run resumes with a rotated credential and identical provider
  semantics.
- [x] Unavailable models and revoked credentials fail closed.

## Stage 6 — Verification, documentation, and rollout

### WP6.1 — Isolated test process coverage

- [x] Keep OAuth callback servers, fake issuers, credential homes, and transport
  fixtures under `Deno.makeTempDir()` with cleanup in `finally`.
- [x] If a test spawns nested Deno, use
  `@commonfabric/test-support/isolated-deno` so it cannot update the repository
  lockfile or generated config.
- [x] Wait on listener readiness, callback receipt, stream events, process exit,
  and abort signals. Do not add sleeps or generic retry loops to tests.
- [x] Keep live subscription smoke tests opt-in and out of ordinary CI. They may
  use only a dedicated test account/workspace approved for this purpose.

### WP6.2 — Required verification

- [x] Run focused auth, transport, prompt-loop, CLI, resume, subagent, and
  interactive-service tests, including the Loom credential-owner boundary.
- [x] Run `deno task test` from `packages/cf-harness`; the root
  `deno task check` does not type-check this package completely.
- [ ] Run root formatting, lint, documentation checks, unused-dependency checks,
  and `git diff --check`.
- [ ] Perform one manual browser-login smoke, one device-login smoke, one tool
  call, one resume, one logout/revoked-credential failure, and inspect all
  generated artifacts for secret leakage.
- [ ] Obtain a security review focused on OAuth state, callback binding, token
  storage/rotation, fixed-origin enforcement, logs, artifacts, and shared-process
  misuse, including cross-user and cross-workspace isolation in Loom.

### WP6.3 — Documentation and rollout

- [x] Update `packages/cf-harness/README.md` with provider selection, auth
  commands, local and Loom credential ownership, credential storage warning,
  logout, model listing, and troubleshooting.
- [x] Update `packages/cf-harness/docs/IMPLEMENTATION_PLAN.md` where its gateway
  auth discussion would otherwise imply that API keys are the only authenticated
  path.
- [x] Document that API-key usage and ChatGPT subscription usage have different
  billing, workspace policy, retention, and availability.
- [ ] Ship local CLI support first, then enable Loom behind explicit user
  connection, provider selection, workspace policy, and a guarded rollout. Do
  not make subscription auth a global default as part of this plan.
- [ ] Archive this plan only after every shipping stage is complete or an owner
  explicitly abandons the direct-provider route.

### Final completion gate

- [x] Existing gateway behavior and artifacts are compatible.
- [x] Subscription requests use only pinned fixed origins and client identity.
- [x] Login, refresh, logout, resume, subagents, quota errors, and cancellation
  are covered without leaking credentials.
- [x] The harness still owns and bounds every model turn and mediates every
  harness tool call through the existing CFC path.
- [ ] Loom users can connect, select, use, refresh, resume, and disconnect their
  own supported subscription without exposing it to another user or workload.
- [ ] Shared or product-hosted workloads cannot select a personal subscription
  accidentally or through ambient process state.

## Deferred work

- Codex Responses WebSocket transport and connection reuse.
- Automatic provider fallback.
- OS keychain-backed `cf-harness` credential storage.
- Importing credentials from Codex CLI or other harnesses.
- A native Codex app-server runtime mode.
- Managed Business/Enterprise automation through Codex access tokens.
- Changing the package's default model.
- Using subscription credentials for non-Codex OpenAI APIs.

[opencode-codex]: https://github.com/anomalyco/opencode/blob/411eff73f026d4950c07947c4d983788cb615baa/packages/opencode/src/plugin/openai/codex.ts
[pi-oauth]: https://github.com/earendil-works/pi/blob/9b3a2059171bcc74ad9d2cadeea6d186776cf2db/packages/ai/src/auth/oauth/openai-codex.ts
[pi-auth-resolution]: https://github.com/earendil-works/pi/blob/9b3a2059171bcc74ad9d2cadeea6d186776cf2db/packages/ai/src/auth/resolve.ts
[pi-responses]: https://github.com/earendil-works/pi/blob/9b3a2059171bcc74ad9d2cadeea6d186776cf2db/packages/ai/src/api/openai-codex-responses.ts
[pi-auth-storage]: https://github.com/earendil-works/pi/blob/9b3a2059171bcc74ad9d2cadeea6d186776cf2db/packages/coding-agent/src/core/auth-storage.ts
[openclaw-openai]: https://github.com/openclaw/openclaw/blob/85e2a432293eedfef2e27dcab11789c2d14385b3/docs/providers/openai.md
[openclaw-auth-bridge]: https://github.com/openclaw/openclaw/blob/85e2a432293eedfef2e27dcab11789c2d14385b3/extensions/codex/src/app-server/auth-bridge.ts
[openclaw-runtime]: https://github.com/openclaw/openclaw/blob/85e2a432293eedfef2e27dcab11789c2d14385b3/docs/plugins/codex-harness-runtime.md
[codex-app-server]: https://github.com/openai/codex/blob/88f1cd9664d09b68909a258a061a662c1f099ce6/codex-rs/app-server/README.md
[codex-auth]: https://learn.chatgpt.com/docs/auth.md
