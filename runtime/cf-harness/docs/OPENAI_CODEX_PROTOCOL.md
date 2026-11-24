# OpenAI Codex subscription protocol reference

This file pins the direct OAuth and ChatGPT Codex Responses contract used by
`cf-harness`. It is a compatibility reference, not a general OpenAI API
contract. Update it together with fixtures when either upstream implementation
changes.

The wire mapping this pins now lives in `src/model/responses-protocol.ts`, which
is shared with the OpenAI-compatible gateway client. A change made there for
gateway reasons also changes the contract described here, so edits to that
module need checking against this reference and its fixtures.

Reviewed sources:

- OpenCode `411eff73f026d4950c07947c4d983788cb615baa`,
  `packages/opencode/src/plugin/openai/codex.ts`
- pi `9b3a2059171bcc74ad9d2cadeea6d186776cf2db`,
  `packages/ai/src/auth/oauth/openai-codex.ts` and
  `packages/ai/src/api/openai-codex-responses.ts`
- official Codex `88f1cd9664d09b68909a258a061a662c1f099ce6`
- [Codex authentication documentation](https://learn.chatgpt.com/docs/auth)

## Pinned OAuth contract

- Client id: `app_EMoamEEZ73f0CkXaXp7hrann`
- Issuer: `https://auth.openai.com`
- Authorization endpoint: `/oauth/authorize`
- Token endpoint: `/oauth/token`
- Scope: `openid profile email offline_access`
- Browser redirect: `http://localhost:1455/auth/callback`
- Authorization parameters: `response_type=code`, PKCE `S256`, state,
  `id_token_add_organizations=true`, `codex_cli_simplified_flow=true`, and
  `originator=cf-harness`
- Device start: `/api/accounts/deviceauth/usercode`
- Device poll: `/api/accounts/deviceauth/token`
- Device verification: `/codex/device`
- Device token-exchange redirect: `/deviceauth/callback`
- Account id claim: object key `https://api.openai.com/auth`, nested field
  `chatgpt_account_id`

Authorization-code exchange sends `grant_type`, `client_id`, `code`,
`code_verifier`, and `redirect_uri` as form data. Refresh sends
`grant_type=refresh_token`, `refresh_token`, and `client_id`. A refresh response
may rotate the refresh token and must be persisted atomically. Every OAuth and
Codex API fetch rejects HTTP redirects so credential-bearing bodies, account
headers, and prompts cannot leave the pinned origins.

The credential document stores credentials and bounded terminal refresh health
in one versioned transaction. Version-1 documents remain readable without a
status-side mutation and migrate on the next successful mutation. Successful
login or refresh clears terminal health; `invalid_grant`, refresh-token reuse,
and revoked responses persist `reconnect-required` before returning a typed auth
failure. Transient failures do not change health, and structured status does not
expose token material, account identifiers, expiry, or raw responses.

## Pinned Responses contract

- Endpoint: `https://chatgpt.com/backend-api/codex/responses`
- Required request headers: bearer authorization, `chatgpt-account-id`,
  `originator: cf-harness`, `accept: text/event-stream`, and
  `content-type: application/json`
- Session affinity: `session-id` and `prompt_cache_key` use the bounded stable
  cache-affinity key (the run id for batch runs and the chat session id for
  interactive runs); `x-client-request-id` is unique per request
- Request invariants: `store: false`, `stream: true`,
  `include: ["reasoning.encrypted_content"]`, `tool_choice: "auto"`, and
  `parallel_tool_calls: true`; text verbosity is `low` and function schemas are
  passed through unchanged with `strict: null`
- Every request asks for a readable summary of the model's reasoning,
  `reasoning.summary: "auto"`, beside `reasoning.effort` when the run names one.
- Three of these fields depend on capabilities that Codex's model list states
  per model: `supports_reasoning_summary_parameter`, `support_verbosity`, and
  `supports_parallel_tool_calls`. Every model in the list that OpenAI's
  open-source Codex client bundles sets all three to `true`, and the first
  defaults to `true` when absent. This client does not read the flags; it sends
  all three fields to every model.
- Optional reasoning experiments pass `reasoning.effort`. The ChatGPT/Codex
  backend rejects the API `prompt_cache_options` field, so this provider uses
  implicit prompt caching with the stable affinity key; cache-mode controls and
  explicit breakpoints are available only through the compatible API gateway.
- Tool continuation retains both the public call id and provider function-item
  id, so the corresponding `function_call_output` remains paired after resume.
- The first transport is SSE. WebSockets, endpoint probing, and client-id
  fallback are not implemented.
- A transient failure — a transport error, a `429` or `5xx` status, an in-stream
  `error` event or `response.failed` terminal whose type or code names overload,
  rate limiting, or a server fault — is issued again under the bounded backoff
  described in the package README under "Model attempts and transport retry".
  The provider's stated `type`, `code`, and `message` are recorded on the
  attempt and carried in the failure the turn ends with. Whatever a failed
  attempt streamed is discarded with it; nothing reaches the harness until an
  attempt completes.

Provider-scoped model discovery uses only
`https://chatgpt.com/backend-api/codex/models?client_version=0.0.0`. It sends
the same bearer/account/originator identity and accepts only the canonical
top-level `models` array. Entries remain in provider order and retain advertised
input, reasoning, and parallel-tool capabilities. Model metadata is not cached
by this first implementation.

The response adapter accepts `response.completed`, `response.done`,
`response.incomplete`, and `response.failed` terminal event spellings because
the compared clients normalize those terminal forms. It persists encrypted
reasoning output items only as provider-tagged opaque continuation state. It
also normalizes response usage details, including cached-input, cache-write,
output, reasoning, and total token counts. Direct subscription usage is never
converted to an API-dollar estimate.

Under `store: false` the ChatGPT Codex backend streams each completed item via
`response.output_item.done` but returns **no assembled output** on the terminal
event — an empty `output` array, or `null` — because it keeps no stored response
to echo back. The adapter therefore accumulates the streamed `output_item.done`
items and normalizes from them whenever the terminal output is empty/null; a
populated terminal `output` (other providers, or stored responses) always wins,
so the two representations never double-count, and `failed`/`incomplete`
statuses still fail before normalization. Reading only the terminal `output`
silently drops the model's message and tool calls.

## Product boundary

The local filesystem credential adapter is keyed to a local owner. Loom must
inject an authenticated owner/tenant key and store that owner's credential in
its encrypted secret backend. Tokens and account ids never belong in Cells,
Spaces, manifests, transcripts, reports, diagnostics, or command lines.

OAuth material is sent only to `https://auth.openai.com` (authorization, device
authorization, and token exchange), the fixed loopback callback
`http://localhost:1455/auth/callback` (the browser redirects the authorization
code and state), and `https://chatgpt.com` (Codex Responses and model
discovery). The implementation does not probe alternatives. On drift, update
this reference and its fixtures from newly pinned OpenCode, pi, and official
Codex sources; until then, fail closed.
