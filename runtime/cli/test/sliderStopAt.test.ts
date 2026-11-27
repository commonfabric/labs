import { expect } from "@std/expect";

import {
  dialogBox,
  type DialogState,
  sliderStopAt,
} from "../lib/view/render.ts";
import { describe, it } from "@commonfabric/test-support/test";

describe("sliderStopAt()", () => {
  const dialog: DialogState = {
    title: "Settings",
    body: [],
    buttons: [{ label: "OK", hotkey: "o" }],
    fields: [
      {
        kind: "slider",
        label: "Delay",
        hotkey: "d",
        stopCount: 5,
        stop: 0,
        text: "1 ms",
      },
      { kind: "checkBox", label: "Quit", hotkey: "q", checked: false },
    ],
  };
  const view = { width: 60, height: 20 };
  const box = dialogBox(view, dialog);
  // Inside the border, a blank row follows the empty body, then the label,
  // then the track, which runs between margins two columns wide.
  const track = box.y + 3;
  const start = box.x + 3;
  const end = box.x + box.innerW - 2;

  it("throws for a field that is not a slider", () => {
    expect(() => sliderStopAt(view, dialog, 1, 0, 0)).toThrow(
      "field 1 of the dialog is not a slider",
    );
  });

  it("returns the stop nearest the column, the first at the track's left end and the last at its right end", () => {
    expect(sliderStopAt(view, dialog, 0, start, track)).toBe(0);
    expect(sliderStopAt(view, dialog, 0, start + 1, track)).toBe(0);
    expect(
      sliderStopAt(
        view,
        dialog,
        0,
        start + Math.round((end - start) / 2),
        track,
      ),
    ).toBe(2);
    expect(sliderStopAt(view, dialog, 0, end - 1, track)).toBe(4);
    expect(sliderStopAt(view, dialog, 0, end, track)).toBe(4);
  });

  it("returns the nearer end for a column in the margin on either side of the track", () => {
    expect(sliderStopAt(view, dialog, 0, box.x + 1, track)).toBe(0);
    expect(sliderStopAt(view, dialog, 0, box.x + box.innerW, track)).toBe(4);
  });

  it("returns null for the label's row and the row past the track", () => {
    expect(sliderStopAt(view, dialog, 0, start, track - 1)).toBeNull();
    expect(sliderStopAt(view, dialog, 0, start, track + 1)).toBeNull();
  });
});
