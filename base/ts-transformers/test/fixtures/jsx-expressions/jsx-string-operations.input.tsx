import { pattern, UI } from "commonfabric";

interface State {
  firstName: string;
  lastName: string;
  title: string;
  message: string;
  count: number;
}

// FIXTURE: jsx-string-operations
// Verifies: string concatenation, template literals, and string methods in JSX are wrapped in a lift-applied computation
//   state.title + ": " + state.firstName → lift(...)({ title, firstName })
//   `Welcome, ${state.firstName}!`       → lift(...)({ firstName })
//   state.firstName.toUpperCase()        → lift(...)({ firstName })
export default pattern<State>((state) => {
  return {
    [UI]: (
      <div>
        <h3>String Concatenation</h3>
        <h1>{state.title + ": " + state.firstName + " " + state.lastName}</h1>
        <p>{state.firstName + state.lastName}</p>
        <p>{"Hello, " + state.firstName + "!"}</p>

        <h3>Template Literals</h3>
        <p>{`Welcome, ${state.firstName}!`}</p>
        <p>{`Full name: ${state.firstName} ${state.lastName}`}</p>
        <p>{`${state.title}: ${state.firstName} ${state.lastName}`}</p>

        <h3>String Methods</h3>
        <p>Uppercase: {state.firstName.toUpperCase()}</p>
        <p>Lowercase: {state.title.toLowerCase()}</p>
        <p>Length: {state.message.length}</p>
        <p>Substring: {state.message.substring(0, 5)}</p>

        <h3>Mixed String and Number</h3>
        <p>{state.firstName + " has " + state.count + " items"}</p>
        <p>{`${state.firstName} has ${state.count} items`}</p>
        <p>Count as string: {"Count: " + state.count}</p>
      </div>
    ),
  };
});
