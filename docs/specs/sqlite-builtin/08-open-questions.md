# 08 — Open questions

Unresolved items for framework-author review, grouped by area. Items resolved
during design are marked **[resolved]** with the decision.

## API surface

1. **[resolved — handle methods]** The original draft chose free built-ins
   (`sqliteQuery`/`sqliteExecute`) over methods on the handle. **As built**, the
   handle is a `SqliteDb` cell variant exposing `db.query` (reactive read) and
   `db.exec` (imperative write) directly (Section [01](./01-api.md)). The
   read/write capability split is preserved at the type level — `.query` and
   `.exec` are distinct methods CFC can gate separately — and the reactive
   `sqliteExecute` built-in was removed (`db.exec` folds the write into the
   caller's commit instead). A free `sqliteQuery<Row>(...)` function remains as an
   equivalent alias for `db.query<Row>(...)`.
2. **Multi-statement writes.** Should `db.exec` accept multiple statements in one
   `sql`, or one statement per call (clearer atomicity story, easier `_cf_link`
   param mapping)? Still open.
3. **[resolved] Transformer support for `sqliteQuery<Row>`.** Routine: the
   transformer already lowers type arguments to schemas for `toSchema<T>`,
   `generateObject`, and `lift`. Add a registry entry + a schema-injection rule —
   see [`base/ts-transformers/docs/adding-type-arg-schema-lowering.md`](../../../base/ts-transformers/docs/adding-type-arg-schema-lowering.md)
   and Phase 5 of the
   [implementation plan](../../history/specs/sqlite-builtin/implementation-plan.md).
   Not a gating risk.

## `_cf_link`

4. **[resolved] Suffix vs. schema — as built.** The `*_cf_link` suffix drives the
   **write** path (which params encode as links) and the storage type (`TEXT`),
   and is self-documenting in raw SQL. **Decode-to-`Cell` on read is driven by the
   typed `db.query<Row>` schema** (a `Cell<T>` field → `asCell`), *not* by the
   suffix alone: an **untyped** query returns the raw sigil-link string regardless
   of the column name (Section [02](./02-cf-link-encoding.md)). So the suffix is
   the storage/write marker and `<Row>` is the read-decode driver — they are
   complementary, not a fallback chain.
5. **Schema in stored links.** We strip `schema`/`asCell` from the stored sigil
   (Section [02](./02-cf-link-encoding.md)) and re-attach the element schema from
   the `Row` on read. If `Row` does not cover a column (untyped query), the decoded
   cell has no schema — acceptable, or should we store a minimal schema
   reference?

## Transactions & storage

6. **[resolved] ATTACH model → one sibling `.sqlite` file per cell-derived db**
   (Option A), ATTACHed on demand. Considered: tables inside the space's own db
   (rejected — co-mingles untrusted pattern schema with the authoritative store),
   and one shared per-space "patterns" db (viable, but forces full SQL
   parse-and-rewrite for table-name namespacing). A wins because:
   - SQLite's only namespace primitive is the attached-db alias, so the file
     boundary gives per-pattern namespacing **for free** — unqualified names
     resolve to the (solely) attached pattern db, **no identifier rewriting**.
   - `@db/sqlite` exposes **no authorizer** (confirmed — see Section
     [04](./04-server-execution-and-transactions.md)), so a shared db would need
     a full parser anyway; A needs only a tokenizer-level guard.
   - Best isolation, file-delete/`backup()` GC and export.
   **Depends on** the core-table-rename flag (below) to remove `main` shadowing,
   and an attach/detach LRU cache for the attach limit. Trade-off accepted:
   per-file WAL reconciliation (Q7) is per-written-db rather than a single pair.
7. **[resolved — V1 cut] WAL crash reconciliation → detect + quarantine.** Normal
   operation is atomic; only a crash *during* a multi-file COMMIT can leave
   `main` and a pattern db disagreeing for one `seq`. V1: write a
   `_cf_commit_watermark(seq)` inside the same txn (no hot-path cost) and
   **persist each commit's `sqlite` ops in the commit record** (small, avoids a
   later migration). On open, compare the watermark to the space's committed
   `seq`; on mismatch, **quarantine that pattern db** (fail its queries with a
   clear error + loud log) rather than serve divergent data.
   *Deferred (fast-follow):* auto-repair — replay missing seqs' persisted ops for
   a behind db, truncate orphaned in-doubt writes for an ahead one. Rejected:
   per-commit checkpoint+fsync of both files (doesn't actually close the crash
   window and kills WAL throughput).
8. **[resolved — read pool]** Connection contention. `@db/sqlite` is a single
   synchronous connection per `Database`, so a long read on the engine
   connection blocked the space. **Resolved** by routing **all reads** —
   cell-derived and injected on-disk — onto a separate path-keyed **read-only
   connection pool** (`ReadConnectionPool`), unattached from the engine; only
   writes use the engine connection (Section
   [04](./04-server-execution-and-transactions.md#read-path-a-pooled-read-only-connection)).
   A statement timeout against a single runaway read remains a worthwhile guard.
8a. **[resolved — V1 cut] Attach limit & core-table shadowing (Option A).**
   - **Attach limit:** `@db/sqlite` exposes no `sqlite3_limit` binding, so
     `SQLITE_LIMIT_ATTACHED` is fixed at the compiled default (assume 10).
     **Update (read pool):** reads no longer attach at all — they run on the
     read-only connection pool (Q8 above), so the attach limit is now a
     *write-only* concern, and a commit touches **at most one** cell-db (the one
     being written), attached before `BEGIN` and detached before the post-commit
     await. The old LRU attach/detach *read* cache is removed; the limit is
     effectively never approached. A one-time startup **probe only logs** the
     real limit (no dependency on headroom).
   - **Core-table shadowing:** V1 ships **without** the core-table rename. Cheap
     mitigations now: the statement guard rejects schema-qualified references,
     `ATTACH`/`DETACH`/`PRAGMA`, and multiple statements; patterns may **not
     declare** a table whose name collides with the core set, and the guard
     **rejects statements that reference a core-table identifier**. Residual,
     documented pre-production gap: tokenizer-level reference checking has minor
     false positives/negatives (e.g. a column literally named `commit`).
     *Deferred (production hardening, behind a flag):* rename the engine's core
     tables to include the space DID (e.g. `commit__<did>`), which removes
     shadowing structurally and drops the name-based guarding. Kept out of the
     feature's critical path because it's an invasive core-store migration.
9. **[resolved — V1 cut] DDL ownership + migration scope → additive-only.** The
   database owns DDL via `sqliteDatabase({ tables })` (Section
   [01](./01-api.md#schema-ownership--the-database-owns-its-tables)); patterns do
   not run `CREATE TABLE`. On open, the runtime diffs declared `tables` against
   `PRAGMA table_info`: **create missing tables**, **`ADD COLUMN`** for new
   nullable/defaulted columns, and validate `_cf_link` columns are `TEXT`. Any
   **destructive or ambiguous** change (drop/rename/retype, constraint/PK change)
   → **refuse to open the db with an explicit "unsupported migration" error**.
   Rationale: a *declarative* diff can't distinguish a rename from a drop+add, so
   auto-applying destructive ops is unsafe; `ADD COLUMN` also can't add `NOT
   NULL` without a default (documented).
   *Deferred (post-V1):* keep erroring by default, but let a database opt in to a
   **migration callback** — author-supplied logic invoked when the on-disk schema
   version is older than the declared one, to perform the reshape (table-rebuild,
   data copy) explicitly. This preserves "no silent destructive migration" while
   giving an escape hatch for evolving older databases.

## Reactivity

10. **[resolved — commit-fold rev bump]** Earlier designs emulated "re-run only
    on committed inputs" with a *separate* post-commit handle-cell dirtying (and
    contemplated a first-class `committedReads` scheduler annotation). **As
    built**, `db.exec` bumps the handle cell's `rev` **inside its own write
    commit** (Section [05](./05-reactivity.md)). The scheduler's existing
    own-commit propagation then notifies `reactOn: db` queries exactly when the
    write commits durably — no separate post-commit signal, and no new scheduler
    primitive needed for the cell-derived case. (A `committedReads` annotation may
    still be worth it as a general feature, but `sqliteQuery` does not need it.)
    This same read-modify-write also resolves the **multi-tab write mutex**: two
    concurrent `db.exec` commits conflict on the handle cell's revision and
    serialize (one retries) — for free, with no separate mutex primitive.
    *Future hardening (not needed for the cell-derived case):* a server-driven
    `markSpaceDirty(handle-id)` emitted when a folded `sqlite` op commits would be
    a more robust signal than the value-`rev` bump, and is the natural mechanism
    for the cross-space injected-handle case (Q12).
11. **Finer invalidation.** Is coarse `reactOn: db` (whole-database) invalidation
    good enough for v1, or do we want table-level handle cells (dirtied per
    touched table) out of the box, parsed from the write SQL? Still open;
    `reactOn` already accepts a narrower cell the author bumps manually.
12. **Cross-space dirty signal for injected handles.** A `cf`-injected on-disk
    handle cell lives in a service space while its writes ride the pattern's
    space commit (Section [05](./05-reactivity.md)). The post-commit dirty signal
    must cross spaces — define that mechanism, or restrict injected sources to
    read-only (no `reactOn`).

## Sources

13. **VM-file API.** What is the improved VM file interface, and can a VM file
    ever be ATTACHed to the space connection for atomicity, or is it always a
    non-atomic post-commit effect (Section [03](./03-database-sources.md))?
14. **On-disk co-location.** Should `cf`-linked on-disk databases be required to
    live where toolshed can ATTACH them (enabling atomicity), or are they always
    read-mostly external datasets? (Partly informed by the `sqlite:` injection
    model in Section [03.3](./03-database-sources.md), which fixes *addressing*
    but not co-location.)
15. **GC of cell-derived dbs.** When the owning cell is collected, who deletes
    the sibling `.sqlite` file, and when?

## CFC (future)

16. **Row-label projection language.** Section [06](./06-cfc.md) ships a pure
    declarative projection (`match(f.col, /re/)` / `principal(protocol, …)` /
    `whenMatches(…)` with explicit `any`/`all` clause combinators —
    implemented as Phase 3.a) so the server can evaluate row labels at commit.
    Still open: is that expressive enough for real policies (e.g. recipients
    stored as a join table rather than a JSON column)?
17. **Read-time filtering vs. fail-closed.** *(Adjudicated at the CFC spec
    level — CFC spec §8.17.2 and invariant 14.)* Fail-closed is the required
    default for any row-set read. Filtering ("skip") is a per-row release of
    one presence bit and is permitted only as a declared opt-in
    (`onExceed: "skip"`), with the table's policy permitting the existence
    release and skips auditable; it never applies to aggregates. Per-user
    views become useful with reader-enumeration ceilings (`any([...])`) once
    OR-clause labels land (CFC spec §3.1.8, §8.10.3). What remains here is
    implementation (phase 3.b), not the principle.

## Authorization of the SQLite verbs

18. **Per-resource authz for `sqlite.query`, the folded `sqlite` write op, and
    `sqlite.register-disk-source`.** These are gated only by "a session exists on
    this space" — the same bar as a normal read — and the write/registration
    paths carry no per-cell/per-row policy.
    - **Implemented defenses:** server-side DDL validation (no `sqlType`
      injection — C1); a `(space, id)`-keyed disk-source registry (no cross-space
      hijack — C2); and an injected disk path that must be absolute, must exist,
      is `realpath`-canonicalized, and is rejected if it resolves **inside** the
      engine store directory (no reading core/other-space `.sqlite` files).
    - **Chosen v1 model:** `cf` is a **trusted operator** (operator access), so
      `register-disk-source` is not yet gated to a distinct operator capability,
      and an injected on-disk path is otherwise unconfined (any readable host
      file the operator names).
    - **Follow-up:** observe **CFC labels** for per-resource authorization here
      (operator vs. pattern, per-row clearance), and confine on-disk sources to
      an operator allowlist directory. **TODO before relying on this in a
      multi-tenant VM:** review how `fuse` authorizes callables and what
      `cf-harness` does inside a VM, and align the SQLite verbs' authorization
      with that model.
    - **Related — forgeable `_cf_link` (review H1).** A stored `_cf_link` is an
      **absolute** sigil link (id + space + scope), and any writer to a cell-db
      can set a link column to point anywhere — including another space. A typed
      `db.query<Row>` decodes it to a live `Cell`. Decoding must **not** by
      itself confer cross-space read authority: the resolved target has to remain
      subject to the reader's normal cell read policy (the CFC work above). v1
      does not add a separate space-constraint at decode time (which could also
      break legitimate cross-space links); closing this is part of wiring read
      policy through `getCellFromLink` for SQLite-sourced links.

## Ergonomics / minor follow-ups

19. **Friendlier client-side "≤1 cell-db per commit" error.** The server enforces
    at most one cell-db per commit and rejects a second with a `ProtocolError`
    (Section [04](./04-server-execution-and-transactions.md)). Two `db.exec` calls
    to the *same* handle in one handler are fine; calls to *two different* dbs in
    one handler trip the limit only at commit time. A client-side assertion in the
    write seam (`recordSqliteWrite`) could surface this earlier with a clearer
    message. Nicety, not a correctness issue.
20. **[resolved] Two schema paths disagree on the `SqliteDb` brand.** The
    schema-generator's object-formatter stamped `asCell: ["sqlite"]` for a
    `SqliteDb` field, but the ts-transformer's capability analysis (handler-state
    schemas) inferred `asCell: ["readonly"]` from SqliteDb's read-only method
    surface. **Resolved** by teaching the transformer that the explicit `"sqlite"`
    cell brand is authoritative and must survive capability shrinking — the same
    mechanism that preserves `Stream` (`preservedWrapperFor` in
    `type-shrinking.ts`); the schema generator now also recognizes the
    `SqliteDb` wrapper name (`type-utils.ts`/`wrapperKindForName`). Both paths now
    emit `["sqlite"]`. Making the brands agree surfaced two latent issues that are
    also fixed: (a) the public `SqliteDb` type no longer extends `IReadable`, so
    `db.get()`/`db.sample()` (meaningless on an opaque handle) no longer
    type-check; (b) the runtime's `db.exec` reads the handle via `getRaw()` rather
    than the schema-shaped `get()` (which, under the real `SqliteDatabase` schema,
    shaped the handle down to `{}` and dropped `id`/`tables`).

## Code-review follow-ups (deferred hardening)

21. **Injected-source jail on memory stores.** For a `file:` store the
    disk-source path is `realpath`-confined to outside the (canonicalized) store
    directory; for a **memory** store there is no on-disk store dir, so the only
    guard is the internal-cell-db basename reject (`(cf-)?cell-*.sqlite`). An
    injected `sqlite:` path on a memory store may therefore name an arbitrary
    readable host `.sqlite`. Accepted under the v1 cf-trusted-operator model
    (Q18); close it with the operator path-allowlist when CFC authz lands.
22. **[resolved]** `provider.sqliteQuery!` non-null assertion in the reactive
    builtin's flush — the missing-method case now throws a clear
    "provider does not support sqlite queries" error (caught by the flush and
    surfaced on the result cell as `error`, not left pending).
23. **[resolved]** Folded write alias clarity — `applySqliteOperation` now asserts
    the attachment with `.has()` (no dead `alias` binding) and documents that the
    unqualified statement relies on the ≤1-cell-db invariant + core-table guard,
    not on alias qualification.
24. **[resolved] Codec / factory duplication.** All three are consolidated, with
    the cell.ts ↔ cf-link.ts cycle broken via a cycle-free leaf module
    (`builtins/sqlite/cf-link-codec.ts`, which depends only on `link-utils` +
    types — no runtime `cell.ts` import).
    - **Cell→sigil encode:** `encodeSqliteParams` (cell.ts) and `encodeCfLinkValue`
      (cf-link.ts) both call the codec's `encodeCellToSigilString`, so write- and
      read-path sigils are byte-identical by construction (no inlining).
    - **Parse prologue:** `parseCfLinkToSigil` lives in the codec; `decodeCfLinkValue`
      delegates to it (one prologue, not two). cf-link.ts re-exports it so importers
      are unchanged.
    - **Bound-cell recovery:** a single exported `asBoundCell` in cell.ts (where
      `isCell`/`CellImpl` live), imported by cf-link.ts (the direction it already
      imported `isCell`).
    - **Factory:** the single `sqliteQuery` node factory lives in
      `builtins/sqlite/query-node.ts`, imported by both `db.query` (cell.ts) and the
      `sqliteQuery` builder export (built-in.ts).
25. **[resolved]** `decodeRowLinkColumns` now copies a result row lazily — only
    when a link column actually decodes to a different value — so rows with no
    link columns (or null values) are returned as-is on the reactive read path,
    avoiding the per-row spread.

## Read pool follow-ups (deferred)

> Risks carried forward from the read-pool work (Section
> [04](./04-server-execution-and-transactions.md#read-path-a-pooled-read-only-connection)).
> The pool is in place and correct for the current access pattern; these are
> sizing/hardening items, not correctness gaps.

26. **fd budget & pool sizing.** The pool caps open read connections with an LRU
    (evict → `close()`). Pick a sensible default and a per-space ceiling well
    under the OS file-descriptor budget as cell-db counts grow.
27. **WAL everywhere.** Reads observe only *committed* state and each query is a
    fresh read transaction, so WAL is **not** required today (pinned by a test).
    WAL remains a future hardening for concurrent read-*during*-write; if adopted,
    assess the `-wal`/`-shm` overhead and checkpointing for many small cell-dbs.
28. **Pooled-reader staleness on migration.** An additive migration bumps the
    schema cookie and the pooled reader reloads schema on next access (SQLite
    re-prepares against committed DDL). If a future case is found where it
    doesn't, add an explicit drop-and-reopen of the pooled connection on a known
    schema-version bump.
29. **Disk-source path disappearing / becoming unreadable** between registration
    and read — surface a clear error (today an open error from the pool) rather
    than a generic failure.
