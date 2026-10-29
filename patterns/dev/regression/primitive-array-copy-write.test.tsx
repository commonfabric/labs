/**
 * A handler that copies an array of primitives, shifts the copy, and writes it
 * back keeps every value where the copy put it.
 *
 * An array the body fills and hands to `.set()` can be written by identity, so
 * that each element it copies goes back as a link to the slot it was read
 * from. A number has no identity of its own: once `slice(-3)` or a prepend
 * moves it to another slot, the link names the value now in its old slot, and
 * every slot ends up naming the newest value. An array whose element type
 * admits `null`, or mixes numbers with objects, holds such values too.
 *
 * Run: deno task cf test patterns/dev/regression/primitive-array-copy-write.test.tsx
 */
import {
  action,
  assert,
  handler,
  pattern,
  TESTS,
  Writable,
} from "commonfabric";

const appendKeepingThree = handler<
  void,
  { history: Writable<number[]>; count: Writable<number> }
>((_, { history, count }) => {
  const next = count.get() + 1;
  count.set(next);
  const updated = [...history.get(), next].slice(-3);
  history.set(updated);
});

const appendKeepingThreeThroughConditional = handler<
  void,
  { history: Writable<number[]>; count: Writable<number> }
>((_, { history, count }) => {
  const next = count.get() + 1;
  count.set(next);
  const current = history.get();
  const list = Array.isArray(current) ? current : [];
  const updated = [...list, next].slice(-3);
  history.set(updated);
});

const appendNullable = handler<
  void,
  { history: Writable<(number | null)[]>; count: Writable<number> }
>((_, { history, count }) => {
  const next = count.get() + 1;
  count.set(next);
  const current = history.get();
  const list = Array.isArray(current) ? current : [];
  const updated = [...list, next].slice(-3);
  history.set(updated);
});

const appendMixed = handler<
  void,
  {
    history: Writable<(number | { label: string })[]>;
    count: Writable<number>;
  }
>((_, { history, count }) => {
  const next = count.get() + 1;
  count.set(next);
  const current = history.get();
  const list = Array.isArray(current) ? current : [];
  const updated = [...list, next].slice(-3);
  history.set(updated);
});

const prepend = handler<
  void,
  { history: Writable<number[]>; count: Writable<number> }
>((_, { history, count }) => {
  const next = count.get() + 1;
  count.set(next);
  const updated = [next, ...history.get()];
  history.set(updated);
});

export default pattern(() => {
  const shifted = new Writable<number[]>([]);
  const shiftedThroughConditional = new Writable<number[]>([]);
  const prepended = new Writable<number[]>([]);
  const nullable = new Writable<(number | null)[]>([]);
  const mixed = new Writable<(number | { label: string })[]>([]);
  const counts = [0, 1, 2, 3, 4].map(() => new Writable<number>(0));
  const appendShifted = appendKeepingThree({
    history: shifted,
    count: counts[0]!,
  });
  const appendThroughConditional = appendKeepingThreeThroughConditional({
    history: shiftedThroughConditional,
    count: counts[1]!,
  });
  const prependOne = prepend({ history: prepended, count: counts[2]! });
  const appendToNullable = appendNullable({
    history: nullable,
    count: counts[3]!,
  });
  const appendToMixed = appendMixed({ history: mixed, count: counts[4]! });

  const action_record_five_times = action(() => {
    for (let index = 0; index < 5; index++) {
      appendShifted.send();
      appendThroughConditional.send();
      prependOne.send();
      appendToNullable.send();
      appendToMixed.send();
    }
  });

  const assert_shifted_copy_keeps_values = assert(() =>
    shifted.get().join(",") === "3,4,5"
  );
  const assert_shifted_copy_through_conditional_keeps_values = assert(() =>
    shiftedThroughConditional.get().join(",") === "3,4,5"
  );
  const assert_prepended_copy_keeps_values = assert(() =>
    prepended.get().join(",") === "5,4,3,2,1"
  );
  const assert_nullable_copy_keeps_values = assert(() =>
    nullable.get().join(",") === "3,4,5"
  );
  const assert_mixed_copy_keeps_values = assert(() =>
    mixed.get().join(",") === "3,4,5"
  );

  return {
    [TESTS]: [
      { action: action_record_five_times },
      { assertion: assert_shifted_copy_keeps_values },
      { assertion: assert_shifted_copy_through_conditional_keeps_values },
      { assertion: assert_prepended_copy_keeps_values },
      { assertion: assert_nullable_copy_keeps_values },
      { assertion: assert_mixed_copy_keeps_values },
    ],
  };
});
