type Default<T, V extends T = T> = T;

interface SchemaRoot {
  /** Titles in a cell */
  titles: Cell<string[]>;

  /** Count as stream */
  count: Stream<number>;

  /** Level with default */
  level: Default<number, 3>;
}
