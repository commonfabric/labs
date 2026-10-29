/**
 * Type definitions for the CF Map component
 */

import type { Reactive } from "@commonfabric/api";

/**
 * Represents a geographic coordinate with latitude and longitude
 */
export interface LatLng {
  lat: number;
  lng: number;
}

/**
 * Represents a geographic bounding box
 */
export interface Bounds {
  north: number; // max latitude
  south: number; // min latitude
  east: number; // max longitude
  west: number; // min longitude
}

/**
 * Represents a marker on the map
 *
 * Popup content follows a progressive model:
 * - Simple: Use `title`, `description`, `icon` fields (pure data, rendered by cf-map)
 * - Advanced: Use `popup` field with a Cell/Reactive that has a [UI] property
 */
export interface MapMarker {
  position: LatLng;

  // Simple popup content (pure data)
  title?: string;
  description?: string;
  icon?: string; // emoji, URL, or icon name

  // Advanced popup content (Cell with [UI] property)
  popup?: Reactive<any>;

  // Behavior
  draggable?: boolean;
}

/**
 * Represents a circle on the map
 *
 * Useful for coverage areas, approximate locations, or highlighting regions.
 */
export interface MapCircle {
  center: LatLng;
  radius: number; // meters

  // Styling
  color?: string;
  fillOpacity?: number;
  strokeWidth?: number;

  // Popup (same pattern as markers)
  title?: string;
  description?: string;
  popup?: Reactive<any>;
}

/**
 * Represents a polyline (path or route) on the map
 */
export interface MapPolyline {
  points: LatLng[];

  // Styling
  color?: string;
  strokeWidth?: number;
  dashArray?: string; // e.g., "5, 10" for dashed lines
}

/**
 * The combined data structure for all map features
 */
export interface MapValue {
  markers?: MapMarker[];
  circles?: MapCircle[];
  polylines?: MapPolyline[];
}

/**
 * Event detail emitted when the map background (not a feature) is clicked
 */
export interface CfClickDetail {
  lat: number;
  lng: number;
}

/**
 * Event detail emitted when the viewport changes (pan/zoom)
 */
export interface CfBoundsChangeDetail {
  bounds: Bounds;
  center: LatLng;
  zoom: number;
  /**
   * Whether a person moved the map (drag, pinch, wheel, double click, zoom
   * control, keyboard), as opposed to cf-map moving it itself: applying a
   * bound center, zoom, or bounds, fitting to features, or following a
   * container resize.
   */
  userInitiated: boolean;
}

/**
 * Event detail emitted when a marker is clicked
 */
export interface CfMarkerClickDetail {
  marker: MapMarker;
  index: number;
  lat: number;
  lng: number;
}

/**
 * Event detail emitted when a draggable marker drag operation completes
 */
export interface CfMarkerDragEndDetail {
  marker: MapMarker;
  index: number;
  position: LatLng;
  oldPosition: LatLng;
}

/**
 * Event detail emitted when a circle is clicked
 */
export interface CfCircleClickDetail {
  circle: MapCircle;
  index: number;
  lat: number;
  lng: number;
}
