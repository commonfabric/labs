/**
 * Styles for UI Tab Panel component
 */

export const tabPanelStyles = `
  :host {
    display: block;
    width: 100%;
  }

  :host([hidden]) {
    display: none !important;
  }

  .tab-panel {
    padding: var(--cf-spacing-6);
    background-color: white;
    border-radius: var(--cf-border-radius-md);
    width: 100%;
    animation: fadeIn var(--cf-transition-duration-base) var(--cf-transition-timing-ease);
  }

  @keyframes fadeIn {
    from {
      opacity: 0;
      transform: translateY(2px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }

  /* Focus styles for keyboard navigation */
  .tab-panel:focus {
    outline: 2px solid var(--cf-colors-primary-500);
    outline-offset: 2px;
  }

  /* Vertical orientation adjustments */
  :host-context(cf-tabs[orientation="vertical"]) .tab-panel {
    margin-left: var(--cf-spacing-4);
  }
`;
