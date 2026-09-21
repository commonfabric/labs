# The language-model provider boundary

Calling a language model from this system crosses one boundary, and the two
sides of it own different things. Getting the division wrong is the most common
reason someone cannot find the code they are looking for.

**The caller names a model. The toolshed resolves that name to a provider.**

"Gateway" in this repository means something narrower and is not either side of
that boundary: it is the internal LLM service at `CFTS_AI_GATEWAY_URL`, one of
the providers the toolshed can resolve a name to.

## Which side owns what

| | Caller — `@commonfabric/llm` | Server — `packages/toolshed/routes/ai/llm/` |
|---|---|---|
| Loaded by | a browser tab, the command line, a background service, and the server too, for the request types | the toolshed server process alone |
| Knows | the request shape and a model **name** | every registered model, its provider, and its capabilities |
| Holds | no credential | whatever each provider needs to authenticate |
| Depends on | `@commonfabric/api`, `@commonfabric/utils`, `@commonfabric/pure-json` | the AI SDK and its four provider packages |

A caller builds an `LLMRequest` whose `model` field is a string and posts it to
`/api/ai/llm`. The string may be a provider-qualified name, a shorter alias, or
the `default` alias. Nothing on the caller's side maps any of those to a
provider, and nothing on the caller's side could work it out unasked. A caller
that wants the list asks for it, over `GET /api/ai/llm/models`.

## Why the catalog stays on the server's side

The catalog is
[`packages/toolshed/routes/ai/llm/models.ts`](../../packages/toolshed/routes/ai/llm/models.ts).
It is five things at once: the model list, the aliases, the capability records,
the provider clients, and the chain that decides what `default` means.

**The reason that reaches all five is that the catalog is not a constant.**
Which models a deployment has is decided by the credentials it was configured
with and by what the gateway answers when the toolshed asks it, so the true
list exists only at run time and only in the server. A copy shipped to a caller
would be a guess. This is why the callers that need the list already fetch
`GET /api/ai/llm/models` rather than importing one — `packages/patterns`
builds its model pickers that way, and cf-harness derives its own entries from
the gateway's `/v1/models`. Moving a static catalog to the caller's package
would create a second answer with no consumer and no way to be right.

Two further facts fence off the provider clients specifically, and they are
narrower than the reason above rather than independent of it:

- **The clients need credentials.** Anthropic, Groq, and OpenAI register behind
  an API key from the toolshed's environment; Vertex registers behind a path to
  a credentials file it reads off disk. A credential belongs in one process.
- **The clients need the AI SDK.** `createAnthropic`, `createOpenAI`,
  `createGroq`, and `createVertex` come from packages declared in
  `packages/toolshed/deno.jsonc`, scoped to the toolshed alone.

The gateway is the exception that shows the shape: its block is gated on a URL
rather than a key, and it authenticates with a placeholder. It stays here not
because it is secret but because what it offers is only discoverable from here.

Two rules hold on the caller's side, for two different reasons, and a
different check keeps each. `@commonfabric/llm` is loaded into a browser worker
through `@commonfabric/runner` and `runtime-client`, so nothing a browser tab
may not load belongs there; `packages/llm/test/package-boundary.test.ts` reads
that package's sources against an allowlist, so a provider SDK, a `node:`
module, or any dependency nobody thought to ban turns the suite red. And
`@commonfabric/runner` imports that package, so an import back the other way
would close a cycle between them — nothing to do with weight. That one is
`deno task check-package-cycles`, which walks the whole workspace and names
both directions of the cycle it finds.

## Asking the registry, and waiting only where it helps

Each provider whose key is present adds its models to `MODELS` as `models.ts`
loads. The gateway's are discovered instead of declared, over a request that
runs alongside the server binding its port. That leaves two ways to ask:

- `resolveModel(name)` returns any already registered model straight away, and
  waits only when the name is not registered yet — a `gateway:` name, the
  `default` alias, or a name that is no model at all, while discovery is still
  out. There is one such wait per process: once discovery finishes, every name
  returns immediately. The `default` alias selects an available preferred model
  or the first registered language model; it remains unavailable when no
  language model was registered.
- `whenModelsReady()` waits for the whole list, which is what
  `GET /api/ai/llm/models` needs: a list quietly missing the gateway's models
  is a wrong answer rather than an early one.

What the candidates are, what an unreachable gateway does, and which
environment variable governs each of these belong to
[`CONFIGURATION.md`](../development/CONFIGURATION.md#llm-providers) and are not
repeated here.

## Where the boundary leaks

Two places where the division is less clean than the above, both worth knowing
before relying on it:

- `DEFAULT_GENERATE_OBJECT_MODEL` in
  [`packages/llm/src/types.ts`](../../packages/llm/src/types.ts) is a
  qualified model name on the caller's side, and
  `packages/toolshed/routes/ai/llm/generateObject.ts` imports it back to use as
  a default. The server's own answer to "which model when the caller names
  none" is the `default` alias; this constant sits beside that answer rather
  than deferring to it, because `generateObject` wants a cheaper model than a
  deployment's general default. What it costs is that the name is a guess about
  what the deployment serves: it names a `gateway:` model, so a deployment
  whose gateway does not answer, or does not serve that name, has a
  `generateObject` default naming a model nothing registered.
- The response shape of `GET /api/ai/llm/models` is caller-facing vocabulary
  written three times on the server's side — `Capabilities` and
  `GatewayModelCapabilities` in `models.ts`, and the response schema in
  `llm.routes.ts` — and read as `any` by the browser code that consumes it.
  Model metadata carries no credential and needs no provider package, so unlike
  the catalog itself this part could live beside `LLMRequest` and `LLMResponse`
  in the caller's package, the way `LLMNativeModelToolId` already does.

## The harness talks to the gateway itself

`packages/cf-harness` is a third place with model code, and it is not part of
the path above. It speaks the gateway's OpenAI-compatible protocol directly
rather than going through the toolshed, and builds its own catalog entries from
what the gateway's `/v1/models` returns — the same discovery the toolshed does,
run separately for itself. What it hardcodes is narrower: a default model name,
a subagent model name, and a pricing table. What it shares with the path above
is the vocabulary in
[`packages/llm/src/types.ts`](../../packages/llm/src/types.ts) — the native
model tool identifiers and their results — and nothing else.

## Related documentation

- [`packages/llm/README.md`](../../packages/llm/README.md) — what the caller's
  package contains
- [`llm-testing.md`](llm-testing.md) — the test-environment guard, the client
  mocks, and driving the route against a stand-in model
- [`gateway-request-provenance.md`](gateway-request-provenance.md) — how a
  request to the gateway says which workload produced it
