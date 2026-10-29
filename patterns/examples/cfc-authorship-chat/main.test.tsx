import { assert, pattern, TESTS } from "commonfabric";
import AuthorshipChat from "./main.tsx";

export default pattern(() => {
  const instance = AuthorshipChat({});

  const assert_verified_fixture_names_alice = assert(() =>
    instance.verifiedAuthor === "Alice Nguyen"
  );
  const assert_forged_fixture_names_bob = assert(() =>
    instance.forgedClaim === "Bob Patel"
  );
  const assert_unsigned_fixture_names_casey = assert(() =>
    instance.unsignedState === "Casey Morgan"
  );

  return {
    [TESTS]: [
      { assertion: assert_verified_fixture_names_alice },
      { assertion: assert_forged_fixture_names_bob },
      { assertion: assert_unsigned_fixture_names_casey },
    ],
    instance,
  };
});
