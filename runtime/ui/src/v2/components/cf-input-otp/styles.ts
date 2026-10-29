/**
 * Styles for cf-input-otp component
 */

export const inputOTPStyles = `
  :host {
    display: inline-block;
    
    /* Default color values if not provided */
    --background: #ffffff;
    --foreground: #0f172a;
    --border: #e2e8f0;
    --ring: #94a3b8;
    --destructive: #dc2626;
    --muted: #f8fafc;
    --muted-foreground: #64748b;
    
    /* OTP input dimensions */
    --otp-input-size: 2.75rem;
    --otp-input-font-size: 1.25rem;
    --otp-input-gap: var(--cf-size-md-spacing, 8px);
    --otp-input-border-radius: var(--cf-size-sm-radius, 5px);
    --otp-separator-margin: 0.25rem;
  }

  .otp-container {
    display: inline-flex;
    align-items: center;
    gap: var(--otp-input-gap);
  }

  .otp-input {
    all: unset;
    box-sizing: border-box;
    width: var(--otp-input-size);
    height: var(--otp-input-size);
    font-size: var(--otp-input-font-size);
    font-family: inherit;
    font-weight: 500;
    text-align: center;
    color: var(--foreground);
    background-color: var(--background);
    border: 2px solid var(--border);
    border-radius: var(--otp-input-border-radius);
    transition: all 150ms cubic-bezier(0.4, 0, 0.2, 1);
    cursor: text;
    caret-color: var(--foreground);
  }

  /* Focus state */
  .otp-input:focus {
    outline: 2px solid transparent;
    outline-offset: 2px;
    border-color: var(--ring);
    box-shadow: 0 0 0 3px rgba(148, 163, 184, 0.1);
  }

  .otp-input:focus-visible {
    outline: 2px solid transparent;
    outline-offset: 2px;
    border-color: var(--ring);
    box-shadow: 0 0 0 3px rgba(148, 163, 184, 0.1);
  }

  /* Disabled state */
  .otp-input:disabled {
    cursor: not-allowed;
    opacity: 0.5;
    background-color: var(--muted);
  }

  /* Readonly state */
  .otp-input:read-only {
    background-color: var(--muted);
    cursor: default;
  }

  /* Error state */
  .otp-input.error {
    border-color: var(--destructive);
  }

  .otp-input.error:focus,
  .otp-input.error:focus-visible {
    border-color: var(--destructive);
    box-shadow: 0 0 0 3px rgba(220, 38, 38, 0.1);
  }

  /* Separator */
  .separator {
    color: var(--muted-foreground);
    font-size: var(--otp-input-font-size);
    margin: 0 var(--otp-separator-margin);
    user-select: none;
  }

  /* Selection styles */
  .otp-input::selection {
    background-color: var(--ring);
    color: var(--background);
    opacity: 0.3;
  }

  .otp-input::-moz-selection {
    background-color: var(--ring);
    color: var(--background);
    opacity: 0.3;
  }

  /* Remove number input spinners */
  .otp-input::-webkit-inner-spin-button,
  .otp-input::-webkit-outer-spin-button {
    -webkit-appearance: none;
    margin: 0;
  }

  /* Autofill styles */
  .otp-input:-webkit-autofill,
  .otp-input:-webkit-autofill:hover,
  .otp-input:-webkit-autofill:focus {
    -webkit-text-fill-color: var(--foreground);
    -webkit-box-shadow: 0 0 0px 1000px var(--background) inset;
    transition: background-color 5000s ease-in-out 0s;
    border: 2px solid var(--border);
  }

  /* Responsive adjustments */
  @media (max-width: 640px) {
    :host {
      --otp-input-size: 2.5rem;
      --otp-input-font-size: 1.125rem;
      --otp-input-gap: var(--cf-size-sm-spacing, 4px);
    }
  }

  @media (max-width: 400px) {
    :host {
      --otp-input-size: 2.25rem;
      --otp-input-font-size: 1rem;
      --otp-input-gap: var(--cf-size-sm-spacing, 4px);
    }
  }

  /* High contrast mode support */
  @media (prefers-contrast: high) {
    .otp-input {
      border-width: 3px;
    }
  }

  /* Animation for value changes */
  @keyframes pulse {
    0% {
      transform: scale(1);
    }
    50% {
      transform: scale(1.05);
    }
    100% {
      transform: scale(1);
    }
  }

  .otp-input:not(:placeholder-shown) {
    animation: pulse 200ms ease-in-out;
  }
`;
