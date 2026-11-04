import { cell, pattern, UI } from "commonfabric";

// FIXTURE: logical-and-non-jsx
// Verifies: && with non-JSX right side still lowers through when(), with predicate/value derived separately
//   user.get().name.length > 0 && `Hello...` → when(lift(...)(predicate), lift(...)(template))
//   user.get().age > 18 && user.get().age    → when(lift(...)(predicate), lift(...)(number))
// Context: JSX-local control flow still uses when(); non-JSX right-hand values become derived branch values
export default pattern((_state) => {
  const user = cell<{ name: string; age: number }>({ name: "", age: 0 });

  return {
    [UI]: (
      <div>
        {/* Non-JSX right side: string template with complex expression */}
        <p>{user.get().name.length > 0 && `Hello, ${user.get().name}!`}</p>

        {/* Non-JSX right side: number expression */}
        <p>Age: {user.get().age > 18 && user.get().age}</p>
      </div>
    ),
  };
});
