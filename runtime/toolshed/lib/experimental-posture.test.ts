/**
 * What `/api/meta` reports, and therefore what every client not built
 * alongside this server adopts: the base a constructed Runtime publishes,
 * and the flags a serving runtime forces over it.
 */

import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  experimentalPosture,
  publishExperimentalPosture,
  publishServingExperimentalOverrides,
} from "./experimental-posture.ts";

describe("experimental-posture", () => {
  it("reports nothing before a Runtime has published one", () => {
    publishExperimentalPosture(null);
    expect(experimentalPosture()).toBe(null);
  });

  it("reports the boolean flags a Runtime resolved", () => {
    publishExperimentalPosture({
      modernCellRep: false,
      serverExecution: true,
    });
    expect(experimentalPosture()).toEqual({
      modernCellRep: false,
      serverExecution: true,
    });
  });

  it("omits a flag the Runtime left unresolved", () => {
    // A client reads an absent flag as "this server said nothing" and keeps
    // its own default. Publishing `false` for it would instead turn every
    // default-on flag off across the fleet.
    publishExperimentalPosture({
      modernCellRep: true,
      serverExecution: undefined,
    });
    expect(experimentalPosture()).toEqual({ modernCellRep: true });
  });

  it("replaces the previous posture rather than merging into it", () => {
    publishExperimentalPosture({ modernCellRep: true });
    publishExperimentalPosture({ serverExecution: true });
    expect(experimentalPosture()).toEqual({ serverExecution: true });
    publishExperimentalPosture(null);
  });

  describe("serving overrides", () => {
    afterEach(() => {
      publishExperimentalPosture(null);
      publishServingExperimentalOverrides(null);
    });

    it("wins over the base for the flags a serving runtime forces", () => {
      publishExperimentalPosture({
        modernCellRep: true,
        serverExecution: false,
      });
      publishServingExperimentalOverrides({ serverExecution: true });
      expect(experimentalPosture()).toEqual({
        modernCellRep: true,
        serverExecution: true,
      });
    });

    it("keeps the merged document in flag order", () => {
      // An override for a flag the base left unresolved would otherwise land
      // at the end, and a diff of the meta document would read as a changed
      // posture when only the iteration order moved.
      publishExperimentalPosture({ serverExecution: false });
      publishServingExperimentalOverrides({ modernCellRep: true });
      expect(Object.keys(experimentalPosture() ?? {})).toEqual([
        "modernCellRep",
        "serverExecution",
      ]);
    });

    it("reports nothing while no Runtime has published a base", () => {
      // Overrides alone are not a posture: without the base they would say
      // `false` about every flag the serving loop does not force.
      publishServingExperimentalOverrides({ serverExecution: true });
      expect(experimentalPosture()).toBe(null);
    });

    it("stops applying once cleared", () => {
      publishExperimentalPosture({ serverExecution: false });
      publishServingExperimentalOverrides({ serverExecution: true });
      publishServingExperimentalOverrides(null);
      expect(experimentalPosture()).toEqual({ serverExecution: false });
    });
  });
});
