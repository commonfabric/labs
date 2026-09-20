# Stream markers out of stored data

**Status:** stage 1 has landed, as #7583. Stage 2 is open as #7589, rebased
onto `main` past it. Stage 3 is not started. Investigated against `main` at `59e8a2540` (2026-09-15); line
references are to that tree unless an item names a stage branch. A file is
named by its path under `packages/` the first time and by its basename after
that (`runner.ts` is `packages/runner/src/runner.ts`, `builder/pattern.ts` is
`packages/runner/src/builder/pattern.ts`); `docs/` and `scripts/` paths are
from the repository root.

**Summary.** A handler's event stream is stored today as a document whose value
is the sentinel `{ "$stream": true }`. That sentinel is the only thing handler
instantiation reads to decide a node is a handler, and the cold-start repairs
are keyed on that read failing on documents whose setup never wrote it. The
schema already knows which positions are streams — the `Stream<T>` brand
becomes `asCell: ["stream"]` — so the runtime should not need a stored value
to say the same thing. This plan moves stream-ness out of the value and into
two places that are already durable: the link schema the builder emits and the
module's own `wrapper: "handler"` flag. Handler dispatch becomes structural,
the cold-start repairs trigger on a structural mismatch instead of on the
missing marker, the stream's document keeps only the `result` back-link it
already carries, and the two readers that have nothing but that document, the
state inspector and a bare address in the runtime, resolve it through the
owner's manifest. FUSE's `entities/` view is not one of them: it projects a
stream's document as an empty owned document until the follow-up lets it
classify from the id.

The contract change to state up front: **a stream is declared by the schema
of the link that names it or by the kind of the handle that holds it. Its
document says nothing about it; a reader that has only the document resolves
it through the owner.**

## What the runtime does today

### The one real producer

- `stream()` creates a kind-`"stream"` cell whose schema is the bare event
  schema with no `asCell` stamp (`packages/runner/src/builder/reactive.ts:81`,
  `packages/runner/src/builder/module.ts:255`).
- `Cell.export()` reports `{ $stream: true }` as that cell's value, purely
  because of its kind (`packages/runner/src/cell.ts:3514`).
- The builder folds the exported value into the derived-internal-cell descriptor
  as `schema.default` (`packages/runner/src/builder/pattern.ts:472`, via
  `schemaWithDefault`).
- Setup seeds that default into the derived document, but only when the
  manifest has no entry for the cell yet (`packages/runner/src/runner.ts:3004`).

Every other writer is hand-rolled: four fields in the llm-dialog builtin
(`packages/runner/src/builtins/llm-dialog.ts:3908`), the CLI test harness
(`packages/cli/lib/test-runner.ts:1369`), and the tests: seven files build a
stream cell with `setRaw({ $stream: true })`, and 41 more carry the literal in
fakes and stored-document fixtures, 48 test files in all.

### The load-bearing reader

`#resolveJavaScriptStreamLink` (`packages/runner/src/runner.ts:9394`) follows
the `$event` input through write redirects and reads the terminal value.
Anything but the sentinel becomes a "Handler used as lift" failure
(`runner.ts:10492`, `:10902`, `describeHandlerStreamFailure` at `:11806`). That
failure class is the trigger for the cold-start repairs, whose causes are
structural (a setup marker naming another version, a manifest missing an
internal cell) and which therefore outlive the sentinel; only the keying goes:

- `isMissingStreamMarkerFailure` (`runner.ts:11862`) and the cold-start
  nested-piece setup repair keyed on it (`runner.ts:4942`).
- The hot-swap pre-setup pass, whose comment cites the same failure
  (`runner.ts:4470`), and the wave-withdrawal note that names it as the
  failure class a withdrawn setup produces (`runner.ts:4558`).
- The pieces-controller cold-start repair comments
  (`packages/piece/src/ops/pieces-controller.ts:2168`, `:2402`).

### Secondary readers

- `Cell.isStream` (`packages/runner/src/cell.ts:1320`): kind first, then the
  resolved link's schema, then the stored value. The schema branch compares the
  first `asCell` entry with the string `"stream"` (`:1339`), so an object entry
  `{ kind: "stream" }` is not recognized; `runner-utils.ts:164` does this
  correctly through `getAsCellKind`.
- The schema-less query-result proxy returns a stream-kind cell when the value
  is the sentinel (`packages/runner/src/query-result-proxy.ts:349`). Added for
  the case where an unspecified Output type lost stream-ness from the result
  schema.
- `processDefaultValue` mints an in-memory immutable cell holding the sentinel
  for an `asCell: ["stream"]` default (`packages/runner/src/schema.ts:574`).
- The default-seeding guard skips a default that is the sentinel
  (`packages/runner/src/data-updating.ts:1193`).
- Two build-time checks read `value.$stream` from the in-memory export
  (`packages/runner/src/builder/pattern.ts:390`, `:1053`).
- Out of runtime: `packages/fuse/callables.ts:50`,
  `packages/fuse/tree-builder.ts:166` and `:554`, the shuttle listing's `kindOf`
  (`packages/cli/lib/shuttle/listing.ts:434`),
  `packages/state-inspector/model.ts:216` and `decode.ts:122`,
  `packages/ui/src/v2/components/cf-piece-menu/cf-piece-menu.ts:155`. The CLI
  read guard (`packages/cli/lib/piece.ts:4707`) refuses on two signals, as its
  comment says: the link-derived schema, and the stored value, which
  `detectCallableKind` reads through `getRaw()`
  (`packages/cli/lib/callable.ts:1226`) and hands to `classifyCallableEntry`
  (`packages/fuse/callables.ts:98`); `piece.test.ts:2617` pins the value-only
  case.

### What already knows stream-ness without the value

- The cell kind at construction.
- `asCell: ["stream"]` in a schema. The schema generator emits it from the
  `Stream<T>` brand, and the schema read path mints a stream-kind cell from it
  without reading the value (`packages/runner/src/schema.ts:1622`).
- `wrapper: "handler"` on the module. `handler()` stamps it
  (`builder/module.ts:230`), the serializer keeps it
  (`builder/to-encodable-form.ts:277` spreads every non-function member), the
  runtime already trusts the stored flag at invocation time to split the
  argument into event and context (`runner.ts:10967`), and the builder uses it
  for writer classification (`builder/pattern.ts:840`, `:980`).
- `$kind: "stream"` in anonymous partial causes (`builder/pattern.ts:379`).
- The `result` back-link meta that setup writes onto every derived document
  regardless of value (`packages/runner/src/result-utils.ts:31`, called from
  `runner.ts:2986`). Event auto-start finds the owning piece through it with
  no value read (`packages/runner/src/ensure-piece-running.ts:173`).

## Three design decisions

### 1. Stream-ness rides in the link schema, not the descriptor kind

The descriptor's `kind` field is minted into the entity URI scheme
(`packages/runner/src/link-utils.ts:845`) and compared during manifest matching
(`runner.ts:2971`); changing it re-materializes the cell under a new id.
`EntityKind` is only `"computed"` today. So the stamp goes into the schema,
which is not part of the id: derived-cell ids hash the cause, so existing
spaces keep their identities and need no migration. The follow-up at the end
of this plan takes that migration on for streams; this plan does not.

Two schemas need the stamp, not one. When a partial-cause alias is bound to a
link, `scopedLinkForPath` prefers the alias's own schema over the descriptor's
(`packages/runner/src/pattern-binding.ts:179`, `:295`), and result-field aliases
are emitted with the cell's sanitized schema (`builder/pattern.ts:509`). So the
builder must stamp `asCell: ["stream"]` on both the descriptor schema and the
alias schema it emits for a stream-kind cell.

Once stamped, every path that reaches the stream through a link the builder or
setup emits sees it: the `$event` sigil in stored node inputs and the
result-field redirect both carry the descriptor/alias schema (manifest links are
emitted with `includeSchema: true` at `runner.ts:2979`), and link resolution
copies a stored redirect's schema onto the resolved link
(`packages/runner/src/link-resolution.ts:722`). `Cell.isStream` already resolves
a content-addressed schema reference before looking for the stamp, so a stamp
that rides as a reference is read the same way.

A builtin that re-serializes a branch at run time is a separate writer.
`getAsLink({ base })` carries a schema only when asked
(`packages/runner/src/link-utils.ts:391`), so `ifElse`, `when` and `unless`
(`builtins/if-else.ts:77`, `when.ts:48`, `unless.ts:48`) must each ask for it
when the selected branch declares a stream, or the link they store names the
stream's document with nothing on it that says so.

This bends one convention slightly: `asCell` normally describes the position
that holds a handle, and the handle's own schema is the stripped one. Putting
the stamp on the derived cell's own schema means a schema-carrying `get()` on
that cell returns a handle rather than a value. For a stream, which has no
value, that is the right answer; `Cell.isStream` already honors the stamp on a
resolved link.

### 2. Handler dispatch keys on the module wrapper, not the `$event` key

Keying on `$event` alone is unsafe: the lunch-poll pattern documents a real trap
where an onClick inside a computed-returned VNode mis-lowers so a lift node ends
up with `$event` in its inputs (`packages/patterns/lunch-poll/main.tsx:1423`).
Today only the sentinel read catches that. Under a `$event`-keyed rule the node
would be silently instantiated as a handler that never fires.

The dispatch rule:

1. `module.wrapper === "handler"` and `$event` present: parse the `$event`
   link and register on it. No value read. Stage 3 adds the assertion that
   the parsed link's schema declares a stream; that still reads nothing.
2. Wrapper is `"handler"` and `$event` absent: throw, the node is malformed.
3. No wrapper and `$event` present: refuse the node by name, with a message
   naming the lift-with-event-input mistake. This replaces every "Handler
   used as lift" variant, including the guard at `runner.ts:10492`, which is
   unreachable today (the resolver always claims a node with `$event`) and
   goes with the value read rather than becoming the live check.
4. Neither: ordinary action node.

Hand-built handler nodes already carry the wrapper
(`packages/runner/test/ensure-piece-running.test.ts:694`,
`packages/cli/test/piece-verbs.test.ts:103`). Of the seven tests at
`packages/runner/test/runner.test.ts:1528` through `:1738` that omit it, four
exist to read a value at `$event` (a missing marker, an overwritten marker, the
pre-manifest hint, the truncated diagnostic) and go with the value read; the
three that bind `$event` to a literal stay and fail on the structural check, and
a positive test beside them registers a handler on a stream whose document holds
no value.

A user-authored lift that legitimately wants an input named `$event` stays
rejected, exactly as today. Rule 3 keeps that restriction on purpose.

### 3. The stream's document carries only the back-link

Without the sentinel the derived document holds the `result` back-link meta and
nothing else. It is still listed (the memory server's entity page selects
current ids with no value condition, `packages/memory/v2/engine.ts:2188`), still
the id a served event's sidecar entry names (`of:stream-events:` docs,
`packages/memory/v2/engine.ts:2577`), and still found by event auto-start. What
it no longer does is describe itself: a reader that has only the document cannot
tell it is a stream.

- The state inspector would classify it as `owned-cell` labeled "(lineage)"
  (`packages/state-inspector/model.ts:383`) and the `stream` entity kind would
  stop firing.
- The shuttle listing classifies a position from its materialized value alone
  (`packages/cli/lib/shuttle/listing.ts:434`) and would label every stream a
  plain value. Its own comment says the listing and the CLI read guard must
  agree about which positions are callables; today they agree through the
  sentinel.
- The FUSE entities view projects an empty owned document, and keeps doing so:
  the owner walk is not added there (stage 2's FUSE item), and the follow-up
  lets it classify from the id.
- The FUSE piece view is mostly fine, because the bridge reads results through
  the pattern's result schema
  (`packages/piece/src/ops/piece-controller.ts:4990`) and its classifier falls
  back to the child handle when the value says nothing
  (`packages/fuse/cell-bridge.ts:4782`, keeping the entry at `:4787` even when
  the value is undefined; the schema argument only detects tools until stage 2).
  The gap is nested objects: the tree builder's JSON sibling is built from
  values (`packages/fuse/tree-builder.ts:544`), so an undefined value drops the
  key.

The plan does not put a declaration back onto the document. A `schema` meta
beside the back-link would be the sentinel moved from value to meta: safer
there, since `get()` never returns it and a stray write cannot clobber it, but
still a per-document copy of what the owner's manifest link already says, and
one more thing that has to agree with it. Instead, a reader that has only the
document resolves it through the owner: follow the `result` back-link to the
owner's result document, read its `internal` manifest, and take the schema of
the entry whose link names the document. That is the stamped link decision 1
emits (`includeSchema: true` at `runner.ts:2979`), so there is one source of
truth. `followResultCellChain`
(`packages/runner/src/ensure-piece-running.ts:45`) is the first half of that
walk already; the manifest lookup is the second. Cost: one extra document per
classification for a reader that starts from a bare document. The inspector
holds the whole space and pays it from memory; the shuttle listing and the CLI
read guard start from a parent cell and its link and never pay it. The walk is
interim: the follow-up puts the owner into the stream's address and deletes it,
so stage 3 keeps it to one function that the inspector and the runtime share.

The runtime pays it in one place. `Cell.isStream` and the proxy decide from
the handle's kind and the resolved link's schema, and a bare address to the
stream document, with no stored link hop to carry a stamp, has neither. The
llm-dialog read and invoke tools dispatch on such an address
(`packages/runner/src/builtins/llm-dialog.ts:2067`, `:2078`), built from an
LLM-supplied path with no schema (`:2050`). Stage 3 resolves a bare address
through the owner before the stream decision, with the same walk; that is what
replaces the value read there.

## Stages

Three PRs. The first keeps the value fallback so nothing that still holds a
sentinel breaks; the last removes it. Stage 1 landed as #7583, and stage 2 is
open as #7589. A checked item is done in that PR; an unchecked item under
stage 2 is still owed there. Where a stage does something other
than what the list first said, the item says what it does now and why.

### Stage 1 — Runner: stop writing, stop needing (#7583)

- [x] `Cell.export()` reports `kind` and stops reporting a value for streams.
      The two build-time checks at `builder/pattern.ts:390` and `:1053` switch
      to the exported kind.
- [x] Builder stamps `asCell: ["stream"]` on the descriptor schema and on the
      alias schema for stream-kind cells, with no `default`. The stamp goes in
      front of an `asCell` the schema already carries (`["opaque"]` on a
      stream's own schema) rather than replacing it.
- [x] Setup writes nothing onto a stream's derived document but the `result`
      back-link (`runner.ts:2986`), per decision 3.
- [x] Handler dispatch follows decision 2, without rule 1's schema assertion,
      which stage 3 adds. `describeHandlerStreamFailure`,
      `isMissingStreamMarkerFailure` and the `runner.ts:10492` throw are gone,
      and a lift binding `$event` is refused by name. The cold-start repairs
      stay, on structural triggers rather than the marker: a nested piece
      repairs when its setup marker names another version and its manifest
      lacks one of the pattern's internal cells, and the controller refuses a
      stopped root whose marker names another version and hands it to the
      existing repair (`Runner.isRunning()` keeps a running root out of it).
      Without the repair a nested piece comes up with no result aliases, so
      `nested-piece-setup-repair.test.ts` stays, rewritten for the structural
      trigger.
- [x] Remove the four hand-written sentinels in llm-dialog and confirm its
      result schema marks those fields as streams.
- [x] `processDefaultValue` mints a stream-kind cell instead of a sentinel
      cell (`schema.ts:574`). The guard at `data-updating.ts:1193` becomes
      dead; remove it.
- [x] `Cell.isStream` goes through `getAsCellKind` so object `asCell` entries
      are recognized. Keep its value fallback for now.
- [x] The query-result proxy tests the resolved link's schema before the value
      (`query-result-proxy.ts:349`). Keep its value fallback for now.
- [x] Regression test: forward a stream into a sub-pattern through `.map`, the
      case that added the proxy fallback and that `sidebar.tsx:84` still works
      around. Under this design it works only because the stored alias link
      carries the stamp.
- [x] `when` and `unless` carry the stamp on the link they write when the
      selected branch declares a stream, as `ifElse` does (each asks for
      `includeSchema` off `declaresStream(resolvedRef.schema)`). One test per
      builtin, over a sub-pattern's stream and the pattern's own
      (`stream-declaration.test.ts`), pins it by what the stamp is for: with
      nothing stored at the position, the selected field reads as a stream
      and a `send()` through it dispatches, which holds only if the link
      carries the declaration.
- [x] Not foreseen: every read path treats a declared stream position as a
      handle whether or not the data names it — the eager traversal, the
      schema view, the defaults path — with `required` checks exempting such
      positions, since a required stream field with nothing stored otherwise
      collapsed the read. A stream handle written into data carries the
      declaration on its link, decided by the handle's kind with nothing read
      (a value read there taints the write, which the CFC tests caught). Link
      resolution keeps a stored schema that is only an `asCell` stamp instead
      of discarding it as unconstraining, and the family-presence probes read
      the document record rather than its value.

### Stage 2 — Consumers, tests, docs (#7589)

- [x] State inspector: a document classifies as `stream` by following its
      `result` back-link to the owner's `internal` manifest and reading the
      stamped link there, through the reading the runtime applies. That
      reading is `@commonfabric/runner/stream-declaration`, a module carrying
      none of the runtime, which the runtime and the inspector both go
      through, each supplying how it resolves an external schema reference:
      the registry, or the space's documents. The value check stays until
      stage 3.
      `classifyDocument` takes
      the document's id, which the manifest entry is matched by, and a
      document reader, which the walk reads the owner and a manifest link's
      `cid:` reference through. The detail view names the manifest it read.
- [x] Shuttle listing: a key is a `callable` off the child's link-derived
      schema, the same signal the CLI read guard refuses on, through a new
      `listCallableKeys` read (`packages/cli/lib/piece.ts`) that runs beside the
      value read and fails open the way the guard does. The listing skips it for
      a keyless cell. A position still reading as the sentinel counts as a
      callable until stage 3.
- [x] FUSE, in part. `classifyCallableEntry` takes a schema that declares a
      stream as a handler whatever stands at the position; the bridge's
      callable discovery asks the child cell itself as a last resort, the way
      the CLI's `detectCallableKind` already did; and a nested `.json` sibling
      shows a stream handle as `{ "/handler": key }` instead of the handle's
      own JSON, at every depth. Not done, and not blocking stage 3: nested
      `.handler` scripts (the bridge's callable discovery is root-only, and a
      nested script needs a path-addressed `cf exec`), and the `entities/`
      projection of a bare stream document, which `#materializeTreeValue`
      already leaves empty rather than failing. Both are follow-ups if anyone
      wants them.
- [x] CLI read guard: the comment at `packages/cli/lib/piece.ts:4694` names
      both of its signals, the link-derived schema and the stored value,
      because `detectCallableKind` reads the value through `getRaw()`
      (`packages/cli/lib/callable.ts:1226`) until stage 3 removes that read.
- [x] Piece menu: already schema-first with a parent-schema fallback
      (`cf-piece-menu.ts:1851`); remove `isRawStreamMarker`.
- [x] Test fixtures, in part. Every fixture that built a stream through a real
      runtime now declares it — `runtime.getCell(space, cause, { asCell:
      ["stream"] })` for a handle, `schema: { asCell: ["stream"] }` on a
      hand-built descriptor or alias — and stores nothing; a declared stream
      argument is passed as `{}`. The served-execution fixtures'
      (`executor-events-down`, `executor-space-server`) serving-side handles
      declare the stream, since a send decides stream-or-write off the handle.
      The CLI test harness (`test-runner.ts`) likewise. Pure fakes whose
      `getRaw` returns the sentinel are deferred to stage 3 (see there): they
      exercise the value fallback that stage removes, and would be rewritten
      twice otherwise.
- [ ] The served-execution fixtures write only the `result` back-link onto the
      stream's document, the way setup does. #7589 has them write a `schema`
      meta beside it; that goes with the setup write it mirrored.
- [x] Docs. The six live documents and the formal spec's encoding table now
      describe the declaration, and the formal spec says the marker is retired
      rather than renamed to `/Stream@1`. The builder README and the lunch-poll
      deploy guide follow. Two pattern comments still mention the marker,
      `packages/patterns/catalog/ui/sidebar/sidebar.tsx:84` and line 1136 of
      `packages/patterns/google/core/experimental/gmail-agentic-search.tsx`:
      editing a pattern's source changes its identity,
      so each waits for the next edit its pattern gets for a reason of its own,
      and stage 3's sweep names both as the allowed residue.
      `packages/patterns/gideon-tests/test-cross-piece-client.tsx:71` is not a
      comment: its handler branches on `innerValue.$stream` and reports "Stream
      not found" for a stream set up under stage 1. It is a manual fixture that
      no CI job dispatches; stage 3 rewrites it (see there).
- [x] Not foreseen, and landed with stage 1: a stream declared through a
      `$ref` into the schema's own `$defs`, or through a composition whose
      branches agree (`allOf` with
      plain constraints beside it, a uniform `anyOf`/`oneOf`), was not a
      declared stream to `Cell.isStream`, which read only a root `asCell`; the
      stored sentinel had been carrying those sends. The piece controller
      already localized such declarations for validation.
      `ContextualFlowControl.declaredHandleKind` reads the kind through a
      local `$ref` and through agreeing branches — `allOf` declares what any
      branch declares, `anyOf`/`oneOf` what every branch declares — and
      `declaresStream`, `Cell.isStream` and the proxy decide from it. The
      local lookup is quiet on a miss, because the CLI test harness counts a
      logged warning as a failure. `Cell.key()` still derives a handle's kind
      from the root `asCell` alone.
- [x] Not foreseen: stage 1 had changed what a verb's link-derived schema
      reads as — `asCell: ["stream"]` in front of the event schema, and
      `{ asCell: ["stream"] }` rather than nothing for a verb declaring no
      event type — and two CLI tests pinning the old shape
      (`verb-undeclared-field.test.ts`) had not been run. Their expectations
      are updated in stage 2.

### Stage 3 — Remove the fallback

- [ ] Delete the value branch in `Cell.isStream`, the proxy's value check
      (and the `$stream` read it registers, which
      `query-result-proxy-shape-reactivity.test.ts` pins), the inspector's
      value check (`model.ts` and `decode.ts`), the shuttle listing's
      (`kindOf`), FUSE's `isStreamValue` in `callables.ts`, and `isStreamValue`
      in `packages/runner/src/builder/types.ts` (and its re-export).
- [ ] A bare address to a stream document resolves through the owner before
      any stream decision: follow the `result` back-link, read the owner's
      `internal` manifest, and take the stamped link's schema (decision 3).
      This is the last resort in `Cell.isStream` and the proxy in place of the
      value read. It covers links a handler or lift wrote into data before
      stage 1, which no setup pass rewrites (`data-updating.ts:1283` stamps
      only a new write), and the llm-dialog dispatch at
      `builtins/llm-dialog.ts:2067`. The walk is a few lines over each
      reader's own substrate — `ownerStreamSchema` (`link-utils.ts`) over
      cells, the inspector's `streamDeclarationOf`
      (`state-inspector/model.ts`) over stored documents — and what they
      share is the reading of the manifest link they find,
      `runner/src/stream-declaration.ts`; the follow-up deletes both walks.
- [ ] Decide compatibility for pieces last set up before stage 1, before the
      value branch goes. Owner resolution covers a bare address whose owner
      manifest is stamped; a piece set up before stage 1 has an unstamped
      stored link and an unstamped owner manifest, so nothing declares its
      streams once the value is not read. The choice is to migrate, a setup
      pass over such pieces that re-emits stamped manifest links, or to
      accept the break: sends through those links become value writes rather
      than events. The follow-up below re-materializes every stream under a
      new id in any case, so the question is whether old pieces break once or
      twice. Record the choice here. The choice rests on live data rather than
      on fixtures, since a fixture today's setup produces is already stamped:
      sample pieces set up before stage 1 on a deployed space and count how
      many have stamped owner manifests; measure whether the cold-start repair
      re-stamps them in practice on a routine pattern update; pin a test over
      hand-written pre-stage-1 stored state — unstamped manifest, unstamped
      stored link, sentinel present — that sends still dispatch as events;
      and land the dispatch assertion of decision 2, rule 1, before the value
      branch goes, so that a link nothing declares refuses loudly rather than
      writing a value. Where the follow-up is coming anyway, migrating once
      there may cost less than breaking twice.
- [ ] Handler dispatch asserts that the parsed `$event` link's schema declares
      a stream (decision 2, rule 1).
- [ ] `detectCallableKind` stops reading the value
      (`packages/cli/lib/callable.ts:1226`), and the read-guard comment at
      `packages/cli/lib/piece.ts:4694` then names one signal.
- [ ] Rewrite the pure fakes deferred from stage 2, whose `getRaw` returns the
      sentinel: the CLI's `piece-call`, `piece-connection`, `exec`,
      `exec-read-options`, `read-options-four-ways` and
      `verb-undeclared-field` doubles, and the inline-verb case in
      `piece.test.ts` that exists to pin the sentinel path. Each should carry
      `schema: { asCell: ["stream"] }` or `isStream: () => true` and return
      `undefined` from `getRaw`.
- [ ] `packages/patterns/gideon-tests/test-cross-piece-client.tsx` sends without
      inspecting the stream's value, and its baseline is refreshed with
      `deno task pattern-compat --update`, the documented remedy for the
      identity change.
- [ ] The raw-document fixtures that model older data switch off the
      sentinel: `scripts/topics-export.test.ts` and
      `packages/runner/test/storage-subscription-filter.bench.ts` seed a
      stamped link where they seed `{ $stream: true }` today (nothing reads
      the value in either), and the codec round-trip case in
      `packages/data-model/test/codecs.test.ts`, which is about `$`-keyed
      records in general, keeps its record under another key.
- [ ] Confirm no `$stream` remains outside `docs/history/`, the plan docs, and
      exactly two pattern comments,
      `packages/patterns/catalog/ui/sidebar/sidebar.tsx:84` and line 1136 of
      `packages/patterns/google/core/experimental/gmail-agentic-search.tsx`.
      Each is rewritten the next time its pattern changes for a reason of its
      own; an edit changes the pattern's identity, and a comment does not earn
      one.

Stage 3 is gated on the compatibility decision above, not on anything the data
can show, because nothing in the data marks a piece as ready. Setup re-emits
only manifest links; a running piece reuses its setup without re-emitting them
(`runner.ts:2840`); the setup marker records pattern identity, not a format
(written at `runner.ts:3257`, reduced to matches, other or absent by
`storedSetupMarker` at `:1731`); and links written into data before stage 1
are never rewritten. So what lets the value read go is the owner resolution
above for pieces whose manifests are stamped and the compatibility decision
above for pieces whose manifests are not; a waiting period settles neither.
Documents that still hold a sentinel are harmless after stage 3: the value is
ignored, and nothing reads it.

## Testing

- Every handler node in `packages/runner/test` instantiates with no value at its
  `$event` target. Assert the derived document holds no value after setup.
- The three `refuses ...` tests at `runner.test.ts:1528` onward fail on the
  structural check, with its message, and the positive test beside them
  registers a handler on a stream whose document holds no value.
- `when` and `unless` over a stream emit a link whose schema declares it, as
  `ifElse` does.
- A bare address to a back-link-only stream document is a stream to
  `Cell.isStream` and to the proxy, resolved through the owner's manifest with
  nothing stored.
- A lift whose inputs carry `$event` fails at instantiation with the
  lift-with-event-input message (the lunch-poll trap, pinned as a unit test).
- `ensurePieceRunning` still auto-starts a piece from an event sent to a
  stream document that has only the back-link.
- The `.map`-into-sub-pattern regression test above.
- State inspector fixtures: a back-link-only stream document classifies as
  `stream` through its owner's manifest, and one whose owner is absent
  classifies as `owned-cell`.
- Shuttle listing: a stream position lists as `callable` with no sentinel
  stored.
- FUSE: a nested stream two levels down a result appears as
  `{"/handler": key}` in its parent's `.json` sibling. It gets no `.handler`
  script of its own; see the stage 2 FUSE item.
- Inspector: a stream whose manifest link schema is a `cid:` reference
  classifies as `stream` and shows the referenced schema.
- A stream declared through `$ref` and `allOf`/`anyOf` sends with nothing
  stored (`stream-declaration.test.ts`).

## Risks

- **Alias schema override.** If only the descriptor schema is stamped,
  everything still works for handler dispatch (decision 2 does not need the
  schema) but `send()` through a schema-less result read regresses to a value
  write. The regression test in stage 1 exists for this.
- **Root-level `asCell` on the derived cell's own schema.** Any code that calls
  `get()` on a derived stream cell with its own schema now gets a handle back.
  Audit `getDerivedInternalCell` callers; today none read a stream's value.
- **Unstamped stored links.** Pieces whose last setup ran before stage 1 carry
  unstamped manifest links until their next setup pass, and links a handler or
  lift wrote into data before stage 1 are never rewritten. The value fallback
  covers both until stage 3; after it, the owner resolution covers a link
  whose owner manifest is stamped and the stage 3 compatibility decision
  governs the rest. A `send()` through a link nothing covers becomes a value
  write with no error, which is the failure to watch for.
- **The `.map` sub-pattern case.** The proxy fallback was added for it, and the
  sidebar pattern still documents the failure. Do not remove the fallback
  before the regression test is green.
- **Setup withdrawal on the ON arm.** The hot-swap path notes that a v2 graph
  running against a withdrawn setup fails as "Handler used as lift"
  (`runner.ts:4558`). Under decision 2 that graph would instead register
  handlers on links whose documents were never materialized. Confirm the
  withdrawal path still keeps the old graph running, which is what makes the
  state coherent, rather than relying on the instantiation failure.

## Follow-up: the owner in the address

This plan leaves a stream's document in place as a back-link-only record
because a bare stream id says nothing about who owns it: the owner's result id
is hashed into the id (`createRef({}, { parent, type: "internal", cause })`
at `link-utils.ts:856`) but cannot be read back out. The follow-up makes the
owner recoverable from the address itself, so any party holding a stream's id
can name the owner's result document with no lookup and no record. It is the
next plan after this one, and this plan is written on the assumption that it
happens. What it changes:

- **Identity.** A stream's id carries its owner's result id and its cause in
  a form a reader can take apart, either as a stream entity kind minted into
  the URI scheme (`link-utils.ts:845`; `EntityKind` is only `"computed"`
  today) or as a structured id. It is minted from owner and cause, as derived
  ids are today, and never content-addressed: a `cid:` id is a function of
  the value, every stream's value is the same nothing, and what tells two
  streams apart is the owner and cause that live in meta. Every existing
  stream re-materializes under a new id. That is the migration decision 1
  declines here, and the follow-up's first section states it and the cutover
  for it.
- **Sidecars.** A stream's event sidecar hashes the stream link
  (`packages/memory/v2.ts:407`), so it moves with the id; entries in flight at
  the cutover drain first or are rewritten.
- **Readers.** The inspector, FUSE, the shuttle listing and the runtime's
  bare-address case classify a stream from its id alone. The owner walk stage
  3 adds is deleted; the link-schema stamp and the handle kind stay, since
  dispatch and `send()` decide from them and neither depends on the id.
- **Auto-start.** `ensurePieceRunning` reads a stream's owner from the address
  and skips the back-link chain for it.
- **The document.** Nothing writes to it and nothing reads it. Whether the
  record exists at all becomes the storage question the unification in
  `docs/specs/space-model/2-storage-format.md:95` answers, and can be settled
  there.

What this plan does in anticipation: stream-ness decisions key on the link
schema and the handle kind, both of which survive an id change; the owner
walk is one shared function, so the follow-up deletes one thing; and nothing
new is written onto the stream document that a migration would have to carry.

## Not in scope

- Unifying streams with value cells, which
  `docs/specs/space-model/2-storage-format.md:95` floats; the follow-up above is
  the step toward it this plan commits to.
- Changing derived-cell identity or the manifest format; the follow-up takes
  the identity change for streams.
- Allowing a lift to take an input named `$event`.
- The formal spec's wider encoding work; this plan only retires one row of its
  table.
