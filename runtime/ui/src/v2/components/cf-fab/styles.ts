import { css } from "lit";

/**
 * Shared animation keyframes and utilities for the FAB system
 */
export const fabAnimations = css`
  /* Spring easing for bouncy morphing effect */
  :host {
    --fab-spring-easing: cubic-bezier(0.34, 1.56, 0.64, 1);
    --fab-ease-out: cubic-bezier(0.4, 0, 0.2, 1);
  }

  /* Fade in animation for panel content */
  @keyframes fabContentFadeIn {
    from {
      opacity: 0;
      transform: translateY(10px) scale(0.98);
    }
    to {
      opacity: 1;
      transform: translateY(0) scale(1);
    }
  }

  /* Fade out animation for panel content */
  @keyframes fabContentFadeOut {
    from {
      opacity: 1;
      transform: translateY(0) scale(1);
    }
    to {
      opacity: 0;
      transform: translateY(10px) scale(0.98);
    }
  }

  /* Slide in from bottom */
  @keyframes fabSlideIn {
    from {
      transform: translateY(100%);
      opacity: 0;
    }
    to {
      transform: translateY(0);
      opacity: 1;
    }
  }

  /* Pulse animation for notification indicator */
  @keyframes fabPulse {
    0%,
    100% {
      opacity: 1;
      transform: scale(1);
    }
    50% {
      opacity: 0.8;
      transform: scale(1.05);
    }
  }

  /* Staggered fade-in for list items */
  @keyframes fabStaggerFadeIn {
    from {
      opacity: 0;
      transform: scale(0.9) translateY(-5px);
    }
    to {
      opacity: 1;
      transform: scale(1) translateY(0);
    }
  }
`;
