// Tests Cell<T> and Stream<T> wrapper types
// These should have asCell/asStream markers

import { Cell, Stream } from "commonfabric";

interface SchemaRoot {
  // Cell wrapper with primitive
  counter: Cell<number>;

  // Cell wrapper with complex type
  user: Cell<{ name: string; age: number }>;

  // Stream wrapper
  events: Stream<string>;

  // Optional cell (Cell with undefined union)
  maybeCell?: Cell<string>;
}
