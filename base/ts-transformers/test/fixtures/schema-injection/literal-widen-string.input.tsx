import { cell } from "commonfabric";

// FIXTURE: literal-widen-string
// Verifies: string literals (normal, empty, multiline, with spaces) are all widened to { type: "string" }
//   cell("hello") → cell("hello", { type: "string" })
//   cell("") → cell("", { type: "string" })
//   cell("hello\nworld") → cell("hello\nworld", { type: "string" })
export default function TestLiteralWidenString() {
  const _s1 = cell("hello");
  const _s2 = cell("");
  const _s3 = cell("hello\nworld");
  const _s4 = cell("with spaces");

  return null;
}
