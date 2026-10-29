# The CFC circuit: an interactive system map

[`cfc-system-map.html`](cfc-system-map.html) is a self-contained, pannable map
of the harness and the runtime around it, drawn to answer three questions for a
colleague seeing the system for the first time: what we are building, where we
have to trust ourselves, and where the threats lie and how the CFC circuit gets
closed. Open the file in any browser; it has no remote dependencies.

## What it draws

Four horizontal bands, ordered by trust: **Outside** (the model provider, the
web, third-party skills and APIs: never trusted), **Agent execution** (the
harness, its children and its sandbox: mediated), the **Trusted computing base**
(cf-service, the runner as CFC kernel, spaces, policy, connectors, the pattern
index: where we trust ourselves), and **Evidence** (run artifacts and the audit
checker: how we check ourselves). A person and an operator sit in the margin as
principals. Data flows left to right.

On top of the bands sit two layers whose colors carry status and nothing else
does:

- **Gates** are diamonds on the edges where a value may cross a boundary. Their
  fill is their status: solid green shipped, solid amber partial, hollow red a
  gap, dashed gray intended.
- **Threats** are red-ringed hexagons, numbered, in three kinds: amber for a
  vector a named piece of planned work closes, green for one CFC holds today,
  gray with a person glyph for one CFC cannot close and people and process hold.

Line kinds distinguish opaque handles (dashed light blue, the "route what you
never hold" idea), model-visible bytes, labeled values inside the base,
untrusted content in or requests out, control, and evidence.

Clicking any node, edge, gate or threat opens its story in the side panel: role,
trust class, what landed (with pull-request links), the threats that live there,
and what it takes to close the circuit. Five guided walks (the circuit, the
three demos, and the trusted base ring by ring) dim everything but the current
step and zoom to it. Edge labels and gate captions hide at overview and appear
as you zoom, so the structure reads before the detail.

## What it claims, and where each claim comes from

The map is a snapshot: the date and the labs commit it describes are stamped in
the top-left corner of the canvas and named in the welcome panel. Every sentence
on it was checked against three sources, in this order of authority:

1. Code: `runtime/cf-harness/src` (the tools, the prompt loop, the handle table,
   the sandbox mediation), `runtime/cf-harness/console`,
   `runtime/cf-harness/audit`, and `runtime/runner/src/cfc`.
2. Live documents: the package [README](../../README.md),
   [CURRENT_STATE.md](../CURRENT_STATE.md), the "Known deviations" list in
   [IMPLEMENTATION_PROFILE.md](../IMPLEMENTATION_PROFILE.md), the CFC section of
   [EXPERIMENTAL_OPTIONS.md](../../../../docs/development/EXPERIMENTAL_OPTIONS.md),
   and the specifications under
   [`docs/specs/`](../../../../docs/specs/README.md), the enforcement matrix and
   the agent-harness contracts among them.
3. Issues: the boundary inventory posted on CT-2175 is what the gate statuses
   were derived from; the three demo issues (CT-2190, CT-2189, CT-2091) are what
   the walks follow. Claims about loom's connectors come from CT-2189 and are
   not verified against loom's code, which this repository does not hold; the
   map says so where it makes them.

## Updating it

The map is hand-authored, not generated: every position is a coordinate in the
file, chosen so that no edge crosses a node and no label lands on another. That
is what makes it legible, and it is also why an update is an edit rather than a
rebuild. All of the content lives in data tables at the top of the script, and
none of the drawing code needs to change to alter what the map says.

- `nodes`, `edges`, `groups`, `bands`: what is drawn and where. An edge is an
  explicit polyline; a gate is placed at a fraction along its edge.
- `gateDefs`: each gate's title, status (`shipped`, `partial`, `gap`,
  `intended`), one-line status caption, and the boundary it sits on.
- `threats` and `threatClass`: each threat's position and class (`guarded`,
  `upcoming`, `residual`).
- `D`, `GD`, `TD`, `ED`: the side-panel copy for nodes, gates, threats and
  edges. A `close` list is what it takes to close the circuit at that element; a
  `links` list names the pull requests that landed; a threat's `plan` names the
  work that closes it.
- `stories`: the walks, each a list of steps naming the elements to focus and
  the caption to show.

When the system changes in a way the map describes, edit the table that holds
the claim, set `SNAPSHOT` (the date and the labs commit the map now describes;
it is stamped in the canvas's top-left corner and named in the welcome text),
and re-verify in a browser. The two reviews that shaped the current version are
the procedure for a larger revision, and both are worth running as subagents
with the file and the sources above in hand:

- An **accuracy review**: for every gate status, threat class and sentence of
  copy, find the code or document that makes it true today, and report anything
  wrong, stale, overstated or unverifiable with a citation. The boundary
  inventory on CT-2175 is the natural checklist for gates; the deviations list
  is the checklist for what the harness does not yet do. Check in particular
  anything that merged after those two were written.
- A **visual review**: render the map at a typical presentation size and list
  every collision, every edge that passes through a node, every parallel run too
  close to separate, and every label unreadable at fit zoom; then judge whether
  status color still lives only on gates and threats.

One boundary is described in words rather than drawn: the read ceiling a run
carries (`--max-confidentiality` / `cfc.maxConfidentiality`) is told in the
value-release gate's copy, because it is a second read boundary and the map has
one release diamond. Giving it a diamond of its own is a geometry change, so it
waits for a redraw rather than an edit.

Regenerating the review screenshots takes a local static server, since browsers
block `file:` navigation from automation:

```sh
cd runtime/cf-harness/docs/system-map && python3 -m http.server 8765 --bind 127.0.0.1
```

## Relation to the other documents here

The map is a reading aid, not a source of truth. Where it and
[IMPLEMENTATION_PROFILE.md](../IMPLEMENTATION_PROFILE.md) or the code disagree,
the map is what is out of date, and the fix is the update procedure above.
