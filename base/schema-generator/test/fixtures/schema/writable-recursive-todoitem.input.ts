// CT-1215: Recursive type with Writable<> wrapper creates orphaned $ref
// Uses the real Cell/Writable branded interface (provided by test prelude)

type Default<T, V extends T = T> = T;

export interface TodoItem {
  title: string;
  done: Default<boolean, false>;
  items: Writable<Default<TodoItem[], []>>;
}

interface SchemaRoot {
  todos: Default<TodoItem[], []>;
}
