import { pattern, type Writable } from "commonfabric";

interface AuthData {
  token: string;
  user: {
    email: string;
  };
}

type AuthCell = Writable<AuthData>;

type AuthAvailability =
  | { state: "loading"; auth: null }
  | { state: "ready"; auth: AuthCell };

interface Input {
  availability: AuthAvailability;
}

// FIXTURE: auth-availability-union-cell-preserved
// A discriminated union can represent loading auth separately from ready auth.
// The ready variant keeps the nested auth value as a live writable cell.
export default pattern<Input>(({ availability }) => {
  return {
    availability,
  };
});
