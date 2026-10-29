import { computed, pattern, UI } from "commonfabric";

// FIXTURE: computed-jsx-local-function
// Verifies: computed() with a locally-defined function inside the callback is closure-extracted
//   computed(() => { const format = ...; return <span>{format(count)}</span> }) → lift(({ count }) => { ... })({ count })
//   The pattern param `count` is captured with asOpaque: true in the schema.
export default pattern<{ count: number }>(({ count }) => {
  return {
    [UI]: (
      <div>
        {computed(() => {
          const format = (value: number) => `Count: ${value}`;
          return <span>{format(count)}</span>;
        })}
      </div>
    ),
  };
});
