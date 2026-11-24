import { cell, pattern, UI } from "commonfabric";

// Tests triple && chain: a && b && c
// Should produce nested when calls or lower the entire chain to a lift-applied computation
// FIXTURE: logical-triple-and-chain
// Verifies: triple && chain (a && b && <JSX>) is transformed to nested when() or a lift-applied computation
//   user.get().active && user.get().verified && <span> → when(lift(...)({ user }), <span>)
export default pattern((_state) => {
  const user = cell<{ active: boolean; verified: boolean; name: string }>({ active: false, verified: false, name: "" });

  return {
    [UI]: (
      <div>
        {/* Triple && chain with complex conditions */}
        {user.get().active && user.get().verified && <span>Welcome, {user.get().name}!</span>}
      </div>
    ),
  };
});
