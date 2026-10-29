import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import {
  DEFAULT_STATE,
  moduleConnectors,
  type StationModule,
} from "./contract.ts";
import {
  findBestSnap,
  findConnections,
  normalizeQuarterTurns,
  rotateVectorY,
  worldConnectors,
} from "./geometry.ts";

function moduleAt(
  id: string,
  position: [number, number, number],
  rotationQuarterTurns = 0,
): StationModule {
  return {
    id,
    label: id,
    kind: "cargo",
    color: [0.4, 0.5, 0.6],
    transform: { position, rotationQuarterTurns },
    connectors: moduleConnectors("cargo"),
  };
}

describe("geometry", () => {
  describe("moduleConnectors()", () => {
    it("returns isolated clones from the connector definitions used by seeded modules", () => {
      const first = moduleConnectors("hub");
      const second = moduleConnectors("hub");
      const seeded = DEFAULT_STATE.modules.find((module) =>
        module.kind === "hub"
      )!;

      first[0].offset[0] = 99;

      expect(second).toEqual(seeded.connectors);
      expect(second[0].offset[0]).toBe(2.4);
    });
  });

  describe("normalizeQuarterTurns()", () => {
    it("returns a canonical rotation for positive and negative turns", () => {
      expect([
        normalizeQuarterTurns(5),
        normalizeQuarterTurns(-1),
        normalizeQuarterTurns(-6),
      ]).toEqual([1, 3, 2]);
    });
  });

  describe("rotateVectorY()", () => {
    it("rotates a vector around the vertical axis in exact quarter turns", () => {
      expect([
        rotateVectorY([2, 1, 3], 1),
        rotateVectorY([2, 1, 3], 2),
        rotateVectorY([2, 1, 3], 3),
      ]).toEqual([
        [3, 1, -2],
        [-2, 1, -3],
        [-3, 1, 2],
      ]);
    });
  });

  describe("worldConnectors()", () => {
    it("preserves stable connector identity while projecting its transform", () => {
      const module = moduleAt("stable-module", [10, 2, -4], 1);

      expect(worldConnectors(module)[0]).toEqual({
        id: "port-lock",
        label: "Port lock",
        offset: [-2.6, 0, 0],
        normal: [-1, 0, 0],
        moduleId: "stable-module",
        position: [10, 2, -1.4],
        worldNormal: [0, 0, 1],
      });
    });
  });

  describe("findConnections()", () => {
    it("returns one joint for coincident connectors with opposing normals", () => {
      const first = moduleAt("first", [0, 1, 0]);
      const second = moduleAt("second", [5.2, 1, 0]);

      expect(findConnections([first, second])).toEqual([{
        id: "first:starboard-lock--second:port-lock",
        first: worldConnectors(first)[1],
        second: worldConnectors(second)[0],
      }]);
    });

    it("returns no joint for aligned connectors that face the same direction", () => {
      const first = moduleAt("first", [0, 1, 0]);
      const second = moduleAt("second", [0, 1, 5.2], 1);

      expect(findConnections([first, second])).toEqual([]);
    });

    it("keeps joint identity stable when the module array is reordered", () => {
      const first = moduleAt("first", [0, 1, 0]);
      const second = moduleAt("second", [5.2, 1, 0]);

      expect(findConnections([second, first])).toEqual(
        findConnections([first, second]),
      );
    });

    it("recognizes the three locked interfaces in the initial assembly", () => {
      expect(findConnections(DEFAULT_STATE.modules).map(({ id }) => id))
        .toEqual([
          "module-cargo-kestrel:port-lock--module-junction-nine:east-lock",
          "module-habitat-morrow:aft-lock--module-junction-nine:north-lock",
          "module-junction-nine:west-lock--module-solar-rig-amber:truss-lock",
        ]);
    });
  });

  describe("findBestSnap()", () => {
    it("returns the nearest compatible transform without changing either ID", () => {
      const anchored = moduleAt("anchor", [0, 1, 0]);
      const moving = moduleAt("moving", [5.7, 1, 0]);

      expect(findBestSnap(moving, [anchored], 1)).toEqual({
        transform: { position: [5.2, 1, 0], rotationQuarterTurns: 0 },
        movingConnectorId: "port-lock",
        targetModuleId: "anchor",
        targetConnectorId: "starboard-lock",
        travelDistance: 0.5,
      });
    });

    it("returns `undefined` when every compatible transform is out of range", () => {
      const anchored = moduleAt("anchor", [0, 1, 0]);
      const moving = moduleAt("moving", [30, 1, 30]);

      expect(findBestSnap(moving, [anchored], 1)).toBeUndefined();
    });

    it("does not reuse an occupied connector in the initial assembly", () => {
      const moving = moduleAt("moving", [5.5, 1.2, 0]);
      const snap = findBestSnap(moving, DEFAULT_STATE.modules, 5);

      expect(snap?.targetModuleId).toBe("module-cargo-kestrel");
      expect(snap?.targetConnectorId).toBe("starboard-lock");
      expect(snap?.movingConnectorId).toBe("port-lock");
      expect(snap?.transform).toEqual({
        position: [10.2, 1.2, 0],
        rotationQuarterTurns: 0,
      });
      expect(snap?.travelDistance).toBeCloseTo(4.7);
    });
  });
});
