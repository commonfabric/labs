/**
 * cf-map's view policy: the decisions about the map's view that need no
 * browser. cf-map wires them to Leaflet; this module holds what they decide,
 * so a plain Deno test can hold them to it. A browser test cannot: Leaflet
 * needs a DOM, and code that runs only in a browser enters no coverage.
 *
 * - which values are usable as a center, a zoom, or bounds;
 * - which points a fit to the features frames;
 * - who owns a move, a person or cf-map (`MoveOwnership`);
 * - which of cf-map's own moves wait, and what cancels them
 *   (`PendingMoves`, `WaitingForSize`, `FitSource`);
 * - when the stored view yields to a fit (`StoredView`).
 */

import type { Bounds, LatLng, MapValue } from "./types.ts";

export const DEFAULT_CENTER: LatLng = { lat: 37.7749, lng: -122.4194 }; // San Francisco
export const DEFAULT_ZOOM = 13;

// Valid coordinate and zoom ranges
const MIN_ZOOM = 0;
const MAX_ZOOM = 18;
const MIN_LAT = -90;
const MAX_LAT = 90;
const MIN_LNG = -180;
const MAX_LNG = 180;

// Cached emoji regex for performance (compiled once at module load)
const EMOJI_REGEX =
  /[\u{1F300}-\u{1F9FF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]|[\u{1F600}-\u{1F64F}]|[\u{1F680}-\u{1F6FF}]/u;

//
// Values
//

/** Whether `str` holds an emoji, which a marker draws as its icon. */
export function isEmoji(str: string): boolean {
  return EMOJI_REGEX.test(str);
}

/** `zoom` within the zooms the map draws, or the default if not a number. */
export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) {
    return DEFAULT_ZOOM;
  }
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom));
}

function clampLat(lat: number): number {
  if (!Number.isFinite(lat)) {
    return DEFAULT_CENTER.lat;
  }
  return Math.max(MIN_LAT, Math.min(MAX_LAT, lat));
}

function clampLng(lng: number): number {
  if (!Number.isFinite(lng)) {
    return DEFAULT_CENTER.lng;
  }
  return Math.max(MIN_LNG, Math.min(MAX_LNG, lng));
}

/** `latLng` with each coordinate within range, or the default's if not one. */
export function validateLatLng(latLng: LatLng): LatLng {
  return {
    lat: clampLat(latLng.lat),
    lng: clampLng(latLng.lng),
  };
}

/** `bounds` if they are finite, in range, and south of north; else null. */
export function validateBounds(bounds: Bounds): Bounds | null {
  const { north, south, east, west } = bounds;

  // Check that all values are finite numbers
  if (
    !Number.isFinite(north) ||
    !Number.isFinite(south) ||
    !Number.isFinite(east) ||
    !Number.isFinite(west)
  ) {
    return null;
  }

  // Check latitude range
  if (
    north < MIN_LAT ||
    north > MAX_LAT ||
    south < MIN_LAT ||
    south > MAX_LAT
  ) {
    return null;
  }

  // Check longitude range
  if (
    east < MIN_LNG ||
    east > MAX_LNG ||
    west < MIN_LNG ||
    west > MAX_LNG
  ) {
    return null;
  }

  // Check that south <= north
  if (south > north) {
    return null;
  }

  return bounds;
}

/**
 * The points a fit to the features frames: every marker's position, every
 * circle's center, and every polyline point. A feature that throws when read,
 * as a reactive proxy can while its data is still loading, or that has no
 * finite position, is skipped.
 */
export function featurePoints(value: MapValue): LatLng[] {
  const allPoints: LatLng[] = [];
  const add = (point: LatLng | undefined) => {
    if (!point) return;
    const lat = point.lat;
    const lng = point.lng;
    if (Number.isFinite(lat) && Number.isFinite(lng)) {
      allPoints.push({ lat, lng });
    }
  };

  // Use traditional for loops with try-catch to avoid reactive proxy issues
  const markers = value.markers ?? [];
  for (let i = 0; i < markers.length; i++) {
    try {
      add(markers[i]?.position);
    } catch {
      // Skip markers that throw during property access
    }
  }

  const circles = value.circles ?? [];
  for (let i = 0; i < circles.length; i++) {
    try {
      add(circles[i]?.center);
    } catch {
      // Skip circles that throw during property access
    }
  }

  const polylines = value.polylines ?? [];
  for (let i = 0; i < polylines.length; i++) {
    try {
      const points = polylines[i]?.points ?? [];
      for (let j = 0; j < points.length; j++) {
        try {
          add(points[j]);
        } catch {
          // Skip points that throw during property access
        }
      }
    } catch {
      // Skip polylines that throw during property access
    }
  }

  return allPoints;
}

//
// Who owns a move
//

/**
 * Who owns the map's moves: a person, or cf-map itself.
 *
 * A move is the person's when it starts (Leaflet's `movestart`) after their
 * input on the map (a pointer press, wheel turn, or key press) and before
 * cf-map's own next move. It stays theirs until its `moveend`, which for a
 * drag includes the inertial glide after it. A move already under way when
 * the input came stays cf-map's.
 *
 * The input mark is not cleared when a move ends, because Leaflet starts a
 * wheel zoom on a timer after the wheel turns it. Only cf-map's own move
 * clears it.
 */
export class MoveOwnership {
  #inputSinceOwnMove = false;
  #personMoving = false;
  #resizing = false;

  /** A person's pointer press, wheel turn, or key press on the map. */
  input(): void {
    this.#inputSinceOwnMove = true;
  }

  /** cf-map is starting a move of its own. */
  ownMove(): void {
    this.#inputSinceOwnMove = false;
  }

  /**
   * cf-map follows a container resize by running `follow`. A resize that
   * changed the size is cf-map's own move, unless a person's move is under
   * way: then the map follows the new size as part of their move. The
   * resize's `moveend`, which comes with no `movestart`, ends nothing.
   */
  resize(sizeChanged: boolean, follow: () => void): void {
    if (sizeChanged && !this.#personMoving) this.#inputSinceOwnMove = false;
    this.#resizing = true;
    try {
      follow();
    } finally {
      this.#resizing = false;
    }
  }

  /** Whether a person's move is under way; cf-map's own moves wait for it. */
  get personMoving(): boolean {
    return this.#personMoving;
  }

  /** Leaflet's `movestart`. */
  moveStarted(): void {
    if (this.#inputSinceOwnMove) this.#personMoving = true;
  }

  /**
   * Leaflet's `moveend`, once the move is reported: whose move ended, or
   * `resize` for a resize's move, which ends no move.
   */
  moveEnded(): "person" | "own" | "resize" {
    if (this.#resizing) return "resize";
    const person = this.#personMoving;
    this.#personMoving = false;
    return person ? "person" : "own";
  }
}

//
// Moves that wait
//

/**
 * What asked for a fit to the features, which decides what cancels it while
 * it waits for a size or for a move to end:
 *
 * - `features`: the features changed while `fitToBounds` was on. A person's
 *   move cancels it, since it would undo their view, and so does turning
 *   `fitToBounds` off.
 * - `property`: `fitToBounds` was turned on. Turning it off cancels it; a
 *   person's move does not, since it is the latest thing anyone asked for.
 * - `call`: `fitBounds()` was called. Nothing cancels it.
 *
 * Listed weakest first: a fit asked for twice keeps the stronger source.
 */
const FIT_SOURCES = ["features", "property", "call"] as const;
export type FitSource = typeof FIT_SOURCES[number];

/** The stronger of two fit sources, the first of which may be absent. */
export function strongerFit(a: FitSource | null, b: FitSource): FitSource {
  return a !== null && FIT_SOURCES.indexOf(a) > FIT_SOURCES.indexOf(b) ? a : b;
}

/** A fit still waiting once `fitToBounds` turns off: off means stop fitting. */
function fitAfterFitToBoundsOff(fit: FitSource | null): FitSource | null {
  return fit === "call" ? fit : null;
}

/** One of cf-map's own moves, queued behind another move. */
export type PendingMove =
  | { kind: "bounds"; bounds: Bounds }
  | { kind: "center"; center: LatLng }
  | { kind: "zoom"; zoom: number }
  | { kind: "fit"; source: FitSource };

/**
 * cf-map's own moves queued behind the move under way: a zoom animation, or
 * a person's move. Each kind holds its latest value. They start one at a
 * time once the move ahead is reported, bounds first, since bounds set both
 * center and zoom.
 */
export class PendingMoves {
  #bounds: Bounds | null = null;
  #center: LatLng | null = null;
  #zoom: number | null = null;
  #fit: FitSource | null = null;

  bounds(bounds: Bounds): void {
    this.#bounds = bounds;
  }

  center(center: LatLng): void {
    this.#center = center;
  }

  zoom(zoom: number): void {
    this.#zoom = zoom;
  }

  fit(source: FitSource): void {
    this.#fit = strongerFit(this.#fit, source);
  }

  /**
   * A person's move ended. Their view supersedes a refit the features set
   * off, which would undo it, and the queued bound values: the move's report
   * wrote their view into those cells, so the last write is theirs and the
   * map agrees with its cells. A fit asked for while they moved still runs.
   */
  personMoved(): void {
    this.#bounds = null;
    this.#center = null;
    this.#zoom = null;
    if (this.#fit === "features") this.#fit = null;
  }

  fitToBoundsOff(): void {
    this.#fit = fitAfterFitToBoundsOff(this.#fit);
  }

  /** Takes the next move to start, or null when none waits. */
  next(): PendingMove | null {
    if (this.#bounds !== null) {
      const bounds = this.#bounds;
      // Bounds set both center and zoom
      this.#bounds = null;
      this.#center = null;
      this.#zoom = null;
      return { kind: "bounds", bounds };
    }
    if (this.#center !== null) {
      const center = this.#center;
      this.#center = null;
      return { kind: "center", center };
    }
    if (this.#zoom !== null) {
      const zoom = this.#zoom;
      this.#zoom = null;
      return { kind: "zoom", zoom };
    }
    if (this.#fit !== null) {
      const source = this.#fit;
      this.#fit = null;
      return { kind: "fit", source };
    }
    return null;
  }

  clear(): void {
    this.#bounds = null;
    this.#center = null;
    this.#zoom = null;
    this.#fit = null;
  }
}

/**
 * Moves asked for while the map has no size, so no zoom could fit them: bound
 * bounds, and a fit to the features. They apply in that order, as on a map
 * mounted with a size, once the container has one.
 */
export class WaitingForSize {
  #bounds: Bounds | null = null;
  #fit: FitSource | null = null;

  bounds(bounds: Bounds): void {
    this.#bounds = bounds;
  }

  fit(source: FitSource): void {
    this.#fit = strongerFit(this.#fit, source);
  }

  /** A newer center or zoom replaces bounds still waiting. */
  viewReplaced(): void {
    this.#bounds = null;
  }

  fitToBoundsOff(): void {
    this.#fit = fitAfterFitToBoundsOff(this.#fit);
  }

  get waiting(): boolean {
    return this.#bounds !== null || this.#fit !== null;
  }

  /** Takes what waits, to apply now the map has a size. */
  take(): { bounds: Bounds | null; fit: FitSource | null } {
    const taken = { bounds: this.#bounds, fit: this.#fit };
    this.#bounds = null;
    this.#fit = null;
    return taken;
  }
}

//
// The stored view
//

/**
 * The first bounds a map is given are the view stored from a past session,
 * whenever they arrive: at mount, or later when the cell's value loads.
 * While `fitToBounds` is on, the fit to the features wins over that stored
 * view. A later value, such as a consumer framing a chosen place, applies as
 * usual.
 */
export class StoredView {
  #given = false;

  /** Whether to apply the bounds the map is being given now. */
  admit(fitToBounds: boolean): boolean {
    const stored = !this.#given;
    this.#given = true;
    return !(stored && fitToBounds);
  }
}
