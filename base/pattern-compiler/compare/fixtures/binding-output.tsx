/// <cts-enable />
import { computed, handler, pattern, Writable } from "commonfabric";

// The state of a handler's binding takes a value the pattern computes, an
// output of the pattern and no stored position.
const bump = handler<unknown, { log: Writable<number[]>; doubled: number }>(
  (_, { log, doubled }) => {
    log.push(doubled);
  },
);

export default pattern<{ n: number; log: Writable<number[]> }>(
  ({ n, log }) => {
    const doubled = computed(() => n * 2);
    return { log, bump: bump({ log, doubled }) };
  },
);
