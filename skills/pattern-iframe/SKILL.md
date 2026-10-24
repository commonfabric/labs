---
name: pattern-iframe
description: Build or generate a Common Fabric pattern whose primary UI is a self-contained `cf-iframe` guest. Use when an agent should turn an input-data shape and a small state/output contract into a working iframe-first pattern without learning the broader pattern framework, including plain DOM, React, D3, Phaser 2D games, Babylon.js 3D scenes, PerSpace/PerUser/PerSession data, path-scoped Cell access, stable array-item handles, mergeable pushes, bridged SQLite, ephemeral presence such as live cursors, or pattern verbs the guest sends events to through streams, such as a user-triggered `agent()` or LLM request.
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
extends beyond the generated wrapper.

Keep the authored surface small:

- Put the files under `packages/patterns/iframe-<name>/`. The `iframe-` prefix
  is load-bearing: pattern discovery uses it to recognize `guest.ts` and
  `guest.tsx` as browser sources rather than additional pattern entries.
- `contract.ts` names the input, durable state, and output data shapes and their
  defaults.
- `guest.ts` or `guest.tsx` owns the application. It may use plain DOM code or
  React and the guest bridge.
- `main.tsx` is generated glue. Do not hand-edit it.
- A contract that declares `streams` makes each one a required input of the
  wrapper, so pass `--out .../frame.tsx` to the command below instead, and write
  `main.tsx` by hand to declare the verbs and pass them in; `cf check` on
  `main.tsx` then checks both. When the pattern exposes an action as a verb,
  prefer having the guest send that verb an event over making the same change
  through its own cell writes. The general guide's "Optional streams" section
  covers this, including LLM built-ins.
- One joint initial `pull()` barrier owns readiness for every resource an action
  uses. Keep action controls disabled until it resolves; an individual
  synchronous `sink()` callback must never declare the guest ready.

Generate the wrapper with:

```bash
deno run -A tools/write-iframe-wrapper.ts \
  --contract packages/patterns/iframe-<name>/contract.ts \
  --guest packages/patterns/iframe-<name>/guest.ts \
  --out packages/patterns/iframe-<name>/main.tsx
```

Add `--react` when the authored guest is React TSX, as required by the React
guide. For a contract that declares `streams`, the output is `frame.tsx`.

Add `--html packages/patterns/iframe-<name>/guest.html` when the guest needs a
custom document shell, and `--force` only when regenerating the named output.
The HTML shell must contain `<!-- PATTERN_IFRAME_SCRIPT -->` exactly once.

Validate the generated pattern with:

```bash
deno fmt packages/patterns/iframe-<name>
deno check packages/patterns/iframe-<name>/<guest-file>
deno task cf check packages/patterns/iframe-<name>/main.tsx --no-run
```

Replace `<guest-file>` with the authored `guest.ts` or `guest.tsx` filename.

Run the pattern or add a focused test when behavior, rather than only its data
contract, changed. Preserve `contract.ts` and the guest source beside the
generated wrapper so the pattern remains reproducible.
