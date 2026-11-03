/// <cts-enable />
/**
 * A verb that only hands a capture on to a pattern it instantiates takes the
 * capture as an opaque handle, so nothing about it has to be current before the
 * verb runs. A capture the verb also reads keeps what the read earns.
 */
import { action, computed, pattern, Writable } from "commonfabric";

interface ChildInput {
  rows: readonly string[];
  count: number;
  label: string;
}

const Child = pattern<ChildInput, { label: string }>(({ label }) => ({ label }));

export default pattern<{ items: Writable<string[]> }>(({ items }) => {
  const rows = computed(() => items.get().map((item) => item.toUpperCase()));
  const count = computed(() => items.get().length);
  const made = new Writable<unknown[]>([]);

  const addChild = action<{ label: string }, void>(({ label }) => {
    if (count > 10) return;
    made.push(Child({ rows, count, label }));
  });

  return { addChild, rows, count };
});
