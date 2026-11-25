import { expect } from "@std/expect";

import { type DialogState, inputLineIndexAt } from "../lib/view/render.ts";
import { describe, it } from "@commonfabric/test-support/test";

describe("inputLineIndexAt()", () => {
  const dialog: DialogState = {
    title: "Settings",
    body: [],
    buttons: [{ label: "OK", hotkey: "o" }],
    fields: [
      { kind: "checkBox", label: "Quit", hotkey: "q", checked: false },
      {
        kind: "inputLine",
        label: "Relay",
        hotkey: "r",
        value: "relay.example.test",
        cursor: 0,
        scroll: 0,
        selected: false,
      },
    ],
  };
  const view = { width: 60, height: 20 };

  it("throws for a field that is not an input line", () => {
    expect(() => inputLineIndexAt(view, dialog, 0, 0, 0)).toThrow(
      "field 0 of the dialog is not an input line",
    );
  });

  it("returns null for a row other than the input line's", () => {
    expect(inputLineIndexAt(view, dialog, 1, 0, 0)).toBeNull();
  });
});
