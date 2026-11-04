import type { Schema } from "@commonfabric/api/schema";
import { LocationDataSchema } from "@commonfabric/runner/component-read-contract";
import { type CellHandle } from "@commonfabric/runtime-client";
import { css, html } from "lit";
import { property, state } from "lit/decorators.js";
import { classMap } from "lit/directives/class-map.js";

import { BaseElement } from "../../core/base-element.ts";
import { createCellController } from "../../core/cell-controller.ts";
import { applyThemeToElement, type CFTheme } from "../theme-context.ts";

// Schema for LocationData

/**
 * Location request state machine to prevent race conditions
 */
type LocationState = "idle" | "requesting" | "watching" | "error";

/**
 * Location data structure matching the Geolocation API
 */
export interface LocationData {
  /** Unique ID for this location capture */
  id: string;

  /** Latitude in decimal degrees */
  latitude: number;

  /** Longitude in decimal degrees */
  longitude: number;

  /** Accuracy of the position in meters */
  accuracy: number;

  /** Altitude in meters above sea level (if available) */
  altitude?: number;

  /** Accuracy of altitude in meters (if available) */
  altitudeAccuracy?: number;

  /** Direction of travel in degrees (0-360, if available) */
  heading?: number;

  /** Speed in meters per second (if available) */
  speed?: number;

  /** Unix timestamp in milliseconds when the location was captured */
  timestamp: number;
}

// Type validation: ensure schema matches interface
type _ValidateLocationData = Schema<
  typeof LocationDataSchema
> extends LocationData ? true : never;
const _validateLocationData: _ValidateLocationData = true;

/**
 * CFLocation - Browser Geolocation API wrapper component
 *
 * TODO: Add throttling option for watch mode to prevent excessive updates (1-10Hz possible)
 * TODO: Improve error messages with actionable guidance (e.g., "enable location in settings")
 * TODO: Consider renaming `continuous` prop to `mode="watch" | "single"` for clarity
 * TODO: Change maximumAge default from 0 to 30000ms to reduce battery drain
 * TODO: Add maxWatchDuration and auto-stop for continuous mode safety
 * TODO: Document in docs/common/COMPONENTS.md
 *
 * @element cf-location
 *
 * @attr {boolean} enableHighAccuracy - Request high accuracy GPS (default: false)
 * @attr {number} timeout - Timeout in milliseconds (default: 10000)
 * @attr {number} maximumAge - Maximum age of cached position in ms (default: 0)
 * @attr {boolean} continuous - Enable watch mode for continuous updates (default: false)
 * @attr {boolean} disabled - Disable location requests (default: false)
 *
 * @fires cf-location-start - Location request started. detail: { timestamp: number }
 * @fires cf-location-update - New location received. detail: { location: LocationData }
 * @fires cf-location-error - Location error occurred. detail: { error: GeolocationPositionError, message: string }
 * @fires cf-change - Location data changed. detail: { location: LocationData | null }
 *
 * @example
 * <cf-location $location={location}></cf-location>
 *
 * @example With high accuracy
 * <cf-location $location={location} enableHighAccuracy></cf-location>
 *
 * @example Continuous tracking
 * <cf-location $location={location} continuous></cf-location>
 */
export class CFLocation extends BaseElement {
  static override styles = [
    BaseElement.baseStyles,
    css`
      :host {
        display: block;
        box-sizing: border-box;
      }

      *,
      *::before,
      *::after {
        box-sizing: inherit;
      }

      .container {
        display: flex;
        flex-direction: column;
        gap: var(--cf-theme-spacing-normal, 0.5rem);
      }

      .button-row {
        display: flex;
        align-items: center;
        gap: var(--cf-theme-spacing-normal, 0.5rem);
      }

      .location-button {
        display: inline-flex;
        align-items: center;
        gap: 0.5rem;
        padding: 0.5rem 1rem;
        border-radius: var(--cf-theme-border-radius, 0.375rem);
        background-color: var(
          --cf-theme-color-surface,
          #f3f4f6
        );
        border: 1px solid var(--cf-theme-color-border, #d1d5db);
        cursor: pointer;
        transition: all 0.2s ease;
        font-size: 0.875rem;
        font-family: inherit;
        color: var(--cf-theme-color-text, inherit);
      }

      .location-button:hover:not(:disabled) {
        background-color: var(
          --cf-theme-color-surface-hover,
          #e5e7eb
        );
      }

      .location-button:active:not(:disabled) {
        transform: scale(0.98);
      }

      .location-button:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      .location-button.requesting {
        background-color: var(
          --cf-theme-color-primary-light,
          var(--cf-colors-blue-100, #dbeafe)
        );
        border-color: var(
          --cf-theme-color-primary,
          var(--cf-colors-blue-500, #3b82f6)
        );
      }

      .location-button.watching {
        background-color: var(
          --cf-theme-color-success-light,
          var(--cf-colors-green-100, #dcfce7)
        );
        border-color: var(
          --cf-theme-color-success,
          var(--cf-colors-green-500, #22c55e)
        );
        animation: pulse 2s ease-in-out infinite;
      }

      @keyframes pulse {
        0%,
        100% {
          opacity: 1;
        }
        50% {
          opacity: 0.8;
        }
      }

      .icon {
        font-size: 1rem;
      }

      .spinner {
        display: inline-block;
        width: 1rem;
        height: 1rem;
        border: 2px solid var(--cf-theme-color-border, #d1d5db);
        border-top-color: var(--cf-theme-color-primary, #3b82f6);
        border-radius: 50%;
        animation: spin 0.8s linear infinite;
      }

      @keyframes spin {
        to {
          transform: rotate(360deg);
        }
      }

      .location-display {
        font-size: 0.75rem;
        color: var(--cf-theme-color-text-muted, #6b7280);
        font-family: var(--cf-theme-mono-font-family, monospace);
      }

      .location-display .coords {
        font-weight: 500;
      }

      .location-display .accuracy {
        margin-left: 0.5rem;
        opacity: 0.8;
      }

      .error {
        padding: 0.5rem;
        border-radius: var(--cf-theme-border-radius, 0.375rem);
        background-color: var(
          --cf-theme-color-error-light,
          var(--cf-colors-red-100, #fee2e2)
        );
        color: var(--cf-theme-color-error, var(--cf-colors-red-600, #dc2626));
        font-size: 0.75rem;
      }
    `,
  ];

  /**
   * A theme given to this element directly, written over the theme it would
   * otherwise inherit. Left unset, the element draws the ambient theme.
   */
  @property({ attribute: false })
  accessor theme: CFTheme | undefined = undefined;

  /** The location data, or a cell binding for it. */
  @property({ attribute: false })
  accessor location: CellHandle<LocationData | null> | LocationData | null =
    null;

  // Configuration
  @property({ type: Boolean })
  accessor enableHighAccuracy = false;

  @property({ type: Number })
  accessor timeout = 10000;

  @property({ type: Number })
  accessor maximumAge = 0;

  @property({ type: Boolean })
  accessor continuous = false;

  @property({ type: Boolean })
  accessor disabled = false;

  // Internal state
  @state()
  private accessor _state: LocationState = "idle";

  @state()
  private accessor _errorMessage = "";

  private _watchId: number | null = null;

  private _cellController = createCellController<LocationData | null>(this, {
    timing: { strategy: "immediate" },
    onChange: (newValue) => {
      this.emit("cf-change", { location: newValue });
    },
  });

  override firstUpdated(changedProperties: Map<string, unknown>) {
    super.firstUpdated(changedProperties);
    this._cellController.bind(this.location, LocationDataSchema);
  }

  override willUpdate(changedProperties: Map<string, unknown>) {
    super.willUpdate(changedProperties);
    if (changedProperties.has("location")) {
      this._cellController.bind(this.location, LocationDataSchema);
    }
  }

  override updated(changedProperties: Map<string, unknown>) {
    if (changedProperties.has("theme")) {
      applyThemeToElement(this, this.theme);
    }
  }

  override disconnectedCallback() {
    this._cleanup();
    super.disconnectedCallback();
  }

  private _cleanup() {
    if (this._watchId !== null) {
      navigator.geolocation.clearWatch(this._watchId);
      this._watchId = null;
    }
    this._state = "idle";
  }

  /**
   * Request the current location (one-shot)
   */
  requestLocation(): Promise<LocationData | null> {
    if (!navigator.geolocation) {
      this._handleError({
        code: 2,
        message: "Geolocation is not supported by this browser",
        PERMISSION_DENIED: 1,
        POSITION_UNAVAILABLE: 2,
        TIMEOUT: 3,
      } as GeolocationPositionError);
      return Promise.resolve(null);
    }

    if (this._state === "requesting") {
      return Promise.resolve(null);
    }

    this._state = "requesting";
    this._errorMessage = "";
    this.emit("cf-location-start", { timestamp: Date.now() });

    return new Promise((resolve) => {
      navigator.geolocation.getCurrentPosition(
        (position) => {
          if (!this.isConnected) return;
          const locationData = this._positionToLocationData(position);
          this._cellController.setValue(locationData);
          this._state = "idle";
          this.emit("cf-location-update", { location: locationData });
          resolve(locationData);
        },
        (error) => {
          if (!this.isConnected) return;
          this._handleError(error);
          this._state = "error";
          resolve(null);
        },
        {
          enableHighAccuracy: this.enableHighAccuracy,
          timeout: this.timeout,
          maximumAge: this.maximumAge,
        },
      );
    });
  }

  /**
   * Start watching location (continuous mode)
   */
  startWatching(): void {
    if (!navigator.geolocation) {
      this._handleError({
        code: 2,
        message: "Geolocation is not supported by this browser",
        PERMISSION_DENIED: 1,
        POSITION_UNAVAILABLE: 2,
        TIMEOUT: 3,
      } as GeolocationPositionError);
      return;
    }

    if (this._watchId !== null) {
      return; // Already watching
    }

    this._state = "watching";
    this._errorMessage = "";
    this.emit("cf-location-start", { timestamp: Date.now() });

    this._watchId = navigator.geolocation.watchPosition(
      (position) => {
        if (!this.isConnected) return;
        const locationData = this._positionToLocationData(position);
        this._cellController.setValue(locationData);
        this.emit("cf-location-update", { location: locationData });
      },
      (error) => {
        if (!this.isConnected) return;
        this._handleError(error);
        this._cleanup();
        this._state = "error";
      },
      {
        enableHighAccuracy: this.enableHighAccuracy,
        timeout: this.timeout,
        maximumAge: this.maximumAge,
      },
    );
  }

  /**
   * Stop watching location
   */
  stopWatching(): void {
    this._cleanup();
  }

  private _positionToLocationData(position: GeolocationPosition): LocationData {
    const coords = position.coords;
    return {
      id: crypto.randomUUID(),
      latitude: coords.latitude,
      longitude: coords.longitude,
      accuracy: coords.accuracy,
      altitude: coords.altitude ?? undefined,
      altitudeAccuracy: coords.altitudeAccuracy ?? undefined,
      heading: coords.heading ?? undefined,
      speed: coords.speed ?? undefined,
      timestamp: position.timestamp,
    };
  }

  private _handleError(error: GeolocationPositionError) {
    let message: string;

    switch (error.code) {
      case error.PERMISSION_DENIED:
        message = "Location permission denied";
        break;
      case error.POSITION_UNAVAILABLE:
        message = "Location unavailable";
        break;
      case error.TIMEOUT:
        message = "Location request timed out";
        break;
      default:
        message = `Location error: ${error.message}`;
    }

    this._errorMessage = message;
    this.emit("cf-location-error", { error, message });
  }

  private _handleButtonClick() {
    if (this.disabled) return;

    if (this.continuous) {
      if (this._state === "watching") {
        this.stopWatching();
      } else {
        this.startWatching();
      }
    } else {
      this.requestLocation();
    }
  }

  private _getButtonText(): string {
    if (this._state === "requesting") {
      return "Getting...";
    }
    if (this._state === "watching") {
      return "Stop Tracking";
    }

    const currentLocation = this._cellController.getValue();
    if (currentLocation) {
      return "Update Location";
    }

    return this.continuous ? "Start Tracking" : "Get Location";
  }

  private _getButtonIcon(): string {
    if (this._state === "requesting") {
      return ""; // Will show spinner instead
    }
    if (this._state === "watching") {
      return "\u{23F9}"; // Stop
    }
    return "\u{1F4CD}"; // Pin
  }

  private _formatCoords(location: LocationData): string {
    const lat = location.latitude.toFixed(6);
    const lng = location.longitude.toFixed(6);
    return `${lat}, ${lng}`;
  }

  private _formatAccuracy(accuracy: number): string {
    if (accuracy < 10) {
      return `\u00B1${accuracy.toFixed(0)}m`;
    }
    if (accuracy < 100) {
      return `\u00B1${accuracy.toFixed(0)}m`;
    }
    return `\u00B1${(accuracy / 1000).toFixed(1)}km`;
  }

  override render() {
    const currentLocation = this._cellController.getValue();

    const buttonClasses = {
      "location-button": true,
      requesting: this._state === "requesting",
      watching: this._state === "watching",
    };

    return html`
      <div class="container">
        <div class="button-row">
          <button
            class="${classMap(buttonClasses)}"
            ?disabled="${this.disabled || this._state === "requesting"}"
            @click="${this._handleButtonClick}"
            aria-label="${this._getButtonText()}"
          >
            ${this._state === "requesting"
              ? html`
                <span class="spinner"></span>
              `
              : html`
                <span class="icon">${this._getButtonIcon()}</span>
              `}
            <span>${this._getButtonText()}</span>
          </button>
        </div>

        ${currentLocation
          ? html`
            <div class="location-display">
              <span class="coords">${this._formatCoords(currentLocation)}</span>
              <span class="accuracy">${this._formatAccuracy(
                currentLocation.accuracy,
              )}</span>
            </div>
          `
          : ""} ${this._errorMessage
          ? html`
            <div class="error">${this._errorMessage}</div>
          `
          : ""}
      </div>
    `;
  }
}
