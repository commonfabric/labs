import { css } from "lit";

export const styles = css`
  :host {
    --cf-button-border-radius: var(
      --cf-theme-border-radius,
      var(--cf-border-radius-md, 0.375rem)
    );
    --cf-button-border-radius-full: var(
      --cf-theme-border-radius-full,
      var(--cf-border-radius-full, 9999px)
    );
    --cf-button-font-family: var(--cf-theme-font-family, inherit);
    --cf-button-animation-duration: var(--cf-theme-animation-duration, 0.2s);
    --cf-button-spacing-tight: var(--cf-theme-spacing-tight, 0.25rem);
    --cf-button-spacing-normal: var(--cf-theme-spacing-normal, 0.5rem);
    --cf-button-spacing-loose: var(--cf-theme-spacing-loose, 1rem);
    --cf-button-spacing-x-lg: 2rem;
    --cf-button-icon-size: 2.5rem;
    --cf-button-icon-padding: 0;
    --cf-button-color-primary: var(
      --cf-theme-color-primary,
      var(--cf-colors-primary-500, #4979fa)
    );
    --cf-button-color-primary-foreground: var(
      --cf-theme-color-primary-foreground,
      #ffffff
    );
    --cf-button-color-secondary: var(
      --cf-theme-color-secondary,
      var(--cf-colors-gray-100, #f2f3f6)
    );
    --cf-button-color-secondary-foreground: var(
      --cf-theme-color-secondary-foreground,
      var(--cf-colors-gray-900, #16181d)
    );
    --cf-button-color-error: var(
      --cf-theme-color-error,
      var(--cf-colors-error, #dc2626)
    );
    --cf-button-color-error-foreground: var(
      --cf-theme-color-error-foreground,
      #ffffff
    );
    --cf-button-color-accent: var(--cf-theme-color-accent, #fc856d);
    --cf-button-color-primary-pressed: var(
      --cf-theme-color-primary-pressed,
      color-mix(in srgb, var(--cf-button-color-primary) 85%, black)
    );
    --cf-button-color-primary-subtle: var(
      --cf-theme-color-primary-subtle,
      color-mix(in srgb, var(--cf-button-color-primary) 10%, transparent)
    );
    --cf-button-color-accent-pressed: var(
      --cf-theme-color-accent-pressed,
      color-mix(in srgb, var(--cf-button-color-accent) 85%, black)
    );
    --cf-button-color-accent-subtle: var(
      --cf-theme-color-accent-subtle,
      color-mix(in srgb, var(--cf-button-color-accent) 10%, transparent)
    );
    --cf-button-color-danger-pressed: var(
      --cf-theme-color-danger-pressed,
      color-mix(in srgb, var(--cf-button-color-error) 85%, black)
    );
    --cf-button-color-danger-subtle: var(
      --cf-theme-color-danger-subtle,
      color-mix(in srgb, var(--cf-button-color-error) 10%, transparent)
    );
    --cf-button-color-border: var(
      --cf-theme-color-border,
      var(--cf-colors-gray-300, #d5d7dd)
    );
    --cf-button-color-surface: var(
      --cf-theme-color-surface,
      var(--cf-colors-gray-50, #ffffff)
    );
    --cf-button-color-surface-hover: var(
      --cf-theme-color-surface-hover,
      var(--cf-colors-gray-200, #eceef1)
    );
    --cf-button-color-text: var(
      --cf-theme-color-text,
      var(--cf-colors-gray-900, #16181d)
    );
    --cf-button-color-text-muted: var(
      --cf-theme-color-text-muted,
      var(--cf-colors-gray-500, #94979e)
    );

    display: inline-block;
    outline: none;
    box-sizing: border-box;
  }

  *,
  *::before,
  *::after {
    box-sizing: inherit;
  }

  .button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    white-space: nowrap;
    width: 100%;
    min-height: var(--cf-size-md-height, 2rem);
    border-radius: var(--cf-size-md-radius, 8px);
    font-size: var(--cf-size-md-font-size, 0.75rem);
    font-weight: var(--cf-font-weight-medium, 500);
    font-family: var(--cf-button-font-family, inherit);
    line-height: var(--cf-size-md-line-height, 1rem);
    padding: var(--cf-size-md-padding-v, 8px) var(--cf-size-md-padding-h, 8px);
    gap: var(--cf-size-md-spacing, 8px);
    transition: all var(--cf-button-animation-duration, 0.2s) ease;
    cursor: pointer;
    user-select: none;
    border: 1px solid transparent;
    outline: 2px solid transparent;
    outline-offset: 2px;
    background-color: transparent;
    background-image: none;
    text-transform: none;
    -webkit-appearance: button;
    text-decoration: none;
  }

  :host(:focus-visible) .button {
    outline: 2px solid
      var(--cf-button-color-primary, var(--cf-colors-primary-500, #4979fa));
    outline-offset: 2px;
  }

  :host([disabled]) .button {
    pointer-events: none;
    opacity: 0.5;
    cursor: not-allowed;
  }

  /* Size variants — driven by :host([size="..."]) attribute selectors */
  :host([size="xs"]) .button {
    min-height: var(--cf-size-xs-height, 16px);
    border-radius: var(--cf-size-xs-radius, 4px);
    padding: var(--cf-size-xs-padding-v, 2px) var(--cf-size-xs-padding-h, 4px);
    font-size: var(--cf-size-xs-font-size, 9px);
    line-height: var(--cf-size-xs-line-height, 12px);
    gap: var(--cf-size-xs-spacing, 2px);
  }

  :host([size="sm"]) .button {
    min-height: var(--cf-size-sm-height, 24px);
    border-radius: var(--cf-size-sm-radius, 5px);
    padding: var(--cf-size-sm-padding-v, 4px) var(--cf-size-sm-padding-h, 6px);
    font-size: var(--cf-size-sm-font-size, 11px);
    line-height: var(--cf-size-sm-line-height, 16px);
    gap: var(--cf-size-sm-spacing, 4px);
  }

  /* size="md" is the default — styles already in .button base rule */

  :host([size="lg"]) .button {
    min-height: var(--cf-size-lg-height, 40px);
    border-radius: var(--cf-size-lg-radius, 9px);
    padding: var(--cf-size-lg-padding-v, 8px) var(--cf-size-lg-padding-h, 12px);
    font-size: var(--cf-size-lg-font-size, 16px);
    line-height: var(--cf-size-lg-line-height, 20px);
    gap: var(--cf-size-lg-spacing, 12px);
  }

  :host([size="xl"]) .button {
    min-height: var(--cf-size-xl-height, 48px);
    border-radius: var(--cf-size-xl-radius, 10px);
    padding: var(--cf-size-xl-padding-v, 12px)
      var(--cf-size-xl-padding-h, 16px);
    font-size: var(--cf-size-xl-font-size, 18px);
    line-height: var(--cf-size-xl-line-height, 24px);
    gap: var(--cf-size-xl-spacing, 16px);
  }

  :host([size="icon"]) .button {
    min-height: auto;
    height: var(--cf-button-icon-size, var(--cf-size-md-height, 2rem));
    width: var(--cf-button-icon-size, var(--cf-size-md-height, 2rem));
    padding: 0;
  }

  /*
  ** Solid variant
  */

  .button.solid {
    border-color: transparent;
  }

  :host([color="neutral"]) .button.solid {
    background-color: var(--cf-button-color-secondary);
    color: var(--cf-button-color-secondary-foreground);
  }

  :host([color="neutral"]:not([disabled])) .button.solid:hover {
    background-color: var(--cf-button-color-surface-hover);
  }

  :host([color="primary"]) .button.solid {
    background-color: var(--cf-button-color-primary);
    color: var(--cf-theme-color-primary-foreground, #fff);
    border-color: var(--cf-button-color-primary);
  }

  :host([color="primary"]:not([disabled])) .button.solid:hover {
    background-color: var(--cf-button-color-primary-pressed);
    border-color: var(--cf-button-color-primary-pressed);
  }

  :host([color="accent"]) .button.solid {
    background-color: var(--cf-button-color-accent);
    color: var(--cf-theme-color-accent-foreground, #fff);
    border-color: var(--cf-button-color-accent);
  }

  :host([color="accent"]:not([disabled])) .button.solid:hover {
    background-color: var(--cf-button-color-accent-pressed);
    border-color: var(--cf-button-color-accent-pressed);
  }

  :host([color="danger"]) .button.solid {
    background-color: var(--cf-button-color-error);
    color: var(--cf-theme-color-error-foreground, #fff);
    border-color: var(--cf-button-color-error);
  }

  :host([color="danger"]:not([disabled])) .button.solid:hover {
    background-color: var(--cf-button-color-danger-pressed);
    border-color: var(--cf-button-color-danger-pressed);
  }

  /*
  ** Outline variant
  */

  .button.outline {
    background-color: transparent;
    border-color: var(--cf-button-color-border);
  }

  :host([color="neutral"]) .button.outline {
    color: var(--cf-button-color-text);
  }

  :host([color="neutral"]:not([disabled])) .button.outline:hover {
    background-color: var(--cf-button-color-surface);
  }

  :host([color="primary"]) .button.outline {
    color: var(--cf-button-color-primary);
    border-color: var(--cf-button-color-primary);
  }

  :host([color="primary"]:not([disabled])) .button.outline:hover {
    background-color: var(--cf-button-color-primary-subtle);
  }

  :host([color="accent"]) .button.outline {
    color: var(--cf-button-color-accent);
    border-color: var(--cf-button-color-accent);
  }

  :host([color="accent"]:not([disabled])) .button.outline:hover {
    background-color: var(--cf-button-color-accent-subtle);
  }

  :host([color="danger"]) .button.outline {
    color: var(--cf-button-color-error);
    border-color: var(--cf-button-color-error);
  }

  :host([color="danger"]:not([disabled])) .button.outline:hover {
    background-color: var(--cf-button-color-danger-subtle);
  }

  /*
  ** Ghost variant
  */

  .button.ghost {
    background-color: transparent;
    border: none;
  }

  :host([color="neutral"]) .button.ghost {
    color: var(--cf-button-color-text-muted);
  }

  :host([color="neutral"]:not([disabled])) .button.ghost:hover {
    color: var(--cf-button-color-text);
    background-color: var(--cf-button-color-surface-hover);
  }

  :host([color="primary"]) .button.ghost {
    color: var(--cf-button-color-primary);
  }

  :host([color="primary"]:not([disabled])) .button.ghost:hover {
    background-color: var(--cf-button-color-primary-subtle);
  }

  :host([color="accent"]) .button.ghost {
    color: var(--cf-button-color-accent);
  }

  :host([color="accent"]:not([disabled])) .button.ghost:hover {
    background-color: var(--cf-button-color-accent-subtle);
  }

  :host([color="danger"]) .button.ghost {
    color: var(--cf-button-color-error);
  }

  :host([color="danger"]:not([disabled])) .button.ghost:hover {
    background-color: var(--cf-button-color-danger-subtle);
  }

  :host([size="icon"]) .button.ghost {
    width: var(--cf-button-icon-size, var(--cf-size-md-height, 2rem));
    height: var(--cf-button-icon-size, var(--cf-size-md-height, 2rem));
    border-radius: var(
      --cf-button-border-radius,
      var(--cf-border-radius-sm, 0.25rem)
    );
  }
`;
