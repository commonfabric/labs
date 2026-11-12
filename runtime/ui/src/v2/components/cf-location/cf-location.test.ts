// First, so that the document it installs is there when Lit loads.
import { mount } from "../../test-utils/dom.ts";

import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { CellHandle } from "@commonfabric/runtime-client";
import {
  createMockCellHandle,
  writesSent,
} from "../../test-utils/mock-cell-handle.ts";
import { defaultTheme } from "../theme-context.ts";
import { CFLocation, type LocationData } from "./index.ts";

/** One request a {@link FakeGeolocation} was asked for, still unanswered. */
interface GeolocationRequest {
  readonly success: PositionCallback;
  readonly error?: PositionErrorCallback | null;
  readonly options?: PositionOptions;
}

/**
 * A geolocation service that answers nothing until the test answers it, and
 * records what it was asked.
 */
class FakeGeolocation implements Geolocation {
  readonly requests: GeolocationRequest[] = [];
  readonly watches = new Map<number, GeolocationRequest>();
  readonly cleared: number[] = [];
  #nextWatchId = 7;

  getCurrentPosition(
    success: PositionCallback,
    error?: PositionErrorCallback | null,
    options?: PositionOptions,
  ): void {
    this.requests.push({ success, error, options });
  }

  watchPosition(
    success: PositionCallback,
    error?: PositionErrorCallback | null,
    options?: PositionOptions,
  ): number {
    const id = this.#nextWatchId++;
    this.watches.set(id, { success, error, options });
    return id;
  }

  clearWatch(id: number): void {
    this.cleared.push(id);
  }
}

/** A position fix at the given coordinates. */
function position(
  latitude: number,
  longitude: number,
  accuracy: number,
): GeolocationPosition {
  const coords = {
    latitude,
    longitude,
    accuracy,
    altitude: null,
    altitudeAccuracy: null,
    heading: 90,
    speed: null,
    toJSON: () => ({}),
  };
  return { coords, timestamp: 1700000000000, toJSON: () => ({}) };
}

/** A geolocation error with the given code. */
function positionError(code: number, message = ""): GeolocationPositionError {
  return {
    code,
    message,
    PERMISSION_DENIED: 1,
    POSITION_UNAVAILABLE: 2,
    TIMEOUT: 3,
  };
}

/**
 * A mounted element over `geolocation`, bound to `cell`, which holds no
 * location unless given one.
 */
async function locationElement(
  geolocation: Geolocation | null,
  properties: Partial<CFLocation> = {},
  cell: CellHandle<LocationData | null> = createMockCellHandle<
    LocationData | null
  >(null),
) {
  const element = Object.assign(new CFLocation(geolocation), {
    location: cell,
    ...properties,
  });
  return { element: await mount(element), cell };
}

/** The details of every `type` event `element` emits from now on. */
function eventsOf(element: CFLocation, type: string): unknown[] {
  const details: unknown[] = [];
  element.addEventListener(type, (event) => {
    if (event instanceof CustomEvent) details.push(event.detail);
  });
  return details;
}

const button = (element: CFLocation) =>
  element.shadowRoot!.querySelector("button")!;

/** The text of the element's part matching `selector`, if it shows one. */
const text = (element: CFLocation, selector: string) =>
  element.shadowRoot!.querySelector(selector)?.textContent?.trim();

/** Clicks the element's button and waits for what it shows to update. */
async function click(element: CFLocation): Promise<void> {
  button(element).click();
  await element.updateComplete;
}

describe("CFLocation", () => {
  afterEach(() => document.body.replaceChildren());

  it("is registered as `cf-location`", () => {
    expect(customElements.get("cf-location")).toBe(CFLocation);
  });

  it("shows a button to get the location and nothing else at first", async () => {
    const { element } = await locationElement(new FakeGeolocation());

    expect(button(element).textContent).toContain("Get Location");
    expect(text(element, ".icon")).toBe("\u{1F4CD}");
    expect(button(element).getAttribute("aria-label")).toBe("Get Location");
    expect(text(element, ".location-display")).toBeUndefined();
    expect(text(element, ".error")).toBeUndefined();
  });

  describe("without geolocation", () => {
    it("shows and emits that geolocation is not supported when asked for a location", async () => {
      const { element, cell } = await locationElement(null);
      const errors = eventsOf(element, "cf-location-error");

      await click(element);

      expect(await element.requestLocation()).toBeNull();
      expect(text(element, ".error")).toBe(
        "Geolocation is not supported by this browser",
      );
      expect(errors).toEqual([
        expect.objectContaining({
          message: "Geolocation is not supported by this browser",
        }),
        expect.objectContaining({
          message: "Geolocation is not supported by this browser",
        }),
      ]);
      expect(writesSent(cell)).toEqual([]);
    });

    it("says geolocation is unsupported by default where the page has none", async () => {
      expect(navigator.geolocation ?? null).toBeNull();
      const element = await mount(new CFLocation());

      expect(await element.requestLocation()).toBeNull();
      await element.updateComplete;

      expect(text(element, ".error")).toBe(
        "Geolocation is not supported by this browser",
      );
    });

    it("shows that geolocation is not supported when asked to watch", async () => {
      const { element } = await locationElement(null, {
        continuous: true,
      });

      await click(element);

      expect(text(element, ".error")).toBe(
        "Geolocation is not supported by this browser",
      );
      expect(button(element).textContent).toContain("Start Tracking");
    });
  });

  describe("one-shot requests", () => {
    it("asks the page's geolocation by default", async () => {
      const geolocation = new FakeGeolocation();
      Object.defineProperty(navigator, "geolocation", {
        configurable: true,
        value: geolocation,
      });
      try {
        const element = await mount(new CFLocation());

        void element.requestLocation();

        expect(geolocation.requests.length).toBe(1);
      } finally {
        Reflect.deleteProperty(navigator, "geolocation");
      }
      expect(navigator.geolocation ?? null).toBeNull();
    });

    it("asks for one position with the configured options and shows that it is waiting", async () => {
      const geolocation = new FakeGeolocation();
      const { element } = await locationElement(geolocation, {
        enableHighAccuracy: true,
        timeout: 5000,
        maximumAge: 30000,
      });
      const starts = eventsOf(element, "cf-location-start");

      await click(element);

      expect(geolocation.requests.map((request) => request.options)).toEqual([
        { enableHighAccuracy: true, timeout: 5000, maximumAge: 30000 },
      ]);
      expect(starts).toEqual([{ timestamp: expect.any(Number) }]);
      expect(button(element).textContent).toContain("Getting...");
      expect(button(element).querySelector(".spinner")).not.toBeNull();
      expect(button(element).classList.contains("requesting")).toBe(true);
      expect(button(element).disabled).toBe(true);
    });

    it("writes, emits and shows the position it receives", async () => {
      const geolocation = new FakeGeolocation();
      const { element, cell } = await locationElement(geolocation);
      const updates = eventsOf(element, "cf-location-update");
      const changes = eventsOf(element, "cf-change");

      const answer = element.requestLocation();
      geolocation.requests[0].success(position(37.7749, -122.4194, 5.4));
      await element.updateComplete;

      const expected = {
        id: expect.any(String),
        latitude: 37.7749,
        longitude: -122.4194,
        accuracy: 5.4,
        altitude: undefined,
        altitudeAccuracy: undefined,
        heading: 90,
        speed: undefined,
        timestamp: 1700000000000,
      };
      expect(await answer).toEqual(expected);
      expect(writesSent(cell)).toEqual([
        expect.objectContaining({ type: "cell:set", value: expected }),
      ]);
      expect(updates).toEqual([{ location: expected }]);
      expect(changes.at(-1)).toEqual({ location: expected });
      expect(text(element, ".coords")).toBe("37.774900, -122.419400");
      expect(text(element, ".accuracy")).toBe("±5m");
      expect(button(element).textContent).toContain("Update Location");
      expect(button(element).classList.contains("requesting")).toBe(false);
      expect(button(element).disabled).toBe(false);
    });

    it("shows a coarse accuracy in kilometers", async () => {
      const geolocation = new FakeGeolocation();
      const { element } = await locationElement(geolocation);

      element.requestLocation();
      geolocation.requests[0].success(position(1, 2, 1500));
      await element.updateComplete;

      expect(text(element, ".accuracy")).toBe("±1.5km");
    });

    it("asks only once while a request is waiting", async () => {
      const geolocation = new FakeGeolocation();
      const { element } = await locationElement(geolocation);

      element.requestLocation();
      const second = element.requestLocation();

      expect(await second).toBeNull();
      expect(geolocation.requests.length).toBe(1);
    });

    for (
      const [code, message] of [
        [1, "Location permission denied"],
        [2, "Location unavailable"],
        [3, "Location request timed out"],
        [9, "Location error: something odd"],
      ] as const
    ) {
      it(`shows and emits "${message}" for error code ${code}`, async () => {
        const geolocation = new FakeGeolocation();
        const { element, cell } = await locationElement(geolocation);
        const errors = eventsOf(element, "cf-location-error");

        const answer = element.requestLocation();
        const error = positionError(code, "something odd");
        geolocation.requests[0].error?.(error);
        await element.updateComplete;

        expect(await answer).toBeNull();
        expect(errors).toEqual([{ error, message }]);
        expect(text(element, ".error")).toBe(message);
        expect(button(element).textContent).toContain("Get Location");
        expect(writesSent(cell)).toEqual([]);
      });
    }

    it("clears the error when asked again", async () => {
      const geolocation = new FakeGeolocation();
      const { element } = await locationElement(geolocation);
      element.requestLocation();
      geolocation.requests[0].error?.(positionError(1));
      await element.updateComplete;
      expect(text(element, ".error")).toBe("Location permission denied");

      await click(element);

      expect(text(element, ".error")).toBeUndefined();
    });

    it("settles with `null` and changes nothing when answered after disconnecting", async () => {
      const geolocation = new FakeGeolocation();
      const { element, cell } = await locationElement(geolocation);
      const updates = eventsOf(element, "cf-location-update");
      const errors = eventsOf(element, "cf-location-error");

      const succeeding = element.requestLocation();
      element.remove();
      geolocation.requests[0].success(position(1, 2, 3));
      document.body.append(element);
      const failing = element.requestLocation();
      element.remove();
      geolocation.requests[1].error?.(positionError(1));

      expect(await succeeding).toBeNull();
      expect(await failing).toBeNull();
      expect(updates).toEqual([]);
      expect(errors).toEqual([]);
      expect(writesSent(cell)).toEqual([]);
    });

    it("applies the answer to a request the element was moved during", async () => {
      const geolocation = new FakeGeolocation();
      const { element, cell } = await locationElement(geolocation);

      const asked = element.requestLocation();
      element.remove();
      document.body.append(element);
      await element.updateComplete;
      expect(text(element, "button")).toContain("Getting...");
      geolocation.requests[0].success(position(1, 2, 3));

      expect((await asked)?.latitude).toBe(1);
      expect(writesSent(cell)).toEqual([
        expect.objectContaining({
          value: expect.objectContaining({ latitude: 1, longitude: 2 }),
        }),
      ]);
    });

    it("ignores a request's answer once watching has started, and keeps the watch", async () => {
      const geolocation = new FakeGeolocation();
      const { element, cell } = await locationElement(geolocation);

      const asked = element.requestLocation();
      element.startWatching();
      geolocation.requests[0].success(position(1, 2, 3));
      expect(await asked).toBeNull();
      geolocation.watches.get(7)!.success(position(4, 5, 6));
      await element.updateComplete;

      expect(writesSent(cell)).toEqual([
        expect.objectContaining({
          value: expect.objectContaining({ latitude: 4, longitude: 5 }),
        }),
      ]);
      expect(text(element, "button")).toContain("Stop Tracking");
    });

    it("takes only the newest request's answer when an earlier one, given up by watching, answers late", async () => {
      const geolocation = new FakeGeolocation();
      const { element, cell } = await locationElement(geolocation);

      const earlier = element.requestLocation();
      element.startWatching();
      element.stopWatching();
      const newer = element.requestLocation();
      geolocation.requests[0].success(position(1, 2, 3));
      await element.updateComplete;
      expect(text(element, "button")).toContain("Getting...");
      geolocation.requests[1].success(position(4, 5, 6));

      expect(await earlier).toBeNull();
      expect((await newer)?.latitude).toBe(4);
      expect(writesSent(cell)).toEqual([
        expect.objectContaining({
          value: expect.objectContaining({ latitude: 4, longitude: 5 }),
        }),
      ]);
    });

    it("does nothing on a click while disabled", async () => {
      const geolocation = new FakeGeolocation();
      const { element } = await locationElement(geolocation, {
        disabled: true,
      });

      expect(button(element).disabled).toBe(true);
      button(element).dispatchEvent(new MouseEvent("click"));

      expect(geolocation.requests).toEqual([]);
    });

    it("does nothing on a click that arrives after it is disabled, before the button shows it", async () => {
      const geolocation = new FakeGeolocation();
      const { element } = await locationElement(geolocation);

      element.disabled = true;
      expect(button(element).disabled).toBe(false);
      button(element).click();

      expect(geolocation.requests).toEqual([]);
    });
  });

  describe("continuous tracking", () => {
    it("starts watching on a click and writes and shows each position it receives", async () => {
      const geolocation = new FakeGeolocation();
      const { element, cell } = await locationElement(geolocation, {
        continuous: true,
      });
      const updates = eventsOf(element, "cf-location-update");
      expect(button(element).textContent).toContain("Start Tracking");

      await click(element);
      const watch = geolocation.watches.get(7)!;
      watch.success(position(1, 2, 3));
      watch.success(position(4, 5, 6));
      await element.updateComplete;

      expect(watch.options).toEqual({
        enableHighAccuracy: false,
        timeout: 10000,
        maximumAge: 0,
      });
      // The second write waits its turn behind the first, which the mock
      // answers later; what shows is already the second.
      expect(writesSent(cell)).toEqual([
        expect.objectContaining({
          value: expect.objectContaining({ latitude: 1, longitude: 2 }),
        }),
      ]);
      expect(text(element, ".coords")).toBe("4.000000, 5.000000");
      expect(updates).toEqual([
        { location: expect.objectContaining({ latitude: 1, longitude: 2 }) },
        { location: expect.objectContaining({ latitude: 4, longitude: 5 }) },
      ]);
      expect(button(element).textContent).toContain("Stop Tracking");
      expect(text(element, ".icon")).toBe("\u{23F9}");
      expect(button(element).classList.contains("watching")).toBe(true);
    });

    it("starts only one watch however often it is asked", async () => {
      const geolocation = new FakeGeolocation();
      const { element } = await locationElement(geolocation);

      element.startWatching();
      element.startWatching();

      expect([...geolocation.watches.keys()]).toEqual([7]);
    });

    it("stops watching on a click after `continuous` is turned off", async () => {
      const geolocation = new FakeGeolocation();
      const { element } = await locationElement(geolocation, {
        continuous: true,
      });
      await click(element);
      element.continuous = false;
      await element.updateComplete;
      expect(text(element, "button")).toContain("Stop Tracking");

      await click(element);

      expect(geolocation.cleared).toEqual([7]);
      expect(geolocation.requests).toEqual([]);
      expect(text(element, "button")).toContain("Get Location");
    });

    it("stops watching on a second click and ignores later positions", async () => {
      const geolocation = new FakeGeolocation();
      const { element, cell } = await locationElement(geolocation, {
        continuous: true,
      });

      await click(element);
      await click(element);
      geolocation.watches.get(7)!.success(position(1, 2, 3));

      expect(geolocation.cleared).toEqual([7]);
      expect(writesSent(cell)).toEqual([]);
      expect(button(element).textContent).toContain("Start Tracking");
    });

    it("stops watching and shows the error a watch reports", async () => {
      const geolocation = new FakeGeolocation();
      const { element } = await locationElement(geolocation);
      const errors = eventsOf(element, "cf-location-error");

      element.startWatching();
      geolocation.watches.get(7)!.error?.(positionError(3));
      geolocation.watches.get(7)!.error?.(positionError(1));
      await element.updateComplete;

      expect(geolocation.cleared).toEqual([7]);
      expect(errors).toEqual([
        expect.objectContaining({ message: "Location request timed out" }),
      ]);
      expect(text(element, ".error")).toBe("Location request timed out");
    });

    it("asks for no one-shot position while watching, and keeps writing what the watch reports", async () => {
      const geolocation = new FakeGeolocation();
      const { element, cell } = await locationElement(geolocation, {
        continuous: true,
      });
      await click(element);

      expect(await element.requestLocation()).toBeNull();
      expect(geolocation.requests).toEqual([]);
      geolocation.watches.get(7)!.success(position(1, 2, 3));

      expect(writesSent(cell)).toEqual([
        expect.objectContaining({
          value: expect.objectContaining({ latitude: 1, longitude: 2 }),
        }),
      ]);
    });

    it("stops watching when disconnected", async () => {
      const geolocation = new FakeGeolocation();
      const { element } = await locationElement(geolocation);
      element.startWatching();

      element.remove();

      expect(geolocation.cleared).toEqual([7]);
    });

    it("clears no watch when it has none", async () => {
      const geolocation = new FakeGeolocation();
      const { element } = await locationElement(geolocation);

      element.stopWatching();

      expect(geolocation.cleared).toEqual([]);
    });
  });

  describe("binding", () => {
    const FIX: LocationData = {
      id: "fix",
      latitude: 51.5,
      longitude: -0.12,
      accuracy: 40,
      timestamp: 0,
    };

    it("shows the location the bound cell holds", async () => {
      const { element } = await locationElement(
        new FakeGeolocation(),
        {},
        createMockCellHandle<LocationData | null>(FIX),
      );

      expect(text(element, ".coords")).toBe("51.500000, -0.120000");
      expect(button(element).textContent).toContain("Update Location");
    });

    it("shows the location of a cell bound in place of the first", async () => {
      const { element } = await locationElement(new FakeGeolocation());

      element.location = createMockCellHandle<LocationData | null>(FIX, {
        id: "of:another-cell",
      });
      await element.updateComplete;

      expect(text(element, ".coords")).toBe("51.500000, -0.120000");
    });
  });

  describe("theme", () => {
    it("writes a theme it is given onto its own style", async () => {
      const { element } = await locationElement(new FakeGeolocation());
      expect(element.style.getPropertyValue("--cf-theme-font-family")).toBe(
        "",
      );

      element.theme = { ...defaultTheme, fontFamily: "Test Serif" };
      await element.updateComplete;

      expect(element.style.getPropertyValue("--cf-theme-font-family")).toBe(
        "Test Serif",
      );
    });
  });
});
