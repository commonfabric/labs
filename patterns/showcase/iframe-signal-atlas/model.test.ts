import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import {
  DEFAULT_STATE,
  type SignalObservation,
  type SignalRoute,
} from "./contract.ts";
import {
  canClearSubmittedDraft,
  capturedAction,
  clampTimeCursor,
  FIELD_HEIGHT,
  FIELD_WIDTH,
  propagationValues,
  recentRouteSelection,
  recentVisibleObservations,
  reconcileTimeCursor,
  reconcileTimeCursorUntilInputStable,
  routePoints,
  visibleObservations,
  visibleRoutes,
} from "./model.ts";

const observations: SignalObservation[] = [
  {
    id: "early-pulse",
    label: "Early pulse",
    x: 0,
    y: 0,
    observedAt: 10,
    strength: 0.8,
    band: "pulse",
  },
  {
    id: "boundary-drift",
    label: "Boundary drift",
    x: 10,
    y: 0,
    observedAt: 20,
    strength: 0.6,
    band: "drift",
  },
  {
    id: "future-pulse",
    label: "Future pulse",
    x: 20,
    y: 0,
    observedAt: 21,
    strength: 0.7,
    band: "pulse",
  },
];

describe("model", () => {
  describe("clampTimeCursor()", () => {
    it("keeps a live time cursor within a changed input window", () => {
      expect(clampTimeCursor(80, 0, 40)).toBe(40);
      expect(clampTimeCursor(-5, 10, 40)).toBe(10);
      expect(clampTimeCursor(25, 10, 40)).toBe(25);
      expect(clampTimeCursor(25, 40, 10)).toBe(25);
    });
  });

  describe("capturedAction()", () => {
    it("keeps every event-time draft value when a queued action runs later", async () => {
      let controlValue = { label: "Alpha", band: "pulse", time: 14 };
      const received: Array<typeof controlValue> = [];
      const action = capturedAction({ ...controlValue }, (value) => {
        received.push(value);
        return Promise.resolve();
      });

      controlValue = { label: "Beta", band: "echo", time: 29 };
      await action();

      expect(controlValue.label).toBe("Beta");
      expect(received).toEqual([{ label: "Alpha", band: "pulse", time: 14 }]);
    });

    it("combines event-time controls with shared state read at execution", async () => {
      let shared = observations.slice(0, 1);
      const action = capturedAction(
        { timeCursor: 21, band: "pulse" as const },
        ({ timeCursor, band }) =>
          Promise.resolve(
            recentVisibleObservations(shared, timeCursor, band).map(({ id }) =>
              id
            ),
          ),
      );

      shared = observations;

      expect(await action()).toEqual(["early-pulse", "future-pulse"]);
    });
  });

  describe("canClearSubmittedDraft()", () => {
    it("preserves a later equal-valued edit while an earlier write is pending", () => {
      let value = "Alpha";
      let generation = 4;
      const submitted = { value, generation };
      value = "Beta";
      generation++;
      value = "Alpha";
      generation++;

      expect(value).toBe(submitted.value);
      expect(
        canClearSubmittedDraft(submitted.generation, generation),
      ).toBe(false);
      expect(canClearSubmittedDraft(submitted.generation, submitted.generation))
        .toBe(true);
    });

    it("preserves a form when a different field changes while saving", () => {
      let formGeneration = 8;
      const submittedGeneration = formGeneration;

      formGeneration++;

      expect(canClearSubmittedDraft(submittedGeneration, formGeneration))
        .toBe(false);
    });

    it("lets an automatic window clamp clear the submitted cursor draft", () => {
      const submittedGeneration = 5;
      let currentGeneration = submittedGeneration;
      let draft = 80;

      draft = clampTimeCursor(draft, 0, 40);

      expect(draft).toBe(40);
      expect(canClearSubmittedDraft(submittedGeneration, currentGeneration))
        .toBe(true);
      currentGeneration++;
      expect(canClearSubmittedDraft(submittedGeneration, currentGeneration))
        .toBe(false);
    });
  });

  describe("reconcileTimeCursor()", () => {
    it("keeps an earlier queued user write that fits the new window", async () => {
      let stored = 72;
      const userWrite = Promise.resolve().then(() => {
        stored = 30;
      });

      await userWrite;
      await reconcileTimeCursor(
        () => Promise.resolve(stored),
        (value) => {
          stored = value;
          return Promise.resolve();
        },
        0,
        40,
      );

      expect(stored).toBe(30);
    });

    it("clamps the latest queued user write only when it exceeds the window", async () => {
      let stored = 72;
      await reconcileTimeCursor(
        () => Promise.resolve(stored),
        (value) => {
          stored = value;
          return Promise.resolve();
        },
        0,
        40,
      );

      expect(stored).toBe(40);
    });
  });

  describe("reconcileTimeCursorUntilInputStable()", () => {
    it("reconciles an input window that changes during hydration", async () => {
      let generation = 0;
      let timeEnd = 100;
      let stored = 80;
      let reads = 0;
      const firstReadStarted = Promise.withResolvers<void>();
      const releaseFirstRead = Promise.withResolvers<void>();

      const reconciliation = reconcileTimeCursorUntilInputStable(
        () => generation,
        async () => {
          reads++;
          if (reads === 1) {
            firstReadStarted.resolve();
            await releaseFirstRead.promise;
          }
          return stored;
        },
        (value) => {
          stored = value;
          return Promise.resolve();
        },
        () => ({ timeStart: 0, timeEnd }),
      );

      await firstReadStarted.promise;
      timeEnd = 40;
      generation++;
      releaseFirstRead.resolve();

      expect(await reconciliation).toBe(40);
      expect(stored).toBe(40);
      expect(reads).toBe(2);
    });
  });

  describe("visibleObservations()", () => {
    it("includes the temporal boundary and applies the selected band", () => {
      expect(visibleObservations(observations, 20, "all").map(({ id }) => id))
        .toEqual(["early-pulse", "boundary-drift"]);
      expect(visibleObservations(observations, 20, "pulse").map(({ id }) => id))
        .toEqual(["early-pulse"]);
    });
  });

  describe("recentRouteSelection()", () => {
    it("uses a changed input window for endpoints and route departure", () => {
      const selection = recentRouteSelection(
        observations,
        80,
        "all",
        0,
        20,
      );

      expect(selection.timeCursor).toBe(20);
      expect(selection.observations.map(({ id }) => id)).toEqual([
        "early-pulse",
        "boundary-drift",
      ]);
    });
  });

  describe("visibleRoutes()", () => {
    it("requires a departed route, the selected band, and both visible endpoints", () => {
      const routes: SignalRoute[] = [
        {
          id: "visible",
          fromObservationId: "early-pulse",
          toObservationId: "boundary-drift",
          departedAt: 20,
          duration: 10,
          band: "pulse",
        },
        {
          id: "future",
          fromObservationId: "early-pulse",
          toObservationId: "boundary-drift",
          departedAt: 21,
          duration: 10,
          band: "pulse",
        },
        {
          id: "hidden-endpoint",
          fromObservationId: "early-pulse",
          toObservationId: "future-pulse",
          departedAt: 15,
          duration: 10,
          band: "pulse",
        },
        {
          id: "wrong-band",
          fromObservationId: "early-pulse",
          toObservationId: "boundary-drift",
          departedAt: 15,
          duration: 10,
          band: "drift",
        },
      ];
      expect(
        visibleRoutes(routes, observations, 20, "pulse").map(({ id }) => id),
      ).toEqual(["visible"]);
    });

    it("filters routes by their band without hiding differently banded endpoints", () => {
      const routes: SignalRoute[] = [{
        id: "cross-band-endpoints",
        fromObservationId: "early-pulse",
        toObservationId: "boundary-drift",
        departedAt: 20,
        duration: 10,
        band: "pulse",
      }];
      expect(
        visibleRoutes(routes, observations, 20, "pulse").map(({ id }) => id),
      ).toEqual(["cross-band-endpoints"]);
    });
  });

  describe("recentVisibleObservations()", () => {
    it("selects recent observations within the active time and band", () => {
      expect(
        recentVisibleObservations(observations, 21, "pulse").map(({ id }) =>
          id
        ),
      ).toEqual(["early-pulse", "future-pulse"]);
      expect(
        recentVisibleObservations(observations, 20, "pulse").map(({ id }) =>
          id
        ),
      ).toEqual(["early-pulse"]);
    });
  });

  describe("DEFAULT_STATE", () => {
    it("keeps every initial observation inside the rendered field", () => {
      expect(
        DEFAULT_STATE.observations.every((observation) =>
          observation.x >= 0 && observation.x <= FIELD_WIDTH &&
          observation.y >= 0 && observation.y <= FIELD_HEIGHT
        ),
      ).toBe(true);
    });
  });

  describe("propagationValues()", () => {
    it("decays signal strength across time and distance", () => {
      const signal: SignalObservation = {
        ...observations[0],
        strength: 1,
        observedAt: 0,
      };

      expect(propagationValues([signal], 0, 2, 1)[0]).toBe(1);
      expect(propagationValues([signal], 42, 1, 1)[0]).toBeCloseTo(
        Math.exp(-1),
      );
      expect(propagationValues([signal], 0, 2, 1)[1]).toBeCloseTo(
        Math.exp(-1 / 185),
      );
    });

    it("clamps overlapping signals to the field maximum", () => {
      expect(propagationValues([observations[0], observations[0]], 10, 1, 1))
        .toEqual([1]);
    });
  });

  describe("routePoints()", () => {
    it("bows a route perpendicular to its span", () => {
      expect(routePoints([0, 0], [100, 0])).toEqual([
        [0, 0],
        [50, 25],
        [100, 0],
      ]);
    });

    it("caps the bend of a long route", () => {
      expect(routePoints([0, 0], [400, 0])[1]).toEqual([200, 72]);
    });
  });
});
