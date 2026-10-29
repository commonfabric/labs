export const resizableHandleStyles = `
  :host {
    display: flex;
    align-items: center;
    justify-content: center;
    position: relative;
    outline: none;
    background-color: hsl(var(--border, 240 5.9% 90%));
    transition: background-color var(--cf-theme-animation-duration, 150ms)
      var(--cf-transition-timing-ease);
  }

  :host(:hover) {
    background-color: hsl(var(--accent, 240 4.8% 95.9%));
  }

  :host(:focus-visible) {
    box-shadow: 0 0 0 2px hsl(var(--ring, 240 5.9% 10%));
  }

  .handle {
    width: 100%;
    height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    position: relative;
  }

  .grip-icon {
    width: 16px;
    height: 16px;
    position: relative;
    opacity: 0.5;
    transition: opacity var(--cf-theme-animation-duration, 150ms)
      var(--cf-transition-timing-ease);
  }

  :host(:hover) .grip-icon {
    opacity: 0.7;
  }

  /* Horizontal grip pattern using CSS */
  :host([data-orientation="horizontal"]) .grip-icon::before,
  :host(:not([data-orientation])) .grip-icon::before {
    content: '';
    position: absolute;
    left: 50%;
    top: 50%;
    transform: translate(-50%, -50%);
    width: 2px;
    height: 16px;
    background-color: currentColor;
    box-shadow: 
      -4px 0 0 0 currentColor,
      4px 0 0 0 currentColor;
  }

  /* Vertical grip pattern using CSS */
  :host([data-orientation="vertical"]) .grip-icon::before {
    content: '';
    position: absolute;
    left: 50%;
    top: 50%;
    transform: translate(-50%, -50%);
    width: 16px;
    height: 2px;
    background-color: currentColor;
    box-shadow: 
      0 -4px 0 0 currentColor,
      0 4px 0 0 currentColor;
  }

  /* Adjust cursor based on parent panel group direction */
  :host-context(cf-resizable-panel-group[direction="horizontal"]) {
    cursor: col-resize;
  }

  :host-context(cf-resizable-panel-group[direction="vertical"]) {
    cursor: row-resize;
  }

  /* Remove default outline in favor of focus-visible */
  :host:focus {
    outline: none;
  }
`;
