/**
 * Fixture for a press step that names a control the view shows twice, with
 * nothing to tell the two apart: the step fails rather than pressing either.
 */

import { assert, handler, pattern, TESTS, UI, Writable } from "commonfabric";

const remove = handler<unknown, { items: Writable<string[]>; name: string }>(
  (_, { items, name }) => {
    items.set(items.get().filter((item) => item !== name));
  },
);

export default pattern(() => {
  const items = Writable.of<string[]>(["apple", "pear"]);
  const view = (
    <div>
      {items.map((name) => (
        <div>
          <span>{name}</span>
          <cf-button onClick={remove({ items, name })}>Remove</cf-button>
        </div>
      ))}
    </div>
  );
  return {
    [UI]: view,
    [TESTS]: [
      { press: view, control: "Remove" },
      { assertion: assert(() => items.get().length === 2) },
    ],
  };
});
