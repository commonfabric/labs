/**
 * Styles for cf-skeleton component
 */

export const skeletonStyles = `
  :host {
    display: inline-block;
    
    /* Default color values if not provided */
    --background: #ffffff;
    --foreground: #0f172a;
    --accent: #f1f5f9;
    --accent-foreground: #475569;
    --border: #e2e8f0;
    --ring: #94a3b8;
  }

  .skeleton {
    display: block;
    background-color: var(--accent, #f1f5f9);
    position: relative;
    overflow: hidden;
    border-radius: 0.375rem;
  }

  /* Default variant */
  .skeleton.variant-default {
    width: 100%;
    height: 1.25rem;
  }

  /* Text variant - multiple lines */
  .skeleton.variant-text {
    width: 100%;
    height: 1rem;
  }

  /* Circular variant */
  .skeleton.variant-circular {
    width: 2.5rem;
    height: 2.5rem;
    border-radius: 50%;
  }

  /* Pulse animation */
  @keyframes skeleton-pulse {
    0% {
      opacity: 1;
    }
    50% {
      opacity: 0.5;
    }
    100% {
      opacity: 1;
    }
  }

  .skeleton.animate {
    animation: skeleton-pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite;
  }

  /* Alternative shimmer animation */
  @keyframes skeleton-shimmer {
    0% {
      transform: translateX(-100%);
    }
    100% {
      transform: translateX(100%);
    }
  }

  .skeleton.animate::after {
    content: '';
    position: absolute;
    top: 0;
    right: 0;
    bottom: 0;
    left: 0;
    background: linear-gradient(
      90deg,
      transparent,
      rgba(255, 255, 255, 0.2),
      transparent
    );
    transform: translateX(-100%);
    animation: skeleton-shimmer 2s infinite;
  }

  /* Screen reader only text */
  .sr-only {
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

  /* Custom sizing support */
  :host([width]) .skeleton {
    width: var(--skeleton-width, auto);
  }

  :host([height]) .skeleton {
    height: var(--skeleton-height, auto);
  }

  /* Block display for full width */
  :host([block]) {
    display: block;
  }

  /* Responsive sizing helpers */
  :host([size="sm"]) .skeleton.variant-default {
    height: 1rem;
  }

  :host([size="md"]) .skeleton.variant-default {
    height: 1.25rem;
  }

  :host([size="lg"]) .skeleton.variant-default {
    height: 1.5rem;
  }

  :host([size="xl"]) .skeleton.variant-default {
    height: 2rem;
  }

  /* Circular size variants */
  :host([size="sm"]) .skeleton.variant-circular {
    width: 2rem;
    height: 2rem;
  }

  :host([size="md"]) .skeleton.variant-circular {
    width: 2.5rem;
    height: 2.5rem;
  }

  :host([size="lg"]) .skeleton.variant-circular {
    width: 3rem;
    height: 3rem;
  }

  :host([size="xl"]) .skeleton.variant-circular {
    width: 4rem;
    height: 4rem;
  }
`;
