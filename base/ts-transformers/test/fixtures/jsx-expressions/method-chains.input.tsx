import { computed, pattern, UI } from "commonfabric";

interface State {
  text: string;
  searchTerm: string;
  items: number[];
  start: number;
  end: number;
  threshold: number;
  factor: number;
  names: string[];
  prefix: string;
  prices: number[];
  discount: number;
  taxRate: number;
  users: Array<{ name: string; age: number; active: boolean }>;
  minAge: number;
  words: string[];
  separator: string;
}

// FIXTURE: method-chains
// Verifies: chained method calls and array method chains in JSX are wrapped in a lift-applied computation
//   state.text.trim().toLowerCase()          → lift(...)({ text })
//   state.items.filter(fn).map(fn)           → .filterWithPattern(...).mapWithPattern(...)
//   state.prices.reduce(fn, 0)               → lift(...)({ prices, discount })
// Context: Covers string chains, filter/map chains, reactive args, computed values, complex predicates
export default pattern<State>((state) => {
  return {
    [UI]: (
      <div>
        <h3>Chained String Methods</h3>
        {/* Simple chain */}
        <p>Trimmed lower: {state.text.trim().toLowerCase()}</p>

        {/* Chain with reactive argument */}
        <p>
          Contains search:{" "}
          {state.text.toLowerCase().includes(state.searchTerm.toLowerCase())}
        </p>

        {/* Longer chain */}
        <p>
          Processed:{" "}
          {state.text.trim().toLowerCase().replace("old", "new").toUpperCase()}
        </p>

        <h3>Array Method Chains</h3>
        {/* Filter then length */}
        <p>
          Count above threshold:{" "}
          {state.items.filter((x) => x > state.threshold).length}
        </p>

        {/* Filter then map */}
        <ul>
          {state.items.filter((x) => x > state.threshold).map((x) => (
            <li>Value: {x * state.factor}</li>
          ))}
        </ul>

        {/* Multiple filters */}
        <p>
          Double filter count:{" "}
          {state.items.filter((x) => x > state.start).filter((x) =>
            x < state.end
          ).length}
        </p>

        <h3>Methods with Reactive Arguments</h3>
        {/* Slice with reactive indices */}
        <p>
          Sliced items: {state.items.slice(state.start, state.end).join(", ")}
        </p>

        {/* String methods with reactive args */}
        <p>
          Starts with:{" "}
          {computed(() => state.names.filter((n) => n.startsWith(state.prefix)).join(", "))}
        </p>

        {/* Array find with reactive predicate */}
        <p>
          First match: {state.names.find((n) => n.includes(state.searchTerm))}
        </p>

        <h3>Complex Method Combinations</h3>
        {/* Map with chained operations inside */}
        <ul>
          {state.names.map((name) => (
            <li>{name.trim().toLowerCase().replace(" ", "-")}</li>
          ))}
        </ul>

        {/* Reduce with reactive accumulator */}
        <p>
          Total with discount: {state.prices.reduce(
            (sum, price) => sum + price * (1 - state.discount),
            0,
          )}
        </p>

        {/* Method result used in computation */}
        <p>
          Average * factor:{" "}
          {(state.items.reduce((a, b) => a + b, 0) / state.items.length) *
            state.factor}
        </p>

        <h3>Methods on Computed Values</h3>
        {/* Method on binary expression result */}
        <p>
          Formatted price: {(state.prices[0]! * (1 - state.discount)).toFixed(2)}
        </p>

        {/* Method on conditional result */}
        <p>
          Conditional trim:{" "}
          {(state.text.length > 10 ? state.text : state.prefix).trim()}
        </p>

        {/* Method chain on computed value */}
        <p>
          Complex:{" "}
          {(state.text + " " + state.prefix).trim().toLowerCase().split(" ")
            .join("-")}
        </p>

        <h3>Array Methods with Complex Predicates</h3>
        {/* Filter with multiple conditions */}
        <p>
          Active adults:{" "}
          {state.users.filter((u) => u.age >= state.minAge && u.active).length}
        </p>

        {/* Map with conditional logic */}
        <ul>
          {state.users.map((u) => (
            <li>{u.active ? u.name.toUpperCase() : u.name.toLowerCase()}</li>
          ))}
        </ul>

        {/* Some/every with reactive predicates */}
        <p>
          Has adults:{" "}
          {state.users.some((u) => u.age >= state.minAge) ? "Yes" : "No"}
        </p>
        <p>All active: {state.users.every((u) => u.active) ? "Yes" : "No"}</p>

        <h3>Method Calls in Expressions</h3>
        {/* Method result in arithmetic */}
        <p>
          Length sum: {state.text.trim().length + state.prefix.trim().length}
        </p>

        {/* Method result in comparison */}
        <p>
          Is long: {state.text.trim().length > state.threshold ? "Yes" : "No"}
        </p>

        {/* Multiple method results combined */}
        <p>Joined: {state.words.join(state.separator).toUpperCase()}</p>
      </div>
    ),
  };
});
