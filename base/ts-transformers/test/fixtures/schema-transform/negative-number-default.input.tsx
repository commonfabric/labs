import { Default, NAME, pattern, toSchema } from "commonfabric";
import "commonfabric/schema";

interface Input {
  selectedIndex: number | Default<number, -1>;
  threshold: number | Default<number, -0.5>;
}

const inputSchema = toSchema<Input>();

// FIXTURE: negative-number-default
// Verifies: negative numeric defaults are emitted as unary minus expressions
// (the TS factory rejects negative numbers in createNumericLiteral)
export default pattern<Input>(({ selectedIndex, threshold }) => ({
  [NAME]: "Negative defaults",
  selectedIndex,
  threshold,
}), inputSchema);
