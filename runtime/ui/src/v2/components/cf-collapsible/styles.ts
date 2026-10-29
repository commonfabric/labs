export const collapsibleStyles = `
  :host {
    display: block;
    width: 100%;
  }

  .collapsible {
    position: relative;
  }

  .trigger-wrapper {
    width: 100%;
    display: flex;
    align-items: center;
    gap: var(--cf-size-md-spacing, 8px);
    cursor: pointer;
  }

  /* Content wrapper for animation */
  .content-wrapper {
    overflow: hidden;
    transition: height var(--cf-theme-animation-duration, 150ms)
      var(--cf-transition-timing-ease);
    height: 0;
    will-change: height;
  }

  .collapsible.open .content-wrapper {
    transition: height var(--cf-theme-animation-duration, 150ms)
      var(--cf-transition-timing-ease);
  }

  .content {
    padding-top: 0.5rem;
  }

  /* Disabled state */
  .collapsible.disabled .trigger-wrapper {
    opacity: 0.5;
    cursor: not-allowed;
  }

  /* Slotted trigger styling hints */
  ::slotted([slot="trigger"]) {
    display: block;
    width: 100%;
    user-select: none;
    -webkit-user-select: none;
  }

  .collapsible.disabled ::slotted([slot="trigger"]) {
    pointer-events: none;
  }

  /* Focus styles for slotted triggers */
  ::slotted([slot="trigger"]:focus-visible) {
    outline: 2px solid hsl(var(--ring));
    outline-offset: 2px;
    border-radius: calc(var(--radius) - 2px);
  }

  /* Chevron indicator */
  .indicator {
    margin-left: auto;
    width: 1rem;
    height: 1rem;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }

  .indicator::before {
    content: '›';
    display: block;
    transform-origin: 50% 50%;
    transform: rotate(0deg);
    transition: transform var(--cf-theme-animation-duration, 150ms)
      var(--cf-transition-timing-ease);
    color: var(--cf-theme-color-text-muted, #64748b);
    font-weight: var(--cf-font-weight-semibold, 600);
  }

  :host([open]) .indicator::before {
    transform: rotate(90deg);
  }

  /* Custom properties for theming */
  :host {
    --ring: 222.2 84% 4.9%;
    --radius: 0.5rem;
  }

  /* Dark mode support */
  @media (prefers-color-scheme: dark) {
    :host {
      --ring: 212.7 26.8% 83.9%;
    }
  }

  /* Allow external customization */
  :host([data-theme="dark"]) {
    --ring: 212.7 26.8% 83.9%;
  }

  /* Smooth height transitions */
  @media (prefers-reduced-motion: reduce) {
    .content-wrapper {
      transition: none;
    }
  }

  /* Additional accessibility styles */
  @media (prefers-contrast: high) {
    ::slotted([slot="trigger"]:focus-visible) {
      outline-width: 3px;
    }
  }
`;
