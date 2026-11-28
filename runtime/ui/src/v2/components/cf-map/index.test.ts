/**
 * The `cf-map` element the package registers, which draws with the real
 * Leaflet. `cf-map.test.ts` covers cf-map's behavior against a fake Leaflet.
 */

// First, so that the document it installs is there when Lit loads.
import { mount } from "../../test-utils/dom.ts";

import { expect } from "@std/expect";
import { afterEach, describe, it } from "@commonfabric/test-support/test";
import { CFMap } from "./index.ts";
import type { MapValue } from "./types.ts";

/** The map container in `element`'s shadow root. */
function containerOf(element: CFMap): HTMLElement {
  return element.shadowRoot!.querySelector<HTMLElement>(".map-container")!;
}

describe("CFMap", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it("is the element the cf-map tag makes", () => {
    expect(customElements.get("cf-map")).toBe(CFMap);
    expect(document.createElement("cf-map")).toBeInstanceOf(CFMap);
  });

  it("draws OpenStreetMap tiles, the zoom control, and its markers with Leaflet", async () => {
    const element = document.createElement("cf-map");
    const value: MapValue = {
      markers: [{ position: { lat: 37.77, lng: -122.42 }, title: "Here" }],
    };
    element.value = value;
    await mount(element);

    const container = containerOf(element);
    expect(container.classList.contains("leaflet-container")).toBe(true);
    const tiles = [...container.querySelectorAll("img.leaflet-tile")];
    expect(tiles.length).toBeGreaterThan(0);
    for (const tile of tiles) {
      expect(tile.getAttribute("src")).toMatch(
        /^https:\/\/[abc]\.tile\.openstreetmap\.org\/\d+\/\d+\/\d+\.png$/,
      );
    }
    expect(container.querySelector(".leaflet-control-zoom-in")).not.toBe(null);
    expect(container.querySelector(".leaflet-control-attribution")?.textContent)
      .toContain("OpenStreetMap");
    expect(
      container.querySelectorAll(".leaflet-marker-pane .cf-map-default-marker"),
    ).toHaveLength(1);
  });

  it("draws no markers and no zoom control for a still map with none", async () => {
    const element = document.createElement("cf-map");
    element.interactive = false;
    await mount(element);

    const container = containerOf(element);
    expect(container.classList.contains("leaflet-container")).toBe(true);
    expect(container.querySelector(".leaflet-control-zoom-in")).toBe(null);
    expect(container.querySelector(".leaflet-marker-pane")?.children)
      .toHaveLength(0);
  });
});
