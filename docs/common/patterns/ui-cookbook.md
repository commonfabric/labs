# UI Cookbook

This page is intentionally compact. It gives agents a few theme-forward UI
scaffolds they can adapt without needing to invent every layout from scratch.

Use it together with:

- `docs/common/patterns/style.md`
- `docs/common/components/COMPONENTS.md`
- `patterns/dev/catalog/stories/vignette-recipe-story.tsx`
- `patterns/dev/catalog/stories/vignette-finance-story.tsx`

## 1. Theme-First Shell

Use this as the starting point for almost any polished surface.

```tsx
const theme = {
  fontFamily: "'Avenir Next', 'Segoe UI', sans-serif",
  borderRadius: "1rem",
  density: "comfortable" as const,
  colorScheme: "light" as const,
  colors: {
    primary: "#1f6feb",
    primaryForeground: "#ffffff",
    background: "#f7f8fb",
    surface: "#ffffff",
    surfaceHover: "#f0f3f9",
    text: "#0f172a",
    textMuted: "#667085",
    border: "#d8dee9",
    borderMuted: "#e8ecf3",
    accent: "#f97316",
    accentForeground: "#ffffff",
    success: "#16a34a",
    successForeground: "#ffffff",
    error: "#dc2626",
    errorForeground: "#ffffff",
    warning: "#d97706",
    warningForeground: "#ffffff",
  },
};

<cf-theme theme={theme}>
  <cf-screen>
    <cf-heading slot="header" level={2}>Pattern</cf-heading>
    <cf-vstack gap="4" padding="4">
      {/* main content — scrolls automatically */}
    </cf-vstack>
  </cf-screen>
</cf-theme>;
```

Why this is the default:

- one theme object establishes a visual system early
- `cf-screen` gives a reliable full-surface container with auto-scrolling main area
- `cf-vstack` keeps spacing and grouping readable
- add `cf-vscroll` only when you need snap-to-bottom (chat), fade-edges, or styled scrollbar

## 2. Mobile App Vignette

Use when the UI should feel like a focused mobile product rather than a raw
tool form.

```tsx
// Shown as JSX element children.
<cf-theme theme={theme}>
  <div
    style={{
      minHeight: "100%",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      padding: "2.5rem",
      background: "linear-gradient(160deg, #0b1020 0%, #19233b 100%)",
    }}
  >
    <div
      style={{
        width: "375px",
        height: "720px",
        borderRadius: "2.5rem",
        overflow: "hidden",
        boxShadow: "0 24px 60px rgba(0,0,0,0.3)",
        background: "var(--cf-theme-color-background)",
      }}
    >
      <cf-vstack gap="4" padding="6">
        <cf-hstack justify="between" align="center">
          <cf-vstack gap="1">
            <cf-text variant="caption" tone="muted">Today</cf-text>
            <cf-heading level={2}>Spending overview</cf-heading>
          </cf-vstack>
          <cf-badge>Live</cf-badge>
        </cf-hstack>

        <cf-card style="--cf-card-color-surface: var(--cf-theme-color-surface-hover);">
          <cf-vstack slot="content" gap="3">
            <cf-text variant="caption" tone="muted">Monthly budget</cf-text>
            <cf-heading level={1}>$2,480</cf-heading>
            <cf-button>Review categories</cf-button>
          </cf-vstack>
        </cf-card>
      </cf-vstack>
    </div>
  </div>
</cf-theme>
```

Use this when you want:

- a strong, self-contained aesthetic frame
- a mobile-first hierarchy
- a vignette that demonstrates the theme system clearly

If you switch this vignette over to `cf-screen`, the body content scrolls
automatically. Add `cf-vscroll` only if you need snap-to-bottom or fade-edges.

## 3. Editorial Detail Layout

Use when the pattern centers on one record, note, recipe, or project.

```tsx
// Shown as JSX element children.
<cf-theme theme={theme}>
  <cf-screen>
    <cf-heading slot="header" level={2}>Details</cf-heading>
    <cf-vstack gap="4" padding="4">
      <cf-card>
        <cf-vstack slot="content" gap="3">
          <cf-text variant="caption" tone="muted">Overview</cf-text>
          <cf-heading level={2}>Primary details</cf-heading>
          {/* main fields */}
        </cf-vstack>
      </cf-card>
      <cf-card>
        <cf-vstack slot="content" gap="3">
          <cf-heading level={3}>Secondary section</cf-heading>
          <cf-input placeholder="Notes" />
        </cf-vstack>
      </cf-card>
    </cf-vstack>
  </cf-screen>
</cf-theme>
```

## 4. Empty State With Intent

Use when first-run or zero-data states matter. They always do more than you
think.

```tsx
// Shown for illustration only.
<cf-theme theme={theme}>
  <cf-card
    style="
      --cf-card-color-surface: var(--cf-theme-color-surface-hover);
      --cf-card-color-border: var(--cf-theme-color-border-muted);
    "
  >
    <cf-vstack slot="content" gap="3" align="center">
      <cf-badge variant="secondary">Start here</cf-badge>
      <cf-heading level={3}>No entries yet</cf-heading>
      <cf-text tone="muted">Add your first item to turn this into a live workspace.</cf-text>
      <cf-button>Create item</cf-button>
    </cf-vstack>
  </cf-card>
</cf-theme>
```

## 5. Catalog References

Use these when you want a concrete aesthetic starting point instead of a blank
page:

- `patterns/dev/catalog/stories/vignette-recipe-story.tsx`
  Warm serif editorial recipe app.
- `patterns/dev/catalog/stories/vignette-finance-story.tsx`
  Dark metric-heavy finance dashboard.

When creating new examples, try to add new aesthetic directions rather than
converging on the same look repeatedly.

For drag-and-drop interactions (`cf-drag-source` / `cf-drop-zone`), see the
worked example in [drag-and-drop](meta/drag-and-drop.md).

## Working Rule

The cookbook should help an agent get to:

- a coherent theme object
- a layout built from `cf-*` primitives
- a UI that feels designed on purpose

It should not encourage cargo-cult copying or one-off style piles.
