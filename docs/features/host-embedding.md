# Host Embedding Contract

The seams a non-shell host (Loom, or any future embedder) may bind to
when mounting labs components and patterns, plus two policy records
upstream commits to honor. Each seam has a labs-side test that goes red
when the contract changes.

> **Audience.** You are embedding `@commonfabric/ui` components and labs
> patterns in a host that is *not* the labs shell — most concretely Loom
> ([loom#3627](https://github.com/commonfabric/loom/pull/3627)). Bind
> only to what is listed here; treat everything else (component
> internals, create-surface DOM, resolution *implementation*) as in
> motion.

## Why this document exists

Every drift incident in the Loom profile integration was upstream
changing a seam it did not know was a seam: labs#4371 rewrote the
profile create surface days after the vendor pin; labs#4415 changed
`#profile` resolution; `cf-cell-link` clicks dispatch `cf-navigate` into
the void in Loom production because nothing listens. Naming the seams —
and testing each one — means a change that breaks an embedder fails CI
upstream in labs instead of silently blanking a render in the embedder
weeks later.

## Seam map

| # | Seam | Kind | Package | Loom binds today | Test |
| - | --- | --- | --- | --- | --- |
| 1 | Wish targets + result semantics | API | `runner` | yes | `test/wish.test.ts` — `host embedding contract: profile wish targets` |
| 2 | `runtimeContext` / `spaceContext` | API | `ui` | yes | `src/v2/runtime-context.test.ts` |
| 3 | Navigation events | API | `navigation`, `lib-shell` | `cf-navigate` yes; `cf-open-external` yes; others available, not bound | `test/navigate-contract.test.ts` |
| 3a | Piece menu | API + component | `ui` | available, not bound | `src/v2/components/cf-render/cf-render.test.ts` — `CFRender piece context menu`; `src/v2/components/cf-piece-menu/cf-piece-menu.test.ts` |
| 4 | `getCfcLabel` egress check | API | `ui` (label shape in `runner`) | yes | `src/v2/core/cfc-label.test.ts` — `cfcLabelViewIsPublic (egress check)` |
| 5 | Guarded-define idiom | API | `ui` | yes | `src/v2/components/host-embedding-guarded-define.test.ts` |
| 6 | Trusted-mark threat model | policy record | `runner` | n/a | `test/cfc-ui-contract.test.ts` — `host embedding contract: trusted-mark threat model` |
| 7 | Pinning is owner-gated | policy record | `patterns` | n/a | `system/profile-home.owner-gated.test.ts` |

---

## 1. Wish targets and result semantics

**Contract.** The runtime resolves the well-known profile targets
`#profile`, `#profileName`, `#profileAvatar`, `#profileBio`,
`#profileSpace`, and hashtag search over profile elements with
`scope: ["profile"]`. Reads are read-only; writes go only through the
profile pattern's own owner-protected handlers (seam 7). At zero
profiles, `#profile` renders the trusted create surface inline
(`result` undefined) and the scalar targets land a `WishError`
(`result` undefined) — so every consumer must use
`wish.result ?? fallback`. Resolution order among multiple profiles is
default-first, then most-recently-used — **pending CT-1829**, which is
settling single-result semantics; do not bind to a fixed ordering.

**Test.** `packages/runner/test/wish.test.ts`,
`describe("host embedding contract: profile wish targets")`.

A host renders the profile by mounting a thin wrapper pattern that
wishes `#profile` inside the runtime it already boots — never by
re-implementing resolution host-side. Full wish semantics:
[docs/common/conventions/wish.md](../common/conventions/wish.md).

---

## 2. The two host-providable contexts

**Contract.** `runtimeContext` (value `RuntimeClient | undefined`, key
`"runtime"`) and `spaceContext` (value `DID | undefined`, key
`"space"`), exported from `packages/ui/src/v2/runtime-context.ts`, are
the only two contexts a host must provide: `runtimeContext` once at the
root, `spaceContext` per mount container. All other contexts degrade
gracefully without a provider. The host bundle must share the same
module instance of `runtime-context.ts` as the components so context
identity matches.

```ts
import { runtimeContext, spaceContext } from "@commonfabric/ui";

// The published seam (packages/ui/src/v2/runtime-context.ts, 8 lines):
//   runtimeContext = createContext<RuntimeClient | undefined>("runtime")
//   spaceContext   = createContext<DID | undefined>("space")
export const hostProvidedContexts = [runtimeContext, spaceContext] as const;
```

(The import above is live — this doc block itself type-checks against
the real export, so a rename fails the docs check.)

**Test.** `packages/ui/src/v2/runtime-context.test.ts`.

---

## 3. Event contracts

**Contract.** Mounted patterns and components signal navigation intent
via `CustomEvent`s dispatched on `globalThis` (not bubbled from the
DOM). A host embeds by listening for:

- **`cf-navigate`** — two emitters, one listener. Pattern-side
  (`navigateTo()`), the detail is a `RuntimeNavigationTarget`;
  component-side (`cf-cell-link` / `cf-render` tile / `cf-profile-badge`
  clicks), the detail is an `AppView`. Bind to the common fields —
  space + `pieceId` — and loud-log + no-op anything else.

  A view naming a collection member carries `pieceSlug` **and**
  `pieceMember`, and the two are one address: a host that binds the slug and
  drops the member opens the piece holding the collection instead of the
  member the view named. Carry both, or no-op the view whole.

  ```ts
  import type { DID } from "@commonfabric/identity";

  // packages/lib-shell/src/runtime.ts
  export type RuntimeNavigationTarget = { spaceDid: DID; pieceId: string };
  ```

  ```ts
  import type { DID } from "@commonfabric/identity";

  // Condensed from packages/navigation/src/view.ts
  type PieceViewRef = {
    pieceId?: string;
    // A slug naming a collection, and the member it selects.
    pieceSlug?: string;
    pieceMember?: string;
  };
  export type AppView =
    | { builtin: "home" }
    | ({ spaceName: string; mode?: "embed" } & PieceViewRef)
    | ({ spaceDid: DID; mode?: "embed" } & PieceViewRef);
  ```

- **`cf-replace-navigation`** — same `AppView` detail; replaces the
  current history entry instead of pushing. Available; Loom does not
  bind it today.
- **`cf-update-page-title`** — detail is the title `string`. Available;
  Loom does not bind it today.
- **`cf-open-external`** — a cancellable event carrying the same view
  target as `cf-navigate`, dispatched on a modifier-click ("open in new
  tab"). A host that calls `preventDefault()` owns the new tab and can
  apply its own URL scheme. Left uncancelled, the default builds a
  fabric URL and calls `globalThis.open`, which on a non-shell origin is
  a 404 tab — so a host that mounts these components binds this one. The
  conceptual browser form is described by
  [Common Fabric URLs](../specs/fabric-urls.md). No deployment is planned; the
  current event behavior remains authoritative.

**Test.** `packages/navigation/test/navigate-contract.test.ts` (event
names and detail shapes) and `packages/navigation/test/navigate.test.ts`
(the `cf-open-external` cancellation contract); the pattern-side shape is
also guarded by `packages/shell/test/runtime-navigation.test.ts`.

---

## 3a. The piece menu

**Contract.** A right-click on a piece rendered by `cf-render` opens
`cf-piece-menu` for that piece. **View source** shows the piece's retained
authored files. **Origin and history** shows its active origin and recorded
source revisions. **Clone fresh piece into new space** creates a copy with
default input data in a unique named space owned by the current user, then
navigates to it. **Clone piece and copy data into new space** takes detached
snapshots of the selected piece's current input and stateful internal data.
Computed values are recomputed in the new space. Data linked from another space
is rejected because it cannot be captured atomically. Both actions move clone
progress and failures from the context menu into a dialog. The copy follows
the selected piece when that piece is detached. When the selected piece already
follows an origin, the copy follows that same origin. A piece with an active
origin also has **Stop following source**. That action keeps the exact current
source and clears the active origin.

Historical entries can restore an exact retained source version or resume
following an earlier web or fabric origin. Each entry can show its exact
retained source. A mutable Fabric piece origin links to that piece in its own
space, and the space fact links to the space's default piece. An incompatible
pattern contract or retained link is shown before mutation and requires a
second explicit confirmation. The runtime binds that confirmation to the exact
reviewed code and source-state snapshot. If the piece's actual retained input
does not satisfy the candidate's argument schema, the runtime rejects the
transition instead. The input must be repaired before that source can be
selected. Nothing is required of the host to get these controls. Importing
`cf-render` registers the menu. The menu reads, clones, and changes the piece
through `RuntimeClient.getPieceSource()`,
`RuntimeClient.getPieceSourceRevision()`, `RuntimeClient.clonePiece()`, and
`RuntimeClient.updatePieceSource()` on the runtime the piece already runs in.

The menu addresses a space, and usually a piece in it. A divider separates the
two: above it the entries that need a piece, below it a heading naming the
space and the entries that act on the space itself. `openPieceMenu()` takes
either — a `cell`, from which the space, the scope, and the runtime are read,
or a `space` and `runtime` with no piece. A host with a surface that no piece
loaded into opens the menu that second way: the piece heading reads "Piece
unavailable", every entry that needs a piece is disabled, and the space
entries stay live. A call carrying neither leaves the menu closed. The menu
covers the viewport while it is up, so one with nothing to show would take the
page's clicks with nothing on screen to account for it.

**Space access rights...** reads the target space's ACL through
`RuntimeClient.getSpaceAcl()`.
Every principal that can read the space sees the entries. A principal whose
effective ACL capability is `OWNER` also gets controls backed by
`RuntimeClient.setSpaceAclEntry()` and `RuntimeClient.removeSpaceAclEntry()`.
The runtime uses `ACLManager` for these mutations, so the memory server remains
the authority that accepts owner changes and preserves a concrete owner.

Calling `RuntimeClient.createPiece()` with an HTTP or HTTPS `URL` creates a
followed piece. The runtime records the canonical URL and retained initial
source in one creation transaction. Calling it with a source string or
`Program` creates a detached piece when that source can be retained.

For a persistent host UI piece, pass a stable `cause` in the options to
`RuntimeClient.createPiece(source, space, options)` or
`RuntimeInternals.createPiece(space, source, options)`. The cause derives the
piece's identity within that space, so repeated calls address the same piece
across reloads. Repeated creation requires the same pattern identity; supplying
a different pattern is rejected, so a stable cause does not perform a source
upgrade. Each call reapplies setup and inputs to the existing pattern; it is
not a lookup that leaves an existing piece untouched. Omitting `cause`
allocates a new identity. Use a distinct cause for each independent host piece.

`updatePieceSource()` returns a one-use `confirmationToken` with an
incompatibility warning. Passing that token back confirms only the reported
pattern-contract or durable linked-producer warning. The token is valid only
for the compiled candidate, retained argument evidence, and linked-producer
contracts that produced the warning. An `executionWarning` means the source
transition was saved but a later running-piece or source-detail refresh failed;
hosts must not present that case as an unsaved change.

The menu mounts itself on `document.body`, not inside the piece, because a piece's
own `overflow: hidden` would clip it and the tile variant's
`transform: scale(0.5)` would shrink it; it copies the `--cf-theme-*` tokens
across from the element that opened it, so it follows the host's theme.
While the built-in menu or one of its panels is open, the originating
`cf-render` shows an animated light sweep and color glow. This visual layer does
not receive pointer events or affect layout. Closing the menu removes it, and
opening the shared menu for another piece moves it to that piece. The menu also
closes if its originating renderer disconnects or begins showing another piece.
When patterns render other patterns directly, their output shares the outer
`cf-render` instead of adding a wrapper. The renderer retains each nested
pattern's result cell on its existing root element through the same standard
element context protocol used for producing-space inheritance. A right-click
selects the deepest such root in the click path, and the portalled visual layer
clips its shine to that root. No element is inserted into the pattern's layout.

Before the menu opens, `cf-render` announces the click. The event is
**cancellable, and cancelling it takes the click**: the built-in menu does not
open, and the host is responsible for what appears instead. Either way the
browser's own context menu is suppressed. Unlike the navigation events, this one
BUBBLES from the DOM (`bubbles`, `composed`), so a host may listen on its mount
container or on `globalThis`.

Every `cf-render` variant resolves a link-valued cell to the piece it displays
before it chooses the menu target. A directly rendered nested pattern is a full
variant, even when its containing renderer uses another variant. The renderer
observes the link itself and resolves again when its target changes.

```ts
import type { DID } from "@commonfabric/identity";

// packages/ui/src/v2/components/cf-render/cf-render.ts
export const PIECE_CONTEXT_MENU_EVENT = "cf-piece-context-menu";

export interface PieceContextMenuDetail {
  space: DID;
  /** The piece's full schemed id (`of:fid1:…`). */
  pieceId: string;
  /** Client coordinates of the click, for placing the menu. */
  x: number;
  y: number;
  variant: "full" | "chip" | "tile";
}
```

Three clicks are never announced, so a host needs no special cases for them: a
click on a text entry, a click held with Shift, and a `cf-render` bound to a
value inside a piece rather than to a whole piece. The innermost rendered piece
announces, so a right-click on a tile inside a piece names the tile.

See [docs/specs/piece-source-lifecycle.md](../specs/piece-source-lifecycle.md)
for what an origin means.

**Test.** `packages/ui/src/v2/components/cf-render/cf-render.test.ts`,
`describe("CFRender piece context menu")` — the event name, the detail shape, and
when the click is taken. `packages/ui/src/v2/components/cf-piece-menu/cf-piece-menu.test.ts`
— the entries, lifecycle actions, compatibility confirmation, and their test
hooks. The menu's DOM behavior is driven end to end by
`packages/shell/integration/piece-menu.test.ts`.

---

## 4. `getCfcLabel` as an egress check

**Contract.** A cell handle exposes
`getCfcLabel(): Promise<CfcLabelView | undefined>` — a pure,
non-blocking read of the cell's runtime-attested CFC label. A host that
persists cell data *outside the runtime* (a host-side cache, an LLM
prompt) has left the CFC enforcement boundary and must **fail closed**:
egress only what is public. A label is public iff no entry carries a
non-empty `confidentiality` clause; an absent label and empty entries
are public; `integrity` atoms are orthogonal and do not make a value
confidential.

```ts
// packages/runner/src/cfc/label-view-core.ts
export type IFCLabel = { confidentiality?: unknown[]; integrity?: unknown[] };
export type CfcLabelViewEntry = { path: readonly string[]; label: IFCLabel };
export type CfcLabelView = { version: 1; entries: CfcLabelViewEntry[] };
```

The predicate is exported as `cfcLabelViewIsPublic` in
`packages/ui/src/v2/core/cfc-label.ts`. This seam is load-bearing as
`Confidential` / `ProjectionOf` land structurally (CT-1658 / CT-1660):
those `confidentiality` clauses become populated, and a check written
against this predicate keeps failing closed. Any change to label
semantics or granularity must account for this egress seam.

**Test.** `packages/ui/src/v2/core/cfc-label.test.ts`,
`describe("cfcLabelViewIsPublic (egress check)")`.

---

## 5. The guarded-define idiom

**Contract.** Every `cf-*` component is safe to import into a host
bundle: importing a component module twice, or importing a component
whose tag is already registered, does not throw (normalized in
labs#4286). Each component's `index.ts` guards its define:

```ts
// Shown at module scope.
// e.g. packages/ui/src/v2/components/cf-render/index.ts
import { CFRender } from "./cf-render.ts";

if (!customElements.get("cf-render")) {
  customElements.define("cf-render", CFRender);
}
```

This is what lets a host deep-import the full component set into one
bundle and re-mount freely.

**Test.**
`packages/ui/src/v2/components/host-embedding-guarded-define.test.ts`.

---

## 6. Policy record: trusted-mark threat model

Not a bindable API — a statement upstream commits to honor.

The trusted-event mark (the `uiContract` machinery in
`packages/runner/src/cfc/`) certifies that an event flow **originated
from the rendered surface** — an anti-confused-deputy defense against
in-runtime pattern code exercising delegated authority it was not
handed through the real UI. It certifies *surface origin*, not *human
intent*: it cannot defend against principal-level actors — a
key-holding CLI never touches the DOM path, and an agent-driven
browser's CDP-injected events are `isTrusted === true`.

**Consequence.** First-class headless issuance for key-holding
principals is consistent with the threat model — forcing a key-holder
through trusted-DOM-event forgery buys no security, only friction. The
right posture is a sanctioned headless issuance path, **not** a
weakening of the in-runtime surface-origin defense, which does real
work against confused-deputy pattern code.

**Test.** `packages/runner/test/cfc-ui-contract.test.ts`,
`describe("host embedding contract: trusted-mark threat model")` — an
unmarked event with a lookalike provenance is rejected; the same
provenance carrying the renderer mark is accepted.

---

## 7. Policy record: pinning is owner-gated, not gesture-gated

Not a bindable API — a statement upstream commits to honor.

Pinning an element to a profile is authorized by **ownership**, not by
a trusted-UI gesture: the single authorized writer of profile
`elements` (`mutateElements` in
`packages/patterns/system/profile-home.tsx`) is typed
`OwnerProtectedProfileWrite` — `WriteAuthorizedBy` plus owner
principal, with **no `uiContract`**. Creating a profile, by contrast,
*is* gesture-gated: `profile-create.tsx` carries the only `uiContract`
(the `ProfileCreateSurface` trusted pattern).

**Consequence.** Headless pinning (`cf piece call` into the `addPiece`
stream) and cross-pattern pin flows are **sanctioned** use cases.
Future guards must keep supporting them — do not "harden" pinning with
a `uiContract`; that conflates the create seam (correctly
gesture-gated) with the pin seam (correctly owner-gated). Richer
pin/arrange flows ride the UI-variants abstraction (`UI` / `CHIP_UI` /
`TILE_UI` + `cf-render variant=…`), not a new authorization gate.

**Test.** `packages/patterns/system/profile-home.owner-gated.test.ts` —
asserts against the real pattern sources that the pin writer carries no
`uiContract` while the create surface does, and that `addPiece` is a
`Stream`.

---

## Summary for embedders

Provide `runtimeContext` + `spaceContext`. Mount a wrapper pattern that
wishes `#profile`. Listen for `cf-navigate` (both shapes) and
`cf-open-external` on `globalThis`. Deep-import the
guarded-define components into one bundle. If you persist profile data
outside the runtime, gate it on `getCfcLabel` failing closed on
non-public labels. Pin through `addPiece` (owner-gated,
headless-friendly); create through the trusted `ProfileCreate` surface
(gesture-gated). Every one of those sentences is a tested seam above —
if one breaks, a labs CI job is what tells you.
