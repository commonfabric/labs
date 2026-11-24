import { computed, fetchText, ifElse, pattern, UI } from "commonfabric";

// Tests ifElse where ifTrue is explicitly undefined
// This pattern is common: ifElse(pending, undefined, { result })
// The transformer must handle this correctly - the undefined is a VALUE, not a missing argument

// FIXTURE: ifelse-undefined-value
// Verifies: ifElse with explicit undefined as ifTrue or ifFalse branch is handled correctly
//   ifElse(cond, undefined, {result}) → ifElse(schema, schema, schema, schema, lift(...)(...), undefined, {result})
//   ifElse(cond, {data}, undefined)   → ifElse(schema, schema, schema, schema, lift(...)(...), {data}, undefined)
// Context: undefined is a VALUE argument, not a missing argument
export default pattern<Record<string, never>>(() => {
  const { pending, result } = fetchText({
    url: "/api/data",
  });

  // Pattern 1: undefined as ifTrue (waiting state returns nothing)
  const output1 = ifElse(
    computed(() => pending || !result),
    undefined,
    { result }
  );

  // Pattern 2: undefined as ifFalse (error state returns nothing)
  const output2 = ifElse(
    computed(() => !!result),
    { data: result },
    undefined
  );

  return {
    [UI]: (
      <div>
        <span>{output1}</span>
        <span>{output2}</span>
      </div>
    ),
  };
});
