/**
 * Styles for cf-progress component
 */

export const progressStyles = `
  :host {
    /* Default color values if not provided */
    --cf-progress-color-background: var(--cf-theme-color-background, #ffffff);
    --cf-progress-color-foreground: var(--cf-theme-color-text, #0f172a);
    --cf-progress-color-track: var(--cf-theme-color-border, #e2e8f0);
    --cf-progress-color-ring: var(--cf-theme-color-primary, #94a3b8);
    --cf-progress-color-indicator: var(--cf-theme-color-primary, #3b82f6);
    --cf-progress-color-indicator-foreground: var(
      --cf-theme-color-primary-foreground,
      #ffffff
    );
    --cf-progress-color-muted: var(--cf-theme-color-surface, #f8fafc);
    --cf-progress-color-muted-foreground: var(
      --cf-theme-color-text-muted,
      #64748b
    );
    
    /* Progress dimensions */
    --progress-height: 0.5rem; /* h-2 equivalent */
    --progress-border-radius: 9999px; /* rounded-full */

    display: block;
    width: 100%;
  }

  * {
    box-sizing: border-box;
  }

  .progress {
    position: relative;
    width: 100%;
    height: var(--progress-height);
    background-color: var(--cf-progress-color-track);
    border-radius: var(--progress-border-radius);
    overflow: hidden;
  }

  /* Indicator (filled portion) */
  .indicator {
    height: 100%;
    background-color: var(--cf-progress-color-indicator);
    border-radius: var(--progress-border-radius);
    transition: width 300ms cubic-bezier(0.4, 0, 0.2, 1);
    will-change: width;
  }

  /* Indeterminate state animation */
  .progress.indeterminate .indicator {
    width: 30%;
    position: absolute;
    animation: indeterminate-progress 1.5s cubic-bezier(0.65, 0.815, 0.735, 0.395) infinite;
  }

  @keyframes indeterminate-progress {
    0% {
      left: -35%;
      right: 100%;
    }
    60% {
      left: 100%;
      right: -90%;
    }
    100% {
      left: 100%;
      right: -90%;
    }
  }

  /* Alternative indeterminate animation for better visual */
  @keyframes indeterminate-progress-alt {
    0% {
      transform: translateX(-100%);
    }
    100% {
      transform: translateX(400%);
    }
  }

  /* High contrast mode support */
  @media (prefers-contrast: high) {
    .progress {
      border: 1px solid;
    }
  }

  /* Reduced motion support */
  @media (prefers-reduced-motion: reduce) {
    .indicator {
      transition: none;
    }
    
    .progress.indeterminate .indicator {
      animation: none;
      width: 100%;
      opacity: 0.5;
    }
  }

  /* Size variants via CSS custom properties */
  :host([size="sm"]) {
    --progress-height: 0.25rem;
  }

  :host([size="lg"]) {
    --progress-height: 0.75rem;
  }

  :host([size="xl"]) {
    --progress-height: 1rem;
  }

  /* Custom styling support */
  :host([variant="success"]) {
    --cf-progress-color-indicator: var(--cf-theme-color-success, #22c55e);
  }

  :host([variant="warning"]) {
    --cf-progress-color-indicator: var(--cf-theme-color-warning, #f59e0b);
  }

  :host([variant="error"]) {
    --cf-progress-color-indicator: var(--cf-theme-color-error, #ef4444);
  }

  :host([variant="info"]) {
    --cf-progress-color-indicator: #3b82f6;
  }

  /* Striped variant */
  :host([striped]) .indicator {
    background-image: linear-gradient(
      45deg,
      rgba(255, 255, 255, 0.15) 25%,
      transparent 25%,
      transparent 50%,
      rgba(255, 255, 255, 0.15) 50%,
      rgba(255, 255, 255, 0.15) 75%,
      transparent 75%,
      transparent
    );
    background-size: 1rem 1rem;
  }

  /* Animated stripes */
  :host([striped][animated]) .indicator {
    animation: progress-stripes 1s linear infinite;
  }

  @keyframes progress-stripes {
    from {
      background-position: 1rem 0;
    }
    to {
      background-position: 0 0;
    }
  }

  /* Smooth transition when not indeterminate */
  .progress:not(.indeterminate) .indicator {
    transition: width 300ms cubic-bezier(0.4, 0, 0.2, 1);
  }

  /* Ensure indicator is visible even at 0% for better UX */
  .progress:not(.indeterminate) .indicator {
    min-width: 0.5%;
  }
`;
