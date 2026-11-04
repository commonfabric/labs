import { unless, pattern, UI, NAME } from "commonfabric";

interface State {
  value: string | null;
  defaultValue: string;
}

// FIXTURE: schema-injection-unless
// Verifies: unless() gets condition, fallback, and result schemas injected
//   unless(value, defaultValue) → unless(conditionSchema, fallbackSchema, resultSchema, value, defaultValue)
//   pattern<State>(fn)          → pattern(fn, inputSchema, outputSchema)
// Context: unless(cond, fallback) returns cond if truthy, else fallback; schemas reflect the union type
export default pattern<State>(({ value, defaultValue }) => {
  // unless(condition, fallback) - returns condition if truthy, else fallback
  const result = unless(value, defaultValue);

  return {
    [NAME]: "unless schema test",
    [UI]: <div>{result}</div>,
  };
});
