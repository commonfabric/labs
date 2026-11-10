---
name: pattern-ui
description: Design and polish pattern UIs with cf- components - theme-first styling via cf-theme, layout with cf-screen/cf-vstack, two-way binding ($value/$checked), and PerSession/PerUser/PerSpace UI-state scoping. Use when styling pattern JSX or writing a UI design doc.
user-invocable: false
---

# UI Polish Phase

In a build/polish pass, apply this only after logic is verified and tests pass.
In a design phase, use this guidance to write the UI design document — specify
theme, layout composition, and state scoping; do not write implementation code.

## Read First, In Order

- `docs/common/components/COMPONENTS.md` - Full component reference; consult on
  demand before assuming a component does or does not exist
- one vignette story for the closest tone:
  `patterns/dev/catalog/stories/vignette-recipe-story.tsx` (warm, editorial
  light) or `patterns/dev/catalog/stories/vignette-finance-story.tsx` (dark,
  dashboard-style)
- `docs/common/patterns/style.md` - for deeper rationale behind the theme-first
  guidance this skill already digests

If needed:

- `docs/common/patterns/ui-cookbook.md` - Themed layout scaffolds and vignette
  references
- `docs/common/patterns/two-way-binding.md` - $value, $checked bindings
- `runtime/ui/README.md` - Current notes on CSS custom properties and parts
- `runtime/ui/LLM-COMPONENT-INSTRUCTIONS.md` - Agent-oriented component and
  theme system notes

## Visual Priorities

Aim for:

- clear visual hierarchy
- consistent spacing rhythm
- calm grouping and sectioning
- usable empty and first-run states
- controls that support the main task rather than dominating the screen
- a memorable aesthetic point of view rather than a generic default app shell

## Design Brief Before Coding

Before touching JSX (or, in a design phase, as the core of the design doc),
decide all of the following:

- **Purpose**: What is this interface helping the user do?
- **Tone**: Pick a concrete direction such as editorial, playful, luxurious,
  brutalist, retro-futurist, soft, or utilitarian.
- **Hook**: What is the one visual idea someone will remember?
- **State lifetime**: Which UI state is shared, user-specific, or session-only?
- **Constraint strategy**: How will you get that look with `cf-*` components,
  local fonts, and public CSS custom properties?

Do not drift into an undifferentiated default. Commit to a direction and execute
it cleanly.

Treat transient UI state as part of the design brief, not as incidental
implementation detail. Active tab, selected item, selected room, open modal,
local filter text, and focused item should usually be `PerSession<>`. A useful
test: if the user opens the same instance in a new tab, should this state carry
over? If not, it is probably `PerSession<>`. User preferences, display names,
and personal drafts are usually `PerUser<>`. Shared records and canonical
content are usually `PerSpace<>`.

## Theme-First Workflow

When polishing a non-trivial UI, default to this workflow:

1. Define a `theme` object first.
2. Wrap the main surface in `<cf-theme theme={theme}>`.
3. Compose the layout with `cf-screen`, `cf-vstack`, `cf-hstack`, `cf-vgroup`,
   `cf-hgroup`, and `cf-card`.
4. Content in `cf-screen`'s default slot scrolls automatically when it
   overflows. Use `cf-vscroll` only when you need snap-to-bottom (chat),
   fade-edges, or styled scrollbar. Use `cf-hscroll` for wide tabular content.
5. Let the theme carry most of the color / type / radius / density decisions.
6. Use component-specific custom properties only for local emphasis or one-off
   refinement.

If `cf-theme` is clearly unavailable in the environment, fall back gracefully.
Otherwise, prefer it over scattered ad hoc overrides.

## Why This Works

- Embedded UI should be themed through context and public styling hooks, not by
  inspecting or mutating its internals.
- The component set is intentionally opinionated. Defaults plus theme tokens
  should carry most of the visual system.
- If public theme/hooks are not enough, treat that as either a design-system gap
  worth naming or an `iframe` / artifact case, not an excuse to guess at
  unsupported structure.

## Core Layout & Form Set (not exhaustive)

Layout: `cf-theme`, `cf-screen`, `cf-vstack`, `cf-hstack`, `cf-vgroup`,
`cf-hgroup`, `cf-card`, `cf-vscroll`, `cf-hscroll` Input: `cf-input`,
`cf-textarea`, `cf-checkbox`, `cf-select` Action: `cf-button`, `cf-chip`
Display: `cf-label`, `cf-heading`, `cf-badge`, `cf-alert`

Many more exist — `cf-modal`, `cf-tabs`, `cf-table`, `cf-switch`,
`cf-radio-group`, `cf-slider`, `cf-progress`, `cf-toast`, `cf-avatar`,
`cf-accordion`, ... — check `docs/common/components/COMPONENTS.md` before
concluding a component doesn't exist.

If a needed component doesn't exist, name the design-system gap in your output;
do not create Lit components or use component internals (`applyThemeToElement`,
`@consume`, shadow selectors) — component authoring is the `lit-component`
skill's domain, for `runtime/ui` work only. In pattern JSX the theme is passed
as `theme={...}`, not Lit's `.theme=${...}`.

## Aesthetic Guidance

- **Typography**: Prefer distinctive local font stacks and thoughtful pairings.
  Avoid generic Arial/Inter/system defaults unless the brief is intentionally
  austere.
- **Color**: Use a dominant palette with a clear accent, not evenly distributed
  safe colors.
- **Composition**: Use overlap, asymmetry, controlled density, or deliberate
  whitespace when the concept calls for it.
- **Atmosphere**: Use gradients, layered surfaces, borders, shadows, or subtle
  texture when they reinforce the chosen direction.
- **Restraint**: Minimal interfaces still need precision and a point of view.

Avoid generic AI-looking UI: timid white cards, purple-gradient-on-white
defaults, or layouts that read like a raw form dump.

## Key Patterns

**Two-way binding:**

```tsx
<cf-input $value={field} />
<cf-checkbox $checked={done} />
```

If a control is already bound to a cell, usually via `$value` or `$checked`, do
not add a change handler that simply writes the same value back into that same
cell. Use handlers only for dependent state updates or other side effects.

**Scoped UI state:**

```ts
interface MultiUserUiState {
  sharedBoard: PerSpace<Board>;
  displayName: PerUser<string | Default<"">>;
  selectedCard: PerSession<CardSelection | Default<{}>>;
}
```

Use ordinary data-shaped inputs when the public API should stay simple. Use
`Writable` cell aliases inside the scope wrapper when handlers need stable cell
handles for `.key(...)`, `.equals(...)`, or per-item bindings.

**Layout structure:**

```tsx
<cf-screen>
  <cf-heading slot="header" level={2}>My Pattern</cf-heading>
  <cf-vstack gap="4" padding="4">
    <cf-hstack gap="3">
      {/* horizontal items — scrolls automatically if content overflows */}
    </cf-hstack>
  </cf-vstack>
</cf-screen>;
```

**Theme wrapper:**

```tsx
const theme = {
  fontFamily: "'Georgia', 'Times New Roman', serif",
  borderRadius: "1rem",
  density: "comfortable" as const,
  colorScheme: "light" as const,
  colors: {
    primary: "#8b4513",
    primaryForeground: "#fff8f0",
    background: "#fff8f0",
    surface: "#fff0e0",
    text: "#2c1810",
    textMuted: "#8b7355",
    border: "#e8d5c0",
    accent: "#c84c09",
    accentForeground: "#fff8f0",
  },
};

<cf-theme theme={theme}>
  <cf-screen>
    <cf-heading slot="header" level={2}>My Pattern</cf-heading>
    <cf-vstack gap="4" padding="4">
      {/* ... */}
    </cf-vstack>
  </cf-screen>
</cf-theme>;
```

## Reference Existing Patterns

Prefer these before browsing arbitrary pattern code:

- `patterns/dev/catalog/stories/vignette-recipe-story.tsx`
- `patterns/dev/catalog/stories/vignette-finance-story.tsx`
- component stories in `patterns/dev/catalog/stories/`

Use existing production patterns only when you specifically need to understand a
domain flow, not as the first place to copy styling from.

## Done When

In a design phase, the artifact is the design doc, not a rendering UI: done when
the doc commits to a theme, layout composition, and explicit UI-state scoping.
In a build/polish pass:

- UI renders correctly
- Bindings work (typing updates state)
- No regression in data behavior
- layout and grouping feel intentional
- empty or first-run states are not neglected
- a `cf-theme` strategy is used intentionally when available
- the result has a clear visual idea rather than a generic default shell
- full-height layouts use `cf-screen` (auto-scrolls); `cf-vscroll` only for
  chat/fade-edges
- transient UI state has explicit scope; tab-local state is `PerSession<>`
  unless cross-session persistence is intentional
