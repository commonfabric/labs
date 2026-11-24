import { lift, Cell, toSchema } from "commonfabric";

interface PieceEntry {
  id: string;
  name: string;
}

// Test: Explicit toSchema, function-first order.
// This overload pattern: lift(fn, toSchema<T>())  (result schema omitted)
const logPiecesList = lift(
  ({ piecesList }) => {
    console.log("logPiecesList: ", piecesList.get());
    return piecesList;
  },
  toSchema<{ piecesList: Cell<PieceEntry[]> }>(),
);

const getStatus = lift(
  ({ status }) => status,
  toSchema<{ status: "open" | "closed"; ignored: "draft" }>({
    description: "Status input",
  }),
  toSchema<string>(),
);

// FIXTURE: lift-explicit-toschema
// Verifies: lift() with explicit toSchema<T>() is replaced by the generated JSON schema
//   lift(fn, toSchema<{ piecesList: Cell<PieceEntry[]> }>()) → lift(fn, generatedSchema)
// Context: The toSchema() call is compiled away and replaced with the actual JSON schema object
export default { logPiecesList, getStatus };
