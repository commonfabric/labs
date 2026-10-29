# Iframe-first pattern guide

Use this guide to build a Common Fabric pattern whose application lives inside
one sandboxed `cf-iframe`. The pattern is one `main.tsx` you write by hand,
following the templates below: it declares the cells, databases, presence rooms,
and verbs the application uses, and renders a `cf-iframe` that hands them to the
guest by name. The guest is an ordinary browser application in its own files,
bundled with `deno bundle`.

No other pattern guide is required for this shape.

## Source layout

Keep these files together:

```text
patterns/examples/iframe-quick-notes/
├── contract.ts  # types and defaults shared by main.tsx and the guest
├── guest.ts     # the iframe application; guest.tsx is also accepted
├── guest.html   # the guest's document
├── guest.js     # `deno bundle` output of guest.ts; never edited by hand
└── main.tsx     # the pattern: cells, databases, verbs, and the cf-iframe
```

In this repository, the directory's name starts with `iframe-`. That prefix is
what keeps the guest out of the pattern type check, which would compile it
under the pattern runtime's JSX, and what keeps the bundle out of `deno fmt`,
`deno lint` and `deno task check`, which read the guest's source instead.

`main.tsx` reads `guest.html` and `guest.js` with `dataFile()`. Each file
travels with the pattern's code, so deploying the pattern needs no guest module
server and no separate build artifact, and every command that builds the
program from local files attaches both because the source names them.

## Describe the data contract

Create `contract.ts`. It holds only types and defaults, which `main.tsx` and the
guest both import. Three data types are the usual shape:

- `IframeInputData` is supplied when the pattern is instantiated. The guest
  receives it as a read-only Cell.
- `IframeStateData` is durable application state the guest may change.
- `IframeOutputData` is the public result the guest may change and the pattern
  returns to callers.

Keep this module declarative and free of side effects.

```typescript
interface Note {
  id: string;
  text: string;
}

export interface IframeInputData {
  heading: string;
  seedNotes: Note[];
}

export interface IframeStateData {
  notes: Note[];
  selectedId: string | null;
}

export interface IframeOutputData {
  noteCount: number;
  selectedId: string | null;
}

export const DEFAULT_INPUT: IframeInputData = {
  heading: "Quick notes",
  seedNotes: [],
};

export const DEFAULT_STATE: IframeStateData = {
  notes: [],
  selectedId: null,
};

export const DEFAULT_OUTPUT: IframeOutputData = {
  noteCount: 0,
  selectedId: null,
};
```

Declare each default with its interface as the annotation, as above, rather
than `as const`: `main.tsx` types every resource as
`Default<IframeStateData, typeof DEFAULT_STATE>`, so a default that does not
satisfy its interface is a type error at the contract, and an `as const`
default makes array members `readonly`, which a mutable `Note[]` rejects.

## Write the pattern

`main.tsx` for state and output that everyone on the piece shares:

```tsx
// Shown at module scope.
import {
  dataFile,
  type Default,
  NAME,
  pattern,
  UI,
  type VNode,
  Writable,
} from "commonfabric";
import {
  DEFAULT_INPUT,
  DEFAULT_OUTPUT,
  DEFAULT_STATE,
  type IframeInputData,
  type IframeOutputData,
  type IframeStateData,
} from "./contract.ts";

const GUEST_HTML = dataFile("./guest.html");
const GUEST_SCRIPT = dataFile("./guest.js");

export interface QuickNotesInput {
  input?: Default<IframeInputData, typeof DEFAULT_INPUT>;
}

export interface QuickNotesOutput {
  [NAME]: string;
  [UI]: VNode;
  state: IframeStateData;
  output: IframeOutputData;
}

export default pattern<QuickNotesInput, QuickNotesOutput>(({ input }) => {
  const state = new Writable<IframeStateData>(DEFAULT_STATE);
  const output = new Writable<IframeOutputData>(DEFAULT_OUTPUT);

  return {
    [NAME]: "Quick notes",
    [UI]: (
      <div style={{ width: "100%", height: "100vh" }}>
        <cf-iframe
          src={GUEST_HTML}
          script={GUEST_SCRIPT}
          $context={{ input, state, output }}
          resourceKinds={{ input: "readonly" }}
        />
      </div>
    ),
    state,
    output,
  };
});
```

The parts the guest depends on:

- `src` is the guest's document and `script` is its bundle. The sandbox runs the
  script as the document's last module script once the document is parsed, so
  `guest.html` holds the markup and styles and no `<script>` for the guest. A
  Content Security Policy the document declares in a `<meta>` must admit inline
  scripts (`script-src 'unsafe-inline'`), since that is how the bundle arrives;
  a policy that does not leaves the guest blank.
- `$context` binds a record of cells. Each field is a resource the guest asks
  for by name, and each reaches the guest live: the host resolves it to its
  concrete cell before the guest loads, so a `user`-scoped field is this user's
  cell, and a write lands where the cell does. A field can be a cell, a path of
  one (`state.key("notes")`), a database, a presence room's cell, or a verb,
  and nothing else: a record with a field that is not a cell is refused when
  the view is built. Without the `$`, `context` hands the guest a copy of the
  values instead.
- `resourceKinds` says what the guest may do with a field. `readonly` grants
  reads only, which suits `input`: it belongs to whoever instantiated the piece.
  A field the record names with no kind is a cell the guest may write. Give
  every database the kind `sqlite`, every presence room `presence`, and every
  verb `stream`; the host cannot tell them apart from a cell on its own.
- `state` and `output` are returned, so the piece's result carries the guest's
  data to callers and to other patterns.

Callers normally omit `input`, and its `Default` supplies the readable value.
Do not put transient DOM state such as hover or an open tooltip in a Fabric
Cell; keep that inside the guest. State that other people should see while it
happens and nobody needs afterwards, such as a pointer position or a drag in
flight, belongs in a presence room rather than a Cell; see
[Optional presence](#optional-presence).

### Choose a scope for state and output

| Scope | Meaning | Declared as |
| --- | --- | --- |
| `space` | Shared by every user and session in the piece | `new Writable(...)` in the pattern body |
| `user` | Separate for each user, shared by that user's sessions | an optional `PerUser<...>` input |
| `session` | Separate for each browser session | an optional `PerSession<...>` input |

Choose scope independently for state and output. A `space`-scoped cell is
created in the pattern body, as above. A `user`- or `session`-scoped one is an
optional input of the pattern, so the runtime resolves it for the active user or
browser session; callers omit it, and its `Default` supplies the readable
fallback. The guest addresses the resource by the same name whatever its scope.

`main.tsx` with state kept for each browser session and output kept for each
user:

```tsx
// Shown at module scope.
import {
  dataFile,
  type Default,
  NAME,
  pattern,
  type PerSession,
  type PerUser,
  UI,
  type VNode,
  type Writable,
} from "commonfabric";
import {
  DEFAULT_INPUT,
  DEFAULT_OUTPUT,
  DEFAULT_STATE,
  type IframeInputData,
  type IframeOutputData,
  type IframeStateData,
} from "./contract.ts";

const GUEST_HTML = dataFile("./guest.html");
const GUEST_SCRIPT = dataFile("./guest.js");

export interface QuickNotesInput {
  input?: Default<IframeInputData, typeof DEFAULT_INPUT>;
  state?: PerSession<Writable<Default<IframeStateData, typeof DEFAULT_STATE>>>;
  output?: PerUser<Writable<Default<IframeOutputData, typeof DEFAULT_OUTPUT>>>;
}

export interface QuickNotesOutput {
  [NAME]: string;
  [UI]: VNode;
  state: IframeStateData;
  output: IframeOutputData;
}

export default pattern<QuickNotesInput, QuickNotesOutput>(
  ({ input, state, output }) => ({
    [NAME]: "Quick notes",
    [UI]: (
      <div style={{ width: "100%", height: "100vh" }}>
        <cf-iframe
          src={GUEST_HTML}
          script={GUEST_SCRIPT}
          $context={{ input, state, output }}
          resourceKinds={{ input: "readonly" }}
        />
      </div>
    ),
    state,
    output,
  }),
);
```

For state per user, write `PerUser` in its place; for output per session,
`PerSession`. For a `space`-scoped one of the two beside a scoped one, drop it
from the inputs and create it in the body as the first template does.

## Write the guest

The guest is an ordinary browser entry, and `deno bundle` inlines its imports
into one module. Its document is `guest.html`, a complete page holding the
element the guest renders into:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Quick notes</title>
    <style>
    html, body, #root {
      box-sizing: border-box;
      width: 100%;
      height: 100%;
      margin: 0;
    }
    </style>
  </head>
  <body>
    <div id="root"></div>
  </body>
</html>
```

A small DOM guest can start like this:

```typescript
// Shown at module scope.
import { connectFabric } from "@commonfabric/iframe-sandbox/guest";
import { DEFAULT_INPUT, DEFAULT_OUTPUT, DEFAULT_STATE } from "./contract.ts";

const fabric = connectFabric();
const input = fabric.cell<typeof DEFAULT_INPUT>("input");
const state = fabric.cell<typeof DEFAULT_STATE>("state");
const output = fabric.cell<typeof DEFAULT_OUTPUT>("output");

const root = document.querySelector<HTMLDivElement>("#root")!;
const heading = document.createElement("h1");
const add = document.createElement("button");
const error = document.createElement("p");
add.type = "button";
add.textContent = "Add note";
error.role = "alert";
root.append(heading, add, error);

let hydrated = false;
const render = () => {
  heading.textContent = input.get()?.heading ?? "Loading";
  add.disabled = !hydrated;
};
const showError = (cause: unknown) => {
  error.textContent = cause instanceof Error ? cause.message : String(cause);
};

const stops = [input.sink(render), state.sink(render), output.sink(render)];
void (async () => {
  try {
    await Promise.all([input.pull(), state.pull(), output.pull()]);
    await state.initialize(DEFAULT_STATE);
    await output.initialize(DEFAULT_OUTPUT);
    hydrated = true;
    render();
  } catch (cause) {
    showError(cause);
  }
})();

add.addEventListener("click", () => {
  const note = { id: crypto.randomUUID(), text: "New note" };
  void state.key("notes").push(note).then(async () => {
    const current = await state.pull();
    await output.set({
      noteCount: current.notes.length,
      selectedId: current.selectedId,
    });
  }).catch(showError);
});

globalThis.addEventListener("pagehide", () => {
  stops.forEach((stop) => stop());
  fabric.disconnect();
}, { once: true });
```

The guest sandbox does not grant native form submission or page navigation.
Group fields in a `div` or `section`, use `button.type = "button"`, and handle
the button's `click` event. Do not use a `<form>`, a submit button, or
`requestSubmit()` for a bridge operation.

The Cell contract matches the rest of Common Fabric:

- `get()` synchronously samples the guest cache and may be stale or undefined.
- `pull()` demands the host Cell's producers and required loads before reading
  reactive state. It can return while other writes remain unconfirmed.
- `sink(listener)` calls the listener synchronously with `get()`, then calls it
  for later values. Call `pull()` when the first render needs fresh data.
- `key(nameOrIndex)` derives a path-specific handle. Its sink observes that path
  rather than the whole root value.
- `initialize(defaultValue)` atomically stores a first-use default only while
  the Cell has no backing value, then returns the value that won. A schema
  fallback visible through `get()` does not count as stored.
- `set(value)` replaces a value. `update(fn)` queues a read-modify-write against
  other operations on the same remote Cell in this guest; it is not a
  transaction across users, sessions, or resources.
- `push(...values)` sends a mergeable array append and conflicts less than
  reading and replacing the entire array.

### Hydrate before mutation

`sink()` is synchronous by design, so its first callback can render an empty or
stale `get()` sample while `pull()` is still active. Disable controls whose
actions replace data, validate against input, or query a scoped database until
all resources those actions depend on have completed their initial pulls. A
pre-hydration sink may render a fallback; it must not persist that fallback or
run another side effect as though it were authoritative.

Make readiness one aggregate phase owned by the bootstrap pulls. An
individual `sink()` callback must never flip that phase, even when its own value
is already present: state can arrive before input or output, and enabling an
action then would let it validate or write against fallback data. While the
aggregate phase is pending, sinks may update loading UI only. Set the phase once
after the joint `Promise.all(...)` resolves, then render from the complete set.

A newly resolved `user`- or `session`-scoped input can also be `undefined` while
its default is materializing. Pull before the first mutation. If a child write
needs its parent object to exist, call `initialize()` after the
pull, await it, and then use the narrow child operation. Call it even when
`get()` exposes the compiled schema fallback: initialization is idempotent and
materializes that fallback before the child write.
When the cell already has a backing value and none of the documents consumed to
build its returned value have pending writes, initialization can return while
unrelated commits remain pending. Otherwise the runtime adapter keeps the cell
demanded through the runtime-wide commit barrier before choosing a value or
storing the default, including commits and conflict repairs that install its
producer. An unrelated pending commit can therefore delay first-use initialization
and iframe bootstrap.

```typescript
// Shown at module scope.
import { connectFabric } from "@commonfabric/iframe-sandbox/guest";
import { DEFAULT_STATE } from "./contract.ts";

const fabric = connectFabric();
const state = fabric.cell<typeof DEFAULT_STATE>("state");

async function addNote(text: string): Promise<void> {
  await state.pull();
  await state.initialize(DEFAULT_STATE);
  await state.key("notes").push({ id: crypto.randomUUID(), text });
}
```

Do not initialize with `update((current) => current ?? DEFAULT_STATE)`: the
updater starts from this guest's cache, which another session may have made
stale. `initialize()` reads raw backing state and conditionally writes in one
runtime transaction, so concurrent guests return the same winning value
without replacing it. Use `set()` for intentional last-writer-wins replacement,
and use `update()` only when a local queue over an already materialized complete
object is the intended boundary.

Keep editable DOM drafts separate from authoritative Cell samples. While a
local write is pending, a sink rerender should preserve that draft. Once it
settles, later PerUser updates from another session should be adopted. Explicit
`hydrating`, `pending`, and settled states are safer than inferring all three
from a control's current value.

An array index is a position, not an identity. Resolve the item before keeping a
long-lived subscription or write target:

```typescript
// Shown at module scope.
import { connectFabric } from "@commonfabric/iframe-sandbox/guest";
import { DEFAULT_STATE } from "./contract.ts";

const fabric = connectFabric();
const state = fabric.cell<typeof DEFAULT_STATE>("state");
const notes = state.key("notes");
await notes.pull();
const note = await notes.key(0).resolve();
const stop = note.key("text").sink((text) => console.log(text));
await note.key("text").set("Still the same note after a reorder");
```

`resolve()` returns an opaque capability anchored to the entity document. The
guest may inspect its identity metadata, but it cannot turn an arbitrary ID into
authority. `.identity.id` names the stored document; scoped instances share it.
`.identity.instanceId` is an opaque key for the concrete instance: it stays the
same across sessions for one PerUser Cell, differs across users, and differs
for each PerSession Cell. Use `.instanceId` when shared data needs one entry per
scoped instance, and write through the resolved handle.

### Design multi-user writes around one authority

The bridge does not make writes to separate resources atomic. If one fact must
agree across shared state and a scoped output, store that fact in one
authoritative resource and put only its stable key in the other. For example, a
shared ballot map can own the selected option under a PerUser `instanceId`,
while PerUser output publishes only that ballot ID. Mirroring the option in both
Cells creates two independently successful writes that can disagree.

Prefer operations whose conflict domain matches the intent: a child `set()` for
one field, a resolved item handle for one entity, or `push()` for an append.
Mint a fresh stable ID inside each logical append action. Reuse an idempotency ID
only when retrying the exact same payload; an edited retry is a new action and
needs a new ID. Represent UI sentinels outside the user-data domain, such as
`null` or a tagged union instead of a string that a user could also enter.

### React guests

When the application should be a React component tree, use the parallel
[`iframe-pattern-react-guide.md`](./iframe-pattern-react-guide.md) as the one
self-contained authoring contract. It covers guest-owned React dependencies,
TSX compilation, hook readiness, fine-grained direct Cell subscriptions,
stable resolved items, SQLite query hooks, cleanup, and browser verification.
Do not combine the two guest bootstraps.

## Style with the ambient theme

The guest wears the theme of the page around its iframe. The nearest `cf-theme`
above the `cf-iframe` provides it: before the guest's own styles, the guest
receives that theme's `--cf-theme-*` custom properties declared on `:root`,
followed by a base stylesheet written against them:
[`guest-base-sheet.ts`](../../../runtime/ui/src/v2/components/cf-theme/guest-base-sheet.ts).
The guest's root also carries the resolved scheme as `data-color-scheme`
(`light` or `dark`). The sheet styles `html`, `body`, headings, links, buttons,
form fields, code, and rules, and provides these classes:

| Class | What it draws |
| --- | --- |
| `cf-surface` | the raised ground of a panel |
| `cf-card` | a bordered, padded, rounded surface |
| `cf-inset` | a recessed ground, for wells and code |
| `cf-pill` | a small, fully rounded label |
| `cf-muted` | secondary text |
| `cf-primary`, `cf-accent`, `cf-brand` | a solid fill with its ink |
| `cf-success`, `cf-warning`, `cf-danger` | a status fill with its ink |
| `cf-stack`, `cf-row` | a vertical or horizontal flex layout with the theme's gap |

The values follow the page: a theme change, or a switch between light and dark,
restyles a running guest without reloading it. So write guest HTML with those
elements, the `cf-*` classes, and `var(--cf-theme-…)` for anything else, such as
`color: var(--cf-theme-color-text-muted)` or
`font-family: var(--cf-theme-font-mono)`, and spell no color or font of your
own. A literal color or font in the guest stays the same on every page, and
reads wrong on the first one whose theme differs. The base sheet sits in a
cascade layer, so any rule of the guest's own overrides it whatever its
specificity; reserve that for a look the pattern deliberately owns, such as a
game's art.

## Optional SQLite

Create the database in the pattern body with `sqliteDatabase()`, put it in the
`$context` record under the name the guest asks for, and give that name the kind
`sqlite`. The variable's annotation sets its scope: `PerUser<SqliteDb>` keeps one
database for each user, `PerSession<SqliteDb>` one for each browser session, and
no annotation one for the whole piece.

```tsx
// Shown at module scope.
import {
  cfSqlite,
  dataFile,
  type Default,
  NAME,
  pattern,
  type PerUser,
  sqliteDatabase,
  type SqliteDb,
  UI,
  type VNode,
  Writable,
} from "commonfabric";
import {
  DEFAULT_INPUT,
  DEFAULT_OUTPUT,
  DEFAULT_STATE,
  type IframeInputData,
  type IframeOutputData,
  type IframeStateData,
} from "./contract.ts";

const GUEST_HTML = dataFile("./guest.html");
const GUEST_SCRIPT = dataFile("./guest.js");

export interface QuickNotesInput {
  input?: Default<IframeInputData, typeof DEFAULT_INPUT>;
}

export interface QuickNotesOutput {
  [NAME]: string;
  [UI]: VNode;
  state: IframeStateData;
  output: IframeOutputData;
}

export default pattern<QuickNotesInput, QuickNotesOutput>(({ input }) => {
  const state = new Writable<IframeStateData>(DEFAULT_STATE);
  const output = new Writable<IframeOutputData>(DEFAULT_OUTPUT);
  const { table } = cfSqlite;
  const appDatabase: PerUser<SqliteDb> = sqliteDatabase({
    tables: {
      notes: table({
        id: "integer primary key",
        text: "text not null",
      }),
    },
  });

  return {
    [NAME]: "Quick notes",
    [UI]: (
      <div style={{ width: "100%", height: "100vh" }}>
        <cf-iframe
          src={GUEST_HTML}
          script={GUEST_SCRIPT}
          $context={{ input, state, output, appDatabase }}
          resourceKinds={{ input: "readonly", appDatabase: "sqlite" }}
        />
      </div>
    ),
    state,
    output,
  };
});
```

Use it from the guest by the name the record gives it:

```typescript
// Shown at module scope.
import { connectFabric } from "@commonfabric/iframe-sandbox/guest";

const fabric = connectFabric();
const database = fabric.sqlite("appDatabase");
const refreshRows = async () => {
  const { rows } = await database.query<{ id: number; text: string }>(
    "SELECT id, text FROM notes ORDER BY id LIMIT 200",
  );
  return rows;
};
await database.exec(
  "INSERT INTO notes (text) VALUES (?)",
  ["Stored for this user"],
);
const rows = await refreshRows();
const stop = database.sink(() => void refreshRows());
```

SQLite scopes have the same `space`, `user`, and `session` meanings as Cells.
An active query should use `sink()` to refresh after committed writes.
Before the first query or exec, hydrate every input or scoped preference used to
construct the SQL or validate its parameters. Keep the controls disabled until
that joint barrier completes; an early sink callback must not query with
fallback configuration and then persist a correction over real user state.
Table and column names are data rather than TypeScript bindings, and may use
reserved words. When a table or column needs the exact name `__proto__`, write
it as a computed property (`["__proto__"]`) in `main.tsx`, so JavaScript
creates an own property.

## Optional presence

A presence room carries what the people on a piece are doing right now. Nothing
in it is stored: each member holds one record, a display name and a few named
facets, and the record is gone when the member leaves. Use it for pointers,
selections, a drag in flight, or a player's position. Use a Cell for anything
that must be agreed on or must survive.

A room is the room of a cell: add the cell to the `$context` record a second
time, under the room's name, and give that name the kind `presence`. Everyone
who shares the cell shares the room, so a room following `space`-scoped state
gathers every user and session on the piece, and a room following `user`-scoped
output gathers only one user's sessions. The name grants the room and none of
the cell's data.

```tsx
// Shown at module scope.
import {
  dataFile,
  type Default,
  NAME,
  pattern,
  type PerUser,
  UI,
  type VNode,
  Writable,
} from "commonfabric";
import {
  DEFAULT_INPUT,
  DEFAULT_OUTPUT,
  DEFAULT_STATE,
  type IframeInputData,
  type IframeOutputData,
  type IframeStateData,
} from "./contract.ts";

const GUEST_HTML = dataFile("./guest.html");
const GUEST_SCRIPT = dataFile("./guest.js");

export interface CursorCanvasInput {
  input?: Default<IframeInputData, typeof DEFAULT_INPUT>;
  output?: PerUser<Writable<Default<IframeOutputData, typeof DEFAULT_OUTPUT>>>;
}

export interface CursorCanvasOutput {
  [NAME]: string;
  [UI]: VNode;
  state: IframeStateData;
  output: IframeOutputData;
}

export default pattern<CursorCanvasInput, CursorCanvasOutput>(
  ({ input, output }) => {
    const state = new Writable<IframeStateData>(DEFAULT_STATE);

    return {
      [NAME]: "Cursor canvas",
      [UI]: (
        <div style={{ width: "100%", height: "100vh" }}>
          <cf-iframe
            src={GUEST_HTML}
            script={GUEST_SCRIPT}
            $context={{ input, state, output, cursors: state }}
            resourceKinds={{ input: "readonly", cursors: "presence" }}
          />
        </div>
      ),
      state,
      output,
    };
  },
);
```

Join from the guest by listening, and publish your own record:

```typescript
// Shown at module scope.
import { connectFabric } from "@commonfabric/iframe-sandbox/guest";

const fabric = connectFabric();
const cursors = fabric.presence("cursors");
const board = document.querySelector<HTMLDivElement>("#root")!;

const draw = () => {
  for (const participant of cursors.participants) {
    const pointer = participant.facets.pointer;
    if (typeof pointer?.x !== "number" || typeof pointer.y !== "number") {
      continue;
    }
    console.log(participant.name, pointer.x, pointer.y);
  }
};

const leave = cursors.join((event) => {
  if (event.kind === "failure") {
    console.warn(event.error.code);
    return;
  }
  draw();
});

// A publication that cannot land rejects; the room reports why to the
// listener, so the rejection itself needs no handling.
const publish = (publication: Promise<void>) => publication.catch(() => {});

publish(cursors.setName("Ada"));
board.addEventListener("pointermove", (event) => {
  publish(cursors.setFacet("pointer", { x: event.offsetX, y: event.offsetY }));
});
board.addEventListener("pointerleave", () => {
  publish(cursors.clearFacet("pointer"));
});

globalThis.addEventListener("pagehide", leave, { once: true });
```

The rules that shape a guest:

- The room publishes nothing for a member with no name, so call `setName()`
  before expecting peers to see you. The guest picks the name; a `user`-scoped
  output field is a reasonable place to keep one.
- `participants` holds every other member, never the guest itself. A
  `participantId` names a membership, not a person: it changes on reconnect,
  and two windows of one user are two participants.
- A room holds latest state, not a stream. Each `setFacet()` replaces the
  facet, and the host sends one publication per animation frame, so peers see
  where a pointer is and not every place it was. A page that is not being
  drawn, such as a background tab, publishes nothing until it is shown.
- A facet is whatever another guest wrote. Check the type of every field
  before using it, as the example does, and ignore a facet that does not fit.
- A record holds at most eight facets and 8 KiB, and a facet's name starts
  with a lowercase letter, continues with lowercase letters, digits, and
  hyphens, and is at most 32 characters long. A publication outside those
  bounds ends the room with a `presence-refused` failure.
- A `failure` ends the room, and a new membership starts empty.
  `presence-unsupported` means the host has no relay, and joining again will
  not help. `presence-refused` means the relay refused the join or a
  publication, and its message says which bound: correct what was published
  before joining again, or the same publication ends the new room too, and a
  full room may admit the guest later. After `presence-disconnected`, call
  `join()` again when the user next acts and publish the name and facets as
  they were.
- Presence does not wait for the hydration barrier. Join at startup, and set
  the name once the Cell that holds it has been pulled.

A shape dragged across a shared board shows the division of labor. While the
pointer is down, publish the shape's position as a facet and draw peers' facets
over the stored positions. On release, write the position to the Cell, and
clear the facet only after that write and a `pull()` have settled, so peers do
not see the shape return to where it was in between.
`patterns/examples/iframe-cursor-canvas/` is a complete example.

## Optional streams

A stream lets the guest send an event to one of the pattern's verbs, a handler
that runs in the pattern rather than in the iframe. Use one when the change
belongs to the pattern: data the pattern owns and checks, an operation other
callers reach through the same verb, or work that only the pattern can start.

When the pattern exposes an action as a verb, have the guest perform that
action by sending the verb an event wherever it can, rather than making the
same change through its own cell writes. One handler then decides what the
action does, whether a person clicks in the frame or `cf piece call`, another
pattern, or an agent sends it, and a change to the action's checks or effects
reaches every caller at once. This is a preference, not a requirement: a direct
write stays correct for an action the pattern exposes no verb for, and for one
whose verb does not fit the interaction.

Work that only the pattern can start is how a guest calls `agent()`,
`generateText()`, `generateObject()`, and the other LLM built-ins in a
user-triggered way. Each built-in is a reactive node in the pattern body, which
the guest cannot call, and it makes a new request whenever its inputs change. A
verb makes the user's action the trigger: the guest sends the event when the
user clicks, the handler writes the task or prompt the built-in reads, and the
result reaches the guest through a read-only resource. Writing the prompt from
the guest's own `state` would also start a request, but on every change to it,
such as each keystroke in a prompt field.

Declare the verb with `action()` in the pattern body, return it as part of the
result so other callers reach it, and put it in the `$context` record with the
kind `stream`. The verb binds to `state` like any handler. In this list, the
items belong to the verb: the guest is granted `state.items` to read and
`state.checked` to write, so it can only ask for an item, and a caller with no
browser, such as `cf piece call`, sends the same verb.

```tsx
// Shown at module scope.
import {
  action,
  dataFile,
  NAME,
  pattern,
  type Stream,
  UI,
  type VNode,
  Writable,
} from "commonfabric";
import {
  type AddItemEvent,
  DEFAULT_OUTPUT,
  DEFAULT_STATE,
  type IframeOutputData,
  type IframeStateData,
  type ListItem,
} from "./contract.ts";

const GUEST_HTML = dataFile("./guest.html");
const GUEST_SCRIPT = dataFile("./guest.js");

export interface VerbListOutput {
  [NAME]: string;
  [UI]: VNode;
  state: IframeStateData;
  output: IframeOutputData;
  addItem: Stream<AddItemEvent>;
}

export default pattern<Record<string, never>, VerbListOutput>(() => {
  const state = new Writable<IframeStateData>(DEFAULT_STATE);
  const output = new Writable<IframeOutputData>(DEFAULT_OUTPUT);
  const addItem = action(({ id, text }: AddItemEvent) => {
    const trimmed = text.trim();
    if (trimmed === "") throw new Error("An item needs text.");
    const items = state.key("items");
    if (items.get().some((item: ListItem) => item.id === id)) return;
    items.push({ id, text: trimmed });
  });

  return {
    [NAME]: "Verb list",
    [UI]: (
      <div style={{ width: "100%", height: "100vh" }}>
        <cf-iframe
          src={GUEST_HTML}
          script={GUEST_SCRIPT}
          $context={{
            items: state.key("items"),
            checked: state.key("checked"),
            output,
            addItem,
          }}
          resourceKinds={{ items: "readonly", addItem: "stream" }}
        />
      </div>
    ),
    state,
    output,
    addItem,
  };
});
```

The guest sends through `fabric.stream(name)`, from the handler of the user's
action, so an event goes out only when someone acts and never on a load or
reload of the frame:

```typescript
// Shown at module scope.
import { connectFabric } from "@commonfabric/iframe-sandbox/guest";
import { type AddItemEvent } from "./contract.ts";

const fabric = connectFabric();
const addItem = fabric.stream<AddItemEvent>("addItem");
const add = document.querySelector<HTMLButtonElement>("#add")!;
const field = document.querySelector<HTMLInputElement>("#new-item")!;

add.addEventListener("click", () => {
  const text = field.value.trim();
  void addItem.send({ id: crypto.randomUUID(), text }).then(() => {
    if (field.value.trim() === text) field.value = "";
  }).catch((cause) => console.warn(cause));
});
```

`send()` goes out once every cell operation the guest made before it has
settled, so the handler reads what they wrote. It resolves once the handler's
run has committed, with no value: a verb's declared result does not reach the
guest, so read the effect through the resources it changed. It rejects with the
reason when the runtime refuses the event or the run, including an error the
handler throws, so show that message where the user acted. The guest's sink can
deliver the change before `send()` resolves, so keep the draft that produced the
event until the send settles. The event is not a trusted gesture: the guest's
code sent it, not a control the host draws, so a write gated on a reviewed
action refuses it.

For an LLM call, the verb writes what the built-in reads, and read-only
resources carry the built-in's state back. An empty task or prompt makes no
request, so nothing runs before the first event. `agent()` identifies a request
by its task text and the addresses of its inputs, not by the values they hold,
and answers a request it has seen from its record, so the verb counts each ask
into the task: asking the same question again is then a new request.

```tsx
// Shown at module scope.
import {
  action,
  agent,
  computed,
  dataFile,
  NAME,
  pattern,
  UI,
  Writable,
} from "commonfabric";

const GUEST_HTML = dataFile("./guest.html");
const GUEST_SCRIPT = dataFile("./guest.js");

export default pattern(() => {
  const request = new Writable<{ question: string; asked: number }>({
    question: "",
    asked: 0,
  });
  const ask = action(({ text }: { text: string }) => {
    request.set({ question: text.trim(), asked: request.get().asked + 1 });
  });
  const task = computed(() => {
    const { question, asked } = request.get();
    return question === "" ? "" : `Question ${asked}: ${question}`;
  });
  const answer = agent<{ answer: string }>({
    task,
    inputs: {},
    resultSchema: {
      type: "object",
      properties: { answer: { type: "string" } },
      required: ["answer"],
    },
  });

  return {
    [NAME]: "Ask",
    [UI]: (
      <div style={{ width: "100%", height: "100vh" }}>
        <cf-iframe
          src={GUEST_HTML}
          script={GUEST_SCRIPT}
          $context={{ pending: answer.pending, answer: answer.result, ask }}
          resourceKinds={{
            pending: "readonly",
            answer: "readonly",
            ask: "stream",
          }}
        />
      </div>
    ),
    ask,
  };
});
```

A built-in that already returns a stream needs no verb of its own:
`llmDialog()` returns `addMessage`, which goes in the `$context` record as it
is, with the kind `stream`.

`patterns/examples/iframe-verb-list/` is a complete example.

## Bundle the guest

From the pattern's directory, write the guest's bundle:

```bash
deno bundle --platform browser --minify guest.ts -o guest.js
```

For a `guest.tsx`, name it in place of `guest.ts` here and in the `deno check`
below. Run it again after every change to the guest or to anything it imports, and
keep `guest.js` with the change: `main.tsx` reads the file as it is, so a stale
bundle runs the guest as it was. `deno bundle` inlines the guest's imports,
`@commonfabric/iframe-sandbox/guest` and pinned `npm:` modules among them, into
the one module the sandbox runs.

A `guest.tsx` names React's JSX factory in pragmas at its top, because the JSX
settings `deno bundle` reads from the repository's configuration are the
pattern runtime's, and without the pragmas the bundle draws in that runtime
instead of React:

```tsx
// Shown for illustration only.
/** @jsxRuntime classic */
/** @jsx React.createElement */
/** @jsxFrag React.Fragment */
// deno-lint-ignore no-external-import
import React from "npm:react@19.2.8";
```

## Verify

Format and compile the result:

```bash
deno fmt patterns/examples/iframe-quick-notes
deno check patterns/examples/iframe-quick-notes/guest.ts
deno task cf check patterns/examples/iframe-quick-notes/main.tsx --no-run
```

If the pattern is intentionally outside the repository, pass its directory as
`--root`; otherwise the CLI uses the repository as its source boundary.

Launch a repository pattern against local servers from the repository root.
Start the servers first:

```bash
./scripts/start-local-dev.sh
```

The script serves on ports 8000 and 5173 and fails when either is taken, which
is the usual case when another checkout has servers running. Start it with
`--port-offset=<n>` then. Continue only once it reports that both servers
started, and use the `Toolshed:` address it prints,
`http://localhost:<8000 + n>`, as `CF_API_URL` below: a `cf` command pointed at
port 8000 would deploy to the other checkout's server.
[`LOCAL_DEV_SERVERS.md`](../../development/LOCAL_DEV_SERVERS.md) covers the
scripts.

Then mint a key, create a space, and create the piece in it:

```bash
mkdir -p .cf
test -e .cf/iframe-pattern.key || \
  deno task cf id new > .cf/iframe-pattern.key
# The Toolshed address that start-local-dev.sh printed.
export CF_API_URL=http://localhost:8000
export CF_IDENTITY=.cf/iframe-pattern.key
export CF_SPACE="$(deno task cf space create --label "Iframe quick notes")"
deno task cf piece new patterns/examples/iframe-quick-notes/main.tsx \
  --root . --slug quick-notes
```

Never overwrite an existing key file: doing so selects a different PerUser
identity. `cf piece new` does not create the space it names, so
`cf space create` runs first. It prints the new space's DID, which `CF_SPACE`
and `--space` accept. Run both commands once: each `cf space create` makes
another space, and a second `cf piece new` leaves the slug with the first
piece. `cf piece new` prints the page address under `Open in browser`, which is
`$CF_API_URL/$CF_SPACE/quick-notes`. It also prints the `cf piece setsrc`
command that updates the piece after a source change.

Open the page address. A browser that has not signed in is shown the shell's
login. Sign it in with the key the CLI used: choose **Register**, which a
browser that has signed in before labels **Register New Key**, then
**Import CLI Key**, and select `.cf/iframe-pattern.key`. The browser then acts
as the identity that created the space, the only one the space admits, and `cf`
commands read the PerUser values the page wrote.
[`shared-identity.md`](../../features/shared-identity.md) covers that workflow.

**Use Passphrase** on the same screen, followed by generating and confirming a
passphrase, registers a new identity instead, and the space refuses it: the
shell reports `Slug "quick-notes" not found.`, and the console carries
`AuthorizationError: Principal did:key:… lacks READ on space did:key:…`.
Take that route only when the tool driving the browser cannot choose a file, or
for the second identity the multi-user checks below need. The principal the
error names is the browser's DID, which
`globalThis.app.state().identity.did()` also returns in the page's console.
Grant it access with the CLI key, in a shell that has the three exports above,
then reload the page:

```bash
deno task cf acl set <browser DID> WRITE
```

Exercise the meaningful action and check the browser console; compilation alone
does not prove that the guest loaded or that a bridge write completed.

Then run the pattern and exercise its meaningful interaction. Check that input
renders, state survives at its declared scope, output changes only when the
guest intends, and any SQLite data has the declared isolation. A pattern that
compiles but never loads the guest is not complete, and neither is one whose
`guest.js` predates its guest's last change.

For multi-user behavior, cover two sessions of one identity, a second identity,
and a reload. The second identity opens the piece only after the `cf acl set`
grant above. PerSpace data must agree everywhere; PerUser data must agree only
between the first identity's sessions; PerSession data must remain distinct.
Exercise first use while scoped defaults and SQLite handles materialize, not
only a warmed-up piece. When the pattern or bridge must support both execution
modes, run the same unskipped browser test in the default suite and with
`EXPERIMENTAL_SERVER_EXECUTION=true`; separate tests can drift into testing two
different products.
