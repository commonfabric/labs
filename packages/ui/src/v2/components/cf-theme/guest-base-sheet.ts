/**
 * The stylesheet `cf-theme` provides to every iframe guest beneath it, after
 * the `:root` block of its `--cf-theme-*` values and ahead of the guest's own
 * styles, written against those custom properties alone, so that guest HTML
 * wears the look of the page around it. This is the sheet to point an author
 * of guest HTML at: style with these elements, the `cf-*` classes and the
 * variables, and spell no color or font, since every literal below is a
 * `var()` fallback for a value the theme does not supply.
 *
 * The whole sheet sits in the `cf-guest-base` cascade layer, and unlayered
 * rules outrank layered ones whatever their specificity, so every rule of the
 * guest's own styles wins over it: a plain
 * `button { background: ... }` holds while the button is hovered, disabled or
 * focused.
 *
 * `html, body { font-size }` takes the theme's size, which redefines `rem`
 * inside the guest: the theme's size is the guest's root size on purpose.
 *
 * Classes:
 * - `cf-surface`: the raised ground of a panel.
 * - `cf-card`: a bordered, padded, rounded surface.
 * - `cf-inset`: a recessed ground, for wells and code.
 * - `cf-pill`: a small, fully rounded label.
 * - `cf-muted`: secondary text.
 * - `cf-primary`, `cf-accent`, `cf-brand`: solid fills with their ink.
 * - `cf-success`, `cf-warning`, `cf-danger`: status fills with their ink.
 * - `cf-stack`, `cf-row`: vertical and horizontal flex layout with the theme's
 *   gap.
 */
export const GUEST_BASE_SHEET = `@layer cf-guest-base {
html, body {
  background: var(--cf-theme-color-background, #f2f3f6);
  color: var(--cf-theme-color-text, #34373c);
  font-family: var(--cf-theme-font-family, system-ui, sans-serif);
  font-size: var(--cf-theme-font-size, 1rem);
  line-height: 1.5;
}
h1, h2, h3, h4, h5, h6 {
  color: var(--cf-theme-color-text, #34373c);
  font-family: var(--cf-theme-font-family, system-ui, sans-serif);
  font-weight: 600;
  line-height: 1.25;
  margin: 0 0 var(--cf-theme-spacing-loose, 0.65rem);
}
a {
  color: var(--cf-theme-color-primary, #4979fa);
}
button, input, select, textarea {
  font: inherit;
  color: var(--cf-theme-color-text, #34373c);
  background: var(--cf-theme-color-surface, #ffffff);
  border: 1px solid var(--cf-theme-color-border, rgba(79, 89, 103, 0.15));
  border-radius: var(--cf-theme-border-radius, 0.5rem);
  padding: var(--cf-theme-spacing-normal, 0.29rem)
    var(--cf-theme-spacing-loose, 0.65rem);
}
button {
  cursor: pointer;
  transition: background var(--cf-theme-animation-duration, 200ms);
}
button:where(:not(.cf-primary, .cf-accent, .cf-brand, .cf-success, .cf-warning, .cf-danger)):hover {
  background: var(--cf-theme-color-surface-hover, #f9fafb);
}
button:disabled, input:disabled, select:disabled, textarea:disabled {
  color: var(--cf-theme-color-text-disabled, rgba(0, 0, 0, 0.3));
  background: var(--cf-theme-color-surface-disabled, #e4e6ea);
  cursor: default;
}
:focus-visible {
  outline: 2px solid var(--cf-theme-color-primary, #4979fa);
  outline-offset: 1px;
}
code, pre, kbd, samp {
  font-family: var(--cf-theme-font-mono, ui-monospace, monospace);
}
pre, .cf-inset {
  background: var(--cf-theme-color-surface-tertiary, #e4e6ea);
  border-radius: var(--cf-theme-border-radius, 0.5rem);
  padding: var(--cf-theme-spacing-padding-block, 0.58rem);
}
hr {
  border: 0;
  border-top: 1px solid var(--cf-theme-color-border, rgba(79, 89, 103, 0.15));
}
.cf-surface, .cf-card {
  background: var(--cf-theme-color-surface, #ffffff);
  color: var(--cf-theme-color-text, #34373c);
}
.cf-card {
  border: 1px solid var(--cf-theme-color-border, rgba(79, 89, 103, 0.15));
  border-radius: var(--cf-theme-border-radius, 0.5rem);
  padding: var(--cf-theme-spacing-loose, 0.65rem);
}
.cf-pill {
  display: inline-block;
  border-radius: var(--cf-theme-border-radius-full, 9999px);
  padding: var(--cf-theme-spacing-tight, 0.125rem)
    var(--cf-theme-spacing-loose, 0.65rem);
  background: var(--cf-theme-color-secondary, #f2f3f6);
  color: var(--cf-theme-color-secondary-foreground, #34373c);
}
.cf-muted {
  color: var(--cf-theme-color-text-muted, #71747a);
}
.cf-primary {
  background: var(--cf-theme-color-primary, #4979fa);
  color: var(--cf-theme-color-primary-foreground, #ffffff);
  border-color: transparent;
}
.cf-accent {
  background: var(--cf-theme-color-accent, #fc856d);
  color: var(--cf-theme-color-accent-foreground, #ffffff);
  border-color: transparent;
}
.cf-brand {
  background: var(--cf-theme-color-brand, #8952fd);
  color: var(--cf-theme-color-brand-foreground, #ffffff);
  border-color: transparent;
}
.cf-success {
  background: var(--cf-theme-color-success, #21c17b);
  color: var(--cf-theme-color-success-foreground, #ffffff);
  border-color: transparent;
}
.cf-warning {
  background: var(--cf-theme-color-warning, #e5a126);
  color: var(--cf-theme-color-warning-foreground, #ffffff);
  border-color: transparent;
}
.cf-danger {
  background: var(--cf-theme-color-error, #ff6057);
  color: var(--cf-theme-color-error-foreground, #ffffff);
  border-color: transparent;
}
.cf-primary:hover, .cf-accent:hover, .cf-brand:hover {
  filter: brightness(0.92);
}
.cf-stack, .cf-row {
  display: flex;
  gap: var(--cf-theme-spacing-loose, 0.65rem);
}
.cf-stack {
  flex-direction: column;
}
.cf-row {
  align-items: center;
  flex-wrap: wrap;
}
}
`;
