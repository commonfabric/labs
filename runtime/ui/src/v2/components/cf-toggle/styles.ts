/**
 * Styles for cf-toggle component
 */

export const toggleStyles = `
  :host {
    --cf-toggle-height: var(--cf-size-md-height, 32px);
    --cf-toggle-height-sm: var(--cf-size-sm-height, 24px);
    --cf-toggle-height-lg: var(--cf-size-lg-height, 40px);
    --cf-toggle-padding-x: var(--cf-size-md-padding-h, 8px);
    --cf-toggle-padding-x-sm: var(--cf-size-sm-padding-h, 6px);
    --cf-toggle-padding-x-lg: var(--cf-size-lg-padding-h, 12px);
    --cf-toggle-font-size: var(--cf-size-md-font-size, 12px);
    --cf-toggle-font-size-sm: var(--cf-size-sm-font-size, 11px);
    --cf-toggle-font-size-lg: var(--cf-size-lg-font-size, 16px);

    /* Default color values if not provided */
    --cf-toggle-color-background: var(--cf-theme-color-background, #ffffff);
    --cf-toggle-color-foreground: var(--cf-theme-color-text, #0f172a);
    --cf-toggle-color-muted: var(--cf-theme-color-surface, #f8fafc);
    --cf-toggle-color-muted-foreground: var(--cf-theme-color-text-muted, #64748b);
    --cf-toggle-color-accent: var(--cf-theme-color-surface-hover, #f1f5f9);
    --cf-toggle-color-accent-foreground: var(--cf-theme-color-text, #0f172a);
    --cf-toggle-color-border: var(--cf-theme-color-border, #e2e8f0);
    --cf-toggle-color-ring: var(--cf-theme-color-primary, #94a3b8);

    display: inline-block;
  }

  button {
    all: unset;
    box-sizing: border-box;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    white-space: nowrap;
    border-radius: 0.375rem;
    font-weight: 500;
    transition: all 150ms cubic-bezier(0.4, 0, 0.2, 1);
    cursor: pointer;
    user-select: none;
    -webkit-user-select: none;
    position: relative;
    font-family: inherit;
    line-height: 1;
    height: var(--cf-toggle-height);
    padding: 0 var(--cf-toggle-padding-x);
    font-size: var(--cf-toggle-font-size);
  }

  button:focus-visible {
    outline: 2px solid transparent;
    outline-offset: 2px;
    box-shadow: 0 0 0 2px var(--cf-toggle-color-background, #fff), 0 0 0 4px var(--cf-toggle-color-ring, #94a3b8);
  }

  button:disabled {
    pointer-events: none;
    opacity: 0.5;
  }

  /* Size variants */
  .size-xs {
    height: var(--cf-size-xs-height, 16px);
    padding: 0 var(--cf-size-xs-padding-h, 4px);
    font-size: var(--cf-size-xs-font-size, 9px);
  }

  .size-sm {
    height: var(--cf-toggle-height-sm);
    padding: 0 var(--cf-toggle-padding-x-sm);
    font-size: var(--cf-toggle-font-size-sm);
  }

  .size-lg {
    height: var(--cf-toggle-height-lg);
    padding: 0 var(--cf-toggle-padding-x-lg);
    font-size: var(--cf-toggle-font-size-lg);
  }

  .size-xl {
    height: var(--cf-size-xl-height, 48px);
    padding: 0 var(--cf-size-xl-padding-h, 16px);
    font-size: var(--cf-size-xl-font-size, 18px);
  }


  /* Default variant */
  .variant-default {
    background-color: transparent;
    color: var(--cf-toggle-color-foreground, #0f172a);
  }

  .variant-default:hover:not(:disabled) {
    background-color: var(--cf-toggle-color-muted, #f8fafc);
    color: var(--cf-toggle-color-foreground, #0f172a);
  }

  .variant-default.pressed {
    background-color: var(--cf-toggle-color-accent, #f1f5f9);
    color: var(--cf-toggle-color-accent-foreground, #0f172a);
  }

  .variant-default.pressed:hover:not(:disabled) {
    background-color: var(--cf-toggle-color-accent, #f1f5f9);
    opacity: 0.9;
  }

  /* Outline variant */
  .variant-outline {
    border: 1px solid var(--cf-toggle-color-border, #e2e8f0);
    background-color: transparent;
    color: var(--cf-toggle-color-foreground, #0f172a);
  }

  .variant-outline:hover:not(:disabled) {
    background-color: var(--cf-toggle-color-accent, #f1f5f9);
    color: var(--cf-toggle-color-accent-foreground, #0f172a);
  }

  .variant-outline.pressed {
    background-color: var(--cf-toggle-color-accent, #f1f5f9);
    color: var(--cf-toggle-color-accent-foreground, #0f172a);
  }

  .variant-outline.pressed:hover:not(:disabled) {
    background-color: var(--cf-toggle-color-accent, #f1f5f9);
    opacity: 0.9;
  }

  /* Host states */
  :host([disabled]) {
    pointer-events: none;
    opacity: 0.5;
  }

  /* Slot styles */
  ::slotted(*) {
    pointer-events: none;
  }
`;
