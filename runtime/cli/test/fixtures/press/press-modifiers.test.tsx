/**
 * Fixture for a press step's modifier keys: one control whose handler records
 * which keys the click held. The first press holds Cmd and Shift, the second
 * holds none, and the assertion reads both clicks back in order.
 */

import { assert, handler, pattern, TESTS, UI, Writable } from "commonfabric";

interface Click {
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
}

const record = handler<Click, { seen: Writable<string[]> }>(
  (click, { seen }) => {
    const held = [
      click.altKey ? "alt" : "",
      click.ctrlKey ? "ctrl" : "",
      click.metaKey ? "meta" : "",
      click.shiftKey ? "shift" : "",
    ].filter((key) => key !== "").join("+");
    seen.push(held === "" ? "none" : held);
  },
);

export default pattern(() => {
  const seen = Writable.of<string[]>([]);
  const view = (
    <div>
      <cf-button onClick={record({ seen })}>Open</cf-button>
    </div>
  );
  return {
    [UI]: view,
    [TESTS]: [
      { press: view, control: "Open", modifiers: ["meta", "shift"] },
      { press: view, control: "Open" },
      {
        assertion: assert(() => seen.get().join(",") === "meta+shift,none"),
      },
    ],
  };
});
