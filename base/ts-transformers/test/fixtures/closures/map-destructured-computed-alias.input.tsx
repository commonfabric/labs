import { pattern, UI } from "commonfabric";

const dynamicKey = "value" as const;

interface Item {
  value: number;
  other: number;
}

interface State {
  items: Item[];
}

// FIXTURE: map-destructured-computed-alias
// Verifies: computed property key with a const-asserted identifier is lowered to lift-applied
//   { [dynamicKey]: val } → __cf_val_key = dynamicKey; lift(...)(...element[__cf_val_key])
//   .map(fn) → .mapWithPattern(pattern(...))
// Context: dynamicKey is a const-asserted string, not a function call — still uses the lift-applied pattern
export default pattern<State>((state) => {
  return {
    [UI]: (
      <div>
        {state.items.map(({ [dynamicKey]: val }) => (
          <span>{val}</span>
        ))}
      </div>
    ),
  };
});
