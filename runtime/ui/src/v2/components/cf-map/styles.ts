/**
 * Styles for cf-map component
 * Includes Leaflet core CSS and cf-* theme integration
 */

import { css } from "lit";

export const styles = css`
  /*
  ** Leaflet Core CSS (v1.9.4)
  **
  ** Required for proper map rendering in Shadow DOM
  */

  /* required styles */

  .leaflet-pane,
  .leaflet-tile,
  .leaflet-marker-icon,
  .leaflet-marker-shadow,
  .leaflet-tile-container,
  .leaflet-pane > svg,
  .leaflet-pane > canvas,
  .leaflet-zoom-box,
  .leaflet-image-layer,
  .leaflet-layer {
    position: absolute;
    left: 0;
    top: 0;
  }
  .leaflet-container {
    overflow: hidden;
  }
  .leaflet-tile,
  .leaflet-marker-icon,
  .leaflet-marker-shadow {
    -webkit-user-select: none;
    -moz-user-select: none;
    user-select: none;
    -webkit-user-drag: none;
  }
  /* Prevents IE11 from highlighting tiles in blue */
  .leaflet-tile::selection {
    background: transparent;
  }
  /* Safari renders non-retina tile on retina better with this, but Chrome is worse */
  .leaflet-safari .leaflet-tile {
    image-rendering: -webkit-optimize-contrast;
  }
  /* hack that prevents hw layers "stretching" when loading new tiles */
  .leaflet-safari .leaflet-tile-container {
    width: 1600px;
    height: 1600px;
    -webkit-transform-origin: 0 0;
  }
  .leaflet-marker-icon,
  .leaflet-marker-shadow {
    display: block;
  }
  /* .leaflet-container svg: reset svg max-width decleration shipped in Joomla! (joomla.org) 3.x */
  /* .leaflet-container img: map is broken in FF if you have max-width: 100% on tiles */
  .leaflet-container .leaflet-overlay-pane svg {
    max-width: none !important;
    max-height: none !important;
  }
  .leaflet-container .leaflet-marker-pane img,
  .leaflet-container .leaflet-shadow-pane img,
  .leaflet-container .leaflet-tile-pane img,
  .leaflet-container img.leaflet-image-layer,
  .leaflet-container .leaflet-tile {
    max-width: none !important;
    max-height: none !important;
    width: auto;
    padding: 0;
  }

  .leaflet-container img.leaflet-tile {
    /* See: https://bugs.chromium.org/p/chromium/issues/detail?id=600120 */
    mix-blend-mode: plus-lighter;
  }

  .leaflet-container.leaflet-touch-zoom {
    -ms-touch-action: pan-x pan-y;
    touch-action: pan-x pan-y;
  }
  .leaflet-container.leaflet-touch-drag {
    -ms-touch-action: pinch-zoom;
    /* Fallback for FF which doesn't support pinch-zoom */
    touch-action: none;
    touch-action: pinch-zoom;
  }
  .leaflet-container.leaflet-touch-drag.leaflet-touch-zoom {
    -ms-touch-action: none;
    touch-action: none;
  }
  .leaflet-container {
    -webkit-tap-highlight-color: transparent;
  }
  .leaflet-container a {
    -webkit-tap-highlight-color: rgba(51, 181, 229, 0.4);
  }
  .leaflet-tile {
    filter: inherit;
    visibility: hidden;
  }
  .leaflet-tile-loaded {
    visibility: visible;
  }
  .leaflet-zoom-box {
    width: 0;
    height: 0;
    -moz-box-sizing: border-box;
    box-sizing: border-box;
    z-index: 800;
  }
  /* workaround for https://bugzilla.mozilla.org/show_bug.cgi?id=888319 */
  .leaflet-overlay-pane svg {
    -moz-user-select: none;
  }

  .leaflet-pane {
    z-index: 400;
  }

  .leaflet-tile-pane {
    z-index: 200;
  }
  .leaflet-overlay-pane {
    z-index: 400;
  }
  .leaflet-shadow-pane {
    z-index: 500;
  }
  .leaflet-marker-pane {
    z-index: 600;
  }
  .leaflet-tooltip-pane {
    z-index: 650;
  }
  .leaflet-popup-pane {
    z-index: 700;
  }

  .leaflet-map-pane canvas {
    z-index: 100;
  }
  .leaflet-map-pane svg {
    z-index: 200;
  }

  .leaflet-vml-shape {
    width: 1px;
    height: 1px;
  }
  .lvml {
    behavior: url(#default#VML);
    display: inline-block;
    position: absolute;
  }

  /* control positioning */

  .leaflet-control {
    position: relative;
    z-index: 800;
    pointer-events: visiblePainted; /* IE 9-10 doesn't have auto */
    pointer-events: auto;
  }
  .leaflet-top,
  .leaflet-bottom {
    position: absolute;
    z-index: 1000;
    pointer-events: none;
  }
  .leaflet-top {
    top: 0;
  }
  .leaflet-right {
    right: 0;
  }
  .leaflet-bottom {
    bottom: 0;
  }
  .leaflet-left {
    left: 0;
  }
  .leaflet-control {
    float: left;
    clear: both;
  }
  .leaflet-right .leaflet-control {
    float: right;
  }
  .leaflet-top .leaflet-control {
    margin-top: 10px;
  }
  .leaflet-bottom .leaflet-control {
    margin-bottom: 10px;
  }
  .leaflet-left .leaflet-control {
    margin-left: 10px;
  }
  .leaflet-right .leaflet-control {
    margin-right: 10px;
  }

  /* zoom and fade animations */

  .leaflet-fade-anim .leaflet-popup {
    opacity: 0;
    -webkit-transition: opacity 0.2s linear;
    -moz-transition: opacity 0.2s linear;
    transition: opacity 0.2s linear;
  }
  .leaflet-fade-anim .leaflet-map-pane .leaflet-popup {
    opacity: 1;
  }
  .leaflet-zoom-animated {
    -webkit-transform-origin: 0 0;
    -ms-transform-origin: 0 0;
    transform-origin: 0 0;
  }
  svg.leaflet-zoom-animated {
    will-change: transform;
  }

  .leaflet-zoom-anim .leaflet-zoom-animated {
    -webkit-transition: -webkit-transform 0.25s cubic-bezier(0, 0, 0.25, 1);
    -moz-transition: -moz-transform 0.25s cubic-bezier(0, 0, 0.25, 1);
    transition: transform 0.25s cubic-bezier(0, 0, 0.25, 1);
  }
  .leaflet-zoom-anim .leaflet-tile,
  .leaflet-pan-anim .leaflet-tile {
    -webkit-transition: none;
    -moz-transition: none;
    transition: none;
  }

  .leaflet-zoom-anim .leaflet-zoom-hide {
    visibility: hidden;
  }

  /* cursors */

  .leaflet-interactive {
    cursor: pointer;
  }
  .leaflet-grab {
    cursor: -webkit-grab;
    cursor: -moz-grab;
    cursor: grab;
  }
  .leaflet-crosshair,
  .leaflet-crosshair .leaflet-interactive {
    cursor: crosshair;
  }
  .leaflet-popup-pane,
  .leaflet-control {
    cursor: auto;
  }
  .leaflet-dragging .leaflet-grab,
  .leaflet-dragging .leaflet-grab .leaflet-interactive,
  .leaflet-dragging .leaflet-marker-draggable {
    cursor: move;
    cursor: -webkit-grabbing;
    cursor: -moz-grabbing;
    cursor: grabbing;
  }

  /* marker & overlays interactivity */
  .leaflet-marker-icon,
  .leaflet-marker-shadow,
  .leaflet-image-layer,
  .leaflet-pane > svg path,
  .leaflet-tile-container {
    pointer-events: none;
  }

  .leaflet-marker-icon.leaflet-interactive,
  .leaflet-image-layer.leaflet-interactive,
  .leaflet-pane > svg path.leaflet-interactive,
  svg.leaflet-image-layer.leaflet-interactive path {
    pointer-events: visiblePainted; /* IE 9-10 doesn't have auto */
    pointer-events: auto;
  }

  /* visual tweaks */

  .leaflet-container {
    background: #ddd;
    outline-offset: 1px;
  }
  .leaflet-container a {
    color: #0078a8;
  }
  .leaflet-zoom-box {
    border: 2px dotted #38f;
    background: rgba(255, 255, 255, 0.5);
  }

  /* general typography */
  .leaflet-container {
    font-family: "Helvetica Neue", Arial, Helvetica, sans-serif;
    font-size: 12px;
    font-size: 0.75rem;
    line-height: 1.5;
  }

  /* general toolbar styles */

  .leaflet-bar {
    box-shadow: 0 1px 5px rgba(0, 0, 0, 0.65);
    border-radius: 4px;
  }
  .leaflet-bar a {
    background-color: #fff;
    border-bottom: 1px solid #ccc;
    width: 26px;
    height: 26px;
    line-height: 26px;
    display: block;
    text-align: center;
    text-decoration: none;
    color: black;
  }
  .leaflet-bar a,
  .leaflet-control-layers-toggle {
    background-position: 50% 50%;
    background-repeat: no-repeat;
    display: block;
  }
  .leaflet-bar a:hover,
  .leaflet-bar a:focus {
    background-color: #f4f4f4;
  }
  .leaflet-bar a:first-child {
    border-top-left-radius: 4px;
    border-top-right-radius: 4px;
  }
  .leaflet-bar a:last-child {
    border-bottom-left-radius: 4px;
    border-bottom-right-radius: 4px;
    border-bottom: none;
  }
  .leaflet-bar a.leaflet-disabled {
    cursor: default;
    background-color: #f4f4f4;
    color: #bbb;
  }

  .leaflet-touch .leaflet-bar a {
    width: 30px;
    height: 30px;
    line-height: 30px;
  }
  .leaflet-touch .leaflet-bar a:first-child {
    border-top-left-radius: 2px;
    border-top-right-radius: 2px;
  }
  .leaflet-touch .leaflet-bar a:last-child {
    border-bottom-left-radius: 2px;
    border-bottom-right-radius: 2px;
  }

  /* zoom control */

  .leaflet-control-zoom-in,
  .leaflet-control-zoom-out {
    font: bold 18px "Lucida Console", Monaco, monospace;
    text-indent: 1px;
  }

  .leaflet-touch .leaflet-control-zoom-in,
  .leaflet-touch .leaflet-control-zoom-out {
    font-size: 22px;
  }

  /* layers control */

  .leaflet-control-layers {
    box-shadow: 0 1px 5px rgba(0, 0, 0, 0.4);
    background: #fff;
    border-radius: 5px;
  }
  .leaflet-control-layers-toggle {
    /* Leaflet's default layers control image URLs do not work in Shadow DOM
      because the relative path 'images/layers.png' cannot be resolved.
      The component uses alternative styling or the layers control is not displayed. */
    /* background-image: url(images/layers.png); */
    width: 36px;
    height: 36px;
  }
  .leaflet-retina .leaflet-control-layers-toggle {
    /* Retina variant - also disabled due to Shadow DOM path resolution issues */
    /* background-image: url(images/layers-2x.png); */
    background-size: 26px 26px;
  }
  .leaflet-touch .leaflet-control-layers-toggle {
    width: 44px;
    height: 44px;
  }
  .leaflet-control-layers .leaflet-control-layers-list,
  .leaflet-control-layers-expanded .leaflet-control-layers-toggle {
    display: none;
  }
  .leaflet-control-layers-expanded .leaflet-control-layers-list {
    display: block;
    position: relative;
  }
  .leaflet-control-layers-expanded {
    padding: 6px 10px 6px 6px;
    color: #333;
    background: #fff;
  }
  .leaflet-control-layers-scrollbar {
    overflow-y: scroll;
    overflow-x: hidden;
    padding-right: 5px;
  }
  .leaflet-control-layers-selector {
    margin-top: 2px;
    position: relative;
    top: 1px;
  }
  .leaflet-control-layers label {
    display: block;
    font-size: 13px;
    font-size: 1.08333em;
  }
  .leaflet-control-layers-separator {
    height: 0;
    border-top: 1px solid #ddd;
    margin: 5px -10px 5px -6px;
  }

  /* Default icon URLs */
  .leaflet-default-icon-path {
    /* used only in path-guessing heuristic, see L.Icon.Default */
    /* Disabled in Shadow DOM: the default marker icons cannot be resolved from relative paths.
      The cf-map component uses custom emoji markers instead, so these icons are not needed. */
    /* background-image: url(images/marker-icon.png); */
  }

  /* attribution and scale controls */

  .leaflet-container .leaflet-control-attribution {
    background: #fff;
    background: rgba(255, 255, 255, 0.8);
    margin: 0;
  }
  .leaflet-control-attribution,
  .leaflet-control-scale-line {
    padding: 0 5px;
    color: #333;
    line-height: 1.4;
  }
  .leaflet-control-attribution a {
    text-decoration: none;
  }
  .leaflet-control-attribution a:hover,
  .leaflet-control-attribution a:focus {
    text-decoration: underline;
  }
  .leaflet-attribution-flag {
    display: inline !important;
    vertical-align: baseline !important;
    width: 1em;
    height: 0.6669em;
  }
  .leaflet-left .leaflet-control-scale {
    margin-left: 5px;
  }
  .leaflet-bottom .leaflet-control-scale {
    margin-bottom: 5px;
  }
  .leaflet-control-scale-line {
    border: 2px solid #777;
    border-top: none;
    line-height: 1.1;
    padding: 2px 5px 1px;
    white-space: nowrap;
    -moz-box-sizing: border-box;
    box-sizing: border-box;
    background: rgba(255, 255, 255, 0.8);
    text-shadow: 1px 1px #fff;
  }
  .leaflet-control-scale-line:not(:first-child) {
    border-top: 2px solid #777;
    border-bottom: none;
    margin-top: -2px;
  }
  .leaflet-control-scale-line:not(:first-child):not(:last-child) {
    border-bottom: 2px solid #777;
  }

  .leaflet-touch .leaflet-control-attribution,
  .leaflet-touch .leaflet-control-layers,
  .leaflet-touch .leaflet-bar {
    box-shadow: none;
  }
  .leaflet-touch .leaflet-control-layers,
  .leaflet-touch .leaflet-bar {
    border: 2px solid rgba(0, 0, 0, 0.2);
    background-clip: padding-box;
  }

  /* popup */

  .leaflet-popup {
    position: absolute;
    text-align: center;
    margin-bottom: 20px;
  }
  .leaflet-popup-content-wrapper {
    padding: 1px;
    text-align: left;
    border-radius: 12px;
  }
  .leaflet-popup-content {
    margin: 13px 24px 13px 20px;
    line-height: 1.3;
    font-size: 13px;
    font-size: 1.08333em;
    min-height: 1px;
  }
  .leaflet-popup-content p {
    margin: 17px 0;
    margin: 1.3em 0;
  }
  .leaflet-popup-tip-container {
    width: 40px;
    height: 20px;
    position: absolute;
    left: 50%;
    margin-top: -1px;
    margin-left: -20px;
    overflow: hidden;
    pointer-events: none;
  }
  .leaflet-popup-tip {
    width: 17px;
    height: 17px;
    padding: 1px;

    margin: -10px auto 0;
    pointer-events: auto;

    -webkit-transform: rotate(45deg);
    -moz-transform: rotate(45deg);
    -ms-transform: rotate(45deg);
    transform: rotate(45deg);
  }
  .leaflet-popup-content-wrapper,
  .leaflet-popup-tip {
    background: white;
    color: #333;
    box-shadow: 0 3px 14px rgba(0, 0, 0, 0.4);
  }
  .leaflet-container a.leaflet-popup-close-button {
    position: absolute;
    top: 0;
    right: 0;
    border: none;
    text-align: center;
    width: 24px;
    height: 24px;
    font: 16px/24px Tahoma, Verdana, sans-serif;
    color: #757575;
    text-decoration: none;
    background: transparent;
  }
  .leaflet-container a.leaflet-popup-close-button:hover,
  .leaflet-container a.leaflet-popup-close-button:focus {
    color: #585858;
  }
  .leaflet-popup-scrolled {
    overflow: auto;
  }

  .leaflet-oldie .leaflet-popup-content-wrapper {
    -ms-zoom: 1;
  }
  .leaflet-oldie .leaflet-popup-tip {
    width: 24px;
    margin: 0 auto;

    -ms-filter: "progid:DXImageTransform.Microsoft.Matrix(M11=0.70710678, M12=0.70710678, M21=-0.70710678, M22=0.70710678)";
    filter: progid:DXImageTransform.Microsoft.Matrix(M11=0.70710678,
      M12=0.70710678, M21=-0.70710678, M22=0.70710678);
  }

  .leaflet-oldie .leaflet-control-zoom,
  .leaflet-oldie .leaflet-control-layers,
  .leaflet-oldie .leaflet-popup-content-wrapper,
  .leaflet-oldie .leaflet-popup-tip {
    border: 1px solid #999;
  }

  /* div icon */

  .leaflet-div-icon {
    background: #fff;
    border: 1px solid #666;
  }

  /* Tooltip */
  /* Base styles for the element that has a tooltip */
  .leaflet-tooltip {
    position: absolute;
    padding: 6px;
    background-color: #fff;
    border: 1px solid #fff;
    border-radius: 3px;
    color: #222;
    white-space: nowrap;
    -webkit-user-select: none;
    -moz-user-select: none;
    -ms-user-select: none;
    user-select: none;
    pointer-events: none;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.4);
  }
  .leaflet-tooltip.leaflet-interactive {
    cursor: pointer;
    pointer-events: auto;
  }
  .leaflet-tooltip-top:before,
  .leaflet-tooltip-bottom:before,
  .leaflet-tooltip-left:before,
  .leaflet-tooltip-right:before {
    position: absolute;
    pointer-events: none;
    border: 6px solid transparent;
    background: transparent;
    content: "";
  }

  /* Directions */

  .leaflet-tooltip-bottom {
    margin-top: 6px;
  }
  .leaflet-tooltip-top {
    margin-top: -6px;
  }
  .leaflet-tooltip-bottom:before,
  .leaflet-tooltip-top:before {
    left: 50%;
    margin-left: -6px;
  }
  .leaflet-tooltip-top:before {
    bottom: 0;
    margin-bottom: -12px;
    border-top-color: #fff;
  }
  .leaflet-tooltip-bottom:before {
    top: 0;
    margin-top: -12px;
    margin-left: -6px;
    border-bottom-color: #fff;
  }
  .leaflet-tooltip-left {
    margin-left: -6px;
  }
  .leaflet-tooltip-right {
    margin-left: 6px;
  }
  .leaflet-tooltip-left:before,
  .leaflet-tooltip-right:before {
    top: 50%;
    margin-top: -6px;
  }
  .leaflet-tooltip-left:before {
    right: 0;
    margin-right: -12px;
    border-left-color: #fff;
  }
  .leaflet-tooltip-right:before {
    left: 0;
    margin-left: -12px;
    border-right-color: #fff;
  }

  /* Printing */

  @media print {
    /* Prevent printers from removing background-images of controls. */
    .leaflet-control {
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }
  }

  /*
  ** cf-map Component Styles
  **
  ** Theme-integrated styles for the map container
  */

  :host {
    display: block;
    width: 100%;
    height: 100%;
    min-height: 300px;
    position: relative;
    isolation: isolate;

    /* Default color values if not provided */
    --background: #ffffff;
    --foreground: var(--cf-colors-gray-900, #16181d);
    --border: var(--cf-colors-gray-300, #d5d7dd);
    --primary: var(--cf-colors-primary-500, #4979fa);
    --ring: var(--cf-colors-primary-500, #4979fa);
  }

  .map-container {
    width: 100%;
    height: 100%;
    min-height: inherit;
    border-radius: var(--cf-border-radius-md, 0.375rem);
    overflow: hidden;
    position: relative;
  }

  /* Override Leaflet container background with theme */
  .map-container .leaflet-container {
    width: 100%;
    height: 100%;
    background: var(--cf-colors-gray-100, #f2f3f6);
    font-family: var(--cf-font-family, inherit);
  }

  /*
  ** Popup Theme Integration
  **
  ** Override Leaflet popup styles with cf-* theme
  */

  .leaflet-popup-content-wrapper,
  .leaflet-popup-tip {
    background: var(--background, #ffffff);
    color: var(--foreground, #0f172a);
    box-shadow: var(
      --cf-shadow-md,
      0 4px 6px -1px rgba(0, 0, 0, 0.1),
      0 2px 4px -1px rgba(0, 0, 0, 0.06)
    );
    border: 1px solid var(--border, #e2e8f0);
  }

  .leaflet-popup-content-wrapper {
    border-radius: var(--cf-border-radius-lg, 0.5rem);
    padding: 0;
  }

  .leaflet-popup-content {
    margin: var(--cf-spacing-3, 0.75rem) var(--cf-spacing-4, 1rem);
    font-size: var(--cf-font-size-sm, 0.875rem);
    line-height: var(--cf-line-height-normal, 1.5);
    font-family: var(--cf-font-family, inherit);
  }

  /* Simple popup styling */
  .popup-simple {
    padding: var(--cf-spacing-2, 0.5rem) 0;
  }

  .popup-icon {
    font-size: var(--cf-font-size-2xl, 1.5rem);
    margin-bottom: var(--cf-spacing-2, 0.5rem);
    text-align: center;
  }

  .popup-title {
    font-weight: var(--cf-font-weight-semibold, 600);
    color: var(--foreground, #0f172a);
    margin-bottom: var(--cf-spacing-1, 0.25rem);
    font-size: var(--cf-font-size-base, 1rem);
  }

  .popup-description {
    color: var(--cf-colors-gray-600, #5b5f65);
    font-size: var(--cf-font-size-sm, 0.875rem);
    margin: 0;
  }

  /* Close button theming */
  .leaflet-container a.leaflet-popup-close-button {
    color: var(--cf-colors-gray-500, #5b5f65);
    width: 28px;
    height: 28px;
    font-size: 18px;
    line-height: 28px;
    top: var(--cf-spacing-2, 0.5rem);
    right: var(--cf-spacing-2, 0.5rem);
    border-radius: var(--cf-border-radius-sm, 0.25rem);
    transition: all var(--cf-theme-animation-duration, 150ms)
      var(--cf-transition-timing-ease, cubic-bezier(0.4, 0, 0.2, 1));
  }

  .leaflet-container a.leaflet-popup-close-button:hover,
  .leaflet-container a.leaflet-popup-close-button:focus {
    color: var(--foreground, #0f172a);
    background: var(--cf-colors-gray-100, #f2f3f6);
  }

  /* Control theming */
  .leaflet-bar {
    border: 1px solid var(--border, #e2e8f0);
    box-shadow: var(
      --cf-shadow-sm,
      0 1px 2px 0 rgba(0, 0, 0, 0.05)
    );
    border-radius: var(--cf-border-radius-md, 0.375rem);
  }

  .leaflet-bar a {
    background-color: var(--background, #ffffff);
    color: var(--foreground, #0f172a);
    border-bottom: 1px solid var(--border, #e2e8f0);
    transition: all var(--cf-theme-animation-duration, 150ms)
      var(--cf-transition-timing-ease, cubic-bezier(0.4, 0, 0.2, 1));
  }

  .leaflet-bar a:hover {
    background-color: var(--cf-colors-gray-100, #f2f3f6);
  }

  .leaflet-bar a:first-child {
    border-top-left-radius: var(--cf-border-radius-md, 0.375rem);
    border-top-right-radius: var(--cf-border-radius-md, 0.375rem);
  }

  .leaflet-bar a:last-child {
    border-bottom-left-radius: var(--cf-border-radius-md, 0.375rem);
    border-bottom-right-radius: var(--cf-border-radius-md, 0.375rem);
  }

  /* Attribution theming */
  .leaflet-container .leaflet-control-attribution {
    background: var(--background, rgba(255, 255, 255, 0.9));
    color: var(--cf-colors-gray-600, #5b5f65);
    font-size: var(--cf-font-size-xs, 0.75rem);
    border-top: 1px solid var(--border, #e2e8f0);
  }

  .leaflet-control-attribution a {
    color: var(--primary, #3b82f6);
  }

  /* Focus state */
  .leaflet-container:focus {
    outline: 2px solid var(--ring, #3b82f6);
    outline-offset: 2px;
  }

  /*
  ** Custom Marker Icon Styles
  **
  ** Styles for divIcon-based markers (emoji and default)
  */

  /* Default marker icon (SVG pin) */
  .cf-map-default-marker {
    background: transparent !important;
    border: none !important;
  }

  .cf-map-default-marker svg {
    display: block;
    filter: drop-shadow(0 2px 2px rgba(0, 0, 0, 0.3));
  }

  /* Emoji marker icon */
  .cf-map-emoji-marker {
    background: transparent !important;
    border: none !important;
  }

  .cf-map-emoji-marker .emoji-marker {
    font-size: 24px;
    line-height: 1;
    filter: drop-shadow(0 2px 2px rgba(0, 0, 0, 0.3));
  }
`;
