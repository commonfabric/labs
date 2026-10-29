import { cell } from "commonfabric";

// FIXTURE: literal-widen-boolean
// Verifies: boolean literals (true/false) are widened to { type: "boolean" } schema
//   cell(true) → cell(true, { type: "boolean" })
//   cell(false) → cell(false, { type: "boolean" })
export default function TestLiteralWidenBoolean() {
  const _b1 = cell(true);
  const _b2 = cell(false);

  return null;
}
