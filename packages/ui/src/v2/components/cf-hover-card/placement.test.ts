import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { placeCard } from "./placement.ts";

describe("placement", () => {
  const window = { width: 800, height: 600 };
  const card = { width: 120, height: 40 };

  describe("placeCard()", () => {
    it("places the card above its content when there is room", () => {
      expect(
        placeCard({ top: 200, bottom: 220, left: 20 }, card, window, 6),
      ).toEqual({ top: 154, left: 20 });
    });

    it("places the card below its content when there is no room above", () => {
      expect(placeCard({ top: 10, bottom: 30, left: 20 }, card, window, 6))
        .toEqual({ top: 36, left: 20 });
    });

    it("keeps a card that goes below inside the window", () => {
      const tall = { width: 120, height: 580 };
      expect(placeCard({ top: 10, bottom: 30, left: 20 }, tall, window, 6))
        .toEqual({ top: 14, left: 20 });
    });

    it("keeps the top of a card taller than the window in view", () => {
      const taller = { width: 120, height: 700 };
      expect(placeCard({ top: 10, bottom: 30, left: 20 }, taller, window, 6))
        .toEqual({ top: 6, left: 20 });
    });

    it("moves the card in from the window's right edge", () => {
      expect(placeCard({ top: 200, bottom: 220, left: 760 }, card, window, 6))
        .toEqual({ top: 154, left: 674 });
    });

    it("keeps the left edge of a card wider than the window in view", () => {
      const wide = { width: 900, height: 40 };
      expect(placeCard({ top: 200, bottom: 220, left: 20 }, wide, window, 6))
        .toEqual({ top: 154, left: 6 });
    });
  });
});
