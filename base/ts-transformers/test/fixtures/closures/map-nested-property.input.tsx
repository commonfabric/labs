import { pattern, UI } from "commonfabric";

interface Item {
  id: number;
  name: string;
}

interface User {
  firstName: string;
  lastName: string;
}

interface State {
  items: Item[];
  currentUser: User;
}

// FIXTURE: map-nested-property
// Verifies: .map() on reactive array captures nested property access on state
//   .map(fn) → .mapWithPattern(pattern(...), {state: {currentUser: {firstName, lastName}}})
// Context: Captures state.currentUser.firstName and state.currentUser.lastName as nested property paths
export default pattern<State>((state) => {
  return {
    [UI]: (
      <div>
        {state.items.map((item) => (
          <div>
            {item.name} - edited by {state.currentUser.firstName} {state.currentUser.lastName}
          </div>
        ))}
      </div>
    ),
  };
});
