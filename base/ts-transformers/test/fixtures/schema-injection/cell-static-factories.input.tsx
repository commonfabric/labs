import { Cell, OpaqueCell, Stream } from "commonfabric";

// FIXTURE: cell-static-factories
// Verifies: static cell factories inject schemas from explicit, inferred, and contextual types
//   new Cell<string>("hello") → new Cell<string>("hello", { type: "string" })
//   new Cell(123) → new Cell(123, { type: "number" })
//   const cell: Cell<number> = Cell.for("cause") → Cell.for("cause").asSchema({ type: "number" })
//   new OpaqueCell<boolean>(true) / new Stream<number>(1) also receive injected schemas
export default function TestCellStaticFactories() {
  const explicitString = new Cell<string>("hello");
  const inferredNumber = new Cell(123);
  const explicitCause = Cell.for<string>("cause");
  const contextualCause: Cell<number> = Cell.for("cause");
  const opaque = new OpaqueCell<boolean>(true);
  const stream = new Stream<number>(1);

  return {
    explicitString,
    inferredNumber,
    explicitCause,
    contextualCause,
    opaque,
    stream,
  };
}
