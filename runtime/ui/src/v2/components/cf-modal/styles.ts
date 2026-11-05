/**
 * Styles for cf-modal component
 *
 * Desktop: Centered modal with fade + scale animation
 * Mobile (<480px): Bottom sheet with slide-up animation
 */

import { css, unsafeCSS } from "lit";
import { surfaceRecipesCSS } from "../../styles/variables.ts";

export const modalStyles = css`
  :host {
    ${unsafeCSS(surfaceRecipesCSS)};
    --cf-modal-color-background: var(--cf-theme-color-background, white);
    --cf-modal-color-border: var(--cf-theme-color-border, #e5e7eb);
    --cf-modal-color-surface: var(--cf-theme-color-surface, #fafafa);
    --cf-modal-color-surface-hover: var(
      --cf-theme-color-surface-hover,
      rgba(0, 0, 0, 0.05)
    );
    --cf-modal-color-text: var(--cf-theme-color-text, #111827);
    --cf-modal-color-text-muted: var(--cf-theme-color-text-muted, #6b7280);
    --cf-modal-color-primary: var(--cf-theme-color-primary, #3b82f6);
    --cf-modal-animation-duration: var(
      --cf-theme-animation-duration,
      var(--cf-transition-duration-base, 200ms)
    );
    --cf-modal-border-radius: var(
      --cf-surface-overlay-border-radius,
      var(--cf-theme-border-radius, 0.5rem)
    );
    --cf-modal-border: var(
      --cf-surface-overlay-border,
      1px solid var(--cf-theme-color-border, #e5e7eb)
    );
    --cf-modal-padding: var(--cf-surface-overlay-padding, 16px 20px);
    --cf-modal-box-shadow: var(
      --cf-surface-overlay-box-shadow,
      0 25px 50px -12px rgba(0, 0, 0, 0.25)
    );
    --cf-modal-sheet-box-shadow: var(
      --cf-surface-overlay-sheet-box-shadow,
      0 -4px 24px rgba(0, 0, 0, 0.15)
    );

    /* CSS custom properties for customization */
    --_backdrop-color: var(--cf-modal-backdrop-color, rgba(0, 0, 0, 0.5));
    --_backdrop-blur: var(
      --cf-modal-backdrop-blur,
      var(--cf-backdrop-blur-md, 8px)
    );
    --_border-radius: var(
      --cf-modal-border-radius,
      var(
        --cf-surface-overlay-border-radius,
        var(--cf-theme-border-radius, 0.5rem)
      )
    );
    --_width-sm: var(--cf-modal-width-sm, var(--cf-layout-width-sm, 320px));
    --_width-md: var(--cf-modal-width-md, var(--cf-layout-width-md, 500px));
    --_width-lg: var(--cf-modal-width-lg, var(--cf-layout-width-lg, 700px));
    --_max-height: var(--cf-modal-max-height, 90vh);
    --_animation-duration: var(
      --cf-modal-animation-duration,
      var(--cf-transition-duration-base, 200ms)
    );

    display: contents;
  }

  /*
  ** Hidden State
  */
  :host(:not([open])) .backdrop,
  :host(:not([open])) .container {
    visibility: hidden;
    pointer-events: none;
  }

  /*
  ** Backdrop
  */
  .backdrop {
    position: fixed;
    inset: 0;
    background: var(--_backdrop-color);
    backdrop-filter: blur(var(--_backdrop-blur));
    -webkit-backdrop-filter: blur(var(--_backdrop-blur));
    opacity: 0;
    transition: opacity var(--_animation-duration)
      var(--cf-transition-timing-ease, ease);
  }

  :host([open]) .backdrop {
    opacity: 1;
  }

  /*
  ** Container (centering)
  */
  .container {
    position: fixed;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: var(--cf-spacing-4, 16px);
  }

  /*
  ** Dialog
  */
  .dialog {
    position: relative;
    box-sizing: border-box;
    background: var(
      --cf-surface-overlay-background,
      var(--cf-modal-color-background, white)
    );
    border: var(--cf-modal-border);
    border-radius: var(--_border-radius);
    box-shadow: var(--cf-modal-box-shadow);
    max-height: min(var(--_max-height), 100%);
    overflow: hidden;
    display: flex;
    flex-direction: column;

    /* Desktop: fade + scale animation */
    opacity: 0;
    transform: scale(0.95);
    transition:
      opacity var(--_animation-duration) var(--cf-transition-timing-ease, ease),
      transform var(--_animation-duration)
      var(--cf-transition-timing-spring, cubic-bezier(0.34, 1.56, 0.64, 1));
  }

  :host([open]) .dialog {
    opacity: 1;
    transform: scale(1);
  }

  /*
  ** Size Variants
  */
  :host([size="sm"]) .dialog {
    width: var(--_width-sm);
  }
  :host([size="md"]) .dialog,
  :host(:not([size])) .dialog {
    width: var(--_width-md);
  }
  :host([size="lg"]) .dialog {
    width: var(--_width-lg);
  }
  :host([size="full"]) .dialog {
    width: calc(100vw - 32px);
    height: calc(100vh - 32px);
    max-height: min(calc(100vh - 32px), 100%);
  }

  /*
  ** Header
  */
  .header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: var(--cf-modal-padding);
    border-bottom: 1px solid var(--cf-modal-color-border, #e5e7eb);
    background: var(--cf-modal-color-surface, #fafafa);
    flex-shrink: 0;
  }

  .header.empty {
    display: none;
  }

  .header-content {
    font-weight: 600;
    font-size: 16px;
    color: var(--cf-modal-color-text, #111827);
    flex: 1;
    min-width: 0;
  }

  /*
  ** Close Button
  */
  .close-button {
    background: transparent;
    border: none;
    cursor: pointer;
    padding: 4px 8px;
    font-size: 18px;
    color: var(--cf-modal-color-text-muted, #6b7280);
    line-height: 1;
    border-radius: 4px;
    transition: background var(--_animation-duration)
      var(--cf-transition-timing-ease, ease);
    flex-shrink: 0;
    margin-left: 8px;
  }

  .close-button:hover {
    background: var(--cf-modal-color-surface-hover, rgba(0, 0, 0, 0.05));
  }

  .close-button:focus-visible {
    outline: 2px solid var(--cf-modal-color-primary, #3b82f6);
    outline-offset: 2px;
  }

  :host(:not([dismissible])) .close-button,
  :host([dismissible="false"]) .close-button,
  :host(:not([dismissable])) .close-button,
  :host([dismissable="false"]) .close-button {
    display: none;
  }

  /*
  ** Content
  */
  .content {
    padding: var(--cf-modal-padding);
    overflow: auto;
    flex: 1;
  }

  /*
  ** Footer
  */
  .footer {
    display: flex;
    justify-content: flex-end;
    gap: 12px;
    padding: var(--cf-modal-padding);
    border-top: 1px solid var(--cf-modal-color-border, #e5e7eb);
    background: var(--cf-modal-color-surface, #fafafa);
    flex-shrink: 0;
  }

  .footer.empty {
    display: none;
  }

  /* Ensure slotted elements in footer take full width */
  .footer ::slotted(*) {
    width: 100%;
  }

  /*
  ** Sheet Presentation Mode
  */

  /* Grabber: hidden by default */
  .grabber {
    display: none;
  }

  /* Grabber visible when both presentation=sheet and grabber attr */
  :host([presentation="sheet"][grabber]) .grabber {
    display: flex;
    justify-content: center;
    align-items: center;
    padding: 8px 0 4px;
    flex-shrink: 0;
    background: var(--cf-modal-color-surface, #fafafa);
  }

  :host([presentation="sheet"][grabber]) .grabber::after {
    content: "";
    display: block;
    width: 36px;
    height: 4px;
    border-radius: 2px;
    background: var(--cf-modal-color-border, #e5e7eb);
  }

  /* Sheet container: bottom-aligned */
  :host([presentation="sheet"]) .container {
    align-items: flex-end;
    padding: 0;
  }

  /* Sheet dialog: full-width, top-only border-radius */
  :host([presentation="sheet"]) .dialog {
    width: 100%;
    border-radius: var(--_border-radius) var(--_border-radius) 0 0;
    box-shadow: var(--cf-modal-sheet-box-shadow);

    /* Sheet animation: slide up instead of scale */
    transform: translateY(100%);
    opacity: 1;
    transition: transform var(--_animation-duration)
      var(--cf-transition-timing-sheet, cubic-bezier(0.32, 0.72, 0, 1));
  }

  :host([presentation="sheet"][open]) .dialog {
    transform: translateY(0);
    opacity: 1;
  }

  /* Sheet detent variants */
  :host([presentation="sheet"][detent="auto"]) .dialog,
  :host([presentation="sheet"]:not([detent])) .dialog {
    max-height: min(90vh, 100%);
  }

  :host([presentation="sheet"][detent="half"]) .dialog {
    max-height: min(50vh, 100%);
  }

  :host([presentation="sheet"][detent="full"]) .dialog {
    max-height: min(92vh, 100%);
  }

  /* Sheet overrides size variants */
  :host([presentation="sheet"][size="sm"]) .dialog,
  :host([presentation="sheet"][size="md"]) .dialog,
  :host([presentation="sheet"][size="lg"]) .dialog {
    width: 100%;
  }

  /*
  ** Reduced Motion
  */
  @media (prefers-reduced-motion: reduce) {
    .backdrop,
    .dialog {
      transition: none;
    }
  }
`;
