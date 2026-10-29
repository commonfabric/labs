---
name: state-inspector
description: Debug Common Fabric runtime/multiplayer state from the durable store, offline, with `cf inspect`. Use when investigating "what is actually stored", a cell that looks different for two users, a lost/overwritten write, divergence across spaces, how state reached its current value, who/what touched a space, or any memory-v2 question you'd otherwise guess at from a live runtime. Reads space SQLite DBs read-only — no live server, no capture step.
---

# State Inspector — debugging Fabric state from the durable store

The thesis you can't derive: **the durable store the server already wrote is the
flight recorder.** Every commit, every per-scope revision, every read a commit
observed is on disk. `cf inspect` opens a space SQLite file read-only and
answers who/what/when/why-different questions with no live runtime. Reach for it
whenever you'd otherwise reason about runtime state from the outside — it
replaces a guess with the ground truth the engine itself reads.

Full command reference + flags: `runtime/state-inspector/README.md`. This skill
is the **map** — what the tool sees, what to trust, and which question each
command answers. Run commands with `deno task cf inspect <cmd>`; every command
takes `--json` for machine reading, and a `<space>` is a DID, a unique
DID-prefix, a space name (resolved the way the runtime derives it), or a path
(local DBs auto-discovered — start with `cf inspect spaces`).

## What it can — and can't — answer

It reads ONE durable store, offline and read-only. That single boundary tells
you when to trust it and when to reach for something else:

**It answers authoritatively** (the same bytes the engine reads): what is
_stored_ for any entity at any `(branch, seq)`; who/what/when wrote it (per
commit, UTC wall-clock to the second); how a value got there
(`history`/`diff`/`timeline`); whether identities _see different values_
(`overlay`); whether the store is _internally consistent_ (anomalous stale
reads); whether the same id agrees across spaces (`converge`); and the structure
of it all (`entities`/`piece`/`graph`).

**It can't — and reaching for it here will mislead you:**

- _Anything client-side_ — optimistic writes, cursor lag, what a browser is
  actually rendering. "Converged" / "consistent" describes the durable store,
  not what any client is showing.
- _A live or production bug from a local snapshot_ — a clean local store does
  not explain a prod-only misbehavior; at most it says the local data is
  healthy, so the cause is concurrency / scale / timing or client-side. Staging
  spaces can be fetched with `--remote` (see below); the dump endpoint is
  deliberately hard-off in production, so a prod space still means copying the
  `.sqlite` off the box (ssh+scp).
- _How long anything took_ — it has logical order (`seq`) plus
  second-granularity commit times ("what happened and when"), never latencies or
  durations.
- _What was rejected_ — the engine rejects stale reads _before_ they persist, so
  they are not here. Zero anomalies means consistent, not "no concurrency."
- _The live reactive graph_ — the dependency graph lives in runtime memory only;
  the sole durable scheduler state is the `scheduler_basis` index (doc-granular
  ids + seqs — no paths, no payloads), empty until the serving loop writes it.
  Entity/commit history always works.
- _Change anything_ — it is read-only; it explains, it never reproduces or
  fixes.

So **reach for it whenever you would otherwise guess at durable or multiplayer
state from outside a live runtime**; reach for something else for live behavior,
client rendering, performance profiling, or reproducing a bug.

## The mental model the output assumes

You will misread the tool without these — they are facts about how memory-v2
stores state, not things a model infers from the data:

- **An entity is a tree of top-level paths**, not a bare value: `value` plus
  meta paths `argument` / `result` / `patternIdentity` / `internal` / `schema` /
  `cfc`. The tool classifies an entity (piece / module / stream / schema /
  owned-cell / free-cell) by _which paths exist_, and resolves lineage from them
  — so "what is this entity" is answerable structurally, and `entities` /
  `piece` / `graph` speak that vocabulary.
- **An entity holding no document says which kind of nothing it is.** A
  tombstone is its own kind, `deleted`. `unknown` is everything else the tool
  cannot make sense of, and its label says which: `(undecodable)` for a payload
  that does not decode, `(no data)` for a `set` that stored none, `(absent)` for
  an id with no visible row, and `{paths}` for the one case that DID decode — a
  document whose shape no other kind recognizes. Ask `--kind deleted` for
  deletions and `--kind unknown` for trouble; do not read a tombstone as damage,
  and do not read the revision count as evidence either way (it includes the
  delete op). What the entity WAS is not in the listing — it is gone at HEAD,
  and `history <id>` plus `value-at --seq` before the delete is what recovers
  it.
- **`scope_key` partitions an entity by identity.** The _same_ cell id can hold
  a shared `space` value AND a per-`user:<DID>` override AND a
  per-`session:<DID>:<sid>` override, stored side by side and genuinely
  different. This is where "looks different for me" multiplayer bugs live. The
  runtime resolves what one identity sees by following a link planted at the
  base scope at _write_ time — **not** by a read-time session→user→space
  fallback (see the honesty contract).
- **Multi-USER ≠ multi-SESSION.** A cell written by two _sessions_ of one person
  (many tabs/devices) is benign; two distinct _principals_ is real cross-user
  contention. The tool draws this line for you — trust the `multiUser` flag, not
  the raw session count.
- **Two at-rest value formats coexist, both handled:** modern `data-model`
  codec-json (ids `of:fid1:…`) and legacy plain-JSON sigils (ids `of:baedrei…`).
  You don't route between them; just know an id's shape tells you the era.
- **Reconstruction is engine-faithful, and proven so.** State-at-`(branch, seq)`
  replays through the server's own `applyPatch`, honors branch inheritance and
  snapshots exactly like `read()`, and is locked to the real engine by a parity
  test that drives it. So a reconstructed value _is_ what the runtime would read
  — you can build on it without hedging.

## The honesty contract — what is ground truth vs. a hint

The tool is deliberate about this, and so must you be when you report findings.
Confusing an approximation for truth is the failure mode that matters here:

- **`overlay <space> <id>` is the ground truth** for "who sees what." It shows
  the entity's value in _every_ scope side by side and flags real divergence
  (compared on the raw stored value, depth-complete). For "this cell looks
  different for two users," this is the answer.
- **`value-at --as <DID>` is an APPROXIMATION** — the most-specific stored scope
  that holds the id. It cannot, from an id alone, know which declared scope a
  real read targets or follow the base-scope link. Useful as a quick "roughly
  what they see"; never quote it as the runtime read. Prefer `overlay`.
- **`conflicts` stale-reads are an ANOMALY detector, not lost-update history.**
  The engine validates every confirmed read _before_ committing, so a healthy
  store yields **zero**. A hit means an invariant violation / corruption —
  surface it loudly as such, and read "0 anomalies" as "the store is
  consistent," not "no concurrency happened." (The separate writer-timeline /
  `multiUser` contention view _is_ normal history.)
- **`converge` / `converge-scan` are server-view only** — durable values
  compared. "Converged" means the stored values agree, not that every client is
  rendering them; client cursor lag and optimistic writes aren't visible here.
- **Same id across spaces is usually NOT replica drift.** Content-addressed ids
  mean two spaces often hold independent _instances of the same pattern_, which
  legitimately differ. The scan labels `cross-space-linked` (real replica →
  drift bug) vs `no-cross-space-link` (likely independent instance). Don't cry
  wolf on the latter.
- **A `schema` under `$link` is what the link stores; a `$schemaSummary` beside
  it describes a schema too large to print.** A link's schema is a JSON Schema,
  so `true` and `false` are values it can really hold — `true` selects every
  value, declaring no constraint at all, where a schema with properties in it
  pins a shape at that link. Never read one as the other. The summary is
  `{ keys, bytes, digest }` and is a SIBLING of `schema`, never a value under
  it, because a link can store a schema of any shape and a summary in the
  `schema` slot could be a schema some link really holds. The two never both
  appear: a `schema` key means that is the stored schema, a `$schemaSummary` key
  means it was too large to print, and neither means the link stores no schema.
  Different digests prove two schemas differ; equal ones make agreement
  overwhelmingly likely without proving it, since the hash is truncated — reach
  for `--full-depth` when you need certainty or the text itself. An absent
  `digest` could not be computed, so two summaries that both lack one say
  nothing about whether they agree; an absent `keys` means the stored schema was
  not an object and so had none.

## Which question → which command

Start from the symptom; let the model below generate the path rather than a
fixed recipe. The recurring debugging questions and where they resolve:

- _"What's actually in this space / what is this entity?"_ → `spaces` →
  `summary` / `entities` / `piece`; `graph` for how pieces, cells, modules and
  streams connect (`--root <id> --depth` to drill, `--dot` for Graphviz).
- _"This cell looks different for user A vs B."_ → `overlay <space> <id>`
  (truth); `scopes` / `users` to see who has per-user/session state;
  `identity <DID>` for one identity's whole world (its spaces + the scopes it
  owns).
- _"A write seems lost / overwritten / a read was stale."_ → `conflicts <space>`
  to find contested cells, then `conflicts <space> <id>` for the writer
  timeline + the anomaly analysis. Remember: a _clean_ result means consistent,
  and a hit is an anomaly worth escalating.
- _"How did this entity reach its current value?"_ → `history` (every write,
  who), `timeline <space> <id>` (value after each write),
  `diff <space> <id> --from --to` (what changed between two seqs),
  `value-at … --seq` (state at a point).
- _"What collaborative operation history is retained, and are its checkpoints
  healthy?"_ → `operations <space> [id]` for field epochs, cursors, submissions,
  integrated rows, retained floors, and consistency checks.
- _"Is this space writing more than it should be / has it settled?"_ →
  `churn <space>` (commits + revisions per time bucket, and the entities driving
  the busiest one). `hot` ranks by all-time writes and so cannot separate a
  burst from the same writes spread over a week — churn is the shape-in-time
  view: a storm starting, and a settle completing. Use it before and after a
  `setsrc` on a populated space; `--bucket`/`--since`/`--until` frame the
  window. Pass `--until` with the moment you stopped watching: the curve then
  covers the window you asked about rather than ending at the last write, which
  is the difference between showing a storm and showing it SETTLE. It reports
  rates and never judges them — what counts as "settled" is yours to decide.
- _"Did a migration preserve this space's content?"_ → `cf space` (a sibling
  command, not `inspect` — a clone exists to be written to, so it lives outside
  inspect's read-only contract). `cf space clone <did> --from <snapshot> --to
  <dir>` builds a writable rehearsal copy plus a manifest; `verify` reports what
  moved against that baseline and `reset` restores it for the next attempt.
  Two things decide whether a rehearsal means anything, and both are easy to get
  wrong: `verify` is strict by default (any change exits nonzero, right for an
  untouched clone, wrong after a migration — pass `--expect-migration`, which
  gates on entities REMOVED instead), and it cannot see a clobber either way,
  because overwriting authored content is a change rather than a removal. Stop
  the server before `reset`: unlinking the database does not reach a process
  holding it open, so `reset` refuses rather than let a served clone keep
  serving the discarded attempt — a tripwire for a forgotten stop, not a
  substitute for it. Full procedure:
  `docs/development/space-clone-rehearsal.md`.
  `cf space fingerprint <space>` runs the content check alone against any store.
  Compiler-generated internal cells are excluded by default: a pattern update
  rotates their identities on purpose, so counting them would change the
  fingerprint on every legitimate migration.
- _"Is this entity the same across spaces / did a replica drift?"_ →
  `converge <id>
  --all` / `converge-scan --all`, trusting the
  replica-vs-instance label.
- _"I want to explore everything for a space interactively."_ →
  `html <space> --out
  file.html` (self-contained: tree + graph + detail pane
  with value, schema, CFC labels, lineage, links, source; `--app-url` adds live
  deep-links).
- _"The space I need is on staging/a server, not local."_ → add `--remote [url]`
  (defaults to `CF_API_URL`) to ANY command: it downloads a read-only snapshot
  into `~/.cache/cf-inspect/<host>/` and inspects it offline. `spaces --remote`
  lists what's dumpable; `pull --all --remote` caches everything so subsequent
  commands run offline. Signs with `CF_IDENTITY`/`--identity`; the server gates
  on a DID allowlist.

## Gotchas that will mislead you if unflagged

- **`scheduler_basis` is the only durable scheduler state** (besides the
  watermark machinery; serving-loop.md §3b). The retired
  `persistentSchedulerState` observation tables were deleted in server-execution
  v2 stage C.2, and the tool no longer reads them even from an old snapshot that
  still contains them. The entity-history surface always works; the basis table
  absent (pre-migration store) or empty is normal, not a broken DB.
- **A capped result announces itself — and the caps that don't are the ones to
  watch.** The space-wide scans (`entities`, `graph`, `html`) print a cap notice
  on stderr in _both_ modes, so silence there means you hold the whole set; a
  `--json` consumer that discards stderr discards the only warning it gets.
  `entities --kind` selects _during_ the scan, so `--limit` counts entities of
  that kind, not entities walked to find them. **Scripting a backup or rollback
  payload? Pass `--require-complete`** — a capped scan then exits nonzero with
  nothing on stdout. Check that status where it is produced: a shell pipeline
  reports its LAST command's status, so a scan piped into `jq` and a redirect
  refuses, and the redirect still writes an empty file and reports success.
  Capture the scan on its own, or set `pipefail`. It refuses for either kind of
  incompleteness — a cap reached, or an entity that would not reconstruct, which
  a higher `--limit` never recovers. The other caps stay silent —
  history/hot/contention row limits, and the HTML stale-read pass, which caps
  per bundle and _marks_ un-analyzed cells rather than showing them clean. There
  a count equal to a round cap is still the tell.
- **`--json` is the agent path.** Human output elides; for anything you parse or
  chain, pass `--json`.
- **It reads DBs it didn't write.** A corrupt/partial row degrades that one
  entity, not the whole command — but if a value looks absent where you expect
  data, check for a decode error before concluding the entity is empty.
