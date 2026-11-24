---
status: historical
created: 2026-10-13
archived: 2026-10-13
reason: "Automatic system-origin update rehearsal and Cubic review corrections for Home interface PR #8820."
---

# Home interface automatic roll-forward

The Home draft at `814f8eddb8` had a passing explicit source-update test and
green CI. This rehearsal extends the test through the ordinary
`PiecesController.ensureDefaultPattern()` path, which follows Home's
`system:system/home.tsx` origin before starting its root.

## Method

A localhost HTTP server uses the production `PatternsRoute` for both source
bytes and closure identities. Its first release serves the frozen Home entry
from `676e4cae1b`, with the current production dependencies. A new route instance
then serves the candidate Home, modeling replacement of the release's source
cache. The runtime fetches, compiles, and verifies the advertised identity; the
test never installs the candidate directly in its automatic cases.

Loopback storage is populated with a schema-valid direct room and policy, a
refused request including its reason, a direct counterpart and room reference,
a queued notice, favorites, a journal entry, navigation, and a catalog entry
with an offer receipt. Storage remains alive while client runtimes close and
reopen. This is a representative populated test Home, not a copy of a production
account or a production toolshed deployment.

Three cases run independently:

- An explicit source update, retaining the existing guard.
- An automatic origin update while the original Home runtime is running.
- An automatic origin update on the first cold Home open after the original
  runtime has been disposed.

Every case opens the updated Home again in another fresh runtime. Automatic
cases use the normal Home-open path for that reopen as well.

## Results

All three cases passed. The Home root retains its identity, its pattern advances
to the candidate, and automatic cases keep their system origin. The new
collection view runs over the retained catalog. Requests, direct records,
favorites, journal, navigation, catalog entries, and receipts retain their
stored values and addresses across the update and fresh open.

The notice argument retains its raw value and address through the update. A
subsequent normal Home open can materialize its array behind a cell reference
and rebase the element links. Comparing that representation byte-for-byte
would report a failure despite retained data. The test additionally reads each
queued notice's ID, recipient, and resolved room link and confirms they survive
the fresh open unchanged.

This measures client-side automatic origin reconciliation with real HTTP source
serving and retained loopback storage. It does not measure a serving executor
rolling the Home forward or a production release.

## Review corrections

Cubic's missing-kind lookup finding reproduced in an authored assertion:
`byKind["toString"]` returned an inherited function. The grouping result now has
a null prototype. Tests cover absent inherited names and real groups named
`__proto__` and `constructor`, alongside existing collection partitions and
session isolation.

The Home child-panel comment describes retained relative positions. Catalog
sorting is explicitly presentation-only; admission hints establish no conflict
precedence or authoritative chronology. The history synopsis distinguishes the
invalid seed from actual code-change loss, the supersession metadata points to
the live catalog contract, and the access plan separates the Home browser's
grouped view from FabriChat's flat manager contract.

## Validation

- The three-mode rehearsal passed under Deno's resource-leak tracing.
- Focused integration passed six suites and 12 steps, including the automatic
  cases, Home command boundaries with serving off/on, observation-schema drift,
  and four public/private manager send cases. Thirty unrelated catalog steps
  were explicitly skipped.
- All Home-system authored entries passed 252 assertions under strict CFC with
  persisted labels. The published dictionary projection also passed its
  absent-kind checks.
- The patterns package passed 60 suites and 409 steps plus its browser test.
  Workspace formatting, lint, types, 637 documentation blocks, history indexing,
  and Home/collection compatibility passed.
