# Pattern index

`@commonfabric/pattern-index` is the host-side client for the cloud pattern
index. The server lives in
[`commontoolsinc/pattern-index`](https://github.com/commontoolsinc/pattern-index).
The package signs calls with the Fabric CF1 HTTP scheme, checks HTTP and JSON
responses, resolves discoverable successors, and composes requests for index
frontends. Callers supply a signer and can substitute the HTTP transport.

Import the client from `@commonfabric/pattern-index/client`, search-body
composition and the status rule from `@commonfabric/pattern-index/front`, or
verdict mapping and recording from `@commonfabric/pattern-index/feedback`.
`recordPatternFeedback()` preserves the harness caller's optional `note`. The
console owns its four-read allowlist and dispatcher, including metadata-only
`getPattern` reads. Publishing and retraction remain explicit client methods.

## Loom helper contract

Loom's CFS commands spawn `packages/pattern-index/cli.ts` once per request:

```sh
deno run --no-lock --config deno.jsonc --allow-read=/path/to/identity.key \
  --allow-net=index.example \
  packages/pattern-index/cli.ts \
  --identity /path/to/identity.key --base-url https://index.example
```

The complete permission set is `--allow-read=<identity path>` and
`--allow-net=<base URL hostname>`. Environment and FFI grants are not required;
the subprocess tests run without them. Loom resolves its generated `deno.json`
or the checkout's `deno.jsonc` through its vendor-config helper.

The identity file contains PKCS#8 bytes. The helper reads one JSON value until
stdin closes, writes one JSON answer followed by a newline on stdout, and exits.
Its only operations are:

- Search: `{"op":"search","text":"calendar","limit":10,"tags":["time"]}`. Search
  fields are optional and use the read frontend's shaping: string text, numeric
  limit, and the string entries of a tags array. The result is
  `{"ok":true,"value":{"results":[...]}}`, including successor substitution.
- Feedback: `{"op":"feedback","patternId":"...","verdict":"up"}`. Verdicts are
  `up` and `down`, recorded as `thumbs_up` and `thumbs_down`. The result is
  `{"ok":true,"value":{"patternId":"...",
  "eventType":"thumbs_up","recordedBy":"did:key:..."}}`.
  The author comes from the signer. Extra input fields, including `did` and
  `note`, are omitted.

A refused request returns `{"ok":false,"status":400,"error":"..."}`. Index 4xx
statuses pass through, including distinct 401 signature failures and 403
allowlist refusals; other index failures, unreadable JSON replies, and an event
response with `ok:false` return status 502. Reply errors contain stable
messages, withholding the index's raw body. Completed requests, including
refusals and malformed JSON input, exit zero. Host failures such as an
unreadable key, an invalid base URL, a failed transport, or an internal
successor-resolution error exit nonzero with detail on stderr and nothing on
stdout. Missing required flags exit 2.

Each process starts with an empty discovery-record cache. Within a client,
create-only lineage records are cached and catalog membership is read on each
nonempty search. The helper uses no persistent cache or resident service. The
CLI import graph reaches the runner through its `toolshed-http-auth` export, for
CF1 signing.

## Tests

`deno task test` runs client, successor, and CLI tests. CLI tests spawn the
helper against a loopback server that verifies CF1 signatures from throwaway
identities; they use the CFS invocation with no lockfile and never call the
deployed index.
