/**
 * Styles for UI Tab List component
 */

export const tabListStyles = `
  :host {
    display: block;
    width: 100%;
  }

  .tab-list {
    display: flex;
    align-items: center;
    gap: var(--cf-spacing-1);
    padding: var(--cf-spacing-1);
    background-color: var(--cf-colors-gray-100);
    border-radius: var(--cf-border-radius-md);
  }

  .tab-list[data-orientation="horizontal"] {
    flex-direction: row;
    width: 100%;
    min-width: 0;
    overflow-x: auto;
    overflow-y: hidden;
    -webkit-overflow-scrolling: touch;
    scrollbar-width: none;
    flex-wrap: nowrap;
  }

  .tab-list[data-orientation="horizontal"]::-webkit-scrollbar {
    display: none;
  }

  .tab-list[data-orientation="horizontal"] ::slotted(cf-tab) {
    flex-shrink: 0;
  }

  .tab-list[data-variant="chip"] {
    background-color: transparent;
    border-radius: 0;
    padding: 0;
    height: auto;
    gap: var(--cf-spacing-2, 0.5rem);
  }

  .tab-list[data-orientation="vertical"] {
    flex-direction: column;
    align-items: stretch;
    width: max-content;
    min-width: 200px;
  }

  /* Remove default button spacing in vertical orientation */
  .tab-list[data-orientation="vertical"] ::slotted(cf-tab) {
    width: 100%;
  }
`;
