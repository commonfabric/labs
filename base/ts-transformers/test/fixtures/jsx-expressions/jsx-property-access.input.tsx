import { pattern, UI } from "commonfabric";

interface User {
  name: string;
  age: number;
  active: boolean;
  profile: {
    bio: string;
    location: string;
    settings: {
      theme: string;
      notifications: boolean;
    };
  };
}

interface Config {
  theme: {
    primaryColor: string;
    secondaryColor: string;
    fontSize: number;
  };
  features: {
    darkMode: boolean;
    beta: boolean;
  };
}

interface State {
  user: User;
  config: Config;
  items: string[];
  index: number;
  numbers: number[];
}

// FIXTURE: jsx-property-access
// Verifies: nested property access chains in JSX are converted to .key() or wrapped in a lift-applied computation
//   state.user.name                → state.key("user", "name")  (simple access, no lift)
//   state.user.age + 1             → lift(({state}) => state.user.age + 1)({ age })
//   state.items[state.index]       → lift(...)({ items, index })
// Context: Covers deep nesting, style bindings, array access, method calls on properties
export default pattern<State>((state) => {
  return {
    [UI]: (
      <div>
        <h3>Basic Property Access</h3>
        <h1>{state.user.name}</h1>
        <p>Age: {state.user.age}</p>
        <p>Active: {state.user.active ? "Yes" : "No"}</p>

        <h3>Nested Property Access</h3>
        <p>Bio: {state.user.profile.bio}</p>
        <p>Location: {state.user.profile.location}</p>
        <p>Theme: {state.user.profile.settings.theme}</p>
        <p>
          Notifications:{" "}
          {state.user.profile.settings.notifications ? "On" : "Off"}
        </p>

        <h3>Property Access with Operations</h3>
        <p>Age + 1: {state.user.age + 1}</p>
        <p>Name length: {state.user.name.length}</p>
        <p>Uppercase name: {state.user.name.toUpperCase()}</p>
        <p>
          Location includes city:{" "}
          {state.user.profile.location.includes("City") ? "Yes" : "No"}
        </p>

        <h3>Array Element Access</h3>
        <p>Item at index: {state.items[state.index]}</p>
        <p>First item: {state.items[0]}</p>
        <p>Last item: {state.items[state.items.length - 1]}</p>
        <p>Number at index: {state.numbers[state.index]}</p>

        <h3>Config Access with Styles</h3>
        <p
          style={{
            color: state.config.theme.primaryColor,
            fontSize: state.config.theme.fontSize + "px",
          }}
        >
          Styled text
        </p>
        <div
          style={{
            backgroundColor: state.config.features.darkMode ? "#333" : "#fff",
            borderColor: state.config.theme.secondaryColor,
          }}
        >
          Theme-aware box
        </div>

        <h3>Complex Property Chains</h3>
        <p>{state.user.name + " from " + state.user.profile.location}</p>
        <p>Font size + 2: {state.config.theme.fontSize + 2}px</p>
        <p>
          Has beta and dark mode:{" "}
          {state.config.features.beta && state.config.features.darkMode
            ? "Yes"
            : "No"}
        </p>
      </div>
    ),
  };
});
