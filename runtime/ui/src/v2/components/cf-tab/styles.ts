/**
 * Styles for UI Tab component
 */

export const tabStyles = `
  :host {
    display: inline-block;
  }

  .tab {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    white-space: nowrap;
    cursor: pointer;
    user-select: none;
    padding: var(--cf-spacing-2) var(--cf-spacing-4);
    border: none;
    background: transparent;
    border-radius: var(--cf-border-radius-md);
    font-family: var(--cf-font-family-sans);
    font-size: var(--cf-font-size-sm);
    font-weight: var(--cf-font-weight-medium);
    line-height: var(--cf-line-height-normal);
    color: var(--cf-colors-gray-700);
    transition: all var(--cf-theme-animation-duration, 150ms)
      var(--cf-transition-timing-ease);
    outline: none;
    position: relative;
  }

  .tab:hover:not([data-disabled="true"]) {
    color: var(--cf-colors-gray-900);
    background-color: var(--cf-colors-gray-200);
  }

  .tab:focus-visible {
    box-shadow: 0 0 0 2px var(--cf-colors-primary-500);
  }

  .tab[data-selected="true"] {
    color: var(--cf-colors-gray-900);
    background-color: white;
    box-shadow: var(--cf-shadow-sm);
  }

  .tab[data-disabled="true"] {
    opacity: 0.5;
    cursor: not-allowed;
    color: var(--cf-colors-gray-500);
  }

  /* Vertical orientation adjustments */
  :host-context(cf-tab-list[orientation="vertical"]) .tab {
    width: 100%;
    justify-content: flex-start;
  }

  /* Chip variant styles */
  :host([data-variant="chip"]) .tab[data-selected="true"]::after {
    display: none;
  }

  :host([data-variant="chip"]) .tab {
    border-radius: var(--cf-border-radius-full, 9999px);
    padding: var(--cf-pill-sm-padding-v, 2px) var(--cf-pill-sm-padding-h, 10px);
    font-size: var(--cf-pill-sm-font-size, var(--cf-size-sm-font-size, 11px));
    line-height: var(--cf-pill-sm-line-height, var(--cf-size-sm-line-height, 16px));
    min-height: var(--cf-pill-sm-min-height, var(--cf-size-sm-height, 24px));
    color: var(--cf-theme-color-text-muted, #6b7280);
    background: transparent;
    border: 1px solid transparent;
  }

  :host([data-variant="chip"]) .tab:hover:not([data-disabled="true"]):not([data-selected="true"]) {
    background: var(--cf-theme-color-surface-hover, var(--cf-colors-gray-200, #eceef1));
    color: var(--cf-theme-color-text, #111827);
  }

  :host([data-variant="chip"]) .tab[data-selected="true"] {
    background: var(--cf-theme-color-surface, var(--cf-colors-gray-100, #f2f3f6));
    border: 1px solid var(--cf-theme-color-border, var(--cf-colors-gray-300, #d5d7dd));
    color: var(--cf-theme-color-text, var(--cf-colors-gray-900, #16181d));
    font-weight: var(--cf-font-weight-medium, 500);
    box-shadow: none;
  }
`;
