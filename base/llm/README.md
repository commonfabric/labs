# @commonfabric/llm

The caller's half of the language-model boundary: the request and response
types, the HTTP client that sends a request to the toolshed, and the check that
a request survives the trip through JSON.

## The model catalog is not here

If you came looking for the list of models, the aliases, which provider serves a
given name, or the chain that decides what `default` means, it is in
[`runtime/toolshed/routes/ai/llm/models.ts`](../../runtime/toolshed/routes/ai/llm/models.ts).
That file is the whole provider abstraction: it registers a model under a name,
records what the model can do, and hands back the provider client to call.

The split is deliberate. A caller sets `model` on an `LLMRequest` to a name and
posts it to `/api/ai/llm`; the toolshed turns that name into a provider to call.
Which models a deployment has depends on the credentials it was configured with
and on what the gateway answers when asked, so the real list exists only in the
server and only at run time. A copy on this side would be a guess, which is why
a caller that wants the list fetches `GET /api/ai/llm/models` instead of
importing one.

Two rules follow for this package. It reaches a browser tab, through
`@commonfabric/runner` and `runtime-client`, so nothing a browser may not load
belongs here — no provider SDK, no `node:` module;
[`test/package-boundary.test.ts`](test/package-boundary.test.ts) checks that
against an allowlist. And `@commonfabric/runner` imports this package, so
importing the runner back would close a cycle, which the repo-wide
`deno task check-package-cycles` catches.

[`docs/features/llm-provider-boundary.md`](../../docs/features/llm-provider-boundary.md)
sets all of this out in full, including the two places the division leaks.

## What is here

- [`src/types.ts`](src/types.ts) — the request and response shapes that cross
  the boundary, and the predicates that recognize them. `LLMRequest`,
  `LLMResponse`, `LLMGenerateObjectRequest`, tool calls and tool results, and
  the native model tools a request may ask a model to run for itself.
- [`src/client.ts`](src/client.ts) — `LLMClient`, which posts to the toolshed
  and reassembles a streamed answer. It also carries the mock mode that tests
  use in place of a live call, and the guard that blocks a live call under
  `ENV=test` or `CI=true`.
- [`src/schema-transport.ts`](src/schema-transport.ts) — the check that a schema
  is still the same schema after a round trip through JSON.

## A system instruction is not a message

`LLMRequest` carries a `system` field, and a caller puts a system instruction
there and nowhere else. A message carries one of three roles — `user`,
`assistant`, and `tool` — and the AI SDK the toolshed hands the array to refuses
a system-role message inside `messages`, directing the caller to its own
`instructions` option instead. (What the toolshed does with the field afterwards
is its own business: for a model whose capability record says it takes no system
prompt, `generateText.ts` folds the instruction into the first message's
content.)

Four declarations say that, and they have to agree.

- `BuiltInLLMMessage` in [`base/api/index.ts`](../api/index.ts) is the type a
  pattern is written against.
- `LLMMessageSchema` in
  [`runtime/runner/src/builtins/llm-schemas.ts`](../../runtime/runner/src/builtins/llm-schemas.ts)
  is the runtime schema describing that type, and it reaches the durable
  argument contract of every pattern using an LLM builtin. It describes rather
  than polices: the runtime enforces an `enum` neither on read nor on write.
- `llmMessageProblem()` in [`src/types.ts`](src/types.ts) is the check that
  refuses one, reached through `llmRequestProblem()` and
  `llmGenerateObjectRequestProblem()`, which are what the toolshed handlers gate
  an incoming payload on.
- `MessageSchema` in
  [`runtime/toolshed/routes/ai/llm/llm.routes.ts`](../../runtime/toolshed/routes/ai/llm/llm.routes.ts)
  is the route's own validator, and the one a caller sending JSON meets first:
  it refuses a system-role message by naming the field to move it to.

`docs/history/features/llm-message-role-narrowing-break.md` records why the role
left, and what that cost the patterns whose contracts carried it.

## A request that leaves `cache` out asks for caching

`cache` is optional, and a request that leaves it out asks for its response to
be cached. Only `cache: false` declines.

Four declarations say that, and they have to agree.

- `LLMRequest` and `LLMGenerateObjectRequest` in [`src/types.ts`](src/types.ts)
  declare the field optional. TypeScript has no way to state a default, so their
  doc comments carry it.
- `llmRequestProblem()` and `llmGenerateObjectRequestProblem()` in the same
  file, which the two POST handlers gate their payloads on, take a request that
  leaves the field out and refuse a value that is not a boolean, so a caller
  sending `cache: "yes"` is told which field to change.
- `LLMRequestSchema` and `GenerateObjectRequestSchema` in
  [`runtime/toolshed/routes/ai/llm/llm.routes.ts`](../../runtime/toolshed/routes/ai/llm/llm.routes.ts)
  publish the field as optional with a default of `true`. That is the OpenAPI
  document, and it is what a caller writing against this API reads.
- `requestsCaching()` in
  [`runtime/toolshed/routes/ai/llm/cache.ts`](../../runtime/toolshed/routes/ai/llm/cache.ts)
  is where the default is applied, and both POST handlers ask it.

What the field asks for is not the whole decision. `/api/ai/llm` answers a
request naming a provider-native tool such as Google Search live whatever
`cache` says, because those results are time-sensitive.

Both handlers read the raw body rather than the value their route's validator
parsed, which is how a body sent under another content type reaches the same
check. The default therefore has to be applied in the handler as well as
declared in the schema.

## The routes on the other side

| Route                        | Method | What it does                                 |
| ---------------------------- | ------ | -------------------------------------------- |
| `/api/ai/llm/models`         | GET    | The registered models and their capabilities |
| `/api/ai/llm`                | POST   | Text generation, streamed or whole           |
| `/api/ai/llm/generateObject` | POST   | Generation constrained to a JSON schema      |

Their handlers are in
[`runtime/toolshed/routes/ai/llm/`](../../runtime/toolshed/routes/ai/llm/).

## Related documentation

- [`docs/features/llm-provider-boundary.md`](../../docs/features/llm-provider-boundary.md)
  — what each side of the boundary owns, and how a model name is resolved
- [`docs/features/llm-testing.md`](../../docs/features/llm-testing.md) — testing
  patterns and routes that call a model
- [`docs/development/CONFIGURATION.md`](../../docs/development/CONFIGURATION.md)
  — the environment variables that decide which providers register
