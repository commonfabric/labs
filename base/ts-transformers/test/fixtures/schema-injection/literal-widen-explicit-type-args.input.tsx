import { Cell } from "commonfabric";

// FIXTURE: literal-widen-explicit-type-args
// Verifies: new Cell with explicit type arguments injects schema matching the type arg
//   new Cell<number>(10) → new Cell<number>(10, { type: "number" })
//   new Cell<string>("hello") → new Cell<string>("hello", { type: "string" })
//   new Cell<boolean>(true) → new Cell<boolean>(true, { type: "boolean" })
//   new Cell<boolean | null>(null)
//     → new Cell<boolean | null>(null, { anyOf: [{ type: "boolean" }, { type: "null" }] })
export default function TestLiteralWidenExplicitTypeArgs() {
  const _c1 = new Cell<number>(10);
  const _c2 = new Cell<string>("hello");
  const _c3 = new Cell<boolean>(true);
  const _c4 = new Cell<boolean | null>(null);

  return null;
}
