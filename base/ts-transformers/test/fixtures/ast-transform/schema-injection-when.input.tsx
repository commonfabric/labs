import { when, pattern, UI, NAME } from "commonfabric";

interface State {
  enabled: boolean;
  message: string;
}

// FIXTURE: schema-injection-when
// Verifies: when() gets condition, value, and result schemas injected
//   when(enabled, message) → when(conditionSchema, valueSchema, resultSchema, enabled, message)
//   pattern<State>(fn)     → pattern(fn, inputSchema, outputSchema)
// Context: when(cond, value) returns value if cond is truthy, else cond; result schema is union type
export default pattern<State>(({ enabled, message }) => {
  // when(condition, value) - returns value if condition is truthy, else condition
  const result = when(enabled, message);

  return {
    [NAME]: "when schema test",
    [UI]: <div>{result}</div>,
  };
});
