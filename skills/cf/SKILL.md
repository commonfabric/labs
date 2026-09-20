---
name: cf
description: Guide for using the cf (Common Fabric) CLI to interact with pieces,
  patterns, and the Common Fabric. Use this skill when deploying patterns, managing
  pieces, linking data between pieces, or debugging pattern execution. Triggers include
  requests to "deploy this pattern", "call a handler", "link these pieces", "get data
  from piece", or "test this pattern locally".
---

# CF CLI

The `cf` CLI is the command-line interface for Common Fabric. **Use `--help` for
current commands:**

```bash
deno task cf --help           # Top-level commands
deno task cf piece --help     # Piece operations
deno task cf check --help     # Type checking
```

## Invocation Paths

Three ways to run the CLI, in order of preference. All run from source, so they
always match the working tree:

1. **`cf` (via `bin/cf`)** — a plain `cf` backed by source, put on PATH once per
   machine by `deno task install-cf`; the copy serves every checkout. On a
   machine that never ran it — an agent's shell, often — route 2 needs nothing
   on PATH. Works from any cwd, and shell completion requires a `cf` on PATH. It
   runs whichever checkout you are standing in (nearest one walking up, or a
   host's `vendor/labs`), not the one it was installed from — set `CF_LABS_ROOT`
   to override when your cwd cannot say what you mean, and run `cf which` to see
   which CLI would run and why. See "Which checkout runs" in
   `packages/cli/README.md`.

2. **`deno task cf ...`** — works from any directory inside the repo (the
   launcher resolves the repo root itself and runs the CLI from your invoking
   cwd). Deno prints a one-line `Task cf ...` echo to stderr; silence it with
   `deno -q task cf ...`. stdout stays clean, so redirection is safe.

3. **`deno run -q -A packages/cli/mod.ts ...`** — repo-root-relative; only works
   with the repo root as cwd. The `-q` suppresses Deno's own warnings (e.g. the
   npm "Ignored build scripts" banner).

**Do not put `dist/cf` on your PATH.** `deno task build-binaries cf` still
produces it, and CI uses it (a CI run never edits the source it was built from),
but there is no invalidation story for a working tree you are actively editing:
nothing compares the binary against its sources, so it silently serves stale
behavior after a `git pull` or a local edit. See "Why not `dist/cf`" in
`packages/cli/README.md`, and the "FUSE mount wrapper mismatch" entry below for
what this looks like when it bites.

## Output Conventions (scripts & agents)

- stdout carries command output only; hints, tips and diagnostics go to stderr.
  `cf cell get` prints JSON, with no ANSI to strip, and represents an absent
  value as `null`.
- ANSI colors are emitted only when stdout is a TTY. Force off with `--no-color`
  or `NO_COLOR=1`; force on (e.g. through a pager) with `FORCE_COLOR=1`.
  (`cf view` keeps its own `--color` flag.)
- `-q/--quiet` (on `piece`/`wish` subcommands) suppresses hints and next-step
  blocks on stderr. To also drop runtime warnings, add `--log-level error` (`-q`
  deliberately leaves the log floor alone — scripts parse those warnings).
- `cf piece call` payloads: inline JSON argument, `-` to read stdin
  (`echo '{...}' | cf piece call ... handler -`), a bare pipe with no payload
  argument, or schema-derived flags in the callable's section — directly after
  the verb, before any `--`. Empty stdin fails loudly.
- A `cf cell get` path that doesn't resolve is a data error: one-line message on
  stderr, exit 1 (no usage screen). A `piece link` that fails validation
  (missing source/target piece or path) reports the same way. So does a
  `cf cell get` path that lands on a handler verb: reading a stream refuses —
  read data, call verbs. A root verb's refusal points at `cf piece call` (its
  literal spelling); a nested verb is not directly callable, so it points at
  reading the parent object or `cf piece verbs`. The verb's parent object still
  reads, and tool bindings read as data.

## Environment Setup

**Identity key** (required for most operations):

```bash
ls -la cf.key                  # Check for existing

# Never overwrite an existing key file — existing identity-scoped data
# becomes invisible under a new identity.

# Default: a fresh, UNIQUE key. Use this for normal pattern dev and for any
# server (local, shared, or remote).
deno run -A packages/cli/mod.ts id new > cf.key

# To match a browser identity registered with a recovery phrase:
deno run -A packages/cli/mod.ts id from-mnemonic -- phrase.txt > cf.key

# To reproduce a key from your OWN secret passphrase (unique to you; pass via
# file or stdin to keep it out of shell history):
deno run -A packages/cli/mod.ts id derive -- passphrase.txt > cf.key
```

Both `id derive` and `id from-mnemonic` accept the secret three ways: as a file
(`-- <file>`), on stdin (`-`, or no argument), or as an inline positional
argument. Prefer a file or stdin for real secrets — an inline argument is
visible in shell history and to other processes via `ps`. A single trailing
newline is stripped from file/stdin input, so `echo`/editor input matches the
equivalent inline value.

Note: `id derive` (passphrase) and `id from-mnemonic` (BIP-39 phrase) use
different derivations and produce different DIDs from the same text. Use
`from-mnemonic` to match browser mnemonic login; see
`docs/features/shared-identity.md`.

Redirecting stdout (as above) is safe through any invocation path: the
`deno task` echo and all Deno/CLI diagnostics go to stderr, so
`deno task cf id new > cf.key` produces a clean key file.

**Environment variables** (avoid repeating flags):

```bash
export CF_API_URL=http://localhost:8000  # local dev default; only target a remote instance when the task explicitly requires it — remote set/rm/setsrc mutate shared state
export CF_IDENTITY=./cf.key
```

**Identity visibility footgun:** If CLI and browser use different DIDs, the same
piece should still load and unscoped/`PerSpace` data should remain visible, but
`PerUser`, `PerSession`, favorites, drafts, and home-space state may look empty
or default. For identity-sensitive local work, use one key everywhere — generate
it with `id new` and import the CLI PKCS8/PEM key in the browser via
`Import CLI Key`. See `docs/features/shared-identity.md`.

**Experimental flags** must be set as env vars on both servers AND CLI commands.
See `docs/development/EXPERIMENTAL_OPTIONS.md` for available flags.

**Local servers**: See `docs/development/LOCAL_DEV_SERVERS.md`

## Naming a target

Every read and every call names a target, and the spelling decides whether the
answer composes into the next command.

<!-- check-address-examples-ignore: /@my-space/tracker/items the bullet below quotes it as the spelling `cf` refuses -->

- `//<space>/<piece>[@<scope>][/<path>]`, and `/<piece>[@<scope>][/<path>]`
  where `--space` names the space — the reference, the one syntax the whole
  fabric shares. `<space>` is a name or a DID and `<piece>` is a slug or a
  handle, so `//my-space/tracker/items` and `//did:key:.../of:fid1:.../items`
  are the same shape. A space embedded in it supplies `--space` when the flag is
  absent, and must agree with it when both are given. **An address printed by
  one command is accepted by the next with no flag beside it.**
- `//` is the space prefix to write, for a name and for a DID alike. `/@` is
  accepted before a DID, so `/@did:key:.../of:fid1:.../items` still reads;
  before a name it is refused, and `/@my-space/tracker/items` reports the
  `/@my-space/` prefix retired and names `//my-space/` to write instead.
  `packages/cli/README.md` carries the whole grammar.
- On `cf cell get`, `cf cell set` and `cf piece call`, write the reference in
  the first positional — `cf cell get /tracker items/0/title`. A reference
  begins with `/` and a relative path never does, so the two cannot collide.
  This is the spelling to reach for.
- `cf piece call` follows a path on its target to the piece linked there:
  `cf piece call //space/of:fid1:…/inbox/piece receive '{…}'` calls `receive` on
  the piece `inbox.piece` links to, in whatever space that link names (opened
  under the same identity; that space's ACL and CFC decide). Never read a
  `$link` and rebuild an address for this. Note that `--select 'inbox.piece@'`
  prints the address of the _position_ (`/of:…/inbox/piece`), not of the linked
  piece — which is exactly the reference to hand `cf piece call`. A path with no
  link stored at it exits 1 with `names no piece` in the message; a link naming
  a cell rather than a piece exits 1 with `links to a cell inside a piece`.
  Every other piece-only command refuses a path on a handle.
- `--cell <reference|id|slug>` takes the same target where a flag suits better,
  and is where the bare id and slug spellings go — there no path competes for
  the position. `--piece` is a deprecated name for that same flag: still
  accepted, no expiration date, and not what to write new commands against.
  Naming the target twice — the flag beside a positional reference — is refused.
- `--url <browser url>` is a convenience for pasting. It is not a spelling of
  its own: the host becomes `--api-url` and the rest becomes a reference.
- A target ending `#argument` selects the piece's arguments cell — the same
  selection `--input` makes, and it is accepted exactly where `--input` is:
  `cf cell get`, `cf cell set`, and `cf cell get-label|set-label`. A reference,
  a bare id and a slug all take it, since all three designate the same piece. A
  command that takes no `--input` refuses the suffix rather than ignoring it,
  `cf piece call` among them. A `--url` carries no fragment into the reference
  it decomposes to, whatever the URL names, so a `#argument` written on one is
  dropped rather than refused. A URL naming the piece admits no `--cell` or
  positional address beside it, so `--input` is what reaches the arguments cell
  there; a URL naming only the space leaves the target to arrive as it always
  does — a positional address, or `--cell` — carrying the suffix like any other.

## Where the read options go

`--select`, `--schema` and `--filter` shape what a read returns, and every
command that returns data carries all three: `cf cell get`, `cf wish`,
`cf piece call`, `cf exec`. `--select` takes a field list, `--schema` a full
JSON Schema, and naming both on one line is refused rather than resolved.

They come after the thing they shape, on all four. Whether a marker stands in
between depends on whether a callable's own vocabulary does. `cf cell get` and
`cf wish` have none, so the flags follow the target directly. `cf piece call`
and `cf exec` have one — the verb, or the mounted file, opens the callable's
section — so `--` closes that section and the read options follow it:

```text
cf cell get  <addr> [path]           --select …
cf wish <target>                --select …
cf piece call <target> <verb> <input> -- --select …
cf exec <mountedFile> <input>   -- --select …
```

A projection written before the verb is **refused**, and so is one written
inside the callable's section; each refusal names the section the flag belongs
to and prints the corrected line. `--` is **refused** on `cf cell get`,
`cf cell set` and `cf wish`: there is no section to close, and the words after
it would be set aside unread. `--help` past the marker still reaches the
callable and prints that verb's page.

**Resolving a wish writes.** `cf wish` commits a cell to the space as part of
resolving the query, so it is not a free read and not safe to issue
speculatively against a space you do not intend to touch.

## Quick Command Reference

`cf profile` is a person's profile from the command line.
`cf profile create <name>` is the shell's create form as a command: the profile
is made by the home pattern's own handler, in a space of its own, and its
address printed. `cf profile show` prints the address and name `#profile`
resolves to. Both take `-i`/`-a` and target the identity's home space; there is
no `--space`.

| Operation          | Command                                                                                                                                              |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Type check         | `deno task cf check pattern.tsx --no-run`                                                                                                            |
| Test pattern       | `deno task cf test pattern.test.tsx`                                                                                                                 |
| Deploy new         | `deno task cf piece new pattern.tsx --test pattern.test.tsx --root . --repository REPO -i key -a url -s space`                                       |
| Attach a data file | `deno task cf piece new pattern.tsx --test pattern.test.tsx --datafile data/cities.json ...`                                                         |
| Update existing    | `deno task cf piece setsrc pattern.tsx --test pattern.test.tsx --root . --repository REPO --cell ID -i key -a url -s space`                          |
| Follow an origin   | `deno task cf piece follow --cell ID system:system/profile-home.tsx ...` (point a detached piece at an origin and adopt it; releases follow on open) |
| Inspect state      | `deno task cf piece inspect --cell ID ...`                                                                                                           |
| Get field          | `deno task cf cell get --cell ID fieldPath ...`                                                                                                      |
| Filter array       | `deno task cf cell get --cell ID items --filter '.active == true' ...`                                                                               |
| Project fields     | `deno task cf cell get --cell ID items --select id,title ...`                                                                                        |
| Read an address    | `deno task cf cell get --cell ID --select 'topic@,topic.title' ...`                                                                                  |
| Read addresses     | `deno task cf cell get --cell ID items --schema '{"type":"array","items":{"$link":true}}' ...`                                                       |
| Step + get         | `deno task cf cell get --cell ID fieldPath --step ...`                                                                                               |
| Set field          | `echo '{"data":...}' \| deno task cf cell set --cell ID path ...`                                                                                    |
| Call handler       | `deno task cf piece call --cell ID handlerName ...`                                                                                                  |
| Shape a result     | `deno task cf piece call --cell ID addTopic ... -- --select topic.title`                                                                             |
| List verbs         | `deno task cf piece verbs --cell ID --json ...` (`--all` adds wrapper/deprecated; `hidden` counts them)                                              |
| Trigger recompute  | `deno task cf piece step --cell ID ...`                                                                                                              |
| Mint a session     | `export CF_INVOCATION_SESSION="$(deno task cf invocation-session new)"` (once per run; ids deduplicate only within it)                               |
| Replayable call    | `deno task cf piece call --cell ID --invocation my-id-1 handlerName ...` (same pair retries settle on the original outcome)                          |
| Detached call      | `deno task cf piece call --cell ID --no-wait --invocation my-id-1 handlerName ...` (exits at commit with `receipt` address)                          |
| Collect a receipt  | `deno task cf cell get --cell <receipt> ...` (the envelope's `receipt` string, later, from any process)                                              |
| Create a profile   | `deno task cf profile create "Ada Lovelace" -i key -a url` (the shell's create form, from the CLI; prints the address)                               |
| Show the profile   | `deno task cf profile show -i key -a url` (the address and name `#profile` resolves to, as JSON)                                                     |
| List pieces        | `deno task cf piece ls -i key -a url -s space` (registry only — a handler-created piece appears only if sent to `addPiece`)                          |
| Describe a piece   | `deno task cf piece describe --cell ID ...` (name, purpose, state, inputs, verbs; `--json`, `--all`)                                                 |
| List slugs         | `deno task cf piece slugs ...`                                                                                                                       |
| Search piece data  | `deno task cf piece search <query> ...` (registered pieces only)                                                                                     |
| Visualize          | `deno task cf piece map ...`                                                                                                                         |
| Rehearse an update | `deno task cf space clone <did> --from <snapshot> --to <dir>` (then `verify` / `reset`)                                                              |

## Check Command Flags

`deno task cf check` compiles and evaluates patterns. Key flags:

| Flag                   | Purpose                                            |
| ---------------------- | -------------------------------------------------- |
| `--no-run`             | Type check only, don't execute                     |
| `--no-check`           | Execute without type checking                      |
| `--json`               | Compile without evaluating; print compiled JSON    |
| `--show-transformed`   | Show the transformed TypeScript after compilation  |
| `--verbose-errors`     | Show original TS errors alongside simplified hints |
| `--pattern-json`       | Print the evaluated pattern export as JSON         |
| `--output <path>`      | Store compiled JS to a file                        |
| `--main-export <name>` | Select non-default export (default: `"default"`)   |

`--json`, `--show-transformed`, and `--pattern-json` are mutually exclusive.
Each mode waits for every input to succeed before it writes to stdout. Errors go
to stderr and leave stdout empty.

Common usage:

```bash
deno task cf check pattern.tsx              # Compile + execute (quiet on success)
deno task cf check pattern.tsx --no-run     # Type check only (fast)
deno task cf check pattern.tsx --no-check   # Skip types, just execute
deno task cf check pattern.tsx --json       # Structured compiled output
deno task cf check pattern.tsx --show-transformed  # Debug compiler transforms
deno task cf check pattern.tsx --verbose-errors     # Detailed error context
```

## Core Workflow: setsrc vs new

**Critical pattern:** Run every authored test before deployment. After initial
deployment, use `setsrc` to iterate and repeat the complete set of attached test
entries:

```bash
# Before every deployment
deno task cf test pattern.test.tsx

# First time only
deno task cf piece new pattern.tsx --test pattern.test.tsx ...
# Output: Created piece bafyreia... <- Save this ID!

# ALL subsequent iterations
deno task cf piece setsrc pattern.tsx --test pattern.test.tsx --cell bafyreia... ...
```

**Why:** `new` creates duplicate pieces. `setsrc` updates in-place. `--test`
packages and type-checks a test entry but does not run it. Repeat the flag for
every authored test entry. Each `setsrc` describes a complete new source
revision, so omitting the flags drops those test roots from that revision.

A file that is not code — a fixture, a lookup table, a list of names — ships and
is recovered with the source. Its bytes are stored verbatim: never parsed,
type-checked, compiled, or importable, and the pattern reads one with
`dataFile("./data/cities.json")` from `commonfabric`. That call is the
declaration, and its path resolves against the module that reads it, the way an
import specifier does. Store the file where the call points and `new`, `setsrc`,
`check`, `test`, and `dev` all attach it, the way they already follow what the
source imports. A name with no file behind it fails the build and says which
module read it.

`--datafile <path>` attaches a file the source cannot name: one read by a
computed path, or one that ships with a program that does not read it. It adds
to what the source declares rather than replacing it. A data file must be UTF-8
text and sit inside the deployment root, which the CLI infers to cover the main
entry, every test entry, and every data file unless `--root` says otherwise.
Like `--test`, the flag is repeatable and defines part of the revision, so
repeat the complete set on every `setsrc`. Changing a data file alone still
produces a new source revision.

`setsrc` normally rejects incompatible argument/result schema changes and
retained links whose durable contracts no longer fit. For an intentional
breaking migration, `--dangerously-allow-incompatible-schema` bypasses those
compatibility proofs. `new` accepts the same flag for deploy-script symmetry,
though a fresh piece has no predecessor schema to compare.

Source-file writes through `cf fuse mount` hit the same update gate. Mount with
`--dangerously-allow-incompatible-schema` when those writes are part of the same
intentional breaking migration.

### Source location metadata

The local-source deployment commands `piece new`, `piece setsrc`, and custom
`space set-home` accept repeatable `--test` flags as well as `--root` and
`--repository`. Attach every authored pattern test. Use the repository checkout
root for `--root`; this preserves `source.entry` as a path inside the
repository. `--repository` is stored exactly as supplied in `source.repository`
and is never inferred from Git configuration. On `setsrc`, omitting
`--repository` preserves the existing value; supplying it replaces the value.
Test flags are different: every source update must repeat the complete list.
`piece inspect --json` and `piece ls --json` expose the resulting structured
source locator.

## JSON Input Format

All values to `set` and `call` must be valid JSON:

```bash
# Strings need nested quotes
echo '"hello world"' | deno task cf cell set ... title

# Numbers are bare
echo '42' | deno task cf cell set ... count

# Objects
echo '{"name": "John"}' | deno task cf cell set ... user
```

`cf cell get` and `wish` always print JSON. Both accept a redundant `--json` so
callers can request the format explicitly.

`cf cell get --filter` accepts a jq-inspired predicate over array items: paths,
JSON literals, comparisons, `and`/`or`/`not`, and parentheses. Only `false` and
`null` are falsey; stored `undefined` is treated like a missing value and is
also falsey. Non-array inputs are rejected. Two flags project the output:
`--select` takes a comma-separated field list, and `--schema` takes an inline
JSON Schema or `@schema.json` — and still accepts the same field list. Naming
both on one command is refused. A field list applies per item for arrays, while
a JSON Schema describes the whole output. In a JSON Schema, `properties`
projects an object and `items` projects an array at every level of nesting, with
or without a matching `type`. In an array-item projection, a typed scalar leaf
that does not match stored data is omitted rather than reported as an error;
prefer `true` leaves unless type filtering is intentional. Concise dotted paths
follow declared source schemas through nested arrays: `comments.body` selects
`body` from every comment and drops its siblings. Source-declared nullable items
and properties remain null. If a present source cannot materialize the
transform, the command exits nonzero with an explicit "not JSON null" error; an
absent optional source retains the ordinary successful `null` response. If the
source schema does not identify a nested container, concise projection still
applies its field mask across encountered arrays to prevent sibling disclosure;
use an explicit schema for a fixed output contract. A filter and a projection
compose as filter-then-project. Both run through runtime filter/map/lift nodes,
which construct projected values from source-schema-selected reads. A declared
root shape and structurally selectable properties make the initial read the
union of predicate and projection paths, so omitted linked subgraphs are not
hydrated; ambiguous compositions can retain a wider selector. A schemaless
source probes its stored root without following children; a stored object or
array establishes the shape directly. Root links, instances, and root-union
schemas need materialization to establish that shape. CFC behavior is the same
as a computed pattern expression. Source schema metadata is authoritative;
projection schemas cannot supply `ifc`, `asCell`, `scope`, or `default`. A
projection marks a position to get that position's address — one string in the
canonical reference syntax `[//<space>]/<id>[@<scope>][/<path>]`, where the
space is written as a DID and rides in front only when it differs from the space
the command targeted, and the scope follows the id only when it is not the
default, no schema inlined — instead of what is behind it, or beside a
projection to get both. A JSON `--schema` marks with `"$link": true`; a field
list marks with a trailing `@`, so `--select 'topic@,topic.title'` returns one
`topic` carrying its address and its title. A path that is only `@` marks the
position the read is already at, so `--select '@'` returns the source's own
address and `--select '@,title'` returns it beside the title. `@` is otherwise
special only at the end of a segment and `\@` writes a literal one, which keeps
a field named `user@home` reachable; a leading `@` followed by anything else is
the `@file` only `--schema` reads. A field list applies to each element wherever
it crosses an array, an address included, so `--select 'notes@'` returns one
address per note and is the concise spelling of
`--schema '{"type":"array","items":{"$link":true}}'`; a marked position holding
anything else returns its own address. That address is the deepest stored link
crossed on the way to the marked position plus the segments below it, so marking
a field under a linked element names that element's own document rather than a
slot in the collection above it; a position with no link above it keeps the
source document's own address. A marked position is never fetched, so a marked
collection costs one document read rather than one per element; the rendered
address is what `--cell` accepts, scheme included, so an emitted address
composes into the next command unchanged, without being reassembled. Neither
spelling composes with `--filter`. See `packages/cli/README.md` for the exact
syntax and supported schema subset.

A field list is held to the source's own vocabulary, and a position states that
vocabulary by carrying a `properties` map: one declaring no fields
(`properties: {}`) refuses every name, while a position with no map at all
declares nothing and refuses none. A path the schema proves nothing can appear
at — a field the position neither declares nor admits, a field named below a
scalar, a field named below a verb — is refused before the read, naming the
position, what it declares, and, where one is close enough, the declared name
the path is a typo of. A field that is merely absent still returns nothing at
exit 0, so a `{}` from a field list reads as "nothing here" rather than "you may
have mistyped". Where the source schema settles nothing — an open
`additionalProperties`, a `patternProperties` map that names a pattern, a
disjunction, an untyped position, a position that only may hold an array, a
tuple-shaped array, a reference site declaring fields of its own, a name several
`allOf` members declare — no refusal is available. An unresolvable reference is
passed over too, and the read reports the reference itself. A JSON `--schema`
states a shape of its own rather than naming the source's fields, and is not
held to that vocabulary.

`cf piece call` takes the same three flags, past the `--` that closes the
callable's section, with the same grammar, the same `--select`/`--schema`
conflict, and the same error messages. They shape the result of the call — a
handler's `result` inside the Invocation JSON, or a tool's JSON on stdout:

```bash
deno task cf piece call --cell ID addTopic '{"title":"Ship it"}' -- --select topic.title
```

A selection can narrow a handler receipt's linked fetches: a schemaless receipt
holding a stored object or array is selected before its children are loaded.
Root links, instances, scalars, explicitly schema-constrained receipts, and tool
results are materialized before selection. A value-less verb therefore still
reports no `result` at all rather than `{}` — but a selection that keeps nothing
from a result that does exist is refused, so the two stay distinguishable. A
shaped call also waits on the CLI runtime's global idle, not just its own
handling's commit, so on a piece with heavy derived state prefer calling plain
(or `--no-wait`) and shaping the collect:
`cf cell get --cell <receipt id> --select …`. `--no-wait` refuses all three
flags, since it skips the receipt readback they are answered from.
`--show-links` composes with a projection — links are collected after the
selection, so each address names a position in the value you were handed — but
not with `--filter`, which moves the positions a link names.

`wish` and `exec` take the same three flags too, so all four arrivals shape
their output the one way. `wish` writes them beside its target and shapes the
cell the query resolved to; a query that matched nothing stays an ordinary empty
result rather than becoming an error. `exec` writes them **past the marker that
closes the section the mounted file opened**, since everything between the two
belongs to the callable's own schema-derived interface — which also means a
callable run through its own shebang cannot carry them. `exec` settles a handler
under an invocation of its own and prints the same Invocation JSON
`cf piece call` does; a tool's result stays on stdout with its result cell's
address on stderr, written as an address argument `--cell` takes unchanged.

```bash
deno task cf wish '#profile' -i ./claude.key --select name,avatar
deno task cf exec /tmp/cf/…/result/search.tool --query milk -- --select id,title
```

For `cf piece call`, options before the callable name configure `cf piece call`.
Arguments after the callable name configure the invoked handler or tool, until
`--` closes that section. The JSON forms match `cf exec`:

```bash
# Complete input as an inline JSON value
deno task cf piece call --cell ID search --json '{"query":"milk"}'

# Complete input from stdin
printf '%s' '{"query":"milk"}' |
  deno task cf piece call --cell ID search --json

# Machine-readable callable schema
deno task cf piece call --cell ID search --help --json

# Schema-derived input flags, in the section the callable name opened
deno task cf piece call --cell ID search --query milk
```

A single positional JSON value after the callable is also accepted. Use
`--json-file <path>`, in the same section, to read JSON from a file. Handler
confirmations move to stderr when JSON input is selected, so stdout remains
available for JSON tool results. Errors always go to stderr.

## Gotcha: Always `step` After `set` or `call`

Neither `cf cell set` nor `cf piece call` triggers recomputation automatically.
You **must** run `piece step` after either one to get fresh computed values.
When the value is session-scoped, use `cf cell get --step` so recomputation and
the read happen in the same CLI session; a separate `piece step` process cannot
carry session-local materialization into the following `cf cell get` process.

```bash
# After setting data:
echo '[...]' | deno task cf cell set --cell ID expenses ...
deno task cf piece step --cell ID ...  # Required!
deno task cf cell get --cell ID totalSpent ...

# Equivalent one-session read (required for session-scoped computed output):
deno task cf cell get --cell ID totalSpent --step ...
```

A path-less `cf cell get` (whole result) degrades outputs it cannot reach —
values living in another session's/user's scope are simply absent from the
returned object rather than voiding the whole read. Use `--step` when you need
those members materialized in your own session.

```bash
# After calling a handler:
deno task cf piece call --cell ID addItem '{"title": "Test"}'
deno task cf piece step --cell ID ...  # Required!
deno task cf piece inspect --cell ID ...
```

`piece inspect` prints a `--- Cached Result Fields ---` section naming every
result field whose resolution crosses a computed cell, with each computed cell's
last-derived commit. The commit the argument document stands at is printed
beside the field. A computed cell which links on to live state is still named:
the cached choice of link can be stale. Commit numbers from different spaces do
not order, and the output identifies that case instead of comparing them. Result
fields the section does not name resolve entirely through live state. `--json`
carries the same information as `cachedResultFields`, `sourceCommit`, and
`sourceSpace`.

**Handler testing workflow** (automated test → deploy → call → step → inspect):

```bash
# 1. Run the authored automated test
deno task cf test pattern.test.tsx
# 2. Deploy with the test attached
deno task cf piece new pattern.tsx --test pattern.test.tsx -i key -a url -s space
# 3. Call a handler
deno task cf piece call --cell ID handlerName '{"arg": "value"}' ...
# 4. Step to process
deno task cf piece step --cell ID ...
# 5. Inspect result
deno task cf piece inspect --cell ID ...
# 6. Repeat 3-5 for each handler
```

See `docs/common/workflows/handlers-cli-testing.md` for the full workflow and
`docs/development/debugging/cli-debugging.md` for debugging.

## Troubleshooting

| Issue                        | Fix                                                                          |
| ---------------------------- | ---------------------------------------------------------------------------- |
| Commands hang                | Check Tailnet connection for `*.ts.net` URLs                                 |
| Permission denied            | `chmod 600 cf.key`                                                           |
| JSON parse error             | Check nested quotes, no trailing commas                                      |
| Local servers not responding | `./scripts/check-local-dev.sh` then `./scripts/restart-local-dev.sh --force` |

### FUSE mount wrapper mismatch

On some local setups, the installed `cf` wrapper (for example `dist/cf`) can lag
behind the source CLI and reject newer `fuse mount` flags such as `-s/--space`,
even when `deno task cf fuse mount --help` supports them.

**Symptom:**

```bash
cf fuse mount /tmp/cf -s my-space
# error: Unknown option "-s"
```

**Fix:** rebuild the binary (`deno task build-binaries --cli-only`), or use the
source CLI through the repo task wrapper (works from any directory inside the
repo):

```bash
export CF_IDENTITY=./cf.key
export CF_API_URL=http://localhost:8000

deno task cf fuse mount /tmp/cf -s my-space
```

This matters because preconnecting the space is required for writable FUSE
mounts; auto-discovered spaces may appear writable but silently drop writes.

## References

- `docs/common/verbs/agents-over-the-cli.md` - Reaching a piece with no id in
  hand: what bounds each discovery surface, and what an empty answer does not
  prove
- `packages/cli/README.md` - Piece references: the two reference forms, what
  each carries, and where a canonical address may be written
- `docs/common/verbs/over-the-cli.md` - The verb walkthrough: invocation ids and
  sessions, receipts, retries, and shaped reads, each step runnable
- `packages/patterns/system/default-app.tsx` - System pieces (pieceRegistry
  lives here)
- `docs/common/workflows/handlers-cli-testing.md` - Handler testing
- `docs/development/debugging/cli-debugging.md` - CLI debugging
