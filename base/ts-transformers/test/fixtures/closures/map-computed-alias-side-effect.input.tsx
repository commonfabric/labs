import { pattern, UI } from "commonfabric";

function nextKey() {
  console.log("key requested");
  return "value";
}

interface State {
  items: Array<Record<string, number>>;
}

// FIXTURE: map-computed-alias-side-effect
// Verifies: computed property key with side effects is hoisted and used via a lift-applied computation
//   { [nextKey()]: amount } → __cf_amount_key = nextKey(); lift(...)(...element[__cf_amount_key])
//   .map(fn) → .mapWithPattern(pattern(...), {})
// Context: nextKey() has a side effect (it logs), so the key expression is evaluated once and cached
export default pattern<State>((state) => {
  return {
    [UI]: (
      <div>
        {state.items.map(({ [nextKey()]: amount }) => (
          <span>{amount}</span>
        ))}
      </div>
    ),
  };
});
