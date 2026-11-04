/**
 * Styles for cf-scroll-area component
 */

export const scrollAreaStyles = `
  :host {
    display: block;
    position: relative;
    width: 100%;
    height: 100%;
    overflow: hidden;
    
    /* Default color values if not provided */
    --background: #ffffff;
    --foreground: #0f172a;
    --border: #e2e8f0;
    --muted: #f8fafc;
    --muted-foreground: #64748b;
    --ring: #94a3b8;
    
    /* Scrollbar colors */
    --scrollbar-track: transparent;
    --scrollbar-thumb: #e2e8f0;
    --scrollbar-thumb-hover: #cbd5e1;
  }

  .scroll-area {
    position: relative;
    width: 100%;
    height: 100%;
    overflow: hidden;
  }

  .scroll-container {
    width: 100%;
    height: 100%;
    overflow: auto;
    scrollbar-width: none; /* Firefox */
    -ms-overflow-style: none; /* IE and Edge */
  }

  .scroll-container::-webkit-scrollbar {
    display: none; /* Chrome, Safari, Opera */
  }

  .scroll-content {
    position: relative;
    min-width: 100%;
    min-height: 100%;
  }

  /* Scrollbar base styles */
  .scrollbar {
    position: absolute;
    background-color: var(--scrollbar-track);
    opacity: 0;
    transition: opacity 200ms ease-out;
    z-index: 10;
    pointer-events: none;
  }

  .scrollbar.scrollbar-visible {
    pointer-events: auto;
  }

  .scrollbar.scrollbar-hover,
  .scrollbar.scrollbar-dragging {
    opacity: 1;
  }

  /* Vertical scrollbar */
  .scrollbar-vertical {
    top: 0;
    right: 0;
    bottom: 0;
    width: 10px;
  }

  /* Horizontal scrollbar */
  .scrollbar-horizontal {
    left: 0;
    right: 0;
    bottom: 0;
    height: 10px;
  }

  /* Adjust for both scrollbars */
  :host([orientation="both"]) .scrollbar-vertical {
    bottom: 10px;
  }

  :host([orientation="both"]) .scrollbar-horizontal {
    right: 10px;
  }

  /* Scrollbar thumb */
  .scrollbar-thumb {
    position: absolute;
    background-color: var(--scrollbar-thumb);
    border-radius: 5px;
    cursor: pointer;
    transition: background-color 150ms ease-out;
  }

  .scrollbar-thumb:hover {
    background-color: var(--scrollbar-thumb-hover);
  }

  .scrollbar-dragging .scrollbar-thumb {
    background-color: var(--scrollbar-thumb-hover);
  }

  /* Vertical thumb */
  .scrollbar-thumb-vertical {
    top: 0;
    right: 2px;
    width: 6px;
    min-height: 30px;
  }

  /* Horizontal thumb */
  .scrollbar-thumb-horizontal {
    bottom: 2px;
    left: 0;
    height: 6px;
    min-width: 30px;
  }

  /* Slot styles */
  ::slotted(*) {
    display: block;
  }

  /* Focus styles */
  .scroll-container:focus {
    outline: none;
  }

  .scroll-container:focus-visible {
    outline: 2px solid var(--ring);
    outline-offset: -2px;
  }

  /* Dark mode support */
  :host([data-theme="dark"]) {
    --background: #020817;
    --foreground: #f8fafc;
    --border: #1e293b;
    --muted: #0f172a;
    --muted-foreground: #94a3b8;
    --ring: #475569;
    --scrollbar-thumb: #334155;
    --scrollbar-thumb-hover: #475569;
  }
`;
