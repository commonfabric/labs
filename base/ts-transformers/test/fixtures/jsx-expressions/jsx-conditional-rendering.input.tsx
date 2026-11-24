import { ifElse, pattern, UI } from "commonfabric";

interface State {
  isActive: boolean;
  count: number;
  userType: string;
  score: number;
  hasPermission: boolean;
  isPremium: boolean;
}

// FIXTURE: jsx-conditional-rendering
// Verifies: ternary expressions and ifElse() calls in JSX are transformed to reactive ifElse()
//   cond ? a : b             → ifElse(schema, schema, schema, schema, cond, a, b)
//   ifElse(cond, <jsx>, <jsx>) → ifElse(schema..., cond, <jsx>, <jsx>)
// Context: Basic, nested, and complex ternaries plus explicit ifElse calls
export default pattern<State>((state) => {
  return {
    [UI]: (
      <div>
        <h3>Basic Ternary</h3>
        <span>{state.isActive ? "Active" : "Inactive"}</span>
        <span>{state.hasPermission ? "Authorized" : "Denied"}</span>

        <h3>Ternary with Comparisons</h3>
        <span>{state.count > 10 ? "High" : "Low"}</span>
        <span>{state.score >= 90 ? "A" : state.score >= 80 ? "B" : "C"}</span>
        <span>
          {state.count === 0
            ? "Empty"
            : state.count === 1
            ? "Single"
            : "Multiple"}
        </span>

        <h3>Nested Ternary</h3>
        <span>
          {state.isActive
            ? (state.isPremium ? "Premium Active" : "Regular Active")
            : "Inactive"}
        </span>
        <span>
          {state.userType === "admin"
            ? "Admin"
            : state.userType === "user"
            ? "User"
            : "Guest"}
        </span>

        <h3>Complex Conditions</h3>
        <span>
          {state.isActive && state.hasPermission
            ? "Full Access"
            : "Limited Access"}
        </span>
        <span>
          {state.count > 0 && state.count < 10 ? "In Range" : "Out of Range"}
        </span>
        <span>
          {state.isPremium || state.score > 100
            ? "Premium Features"
            : "Basic Features"}
        </span>

        <h3>IfElse Component</h3>
        {ifElse(
          state.isActive,
          <div>User is active with {state.count} items</div>,
          <div>User is inactive</div>,
        )}

        {ifElse(
          state.count > 5,
          <ul>
            <li>Many items: {state.count}</li>
          </ul>,
          <p>Few items: {state.count}</p>,
        )}
      </div>
    ),
  };
});
