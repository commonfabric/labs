/**
 * A member of a handler's state handed to `equals` is compared by its link.
 *
 * `equals(state.selected, event.panel)` only compares `state.selected`, so the
 * handler's state schema gives it as a comparable cell rather than reading
 * its value. The comparison is still by link: the same cell matches, and a
 * different cell holding an equal value does not.
 *
 * Run: deno task cf test packages/patterns/regression/member-identity-argument.test.tsx
 */
import {
  assert,
  equals,
  handler,
  pattern,
  TESTS,
  Writable,
} from "commonfabric";

interface Panel {
  name: string;
}

const compare = handler<
  { panel: Writable<Panel> },
  { selected: Writable<Panel>; found: Writable<string> }
>((event, state) => {
  state.found.set(equals(state.selected, event.panel) ? "same" : "different");
});

export default pattern(() => {
  const selected = new Writable<Panel>({ name: "a" });
  const lookalike = new Writable<Panel>({ name: "a" });
  const found = new Writable<string>("");
  const check = compare({ selected, found });

  const assertSameMatches = assert(() => found.get() === "same");
  const assertLookalikeDiffers = assert(() => found.get() === "different");

  return {
    [TESTS]: [
      { action: check, event: { panel: selected } },
      { assertion: assertSameMatches },
      { action: check, event: { panel: lookalike } },
      { assertion: assertLookalikeDiffers },
    ],
  };
});
