# Fetching Data

Fetch calls are reactive nodes, not promises: never `await` them. Call them in
the pattern body and read `pending` / `error` / `result` reactively. Each
returns `{ pending: boolean, result, error }`, and re-runs automatically when
its inputs (URL, options) change. Results are memoized per request, so calling
the same fetch with the same inputs does not re-issue the request.

There are four functions, one per body shape.

## fetchJson\<T\>

JSON parsed into a TypeScript type. A type argument is **required** — the
compiler derives a JSON schema from `T` and verifies the response against it at
fetch time. A response that is missing a required field or has a mismatched
type lands on `error` with `result` left undefined; fields the type does not
mention are allowed through.

```typescript
// Shown for illustration only.
interface Repo {
  name: string;
  stargazers_count: number;
}

const repo = fetchJson<Repo>({ url: apiUrl });

// Response: { result: Repo, error: any, pending: boolean }
{repo.pending
  ? <span>Loading...</span>
  : repo.error
  ? <span>Error: {String(repo.error)}</span>
  : <p>{repo.result?.name} ({repo.result?.stargazers_count}★)</p>}
```

Calling `fetchJson` without a type argument is a compile error. Reach for
`fetchJsonUnchecked` when the response shape isn't declared as a type.

## fetchText

The response body decoded as UTF-8 text.

```typescript
// Shown for illustration only.
const page = fetchText({ url: resolvedUrl });
// Response: { result: string, error: any, pending: boolean }
```

## fetchJsonUnchecked

JSON parsed without a type or verification — the escape hatch for responses
whose shape you don't declare. `result` is typed `any`.

```typescript
// Shown for illustration only.
const models = fetchJsonUnchecked({ url: "/api/ai/llm/models" });
```

## fetchBinary

The raw response bytes plus the media type.

```typescript
// Shown for illustration only.
const file = fetchBinary({ url: assetUrl });
// Response: { result: { bytes: FabricBytes, mediaType: string }, error, pending }
```

`bytes` is a `FabricBytes` byte buffer; read it with `slice()` / `copyInto()`.
`mediaType` comes from the `Content-Type` response header (for example
`"image/png"`).

## POST and request options

Pass an `options` object for the method, headers, and body. A non-string body
is stringified for you, so a `body` can be a plain object (or a `computed()`
that produces one).

```typescript
// Shown for illustration only.
const result = fetchJson<SearchResult>({
  url: "/api/agent-tools/web-search",
  options: {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: { query, max_results: 5 },
  },
});
```

## Processing arrays

Map over items — memoization is automatic per item:

```typescript
// Shown for illustration only.
const pages = urls.map((url) => ({
  url,
  data: fetchJson<Page>({ url }),
}));

{pages.map(({ url, data }) => (
  <div>{data.pending ? <em>Loading...</em> : <p>{data.result?.title}</p>}</div>
))}
```

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
[`patterns/examples/fetch-json/fetch-json.tsx`](../../../patterns/examples/fetch-json/fetch-json.tsx).
