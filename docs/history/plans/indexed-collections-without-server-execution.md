---
status: historical
created: 2026-11-24
archived: 2026-11-24
reason: "Executed plan; toolshed's IndexedCollectionHost keeps indexed collections current with server execution off."
superseded-by: docs/features/indexed-collections.md
---

# Indexed collections without server execution

An [indexed collection](../../features/indexed-collections.md) keeps its tables
current through a maintainer that hears every committed write to its space and
re-reads the members that write could have changed. This plan has the toolshed
run that maintainer, once per process, while server execution
(`EXPERIMENTAL_SERVER_EXECUTION`) is off. Under server execution the serving
runtime of each space maintains its collections, and nothing here changes
that.

The whole arrangement exists only while server execution can be turned off.
Once it cannot, the host, its toolshed wiring and the service-principal entry
described below are deleted together.

## The problem

With server execution off, none of toolshed's runtimes maintains indexed
collections (its one runtime runs webhook deliveries), so every client runtime
maintains the collections it touches. Each one hears only the
commits to documents it has loaded, never reads the space's registry of
collections, and maintains nothing once it closes. Two clients with the same
piece open both re-read the same members, and a write made while no client is
open is never carried into the tables.

## Design

### One maintenance runtime in toolshed

`IndexedCollectionHost` in `runtime/runner/src/builtins/indexed-collection/`
holds one runtime whose only work is maintenance. Toolshed starts the host
when server execution is off. The runtime is an ordinary client of the
co-hosted memory server over in-process loopback sessions, signed by the
toolshed's identity, with server execution off. It starts no piece, so the
member fields it reads are the stored ones, which is what the feature already
specifies: the mirror follows stored state.

The host hears every admitted commit from the memory server's
`watchAdmittedCommits()`. It hands the written document ids to the runtime's
maintainer only for a space that holds a collection, which it learns without
a runtime:

- a commit that writes the space's registry document marks the space;
- for any other space, the host reads the registry document once, directly
  from the engine, and keeps the answer, since a registry only grows.

The runtime is constructed on the first commit to a space that holds a
collection. A toolshed whose spaces hold none therefore pays a map lookup and
a scan of the written ids per commit, plus one engine read per space per
process, and builds no runtime.

### Authority

The maintenance runtime reads member documents and writes collection
databases in the users' spaces. While server execution is off, toolshed lists
its own identity among the memory server's service principals
(`serviceDids`), which holds implicit OWNER on every space. Its commits then
go through ordinary session admission, the CFC envelope admission and the
database attachment included.

That is the trust of committing straight through the co-hosted engine, which
is how the serving host writes leases. A direct engine commit is not used
because a runtime has no path that commits an ordinary transaction to the
engine: the serving runtime's path is the wave sink, which also reconciles the
runtime's own view of what it wrote. The service-principal entry reaches the
same trust with no new commit path.

Toolshed runs at most one process per store while server execution is off, so
one host maintains each space once.

### Clients stop maintaining

`RuntimeOptions.indexedCollectionMaintenance` says which collections a runtime
keeps current:

- `"listed"`: every collection the registries of the spaces it hears of list,
  as well as those it declares or writes. The serving posture and the
  maintenance host.
- `"own"`: those it declares or writes. A single-process runtime over
  emulated storage, such as `cf test` and the runner's unit tests, which has
  no server to maintain for it.
- `"none"`: no collection. A client under server execution, and the presets
  for runtimes that talk to a deployed toolshed (`productionServer`,
  `remoteClient`, `browserWorker`).

Unset, a runtime in the serving posture maintains `"listed"`, a runtime under
server execution `"none"`, and any other `"own"`.

### Listing a collection

The server-side runtime learns of a collection only from its space's registry.
`add()` writes the collection's registry entry in its own transaction when the
entry is missing, so a collection is listed by the commit that gives it its
first member, whichever runtime ran the handler. The maintainer no longer
lists a collection from an event of its own.

### Members a handler creates

A member's dependencies always include its own document. A handler that
creates a piece and adds it writes the piece's documents in the same commit,
so the commit feed carries that document's id and the server re-reads the
member as it does after any write. A runtime that maintains in process keeps
its post-commit re-read of an added member as well.

## Stages

- [x] The runtime option, its preset classification, and the maintainer's use
      of it.
- [x] `add()` lists the collection; the maintainer's listing event is gone.
- [x] `IndexedCollectionHost`, with a test of a client that runs with server
      execution off and maintains nothing while the host maintains, against a
      memory server that enforces its access lists.
- [x] Toolshed starts and stops the host with server execution off, and lists
      its identity as a service principal.
- [x] `docs/features/indexed-collections.md` describes the posture.
- [x] A local toolshed started with `EXPERIMENTAL_SERVER_EXECUTION=false`, with
      its memory server enforcing access lists, carries topics that `cf`
      adds to the example `patterns/examples/indexed-topics/`, and a rename
      `cf` makes later, into the collection's database.
- [x] The same toolshed keeps the example's listing current, with topics that
      `cf` adds and renames, in two browser tabs, in a tab reopened after it
      was closed during those writes, and in a tab opened after a write made
      with no tab open.

## Limits

- The maintenance runtime keeps a session, and the replicas of the members it
  re-read, for each space that holds a collection and that it has heard a
  commit to, for as long as the process runs.
- What a drain owes is held in memory. A write that lands while the toolshed
  is down, or that a drain had not carried out when it stopped, is carried in
  only once one of the documents the member's rows were read from is written
  again, as under server execution.
- A client that talks to a toolshed without the host, an older build, keeps
  nothing current.
