/**
 * Design tokens as CSS variables for web components
 * This file exports the CSS variables for use in shadow DOM
 */

// The variables below derive from `--cf-theme-*` tokens, so each is declared
// by the components that consume it, not by every component's base styles. A
// custom property's `var()` resolves where it is declared: declared on every
// host, a recipe is fixed by each component to the theme around it, and a tint
// inside that component (a nested `cf-theme`, or `--cf-theme-*` set by any
// element) never reaches a card or a pill beneath. Declared on the consumer's
// own host, it derives from the theme the consumer itself is in.

/** The pill radius, for badges, chips and tags. */
export const pillGeometryCSS = `
  --cf-pill-border-radius: var(
    --cf-theme-border-radius-full,
    var(--cf-border-radius-full, 9999px)
  );
`;

/** The surface recipes, for cards, modals and toasts. */
export const surfaceRecipesCSS = `
  /*
   * Shared surface recipes
   * Components like cards, modals, and toasts should consume these shared
   * tier tokens instead of defining independent radius, padding, border,
   * or elevation values inline.
   */
  --cf-surface-plain-border-radius: var(
    --cf-theme-border-radius,
    var(--cf-border-radius-lg, 0.5rem)
  );
  --cf-surface-plain-background: var(--cf-theme-color-surface, #ffffff);
  --cf-surface-plain-border: 1px solid var(
    --cf-theme-color-border,
    #e5e7eb
  );
  --cf-surface-plain-padding: var(--cf-spacing-4);
  --cf-surface-plain-box-shadow: var(--cf-shadow-none);

  --cf-surface-elevated-border-radius: var(--cf-surface-plain-border-radius);
  --cf-surface-elevated-background: var(--cf-surface-plain-background);
  --cf-surface-elevated-border: var(--cf-surface-plain-border);
  --cf-surface-elevated-padding: var(--cf-surface-plain-padding);
  --cf-surface-elevated-box-shadow: var(
    --cf-shadow-md,
    0 4px 6px -1px rgba(0, 0, 0, 0.1),
    0 2px 4px -1px rgba(0, 0, 0, 0.06)
  );

  --cf-surface-overlay-border-radius: var(--cf-surface-plain-border-radius);
  --cf-surface-overlay-background: var(--cf-theme-color-background, #ffffff);
  --cf-surface-overlay-border: var(--cf-surface-plain-border);
  --cf-surface-overlay-padding: var(--cf-spacing-4) var(--cf-spacing-5);
  --cf-surface-overlay-box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.25);
  --cf-surface-overlay-sheet-box-shadow: 0 -4px 24px rgba(0, 0, 0, 0.15);

  --cf-surface-transient-border-radius: var(--cf-surface-plain-border-radius);
  --cf-surface-transient-background: color-mix(
    in srgb,
    var(--cf-theme-color-surface, #f8fafc) 85%,
    transparent
  );
  --cf-surface-transient-border: 1px solid var(
    --cf-theme-color-border,
    #e2e8f0
  );
  --cf-surface-transient-padding: 0.625rem 0.875rem;
  --cf-surface-transient-box-shadow: 0 4px 16px rgba(0, 0, 0, 0.08);
`;

export const variablesCSS = `
  /*
   * Canonical token namespaces:
   * - --cf-colors-* defines the base palette and literal ramps.
   * - --cf-theme-* is the runtime semantic contract emitted by theme-context.ts.
   * - The deprecated singular cf-color namespace must not be introduced in v2 components.
   */

  /* Colors - Primary (Figma blue ramp) */
  --cf-colors-primary-50: #eef2fe;
  --cf-colors-primary-100: #d5dffd;
  --cf-colors-primary-200: #b3c5fb;
  --cf-colors-primary-300: #8da8fa;
  --cf-colors-primary-400: #6b8ffa;
  --cf-colors-primary-500: #4979fa;
  --cf-colors-primary-600: #3e6af7;
  --cf-colors-primary-700: #376bf9;
  --cf-colors-primary-800: #2a54d4;
  --cf-colors-primary-900: #1e3faa;

  /* Colors - Gray (aligned to Figma slate) */
  --cf-colors-gray-50: #ffffff;
  --cf-colors-gray-100: #f2f3f6;
  --cf-colors-gray-200: #eceef1;
  --cf-colors-gray-300: #d5d7dd;
  --cf-colors-gray-400: #b3b6bc;
  --cf-colors-gray-500: #94979e;
  --cf-colors-gray-600: #5b5f65;
  --cf-colors-gray-700: #404349;
  --cf-colors-gray-800: #34373c;
  --cf-colors-gray-900: #16181d;

  /* Colors - Semantic */
  --cf-colors-success: #21c17b;
  --cf-colors-warning: #e5a126;
  --cf-colors-error: #ff6057;
  --cf-colors-info: #4979fa;

  /* Colors - Slate (Figma design system, canonical names) */
  --cf-colors-slate-000: #ffffff;
  --cf-colors-slate-100: #f2f3f6;
  --cf-colors-slate-150: #eceef1;
  --cf-colors-slate-300: #d5d7dd;
  --cf-colors-slate-400: #b3b6bc;
  --cf-colors-slate-450: #94979e;
  --cf-colors-slate-550: #5b5f65;
  --cf-colors-slate-600: #404349;
  --cf-colors-slate-700: #34373c;

  /* Colors - Named (Figma design system) */
  --cf-colors-white: #ffffff;
  --cf-colors-blue-50: #eff6ff;
  --cf-colors-blue-100: #dbeafe;
  --cf-colors-blue: #4979fa;
  --cf-colors-blue-500: #3b82f6;
  --cf-colors-blue-600: #2563eb;
  --cf-colors-blue-dark: #376bf9;
  --cf-colors-blue-a10: rgba(73, 121, 250, 0.1);
  --cf-colors-blue-a20: rgba(73, 121, 250, 0.15);
  --cf-colors-blue-a90: rgba(73, 121, 250, 0.9);

  --cf-colors-purple: #8952fd;
  --cf-colors-purple-dark: #632cda;
  --cf-colors-purple-a10: rgba(137, 82, 253, 0.1);
  --cf-colors-purple-a20: rgba(137, 82, 253, 0.15);

  --cf-colors-red: #ff6057;
  --cf-colors-red-50: #fef2f2;
  --cf-colors-red-100: #fee2e2;
  --cf-colors-red-200: #fecaca;
  --cf-colors-red-500: #ef4444;
  --cf-colors-red-600: #dc2626;
  --cf-colors-red-700: #b91c1c;
  --cf-colors-red-dark: #eb4747;
  --cf-colors-red-a10: rgba(255, 96, 87, 0.1);
  --cf-colors-red-a20: rgba(255, 96, 87, 0.15);

  --cf-colors-green-50: #f0fdf4;
  --cf-colors-green-100: #dcfce7;
  --cf-colors-green: #21c17b;
  --cf-colors-green-500: #22c55e;
  --cf-colors-green-600: #16a34a;
  --cf-colors-coral: #fc856d;
  --cf-colors-indigo: #5b53ff;

  /* Colors - Light alpha ramp */
  --cf-colors-alpha-00: rgba(13, 18, 24, 0);
  --cf-colors-alpha-03: rgba(37, 45, 54, 0.03);
  --cf-colors-alpha-06: rgba(46, 53, 64, 0.06);
  --cf-colors-alpha-10: rgba(54, 63, 74, 0.1);
  --cf-colors-alpha-20: rgba(79, 89, 103, 0.15);

  /* Typography - Font Family */
  --cf-font-family-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --cf-font-family-mono: Consolas, Monaco, "Andale Mono", "Ubuntu Mono", monospace;

  /* Typography - Font Size */
  --cf-font-size-xs: 0.75rem;
  --cf-font-size-sm: 0.875rem;
  --cf-font-size-base: 1rem;
  --cf-font-size-lg: 1.125rem;
  --cf-font-size-xl: 1.25rem;
  --cf-font-size-2xl: 1.5rem;
  --cf-font-size-3xl: 1.875rem;
  --cf-font-size-4xl: 2.25rem;

  /* Typography - Font Weight */
  --cf-font-weight-light: 300;
  --cf-font-weight-normal: 400;
  --cf-font-weight-medium: 500;
  --cf-font-weight-semibold: 600;
  --cf-font-weight-bold: 700;

  /* Typography - Line Height */
  --cf-line-height-none: 1;
  --cf-line-height-tight: 1.25;
  --cf-line-height-snug: 1.375;
  --cf-line-height-normal: 1.5;
  --cf-line-height-relaxed: 1.625;
  --cf-line-height-loose: 2;

  /*
   * Typography roles
   * Use these semantic roles in components instead of hardcoded font-size,
   * font-weight, line-height, or letter-spacing declarations.
   */
  --cf-font-caption-size: 0.75rem;
  --cf-font-caption-line-height: 1rem;
  --cf-font-caption-weight: 500;
  --cf-font-caption-letter-spacing: 0;

  --cf-font-body-compact-size: 0.8125rem;
  --cf-font-body-compact-line-height: 1.25rem;
  --cf-font-body-compact-weight: 500;
  --cf-font-body-compact-letter-spacing: 0;

  --cf-font-body-size: 0.875rem;
  --cf-font-body-line-height: 1.25rem;
  --cf-font-body-weight: 400;
  --cf-font-body-letter-spacing: 0;

  --cf-font-body-large-size: 1rem;
  --cf-font-body-large-line-height: 1.5rem;
  --cf-font-body-large-weight: 400;
  --cf-font-body-large-letter-spacing: 0;

  --cf-font-heading-sm-size: 1.125rem;
  --cf-font-heading-sm-line-height: 1.5rem;
  --cf-font-heading-sm-weight: 600;
  --cf-font-heading-sm-letter-spacing: 0;

  --cf-font-heading-md-size: 1.25rem;
  --cf-font-heading-md-line-height: 1.75rem;
  --cf-font-heading-md-weight: 600;
  --cf-font-heading-md-letter-spacing: 0;

  --cf-font-heading-lg-size: 1.5rem;
  --cf-font-heading-lg-line-height: 2rem;
  --cf-font-heading-lg-weight: 600;
  --cf-font-heading-lg-letter-spacing: -0.025em;

  /*
   * Spacing
   * Layout utility props like gap="4" and padding="2" map directly to
   * this shared spacing namespace.
   */
  --cf-spacing-0: 0;
  --cf-spacing-1: 0.25rem;
  --cf-spacing-2: 0.5rem;
  --cf-spacing-3: 0.75rem;
  --cf-spacing-4: 1rem;
  --cf-spacing-5: 1.25rem;
  --cf-spacing-6: 1.5rem;
  --cf-spacing-8: 2rem;
  --cf-spacing-10: 2.5rem;
  --cf-spacing-12: 3rem;
  --cf-spacing-16: 4rem;
  --cf-spacing-20: 5rem;
  --cf-spacing-24: 6rem;
  --cf-spacing-xs: 0.125rem;
  --cf-spacing-sm: var(--cf-spacing-1);
  --cf-spacing-md: var(--cf-spacing-2);
  --cf-spacing-lg: var(--cf-spacing-3);
  --cf-spacing-xl: var(--cf-spacing-4);

  /* Border Radius */
  --cf-border-radius-none: 0;
  --cf-border-radius-sm: 0.125rem;
  --cf-border-radius-base: 0.25rem;
  --cf-border-radius-md: 0.375rem;
  --cf-border-radius-lg: 0.5rem;
  --cf-border-radius-xl: 0.75rem;
  --cf-border-radius-2xl: 1rem;
  --cf-border-radius-3xl: 1.5rem;
  --cf-border-radius-full: 9999px;

  /* Coordinated Sizing Scale (Figma) */
  --cf-size-xs-height: 16px;
  --cf-size-xs-radius: 4px;
  --cf-size-xs-icon-lg: 12px;
  --cf-size-xs-icon-md: 8px;
  --cf-size-xs-icon-sm: 6px;
  --cf-size-xs-spacing: 2px;
  --cf-size-xs-padding-h: 4px;
  --cf-size-xs-padding-v: 2px;
  --cf-size-xs-font-size: 9px;
  --cf-size-xs-line-height: 12px;

  --cf-size-sm-height: 24px;
  --cf-size-sm-radius: 5px;
  --cf-size-sm-icon-lg: 16px;
  --cf-size-sm-icon-md: 12px;
  --cf-size-sm-icon-sm: 10px;
  --cf-size-sm-spacing: 4px;
  --cf-size-sm-padding-h: 6px;
  --cf-size-sm-padding-v: 4px;
  --cf-size-sm-font-size: 11px;
  --cf-size-sm-line-height: 16px;

  --cf-size-md-height: 32px;
  --cf-size-md-radius: 8px;
  --cf-size-md-icon-lg: 20px;
  --cf-size-md-icon-md: 16px;
  --cf-size-md-icon-sm: 12px;
  --cf-size-md-spacing: 8px;
  --cf-size-md-padding-h: 8px;
  --cf-size-md-padding-v: 8px;
  --cf-size-md-font-size: 12px;
  --cf-size-md-line-height: 16px;

  --cf-size-lg-height: 40px;
  --cf-size-lg-radius: 9px;
  --cf-size-lg-icon-lg: 24px;
  --cf-size-lg-icon-md: 20px;
  --cf-size-lg-icon-sm: 16px;
  --cf-size-lg-spacing: 12px;
  --cf-size-lg-padding-h: 12px;
  --cf-size-lg-padding-v: 8px;
  --cf-size-lg-font-size: 16px;
  --cf-size-lg-line-height: 20px;

  --cf-size-xl-height: 48px;
  --cf-size-xl-radius: 10px;
  --cf-size-xl-icon-lg: 28px;
  --cf-size-xl-icon-md: 24px;
  --cf-size-xl-icon-sm: 20px;
  --cf-size-xl-spacing: 16px;
  --cf-size-xl-padding-h: 16px;
  --cf-size-xl-padding-v: 12px;
  --cf-size-xl-font-size: 18px;
  --cf-size-xl-line-height: 24px;

  /*
   * Shared pill geometry
   * Badge, chip, and button[variant="pill"] keep separate semantics and
   * colors, but they should share the same compact rounded size contract.
   */
  --cf-pill-xs-min-height: var(--cf-size-xs-height);
  --cf-pill-xs-padding-h: 6px;
  --cf-pill-xs-padding-v: 1px;
  --cf-pill-xs-gap: var(--cf-size-xs-spacing);
  --cf-pill-xs-font-size: var(--cf-size-xs-font-size);
  --cf-pill-xs-line-height: var(--cf-size-xs-line-height);

  --cf-pill-sm-min-height: var(--cf-size-sm-height);
  --cf-pill-sm-padding-h: 10px;
  --cf-pill-sm-padding-v: 2px;
  --cf-pill-sm-gap: var(--cf-size-sm-spacing);
  --cf-pill-sm-font-size: var(--cf-size-sm-font-size);
  --cf-pill-sm-line-height: var(--cf-size-sm-line-height);

  --cf-pill-md-min-height: var(--cf-size-md-height);
  --cf-pill-md-padding-h: 12px;
  --cf-pill-md-padding-v: 4px;
  --cf-pill-md-gap: var(--cf-size-md-spacing);
  --cf-pill-md-font-size: var(--cf-size-md-font-size);
  --cf-pill-md-line-height: var(--cf-size-md-line-height);

  --cf-pill-lg-min-height: var(--cf-size-lg-height);
  --cf-pill-lg-padding-h: 14px;
  --cf-pill-lg-padding-v: 6px;
  --cf-pill-lg-gap: var(--cf-size-lg-spacing);
  --cf-pill-lg-font-size: var(--cf-size-lg-font-size);
  --cf-pill-lg-line-height: var(--cf-size-lg-line-height);

  --cf-pill-xl-min-height: var(--cf-size-xl-height);
  --cf-pill-xl-padding-h: 18px;
  --cf-pill-xl-padding-v: 8px;
  --cf-pill-xl-gap: var(--cf-size-xl-spacing);
  --cf-pill-xl-font-size: var(--cf-size-xl-font-size);
  --cf-pill-xl-line-height: var(--cf-size-xl-line-height);

  /* Shadows */
  --cf-shadow-sm: 0 1px 2px 0 rgba(0, 0, 0, 0.05);
  --cf-shadow-base: 0 1px 3px 0 rgba(0, 0, 0, 0.1), 0 1px 2px 0 rgba(0, 0, 0, 0.06);
  --cf-shadow-md: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06);
  --cf-shadow-lg: 0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -2px rgba(0, 0, 0, 0.05);
  --cf-shadow-xl: 0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04);
  --cf-shadow-none: none;

  /* Transitions - Duration */
  --cf-transition-duration-fast: 150ms;
  --cf-transition-duration-base: 200ms;
  --cf-transition-duration-slow: 300ms;

  /* Transitions - Timing */
  --cf-transition-timing-ease: cubic-bezier(0.4, 0, 0.2, 1);
  --cf-transition-timing-ease-in: cubic-bezier(0.4, 0, 1, 1);
  --cf-transition-timing-ease-out: cubic-bezier(0, 0, 0.2, 1);
  --cf-transition-timing-ease-in-out: cubic-bezier(0.4, 0, 0.2, 1);
  --cf-transition-timing-spring: cubic-bezier(0.34, 1.56, 0.64, 1);
  --cf-transition-timing-sheet: cubic-bezier(0.32, 0.72, 0, 1);

  /*
   * Shared structural dimensions. Components may expose component-specific
   * aliases, but these provide a common default vocabulary for overlays,
   * transient surfaces, prose, and container-aware layouts.
   */
  --cf-layout-breakpoint-sm: 640px;
  --cf-layout-breakpoint-md: 768px;
  --cf-layout-breakpoint-lg: 1024px;
  --cf-layout-width-sm: 320px;
  --cf-layout-width-md: 500px;
  --cf-layout-width-lg: 700px;
  --cf-layout-width-transient-min: 240px;
  --cf-layout-width-transient-max: 420px;
  --cf-layout-width-prose: 700px;

  /* Z-index */
  --cf-z-index-auto: auto;
  --cf-z-index-0: 0;
  --cf-z-index-10: 10;
  --cf-z-index-20: 20;
  --cf-z-index-30: 30;
  --cf-z-index-40: 40;
  --cf-z-index-50: 50;
  --cf-z-index-100: 100;
  --cf-z-index-1000: 1000;

  /* Backdrop Blur */
  --cf-backdrop-blur-sm: 4px;
  --cf-backdrop-blur-md: 8px;
  --cf-backdrop-blur-lg: 16px;
  --cf-backdrop-blur-xl: 24px;

  /* Translucent Surfaces */
  --cf-surface-translucent: rgba(255, 255, 255, 0.72);
  --cf-surface-translucent-strong: rgba(255, 255, 255, 0.88);
  --cf-overlay-dim: rgba(0, 0, 0, 0.4);

  /* Z-index — Semantic Layers */
  --cf-z-layer-sticky: 10;
  --cf-z-layer-fixed: 500;
  --cf-z-layer-fab: 900;
  --cf-z-layer-sheet: 950;
  --cf-z-layer-overlay: 1000;
  --cf-z-layer-toast: 1100;
`;
