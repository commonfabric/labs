/**
 * Styles for cf-aspect-ratio component
 */

export const aspectRatioStyles = `
  :host {
    display: block;
    position: relative;
    width: 100%;
    overflow: hidden;
  }

  .aspect-ratio-container {
    position: relative;
    width: 100%;
    height: 0;
    overflow: hidden;
  }

  .aspect-ratio-content {
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
  }

  /* Allow content to fill the container */
  .aspect-ratio-content ::slotted(*) {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  /* Special handling for images and videos */
  .aspect-ratio-content ::slotted(img),
  .aspect-ratio-content ::slotted(video),
  .aspect-ratio-content ::slotted(iframe) {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  /* Allow customization of object-fit */
  :host([object-fit="contain"]) .aspect-ratio-content ::slotted(img),
  :host([object-fit="contain"]) .aspect-ratio-content ::slotted(video) {
    object-fit: contain;
  }

  :host([object-fit="fill"]) .aspect-ratio-content ::slotted(img),
  :host([object-fit="fill"]) .aspect-ratio-content ::slotted(video) {
    object-fit: fill;
  }

  :host([object-fit="none"]) .aspect-ratio-content ::slotted(img),
  :host([object-fit="none"]) .aspect-ratio-content ::slotted(video) {
    object-fit: none;
  }

  :host([object-fit="scale-down"]) .aspect-ratio-content ::slotted(img),
  :host([object-fit="scale-down"]) .aspect-ratio-content ::slotted(video) {
    object-fit: scale-down;
  }

  /* Common aspect ratio presets */
  :host([ratio="square"]) .aspect-ratio-container,
  :host([ratio="1/1"]) .aspect-ratio-container {
    padding-bottom: 100%;
  }

  :host([ratio="video"]) .aspect-ratio-container,
  :host([ratio="16/9"]) .aspect-ratio-container {
    padding-bottom: 56.25%;
  }

  :host([ratio="4/3"]) .aspect-ratio-container {
    padding-bottom: 75%;
  }

  :host([ratio="3/2"]) .aspect-ratio-container {
    padding-bottom: 66.666667%;
  }

  :host([ratio="21/9"]) .aspect-ratio-container {
    padding-bottom: 42.857143%;
  }

  :host([ratio="9/16"]) .aspect-ratio-container {
    padding-bottom: 177.777778%;
  }

  /* Ensure proper stacking context */
  .aspect-ratio-content > * {
    position: relative;
    z-index: 1;
  }

  /* Debug mode */
  :host([debug]) .aspect-ratio-container {
    background-color: rgba(255, 0, 0, 0.1);
    border: 2px dashed rgba(255, 0, 0, 0.5);
  }

  /* Responsive behavior */
  @media (max-width: 640px) {
    :host([mobile-ratio]) .aspect-ratio-container {
      /* Mobile ratio will be handled by JavaScript */
    }
  }
`;
