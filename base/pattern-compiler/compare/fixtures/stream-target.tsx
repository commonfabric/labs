/// <cts-enable />
import { handler, pattern, UI, Writable } from "commonfabric";

const bump = handler<{ by: number }, { count: Writable<number> }>(
  (event, { count }) => {
    count.set(count.get() + event.by);
  },
);

// The inline handler sends to the stream of `inc`: its one write edge has
// that stream as its target, and what `bump` then writes is the write of
// another event.
export default pattern<{ start: number }>(({ start }) => {
  const count = Writable.of(0);
  const inc = bump({ count });
  return {
    [UI]: <div onClick={() => inc.send({ by: 2 })}>{start}</div>,
    count,
  };
});
