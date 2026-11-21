/// <cts-enable />
import { handler, pattern, type Stream, type Writable } from "commonfabric";

// A handler that reads a cell and then writes it: the slot of its write
// edge is bound to the position the write targets, read before the write.
const increment = handler<unknown, { count: Writable<number> }>(
  (_, { count }) => {
    count.set(count.get() + 1);
  },
);

export default pattern<{ count: Writable<number> }>(({ count }) => ({
  bump: increment({ count }) as Stream<unknown>,
}));
