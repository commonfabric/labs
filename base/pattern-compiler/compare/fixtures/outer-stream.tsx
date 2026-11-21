/// <cts-enable />
import { handler, pattern, UI, Writable } from "commonfabric";

const bump = handler<{ by: number }, { count: Writable<number> }>(
  (event, { count }) => {
    count.set(count.get() + event.by);
  },
);

// One binding, made outside every element body, whose stream the tree
// holds at three positions: in a branch of a conditional, in each element
// of a list, and at a position of its own.
export default pattern<{ items: string[]; shown: boolean }>(
  ({ items, shown }) => {
    const count = Writable.of(0);
    const inc = bump({ count });
    return {
      [UI]: (
        <div>
          {shown ? <b onClick={inc}>+</b> : null}
          <ul>{items.map((item) => <li onClick={inc}>{item}</li>)}</ul>
          <i onClick={inc}>+</i>
        </div>
      ),
      count,
    };
  },
);
