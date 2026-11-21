# Pattern index

`@commonfabric/pattern-index` is the host-side client for the cloud pattern
index. The server lives in
[`commontoolsinc/pattern-index`](https://github.com/commontoolsinc/pattern-index).
The package signs calls with the Fabric CF1 HTTP scheme, checks HTTP and JSON
responses, and composes requests for index frontends. The index resolves
discoverable successors itself, so a search answer's rows are current
generations. A row carries an optional display `name`, present when the index
holds or can derive one, and a replacement carries the `supersedes` id it
matched as. Callers supply a signer and can substitute the HTTP transport.

Import the client from `@commonfabric/pattern-index/client`, search-body
composition and the status rule from `@commonfabric/pattern-index/front`, or
verdict mapping and recording from `@commonfabric/pattern-index/feedback`.
`recordPatternFeedback()` preserves the harness caller's optional `note`. The
console owns its four-read allowlist and dispatcher, including metadata-only
`getPattern` reads. Publishing and retraction remain explicit client methods.

## Deploying an indexed pattern

`@commonfabric/pattern-index/deploy` is the one place a published pattern is
deployed from. cf-harness's `run_pattern` uses it when a model names a
`patternId`, and `cf piece new --from-index <patternId>` uses it to create a
piece. `compileIndexedPattern()` fetches the program with its source, draws
every published pattern it imports through `cf:pattern:` into the space so those
imports resolve, and compiles it there; it answers the index's display `name`
for the pattern beside the program, when the index has one.
`prepareIndexedProgram()` stops before the compile, and `composeProgram()` does
only the import step, for authored source that composes published patterns.

Every failure is an `IndexedPatternError` with a `stage` of `lookup`, `compose`,
or `compile`. Its message never quotes indexed source: where it names a pattern
it names its id, and some failures, such as a runtime without CFC enforcement or
a composition past the cap, name none. A compile diagnostic, or an index
response body, can quote that source, so it is kept apart as `rawCauseMessage`
for an artifact or an operator log.

## Syncing a repository

A GitHub repository's pattern entries are published to the index, one lineage
per entry file, in two steps that run in two jobs. `sync-plan.ts` compiles every
entry and writes a plan, holding no credential. `sync-publish.ts` reads the
plan, compares each entry's source hash and pattern id with the ones
`listRepoHeads` returns for its path, publishes what changed, and withdraws the
lineages of paths that are gone (`withdrawRepoPaths`). Its only credential is a
GitHub OIDC token bound to a key made for the run (`src/github-oidc.ts`).
`src/repo-sync.ts` says why the two steps are kept apart, and `src/repo-plan.ts`
decides which files are entries. Other repositories adopt it through the
composite action in `.github/actions/pattern-index-sync`, whose README covers
adoption and the run step by step. This repository's own patterns sync through
`.github/workflows/pattern-index-sync.yml`, which runs only while the repository
variable `PATTERN_INDEX_SYNC` is `on`.

A publish the index refuses for its program's size is listed in the sync summary
as too large for the index, with the server's byte limit, rather than as failed.
Like an entry with no description, it does not fail the job, and the sync
continues with the remaining entries. Only the server's fixed size-error wording
with a bounded decimal limit is recognized; any other refusal fails the entry,
and other index response details remain withheld.

## Loom helper contract

Loom's CFS commands spawn `runtime/pattern-index/cli.ts` once per request:

```sh
deno run --no-lock --config deno.jsonc --allow-read=/path/to/identity.key \
  --allow-net=index.example \
  runtime/pattern-index/cli.ts \
  --identity /path/to/identity.key --base-url https://index.example
```

The complete permission set is `--allow-read=<identity path>` and
`--allow-net=<base URL hostname>`. Environment and FFI grants are not required;
the subprocess tests run without them. Loom resolves its generated `deno.json`
or the checkout's `deno.jsonc` through its vendor-config helper.

The identity file contains PKCS#8 bytes. The helper reads one JSON value until
stdin closes, writes one JSON answer followed by a newline on stdout, and exits.
Its operations are:

- Search: `{"op":"search","text":"calendar","limit":10,"tags":["time"]}`. Search
  fields are optional and use the read frontend's shaping: string text, numeric
  limit, and the string entries of a tags array. The result is
  `{"ok":true,"value":{"results":[...]}}`, as the index answered it.
- Feedback: `{"op":"feedback","patternId":"...","verdict":"up"}`. Verdicts are
  `up` and `down`, recorded as `thumbs_up` and `thumbs_down`. The result is
  `{"ok":true,"value":{"patternId":"...",
  "eventType":"thumbs_up","recordedBy":"did:key:..."}}`.
  The author comes from the signer. Extra input fields, including `did` and
  `note`, are omitted.
- Source: `{"op":"source","patternIds":["..."]}`, one to five ids. Each
  pattern's program, in the order asked, for a caller that builds on it:
  `{"ok":true,"value":{"patterns":[{"patternId":"...","name":"...",
  "description":"...","mine":false,"program":{"main":"...","files":[...]}}]}}`,
  where `name` and `mine` appear only when the index answers them. A pattern the
  index does not hold or will not show the signer answers
  `{"patternId":"...","status":404}` in its place, and one it answered without
  its program `{"patternId":"...","status":403}`; any other refusal answers the
  whole request. The patterns are read concurrently.
- View: `{"op":"view","piece":"piece:<sha256 hex>"}` or
  `{"op":"view","patternId":"..."}`, exactly one. It records the signer's
  `viewed_in_loom`: a piece key (`deployedPieceRef`) counts toward settling the
  version of theirs deployed to that piece: used for a day with no newer
  version, and past the privacy check, it is shared under their sharing setting.
  It ranks nothing. A pattern id ranks a pattern the person placed from the
  index. The result is the index's answer,
  `{"ok":true,"value":{"ok":true,
  "recorded":false,"settled":{...}}}`; an
  index answer of `ok:false` returns status 502.
- Sharing settings: `{"op":"getSharing"}` reads the signer's member's
  give-to-get settings, and `{"op":"setSharing","enabled":false}` changes them,
  sending only the switches given (`enabled`, `selfBuilt`, each a boolean; at
  least one). Both answer
  `{"ok":true,"value":{"enabled":true,"selfBuilt":true,
  "receivesAnonymous":true,"updatedAt":null}}`,
  as the index answered it.

Membership operations (`whoami`, `admit`, `join`) are described with the
membership store below.

A refused request returns `{"ok":false,"status":400,"error":"..."}`. Index 4xx
statuses pass through, including distinct 401 signature failures and 403
allowlist refusals, even when their body is not JSON. Other index failures,
successful replies with unreadable JSON, and an event response with `ok:false`
return status 502. Reply errors contain stable messages, withholding the index's
raw body. Completed requests, including refusals and malformed JSON input, exit
zero. Host failures such as an unreadable key, an invalid base URL, or a failed
transport exit nonzero with detail on stderr and nothing on stdout. Missing
required flags exit 2.

A search is one signed request. The helper uses no cache or resident service.
The CLI import graph reaches the runner through its `toolshed-http-auth` export,
for CF1 signing.

## Tests

`deno task test` runs client, deploy, and CLI tests. CLI tests spawn the helper
against a loopback server that verifies CF1 signatures from throwaway
identities; they use the CFS invocation with no lockfile and never call the
deployed index.
