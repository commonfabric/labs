import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { stripAnsi } from "@commonfabric/cli/view/ansi";

import { Canvas } from "./canvas.ts";
import { menuBar, pullDown, statusLine } from "./widgets.ts";
import { span } from "./text.ts";

describe("widgets", () => {
  describe("statusLine()", () => {
    it("draws only the hints that fit whole, and the start of what is said at the right", () => {
      const canvas = new Canvas<string>(24, 1, [0, 0, 0]);
      const hints = [
        { key: "F1", label: "Help", act: "help" },
        { key: "F2", label: "Comment", act: "comment" },
      ];
      statusLine(canvas, hints, [span("ok ")]);

      expect(stripAnsi(canvas.paint()[0])).toBe(
        "  F1 Help".padEnd(21) + "ok ",
      );

      statusLine(canvas, hints, [
        span("Commenting on top/1 may not have finished"),
      ]);

      expect(stripAnsi(canvas.paint()[0])).toBe("Commenting on top/1 may ");
    });
  });

  describe("menuBar()", () => {
    it("draws the menus first, and what is said at the right in the room left", () => {
      const canvas = new Canvas<string>(16, 1, [0, 0, 0]);
      menuBar(
        canvas,
        [{ label: "File", hotkey: "F", items: [] }],
        undefined,
        () => "menu",
        [span("connecting to the board")],
      );

      expect(stripAnsi(canvas.paint()[0])).toBe("   File connecti");
    });
  });

  describe("pullDown()", () => {
    it("draws each item's shortcut against the right border, and returns where it drew", () => {
      const canvas = new Canvas<string>(30, 6, [0, 0, 0]);
      const rect = pullDown(canvas, 0, 0, {
        label: "File",
        hotkey: "F",
        items: [
          { label: "Open", hotkey: "O", shortcut: "F3", act: "open" },
          "-",
          { label: "Exit", hotkey: "x", shortcut: "Alt-X", act: "exit" },
        ],
      }, 0);
      const rows = canvas.paint().map(stripAnsi);

      expect(rect).toEqual({ x: 0, y: 0, width: 15, height: 5 });
      expect(rows.slice(0, 5).map((row) => row.slice(0, 15))).toEqual([
        "┌─────────────┐",
        "│ Open     F3 │",
        "├─────────────┤",
        "│ Exit  Alt-X │",
        "└─────────────┘",
      ]);
      expect(canvas.at(9, 3).click).toBe("exit");
    });
  });
});
