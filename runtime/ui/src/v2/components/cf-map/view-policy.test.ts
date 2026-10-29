/**
 * cf-map's view policy, held without a browser: which values are usable,
 * which points a fit frames, who owns a move, which of cf-map's own moves
 * wait and what cancels them, and when the stored view yields to a fit.
 * `cf-map.browser.test.ts` holds cf-map's wiring of it to Leaflet.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  clampZoom,
  DEFAULT_CENTER,
  DEFAULT_ZOOM,
  featurePoints,
  isEmoji,
  MoveOwnership,
  PendingMoves,
  StoredView,
  strongerFit,
  validateBounds,
  validateLatLng,
  WaitingForSize,
} from "./view-policy.ts";
import type { Bounds, MapValue } from "./types.ts";

const PARIS: Bounds = { north: 48.9, south: 48.82, east: 2.42, west: 2.27 };
const LYON: Bounds = { north: 45.8, south: 45.72, east: 4.9, west: 4.78 };

describe("view values", () => {
  it("keeps a zoom in range and clamps one outside it", () => {
    expect(clampZoom(12)).toBe(12);
    expect(clampZoom(-3)).toBe(0);
    expect(clampZoom(40)).toBe(18);
  });

  it("takes the default zoom for a zoom that is not a number", () => {
    expect(clampZoom(Number.NaN)).toBe(DEFAULT_ZOOM);
    expect(clampZoom(Number.POSITIVE_INFINITY)).toBe(DEFAULT_ZOOM);
  });

  it("clamps a center into range, coordinate by coordinate", () => {
    expect(validateLatLng({ lat: 48.86, lng: 2.35 })).toEqual({
      lat: 48.86,
      lng: 2.35,
    });
    expect(validateLatLng({ lat: 95, lng: -200 })).toEqual({
      lat: 90,
      lng: -180,
    });
    expect(validateLatLng({ lat: -95, lng: 200 })).toEqual({
      lat: -90,
      lng: 180,
    });
  });

  it("takes the default center's coordinate for one that is not a number", () => {
    expect(validateLatLng({ lat: Number.NaN, lng: 2.35 })).toEqual({
      lat: DEFAULT_CENTER.lat,
      lng: 2.35,
    });
    expect(validateLatLng({ lat: 48.86, lng: Number.NaN })).toEqual({
      lat: 48.86,
      lng: DEFAULT_CENTER.lng,
    });
  });

  it("accepts bounds that are finite, in range, and south of north", () => {
    expect(validateBounds(PARIS)).toBe(PARIS);
  });

  it("refuses bounds with a coordinate that is not a number", () => {
    expect(validateBounds({ ...PARIS, north: Number.NaN })).toBeNull();
    expect(validateBounds({ ...PARIS, south: Number.NaN })).toBeNull();
    expect(validateBounds({ ...PARIS, east: Number.NaN })).toBeNull();
    expect(validateBounds({ ...PARIS, west: Number.NaN })).toBeNull();
  });

  it("refuses bounds out of range", () => {
    expect(validateBounds({ ...PARIS, north: 91 })).toBeNull();
    expect(validateBounds({ ...PARIS, south: -91 })).toBeNull();
    expect(validateBounds({ ...PARIS, east: 181 })).toBeNull();
    expect(validateBounds({ ...PARIS, west: -181 })).toBeNull();
  });

  it("refuses bounds whose south lies north of their north", () => {
    expect(validateBounds({ ...PARIS, north: 48.8, south: 48.9 })).toBeNull();
  });

  it("tells an emoji icon from text", () => {
    expect(isEmoji("📍")).toBe(true);
    expect(isEmoji("☕")).toBe(true);
    expect(isEmoji("A")).toBe(false);
  });
});

describe("featurePoints", () => {
  it("frames every marker, circle center, and polyline point", () => {
    const value: MapValue = {
      markers: [{ position: { lat: 1, lng: 2 } }],
      circles: [{ center: { lat: 3, lng: 4 }, radius: 10 }],
      polylines: [{ points: [{ lat: 5, lng: 6 }, { lat: 7, lng: 8 }] }],
    };
    expect(featurePoints(value)).toEqual([
      { lat: 1, lng: 2 },
      { lat: 3, lng: 4 },
      { lat: 5, lng: 6 },
      { lat: 7, lng: 8 },
    ]);
  });

  it("frames nothing for a map with no features", () => {
    expect(featurePoints({})).toEqual([]);
  });

  it("skips a feature with no usable position, and keeps the rest", () => {
    const value = {
      markers: [
        undefined,
        { position: undefined },
        { position: { lat: "1", lng: 2 } },
        { position: { lat: 1, lng: null } },
        { position: { lat: 1, lng: 2 } },
      ],
      circles: [{ center: undefined, radius: 1 }],
      polylines: [{ points: undefined }, { points: [undefined] }],
    };
    // Data as it arrives, before anything has checked its shape.
    const arrived: MapValue = JSON.parse(JSON.stringify(value));
    expect(featurePoints(arrived)).toEqual([
      { lat: 1, lng: 2 },
    ]);
  });

  it("skips a point whose coordinates are not finite", () => {
    const value: MapValue = {
      markers: [
        { position: { lat: Number.NaN, lng: 2 } },
        { position: { lat: 1, lng: Number.POSITIVE_INFINITY } },
        { position: { lat: 1, lng: 2 } },
      ],
    };
    expect(featurePoints(value)).toEqual([{ lat: 1, lng: 2 }]);
  });

  it("skips a feature that throws when read, as a loading proxy can", () => {
    const notLoaded = (): never => {
      throw new Error("not loaded");
    };
    const value: MapValue = {
      markers: [{
        get position() {
          return notLoaded();
        },
      }, { position: { lat: 1, lng: 2 } }],
      circles: [{
        get center() {
          return notLoaded();
        },
        radius: 1,
      }, { center: { lat: 3, lng: 4 }, radius: 1 }],
      polylines: [{
        get points() {
          return notLoaded();
        },
      }, {
        points: [{
          get lat() {
            return notLoaded();
          },
          lng: 0,
        }, { lat: 5, lng: 6 }],
      }],
    };
    expect(featurePoints(value)).toEqual([
      { lat: 1, lng: 2 },
      { lat: 3, lng: 4 },
      { lat: 5, lng: 6 },
    ]);
  });
});

describe("MoveOwnership", () => {
  it("makes a move that starts after a person's input theirs", () => {
    const moves = new MoveOwnership();
    moves.input();
    moves.moveStarted();
    expect(moves.personMoving).toBe(true);
    expect(moves.moveEnded()).toBe("person");
    expect(moves.personMoving).toBe(false);
  });

  it("leaves a move with no input before it cf-map's", () => {
    const moves = new MoveOwnership();
    moves.moveStarted();
    expect(moves.personMoving).toBe(false);
    expect(moves.moveEnded()).toBe("own");
  });

  it("leaves a move already under way cf-map's when input comes during it", () => {
    const moves = new MoveOwnership();
    moves.moveStarted();
    moves.input();
    expect(moves.moveEnded()).toBe("own");
  });

  it("lets cf-map's own move clear a person's earlier input", () => {
    const moves = new MoveOwnership();
    moves.input();
    moves.ownMove();
    moves.moveStarted();
    expect(moves.moveEnded()).toBe("own");
  });

  it("keeps a person's input past a move's end, for a wheel zoom's timer", () => {
    const moves = new MoveOwnership();
    moves.input();
    moves.moveStarted();
    moves.moveEnded();
    moves.moveStarted();
    expect(moves.moveEnded()).toBe("person");
  });

  it("makes a resize that changes the size cf-map's own move", () => {
    const moves = new MoveOwnership();
    moves.input();
    moves.resize(true, () => {});
    moves.moveStarted();
    expect(moves.moveEnded()).toBe("own");
  });

  it("leaves a person's input in place across a resize that changes nothing", () => {
    const moves = new MoveOwnership();
    moves.input();
    moves.resize(false, () => {});
    moves.moveStarted();
    expect(moves.moveEnded()).toBe("person");
  });

  it("keeps a person's move theirs through a resize during it", () => {
    const moves = new MoveOwnership();
    moves.input();
    moves.moveStarted();
    let endedDuringResize = "";
    moves.resize(true, () => {
      endedDuringResize = moves.moveEnded();
    });
    // The resize's own moveend ends nothing.
    expect(endedDuringResize).toBe("resize");
    expect(moves.personMoving).toBe(true);
    expect(moves.moveEnded()).toBe("person");
    // Nor did it clear their input: a wheel zoom's next step is theirs too.
    moves.moveStarted();
    expect(moves.moveEnded()).toBe("person");
  });

  it("stops treating moveends as a resize's once the resize is done, even if it threw", () => {
    const moves = new MoveOwnership();
    expect(() =>
      moves.resize(true, () => {
        throw new Error("resize failed");
      })
    ).toThrow("resize failed");
    expect(moves.moveEnded()).toBe("own");
  });
});

describe("fit sources", () => {
  it("keeps the stronger of two sources, in either order", () => {
    expect(strongerFit(null, "features")).toBe("features");
    expect(strongerFit("features", "property")).toBe("property");
    expect(strongerFit("property", "features")).toBe("property");
    expect(strongerFit("call", "property")).toBe("call");
    expect(strongerFit("property", "call")).toBe("call");
  });
});

describe("PendingMoves", () => {
  it("holds nothing to start until a move is queued", () => {
    expect(new PendingMoves().next()).toBeNull();
  });

  it("starts bounds first, and bounds stand in for center and zoom", () => {
    const pending = new PendingMoves();
    pending.center({ lat: 1, lng: 2 });
    pending.zoom(9);
    pending.bounds(PARIS);
    pending.fit("features");
    expect(pending.next()).toEqual({ kind: "bounds", bounds: PARIS });
    expect(pending.next()).toEqual({ kind: "fit", source: "features" });
    expect(pending.next()).toBeNull();
  });

  it("starts a center, then a zoom, then a fit, one at a time", () => {
    const pending = new PendingMoves();
    pending.fit("call");
    pending.zoom(9);
    pending.center({ lat: 1, lng: 2 });
    expect(pending.next()).toEqual({
      kind: "center",
      center: { lat: 1, lng: 2 },
    });
    expect(pending.next()).toEqual({ kind: "zoom", zoom: 9 });
    expect(pending.next()).toEqual({ kind: "fit", source: "call" });
    expect(pending.next()).toBeNull();
  });

  it("holds each kind's latest value", () => {
    const pending = new PendingMoves();
    pending.bounds(PARIS);
    pending.bounds(LYON);
    expect(pending.next()).toEqual({ kind: "bounds", bounds: LYON });
  });

  it("keeps the stronger source of a fit asked for twice", () => {
    const pending = new PendingMoves();
    pending.fit("property");
    pending.fit("features");
    expect(pending.next()).toEqual({ kind: "fit", source: "property" });
  });

  it("drops queued values and a features refit when a person's move ends", () => {
    const pending = new PendingMoves();
    pending.bounds(PARIS);
    pending.center({ lat: 1, lng: 2 });
    pending.zoom(9);
    pending.fit("features");
    pending.personMoved();
    expect(pending.next()).toBeNull();
  });

  it("keeps a fit asked for while a person moved", () => {
    for (const source of ["property", "call"] as const) {
      const pending = new PendingMoves();
      pending.fit(source);
      pending.personMoved();
      expect(pending.next()).toEqual({ kind: "fit", source });
    }
  });

  it("drops a waiting fit when fitToBounds turns off, unless fitBounds() asked", () => {
    for (const source of ["features", "property"] as const) {
      const pending = new PendingMoves();
      pending.fit(source);
      pending.fitToBoundsOff();
      expect(pending.next()).toBeNull();
    }
    const pending = new PendingMoves();
    pending.fit("call");
    pending.fitToBoundsOff();
    expect(pending.next()).toEqual({ kind: "fit", source: "call" });
  });

  it("forgets everything when cleared", () => {
    const pending = new PendingMoves();
    pending.bounds(PARIS);
    pending.center({ lat: 1, lng: 2 });
    pending.zoom(9);
    pending.fit("call");
    pending.clear();
    expect(pending.next()).toBeNull();
  });
});

describe("WaitingForSize", () => {
  it("waits for nothing until a move is asked for", () => {
    const waiting = new WaitingForSize();
    expect(waiting.waiting).toBe(false);
    expect(waiting.take()).toEqual({ bounds: null, fit: null });
  });

  it("hands over the bounds and the fit together, once", () => {
    const waiting = new WaitingForSize();
    waiting.bounds(PARIS);
    waiting.fit("features");
    expect(waiting.waiting).toBe(true);
    expect(waiting.take()).toEqual({ bounds: PARIS, fit: "features" });
    expect(waiting.waiting).toBe(false);
    expect(waiting.take()).toEqual({ bounds: null, fit: null });
  });

  it("keeps the stronger source of a fit asked for twice", () => {
    const waiting = new WaitingForSize();
    waiting.fit("call");
    waiting.fit("property");
    expect(waiting.take().fit).toBe("call");
  });

  it("lets a newer center or zoom replace waiting bounds, but not a fit", () => {
    const waiting = new WaitingForSize();
    waiting.bounds(PARIS);
    waiting.fit("features");
    waiting.viewReplaced();
    expect(waiting.take()).toEqual({ bounds: null, fit: "features" });
  });

  it("drops a waiting fit when fitToBounds turns off, unless fitBounds() asked", () => {
    const off = new WaitingForSize();
    off.fit("property");
    off.fitToBoundsOff();
    expect(off.waiting).toBe(false);
    const called = new WaitingForSize();
    called.fit("call");
    called.fitToBoundsOff();
    expect(called.take().fit).toBe("call");
  });
});

describe("StoredView", () => {
  it("lets the first bounds yield to a fit to the features", () => {
    const view = new StoredView();
    expect(view.admit(true)).toBe(false);
    // A later value applies even while fitting.
    expect(view.admit(true)).toBe(true);
  });

  it("applies the first bounds when the map does not fit", () => {
    const view = new StoredView();
    expect(view.admit(false)).toBe(true);
    expect(view.admit(true)).toBe(true);
  });
});
