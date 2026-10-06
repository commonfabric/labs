# Fabric iframe bridge

`@commonfabric/iframe-sandbox` runs guest HTML in a double-iframe sandbox and
connects it to an explicit set of host capabilities. The host describes named
resources; the guest discovers and uses only those resources.

> [!CAUTION]
> This remains experimental sandboxing. Review the security considerations below
> before exposing sensitive data or accepting third-party guest code.

## Host API

Give each element its own bridge. There is no process-global handler and no
ambient access to host state.

```ts
import {
  createFabricBridge,
  type FabricBridge,
} from "@commonfabric/iframe-sandbox";

let count = 0;
const listeners = new Set<(value: number) => void>();

const bridge: FabricBridge = createFabricBridge({
  count: {
    kind: "cell",
    schema: { type: "number", description: "Shared counter" },
    cell: {
      get: () => count,
      pull: () => count,
      set: (value) => {
        count = value as number;
        for (const listener of listeners) listener(count);
      },
      sink: (listener) => {
        listener(count);
        listeners.add(listener as (value: number) => void);
        return () => listeners.delete(listener as (value: number) => void);
      },
    },
  },
});

const frame = document.createElement("common-iframe-sandbox");
frame.bridge = bridge;
frame.src = "<main id='root'></main>";
```

A resource has a `kind`, optional schema and description, and only the
operations the host supplies. A cell capability follows the runtime's Cell
shape: `get()`, `pull()`, optional `initialize()`, `set()`, and `push()`,
`sink()`, `key()`, and `resolve()`. The capability's `push(values)` takes the
members to append as one list, like the runtime's `Cell.pushAll()`, so a list of
any length reaches it intact. `initialize(defaultValue)` atomically stores the
default only while the cell has no backing value and returns the value that won.
A readable schema fallback does not count as stored, so calling `initialize()`
after `pull()` safely materializes it before a child write. The resource kinds
are `cell`, `stream`, `sqlite`, and `service`. Named methods let an application
expose a narrow service without expanding the cell protocol.

The higher-level `cf-iframe` component accepts the same `bridge` property. Its
`context` convenience property turns top-level Fabric cells into cell resources,
read-only cells into resources without `set`, stream cells into `send`
resources, and SQLite database cells into `query`/`exec` resources. A pattern
can supply a serializable capability hint when a context cell's schema is
intentionally opaque at the renderer boundary:

```tsx
<cf-iframe
  src={guestHtml}
  $context={context}
  resourceKinds={{ appDatabase: "sqlite" }}
/>;
```

`resourceKinds` is a narrow manifest of `cell`, `readonly`, `stream`, or
`sqlite` kinds. It does not grant access to another cell: each name must still
be present in the bound context, and the bridge resolves that cell's concrete
scope before the guest loads.

## Guest API

The guest connects once and receives a Cell-shaped client. Remote operations
return promises; calls made before the document receives its `MessagePort`
remain queued in order.

```ts
import { connectFabric } from "@commonfabric/iframe-sandbox/guest";

const fabric = connectFabric();
const manifest = await fabric.describe();
console.log(manifest.resources);

const count = fabric.cell<number>("count");
console.log(count.get()); // Immediate cache sample; it may be stale.
console.log(await count.pull()); // Fully updated after the host Cell.pull().
await count.initialize(0); // Atomic first-use default; returns the winner.
await count.set(1);

const stop = count.sink((value) => {
  console.log(value);
});

// When the application unmounts:
stop();
fabric.disconnect();
```

`sink()` calls its listener synchronously with the same cache sample `get()`
would return, then calls it when the host cell changes. `pull()` is the explicit
freshness boundary; the runtime adapter demands producers and required loads
before returning reactive state. Pending commit confirmation is separate from
readiness. The runtime adapter's mutations confirm their own commit, and
subsequent operations on the same resource stay ordered behind those mutations.
Custom hosts supply their own pull contract.

A read the host may not show is refused, with the `read-refused` error code, and
is never delivered as `undefined`. `pull()` rejects with it, and a sink hears it
through the `onRefused` option, after the cleanup its listener returned for the
last value runs. A sink added while a refusal stands hears it there at once, and
its listener is not called until a value arrives. A failed write changes no
value, so it reaches no sink:

```ts
const stopSecret = secret.sink((value) => render(value), {
  onRefused: (error) => renderHidden(error.code),
});
```

A cell the host has not read yet is loading, not empty: `get()` returns
`undefined`, which a sink's listener is handed at once as any sink's is, the
listener hears nothing more until the host's read answers, and `update()` pulls
before it computes.

The host holds the path a guest read to that refusal: `set()` and `push()`
through the same path reject with `read-refused` until a read of it (a `pull()`,
or a value its sink delivers) is admitted.

`describe()` makes the API inspectable by people and agents. It returns every
resource's kind, core operations, named methods, description, and schema.
Missing resources and unsupported operations reject with `FabricBridgeError`,
whose `code` and `resource` fields are stable machine-readable context.

### Paths and stable array entries

`key()` derives a fine-grained cell view locally. Pulls, sinks, and writes carry
that path to the host, so a sink on `profile.key("name")` does not subscribe to
the whole profile.

An array position is not an item identity. Resolve the position before keeping a
sink or set handle when the item can move:

```ts
const tasks = fabric.cell<Array<{ title: string; done: boolean }>>("tasks");
await tasks.pull();

const task = await tasks.key(0).resolve();
console.log(task.identity?.id); // Stored entity document ID.
console.log(task.identity?.instanceId); // Concrete scoped instance ID.

const stop = task.key("title").sink((title) => console.log(title));
await task.key("done").set(true); // Still the same task after array reorder.
```

The host mints an opaque capability for the resolved cell. The guest receives
identity metadata for keys and diagnostics, but cannot turn an arbitrary ID into
authority. `.id` names the stored document and is shared by its scoped
instances. `.instanceId` is opaque: it is stable across sessions for one PerUser
instance, differs across users, and differs for each PerSession instance.
`Cell.for(cause)` remains the runtime's construction API for a new deterministic
cell; it is not an array selector. Existing array objects are anchored into
entity documents, which is why resolving a positional item can return a stable
handle.

Use operation-shaped writes when they express the intent. `push()` carries only
the appended members and uses the runtime's mergeable append instead of reading
and replacing the array:

```ts
await tasks.push({ title: "Review bridge", done: false });
```

`pushAll()` appends every member of one list the same way, for a list too long
to spread into `push()`'s arguments.

## React

The React adapter takes the React instance already used by the guest, so this
package does not impose or duplicate a React version. `useCell` is built on
`useSyncExternalStore`; it exposes a status snapshot, a setter that accepts a
value or updater function, and an explicit refresh.

```tsx
import React from "react";
import { connectFabric } from "@commonfabric/iframe-sandbox/guest";
import { createFabricReact } from "@commonfabric/iframe-sandbox/react";

const fabric = connectFabric();
const { useCell, useSqliteQuery } = createFabricReact(React, fabric);

export function App() {
  const count = useCell<number>("count");
  const notes = useSqliteQuery<{ id: number; title: string }>(
    "appDatabase",
    "SELECT id, title FROM notes ORDER BY id DESC",
  );

  if (count.status !== "ready" || notes.status !== "ready") return <>Loading</>;
  return (
    <>
      <button onClick={() => count.set((value) => value + 1)}>
        {count.value}
      </button>
      <ul>{notes.rows.map((note) => <li key={note.id}>{note.title}</li>)}</ul>
    </>
  );
}
```

SQLite query hooks subscribe to the database resource's invalidation stream, so
a committed `exec` refreshes active queries.

## SQLite

SQLite is a resource on the same bridge rather than a separate transport.

```ts
const database = fabric.sqlite("appDatabase");

const { rows } = await database.query<{ id: number; title: string }>(
  "SELECT id, title FROM notes WHERE archived = ?",
  [false],
);

await database.exec(
  "INSERT INTO notes (title) VALUES (:title)",
  { title: "Bridge the database" },
);

const stopInvalidations = database.sink(() => {
  console.log("database changed");
});
```

`exec` uses the runner's transactional SQLite path, including its write checks,
commit conflict handling, and database revision update. Direct bridge queries
are available for unlabeled databases. A database whose schema needs CFC column
provenance is refused because the direct response has no Fabric result cell on
which to persist derived labels; query that database inside a pattern instead.

The same `cf-iframe-bridge-multi-user.test.ts` multiplayer browser integration
runs without a skip in both the default and server-execution ON pattern suites.
It exercises `PerSpace`, `PerUser`, and `PerSession` cells and SQLite databases
across two sessions for one identity, a second identity, and a guest reload.

## Protocol

Each loaded document owns a fresh capability session over a `MessagePort`.
Requests carry a protocol name, version, numeric request ID, operation, and
either a named resource or an opaque resolved-cell handle. Cell requests may
carry a path; push requests carry appended members separately from replacement
values. `resolve` returns a session-local handle plus stable document and
scoped-instance identity metadata. Responses correlate by ID and carry either a
result or a structured error. Sinks have explicit IDs and are cancelled when the
guest cancels, reloads, or sends the session-level `disconnect` operation.

The complete request, response, or event is encoded with `codec-realm`. This
preserves Fabric values such as `FabricBytes` instead of relying on structured
clone to preserve class instances.

Three browser realms participate: the host page, an outer frame that enforces
the CSP and loads documents, and the inner guest. The host transfers a port
directly to each guest; the outer frame does not relay capability traffic.

`reportGuestError(error)` is the exception. It posts a one-way alarm through the
parent so a guest can report failure before it has a working port. The host
emits a `common-iframe-error` event.

The alarm route and the port are separate channels, so a flush exchange puts
what crossed before the port ahead of what crosses on it. The host announces the
exchange ahead of each handoff; a guest that heard the announcement posts a
nonce-carrying flush marker up the parent chain on taking its port, behind
everything it posted there before, and holds its port traffic until the host
echoes the nonce back over the port -- which the host does only once it has
handled everything the relay carried ahead of the marker. An alarm raised before
the guest's first write is therefore dispatched before that write lands. A guest
whose host predates the exchange is never told about it, and sends unordered
rather than waiting.

A load report cannot be matched to a document: a guest can renavigate its own
frame, and the inner frame's initial `about:blank` navigation can complete after
a document was asked for, so reports do not stand one to one with the documents
the host asks for. The host offers a fresh port per report and lets use decide
which offer matters. A guest need not have started listening by the time its
document has loaded, so a guest that starts listening only after that asks for a
port up the parent chain, and the host offers one on that request as it does on
a report, unless it is still loading a document, whose report is still to come.
A session's first request retires every session offered before it, and a guest
already holding a port refuses the new offer rather than losing the session it
has. Two offers are kept at most, which is what stops a guest renavigating its
own frame from accumulating them.

## Security considerations

- The bridge is capability-based, but every resource supplied to a frame is
  readable or mutable exactly as its descriptor says. Keep the manifest small.
- The remaining window `postMessage()` lifecycle, port handoff, and alarm
  traffic uses source-window checks but not origin-bound messages; audit that
  path before treating this as a hardened security boundary.
- Allowed script CDNs and their logging services can exfiltrate data.
- Links opened with `target="_blank"`, `document.baseURI`, and browser
  fingerprinting capabilities can reveal information outside the bridge.
- The iframe CSP, sandbox flags, and permissions policy are separate controls
  from Fabric's CFC checks. A bridge does not make an over-broad browser policy
  safe.

The double-frame construction exists because support for the iframe `csp`
attribute is inconsistent. The outer `srcdoc` frame applies a Content Security
Policy inherited by the inner guest document. See the [CSP processing model] and
[browser support for the `csp` attribute].

A `srcdoc` frame also inherits the policy of the page that embeds it, and both
apply. A host page whose own policy refuses inline script therefore refuses the
outer frame's script and every guest's. Such a host serves the outer frame from
a URL instead, where it takes its policy from its own response, and sets
`outerFrameUrl` on the element; `cf-iframe` takes it from the
`iframeOuterFrameUrl` the host gave its `RuntimeClient`. The document served is
`outer-frame-script.js` as its script, under the policy the guest is to inherit
and a `sandbox` directive that withholds `allow-same-origin`. Framed by the
element, the document is sandboxed by the element's `sandbox` attribute as the
inlined one is. The directive is for the same URL opened on its own, in a tab or
a window, where no element and so no attribute stands in front of it, and a
document that runs a guest's inline script would otherwise run it as the host's
origin.

[CSP processing model]: https://www.w3.org/TR/CSP2/#processing-model-iframe-srcdoc
[browser support for the `csp` attribute]: https://caniuse.com/mdn-html_elements_iframe_csp
