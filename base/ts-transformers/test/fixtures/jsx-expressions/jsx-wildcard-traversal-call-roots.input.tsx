import { pattern, UI } from "commonfabric";

interface State {
  wishes: [
    { id: string; status: string },
    { id: string; status: string },
  ];
}

// FIXTURE: jsx-wildcard-traversal-call-roots
// Verifies: wildcard traversal calls lower as whole JSX call roots
export default pattern<State>((state) => ({
  [UI]: (
    <div>
      <p>{JSON.stringify(state.wishes[1])}</p>
      <p>{Object.keys(state.wishes[1])}</p>
      <p>{Object.values(state.wishes[1])}</p>
      <p>{Object.entries(state.wishes[1])}</p>
    </div>
  ),
}));
