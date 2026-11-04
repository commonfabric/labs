import {
  boundsSchema,
  latLngSchema,
  mapValueSchema,
} from "@commonfabric/runner/component-read-contract";
/**
 * cf-map - Interactive map component using Leaflet
 *
 * Displays markers, circles, and polylines with bidirectional Cell reactivity.
 * Uses OpenStreetMap tiles (no API key required).
 */
import { type CellHandle } from "@commonfabric/runtime-client";
// @ts-types="@types/leaflet"
import * as L from "leaflet";
import { html, PropertyValues } from "lit";

import { BaseElement } from "../../core/base-element.ts";
import { createCellController } from "../../core/cell-controller.ts";
import { styles } from "./styles.ts";
import type {
  Bounds,
  CfBoundsChangeDetail,
  CfCircleClickDetail,
  CfClickDetail,
  CfMarkerClickDetail,
  CfMarkerDragEndDetail,
  LatLng,
  MapCircle,
  MapMarker,
  MapPolyline,
  MapValue,
} from "./types.ts";

import {
  clampZoom,
  DEFAULT_CENTER,
  DEFAULT_ZOOM,
  featurePoints,
  type FitSource,
  isEmoji,
  MoveOwnership,
  PendingMoves,
  StoredView,
  validateBounds,
  validateLatLng,
  WaitingForSize,
} from "./view-policy.ts";

import "../cf-render/index.ts";

// Default map configuration
const TILE_URL = "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png";
const TILE_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

// Keyboard navigation constants
const PAN_AMOUNT = 100; // pixels to pan per arrow key press

// ResizeObserver debounce delay in milliseconds
const RESIZE_DEBOUNCE_MS = 150;

/**
 * The inputs through which a person moves the map: a drag, pinch, double
 * click, box zoom, or zoom-control press starts with a pointer press, a wheel
 * zoom with a wheel turn, and keyboard pans and zooms with a key press.
 */
const USER_INPUT_EVENTS = ["pointerdown", "wheel", "keydown"] as const;

/**
 * CFMap - Interactive map component with markers, circles, and polylines
 *
 * @element cf-map
 *
 * @attr {MapValue|Cell<MapValue>} value - Map data with markers, circles, polylines
 * @attr {LatLng|Cell<LatLng>} center - Map center coordinates (bidirectional)
 * @attr {number|Cell<number>} zoom - Map zoom level (bidirectional)
 * @attr {Bounds|Cell<Bounds>} bounds - Visible map bounds (bidirectional)
 * @attr {boolean} fitToBounds - Auto-fit to show all features
 * @attr {boolean} interactive - Enable pan/zoom (default: true)
 *
 * @fires cf-click - Map background click with { lat, lng }
 * @fires cf-bounds-change - Viewport change with { bounds, center, zoom, userInitiated }
 * @fires cf-marker-click - Marker click with { marker, index, lat, lng }
 * @fires cf-marker-drag-end - Marker drag end with { marker, index, position, oldPosition }
 * @fires cf-circle-click - Circle click with { circle, index, lat, lng }
 *
 * @note Polyline click events are not currently supported. Polylines are rendered
 * for display only (routes, paths). For clickable segments, use circles as waypoints.
 *
 * @example
 * <cf-map
 *   $value={mapDataCell}
 *   $center={centerCell}
 *   $zoom={zoomCell}
 *   fitToBounds
 *   @cf-marker-click={handleMarkerClick}
 * ></cf-map>
 */
export class CFMap extends BaseElement {
  static override styles = [BaseElement.baseStyles, styles];

  static override properties = {
    value: { attribute: false },
    center: { attribute: false },
    zoom: { attribute: false },
    bounds: { attribute: false },
    fitToBounds: { type: Boolean },
    interactive: { type: Boolean },
  };

  declare value: CellHandle<MapValue> | MapValue;
  declare center: CellHandle<LatLng> | LatLng;
  declare zoom: CellHandle<number> | number;
  declare bounds: CellHandle<Bounds> | Bounds;
  declare fitToBounds: boolean;
  declare interactive: boolean;

  /** The Leaflet map instance. */
  private _map: L.Map | null = null;

  // Layer groups for organized management
  private _markerLayer: L.LayerGroup | null = null;
  private _circleLayer: L.LayerGroup | null = null;
  private _polylineLayer: L.LayerGroup | null = null;

  /** The markers, tracked for drag events. */
  private _leafletMarkers: L.Marker[] = [];

  /** The circles, tracked for click events. */
  private _leafletCircles: L.Circle[] = [];

  /** The polylines, tracked for cleanup. */
  private _leafletPolylines: L.Polyline[] = [];

  /**
   * `requestAnimationFrame` id for map initialization, which prevents a race
   * condition on disconnect.
   */
  private _rafId: number | null = null;

  /** `ResizeObserver` for automatic map resize when the container changes. */
  private _resizeObserver: ResizeObserver | null = null;

  /** Timeout id for debounced resize handling. */
  private _resizeTimeoutId: ReturnType<typeof setTimeout> | null = null;

  /** Whether a programmatic update is in progress; this prevents echo loops. */
  private _isUpdatingFromCell = false;

  /** Who owns the map's moves, a person or cf-map. */
  private _moves = new MoveOwnership();

  /** cf-map's own moves queued behind the move under way. */
  private _pending = new PendingMoves();

  /** Moves asked for while the map had no size. */
  private _waitingForSize = new WaitingForSize();

  /** Whether bounds the map is given now are the stored view. */
  private _storedView = new StoredView();

  /**
   * Whether `updated()` has run once. On the first update the map was just
   * created with the bound center and zoom and fitted to any bound bounds, so
   * applying center and zoom again would only undo the bounds.
   */
  private _viewApplied = false;

  /** A pending click event deferred during an animation, if any. */
  private _pendingClickEvent: L.LeafletMouseEvent | null = null;

  // Cell controllers for reactive data binding
  // These manage subscriptions automatically via Lit's ReactiveController lifecycle
  // Note: Feature rendering is handled in updated() to catch both property changes
  // and cell subscription updates
  private _valueController = createCellController<MapValue>(this, {
    timing: { strategy: "immediate" },
  });

  private _centerController = createCellController<LatLng>(this, {
    timing: { strategy: "immediate" },
    triggerUpdate: false,
    onChange: () => {
      if (!this._isUpdatingFromCell) {
        this._updateMapCenter();
      }
    },
  });

  private _zoomController = createCellController<number>(this, {
    timing: { strategy: "immediate" },
    triggerUpdate: false,
    onChange: () => {
      if (!this._isUpdatingFromCell) {
        this._updateMapZoom();
      }
    },
  });

  private _boundsController = createCellController<Bounds>(this, {
    timing: { strategy: "immediate" },
    triggerUpdate: false,
    onChange: () => {
      if (!this._isUpdatingFromCell) {
        this._updateMapFromBounds();
      }
    },
  });

  /** Bound keydown handler, held so it can be removed on cleanup. */
  private _boundHandleKeydown = this._handleKeydown.bind(this);

  /** Marks the map's next moves as a person's; see `MoveOwnership`. */
  private _boundMarkUserInput = (): void => {
    this._moves.input();
  };

  constructor() {
    super();
    this.fitToBounds = false;
    this.interactive = true;
  }

  override connectedCallback(): void {
    super.connectedCallback();
    this.addEventListener("keydown", this._boundHandleKeydown);
    // On the host, in the capture phase, so the mark is set before any
    // handler inside the shadow root, Leaflet's or cf-map's, moves the map.
    for (const type of USER_INPUT_EVENTS) {
      this.addEventListener(type, this._boundMarkUserInput, {
        capture: true,
        passive: true,
      });
    }
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.removeEventListener("keydown", this._boundHandleKeydown);
    for (const type of USER_INPUT_EVENTS) {
      this.removeEventListener(type, this._boundMarkUserInput, {
        capture: true,
      });
    }
    this._cleanup();
  }

  protected override firstUpdated(_changedProperties: PropertyValues): void {
    super.firstUpdated(_changedProperties);

    // Bind all controllers to their initial values with JSON schemas
    // Schema binding enables automatic resolution of nested CellHandles
    this._valueController.bind(this.value, mapValueSchema);
    this._centerController.bind(this.center, latLngSchema);
    this._zoomController.bind(this.zoom);
    this._boundsController.bind(this.bounds, boundsSchema);

    this._initializeMap();

    // Render features after map initialization
    this._renderFeatures();
  }

  protected override updated(changedProperties: PropertyValues): void {
    super.updated(changedProperties);

    // Handle value changes - rebind controller when property changes
    if (changedProperties.has("value")) {
      this._valueController.bind(this.value, mapValueSchema);
    }

    // Re-render features on every update when we have a Cell
    // Cell subscription updates trigger requestUpdate() but don't show in changedProperties
    if (this._valueController.hasCell() || changedProperties.has("value")) {
      this._renderFeatures();
    }

    // Handle center changes - rebind controller when property changes
    if (changedProperties.has("center")) {
      this._centerController.bind(this.center, latLngSchema);
      if (this._viewApplied) this._updateMapCenter();
    }

    // Handle zoom changes - rebind controller when property changes
    if (changedProperties.has("zoom")) {
      this._zoomController.bind(this.zoom);
      if (this._viewApplied) this._updateMapZoom();
    }

    // Handle bounds changes - rebind controller when property changes
    if (changedProperties.has("bounds")) {
      this._boundsController.bind(this.bounds, boundsSchema);
    }

    // Handle interactive changes
    if (changedProperties.has("interactive") && this._map) {
      if (this.interactive) {
        this._map.dragging.enable();
        this._map.touchZoom.enable();
        this._map.doubleClickZoom.enable();
        this._map.scrollWheelZoom.enable();
        this._map.boxZoom.enable();
        this._map.keyboard.enable();
      } else {
        this._map.dragging.disable();
        this._map.touchZoom.disable();
        this._map.doubleClickZoom.disable();
        this._map.scrollWheelZoom.disable();
        this._map.boxZoom.disable();
        this._map.keyboard.disable();
      }
    }

    // Handle fitToBounds changes
    if (changedProperties.has("fitToBounds") && this.fitToBounds) {
      this._fitMapToBounds("property");
    }
    if (changedProperties.has("fitToBounds") && !this.fitToBounds) {
      // Off means stop fitting, so a fit still waiting is dropped
      this._pending.fitToBoundsOff();
      this._waitingForSize.fitToBoundsOff();
    }

    this._viewApplied = true;
  }

  override render() {
    return html`
      <div
        class="map-container"
        role="application"
        aria-label="Interactive map"
        tabindex="0"
      ></div>
    `;
  }

  //
  // Keyboard Navigation
  //

  private _handleKeydown(event: KeyboardEvent): void {
    // Only handle when interactive and map exists and is stable
    if (!this.interactive || !this._map || !this._isMapStable()) return;

    // Check that the event target is within the map container
    const mapContainer = this.shadowRoot?.querySelector(".map-container");
    if (!mapContainer) return;

    // Only handle events when focus is on the map container
    const target = event.target as Node;
    if (target !== mapContainer && !mapContainer.contains(target)) return;

    switch (event.key) {
      case "ArrowUp":
        event.preventDefault();
        this._map.panBy([0, -PAN_AMOUNT]);
        break;
      case "ArrowDown":
        event.preventDefault();
        this._map.panBy([0, PAN_AMOUNT]);
        break;
      case "ArrowLeft":
        event.preventDefault();
        this._map.panBy([-PAN_AMOUNT, 0]);
        break;
      case "ArrowRight":
        event.preventDefault();
        this._map.panBy([PAN_AMOUNT, 0]);
        break;
      case "+":
      case "=":
        event.preventDefault();
        this._map.zoomIn();
        break;
      case "-":
        event.preventDefault();
        this._map.zoomOut();
        break;
    }
  }

  //
  // Map State Helpers
  //

  /**
   * Check if the map is in a stable state for operations.
   * Returns false during zoom animations or when the map pane is not ready.
   * This prevents the Leaflet race condition where _mapPane becomes undefined
   * during concurrent pan+click operations.
   */
  private _isMapStable(): boolean {
    if (!this._map) return false;

    // Check if map is during a zoom animation
    // Access internal Leaflet state - _animatingZoom is set during zoom transitions
    const map = this._map as L.Map & { _animatingZoom?: boolean };
    if (map._animatingZoom) return false;

    // Check if map pane exists and is ready
    // This is the element that causes the _leaflet_pos error when undefined
    try {
      const pane = this._map.getPane("mapPane");
      if (!pane) return false;
    } catch {
      return false;
    }

    return true;
  }

  /**
   * Whether cf-map may start a move of its own now: the map is stable and no
   * person's move is under way. A move that may not start is queued.
   */
  private _canMoveMap(): boolean {
    return this._isMapStable() && !this._moves.personMoving;
  }

  //
  // Map Initialization
  //

  private _initializeMap(): void {
    const container = this.shadowRoot?.querySelector(
      ".map-container",
    ) as HTMLElement;
    if (!container) return;

    // Get initial center and zoom
    const initialCenter = this._getCenter();
    const initialZoom = this._getZoom();

    // Create map instance
    this._map = L.map(container, {
      center: [initialCenter.lat, initialCenter.lng],
      zoom: initialZoom,
      dragging: this.interactive,
      touchZoom: this.interactive,
      doubleClickZoom: this.interactive,
      scrollWheelZoom: this.interactive,
      boxZoom: this.interactive,
      keyboard: this.interactive,
      zoomControl: this.interactive,
      // The ResizeObserver below follows every size change, the window's
      // included; Leaflet's own window listener would move the map without
      // cf-map knowing the move is its own.
      trackResize: false,
    });

    // Add tile layer with crossOrigin for CORS compatibility
    const tileLayer = L.tileLayer(TILE_URL, {
      attribution: TILE_ATTRIBUTION,
      crossOrigin: true,
    });

    // Handle tile loading errors gracefully
    tileLayer.on("tileerror", (event: L.TileErrorEvent) => {
      console.warn("cf-map: Tile loading error", {
        coords: event.coords,
        error: event.error,
      });
    });

    tileLayer.addTo(this._map);

    // Create layer groups
    this._markerLayer = L.layerGroup().addTo(this._map);
    this._circleLayer = L.layerGroup().addTo(this._map);
    this._polylineLayer = L.layerGroup().addTo(this._map);

    // Set up event handlers
    this._setupMapEventHandlers();

    // Open on the bound bounds. Binding the bounds controller delivered them
    // before the map existed, so that delivery could not apply them.
    this._updateMapFromBounds(false);

    // Invalidate size after initialization to ensure proper tile loading
    // This is necessary when the map is rendered in Shadow DOM
    this._rafId = requestAnimationFrame(() => {
      this._resizeMap();
      this._rafId = null;
    });

    // Set up ResizeObserver to handle container size changes
    // This handles responsive layouts, tab switching, accordion panels, etc.
    // Debounce to prevent excessive layout thrashing on every pixel change
    this._resizeObserver = new ResizeObserver(() => {
      if (this._resizeTimeoutId !== null) {
        clearTimeout(this._resizeTimeoutId);
      }
      this._resizeTimeoutId = setTimeout(() => {
        this._resizeMap();
        this._resizeTimeoutId = null;
      }, RESIZE_DEBOUNCE_MS);
    });
    this._resizeObserver.observe(container);
  }

  private _setupMapEventHandlers(): void {
    if (!this._map) return;

    // Map click event - guard against race condition during zoom animations
    this._map.on("click", (e: L.LeafletMouseEvent) => {
      // If map is not stable (e.g., during zoom animation), defer the click
      if (!this._isMapStable()) {
        this._pendingClickEvent = e;
        return;
      }

      this._emitClickEvent(e);
    });

    // Handle deferred updates after zoom animations complete
    this._map.on("zoomend", () => {
      if (!this._isMapStable()) return;

      // Process pending click event
      if (this._pendingClickEvent) {
        this._emitClickEvent(this._pendingClickEvent);
        this._pendingClickEvent = null;
      }
    });

    this._map.on("movestart", () => this._moves.moveStarted());

    // Bounds change event (moveend covers both pan and zoom)
    this._map.on("moveend", () => {
      this._reportMove();
      const ended = this._moves.moveEnded();
      // A resize's move, which may land in the middle of a person's, ends
      // nothing and starts nothing.
      if (ended === "resize") return;
      if (ended === "person") this._pending.personMoved();
      // Moves queued behind this one start once it is reported. A move
      // cf-map is making from a cell leaves the queue to the move after it.
      if (!this._isUpdatingFromCell) this._processPendingUpdates();
    });
  }

  /** Emit `cf-bounds-change` and write the view's cells for a finished move. */
  private _reportMove(): void {
    if (this._isUpdatingFromCell) return;

    // Guard against race condition - map pane may not be ready
    if (!this._isMapStable()) return;

    // Wrap in try-catch as additional safety for Leaflet internal state issues
    try {
      const bounds = this._map!.getBounds();
      const center = this._map!.getCenter();
      const zoom = this._map!.getZoom();

      const boundsData: Bounds = {
        north: bounds.getNorth(),
        south: bounds.getSouth(),
        east: bounds.getEast(),
        west: bounds.getWest(),
      };

      const centerData: LatLng = {
        lat: center.lat,
        lng: center.lng,
      };

      // Emit bounds change event
      const detail: CfBoundsChangeDetail = {
        bounds: boundsData,
        center: centerData,
        zoom,
        userInitiated: this._moves.personMoving,
      };
      this.emit("cf-bounds-change", detail);

      // Update Cell values (bidirectional) using controllers
      this._updateCenterCell(centerData);
      this._updateZoomCell(zoom);
      this._updateBoundsCell(boundsData);
    } catch {
      // Silently ignore errors from Leaflet internal state issues
      // This can happen during rapid pan+click operations
    }
  }

  /**
   * Emit click event with coordinates.
   * Extracted to allow deferred clicks after animations.
   */
  private _emitClickEvent(e: L.LeafletMouseEvent): void {
    const detail: CfClickDetail = {
      lat: e.latlng.lat,
      lng: e.latlng.lng,
    };
    this.emit("cf-click", detail);
  }

  //
  // Value Getters (using CellControllers)
  //

  private _getValue(): MapValue {
    return this._valueController.getValue() || {};
  }

  private _getCenter(): LatLng {
    const center = this._centerController.getValue() || DEFAULT_CENTER;
    return validateLatLng(center);
  }

  private _getZoom(): number {
    const zoom = this._zoomController.getValue() ?? DEFAULT_ZOOM;
    return clampZoom(zoom);
  }

  private _getBounds(): Bounds | null {
    return this._boundsController.getValue() || null;
  }

  //
  // Cell Updates (bidirectional, using CellControllers)
  //

  private _updateCenterCell(center: LatLng): void {
    if (!this._centerController.hasCell()) return;

    this._isUpdatingFromCell = true;
    try {
      this._centerController.setValue(center);
    } finally {
      this._isUpdatingFromCell = false;
    }
  }

  private _updateZoomCell(zoom: number): void {
    if (!this._zoomController.hasCell()) return;

    this._isUpdatingFromCell = true;
    try {
      this._zoomController.setValue(zoom);
    } finally {
      this._isUpdatingFromCell = false;
    }
  }

  private _updateBoundsCell(bounds: Bounds): void {
    if (!this._boundsController.hasCell()) return;

    this._isUpdatingFromCell = true;
    try {
      this._boundsController.setValue(bounds);
    } finally {
      this._isUpdatingFromCell = false;
    }
  }

  //
  // Map Updates
  //

  private _updateMapCenter(): void {
    if (!this._map) return;

    const center = this._getCenter(); // Already validated by _getCenter()
    this._waitingForSize.viewReplaced();

    // If cf-map may not move the map now, queue the update
    if (!this._canMoveMap()) {
      this._pending.center(center);
      return;
    }

    this._setCenter(center);
  }

  private _updateMapZoom(): void {
    if (!this._map) return;

    const zoom = this._getZoom(); // Already validated by _getZoom()
    this._waitingForSize.viewReplaced();

    // If cf-map may not move the map now, queue the update
    if (!this._canMoveMap()) {
      this._pending.zoom(zoom);
      return;
    }

    this._setZoom(zoom);
  }

  private _updateMapFromBounds(animate = true): void {
    if (!this._map) return;

    const bounds = this._getBounds();
    if (!bounds) return;

    // Validate bounds before applying
    const validatedBounds = validateBounds(bounds);
    if (!validatedBounds) return;

    // The stored view yields to a fit to the features
    if (!this._storedView.admit(this.fitToBounds)) return;

    // If cf-map may not move the map now, queue the update
    if (!this._canMoveMap()) {
      this._pending.bounds(validatedBounds);
      return;
    }

    // A map with no size fits any bounds at zoom 0, so wait for a size
    if (!this._hasSize()) {
      this._waitingForSize.bounds(validatedBounds);
      return;
    }

    this._fitMapToCellBounds(validatedBounds, animate);
  }

  /** Center the map on a value read from the center cell, without echo. */
  private _setCenter(center: LatLng): void {
    if (!this._map) return;

    this._moves.ownMove();
    this._isUpdatingFromCell = true;
    try {
      this._map.setView([center.lat, center.lng], this._map.getZoom(), {
        animate: true,
      });
    } finally {
      this._isUpdatingFromCell = false;
    }
  }

  /** Zoom the map to a value read from the zoom cell, without echo. */
  private _setZoom(zoom: number): void {
    if (!this._map) return;

    this._moves.ownMove();
    this._isUpdatingFromCell = true;
    try {
      this._map.setZoom(zoom, { animate: true });
    } finally {
      this._isUpdatingFromCell = false;
    }
  }

  /** Fit the map to bounds read from the bounds cell, without echoing them. */
  private _fitMapToCellBounds(bounds: Bounds, animate: boolean): void {
    if (!this._map) return;

    this._waitingForSize.viewReplaced();
    this._moves.ownMove();
    this._isUpdatingFromCell = true;
    try {
      const leafletBounds = L.latLngBounds(
        [bounds.south, bounds.west],
        [bounds.north, bounds.east],
      );
      this._map.fitBounds(leafletBounds, { animate });
    } finally {
      this._isUpdatingFromCell = false;
    }
  }

  private _hasSize(): boolean {
    if (!this._map) return false;
    const size = this._map.getSize();
    return size.x > 0 && size.y > 0;
  }

  /**
   * Tell Leaflet the container may have changed size, then fit the bound
   * bounds and the features that waited for the map to have a size.
   */
  private _resizeMap(): void {
    const map = this._map;
    if (!map) return;

    // A resize that changes no size moves nothing
    const size = map.getSize();
    const element = map.getContainer();
    const sizeChanged = element.clientWidth !== size.x ||
      element.clientHeight !== size.y;
    if (!this._waitingForSize.waiting) {
      this._moves.resize(sizeChanged, () => map.invalidateSize());
      return;
    }
    if (this._moves.personMoving) {
      // What waited for a size now waits for the person's move instead
      this._moves.resize(sizeChanged, () => map.invalidateSize());
      const { bounds, fit } = this._waitingForSize.take();
      if (bounds !== null) this._pending.bounds(bounds);
      if (fit !== null) this._pending.fit(fit);
      return;
    }

    // The resize and the fits that waited for it are one move, reported
    // once, as cf-map's own, with the view they end on.
    let sized = false;
    this._isUpdatingFromCell = true;
    try {
      this._moves.resize(sizeChanged, () => map.invalidateSize());
      sized = this._hasSize();
      if (sized) {
        const { bounds, fit } = this._waitingForSize.take();
        // In the order a map mounted with a size applies them: the bound
        // bounds, then the fit to the features.
        if (bounds !== null) this._fitMapToCellBounds(bounds, false);
        if (fit !== null) this._fitMapToBounds(fit, false);
      }
    } finally {
      this._isUpdatingFromCell = false;
    }
    if (sized) this._reportMove();
  }

  /**
   * Start the next of cf-map's own moves queued behind the move just
   * reported. Called from the moveend handler.
   */
  private _processPendingUpdates(): void {
    if (!this._map) return;

    const move = this._pending.next();
    if (move === null) return;
    // The next moveend starts the move after this one
    switch (move.kind) {
      case "bounds":
        this._fitMapToCellBounds(move.bounds, true);
        return;
      case "center":
        this._setCenter(move.center);
        return;
      case "zoom":
        this._setZoom(move.zoom);
        return;
      case "fit":
        this._fitMapToBounds(move.source);
        return;
    }
  }

  //
  // Feature Rendering
  //

  private _clearLayers(): void {
    // Remove event listeners from tracked markers before clearing to prevent memory leaks
    // Leaflet's clearLayers() removes DOM nodes but doesn't remove .on() listeners
    for (const marker of this._leafletMarkers) {
      marker.off();
    }
    for (const circle of this._leafletCircles) {
      circle.off();
    }
    for (const polyline of this._leafletPolylines) {
      polyline.off();
    }

    this._markerLayer?.clearLayers();
    this._circleLayer?.clearLayers();
    this._polylineLayer?.clearLayers();
    this._leafletMarkers = [];
    this._leafletCircles = [];
    this._leafletPolylines = [];
  }

  /**
   * Render all map features from the current value.
   * Schema binding via CellController.bind() automatically resolves nested CellHandles,
   * so we can read directly from _getValue() without manual cell traversal.
   */
  private _renderFeatures(): void {
    if (!this._map) return;

    const value = this._getValue();

    // Clear existing layers
    this._clearLayers();

    // Render features from resolved data
    if (value.markers && value.markers.length > 0) {
      this._renderMarkers(value.markers);
    }
    if (value.circles && value.circles.length > 0) {
      this._renderCircles(value.circles);
    }
    if (value.polylines && value.polylines.length > 0) {
      this._renderPolylines(value.polylines);
    }

    // Handle fitToBounds
    if (this.fitToBounds) {
      this._fitMapToBounds("features");
    }
  }

  private _renderMarkers(markers: readonly MapMarker[]): void {
    if (!this._markerLayer) return;

    // Access length inside try-catch since reactive proxies can throw on property access
    let length: number;
    try {
      length = markers.length;
    } catch {
      return;
    }
    for (let i = 0; i < length; i++) {
      const index = i;

      // Extract all marker properties within try-catch to handle reactive proxy edge cases
      // where accessing nested properties may throw during partial data loading
      let marker: MapMarker;
      let lat: number;
      let lng: number;
      let title: string | undefined;
      let description: string | undefined;
      let icon: string | undefined;
      let popup: unknown;
      let draggable: boolean | undefined;

      try {
        marker = markers[i];
        if (!marker) {
          continue;
        }

        // Marker is resolved by the effect system
        const position = marker.position;
        if (!position) {
          continue;
        }

        lat = position.lat;
        lng = position.lng;
        if (typeof lat !== "number" || typeof lng !== "number") {
          continue;
        }

        // Extract remaining properties
        title = marker.title;
        description = marker.description;
        icon = marker.icon;
        popup = marker.popup;
        draggable = marker.draggable;
      } catch {
        // Skip markers that throw during property access
        continue;
      }

      // Create marker icon - always use divIcon to avoid Leaflet default icon issues in Shadow DOM
      let markerIcon: L.DivIcon;
      if (icon && isEmoji(icon)) {
        // Create a span element safely to prevent XSS
        const span = document.createElement("span");
        span.className = "emoji-marker";
        span.textContent = icon; // Safe - escapes HTML

        markerIcon = L.divIcon({
          html: span.outerHTML,
          className: "cf-map-emoji-marker",
          iconSize: [32, 32],
          iconAnchor: [16, 32],
          popupAnchor: [0, -32],
        });
      } else {
        // Default marker icon - SVG pin that works in Shadow DOM
        // (Leaflet's default L.Icon.Default fails in Shadow DOM due to image path resolution)
        markerIcon = L.divIcon({
          html:
            `<svg width="25" height="41" viewBox="0 0 25 41" xmlns="http://www.w3.org/2000/svg">
            <path d="M12.5 0C5.6 0 0 5.6 0 12.5c0 2.4.7 4.6 1.9 6.5L12.5 41l10.6-22c1.2-1.9 1.9-4.1 1.9-6.5C25 5.6 19.4 0 12.5 0z" fill="#3b82f6"/>
            <circle cx="12.5" cy="12.5" r="5" fill="white"/>
          </svg>`,
          className: "cf-map-default-marker",
          iconSize: [25, 41],
          iconAnchor: [12, 41],
          popupAnchor: [0, -41],
        });
      }

      // Create Leaflet marker (use validated lat/lng from above)
      const leafletMarker = L.marker([lat, lng], {
        icon: markerIcon,
        draggable: draggable || false,
      });

      // Add popup if content is provided
      if (popup || title || description) {
        const popupContent = this._createPopupContent(marker, "marker", index);
        leafletMarker.bindPopup(popupContent);
      }

      // Click handler
      leafletMarker.on("click", (e: L.LeafletMouseEvent) => {
        const detail: CfMarkerClickDetail = {
          marker,
          index,
          lat: e.latlng.lat,
          lng: e.latlng.lng,
        };
        this.emit("cf-marker-click", detail);
      });

      // Drag handlers
      if (draggable) {
        // Use validated lat/lng instead of spreading reactive proxy
        let oldPosition: LatLng = { lat, lng };

        // Capture position at drag start (not creation time)
        leafletMarker.on("dragstart", () => {
          const pos = leafletMarker.getLatLng();
          oldPosition = { lat: pos.lat, lng: pos.lng };
        });

        leafletMarker.on("dragend", (e: L.DragEndEvent) => {
          const newLatLng = e.target.getLatLng();
          const newPosition: LatLng = {
            lat: newLatLng.lat,
            lng: newLatLng.lng,
          };
          const detail: CfMarkerDragEndDetail = {
            marker,
            index,
            position: newPosition,
            oldPosition,
          };
          this.emit("cf-marker-drag-end", detail);
        });
      }

      // Add to layer and track
      leafletMarker.addTo(this._markerLayer!);
      this._leafletMarkers.push(leafletMarker);
    }
  }

  private _renderCircles(circles: readonly MapCircle[]): void {
    if (!this._circleLayer) return;

    // Access length inside try-catch since reactive proxies can throw on property access
    let length: number;
    try {
      length = circles.length;
    } catch {
      return;
    }
    for (let i = 0; i < length; i++) {
      const index = i;

      // Extract all circle properties within try-catch
      let circle: MapCircle;
      let lat: number;
      let lng: number;
      let radius: number;
      let color: string | undefined;
      let fillOpacity: number | undefined;
      let strokeWidth: number | undefined;
      let popup: unknown;
      let title: string | undefined;

      try {
        circle = circles[i];
        if (!circle) {
          continue;
        }

        // Circle is resolved by the effect system
        const center = circle.center;
        if (!center) {
          continue;
        }

        lat = center.lat;
        lng = center.lng;
        if (typeof lat !== "number" || typeof lng !== "number") {
          continue;
        }

        // Extract remaining properties
        radius = circle.radius;
        color = circle.color;
        fillOpacity = circle.fillOpacity;
        strokeWidth = circle.strokeWidth;
        popup = circle.popup;
        title = circle.title;
      } catch {
        // Skip circles that throw during property access
        continue;
      }

      // Create Leaflet circle (use validated lat/lng from above)
      const leafletCircle = L.circle([lat, lng], {
        radius,
        color: color || "#3b82f6",
        fillColor: color || "#3b82f6",
        fillOpacity: fillOpacity ?? 0.2,
        weight: strokeWidth ?? 2,
      });

      // Add popup if content is provided
      if (popup || title) {
        const popupContent = this._createPopupContent(circle, "circle", index);
        leafletCircle.bindPopup(popupContent);
      }

      // Click handler
      leafletCircle.on("click", (e: L.LeafletMouseEvent) => {
        const detail: CfCircleClickDetail = {
          circle,
          index,
          lat: e.latlng.lat,
          lng: e.latlng.lng,
        };
        this.emit("cf-circle-click", detail);
      });

      // Add to layer and track
      leafletCircle.addTo(this._circleLayer!);
      this._leafletCircles.push(leafletCircle);
    }
  }

  private _renderPolylines(polylines: readonly MapPolyline[]): void {
    if (!this._polylineLayer) return;

    // Access length inside try-catch since reactive proxies can throw on property access
    let length: number;
    try {
      length = polylines.length;
    } catch {
      return;
    }
    for (let i = 0; i < length; i++) {
      const polyline = polylines[i];

      // Skip polylines without valid points array
      if (!polyline) {
        continue;
      }

      // Polyline is resolved by the effect system
      const points = polyline.points;
      if (!points || !Array.isArray(points)) {
        continue;
      }

      // Extract style properties
      const color = polyline.color;
      const strokeWidth = polyline.strokeWidth;
      const dashArray = polyline.dashArray;

      // Convert to Leaflet format, filtering out invalid points
      const latLngs: L.LatLngExpression[] = [];
      const pointsLength = points.length;
      for (let j = 0; j < pointsLength; j++) {
        const p = points[j];
        if (p && typeof p.lat === "number" && typeof p.lng === "number") {
          latLngs.push([p.lat, p.lng]);
        }
      }

      // Skip if no valid points remain
      if (latLngs.length === 0) {
        continue;
      }

      // Create Leaflet polyline
      // Note: Polylines are display-only (no click events). Use circles as
      // waypoints if clickable segments are needed.
      const leafletPolyline = L.polyline(latLngs, {
        color: color || "#3b82f6",
        weight: strokeWidth ?? 3,
        dashArray: dashArray,
      });

      // Add to layer and track
      leafletPolyline.addTo(this._polylineLayer!);
      this._leafletPolylines.push(leafletPolyline);
    }
  }

  //
  // Popup Rendering
  //

  private _createPopupContent(
    feature: MapMarker | MapCircle,
    _type: "marker" | "circle",
    _index: number,
  ): HTMLElement {
    const container = document.createElement("div");

    // Check if we have a Reactive popup (advanced mode)
    if (feature.popup) {
      // Create a cf-render element for the popup content
      const cfRender = document.createElement("cf-render");
      (cfRender as any).cell = feature.popup;
      container.appendChild(cfRender);
    } else {
      // Simple popup content
      container.className = "popup-simple";

      if ("icon" in feature && feature.icon) {
        const iconEl = document.createElement("div");
        iconEl.className = "popup-icon";
        iconEl.textContent = feature.icon;
        container.appendChild(iconEl);
      }

      if (feature.title) {
        const titleEl = document.createElement("div");
        titleEl.className = "popup-title";
        titleEl.textContent = feature.title;
        container.appendChild(titleEl);
      }

      if (feature.description) {
        const descEl = document.createElement("p");
        descEl.className = "popup-description";
        descEl.textContent = feature.description;
        container.appendChild(descEl);
      }
    }

    return container;
  }

  //
  // Fit to Bounds
  //

  private _fitMapToBounds(source: FitSource, animate = true): void {
    if (!this._map) return;

    // If cf-map may not move the map now, queue the fit
    if (!this._canMoveMap()) {
      this._pending.fit(source);
      return;
    }

    // A map with no size has no zoom to fit to, so wait for a size
    if (!this._hasSize()) {
      this._waitingForSize.fit(source);
      return;
    }

    const points = featurePoints(this._getValue());
    if (points.length === 0) return;

    const bounds = L.latLngBounds(
      points.map((point) => L.latLng(point.lat, point.lng)),
    );
    this._moves.ownMove();
    this._isUpdatingFromCell = true;
    try {
      const options: L.FitBoundsOptions = { padding: [50, 50], maxZoom: 16 };
      if (!animate) options.animate = false;
      this._map.fitBounds(bounds, options);
    } finally {
      this._isUpdatingFromCell = false;
    }
  }

  //
  // Cleanup
  //

  private _cleanup(): void {
    // Cancel pending RAF to prevent race condition if component disconnects before it fires
    if (this._rafId !== null) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }

    // Clear pending resize debounce timeout
    if (this._resizeTimeoutId !== null) {
      clearTimeout(this._resizeTimeoutId);
      this._resizeTimeoutId = null;
    }

    // Disconnect ResizeObserver
    if (this._resizeObserver) {
      this._resizeObserver.disconnect();
      this._resizeObserver = null;
    }

    // Destroy map
    if (this._map) {
      this._map.remove();
      this._map = null;
    }

    // Clear references
    this._markerLayer = null;
    this._circleLayer = null;
    this._polylineLayer = null;
    this._leafletMarkers = [];
    this._leafletCircles = [];
    this._leafletPolylines = [];
    this._pendingClickEvent = null;
    this._moves = new MoveOwnership();
    this._pending = new PendingMoves();
    this._waitingForSize = new WaitingForSize();
    this._storedView = new StoredView();

    // Note: CellControllers are automatically cleaned up by Lit's reactive
    // controller system. They implement ReactiveController with
    // hostDisconnected() callbacks that are automatically invoked when
    // the host element disconnects.
  }

  //
  // Public API
  //

  /**
   * Get the underlying Leaflet map instance for advanced usage
   */
  get leafletMap(): L.Map | null {
    return this._map;
  }

  /**
   * Invalidate the map size (call after container resize)
   */
  invalidateSize(): void {
    this._resizeMap();
  }

  /**
   * Programmatically fit the map to show all features
   */
  fitBounds(): void {
    this._fitMapToBounds("call");
  }

  /**
   * Pan to a specific location
   */
  panTo(lat: number, lng: number): void {
    if (!this._canMoveMap()) return;
    this._moves.ownMove();
    this._map?.panTo([lat, lng]);
  }

  /**
   * Set the map view to a specific location and zoom
   */
  setView(lat: number, lng: number, zoom: number): void {
    if (!this._canMoveMap()) return;
    this._moves.ownMove();
    this._map?.setView([lat, lng], zoom);
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "cf-map": CFMap;
  }
}
