# React iframe-first pattern guide

Use this guide to build a Common Fabric pattern whose application is a React
tree inside one sandboxed `cf-iframe`. The wrapper remains mechanical: it
exposes named Cell and SQLite resources, bundles the React guest and all of its
dependencies into one HTML string, and returns durable state and output through
the normal pattern result.

This guide is self-contained. Do not also load the plain-DOM iframe guide unless
you are migrating an existing guest and need to compare the two source styles.

## Source layout

Keep these authored files beside the generated wrapper:

```text
packages/patterns/iframe-react-quick-notes/
├── contract.ts  # input, durable state, output, scopes, optional databases
├── guest.tsx    # React application and Fabric bridge client
├── guest.html   # optional document shell
├── editor/
│   └── guest.ts  # optional browser-only helper; see below
└── main.tsx     # generated wrapper; do not hand-edit
```

The generated `main.tsx` contains React, React DOM, the guest bridge, and the
application. It does not need a module server at runtime. Keep `contract.ts` and
`guest.tsx` so an agent can regenerate the wrapper.

React is owned by the guest bundle. The iframe sandbox adapter accepts the
exact React instance the guest imports; `@commonfabric/iframe-sandbox` does not
select a React version for applications.

Pattern discovery treats an ordinary non-test `.ts` or `.tsx` file under an
`iframe-*` pattern as another pattern entry. Keep browser-only code in the root
`guest.tsx`, or give an extracted browser helper the basename `guest.ts` or
`guest.tsx`, as in `editor/guest.ts` above. Import that helper from the root
guest so the wrapper includes it in the bundle; the basename prevents pattern
discovery from separately asking the pattern compiler to evaluate its React or
browser-only dependencies.

## Describe input, state, and output

Create `contract.ts` as a declarative module with no side effects:

```typescript
interface Note {
  id: string;
  text: string;
}

export interface IframeInputData {
  heading: string;
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
};

export const DEFAULT_STATE: IframeStateData = {
  notes: [],
  selectedId: null,
};

export const DEFAULT_OUTPUT: IframeOutputData = {
  noteCount: 0,
  selectedId: null,
};

export const IFRAME_PATTERN = {
  name: "ReactQuickNotes",
  displayName: "React quick notes",
  stateScope: "user",
  outputScope: "session",
  frameHeight: "100vh",
  databases: {},
} as const;
```

The wrapper exposes three resources with these roles:

- `input` is read-only data supplied by the caller.
- `state` is durable application state the guest may change.
- `output` is the public result the guest may change and the wrapper returns.

The scopes are independent:

| Scope | Meaning |
| --- | --- |
| `space` | Shared by every user and session in the piece |
| `user` | Separate for each user and shared by that user's sessions |
| `session` | Separate for each browser session |

Keep React-only UI state such as hover, an open menu, an unfinished text field,
or animation state in React. Put data in a Fabric Cell only when it should be
durable or visible outside this component tree.

## Import React and create the adapter

Pin the React and type packages in the guest source. The file-level JSX pragmas
make the guest compile independently of the Common Fabric JSX configuration
used by generated `main.tsx`:

```tsx
// Shown at module scope.
/** @jsxRuntime classic */
/** @jsx React.createElement */
// @deno-types="npm:@types/react@19.2.18"
import React from "npm:react@19.2.8";
// @deno-types="npm:@types/react-dom@19.2.5/client.d.ts"
import { createRoot } from "npm:react-dom@19.2.8/client";
import { connectFabric } from "@commonfabric/iframe-sandbox/guest";
import { createFabricReact } from "@commonfabric/iframe-sandbox/react";

const fabric = connectFabric();
const { useCell, useSqliteQuery } = createFabricReact(React, fabric);

function App() {
  const heading = useCell<{ heading: string } | undefined>("input");
  if (heading.status === "error") return <p role="alert">{heading.error.message}</p>;
  if (heading.status !== "ready") return <p>Loading</p>;
  return <h1>{(heading.value ?? { heading: "Notes" }).heading}</h1>;
}

const root = createRoot(document.querySelector<HTMLDivElement>("#root")!);
root.render(<App />);

globalThis.addEventListener("pagehide", () => {
  root.unmount();
  fabric.disconnect();
}, { once: true });
```

Pass the same imported `React` object to `createFabricReact` that creates the
tree. Do not import a second React copy for the bridge adapter. Use
`createRoot`; do not use the removed legacy `render` entry point.

The default generated document contains `<div id="root"></div>`. Supply a
custom `guest.html` only when the guest needs document-level metadata, fonts,
or sibling elements outside the React root.

## Read and write Cells with hooks

`useCell<T>(name)` returns one of three snapshots:

- `{ status: "loading" }` while the initial pull is active;
- `{ status: "ready", value }` after the host pull completes;
- `{ status: "error", error }` when the resource cannot be read.

It also returns `initialize(defaultValue)`, `set(valueOrUpdater)`, and
`refresh()`. `initialize()` atomically stores the default only while the Cell
has no backing value and returns the value selected by that transaction. A
readable schema fallback does not count as stored. `refresh()` is the explicit
host `Cell.pull()` boundary. The hook subscribes through `useSyncExternalStore`,
so host updates rerender the component. The runtime pull demands producers and
required loads; readiness does not confirm unrelated pending writes.

`ready` means the pull completed; a newly scoped or optional Cell can therefore
be ready with the value `undefined`. Include `undefined` in the hook type. Use
the declared input default for an absent read-only input. For writable state or
output, initialize only after that Cell's pull completes. Call
`initialize()` once even when the compiled schema fallback is already visible:
the idempotent operation materializes the backing value without replacing a
value another session won.
Bridge `set()` reports commit failure, but its write remains an intentional
last-writer-wins replacement.

Treat readiness as one aggregate phase. Every resource an action reads must be
ready before that action becomes available:

```tsx
// Shown at module scope.
/** @jsxRuntime classic */
/** @jsx React.createElement */
// @deno-types="npm:@types/react@19.2.18"
import React from "npm:react@19.2.8";
import { connectFabric } from "@commonfabric/iframe-sandbox/guest";
import { createFabricReact } from "@commonfabric/iframe-sandbox/react";
import {
  DEFAULT_INPUT,
  DEFAULT_OUTPUT,
  DEFAULT_STATE,
} from "./contract.ts";

const fabric = connectFabric();
const { useCell } = createFabricReact(React, fabric);
const stateCell = fabric.cell<typeof DEFAULT_STATE>("state");

function Editor() {
  const input = useCell<typeof DEFAULT_INPUT | undefined>("input");
  const state = useCell<typeof DEFAULT_STATE | undefined>("state");
  const output = useCell<typeof DEFAULT_OUTPUT | undefined>("output");
  const stateValue = state.status === "ready" ? state.value : undefined;
  const outputValue = output.status === "ready" ? output.value : undefined;
  const actionTail = React.useRef(Promise.resolve());
  const [pending, setPending] = React.useState(false);
  const [materialized, setMaterialized] = React.useState(false);
  const [initializationError, setInitializationError] = React.useState<Error>();
  const [actionError, setActionError] = React.useState<Error>();
  React.useEffect(() => {
    if (
      input.status !== "ready" || state.status !== "ready" ||
      output.status !== "ready"
    ) {
      return;
    }
    let active = true;
    void Promise.all([
      state.initialize(DEFAULT_STATE),
      output.initialize(DEFAULT_OUTPUT),
    ]).then(() => {
      if (active) setMaterialized(true);
    }).catch((cause) => {
      if (active) {
        setInitializationError(
          cause instanceof Error ? cause : new Error(String(cause)),
        );
      }
    });
    return () => {
      active = false;
    };
  }, [
    input.status,
    state.status,
    output.status,
    state.initialize,
    output.initialize,
  ]);
  const resources = [input, state, output];
  const failure = resources.find((resource) => resource.status === "error");

  if (failure?.status === "error") {
    return <p role="alert">{failure.error.message}</p>;
  }
  if (initializationError) {
    return <p role="alert">{initializationError.message}</p>;
  }
  if (
    input.status !== "ready" || state.status !== "ready" ||
    stateValue === undefined || output.status !== "ready" || !materialized ||
    outputValue === undefined
  ) {
    return <button type="button" disabled>Loading</button>;
  }

  const runAction = (action: () => Promise<void>): Promise<void> => {
    const next = actionTail.current.then(async () => {
      setPending(true);
      setActionError(undefined);
      try {
        await action();
      } catch (cause) {
        setActionError(
          cause instanceof Error ? cause : new Error(String(cause)),
        );
      } finally {
        setPending(false);
      }
    });
    actionTail.current = next;
    return next;
  };
  const addNote = () =>
    runAction(async () => {
      const note = { id: crypto.randomUUID(), text: "New note" };
      await stateCell.key("notes").push(note);
      await stateCell.key("selectedId").set(note.id);
      const current = (await state.refresh()) ?? DEFAULT_STATE;
      await output.set({
        noteCount: current.notes.length,
        selectedId: current.selectedId,
      });
    });

  return (
    <section>
      <h1>{(input.value ?? DEFAULT_INPUT).heading}</h1>
      <p>{stateValue.notes.length} notes</p>
      <button
        type="button"
        disabled={pending}
        onClick={() => void addNote()}
      >
        Add note
      </button>
      {actionError && <p role="alert">{actionError.message}</p>}
    </section>
  );
}
```

The hooks load Cells independently, but the component owns one joint readiness
predicate. An individual resource becoming ready must not enable an action that
still reads fallback input, state, or output. The materialization phase keeps
actions disabled until both writable initializers settle, and renders an
initialization rejection. Action rejections use the same visible error region,
and the ref-backed tail keeps rapid actions serialized across rerenders.

Functional setters are serialized for the same remote Cell inside one guest.
They are not a transaction across users or across resources. Prefer a narrow
operation when the intent permits it. The direct client remains available next
to the hooks:

```typescript
// Shown at module scope.
import { connectFabric } from "@commonfabric/iframe-sandbox/guest";

const fabric = connectFabric();
const state = fabric.cell<{ notes: Array<{ id: string; text: string }> }>(
  "state",
);

async function appendNote(text: string): Promise<void> {
  await state.key("notes").push({ id: crypto.randomUUID(), text });
}
```

`push()` is a mergeable append. Replacing the whole array from a React setter
has a wider conflict domain.

## Give every state layer one owner

Fabric updates can rerender a React tree at any time, including while a pointer
gesture, native popup, text edit, animation, or third-party component update is
in progress. Divide state by the lifecycle that owns it:

| State | Owner | Examples |
| --- | --- | --- |
| Durable collaborative data | Fabric Cell or SQLite | records, committed positions, shared edges |
| Local user intent not yet committed | React state or refs | a text draft, open menu, active drag, pending selection |
| Third-party interaction state | The library's local component state | `dragging`, measured bounds, viewport, focus, selection handles |
| Pure presentation | Derived during render | labels, colors, filtered rows |

Fabric is authoritative for durable values, but it is not a frame-by-frame
controller for a stateful React library. If a diagram, grid, editor, or canvas
emits change objects, keep its working value in a dedicated child component and
apply changes with the library's own reducer. Commit only at a semantic
boundary such as drag stop, edit confirmation, or row commit. Persisting every
pointer move adds worker traffic and lets authoritative rerenders interrupt the
gesture.

Reconcile the local library value in `useLayoutEffect` only when its
authoritative projection changes. Memoize that projection from the durable
snapshot so an unrelated parent render does not manufacture a new dependency.
During reconciliation, merge new durable data by stable ID while preserving:

- the library's transient fields, such as `dragging`, measured dimensions, and
  viewport state;
- the active local draft for the item being edited;
- a pending local selection until its write succeeds and the matching
  authoritative sink update arrives.

Do not replace the library value with a fresh Fabric projection on every
render. That turns each pointer event or Cell acknowledgement into a visual
remount: native popups close, focus moves, selections flash, and dragged items
snap between local and durable positions. Keep component types, React keys, and
the library root stable for the same reason. The full loading view belongs only
to initial hydration; an ordinary mutation must not remount the application.

### Reconcile asynchronous gestures by identity

Serialized writes still complete later than the browser gesture that created
them. Track each draft with a monotonically increasing token, not only its
value. Two different drags can end at the same coordinates, and an older
completion must not clear the newer draft merely because their values compare
equal.

On completion, settle only the matching token. A successful write can retain
the draft until the same value arrives through the authoritative subscription.
A failed current write can roll back to the latest authoritative value; a
failed older write must not move or clear a newer gesture. Apply the same rule
to selection and other optimistic UI. Repeated requests for the same pending
selection should share that request's eventual result rather than reporting an
early success.

Capture event-owned values synchronously. If an action instead derives a new
value from shared state, pull that value when the serialized action begins, not
when it is enqueued. This keeps two rapid updater actions from deriving the same
replacement from one stale render.

### Scope pending state to the affected interaction

A single global `pending` flag makes a narrow worker round trip look like a
page refresh. Use the smallest pending boundary that matches the operation:

- global pending for an action that genuinely changes the whole application;
- per-item pending for a parameter or row edit;
- no global visual lock for quiet persistence such as a drag position or
  personal selection.

The application may keep one serializer for ordering while exposing these
different pending indicators. Preserve the latest visible error until the user
acts on it; a later queued success must not erase an earlier rejection before
it can be read.

### Isolate controls embedded in interactive components

Interactive libraries often treat any descendant pointer or click as a canvas,
row, or node gesture. A native `select`, text field, or button inside that
surface therefore needs both the library's gesture opt-out and a React event
boundary. For React Flow, use `nodrag nopan` and stop the bubbling click at one
ancestor:

```tsx
// Shown at module scope.
/** @jsxRuntime classic */
/** @jsx React.createElement */
// @deno-types="npm:@types/react@19.2.18"
import React from "npm:react@19.2.8";

function NodeControls({ children }: React.PropsWithChildren) {
  return React.createElement(
    "div",
    {
      className: "nodrag nopan",
      onClick: (event: React.MouseEvent<HTMLDivElement>) =>
        event.stopPropagation(),
    },
    children,
  );
}
```

Use the equivalent gesture opt-out for another library. Keep editable control
values in local React drafts while focused, and adopt authoritative values only
when that local edit is settled. A Cell rerender must not close the popup or
replace the text under the user's cursor.

### Include the library's structural CSS

The generated wrapper bundles JavaScript imports, but a React library can also
depend on stylesheet rules that give its viewport, measurement wrappers,
overlays, portals, and controls their geometry. Theme colors alone are not
enough. Put the required structural rules in `guest.html` so the document stays
self-contained under the iframe CSP. Give `html`, `body`, `#root`, and every
intermediate layout container an explicit height, and give custom measured
items a stable width or size when the library expects one.

Exercise built-in layout actions such as fit-to-view and inspect the rendered
bounds. A component that mounts without an exception can still be unusable when
its measurement layer is zero-sized or an overlay is positioned outside the
viewport.

## Fine-grained paths and stable array items

The React adapter intentionally covers named root resources. Use the direct
Cell API in a custom hook when a component should observe one path rather than
rerender for the entire root. `sink()` calls its listener synchronously with the
current cached sample, then again for later values; call `pull()` when the
component requires current data before mutation.

An array index is a position rather than an identity. `resolve()` gives a stable
handle only when that value is backed by a stored entity document. Do not assume
that a seeded inline object is such an entity: resolving an inline value can
produce a detached value capability rather than the durable array address.

When the contract guarantees entity-backed items, resolve the item and keep the
host-minted handle in the effect:

```tsx
/** @jsxRuntime classic */
/** @jsx React.createElement */
// @deno-types="npm:@types/react@19.2.18"
import React from "npm:react@19.2.8";
import { connectFabric } from "@commonfabric/iframe-sandbox/guest";

const fabric = connectFabric();

function FirstNoteTitle() {
  const [title, setTitle] = React.useState<string>();
  const [error, setError] = React.useState<Error>();

  React.useEffect(() => {
    let stop: (() => void) | undefined;
    let active = true;
    void fabric.cell<Array<{ title: string }>>("notes").key(0).resolve()
      .then(async (note) => {
        if (!active) return;
        const titleCell = note.key("title");
        await titleCell.pull();
        if (!active) return;
        stop = titleCell.sink((value) => setTitle(value));
      })
      .catch((cause) => {
        if (active) setError(cause instanceof Error ? cause : new Error(String(cause)));
      });
    return () => {
      active = false;
      stop?.();
    };
  }, []);

  if (error) return <p role="alert">{error.message}</p>;
  return <p>{title ?? "Loading"}</p>;
}
```

The resolved capability stays anchored to the stored entity if array positions
move. Its `.identity.id` names the entity document. Its
`.identity.instanceId` names the concrete scoped instance and is stable across
sessions for one PerUser Cell, different across users, and different for every
PerSession Cell. The guest cannot turn an arbitrary ID into authority; writes
go through the resolved handle.

For inline objects in an append-only array, use an application-level stable ID.
Pull the array when the queued action begins, locate the current index by ID,
derive the path handle, pull it, and recheck its ID before the narrow write. This
is safe only while existing entries never reorder or disappear. If entries can
move or be deleted, store them as independently addressable entities or use a
record keyed by stable ID instead of retaining an array path.

## Add SQLite without querying before hydration

Declare databases in `IFRAME_PATTERN`:

```typescript
export const IFRAME_PATTERN = {
  name: "ReactQuickNotes",
  displayName: "React quick notes",
  stateScope: "user",
  outputScope: "session",
  databases: {
    appDatabase: {
      scope: "user",
      tables: {
        notes: {
          id: "integer primary key",
          text: "text not null",
        },
      },
    },
  },
} as const;
```

Mount the query component only after every Cell used to construct or authorize
the query is ready. This preserves the Rules of Hooks while preventing an early
query from using fallback configuration:

```tsx
/** @jsxRuntime classic */
/** @jsx React.createElement */
// @deno-types="npm:@types/react@19.2.18"
import React from "npm:react@19.2.8";
import { connectFabric } from "@commonfabric/iframe-sandbox/guest";
import { createFabricReact } from "@commonfabric/iframe-sandbox/react";

const fabric = connectFabric();
const database = fabric.sqlite("appDatabase");
const { useCell, useSqliteQuery } = createFabricReact(React, fabric);

function Notes({ heading }: { heading: string }) {
  const query = useSqliteQuery<{ id: number; text: string }>(
    "appDatabase",
    "SELECT id, text FROM notes ORDER BY id LIMIT 200",
  );
  if (query.status === "error") return <p role="alert">{query.error.message}</p>;
  if (query.status !== "ready") return <p>Loading notes</p>;

  const add = async () => {
    await database.exec(
      "INSERT INTO notes (text) VALUES (?)",
      [`${heading} ${query.rows.length + 1}`],
    );
  };

  return (
    <section>
      <button type="button" onClick={() => void add()}>Add stored note</button>
      <ul>{query.rows.map((note) => <li key={note.id}>{note.text}</li>)}</ul>
    </section>
  );
}

function App() {
  const input = useCell<{ heading: string }>("input");
  const state = useCell<{ selectedId: string | null }>("state");
  if (input.status !== "ready" || state.status !== "ready") {
    return <p>Loading application</p>;
  }
  return <Notes heading={input.value.heading} />;
}
```

`useSqliteQuery()` begins in `loading`, returns typed rows in `ready`, reports
query failures in `error`, and exposes `refresh()`. It subscribes to database
invalidations, so committed `exec()` calls refresh active queries. Do not put a
query hook behind a conditional inside one component; put it in a child that is
mounted after the readiness boundary.

SQLite scopes have the same meanings as Cell scopes. Database, table, and
column names are data. For the exact name `__proto__` in `contract.ts`, use a
computed property (`["__proto__"]`) so JavaScript creates an own property.

## Preserve user drafts and report failures

An authoritative sink or hook rerender can arrive while the user edits a text
field. Keep the draft in `useState`; copy authoritative data into it only when
there is no pending local edit. Disable the action while its write is pending,
and surface rejected writes. Do not clear the draft before a successful write.
Use a form-level edit generation when several fields form one submission: a
change to any field means an older completion owns none of the new draft.

Use `button type="button"` for every bridge action. The sandbox does not grant
native form submission or navigation, so do not wrap bridge controls in a
`form`, use a submit button, or call `requestSubmit()`.

If one fact must agree across shared state and scoped output, store the fact in
one authoritative resource and store only its stable key in the other. Separate
Cell writes are not atomic. Mint a new ID for a genuinely edited retry; reuse an
idempotency ID only for the same payload.

## Generate the wrapper

Run the helper from the repository root with `--react`. That flag compiles TSX
through the `React` instance imported by `guest.tsx`; without it, repository JSX
settings target the Common Fabric host runtime instead.

```bash
deno run -A tools/write-iframe-wrapper.ts \
  --contract packages/patterns/iframe-react-quick-notes/contract.ts \
  --guest packages/patterns/iframe-react-quick-notes/guest.tsx \
  --out packages/patterns/iframe-react-quick-notes/main.tsx \
  --react
```

The helper refuses to overwrite a file. Add `--force` only when regenerating
that named output. For a custom document, add `--html .../guest.html`; the HTML
must contain `<!-- PATTERN_IFRAME_SCRIPT -->` exactly once.

## Verify in the browser

Format and compile both realms:

```bash
deno fmt packages/patterns/iframe-react-quick-notes
deno check packages/patterns/iframe-react-quick-notes/guest.tsx
deno task cf check packages/patterns/iframe-react-quick-notes/main.tsx --no-run
```

Launch against local servers:

```bash
./scripts/start-local-dev.sh
mkdir -p .cf
test -e .cf/iframe-pattern.key || \
deno task cf id new > .cf/iframe-pattern.key
CF_API_URL=http://localhost:8000 \
CF_IDENTITY=.cf/iframe-pattern.key \
deno task cf piece new packages/patterns/iframe-react-quick-notes/main.tsx \
  --root . --space iframe-react-notes --slug react-notes
```

Never overwrite an existing key file because it selects the PerUser identity.
Open `http://localhost:8000/iframe-react-notes/react-notes`. If the shell shows
first-use login, choose **Register New Key**, enter and confirm a passphrase, and
continue. Exercise every meaningful action and inspect the browser console. A
successful bundle does not prove React mounted, a hook completed its pull, or a
bridge write reached the worker.

Verify at least these behaviors:

- the initial loading view becomes the authoritative input/state view;
- hook-driven Cell writes rerender and survive reload at their declared scope;
- a SQLite mutation causes the active query to rerender;
- a rejected write or query renders an error rather than silently clearing a
  draft;
- a high-frequency third-party interaction stays mounted across several
  painted frames and persists only at its commit boundary;
- native controls embedded in an interactive node or row keep focus and do not
  trigger the parent library's selection or drag behavior;
- a narrow mutation does not return the whole application to loading or disable
  unrelated controls;
- cleanup disconnects the bridge when the iframe document is replaced.

Put deterministic reconciliation, gesture-token, and write-ordering logic in
plain modules and cover the failure and out-of-order cases with Deno tests. If
you test a hook boundary with a small injected harness, model React dependency
arrays with `Object.is`; a harness that runs every layout effect on every render
cannot detect accidental reconciliation during local state updates.

Use a real browser test for DOM event propagation, native controls, focus, and
third-party lifecycle behavior. Exercise the rendered descendant and make the
parent handler change observable state so the assertion would fail without the
event boundary. Run `*.browser.test.ts` through the package's browser task and
exclude it from plain Deno discovery; a DOM guard that turns the same file into
a no-op unit test is false coverage. Prefer this focused component boundary
when the regression does not require the running shell. Reserve a full pattern
integration test for behavior that genuinely crosses the wrapper, runtime,
scope, or reload boundary. Do not add an application-specific `postMessage`
command or snapshot backdoor only to automate the guest.

A source-token assertion can guard that a tested helper remains wired into the
guest, but it is not behavioral proof on its own. Keep it insensitive to
formatting and attribute order, and pair it with the unit or browser test that
executes the behavior.

Wait for rendered state or an explicit completion event. Do not use sleeps to
make gestures line up with worker acknowledgements. A final Computer Use pass
should drag through multiple visible frames, operate every embedded native
control, and confirm that the browser console stays clean.

For multi-user state, cover two sessions of one identity, a second identity,
and a reload. PerSpace data agrees everywhere, PerUser data agrees only between
the same identity's sessions, and PerSession data remains distinct. Exercise
first use rather than only a warmed-up piece. When both runtime modes matter,
run the same unskipped browser test with default execution and with
`EXPERIMENTAL_SERVER_EXECUTION=true`.
