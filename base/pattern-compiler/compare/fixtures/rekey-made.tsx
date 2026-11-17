/// <cts-enable />
import { handler, lift, pattern, type Stream, Writable } from "commonfabric";

interface Task {
  title: string;
  done: boolean;
}

const bump = handler<{ by: number }, { count: Writable<number> }>(
  (event, { count }) => {
    count.set(count.get() + event.by);
  },
);

interface RowResult {
  title: string;
  count: number;
  bump: Stream<{ by: number }>;
}

// A pattern with a state cell, which a function body instantiates.
const Row = pattern<{ title: string }, RowResult>(({ title }) => {
  const count = Writable.of(0);
  return { title, count, bump: bump({ count }) };
});

// A function body of the element body that makes an instance, and one
// that binds a handler to a cell of the pattern.
const made = lift((input: { title: string }) => Row({ title: input.title }));
const bound = lift((input: { pressed: Writable<number> }) => ({
  press: bump({ count: input.pressed }),
}));

// A write through the element of a row, which changes its value.
const finish = handler<unknown, { task: Writable<Task> }>((_, { task }) => {
  task.key("done").set(true);
});

// Ruling Z41: on a re-key of a plain value in place, the instance that a
// `lift` of the element body made moves to the new key as a child, and
// nothing moves for the binding that a function body made. Neither
// `lift` reads `done`, so the write of `finish` changes the key of the
// element and nothing the bodies read. `rows` is over the array, which a
// test gives as plain values in place and as references to cells. The
// executor's tests run this fixture. It is not compared with today's
// runtime.
export default pattern<{ tasks: Writable<Task[]> }>(({ tasks }) => {
  const pressed = Writable.of(0);
  return {
    pressed,
    rows: tasks.map((task) => ({
      done: task.done,
      row: made({ title: task.title }),
      button: bound({ pressed }),
      finish: finish({ task }),
    })),
  };
});
