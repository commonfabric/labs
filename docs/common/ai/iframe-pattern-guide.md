# Iframe-first pattern guide

Use this guide to build a Common Fabric pattern whose application lives inside
one sandboxed `cf-iframe`. The wrapper is deliberately mechanical: it exposes
three named Cell resources (`input`, `state`, and `output`), optionally exposes
SQLite databases, embeds the guest and its dependencies into one HTML string,
and returns the state and output through the normal pattern result.

No other pattern guide is required for this shape.

## Source layout

Keep these files together:

```text
packages/patterns/quick-notes/
├── contract.ts  # input, durable state, output, scopes, optional databases
├── guest.ts     # the iframe application; guest.tsx is also accepted
├── guest.html   # optional custom document shell
└── main.tsx     # generated wrapper; do not hand-edit
```

The generated `main.tsx` contains the bundled guest. Deploying the pattern does
not require a guest module server or a second build artifact. Keep the source
guest and contract beside it so regeneration remains possible.

## Describe the data contract

Create `contract.ts`. The three data types are intentionally explicit:

- `IframeInputData` is supplied when the pattern is instantiated. The guest
  receives it as a read-only Cell.
- `IframeStateData` is durable application state the guest may change.
- `IframeOutputData` is the public result the guest may change and the wrapper
  returns to callers.

Keep this module declarative and free of side effects. The wrapper helper
imports it to read the defaults and `IFRAME_PATTERN` configuration.

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

export const IFRAME_PATTERN = {
  name: "QuickNotes",
  displayName: "Quick notes",
  stateScope: "space",
  outputScope: "space",
  frameHeight: "100vh",
  databases: {},
} as const;
```

Declare each default with its interface as the annotation, as above, rather
than `as const`: the wrapper types every resource as
`Default<IframeStateData, typeof DEFAULT_STATE>`, so a default that does not
satisfy its interface is a type error at the contract, and an `as const`
default makes array members `readonly`, which a mutable `Note[]` rejects.

`name` is a TypeScript identifier used for the generated interfaces. The three
available scopes are:

| Scope | Meaning |
| --- | --- |
| `space` | Shared by every user and session in the piece |
| `user` | Separate for each user, shared by that user's sessions |
| `session` | Separate for each browser session |

Choose scope independently for state and output. Do not put transient DOM state
such as hover or an open tooltip in a Fabric Cell; keep that inside the guest.

The generated wrapper owns `space`-scoped state and output inside the piece. It
declares `user`- and `session`-scoped state or output as optional scoped pattern
inputs, so the runtime resolves them for the active user or browser session.
Callers normally omit those inputs. Their `Default` supplies the readable
schema fallback; the guest materializes each writable value after pulling it.
This distinction stays in the wrapper; the guest always addresses the same
`state` and `output` resources by name.

## Write the guest

The guest is an ordinary browser entry. The wrapper bundles it, including its
imports, into the iframe document. A small DOM guest can start like this:

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
When the cell already has a backing value and none of the documents its answer
reads have pending writes, initialization can return while unrelated commits
remain pending. Otherwise the runtime adapter keeps the cell demanded through
the runtime-wide commit barrier before choosing a value or storing the default,
including commits and conflict repairs that install its producer. An unrelated
pending commit can therefore delay first-use initialization and iframe bootstrap.

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

## Optional SQLite

Declare database tables in `IFRAME_PATTERN`. The wrapper creates the database,
adds it to the iframe context, and marks it as a SQLite resource:

```typescript
export const IFRAME_PATTERN = {
  name: "QuickNotes",
  displayName: "Quick notes",
  stateScope: "session",
  outputScope: "space",
  frameHeight: "100vh",
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

Use it from the guest by its declared name:

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
Database resource names, table names, and column names are data rather than
generated TypeScript bindings. They may use reserved words. When the exact name
`__proto__` is required in `contract.ts`, write it as a computed property
(`["__proto__"]`) so JavaScript creates an own property.

## Generate the wrapper

Run the checked-in helper from the repository root:

```bash
deno run -A tools/write-iframe-wrapper.ts \
  --contract packages/patterns/quick-notes/contract.ts \
  --guest packages/patterns/quick-notes/guest.ts \
  --out packages/patterns/quick-notes/main.tsx
```

The helper refuses to overwrite a file. Pass `--force` when regenerating the
same `main.tsx` after changing the contract or guest. Regenerating with an
unchanged contract and guest does not change the compiled schema. Whether a
deployed piece accepts the result through `cf piece setsrc` depends on the
schema it was deployed with: a piece whose schema carried no defaults (one
deployed before the generator read imported defaults) is refused, since the
defaults now present would change what its stored values mean; start a new
piece for it.

For a custom HTML shell, put `<!-- PATTERN_IFRAME_SCRIPT -->` exactly once where
the bundled module should run, then add `--html .../guest.html`. Without it, the
helper supplies a complete document with `<div id="root"></div>`.

## Verify

Format and compile the result:

```bash
deno fmt packages/patterns/quick-notes
deno check packages/patterns/quick-notes/guest.ts
deno task cf check packages/patterns/quick-notes/main.tsx --no-run
```

If the pattern is intentionally outside the repository, pass its directory as
`--root`; otherwise the CLI uses the repository as its source boundary.

Launch a repository pattern against local servers from the repository root:

```bash
./scripts/start-local-dev.sh
mkdir -p .cf
test -e .cf/iframe-pattern.key || \
  deno task cf id new > .cf/iframe-pattern.key
CF_API_URL=http://localhost:8000 \
CF_IDENTITY=.cf/iframe-pattern.key \
deno task cf piece new packages/patterns/quick-notes/main.tsx \
  --root . --space iframe-quick-notes --slug quick-notes
```

Never overwrite an existing key file: doing so selects a different PerUser
identity. Open `http://localhost:8000/iframe-quick-notes/quick-notes`. If the
shell shows its first-use login, register a new key and complete the passphrase
confirmation. Exercise the meaningful action and check the browser console;
compilation alone does not prove that the guest loaded or that a bridge write
completed.

Then run the pattern and exercise its meaningful interaction. Check that input
renders, state survives at its declared scope, output changes only when the
guest intends, and any SQLite data has the declared isolation. A generated
wrapper that compiles but never loads the guest is not complete.

For multi-user behavior, cover two sessions of one identity, a second identity,
and a reload. PerSpace data must agree everywhere; PerUser data must agree only
between the first identity's sessions; PerSession data must remain distinct.
Exercise first use while scoped defaults and SQLite handles materialize, not
only a warmed-up piece. When the pattern or bridge must support both execution
modes, run the same unskipped browser test in the default suite and with
`EXPERIMENTAL_SERVER_EXECUTION=true`; separate tests can drift into testing two
different products.
