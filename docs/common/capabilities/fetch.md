# Fetching Data

Fetch calls are reactive nodes, not promises: never `await` them. Each returns
an `AsyncResult<T>`: either its usable value or a runtime-owned unavailable
state. Keep that request value when the UI needs to render a loading or error
state, and call `resultOf(request)` once to obtain the ordinary `T` view used by
the rest of the pattern. A consumer of that view waits automatically while the
request is unavailable.

Fetches re-run when their inputs (URL, options) change. Results are memoized per
request, so calling the same fetch with the same inputs does not re-issue the
request.

There are five single-result fetch functions: four body shapes plus a program
loader.

## fetchJson\<T\>

JSON parsed into a TypeScript type. A type argument is **required** — the
compiler derives a JSON schema from `T` and verifies the response against it at
fetch time. A response that is missing a required field or has a mismatched
type produces the `schemaMismatch` unavailable state; fields the type does not
mention are allowed through.

```typescript
// Shown for illustration only.
interface Repo {
  name: string;
  stargazers_count: number;
}

const repoRequest = fetchJson<Repo>({ url: apiUrl });
const repo = resultOf(repoRequest);

{isPending(repoRequest)
  ? <span>Loading...</span>
  : hasError(repoRequest)
  ? <span>Error: {repoRequest.errorMessage}</span>
  : <p>{repo.name} ({repo.stargazers_count}★)</p>}
```

Calling `fetchJson` without a type argument is a compile error. Reach for
`fetchJsonUnchecked` when the response shape isn't declared as a type.

## fetchText

The response body decoded as UTF-8 text.

```typescript
// Shown for illustration only.
const page = fetchText({ url: resolvedUrl });
const text = resultOf(page); // string
```

## fetchJsonUnchecked

JSON parsed without a type or verification — the escape hatch for responses
whose shape you don't declare. Its usable value is typed `any`.

```typescript
// Shown for illustration only.
const models = fetchJsonUnchecked({ url: "/api/ai/llm/models" });
const modelData = resultOf(models); // any
```

## fetchBinary

The raw response bytes plus the media type.

```typescript
// Shown for illustration only.
const file = fetchBinary({ url: assetUrl });
const binary = resultOf(file); // { bytes: FabricBytes, mediaType: string }
```

`bytes` is a `FabricBytes` byte buffer; read it with `slice()` / `copyInto()`.
`mediaType` comes from the `Content-Type` response header (for example
`"image/png"`).

## fetchProgram

Fetch a Common Fabric program bundle for `compileAndRun`. The usable result is
`{ files: Array<{ name, contents }>, main }`.

```typescript
// Shown for illustration only.
const programRequest = fetchProgram({ url: sourceUrl });
const program = resultOf(programRequest);
const compileRequest = compileAndRun({
  files: program.files,
  main: program.main,
  input,
});
const compiled = resultOf(compileRequest);
```

## POST and request options

Pass an `options` object for the method, headers, and body. A non-string body
is stringified for you, so a `body` can be a plain object (or a `computed()`
that produces one).

```typescript
// Shown for illustration only.
const request = fetchJson<SearchResult>({
  url: "/api/agent-tools/web-search",
  options: {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: { query, max_results: 5 },
  },
});
const result = resultOf(request);
```

## Processing arrays

Map over items — memoization is automatic per item:

```typescript
// Shown for illustration only.
const pages = urls.map((url) => ({
  url,
  request: fetchJson<Page>({ url }),
}));

{pages.map(({ request }) => (
  <div>
    {isPending(request)
      ? <em>Loading...</em>
      : <p>{resultOf(request).title}</p>}
  </div>
))}
```

The guards `isPending`, `hasError`, `isSyncing`, and `hasSchemaMismatch`
narrow the request to the corresponding state. You do not need to handle every
state: if a computation only consumes `resultOf(request)`, unavailability
propagates through it and the computation runs once usable data exists.

### Migrating fallback-while-loading code

`resultOf(request)` is a type projection, not a defaulting operator. Do not
translate an old expression such as `request.result ?? previousValue` into
`resultOf(request) ?? previousValue`: the runtime marker is intentionally
preserved and is truthy, so the fallback does not provide continuity. Keep the
request for explicit pending/error branches. If the requirement is to retain
the last successful value across a new request, use
`latestComplete(request)`; it provides continuity without hand-written snapshot
cells while leaving the original request available for guards.

## URLs

Use whichever URL fits the data:

- A **relative URL** targets a first-party platform service (the LLM gateway,
  agent tools, the sandbox, registries). It resolves against the executing
  space's host, so the pattern stays portable across deployments and works
  under federation. This is the right choice for first-party APIs, for those
  reasons rather than to avoid CORS.
- An **absolute URL** targets any external resource, and is a first-class case.

### CORS (current limitation)

The request currently runs in the browser, so an absolute cross-origin URL only
succeeds if that server sends the CORS response headers. A JSON API that does
not cannot be fetched directly yet. For external web *page* content, the
first-party `/api/agent-tools/web-read` and `/api/agent-tools/web-search`
endpoints fetch server-side on your behalf. This is a current limitation,
expected to lift as fetches move to runtime-managed egress under an explicit
egress policy.

A worked example lives in
[`packages/patterns/examples/fetch-json.tsx`](../../../packages/patterns/examples/fetch-json.tsx).
