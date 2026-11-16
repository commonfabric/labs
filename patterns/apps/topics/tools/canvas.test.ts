import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { RESET, stripAnsi } from "@commonfabric/cli/view/ansi";

import { Canvas, inside } from "./canvas.ts";
import { span } from "./text.ts";

const BG = [0, 0, 0] as const;

/** `canvas` painted, as text. */
function text<C>(canvas: Canvas<C>): string[] {
  return canvas.paint().map(stripAnsi);
}

describe("canvas", () => {
  describe("inside()", () => {
    it("returns whether a cell lies in a rectangle, its far edges outside", () => {
      const rect = { x: 2, y: 1, width: 3, height: 2 };

      expect(inside(rect, 2, 1)).toBe(true);
      expect(inside(rect, 4, 2)).toBe(true);
      expect(inside(rect, 5, 2)).toBe(false);
      expect(inside(rect, 4, 3)).toBe(false);
    });
  });

  describe("Canvas", () => {
    it("draws a later region over an earlier one, cut to its width and padded", () => {
      const canvas = new Canvas<never>(8, 2, BG);
      canvas.put(0, 0, [span("abcdefgh")]);
      canvas.put(2, 0, [span("XYZ")], 4);
      canvas.put(0, 1, [span("off the edge")], 20);

      expect(text(canvas)).toEqual(["abXYZ gh", "off the "]);
    });

    it("draws only what of a region falls on the canvas", () => {
      const canvas = new Canvas<never>(4, 2, BG);
      canvas.put(-2, 0, [span("abcdef")]);
      canvas.put(0, 2, [span("below")]);
      canvas.put(0, -1, [span("above")]);

      expect(text(canvas)).toEqual(["cdef", "    "]);
    });

    it("blanks a wide character a region cuts in half, rather than half drawing it", () => {
      const canvas = new Canvas<never>(6, 1, BG);
      canvas.put(0, 0, [span("日本語")]);
      canvas.put(1, 0, [span("x")], 1);

      expect(text(canvas)).toEqual([" x本語"]);

      canvas.put(0, 0, [span("ab日")], 3);

      expect(text(canvas)).toEqual(["ab  語"]);
    });

    it("answers what clicking a cell does and where it links, and forgets both under a shadow", () => {
      const canvas = new Canvas<string>(6, 2, BG);
      canvas.put(0, 0, [
        { ...span("go"), click: "go!" },
        span("x", {}, "https://example.com"),
      ]);

      expect(canvas.at(1, 0)).toEqual({ click: "go!", href: undefined });
      expect(canvas.at(2, 0)).toEqual({
        click: undefined,
        href: "https://example.com",
      });
      expect(canvas.at(9, 9)).toEqual({});

      canvas.shade({ x: 0, y: 0, width: 3, height: 1 }, [9, 9, 9]);

      expect(canvas.at(1, 0)).toEqual({ click: undefined, href: undefined });
      expect(text(canvas)[0]).toBe("gox   ");
    });

    it("shades only what of a rectangle falls on the canvas", () => {
      const canvas = new Canvas<never>(2, 1, BG);
      canvas.put(0, 0, [span("ab", { fg: [200, 200, 200] })]);
      canvas.shade({ x: 1, y: -1, width: 4, height: 3 }, [10, 10, 10]);
      const [row] = canvas.paint();

      expect(stripAnsi(row)).toBe("ab");
      expect(row).toContain("48;2;0;0;0ma");
      expect(row).toContain("48;2;10;10;10mb");
    });

    it("paints a run of one style as one, and a link as a terminal hyperlink", () => {
      const canvas = new Canvas<never>(4, 1, BG);
      canvas.put(0, 0, [
        span("ab", { bold: true }),
        span("cd", {}, "https://e.x"),
      ]);
      const [row] = canvas.paint();

      expect(row.split(RESET).length - 1).toBe(3);
      expect(row).toContain("\x1b]8;;https://e.x\x07cd\x1b]8;;\x07");
    });

    it("puts the cursor where the next cell is after a wide character", () => {
      const canvas = new Canvas<never>(4, 1, BG);
      canvas.put(0, 0, [span("日ab")]);
      const [row] = canvas.paint();

      expect(row).toContain("日\x1b[3G");
    });

    it("paints a link to anywhere but the web as plain text", () => {
      const canvas = new Canvas<never>(4, 1, BG);
      canvas.put(0, 0, [span("ab", {}, "file:///etc/passwd")]);
      const [row] = canvas.paint();

      expect(row).not.toContain("\x1b]8;");
    });

    it("turns the colors about of the one thing held down, and no others", () => {
      const canvas = new Canvas<string>(6, 1, BG);
      canvas.put(0, 0, [
        { ...span("go", { fg: [1, 1, 1] }), click: "go!" },
        span("x", { fg: [2, 2, 2] }),
        { ...span("go", { fg: [1, 1, 1] }), click: "go!" },
      ]);
      const held = canvas.reach(1, 0, (cell) => cell.click ?? "");

      expect([...held].sort()).toEqual([0, 1]);

      canvas.press(held, [9, 9, 9]);
      const [row] = canvas.paint();

      expect(row).toContain("\x1b[38;2;0;0;0;48;2;1;1;1mgo");
      expect(row).toContain("\x1b[38;2;2;2;2;48;2;0;0;0mx");
      expect(row).toContain("\x1b[38;2;1;1;1;48;2;0;0;0mgo");
    });

    it("reaches nothing from outside the canvas, and holds down nothing outside it", () => {
      const canvas = new Canvas<string>(2, 1, BG);
      canvas.put(0, 0, [{ ...span("go", { fg: [1, 1, 1] }), click: "go!" }]);
      const before = canvas.paint();

      expect(canvas.reach(5, 5, (cell) => cell.click ?? "").size).toBe(0);

      canvas.press(new Set([7]), [9, 9, 9]);

      expect(canvas.paint()).toEqual(before);
    });

    it("draws a cell held down that leaves its color to the terminal in the color given", () => {
      const canvas = new Canvas<string>(2, 1, BG);
      canvas.put(0, 0, [{ ...span("go"), click: "go!" }]);
      canvas.press(canvas.reach(0, 0, (cell) => cell.click ?? ""), [9, 9, 9]);

      expect(canvas.paint()[0]).toContain("\x1b[38;2;0;0;0;48;2;9;9;9mgo");
    });

    it("fills a rectangle with a character that runs a command", () => {
      const canvas = new Canvas<string>(3, 2, BG);
      canvas.fill({ x: 1, y: 0, width: 2, height: 2 }, "░", {}, "here");

      expect(text(canvas)).toEqual([" ░░", " ░░"]);
      expect(canvas.at(2, 1).click).toBe("here");
      expect(canvas.at(0, 1).click).toBeUndefined();
    });
  });
});
