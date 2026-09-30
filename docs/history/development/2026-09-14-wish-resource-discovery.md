---
status: historical
created: 2026-09-14
archived: 2026-09-14
reason: "Source investigation of wish and Loom inbox startup dependencies for a proposed resource-discovery migration."
---

# Wish and Loom resource discovery: investigation

## Scope and evidence

Examined local Labs at `ed17ef324e04e0e04a95bdf5991849576929e51e` and local Loom
at `2c157a350c5988c9b380017ec5b0c6dc1d932461` in `/Users/berni/looms/primary`.
These are local source observations, not a verification of deployed code or
latest remote main. Loom's `vendor/labs` exists, but its revision was not
established by a Git submodule entry.

No production state was changed. No application/runtime implementation was
changed. The resulting
[proposal and implementation plan](../../plans/loom-resource-discovery.md)
requires a compiled wish-to-SQLite composition test before implementation.

## How wish works

- [`WishParams` and `WishState`](../../../packages/api/index.ts) expose query,
  path, schema, scope, headless, result, candidates, optional error, and UI. The
  result can be undefined; there is no separate pending field.
- [`wish.ts`](../../../packages/runner/src/builtins/wish.ts) `parseWishTarget`
  separates slash paths and hashtag paths. `resolveBase` tries space targets,
  home targets, then hashtag search. Free-form requests use the suggestion
  machinery rather than a deterministic resource query.
- `searchByHashtag` searches favorites by default. Explicit scopes select
  favorites (`~`), current-space mentionables (`.`), profile elements, and
  arbitrary DID-space mentionables. Its category order is fixed; it does not
  simply iterate the supplied scope array as a priority list.
- Favorites match `userTags` and normalized `tags`; profile elements match
  `userTags` and tags extracted from `tag`. Mentionables match exact lowercase
  `[NAME]` or hashtags extracted from the serialized linked schema.
- `searchMentionablesForHashtag` reads
  `space.defaultPattern.backlinksIndex.mentionable`. It does not enumerate
  memory entities, filesystem paths, or SQLite registrations. It reads each
  candidate and may resolve/stringify its schema. Requested schemas project
  results; they are not a structural-match predicate.
- Result paths are resolved before cell equality deduplication. Headless matches
  retain all candidates but put the first in `result`. They skip suggestion
  launch, but still project a UI or a cell link.
- `createSharedHashtagResolver` shares identical headless hashtag searches
  within a runtime, keyed by parent space, query/path, and scope. Per-caller
  result schemas are applied afterward. Different tags/paths do not share one
  scan. Resolver ownership is reference-counted and cancelled on release.
- `projectWishCellValue` and `wishStateSchemaForResult` transport projected
  links and definitions. Nested SQLite handle composition was not exercised by
  this investigation's test run.
- `wishOutputScope` uses explicit result-schema scope when supplied; otherwise
  home-dependent queries narrow to at least user scope. Current-space-only
  discovery avoids implicit home dependence; data permissions still apply.
- [`backlinks-index.tsx`](../../../packages/patterns/system/backlinks-index.tsx)
  derives mentionables from registered pieces, excluding `isMentionable: false`,
  and recursively includes exported mentionables to depth five. Ordinary
  registration is therefore a publication route for a provider.
- [`CLI wish`](../../../packages/cli/lib/wish.ts) uses the same builtin with
  `headless: true`, but `WishReadResult` returns the resolved value/error, not
  the complete candidates array. It is useful for inspection, but its current
  public result alone cannot establish uniqueness.

## Inbox and daemon dependencies

Loom `src/patterns/cf-person-inbox.tsx`, `InboxInput`, declares six optional
database roles: Signal, iMessage, WhatsApp, Telegram, personal Gmail, and work
Gmail. Each has freshness, panel, and CFC fields. It also takes `peopleIndex`,
`people`, `picked`, and session-scoped `view`.

The body consumes the six database/freshness pairs and the people index; panel
and CFC fields are declared but not destructured there. It constructs message,
probe, and recent-sender queries for each role, with session-scoped results. It
derives `reactOn` from `gen` and `epoch`, excluding the badge clock `tickAt`.
The people index uses keyed cell access. Those distinctions constrain what
should move to provider discovery and what should stay application input.

Loom `src/services/loom-daemon/sqlite-injection.ts`:

- `resolveInjections` starts from each piece's `sqlite_sources` and requires
  `local_piece_id`, so provisioning is currently consumer-dependent.
- `resolveOneInjection` validates source paths and table/row-label contracts.
- `reconcileOne` canonicalizes the file, derives the handle identity, seeds or
  merges the table contract, handles relink requests, derives CFC context,
  registers the file, and links handle/freshness/panel/people-index/context
  cells into the consumer's input fields.
- Handle identity reuses Labs' `deriveDiskHandleId`. Freshness and panel cells
  are keyed by connection; CFC context is tied to the actual handle.
- `linkedThisSession` limits repeated link writes in a process. A new consumer
  still requires its own link set. Per-source provisioning and per-consumer
  linking can be separated without redesigning the handle API.
- Registration is repeated to restore in-memory toolshed state. Reconciliation
  and freshness sidecar watching update companion cells. Health polling and a
  heal backstop cover resets not surfaced as explicit reconnect events.

Loom `src/services/local-loom-ui/pattern-host.js`, `writeConnectorPanelConfig`,
writes the existing panel-config cell. The daemon only links that cell. Moving
ownership to a provider writer would be a behavior change, not a necessary
consequence of discovery.

## SQLite boundary

[`sqlite-source.ts`](../../../packages/cli/lib/sqlite-source.ts) derives a
stable `(space, path)` handle identity and preserves existing handle contracts
on relinking.
[`DiskSourceRegistry`](../../../packages/memory/v2/sqlite/disk-source.ts) is an
in-memory map keyed by `(space, id)` on the memory server. Disk paths stay
server-side; an unregistered ID falls back to the cell-derived database path. A
discoverable handle therefore does not prove a disk source is live.

The [SQLite API](../../specs/sqlite-builtin/01-api.md) defines `SqliteDb` as a
branded cell with query/exec methods; its readable descriptor is not a
substitute for the reference. Injected disk sources remain read-only.
[`sqlite-builtins.ts`](../../../packages/runner/src/builtins/sqlite-builtins.ts)
guards absent database inputs, reports malformed handles as query errors, and
requires session result scope under a runtime read ceiling. Discovery must
preserve those properties and external-write invalidation.

## Verification performed

Ran from `packages/runner`, using its test task's environment and preload:

```bash
ENV=test deno test --no-check --preload=test/clock-preload.ts \
  --allow-ffi --allow-env --allow-read --allow-write=/tmp,/var/folders \
  --allow-run=git,deno \
  test/wish.test.ts test/wish-scope.test.ts test/wish-shared-hashtag.test.ts
```

Result: **10 passed, 135 steps, zero failed**, exit status 0, approximately 11
seconds. Output included memory-client/replica-closed teardown diagnostics and
deliberate failed-sidecar diagnostics. These passes cover existing wish
behavior, not a warning-free lifecycle or the proposed inbox conversion.

The shared-hashtag tests verify one mentionable scan across repeated identical
wishes and across different requested schemas. Tag tests explicitly cover the
hyphen boundary and underscore support. No new performance measurement, live SQL
query, full package run, or end-to-end provider prototype was performed.

## Conclusion

The existing platform supports a promising composition: publish resource
references once, discover them reactively, and reuse the existing query graph.
The major removable work is per-consumer linking and field-name configuration.
Disk registration, freshness, authority, role assignment, and reconnection
remain real obligations. The implementation plan makes reference preservation,
late discovery, ambiguity handling, and CFC parity explicit acceptance gates.
