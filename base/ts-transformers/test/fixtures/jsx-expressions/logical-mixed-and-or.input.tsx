import { cell, pattern, UI } from "commonfabric";

// Tests mixed && and || operators: (a && b) || c
// The && should use when, the || should use unless
// FIXTURE: logical-mixed-and-or
// Verifies: mixed && and || patterns are correctly decomposed into when/unless/lift-applied
//   (cond && value) || fallback → lift-applied computation or nested when/unless
//   cond && (value || fallback) → nested logical transforms
//   (a && b) || (c && d) || e   → chained lift-applied expressions
export default pattern((_state) => {
  const user = cell<{ name: string; age: number }>({ name: "", age: 0 });
  const defaultMessage = cell("Guest");

  return {
    [UI]: (
      <div>
        {/* (condition && value) || fallback pattern */}
        <span>{(user.get().name.length > 0 && user.get().name) || defaultMessage.get()}</span>

        {/* condition && (value || fallback) pattern */}
        <span>{user.get().age > 18 && (user.get().name || "Anonymous Adult")}</span>

        {/* Complex: (a && b) || (c && d) */}
        <span>
          {(user.get().name.length > 0 && `Hello ${user.get().name}`) ||
            (user.get().age > 0 && `Age: ${user.get().age}`) ||
            "Unknown user"}
        </span>
      </div>
    ),
  };
});
