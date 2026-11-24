import { cell } from "commonfabric";

// FIXTURE: literal-widen-mixed-values
// Verifies: schema injection works for literals, variable references, and expressions alike
//   cell(10) → cell(10, { type: "number" })
//   cell(variable) → cell(variable, { type: "number" })
//   cell(10 + 20) → cell(10 + 20, { type: "number" })
// Context: variable and expression values are resolved to their inferred type
export default function TestLiteralWidenMixedValues() {
  const variable = 42;
  const _c1 = cell(10);
  const _c2 = cell(variable);
  const _c3 = cell(10 + 20);

  return null;
}
