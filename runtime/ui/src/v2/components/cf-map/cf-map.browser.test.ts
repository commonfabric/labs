/**
 * cf-map in a real browser: it opens on the bounds its `bounds` cell holds,
 * and its `cf-bounds-change` says whether a person moved the map or cf-map
 * moved it itself (a feature fit, a bound value, a resize). cf-map's own
 * moves wait out a person's move, and a person's move cancels them.
 */

import { expect } from "@std/expect";

import {
  createMockCellHandle,
  pushUpdate,
  writesSent,
} from "../../test-utils/mock-cell-handle.ts";
import { CFMap } from "./index.ts";
import type { Bounds, CfBoundsChangeDetail, MapValue } from "./types.ts";

/** A box around Paris, far from cf-map's default view of San Francisco. */
const PARIS: Bounds = { north: 48.9, south: 48.82, east: 2.42, west: 2.27 };
const PARIS_CENTER = { lat: 48.86, lng: 2.345 };
/** A box around San Francisco, inside cf-map's default view. */
const SF_BOX: Bounds = {
  north: 37.81,
  south: 37.76,
  east: -122.39,
  west: -122.45,
};
/**
 * A small box beside Paris, east of the Paris box: within four zoom levels of
 * a map fitted to one Paris marker, so Leaflet animates the move and reports
 * it.
 */
const PARIS_EAST: Bounds = {
  north: 48.87,
  south: 48.85,
  east: 2.62,
  west: 2.58,
};
/** Outside the Paris box by about the box's own width. */
const NEAR_PARIS = { lat: 48.86, lng: 2.6 };

/** Two points near the default view, which a fit reaches by animating. */
const NEAR_DEFAULT: MapValue = {
  markers: [
    { position: { lat: 37.78, lng: -122.42 } },
    { position: { lat: 37.8, lng: -122.4 } },
  ],
};

/** The same two points nudged, for a second animated fit. */
const NEAR_DEFAULT_NUDGED: MapValue = {
  markers: [
    { position: { lat: 37.77, lng: -122.43 } },
    { position: { lat: 37.79, lng: -122.41 } },
  ],
};

type Mounted = { map: CFMap; [Symbol.dispose]: () => void };

/** A sized cf-map, set up by `configure` before it renders. */
function sizedMap(configure: (map: CFMap) => void): CFMap {
  const map = new CFMap();
  map.style.display = "block";
  map.style.width = "400px";
  map.style.height = "300px";
  configure(map);
  return map;
}

/** A sized cf-map in the page, set up by `configure` before it renders. */
async function mounted(configure: (map: CFMap) => void): Promise<Mounted> {
  const map = sizedMap(configure);
  document.body.append(map);
  await map.updateComplete;
  return { map, [Symbol.dispose]: () => map.remove() };
}

/** A sized cf-map fitted to `features`, mounted once its first fit is done. */
async function fittedTo(features: MapValue): Promise<Mounted> {
  const map = sizedMap((map) => {
    map.value = features;
    map.fitToBounds = true;
  });
  const fitted = nextBoundsChange(map);
  document.body.append(map);
  await fitted;
  return { map, [Symbol.dispose]: () => map.remove() };
}

/** The `.map-container` Leaflet draws into. */
function container(map: CFMap): HTMLElement {
  const element = map.shadowRoot?.querySelector(".map-container");
  if (!(element instanceof HTMLElement)) {
    throw new Error("cf-map did not render its container");
  }
  return element;
}

/** The next `cf-bounds-change` the map emits. */
function nextBoundsChange(map: CFMap): Promise<CfBoundsChangeDetail> {
  return new Promise((resolve) => {
    map.addEventListener("cf-bounds-change", (event) => {
      if (event instanceof CustomEvent) resolve(event.detail);
    }, { once: true });
  });
}

/** Counts the `cf-bounds-change` events the map emits from now on. */
function countBoundsChanges(map: CFMap): { count: number } {
  const counter = { count: 0 };
  map.addEventListener("cf-bounds-change", () => counter.count++);
  return counter;
}

/** The next animation frame. */
function nextFrame(): Promise<number> {
  return new Promise((resolve) => requestAnimationFrame(resolve));
}

/** The longitude `pixels` of Web Mercator map span at `zoom`. */
function lngSpan(pixels: number, zoom: number): number {
  return pixels * 360 / (256 * 2 ** zoom);
}

/**
 * Whether the map, which does not fit to its features, draws a marker for
 * `position` inside its container.
 */
async function showsMarkerAt(
  map: CFMap,
  position: { lat: number; lng: number },
): Promise<boolean> {
  map.value = { markers: [{ position }] };
  await map.updateComplete;
  return drawsMarkerInside(map);
}

/** Whether the map draws one of its markers inside its container. */
function drawsMarkerInside(map: CFMap): boolean {
  const box = container(map).getBoundingClientRect();
  return [...container(map).querySelectorAll(".leaflet-marker-icon")].some(
    (marker) => {
      const r = marker.getBoundingClientRect();
      return r.left >= box.left && r.right <= box.right &&
        r.top >= box.top && r.bottom <= box.bottom;
    },
  );
}

/** Mouse event options at the map's middle, `dx` pixels to the right. */
function mouseAt(map: CFMap, dx: number): MouseEventInit {
  const box = container(map).getBoundingClientRect();
  return {
    clientX: box.left + box.width / 2 + dx,
    clientY: box.top + box.height / 2,
    button: 0,
    bubbles: true,
    composed: true,
    cancelable: true,
  };
}

/** A mouse press on the map, which Leaflet takes as the start of a drag. */
function press(map: CFMap): void {
  // A mouse's pointer press; Leaflet drags a mouse on its mouse events.
  container(map).dispatchEvent(
    new PointerEvent("pointerdown", {
      ...mouseAt(map, 0),
      pointerType: "mouse",
    }),
  );
  container(map).dispatchEvent(new MouseEvent("mousedown", mouseAt(map, 0)));
}

/**
 * Moves the pressed mouse to `dx` pixels right of where it was pressed. A
 * drag of one move ends without an inertial glide: Leaflet glides only on two
 * samples, and two a few milliseconds apart make a flick that glides for
 * seconds.
 */
function moveTo(map: CFMap, dx: number): void {
  container(map).dispatchEvent(new MouseEvent("mousemove", mouseAt(map, dx)));
}

/** Lets the mouse go `dx` pixels right of where it was pressed. */
function release(map: CFMap, dx: number): void {
  container(map).dispatchEvent(new MouseEvent("mouseup", mouseAt(map, dx)));
}

/** A wheel turn at the map's middle, which Leaflet zooms in on. */
function wheel(map: CFMap): void {
  container(map).dispatchEvent(
    new WheelEvent("wheel", { ...mouseAt(map, 0), deltaY: -240 }),
  );
}

//
// Opening on the bound bounds
//

Deno.test("cf-map opens on the bounds its bounds cell holds", async () => {
  using page = await mounted((map) => {
    map.bounds = createMockCellHandle(PARIS);
  });
  expect(await showsMarkerAt(page.map, PARIS_CENTER)).toBe(true);
  // The box itself, not a wider view that also holds it.
  expect(await showsMarkerAt(page.map, NEAR_PARIS)).toBe(false);
});

Deno.test("cf-map with no bounds opens on its default view", async () => {
  using page = await mounted(() => {});
  expect(await showsMarkerAt(page.map, PARIS_CENTER)).toBe(false);
});

Deno.test("bound bounds win over a bound center and zoom at mount", async () => {
  using page = await mounted((map) => {
    map.bounds = createMockCellHandle(PARIS);
    map.center = createMockCellHandle({ lat: 37.7749, lng: -122.4194 });
    map.zoom = createMockCellHandle(13);
  });
  // Past the frames in which a move of the first update would land.
  await nextFrame();
  await nextFrame();
  expect(await showsMarkerAt(page.map, PARIS_CENTER)).toBe(true);
});

Deno.test("opening on the bound bounds reports no move and writes no cell", async () => {
  const bounds = createMockCellHandle(PARIS);
  const map = sizedMap((map) => {
    map.bounds = bounds;
  });
  const changes = countBoundsChanges(map);
  document.body.append(map);
  try {
    await map.updateComplete;
    // Past the mount's resize frame, the move it could have made.
    await nextFrame();
    await nextFrame();
    expect(changes.count).toBe(0);
    expect(writesSent(bounds)).toEqual([]);
  } finally {
    map.remove();
  }
});

Deno.test("cf-map mounted hidden opens on its bound bounds once it is shown", async () => {
  const hidden = document.createElement("div");
  hidden.style.display = "none";
  document.body.append(hidden);
  try {
    const map = sizedMap((map) => {
      map.bounds = createMockCellHandle(PARIS);
    });
    hidden.append(map);
    await map.updateComplete;
    // Shown later than the mount's own resize frame.
    await nextFrame();
    await nextFrame();

    // Shown, the map reports the fitted view as cf-map's own move: the Paris
    // box, not the whole world a map with no size fits it to.
    const shown = nextBoundsChange(map);
    hidden.style.display = "block";
    const detail = await shown;
    expect(detail.userInitiated).toBe(false);
    expect(detail.zoom).toBeGreaterThanOrEqual(11);
    expect(detail.bounds.north).toBeLessThan(49);
    expect(detail.bounds.south).toBeGreaterThan(48.7);
  } finally {
    hidden.remove();
  }
});

//
// Who moved the map
//

Deno.test("an animated fit to the features is reported as cf-map's own move", async () => {
  const map = sizedMap((map) => {
    map.value = NEAR_DEFAULT;
    map.fitToBounds = true;
  });
  // Listening before the map renders, since the fit starts as it does.
  const change = nextBoundsChange(map);
  document.body.append(map);
  try {
    expect((await change).userInitiated).toBe(false);
  } finally {
    map.remove();
  }
});

Deno.test("a resize of the container is reported as cf-map's own move", async () => {
  using page = await mounted(() => {});
  const change = nextBoundsChange(page.map);
  page.map.style.width = "200px";
  const detail = await change;
  // The move reported is the resize's: 200 pixels at the default zoom.
  expect(detail.zoom).toBe(13);
  expect(detail.bounds.east - detail.bounds.west).toBeCloseTo(
    lngSpan(200, 13),
    6,
  );
  expect(detail.userInitiated).toBe(false);
});

Deno.test("a wheel zoom is a person's move", async () => {
  using page = await mounted(() => {});
  const zoom = nextBoundsChange(page.map);
  wheel(page.map);
  const detail = await zoom;
  expect(detail.zoom).toBeGreaterThan(13);
  expect(detail.userInitiated).toBe(true);
});

Deno.test("a drag is a person's move", async () => {
  using page = await mounted(() => {});
  const pan = nextBoundsChange(page.map);
  press(page.map);
  moveTo(page.map, 80);
  release(page.map, 80);
  expect((await pan).userInitiated).toBe(true);
});

Deno.test("a feature fit after a person's move is cf-map's own", async () => {
  using page = await fittedTo(NEAR_DEFAULT);
  const pan = nextBoundsChange(page.map);
  press(page.map);
  moveTo(page.map, 40);
  release(page.map, 40);
  expect((await pan).userInitiated).toBe(true);

  const fit = nextBoundsChange(page.map);
  page.map.value = NEAR_DEFAULT_NUDGED;
  expect((await fit).userInitiated).toBe(false);
});

Deno.test("a press that moves nothing leaves cf-map's next fit its own", async () => {
  using page = await fittedTo(NEAR_DEFAULT);
  press(page.map);
  release(page.map, 0);
  const fit = nextBoundsChange(page.map);
  page.map.value = NEAR_DEFAULT_NUDGED;
  expect((await fit).userInitiated).toBe(false);
});

Deno.test("a window resize after a press that moves nothing is cf-map's own", async () => {
  using page = await mounted(() => {});
  // Past the mount's own resize frame, which would report the size change
  // before the window's resize could.
  await nextFrame();
  await nextFrame();
  press(page.map);
  release(page.map, 0);
  const change = nextBoundsChange(page.map);
  page.map.style.width = "200px";
  globalThis.dispatchEvent(new Event("resize"));
  expect((await change).userInitiated).toBe(false);
});

Deno.test("a resize after a wheel zoom is cf-map's own", async () => {
  using page = await mounted(() => {});
  const zoom = nextBoundsChange(page.map);
  wheel(page.map);
  expect((await zoom).userInitiated).toBe(true);
  const resize = nextBoundsChange(page.map);
  page.map.style.width = "200px";
  expect((await resize).userInitiated).toBe(false);
});

Deno.test("features that arrive during a drag neither move the map nor take the drag", async () => {
  using page = await fittedTo(NEAR_DEFAULT);
  press(page.map);
  moveTo(page.map, 40);
  // Far features, which a fit would jump to in one step.
  page.map.value = { markers: [{ position: PARIS_CENTER }] };
  await page.map.updateComplete;
  const pan = nextBoundsChange(page.map);
  release(page.map, 40);
  const detail = await pan;
  expect(detail.userInitiated).toBe(true);
  // The drag's view, near where it started, not the features'.
  expect(detail.center.lat).toBeCloseTo(37.79, 1);

  // The fit queued behind the drag is cancelled by it, not run after it: the
  // far feature stays off the map.
  await nextFrame();
  await nextFrame();
  expect(drawsMarkerInside(page.map)).toBe(false);
});

Deno.test("a resize during a drag leaves the drag the person's", async () => {
  using page = await fittedTo(NEAR_DEFAULT);
  press(page.map);
  moveTo(page.map, 40);
  const resized = nextBoundsChange(page.map);
  page.map.style.width = "200px";
  await resized;
  // Far features, whose fit must still wait for the drag to end.
  page.map.value = { markers: [{ position: PARIS_CENTER }] };
  await page.map.updateComplete;
  const pan = nextBoundsChange(page.map);
  release(page.map, 40);
  const detail = await pan;
  expect(detail.userInitiated).toBe(true);
  expect(detail.center.lat).toBeCloseTo(37.79, 1);
  await nextFrame();
  await nextFrame();
  expect(drawsMarkerInside(page.map)).toBe(false);
});

Deno.test("a fit asked for during a drag runs once the drag ends", async () => {
  using page = await mounted((map) => {
    map.value = { markers: [{ position: PARIS_CENTER }] };
  });
  expect(drawsMarkerInside(page.map)).toBe(false);
  press(page.map);
  moveTo(page.map, 40);
  page.map.fitToBounds = true;
  await page.map.updateComplete;
  // Asked for mid-drag, the fit waits rather than moving the map under it.
  expect(drawsMarkerInside(page.map)).toBe(false);
  const pan = nextBoundsChange(page.map);
  release(page.map, 40);
  expect((await pan).userInitiated).toBe(true);
  expect(drawsMarkerInside(page.map)).toBe(true);
});

//
// The stored view and a fit to the features
//

Deno.test("a fit to the features wins over stored bounds there at mount", async () => {
  using page = await mounted((map) => {
    map.bounds = createMockCellHandle(PARIS);
    map.value = NEAR_DEFAULT;
    map.fitToBounds = true;
  });
  await nextFrame();
  await nextFrame();
  expect(drawsMarkerInside(page.map)).toBe(true);
});

Deno.test("stored bounds that load after mount do not undo a fit to the features", async () => {
  const bounds = createMockCellHandle<Bounds>();
  using page = await mounted((map) => {
    map.bounds = bounds;
    map.value = { markers: [{ position: PARIS_CENTER }] };
    map.fitToBounds = true;
  });
  expect(drawsMarkerInside(page.map)).toBe(true);
  const moved = nextBoundsChange(page.map);
  // The stored view, a box near San Francisco, loads late…
  pushUpdate(bounds, SF_BOX);
  // …and a later value, a consumer framing a box beside Paris, follows. A
  // frame apart, since values pushed together reach the map as the last.
  await nextFrame();
  pushUpdate(bounds, PARIS_EAST);
  // The first move is to the later value: the stored view moved nothing.
  const detail = await moved;
  expect(detail.center.lat).toBeCloseTo(48.86, 1);
  expect(detail.center.lng).toBeCloseTo(2.6, 1);
});

Deno.test("stored bounds apply when the map does not fit to its features", async () => {
  const bounds = createMockCellHandle<Bounds>();
  using page = await mounted((map) => {
    map.bounds = bounds;
  });
  const applied = nextBoundsChange(page.map);
  pushUpdate(bounds, PARIS);
  await applied;
  expect(await showsMarkerAt(page.map, PARIS_CENTER)).toBe(true);
});

//
// Moves already under way, and moves asked for while a person moves
//

Deno.test("a press during cf-map's own fit leaves that fit cf-map's", async () => {
  using page = await fittedTo(NEAR_DEFAULT);
  const fit = nextBoundsChange(page.map);
  page.map.value = NEAR_DEFAULT_NUDGED;
  await page.map.updateComplete;
  // The fit is animating; a press that moves nothing lands in the middle.
  press(page.map);
  release(page.map, 0);
  expect((await fit).userInitiated).toBe(false);
});

Deno.test("panTo during a drag does not move the map under it", async () => {
  using page = await mounted(() => {});
  press(page.map);
  moveTo(page.map, 40);
  page.map.panTo(PARIS_CENTER.lat, PARIS_CENTER.lng);
  const pan = nextBoundsChange(page.map);
  release(page.map, 40);
  const detail = await pan;
  expect(detail.userInitiated).toBe(true);
  expect(detail.center.lat).toBeCloseTo(37.77, 1);
});

Deno.test("turning fitToBounds off drops a fit still waiting for a size", async () => {
  const hidden = document.createElement("div");
  hidden.style.display = "none";
  document.body.append(hidden);
  try {
    const map = sizedMap((map) => {
      map.value = { markers: [{ position: PARIS_CENTER }] };
      map.fitToBounds = true;
    });
    hidden.append(map);
    await map.updateComplete;
    map.fitToBounds = false;
    await map.updateComplete;
    const shown = nextBoundsChange(map);
    hidden.style.display = "block";
    await shown;
    expect(drawsMarkerInside(map)).toBe(false);
  } finally {
    hidden.remove();
  }
});

Deno.test("fitBounds() asked for while hidden runs once the map is shown", async () => {
  const hidden = document.createElement("div");
  hidden.style.display = "none";
  document.body.append(hidden);
  try {
    const map = sizedMap((map) => {
      map.value = { markers: [{ position: PARIS_CENTER }] };
    });
    hidden.append(map);
    await map.updateComplete;
    map.fitBounds();
    map.fitToBounds = false;
    await map.updateComplete;
    const shown = nextBoundsChange(map);
    hidden.style.display = "block";
    await shown;
    expect(drawsMarkerInside(map)).toBe(true);
  } finally {
    hidden.remove();
  }
});
