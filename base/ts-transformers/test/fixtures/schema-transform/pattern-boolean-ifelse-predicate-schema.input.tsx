import { pattern, UI } from "commonfabric";

type State = {
  user: {
    settings: {
      notifications: boolean;
    };
  };
};

// FIXTURE: pattern-boolean-ifelse-predicate-schema
// Verifies: ternaries lowered from `.key(...)` reads keep a boolean predicate
// schema instead of collapsing to `true`.
export default pattern<State>((state) => ({
  [UI]: (
    <div>
      {state.user.settings.notifications ? "enabled" : "disabled"}
    </div>
  ),
}));
