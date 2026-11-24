import { css } from "lit";

export const chartStyles = css`
  :host {
    display: block;
    box-sizing: border-box;
    width: 100%;
  }

  *,
  *::before,
  *::after {
    box-sizing: inherit;
  }

  .chart-container {
    position: relative;
    width: 100%;
    overflow: hidden;
  }

  svg {
    display: block;
    width: 100%;
  }

  .mark-group path,
  .mark-group rect,
  .mark-group circle {
    vector-effect: non-scaling-stroke;
  }

  .axis text {
    font-size: 10px;
    font-family: var(
      --cf-theme-font-family,
      var(--cf-font-family-sans, system-ui, sans-serif)
    );
    fill: var(--cf-theme-color-text-muted, var(--cf-colors-gray-500, #94979e));
  }

  .axis line,
  .axis path {
    stroke: var(--cf-theme-color-border, var(--cf-colors-gray-300, #d5d7dd));
    stroke-width: 1;
    fill: none;
  }

  .axis .grid-line {
    stroke: var(--cf-theme-color-border, var(--cf-colors-gray-300, #d5d7dd));
    stroke-opacity: 0.4;
    stroke-dasharray: 2 2;
  }

  .axis .axis-label {
    font-size: 11px;
    fill: var(--cf-theme-color-text-muted, var(--cf-colors-gray-500, #94979e));
    font-weight: 500;
  }

  .crosshair line {
    stroke: var(
      --cf-theme-color-text-muted,
      var(--cf-colors-gray-500, #94979e)
    );
    stroke-width: 1;
    stroke-dasharray: 4 2;
    pointer-events: none;
  }

  .tooltip {
    position: absolute;
    pointer-events: none;
    background: var(--cf-theme-color-surface-inverse, #16181d);
    color: var(--cf-theme-color-text-on-inverse, #ffffff);
    border: 1px solid var(--cf-theme-color-border, rgba(79, 89, 103, 0.15));
    border-radius: 4px;
    padding: 4px 8px;
    font-size: 12px;
    font-family: var(
      --cf-theme-font-family,
      var(--cf-font-family-sans, system-ui, sans-serif)
    );
    white-space: nowrap;
    z-index: 10;
    transform: translate(-50%, -100%);
    margin-top: -8px;
  }

  .tooltip-label {
    font-weight: 600;
    margin-right: 4px;
  }

  .interaction-overlay {
    fill: transparent;
    cursor: crosshair;
  }
`;
