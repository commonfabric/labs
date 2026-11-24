# Patterns

End-user programs ("patterns") for the Common Fabric runtime, plus the component
catalog and the system patterns that ship with the product.

## Layout

Each pattern is a directory inside a directory for its category. A pattern's
_key_ is the path of one of its files inside this directory, such as
`apps/topics/main.tsx`. The server serves that file at `/api/patterns/<key>`.

The categories are listed below in the order that dependencies run between them.
A pattern imports only from its own category or an earlier one, and
`deno task check-dependency-direction` fails on a production import that runs
the other way.

- `system/` holds what the runtime itself knows about, and what is core to how
  Common Fabric works. That is the patterns the runtime starts by name (Home,
  the default app, profiles, the private inbox, and suggestions), the patterns
  those are built from, such as FabriChat, Loom, notes, and FabriFile (a space's
  set of named files), and the libraries that patterns share, such as the
  helpers for writing information-flow policies (`system/cfc/`).
- `product/` holds parts of the product that the runtime does not start by name,
  such as the lobby, collection naming, and the primitives published to the
  pattern index.
- `apps/` holds apps that people use but that the platform does not depend on,
  such as Topics and Lunch Poll, and the workbenches built on Topics.
- `examples/` holds patterns that each demonstrate one capability or idiom. They
  include the exemplars that `index.md` recommends imitating, and demonstrations
  of the information-flow rules that Contextual Flow Control (CFC) enforces.
- `showcase/` holds larger demonstrations, such as games.
- `dev/` holds patterns used to develop the platform: test fixtures, regression
  tests, experiments, personal variants of system patterns, and the component
  catalog.

Three directories are not categories. `baselines/` holds a recorded description
of each pattern's inputs and outputs, which a check compares each new version
against. `integration/` holds the browser tests. `tools/` holds scripts and test
helpers.

Stored data can name a pattern by the key it had before the patterns were sorted
into categories, such as `system:topics/main.tsx`. The runtime maps each such
key to the pattern's current key, using the table in
`runtime/runner/src/pattern-key-moves.ts`.

This README is intentionally just a signpost. The maintained references are:

- **[index.md](./index.md)** — the canonical pattern catalog: every pattern with
  a summary, data types, and keywords. Start with its **Status tiers** section,
  which says whether a given pattern is an _exemplar_ (imitate it), a _demo_
  (illustrates one capability; wiring may be intentionally verbose), a _fixture_
  (regression scaffolding; never imitate), or _legacy_ (do not copy).
- **[dev/catalog/catalog.tsx](./dev/catalog/catalog.tsx)** — the authoritative,
  type-checked UI component catalog; live usage in
  [dev/catalog/stories/](./dev/catalog/stories/). Narrative component docs live
  in
  [docs/common/components/COMPONENTS.md](../docs/common/components/COMPONENTS.md).
- **[DEPRECATED_IDIOMS.md](./DEPRECATED_IDIOMS.md)** — API-level migrations (old
  idiom → current idiom).
- **[skills/pattern-dev](../skills/pattern-dev/SKILL.md)** — the workflow guide
  for authoring patterns; broader pattern documentation is indexed from
  [docs/common/README.md](../docs/common/README.md).

A previous version of this file was a hand-maintained duplicate of the catalog;
it drifted badly. Add new catalog entries to `index.md` only (and give them a
status tier).
