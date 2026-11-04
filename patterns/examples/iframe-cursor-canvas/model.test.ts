import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import type { CanvasShape } from "./contract.ts";
import {
  BOARD_HEIGHT,
  BOARD_WIDTH,
  clampToBoard,
  createShape,
  displayNameOf,
  dragPosition,
  hueOf,
  MIN_SHAPE_SIZE,
  readDrag,
  readHue,
  readPeer,
  readPoint,
  resizeBox,
  sameBox,
  shapeIndex,
  visitorName,
} from "./model.ts";

describe("model", () => {
  describe("clampToBoard()", () => {
    it("returns a point on the board unchanged", () => {
      expect(clampToBoard({ x: 12, y: 34 })).toEqual({ x: 12, y: 34 });
    });

    it("returns the nearest point on the board for one off it", () => {
      expect(clampToBoard({ x: -5, y: BOARD_HEIGHT + 80 })).toEqual({
        x: 0,
        y: BOARD_HEIGHT,
      });
    });

    it("keeps a box of the given size inside the board", () => {
      expect(
        clampToBoard({ x: BOARD_WIDTH, y: BOARD_HEIGHT }, {
          width: 200,
          height: 100,
        }),
      ).toEqual({ x: BOARD_WIDTH - 200, y: BOARD_HEIGHT - 100 });
    });
  });

  describe("readPoint()", () => {
    it("returns the point for an object with finite `x` and `y`", () => {
      expect(readPoint({ x: 3, y: 4, extra: true })).toEqual({ x: 3, y: 4 });
    });

    it("returns a point moved onto the board for one off it", () => {
      expect(readPoint({ x: 1e9, y: -1 })).toEqual({ x: BOARD_WIDTH, y: 0 });
    });

    it("returns `undefined` for anything that is not a finite point", () => {
      for (
        const value of [
          undefined,
          null,
          "3,4",
          [3, 4],
          { x: 3 },
          { x: "3", y: 4 },
          { x: Number.NaN, y: 4 },
          { x: 3, y: Number.POSITIVE_INFINITY },
        ]
      ) {
        expect(readPoint(value)).toBeUndefined();
      }
    });
  });

  describe("readHue()", () => {
    it("returns a hue in `[0, 360)` for any finite number", () => {
      expect(readHue(200)).toBe(200);
      expect(readHue(360)).toBe(0);
      expect(readHue(-30)).toBe(330);
      expect(readHue(725.4)).toBe(5);
    });

    it("returns `undefined` for anything that is not a finite number", () => {
      expect(readHue("200")).toBeUndefined();
      expect(readHue(Number.NaN)).toBeUndefined();
      expect(readHue(null)).toBeUndefined();
    });
  });

  describe("hueOf()", () => {
    it("returns the same hue in `[0, 360)` for the same seed", () => {
      const hue = hueOf("participant-a");
      expect(hue).toBe(hueOf("participant-a"));
      expect(hue).toBeGreaterThanOrEqual(0);
      expect(hue).toBeLessThan(360);
    });

    it("returns different hues for these two seeds", () => {
      expect(hueOf("participant-a")).not.toBe(hueOf("participant-b"));
    });
  });

  describe("readDrag()", () => {
    it("returns the shape id and the position it is held at, with no size when the facet carries none", () => {
      expect(readDrag({ id: "shape-1", position: { x: 40, y: 50 } }))
        .toStrictEqual({
          id: "shape-1",
          position: { x: 40, y: 50 },
          size: undefined,
        });
    });

    it("returns the size a shape is resized to, kept between the minimum and the board", () => {
      expect(
        readDrag({
          id: "shape-1",
          position: { x: 40, y: 50 },
          width: 3,
          height: BOARD_HEIGHT * 2,
        }),
      ).toStrictEqual({
        id: "shape-1",
        position: { x: 40, y: 0 },
        size: { width: MIN_SHAPE_SIZE, height: BOARD_HEIGHT },
      });
    });

    it("returns a position that keeps the resized box on the board", () => {
      expect(
        readDrag({
          id: "shape-1",
          position: { x: BOARD_WIDTH, y: BOARD_HEIGHT - 10 },
          width: 100,
          height: 60,
        }),
      ).toStrictEqual({
        id: "shape-1",
        position: { x: BOARD_WIDTH - 100, y: BOARD_HEIGHT - 60 },
        size: { width: 100, height: 60 },
      });
    });

    it("returns `undefined` for a size that is partly given or not a number", () => {
      const position = { x: 40, y: 50 };
      expect(readDrag({ id: "s", position, width: 100 })).toBeUndefined();
      expect(readDrag({ id: "s", position, width: "100", height: 80 }))
        .toBeUndefined();
      expect(readDrag({ id: "s", position, width: 100, height: Number.NaN }))
        .toBeUndefined();
    });

    it("returns `undefined` without a shape id or a readable position", () => {
      expect(readDrag({ position: { x: 40, y: 50 } })).toBeUndefined();
      expect(readDrag({ id: "", position: { x: 40, y: 50 } })).toBeUndefined();
      expect(readDrag({ id: "shape-1", position: "here" })).toBeUndefined();
      expect(readDrag("shape-1")).toBeUndefined();
    });
  });

  describe("readPeer()", () => {
    it("returns the peer's name, chosen hue, pointer, and drag", () => {
      expect(
        readPeer({
          participantId: "p1",
          name: "Ada",
          facets: {
            user: { hue: 120 },
            pointer: { x: 10, y: 20 },
            drag: {
              id: "shape-1",
              position: { x: 30, y: 40 },
              width: 90,
              height: 60,
            },
          },
        }),
      ).toEqual({
        participantId: "p1",
        name: "Ada",
        hue: 120,
        pointer: { x: 10, y: 20 },
        drag: {
          id: "shape-1",
          position: { x: 30, y: 40 },
          size: { width: 90, height: 60 },
        },
      });
    });

    it("returns a peer with no pointer or drag, and a hue derived from its id, for facets it cannot read", () => {
      expect(
        readPeer({
          participantId: "p1",
          name: "Ada",
          facets: { user: "blue", pointer: [1, 2], caret: { focused: true } },
        }),
      ).toEqual({
        participantId: "p1",
        name: "Ada",
        hue: hueOf("p1"),
        pointer: undefined,
        drag: undefined,
      });
    });
  });

  describe("visitorName()", () => {
    it("returns a three-digit visitor name for any seed", () => {
      expect(visitorName(0)).toBe("Visitor 100");
      expect(visitorName(899)).toBe("Visitor 999");
      expect(visitorName(900)).toBe("Visitor 100");
      expect(visitorName(-7.9)).toBe("Visitor 107");
    });
  });

  describe("displayNameOf()", () => {
    it("returns the draft trimmed and without control characters", () => {
      expect(displayNameOf("  Ada\u0007 Lovelace ", "Visitor 100")).toBe(
        "Ada Lovelace",
      );
    });

    it("returns the fallback when nothing printable is left", () => {
      expect(displayNameOf(" \u0000 ", "Visitor 100")).toBe("Visitor 100");
    });

    it("returns at most 80 code points", () => {
      expect([...displayNameOf("é".repeat(200), "Visitor 100")]).toHaveLength(
        80,
      );
    });
  });

  describe("dragPosition()", () => {
    it("returns the corner that keeps the grabbed spot under the pointer", () => {
      expect(
        dragPosition({ x: 300, y: 200 }, { x: 20, y: 30 }, {
          width: 100,
          height: 80,
        }),
      ).toEqual({ x: 280, y: 170 });
    });

    it("returns a corner that keeps the whole shape on the board", () => {
      expect(
        dragPosition({ x: BOARD_WIDTH + 50, y: -40 }, { x: 10, y: 10 }, {
          width: 100,
          height: 80,
        }),
      ).toEqual({ x: BOARD_WIDTH - 100, y: 0 });
    });
  });

  describe("resizeBox()", () => {
    const from = { position: { x: 100, y: 100 }, width: 200, height: 100 };

    it("returns the box with the dragged corner at the pointer and the opposite one in place", () => {
      expect(resizeBox(from, "se", { x: 350, y: 260 })).toEqual({
        position: { x: 100, y: 100 },
        width: 250,
        height: 160,
      });
      expect(resizeBox(from, "nw", { x: 60, y: 40 })).toEqual({
        position: { x: 60, y: 40 },
        width: 240,
        height: 160,
      });
      expect(resizeBox(from, "ne", { x: 320, y: 80 })).toEqual({
        position: { x: 100, y: 80 },
        width: 220,
        height: 120,
      });
      expect(resizeBox(from, "sw", { x: 150, y: 130 })).toEqual({
        position: { x: 150, y: 100 },
        width: 150,
        height: 30,
      });
    });

    it("returns a box no smaller than the minimum when the corner crosses the opposite one", () => {
      expect(resizeBox(from, "se", { x: 0, y: 0 })).toEqual({
        position: { x: 100, y: 100 },
        width: MIN_SHAPE_SIZE,
        height: MIN_SHAPE_SIZE,
      });
      expect(resizeBox(from, "nw", { x: 900, y: 900 })).toEqual({
        position: { x: 300 - MIN_SHAPE_SIZE, y: 200 - MIN_SHAPE_SIZE },
        width: MIN_SHAPE_SIZE,
        height: MIN_SHAPE_SIZE,
      });
    });

    it("returns a box that stays on the board", () => {
      expect(resizeBox(from, "se", { x: BOARD_WIDTH + 90, y: -50 })).toEqual({
        position: { x: 100, y: 100 },
        width: BOARD_WIDTH - 100,
        height: MIN_SHAPE_SIZE,
      });
      expect(resizeBox(from, "nw", { x: -40, y: -40 })).toEqual({
        position: { x: 0, y: 0 },
        width: 300,
        height: 200,
      });
    });
  });

  describe("sameBox()", () => {
    const box = { position: { x: 1, y: 2 }, width: 30, height: 40 };

    it("returns `true` for an equal box and `false` when any side differs", () => {
      expect(sameBox(box, { ...box, position: { x: 1, y: 2 } })).toBe(true);
      expect(sameBox(box, { ...box, width: 31 })).toBe(false);
      expect(sameBox(box, { ...box, position: { x: 1, y: 3 } })).toBe(false);
    });
  });

  describe("createShape()", () => {
    it("returns a shape of the kind, id, and hue given, not removed", () => {
      expect(createShape("ellipse", "shape-1", 40, 0)).toEqual({
        id: "shape-1",
        kind: "ellipse",
        box: { position: { x: 260, y: 140 }, width: 150, height: 150 },
        hue: 40,
        removed: false,
      });
    });

    it("returns a position a step further on for the next sequence number", () => {
      expect(createShape("rectangle", "a", 0, 1).box.position).toEqual({
        x: 288,
        y: 168,
      });
      expect(createShape("rectangle", "a", 0, 10).box.position).toEqual({
        x: 260,
        y: 140,
      });
    });
  });

  describe("shapeIndex()", () => {
    const shapes: CanvasShape[] = [
      createShape("rectangle", "a", 0, 0),
      createShape("ellipse", "b", 0, 1),
    ];

    it("returns the index of the shape with the id", () => {
      expect(shapeIndex(shapes, "b")).toBe(1);
    });

    it("returns `-1` for an id no shape has", () => {
      expect(shapeIndex(shapes, "c")).toBe(-1);
    });
  });
});
