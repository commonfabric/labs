/**
 * Styles for cf-radio-group component
 */

export const radioGroupStyles = `
  :host {
    display: block;
    box-sizing: border-box;

    /* Default spacing values */
    --spacing: 0.5rem;

    /* Radio button styling */
    --radio-size: 1rem;
    --radio-border-color: var(--cf-theme-color-border, #e2e8f0);
    --radio-checked-color: var(--cf-theme-color-primary, #0f172a);
    --radio-background: var(--cf-theme-color-background, #ffffff);
    --radio-focus-ring: var(--cf-theme-color-primary, #94a3b8);
  }

  *,
  *::before,
  *::after {
    box-sizing: inherit;
  }

  :host([disabled]) {
    cursor: not-allowed;
    opacity: 0.7;
  }

  .radio-group {
    display: flex;
    flex-direction: column;
    gap: var(--spacing, 0.5rem);
  }

  /* Support for horizontal layout */
  :host([orientation="horizontal"]) .radio-group {
    flex-direction: row;
    flex-wrap: wrap;
    align-items: center;
  }

  /* Ensure proper spacing between radio buttons and their labels */
  ::slotted(cf-radio) {
    margin: 0;
  }

  /* When used with labels */
  ::slotted(label) {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    cursor: pointer;
  }

  :host([disabled]) ::slotted(label) {
    cursor: not-allowed;
  }

  /*
  ** Styles for items-based rendering
  */

  .radio-item {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    cursor: pointer;
    user-select: none;
    font-family: var(--cf-theme-font-family, inherit);
    font-size: 0.875rem;
    line-height: 1.25rem;
    color: var(--cf-theme-color-text, #111827);
  }

  .radio-item.disabled {
    cursor: not-allowed;
    opacity: 0.5;
  }

  /* Hide native radio input but keep it accessible */
  .radio-item input[type="radio"] {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border-width: 0;
  }

  /* Custom radio indicator */
  .radio-indicator {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
    width: var(--radio-size, 1rem);
    height: var(--radio-size, 1rem);
    border: 1px solid var(--radio-border-color, #e2e8f0);
    border-radius: 50%;
    background-color: var(--radio-background, #ffffff);
    transition: all 150ms cubic-bezier(0.4, 0, 0.2, 1);
    flex-shrink: 0;
  }

  /* Radio dot */
  .radio-dot {
    width: calc(var(--radio-size, 1rem) / 2);
    height: calc(var(--radio-size, 1rem) / 2);
    border-radius: 50%;
    background-color: var(--radio-checked-color, #0f172a);
    opacity: 0;
    transform: scale(0);
    transition: all 150ms cubic-bezier(0.4, 0, 0.2, 1);
  }

  /* Checked state */
  .radio-item.checked .radio-indicator {
    border-color: var(--radio-checked-color, #0f172a);
  }

  .radio-item.checked .radio-dot {
    opacity: 1;
    transform: scale(1);
  }

  /* Focus state */
  .radio-item input[type="radio"]:focus-visible + .radio-indicator {
    outline: 2px solid transparent;
    outline-offset: 2px;
    box-shadow:
      0 0 0 2px var(--radio-background, #fff),
      0 0 0 4px var(--radio-focus-ring, #94a3b8);
  }

  /* Hover state */
  .radio-item:not(.disabled):hover .radio-indicator {
    border-color: var(--radio-checked-color, #0f172a);
  }

  /* Animation for selection */
  .radio-item.checked .radio-dot {
    animation: radio-dot-animation 200ms ease-out;
  }

  @keyframes radio-dot-animation {
    0% {
      transform: scale(0);
    }
    50% {
      transform: scale(1.2);
    }
    100% {
      transform: scale(1);
    }
  }

  /* Label styling */
  .radio-label {
    flex: 1;
  }
`;
