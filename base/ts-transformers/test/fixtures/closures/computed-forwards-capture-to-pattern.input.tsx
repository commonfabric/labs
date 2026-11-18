/// <cts-enable />
/**
 * A computed that only hands a capture on to a pattern it instantiates takes the
 * capture as an opaque handle, so a change to the capture does not run it again
 * and nothing about the capture has to be current first. A capture it also reads
 * keeps what the read earns.
 */
import { computed, lift, pattern, Writable } from "commonfabric";

interface ChildInput {
  rows: readonly string[];
  count: number;
}

const Child = pattern<ChildInput, { count: number }>(({ count }) => ({ count }));

const makeChild = lift<ChildInput, unknown>(({ rows, count }) => {
  if (count > 10) return undefined;
  return Child({ rows, count });
});

export default pattern<{ items: Writable<string[]> }>(({ items }) => {
  const rows = computed(() => items.get().map((item) => item.toUpperCase()));
  const count = computed(() => items.get().length);
  const child = computed(() => count > 10 ? undefined : Child({ rows, count }));
  const lifted = makeChild({ rows, count });

  return { child, lifted };
});
