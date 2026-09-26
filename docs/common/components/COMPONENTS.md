<!-- @reviewed 2026-06-10 docs-overhaul-phase-3 -->

# UI Components Reference

This file is the **agent-facing index plus usage narrative** for the Common
Fabric UI library. Division of labor:

- **This file** — complete component index (tag, purpose, bindable props) and
  the usage narrative that is not derivable from source.
- [`packages/patterns/catalog/catalog.tsx`](../../../packages/patterns/catalog/catalog.tsx)
  and the story files under
  [`packages/patterns/catalog/stories/`](../../../packages/patterns/catalog/stories/)
  — authoritative, type-checked live usage.
- Component source under
  [`packages/ui/src/v2/components/`](../../../packages/ui/src/v2/components/)
  — authoritative props, events, and JSDoc.
- [`packages/ui/LLM-COMPONENT-INSTRUCTIONS.md`](../../../packages/ui/LLM-COMPONENT-INSTRUCTIONS.md)
  — HTML attribute tables per component.

## Bidirectional Binding

Use the `$` prefix for explicit two-way sync. That is the normal authoring
form for Common Fabric controls. No handler is needed for simple updates.

```tsx
// Shown for illustration only.
<cf-checkbox $checked={item.done} />    // Auto-syncs checkbox state
<cf-input $value={title} />             // Auto-syncs text input
<cf-select $value={category} items={[...]} />
```

**Native HTML inputs are one-way only.** Always use the Common Fabric form
components for inputs.

Use camelCase for component properties — kebab-case JSX attributes don't map
correctly:

```tsx
// Shown for illustration only.
// ❌ Kebab-case won't work
<cf-autocomplete allow-custom={true} />  // Sets element["allow-custom"], not allowCustom

// ✅ CamelCase works
<cf-autocomplete allowCustom={true} />  // Sets element.allowCustom correctly
```

When a control is already bound to a cell via `$value`, treat that binding as
the primary value path. Avoid `oncf-change` handlers that simply write the same
value back into the same cell; use them only for dependent state or side
effects.

For when to use handlers vs binding — and the standard `equals()` idiom for
removing array items by identity — see
[two-way-binding](../patterns/two-way-binding.md).

### Testing note: Playwright `fill()`

Playwright's `fill()` does not work on `cf-input` hosts (they are custom
elements, not native inputs). Use `type @ref "text"` in agent-browser, or
`locator.pressSequentially()` in Playwright tests:

```bash
agent-browser snapshot -i              # → textbox "Title" [ref=e4]
agent-browser type @e4 "Quarterly plan"
```

### Accessibility shape for custom elements

Choose the semantic anchor from the component's interaction model:

- Put role, state, focus, and keyboard handling on the custom-element host when
  the component represents one logical control.
- Use separately named native controls inside the shadow root when a composite
  component exposes multiple independent actions. A single host role cannot
  represent actions such as both opening and removing a chip.
- Use list and list-item semantics for informational collections; do not turn
  information-only items into buttons or tab stops for automation.

The native-shadow approach is simpler and preserves browser behavior, but
shadow-blind DOM walkers cannot see those controls. The supported role/name
locators in agent-browser and Playwright consume the flattened accessibility
tree and do see them. See
[Testing Shadow DOM Components](../../development/UI_TESTING.md) for the full
decision table and fallback locator strategy.

`cf-checkbox` exposes its checked state through `aria-checked` on the host.
That state follows the rendered checkbox, including values delivered through
`$checked` after the first render. An indeterminate checkbox exposes `mixed`.

## Component Index

One row per component directory in `packages/ui/src/v2/components/`. "Bindable
props" lists cell-bound (`$`-prefixed) properties verified in source; an empty
cell means none confirmed — check the component source before assuming.

| Tag | Purpose | Bindable props |
|-----|---------|----------------|
| `cf-accordion` | Container for collapsible content panels | |
| `cf-accordion-item` | Individual accordion panel | |
| `cf-alert` | Alert message with `status` (`info`, `error`, `warning`, `success`) and dismissible option | |
| `cf-area-mark` | Filled area mark rendered inside `cf-chart` | `$data` |
| `cf-aspect-ratio` | Maintains a fixed aspect ratio for its content | |
| `cf-attachments-bar` | Displays pinned cells as a horizontal list of chips | |
| `cf-audio-visualizer` | Real-time audio waveform visualization | |
| `cf-autocomplete` | Search input with filterable dropdown; single/multi select | `$value`, `$items` |
| `cf-autolayout` | Responsive multi-panel layout | |
| `cf-autostart` | Zero-UI element that emits a `start` event once on connect | |
| `cf-avatar` | Avatar showing data-URI image, emoji glyph, or initials | |
| `cf-badge` | Status indicator / label with visual variants | |
| `cf-bar-mark` | Bar mark rendered inside `cf-chart` | `$data` |
| `cf-button` | Interactive button with color/variant/size options | |
| `cf-calendar` | Month-grid mini calendar | `$value`, `$markedDates` |
| `cf-canvas` | Fixed-size canvas surface emitting `cf-canvas-click` with x/y | |
| `cf-card` | Content container with header/content/footer (built-in 1rem padding) | |
| `cf-cell-link` | Renders a link or cell as a clickable, draggable pill | |
| `cf-cfc-authorship` | Shows trusted authorship state for CFC-labeled content | `$value`, `$author` |
| `cf-cfc-label` | Renders the CFC label of a bound cell value; `variant="badge"` shows a compact pill for whether an integrity atom matches the `atom`/`kind` filter | `$value` |
| `cf-chart` | SVG charting container for line/area/bar/dot marks (see [cf-chart](#cf-chart)) | `$marks` (marks: `$data`) |
| `cf-chat` | Chat container handling message flow and tool-call correlation | `$messages` |
| `cf-chat-message` | Single chat message with markdown support | |
| `cf-checkbox` | Binary selection input with indeterminate support | `$checked` |
| `cf-chevron-button` | Minimal chevron button rotating between up/down | |
| `cf-chip` | Compact pill/label for status, tags, and filters | |
| `cf-code-editor` | Code/prose editor with highlighting and `[[`-mention completion | `$value`, `$mentionable`, `$mentioned` |
| `cf-collapsible` | Single collapsible section with trigger and content | |
| `cf-copy-button` | Copy-to-clipboard button with visual feedback | |
| `cf-custody-seal` | Native confirmation that seals the actor's draft into a custody room, showing the runtime-verified room, readers, seats, policy and sources beside what the terms say (see [custody seal](#cf-custody-seal)) | `$draft`, `$terms`, `$policy`, `$sources` |
| `cf-dot-mark` | Scatter/dot mark rendered inside `cf-chart` | `$data` |
| `cf-drag-source` | Wraps draggable content; pairs with `cf-drop-zone` (see [drag-and-drop](../patterns/meta/drag-and-drop.md)) | `$cell` |
| `cf-draggable` | Absolutely-positioned draggable container (x/y) | |
| `cf-drop-zone` | Droppable region emitting `cf-drop` events (see [drag-and-drop](../patterns/meta/drag-and-drop.md)) | |
| `cf-empty-state` | Centered, muted placeholder for empty lists (see [cf-empty-state](#cf-empty-state)) | |
| `cf-fab` | Morphing floating action button that expands into a panel | |
| `cf-field` | Labeled field wrapper: muted label, optional required/error/help text (see [cf-field](#cf-field)) | |
| `cf-file-download` | File download button (encapsulates blob/anchor download) | `$data`, `$filename` |
| `cf-file-input` | Generic file upload to the space's blob store (see [files](../capabilities/files.md)) | |
| `cf-form` | Transactional form wrapper buffering field writes until submit (see [cf-form](#cf-form)) | |
| `cf-fragment` | Transparent wrapper element (`display: contents`) | |
| `cf-google-oauth` | Google OAuth login (wrapper over `cf-oauth`) | `$auth` |
| `cf-grid` | CSS Grid layout | |
| `cf-heading` | Theme-compliant heading replacing `h1`–`h6` | |
| `cf-hgroup` | Horizontal group with automatic gap management | |
| `cf-hover-card` | A card that appears beside its content on hover or focus (see [cf-hover-card](#cf-hover-card)) | |
| `cf-hover-reveal` | Content whose `actions` slot appears on hover or focus (see [cf-hover-reveal](#cf-hover-reveal)) | |
| `cf-hscroll` | Horizontal scroll container | |
| `cf-hstack` | Horizontal stack layout (flexbox) (see [stacks](#cf-vstack--cf-hstack)) | |
| `cf-iframe` | Sandboxed guest with explicit cell, stream, SQLite, or service capabilities | |
| `cf-image-input` | Image capture/upload with compression, EXIF, camera support | |
| `cf-input` | Text input with validation and reactive binding | `$value` |
| `cf-input-otp` | One-time-password input with individual digit fields | |
| `cf-kbd` | Inline keyboard hint element | |
| `cf-keybind` | Declarative keyboard shortcut listener | |
| `cf-label` | Form field label with accessibility features | |
| `cf-line-mark` | Line mark rendered inside `cf-chart` | `$data` |
| `cf-link` | Navigation link that emits `cf-route-change` for `cf-router` | |
| `cf-link-preview` | Rich link preview card for a URL | |
| `cf-list-item` | Generic list row (SwiftUI-List inspired) | |
| `cf-loader` | Inline spinner for pending async operations | |
| `cf-location` | Geolocation capture (single or continuous) | `$location` |
| `cf-map` | Interactive Leaflet/OpenStreetMap map (see [cf-map](#cf-map)) | `$value`, `$center`, `$zoom`, `$bounds` |
| `cf-markdown` | Renders markdown with syntax highlighting and copy buttons; safe for untrusted content, and raw HTML written into the markdown is not rendered | `$content` |
| `cf-message-beads` | Compact bead visualization of a message history | `$messages` |
| `cf-message-input` | Input + send button combo for chat-style item entry; emits a synthetic (untrusted) `cf-send` event, so use `cf-submit-input` when the submit must authorize an owner-protected write | |
| `cf-modal` | Accessible modal dialog with bottom-sheet presentation mode | `$open` |
| `cf-oauth` | Generic OAuth authentication | `$auth` |
| `cf-owner-view` | Sets a per-user presentation predicate from the runtime's acting principal and a stored creator attestation (see [owner view](#cf-owner-view)) | `$originator`, `$result` |
| `cf-picker` | Carousel selection over cells with `[UI]` | `$items`, `$selectedIndex` |
| `cf-piece` | Provides piece context to child components | |
| `cf-plaid-link` | Plaid banking integration | `$auth` |
| `cf-profile-badge` | The blessed, trusted way to render a profile identity (avatar + name + the generative verification seal — a DID-derived aura ring + cursor glint, no shield icon); navigable to the profile. Variants `full`/`chip`/`circle`/`hero` + `size`/`noNavigate` attrs (CT-1761). Prefer it over a bare name/avatar anywhere an identity appears. | `$profile` |
| `cf-progress` | Progress bar, determinate or indeterminate | |
| `cf-prompt-input` | Multiline prompt input with `@`-mentions, attachments, voice | `$mentionable`, `$model` |
| `cf-question` | Asks a single question and collects the answer | |
| `cf-radio` | Single radio button used within `cf-radio-group` | |
| `cf-radio-group` | Radio group; declarative `items` or slotted `cf-radio` | `$value` |
| `cf-render` | Renders a cell containing a piece pattern at a UI variant — `full`/`chip`/`tile` (see [cf-render](#cf-render)) | `$cell`, `variant` |
| `cf-resizable-handle` | Drag handle between resizable panels | |
| `cf-resizable-panel` | Individual panel within a resizable panel group | |
| `cf-resizable-panel-group` | Container managing resizable panels and handles | |
| `cf-router` | Routes `cf-route-change` events into a path cell | `$path` |
| `cf-screen` | Full-height layout with header/main/footer slots (see [cf-screen](#cf-screen)) | |
| `cf-scroll-area` | Scrollable container with custom-styled scrollbars | |
| `cf-secret-viewer` | Trusted UI for revealing secret strings | `$value` |
| `cf-select` | Dropdown taking `{ label, value }` items — not `<option>` elements | `$value` |
| `cf-separator` | Visual divider line between content sections | |
| `cf-share-snapshot` | Native confirmation of an exact JSON snapshot and runtime-verified audience (see [snapshot sharing](#cf-share-snapshot)) | `$source`, `$recipient`, `$result` |
| `cf-skeleton` | Animated loading placeholder | |
| `cf-slider` | Range input slider | |
| `cf-space-link` | Renders a space as a clickable navigation pill | |
| `cf-submit-input` | Text field + submit button whose real (trusted) click carries the typed text as `event.target.value` with the surface's UI integrity, so it can authorize an owner-protected runtime write; prefer over `cf-message-input` when the submit gesture must be trusted | |
| `cf-svg` | Renders SVG content from a string; safe for untrusted content, and anything that would run script is dropped | |
| `cf-switch` | Toggle switch for binary on/off state | `$checked` |
| `cf-tab` | Individual tab button used within `cf-tab-list` | |
| `cf-tab-bar` | Fixed navigation bar for app-like UIs (with `cf-tab-bar-item`) | `$value` |
| `cf-tab-bar-item` | Individual item within `cf-tab-bar` (value, label, icon) | |
| `cf-tab-list` | Container for tab buttons | |
| `cf-tab-panel` | Content panel associated with a tab | |
| `cf-table` | Semantic table with striped/hover/bordered styling | |
| `cf-tabs` | Container managing ARIA tab navigation and panels | `$value` |
| `cf-tags` | Tag pills with add/remove functionality | |
| `cf-text` | Generic text primitive for non-label typography (see [cf-text](#cf-text)) | |
| `cf-textarea` | Multi-line text input with auto-resize and reactive binding | `$value` |
| `cf-theme` | Provides a theme to a subtree and applies CSS variables | |
| `cf-tile` | Page/item preview tile with click handling | |
| `cf-toast` | Floating ephemeral notification (inside `cf-toast-provider`) | |
| `cf-toast-provider` | Region that hosts and displays `cf-toast` notifications | |
| `cf-toggle` | Pressable toggle button with variants and sizes | |
| `cf-toggle-group` | Toggle container with single or multiple selection | |
| `cf-tool-call` | Expandable tool-call display | |
| `cf-toolbar` | Horizontal toolbar for grouping controls | |
| `cf-tools-chip` | Pill revealing a read-only tool list on hover/tap | `$tools` |
| `cf-vgroup` | Vertical group with automatic gap management | |
| `cf-voice-input` | Voice recording and transcription | `$transcription` |
| `cf-vscroll` | Vertical scroll container (snap-to-bottom, fade edges) | |
| `cf-vstack` | Vertical stack layout (flexbox) (see [stacks](#cf-vstack--cf-hstack)) | |
| `cf-webhook` | Webhook integration: receives payloads into a stream | `$inbox`, `$config` |

---

## cf-form

`cf-form` provides a "write gate" for transactional form submission:

- Fields buffer writes locally instead of immediately writing to cells
- On submit, all buffered values are validated and flushed atomically, then
  `cf-submit` is emitted
- On reset (`cf-button type="reset"` or `form.reset()`), buffered changes are
  discarded and fields restore their initial cell values
- Works for both "create" (fresh staging cell) and "edit" (existing cell) modes

All form-compatible fields (`cf-input`, `cf-select`, `cf-checkbox`,
`cf-textarea`) share the same behavior: **outside** `cf-form` they write to
the bound cell immediately; **inside** `cf-form` they buffer until submit.

```tsx
// Shown as JSX element children.
<cf-form oncf-submit={handleSubmit}>
  <cf-input name="email" $value={data.key("email")} required />
  <cf-button type="submit">Save</cf-button>
</cf-form>
```

### Create mode

Bind fields to a staging cell, then copy to the collection on submit:

```tsx
// Shown for illustration only.
const formData = new Writable({ name: "", email: "" });

<cf-form
  oncf-submit={handler((_, { formData, collection }) => {
    // cf-form flushes buffers to cells before emitting cf-submit,
    // so we can read the complete, typed object directly.
    // IMPORTANT: Copy the object to avoid sharing references!
    collection.push({ ...formData.get() });
  }, { formData, collection })}
>
  <cf-input name="name" $value={formData.key("name")} required />
  <cf-input name="email" $value={formData.key("email")} type="email" />
  <cf-button type="submit">Create</cf-button>
</cf-form>;
```

**The copy trap:** always copy with `{ ...formData.get() }` when adding to a
collection. The staging cell is reused between submissions, so pushing the same
object reference would make all items share the same data.

### Edit mode

Bind fields to a pointer (`Writable<Person>`) instead of using indices; on
submit, values are flushed to the bound cell:

```tsx
// Shown at module scope.
export const EditPerson = pattern<{ person: Writable<Person> }, { [UI]: VNode }>(
  ({ person }) => ({
    [UI]: (
      <cf-form oncf-submit={closeModal}>
        <cf-input name="name" $value={person.key("name")} required />
        <cf-input name="email" $value={person.key("email")} type="email" />
        <cf-button type="submit">Save</cf-button>
        <cf-button type="reset">Cancel</cf-button>
      </cf-form>
    ),
  }),
);
```

When choosing which item to edit from a list, store the pointer and find it
with `equals()` (see [two-way-binding](../patterns/two-way-binding.md)), not
array indices, which drift when lists change.

### Events and best practices

- `cf-submit` — emitted after validation passes and buffers are flushed.
  Handlers should read from the bound cell directly (type-safe), not from
  event detail.
- `cf-form-invalid` — emitted when submit is attempted but validation fails;
  detail carries `{ errors: Array<{ element, message? }> }`.
- Fields use HTML5 constraint validation by default.
- When using `cf-modal` around a form, bind `$open` to a `Writable<boolean>`
  (not a `computed`) so the modal can update state.

Contributor-facing internals (FormFieldController, file organization, design
decisions) live in
[`packages/ui/docs/forms-internals.md`](../../../packages/ui/docs/forms-internals.md).

---

## cf-field

`cf-field` is a layout/typography wrapper for labeled form fields. It replaces
the hand-rolled label-above-control stack repeated throughout patterns:

```tsx
// Shown for illustration only.
// Before
<cf-vstack gap="1">
  <label style={{ fontSize: "12px", color: "#6b7280" }}>Email</label>
  <cf-input type="email" $value={address} />
</cf-vstack>

// After
<cf-field label="Email">
  <cf-input type="email" $value={address} />
</cf-field>
```

Attributes:

- `label` — small muted label rendered above the control
- `required` — appends a danger-colored asterisk to the label
- `error` — error text below the control in the danger color (replaces `help`
  while set)
- `help` — muted helper text below the control

The default slot takes any control (`cf-input`, `cf-select`, `cf-textarea`,
…). All colors and sizes come from theme tokens, so fields adapt to the
ambient `cf-theme`.

```tsx
// Shown as JSX element children.
<cf-field label="Username" required error={usernameError}>
  <cf-input $value={username} placeholder="Pick a username" />
</cf-field>

<cf-field label="Bio" help="Shown on your public profile.">
  <cf-textarea $value={bio} />
</cf-field>
```

Notes:

- `cf-field` is presentation only — it renders whatever `error` string it is
  given. Validation logic and submit gating belong to
  [`cf-form`](#cf-form) or the pattern.
- Shadow DOM prevents a native `for`/`id` association with the slotted
  control, so clicking the label focuses (and for custom elements, clicks)
  the first slotted element instead — same approach as `cf-label`. For full
  assistive-technology support, also set `aria-label` on the control itself.

---

## cf-render

Renders pattern instances for composition.

```tsx
// Shown at module scope.
import SubPattern from "./sub-pattern.tsx";

const subView = SubPattern({ items });

// Three equivalent ways:
<cf-render $cell={subView} />   // Most explicit
{subView}                        // Direct interpolation
<SubPattern items={items} />     // JSX syntax
```

**Use `$cell`, not `piece` or `pattern` attribute.**

Multiple patterns sharing data:

```tsx
// Shown inside a pattern body.
const listView = ListView({ items });
const gridView = GridView({ items });

<div style={{ display: "flex", gap: "1rem" }}>
  <cf-render $cell={listView} />
  <cf-render $cell={gridView} />
</div>
// Both views stay in sync automatically
```

See [composition](../patterns/composition.md) for more on pattern composition.

### UI variants (CT-1321)

A piece can expose a **size spectrum** of renderings as optional sibling output
keys, addressed by symbols vended from `commonfabric`:

| Variant | Output key | Symbol | Use |
| --- | --- | --- | --- |
| `full` | `"$UI"` | `UI` | Standalone rendering — the default, and the universal floor. |
| `chip` | `"$CHIP_UI"` | `CHIP_UI` | Inline rendering for text and lists. |
| `tile` | `"$TILE_UI"` | `TILE_UI` | Gallery/grid card. |

Pick a variant with the `variant` attribute (default `"full"`):

```tsx
// Shown as JSX element children.
<cf-render $cell={piece} variant="full" />   // default — standalone
<cf-render $cell={piece} variant="chip" />   // inline
<cf-render $cell={piece} variant="tile" />   // gallery/grid tile
```

**Failover — every piece renders at every variant.** When a piece doesn't
export the requested variant key, `cf-render` substitutes a per-variant platform
default:

- `chip` → a `cf-cell-link` bound to the piece (renders it by its `[NAME]`).
- `tile` → the full `[UI]` rendered small at ~0.5 scale, clipped to a static
  preview and clickable to navigate to the piece (like `cf-cell-link`).

Because `full`/`[UI]` is the universal floor, a piece that exports only `[UI]`
still renders correctly at `chip` and `tile`.

A pattern exports the spectrum by returning the sibling keys:

```tsx
// Shown for illustration only.
import { CHIP_UI, NAME, pattern, TILE_UI, UI } from "commonfabric";

export default pattern(({ title }) => ({
  [NAME]: title,
  [UI]: <FullView title={title} />,      // standalone (always provide this)
  [CHIP_UI]: <InlineChip title={title} />, // optional inline
  [TILE_UI]: <GridTile title={title} />,   // optional gallery tile
}));
```

`pattern()` types these variant keys at its return position: each is a `VNode`
or a `JSXElement` (a renderable sub-piece), or a reactive value of one, so a
value of the wrong shape under `[UI]`, `[CHIP_UI]` or `[TILE_UI]` is a compile
error at the pattern.

See `packages/patterns/examples/ui-variants-demo.tsx` for a full example.

> Note: `sidebarUI` is a shell composition **slot**, a separate concept from
> size variants. Other exported subviews such as `settingsUI` are
> application-level conventions; the shell does not consume `fabUI`. A vended
> `uiVariant()` helper for render paths outside `cf-render` is a planned
> follow-up and does not exist yet.

### Views a host draws itself

A rendering is not the only thing a piece can offer. `[VIEWS]` is a single
output key holding **named groups of facts and streams** for a host that draws
with its own toolkit instead of rendering VDOM — a native application, say, or
one built on a different renderer. It is a sibling concept to the variants
above rather than a member of them: not a size, and not a shell slot.

One key rather than one key per view is what keeps discovery cheap: a host
learns what is on offer in one round, where probing well-known names one at a
time would make the common case slow. Two different schemas carry that, and
telling them apart is the thing to get right.

- **The pattern's own result schema** names every group and everything in it.
  A pattern declares `[VIEWS]` as the groups it offers — `{ inboxView:
  InboxView }` — and the emitted schema carries each group by name, each
  member's type, and each `Stream<T>`'s payload schema, which is where a host
  reads the event contract from. Declaring the field `unknown` instead is a
  compile error at the root of a result, for the same reason it is one under
  `[UI]`: see [`unknown`](../concepts/types-and-schemas/unknown.md).
- **A consumer's demand schema** is what that host reads with, and it is free
  to ask for less. Below the root, a consumer may describe a group as
  `unknown` and receive an opaque reference in place of the derived value —
  which is how a host learns *which* groups are on offer without the runtime
  computing any of them, and then reads for real only the one it will draw.

```tsx
import {
  handler,
  NAME,
  pattern,
  type Stream,
  UI,
  VIEWS,
  type Writable,
} from "commonfabric";

interface ThreadRow {
  at: number;
  title: string;
}

interface InboxView {
  threads: ThreadRow[];
  forQuery: string;
  setSearch: Stream<{ query: string }>;
}

const setSearch = handler<{ query: string }, { query: Writable<string> }>(
  ({ query }, state) => state.query.set(query),
);

export default pattern<
  { threads: ThreadRow[]; query: Writable<string> },
  { [NAME]: string; [VIEWS]: { inboxView: InboxView } }
>((state) => ({
  [NAME]: "Inbox",
  // The floor, reading the same values a host would draw itself.
  [UI]: <div>{state.query}</div>,
  // Every offered group, under one key.
  [VIEWS]: {
    inboxView: {
      threads: state.threads,
      forQuery: state.query,
      setSearch: setSearch(state),
    },
  },
}));
```

`pattern()` types `[VIEWS]` as an object and no further: what a group holds is
the pattern's to declare and its consumer's to demand through a schema. Two
properties of a group follow from who draws it.

- **`[UI]` stays the floor.** A host that knows none of the offered groups —
  or holds a schema the value does not satisfy — renders `[UI]`, so a piece
  that offers a group exports a complete `[UI]` as well.
- **A group carries facts, not renderings.** A timestamp beside any label it
  also offers, a count beside any "show 40 earlier", a named tint rather than a
  colour. A host that formats in its own idiom needs the fact; one that cannot
  still has the label.

A group is named output like any other, so nothing here needs a new mechanism:
TypeScript checks it, `resultSchema` carries it — streams and their payload
schemas included — and a member declared for one host under design reaches no
other host, because a reader receives only what its own demand declares.

### The piece context menu

Right-clicking a rendered piece opens `cf-piece-menu` for it. **View source**
shows the piece's retained authored files. **Origin and history** shows its
active origin and recorded source revisions. **Clone fresh piece into new
space** creates a copy with default input data in a unique named space and opens
it. **Clone piece and copy data into new space** instead seeds the copy with
detached snapshots of the selected piece's current input and stateful internal
data. Computed values are recomputed in the new space. Data linked from another
space is rejected because it cannot be captured atomically. Both actions show
their progress and any failure in a dialog. A detached piece becomes the copy's
origin. A piece that already follows an origin passes that origin to the copy.
A followed piece also has **Stop following source**, which keeps the exact
current source and clears the origin. Historical entries can restore
their retained source version or resume following their earlier origin. Each
entry links to its exact retained source. A mutable Fabric piece origin links
to that piece in its own space, and the space fact links to the space's default
piece. The menu warns before applying a structurally incompatible historical
source. Its confirmation remains bound to the exact candidate that produced
the warning.

**Data** shows the piece's argument and result values (both stay live while
the menu is open; linked cells appear as `{"@cell": …}` stubs), and
**Actions** lists the handler streams the piece's declared argument and
result schemas carry and dispatches an event to one, with an optional JSON
payload. A handler only appears if the stream is declared in the pattern's
output (or argument) type — the schema'd read is closed-world, so a handler
returned at runtime behind an index signature is invisible to it. Dispatches
from the menu are accepted-for-delivery acknowledgments (the commit is
asynchronous) and are not renderer-trusted, so a handler gated on UI
provenance will refuse them.

The piece-specific entries are followed by a divider and **Space access
rights...**. That dialog lists the space ACL for every reader. A principal with
`OWNER` access can add identities, change their `READ`, `WRITE`, or `OWNER`
capability, and remove entries. The memory server validates every change and
requires the ACL to retain at least one concrete owner.

The menu comes with `cf-render`. Importing the component registers it. It mounts
itself on `document.body` so a piece's clipping or a tile's scaling cannot reach
it. While the menu or one of its panels is open, the addressed piece carries an
animated light sweep and soft color glow. The visual layer sits over the piece,
does not receive pointer events, and does not change its size or layout. The
menu closes if that renderer disconnects or begins showing another piece.

The innermost rendered piece claims the click, so right-clicking a tile inside a
piece addresses the tile. Three cases keep the browser's own menu instead: a
click on a text entry, a click held with Shift, and a `cf-render` whose cell is a
value inside a piece rather than a whole piece.

Before opening, `cf-render` announces the click as `cf-piece-context-menu`; a host
can cancel that event to show its own menu for the piece instead. The seam is
written up in [host-embedding.md §3a](../../features/host-embedding.md).

---

## cf-screen

Full-height app layout with pinned header, auto-scrolling main area, and pinned
footer. Use instead of `<div style={{ height: "100%" }}>` which doesn't work
(parent has no explicit height).

Content in the default slot scrolls automatically when it overflows. Use
`cf-vscroll` inside `cf-screen` only when you need snap-to-bottom (chat),
fade-edges, or a styled/hidden scrollbar.

```tsx
// Shown for illustration only.
// Simple case — main area scrolls automatically
<cf-screen>
  <cf-heading slot="header" level={2}>Title</cf-heading>
  <cf-vstack gap="4" padding="4">
    {items}
  </cf-vstack>
</cf-screen>

// Chat case — snap-to-bottom + fade-edges
<cf-screen>
  <cf-heading slot="header" level={2}>Chat</cf-heading>
  <cf-vscroll flex snapToBottom fadeEdges>
    {messages}
  </cf-vscroll>
  <cf-message-input slot="footer" />
</cf-screen>
```

---

## cf-empty-state

Centered, muted placeholder for empty lists and regions. Use instead of ad-hoc
`<div style="text-align: center; color: ...; padding: 2rem;">` blocks.

The message comes from the `message` attribute (simple case) or the default
slot. Optional `icon` and `action` slots render above and below the message.

```tsx
// Shown inside a pattern body.
// Simple case — message attribute
{items.get().length === 0
  ? <cf-empty-state message="No items yet. Add one below!" />
  : null}

// With icon and a call to action
<cf-empty-state>
  <span slot="icon">📋</span>
  Your shopping list is empty.
  <cf-button slot="action" size="sm" onClick={addItem}>
    Add first item
  </cf-button>
</cf-empty-state>
```

---

## cf-hover-card

A small card that appears beside its content while the pointer rests on the
content or focus is inside it, as a reaction count shows who reacted. What the
card shows goes in the `card` slot. The card sits above the content, or below
when there is no room above, in the browser's top layer, so no ancestor that
clips its overflow can cut it off, and it follows the content as the page
scrolls. It hides when the pointer and focus have both left. The pointer cannot
reach the card, so what it shows is for reading, not for clicking; to have it
read as a description of its content, point `aria-describedby` from the content
to the element in the `card` slot.

Showing and hiding is the component's own, so hovering runs no handler and
writes no state.

```tsx
// Shown as JSX element children.
<cf-hover-card>
  <cf-button size="sm" aria-describedby="cats-reactors">😺 2</cf-button>
  <cf-vstack id="cats-reactors" slot="card" gap="1">
    <cf-text>Alice</cf-text>
    <cf-text>Bob</cf-text>
  </cf-vstack>
</cf-hover-card>
```

---

## cf-hover-reveal

Content with controls that appear while the pointer rests on it or focus is
inside it, as a chat message shows its reaction button. The controls go in the
`actions` slot and stay laid out while hidden, so revealing them never moves
the content. Set `revealed` to keep them shown, for instance while a picker
they opened is still open. On a device that cannot hover, they are always
shown.

The reveal is the component's own CSS, so hovering runs no handler and writes
no state.

```tsx
// Shown inside a pattern body.
const pickerOpen = new Writable.perSession(false);
const togglePicker = action(() => pickerOpen.set(!pickerOpen.get()));

<cf-hover-reveal revealed={pickerOpen}>
  <cf-text>Lunch at noon?</cf-text>
  <cf-button slot="actions" size="sm" onClick={togglePicker}>
    React
  </cf-button>
</cf-hover-reveal>
```

---

## cf-text

Generic text primitive for non-label typography: captions, helper copy,
metadata, descriptions. Use `cf-label` only when text labels a specific
control.

- `variant` — typography role: `caption`, `body-compact`, `body` (default),
  `body-large`, `heading-sm`, `heading-md`, `heading-lg`
- `tone` — semantic color: `default`, `muted`, `tertiary`, `disabled`,
  `primary`, `success`, `warning`, `error`
- `block` — render as block text instead of inline text
- `truncate` — clip overflowing text to a single line with an ellipsis. Use
  instead of ad-hoc
  `style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap;"`.
  `truncate` implies block display, so combining it with `block` is allowed
  but redundant. The host also gets `min-width: 0` so it shrinks and
  truncates correctly inside flex rows like `cf-hstack`.

```tsx
// Shown inside a pattern body.
// Truncated note next to fixed-width siblings in a row
<cf-hstack gap="2" align="center">
  <cf-text truncate tone="muted">{item.notes}</cf-text>
  <cf-badge size="xs">{item.status}</cf-badge>
</cf-hstack>
```

---

## cf-vstack / cf-hstack

Vertical and horizontal flexbox stacks. Shared layout props:

- `gap` — space between items (`0`–`24` numeric scale or `xs`–`xl`)
- `align` — cross-axis alignment: `start`, `center`, `end`, or `stretch`;
  `cf-hstack` also accepts `baseline`
- `justify` — main-axis alignment: `start`, `center`, `end`, `between`, `around`,
  or `evenly` (for example, `justify="between"` separates two items)
- `reverse` — reverse the direction (`wrap` is cf-hstack only)
- `padding` — uniform padding around the stack (same scale as `gap`)
- `px` / `py` — horizontal / vertical axis padding (same scale)
- `pt` / `pr` / `pb` / `pl` — single-side padding (same scale)

Padding precedence: single-side props (`pt`/`pr`/`pb`/`pl`) override the axis
props (`px`/`py`) on their side, which override the uniform `padding`. Use
these instead of inline `style="padding-top: ..."` overrides.

```tsx
// Shown for illustration only.
// Uniform padding, but tighter on top
<cf-vstack gap="2" padding="4" pt="2">
  {items}
</cf-vstack>

// Axis-only padding
<cf-hstack gap="2" px="4" py="1">
  {toolbarButtons}
</cf-hstack>
```

---

## cf-map

Interactive map component using Leaflet with OpenStreetMap tiles. No API key required.

### Properties

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `value` / `$value` | `MapValue \| Writable<MapValue>` | `{}` | Map data with markers, circles, polylines |
| `center` / `$center` | `LatLng \| Writable<LatLng>` | San Francisco | Map center coordinates (bidirectional) |
| `zoom` / `$zoom` | `number \| Writable<number>` | `13` | Zoom level 0-18 (bidirectional) |
| `bounds` / `$bounds` | `Bounds \| Writable<Bounds>` | - | Visible map bounds (bidirectional) |
| `fitToBounds` | `boolean` | `false` | Auto-fit to show all features |
| `interactive` | `boolean` | `true` | Enable pan/zoom |

### Types

```tsx
// Shown at module scope.
interface LatLng { lat: number; lng: number; }
interface Bounds { north: number; south: number; east: number; west: number; }

interface MapValue {
  markers?: MapMarker[];
  circles?: MapCircle[];
  polylines?: MapPolyline[];
}

interface MapMarker {
  position: LatLng;
  title?: string;
  description?: string;
  icon?: string;        // Emoji or icon name
  popup?: Reactive<any>; // Advanced: pattern reference for rich popup
  draggable?: boolean;
}

interface MapCircle {
  center: LatLng;
  radius: number;       // meters
  color?: string;
  fillOpacity?: number;
  strokeWidth?: number;
  title?: string;
  description?: string;
  popup?: Reactive<any>;
}

interface MapPolyline {
  points: LatLng[];
  color?: string;
  strokeWidth?: number;
  dashArray?: string;   // e.g., "5, 10" for dashed
}
```

### Events

| Event | Detail | Description |
|-------|--------|-------------|
| `cf-click` | `{ lat, lng }` | Map background clicked |
| `cf-bounds-change` | `{ bounds, center, zoom }` | Viewport changed |
| `cf-marker-click` | `{ marker, index, lat, lng }` | Marker clicked |
| `cf-marker-drag-end` | `{ marker, index, position, oldPosition }` | Marker drag completed |
| `cf-circle-click` | `{ circle, index, lat, lng }` | Circle clicked |

**Note:** Polylines do not emit click events. For clickable segments, use circles as waypoints.

### Usage

```tsx
// Shown for illustration only.
// Simple: Display locations
const mapData = {
  markers: stores.map(store => ({
    position: { lat: store.lat, lng: store.lng },
    title: store.name,
    icon: "📍"
  }))
};
<cf-map $value={mapData} fitToBounds />

// Interactive: Click to add marker
<cf-map
  $value={mapData}
  oncf-click={(e) => {
    markers.push({
      position: { lat: e.detail.lat, lng: e.detail.lng },
      title: "New Location",
      draggable: true
    });
  }}
/>

// Draggable markers
<cf-map
  $value={mapData}
  oncf-marker-drag-end={(e) => {
    markers.key(e.detail.index).key("position").set(e.detail.position);
  }}
/>

// Coverage areas with circles
const mapData = {
  circles: areas.map(area => ({
    center: { lat: area.lat, lng: area.lng },
    radius: area.radiusMeters,
    color: area.available ? "#22c55e" : "#ef4444",
    fillOpacity: 0.2,
    title: area.name
  }))
};

// Route visualization
const mapData = {
  polylines: [{
    points: route.waypoints,
    color: "#3b82f6",
    strokeWidth: 4
  }],
  markers: [
    { position: route.start, icon: "🚀" },
    { position: route.end, icon: "🏁" }
  ]
};
```

### Notes

- **Bundle size:** Leaflet adds ~40KB gzipped
- **Zoom range:** 0 (world) to 18 (street level)
- **Default center:** San Francisco (37.7749, -122.4194)
- **Emoji markers:** Use any emoji as the `icon` property
- **Rich popups:** Pass a pattern reference via `popup` for interactive popup content

---

## cf-chart

SVG charting components. Compose mark elements inside a `cf-chart` container.

### Elements

- **`cf-chart`** - Container that discovers child marks, computes scales, renders SVG
- **`cf-line-mark`** - Line series
- **`cf-area-mark`** - Filled area
- **`cf-bar-mark`** - Bar/column chart
- **`cf-dot-mark`** - Scatter/dot plot

### cf-chart Properties

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `height` | `number` | `200` | Chart height in px. Width fills container. |
| `marks` / `$marks` | `MarkConfig[]` | `[]` | Programmatic marks (rendered below children) |
| `xAxis` | `boolean` | `false` | Show x-axis |
| `yAxis` | `boolean` | `false` | Show y-axis |
| `xType` | `"linear"\|"time"\|"band"` | auto | Scale type (auto-detected from data) |
| `yType` | `"linear"\|"log"` | auto | Y scale type |
| `xDomain` | `[min, max]` | auto | Override x domain |
| `yDomain` | `[min, max]` | auto | Override y domain |
| `crosshair` | `boolean` | `true` | Show crosshair on hover |

### Mark Properties (shared)

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `data` / `$data` | `number[]\|object[]` | required | Data array |
| `x` | `string` | index | Key for x accessor |
| `y` | `string` | value | Key for y accessor |
| `color` | `string` | `"#6366f1"` | Stroke/fill color |
| `label` | `string` | - | Label for tooltip |

**cf-line-mark** adds: `strokeWidth` (default 2), `curve` (`"linear"`, `"step"`, `"monotone"`, `"natural"`)

**cf-area-mark** adds: `opacity` (default 0.2), `curve`, `y2` (baseline)

**cf-bar-mark** adds: `opacity` (default 1), `barPadding` (0-1, default 0.2)

**cf-dot-mark** adds: `radius` (default 3)

### Events

| Event | Detail | Description |
|-------|--------|-------------|
| `cf-hover` | `{ x, y, dataX, dataY, nearest }` | Mouse over chart |
| `cf-click` | `{ x, y, dataX, dataY, nearest }` | Chart clicked |
| `cf-leave` | `{}` | Mouse left chart |

### Usage

```tsx
// Shown for illustration only.
// Sparkline (inline, no axes)
<cf-chart height={24} style="width: 80px;">
  <cf-line-mark $data={trend} color="green" />
</cf-chart>

// Line chart with axes
<cf-chart height={200} xAxis yAxis>
  <cf-line-mark $data={prices} x="date" y="price" color="blue" label="AAPL" />
</cf-chart>

// Layered area + line
<cf-chart height={200} xAxis yAxis>
  <cf-area-mark $data={prices} x="date" y="price" color="blue" opacity={0.15} />
  <cf-line-mark $data={prices} x="date" y="price" color="blue" />
</cf-chart>

// Bar chart
<cf-chart height={200} xAxis yAxis>
  <cf-bar-mark $data={monthly} x="month" y="revenue" color="green" label="Revenue" />
</cf-chart>

// Multi-series
<cf-chart height={300} xAxis yAxis>
  <cf-line-mark $data={appl} x="date" y="price" color="blue" label="AAPL" />
  <cf-line-mark $data={goog} x="date" y="price" color="red" label="GOOG" />
</cf-chart>

// Simple number array (auto-indexed x)
<cf-chart height={100}>
  <cf-line-mark $data={[1, 3, 2, 5, 4, 7, 6]} color="#22c55e" />
</cf-chart>
```

### Notes

- **Data auto-detection:** Number arrays auto-index. String x-values use band scale. Date/ISO strings use time scale.
- **Responsive width:** Chart fills its container width. Use CSS to control.
- **Crosshair:** Enabled by default. Shows nearest data point on hover.

---

## Identity components

**Render a person with the identity components — never a bare name string or a
raw `<img>`.** A display name alone is forgeable, hard to recognize at a glance,
and inaccessible. These components give consistent treatment, an accessible name,
and (for the current viewer) a verified seal that user-space cannot forge.

| You are showing… | Use | Why |
| --- | --- | --- |
| **any participant** whose live profile cell you hold — the viewer (via `wish`) or anyone who contributed their cell on join | `cf-profile-badge` bound to that cell | trusted; draws name + avatar + a DID-derived verified seal; cross-space reads resolve for every viewer (CT-1667/1687) |
| a person you hold **only a snapshot** for — a self-contained piece, or an offline remote profile space | `cf-avatar` + their name | untrusted fallback, safe for any value; needs no profile cell |
| a row that **may or may not** carry a profile — one written before the space had profiles, beside rows that do | `cf-profile-badge` with `fallback-name` | one binding for both, so nothing has to test a cell-typed field for presence; the name shows only where no profile resolves |

`cf-profile-badge` is the one preferred way to render an identity; `cf-avatar` is
the explicit fallback for when no live profile cell is available.

`fallback-name` is for the mixed case only, and it is **untrusted**: it renders
where no profile value resolved, never beside the verification seal, and never
over a profile that resolved without a name — such a profile reads as unknown
rather than borrowing the caller's string. A name a caller supplies can never
acquire the treatment a resolved cell earns, which is what makes the seal worth
reading. See
[multi-user-patterns → Presenting Identity](../patterns/multi-user-patterns.md#presenting-identity)
for the end-to-end flow (resolve the viewer, store each joiner's profile cell, mark "me").

### cf-avatar

Untrusted avatar primitive — safe for any code to render, for any person.

```tsx
// Shown for illustration only.
<cf-avatar name="Ada Lovelace" src={person.avatar} size="sm" /> // data: URI image
<cf-avatar name="Grace Hopper" src="🦊" />                       // emoji glyph
<cf-avatar name="Alan Turing" />                                 // initials "AT"
```

- `src`: a `data:` URI image, an emoji/glyph, or `""`. **Only `data:` URIs render
  as an image** — `http(s)`, `blob:`, and path URLs degrade to initials and are
  never fetched (no tracking/exfil beacon).
- `name`: drives the initials fallback and the accessible label — always set it.
- `size`: `xs | sm | md | lg | xl`. `shape`: `circle | square`.

Use `cf-avatar` as the **fallback** when you hold only a snapshot of a person — a
self-contained piece, or a participant whose remote profile space is offline. When
you have the live profile cell (which you do for every participant who joined by
contributing it), prefer `cf-profile-badge`.

### cf-profile-badge

Trusted presentation of **a participant's profile** — the viewer's own, or anyone
whose profile cell you stored on join. Bind a profile **cell** (not strings) via
`$profile`; it renders name + avatar + a verified seal derived from the owner's
identity that user-space cannot mint.

```tsx
// Shown for illustration only.
const profileWish = wish({ query: "#profile" }); // resolves the viewer's profile cell
...
<cf-profile-badge $profile={profileWish.result} size="sm" />
```

- `$profile`: a profile **cell** — the viewer's own is
  `wish({ query: "#profile" }).result` (the `.result`, not the wish object); for
  other participants, bind the profile cell they contributed to the shared roster
  on join.
- `size`: `xs | sm | md | lg | xl`.
- The verified seal only appears for a live, runtime-attested profile cell (it
  will not show in stories or `--no-run` checks — that is expected, not a failure).
- **Every participant** with a stored profile cell can be badged — not just the
  viewer. Cross-space profile reads resolve for any authorized viewer (CT-1667/1687),
  so store each person's `#profile` cell in the shared `PerSpace` roster on join and
  bind `$profile={p.profile}`. See
  [multi-user-patterns → Presenting Identity](../patterns/multi-user-patterns.md#presenting-identity)
  and the live demo `packages/patterns/profile-roster-live-demo.tsx`. Only fall back
  to `cf-avatar` when you deliberately hold just a snapshot.
- ⚠️ **Bind it at a STATIC `[UI]` position.** Like every `$`-bidirectional binding
  (`$value`, `$checked`, …), `$profile` must be bound where the JSX is constructed
  once — **never inside a `{computed(() => …)}` subtree**. Inside a computed the
  cell is auto-unwrapped to a plain value and the renderer throws *"Bidirectionally
  bound property $profile is not reactive"*, blanking the whole pattern. Resolve
  `wish({query:"#profile"})` once and place the badge in the static JSX; gate only
  its *siblings* reactively, or use `ifElse(cond, staticA, staticB)` as a child of a
  static wrapper. Repro: `packages/patterns/scope-bug-computed-vnode-blank/`.

---

## cf-owner-view

`cf-owner-view` checks whether the runtime's authenticated principal matches
the single root `represents-principal` attestation on `$originator`. It writes
the result to the per-user boolean `$result` cell and renders no content of its
own. A missing, unreadable, or conflicting attestation leaves the result false.
The component does not use the selected `#profile`, which may represent a
different persona. The predicate selects presentation; CFC labels govern reads.

## cf-share-snapshot

`cf-share-snapshot` reviews a copy of a source cell before releasing that copy
to another user or space. Bind `$source` to the JSON value to review,
`$recipient` to a live profile or space cell, and `$result` to a writable cell
that will receive the released cell link. In pattern JSX, set `audienceKind` to
`user` (the default) or `space`. The native HTML attribute is `audience-kind`.

The authenticated host checks the source against its runtime read ceiling. When
the host has no runtime-wide ceiling, the source must fit the confirming user's
own `User` ceiling. This permits the default shell to share the user's private
draft while refusing a source labeled only for another user.

The host displays the exact snapshot and the audience verified by the runtime in
a native modal dialog. Its disclosure and preview are fixed host UI. The user
must confirm with a trusted browser gesture; a scripted click cannot publish.
The source stays private, and future changes are not included in the copy. JSON
values containing links are refused.

Changing a binding, dismissing the dialog, or disconnecting the component
invalidates its preview. The runtime refuses a commit when the source or
verified audience changed after preparation. Once the released link is stored
successfully, the component emits `cf-shared` with no payload. A consuming
handler reads its bound result cell; the event does not carry source values or
identity claims.

## cf-custody-seal

`cf-custody-seal` seals the actor's draft into the custody of a room's trusted
declassifier policy, as the [custody seal](../../specs/cfc-custody-seal.md)
specifies. Bind `$draft` to the value to seal, `$terms` to the room's terms
document, `$policy` to a cell holding the room's custody policy reference, and
`$sources` to the actor's source policy: a list of the actor's own `Context`
and `Resource` atoms in the actor's home space.

The button opens a native modal dialog. Its first part comes from what the
runtime read and checked, not from anything the pattern renders: the room space;
who can read it now, and so see the answer, including the room space's own key;
the seats; the policy that decides what comes out, shown by the manifest digest
a statement in the runtime's trust configuration names (the host declares it,
and an attach cannot change it), beside the symbol and module the room's
reference names; and which of the actor's sources go in. Each reader, seat and
the room is shown in a bidirectionally isolated element of its own, with the
dialog's annotations (`you`, `no seat`, `Anyone`) as separate elements beside
it. The room's owners can add readers after the seal, and the dialog says so.
Its second part, set apart, is what the room's terms say: the `question` and the
`answers` the terms list, and, for `k` distinct answers, the bound of `log₂ k`
bits on what one of them reveals. Nothing checks that the room's policy releases
only the listed answers, so the dialog states the bound as conditional on it.
Room-authored text is shown with control, format (direction overrides and
zero-width characters among them) and line-separator characters removed and is
capped in length. The exact sealed values and the terms are under a collapsed
details section.

The actor confirms with one trusted browser gesture on **Seal & consent**; a
scripted click cannot seal. Changing a binding, dismissing the dialog, or
disconnecting the component invalidates the review, and the runtime refuses a
seal when the draft, the terms, the room's policy, the room's readers or the
actor's source policy changed after preparation, up to the moment the entry is
written. When the seal commits, the component emits
`cf-sealed` with no payload. The event carries neither the value nor the
actor's entry in the room. A binding that changes while a commit is in flight
leaves the component without that event even if the seal committed, so a
pattern that must know should read the room rather than rely on it.

## CFC Authorship

`cf-cfc-authorship` can enforce text-integrity policy for its children when
`verifyTextIntegrity` is set. If `requiredTextIntegrity` or `requiredIntegrity`
is provided, the renderer uses that explicit atom list.

When no explicit requirement is provided and `$author`/`author` is a cell whose
CFC label carries `represents-principal` at its root or on its top-level fields
(a profile's owner-protected fields carry its owner's), the renderer infers a
required `{ kind: "authored-by", subject }` atom for each principal those atoms
name. One principal is the usual case; for an author naming several, text must
carry `authored-by` for each of them. With no principal and no explicit
requirement, the boundary admits no cell text at all. This means a cell-backed
author can make previously display-only text require matching authorship
integrity. Use an explicit `requiredTextIntegrity` when a component needs a
different policy, and avoid cell-backed `$author` for purely decorative author
names.

The component itself checks its value's `authored-by` against the same
principal, and marks the content verified when they match. When either check
matches a principal claim, it reads the atom only as the object the runtime
writes, `{ kind, subject }`, taking the subject exactly as written and ignoring
any other field; a `represents-principal` subject counts only when it is a
well-formed DID, and the `authored-by:<subject>` string form is not read. The
component's own badge verifies only the kinds `authored-by` and
`represents-principal`; an explicit `requiredTextIntegrity` or
`requiredIntegrity` list is matched as given.
