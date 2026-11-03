---
name: pattern-iframe
description: Build a Common Fabric pattern whose primary UI is a self-contained `cf-iframe` guest. Use when an agent should turn an input-data shape and a small state/output contract into a working iframe-first pattern without learning the broader pattern framework, including plain DOM, React, D3, Phaser 2D games, Babylon.js 3D scenes, PerSpace/PerUser/PerSession data, path-scoped Cell access, stable array-item handles, mergeable pushes, bridged SQLite, ephemeral presence such as live cursors, or pattern verbs the guest sends events to through streams, such as a user-triggered `agent()` or LLM request.
---

# Iframe-first patterns

Choose one self-contained authoring contract before writing code. Route by the
primary rendering owner, in this order:

- For a 3D game, world, simulation, or WebGL scene, read
  `docs/common/ai/iframe-pattern-babylon-guide.md` in full.
- For a primarily 2D HTML5 game, read
  `docs/common/ai/iframe-pattern-phaser-guide.md` in full.
- For a data visualization whose DOM or SVG is owned by D3, read
  `docs/common/ai/iframe-pattern-d3-guide.md` in full.
- For a React component tree, hooks, an explicitly requested React guest, or a
  stateful React-only editor, diagram, grid, or canvas library, read
  `docs/common/ai/iframe-pattern-react-guide.md` in full. It owns the boundary
  between durable Fabric data, React drafts, and library-managed interaction
  state.
- Otherwise read `docs/common/ai/iframe-pattern-guide.md` in full for a plain
  DOM guest.

For an explicit hybrid, choose the guide for the framework that owns the DOM or
canvas lifecycle. Load a second guide only when the request genuinely combines
two owners, such as React mounting and unmounting a D3-managed subtree. Do not
load the general pattern-development guides unless the requested behavior
extends beyond one `cf-iframe` and the cells, databases, presence rooms, and
verbs it is handed.

What the guides cannot leave to judgment:

- Put the files under `patterns/<category>/iframe-<name>/`, with the category
  chosen from those `patterns/README.md` lists. The `iframe-` prefix is
  load-bearing: pattern discovery uses it to recognize `guest.ts` and
  `guest.tsx` as browser sources rather than pattern entries, and the root
  `deno.jsonc` excludes `guest.js` from fmt, lint, and the type check by it.
- `main.tsx` is hand-written from the guide's templates. It reads `guest.html`
  and `guest.js` with `dataFile()` and hands `cf-iframe` its cells as one
  `$context={{ ... }}` record. The `$` is what makes them live; a field that is
  a database, a presence room, or a verb is named in `resourceKinds`, since the
  host cannot tell those from a cell on its own.
- `guest.js` is `deno bundle` output and is kept in the tree: `main.tsx` reads
  it as it is, so rebundle after every guest change. A React `guest.tsx` names
  React's JSX factory in pragmas, because the repository's JSX configuration is
  the pattern runtime's.
- When the pattern exposes an action as a verb, prefer having the guest send
  that verb an event over making the same change through its own cell writes.
  The general guide's "Optional streams" section covers this, including LLM
  built-ins.
- One joint initial `pull()` barrier owns readiness for every resource an action
  uses. Keep action controls disabled until it resolves; an individual
  synchronous `sink()` callback must never declare the guest ready.

`patterns/examples/iframe-verb-list/` is the smallest complete example, with a
verb; `patterns/showcase/iframe-signal-atlas/` adds a per-user SQLite database
and per-session output, and `patterns/examples/iframe-cursor-canvas/` a presence
room. `patterns/showcase/iframe-ring-loops/` is the exception, not a template:
its `main.tsx` composes a `frame.tsx` that `scripts/write-iframe-wrapper.ts`
generates, and it has no `guest.js`. Do not copy its shape into a new pattern.

Run the pattern or add a focused test when behavior, rather than only its data
contract, changed. `deno task cf check` proves the pattern compiles, not that
the guest loads or that a bridge write completes.
