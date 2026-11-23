/// <cts-enable />
/**
 * A handler that makes an instance of a pattern with a state cell, a
 * handler and a computation of its own, and adds it to a list: `add`
 * instantiates `Counter`, whose `bump` adds to its `count`, and whose
 * `shown` is computed from its label and its count.
 */
import {
  computed,
  handler,
  pattern,
  type Stream,
  Writable,
} from "commonfabric";

interface CounterResult {
  label: string;
  count: number;
  shown: string;
  bump: Stream<{ by: number }>;
}

const bump = handler<{ by: number }, { count: Writable<number> }>(
  (event, { count }) => {
    count.set(count.get() + event.by);
  },
);

const Counter = pattern<{ label: string }, CounterResult>(({ label }) => {
  const count = Writable.of(0);
  return {
    label,
    count,
    shown: computed(() => label + ":" + count.get()),
    bump: bump({ count }),
  };
});

const add = handler<
  { label: string },
  { members: Writable<CounterResult[]> }
>((event, { members }) => {
  members.push(Counter({ label: event.label }));
});

interface Input {
  members: Writable<CounterResult[]>;
}

interface Output {
  members: CounterResult[];
  add: Stream<{ label: string }>;
}

export default pattern<Input, Output>(({ members }) => ({
  members,
  add: add({ members }),
}));
