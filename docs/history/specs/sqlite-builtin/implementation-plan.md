---
status: historical
created: 2026-06-03
archived: 2026-07-09
reason: "As-built workstream record; the open items live in 08-open-questions.md."
---

# Implementation plan — SQLite builtins

Ordered workstreams for building the feature specified in this directory. Each
phase lists its goal, the files it touches (with the integration points already
located in the codebase), the work, tests, and exit criteria. Phases are ordered
to land a thin vertical slice early and defer the hardest/most-deferred pieces.

**Status (as-built):** Phases 0–5 are done and tested. The shipped API is the
**`SqliteDb` cell variant** (kind `"sqlite"`) exposing `db.query<Row>` (reactive
read) and `db.exec` (imperative, commit-atomic write) — **not** the standalone
`sqliteQuery`/`sqliteExecute` built-ins this plan was originally written against.
The reactive `sqliteExecute` built-in was removed; `db.exec` folds the write into
the caller's commit. **Phase 3 (reactivity)** is delivered via the in-commit
`rev`-bump model: `db.exec` bumps the handle cell's `rev` in its own commit, which
both drives `reactOn: db` re-query and serializes concurrent writers (the
multi-tab write mutex) — no separate post-commit signal. **Phase 7 (on-disk `cf`
source) is done, read-only v1** (`cf piece link sqlite:<path> <piece>/<field>`;
Section [03.3](../../../specs/sqlite-builtin/03-database-sources.md)). **Phases 6, 8, 9 are deferred**: WAL
crash detect/quarantine (6), VM-file source (8, stub), CFC labels (9, follow-up).
The shipped API surface (Section [01](../../../specs/sqlite-builtin/01-api.md)) supersedes the
standalone-built-in framing in the phase descriptions below; read those for the
workstream sequencing, not the exact call shapes. Items marked **[gated]** depend
on an open question ([08-open-questions.md](../../../specs/sqlite-builtin/08-open-questions.md)).

## Milestones at a glance

| Milestone | Phases | Delivers |
| --- | --- | --- |
| **M1 — Vertical slice** | 0, 1 | A pattern issues a server-side `SELECT` over the space websocket and gets rows. Proves protocol + builtin + ATTACH wiring end to end. |
| **M2 — Atomic writes** | 2, 3 | `sqliteExecute` writes that commit atomically with cell writes, plus reactive `reactOn: db` re-query. The core value proposition. |
| **M3 — Cell references & typed rows** | 4, 5 | `_cf_link` round-trip and `sqliteQuery<Row>` transformer typing. |
| **M4 — Durability & sources** | 6, 7, 8 | WAL crash reconciliation; injected on-disk and VM sources (stub → partial). |
| **M5 — CFC** | 9 | Per-column then per-row labels (separate follow-up). |

## Dependency graph

```
0 ──▶ 1 ──▶ 2 ──▶ 3
            │
            ├──▶ 4 ──▶ 5
            └──▶ 6
       7 (cf inject)  ── depends on 1; partial, mostly independent
       8 (vm)         ── depends on 1; stub
       9 (cfc)        ── depends on 4 (per-column), 2 (per-row write hook)
```

---

## Phase 0 — API surface & scaffolding

**Goal:** patterns type-check against the new API; builtins are registered but
return `not-implemented`. No behavior yet. De-risks the type design.

**Files**

- [`packages/api/index.ts`](../../../../base/api/index.ts) — add the public
  types: branded `SqliteDatabase`, `SqliteDatabaseSource`, `SqliteQueryParams`,
  `SqliteQueryState<Row>`, `SqliteExecuteParams`, `SqliteExecuteState`, and the
  function declarations (`sqliteDatabase`, `sqliteQuery`, `sqliteExecute`).
  Follow the existing `FetchJsonFunction` / `GenerateTextFunction` declaration
  style.
- `packages/api/` — `table(...)` and `cfLink<T>()` helper types (compile to
  `JSONSchema`; `cfLink` emits `{ type: "string", cfLink: true }`).
- [`packages/runner/src/builder/built-in.ts`](../../../../runtime/runner/src/builder/built-in.ts)
  — builder factories via `createNodeFactory({ type: "ref", implementation })`.
- [`packages/runner/src/builder/factory.ts`](../../../../runtime/runner/src/builder/factory.ts)
  — export `sqliteDatabase`/`sqliteQuery`/`sqliteExecute`/`table`/`cfLink` on the
  `commonfabric` object.
- [`packages/runner/src/builtins/index.ts`](../../../../runtime/runner/src/builtins/index.ts)
  — `registerBuiltins` registers `sqliteQuery` (`raw`) and `sqliteExecute`
  (`raw(..., { isEffect: true })`), initially pointing at stubs that throw
  `not-implemented`.
- `packages/runner/src/builtins/sqlite-query.ts`, `.../sqlite-execute.ts` — stub
  `Action` factories with the canonical signature
  `(inputsCell, sendResult, addCancel, cause, parentCell, runtime)`.

**Tests:** type-only fixtures that import and call each function; a pattern that
references them compiles. No runtime assertions yet.

**Exit:** `deno task check` passes on a sample pattern using the full API.

---

## Phase 1 — Read path (cell-derived, no reactivity, no `_cf_link`)

**Goal (M1):** a `SELECT` runs server-side against a cell-derived database and
returns plain rows to the pattern. The thin slice that proves the protocol and
builtin plumbing.

**Files & work**

1. **Protocol — new `sqlite.query` verb.**
   - [`packages/memory/v2.ts`](../../../../runtime/memory/v2.ts) — add
     `SqliteQueryRequest` to the `ClientMessage` union (near line 396), and a
     `{ rows: unknown[] }` payload on the existing `ResponseMessage`.
   - [`packages/memory/v2/server.ts`](../../../../runtime/memory/v2/server.ts) —
     parse the new `type` in `parseClientMessage`, route it in
     `Connection.receiveOrdered` (guarded by `requireSession`, like the
     `transact`/`graph.query` cases), and add `Server.sqliteQuery(message)`
     modelled on `Server.queryGraph` (~line 444 client / server handler).
   - [`packages/memory/v2/client.ts`](../../../../runtime/memory/v2/client.ts) —
     add `SpaceSession.sqliteQuery(...)` mirroring `queryGraph` (~line 444),
     using the existing `client.request<T>()` requestId correlation (~line 145).

2. **Server execution & ATTACH.**
   - [`packages/memory/v2/engine.ts`](../../../../runtime/memory/v2/engine.ts) —
     `Server.sqliteQuery` calls `openEngine(space)` (~line 1456), ATTACHes the
     cell-derived db file via the attach/detach cache, applies the **statement
     guard** (single `SELECT`/read-only CTE; reject DML/DDL, schema-qualified
     refs, `PRAGMA`/`ATTACH`/`DETACH`, multi-statement), then
     `engine.database.prepare(sql).all(params)`. The guard is tokenizer-level —
     **confirmed: `@db/sqlite@0.12.0` exposes no authorizer** (Section
     [04](../../../specs/sqlite-builtin/04-server-execution-and-transactions.md#isolation-namespacing--the-statement-guard)).
   - [`packages/memory/v2/storage-path.ts`](../../../../runtime/memory/v2/storage-path.ts)
     — add sibling-file naming `cell-<entityhash>.sqlite` next to the space file
     (`engine-v3/…`). (Q6 resolved → Option A, one file per db.)
   - **Attach/detach LRU cache** + **core-table-rename flag** (Q6/Q8a): probe the
     compiled `SQLITE_LIMIT_ATTACHED` (no `sqlite3_limit` binding to set it);
     manage attaches at transaction boundaries; rename core tables to include the
     space DID behind a flag (ship unflagged pre-production).

3. **Runner builtin — `sqlite-query.ts`.**
   - Read `db`, `sql`, `params` from `inputsCell`. Recover the handle cell from
     `db` via the `toCell` back-pointer
     ([`packages/runner/src/back-to-cell.ts`](../../../../runtime/runner/src/back-to-cell.ts);
     [`query-result-proxy.ts`](../../../../runtime/runner/src/query-result-proxy.ts)).
   - Allocate `{ pending, result, error }` output cells (model on
     [`packages/runner/src/builtins/fetch.ts`](../../../../runtime/runner/src/builtins/fetch.ts)).
   - Issue the query over the space session (the runner's storage client) and
     write the result back. (Reads are non-mutating, so no post-commit effect is
     needed for the read path itself.)

4. **Handle creation — cell-derived.**
   - `sqliteDatabase()` (no source) allocates a handle cell in the current frame
     (as builtins allocate result cells), with an **empty readable value**; the
     db name derives from its entity id
     ([`packages/runner/src/create-ref.ts`](../../../../runtime/runner/src/create-ref.ts)).

**Tests**

- `packages/memory` unit: `sqlite.query` returns rows; read-only guard rejects
  DML.
- `packages/runner` integration (model on `generate-text.test.ts`): a pattern
  queries an (empty) cell-derived db → `result: []`, `pending` settles false.
- `packages/generated-patterns` fixture once a real table exists (after Phase 2).

**Exit:** a pattern `SELECT`s from a cell-derived db over the live websocket and
receives rows; non-`SELECT` statements are rejected server-side.

---

## Phase 2 — Write path & atomicity (cell-derived)

**Goal (M2a):** `sqliteExecute` writes ride the existing commit transaction, so
cells + rows commit atomically.

**Files & work**

1. **Commit operation kind.**
   - [`packages/memory/v2.ts`](../../../../runtime/memory/v2.ts) — add
     `SqliteOperation { op: "sqlite"; db; sql; params }` to the `Operation`
     union (currently `SetOperation | PatchOperation | DeleteOperation`, lines
     69–89).
   - [`packages/memory/v2/engine.ts`](../../../../runtime/memory/v2/engine.ts) —
     add `case "sqlite"` to `writeOperation` (line 3241): ensure the db is
     ATTACHed to `engine.database` (already inside the open transaction from
     `applyCommit` → `applyCommitTransaction`, lines 1510 / 3068), then execute
     the statement on that connection so it is part of the same `.immediate()`
     transaction. Order `sqlite` ops **last** among a commit's operations.

2. **Runner builtin — `sqlite-execute.ts` (`isEffect`).**
   - Append a `sqlite` operation to the transaction the effect runs in, rather
     than performing a separate RPC. Encode `_cf_link` params is deferred to
     Phase 4; for now reject cell-valued params.
   - Record that the db has pending writes in the current transaction, to support
     the read-after-write guard.

3. **Read-after-write guard.**
   - In `sqlite-query.ts` / server, if a `sqlite.query` targets a db with
     uncommitted `sqlite` writes in the same transaction, reject with
     `read-after-write-unsupported` (spec Section 04).

4. **DDL / migration from `tables` — additive-only (Q9 → V1 cut).**
   - On first server-side open, diff declared `tables` vs `PRAGMA table_info`:
     `CREATE TABLE` when absent, `ALTER TABLE ADD COLUMN` for new
     nullable/defaulted columns, validate `_cf_link` columns are `TEXT`.
   - **Destructive/ambiguous changes** (drop/rename/retype, constraint/PK change)
     → **refuse to open the db** with an explicit "unsupported migration" error
     (a declarative diff can't tell rename from drop+add). Document that
     `ADD COLUMN` can't add `NOT NULL` without a default.
   - *Deferred (post-V1):* opt-in **migration callback** — keep erroring by
     default, but let a db supply author logic invoked when the on-disk schema
     version is older than the declared one, to perform the reshape explicitly.

**Tests**

- Atomic commit: a handler that sets a cell and inserts a row → both visible
  after commit; a rejected commit (seq conflict) leaves neither.
- Read-after-write in the same tx throws.
- DDL: declaring `{ tables }` creates them; add-column migrates; drop-column
  errors.

**Exit:** a pattern INSERTs and the row + surrounding cell writes are atomic.

---

## Phase 3 — Reactivity (`reactOn: db`)

**Goal (M2b):** queries re-run after committed writes, never on optimistic
state.

**Files & work**

- [`packages/memory/v2/engine.ts`](../../../../runtime/memory/v2/engine.ts) /
  [`server.ts`](../../../../runtime/memory/v2/server.ts) — when
  `applyCommitTransaction` applies a `sqlite` op, mark the **handle cell's
  entity** dirty via `markSpaceDirty` (line ~1280; already per-entity). The
  session sync (`syncSessionForConnection`, ~line 1152) pushes only after the
  commit is durable.
- `sqlite-query.ts` — read `reactOn` wholesale (any schema) so the scheduler
  subscribes to the handle cell; re-issue the query when it is dirtied. Confirm
  via the scheduler's own-commit-source / committed-state semantics
  ([`packages/runner/src/scheduler/`](../../../../runtime/runner/src/scheduler)).
- Fallback: if a server hook is not viable, bump the handle cell from a
  post-commit effect (`enqueueSinkRequestPostCommitEffect`,
  [`packages/runner/src/cfc/sink-request.ts`](../../../../runtime/runner/src/cfc/sink-request.ts)).

**Tests:** write → dependent `sqliteQuery` re-runs after commit; assert no
re-run against optimistic in-flight state (no phantom rows).

**Exit:** reactive re-query works for cell-derived dbs.

---

## Phase 4 — `_cf_link` encode/decode

**Goal (M3a):** cells survive a write/read round-trip as live cells.

**Files & work**

- `table()` / `cfLink<T>()` finalize their JSON-schema output and the
  `cfLink: true` marker + the "single string field ending in `_cf_link`"
  validation.
- **Encode (write builtin):** map each param to its column (from the statement's
  named columns) against the db table schema; for a link column, require a cell
  and serialize an **absolute** sigil link via
  `createSigilLinkFromParsedLink(link, { includeSchema: false })`
  ([`packages/runner/src/link-utils.ts`](../../../../runtime/runner/src/link-utils.ts);
  cf. `Cell.getAsLink`, [`packages/runner/src/cell.ts`](../../../../runtime/runner/src/cell.ts) ~1400).
  Enforce all throw conditions (Section 02).
- **Decode (query builtin):** identify link columns (Row schema `Cell<T>` → table
  `cfLink` → `*_cf_link` suffix); `JSON.parse`, validate single `link@1`,
  reconstruct a `Cell` via the runtime's link resolution. Throw on malformed.

**Tests:** round-trip a `Cell<User>` through a `_cf_link` column, including
cross-space; every throw condition; `NULL` → `null`.

**Exit:** `_cf_link` columns behave as specified.

---

## Phase 5 — `sqliteQuery<Row>` transformer support

**Goal (M3b):** the `Row` type argument is lowered to a runtime schema; `Cell<T>`
fields drive decode through aliases/joins.

This is a **routine, well-trodden change**, not a research item: the transformer
already lowers type arguments to schemas for `toSchema<T>`, `generateObject`, and
`lift`. Follow the existing path — see
[`packages/ts-transformers/docs/adding-type-arg-schema-lowering.md`](../../../../base/ts-transformers/docs/adding-type-arg-schema-lowering.md)
(added alongside this spec).

**Files & work**

- [`packages/ts-transformers/src/core/commonfabric-runtime-registry.ts`](../../../../base/ts-transformers/src/core/commonfabric-runtime-registry.ts)
  — register `sqliteQuery` (a `runtime-call` entry is enough).
- [`packages/ts-transformers/src/transformers/schema-injection.ts`](../../../../base/ts-transformers/src/transformers/schema-injection.ts)
  — recognize the `sqliteQuery<Row>` call (`detectCallKind` + single type arg)
  and inject the lowered schema via `createSchemaCallWithRegistryTransfer`,
  exactly as `generate-object` injects its result schema. `schema-generator.ts`
  emits the literal off the registry transfer; no change expected there.
- `sqlite-query.ts` — accept the injected `Row` schema; use it as the
  highest-precedence source for `_cf_link` decode and result shaping.
- Add a `test/fixtures/schema-transform/` fixture pair for `sqliteQuery<Row>`.

**Tests:** transformer fixture pair (`input.tsx` → `expected.jsx`) under
`packages/ts-transformers/test/fixtures/`; runtime test of the aliased-column
decode case from Example 07-#2.

**Exit:** `<Row>` drives decode; omitting it falls back to the table schema.

---

## Phase 6 — WAL crash safety: detect + quarantine (Q7 → V1 cut)

**Goal (M4a):** never serve divergent cell/row state after a crash mid-commit.
V1 detects and quarantines; auto-repair is a fast-follow.

Two pieces of Phase 6 land **early, in Phase 2**, so they don't require a later
migration: writing the watermark in-txn, and persisting each commit's `sqlite`
ops in the commit record.

**Files & work**

- [`packages/memory/v2/engine.ts`](../../../../runtime/memory/v2/engine.ts):
  - Add a `_cf_commit_watermark(seq)` row in each attached db, written **inside**
    the commit txn and advanced on commit (done in Phase 2; no hot-path cost).
  - **Persist the commit's `sqlite` ops** in the commit record (Phase 2) so a
    behind db can later be replayed without a schema migration.
  - On `open()` (~line 1335), compare the space's committed `seq` (`commit`
    table) against each attached db's watermark. **On mismatch → quarantine**
    that pattern db: fail its queries with a clear error and log loudly. Do
    **not** serve it.
- Rejected alternative: per-commit checkpoint+fsync of both files under a lock —
  doesn't close the crash window and kills WAL throughput.

**Deferred (fast-follow): auto-repair.** Replay the persisted ops for the missing
seqs when a pattern db is *behind*; truncate orphaned in-doubt writes when it is
*ahead* (needs per-row seq tagging or a rebuild). Lifts the quarantine
automatically.

**Tests:** fault-injection that interleaves WAL durability across the two files
and asserts (V1) the db is quarantined, not silently divergent; (later) that
auto-repair restores agreement.

**Exit:** a crash never yields silently divergent cells/rows — the affected
pattern db is quarantined and flagged.

---

## Phase 7 — Injected on-disk source via `cf` (stub → partial)

**Goal (M4b):** operators connect an on-disk db to a pattern input; pattern is
source-agnostic. **[gated on Q13/Q14 — co-location, cross-space dirty.]**

**Files & work**

- [`packages/cli/commands/piece.ts`](../../../../runtime/cli/commands/piece.ts) /
  `parseLink` — recognize the `sqlite:` scheme in `cf piece link`. Create-if-absent
  a handle cell with id from `createRef(space, absPath)` in a service space,
  store the `{ disk: { path } }` descriptor as server-side registration (not in
  the cell value), then write a normal sigil link to the input field.
- Server — resolve `disk:` descriptors to reachable/attachable files; return
  `not-implemented` until co-location is settled.
- Reactivity — cross-space dirty signal for the service-space handle, or restrict
  injected dbs to read-only (`reactOn` omitted) for v1 (Q12).
- Pending-until-connected already falls out of an empty input (Phase 1/3).

**Tests:** `cf piece link sqlite:` is idempotent (same `(space, path)` → same
handle); pattern shows pending until linked, then resolves.

**Exit:** read-only injected on-disk dbs work end to end (writes/atomicity may
remain deferred).

---

## Phase 8 — VM-file source (stub)

**Goal:** `sqliteDatabase({ vm, path })` resolves; server returns
`not-implemented` until the improved VM file API exists. **[gated on Q13.]**

**Files & work**

- Wire the `{ vm, path }` descriptor through the handle and server resolver.
- When implemented, VM-file writes run as a **non-atomic post-commit effect**
  (like `fetchJson`), not part of the commit transaction (Section 03.2).

**Exit:** API stable; explicit `not-implemented` until backend lands.

---

## Phase 9 — CFC (separate follow-up)

**Goal (M5):** per-column then per-row confidentiality/integrity. See
[06-cfc.md](../../../specs/sqlite-builtin/06-cfc.md) and cross-reference
[`docs/plans/runner_cfc_implementation.md`](../../../plans/runner_cfc_implementation.md).

- **9a — per-column:** honor static `ifc` on table columns for read-label
  propagation and write-time checks, reusing `ContextualFlowControl`
  ([`packages/runner/src/cfc.ts`](../../../../runtime/runner/src/cfc.ts)) and the
  write-policy sink ([`sink-request.ts`](../../../../runtime/runner/src/cfc/sink-request.ts)).
- **9b — per-row:** declarative row-label projection evaluated server-side at
  commit and on read; row-level filtering / fail-closed reads. **[gated on
  Q16/Q17.]** Implementation note: `@db/sqlite` exposes custom scalar/aggregate
  function registration (`function()`/`aggregate()`), so projection helpers like
  `principal(field)` (`"did:mailto:" + field`) can be **registered SQL
  functions** evaluated in-engine at commit — no separate expression interpreter.

---

## Cross-cutting work

- **Statement guard** must be robust against smuggling (comments, multiple
  statements, `PRAGMA`, schema-qualified references). `@db/sqlite` exposes **no
  authorizer**, so this is a tokenizer-level guard (Section
  [04](../../../specs/sqlite-builtin/04-server-execution-and-transactions.md#isolation-namespacing--the-statement-guard)),
  not a `prepare`-time authorizer. Future hardening: bind
  `sqlite3_set_authorizer` via Deno FFI against `Database.unsafeHandle` for
  defense-in-depth.
- **Concurrency:** `@db/sqlite` is one synchronous connection per `Database`;
  long queries block the space. Add a statement timeout, and evaluate a separate
  WAL read connection. **[gated on Q8.]**
- **Telemetry/tracing:** emit query/exec spans consistent with existing builtins.
- **Docs:** a `pattern-dev` skill note and a catalog/story example once M3 lands.

## Test strategy

- **Per-package unit:** `packages/memory` (protocol, engine ops, reconciliation),
  `packages/runner` (builtin behavior), `packages/ts-transformers` (fixtures).
- **Integration:** `packages/generated-patterns/integration/patterns/` — a
  `sqlite-*.pattern.ts` exercising query + execute + reactivity end to end
  against a live toolshed, mirroring the `ct-1334-fetchjson-*` patterns.
- Every new workspace package (none expected here) would need a `test` task per
  `AGENTS.md`; this feature extends existing packages only.

## Risks & gating summary

| Risk / decision | Gates | Open question |
| --- | --- | --- |
| ATTACH model → **resolved: one file per db (A)** | — | Q6 |
| Attach limit (LRU cache, probe-and-log) + shadowing guards; DID-rename deferred behind flag | Phase 1, 2 | Q8a |
| Migration → **resolved: additive-only**; callback deferred | Phase 2 | Q9 |
| WAL crash safety → **resolved: detect + quarantine**; auto-repair deferred | Phase 2, 6 | Q7 |
| On-disk co-location & cross-space dirty | Phase 7 | Q12, Q13, Q14 |
| Connection contention / timeouts | Cross-cutting | Q8 |
| Row-label projection expressiveness; read filtering | Phase 9 | Q16, Q17 |
