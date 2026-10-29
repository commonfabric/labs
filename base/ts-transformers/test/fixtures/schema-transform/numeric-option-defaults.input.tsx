import { toSchema } from "commonfabric";

interface Config {
  sentinel: number;
  ratio: number;
  nan: number;
  inf: number;
  negInf: number;
  negZero: number;
  parenthesized: number;
}

const configSchema = toSchema<Config>({
  "default": {
    sentinel: -1,
    ratio: -0.5,
    nan: NaN,
    inf: Infinity,
    negInf: -Infinity,
    negZero: -0,
    // Parentheses carry no meaning, but they are a distinct AST node; without
    // unwrapping them this property is dropped like any other.
    parenthesized: (-1),
  },
});
// FIXTURE: numeric-option-defaults
// Verifies: the toSchema options object carries signed and non-finite numbers
// through to the emitted schema. Recognizing only bare NumericLiteral drops
// each of these properties silently — a `-1` sentinel default just vanishes.
// (Wrappers across all option types: see `wrapped-options`.)
export { configSchema };
