/**
 * cf-map against a stand-in for Leaflet. Leaflet needs a browser's layout,
 * so these cases hand cf-map a fake Leaflet that records what cf-map asks of
 * it, and fire the map events Leaflet would. `cf-map.browser.test.ts` drives
 * the real Leaflet in a browser.
 */

// First, so that the document it installs is there when Lit loads.
import { mount } from "../../test-utils/dom.ts";

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { stub } from "@std/testing/mock";
import type { CellHandle } from "@commonfabric/runtime-client";
import {
  createMockCellHandle,
  pushUpdate,
  writesSent,
} from "../../test-utils/mock-cell-handle.ts";
import { CFRender } from "../cf-render/index.ts";
import { CFMap, type Leaflet } from "./cf-map.ts";
import type {
  Bounds,
  CfBoundsChangeDetail,
  LatLng,
  MapCircle,
  MapMarker,
  MapValue,
} from "./types.ts";

customElements.define("cf-map-under-test", CFMap);

type Listener = (event: object) => void;

/** Leaflet's event methods, plus `fire()` for the test to play Leaflet. */
class FakeEvented {
  #listeners = new Map<string, Listener[]>();

  on(type: string, listener: Listener): this {
    this.#listeners.set(type, [...this.#listeners.get(type) ?? [], listener]);
    return this;
  }

  off(): this {
    this.#listeners.clear();
    return this;
  }

  fire(type: string, event: object = {}): void {
    for (const listener of this.#listeners.get(type) ?? []) listener(event);
  }

  listens(type: string): boolean {
    return this.#listeners.has(type);
  }
}

class FakeLayerGroup {
  layers: FakeFeature[] = [];

  addTo(map: FakeMap): this {
    map.layers.push(this);
    return this;
  }

  clearLayers(): this {
    this.layers = [];
    return this;
  }
}

/** A marker, circle, or polyline. */
class FakeFeature extends FakeEvented {
  popup: HTMLElement | undefined;

  constructor(
    readonly kind: "marker" | "circle" | "polyline",
    public at: unknown,
    readonly options: Record<string, unknown>,
  ) {
    super();
  }

  bindPopup(content: HTMLElement): this {
    this.popup = content;
    return this;
  }

  addTo(layer: FakeLayerGroup): this {
    layer.layers.push(this);
    return this;
  }

  getLatLng(): LatLng {
    const [lat, lng] = this.at as [number, number];
    return { lat, lng };
  }
}

class FakeHandler {
  constructor(public enabled: boolean) {}

  enable(): void {
    this.enabled = true;
  }

  disable(): void {
    this.enabled = false;
  }
}

/** A Leaflet map, holding the view the test sets and the moves asked of it. */
class FakeMap extends FakeEvented {
  /** The moves cf-map asked for, in order. */
  readonly moves: unknown[][] = [];
  readonly layers: FakeLayerGroup[] = [];
  readonly dragging: FakeHandler;
  readonly touchZoom: FakeHandler;
  readonly doubleClickZoom: FakeHandler;
  readonly scrollWheelZoom: FakeHandler;
  readonly boxZoom: FakeHandler;
  readonly keyboard: FakeHandler;
  center: LatLng;
  zoom: number;
  bounds: Bounds = { north: 2, south: 1, east: 4, west: 3 };
  /** The size Leaflet last measured. */
  size = { x: 400, y: 300 };
  /** The container's size now, which `invalidateSize()` measures. */
  readonly element = { clientWidth: 400, clientHeight: 300 };
  _animatingZoom = false;
  pane: "ready" | "missing" | "throws" = "ready";
  readsThrow = false;
  removed = false;

  constructor(
    readonly container: object,
    readonly options: Record<string, unknown>,
  ) {
    super();
    const [lat, lng] = options.center as [number, number];
    this.center = { lat, lng };
    this.zoom = options.zoom as number;
    const on = (name: string) => new FakeHandler(options[name] === true);
    this.dragging = on("dragging");
    this.touchZoom = on("touchZoom");
    this.doubleClickZoom = on("doubleClickZoom");
    this.scrollWheelZoom = on("scrollWheelZoom");
    this.boxZoom = on("boxZoom");
    this.keyboard = on("keyboard");
  }

  get handlersEnabled(): boolean[] {
    return [
      this.dragging,
      this.touchZoom,
      this.doubleClickZoom,
      this.scrollWheelZoom,
      this.boxZoom,
      this.keyboard,
    ].map((handler) => handler.enabled);
  }

  getPane(): object | undefined {
    if (this.pane === "throws") throw new Error("no map pane");
    return this.pane === "ready" ? {} : undefined;
  }

  getBounds() {
    if (this.readsThrow) throw new Error("no view");
    const bounds = this.bounds;
    return {
      getNorth: () => bounds.north,
      getSouth: () => bounds.south,
      getEast: () => bounds.east,
      getWest: () => bounds.west,
    };
  }

  getCenter(): LatLng {
    return this.center;
  }

  getZoom(): number {
    return this.zoom;
  }

  getSize(): { x: number; y: number } {
    return this.size;
  }

  getContainer(): { clientWidth: number; clientHeight: number } {
    return this.element;
  }

  /** Measures the container, and ends a move if its size changed. */
  invalidateSize(): void {
    this.moves.push(["invalidateSize"]);
    const { clientWidth: x, clientHeight: y } = this.element;
    if (x === this.size.x && y === this.size.y) return;
    this.size = { x, y };
    this.fire("moveend");
  }

  setView(...args: unknown[]): void {
    this.moves.push(["setView", ...args]);
  }

  setZoom(...args: unknown[]): void {
    this.moves.push(["setZoom", ...args]);
  }

  /** Fits `bounds`, moving at once when not animating, as Leaflet does. */
  fitBounds(bounds: unknown, options: { animate?: boolean }): void {
    this.moves.push(["fitBounds", bounds, options]);
    if (options.animate !== false) return;
    this.fire("movestart");
    this.fire("moveend");
  }

  panTo(...args: unknown[]): void {
    this.moves.push(["panTo", ...args]);
  }

  remove(): void {
    this.removed = true;
  }

  /** Plays Leaflet ending a move on `view`. */
  endMove(view: Partial<Pick<FakeMap, "center" | "zoom" | "bounds">> = {}) {
    Object.assign(this, view);
    this.fire("moveend");
  }
}

/** What the fake Leaflet made, which the test reads back. */
interface Made {
  maps: FakeMap[];
  tileLayers: { url: string; options: object; layer: FakeEvented }[];
  features: FakeFeature[];
}

function fakeLeaflet(): { leaflet: Leaflet; made: Made } {
  const made: Made = { maps: [], tileLayers: [], features: [] };
  const feature =
    (kind: FakeFeature["kind"]) =>
    (at: unknown, options: Record<string, unknown>) => {
      const made_ = new FakeFeature(kind, at, options);
      made.features.push(made_);
      return made_;
    };
  const leaflet = {
    map: (container: object, options: Record<string, unknown>) => {
      const map = new FakeMap(container, options);
      made.maps.push(map);
      return map;
    },
    tileLayer: (url: string, options: object) => {
      const layer = Object.assign(new FakeEvented(), {
        addTo: () => layer,
      });
      made.tileLayers.push({ url, options, layer });
      return layer;
    },
    layerGroup: () => new FakeLayerGroup(),
    divIcon: (options: object) => options,
    marker: feature("marker"),
    circle: feature("circle"),
    polyline: feature("polyline"),
    latLng: (lat: number, lng: number) => ({ lat, lng }),
    latLngBounds: (...corners: unknown[]) => ({ corners }),
  };
  return { leaflet: leaflet as unknown as Leaflet, made };
}

type Properties = Partial<
  Pick<
    CFMap,
    "value" | "center" | "zoom" | "bounds" | "fitToBounds" | "interactive"
  >
>;

/** The `ResizeObserver` cf-map made, which the test fires. */
class FakeResizeObserver {
  static made: FakeResizeObserver[] = [];
  observed: object[] = [];
  disconnected = false;

  constructor(readonly callback: () => void) {
    FakeResizeObserver.made.push(this);
  }

  observe(target: object): void {
    this.observed.push(target);
  }

  disconnect(): void {
    this.disconnected = true;
  }
}

interface Mounted {
  element: CFMap;
  map: FakeMap;
  made: Made;
  /** The details of the `cf-bounds-change` events emitted so far. */
  reports: CfBoundsChangeDetail[];
  /** Plays the container's `ResizeObserver` reporting a size of `x` by `y`. */
  resize(x: number, y: number): void;
}

/**
 * A cf-map mounted with `properties` set, after its first update, whose
 * Leaflet map measures `size`.
 */
async function mountMap(
  properties: Properties = {},
  size = { x: 400, y: 300 },
): Promise<Mounted> {
  const { leaflet, made } = fakeLeaflet();
  // The map measures its container as it is made, before the first fit.
  const makeMap = leaflet.map;
  leaflet.map = (...args) =>
    Object.assign(makeMap(...args), {
      size,
      element: { clientWidth: size.x, clientHeight: size.y },
    });
  const element = Object.assign(new CFMap(leaflet), properties);
  const reports: CfBoundsChangeDetail[] = [];
  element.addEventListener("cf-bounds-change", (event) => {
    if (event instanceof CustomEvent) reports.push(event.detail);
  });
  await mount(element);
  const observer = FakeResizeObserver.made.at(-1)!;
  return {
    element,
    map: made.maps[0],
    made,
    reports,
    resize(x, y) {
      Object.assign(made.maps[0].element, { clientWidth: x, clientHeight: y });
      observer.callback();
    },
  };
}

/** The container cf-map renders for Leaflet to draw in. */
function containerOf(element: CFMap): HTMLElement {
  return element.shadowRoot!.querySelector<HTMLElement>(".map-container")!;
}

/** The events of `type` the element emits, by their details. */
function emitted(element: EventTarget, type: string): unknown[] {
  const details: unknown[] = [];
  element.addEventListener(type, (event) => {
    if (event instanceof CustomEvent) details.push(event.detail);
  });
  return details;
}

/** The features drawn now of `kind`, from the map's layer groups. */
function drawn(map: FakeMap, kind: FakeFeature["kind"]): FakeFeature[] {
  return map.layers.flatMap((group) => group.layers).filter((feature) =>
    feature.kind === kind
  );
}

/** A popup's content as its children's class names and text. */
function popupContent(popup: HTMLElement | undefined): unknown {
  return {
    className: popup?.className,
    children: [...popup?.children ?? []].map((child) => ({
      tagName: child.localName,
      className: child.className,
      text: child.textContent,
    })),
  };
}

const PARIS: Bounds = { north: 48.9, south: 48.82, east: 2.42, west: 2.27 };

/** Paris's bounds as cf-map hands them to Leaflet: south-west, north-east. */
const PARIS_CORNERS = { corners: [[48.82, 2.27], [48.9, 2.42]] };

/** A person's press on the map, which makes the move it starts theirs. */
function personInput(element: CFMap): void {
  containerOf(element).dispatchEvent(
    new PointerEvent("pointerdown", { bubbles: true, composed: true }),
  );
}

describe("cf-map", () => {
  // `ResizeObserver` there observes nothing; cf-map's is played by the test.
  let resizeObserver: PropertyDescriptor | undefined;

  beforeEach(() => {
    FakeResizeObserver.made = [];
    resizeObserver = Object.getOwnPropertyDescriptor(
      globalThis,
      "ResizeObserver",
    );
    Object.defineProperty(globalThis, "ResizeObserver", {
      value: FakeResizeObserver,
      configurable: true,
      writable: true,
    });
  });

  afterEach(() => {
    document.body.replaceChildren();
    Reflect.deleteProperty(globalThis, "ResizeObserver");
    if (resizeObserver) {
      Object.defineProperty(globalThis, "ResizeObserver", resizeObserver);
    }
  });

  describe("opening the map", () => {
    it("renders a focusable container labeled as an interactive map", async () => {
      const { element } = await mountMap();

      const container = containerOf(element);
      expect(container.getAttribute("role")).toBe("application");
      expect(container.getAttribute("aria-label")).toBe("Interactive map");
      expect(container.tabIndex).toBe(0);
    });

    it("makes a map at the bound center and zoom, with the person's controls on", async () => {
      const { element, map, made } = await mountMap({
        center: { lat: 48.86, lng: 2.35 },
        zoom: 11,
      });

      expect(map.container).toBe(containerOf(element));
      expect(map.options).toEqual({
        center: [48.86, 2.35],
        zoom: 11,
        dragging: true,
        touchZoom: true,
        doubleClickZoom: true,
        scrollWheelZoom: true,
        boxZoom: true,
        keyboard: true,
        zoomControl: true,
        trackResize: false,
      });
      expect(made.tileLayers.map(({ url, options }) => ({ url, options })))
        .toEqual([{
          url: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
          options: expect.objectContaining({ crossOrigin: true }),
        }]);
      const [observer] = FakeResizeObserver.made;
      expect(observer.observed).toHaveLength(1);
      expect(observer.observed[0]).toBe(containerOf(element));
    });

    it("opens on the default view when nothing is bound", async () => {
      const { map } = await mountMap();

      expect(map.options.center).toEqual([37.7749, -122.4194]);
      expect(map.options.zoom).toBe(13);
    });

    it("opens within the map's ranges given a center and zoom outside them", async () => {
      const { map } = await mountMap({
        center: { lat: 200, lng: NaN },
        zoom: 40,
      });

      expect(map.options.center).toEqual([90, -122.4194]);
      expect(map.options.zoom).toBe(18);
    });

    it("opens with the person's controls off when not interactive", async () => {
      const { map } = await mountMap({ interactive: false });

      expect(map.handlersEnabled).toEqual([
        false,
        false,
        false,
        false,
        false,
        false,
      ]);
      expect(map.options.zoomControl).toBe(false);
    });

    it("opens on the bound bounds, without animating, and reports no move", async () => {
      const { map, reports } = await mountMap({ bounds: PARIS });

      expect(map.moves).toEqual([
        ["fitBounds", PARIS_CORNERS, { animate: false }],
      ]);
      expect(reports).toEqual([]);
    });

    it("ignores bound bounds whose south is north of their north", async () => {
      const { map } = await mountMap({
        bounds: { ...PARIS, south: PARIS.north, north: PARIS.south },
      });

      expect(map.moves).toEqual([]);
    });

    it("fits to the features rather than the stored bounds when fitToBounds is on", async () => {
      const { map } = await mountMap({
        bounds: PARIS,
        fitToBounds: true,
        value: { markers: [{ position: { lat: 1, lng: 2 } }] },
      });

      expect(map.moves.map(([move, bounds]) => [move, bounds])).not
        .toContainEqual(["fitBounds", PARIS_CORNERS]);
      expect(map.moves[0]).toEqual([
        "fitBounds",
        { corners: [[{ lat: 1, lng: 2 }]] },
        { padding: [50, 50], maxZoom: 16 },
      ]);
    });

    it("logs a tile that fails to load", async () => {
      const { made } = await mountMap();
      const warn = stub(console, "warn");
      try {
        made.tileLayers[0].layer.fire("tileerror", {
          coords: { x: 1, y: 2, z: 3 },
          error: "404",
        });
      } finally {
        warn.restore();
      }

      expect(warn.calls.map((call) => call.args)).toEqual([[
        "cf-map: Tile loading error",
        { coords: { x: 1, y: 2, z: 3 }, error: "404" },
      ]]);
    });
  });

  describe("markers", () => {
    it("draws a blue pin at each marker's position", async () => {
      const { map } = await mountMap({
        value: {
          markers: [
            { position: { lat: 1, lng: 2 } },
            { position: { lat: 3, lng: 4 }, icon: "pin" },
          ],
        },
      });

      const markers = drawn(map, "marker");
      expect(markers.map((marker) => marker.at)).toEqual([[1, 2], [3, 4]]);
      for (const marker of markers) {
        expect(marker.options.draggable).toBe(false);
        expect(marker.options.icon).toEqual(expect.objectContaining({
          className: "cf-map-default-marker",
          html: expect.stringContaining('fill="#3b82f6"'),
        }));
      }
    });

    it("draws an emoji icon as the text of its marker", async () => {
      const { map } = await mountMap({
        value: { markers: [{ position: { lat: 1, lng: 2 }, icon: "🍕" }] },
      });

      const [marker] = drawn(map, "marker");
      const icon = marker.options.icon as { className: string; html: unknown };
      expect(icon.className).toBe("cf-map-emoji-marker");
      const span = icon.html instanceof HTMLSpanElement ? icon.html : null;
      expect(span?.className).toBe("emoji-marker");
      expect(span?.textContent).toBe("🍕");
    });

    it("skips markers with no numeric position, or that throw when read", async () => {
      const throwing = {
        get position(): LatLng {
          throw new Error("still loading");
        },
      };
      const { map } = await mountMap({
        value: {
          markers: [
            null,
            {},
            { position: { lat: "1", lng: 2 } },
            throwing,
            { position: { lat: 5, lng: 6 } },
          ] as unknown as MapMarker[],
        },
      });

      expect(drawn(map, "marker").map((marker) => marker.at)).toEqual([
        [5, 6],
      ]);
    });

    it("shows the marker's icon, title, and description in its popup", async () => {
      const { map } = await mountMap({
        value: {
          markers: [{
            position: { lat: 1, lng: 2 },
            icon: "🍕",
            title: "Pizza",
            description: "<b>Hot</b>",
          }],
        },
      });

      expect(popupContent(drawn(map, "marker")[0].popup)).toEqual({
        className: "popup-simple",
        children: [
          { tagName: "div", className: "popup-icon", text: "🍕" },
          { tagName: "div", className: "popup-title", text: "Pizza" },
          { tagName: "p", className: "popup-description", text: "<b>Hot</b>" },
        ],
      });
    });

    it("gives a marker with nothing to show no popup", async () => {
      const { map } = await mountMap({
        value: { markers: [{ position: { lat: 1, lng: 2 }, icon: "📍" }] },
      });

      expect(drawn(map, "marker")[0].popup).toBeUndefined();
    });

    it("renders a reactive popup in a `cf-render`", async () => {
      const popup = createMockCellHandle({ note: "hi" });
      const { map } = await mountMap({
        value: {
          markers: [{
            position: { lat: 1, lng: 2 },
            title: "Ignored",
            popup: popup as unknown as MapMarker["popup"],
          }],
        },
      });

      const content = drawn(map, "marker")[0].popup!;
      expect(content.className).toBe("");
      expect(content.children).toHaveLength(1);
      const render = content.firstElementChild;
      expect(render instanceof CFRender ? render.cell : null).toBe(popup);
    });

    it("emits `cf-marker-click` with the marker, its index, and where it was clicked", async () => {
      const markers = [
        { position: { lat: 1, lng: 2 } },
        { position: { lat: 3, lng: 4 }, title: "B" },
      ];
      const { element, map } = await mountMap({ value: { markers } });
      const clicks = emitted(element, "cf-marker-click");

      drawn(map, "marker")[1].fire("click", { latlng: { lat: 3.1, lng: 4.1 } });

      expect(clicks).toEqual([
        { marker: markers[1], index: 1, lat: 3.1, lng: 4.1 },
      ]);
    });

    it("emits `cf-marker-drag-end` with where a drag started and ended", async () => {
      const markers = [{ position: { lat: 1, lng: 2 }, draggable: true }];
      const { element, map } = await mountMap({ value: { markers } });
      const drags = emitted(element, "cf-marker-drag-end");
      const [marker] = drawn(map, "marker");
      expect(marker.options.draggable).toBe(true);

      // The marker moved since it was drawn; the drag starts from there.
      marker.at = [1.5, 2.5];
      marker.fire("dragstart");
      marker.at = [7, 8];
      marker.fire("dragend", { target: marker });

      expect(drags).toEqual([{
        marker: markers[0],
        index: 0,
        position: { lat: 7, lng: 8 },
        oldPosition: { lat: 1.5, lng: 2.5 },
      }]);
    });

    it("reports the drawn position as where a drag started when none was seen", async () => {
      const markers = [{ position: { lat: 1, lng: 2 }, draggable: true }];
      const { element, map } = await mountMap({ value: { markers } });
      const drags = emitted(element, "cf-marker-drag-end");
      const [marker] = drawn(map, "marker");

      marker.at = [7, 8];
      marker.fire("dragend", { target: marker });

      expect(drags).toEqual([
        expect.objectContaining({ oldPosition: { lat: 1, lng: 2 } }),
      ]);
    });

    it("listens for no drags on a marker that is not draggable", async () => {
      const { map } = await mountMap({
        value: { markers: [{ position: { lat: 1, lng: 2 } }] },
      });

      const [marker] = drawn(map, "marker");
      expect(marker.listens("click")).toBe(true);
      expect(marker.listens("dragend")).toBe(false);
    });
  });

  describe("circles", () => {
    it("draws each circle with its radius, in a blue outline by default", async () => {
      const { map } = await mountMap({
        value: {
          circles: [
            { center: { lat: 1, lng: 2 }, radius: 100 },
            {
              center: { lat: 3, lng: 4 },
              radius: 50,
              color: "red",
              fillOpacity: 0,
              strokeWidth: 0,
            },
          ],
        },
      });

      expect(drawn(map, "circle").map(({ at, options }) => ({ at, options })))
        .toEqual([
          {
            at: [1, 2],
            options: {
              radius: 100,
              color: "#3b82f6",
              fillColor: "#3b82f6",
              fillOpacity: 0.2,
              weight: 2,
            },
          },
          {
            at: [3, 4],
            options: {
              radius: 50,
              color: "red",
              fillColor: "red",
              fillOpacity: 0,
              weight: 0,
            },
          },
        ]);
    });

    it("skips circles with no numeric center, or that throw when read", async () => {
      const throwing = {
        get center(): LatLng {
          throw new Error("still loading");
        },
      };
      const { map } = await mountMap({
        value: {
          circles: [
            null,
            { radius: 1 },
            { center: { lat: 1, lng: null }, radius: 1 },
            throwing,
            { center: { lat: 5, lng: 6 }, radius: 1 },
          ] as unknown as MapCircle[],
        },
      });

      expect(drawn(map, "circle").map((circle) => circle.at)).toEqual([
        [5, 6],
      ]);
    });

    it("shows a titled circle's title in its popup, and gives an untitled one none", async () => {
      const { map } = await mountMap({
        value: {
          circles: [
            { center: { lat: 1, lng: 2 }, radius: 1, title: "Zone" },
            { center: { lat: 3, lng: 4 }, radius: 1, description: "Unseen" },
          ],
        },
      });

      const [titled, untitled] = drawn(map, "circle");
      expect(popupContent(titled.popup)).toEqual({
        className: "popup-simple",
        children: [{ tagName: "div", className: "popup-title", text: "Zone" }],
      });
      expect(untitled.popup).toBeUndefined();
    });

    it("emits `cf-circle-click` with the circle, its index, and where it was clicked", async () => {
      const circles = [{ center: { lat: 1, lng: 2 }, radius: 5 }];
      const { element, map } = await mountMap({ value: { circles } });
      const clicks = emitted(element, "cf-circle-click");

      drawn(map, "circle")[0].fire("click", { latlng: { lat: 1.1, lng: 2.1 } });

      expect(clicks).toEqual([
        { circle: circles[0], index: 0, lat: 1.1, lng: 2.1 },
      ]);
    });
  });

  describe("polylines", () => {
    it("draws each polyline through its numeric points, in blue by default", async () => {
      const { map } = await mountMap({
        value: {
          polylines: [
            {
              points: [
                { lat: 1, lng: 2 },
                null,
                { lat: "3", lng: 4 },
                { lat: 5, lng: 6 },
              ] as unknown as LatLng[],
            },
            {
              points: [{ lat: 7, lng: 8 }],
              color: "red",
              strokeWidth: 1,
              dashArray: "5, 10",
            },
          ],
        },
      });

      expect(drawn(map, "polyline").map(({ at, options }) => ({ at, options })))
        .toEqual([
          {
            at: [[1, 2], [5, 6]],
            options: { color: "#3b82f6", weight: 3, dashArray: undefined },
          },
          {
            at: [[7, 8]],
            options: { color: "red", weight: 1, dashArray: "5, 10" },
          },
        ]);
    });

    it("skips polylines with no numeric point", async () => {
      const { map } = await mountMap({
        value: {
          polylines: [
            null,
            {},
            { points: "1,2" },
            { points: [null] },
          ] as unknown as MapValue["polylines"],
        },
      });

      expect(drawn(map, "polyline")).toEqual([]);
    });
  });

  describe("redrawing", () => {
    it("replaces the features drawn when the value changes, and stops listening to the old ones", async () => {
      const { element, map } = await mountMap({
        value: {
          markers: [{ position: { lat: 1, lng: 2 } }],
          circles: [{ center: { lat: 1, lng: 2 }, radius: 1 }],
          polylines: [{ points: [{ lat: 1, lng: 2 }] }],
        },
      });
      const before = map.layers.flatMap((group) => group.layers);

      element.value = { markers: [{ position: { lat: 9, lng: 9 } }] };
      await element.updateComplete;

      expect(before.map((feature) => feature.listens("click"))).toEqual([
        false,
        false,
        false,
      ]);
      expect(map.layers.flatMap((group) => group.layers).map((f) => f.at))
        .toEqual([[9, 9]]);
    });

    it("redraws when the bound value cell changes", async () => {
      const value = createMockCellHandle<MapValue>({
        markers: [{ position: { lat: 1, lng: 2 } }],
      });
      const { element, map } = await mountMap({ value });

      pushUpdate(value, { markers: [{ position: { lat: 3, lng: 4 } }] });
      await element.updateComplete;

      expect(drawn(map, "marker").map((marker) => marker.at)).toEqual([
        [3, 4],
      ]);
    });

    it("leaves the drawing alone on an update that changes no value", async () => {
      const { element, map } = await mountMap({
        value: { markers: [{ position: { lat: 1, lng: 2 } }] },
      });
      const [marker] = drawn(map, "marker");

      element.zoom = 5;
      await element.updateComplete;

      expect(drawn(map, "marker")).toEqual([marker]);
    });
  });

  describe("clicks", () => {
    it("emits `cf-click` where the map was clicked", async () => {
      const { element, map } = await mountMap();
      const clicks = emitted(element, "cf-click");

      map.fire("click", { latlng: { lat: 1, lng: 2 } });

      expect(clicks).toEqual([{ lat: 1, lng: 2 }]);
    });

    it("holds a click made during a zoom animation until the zoom ends", async () => {
      const { element, map } = await mountMap();
      const clicks = emitted(element, "cf-click");

      map._animatingZoom = true;
      map.fire("click", { latlng: { lat: 1, lng: 2 } });
      map.fire("zoomend");
      expect(clicks).toEqual([]);

      map._animatingZoom = false;
      map.fire("zoomend");
      map.fire("zoomend");
      expect(clicks).toEqual([{ lat: 1, lng: 2 }]);
    });

    it("holds a click while Leaflet's map pane is missing or unreadable", async () => {
      const { element, map } = await mountMap();
      const clicks = emitted(element, "cf-click");

      map.pane = "missing";
      map.fire("click", { latlng: { lat: 1, lng: 2 } });
      map.pane = "throws";
      map.fire("click", { latlng: { lat: 3, lng: 4 } });
      expect(clicks).toEqual([]);

      map.pane = "ready";
      map.fire("zoomend");
      expect(clicks).toEqual([{ lat: 3, lng: 4 }]);
    });
  });

  describe("reporting moves", () => {
    it("emits `cf-bounds-change` with the view a move ended on, as cf-map's own", async () => {
      const { map, reports } = await mountMap();

      map.fire("movestart");
      map.endMove({ center: { lat: 1, lng: 2 }, zoom: 5, bounds: PARIS });

      expect(reports).toEqual([{
        bounds: PARIS,
        center: { lat: 1, lng: 2 },
        zoom: 5,
        userInitiated: false,
      }]);
    });

    it("reports a move started after a person's input as theirs, until cf-map moves", async () => {
      const { element, map, reports } = await mountMap();

      personInput(element);
      map.fire("movestart");
      map.endMove();
      element.panTo(1, 2);
      map.fire("movestart");
      map.endMove();

      expect(reports.map((report) => report.userInitiated)).toEqual([
        true,
        false,
      ]);
    });

    it("writes the view into the bound cells, without moving the map back", async () => {
      const center = createMockCellHandle<LatLng>({ lat: 0, lng: 0 });
      const zoom = createMockCellHandle<number>(3);
      const bounds = createMockCellHandle<Bounds>({
        north: 1,
        south: 0,
        east: 1,
        west: 0,
      });
      const { map } = await mountMap({ center, zoom, bounds });
      const opened = map.moves.length;

      map.endMove({ center: { lat: 1, lng: 2 }, zoom: 5, bounds: PARIS });
      await Promise.resolve();

      const written = <T>(cell: CellHandle<T>) =>
        writesSent(cell).map((write) => write.value);
      expect(written(center)).toEqual([{ lat: 1, lng: 2 }]);
      expect(written(zoom)).toEqual([5]);
      expect(written(bounds)).toEqual([PARIS]);
      expect(map.moves.slice(opened)).toEqual([]);
    });

    it("reports nothing while the map is unsettled, or when Leaflet cannot read the view", async () => {
      const { map, reports } = await mountMap();

      map._animatingZoom = true;
      map.endMove();
      map._animatingZoom = false;
      map.readsThrow = true;
      map.endMove();

      expect(reports).toEqual([]);
    });
  });

  describe("following bound values", () => {
    it("animates to a new center, zoom, or bounds in the bound cells", async () => {
      const center = createMockCellHandle<LatLng>({ lat: 0, lng: 0 });
      const zoom = createMockCellHandle<number>(3);
      const bounds = createMockCellHandle<Bounds>(PARIS);
      const { map } = await mountMap({ center, zoom, bounds });
      map.moves.length = 0;
      map.zoom = 7;

      pushUpdate(center, { lat: 1, lng: 2 });
      pushUpdate(zoom, 30);
      pushUpdate(bounds, { ...PARIS, north: 49 });

      expect(map.moves).toEqual([
        ["setView", [1, 2], 7, { animate: true }],
        ["setZoom", 18, { animate: true }],
        [
          "fitBounds",
          { corners: [[48.82, 2.27], [49, 2.42]] },
          { animate: true },
        ],
      ]);
    });

    it("applies a center or zoom property set after the first update, but not at it", async () => {
      const { element, map } = await mountMap({
        center: { lat: 1, lng: 2 },
        zoom: 4,
      });
      expect(map.moves).toEqual([]);

      element.center = { lat: 3, lng: 4 };
      element.zoom = 6;
      await element.updateComplete;

      expect(map.moves).toEqual([
        ["setView", [3, 4], 4, { animate: true }],
        ["setZoom", 6, { animate: true }],
      ]);
    });

    it("moves nothing for bounds that are invalid or not yet held", async () => {
      const bounds = createMockCellHandle<Bounds>();
      const { map } = await mountMap({ bounds });

      pushUpdate(bounds, { ...PARIS, east: 200 });

      expect(map.moves).toEqual([]);
    });

    it("starts moves asked for during a zoom animation one at a time once it ends", async () => {
      const center = createMockCellHandle<LatLng>({ lat: 0, lng: 0 });
      const zoom = createMockCellHandle<number>(3);
      const { map } = await mountMap({ center, zoom });

      map._animatingZoom = true;
      pushUpdate(center, { lat: 1, lng: 2 });
      pushUpdate(zoom, 8);
      expect(map.moves).toEqual([]);

      map._animatingZoom = false;
      map.endMove();
      expect(map.moves).toEqual([["setView", [1, 2], 3, { animate: true }]]);
      map.endMove();
      expect(map.moves.at(-1)).toEqual(["setZoom", 8, { animate: true }]);
      map.endMove();
      expect(map.moves).toHaveLength(2);
    });

    it("starts queued bounds in place of a queued center and zoom", async () => {
      const center = createMockCellHandle<LatLng>({ lat: 0, lng: 0 });
      const bounds = createMockCellHandle<Bounds>(PARIS);
      const { map } = await mountMap({ center, bounds });
      map.moves.length = 0;

      map._animatingZoom = true;
      pushUpdate(center, { lat: 1, lng: 2 });
      pushUpdate(bounds, { ...PARIS, north: 49 });
      map._animatingZoom = false;
      map.endMove();
      map.endMove();

      expect(map.moves).toEqual([[
        "fitBounds",
        { corners: [[48.82, 2.27], [49, 2.42]] },
        { animate: true },
      ]]);
    });

    it("drops bound values that arrive during a person's move, whose view supersedes them", async () => {
      const center = createMockCellHandle<LatLng>({ lat: 0, lng: 0 });
      const { element, map } = await mountMap({ center });

      personInput(element);
      map.fire("movestart");
      pushUpdate(center, { lat: 1, lng: 2 });
      map.endMove();

      expect(map.moves).toEqual([]);
    });
  });

  describe("interactive", () => {
    it("turns the person's controls off and on again", async () => {
      const { element, map } = await mountMap();

      element.interactive = false;
      await element.updateComplete;
      const off = map.handlersEnabled;
      element.interactive = true;
      await element.updateComplete;

      expect(off).toEqual([false, false, false, false, false, false]);
      expect(map.handlersEnabled).toEqual([true, true, true, true, true, true]);
    });
  });

  describe("fitting to the features", () => {
    const value: MapValue = {
      markers: [{ position: { lat: 1, lng: 2 } }],
      circles: [{ center: { lat: 3, lng: 4 }, radius: 1 }],
      polylines: [{ points: [{ lat: 5, lng: 6 }] }],
    };
    const fit = [
      "fitBounds",
      {
        corners: [[{ lat: 1, lng: 2 }, { lat: 3, lng: 4 }, { lat: 5, lng: 6 }]],
      },
      { padding: [50, 50], maxZoom: 16 },
    ];

    it("frames every feature when fitToBounds turns on", async () => {
      const { element, map } = await mountMap({ value });
      expect(map.moves).toEqual([]);

      element.fitToBounds = true;
      await element.updateComplete;

      expect(map.moves).toEqual([fit]);
    });

    it("frames the features again when they change", async () => {
      const { element, map } = await mountMap({ value, fitToBounds: true });
      map.moves.length = 0;

      element.value = { markers: [{ position: { lat: 9, lng: 9 } }] };
      await element.updateComplete;

      expect(map.moves).toEqual([[
        "fitBounds",
        { corners: [[{ lat: 9, lng: 9 }]] },
        { padding: [50, 50], maxZoom: 16 },
      ]]);
    });

    it("moves nothing when there are no features", async () => {
      const { element, map } = await mountMap();

      element.fitBounds();

      expect(map.moves).toEqual([]);
    });

    it("runs a fit asked for during a person's move once the move ends", async () => {
      const { element, map } = await mountMap({ value });

      personInput(element);
      map.fire("movestart");
      element.fitBounds();
      expect(map.moves).toEqual([]);
      map.endMove();

      expect(map.moves).toEqual([fit]);
    });

    it("drops a fit queued behind a person's move when fitToBounds turns off", async () => {
      const { element, map } = await mountMap({ value });

      personInput(element);
      map.fire("movestart");
      element.fitToBounds = true;
      await element.updateComplete;
      element.fitToBounds = false;
      await element.updateComplete;
      map.endMove();

      expect(map.moves).toEqual([]);
    });

    it("drops a refit the features asked for during a person's move", async () => {
      const { element, map } = await mountMap({ value, fitToBounds: true });
      map.moves.length = 0;

      personInput(element);
      map.fire("movestart");
      element.value = { markers: [{ position: { lat: 9, lng: 9 } }] };
      await element.updateComplete;
      map.endMove();

      expect(map.moves).toEqual([]);
    });
  });

  describe("resizing", () => {
    it("follows a container resize as cf-map's own move", async () => {
      const { map, reports, resize } = await mountMap();

      resize(400, 300);
      resize(500, 300);

      expect(map.moves).toEqual([["invalidateSize"], ["invalidateSize"]]);
      expect(reports.map((report) => report.userInitiated)).toEqual([false]);
    });

    it("leaves a person's move theirs, and moves queued behind it waiting, across a resize", async () => {
      const center = createMockCellHandle<LatLng>({ lat: 0, lng: 0 });
      const { element, map, reports, resize } = await mountMap({
        center,
        value: { markers: [{ position: { lat: 1, lng: 2 } }] },
      });

      personInput(element);
      map.fire("movestart");
      pushUpdate(center, { lat: 5, lng: 6 });
      element.fitBounds();
      resize(500, 300);
      expect(map.moves).toEqual([["invalidateSize"]]);
      map.endMove();

      expect(reports.map((report) => report.userInitiated)).toEqual([
        true,
        true,
      ]);
      expect(map.moves.slice(1)).toEqual([[
        "fitBounds",
        { corners: [[{ lat: 1, lng: 2 }]] },
        { padding: [50, 50], maxZoom: 16 },
      ]]);
    });

    it("fits the bounds and features that waited for a size once it has one, as one move", async () => {
      const { map, reports, resize, element } = await mountMap(
        {
          bounds: PARIS,
          value: { markers: [{ position: { lat: 1, lng: 2 } }] },
        },
        { x: 0, y: 0 },
      );
      element.fitBounds();
      expect(map.moves).toEqual([]);

      resize(0, 0);
      expect(map.moves).toEqual([["invalidateSize"]]);
      resize(400, 300);

      expect(map.moves.slice(1)).toEqual([
        ["invalidateSize"],
        ["fitBounds", PARIS_CORNERS, { animate: false }],
        [
          "fitBounds",
          { corners: [[{ lat: 1, lng: 2 }]] },
          { padding: [50, 50], maxZoom: 16, animate: false },
        ],
      ]);
      expect(reports.map((report) => report.userInitiated)).toEqual([false]);
    });

    it("drops bounds waiting for a size when a center replaces them", async () => {
      const { element, map, resize } = await mountMap({ bounds: PARIS }, {
        x: 0,
        y: 0,
      });

      element.center = { lat: 1, lng: 2 };
      await element.updateComplete;
      resize(400, 300);

      expect(map.moves).toEqual([
        ["setView", [1, 2], 13, { animate: true }],
        ["invalidateSize"],
      ]);
    });

    it("drops a fit waiting for a size when fitToBounds turns off", async () => {
      const { element, map, resize } = await mountMap({
        fitToBounds: true,
        value: { markers: [{ position: { lat: 1, lng: 2 } }] },
      }, { x: 0, y: 0 });

      element.fitToBounds = false;
      await element.updateComplete;
      resize(400, 300);

      expect(map.moves).toEqual([["invalidateSize"]]);
    });

    it("runs a fit that waited for a size after a person's move under way, but drops the bounds", async () => {
      const { element, map, reports, resize } = await mountMap({
        bounds: PARIS,
        value: { markers: [{ position: { lat: 1, lng: 2 } }] },
      }, { x: 0, y: 0 });
      element.fitBounds();

      personInput(element);
      map.fire("movestart");
      resize(400, 300);
      expect(map.moves).toEqual([["invalidateSize"]]);
      map.endMove();

      // The resize's move is part of the person's, which it does not end.
      expect(reports.map((report) => report.userInitiated)).toEqual([
        true,
        true,
      ]);
      expect(map.moves.slice(1)).toEqual([[
        "fitBounds",
        { corners: [[{ lat: 1, lng: 2 }]] },
        { padding: [50, 50], maxZoom: 16 },
      ]]);
    });

    it("follows a resize when `invalidateSize()` is called", async () => {
      const { element, map } = await mountMap();

      element.invalidateSize();

      expect(map.moves).toEqual([["invalidateSize"]]);
    });
  });

  describe("public methods", () => {
    it("drops moves asked for before the map is made", async () => {
      const { leaflet, made } = fakeLeaflet();
      const element = new CFMap(leaflet);
      element.value = { markers: [{ position: { lat: 1, lng: 2 } }] };

      element.panTo(1, 2);
      element.setView(1, 2, 3);
      element.fitBounds();
      element.invalidateSize();
      await mount(element);

      expect(made.maps[0].moves).toEqual([]);
    });

    it("exposes the Leaflet map", async () => {
      const { element, map } = await mountMap();

      expect(element.leafletMap).toBe(map);
    });

    it("pans and sets the view on request, but not during a person's move", async () => {
      const { element, map } = await mountMap();

      element.panTo(1, 2);
      element.setView(3, 4, 5);
      personInput(element);
      map.fire("movestart");
      element.panTo(6, 7);
      element.setView(8, 9, 10);

      expect(map.moves).toEqual([["panTo", [1, 2]], ["setView", [3, 4], 5]]);
    });
  });

  describe("disconnecting", () => {
    it("draws nothing while disconnected", async () => {
      const { element, made } = await mountMap();

      element.remove();
      element.value = { markers: [{ position: { lat: 1, lng: 2 } }] };
      await element.updateComplete;

      expect(made.features).toEqual([]);
    });

    it("draws a new map, with its bounds and features, when connected again", async () => {
      const { element, made } = await mountMap({
        bounds: PARIS,
        value: { markers: [{ position: { lat: 1, lng: 2 } }] },
      });

      element.remove();
      document.body.append(element);

      expect(made.maps).toHaveLength(2);
      const [first, second] = made.maps;
      expect(first.removed).toBe(true);
      expect(second.container).toBe(containerOf(element));
      expect(second.moves).toEqual([
        ["fitBounds", PARIS_CORNERS, { animate: false }],
      ]);
      expect(drawn(second, "marker").map((marker) => marker.at)).toEqual([
        [1, 2],
      ]);
      expect(element.leafletMap).toBe(second);
    });

    it("removes the map and stops observing its size", async () => {
      const { element, map, reports } = await mountMap();
      const observer = FakeResizeObserver.made[0];

      element.remove();

      expect(map.removed).toBe(true);
      expect(observer.disconnected).toBe(true);
      expect(element.leafletMap).toBeNull();
      map.endMove();
      expect(reports).toEqual([]);
    });
  });
});
