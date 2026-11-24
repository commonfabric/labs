import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  dialogBox,
  type DialogState,
  radioButtonAt,
} from "../lib/view/render.ts";

describe("radioButtonAt()", () => {
  const dialog: DialogState = {
    title: "Settings",
    body: [],
    buttons: [{ label: "OK", hotkey: "o" }],
    fields: [
      {
        kind: "radioButtons",
        label: "Tool",
        hotkey: "t",
        buttons: [
          { label: "Link", hotkey: "l" },
          { label: "Browser", hotkey: "b" },
        ],
        selected: 0,
      },
      { kind: "checkBox", label: "Quit", hotkey: "q", checked: false },
    ],
  };
  const view = { width: 60, height: 20 };
  const box = dialogBox(view, dialog);
  // Inside the border, a blank row follows the empty body, then the label,
  // then a row for each button.
  const label = box.y + 2;

  it("throws for a field that is not a set of radio buttons", () => {
    expect(() => radioButtonAt(view, dialog, 1, 0, 0)).toThrow(
      "field 1 of the dialog is not a set of radio buttons",
    );
  });

  it("returns the index of the button drawn on the row", () => {
    expect(radioButtonAt(view, dialog, 0, box.x + 1, label + 1)).toBe(0);
    expect(radioButtonAt(view, dialog, 0, box.x + 1, label + 2)).toBe(1);
  });

  it("returns null for the label's row, a row past the buttons, or the box's border", () => {
    expect(radioButtonAt(view, dialog, 0, box.x + 1, label)).toBeNull();
    expect(radioButtonAt(view, dialog, 0, box.x + 1, label + 3)).toBeNull();
    expect(radioButtonAt(view, dialog, 0, box.x, label + 1)).toBeNull();
  });
});
