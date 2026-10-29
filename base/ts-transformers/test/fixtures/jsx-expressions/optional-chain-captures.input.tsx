import { pattern, UI } from "commonfabric";

interface Item {
  maybe?: { value: number };
}

interface State {
  maybe?: { value: number };
  items: Item[];
}

// FIXTURE: optional-chain-captures
// Verifies: optional chaining (?.) in JSX is resolved to .key() or wrapped in a lift-applied computation
//   state.maybe?.value         → state.key("maybe", "value")
//   item.maybe?.value ?? 0     → lift(({item}) => item.maybe?.value ?? 0)({ item })
// Context: Optional chaining with nullish coalescing inside a map body
export default pattern<State>((state) => {
  return {
    [UI]: (
      <div>
        <span>{state.maybe?.value}</span>
        {state.items.map((item) => (
          <span>{item.maybe?.value ?? 0}</span>
        ))}
      </div>
    ),
  };
});
