# `cf space clone` — rehearsal-grade space copies

**Status:** proposed. Research complete; not yet agreed. Written 2026-07-24
against the July Estuary Topics migration, which established that updating a
deployed pattern on a populated space is a rehearsal-grade event. Decides
whether the hand-built clone rehearsal becomes a command, and what shape.

**Revised 2026-07-27.** This doc originally gated on interviewing Wilk, who
built the rehearsal setup with Gideon; both answered on PR #5009's review
threads, and the answers are folded in below ([Interview
results](#interview-results-2026-07-27)). The headline change: the copy/reset
mechanics were *less* painful in practice than predicted, and the verification
bookkeeping — counts and fingerprints, re-invented as ad-hoc SQL per run — was
the actual toil. The recommendation re-weights accordingly: the manifest,
`--verify`, and `churn` are the payload; the copy mechanics are a thin wrapper.

## Why

The July Topics migration exposed the whole failure surface of a live pattern
update, and every mitigation that worked was hand-built:

- the legacy→current transition **fails the compat checker**, forcing
  `--dangerously-allow-incompatible-schema` plus manual validation;
- a first production attempt was **rolled back on false-negative health
  checks** — cold browser loads take ~20 s, and unstepped CLI reads look empty;
- historical pattern updates produced **generated-cell write storms**: per the
  board's incident record, 20 generated cells produced 192,381 revisions —
  90.3% of every revision and 96.0% of all commits in the 2026-07-22 snapshot,
  peaking at 1,598 commits/minute;
- the thing that actually worked was a **copy-on-write clone rehearsal**: copy
  the space's SQLite store, serve it from a local toolshed, migrate all 73
  topics serially, verify counts / fingerprint / cold reads / write settlement,
  reset, repeat.

That rehearsal caught two data-corrupting schema bugs ([#4997]) that static
checking could not — a dangling legacy `createdByName` author link and a
recursive `TopicPiece` crossref that made validation stop making progress. It
also demonstrated the fix for the write storm: "current-main clients against
the local clone become completely quiet."

The verb-contract arc commits to continuous dogfood on this board — every phase
implies another rehearsal — and its Risks section already names the gate:
"before any live `setsrc`, rehearse old→populate→new in a scratch space watching
commit rates." Today that instruction has no executable form. This document
decides what to build so it does.

[#4997]: https://github.com/commonfabric/labs/pull/4997

## Recommendation in one paragraph

Build a **thin, offline `cf space clone`** whose payload is the bookkeeping —
the manifest and `--verify`, replacing the ad-hoc SQL and Python one-liners
each rehearsal has re-invented for counts and fingerprints — plus **`cf
inspect churn`**, the retrospective commit-rate query that makes the
write-storm gate executable offline. The copy mechanics (store-path knowledge,
crash-consistent snapshot, pristine/working split) ride along as a thin
wrapper; practice showed they were never the hard part. Clone **same-DID**.
Reset by re-copy from a pristine snapshot (clonefile where the filesystem
offers it). Leave server-side acquisition, toolshed orchestration, and the
migration driver **manual**. Roughly 400 lines across two layer-4 packages,
against a practice the team is already committed to repeating every phase.

## What exists (verified)

| Fact | Where |
| --- | --- |
| Crash-consistent snapshot via `VACUUM INTO`; never mutates source, never runs the engine's DDL-on-open path; produces one file with no `-wal`/`-shm` | `packages/memory/v2/dump.ts` |
| A space is one SQLite file whose name encodes its DID; directory mode nests under `engine-v3/` with the **literal** DID as the stem, single-file mode percent-encodes it | `packages/memory/v2/storage-path.ts` |
| The store dir defaults to `./cache/memory/` relative to cwd — so storage is already isolated per checkout | `packages/toolshed/env.ts` (`MEMORY_DIR`) |
| The dump endpoint is hard-off in production: fail-closed env allowlist, no override, and "a prod form is a separate mechanism" | `packages/toolshed/routes/storage/memory/memory-dump-policy.ts` |
| `cf inspect --remote` fetches snapshots into `~/.cache/cf-inspect/<host>/` | `packages/state-inspector/remote.ts` |
| Genesis/ACL ride inside the store (`of:<space>` doc), so existing team keys authorize on a copy | `packages/memory/v2/server.ts` |
| `cf inspect` is read-only by contract — "it explains, it never reproduces or replays" | `skills/state-inspector/SKILL.md` |

## Identity: same-DID, and it is not close

The clone keeps the source space's DID. Re-keying is not a rename; it is an
unbounded data migration, and it degrades exactly the fidelity the rehearsal
exists to buy.

**What would survive a re-key.** Entity ids are content-addressed from
`{source, cause}` and do **not** include the space DID (`createRef` in
`packages/runner/src/create-ref.ts`), so the document graph is space-agnostic.
Same-space links elide the `space` field entirely when it matches the base
(the base/baseSpace elision in `packages/runner/src/link-utils.ts`). On those two dimensions a re-key
is a no-op.

**What would break.**

1. **CFC labels name the space.** `CfcSpaceAtom` and `HasRole` carry a space
   DID (`packages/api/cfc.ts`), and `space` is a *commitment* field —
   equality-consumed (`packages/runner/src/cfc/label-field-classification.ts`).
   At render the runtime mints `HasRole(actingPrincipal, space, reader)` from
   the **actual** space and correlates it against the stored label
   (`render-ceiling.ts`, `space-membership.ts`). A stored `Space(did:PROD)` atom
   under a `did:CLONE` runtime never correlates, and the ceiling **fails
   closed** — content silently over-blocks. A rehearsal that over-blocks is
   worse than no rehearsal: it manufactures failures the live update won't have.
2. **The ACL doc is keyed by the DID.** `aclDocId(space) === "of:" + space`
   (`server.ts`). Re-keying orphans it, and the clone falls through to
   `#resolveCapability`'s legacy-compat branch — a populated space with no ACL
   grants WRITE to any authenticated principal. That branch is explicitly
   "temporary pre-launch compatibility" and is on its way out. Rehearsing on it
   means rehearsing a different authorization world.
3. **History can't be re-signed.** Every `invocation` row records `sub` (the
   space DID) and links to an `authorization` row holding the signed UCAN
   (the `invocation`/`authorization` tables in `engine.ts`). Re-keying makes
   every historical row inconsistent with its signature, and we cannot re-sign
   them.
4. **Cross-space links are unfixed either way.** Links to *other* spaces keep
   their DIDs under both schemes, so re-keying buys nothing there.

**The residual same-DID risk is real, and belongs at the endpoint layer.** Two
stores now claim one identity, so a mis-pointed client is the hazard. The fix is
not to change the identity — it is to make the clone unreachable at the prod
address and loudly labeled at its own. See [Safety rails](#safety-rails).

**Interview result:** the July rehearsal used same-DID, and Wilk noticed no
trouble — caveated that he drove it mostly through an agent, so a mis-point
could have gone unseen. That caveat argues for rail 3 (making the clone
unmistakable at the endpoint), not against same-DID.

## Write semantics and the reset mechanism

All of this is measured, not assumed. The probe below ran against a 124 MB
WAL-mode SQLite store shaped like a space file, with a writer connection held
open throughout — the live-server condition.

| Step | Result |
| --- | --- |
| `VACUUM INTO` with the writer open | 176 ms → 124.3 MB, **no `-wal` companion** |
| `cp -c` (APFS clonefile) of the snapshot | **8.9 ms**, no additional disk |
| plain `cp` of the same file | 24.1 ms |
| open clone + engine pragmas + idempotent DDL + write | 126 ms; creates `-wal` |
| source byte-identical afterwards | **yes** |
| pristine snapshot byte-identical afterwards | **yes** |
| reset (`rm` working set incl. `-wal`/`-shm`, re-clone) | **3.5 ms**, rehearsal write gone |

**Migration-on-open is safe on a copy.** `Engine.open` is forward-only and
idempotent: `CREATE TABLE IF NOT EXISTS` plus a fixed list of guarded
`migrate*` steps, all applied under `create: true`
(`packages/memory/v2/engine.ts`). Running it against a VACUUM-INTO copy is the
ordinary path — the copy is a complete database, not a partial one. This is
precisely why `dump.ts` refuses to run it against the *source*.

**WAL is handled by the copy primitive, not by us.** `VACUUM INTO` checkpoints
into the destination, so the pristine snapshot has no companions to ship or to
get out of sync. The *working* copy grows a `-wal` as soon as the engine opens
it, which is why reset must delete the companions and not just the `.sqlite`.

**"Copy-on-write / reset per attempt" concretely** — a three-file discipline:

```
<clone-dir>/
  clone.json                        # manifest: source, fingerprint, counts
  pristine/<did>.sqlite             # VACUUM INTO output; never opened rw
  engine-v3/<did>.sqlite            # the working copy; toolshed serves this
```

Reset = delete `engine-v3/<did>.sqlite{,-wal,-shm}`, re-copy from `pristine/`.
Not `sqlite3 .backup` (needs a live connection, slower, no advantage here). Not
re-running `VACUUM INTO` (needs the source, which may be a laptop-local scp'd
file or offline).

**Implemented as a portable `Deno.copyFile`, not clonefile** (revised
2026-07-27 during implementation). Clonefile needs a `cp -c` subprocess and a
platform branch — GNU `cp` has no `-c` — and measured against the real 1.1 GB
Estuary store a plain-copy reset costs **14.2 s**, against a rehearsal whose
migration phase runs for minutes. Wilk's rehearsal used plain `cp` for the same
reason. Clonefile stays available as a later optimization if reset ever sits on
the critical path; the numbers to beat are in the table above.

**Interview result:** Wilk reset with a plain `cp` — no clonefile — and it was
fine at Topics-store scale; Gideon likewise drove the mechanics through his
agents. Clonefile is an optimization, not a requirement. The attempt count went
unrecorded (Gideon answered live rather than in-thread).

## Acquisition: scp-then-clone is the honest scope

The production dump refusal is deliberate and well-reasoned, and this proposal
does not touch it. `memory-dump-policy.ts` fails closed on an env allowlist
specifically so an alias or typo can't enable it, states "there is intentionally
no override to turn raw whole-space dumps on in production," and the route
carries an unresolved capacity caveat — no size or concurrency cap, which the
comment names as a prerequisite before wider availability. Underneath both:
**a dump is the entire contents of a space**, which is a confidentiality
decision, not an ergonomics one.

So:

- **Staging** (`MEMORY_DUMP_ENABLED`, tailnet, allowlisted DID): `cf space clone
  --from-remote <url>` reuses the existing `cf inspect pull` path verbatim. No
  new server surface.
- **Production**: the operator runs `VACUUM INTO` server-side and scp's the file
  down; `cf space clone --from <path>` takes it from there. The command's job is
  to document that one-liner in its error message when `--from-remote` hits a
  404, so the manual path is discoverable rather than folklore.

**Interview result — this matches the practiced flow, plus one hop worth
keeping:** the July rehearsal did server-side `VACUUM INTO`, scp'd the file
down, then uploaded it to **S3 so other operators could download the same
snapshot**, and copied it into a running toolshed's cache dir. One shared
snapshot is better rehearsal hygiene than per-operator dumps (identical
baselines, comparable fingerprints), so `--from` should accept an `https://`
URL as well as a path. What stays out is any *production server* surface.

If prod acquisition later deserves automating, it is a separate mechanism with
its own access-control design — as the existing comment already says. Bundling
it into this command would relitigate a decision that was made correctly.

## Layering: `cf space`, over `state-inspector`

Per the pace layers in `AGENTS.md`, `cli` and `state-inspector` are both
Operation (layer 4), and memory is Foundation (layer 1). Operator tooling over
the memory layer is exactly what layer 4 is. `state-inspector` already imports
`@commonfabric/memory/v2/dump` and already owns remote acquisition and the cache
layout, so the mechanism goes there and the command surface goes in
`packages/cli/commands/space.ts`.

Two rejected alternatives:

- **A script in `scripts/`.** It would have to reimplement `resolveSpaceStoreUrl`'s
  mode-dependent filename encoding — the one thing in this whole area that is
  genuinely non-derivable, and whose comment says changing it "silently forks
  data into new per-space files." A script copy of that logic drifts silently.
- **A `cf inspect` subcommand.** `inspect`'s contract is its value: read-only,
  offline, "it explains, it never reproduces or replays." A clone exists to be
  written to. Filing it under `inspect` costs the one boundary that makes the
  skill trustworthy. A new `cf space` noun keeps that line sharp and gives
  future space-level operations a home.

## Safety rails

The write-storm history and the mis-pointed-client hazard drive four rails.

1. **Refuse the dangerous targets.** `cf space clone` fails if the resolved
   target directory is the store dir the local toolshed is configured to serve
   (`MEMORY_DIR` / `DB_PATH` from the environment), or is the source directory.
   Both are cheap path comparisons and both are the accidents worth blocking.
2. **A manifest, and `--verify` — the command's payload.** `clone.json` records
   source host/path, source DID, VACUUM timestamp, a hash of the pristine
   snapshot (via `@commonfabric/content-hash`, the canonical SHA-256 home — not
   a direct `crypto.subtle.digest`), `max(seq)` and commit count, and the tool
   revision. `cf space clone --verify` re-checks the working copy's fingerprint
   against it. This is the executable form of Gideon's "snapshot manifest +
   content fingerprint," and per the interview it replaces the part of the July
   rehearsal that was genuinely re-invented each run: counts and fingerprints
   were ad-hoc SQL and Python heredocs written by an agent per attempt. Two
   rehearsals whose fingerprints were computed differently can't be compared;
   the manifest is what makes attempts commensurable.
3. **Make the clone unmistakable at the endpoint.** The clone directory carries
   a `.cf-clone` marker; the toolshed prints a startup banner naming the clone
   and its source when its store dir contains one. Both halves are now built:
   the marker ships with `cf space clone`, and the banner with
   `packages/toolshed/lib/clone-banner.ts`. A printed hint from `cf space clone`
   alone was weak, and "make prod-vs-clone unmistakable" was the explicit ask.
   Note the banner fires at boot and then scrolls away — it does not help
   someone returning to a browser tab an hour later; surfacing clone-ness in the
   shell UI would, and is not designed. The clone launches on an
   offset port via the existing `start-local-dev.sh --port-offset`, so the
   api-url differs by construction.
4. **`cf inspect churn`.** A time-bucketed commit/revision rate query —
   commits and revisions per bucket over `commit.created_at`, plus the top
   entities in the hottest bucket. Two neighbors exist and neither fills this
   slot: the OTel commit telemetry (SigNoz) shows live rates but only where a
   collector was attached when it mattered, and [#4950] (open) adds
   deterministic commit/settle counters for *orchestrated diagnostics runs* of
   a live runtime. Churn's niche is retrospective and offline — any store, any
   time window, no instrumentation required at incident time. Within the
   state-inspector, `hotEntities` (`packages/state-inspector/queries.ts`)
   gives all-time write counts per entity with no time dimension, which cannot
   show a storm starting or a settle completing. Churn is what makes "watch
   commit rates" executable against the flight recorder, and it earns its keep
   on live spaces independent of cloning — it is the query that would have
   caught the July storm in minutes.

## Corrected by the first real rehearsal (2026-07-29)

This document claimed that excluding compiler-generated cells would leave the
content fingerprint **unchanged** across a clean pattern update. That is wrong,
and the first real rehearsal proved it: a schema migration rewrites every
piece's *result* value, and results are part of the fingerprint, so
`fingerprint.match` is false after any successful migration.

Excluding generated cells was necessary but not sufficient. The single hash
therefore cannot distinguish "the update worked" from "content was destroyed",
which was the one job it was designed for.

What does distinguish them is the **shape** of the change. On the Topics
rehearsal: 149 changed (74 pieces, 73 owned cells, 2 modules), 3,189 added,
and **0 removed** — while every authored title, body, comment and link stayed
byte-identical (73 topics / 59 comments / 56 links, matching #4997). `removed`
is the alarm; changes confined to pieces and their derived cells are the
migration working. `cf space verify` now reports that breakdown, and authored
content still has to be checked separately — no fingerprint over the whole
store can answer "did the content survive?" on its own.

## Fidelity caveats the practice must state

A clone is not the production system, and two gaps are worth naming so a
rehearsal isn't over-trusted:

- **Cross-space references resolve to empty, not to an error.** The memory
  server creates space stores on demand (the space-open path in `server.ts`:
  `ensureDir` + `Engine.open` with `create: true`), so any link to another space silently
  manufactures an empty local one. A fresh space grants READ only, so the read
  succeeds and returns nothing. Rehearsing a pattern with cross-space reads will
  look cleaner than production.
- **A clone tests the durable store and the runtime, not the deployment.**
  Cold-load timing, CDN/shell versions, and concurrent human traffic are all
  absent. The ~20 s cold-load patience rule exists because of the deployment,
  and a fast clone cold load does not retire it.
- **Watch item (interview):** nothing lied during the July rehearsal, but Wilk
  flags that as profile use and cross-space links grow, the empty-space
  substitution above will matter more. Revisit when a rehearsal first involves
  profile-linked content.

## Scope cut

**Build (increment 1).**

- `cf space clone <did> --from <path|dir> | --from-remote <url> --to <dir>` —
  resolve the store path, copy to `pristine/`, copy that to `engine-v3/`,
  write `clone.json`, write `.cf-clone`, print the launch command.
- `cf space clone --reset` — restore the working copy from pristine.
- `cf space clone --verify` — fingerprint check against the manifest.
- `cf inspect churn <space> [--bucket 1m] [--since …] [--top N]`.

**Layout correction (2026-07-28).** The first implementation wrote the working
copy to `<dir>/engine-v3/<did>.sqlite` and told the operator to point
`MEMORY_DIR` at `<dir>`. A server pointed there actually reads
`<dir>/engine-v3/engine-v3/<did>.sqlite`: toolshed's
`resolveMemoryEngineStoreRootUrl` appends `engine-v3`, and memory's
`resolveSpaceStoreUrl` appends it again. Every clone produced was therefore
unservable — the server found nothing and silently created a fresh empty space
— and every test passed, because they all checked the layout against the
tool's own hardcoded constant rather than against the resolvers. Only booting a
real toolshed and reading the board back exposed it.

The fix is not to hardcode the doubled path, which would be a third statement
of the layout. `resolveMemoryEngineStoreRootUrl` moved into
`memory/v2/storage-path.ts` beside `resolveSpaceStoreUrl`, and both the clone
and its tests now COMPOSE the two. If the redundant append is ever removed,
clones follow with no further change. The doubling itself is a latent bug worth
its own change: every existing store depends on it, so removing it is a
migration, not a drive-by.

**Build (increment 2, optional).** Toolshed clone banner. **Shipped** —
`packages/toolshed/lib/clone-banner.ts` reads the `.cf-clone` marker at
startup and prints the clone's provenance, so a served clone is visible in
the log an operator is already watching rather than only on disk.

**Explicitly not building.**

- Re-keyed clones. See the identity section.
- Production dump automation. See acquisition.
- A rehearsal orchestrator that starts the toolshed, drives the migration, and
  verifies. `start-local-dev.sh --port-offset` already starts an isolated
  server, and the migration driver is pattern-specific — a `topics`-shaped
  driver would not generalize, and generalizing it prematurely is how operator
  tooling turns into a framework nobody trusts.
- Automatic prod detection by heuristic. Explicit path refusal (rail 1) is
  honest; guessing "this looks like production" is not.

**The honest "don't build it" case — updated by the interview.** The prediction
this section originally leaned on was wrong: the `engine-v3/` filename encoding
and the WAL-companion rule cost the July rehearsal nothing, because server-side
`VACUUM INTO` absorbs both — it emits one correctly-named, companion-free file.
The copy mechanics alone would not justify a command. What survived, and
strengthened, is the other half: the verification bookkeeping was re-invented
per run (ad-hoc SQL and Python heredocs, agent-written each time), both
operators describe the setup as "told my agent to make it happen," and the
verb-contract arc repeats this every phase. Per-run agent improvisation is
exactly the silent-divergence surface the manifest closes — two rehearsals
whose fingerprints were computed differently can't be compared, and an
agent-improvised check that quietly measures less than last time looks
identical to a pass. So the scope cut holds with the weight moved: `--verify`,
the manifest, and `churn` *are* the command; the copy wrapper is the smaller
half and can even land second.

## Blessed practice

### When a clone rehearsal is required

Required when updating a **populated** space and any of:

- the compat checker fails, or the update needs
  `--dangerously-allow-incompatible-schema`;
- the update changes a **result** schema that a parent or sibling piece reads
  (the "Topics (0)" failure mode from the 2026-07-10 board outage: old-generation
  results lacking new fields make the *whole array* read empty, silently);
- more than one pattern generation is live in the space;
- the target is a board or collection whose children are separate pieces —
  children and parent migrate separately and can disagree mid-flight.

Not required for additive input fields with defaults, UI-only changes, or work
on a fresh/scratch space.

### Acceptance checklist

Gideon's runbook, made checkable:

1. **Baseline.** `cf space clone … --verify`; record fingerprint, topic/comment/
   link counts, `max(seq)`. `cf inspect churn` shows a quiet window.
2. **Serial batches, children first, board last.** Never parallel; the board's
   result recomputation is what storms. This order inverts when the update
   moves the BOARD's own demand: children-first assumes the children must
   catch up to what the board already requires, so if the new board reads both
   shapes and the old one cannot read the new children, the board goes first.
   Decide it by reading the deployed holder's demand, not its source.
3. **Step and verify each batch.** `--input` for what durably committed,
   `--step` for computed results. An unstepped result read that looks empty is
   not evidence of anything.
4. **Trust no fresh-replica read.** The 2026-07-10 outage record is explicit:
   "every wrong turn in this investigation traces to trusting a fresh-replica
   read." Confirm from the store or from a stepped read, not from a first read
   on a cold client.
5. **≥20 s cold-load patience** before calling a health check failed. A first
   production attempt was rolled back on this false negative.
6. **Post-run.** Counts match; content fingerprint of durable topic content
   unchanged; a cold board read returns every child; a cold index read resolves
   a linked child; churn returns to baseline and *stays* there — a storm is a
   steady state, not a spike.
7. **Rollback manifest.** The pristine snapshot path and the exact reset command,
   written down before the live attempt, not improvised during it.
8. **Two consecutive clean passes** before the live `setsrc`. Reset between
   them.

The live run then repeats 2–6 against production, with the rollback manifest in
hand.

## Interview results (2026-07-27)

The seven questions this doc originally gated on, answered by Wilk (and Gideon,
live) on PR #5009's review threads; paraphrased.

1. **End to end:** server-side `VACUUM INTO`, scp down, S3 upload so other
   operators could fetch the same snapshot, copy into a running toolshed's
   cache dir. Both operators drove the mechanics through their coding agents.
2. **Same-DID**, no accidents noticed — caveated that interaction was mostly
   agent-mediated, so a mis-point could have gone unseen. (Rail 3's argument.)
3. **Reset was a plain `cp`** — no clonefile — and fine at this scale. Attempt
   count unrecorded.
4. **Neither the path encoding nor WAL companions cost time**: the VACUUM
   output was already `<did>.sqlite` with no companions. The build case does
   not rest here (see the scope cut).
5. **Counts and fingerprints were ad-hoc SQL and Python one-liners** written by
   an agent per run — the manifest's job, and the strongest build evidence.
6. **Commit-rate watching:** OTel commit telemetry exists, and [#4950] adds
   deterministic workload counters — neither is retrospective-offline, so
   churn's slot stands, positioned against both.
7. **Nothing lied**, with the links/profile growth watch item recorded under
   fidelity caveats.

## References

- Gideon's migration writeup, 2026-07-25 (Discord).
- Board topics: "Cross-version generated-cell identity collisions cause Topics
  write storms"; "Pattern verb contract…" (Deployment section); "Board outage
  2026-07-10…".
- PRs [#4997] (migration-safe legacy Topics; the rehearsal that caught it),
  [#4916] (generated-cell identity versioning), [#4991] (verb contract WS-A),
  [#4950] (Topics workload diagnostics — churn's live-runtime neighbor).
- The interview: [PR #5009 review threads](https://github.com/commonfabric/labs/pull/5009)
  (Wilk; Gideon confirmed live).
- `docs/history/plans/pattern-verb-contract-implementation.md` — Risks, the
  write-storm gate.
- `docs/development/LOCAL_DEV_SERVERS.md` — toolshed over a store dir, port
  offsets.

[#4916]: https://github.com/commonfabric/labs/pull/4916
[#4950]: https://github.com/commonfabric/labs/pull/4950
[#4991]: https://github.com/commonfabric/labs/pull/4991
