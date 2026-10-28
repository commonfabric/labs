# Pattern Styling and Theme Guide

This is the current agent-facing guide for styling Common Fabric patterns with
`cf-*` components.

Use this page when you are in a UI polish or UI design pass and need to make a
pattern feel intentional, distinctive, and coherent rather than merely
functional.

A pattern inherits the theme of the host it runs in: the host, or a `cf-theme`
around the pattern, puts one look in effect, and every `cf-*` component inside
draws it. A pattern may tint that theme with a nested `cf-theme` carrying only
what it changes, such as `{ accentColor }`, and inherits the rest. It never
declares a full theme, and never writes out a color or a font anywhere but in
that tint.

## Why This System Works This Way

Common Fabric UI is designed for composition across opaque subtrees.

- Theme and public component affordances are the styling boundary.
- Restyle embedded UI by wrapping it in `cf-theme`, not by reaching into its
  internals.
- Start with component defaults, then use theme tokens, then use documented
  component-specific overrides for local refinement.
- If a needed visual treatment cannot be expressed that way, treat it as a
  design-system gap to address explicitly, or as an `iframe` / artifact case
  where you take full control yourself.

This is intentionally more opinionated than general-purpose CSS. The goal is
safe, composable UI that still gives agents enough room to form a strong visual
point of view.

## Start Here

For pattern-building work, use this guidance stack in order:

1. `docs/common/patterns/style.md`
2. `docs/common/patterns/ui-cookbook.md`
3. `docs/common/components/COMPONENTS.md`
4. `packages/ui/README.md`
5. `packages/ui/LLM-COMPONENT-INSTRUCTIONS.md`

## Design Brief Before Coding

Before writing JSX, decide these things explicitly:

1. **Purpose**: What is the user trying to do here?
2. **Tone**: What visual direction fits the task? Choose something concrete:
   editorial, soft, luxurious, utilitarian, playful, raw, retro-futurist,
   etc.
3. **Memorable hook**: What is the one thing someone should remember about this
   interface?
4. **Constraint strategy**: How will you get there with `cf-*` components and
   public styling hooks over the host's theme? What the pattern changes in that
   theme is a tint: a nested `cf-theme` naming only what differs, never a full
   theme of its own.

Do not settle into a generic default app shell. Commit to a direction and make
the UI clearly about that direction.

## Smallest Button Retheme

If the task is just "make this button look different", wrap the button in a
small `cf-theme` and set semantic tokens. Do not reach into the button's shadow
DOM.

```tsx
const buttonTheme = {
  borderRadius: "999px",
  colors: {
    primary: "#121826",
    primaryForeground: "#ffffff",
  },
};

<cf-theme theme={buttonTheme}>
  <cf-button color="primary" variant="solid" size="lg">
    Save changes
  </cf-button>
</cf-theme>;
```

This changes the filled primary button's background, text color, hover family,
and radius for that subtree. Use the same pattern around a larger section when
several controls should share the treatment.

## Theme-First Workflow

This is host and story authoring, where a full theme is declared; a pattern
inside a host tints, see the opening.

When polishing a non-trivial UI, default to this workflow:

1. Define a `theme` object first.
2. Wrap the main surface in `<cf-theme theme={theme}>`.
3. Build the layout with `cf-screen`, `cf-vstack`, `cf-hstack`, `cf-vgroup`,
   `cf-hgroup`, `cf-card`, and other `cf-*` primitives.
4. Content in `cf-screen`'s default slot scrolls automatically when it
   overflows. Use `cf-vscroll` only when you need snap-to-bottom behavior,
   fade edges, or a styled/hidden scrollbar. Use `cf-hscroll` for wide
   tabular content.
5. Let the theme carry most of the typography, color, radius, density, and
   motion decisions.
6. Use component-specific CSS custom properties only for local emphasis or
   targeted refinement.

If `cf-theme` is unavailable in the environment, fall back gracefully. If it is
available, prefer it over scattered one-off overrides.

## `cf-theme` Usage

`cf-theme` merges a partial theme object over the theme of the `cf-theme`
around it, or over the default Common Fabric theme when there is none, and
applies CSS custom properties to a subtree. A nested `cf-theme` sets only the
properties its partial changes; the rest inherit.

A pattern tints the theme it runs in, naming only what it changes:

```tsx
const theme = {
  accentColor: "#c84c09",
  fontFace: "'Georgia', 'Times New Roman', serif",
};

<cf-theme theme={theme}>
  <cf-screen>
    <cf-heading slot="header" level={2}>Budget tracker</cf-heading>
    <cf-vstack gap="4" padding="4">
      {/* themed UI */}
    </cf-vstack>
  </cf-screen>
</cf-theme>;
```

A host or a story declares a full theme (every color, `colorScheme`,
`density`) the same way, with a complete object in place of the tint.

## Full-Height Layout Rule

`cf-screen` is a full-surface frame with a pinned header, an auto-scrolling
main area, and a pinned footer.

- Put ordinary vertical content directly in the default slot; it scrolls when
  it overflows.
- Use `cf-vscroll` inside `cf-screen` only when you need snap-to-bottom
  behavior, fade edges, or a styled/hidden scrollbar.
- If the layout is wider than one viewport, introduce a deliberate `cf-hscroll`
  region.
- Do not rely on document scrolling around `cf-screen`; the scroll boundary is
  the component's main area.

Verified top-level theme fields:

- `fontFamily`
- `monoFontFamily`
- `fontSize`
- `borderRadius`
- `density`
- `colorScheme`
- `animationSpeed`
- `roundness`
- `scale`
- `motion`
- `colors`

Supported `colors` keys:

- Core: `primary`, `primaryForeground`, `secondary`,
  `secondaryForeground`, `background`, `surface`, `surfaceHover`, `text`,
  `textMuted`, `border`, `borderMuted`, `success`, `successForeground`,
  `error`, `errorForeground`, `warning`, `warningForeground`, `accent`,
  `accentForeground`
- Extended: `brand`, `brandForeground`, `textTertiary`, `textDisabled`,
  `surfaceDisabled`, `surfacePressed`, `surfaceTertiary`, `surfaceInverse`,
  `textOnColorSecondary`, `textOnInverse`, `textPressed`

Supported pattern-style aliases:

- `accentColor`
- `fontFace`

See:

- `packages/ui/src/v2/components/cf-theme/cf-theme.ts`
- `packages/ui/src/v2/components/theme-context.ts`

## What `cf-theme` Emits

`cf-theme` applies concrete CSS custom properties to the themed subtree.

### Typography, Radius, Motion

- `--cf-theme-font-family`
- `--cf-theme-mono-font-family`
- `--cf-theme-font-size`
- `--cf-theme-border-radius`
- `--cf-theme-border-radius-full`
- `--cf-theme-animation-duration`

Compatibility aliases are also emitted for older components:

- `--cf-theme-font-mono`

### Colors

- `--cf-theme-color-primary`
- `--cf-theme-color-primary-foreground`
- `--cf-theme-color-secondary`
- `--cf-theme-color-secondary-foreground`
- `--cf-theme-color-background`
- `--cf-theme-color-surface`
- `--cf-theme-color-surface-hover`
- `--cf-theme-color-text`
- `--cf-theme-color-text-muted`
- `--cf-theme-color-border`
- `--cf-theme-color-border-muted`
- `--cf-theme-color-success`
- `--cf-theme-color-success-foreground`
- `--cf-theme-color-error`
- `--cf-theme-color-error-foreground`
- `--cf-theme-color-warning`
- `--cf-theme-color-warning-foreground`
- `--cf-theme-color-accent`
- `--cf-theme-color-accent-foreground`
- `--cf-theme-color-brand`
- `--cf-theme-color-brand-foreground`
- `--cf-theme-color-text-tertiary`
- `--cf-theme-color-text-disabled`
- `--cf-theme-color-surface-disabled`
- `--cf-theme-color-surface-pressed`
- `--cf-theme-color-surface-tertiary`
- `--cf-theme-color-surface-inverse`
- `--cf-theme-color-text-on-color-secondary`
- `--cf-theme-color-text-on-inverse`
- `--cf-theme-color-text-pressed`

Derived and compatibility color variables:

- `--cf-theme-color-error-surface`
- `--cf-theme-color-error-light`
- `--cf-theme-color-primary-light`
- `--cf-theme-color-success-light`
- `--cf-theme-color-muted`
- `--cf-theme-color-text-secondary`
- `--cf-theme-{background,border,border-muted,error,primary,success,surface,surface-hover,text,text-muted}`
- `--cf-theme-color-{primary,accent,danger}-{pressed,soft,subtle}`
- `--cf-theme-color-status-{info,success,warning,error}`
- `--cf-theme-color-status-{info,success,warning,error}-{pressed,soft,subtle,foreground}`

### Spacing

- `--cf-theme-spacing-tight`
- `--cf-theme-spacing-normal`
- `--cf-theme-spacing-loose`
- `--cf-theme-spacing-padding-message`
- `--cf-theme-spacing-padding-code`
- `--cf-theme-spacing-padding-block`
- `--cf-theme-spacing`
- `--cf-theme-spacing-compact`
- `--cf-theme-padding`

These are the right starting point for most visual decisions.

## Component-Specific Refinement

After setting a theme, refine individual components through their documented
custom properties rather than by guessing at internal DOM structure.

Examples from current component implementations:

- `cf-card`
  - `--cf-card-color-surface`
  - `--cf-card-color-border`
  - `--cf-card-border-radius`
- `cf-button`
  - `--cf-button-color-primary`
  - `--cf-button-color-surface`
  - `--cf-button-border-radius`
- `cf-input`
  - `--cf-input-color-border`
  - `--cf-input-color-primary`
  - `--cf-input-border-radius`
- `cf-badge`
  - `--cf-badge-color-primary`
  - `--cf-badge-color-secondary`
- `cf-hstack` / `cf-vstack`
  - `--cf-hstack-gap-*`, `--cf-hstack-padding-*`
  - `--cf-vstack-gap-*`, `--cf-vstack-padding-*`

Use these local overrides when a single component needs special treatment. Do
not use them as a substitute for defining an overall theme.

## Aesthetic Guidance

This is host and story authoring, where a full theme is declared; a pattern
inside a host tints, see the opening.

### Typography

- Prefer distinctive local font stacks or deliberate pairings.
- Avoid generic Arial/Inter/system defaults unless the concept is intentionally
  plain.
- Use the theme to make typography consistent across the surface.

### Color

- Choose one dominant palette with a clear accent.
- Prefer strong foreground/background contrast and intentional muted tones over
  evenly distributed safe neutrals.
- Let `background`, `surface`, `text`, `border`, `primary`, and `accent` do
  most of the work.

### Composition

- Use layout primitives first: `cf-screen`, `cf-vstack`, `cf-hstack`,
  `cf-vgroup`, `cf-hgroup`, `cf-card`, `cf-vscroll`, `cf-hscroll`.
- Group related information. Avoid raw form dumps.
- Make overflow explicit. A polished full-height layout is still broken if the
  lower sections cannot be reached.
- Use whitespace, overlap, layered surfaces, or asymmetry when the concept
  calls for it.

### Atmosphere

- Use gradients, borders, shadows, translucency, or textures when they support
  the chosen direction.
- Keep decorative detail coherent with the theme. Maximalism still needs
  discipline; minimalism still needs character.

## Working Examples

This is host and story authoring, where a full theme is declared; a pattern
inside a host tints, see the opening.

Use these as concrete references for theme-forward UI composition:

- `packages/patterns/catalog/stories/vignette-recipe-story.tsx`
  Warm editorial light theme with serif typography and layered surfaces.
- `packages/patterns/catalog/stories/vignette-finance-story.tsx`
  Dark dashboard-style theme with strong contrast and metric cards.
- `packages/patterns/catalog/stories/`
  Component stories for smaller component-specific usage.

## Avoid

- generic, unopinionated default shells
- scattered hard-coded colors without a shared theme object
- guessed shadow-internal selectors
- styling every element manually instead of using the theme and component
  variables
- copying production pattern data flow just to borrow a visual look

## Working Rule

If the UI needs to look polished, the first question should usually be:

> What is the theme and what is the visual point of view?

Not:

> Which random inline styles should I add to make this less plain?
