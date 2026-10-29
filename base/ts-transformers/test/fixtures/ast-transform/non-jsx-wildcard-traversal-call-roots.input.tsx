import { pattern } from "commonfabric";

interface State {
  wishes: [
    { id: string; status: string },
    { id: string; status: string },
  ];
}

// FIXTURE: non-jsx-wildcard-traversal-call-roots
// Verifies: wildcard traversal calls lower as whole call roots outside JSX
export default pattern<State>((state) => ({
  serialized: JSON.stringify(state.wishes[1]),
  keys: Object.keys(state.wishes[1]),
  values: Object.values(state.wishes[1]),
  entries: Object.entries(state.wishes[1]),
}));
