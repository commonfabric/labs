/// <cts-enable />
import { handler, pattern, UI, Writable } from "commonfabric";

interface Input {
  tags: string[];
}

// Bound once per occurrence of an element: it sets the state cell that
// the element body declares.
const open = handler<unknown, { opened: Writable<boolean> }>(
  (_, { opened }) => {
    opened.set(true);
  },
);

export default pattern<Input>(({ tags }) => {
  return {
    [UI]: (
      <ul>
        {tags.map((tag) => {
          // A state cell per occurrence: two equal tags have one each.
          const opened = Writable.of(false);
          return <li onClick={open({ opened })}>{tag}{opened}</li>;
        })}
      </ul>
    ),
  };
});
