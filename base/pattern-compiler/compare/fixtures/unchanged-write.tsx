/// <cts-enable />
import { computed, handler, pattern, Writable } from "commonfabric";

const raise = handler<unknown, { floor: number; level: Writable<number> }>(
  (_, { floor, level }) => {
    level.set(Math.max(level.get(), floor));
  },
);

// A handler run that leaves a value as it was: `raise` writes the greater
// of the inputs `level` and `floor`, which is `level` itself where `floor`
// is not above it. That the value stayed says that `floor` is not above
// it. `text` is computed from `level`, and is not computed again for a
// value that stayed.
export default pattern<{ floor: number; level: Writable<number> }>(
  ({ floor, level }) => ({
    level,
    text: computed(() => `level ${level.get()}`),
    raise: raise({ floor, level }),
  }),
);
