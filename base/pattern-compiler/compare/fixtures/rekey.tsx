/// <cts-enable />
import { handler, pattern, Writable } from "commonfabric";

interface Task {
  title: string;
  done: boolean;
}

// Two writes through the element of a row, one after the other.
const finishAndRename = handler<unknown, { task: Writable<Task> }>(
  (_, { task }) => {
    task.key("done").set(true);
    task.key("title").set("renamed");
  },
);

// A write through the element of a row, and then the element stored in
// a cell.
const finishAndPick = handler<
  unknown,
  { task: Writable<Task>; picked: Writable<Task | null> }
>((_, { task, picked }) => {
  task.key("done").set(true);
  picked.set(task);
});

// The element stored in a cell, with no write.
const pick = handler<
  unknown,
  { task: Writable<Task>; picked: Writable<Task | null> }
>((_, { task, picked }) => {
  picked.set(task);
});

// A state cell of a row.
const note = handler<{ text: string }, { noted: Writable<string> }>(
  (event, { noted }) => {
    noted.set(event.text);
  },
);

// Ruling Z24: a write through a reference by key that changes a plain
// value in place re-keys the element in the same transaction. What the
// old key holds moves to the new key, so the state cell `noted` of the
// row stays with the element, a second write through the same handle
// succeeds, and the handle stored after the write names the element. A
// reference stored elsewhere under the old key reads as nothing. `rows`
// is over the array, which a test gives as plain values in place and as
// references to cells, and `open` is over the result of a `filter` of
// it, with a state cell of its own. The executor's tests run this
// fixture. It is not compared with today's runtime.
export default pattern<{ tasks: Writable<Task[]> }>(({ tasks }) => {
  const picked = Writable.of<Task | null>(null);
  return {
    picked,
    rows: tasks.map((task) => {
      const noted = Writable.of("");
      return {
        title: task.title,
        done: task.done,
        noted,
        check: <cf-checkbox $checked={task.done} />,
        note: note({ noted }),
        finishAndRename: finishAndRename({ task }),
        finishAndPick: finishAndPick({ task, picked }),
        pick: pick({ task, picked }),
      };
    }),
    open: tasks.filter((task) => task.title !== "hidden").map((task) => {
      const seen = Writable.of("");
      return { title: task.title, seen, see: note({ noted: seen }) };
    }),
  };
});
