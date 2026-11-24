type Default<T, V extends T = T> = T;
interface TodoItem {
  title: string;
  done: boolean;
}
interface SchemaRoot {
  emptyItems: Default<TodoItem[], []>;
  prefilledItems: Default<string[], ["item1", "item2"]>;
  matrix: Default<number[][], [[1, 2], [3, 4]]>;
}
